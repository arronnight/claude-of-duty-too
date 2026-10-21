import * as THREE from 'three';
import { FX_NOISE } from './glsl.js';

/**
 * The two FX texture atlases, generated once on the GPU at boot.
 *
 * Everything the FX system draws — every smoke puff, spark, splinter, muzzle
 * lobe, bullet hole and blood splat — samples one of two 1024² atlases, which
 * is what keeps the whole combat FX layer inside four draw calls. No per-pixel
 * JS, no image files: one fullscreen shader pass per atlas.
 *
 * ## PARTICLE atlas channel layout
 *   `rg` detail normal (0.5 = flat), `b` thickness / heat, `a` coverage.
 * The normal is the reason smoke reads as volume rather than as a decal of a
 * cloud: the particle shader lights a hemisphere normal *perturbed by rg*, so
 * the same puff has bright and dark lobes facing the sun.
 *
 * ## DECAL atlas channel layout
 *   `rgb` tint/2 (0.5 = neutral, 0 = black, 1 = 2× brighten), `a` coverage.
 * Decals are drawn with a modulate blend (`dst * mix(1, tint, coverage)`), so a
 * bullet hole inherits the lighting of whatever it lands on for free — no
 * lighting code, no "glowing decal in shadow" tell, one draw call.
 */

export const PT = {
  SMOKE_A: 0, SMOKE_B: 1, SMOKE_C: 2, DUST: 3,
  SPARK: 4, STREAK: 5, FLASH_STAR: 6, FLASH_LOBE: 7,
  CHIP: 8, SPLINTER: 9, SHARD: 10, BLOOD: 11,
  FIRE: 12, RING: 13, EMBER: 14, SOFT: 15,
};

export const DT = {
  HOLE_CONCRETE_A: 0, HOLE_CONCRETE_B: 1, HOLE_METAL: 2, HOLE_WOOD: 3,
  CRACK_GLASS: 4, DIVOT_SAND: 5, SCORCH: 6, BLOOD_A: 7,
  BLOOD_B: 8, SCUFF: 9, SPALL_CLUSTER: 10, OIL: 11,
};

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
`;

const SHAPES = /* glsl */ `
${FX_NOISE}

// ---------------------------------------------------------------- particles

float shSmoke(vec2 c, float seed){
  float r = length(c);
  vec2 w = c * 1.7 + seed * 11.0;
  vec2 wc = c + (vec2(fxFbm(w + 3.1, 3), fxFbm(w + 9.7, 3)) - 0.5) * 0.62;
  float body = 1.0 - smoothstep(0.24, 0.96, length(wc));
  float lumps = fxFbm(wc * 3.1 + seed * 4.0, 5);
  float cell = fxSat(fxWorley(wc * 2.6 + seed * 6.0) * 1.5);
  float a = body * (0.30 + 0.80 * lumps) * (0.55 + 0.55 * cell);
  return fxSat(a * 1.35) * smoothstep(1.0, 0.78, r);
}

float shDust(vec2 c, float seed){
  float r = length(c);
  vec2 wc = c + (vec2(fxFbm(c * 2.6 + seed, 3), fxFbm(c * 2.6 + seed + 17.0, 3)) - 0.5) * 0.95;
  float body = 1.0 - smoothstep(0.06, 1.0, length(wc));
  float a = body * body * (0.30 + 0.85 * fxFbm(wc * 4.2 + 3.0, 4));
  return fxSat(a * 1.5) * smoothstep(1.0, 0.72, r);
}

float shSpark(vec2 c){
  float r = length(c);
  return fxSat(pow(fxSat(1.0 - r / 0.17), 2.0) + exp(-r * 5.5) * 0.55) * smoothstep(1.0, 0.86, r);
}

float shStreak(vec2 c){
  float head = fxSat(c.y * 0.5 + 0.5);
  float w = 0.16 * mix(0.35, 1.0, head);
  float a = fxSat(1.0 - abs(c.x) / w);
  a = pow(a, 1.7) * mix(0.05, 1.0, pow(head, 1.6));
  a += pow(fxSat(1.0 - length(vec2(c.x * 3.4, (c.y - 0.72) * 2.4))), 2.0) * 0.9;
  a *= 1.0 - smoothstep(0.88, 1.0, abs(c.y));
  return fxSat(a);
}

float shFlashStar(vec2 c){
  float r = length(c);
  float ang = atan(c.y, c.x);
  float s4 = pow(abs(cos(2.0 * ang)), 14.0);
  float s8 = pow(abs(cos(4.0 * ang + 0.7854)), 26.0);
  float spikes = fxSat(s4 + s8 * 0.5);
  float core = pow(fxSat(1.0 - r / 0.26), 2.0);
  return fxSat(core * 1.2 + exp(-r * 2.2) * spikes * 0.95 + exp(-r * 4.4) * 0.40)
       * smoothstep(1.0, 0.90, r);
}

float shFlashLobe(vec2 c){
  float ty = fxSat((c.y + 0.85) / 1.7);
  float halfW = (0.07 + 0.52 * pow(ty, 0.85)) * (0.72 + 0.5 * fxFbm(vec2(ty * 7.0, 4.0), 3));
  float d = abs(c.x) / max(halfW, 1e-3);
  float a = fxSat(1.0 - d * d) * (1.0 - smoothstep(0.45, 1.0, ty));
  a *= 0.55 + 0.65 * fxFbm(vec2(c.x * 5.0, ty * 8.0) + 13.0, 3);
  a += pow(fxSat(1.0 - length(vec2(c.x * 1.7, (c.y + 0.72) * 1.7))), 3.0) * 1.3;
  return fxSat(a) * smoothstep(1.0, 0.90, length(c));
}

float shChip(vec2 c, float seed){
  float ang = atan(c.y, c.x);
  float q = floor((ang + 3.14159) / (6.28318 / 6.0));
  float rad = 0.38 + 0.34 * fxHash11(q * 3.7 + seed);
  float radn = 0.38 + 0.34 * fxHash11(mod(q + 1.0, 6.0) * 3.7 + seed);
  float f = fract((ang + 3.14159) / (6.28318 / 6.0));
  rad = mix(rad, radn, f);
  return (1.0 - smoothstep(rad - 0.05, rad + 0.02, length(c)));
}

float shSplinter(vec2 c){
  float ty = fxSat(c.y * 0.5 + 0.5);
  float w = 0.13 * (1.0 - ty * 0.82) * (0.45 + 0.95 * fxNoise(vec2(c.y * 5.0, 2.0)));
  float a = 1.0 - smoothstep(w, w + 0.045, abs(c.x));
  return a * (1.0 - smoothstep(0.82, 0.99, abs(c.y)));
}

float shShardSDF(vec2 c){
  float d1 = dot(c, normalize(vec2(0.92, 0.39))) - 0.40;
  float d2 = dot(c, normalize(vec2(-0.72, 0.69))) - 0.36;
  float d3 = dot(c, normalize(vec2(-0.08, -0.99))) - 0.44;
  return max(max(d1, d2), d3);
}

float shBlood(vec2 c, float seed){
  float a = 1.0 - smoothstep(0.24, 0.36, length(c));
  for (int i = 0; i < 6; i++){
    float fi = float(i);
    vec2 o = (fxHash22(vec2(fi * 3.1 + seed, fi * 7.7)) - 0.5) * 1.45;
    float rr = 0.045 + 0.115 * fxHash11(fi * 5.3 + seed);
    a = max(a, 1.0 - smoothstep(rr * 0.65, rr, length(c - o)));
  }
  return a * smoothstep(1.0, 0.88, length(c));
}

float shFire(vec2 c, float seed){
  vec2 wc = c + (vec2(fxFbm(c * 2.2 + seed, 4), fxFbm(c * 2.2 + seed + 19.0, 4)) - 0.5) * 0.55;
  float body = 1.0 - smoothstep(0.10, 0.98, length(wc));
  float turb = fxRidge(wc * 2.9 + 7.0, 5);
  return fxSat(body * (0.42 + 0.95 * turb)) * smoothstep(1.0, 0.80, length(c));
}

float shRing(vec2 c){
  float r = length(c);
  float band = exp(-pow((r - 0.70) / 0.21, 2.0));
  float brk = 0.45 + 0.80 * fxFbm(vec2(atan(c.y, c.x) * 2.4, r * 2.6) + 31.0, 4);
  return fxSat(band * brk) * smoothstep(1.0, 0.90, r);
}

float shEmber(vec2 c){
  return pow(fxSat(1.0 - length(c) / 0.52), 2.0);
}

float shSoft(vec2 c){
  return exp(-dot(c, c) * 3.0) * smoothstep(1.0, 0.70, length(c));
}

float particleAlpha(int id, vec2 c){
  if (id == 0) return shSmoke(c, 0.0);
  if (id == 1) return shSmoke(c, 1.0);
  if (id == 2) return shSmoke(c, 2.0);
  if (id == 3) return shDust(c, 3.0);
  if (id == 4) return shSpark(c);
  if (id == 5) return shStreak(c);
  if (id == 6) return shFlashStar(c);
  if (id == 7) return shFlashLobe(c);
  if (id == 8) return shChip(c, 4.0);
  if (id == 9) return shSplinter(c);
  if (id == 10) return 1.0 - smoothstep(-0.015, 0.015, shShardSDF(c));
  if (id == 11) return shBlood(c, 5.0);
  if (id == 12) return shFire(c, 6.0);
  if (id == 13) return shRing(c);
  if (id == 14) return shEmber(c);
  return shSoft(c);
}

/** Thickness / heat channel — what the particle shader shades against. */
float particleThickness(int id, vec2 c, float a){
  if (id <= 2) return fxSat(a * 1.25);
  if (id == 3) return fxSat(a * 0.9);
  if (id == 10) return fxSat(1.0 - abs(shShardSDF(c)) / 0.09) * a;   // bright cut edge
  if (id == 12) return fxSat(a * 1.35 - 0.12);                        // heat ramp
  if (id == 8 || id == 9) return fxSat(a * 1.1);
  return a;
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${SHAPES}

void main(){
  vec2 t = floor(vec2(vUv.x, 1.0 - vUv.y) * 4.0);
  int id = int(t.y * 4.0 + t.x);
  vec2 c = fract(vec2(vUv.x, 1.0 - vUv.y) * 4.0) * 2.0 - 1.0;

  float a = particleAlpha(id, c);
  float e = 0.0098;
  float hx = particleAlpha(id, c + vec2(e, 0.0)) - particleAlpha(id, c - vec2(e, 0.0));
  float hy = particleAlpha(id, c + vec2(0.0, e)) - particleAlpha(id, c - vec2(0.0, e));
  vec2 n = vec2(-hx, -hy) * 2.6;
  gl_FragColor = vec4(fxSat3(vec3(n * 0.5 + 0.5, particleThickness(id, c, a))), fxSat(a));
}
`;

const DECAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${SHAPES}

/** rgb = tint/2 (0.5 neutral), a = coverage. */
vec4 dBulletConcrete(vec2 c, float seed){
  float r = length(c);
  float ang = atan(c.y, c.x);
  float craterR = 0.135 * (0.8 + 0.4 * fxNoise(vec2(ang * 3.0, seed)));
  float hole = 1.0 - smoothstep(craterR * 0.65, craterR * 1.2, r);
  float spallR = 0.30 + 0.20 * fxFbm(vec2(ang * 1.8, seed * 3.0), 4);
  float spall = (1.0 - smoothstep(spallR * 0.62, spallR, r)) * (1.0 - hole);
  spall *= 0.40 + 0.85 * fxSat(fxWorley(c * 8.0 + seed) * 1.7);
  // Short radial hairlines only — long spidery legs read as a decal, not as
  // spalled concrete.
  float crack = fxSat(1.0 - fxWorley(c * 5.2 + seed * 2.0) * 11.0);
  crack *= (1.0 - smoothstep(0.16, 0.46, r)) * (1.0 - hole);
  float halo = exp(-r * 4.4) * (0.35 + 0.75 * fxFbm(c * 4.0 + 11.0, 4)) * 0.45;

  float v = 0.5;
  v = mix(v, 0.73, fxSat(spall * 1.0));
  v = mix(v, 0.34, fxSat(halo * 0.6));
  v = mix(v, 0.30, fxSat(crack * 0.7));
  v = mix(v, 0.030, hole);
  float cov = fxSat(hole + spall * 0.85 + halo * 0.5 + crack * 0.45);
  return vec4(vec3(v * 1.0, v * 0.99, v * 0.97), cov * smoothstep(1.0, 0.80, r));
}

vec4 dBulletMetal(vec2 c){
  float r = length(c);
  float ang = atan(c.y, c.x);
  float holeR = 0.11 * (0.85 + 0.3 * fxNoise(vec2(ang * 4.0, 9.0)));
  float hole = 1.0 - smoothstep(holeR * 0.7, holeR * 1.1, r);
  float lip = (1.0 - smoothstep(holeR * 1.1, holeR * 2.3, r)) * (1.0 - hole);
  float scratch = fxSat(1.0 - abs(fract(ang * 3.8 + fxNoise(c * 5.0) * 0.5) - 0.5) * 9.0);
  scratch *= (1.0 - smoothstep(0.16, 0.62, r));
  float v = 0.5;
  v = mix(v, 0.96, fxSat(lip * 1.1));
  v = mix(v, 0.72, fxSat(scratch * 0.7));
  v = mix(v, 0.04, hole);
  float cov = fxSat(hole + lip + scratch * 0.6);
  return vec4(vec3(v * 1.02, v, v * 0.94), cov * smoothstep(1.0, 0.82, r));
}

vec4 dBulletWood(vec2 c){
  float r = length(c);
  float ang = atan(c.y, c.x);
  float holeR = 0.14 * (0.8 + 0.4 * fxNoise(vec2(ang * 3.5, 21.0)));
  float hole = 1.0 - smoothstep(holeR * 0.6, holeR * 1.15, r);
  float grain = fxSat(1.0 - abs(fract(ang * 2.6 + fxNoise(c * 3.0) * 0.9) - 0.5) * 7.0);
  float splint = grain * (1.0 - smoothstep(0.14, 0.55, r)) * (1.0 - hole);
  float ring = (1.0 - smoothstep(holeR, holeR * 2.0, r)) * (1.0 - hole);
  float v = 0.5;
  v = mix(v, 0.72, fxSat(splint));
  v = mix(v, 0.24, fxSat(ring * 0.8));
  v = mix(v, 0.03, hole);
  return vec4(vec3(v * 1.03, v * 0.97, v * 0.9), fxSat(hole + splint * 0.8 + ring * 0.8) * smoothstep(1.0, 0.82, r));
}

vec4 dGlassCrack(vec2 c){
  float r = length(c);
  float ang = atan(c.y, c.x);
  float radial = fxSat(1.0 - abs(fract(ang * 2.2 + fxNoise(c * 2.0) * 0.4) - 0.5) * 13.0);
  radial *= 1.0 - smoothstep(0.15, 0.95, r);
  float conc = fxSat(1.0 - abs(fract(r * 4.5 + fxNoise(c * 3.0) * 0.5) - 0.5) * 11.0);
  conc *= (1.0 - smoothstep(0.25, 0.85, r)) * step(0.12, r);
  float hole = 1.0 - smoothstep(0.06, 0.11, r);
  float v = 0.5;
  v = mix(v, 1.0, fxSat((radial + conc) * 0.9));
  v = mix(v, 0.10, hole);
  return vec4(vec3(v), fxSat(radial + conc + hole) * smoothstep(1.0, 0.84, r));
}

vec4 dSandDivot(vec2 c){
  float r = length(c);
  vec2 wc = c + (vec2(fxFbm(c * 3.0, 3), fxFbm(c * 3.0 + 8.0, 3)) - 0.5) * 0.35;
  float rr = length(wc);
  float pit = 1.0 - smoothstep(0.14, 0.40, rr);
  float rim = (1.0 - smoothstep(0.36, 0.72, rr)) * (1.0 - pit);
  float v = 0.5;
  v = mix(v, 0.74, fxSat(rim * 0.9));
  v = mix(v, 0.34, pit);
  return vec4(vec3(v * 1.04, v, v * 0.9), fxSat(pit * 0.9 + rim * 0.7) * smoothstep(1.0, 0.80, r));
}

vec4 dScorch(vec2 c){
  float r = length(c);
  vec2 wc = c + (vec2(fxFbm(c * 1.8, 4), fxFbm(c * 1.8 + 12.0, 4)) - 0.5) * 0.75;
  float body = 1.0 - smoothstep(0.10, 0.95, length(wc));
  float soot = body * (0.45 + 0.75 * fxFbm(wc * 3.4 + 5.0, 5));
  float core = 1.0 - smoothstep(0.05, 0.34, length(wc));
  float v = mix(0.5, 0.20, fxSat(soot));
  v = mix(v, 0.07, core * 0.9);
  return vec4(vec3(v * 1.0, v * 0.96, v * 0.92), fxSat(soot * 1.1) * smoothstep(1.0, 0.76, r));
}

vec4 dBlood(vec2 c, float seed){
  float a = 1.0 - smoothstep(0.22, 0.40, length(c + (vec2(fxFbm(c * 3.0 + seed, 3), fxFbm(c * 3.0 + seed + 6.0, 3)) - 0.5) * 0.4));
  for (int i = 0; i < 9; i++){
    float fi = float(i);
    vec2 o = (fxHash22(vec2(fi * 2.9 + seed, fi * 6.1 + seed)) - 0.5) * 1.7;
    float rr = 0.035 + 0.13 * fxHash11(fi * 4.3 + seed);
    float d = 1.0 - smoothstep(rr * 0.55, rr, length(c - o));
    a = max(a, d);
  }
  return vec4(vec3(0.5), fxSat(a) * smoothstep(1.0, 0.88, length(c)));
}

vec4 dScuff(vec2 c){
  float r = length(c);
  float a = (1.0 - smoothstep(0.15, 0.95, r)) * (0.35 + 0.85 * fxFbm(c * 2.6 + 41.0, 5));
  float v = mix(0.5, 0.36, fxSat(a));
  return vec4(vec3(v), fxSat(a * 0.75) * smoothstep(1.0, 0.74, r));
}

vec4 dSpallCluster(vec2 c){
  float cov = 0.0;
  float v = 0.5;
  for (int i = 0; i < 5; i++){
    float fi = float(i);
    vec2 o = (fxHash22(vec2(fi * 3.7 + 2.0, fi * 8.3)) - 0.5) * 1.35;
    vec4 h = dBulletConcrete((c - o) * 2.4, fi);
    v = mix(v, h.r, fxSat(h.a));
    cov = fxSat(cov + h.a);
  }
  return vec4(vec3(v), cov * smoothstep(1.0, 0.86, length(c)));
}

vec4 dOil(vec2 c){
  float r = length(c);
  vec2 wc = c + (vec2(fxFbm(c * 2.2 + 3.0, 4), fxFbm(c * 2.2 + 15.0, 4)) - 0.5) * 0.6;
  float a = 1.0 - smoothstep(0.30, 0.80, length(wc));
  float v = mix(0.5, 0.18, fxSat(a));
  return vec4(vec3(v * 0.98, v, v * 1.02), fxSat(a) * smoothstep(1.0, 0.80, r));
}

void main(){
  vec2 t = floor(vec2(vUv.x, 1.0 - vUv.y) * 4.0);
  int id = int(t.y * 4.0 + t.x);
  vec2 c = fract(vec2(vUv.x, 1.0 - vUv.y) * 4.0) * 2.0 - 1.0;

  vec4 o = vec4(0.5, 0.5, 0.5, 0.0);
  if (id == 0) o = dBulletConcrete(c, 0.0);
  else if (id == 1) o = dBulletConcrete(c, 3.0);
  else if (id == 2) o = dBulletMetal(c);
  else if (id == 3) o = dBulletWood(c);
  else if (id == 4) o = dGlassCrack(c);
  else if (id == 5) o = dSandDivot(c);
  else if (id == 6) o = dScorch(c);
  else if (id == 7) o = dBlood(c, 1.0);
  else if (id == 8) o = dBlood(c, 9.0);
  else if (id == 9) o = dScuff(c);
  else if (id == 10) o = dSpallCluster(c);
  else if (id == 11) o = dOil(c);
  gl_FragColor = vec4(fxSat3(o.rgb), fxSat(o.a));
}
`;

let _quadScene = null;
let _quadCam = null;
let _quadMesh = null;

function drawFullscreen(renderer, fragment, size) {
  if (!_quadScene) {
    _quadScene = new THREE.Scene();
    _quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    _quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), null);
    _quadMesh.frustumCulled = false;
    _quadScene.add(_quadMesh);
  }
  const rt = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    colorSpace: THREE.NoColorSpace,
  });
  const mat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT,
    fragmentShader: fragment,
    depthTest: false,
    depthWrite: false,
  });
  _quadMesh.material = mat;
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(_quadScene, _quadCam);
  renderer.setRenderTarget(prevTarget);
  _quadMesh.material = null;
  mat.dispose();
  rt.texture.anisotropy = 1;
  return rt;
}

/**
 * Builds both atlases. Returns `{ particles, decals, dispose }`; the textures
 * are ready to bind immediately. Falls back to a pair of 1×1 white textures if
 * the renderer is missing so nothing downstream ever sees a null sampler.
 */
export function buildAtlases(renderer, quality) {
  const size = quality?.textureSize >= 2048 ? 1024 : quality?.textureSize <= 512 ? 512 : 1024;
  if (!renderer) {
    const fallback = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    fallback.needsUpdate = true;
    return { particles: fallback, decals: fallback, dispose() { fallback.dispose(); } };
  }
  const pRt = drawFullscreen(renderer, PARTICLE_FRAG, size);
  const dRt = drawFullscreen(renderer, DECAL_FRAG, size);
  return {
    particles: pRt.texture,
    decals: dRt.texture,
    size,
    dispose() { pRt.dispose(); dRt.dispose(); },
  };
}
