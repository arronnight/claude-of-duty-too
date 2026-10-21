import * as THREE from 'three';
import { PT } from './Atlas.js';
import { resetSpec } from './ParticleField.js';

/**
 * Persistent smoke emitters — columns, barrel smoke, lingering dust.
 *
 * `ParticleField` is fire-and-forget: a particle is written once and lives out
 * a closed-form trajectory. That is exactly wrong for a smoke *column*, which
 * has to keep producing new material for seconds while the old material rises,
 * cools, expands and thins. So emitters live here: a small fixed pool, each
 * ticking a spawn accumulator, each with its own colour ramp and rise profile.
 *
 * The look is carried by four things, all of them in `ParticleField`'s shader
 * rather than here: soft depth-faded edges, curl drift, a perturbed hemisphere
 * normal lit by the scene's real sun (so a column is bright on the sun side and
 * blue in its own shade), and the aerial-perspective chunk so a distant column
 * hazes with everything else.
 */

const MAX_EMITTERS = 12;
const _v = new THREE.Vector3();

function makeEmitter() {
  return {
    active: false,
    x: 0, y: 0, z: 0,
    dirX: 0, dirY: 1, dirZ: 0,
    rate: 12, accum: 0,
    age: 0, duration: 2, ramp: 0.25,
    radius: 0.25, rise: 1.4, spread: 0.5,
    life: 3, lifeVar: 0.4,
    size0: 0.3, size1: 2.2,
    drag: 0.9, gravity: 0.35, turb: 0.4,
    alpha: 0.5, fadeOut: 0.5,
    r0: 0.30, g0: 0.29, b0: 0.28,
    r1: 0.52, g1: 0.51, b1: 0.50,
    tile: -1,
    soft: 0.9,
    sunVis: 1,
  };
}

export class Smoke {
  constructor(lit) {
    this.lit = lit;
    this.pool = new Array(MAX_EMITTERS);
    for (let i = 0; i < MAX_EMITTERS; i++) this.pool[i] = makeEmitter();
    this.frozen = false;
  }

  _acquire() {
    let oldest = null;
    for (const e of this.pool) {
      if (!e.active) { e.active = true; e.age = 0; e.accum = 0; e.sunVis = 1; return e; }
      if (!oldest || e.age > oldest.age) oldest = e;
    }
    oldest.age = 0;
    oldest.accum = 0;
    oldest.sunVis = 1;
    return oldest;
  }

  /**
   * A lingering column. `opts` overrides any emitter field; the defaults are a
   * mid-grey vehicle-fire column.
   */
  column(pos, opts) {
    const e = this._acquire();
    e.x = pos.x; e.y = pos.y; e.z = pos.z;
    e.dirX = 0; e.dirY = 1; e.dirZ = 0;
    e.rate = 14; e.duration = 9; e.ramp = 0.5;
    e.radius = 0.45; e.rise = 1.9; e.spread = 0.55;
    e.life = 4.5; e.lifeVar = 0.45;
    e.size0 = 0.55; e.size1 = 4.2;
    e.drag = 0.55; e.gravity = 0.30; e.turb = 0.55;
    e.alpha = 0.42; e.fadeOut = 0.55;
    e.r0 = 0.16; e.g0 = 0.155; e.b0 = 0.15;
    e.r1 = 0.46; e.g1 = 0.45; e.b1 = 0.44;
    e.tile = -1; e.soft = 1.1;
    if (opts) Object.assign(e, opts);
    return e;
  }

  /** Barrel smoke: thin, short, drifting off the muzzle. */
  barrel(pos, dir, heat) {
    const e = this._acquire();
    e.x = pos.x; e.y = pos.y; e.z = pos.z;
    e.dirX = dir.x * 0.45; e.dirY = dir.y * 0.45 + 0.6; e.dirZ = dir.z * 0.45;
    e.rate = 7 * heat; e.duration = 0.9 + heat * 1.4; e.ramp = 0.1;
    e.radius = 0.035; e.rise = 0.45 + heat * 0.4; e.spread = 0.25;
    e.life = 1.1 + heat * 1.0; e.lifeVar = 0.4;
    e.size0 = 0.05; e.size1 = 0.42 + heat * 0.5;
    e.drag = 1.3; e.gravity = 0.16; e.turb = 0.30;
    e.alpha = 0.13 + 0.13 * heat; e.fadeOut = 0.6;
    e.r0 = 0.44; e.g0 = 0.435; e.b0 = 0.43;
    e.r1 = 0.60; e.g1 = 0.60; e.b1 = 0.60;
    e.tile = -1; e.soft = 0.5;
    return e;
  }

  /** Static, already-settled haze: no rise, long life, very soft. */
  haze(pos, opts) {
    const e = this._acquire();
    e.x = pos.x; e.y = pos.y; e.z = pos.z;
    e.rate = 5; e.duration = 12; e.ramp = 1.2;
    e.radius = 1.6; e.rise = 0.18; e.spread = 1.1;
    e.life = 7; e.lifeVar = 0.5;
    e.size0 = 1.4; e.size1 = 4.0;
    e.drag = 0.9; e.gravity = 0.03; e.turb = 0.35;
    e.alpha = 0.13; e.fadeOut = 0.6;
    e.r0 = 0.52; e.g0 = 0.50; e.b0 = 0.47;
    e.r1 = 0.60; e.g1 = 0.58; e.b1 = 0.55;
    e.tile = PT.DUST; e.soft = 1.4;
    if (opts) Object.assign(e, opts);
    return e;
  }

  /** One-shot puff, no emitter slot needed. */
  puff(pos, opts) {
    const n = opts?.count ?? 4;
    for (let i = 0; i < n; i++) {
      const s = resetSpec();
      s.sunVis = opts?.sunVis ?? 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (opts?.radius ?? 0.25);
      s.x = pos.x + Math.cos(a) * r;
      s.y = pos.y + (Math.random() - 0.3) * (opts?.radius ?? 0.25);
      s.z = pos.z + Math.sin(a) * r;
      s.vx = Math.cos(a) * (opts?.spread ?? 0.5) + (opts?.vx ?? 0);
      s.vy = (opts?.rise ?? 0.6) * (0.6 + Math.random() * 0.8) + (opts?.vy ?? 0);
      s.vz = Math.sin(a) * (opts?.spread ?? 0.5) + (opts?.vz ?? 0);
      s.life = (opts?.life ?? 2.0) * (0.7 + Math.random() * 0.6);
      s.drag = opts?.drag ?? 1.1;
      s.gravity = opts?.gravity ?? 0.2;
      s.turb = opts?.turb ?? 0.35;
      s.size0 = opts?.size0 ?? 0.3;
      s.size1 = (opts?.size1 ?? 1.6) * (0.75 + Math.random() * 0.5);
      s.tile = opts?.tile ?? (PT.SMOKE_A + ((Math.random() * 3) | 0));
      s.soft = opts?.soft ?? 0.9;
      s.rot = Math.random() * 6.28;
      s.rotSpeed = (Math.random() - 0.5) * 0.7;
      const c0 = opts?.color0 || [0.30, 0.29, 0.28];
      const c1 = opts?.color1 || [0.52, 0.51, 0.50];
      s.r0 = c0[0]; s.g0 = c0[1]; s.b0 = c0[2];
      s.r1 = c1[0]; s.g1 = c1[1]; s.b1 = c1[2];
      s.a0 = opts?.alpha ?? 0.45;
      s.a1 = 0;
      s.fadeIn = opts?.fadeIn ?? 0.12;
      s.fadeOut = opts?.fadeOut ?? 0.5;
      s.delay = opts?.delay ? opts.delay * Math.random() : 0;
      this.lit.spawn(s);
    }
  }

  /**
   * Fills an emitter's whole history in one call, so a screenshot can be taken
   * of a column that has "already been burning" for `seconds`.
   */
  prime(emitter, seconds, steps = 26) {
    // Never prime further back than the particle lifetime: those births are
    // already expired and the column comes out half as dense as asked for.
    seconds = Math.min(seconds, emitter.life * 0.72);
    const dt = seconds / steps;
    for (let i = steps; i > 0; i--) {
      emitter.age = seconds - i * dt;
      this._emit(emitter, -i * dt);
    }
    emitter.age = seconds;
  }

  _emit(e, birthOffset) {
    const s = resetSpec();
    s.sunVis = e.sunVis;
    const t = e.duration > 0 ? Math.min(1, e.age / Math.max(e.ramp, 1e-3)) : 1;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * e.radius;
    s.x = e.x + Math.cos(a) * r;
    s.y = e.y + (Math.random() - 0.5) * e.radius * 0.5;
    s.z = e.z + Math.sin(a) * r;
    s.vx = e.dirX * e.rise + Math.cos(a) * e.spread * Math.random();
    s.vy = e.dirY * e.rise * (0.75 + Math.random() * 0.5);
    s.vz = e.dirZ * e.rise + Math.sin(a) * e.spread * Math.random();
    s.life = e.life * (1 - e.lifeVar * 0.5 + Math.random() * e.lifeVar);
    s.drag = e.drag;
    s.gravity = e.gravity;
    s.turb = e.turb;
    s.size0 = e.size0 * (0.8 + Math.random() * 0.4);
    s.size1 = e.size1 * (0.75 + Math.random() * 0.5);
    s.tile = e.tile >= 0 ? e.tile : PT.SMOKE_A + ((Math.random() * 3) | 0);
    s.soft = e.soft;
    s.rot = Math.random() * 6.28;
    s.rotSpeed = (Math.random() - 0.5) * 0.55;
    s.r0 = e.r0; s.g0 = e.g0; s.b0 = e.b0;
    s.r1 = e.r1; s.g1 = e.g1; s.b1 = e.b1;
    s.a0 = e.alpha * t;
    s.a1 = 0;
    s.fadeIn = 0.14;
    s.fadeOut = e.fadeOut;
    s.delay = birthOffset || 0;
    this.lit.spawn(s);
  }

  clear() {
    for (const e of this.pool) e.active = false;
  }

  update(dt) {
    if (this.frozen || dt <= 0) return;
    for (const e of this.pool) {
      if (!e.active) continue;
      e.age += dt;
      if (e.age > e.duration) { e.active = false; continue; }
      const tail = 1 - Math.max(0, (e.age - e.duration * 0.6) / (e.duration * 0.4));
      e.accum += dt * e.rate * Math.max(0.15, tail);
      let guard = 0;
      while (e.accum >= 1 && guard++ < 6) {
        e.accum -= 1;
        this._emit(e, 0);
      }
    }
  }
}

export { _v as _smokeScratch };
