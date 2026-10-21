import * as THREE from 'three';
import { PT } from './Atlas.js';
import { resetSpec } from './ParticleField.js';

/**
 * Explosions, staged as a sequence rather than a single burst.
 *
 * A real detonation is legible because its parts arrive in order and at very
 * different speeds, and that ordering is what the eye reads as force:
 *
 *   t+0 ms    white flash, gone in two frames
 *   t+0 ms    fireball expanding fast, hot core cooling white → orange → soot
 *   t+0 ms    debris and embers thrown ballistically, the fastest arriving first
 *   t+30 ms   a dust ring rolling *outward along the ground*, not upward — this
 *             is the single most recognisable part of a movie explosion and the
 *             most commonly omitted
 *   t+150 ms  the fireball's remains lift into a smoke column that lingers
 *
 * The light comes from the lighting system's own `fx:explosion` handler (a
 * 4200-candela, 0.4 s pulse with a hold), so this does not add a second one.
 * The screen shake is routed back through `FXSystem.screenShake`.
 */

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _colOpts = { sunVis: 1 };
const rnd = (a, b) => a + Math.random() * (b - a);

export class Explosions {
  constructor(ctx, lit, add, smoke, decals, fx) {
    this.ctx = ctx;
    this.lit = lit;
    this.add = add;
    this.smoke = smoke;
    this.decals = decals;
    this.fx = fx;
    this._payload = { pos: new THREE.Vector3(), radius: 5 };
  }

  /**
   * @param {THREE.Vector3|{x,y,z}} pos
   * @param {number} radius blast radius in metres; scales everything
   * @param {{ground?: boolean, hold?: number}} [opts]
   */
  explode(pos, radius = 5, opts) {
    const R = THREE.MathUtils.clamp(radius || 5, 0.6, 24);
    const sunVis = this.fx?.impacts?.sunVisibility?.(pos, null) ?? 1;
    const k = R / 5;
    const hold = opts?.hold || 0;
    _p.set(pos.x, pos.y, pos.z);

    // --- flash --------------------------------------------------------------
    const f = resetSpec(); f.sunVis = sunVis;
    f.x = _p.x; f.y = _p.y; f.z = _p.z;
    f.life = 0.075 + hold; f.gravity = 0; f.drag = 0;
    f.size0 = 1.1 * k; f.size1 = 2.4 * k;
    f.tile = PT.FLASH_STAR; f.soft = 0.6;
    f.rot = Math.random() * 6.28;
    f.r0 = 12.0; f.g0 = 9.5; f.b0 = 6.0; f.a0 = 1;
    f.r1 = 6.0; f.g1 = 2.6; f.b1 = 0.6; f.a1 = 0.5;
    f.fadeIn = 0.02; f.fadeOut = 0.5;
    this.add.spawn(f);

    // --- fireball -----------------------------------------------------------
    const balls = 9;
    for (let i = 0; i < balls; i++) {
      const s = resetSpec(); s.sunVis = sunVis;
      s.sunVis = sunVis;
      const core = i < 3;
      const a = Math.random() * Math.PI * 2;
      const el = rnd(-0.25, 0.85);
      const sp = core ? rnd(0.6, 2.0) * k : rnd(2.4, 6.5) * k;
      _v.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
      s.x = _p.x + _v.x * 0.2 * k; s.y = _p.y + _v.y * 0.2 * k; s.z = _p.z + _v.z * 0.2 * k;
      s.vx = _v.x * sp; s.vy = _v.y * sp + 1.1 * k; s.vz = _v.z * sp;
      s.life = (core ? rnd(0.26, 0.42) : rnd(0.18, 0.34)) + hold;
      s.drag = 3.4; s.gravity = 1.6;
      s.size0 = (core ? 0.7 : 0.35) * k;
      s.size1 = (core ? 2.6 : 1.7) * k;
      s.tile = PT.FIRE; s.soft = 0.7;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-1.6, 1.6);
      s.r0 = core ? 9.0 : 5.2; s.g0 = core ? 6.0 : 2.6; s.b0 = core ? 2.2 : 0.7; s.a0 = 1;
      s.r1 = 1.6; s.g1 = 0.34; s.b1 = 0.05; s.a1 = 0.25;
      s.fadeIn = 0.03; s.fadeOut = 0.55;
      this.add.spawn(s);
    }

    // Sooty shell wrapping the fireball, so it is not pure additive glow.
    for (let i = 0; i < 7; i++) {
      const s = resetSpec(); s.sunVis = sunVis;
      s.sunVis = sunVis;
      const a = Math.random() * Math.PI * 2;
      const el = rnd(-0.1, 0.9);
      const sp = rnd(1.6, 4.6) * k;
      _v.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
      s.x = _p.x; s.y = _p.y; s.z = _p.z;
      s.vx = _v.x * sp; s.vy = _v.y * sp + 1.4 * k; s.vz = _v.z * sp;
      s.life = rnd(1.4, 2.6) + hold;
      s.drag = 1.9; s.gravity = 0.5; s.turb = 0.5;
      s.size0 = 0.5 * k; s.size1 = rnd(2.4, 4.2) * k;
      s.tile = PT.SMOKE_A + ((Math.random() * 3) | 0);
      s.soft = 1.0;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-0.7, 0.7);
      s.r0 = 0.055; s.g0 = 0.048; s.b0 = 0.044;
      s.r1 = 0.34; s.g1 = 0.32; s.b1 = 0.30;
      s.a0 = 0.80; s.a1 = 0;
      s.fadeIn = 0.05; s.fadeOut = 0.55;
      this.lit.spawn(s);
    }

    // --- ground dust ring ---------------------------------------------------
    const ringN = 14;
    for (let i = 0; i < ringN; i++) {
      const s = resetSpec(); s.sunVis = sunVis;
      const a = (i / ringN) * Math.PI * 2 + rnd(-0.16, 0.16);
      const sp = rnd(5.5, 9.5) * k;
      s.x = _p.x + Math.cos(a) * 0.4 * k;
      s.y = _p.y - 0.15;
      s.z = _p.z + Math.sin(a) * 0.4 * k;
      s.vx = Math.cos(a) * sp; s.vy = rnd(0.25, 0.9); s.vz = Math.sin(a) * sp;
      s.life = rnd(1.6, 2.6) + hold;
      s.drag = 2.3; s.gravity = 0.12; s.turb = 0.30;
      s.size0 = 0.5 * k; s.size1 = rnd(2.2, 3.6) * k;
      s.tile = PT.DUST; s.soft = 1.1;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-0.5, 0.5);
      s.r0 = 0.42; s.g0 = 0.375; s.b0 = 0.315;
      s.r1 = 0.58; s.g1 = 0.545; s.b1 = 0.50;
      s.a0 = 0.55; s.a1 = 0;
      s.fadeIn = 0.07; s.fadeOut = 0.6;
      s.delay = rnd(0, 0.05);
      this.lit.spawn(s);
    }
    // Shock ring on the deck, one frame behind the flash.
    const ring = resetSpec(); ring.sunVis = sunVis;
    ring.x = _p.x; ring.y = _p.y - 0.05; ring.z = _p.z;
    ring.life = 0.28 + hold; ring.gravity = 0; ring.drag = 0;
    ring.size0 = 0.6 * k; ring.size1 = 5.5 * k;
    ring.tile = PT.RING; ring.soft = 0.9;
    ring.r0 = 2.4; ring.g0 = 1.9; ring.b0 = 1.3; ring.a0 = 0.5;
    ring.r1 = 0.8; ring.g1 = 0.5; ring.b1 = 0.25; ring.a1 = 0;
    ring.fadeIn = 0.05; ring.fadeOut = 0.75;
    this.add.spawn(ring);

    // --- debris and embers --------------------------------------------------
    const debris = Math.round(18 * k);
    for (let i = 0; i < debris; i++) {
      const s = resetSpec(); s.sunVis = sunVis;
      s.sunVis = sunVis;
      const a = Math.random() * Math.PI * 2;
      const el = rnd(0.05, 1.25);
      const sp = rnd(5, 20) * Math.sqrt(k);
      _v.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
      s.x = _p.x; s.y = _p.y; s.z = _p.z;
      s.vx = _v.x * sp; s.vy = _v.y * sp; s.vz = _v.z * sp;
      s.life = rnd(1.1, 2.4);
      s.drag = 0.35; s.gravity = -12.5;
      s.size0 = rnd(0.03, 0.14) * k; s.size1 = s.size0;
      s.tile = PT.CHIP; s.soft = 0.15;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-16, 16);
      s.r0 = 0.20; s.g0 = 0.185; s.b0 = 0.17;
      s.r1 = 0.20; s.g1 = 0.185; s.b1 = 0.17;
      s.a0 = 1; s.a1 = 1; s.fadeIn = 0.01; s.fadeOut = 0.15;
      this.lit.spawn(s);
    }
    const embers = Math.round(22 * k);
    for (let i = 0; i < embers; i++) {
      const s = resetSpec(); s.sunVis = sunVis;
      s.sunVis = sunVis;
      const a = Math.random() * Math.PI * 2;
      const el = rnd(-0.1, 1.2);
      const sp = rnd(4, 17) * Math.sqrt(k);
      _v.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
      s.x = _p.x; s.y = _p.y; s.z = _p.z;
      s.vx = _v.x * sp; s.vy = _v.y * sp; s.vz = _v.z * sp;
      s.life = rnd(0.5, 1.6);
      s.drag = 1.5; s.gravity = -10;
      s.size0 = rnd(0.012, 0.03); s.size1 = s.size0 * 0.6;
      s.tile = PT.EMBER; s.stretch = 0.004; s.soft = 0.06;
      s.r0 = 5.5; s.g0 = 2.8; s.b0 = 0.7; s.a0 = 1;
      s.r1 = 1.3; s.g1 = 0.22; s.b1 = 0.02; s.a1 = 0.6;
      s.fadeIn = 0.02; s.fadeOut = 0.45;
      this.add.spawn(s);
    }

    // --- lingering column and scorch ---------------------------------------
    const col = this.smoke.column(_p, {
      sunVis,
      rate: 10 * Math.min(2, k),
      duration: 7 + 3 * k,
      radius: 0.35 * k,
      rise: 1.5 + 0.5 * k,
      size0: 0.5 * k,
      size1: 3.4 * k,
      life: 4.0,
      alpha: 0.36,
      r0: 0.075, g0: 0.068, b0: 0.062,
      r1: 0.42, g1: 0.40, b1: 0.38,
    });
    if (hold > 0) this.smoke.prime(col, 2.4);

    if (this.decals && opts?.ground !== false) {
      const phys = this.ctx.physics;
      _v.set(0, -1, 0);
      const hit = phys?.raycast?.(_p, _v, R * 1.5, 1 | 2);
      if (hit) this.decals.add(hit.point, hit.normal, 'scorch', R * 0.85, 0.9);
    }

    this.fx?.screenShake?.(Math.min(1.2, 0.55 * k), 0.7);
    this._payload.pos.copy(_p);
    this._payload.radius = R;
    this.ctx.bus?.emit?.('fx:explosion', this._payload);
    this.ctx.audio?.playAt?.('explosion', _p, { gain: 1, radius: R });
  }
}
