import * as THREE from 'three';
import { ShaderPass, makeRT } from './Common.js';

/**
 * One-off procedural lens dirt: sparse specks, a few greasy wipe arcs and a
 * dusting of fine grit, biased toward the frame edges the way a real front
 * element wears. Rendered once into an 8-bit target at init; the grade pass
 * only ever multiplies it against thresholded bloom, so it is invisible until
 * something genuinely bright is on screen.
 */

const DIRT = /* glsl */ `
float h1( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}
float vnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = h1( i );
  float b = h1( i + vec2( 1.0, 0.0 ) );
  float c = h1( i + vec2( 0.0, 1.0 ) );
  float d = h1( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float fbm( vec2 p ) {
  float v = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 5; i++ ) { v += a * vnoise( p ); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = vUv;
  float acc = 0.0;

  // Specks at four scales; only a fraction of cells are populated.
  for ( int i = 0; i < 4; i++ ) {
    float s = exp2( float( i ) );
    vec2 g = uv * 22.0 * s;
    vec2 id = floor( g );
    vec2 f = fract( g ) - 0.5;
    vec2 off = vec2( h1( id + 1.7 ), h1( id + 5.3 ) ) - 0.5;
    float pick = h1( id + 11.9 );
    float rad = mix( 0.05, 0.30, h1( id + 3.1 ) );
    float d = length( ( f - off * 0.7 ) * vec2( 1.0, 1.0 + h1( id + 8.2 ) ) );
    acc += smoothstep( rad, rad * 0.15, d ) * step( 0.80, pick ) * ( 0.55 / s );
  }

  // Wipe arcs: a couple of smeared rings left by a sleeve.
  for ( int i = 0; i < 3; i++ ) {
    float fi = float( i );
    vec2 c = vec2( 0.5 + 0.34 * sin( fi * 2.4 + 0.7 ), 0.5 + 0.30 * cos( fi * 1.9 ) );
    float r = length( ( uv - c ) * vec2( 1.0, 0.72 ) );
    float band = exp( -pow( ( r - ( 0.16 + 0.08 * fi ) ) * 26.0, 2.0 ) );
    acc += band * ( 0.16 + 0.10 * fbm( uv * 12.0 + fi * 7.0 ) );
  }

  // Fine grit, thresholded so it stays sparse.
  float grit = fbm( uv * 42.0 );
  acc += smoothstep( 0.62, 0.92, grit ) * 0.32;
  acc += smoothstep( 0.74, 1.0, fbm( uv * 130.0 ) ) * 0.18;

  // A real element is cleanest where it gets wiped: the middle.
  float r = length( uv - 0.5 ) * 1.4142;
  acc *= mix( 0.45, 1.35, smoothstep( 0.15, 0.95, r ) );

  float v = clamp( acc, 0.0, 1.0 );
  // Slight warm cast — dust scatters long wavelengths a touch more.
  fragColor = vec4( v, v * 0.96, v * 0.88, 1.0 );
}
`;

export function buildLensDirt(renderer, size = 512) {
  const rt = makeRT(size, size, {
    type: THREE.UnsignedByteType,
    name: 'lensDirt',
  });
  const pass = new ShaderPass('postfx/lens-dirt', DIRT, {});
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  pass.render(renderer, rt);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  pass.dispose();
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}
