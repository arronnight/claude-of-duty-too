import * as THREE from 'three';
import { ShaderPass } from './Common.js';

/**
 * AMD contrast-adaptive sharpening, then FXAA.
 *
 * CAS runs last at full resolution because it is the counterweight to TAA: the
 * accumulation of eight jittered samples is very slightly soft, and CAS puts
 * the acuity back without the ringing an unsharp mask would leave on high
 * contrast edges (its amplitude is clamped by the local min/max, so it cannot
 * overshoot into a halo).
 *
 * FXAA then cleans the one thing TAA cannot: the hard alpha edge where the
 * viewmodel was composited, which never went through the jittered path. Both
 * operate on the display-encoded signal, which is where they were designed to.
 */

const CAS = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uSharpness;

vec3 T( float x, float y ) { return texture( uSrc, vUv + vec2( x, y ) * uTexel ).rgb; }

void main() {
  vec3 a = T( -1.0, -1.0 ), b = T( 0.0, -1.0 ), c = T( 1.0, -1.0 );
  vec3 d = T( -1.0,  0.0 ), e = T( 0.0,  0.0 ), f = T( 1.0,  0.0 );
  vec3 g = T( -1.0,  1.0 ), h = T( 0.0,  1.0 ), i = T( 1.0,  1.0 );

  vec3 mn = min( min( min( d, e ), min( f, b ) ), h );
  mn += min( mn, min( min( a, c ), min( g, i ) ) );
  vec3 mx = max( max( max( d, e ), max( f, b ) ), h );
  mx += max( mx, max( max( a, c ), max( g, i ) ) );

  vec3 rcp = 1.0 / max( mx, vec3( 1e-4 ) );
  vec3 amp = clamp( min( mn, 2.0 - mx ) * rcp, 0.0, 1.0 );
  amp = sqrt( amp );

  float peak = -1.0 / mix( 8.0, 5.0, clamp( uSharpness, 0.0, 1.0 ) );
  vec3 w = amp * peak;
  vec3 rcpW = 1.0 / ( 1.0 + 4.0 * w );
  fragColor = vec4( clamp( ( ( b + d + f + h ) * w + e ) * rcpW, 0.0, 1.0 ), 1.0 );
}
`;

const FXAA = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;

#define EDGE_MIN 0.0312
#define EDGE_MAX 0.125
#define SUBPIX 0.75
#define STEPS 10

float lum( vec3 c ) { return sqrt( dot( c, vec3( 0.299, 0.587, 0.114 ) ) ); }

void main() {
  vec3 rgbM = texture( uSrc, vUv ).rgb;
  float lM = lum( rgbM );
  float lN = lum( texture( uSrc, vUv + vec2( 0.0, -1.0 ) * uTexel ).rgb );
  float lS = lum( texture( uSrc, vUv + vec2( 0.0,  1.0 ) * uTexel ).rgb );
  float lW = lum( texture( uSrc, vUv + vec2( -1.0, 0.0 ) * uTexel ).rgb );
  float lE = lum( texture( uSrc, vUv + vec2(  1.0, 0.0 ) * uTexel ).rgb );

  float lMin = min( lM, min( min( lN, lS ), min( lW, lE ) ) );
  float lMax = max( lM, max( max( lN, lS ), max( lW, lE ) ) );
  float range = lMax - lMin;
  if ( range < max( EDGE_MIN, lMax * EDGE_MAX ) ) { fragColor = vec4( rgbM, 1.0 ); return; }

  float lNW = lum( texture( uSrc, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb );
  float lNE = lum( texture( uSrc, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb );
  float lSW = lum( texture( uSrc, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb );
  float lSE = lum( texture( uSrc, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb );

  float lNS = lN + lS;
  float lWE = lW + lE;
  float lNWNE = lNW + lNE;
  float lSWSE = lSW + lSE;
  float lWNWSW = lNW + lSW;
  float lENESE = lNE + lSE;

  float edgeH = abs( -2.0 * lW + lWNWSW ) + abs( -2.0 * lM + lNS ) * 2.0 + abs( -2.0 * lE + lENESE );
  float edgeV = abs( -2.0 * lN + lNWNE ) + abs( -2.0 * lM + lWE ) * 2.0 + abs( -2.0 * lS + lSWSE );
  bool horizontal = edgeH >= edgeV;

  float l1 = horizontal ? lN : lW;
  float l2 = horizontal ? lS : lE;
  float g1 = abs( l1 - lM );
  float g2 = abs( l2 - lM );
  bool steepest = g1 >= g2;
  float gradient = 0.25 * max( g1, g2 );

  float stepLen = horizontal ? uTexel.y : uTexel.x;
  float lLocal = steepest ? l1 : l2;
  if ( steepest ) stepLen = -stepLen;
  float lAvg = 0.5 * ( lLocal + lM );

  vec2 uv = vUv;
  if ( horizontal ) uv.y += stepLen * 0.5; else uv.x += stepLen * 0.5;

  vec2 offset = horizontal ? vec2( uTexel.x, 0.0 ) : vec2( 0.0, uTexel.y );
  vec2 uv1 = uv - offset;
  vec2 uv2 = uv + offset;
  float end1 = lum( texture( uSrc, uv1 ).rgb ) - lAvg;
  float end2 = lum( texture( uSrc, uv2 ).rgb ) - lAvg;
  bool done1 = abs( end1 ) >= gradient;
  bool done2 = abs( end2 ) >= gradient;
  if ( !done1 ) uv1 -= offset;
  if ( !done2 ) uv2 += offset;

  if ( !done1 || !done2 ) {
    for ( int i = 2; i < STEPS; i++ ) {
      float q = i < 5 ? 1.0 : ( i < 6 ? 1.5 : ( i < 9 ? 2.0 : 4.0 ) );
      if ( !done1 ) { end1 = lum( texture( uSrc, uv1 ).rgb ) - lAvg; done1 = abs( end1 ) >= gradient; }
      if ( !done2 ) { end2 = lum( texture( uSrc, uv2 ).rgb ) - lAvg; done2 = abs( end2 ) >= gradient; }
      if ( !done1 ) uv1 -= offset * q;
      if ( !done2 ) uv2 += offset * q;
      if ( done1 && done2 ) break;
    }
  }

  float d1 = horizontal ? ( vUv.x - uv1.x ) : ( vUv.y - uv1.y );
  float d2 = horizontal ? ( uv2.x - vUv.x ) : ( uv2.y - vUv.y );
  bool near1 = d1 < d2;
  float dist = min( d1, d2 );
  float span = d1 + d2;
  float pixelOffset = -dist / max( span, 1e-6 ) + 0.5;

  bool lMLess = lM < lAvg;
  bool correct = ( ( near1 ? end1 : end2 ) < 0.0 ) != lMLess;
  float finalOffset = correct ? pixelOffset : 0.0;

  float lSum = 2.0 * ( lN + lS + lW + lE ) + lNWNE + lSWSE;
  float lAvgAll = lSum / 12.0;
  float subPix = clamp( abs( lAvgAll - lM ) / max( range, 1e-6 ), 0.0, 1.0 );
  subPix = ( -2.0 * subPix + 3.0 ) * subPix * subPix;
  finalOffset = max( finalOffset, subPix * subPix * SUBPIX );

  vec2 finalUv = vUv;
  if ( horizontal ) finalUv.y += finalOffset * stepLen; else finalUv.x += finalOffset * stepLen;
  fragColor = vec4( texture( uSrc, finalUv ).rgb, 1.0 );
}
`;

export class SharpenPass {
  constructor() {
    this.cas = new ShaderPass('postfx/cas', CAS, {
      uSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uSharpness: { value: 0.55 },
    });
    this.fxaa = new ShaderPass('postfx/fxaa', FXAA, {
      uSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
  }

  setSize(w, h) {
    this.cas.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.fxaa.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  dispose() {
    this.cas.dispose();
    this.fxaa.dispose();
  }
}
