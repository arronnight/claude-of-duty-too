import * as THREE from 'three';
import { ShaderPass, makeRT, VIEW_RAY_GLSL, viewRayUniforms, updateViewRay } from './Common.js';

/**
 * Ground-truth ambient occlusion: horizon search over N slices, integrated with
 * the GTAO arc formula against the normal projected into each slice plane, so
 * the result is a real cosine-weighted visibility rather than the flat
 * hemisphere estimate SSAO gives you.
 *
 * Runs at half resolution against the full-resolution depth buffer, then a
 * separable depth-aware bilateral, then temporal accumulation reprojected with
 * the same camera-only motion vectors TAA uses. Output is R = visibility,
 * G = linear view depth, which the composite pass needs for the depth-aware
 * upsample and the temporal pass needs for its rejection test.
 */

const AO_FRAGMENT = /* glsl */ `
uniform sampler2D uDepth;
uniform sampler2D uNoise;
uniform vec2 uTexelFull;
uniform vec2 uNoiseScale;
uniform float uRadius;
uniform float uProjScale;
uniform float uPower;
uniform float uFrame;

${VIEW_RAY_GLSL}

void main() {
  float d = texture( uDepth, vUv ).r;
  if ( d >= 0.9999 ) { fragColor = vec4( 1.0, uFar, 0.0, 1.0 ); return; }

  vec3 P = viewPosAt( vUv, d );
  vec3 V = normalize( -P );
  vec3 N = normalFromDepthFast( vUv, d );

  vec2 nz = texture( uNoise, gl_FragCoord.xy * uNoiseScale ).rg;
  nz.x = fract( nz.x + uFrame * 0.6180339887 );
  nz.y = fract( nz.y + uFrame * 0.4142135624 );

  float radiusPx = clamp( uRadius * uProjScale / max( 0.05, -P.z ), 6.0, 110.0 );

  float visibility = 0.0;
  for ( int slice = 0; slice < SLICES; slice++ ) {
    float phi = PI * ( float( slice ) + nz.x ) / float( SLICES );
    vec2 omega = vec2( cos( phi ), sin( phi ) );
    vec3 dirV = vec3( omega, 0.0 );

    vec3 orthoDir = dirV - dot( dirV, V ) * V;
    vec3 axis = normalize( cross( dirV, V ) );
    vec3 projN = N - axis * dot( N, axis );
    float projLen = length( projN );
    if ( projLen < 1e-4 ) continue;

    float sgn = sign( dot( orthoDir, projN ) );
    float cosNorm = clamp( dot( projN, V ) / projLen, 0.0, 1.0 );
    float n = sgn * acos( cosNorm );
    float sinN = sin( n );

    float lowCos0 = cos( n + HALF_PI );
    float lowCos1 = cos( n - HALF_PI );
    float hc0 = lowCos0;
    float hc1 = lowCos1;

    for ( int s = 0; s < STEPS; s++ ) {
      float t = ( float( s ) + nz.y ) / float( STEPS );
      float px = max( t * t * radiusPx, 1.6 + float( s ) );
      vec2 off = omega * px * uTexelFull;

      vec3 dp = viewPosAt( vUv + off, texture( uDepth, vUv + off ).r ) - P;
      float len = length( dp ) + 1e-6;
      float w = 1.0 - smoothstep( uRadius * 0.55, uRadius, len );
      hc1 = max( hc1, mix( lowCos1, dot( dp, V ) / len, w ) );

      dp = viewPosAt( vUv - off, texture( uDepth, vUv - off ).r ) - P;
      len = length( dp ) + 1e-6;
      w = 1.0 - smoothstep( uRadius * 0.55, uRadius, len );
      hc0 = max( hc0, mix( lowCos0, dot( dp, V ) / len, w ) );
    }

    float h0 = -acos( clamp( hc1, -1.0, 1.0 ) );
    float h1 = acos( clamp( hc0, -1.0, 1.0 ) );
    float arc0 = 0.25 * ( cosNorm + 2.0 * h0 * sinN - cos( 2.0 * h0 - n ) );
    float arc1 = 0.25 * ( cosNorm + 2.0 * h1 * sinN - cos( 2.0 * h1 - n ) );
    visibility += projLen * ( arc0 + arc1 );
  }

  visibility = clamp( visibility / float( SLICES ), 0.0, 1.0 );
  fragColor = vec4( pow( visibility, uPower ), -P.z, 0.0, 1.0 );
}
`;

/** Cheap 4-tap reconstruction that reuses the fast view-ray unprojection. */
const NORMAL_FAST = /* glsl */ `
vec3 normalFromDepthFast( vec2 uv, float d0 ) {
  vec3 P = viewPosAt( uv, d0 );
  vec2 ux = vec2( uTexelFull.x, 0.0 );
  vec2 uy = vec2( 0.0, uTexelFull.y );
  vec3 L = viewPosAt( uv - ux, texture( uDepth, uv - ux ).r );
  vec3 R = viewPosAt( uv + ux, texture( uDepth, uv + ux ).r );
  vec3 D = viewPosAt( uv - uy, texture( uDepth, uv - uy ).r );
  vec3 U = viewPosAt( uv + uy, texture( uDepth, uv + uy ).r );
  vec3 dx = abs( L.z - P.z ) < abs( R.z - P.z ) ? ( P - L ) : ( R - P );
  vec3 dy = abs( D.z - P.z ) < abs( U.z - P.z ) ? ( P - D ) : ( U - P );
  vec3 nn = cross( dx, dy );
  float l = length( nn );
  return l > 1e-9 ? nn / l : vec3( 0.0, 0.0, 1.0 );
}
`;

const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D uAo;
uniform vec2 uStep;

void main() {
  vec2 c = texture( uAo, vUv ).rg;
  float sum = c.r;
  float wsum = 1.0;
  for ( int i = 1; i <= 4; i++ ) {
    float fi = float( i );
    float sw = exp( -fi * fi * 0.18 );
    vec2 o = uStep * fi;

    vec2 a = texture( uAo, vUv + o ).rg;
    float wa = sw * exp( -abs( a.g - c.g ) * 6.0 );
    sum += a.r * wa; wsum += wa;

    vec2 b = texture( uAo, vUv - o ).rg;
    float wb = sw * exp( -abs( b.g - c.g ) * 6.0 );
    sum += b.r * wb; wsum += wb;
  }
  fragColor = vec4( sum / wsum, c.g, 0.0, 1.0 );
}
`;

const TEMPORAL_FRAGMENT = /* glsl */ `
uniform sampler2D uAo;
uniform sampler2D uHistory;
uniform sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uStep;
uniform float uReset;

void main() {
  vec2 c = texture( uAo, vUv ).rg;

  // Vertical half of the separable bilateral, folded into the temporal pass.
  float sum = c.r;
  float wsum = 1.0;
  float lo = c.r;
  float hi = c.r;
  for ( int i = 1; i <= 4; i++ ) {
    float fi = float( i );
    float sw = exp( -fi * fi * 0.18 );
    vec2 o = uStep * fi;
    vec2 a = texture( uAo, vUv + o ).rg;
    float wa = sw * exp( -abs( a.g - c.g ) * 6.0 );
    sum += a.r * wa; wsum += wa;
    vec2 b = texture( uAo, vUv - o ).rg;
    float wb = sw * exp( -abs( b.g - c.g ) * 6.0 );
    sum += b.r * wb; wsum += wb;
    if ( i <= 2 ) { lo = min( lo, min( a.r, b.r ) ); hi = max( hi, max( a.r, b.r ) ); }
  }
  float ao = sum / wsum;

  float d = min( texture( uDepth, vUv ).r, 0.999999 );
  vec4 wp = uInvViewProj * vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  wp /= wp.w;
  vec4 prev = uPrevViewProj * vec4( wp.xyz, 1.0 );
  vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;

  float alpha = 0.12;
  if ( any( lessThan( prevUv, vec2( 0.0 ) ) ) || any( greaterThan( prevUv, vec2( 1.0 ) ) ) ) alpha = 1.0;

  vec2 h = texture( uHistory, prevUv ).rg;
  float dDiff = abs( h.g - prev.w ) / max( prev.w, 1e-3 );
  if ( dDiff > 0.05 ) alpha = 1.0;
  alpha = max( alpha, uReset );

  float blended = mix( clamp( h.r, lo - 0.08, hi + 0.08 ), ao, alpha );
  fragColor = vec4( blended, c.g, 0.0, 1.0 );
}
`;

export class GTAOPass {
  constructor(slices = 4, steps = 8) {
    const aoUniforms = {
      uDepth: { value: null },
      uNoise: { value: null },
      uTexelFull: { value: new THREE.Vector2() },
      uNoiseScale: { value: new THREE.Vector2(1 / 32, 1 / 32) },
      uRadius: { value: 0.9 },
      uProjScale: { value: 500 },
      uPower: { value: 1.35 },
      uFrame: { value: 0 },
      ...viewRayUniforms(),
    };
    // NORMAL_FAST needs the uniforms declared by VIEW_RAY_GLSL, so it is
    // appended after the block rather than living in the shared prelude.
    this.ao = new ShaderPass(
      'postfx/gtao',
      AO_FRAGMENT.replace('void main() {', NORMAL_FAST + '\nvoid main() {'),
      aoUniforms,
      { SLICES: slices, STEPS: steps }
    );

    this.blur = new ShaderPass('postfx/gtao-blur', BLUR_FRAGMENT, {
      uAo: { value: null },
      uStep: { value: new THREE.Vector2() },
    });

    this.temporal = new ShaderPass('postfx/gtao-temporal', TEMPORAL_FRAGMENT, {
      uAo: { value: null },
      uHistory: { value: null },
      uDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uStep: { value: new THREE.Vector2() },
      uReset: { value: 1 },
    });

    this.raw = null;
    this.tmp = null;
    this.hist = [null, null];
    this.write = 0;
    this.needsReset = true;
  }

  setSize(w, h) {
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.raw?.dispose();
    this.tmp?.dispose();
    this.raw = makeRT(hw, hh, { format: THREE.RGBAFormat, name: 'gtao-raw' });
    this.tmp = makeRT(hw, hh, { format: THREE.RGBAFormat, name: 'gtao-tmp' });
    for (let i = 0; i < 2; i++) {
      this.hist[i]?.dispose();
      this.hist[i] = makeRT(hw, hh, { format: THREE.RGBAFormat, name: `gtao-h${i}` });
    }
    this.ao.uniforms.uTexelFull.value.set(1 / w, 1 / h);
    this.blur.uniforms.uStep.value.set(1 / hw, 0);
    this.temporal.uniforms.uStep.value.set(0, 1 / hh);
    this.needsReset = true;
  }

  render(renderer, depthTex, camera, frame, invViewProj, prevViewProj) {
    const au = this.ao.uniforms;
    au.uDepth.value = depthTex;
    au.uFrame.value = frame % 64;
    updateViewRay(au, camera);
    au.uProjScale.value =
      0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) / this.ao.uniforms.uTexelFull.value.y;
    this.ao.render(renderer, this.raw);

    this.blur.uniforms.uAo.value = this.raw.texture;
    this.blur.render(renderer, this.tmp);

    const tu = this.temporal.uniforms;
    const dst = this.hist[this.write];
    tu.uAo.value = this.tmp.texture;
    tu.uHistory.value = this.hist[1 - this.write].texture;
    tu.uDepth.value = depthTex;
    tu.uInvViewProj.value.copy(invViewProj);
    tu.uPrevViewProj.value.copy(prevViewProj);
    tu.uReset.value = this.needsReset ? 1 : 0;
    this.temporal.render(renderer, dst);
    this.needsReset = false;
    this.write = 1 - this.write;
    return dst.texture;
  }

  dispose() {
    this.ao.dispose();
    this.blur.dispose();
    this.temporal.dispose();
    this.raw?.dispose();
    this.tmp?.dispose();
    for (const rt of this.hist) rt?.dispose();
  }
}
