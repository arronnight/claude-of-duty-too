import * as THREE from 'three';

/**
 * Motion primitives for the camera rig. Every view offset the player produces is
 * driven through one of these rather than a bare sine, so impulses decay
 * physically, blends never pop, and each effect is retuned by frequency and
 * damping ratio instead of by magic per-frame lerp constants.
 */

const MAX_SUBSTEP = 1 / 90;
const MAX_ITERS = 16;
const DEG = Math.PI / 180;

export class Spring1 {
  constructor(freqHz = 6, zeta = 0.7, value = 0) {
    this.tune(freqHz, zeta);
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  tune(freqHz, zeta) {
    const w = Math.PI * 2 * freqHz;
    this.k = w * w;
    this.c = 2 * zeta * w;
    return this;
  }

  impulse(v) { this.velocity += v; return this; }

  reset(v = 0) { this.value = v; this.target = v; this.velocity = 0; return this; }

  update(dt) {
    let left = dt;
    let iters = 0;
    while (left > 1e-6 && iters++ < MAX_ITERS) {
      const h = left > MAX_SUBSTEP ? MAX_SUBSTEP : left;
      left -= h;
      const a = this.k * (this.target - this.value) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

const _acc = new THREE.Vector3();

export class Spring3 {
  constructor(freqHz = 6, zeta = 0.7) {
    this.tune(freqHz, zeta);
    this.value = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
  }

  tune(freqHz, zeta) {
    const w = Math.PI * 2 * freqHz;
    this.k = w * w;
    this.c = 2 * zeta * w;
    return this;
  }

  reset() { this.value.set(0, 0, 0); this.target.set(0, 0, 0); this.velocity.set(0, 0, 0); return this; }

  update(dt) {
    let left = dt;
    let iters = 0;
    while (left > 1e-6 && iters++ < MAX_ITERS) {
      const h = left > MAX_SUBSTEP ? MAX_SUBSTEP : left;
      left -= h;
      _acc.copy(this.target).sub(this.value).multiplyScalar(this.k).addScaledVector(this.velocity, -this.c);
      this.velocity.addScaledVector(_acc, h);
      this.value.addScaledVector(this.velocity, h);
    }
    return this.value;
  }
}

/** Seeded 1D value noise. Drives breathing and sway so they never repeat audibly. */
export class ValueNoise {
  constructor(seed = 1337, size = 512) {
    this.mask = size - 1;
    this.t = new Float32Array(size);
    let s = seed >>> 0;
    for (let i = 0; i < size; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      this.t[i] = (s / 4294967296) * 2 - 1;
    }
  }

  at(x) {
    const i = Math.floor(x);
    const f = x - i;
    const a = this.t[i & this.mask];
    const b = this.t[(i + 1) & this.mask];
    return a + (b - a) * (f * f * (3 - 2 * f));
  }

  fbm(x) {
    return this.at(x) * 0.62 + this.at(x * 2.13 + 17.3) * 0.26 + this.at(x * 4.71 + 41.1) * 0.12;
  }
}

/** Framerate-independent exponential approach; `rate` is roughly 4/settleSeconds. */
export function approach(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function lerp(a, b, t) { return a + (b - a) * t; }

export function smoothstep(t) { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); }

export function smootherstep(t) { const x = clamp(t, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); }

export function easeOutCubic(t) { const x = 1 - clamp(t, 0, 1); return 1 - x * x * x; }

export function easeInCubic(t) { const x = clamp(t, 0, 1); return x * x * x; }

export function easeOutQuint(t) { const x = 1 - clamp(t, 0, 1); return 1 - x * x * x * x * x; }

/** Rises fast, settles with a small overshoot — used for the mantle pull-up. */
export function easeOutBack(t, overshoot = 1.18) {
  const x = clamp(t, 0, 1) - 1;
  const c = overshoot;
  return 1 + x * x * ((c + 1) * x + c);
}

/** Unit bump, zero at both ends — envelope for one-shot roll/FOV punches. */
export function bump(t, power = 1) {
  const s = Math.sin(Math.PI * clamp(t, 0, 1));
  return power === 1 ? s : Math.pow(s, power);
}

export const deg = (d) => d * DEG;
