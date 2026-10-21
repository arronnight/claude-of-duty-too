import * as THREE from 'three';
import { ShaderPass, makeRT } from './Common.js';

/**
 * Temporal anti-aliasing with 8-sample Halton jitter.
 *
 * Motion vectors are camera-only: the world position is recovered exactly from
 * the depth buffer using the *jittered* inverse view-projection, then projected
 * with the previous frame's unjittered view-projection. Dynamic objects
 * therefore have no true velocity, which is why the neighbourhood clamp does
 * the heavy lifting — variance clipping in YCoCg on a reversible-tonemapped
 * signal, so a bright moving highlight cannot drag a comet tail behind it.
 *
 * The history's alpha channel carries linear depth, which gives a free
 * disocclusion test (compare against the reprojected w) without a second
 * full-resolution buffer.
 */

const FRAGMENT = /* glsl */ `
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform vec2 uJitterUV;
uniform float uNear;
uniform float uFar;
uniform float uReset;
uniform float uFeedbackStill;
uniform float uFeedbackMoving;
uniform float uClampGamma;

vec3 tm( vec3 c ) { return c / ( 1.0 + luma( c ) ); }
vec3 tmInv( vec3 c ) { return c / max( 1e-4, 1.0 - luma( c ) ); }

vec4 catmullRom( sampler2D tex, vec2 uv, vec2 size ) {
  vec2 sp = uv * size;
  vec2 tp1 = floor( sp - 0.5 ) + 0.5;
  vec2 f = sp - tp1;
  vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
  vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
  vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
  vec2 w3 = f * f * ( -0.5 + 0.5 * f );
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 p0 = ( tp1 - 1.0 ) / size;
  vec2 p3 = ( tp1 + 2.0 ) / size;
  vec2 p12 = ( tp1 + o12 ) / size;
  vec4 r = vec4( 0.0 );
  float wsum = 0.0;
  float w;
  w = w12.x * w0.y;  r += texture( tex, vec2( p12.x, p0.y ) ) * w;  wsum += w;
  w = w0.x * w12.y;  r += texture( tex, vec2( p0.x, p12.y ) ) * w;  wsum += w;
  w = w12.x * w12.y; r += texture( tex, vec2( p12.x, p12.y ) ) * w; wsum += w;
  w = w3.x * w12.y;  r += texture( tex, vec2( p3.x, p12.y ) ) * w;  wsum += w;
  w = w12.x * w3.y;  r += texture( tex, vec2( p12.x, p3.y ) ) * w;  wsum += w;
  return r / max( wsum, 1e-5 );
}

vec3 clipToAABB( vec3 c, vec3 lo, vec3 hi ) {
  vec3 mid = 0.5 * ( hi + lo );
  vec3 ext = 0.5 * ( hi - lo ) + 1e-5;
  vec3 v = c - mid;
  vec3 a = abs( v ) / ext;
  float m = max( a.x, max( a.y, a.z ) );
  return m > 1.0 ? mid + v / m : c;
}

void main() {
  vec3 current = texture( uCurrent, vUv ).rgb;
  float d = min( texture( uDepth, vUv ).r, 0.999999 );
  float viewZ = viewZFromDepth( d, uNear, uFar );
  float linDepth = clamp( -viewZ / uFar, 0.0, 1.0 );

  vec4 wp = uInvViewProj * vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  wp /= wp.w;
  vec4 prevClip = uPrevViewProj * vec4( wp.xyz, 1.0 );
  vec2 prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;

  vec2 unjittered = vUv - uJitterUV;
  vec2 velocity = ( prevUv - unjittered ) * uResolution;
  float velPx = length( velocity );

  // 3x3 neighbourhood statistics on the compressed signal.
  vec3 m1 = vec3( 0.0 );
  vec3 m2 = vec3( 0.0 );
  vec3 nMin = vec3( 1e9 );
  vec3 nMax = vec3( -1e9 );
  vec3 centre = vec3( 0.0 );
  for ( int y = -1; y <= 1; y++ ) {
    for ( int x = -1; x <= 1; x++ ) {
      vec3 s = rgbToYCoCg( tm( texture( uCurrent, vUv + vec2( float( x ), float( y ) ) * uTexel ).rgb ) );
      m1 += s;
      m2 += s * s;
      nMin = min( nMin, s );
      nMax = max( nMax, s );
      if ( x == 0 && y == 0 ) centre = s;
    }
  }
  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt( max( vec3( 0.0 ), m2 / 9.0 - mean * mean ) );
  float gamma = mix( uClampGamma, uClampGamma * 0.62, clamp( velPx / 8.0, 0.0, 1.0 ) );
  vec3 lo = max( mean - gamma * sigma, nMin );
  vec3 hi = min( mean + gamma * sigma, nMax );

  vec4 hist = catmullRom( uHistory, prevUv, uResolution );
  hist.rgb = max( hist.rgb, vec3( 0.0 ) );
  vec3 histY = rgbToYCoCg( tm( hist.rgb ) );
  vec3 clipped = clipToAABB( histY, lo, hi );

  float offscreen = any( lessThan( prevUv, vec2( 0.0 ) ) ) || any( greaterThan( prevUv, vec2( 1.0 ) ) ) ? 1.0 : 0.0;

  // Disocclusion: the history stores linear depth, the reprojection gives the
  // depth that pixel *should* have had last frame.
  float expected = clamp( prevClip.w / uFar, 0.0, 1.0 );
  float stored = texture( uHistory, prevUv ).a;
  float dDiff = abs( stored - expected ) / max( expected, 1e-3 );
  float disocclusion = smoothstep( 0.035, 0.14, dDiff ) * step( 0.0002, expected );

  float alpha = mix( uFeedbackStill, uFeedbackMoving, clamp( velPx / 10.0, 0.0, 1.0 ) );
  alpha = mix( alpha, 1.0, max( max( offscreen, disocclusion ), uReset ) );

  // A history sample that had to be dragged a long way into the box was a bad
  // prediction; trust the new frame more so it converges instead of pumping.
  float clipDist = length( clipped - histY );
  alpha = clamp( alpha + clipDist * 0.35, 0.0, 1.0 );

  vec3 resolved = ycoCgToRgb( mix( clipped, centre, alpha ) );
  fragColor = vec4( max( tmInv( resolved ), vec3( 0.0 ) ), linDepth );
}
`;

const HALTON_COUNT = 8;

export class TAAPass {
  constructor() {
    this.pass = new ShaderPass('postfx/taa', FRAGMENT, {
      uCurrent: { value: null },
      uHistory: { value: null },
      uDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uJitterUV: { value: new THREE.Vector2() },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uReset: { value: 1 },
      uFeedbackStill: { value: 0.055 },
      uFeedbackMoving: { value: 0.26 },
      uClampGamma: { value: 1.25 },
    });
    this.history = [null, null];
    this.write = 0;
    this.needsReset = true;
    this.jitterScale = 1.0;
  }

  setSize(w, h) {
    for (let i = 0; i < 2; i++) {
      this.history[i]?.dispose();
      this.history[i] = makeRT(w, h, { name: `taa${i}` });
    }
    this.needsReset = true;
    this.pass.uniforms.uResolution.value.set(w, h);
    this.pass.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  /** Halton(2,3) sub-pixel offset in NDC for frame `index`. */
  jitterNDC(index, w, h, out) {
    const i = (index % HALTON_COUNT) + 1;
    const jx = (halton2(i) - 0.5) * this.jitterScale;
    const jy = (halton3(i) - 0.5) * this.jitterScale;
    return out.set((2 * jx) / w, (2 * jy) / h);
  }

  render(renderer, current, depth, jitterNdc) {
    const u = this.pass.uniforms;
    const read = this.history[1 - this.write];
    const dst = this.history[this.write];
    u.uCurrent.value = current;
    u.uHistory.value = read.texture;
    u.uDepth.value = depth;
    u.uJitterUV.value.set(jitterNdc.x * 0.5, jitterNdc.y * 0.5);
    u.uReset.value = this.needsReset ? 1 : 0;
    this.pass.render(renderer, dst);
    this.needsReset = false;
    this.write = 1 - this.write;
    return dst.texture;
  }

  dispose() {
    this.pass.dispose();
    for (const rt of this.history) rt?.dispose();
  }
}

function halton2(i) {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f *= 0.5;
    r += f * (n & 1);
    n >>= 1;
  }
  return r;
}

function halton3(i) {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f /= 3;
    r += f * (n % 3);
    n = Math.floor(n / 3);
  }
  return r;
}
