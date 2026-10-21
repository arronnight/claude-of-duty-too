import * as THREE from 'three';
import { ShaderPass } from './Common.js';

/**
 * The display transform, in one pass: chromatic aberration and lens dirt on the
 * incoming HDR, an optical vignette, auto exposure, ACES, the sRGB OETF, the 3D
 * LUT look, then film grain.
 *
 * Tone mapping lives here rather than on the renderer because the scene is
 * rendered into an HDR target — three only applies its tone map when drawing
 * straight to the canvas, so bloom, exposure and the grade would all be
 * operating on the wrong signal otherwise. The ACES fit is byte-identical to
 * three's so material tuning done against the default renderer still holds.
 *
 * Everything downstream of this pass (CAS, FXAA) is display-encoded, which is
 * exactly where both of those algorithms expect to work.
 */

const FRAGMENT = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uDirt;
uniform sampler2D uAvgLum;
uniform sampler3D uLutA;
uniform sampler3D uLutB;

uniform vec2 uResolution;
uniform float uLutMix;
uniform float uLutStrength;
uniform float uExposureBase;
uniform float uKey;
uniform float uMinExposure;
uniform float uMaxExposure;
uniform float uBloomStrength;
uniform float uDirtStrength;
uniform float uCA;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uLutSize;

vec3 hdrAt( vec2 uv ) {
  return texture( uScene, uv ).rgb + texture( uBloom, uv ).rgb * uBloomStrength;
}

vec3 RRTAndODTFit( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}

vec3 aces( vec3 color ) {
  const mat3 IN = mat3(
    vec3( 0.59719, 0.07600, 0.02840 ),
    vec3( 0.35458, 0.90834, 0.13383 ),
    vec3( 0.04823, 0.01566, 0.83777 ) );
  const mat3 OUT = mat3(
    vec3(  1.60475, -0.10208, -0.00327 ),
    vec3( -0.53108,  1.10813, -0.07276 ),
    vec3( -0.07367, -0.00605,  1.07602 ) );
  color = IN * color;
  color = RRTAndODTFit( color );
  return clamp( OUT * color, 0.0, 1.0 );
}

vec3 linearToSrgb( vec3 c ) {
  return mix( c * 12.92, 1.055 * pow( max( c, vec3( 0.0031308 ) ), vec3( 1.0 / 2.4 ) ) - 0.055,
              step( vec3( 0.0031308 ), c ) );
}

vec3 lutLookup( sampler3D lut, vec3 c ) {
  vec3 uvw = ( clamp( c, 0.0, 1.0 ) * ( uLutSize - 1.0 ) + 0.5 ) / uLutSize;
  return texture( lut, uvw ).rgb;
}

void main() {
  vec2 cc = vUv - 0.5;
  float r = length( cc ) * 1.41421356;

  // Chromatic aberration, confined to the outer third of the frame.
  float caMask = smoothstep( 0.74, 1.05, r );
  float k = uCA * caMask;
  vec3 hdr;
  if ( k > 0.0002 ) {
    hdr.r = hdrAt( 0.5 + cc * ( 1.0 + k ) ).r;
    hdr.g = hdrAt( vUv ).g;
    hdr.b = hdrAt( 0.5 + cc * ( 1.0 - k ) ).b;
  } else {
    hdr = hdrAt( vUv );
  }

  if ( uDirtStrength > 0.0 ) {
    vec3 dirt = texture( uDirt, vUv ).rgb;
    hdr += texture( uBloom, vUv ).rgb * dirt * uDirtStrength;
  }

  float vig = mix( 1.0, smoothstep( 1.16, 0.24, r ), uVignette );
  hdr *= vig;

  float avg = max( texture( uAvgLum, vec2( 0.5 ) ).r, 1e-5 );
  float exposure = uExposureBase * clamp( uKey / avg, uMinExposure, uMaxExposure );

  vec3 col = aces( hdr * ( exposure / 0.6 ) );
  col = linearToSrgb( col );

  vec3 graded = mix( lutLookup( uLutA, col ), lutLookup( uLutB, col ), uLutMix );
  col = mix( col, graded, uLutStrength );

  if ( uGrain > 0.0 ) {
    vec2 p = vUv * uResolution;
    float t = fract( uTime * 24.0 ) * 137.0;
    float n1 = hash12( p + t );
    float n2 = hash12( p * 0.487 + t * 1.31 );
    float g = ( n1 * 0.68 + n2 * 0.32 ) - 0.5;
    float chroma = hash12( p * 1.13 - t ) - 0.5;
    float l = luma( col );
    float amt = uGrain * mix( 1.7, 0.22, sqrt( clamp( l, 0.0, 1.0 ) ) );
    col += g * amt;
    col.r += chroma * amt * 0.22;
    col.b -= chroma * amt * 0.22;
  }

  // Quantisation dither, triangular PDF, +/- 1 LSB peak. A 3 km haze gradient
  // across an 8-bit PNG bands, and none of the reference frames band. Placed
  // AFTER the sRGB encode and the LUT rather than before them as the brief
  // asked: 1/255 of *display-linear* becomes ~13/255 after the OETF's toe, so
  // dithering upstream of the encode puts visible noise in every shadow. This
  // is where the quantiser is, so this is where the dither belongs. The grain
  // above already dithers where it is enabled, but it is level-dependent and
  // fades toward white, which is exactly where a sky gradient bands.
  vec2 dp = vUv * uResolution;
  float d = ( hash12( dp + 0.5 ) + hash12( dp.yx * 1.37 + 7.31 ) - 1.0 ) / 255.0;
  col += d * 0.5;

  fragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
}
`;

export class GradePass {
  constructor(lutSize) {
    this.pass = new ShaderPass('postfx/grade', FRAGMENT, {
      uScene: { value: null },
      uBloom: { value: null },
      uDirt: { value: null },
      uAvgLum: { value: null },
      uLutA: { value: null },
      uLutB: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uLutMix: { value: 0 },
      uLutStrength: { value: 1 },
      uExposureBase: { value: 1 },
      uKey: { value: 0.20 },
      uMinExposure: { value: 0.32 },
      uMaxExposure: { value: 7.5 },
      uBloomStrength: { value: 0.055 },
      uDirtStrength: { value: 0.5 },
      uCA: { value: 0.0022 },
      uVignette: { value: 0.34 },
      uGrain: { value: 0.026 },
      uTime: { value: 0 },
      uLutSize: { value: lutSize },
    });
  }

  setSize(w, h) {
    this.pass.uniforms.uResolution.value.set(w, h);
  }

  render(renderer, target) {
    this.pass.render(renderer, target);
  }

  get uniforms() {
    return this.pass.uniforms;
  }

  dispose() {
    this.pass.dispose();
  }
}
