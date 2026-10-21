import * as THREE from 'three';
import { ShaderPass, makeRT, VIEW_RAY_GLSL, viewRayUniforms, updateViewRay } from './Common.js';

/**
 * Circle-of-confusion depth of field, only ever armed for ADS and cinematic
 * framing — a permanently blurred background in a shooter reads as a bug.
 *
 * Half-resolution scatter-as-gather with a 32 tap golden-angle disc. Near and
 * far fields are accumulated separately: the far field is masked by the
 * *destination* pixel's CoC so a sharp foreground cannot smear into it, while
 * the near field is allowed to bleed over sharp background, which is the
 * behaviour that removes the classic halo around a foreground silhouette.
 */

const COC = /* glsl */ `
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform float uFocus;
uniform float uRange;
uniform float uNearScale;
uniform float uFarScale;

${VIEW_RAY_GLSL}

void main() {
  vec2 t = 1.0 / vec2( textureSize( uColor, 0 ) );
  vec3 c = texture( uColor, vUv + vec2( -0.5, -0.5 ) * t ).rgb;
  c += texture( uColor, vUv + vec2( 0.5, -0.5 ) * t ).rgb;
  c += texture( uColor, vUv + vec2( -0.5, 0.5 ) * t ).rgb;
  c += texture( uColor, vUv + vec2( 0.5, 0.5 ) * t ).rgb;
  c *= 0.25;

  float d = min( texture( uDepth, vUv ).r, 0.999999 );
  float dist = -viewZFromDepth( d, uNear, uFar );
  float signedCoc = ( dist - uFocus ) / max( dist, 1e-3 );
  signedCoc *= signedCoc > 0.0 ? uFarScale : uNearScale;
  signedCoc = clamp( signedCoc / max( uRange, 1e-3 ), -1.0, 1.0 );
  fragColor = vec4( c, signedCoc );
}
`;

const GATHER = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;

void main() {
  vec4 centre = texture( uSrc, vUv );
  float cocC = centre.a;

  vec3 farSum = centre.rgb * max( cocC, 0.0 );
  float farW = max( cocC, 0.0 );
  vec3 nearSum = centre.rgb * max( -cocC, 0.0 );
  float nearW = max( -cocC, 0.0 );

  float ang = ign( gl_FragCoord.xy ) * TAU;
  float ca = cos( ang );
  float sa = sin( ang );

  for ( int i = 0; i < TAPS; i++ ) {
    float fi = float( i ) + 0.5;
    float r = sqrt( fi / float( TAPS ) );
    float a = fi * 2.39996323;
    vec2 o = vec2( cos( a ), sin( a ) ) * r;
    o = vec2( o.x * ca - o.y * sa, o.x * sa + o.y * ca );
    vec2 uv = vUv + o * uRadius * uTexel;
    vec4 s = texture( uSrc, uv );

    // A sample only reaches this pixel if its own blur circle is wide enough.
    float reach = smoothstep( r - 0.12, r + 0.12, abs( s.a ) );
    float wFar = max( s.a, 0.0 ) * reach * step( 0.0, cocC + 0.02 );
    float wNear = max( -s.a, 0.0 ) * reach;
    farSum += s.rgb * wFar;  farW += wFar;
    nearSum += s.rgb * wNear; nearW += wNear;
  }

  vec3 farC = farSum / max( farW, 1e-4 );
  vec3 nearC = nearSum / max( nearW, 1e-4 );
  float nearAlpha = clamp( nearW / ( float( TAPS ) * 0.28 ), 0.0, 1.0 );
  fragColor = vec4( mix( farC, nearC, nearAlpha ), max( clamp( cocC, 0.0, 1.0 ), nearAlpha ) );
}
`;

const COMPOSITE = /* glsl */ `
uniform sampler2D uSharp;
uniform sampler2D uBlur;
uniform float uAmount;

void main() {
  vec4 b = texture( uBlur, vUv );
  vec3 s = texture( uSharp, vUv ).rgb;
  float k = clamp( b.a * uAmount, 0.0, 1.0 );
  fragColor = vec4( mix( s, b.rgb, smoothstep( 0.0, 0.65, k ) ), 1.0 );
}
`;

export class DOFPass {
  constructor(taps = 32) {
    this.coc = new ShaderPass('postfx/dof-coc', COC, {
      uColor: { value: null },
      uDepth: { value: null },
      uFocus: { value: 6 },
      uRange: { value: 1 },
      uNearScale: { value: 2.6 },
      uFarScale: { value: 1.1 },
      ...viewRayUniforms(),
    });
    this.gather = new ShaderPass(
      'postfx/dof-gather',
      GATHER,
      {
        uSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 14 },
      },
      { TAPS: taps }
    );
    this.composite = new ShaderPass('postfx/dof-composite', COMPOSITE, {
      uSharp: { value: null },
      uBlur: { value: null },
      uAmount: { value: 1 },
    });
    this.rtCoc = null;
    this.rtBlur = null;
    this.focus = 8;
    this.range = 0.55;
    this.radius = 14;
  }

  setSize(w, h) {
    this.rtCoc?.dispose();
    this.rtBlur?.dispose();
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.rtCoc = makeRT(hw, hh, { name: 'dof-coc' });
    this.rtBlur = makeRT(hw, hh, { name: 'dof-blur' });
    this.gather.uniforms.uTexel.value.set(1 / hw, 1 / hh);
  }

  render(renderer, target, color, depth, camera) {
    const cu = this.coc.uniforms;
    cu.uColor.value = color;
    cu.uDepth.value = depth;
    cu.uFocus.value = this.focus;
    cu.uRange.value = this.range;
    updateViewRay(cu, camera);
    this.coc.render(renderer, this.rtCoc);

    this.gather.uniforms.uSrc.value = this.rtCoc.texture;
    this.gather.uniforms.uRadius.value = this.radius;
    this.gather.render(renderer, this.rtBlur);

    this.composite.uniforms.uSharp.value = color;
    this.composite.uniforms.uBlur.value = this.rtBlur.texture;
    this.composite.render(renderer, target);
  }

  dispose() {
    this.coc.dispose();
    this.gather.dispose();
    this.composite.dispose();
    this.rtCoc?.dispose();
    this.rtBlur?.dispose();
  }
}
