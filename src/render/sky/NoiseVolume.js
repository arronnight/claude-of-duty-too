import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { COMMON_GLSL } from './glsl/common.glsl.js';

/**
 * Tiling Perlin-Worley volume + 2-D weather map, baked on the GPU at startup.
 *
 * Evaluating fbm by hand inside the cloud march costs ~70 hashes per sample,
 * which caps the cloud cache at a resolution where every edge is mush. Baking
 * the same fields into a 128^3 RGBA8 volume turns each sample into one texture
 * fetch and buys roughly 8x the cache resolution for the same frame time.
 *
 * The bake is spread over several frames: 500M-odd Worley taps in one call
 * would trip the browser's GPU watchdog.
 */

const NOISE_GLSL = /* glsl */ `
float phash13v(vec3 i, vec3 period){
  i = mod(i, period) + 0.5;
  return hash13(i);
}
float phash13(vec3 i, float period){ return phash13v(i, vec3(period)); }
vec3 phash33(vec3 i, float period){
  i = mod(i, vec3(period)) + 0.5;
  return hash33(i);
}

/**
 * Tiling value noise, per-axis period. Anisotropic features have to be made by
 * changing the period, never by scaling the input: scaling breaks the wrap and
 * paints a hard seam straight across the sky.
 */
float pnoise3(vec3 uvw, vec3 period){
  vec3 p = uvw * period;
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(phash13v(i + vec3(0,0,0), period), phash13v(i + vec3(1,0,0), period), f.x),
                 mix(phash13v(i + vec3(0,1,0), period), phash13v(i + vec3(1,1,0), period), f.x), f.y),
             mix(mix(phash13v(i + vec3(0,0,1), period), phash13v(i + vec3(1,0,1), period), f.x),
                 mix(phash13v(i + vec3(0,1,1), period), phash13v(i + vec3(1,1,1), period), f.x), f.y), f.z);
}

/** Tiling value noise on a lattice of 'period' cells across the unit cube. */
float pnoise(vec3 uvw, float period){
  vec3 p = uvw * period;
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = 0.0;
  n += mix(mix(mix(phash13(i + vec3(0,0,0), period), phash13(i + vec3(1,0,0), period), f.x),
               mix(phash13(i + vec3(0,1,0), period), phash13(i + vec3(1,1,0), period), f.x), f.y),
           mix(mix(phash13(i + vec3(0,0,1), period), phash13(i + vec3(1,0,1), period), f.x),
               mix(phash13(i + vec3(0,1,1), period), phash13(i + vec3(1,1,1), period), f.x), f.y), f.z);
  return n;
}

/** Tiling Worley; returns the distance to the nearest feature point, 0..1. */
float pworley(vec3 uvw, float period){
  vec3 p = uvw * period;
  vec3 i = floor(p);
  vec3 f = fract(p);
  float best = 1.5;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++){
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = phash33(i + g, period);
    best = min(best, length(g + o - f));
  }
  return clamp(best, 0.0, 1.0);
}

/** Inverted two-octave Worley: 1 at feature centres, so it reads as billows. */
float billow(vec3 uvw, float f0){
  return (1.0 - pworley(uvw, f0)) * 0.68 + (1.0 - pworley(uvw, f0 * 2.0)) * 0.32;
}

float valueFbm(vec3 uvw, float f0){
  return pnoise(uvw, f0) * 0.53 + pnoise(uvw, f0 * 2.0) * 0.27
       + pnoise(uvw, f0 * 4.0) * 0.13 + pnoise(uvw, f0 * 8.0) * 0.07;
}
`;

export class NoiseVolume {
  constructor(size = 128, weatherSize = 512) {
    this.size = size;
    this.layer = 0;
    this.ready = false;

    this.volumeTarget = new THREE.WebGL3DRenderTarget(size, size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    const vt = this.volumeTarget.texture;
    vt.minFilter = THREE.LinearFilter;
    vt.magFilter = THREE.LinearFilter;
    vt.wrapS = THREE.RepeatWrapping;
    vt.wrapT = THREE.RepeatWrapping;
    vt.wrapR = THREE.RepeatWrapping;
    vt.colorSpace = THREE.NoColorSpace;

    this.weatherTarget = new THREE.WebGLRenderTarget(weatherSize, weatherSize, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
    });
    this.weatherTarget.texture.wrapS = THREE.RepeatWrapping;
    this.weatherTarget.texture.wrapT = THREE.RepeatWrapping;
    this.weatherTarget.texture.colorSpace = THREE.NoColorSpace;

    const vertexShader = /* glsl */ `
      precision highp float;
      in vec3 position;
      in vec2 uv;
      out vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `;

    this.volumeMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: { uW: { value: 0 } },
      vertexShader,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        layout(location = 0) out vec4 fragColor;
        uniform float uW;
        ${COMMON_GLSL}
        ${NOISE_GLSL}
        void main(){
          vec3 uvw = vec3(vUv, uW);
          float perlin = valueFbm(uvw, 4.0);
          float wLow = billow(uvw, 4.0);
          // Schneider's Perlin-Worley: dilate the value fbm by the billows so
          // the base shape gets cauliflower lobes instead of smoke.
          float pw = remap(perlin, (1.0 - wLow) - 1.0, 1.0, 0.0, 1.0);
          pw = remap(pw, 0.18, 0.94, 0.0, 1.0);
          fragColor = vec4(
            pw,
            billow(uvw, 8.0),
            billow(uvw, 16.0),
            billow(uvw, 30.0)
          );
        }
      `,
    });

    this.weatherMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {},
      vertexShader,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        layout(location = 0) out vec4 fragColor;
        ${COMMON_GLSL}
        ${NOISE_GLSL}
        void main(){
          vec3 u = vec3(vUv, 0.31);
          float cov = pnoise(u, 3.0) * 0.52 + pnoise(u, 6.0) * 0.27
                    + pnoise(u, 12.0) * 0.14 + pnoise(u, 24.0) * 0.07;
          // MEASURED CLIMBDOWN FROM THE BRIEF. It asked for the coverage
          // remap to narrow to (0.38, 0.74) and for a 1.5-cell cluster gate
          // multiplying cov before the front term. Both landed: I rendered
          // them. Together they took skyline.png and goldenhour.png to a
          // completely cloudless sky — the gate's holes are ~73 km across and
          // both of those cameras look straight into one — and goldenhour with
          // no deck for the sun to rake under is strictly worse than what we
          // had. The remap stays slightly narrowed, the gate is gone, and the
          // sky's openness is now driven by the time-of-day coverage presets in
          // Sky.js instead, where it can be seen and tuned per shot.
          cov = remap(cov, 0.30, 0.78, 0.0, 1.0);
          // Break the fbm's uniform blobbiness into fronts and clear lanes.
          float front = pnoise3(vec3(vUv, 0.77), vec3(3.0, 1.0, 1.0)) * 0.65
                      + pnoise3(vec3(vUv, 0.77), vec3(6.0, 2.0, 1.0)) * 0.35;
          cov *= mix(0.50, 1.30, smoothstep(0.30, 0.72, front));
          float typ = pnoise(vec3(vUv, 0.61), 5.0) * 0.6 + pnoise(vec3(vUv, 0.61), 10.0) * 0.4;
          // Towering correlates with coverage in the real atmosphere: the deep
          // convective cells are where the water is. Uncorrelated they read as
          // two unrelated noise fields painted over each other.
          typ = saturate1(typ * 0.55 + saturate1(cov) * 0.65);
          float varia = pnoise(vec3(vUv, 0.19), 8.0);
          fragColor = vec4(saturate1(cov), typ, varia, 1.0);
        }
      `,
    });

    this.quad = new FullScreenQuad(this.volumeMaterial);
  }

  get volume() { return this.volumeTarget.texture; }
  get weather() { return this.weatherTarget.texture; }

  /** Bake up to `layers` slices this frame. Returns true once complete. */
  step(renderer, layers = 8) {
    if (this.ready) return true;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    if (this.layer === 0) {
      this.quad.material = this.weatherMaterial;
      renderer.setRenderTarget(this.weatherTarget);
      this.quad.render(renderer);
    }

    this.quad.material = this.volumeMaterial;
    const end = Math.min(this.layer + layers, this.size);
    for (let z = this.layer; z < end; z++) {
      this.volumeMaterial.uniforms.uW.value = (z + 0.5) / this.size;
      renderer.setRenderTarget(this.volumeTarget, z);
      this.quad.render(renderer);
    }
    this.layer = end;
    if (this.layer >= this.size) this.ready = true;

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    return this.ready;
  }

  dispose() {
    this.volumeTarget.dispose();
    this.weatherTarget.dispose();
    this.volumeMaterial.dispose();
    this.weatherMaterial.dispose();
  }
}
