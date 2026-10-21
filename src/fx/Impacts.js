import * as THREE from 'three';
import { PT } from './Atlas.js';
import { SPEC, resetSpec } from './ParticleField.js';

/**
 * Per-surface impact signatures.
 *
 * This is the file that decides whether shooting feels real. Every surface gets
 * a *different* particle signature, because the thing a player reads in the
 * quarter second after a round lands is not "particles happened" — it is
 * "that was concrete" or "that was sheet metal". The families:
 *
 *  - **concrete / brick / plaster** — a pale grey dust puff that lingers,
 *    a scatter of angular chips, and a pockmark decal with a bright exposed-
 *    aggregate ring. No sparks: masonry does not spark.
 *  - **metal** — hot sparks on a white → yellow → deep-orange temperature ramp
 *    that *bounce*: a short raycast along each spark's ballistic path spawns a
 *    delayed secondary from the reflection, which is why they skitter along the
 *    ground instead of dying in mid-air. Plus a torn bright-lipped hole.
 *  - **wood** — tumbling splinters along the surface tangent, a warm brown
 *    dust wisp, a dark ragged hole.
 *  - **sand / dirt / gravel** — no chips and no ring: a soft brown plume that
 *    keeps growing and drifts, and a shallow divot.
 *  - **glass** — a cone of shards catching a specular glint, an additive
 *    sparkle layer, and a radial crack decal.
 *  - **flesh** — restrained. A short directional mist, a few droplets, and a
 *    splat decal on whatever is behind.
 *
 * Everything writes through the shared `SPEC` descriptor, so an impact
 * allocates nothing.
 */

const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ALT = new THREE.Vector3(1, 0, 0);

/**
 * Material key → family. Substring matched so it survives whatever the level
 * and prop agents actually tag their colliders with.
 */
const FAMILY_RULES = [
  ['glass', 'glass'],
  ['flesh', 'flesh'], ['body', 'flesh'], ['head', 'flesh'], ['bot', 'flesh'],
  ['sandbag', 'sand'], ['sand', 'sand'], ['dirt', 'dirt'], ['gravel', 'gravel'],
  ['rubble', 'gravel'],
  ['wood', 'wood'], ['plank', 'wood'], ['plywood', 'wood'], ['bark', 'wood'],
  ['corrugated', 'thinmetal'], ['metal', 'metal'], ['steel', 'metal'],
  ['gun_', 'metal'], ['rust', 'metal'],
  ['fabric', 'fabric'], ['canvas', 'fabric'], ['tarp', 'fabric'],
  ['foliage', 'foliage'],
  ['rubber', 'rubber'], ['tyre', 'rubber'],
  ['tile', 'concrete'], ['brick', 'brick'], ['plaster', 'plaster'],
  ['stucco', 'plaster'], ['asphalt', 'asphalt'], ['tarmac', 'asphalt'],
  ['concrete', 'concrete'],
];

export function surfaceFamily(key) {
  if (!key) return 'concrete';
  const k = String(key).toLowerCase();
  for (let i = 0; i < FAMILY_RULES.length; i++) {
    if (k.indexOf(FAMILY_RULES[i][0]) >= 0) return FAMILY_RULES[i][1];
  }
  return 'concrete';
}

/** Dust colour and decal per family. Dust is albedo — the shader lights it. */
const FAMILY = {
  concrete: { dust: [0.66, 0.645, 0.615], chip: [0.34, 0.33, 0.31], decal: 'bullet_concrete', sound: 'impact_concrete' },
  brick: { dust: [0.62, 0.47, 0.40], chip: [0.42, 0.24, 0.18], decal: 'bullet_brick', sound: 'impact_concrete' },
  plaster: { dust: [0.78, 0.755, 0.71], chip: [0.55, 0.53, 0.50], decal: 'bullet_plaster', sound: 'impact_concrete' },
  asphalt: { dust: [0.42, 0.41, 0.40], chip: [0.16, 0.155, 0.15], decal: 'bullet_concrete', sound: 'impact_concrete' },
  gravel: { dust: [0.56, 0.52, 0.46], chip: [0.30, 0.27, 0.23], decal: 'bullet_sand', sound: 'impact_dirt' },
  dirt: { dust: [0.44, 0.34, 0.24], chip: [0.24, 0.18, 0.12], decal: 'bullet_sand', sound: 'impact_dirt' },
  sand: { dust: [0.66, 0.55, 0.38], chip: [0.42, 0.34, 0.22], decal: 'bullet_sand', sound: 'impact_dirt' },
  wood: { dust: [0.50, 0.38, 0.24], chip: [0.32, 0.21, 0.12], decal: 'bullet_wood', sound: 'impact_wood' },
  metal: { dust: [0.34, 0.33, 0.33], chip: [0.22, 0.22, 0.23], decal: 'bullet_metal', sound: 'impact_metal' },
  thinmetal: { dust: [0.36, 0.35, 0.34], chip: [0.24, 0.24, 0.25], decal: 'bullet_metal', sound: 'impact_metal_thin' },
  glass: { dust: [0.70, 0.76, 0.80], chip: [0.62, 0.70, 0.76], decal: 'bullet_glass', sound: 'impact_glass' },
  fabric: { dust: [0.50, 0.46, 0.40], chip: [0.34, 0.31, 0.26], decal: 'scuff', sound: 'impact_fabric' },
  foliage: { dust: [0.30, 0.38, 0.20], chip: [0.20, 0.28, 0.13], decal: null, sound: 'impact_foliage' },
  rubber: { dust: [0.22, 0.22, 0.22], chip: [0.11, 0.11, 0.11], decal: 'scuff', sound: 'impact_rubber' },
  // Flesh places its own decal from the exit ray, not from the entry normal.
  flesh: { dust: [0.34, 0.06, 0.05], chip: [0.28, 0.04, 0.035], decal: null, sound: null },
};

const _sun = new THREE.Vector3();
const rnd = (a, b) => a + Math.random() * (b - a);

export class Impacts {
  constructor(ctx, lit, add, decals) {
    this.ctx = ctx;
    this.lit = lit;
    this.add = add;
    this.decals = decals;
    this.sparkBounces = true;
    this.sunVis = 1;
  }

  /** Builds a tangent frame around a surface normal. */
  _frame(normal) {
    _n.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_n.lengthSq() < 1e-9) _n.set(0, 1, 0);
    _n.normalize();
    _t.copy(Math.abs(_n.y) > 0.94 ? ALT : UP).cross(_n).normalize();
    _b.copy(_n).cross(_t).normalize();
  }

  /** Random direction in the hemisphere around `_n`, biased toward the normal. */
  _cone(spread) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    _v.copy(_n).multiplyScalar(Math.sqrt(Math.max(0, 1 - r * r)))
      .addScaledVector(_t, Math.cos(a) * r)
      .addScaledVector(_b, Math.sin(a) * r);
    return _v;
  }

  /**
   * One ray at the sun per effect, not per particle: is this spot in the light?
   * Everything the effect spawns inherits the answer through `SPEC.sunVis`.
   */
  sunVisibility(point, normal) {
    const dir = this.ctx.lighting?.sunDirection || this.ctx.sky?.sunDirection;
    const phys = this.ctx.physics;
    if (!dir || !phys?.raycast || dir.y <= 0.02) return 1;
    _sun.copy(dir).normalize();
    _p.set(point.x, point.y, point.z);
    if (normal) _p.addScaledVector(normal, 0.06);
    _p.y += 0.02;
    return phys.raycast(_p, _sun, 70, 1 | 2) ? 0.16 : 1;
  }

  impact(point, normal, surfaceKey, energy = 1) {
    const fam = surfaceFamily(surfaceKey);
    const e = THREE.MathUtils.clamp(energy || 1, 0.25, 3);
    this._frame(normal);
    SPEC.sunVis = this.sunVisibility(point, _n);
    this.sunVis = SPEC.sunVis;
    const def = FAMILY[fam] || FAMILY.concrete;

    switch (fam) {
      case 'metal': case 'thinmetal': this._metal(point, def, e, fam === 'thinmetal'); break;
      case 'wood': this._wood(point, def, e); break;
      case 'sand': case 'dirt': case 'gravel': this._soft(point, def, e); break;
      case 'glass': this._glass(point, def, e); break;
      case 'fabric': case 'foliage': case 'rubber': this._muted(point, def, e); break;
      case 'flesh': this._flesh(point, def, e); break;
      default: this._masonry(point, def, e, fam); break;
    }

    if (def.decal && this.decals) {
      this.decals.add(point, _n, def.decal, undefined, 1);
      // A heavy hit also scars the surrounding surface, which is what makes a
      // shot-up wall read as shot up rather than as a sticker collection.
      if (e > 1.6 && Math.random() < 0.5) {
        this.decals.add(point, _n, 'spall', 0.55 + Math.random() * 0.4, 0.55);
      }
    }
    if (def.sound) this.ctx.audio?.playAt?.(def.sound, point, { gain: Math.min(1, 0.45 + e * 0.3) });
  }

  // ------------------------------------------------------------- signatures

  _masonry(point, def, e, fam) {
    const lit = this.lit;
    // Dust: one broad puff plus two small satellites so the plume has structure.
    for (let i = 0; i < 3; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      const big = i === 0;
      this._cone(big ? 0.35 : 0.8);
      const sp = big ? rnd(0.5, 0.9) : rnd(1.2, 2.4);
      // Stand the puff off the surface: it is a cloud coming *out* of the wall,
      // and a billboard centred on the wall plane is half-buried in it.
      const off = big ? 0.16 : 0.10;
      s.x = point.x + _n.x * off; s.y = point.y + _n.y * off; s.z = point.z + _n.z * off;
      s.vx = _v.x * sp; s.vy = _v.y * sp + 0.35; s.vz = _v.z * sp;
      s.life = big ? rnd(0.85, 1.25) * e : rnd(0.4, 0.7);
      s.drag = big ? 2.8 : 3.6;
      s.gravity = -0.7;
      s.size0 = big ? 0.07 * e : 0.035;
      s.size1 = big ? rnd(0.55, 0.85) * e : rnd(0.20, 0.34);
      s.tile = big ? PT.DUST : PT.SMOKE_A + ((Math.random() * 3) | 0);
      s.turb = 0.12;
      s.soft = 0.55;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-1.1, 1.1);
      s.r0 = def.dust[0]; s.g0 = def.dust[1]; s.b0 = def.dust[2];
      s.r1 = def.dust[0] * 0.88; s.g1 = def.dust[1] * 0.88; s.b1 = def.dust[2] * 0.9;
      s.a0 = big ? 0.85 : 0.55; s.a1 = 0;
      s.fadeIn = 0.04; s.fadeOut = 0.55;
      lit.spawn(s);
    }

    // Chips: spinning angular fragments on real ballistic arcs.
    const chips = Math.round(rnd(4, 7) * e);
    for (let i = 0; i < chips; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(0.85);
      const sp = rnd(2.5, 8.5);
      s.x = point.x + _n.x * 0.02; s.y = point.y + _n.y * 0.02; s.z = point.z + _n.z * 0.02;
      s.vx = _v.x * sp; s.vy = _v.y * sp + rnd(0.4, 1.6); s.vz = _v.z * sp;
      s.life = rnd(0.6, 1.25);
      s.drag = 0.55; s.gravity = -11.5;
      s.size0 = rnd(0.010, 0.032); s.size1 = s.size0;
      s.tile = PT.CHIP;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-14, 14);
      s.soft = 0.12;
      s.r0 = def.chip[0]; s.g0 = def.chip[1]; s.b0 = def.chip[2];
      s.r1 = def.chip[0]; s.g1 = def.chip[1]; s.b1 = def.chip[2];
      s.a0 = 1; s.a1 = 1; s.fadeIn = 0.01; s.fadeOut = 0.12;
      lit.spawn(s);
    }

    // A single frame of white-hot flash where the round vaporises: masonry does
    // not spark, but a jacketed round arriving at 800 m/s does flash.
    if (fam !== 'asphalt') {
      const s = resetSpec(); s.sunVis = this.sunVis;
      s.x = point.x + _n.x * 0.03; s.y = point.y + _n.y * 0.03; s.z = point.z + _n.z * 0.03;
      s.life = 0.055; s.drag = 0; s.gravity = 0;
      s.size0 = 0.10 * e; s.size1 = 0.17 * e;
      s.tile = PT.SOFT; s.soft = 0.5;
      s.r0 = 2.6; s.g0 = 1.9; s.b0 = 1.0; s.a0 = 0.85;
      s.r1 = 1.4; s.g1 = 0.7; s.b1 = 0.2; s.a1 = 0;
      s.fadeIn = 0.02; s.fadeOut = 0.7;
      this.add.spawn(s);
    }
  }

  _metal(point, def, e, thin) {
    const count = Math.round(rnd(10, 18) * e);
    for (let i = 0; i < count; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(0.95);
      const sp = rnd(4, 15) * (thin ? 0.85 : 1);
      s.x = point.x + _n.x * 0.02; s.y = point.y + _n.y * 0.02; s.z = point.z + _n.z * 0.02;
      s.vx = _v.x * sp; s.vy = _v.y * sp + rnd(0, 1.4); s.vz = _v.z * sp;
      s.life = rnd(0.28, 0.85);
      s.drag = rnd(1.4, 3.0);
      s.gravity = -13.5;
      s.size0 = rnd(0.010, 0.020); s.size1 = s.size0 * 0.55;
      s.tile = PT.SPARK;
      s.stretch = 0.0075;               // velocity-aligned smear
      s.soft = 0.06;
      // Blackbody-ish cooling: white-hot -> yellow -> deep orange.
      s.r0 = 5.2; s.g0 = 3.4; s.b0 = 1.35; s.a0 = 1;
      s.r1 = 2.1; s.g1 = 0.42; s.b1 = 0.05; s.a1 = 0.9;
      s.fadeIn = 0.02; s.fadeOut = 0.35;
      this.add.spawn(s);
      if (this.sparkBounces && i < 4) this._bounceSpark(point, s);
    }

    // Impact flash and a thin wisp of scorched-metal smoke.
    const f = resetSpec(); f.sunVis = this.sunVis;
    f.x = point.x + _n.x * 0.03; f.y = point.y + _n.y * 0.03; f.z = point.z + _n.z * 0.03;
    f.life = 0.07; f.gravity = 0;
    f.size0 = 0.22 * e; f.size1 = 0.34 * e;
    f.tile = PT.FLASH_STAR; f.soft = 0.2;
    f.rot = Math.random() * 6.28;
    f.r0 = 5.5; f.g0 = 3.6; f.b0 = 1.5; f.a0 = 1;
    f.r1 = 2.0; f.g1 = 0.8; f.b1 = 0.15; f.a1 = 0;
    f.fadeIn = 0.02; f.fadeOut = 0.6;
    this.add.spawn(f);

    for (let i = 0; i < 2; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(0.5);
      s.x = point.x + _n.x * 0.13; s.y = point.y + _n.y * 0.13; s.z = point.z + _n.z * 0.13;
      s.vx = _v.x * 0.8; s.vy = _v.y * 0.8 + 0.6; s.vz = _v.z * 0.8;
      s.life = rnd(0.5, 0.85); s.drag = 3.0; s.gravity = -0.4;
      s.size0 = 0.04; s.size1 = rnd(0.18, 0.30);
      s.tile = PT.SMOKE_B; s.turb = 0.12; s.soft = 0.4;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-1.4, 1.4);
      s.r0 = def.dust[0]; s.g0 = def.dust[1]; s.b0 = def.dust[2];
      s.r1 = def.dust[0]; s.g1 = def.dust[1]; s.b1 = def.dust[2];
      s.a0 = 0.34; s.a1 = 0;
      this.lit.spawn(s);
    }
  }

  /**
   * Sparks that skitter. Casts a short ray along the spark's initial path; if
   * it finds geometry, a delayed secondary is spawned at the reflection with
   * the birth offset by the time of flight, so it reads as one spark bouncing
   * rather than two sparks appearing.
   */
  _bounceSpark(point, src) {
    const phys = this.ctx.physics;
    if (!phys?.raycast) return;
    _v.set(src.vx, src.vy, src.vz);
    const speed = _v.length();
    if (speed < 1.5) return;
    _v.multiplyScalar(1 / speed);
    _p.set(src.x, src.y, src.z);
    const reach = Math.min(2.2, speed * 0.16);
    const hit = phys.raycast(_p, _v, reach, 1 | 2);
    if (!hit) return;

    const tof = Math.max(0.02, hit.distance / speed);
    _r.set(hit.normal.x, hit.normal.y, hit.normal.z);
    const dot = _v.dot(_r);
    _v.addScaledVector(_r, -2 * dot).normalize();

    const s = resetSpec(); s.sunVis = this.sunVis;
    s.x = hit.point.x + _r.x * 0.01;
    s.y = hit.point.y + _r.y * 0.01;
    s.z = hit.point.z + _r.z * 0.01;
    const rs = speed * rnd(0.28, 0.5);
    s.vx = (_v.x + rnd(-0.25, 0.25)) * rs;
    s.vy = (_v.y + rnd(0.05, 0.4)) * rs;
    s.vz = (_v.z + rnd(-0.25, 0.25)) * rs;
    s.delay = tof;
    s.life = rnd(0.18, 0.5);
    s.drag = 2.4; s.gravity = -13.5;
    s.size0 = 0.009; s.size1 = 0.005;
    s.tile = PT.SPARK; s.stretch = 0.006; s.soft = 0.06;
    s.r0 = 3.2; s.g0 = 1.5; s.b0 = 0.35; s.a0 = 1;
    s.r1 = 1.2; s.g1 = 0.20; s.b1 = 0.02; s.a1 = 0.8;
    s.fadeIn = 0.02; s.fadeOut = 0.4;
    this.add.spawn(s);
  }

  _wood(point, def, e) {
    const n = Math.round(rnd(6, 11) * e);
    for (let i = 0; i < n; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(1.0);
      const sp = rnd(2.0, 7.0);
      s.x = point.x + _n.x * 0.02; s.y = point.y + _n.y * 0.02; s.z = point.z + _n.z * 0.02;
      s.vx = _v.x * sp; s.vy = _v.y * sp + rnd(0.2, 1.4); s.vz = _v.z * sp;
      s.life = rnd(0.7, 1.4);
      s.drag = 1.1; s.gravity = -10.5;
      s.size0 = rnd(0.030, 0.085); s.size1 = s.size0;
      s.tile = PT.SPLINTER;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-18, 18);
      s.soft = 0.12;
      s.r0 = def.chip[0]; s.g0 = def.chip[1]; s.b0 = def.chip[2];
      s.r1 = def.chip[0] * 0.8; s.g1 = def.chip[1] * 0.8; s.b1 = def.chip[2] * 0.8;
      s.a0 = 1; s.a1 = 1; s.fadeIn = 0.01; s.fadeOut = 0.15;
      this.lit.spawn(s);
    }
    for (let i = 0; i < 2; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(0.55);
      s.x = point.x + _n.x * 0.13; s.y = point.y + _n.y * 0.13; s.z = point.z + _n.z * 0.13;
      s.vx = _v.x * 0.9; s.vy = _v.y * 0.9 + 0.4; s.vz = _v.z * 0.9;
      s.life = rnd(0.6, 1.0); s.drag = 3.2; s.gravity = -0.6;
      s.size0 = 0.045; s.size1 = rnd(0.22, 0.38);
      s.tile = PT.DUST; s.turb = 0.1; s.soft = 0.45;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-1, 1);
      s.r0 = def.dust[0]; s.g0 = def.dust[1]; s.b0 = def.dust[2];
      s.r1 = def.dust[0]; s.g1 = def.dust[1]; s.b1 = def.dust[2];
      s.a0 = 0.42; s.a1 = 0;
      this.lit.spawn(s);
    }
  }

  _soft(point, def, e) {
    // No chips, no ring, no flash: soil absorbs. What sells it is the plume
    // continuing to grow and drift long after the round has gone.
    for (let i = 0; i < 4; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      const big = i < 2;
      this._cone(big ? 0.45 : 0.95);
      const sp = big ? rnd(1.0, 2.2) : rnd(2.0, 4.5);
      s.x = point.x + _n.x * 0.14; s.y = point.y + _n.y * 0.14; s.z = point.z + _n.z * 0.14;
      s.vx = _v.x * sp; s.vy = _v.y * sp + rnd(0.5, 1.6); s.vz = _v.z * sp;
      s.life = big ? rnd(1.2, 1.8) * e : rnd(0.6, 1.0);
      s.drag = big ? 2.0 : 3.0;
      s.gravity = -0.55;
      s.size0 = big ? 0.09 * e : 0.045;
      s.size1 = big ? rnd(0.80, 1.20) * e : rnd(0.30, 0.5);
      s.tile = big ? PT.DUST : PT.SMOKE_C;
      s.turb = 0.20; s.soft = 0.6;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-0.9, 0.9);
      s.r0 = def.dust[0]; s.g0 = def.dust[1]; s.b0 = def.dust[2];
      s.r1 = def.dust[0] * 0.9; s.g1 = def.dust[1] * 0.9; s.b1 = def.dust[2] * 0.92;
      s.a0 = big ? 0.78 : 0.52; s.a1 = 0;
      s.fadeIn = 0.06; s.fadeOut = 0.6;
      this.lit.spawn(s);
    }
    const grit = Math.round(rnd(5, 10) * e);
    for (let i = 0; i < grit; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(0.8);
      const sp = rnd(2.5, 7.5);
      s.x = point.x; s.y = point.y; s.z = point.z;
      s.vx = _v.x * sp; s.vy = _v.y * sp + rnd(1, 3); s.vz = _v.z * sp;
      s.life = rnd(0.6, 1.1); s.drag = 0.9; s.gravity = -11;
      s.size0 = rnd(0.008, 0.026); s.size1 = s.size0;
      s.tile = PT.CHIP; s.soft = 0.1;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-12, 12);
      s.r0 = def.chip[0]; s.g0 = def.chip[1]; s.b0 = def.chip[2];
      s.r1 = def.chip[0]; s.g1 = def.chip[1]; s.b1 = def.chip[2];
      s.a0 = 1; s.a1 = 1; s.fadeIn = 0.01; s.fadeOut = 0.2;
      this.lit.spawn(s);
    }
  }

  _glass(point, def, e) {
    const n = Math.round(rnd(9, 15) * e);
    for (let i = 0; i < n; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(0.9);
      const sp = rnd(2.5, 8);
      s.x = point.x + _n.x * 0.02; s.y = point.y + _n.y * 0.02; s.z = point.z + _n.z * 0.02;
      s.vx = _v.x * sp; s.vy = _v.y * sp + rnd(0, 1.2); s.vz = _v.z * sp;
      s.life = rnd(0.8, 1.5);
      s.drag = 0.5; s.gravity = -11.5;
      s.size0 = rnd(0.018, 0.055); s.size1 = s.size0;
      s.tile = PT.SHARD;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-20, 20);
      s.soft = 0.1;
      s.r0 = def.chip[0]; s.g0 = def.chip[1]; s.b0 = def.chip[2];
      s.r1 = def.chip[0]; s.g1 = def.chip[1]; s.b1 = def.chip[2];
      s.a0 = 0.9; s.a1 = 0.9; s.fadeIn = 0.01; s.fadeOut = 0.2;
      this.lit.spawn(s);
      // A matching additive glint: glass is only readable when it catches light.
      if (i % 2 === 0) {
        const g = resetSpec(); g.sunVis = this.sunVis;
        g.x = s.x; g.y = s.y; g.z = s.z;
        g.vx = s.vx; g.vy = s.vy; g.vz = s.vz;
        g.life = s.life * 0.7; g.drag = s.drag; g.gravity = s.gravity;
        g.size0 = s.size0 * 0.8; g.size1 = g.size0 * 0.8;
        g.tile = PT.SHARD; g.soft = 0.1;
        g.rot = s.rot; g.rotSpeed = s.rotSpeed;
        g.r0 = 1.8; g.g0 = 2.0; g.b0 = 2.2; g.a0 = 0.55;
        g.r1 = 0.8; g.g1 = 0.9; g.b1 = 1.0; g.a1 = 0.2;
        this.add.spawn(g);
      }
    }
  }

  _muted(point, def, e) {
    for (let i = 0; i < 3; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(0.8);
      const sp = rnd(0.8, 2.4);
      s.x = point.x + _n.x * 0.03; s.y = point.y + _n.y * 0.03; s.z = point.z + _n.z * 0.03;
      s.vx = _v.x * sp; s.vy = _v.y * sp + 0.3; s.vz = _v.z * sp;
      s.life = rnd(0.4, 0.9); s.drag = 3.6; s.gravity = -1.2;
      s.size0 = 0.04; s.size1 = rnd(0.16, 0.32);
      s.tile = PT.DUST; s.soft = 0.4; s.turb = 0.1;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-1.5, 1.5);
      s.r0 = def.dust[0]; s.g0 = def.dust[1]; s.b0 = def.dust[2];
      s.r1 = def.dust[0]; s.g1 = def.dust[1]; s.b1 = def.dust[2];
      s.a0 = 0.38; s.a1 = 0;
      this.lit.spawn(s);
    }
  }

  _flesh(point, def, e) {
    this.bloodHit(point, _n, _n, e);
  }

  /**
   * Restrained, directional blood. Six to nine droplets in a narrow cone with
   * the bullet, a low-alpha mist, and one splat decal on whatever is behind.
   */
  bloodHit(point, normal, dir, energy = 1) {
    const e = THREE.MathUtils.clamp(energy || 1, 0.3, 2.5);
    _r.set(dir?.x ?? 0, dir?.y ?? 0, dir?.z ?? 1);
    if (_r.lengthSq() < 1e-8) _r.set(0, 0, 1);
    _r.normalize();
    this._frame(_r);
    this.sunVis = this.sunVisibility(point, null);

    const n = Math.round(rnd(6, 9) * e);
    for (let i = 0; i < n; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(0.42);
      const sp = rnd(1.6, 5.2);
      s.x = point.x; s.y = point.y; s.z = point.z;
      s.vx = _v.x * sp; s.vy = _v.y * sp + rnd(0.2, 1.1); s.vz = _v.z * sp;
      s.life = rnd(0.35, 0.75);
      s.drag = 1.3; s.gravity = -12;
      s.size0 = rnd(0.02, 0.062); s.size1 = s.size0 * 1.15;
      s.tile = PT.BLOOD; s.soft = 0.1;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-6, 6);
      s.r0 = 0.30; s.g0 = 0.035; s.b0 = 0.03;
      s.r1 = 0.20; s.g1 = 0.025; s.b1 = 0.022;
      s.a0 = 0.95; s.a1 = 0.8; s.fadeIn = 0.01; s.fadeOut = 0.25;
      this.lit.spawn(s);
    }
    for (let i = 0; i < 2; i++) {
      const s = resetSpec(); s.sunVis = this.sunVis;
      this._cone(0.6);
      s.x = point.x; s.y = point.y; s.z = point.z;
      s.vx = _v.x * 1.6; s.vy = _v.y * 1.6 + 0.2; s.vz = _v.z * 1.6;
      s.life = rnd(0.22, 0.4); s.drag = 4.5; s.gravity = -2;
      s.size0 = 0.06; s.size1 = rnd(0.22, 0.34);
      s.tile = PT.SMOKE_C; s.soft = 0.3;
      s.rot = Math.random() * 6.28;
      s.r0 = 0.26; s.g0 = 0.045; s.b0 = 0.04;
      s.r1 = 0.20; s.g1 = 0.035; s.b1 = 0.032;
      s.a0 = 0.30; s.a1 = 0; s.fadeIn = 0.05; s.fadeOut = 0.7;
      this.lit.spawn(s);
    }

    const phys = this.ctx.physics;
    if (phys?.raycast && this.decals) {
      _p.set(point.x, point.y, point.z);
      const hit = phys.raycast(_p, _r, 2.6, 1 | 2);
      if (hit) this.decals.add(hit.point, hit.normal, 'blood', 0.30 + Math.random() * 0.35, 0.9);
    }
    this.ctx.audio?.playAt?.('impact_flesh', point, { gain: 0.7 });
  }
}
