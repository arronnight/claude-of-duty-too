import * as THREE from 'three';
import { ShaderPass, VIEW_RAY_GLSL, viewRayUniforms, updateViewRay } from './Common.js';

/**
 * Composites the separately rendered weapon layer over the world.
 *
 * The viewmodel never sees TAA jitter, GTAO or motion blur — an FPS weapon has
 * to stay razor sharp or the whole frame feels soft — so it gets its own tiny
 * depth-of-field instead: when aiming, the rear of the receiver and the muzzle
 * fall off around the focused sight, which is what sells the ADS pose.
 *
 * The merge happens in HDR before bloom so a muzzle flash blooms and the weapon
 * shares the world's exposure and grade rather than being pasted on afterwards.
 */

const FRAGMENT = /* glsl */ `
uniform sampler2D uWorld;
uniform sampler2D uView;
uniform sampler2D uViewDepth;
uniform vec2 uTexel;
uniform float uFocus;
uniform float uBlurScale;
uniform float uRadius;

${VIEW_RAY_GLSL}

void main() {
  vec3 world = texture( uWorld, vUv ).rgb;
  vec4 vm = texture( uView, vUv );

  if ( uBlurScale > 0.0 ) {
    float d = texture( uViewDepth, vUv ).r;
    if ( d < 0.999999 ) {
      float dist = -viewZFromDepth( d, uNear, uFar );
      float coc = clamp( abs( dist - uFocus ) / max( uFocus, 1e-3 ) * uBlurScale, 0.0, 1.0 );
      if ( coc > 0.02 ) {
        vec4 acc = vec4( 0.0 );
        float ang = ign( gl_FragCoord.xy ) * TAU;
        float ca = cos( ang ), sa = sin( ang );
        for ( int i = 0; i < 12; i++ ) {
          float fi = float( i ) + 0.5;
          float r = sqrt( fi / 12.0 );
          float a = fi * 2.39996323;
          vec2 o = vec2( cos( a ), sin( a ) ) * r;
          o = vec2( o.x * ca - o.y * sa, o.x * sa + o.y * ca );
          acc += texture( uView, vUv + o * coc * uRadius * uTexel );
        }
        vm = mix( vm, acc / 12.0, smoothstep( 0.02, 0.35, coc ) );
      }
    }
  }

  fragColor = vec4( mix( world, vm.rgb, clamp( vm.a, 0.0, 1.0 ) ), 1.0 );
}
`;

export class ViewmodelPass {
  constructor() {
    this.pass = new ShaderPass('postfx/viewmodel', FRAGMENT, {
      uWorld: { value: null },
      uView: { value: null },
      uViewDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uFocus: { value: 0.4 },
      uBlurScale: { value: 0 },
      uRadius: { value: 9 },
      ...viewRayUniforms(),
    });
  }

  setSize(w, h) {
    this.pass.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(renderer, target, world, view, viewDepth, viewCamera, focus, blurScale) {
    const u = this.pass.uniforms;
    u.uWorld.value = world;
    u.uView.value = view;
    u.uViewDepth.value = viewDepth;
    u.uFocus.value = focus;
    u.uBlurScale.value = blurScale;
    updateViewRay(u, viewCamera);
    this.pass.render(renderer, target);
  }

  dispose() {
    this.pass.dispose();
  }
}
