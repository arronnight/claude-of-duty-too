import * as THREE from 'three';
import { ShaderPass, makeRT } from './Common.js';

/**
 * Dual-filter bloom: the Call of Duty: Advanced Warfare 13-tap downsample and
 * 9-tap tent upsample over six mips. The tap weights sum to one at every level
 * so the chain is energy conserving — the visible size of a highlight's halo
 * comes from the mip count, not from cranking the intensity, which is what
 * keeps a bright window a faint bloom instead of a glowing smear.
 *
 * The first downsample carries a Karis average so a single hot pixel from a
 * specular glint cannot pump the whole chain.
 */

const PREFILTER = /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uAvgLum;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftKnee;
uniform float uClamp;
uniform float uExposureBase;
uniform float uKey;
uniform float uMinExposure;
uniform float uMaxExposure;

// The threshold is authored in display units and converted to scene units with
// the same exposure the grade pass will use. A fixed HDR threshold blooms the
// entire sky at noon and nothing at all at night.
float sceneScale() {
  float avg = max( texture( uAvgLum, vec2( 0.5 ) ).r, 1e-5 );
  float exposure = uExposureBase * clamp( uKey / avg, uMinExposure, uMaxExposure );
  return 0.6 / max( exposure, 1e-4 );
}

float gThreshold;
float gClamp;

vec3 fetch( vec2 uv ) { return min( texture( uSrc, uv ).rgb, vec3( gClamp ) ); }
float karis( vec3 c ) { return 1.0 / ( 1.0 + luma( c ) ); }

vec3 threshold( vec3 c ) {
  float br = maxc( c );
  float knee = gThreshold * uSoftKnee + 1e-5;
  float soft = clamp( br - gThreshold + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee );
  return c * max( soft, br - gThreshold ) / max( br, 1e-5 );
}

void main() {
  float scale = sceneScale();
  gThreshold = uThreshold * scale;
  gClamp = uClamp * scale;
  vec2 t = uTexel;
  vec3 a = fetch( vUv + vec2( -2.0,  2.0 ) * t );
  vec3 b = fetch( vUv + vec2(  0.0,  2.0 ) * t );
  vec3 c = fetch( vUv + vec2(  2.0,  2.0 ) * t );
  vec3 d = fetch( vUv + vec2( -2.0,  0.0 ) * t );
  vec3 e = fetch( vUv );
  vec3 f = fetch( vUv + vec2(  2.0,  0.0 ) * t );
  vec3 g = fetch( vUv + vec2( -2.0, -2.0 ) * t );
  vec3 h = fetch( vUv + vec2(  0.0, -2.0 ) * t );
  vec3 i = fetch( vUv + vec2(  2.0, -2.0 ) * t );
  vec3 j = fetch( vUv + vec2( -1.0,  1.0 ) * t );
  vec3 k = fetch( vUv + vec2(  1.0,  1.0 ) * t );
  vec3 l = fetch( vUv + vec2( -1.0, -1.0 ) * t );
  vec3 m = fetch( vUv + vec2(  1.0, -1.0 ) * t );

  vec3 g0 = ( a + b + d + e ) * 0.25;
  vec3 g1 = ( b + c + e + f ) * 0.25;
  vec3 g2 = ( d + e + g + h ) * 0.25;
  vec3 g3 = ( e + f + h + i ) * 0.25;
  vec3 g4 = ( j + k + l + m ) * 0.25;
  float w0 = karis( g0 ) * 0.125;
  float w1 = karis( g1 ) * 0.125;
  float w2 = karis( g2 ) * 0.125;
  float w3 = karis( g3 ) * 0.125;
  float w4 = karis( g4 ) * 0.5;
  vec3 sum = ( g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4 ) / max( w0 + w1 + w2 + w3 + w4, 1e-5 );

  fragColor = vec4( threshold( sum ), 1.0 );
}
`;

const DOWNSAMPLE = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uAnamorphic;

vec3 T( vec2 o ) { return texture( uSrc, vUv + o * uTexel * vec2( uAnamorphic, 1.0 ) ).rgb; }

void main() {
  vec3 e = T( vec2( 0.0, 0.0 ) );
  vec3 a = T( vec2( -2.0,  2.0 ) );
  vec3 b = T( vec2(  0.0,  2.0 ) );
  vec3 c = T( vec2(  2.0,  2.0 ) );
  vec3 d = T( vec2( -2.0,  0.0 ) );
  vec3 f = T( vec2(  2.0,  0.0 ) );
  vec3 g = T( vec2( -2.0, -2.0 ) );
  vec3 h = T( vec2(  0.0, -2.0 ) );
  vec3 i = T( vec2(  2.0, -2.0 ) );
  vec3 j = T( vec2( -1.0,  1.0 ) );
  vec3 k = T( vec2(  1.0,  1.0 ) );
  vec3 l = T( vec2( -1.0, -1.0 ) );
  vec3 m = T( vec2(  1.0, -1.0 ) );
  vec3 r = e * 0.125;
  r += ( a + c + g + i ) * 0.03125;
  r += ( b + d + f + h ) * 0.0625;
  r += ( j + k + l + m ) * 0.125;
  fragColor = vec4( r, 1.0 );
}
`;

const UPSAMPLE = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uAnamorphic;

vec3 T( vec2 o ) { return texture( uSrc, vUv + o * uTexel * uRadius * vec2( uAnamorphic, 1.0 ) ).rgb; }

void main() {
  vec3 r = T( vec2( -1.0,  1.0 ) ) + T( vec2( 0.0,  1.0 ) ) * 2.0 + T( vec2( 1.0,  1.0 ) );
  r += T( vec2( -1.0,  0.0 ) ) * 2.0 + T( vec2( 0.0, 0.0 ) ) * 4.0 + T( vec2( 1.0,  0.0 ) ) * 2.0;
  r += T( vec2( -1.0, -1.0 ) ) + T( vec2( 0.0, -1.0 ) ) * 2.0 + T( vec2( 1.0, -1.0 ) );
  fragColor = vec4( r * 0.0625, 1.0 );
}
`;

export class BloomPass {
  constructor(levels = 6) {
    this.levels = levels;
    this.mips = [];
    this.threshold = 1.15;
    this.softKnee = 0.55;
    this.radius = 1.0;
    this.anamorphic = 1.12;

    this.prefilter = new ShaderPass('postfx/bloom-prefilter', PREFILTER, {
      uSrc: { value: null },
      uAvgLum: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: this.threshold },
      uSoftKnee: { value: this.softKnee },
      uClamp: { value: 48 },
      uExposureBase: { value: 1 },
      uKey: { value: 0.19 },
      uMinExposure: { value: 0.22 },
      uMaxExposure: { value: 7.5 },
    });
    this.down = new ShaderPass('postfx/bloom-down', DOWNSAMPLE, {
      uSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uAnamorphic: { value: this.anamorphic },
    });
    this.up = new ShaderPass('postfx/bloom-up', UPSAMPLE, {
      uSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: this.radius },
      uAnamorphic: { value: this.anamorphic },
    }).additive();
  }

  setSize(w, h) {
    for (const m of this.mips) m.dispose();
    this.mips.length = 0;
    let mw = Math.max(1, w >> 1);
    let mh = Math.max(1, h >> 1);
    for (let i = 0; i < this.levels; i++) {
      this.mips.push(makeRT(mw, mh, { name: `bloom${i}` }));
      if (mw <= 4 || mh <= 4) break;
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
    }
    this.prefilter.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(renderer, source, avgLum, exposure) {
    const mips = this.mips;
    if (!mips.length) return null;

    const pu = this.prefilter.uniforms;
    pu.uSrc.value = source;
    pu.uAvgLum.value = avgLum;
    pu.uThreshold.value = this.threshold;
    pu.uSoftKnee.value = this.softKnee;
    if (exposure) {
      pu.uExposureBase.value = exposure.base;
      pu.uKey.value = exposure.key;
      pu.uMinExposure.value = exposure.min;
      pu.uMaxExposure.value = exposure.max;
    }
    this.prefilter.render(renderer, mips[0]);

    for (let i = 1; i < mips.length; i++) {
      const src = mips[i - 1];
      this.down.uniforms.uSrc.value = src.texture;
      this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.down.uniforms.uAnamorphic.value = this.anamorphic;
      this.down.render(renderer, mips[i]);
    }

    for (let i = mips.length - 1; i > 0; i--) {
      const src = mips[i];
      this.up.uniforms.uSrc.value = src.texture;
      this.up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.up.uniforms.uRadius.value = this.radius;
      this.up.uniforms.uAnamorphic.value = this.anamorphic;
      this.up.render(renderer, mips[i - 1]);
    }

    return mips[0].texture;
  }

  dispose() {
    this.prefilter.dispose();
    this.down.dispose();
    this.up.dispose();
    for (const m of this.mips) m.dispose();
    this.mips.length = 0;
  }
}
