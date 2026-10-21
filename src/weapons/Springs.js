import * as THREE from 'three';

/**
 * Self-contained spring primitives for the weapon rig.
 *
 * The player system has its own copies; these are deliberately duplicated
 * rather than imported so `src/weapons` never reaches into `src/player`
 * internals (the architecture contract only allows the published `ctx` API).
 *
 * Everything here is allocation-free after construction: the viewmodel runs
 * a dozen of these every frame and the budget is ~0 bytes/frame.
 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const smootherstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeOutBack = (t, s = 1.25) => {
  const u = clamp(t, 0, 1) - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
};
export const deg = (d) => (d * Math.PI) / 180;

/** Frame-rate independent exponential approach. `rate` is in 1/seconds. */
export function approach(cur, target, rate, dt) {
  return target + (cur - target) * Math.exp(-rate * dt);
}

/** Scalar damped harmonic oscillator, semi-implicit Euler, sub-stepped. */
export class Spring1 {
  constructor(freq = 10, zeta = 0.7, value = 0) {
    this.freq = freq;
    this.zeta = zeta;
    this.value = value;
    this.velocity = 0;
    this.target = value;
  }
  reset(v = 0) { this.value = v; this.velocity = 0; this.target = v; }
  impulse(v) { this.velocity += v; }
  set(v) { this.value = v; }
  update(dt, target) {
    if (target !== undefined) this.target = target;
    const w = Math.PI * 2 * this.freq;
    const steps = dt > 1 / 90 ? 2 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = w * w * (this.target - this.value) - 2 * this.zeta * w * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Vector3 damped harmonic oscillator. Shares one scratch accumulator. */
export class Spring3 {
  constructor(freq = 10, zeta = 0.7) {
    this.freq = freq;
    this.zeta = zeta;
    this.value = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.target = new THREE.Vector3();
  }
  reset() { this.value.set(0, 0, 0); this.velocity.set(0, 0, 0); this.target.set(0, 0, 0); }
  impulse(x, y, z) { this.velocity.x += x; this.velocity.y += y; this.velocity.z += z; }
  update(dt, tx, ty, tz) {
    if (tx !== undefined) this.target.set(tx, ty, tz);
    const w = Math.PI * 2 * this.freq;
    const k = w * w;
    const c = 2 * this.zeta * w;
    const steps = dt > 1 / 90 ? 2 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity.x += (k * (this.target.x - this.value.x) - c * this.velocity.x) * h;
      this.velocity.y += (k * (this.target.y - this.value.y) - c * this.velocity.y) * h;
      this.velocity.z += (k * (this.target.z - this.value.z) - c * this.velocity.z) * h;
      this.value.x += this.velocity.x * h;
      this.value.y += this.velocity.y * h;
      this.value.z += this.velocity.z * h;
    }
    return this.value;
  }
}

/**
 * Smooth 1-D value noise. Breathing and idle drift want a continuous, non
 * periodic wander — a raw sine reads as machinery.
 */
export class ValueNoise {
  constructor(seed = 1) {
    this.n = 64;
    this.t = new Float32Array(this.n);
    let s = seed >>> 0;
    for (let i = 0; i < this.n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      this.t[i] = (s / 0xffffffff) * 2 - 1;
    }
  }
  at(x) {
    const n = this.n;
    const i = Math.floor(x);
    const f = x - i;
    const a = this.t[((i % n) + n) % n];
    const b = this.t[(((i + 1) % n) + n) % n];
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  }
}

/** Deterministic per-shot jitter so recoil is learnable but not robotic. */
export class Rand {
  constructor(seed = 0x9e3779b9) { this.s = seed >>> 0; }
  next() {
    this.s ^= this.s << 13; this.s >>>= 0;
    this.s ^= this.s >>> 17;
    this.s ^= this.s << 5; this.s >>>= 0;
    return this.s / 0xffffffff;
  }
  sym() { return this.next() * 2 - 1; }
  range(a, b) { return a + (b - a) * this.next(); }
}
