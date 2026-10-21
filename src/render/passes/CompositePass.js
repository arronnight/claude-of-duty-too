import * as THREE from 'three';
import { ShaderPass, VIEW_RAY_GLSL, viewRayUniforms, updateViewRay } from './Common.js';

/**
 * Folds the three half-resolution buffers back into the full-resolution HDR
 * image with a depth-aware joint bilateral upsample (bilinear weights times an
 * inverse depth-difference weight), so occlusion and god rays do not bleed
 * across silhouettes the way a plain bilinear upsample does.
 *
 * AO is deliberately *not* a flat multiply. The scene is forward rendered, so
 * there is no separate indirect-diffuse buffer to modulate; instead the
 * indirect share of each pixel is estimated as the ratio of the frame's adapted
 * average luminance to the pixel's own luminance, damped further where the
 * surface faces the key light. A wall in full sun keeps its brightness; a
 * corner lit only by sky and bounce takes the full occlusion.
 */

const FRAGMENT = /* glsl */ `
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform sampler2D uAo;
uniform sampler2D uVol;
uniform sampler2D uSsr;
uniform sampler2D uAvgLum;
uniform vec2 uTexelHalf;
uniform vec3 uSunDirView;
uniform float uAoStrength;
uniform float uIndirectScale;
uniform float uSunWeight;
uniform float uVolStrength;
uniform float uSsrStrength;
uniform vec2 uTexelFull;

${VIEW_RAY_GLSL}

vec4 upsample( sampler2D tex, float refZ, int chan ) {
  vec2 sp = vUv / uTexelHalf - 0.5;
  vec2 base = floor( sp );
  vec2 f = sp - base;
  vec4 acc = vec4( 0.0 );
  float wtot = 0.0;
  for ( int j = 0; j < 2; j++ ) {
    for ( int i = 0; i < 2; i++ ) {
      vec2 p = ( base + vec2( float( i ), float( j ) ) + 0.5 ) * uTexelHalf;
      vec4 s = texture( tex, p );
      float bw = ( i == 0 ? 1.0 - f.x : f.x ) * ( j == 0 ? 1.0 - f.y : f.y );
      float sz = chan == 0 ? s.g : s.a;
      float w = bw / ( 1e-3 + abs( sz - refZ ) * 12.0 );
      acc += s * w;
      wtot += w;
    }
  }
  return acc / max( wtot, 1e-5 );
}

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

void main() {
  vec3 color = texture( uColor, vUv ).rgb;
  float d = texture( uDepth, vUv ).r;
  bool sky = d >= 0.9999;
  float viewZ = viewZFromDepth( min( d, 0.999999 ), uNear, uFar );

  if ( uAoStrength > 0.0 && !sky ) {
    float ao = upsample( uAo, -viewZ, 0 ).r;
    vec3 N = normalFromDepthFast( vUv, d );
    float avg = max( texture( uAvgLum, vec2( 0.5 ) ).r, 1e-4 );
    float indirect = clamp( avg * uIndirectScale / max( luma( color ), 1e-4 ), 0.0, 1.0 );
    float sunFace = clamp( dot( N, uSunDirView ), 0.0, 1.0 ) * uSunWeight;
    float w = indirect * ( 1.0 - 0.65 * sunFace ) * uAoStrength;
    color *= mix( 1.0, ao, w );
  }

  if ( uSsrStrength > 0.0 && !sky ) {
    vec4 refl = upsample( uSsr, clamp( -viewZ / uFar, 0.0, 1.0 ), 1 );
    color += max( refl.rgb, vec3( 0.0 ) ) * uSsrStrength;
  }

  if ( uVolStrength > 0.0 ) {
    vec4 v = upsample( uVol, clamp( -viewZ / uFar, 0.0, 1.0 ), 1 );
    color += max( v.rgb, vec3( 0.0 ) ) * uVolStrength;
  }

  fragColor = vec4( color, 1.0 );
}
`;

const _sunView = new THREE.Vector3();

export class CompositePass {
  constructor() {
    this.pass = new ShaderPass('postfx/composite', FRAGMENT, {
      uColor: { value: null },
      uDepth: { value: null },
      uAo: { value: null },
      uVol: { value: null },
      uSsr: { value: null },
      uAvgLum: { value: null },
      uTexelHalf: { value: new THREE.Vector2() },
      uTexelFull: { value: new THREE.Vector2() },
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      uAoStrength: { value: 1.0 },
      uIndirectScale: { value: 0.8 },
      uSunWeight: { value: 1.0 },
      uVolStrength: { value: 1.0 },
      uSsrStrength: { value: 0.0 },
      ...viewRayUniforms(),
    });
  }

  setSize(w, h) {
    this.pass.uniforms.uTexelFull.value.set(1 / w, 1 / h);
    this.pass.uniforms.uTexelHalf.value.set(1 / (w >> 1 || 1), 1 / (h >> 1 || 1));
  }

  render(renderer, target, ctx, inputs) {
    const u = this.pass.uniforms;
    u.uColor.value = inputs.color;
    u.uDepth.value = inputs.depth;
    u.uAo.value = inputs.ao || inputs.fallback;
    u.uVol.value = inputs.vol || inputs.fallback;
    u.uSsr.value = inputs.ssr || inputs.fallback;
    u.uAvgLum.value = inputs.avgLum || inputs.fallback;
    u.uAoStrength.value = inputs.ao ? inputs.aoStrength : 0;
    u.uVolStrength.value = inputs.vol ? inputs.volStrength : 0;
    u.uSsrStrength.value = inputs.ssr ? inputs.ssrStrength : 0;
    updateViewRay(u, ctx.camera);

    const sun = ctx.lighting?.sunDirection || ctx.sky?.sunDirection;
    if (sun) {
      _sunView.copy(sun).transformDirection(ctx.camera.matrixWorldInverse);
      u.uSunDirView.value.copy(_sunView);
    }
    this.pass.render(renderer, target);
  }

  dispose() {
    this.pass.dispose();
  }
}
