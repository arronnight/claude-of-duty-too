import * as THREE from 'three';

/**
 * Tracer rounds — velocity-aligned ribbons travelling at the projectile speed.
 *
 * One instanced draw call, analytic motion in the vertex shader exactly like
 * `ParticleField` (the CPU writes a tracer once and never touches it again),
 * and an analytic cross-section in the fragment shader rather than a texture
 * fetch: a tracer is a 2 cm bright line, so a sprite would be all filtering
 * and no signal.
 *
 * Two details that matter for believability:
 *  - **The ribbon is a trail, not a bar.** It is brightest at the head, decays
 *    along its length, and only reaches full length once the round has flown
 *    that far — a tracer does not appear fully formed at the muzzle.
 *  - **Screen-space width floor.** Real tracers stay visible at 200 m because
 *    they are self-luminous and bloom; a purely world-space width would thin to
 *    a sub-pixel dotted line and alias. The width is clamped to a minimum
 *    angular size, which is what makes distant fire read.
 *
 * Callers should light roughly one round in three (`FXSystem` does), which is a
 * real 4:1..1:1 belt mix rather than a laser show.
 */

const QUAD = new THREE.PlaneGeometry(1, 1);

const VERT = /* glsl */ `
precision highp float;
attribute vec4 tA;   // origin.xyz, birth
attribute vec4 tB;   // dir.xyz, speed
attribute vec4 tC;   // trailLength, width, life, travelDistance
attribute vec4 tD;   // colour.rgb, intensity

uniform float uTime;

varying vec2 vQ;
varying vec3 vCol;
varying float vFade;

void main(){
  float t = uTime - tA.w;
  float u = t / max(tC.z, 1e-3);
  if (u < 0.0 || u >= 1.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vQ = vec2(0.0); vCol = vec3(0.0); vFade = 0.0;
    return;
  }

  float travelled = min(tB.w * t, tC.w);
  float trail = min(tC.x, travelled);
  vec3 head = tA.xyz + tB.xyz * travelled;
  vec3 tail = head - tB.xyz * trail;

  float py = position.y + 0.5;                 // 0 tail .. 1 head
  vec3 p = mix(tail, head, py);

  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 fwd = toCam / max(dist, 1e-4);
  vec3 side = cross(tB.xyz, fwd);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);

  // Never let a self-luminous round thin below a couple of pixels.
  float w = max(tC.y, dist * 0.0013);
  p += side * (position.x * w);

  vQ = vec2(position.x * 2.0, py);
  vCol = tD.rgb * tD.w;
  // Fade out over the last 25% of flight, kill the muzzle-adjacent smear, and
  // dim a round that is passing within arm's reach — at 30 cm a tracer covers
  // a third of the screen in bloom and reads as a lens artefact, not a bullet.
  vFade = (1.0 - smoothstep(0.72, 1.0, u))
        * clamp(travelled * 1.6, 0.0, 1.0)
        * smoothstep(0.5, 2.2, dist);

  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vQ;
varying vec3 vCol;
varying float vFade;

void main(){
  float x = clamp(1.0 - abs(vQ.x), 0.0, 1.0);
  // A hard thin core inside a soft halo. A single smooth falloff across the
  // ribbon reads as a light sabre; the round itself has to be a filament.
  float core = pow(x, 14.0);
  float glow = pow(x, 3.2) * 0.16;
  float along = clamp(vQ.y, 0.0, 1.0);
  float tail = pow(along, 3.2);
  float headPop = pow(clamp((along - 0.90) / 0.10, 0.0, 1.0), 1.2);
  float a = (core + glow) * (0.03 + 0.97 * tail) + headPop * (core * 1.2 + 0.35);
  a *= vFade;
  if (a < 0.003) discard;
  vec3 col = mix(vCol * vec3(1.0, 0.62, 0.26), vCol, min(1.0, core * 1.3 + headPop));
  gl_FragColor = vec4(col, a);
}
`;

const _dir = new THREE.Vector3();

export class Tracers {
  constructor(capacity = 72) {
    this.capacity = capacity;
    this.head = 0;
    this.used = 0;
    this.maxExpiry = -1;
    this.time = 0;
    this._dirty = false;

    const geo = new THREE.InstancedBufferGeometry();
    geo.index = QUAD.index;
    geo.setAttribute('position', QUAD.attributes.position);
    geo.instanceCount = 0;

    this.data = {};
    for (const name of ['tA', 'tB', 'tC', 'tD']) {
      const arr = new Float32Array(capacity * 4);
      const attr = new THREE.InstancedBufferAttribute(arr, 4);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      this.data[name] = arr;
      this.data[name + '_attr'] = attr;
    }
    for (let i = 0; i < capacity; i++) {
      this.data.tA[i * 4 + 3] = -1e6;
      this.data.tC[i * 4 + 2] = 1;
    }

    this.uniforms = { uTime: { value: 0 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'FXTracers';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    this.mesh.matrixAutoUpdate = false;
  }

  /**
   * @param {THREE.Vector3|{x,y,z}} from muzzle
   * @param {THREE.Vector3|{x,y,z}} to impact point
   * @param {number} speed m/s
   * @param {{trail?:number,width?:number,color?:number[],intensity?:number,age?:number}} [opts]
   */
  fire(from, to, speed = 880, opts) {
    _dir.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const dist = _dir.length();
    if (dist < 0.05) return -1;
    _dir.multiplyScalar(1 / dist);
    const v = Math.max(40, speed);
    const flight = dist / v;

    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    const o = i * 4;
    const trail = opts?.trail ?? Math.min(4.6, 1.4 + v * 0.0032);
    // `age` back-dates the birth so a staged tableau can freeze a round
    // mid-flight instead of at the muzzle.
    const birth = this.time - (opts?.age ?? 0);

    const a = this.data.tA; a[o] = from.x; a[o + 1] = from.y; a[o + 2] = from.z; a[o + 3] = birth;
    const b = this.data.tB; b[o] = _dir.x; b[o + 1] = _dir.y; b[o + 2] = _dir.z; b[o + 3] = v;
    const c = this.data.tC;
    c[o] = trail;
    c[o + 1] = opts?.width ?? 0.018;
    c[o + 2] = flight + (trail / v) + 0.02;
    c[o + 3] = dist;
    const d = this.data.tD;
    const col = opts?.color;
    d[o] = col ? col[0] : 1.0;
    d[o + 1] = col ? col[1] : 0.80;
    d[o + 2] = col ? col[2] : 0.38;
    d[o + 3] = opts?.intensity ?? 3.6;

    const expiry = birth + c[o + 2];
    if (expiry > this.maxExpiry) this.maxExpiry = expiry;
    this._dirty = true;
    return i;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) this.data.tA[i * 4 + 3] = -1e6;
    this._dirty = true;
    this.maxExpiry = -1;
    this.head = 0;
  }

  get alive() { return this.time <= this.maxExpiry; }

  update(time) {
    this.time = time;
    this.uniforms.uTime.value = time;
    if (this._dirty) {
      for (const name of ['tA', 'tB', 'tC', 'tD']) this.data[name + '_attr'].needsUpdate = true;
      this._dirty = false;
    }
    const live = time <= this.maxExpiry ? this.used : 0;
    this.mesh.geometry.instanceCount = live;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
