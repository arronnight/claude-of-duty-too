import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { COMMON_GLSL } from './glsl/common.glsl.js';
import { ATMOSPHERE_GLSL } from './glsl/atmosphere.glsl.js';
import { GROUND_ALBEDO } from './constants.js';

/**
 * Inscattering cache, equirect over the whole sphere, two colour attachments:
 * attachment 0 is the sun-lit sky, attachment 1 the moon-lit sky. Both come out
 * of one raymarch because the expensive part — the view-ray transmittance — is
 * shared, so a physically moonlit night costs almost nothing extra.
 *
 * The Rayleigh phase and the ground bounce are baked in (both smooth); the Mie
 * integral is stored unphased in alpha and phased at sample time, otherwise the
 * 4-degree aureole would be destroyed by bilinear interpolation.
 */
export class AtmosphereLUT {
  constructor(width = 384, height = 192) {
    this.width = width;
    this.height = height;
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      count: 2,
    });
    for (const t of this.target.textures) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.colorSpace = THREE.NoColorSpace;
    }

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uGroundAlbedo: { value: new THREE.Vector3(...GROUND_ALBEDO) },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        in vec3 position;
        in vec2 uv;
        out vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        layout(location = 0) out vec4 outSun;
        layout(location = 1) out vec4 outMoon;
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform vec3 uGroundAlbedo;
        ${COMMON_GLSL}
        ${ATMOSPHERE_GLSL}
        void main(){
          vec3 dir = skyUVToDir(vUv);
          vec3 ro = vec3(0.0, ATM_RG + 0.02, 0.0);
          // No stochastic jitter: the LUT is magnified ~8x by the dome, which
          // would turn per-texel noise into visible cross-hatch.
          float jitter = 0.5;
          AtmResult s = atmScatter(ro, dir, uSunDir, uGroundAlbedo, jitter);
          AtmResult m = atmScatter(ro, dir, uMoonDir, uGroundAlbedo, jitter);
          outSun = vec4(s.rayleigh, s.mie);
          outMoon = vec4(m.rayleigh, m.mie);
        }
      `,
    });
    this.quad = new FullScreenQuad(this.material);
    this._slice = 0;
  }

  get sunTexture() { return this.target.textures[0]; }
  get moonTexture() { return this.target.textures[1]; }

  setLights(sunDir, moonDir) {
    this.material.uniforms.uSunDir.value.copy(sunDir);
    this.material.uniforms.uMoonDir.value.copy(moonDir);
  }

  /** Renders `slices` horizontal bands, one per call; pass 1 for a full refresh. */
  render(renderer, slices = 1) {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    if (slices <= 1) {
      this.target.scissorTest = false;
      this._slice = 0;
    } else {
      const band = Math.ceil(this.height / slices);
      const y = this._slice * band;
      this.target.scissorTest = true;
      this.target.scissor.set(0, y, this.width, Math.min(band, this.height - y));
      this._slice = (this._slice + 1) % slices;
    }
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    this.target.scissorTest = false;
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}
