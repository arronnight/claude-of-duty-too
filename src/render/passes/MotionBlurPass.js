import * as THREE from 'three';
import { ShaderPass, makeRT, VIEW_RAY_GLSL, viewRayUniforms, updateViewRay } from './Common.js';

/**
 * Per-pixel motion blur reconstruction (McGuire 2012).
 *
 * Velocity is camera-only, rebuilt from depth and the previous view-projection,
 * then reduced through a 16x16 tile-max and a 3x3 neighbour-max so a fast
 * silhouette can smear *past* its own edge — without the dilation, blur stops
 * dead at the object outline and reads as a smudge rather than motion.
 *
 * The whole chain is skipped on frames where the view matrix barely moved,
 * which is both the common case while aiming and exactly what the screenshot
 * harness produces.
 */

const VELOCITY = /* glsl */ `
uniform sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uResolution;
uniform vec2 uJitterUV;
uniform float uScale;
uniform float uMaxPixels;

void main() {
  float d = min( texture( uDepth, vUv ).r, 0.999999 );
  vec4 wp = uInvViewProj * vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  wp /= wp.w;
  vec4 prev = uPrevViewProj * vec4( wp.xyz, 1.0 );
  vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
  vec2 v = ( ( vUv - uJitterUV ) - prevUv ) * uResolution * uScale;
  float l = length( v );
  if ( l > uMaxPixels ) v *= uMaxPixels / l;
  fragColor = vec4( v, 0.0, 1.0 );
}
`;

const TILE_MAX = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = -1.0;
  for ( int y = 0; y < 4; y++ ) {
    for ( int x = 0; x < 4; x++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 1.5 ) * uTexel;
      vec2 v = texture( uSrc, vUv + o ).rg;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
  }
  fragColor = vec4( best, 0.0, 1.0 );
}
`;

const NEIGHBOUR_MAX = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = -1.0;
  for ( int y = -1; y <= 1; y++ ) {
    for ( int x = -1; x <= 1; x++ ) {
      vec2 v = texture( uSrc, vUv + vec2( float( x ), float( y ) ) * uTexel ).rg;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
  }
  fragColor = vec4( best, 0.0, 1.0 );
}
`;

const RECONSTRUCT = /* glsl */ `
uniform sampler2D uColor;
uniform sampler2D uVelocity;
uniform sampler2D uNeighbour;
uniform sampler2D uDepth;
uniform vec2 uTexel;

${VIEW_RAY_GLSL}

float softZ( float za, float zb ) { return clamp( 1.0 - ( za - zb ) / 0.35, 0.0, 1.0 ); }
float cone( float d, float l ) { return clamp( 1.0 - d / l, 0.0, 1.0 ); }
float cylinder( float d, float l ) { return 1.0 - smoothstep( 0.95 * l, 1.05 * l, d ); }
float depthAt( vec2 uv ) { return -viewZFromDepth( min( texture( uDepth, uv ).r, 0.999999 ), uNear, uFar ); }

void main() {
  vec3 centre = texture( uColor, vUv ).rgb;
  vec2 vmax = texture( uNeighbour, vUv ).rg;
  float vmaxLen = length( vmax );
  if ( vmaxLen < 1.0 ) { fragColor = vec4( centre, 1.0 ); return; }

  vec2 vc = texture( uVelocity, vUv ).rg;
  float lc = max( length( vc ), 0.5 );
  float zc = depthAt( vUv );

  float jitter = ign( gl_FragCoord.xy ) - 0.5;
  vec3 sum = centre;
  float wsum = 1.0;

  for ( int i = 0; i < TAPS; i++ ) {
    float t = ( float( i ) + 1.0 + jitter ) / ( float( TAPS ) + 1.0 ) - 0.5;
    vec2 uv = vUv + vmax * t * uTexel;
    float zs = depthAt( uv );
    float ls = max( length( texture( uVelocity, uv ).rg ), 0.5 );
    float dist = abs( t ) * vmaxLen;
    float f = softZ( zc, zs );
    float b = softZ( zs, zc );
    float w = f * cone( dist, ls ) + b * cone( dist, lc ) + cylinder( dist, ls ) * cylinder( dist, lc ) * 2.0;
    sum += texture( uColor, uv ).rgb * w;
    wsum += w;
  }

  fragColor = vec4( sum / wsum, 1.0 );
}
`;

export class MotionBlurPass {
  constructor(taps = 8) {
    this.velocity = new ShaderPass('postfx/velocity', VELOCITY, {
      uDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2() },
      uJitterUV: { value: new THREE.Vector2() },
      uScale: { value: 0.3 },
      uMaxPixels: { value: 56 },
    });
    this.tile = new ShaderPass('postfx/tilemax', TILE_MAX, {
      uSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.neighbour = new ShaderPass('postfx/neighbourmax', NEIGHBOUR_MAX, {
      uSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.reconstruct = new ShaderPass(
      'postfx/motionblur',
      RECONSTRUCT,
      {
        uColor: { value: null },
        uVelocity: { value: null },
        uNeighbour: { value: null },
        uDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        ...viewRayUniforms(),
      },
      { TAPS: taps }
    );

    this.rtVelocity = null;
    this.rtTileA = null;
    this.rtTileB = null;
    this.rtNeighbour = null;
    this.shutter = 0.3;
  }

  setSize(w, h) {
    for (const rt of [this.rtVelocity, this.rtTileA, this.rtTileB, this.rtNeighbour]) rt?.dispose();
    const opts = { format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.rtVelocity = makeRT(w, h, { ...opts, name: 'velocity' });
    const q = { w: Math.max(1, Math.ceil(w / 4)), h: Math.max(1, Math.ceil(h / 4)) };
    const t = { w: Math.max(1, Math.ceil(w / 16)), h: Math.max(1, Math.ceil(h / 16)) };
    this.rtTileA = makeRT(q.w, q.h, { ...opts, name: 'tileA' });
    this.rtTileB = makeRT(t.w, t.h, { ...opts, name: 'tileB' });
    this.rtNeighbour = makeRT(t.w, t.h, { ...opts, name: 'neighbourMax' });
    this.velocity.uniforms.uResolution.value.set(w, h);
    this.reconstruct.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(renderer, target, color, depth, camera, invViewProj, prevViewProj, jitterUV) {
    const vu = this.velocity.uniforms;
    vu.uDepth.value = depth;
    vu.uInvViewProj.value.copy(invViewProj);
    vu.uPrevViewProj.value.copy(prevViewProj);
    vu.uJitterUV.value.copy(jitterUV);
    vu.uScale.value = this.shutter;
    this.velocity.render(renderer, this.rtVelocity);

    this.tile.uniforms.uSrc.value = this.rtVelocity.texture;
    this.tile.uniforms.uTexel.value.set(1 / this.rtVelocity.width, 1 / this.rtVelocity.height);
    this.tile.render(renderer, this.rtTileA);

    this.tile.uniforms.uSrc.value = this.rtTileA.texture;
    this.tile.uniforms.uTexel.value.set(1 / this.rtTileA.width, 1 / this.rtTileA.height);
    this.tile.render(renderer, this.rtTileB);

    this.neighbour.uniforms.uSrc.value = this.rtTileB.texture;
    this.neighbour.uniforms.uTexel.value.set(1 / this.rtTileB.width, 1 / this.rtTileB.height);
    this.neighbour.render(renderer, this.rtNeighbour);

    const ru = this.reconstruct.uniforms;
    ru.uColor.value = color;
    ru.uVelocity.value = this.rtVelocity.texture;
    ru.uNeighbour.value = this.rtNeighbour.texture;
    ru.uDepth.value = depth;
    updateViewRay(ru, camera);
    this.reconstruct.render(renderer, target);
  }

  dispose() {
    this.velocity.dispose();
    this.tile.dispose();
    this.neighbour.dispose();
    this.reconstruct.dispose();
    for (const rt of [this.rtVelocity, this.rtTileA, this.rtTileB, this.rtNeighbour]) rt?.dispose();
  }
}
