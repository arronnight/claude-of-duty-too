import * as THREE from 'three';
import { ShaderPass, makeRT } from './Common.js';

/**
 * GPU eye adaptation. A log-luminance reduction chain collapses the frame to a
 * single texel and an exponential smoother tracks it, all on the GPU — no
 * readback, so nothing ever stalls the pipeline. The grade pass samples the 1x1
 * result directly, and the composite pass reuses it as the reference level for
 * deciding how much of a pixel is indirect light.
 *
 * Time of day here spans a ~14 stop range, so without adaptation either noon
 * clips or midnight is a black frame.
 */

const SEED = /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform float uSkyWeight;

float sample4( vec2 uv ) {
  vec3 c = texture( uSrc, uv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  c += texture( uSrc, uv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  c += texture( uSrc, uv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  c += texture( uSrc, uv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  return luma( max( c * 0.25, vec3( 0.0 ) ) );
}

void main() {
  float l = sample4( vUv );
  // Broad centre weighting plus a sky rejection from the depth buffer. The
  // pattern is deliberately wide rather than spot: on a street lit half in hard
  // sun and half in deep shadow, a tight spot meter keys to whichever half
  // happens to sit under the reticle and blows out the other one.
  vec2 d = vUv - 0.5;
  float w = exp( -dot( d, d ) * 1.15 );
  float sky = step( 0.9999, texture( uDepth, vUv ).r );
  w *= mix( 1.0, uSkyWeight, sky );
  // First and second weighted moments of log luminance. The second moment is
  // what lets the adapt step key off a high percentile instead of the mean.
  float lg = log( max( l, 1e-5 ) );
  fragColor = vec4( lg * w, w, lg * lg * w, 1.0 );
}
`;

const REDUCE = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
  vec3 acc = vec3( 0.0 );
  for ( int y = 0; y < 4; y++ ) {
    for ( int x = 0; x < 4; x++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 1.5 ) * uTexel;
      acc += texture( uSrc, vUv + o ).rgb;
    }
  }
  fragColor = vec4( acc / 16.0, 1.0 );
}
`;

const ADAPT = /* glsl */ `
uniform sampler2D uCurrent;
uniform sampler2D uPrev;
uniform float uRate;
uniform float uReset;
uniform float uMinLum;
uniform float uMaxLum;
uniform float uHighlightBias;
uniform float uSigmaMax;

void main() {
  vec3 s = texture( uCurrent, vec2( 0.5 ) ).rgb;
  float wsum = max( s.g, 1e-4 );
  float mean = s.r / wsum;
  // Log luminance is close enough to normal that mean + k.sigma is a percentile:
  // k = 0.85 lands near the 80th. Keying off that instead of the plain log
  // average is what stops a half-sun / half-shadow street from metering to the
  // shadow and clipping every sunlit concrete face to flat white. sigma is
  // capped so a night frame with a few sodium lamps in an otherwise black
  // street does not meter itself into the ground.
  float sigma = sqrt( max( s.b / wsum - mean * mean, 0.0 ) );
  float target = clamp( exp( mean + uHighlightBias * min( sigma, uSigmaMax ) ), uMinLum, uMaxLum );
  float prev = texture( uPrev, vec2( 0.5 ) ).r;
  if ( uReset > 0.5 || prev <= 0.0 ) { fragColor = vec4( target, 0.0, 0.0, 1.0 ); return; }
  // Track in log space and snap on a large jump so a time-of-day change does
  // not spend three seconds crawling across ten stops.
  float lt = log2( target );
  float lp = log2( max( prev, 1e-5 ) );
  float delta = lt - lp;
  float k = abs( delta ) > 2.5 ? 1.0 : clamp( uRate * ( 0.35 + abs( delta ) ), 0.0, 1.0 );
  fragColor = vec4( exp2( mix( lp, lt, k ) ), 0.0, 0.0, 1.0 );
}
`;

export class ExposurePass {
  constructor() {
    this.seed = new ShaderPass('postfx/lum-seed', SEED, {
      uSrc: { value: null },
      uDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uSkyWeight: { value: 0.40 },
    });
    this.reduce = new ShaderPass('postfx/lum-reduce', REDUCE, {
      uSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.adapt = new ShaderPass('postfx/lum-adapt', ADAPT, {
      uCurrent: { value: null },
      uPrev: { value: null },
      uRate: { value: 0.06 },
      uReset: { value: 1 },
      uMinLum: { value: 0.0025 },
      uMaxLum: { value: 12 },
      uHighlightBias: { value: 0.62 },
      uSigmaMax: { value: 1.75 },
    });

    // Full float: the variance is a difference of two similar second moments,
    // and half float loses it in the noise once log-luminance squared runs to
    // three figures. These targets are 64x64 at most, so it costs nothing.
    this.chain = [];
    for (const s of [64, 16, 4, 1]) {
      this.chain.push(makeRT(s, s, {
        name: `lum${s}`, type: THREE.FloatType, minFilter: THREE.LinearFilter,
      }));
    }
    this.adapted = [
      makeRT(1, 1, { name: 'adapt0', type: THREE.FloatType }),
      makeRT(1, 1, { name: 'adapt1', type: THREE.FloatType }),
    ];
    this.write = 0;
    this.needsReset = true;
  }

  setSize() {
    // Taps are spread over the 64x64 destination footprint, not the source
    // texel grid, so the 4096 samples actually cover the frame.
    this.seed.uniforms.uTexel.value.set(1 / 160, 1 / 160);
    this.needsReset = true;
  }

  render(renderer, source, depth, dt) {
    this.seed.uniforms.uSrc.value = source;
    this.seed.uniforms.uDepth.value = depth;
    this.seed.render(renderer, this.chain[0]);
    for (let i = 1; i < this.chain.length; i++) {
      const src = this.chain[i - 1];
      this.reduce.uniforms.uSrc.value = src.texture;
      this.reduce.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.reduce.render(renderer, this.chain[i]);
    }
    const dst = this.adapted[this.write];
    const u = this.adapt.uniforms;
    u.uCurrent.value = this.chain[this.chain.length - 1].texture;
    u.uPrev.value = this.adapted[1 - this.write].texture;
    u.uRate.value = THREE.MathUtils.clamp((dt || 0.016) * 5.5, 0.01, 1);
    u.uReset.value = this.needsReset ? 1 : 0;
    this.adapt.render(renderer, dst);
    this.needsReset = false;
    this.write = 1 - this.write;
    return dst.texture;
  }

  /** The most recently written 1x1 adaptation texture. */
  get texture() {
    return this.adapted[1 - this.write].texture;
  }

  dispose() {
    this.seed.dispose();
    this.reduce.dispose();
    this.adapt.dispose();
    for (const rt of this.chain) rt.dispose();
    for (const rt of this.adapted) rt.dispose();
  }
}
