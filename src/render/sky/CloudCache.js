import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { COMMON_GLSL } from './glsl/common.glsl.js';
import { ATMOSPHERE_GLSL } from './glsl/atmosphere.glsl.js';
import { CLOUDS_GLSL } from './glsl/clouds.glsl.js';

/**
 * Directional cache for the volumetric clouds. Clouds sit 1.5-8 km away, so
 * their appearance depends only on the view *direction* — caching them in an
 * equirect map costs nothing in parallax and lets the expensive raymarch run at
 * a fraction of screen resolution, one horizontal band per frame.
 *
 * Animation time is quantised to the refresh cycle, so all bands of a completed
 * sweep share one timestamp; the only discontinuity is one cycle of drift
 * (~0.13 s) between the freshest and stalest band, which is sub-pixel.
 */
export class CloudCache {
  constructor(width = 512, height = 256, slices = 8) {
    this.width = width;
    this.height = height;
    this.slices = slices;
    this._slice = 0;
    this._cycleTime = 0;

    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.wrapS = THREE.RepeatWrapping;
    this.target.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.target.texture.colorSpace = THREE.NoColorSpace;

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uNoiseVol: { value: null },
        uWeather: { value: null },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uSunLight: { value: new THREE.Vector3(1, 1, 1) },
        uMoonLight: { value: new THREE.Vector3(0, 0, 0) },
        uSkyTop: { value: new THREE.Vector3(0.2, 0.3, 0.5) },
        uSkyBottom: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
        uHaze: { value: new THREE.Vector3(0.5, 0.6, 0.7) },
        uCloudCoverage: { value: 0.60 },
        uCloudDensity: { value: 1.0 },
        uCirrusAmount: { value: 0.62 },
        uCloudWind: { value: new THREE.Vector3(0.0125, 0.0006, 0.0044) },
        uCloudTime: { value: 0 },
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
        layout(location = 0) out vec4 fragColor;
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform vec3 uSunLight;
        uniform vec3 uMoonLight;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyBottom;
        uniform vec3 uHaze;
        ${COMMON_GLSL}
        ${ATMOSPHERE_GLSL}
        ${CLOUDS_GLSL}
        void main(){
          vec3 dir = cloudUVToDir(vUv);
          float jitter = hash12(gl_FragCoord.xy * 0.7913 + 11.3);
          fragColor = marchClouds(dir, uSunDir, uSunLight, uSkyTop, uSkyBottom,
                                  uMoonDir, uMoonLight, jitter, uHaze);
        }
      `,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  get texture() { return this.target.texture; }

  /** Advance one band. `full` renders every band this call (used on a time-of-day jump). */
  render(renderer, elapsed, full = false) {
    const u = this.material.uniforms;
    if (full || this._slice === 0) this._cycleTime = elapsed;
    u.uCloudTime.value = this._cycleTime;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    if (full) {
      this.target.scissorTest = false;
      renderer.setRenderTarget(this.target);
      this.quad.render(renderer);
      this._slice = 0;
    } else {
      const band = Math.ceil(this.height / this.slices);
      const y = this._slice * band;
      this.target.scissorTest = true;
      this.target.scissor.set(0, y, this.width, Math.min(band, this.height - y));
      renderer.setRenderTarget(this.target);
      this.quad.render(renderer);
      this._slice = (this._slice + 1) % this.slices;
    }

    this.target.scissorTest = false;
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}
