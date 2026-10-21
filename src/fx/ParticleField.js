import * as THREE from 'three';

/**
 * The one particle system everything else is built out of.
 *
 * Two instances of this class carry every particle in the game — one
 * alpha-blended and lit (smoke, dust, debris, blood), one additive and
 * unlit (sparks, embers, muzzle lobes, fireball) — which is **two draw calls**
 * for the entire combat FX layer.
 *
 * ## Why the motion is analytic
 * A particle's whole trajectory is baked into its instance attributes at spawn
 * and evaluated in the vertex shader as a closed form:
 *
 *     v(t) = (v0 + g/k)·e^(-kt) − g/k          exact linear-drag + gravity
 *     p(t) = p0 + (v0 + g/k)·(1−e^(-kt))/k − (g/k)·t
 *
 * so the CPU touches a particle exactly once, when it is born. There is no
 * per-frame integration loop, no per-frame buffer upload while nothing is
 * spawning, and — the actual requirement — **zero steady-state allocation**.
 * Curl drift for smoke is added on top as an analytic divergence-free field.
 *
 * ## Why the lighting looks right
 * The lit variant reconstructs a hemisphere normal across the billboard,
 * perturbs it with the detail normal packed into the atlas, and shades it
 * against the *scene's own* sun direction, sun colour and sky fill (pushed in
 * every frame from `ctx.lighting` / `ctx.sky`). A puff is therefore bright on
 * the sun side and blue-shadowed on the other, matching the geometry beside it
 * with no hand-tuned constants. It also runs the patched aerial-perspective fog
 * chunk, so distant smoke hazes exactly like distant walls do.
 *
 * ## Soft edges
 * If a linear scene-depth texture is supplied, coverage is faded by the
 * distance between the particle and the geometry behind it. Hard intersection
 * lines where smoke meets the ground are one of the most reliable "this is a
 * game demo" tells; this removes them.
 */

const QUAD = new THREE.PlaneGeometry(1, 1);

/**
 * Shared spawn descriptor. Callers fill this and hand it back — no allocation
 * per particle, ever. `resetSpec()` returns it primed with sane defaults.
 */
export const SPEC = {
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  life: 1, drag: 0, gravity: -9.81,
  rot: 0, rotSpeed: 0,
  size0: 0.2, size1: 0.35,
  tile: 15, turb: 0, stretch: 0, soft: 0.5,
  sunVis: 1,
  fadeIn: 0.08, fadeOut: 0.4,
  r0: 1, g0: 1, b0: 1, a0: 1,
  r1: 1, g1: 1, b1: 1, a1: 0,
  delay: 0,
};

export function resetSpec() {
  const s = SPEC;
  s.x = s.y = s.z = 0;
  s.vx = s.vy = s.vz = 0;
  s.life = 1; s.drag = 0; s.gravity = -9.81;
  s.rot = 0; s.rotSpeed = 0;
  s.size0 = 0.2; s.size1 = 0.35;
  s.tile = 15; s.turb = 0; s.stretch = 0; s.soft = 0.5;
  s.sunVis = 1;
  s.fadeIn = 0.08; s.fadeOut = 0.4;
  s.r0 = 1; s.g0 = 1; s.b0 = 1; s.a0 = 1;
  s.r1 = 1; s.g1 = 1; s.b1 = 1; s.a1 = 0;
  s.delay = 0;
  return s;
}

const VERT = /* glsl */ `
precision highp float;

attribute vec4 iA;    // origin.xyz, birth
attribute vec4 iB;    // velocity.xyz, 1/life
attribute vec4 iC;    // drag, gravity, rot0, rotSpeed
attribute vec4 iD;    // size0, size1, tile, turbulence
attribute vec4 iE;    // stretch, softDistance, fadeIn, fadeOut
attribute vec4 iF;    // colour + alpha at birth
attribute vec4 iG;    // colour + alpha at death
attribute vec4 iH;    // sun visibility, spare

uniform float uTime;

varying vec2 vUv;
varying vec4 vCol;
varying vec2 vQuad;
varying vec3 vViewPos;
varying float vSoft;
varying float vSun;
varying vec4 vClip;

#include <fog_pars_vertex>

void main(){
  float t = uTime - iA.w;
  float u = t * iB.w;
  if (u < 0.0 || u >= 1.0) {
    // Behind the near plane on every vertex: the triangle is clipped away
    // before rasterisation, which is how dead ring slots cost nothing.
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vUv = vec2(0.0); vCol = vec4(0.0); vQuad = vec2(0.0);
    vViewPos = vec3(0.0); vSoft = 1.0; vSun = 1.0; vClip = gl_Position;
    return;
  }

  float k = iC.x;
  vec3 g = vec3(0.0, iC.y, 0.0);
  vec3 disp, vel;
  if (k > 1e-3) {
    float e = exp(-k * t);
    vec3 gk = g / k;
    disp = (iB.xyz + gk) * ((1.0 - e) / k) - gk * t;
    vel = (iB.xyz + gk) * e - gk;
  } else {
    disp = iB.xyz * t + 0.5 * g * t * t;
    vel = iB.xyz + g * t;
  }
  vec3 wpos = iA.xyz + disp;

  if (iD.w > 0.0) {
    // Analytic divergence-free drift: the curl of a sum of sinusoids. Smoke
    // that rises in a straight line is the second-most obvious tell after hard
    // particle edges.
    vec3 q = wpos * 0.62 + vec3(0.0, uTime * 0.10, 0.0);
    vec3 c = vec3(
      sin(q.z * 1.31 + q.y * 0.70) - cos(q.y * 1.09 + 1.7),
      (sin(q.x * 1.07 + 0.6) - cos(q.z * 0.93)) * 0.45,
      sin(q.y * 1.19 + 2.3) - cos(q.x * 0.81)
    );
    wpos += c * (iD.w * t);
  }

  float grow = 1.0 - pow(1.0 - u, 2.0);
  float sz = mix(iD.x, iD.y, grow);

  vec3 toCam = cameraPosition - wpos;
  vec3 fwd = normalize(toCam);
  float sp = length(vel);

  // A velocity-aligned billboard degenerates when the velocity points at the
  // camera — cross(axis, view) collapses and the quad snaps to an arbitrary
  // basis, which shows up as a flat bar across the screen. Blend back to a
  // plain camera-facing quad as that happens; seen end-on a spark or a muzzle
  // cone *is* a round blob, so this is also the correct look.
  float axisView = iE.x > 0.0 && sp > 0.06 ? 1.0 - abs(dot(vel / sp, fwd)) : 0.0;
  float aligned = smoothstep(0.02, 0.30, axisView);
  if (aligned > 0.001) {
    vec3 ax = vel / sp;
    vec3 side = cross(ax, fwd);
    float sl = length(side);
    side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
    float len = mix(sz, sz + iE.x * sp, aligned);
    wpos += side * (position.x * sz) + ax * (position.y * len);
  } else {
    float rot = iC.z + iC.w * t;
    float cs = cos(rot), sn = sin(rot);
    vec2 q2 = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs) * sz;
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    wpos += camRight * q2.x + camUp * q2.y;
  }

  float tx = mod(iD.z, 4.0);
  float ty = floor(iD.z * 0.25);
  vec2 iuv = mix(vec2(0.010), vec2(0.990), uv);
  vUv = vec2((tx + iuv.x) * 0.25, 1.0 - (ty + 1.0 - iuv.y) * 0.25);

  float fade = smoothstep(0.0, max(iE.z, 1e-4), u) * (1.0 - smoothstep(1.0 - max(iE.w, 1e-4), 1.0, u));
  vCol = vec4(mix(iF.rgb, iG.rgb, u), mix(iF.a, iG.a, u) * fade);
  vQuad = position.xy * 2.0;
  // Soft-fade distance is a multiple of the particle's *current* radius, not an
  // absolute. A 4 m smoke puff should feather over metres; a 2 cm dust wisp
  // sitting 4 cm off the wall it came from must not be erased by the same rule.
  vSoft = max(0.02, iE.y * sz);
  vSun = iH.x;

  vec4 mvPosition = viewMatrix * vec4(wpos, 1.0);
  vViewPos = mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  vClip = gl_Position;

  #include <fog_vertex>
}
`;

function fragment(lit) {
  return /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform sampler2D uDepth;
uniform float uSoftEnabled;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uGround;
uniform vec3 uSunDirView;
uniform vec3 uUpView;
uniform float uGain;

varying vec2 vUv;
varying vec4 vCol;
varying vec2 vQuad;
varying vec3 vViewPos;
varying float vSoft;
varying float vSun;
varying vec4 vClip;

${lit ? '#include <fog_pars_fragment>' : ''}

void main(){
  vec4 tex = texture2D(uAtlas, vUv);
  float a = tex.a * vCol.a;
  if (a < 0.0025) discard;
  vec3 col = vCol.rgb * uGain;

${lit ? `
  // Hemisphere normal across the billboard, perturbed by the atlas detail
  // normal, shaded against the scene's real sun. This is what stops smoke
  // reading as a flat grey sticker.
  float r2 = dot(vQuad, vQuad);
  vec3 n = vec3(vQuad + (tex.rg - 0.5) * 1.7, sqrt(max(0.0, 1.0 - min(r2, 1.0))));
  n = normalize(n);
  float ndl = dot(n, uSunDirView);
  float wrap = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
  float forward = pow(clamp(ndl, 0.0, 1.0), 3.0);
  // Optical depth through the puff: thick centres are shadowed by their own
  // near side, thin edges glow. Without this a puff is a flat disc of one tone.
  float selfShadow = mix(1.0, 0.45, clamp(tex.b, 0.0, 1.0));
  float upness = clamp(dot(n, uUpView) * 0.5 + 0.5, 0.0, 1.0);
  vec3 ambient = mix(uGround, uAmbient, upness);
  // vSun is the emitter's shadow visibility, sampled once with a single ray
  // when the effect spawned. Dust lit as if in full sun while standing in the
  // shadow half of a street is one of the loudest possible tells.
  col *= ambient + uSunColor * ((wrap * wrap * 1.05 + forward * 0.55) * selfShadow * vSun);
` : `
  col *= mix(1.0, 1.0 + tex.b * 0.8, 0.6);
`}

  if (uSoftEnabled > 0.5) {
    vec2 suv = vClip.xy / max(vClip.w, 1e-5) * 0.5 + 0.5;
    float sceneZ = texture2D(uDepth, suv).r;
    a *= clamp((sceneZ - (-vViewPos.z)) / max(vSoft, 0.02), 0.0, 1.0);
  }
  // Never slap a full-screen sprite on the lens.
  a *= clamp((-vViewPos.z - 0.14) * 5.0, 0.0, 1.0);
  if (a < 0.0025) discard;

  gl_FragColor = vec4(col, a);
${lit ? '  #include <fog_fragment>' : ''}
}
`;
}

const ATTRS = ['iA', 'iB', 'iC', 'iD', 'iE', 'iF', 'iG', 'iH'];

export class ParticleField {
  /**
   * @param {THREE.Texture} atlas
   * @param {number} capacity ring size; dead slots are free
   * @param {{lit?: boolean, name?: string, renderOrder?: number}} opts
   */
  constructor(atlas, capacity, opts = {}) {
    this.capacity = capacity;
    this.lit = !!opts.lit;
    this.head = 0;
    this.used = 0;
    this.maxExpiry = -1;
    this.time = 0;
    this._dirty = false;
    this._lo = 0;
    this._hi = 0;

    const geo = new THREE.InstancedBufferGeometry();
    geo.index = QUAD.index;
    geo.setAttribute('position', QUAD.attributes.position);
    geo.setAttribute('uv', QUAD.attributes.uv);
    geo.instanceCount = capacity;
    this.data = {};
    for (const name of ATTRS) {
      const arr = new Float32Array(capacity * 4);
      const attr = new THREE.InstancedBufferAttribute(arr, 4);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      this.data[name] = arr;
      this.data[name + '_attr'] = attr;
    }
    // iB.w is 1/life; leaving it 0 makes u == 0 forever, i.e. every unborn
    // slot would render. Park them all as expired instead.
    const iA = this.data.iA;
    const iB = this.data.iB;
    for (let i = 0; i < capacity; i++) { iA[i * 4 + 3] = -1e6; iB[i * 4 + 3] = 1; }

    const uniforms = {
      uAtlas: { value: atlas },
      uDepth: { value: null },
      uSoftEnabled: { value: 0 },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.86) },
      uAmbient: { value: new THREE.Color(0.22, 0.27, 0.35) },
      uGround: { value: new THREE.Color(0.08, 0.075, 0.07) },
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
      uGain: { value: 1 },
      uTime: { value: 0 },
    };

    // Merge only the fog lib, then splice our own uniform objects back in:
    // UniformsUtils.merge deep-clones (it would clone the atlas texture) but it
    // copies the shared aerial-perspective Float32Array by reference, which is
    // exactly the behaviour the sky system relies on.
    const merged = this.lit ? THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) : {};
    Object.assign(merged, uniforms);

    const mat = new THREE.ShaderMaterial({
      uniforms: merged,
      vertexShader: VERT,
      fragmentShader: fragment(this.lit),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: this.lit,
      blending: this.lit ? THREE.NormalBlending : THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.uniforms = uniforms;
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = opts.name || (this.lit ? 'FXParticlesLit' : 'FXParticlesAdditive');
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? (this.lit ? 12 : 14);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.count = 0;
    geo.instanceCount = 0;
  }

  /** Writes the shared SPEC into the next ring slot. Allocation free. */
  spawn(spec = SPEC) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    const o = i * 4;
    const d = this.data;
    const birth = this.time + (spec.delay || 0);
    const life = Math.max(spec.life, 0.016);

    const a = d.iA; a[o] = spec.x; a[o + 1] = spec.y; a[o + 2] = spec.z; a[o + 3] = birth;
    const b = d.iB; b[o] = spec.vx; b[o + 1] = spec.vy; b[o + 2] = spec.vz; b[o + 3] = 1 / life;
    const c = d.iC; c[o] = spec.drag; c[o + 1] = spec.gravity; c[o + 2] = spec.rot; c[o + 3] = spec.rotSpeed;
    const e = d.iD; e[o] = spec.size0; e[o + 1] = spec.size1; e[o + 2] = spec.tile; e[o + 3] = spec.turb;
    const f = d.iE; f[o] = spec.stretch; f[o + 1] = spec.soft; f[o + 2] = spec.fadeIn; f[o + 3] = spec.fadeOut;
    const g = d.iF; g[o] = spec.r0; g[o + 1] = spec.g0; g[o + 2] = spec.b0; g[o + 3] = spec.a0;
    const h = d.iG; h[o] = spec.r1; h[o + 1] = spec.g1; h[o + 2] = spec.b1; h[o + 3] = spec.a1;
    const k = d.iH; k[o] = spec.sunVis; k[o + 1] = 0; k[o + 2] = 0; k[o + 3] = 0;

    const expiry = birth + life;
    if (expiry > this.maxExpiry) this.maxExpiry = expiry;
    if (!this._dirty) { this._dirty = true; this._lo = i; this._hi = i; }
    else { if (i < this._lo) this._lo = i; if (i > this._hi) this._hi = i; }
    return i;
  }

  /** Drops every live particle without touching the buffers' identity. */
  clear() {
    const iA = this.data.iA;
    for (let i = 0; i < this.capacity; i++) iA[i * 4 + 3] = -1e6;
    this._dirty = true; this._lo = 0; this._hi = this.capacity - 1;
    this.maxExpiry = -1;
    this.head = 0;
  }

  get alive() { return this.time <= this.maxExpiry; }

  update(time) {
    this.time = time;
    this.uniforms.uTime.value = time;
    if (this._dirty) {
      const count = this._hi - this._lo + 1;
      for (const name of ATTRS) {
        const attr = this.data[name + '_attr'];
        attr.clearUpdateRanges?.();
        attr.addUpdateRange?.(this._lo * 4, count * 4);
        attr.needsUpdate = true;
      }
      this._dirty = false;
    }
    const live = time <= this.maxExpiry ? this.used : 0;
    this.mesh.count = live;
    this.mesh.geometry.instanceCount = live;
  }

  setDepth(texture) {
    this.uniforms.uDepth.value = texture;
    this.uniforms.uSoftEnabled.value = texture ? 1 : 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
