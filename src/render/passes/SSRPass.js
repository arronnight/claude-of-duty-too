import * as THREE from 'three';
import { ShaderPass, makeRT, VIEW_RAY_GLSL, viewRayUniforms, updateViewRay } from './Common.js';

/**
 * Half-resolution screen-space reflections, tier gated and off by default.
 *
 * There is no G-buffer roughness to read, so the pass would happily make dry
 * concrete look like a wet floor. It is therefore restricted to near-horizontal
 * upward-facing surfaces — the ground plane, where a reflection actually reads
 * as damp asphalt — with a Fresnel weight and a hard fade at the screen edge
 * and at ray-march failure. Enable with `ctx.postfx.set('ssr', true)`.
 */

const FRAGMENT = /* glsl */ `
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform mat4 uProj;
uniform vec2 uTexelFull;
uniform float uMaxDistance;
uniform float uThickness;
uniform float uNormalCutoff;
uniform vec3 uUpView;

${VIEW_RAY_GLSL}

vec3 reconstructNormal( vec2 uv, float d0 ) {
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

vec2 project( vec3 v ) {
  vec4 c = uProj * vec4( v, 1.0 );
  return ( c.xy / c.w ) * 0.5 + 0.5;
}

void main() {
  float d = texture( uDepth, vUv ).r;
  float viewZ = viewZFromDepth( min( d, 0.999999 ), uNear, uFar );
  if ( d >= 0.9999 ) { fragColor = vec4( 0.0, 0.0, 0.0, -viewZ / uFar ); return; }

  vec3 P = viewPosAt( vUv, d );
  vec3 N = reconstructNormal( vUv, d );
  vec3 V = normalize( -P );

  float upness = clamp( ( dot( N, uUpView ) - uNormalCutoff ) / ( 1.0 - uNormalCutoff ), 0.0, 1.0 );
  if ( upness <= 0.0 ) { fragColor = vec4( 0.0, 0.0, 0.0, -viewZ / uFar ); return; }

  vec3 R = reflect( -V, N );
  if ( R.z > 0.0 ) { fragColor = vec4( 0.0, 0.0, 0.0, -viewZ / uFar ); return; }

  float stepLen = uMaxDistance / float( STEPS );
  float jitter = ign( gl_FragCoord.xy );
  vec3 hitColor = vec3( 0.0 );
  float hit = 0.0;
  vec2 hitUv = vec2( 0.0 );

  for ( int i = 1; i <= STEPS; i++ ) {
    vec3 p = P + R * ( ( float( i ) + jitter ) * stepLen );
    vec2 uv = project( p );
    if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) break;
    float sd = texture( uDepth, uv ).r;
    float sz = viewZFromDepth( min( sd, 0.999999 ), uNear, uFar );
    float diff = sz - p.z;
    if ( diff > 0.0 && diff < uThickness + stepLen ) {
      // Binary refine so the hit lands on the surface rather than a step behind it.
      vec3 lo = p - R * stepLen;
      vec3 hi = p;
      for ( int k = 0; k < 5; k++ ) {
        vec3 mid = ( lo + hi ) * 0.5;
        vec2 muv = project( mid );
        float mz = viewZFromDepth( min( texture( uDepth, muv ).r, 0.999999 ), uNear, uFar );
        if ( mz - mid.z > 0.0 ) hi = mid; else lo = mid;
      }
      hitUv = project( hi );
      hitColor = texture( uColor, hitUv ).rgb;
      hit = 1.0;
      break;
    }
  }

  vec2 edge = abs( hitUv - 0.5 ) * 2.0;
  float fade = ( 1.0 - smoothstep( 0.72, 1.0, max( edge.x, edge.y ) ) ) * hit;
  float fresnel = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 4.0 );
  float weight = clamp( fade * upness * mix( 0.05, 1.0, fresnel ), 0.0, 1.0 );

  // Premultiplied so the composite's bilateral upsample can keep alpha for the
  // depth key the way the AO and volumetric buffers do.
  fragColor = vec4( hitColor * weight, -viewZ / uFar );
}
`;

export class SSRPass {
  constructor(steps = 24) {
    this.pass = new ShaderPass(
      'postfx/ssr',
      FRAGMENT,
      {
        uColor: { value: null },
        uDepth: { value: null },
        uProj: { value: new THREE.Matrix4() },
        uTexelFull: { value: new THREE.Vector2() },
        uUpView: { value: new THREE.Vector3(0, 1, 0) },
        uMaxDistance: { value: 14 },
        uThickness: { value: 0.4 },
        uNormalCutoff: { value: 0.72 },
        ...viewRayUniforms(),
      },
      { STEPS: steps }
    );
    this.rt = null;
  }

  setSize(w, h) {
    this.rt?.dispose();
    this.rt = makeRT(Math.max(1, w >> 1), Math.max(1, h >> 1), { name: 'ssr' });
    this.pass.uniforms.uTexelFull.value.set(1 / w, 1 / h);
  }

  render(renderer, color, depth, camera) {
    const u = this.pass.uniforms;
    u.uColor.value = color;
    u.uDepth.value = depth;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uUpView.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    updateViewRay(u, camera);
    this.pass.render(renderer, this.rt);
    return this.rt.texture;
  }

  dispose() {
    this.pass.dispose();
    this.rt?.dispose();
  }
}
