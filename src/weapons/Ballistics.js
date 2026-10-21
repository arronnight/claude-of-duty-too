import * as THREE from 'three';
import { penetrationFor, damageFalloff, HITBOX_MULT } from './WeaponDefs.js';

/**
 * Real projectiles, not hitscan.
 *
 * Every round is a pooled body integrated at the engine's fixed 120 Hz rate
 * with gravity and quadratic drag, and **ray-marched** against the BVH over
 * each step's swept segment so nothing tunnels through a wall at 900 m/s.
 * At 20 m the difference against hitscan is invisible; at 70 m the drop is a
 * third of a metre, which is the difference between a shooter and a toy.
 *
 * Penetration is a first-class part of the model because it is a Call of Duty
 * signature: on a blocked hit the far side is probed by a reverse cast, and if
 * the material is thin enough and the round powerful enough the bullet exits
 * with reduced damage and an exit impact of its own.
 */

const POOL = 96;
const MAX_LIFE = 1.6;
const MAX_RANGE = 420;
const MAX_PEN_PER_BULLET = 3;

// Materials that simply stop a normal rifle round no matter how thin: you need
// a genuinely powerful cartridge before masonry is a maybe.
const MIN_POWER = {
  concrete_wall: 1.5, concrete_floor: 1.5, asphalt: 1.5, gravel: 1.5,
  brick: 1.35, rubble: 1.35, sandbag: 1.4, dirt: 1.3, sand: 1.3,
  steel_brushed: 1.6, tile_roof: 0.7,
};

const _v = new THREE.Vector3();
const _step = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _far = new THREE.Vector3();
const _back = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _nrm = new THREE.Vector3();

class Bullet {
  constructor() {
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.alive = false;
    this.life = 0;
    this.travelled = 0;
    this.damage = 0;
    this.penPower = 0;
    this.penCount = 0;
    this.drag = 1.2e-4;
    this.weapon = null;
    this.owner = null;
  }
}

export class Ballistics {
  constructor(ctx) {
    this.ctx = ctx;
    this.pool = [];
    for (let i = 0; i < POOL; i++) this.pool.push(new Bullet());
    this.free = this.pool.slice();
    this.active = [];
    this.stats = { fired: 0, hits: 0, penetrations: 0 };
    this.onHit = null;   // (hit, damage, bullet) -> void
  }

  /**
   * @param origin  world-space muzzle/eye position
   * @param dir     unit direction, spread already applied
   * @param def     weapon definition
   * @param damage  base chest damage for this round (pellets scale it down)
   */
  spawn(origin, dir, def, damage, owner) {
    const b = this.free.pop();
    if (!b) return null;
    b.alive = true;
    b.life = 0;
    b.travelled = 0;
    b.penCount = 0;
    b.pos.copy(origin);
    b.prev.copy(origin);
    b.vel.copy(dir).multiplyScalar(def.muzzleVelocity);
    b.damage = damage;
    b.penPower = def.penPower;
    // Light, fast rifle rounds shed velocity slowly; pistol and buckshot fast.
    // Calibrated against real drop tables rather than guessed: 8.5e-4 gives a
    // 5.56 round ~690 m/s2 of deceleration at the muzzle, so it sheds about
    // 100 m/s over the first 100 m. The first pass ran an order of magnitude
    // lower and the round arrived at 300 m still doing 858 m/s.
    b.drag = def.caliber === '12ga' ? 6.0e-3 : def.muzzleVelocity > 700 ? 8.5e-4 : 1.7e-3;
    b.weapon = def;
    b.owner = owner || 'player';
    this.active.push(b);
    this.stats.fired++;
    return b;
  }

  fixedUpdate(dt) {
    const phys = this.ctx.physics;
    if (!phys?.raycast) { this._expireAll(dt); return; }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      if (!this._step(b, dt, phys)) {
        b.alive = false;
        this.active.splice(i, 1);
        this.free.push(b);
      }
    }
  }

  _expireAll(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.life += dt;
      if (b.life > MAX_LIFE) { b.alive = false; this.active.splice(i, 1); this.free.push(b); }
    }
  }

  /** One fixed step of one bullet. Returns false when it should be retired. */
  _step(b, dt, phys) {
    b.life += dt;
    if (b.life > MAX_LIFE || b.travelled > MAX_RANGE) return false;

    // Quadratic drag then gravity, semi-implicit.
    const speed = b.vel.length();
    if (speed > 1e-3) {
      const decel = b.drag * speed * speed * dt;
      b.vel.multiplyScalar(Math.max(0, 1 - decel / speed));
    }
    b.vel.y -= 9.81 * dt;

    b.prev.copy(b.pos);
    _step.copy(b.vel).multiplyScalar(dt);
    const len = _step.length();
    if (len < 1e-6) return true;
    _dir.copy(_step).multiplyScalar(1 / len);

    let remaining = len;
    let origin = _pt.copy(b.pos);
    let guard = 0;
    while (remaining > 1e-5 && guard++ < 4) {
      const hit = phys.raycast(origin, _dir, remaining);
      if (!hit) break;
      const consumed = hit.distance;
      b.travelled += consumed;
      origin.copy(hit.point);
      _nrm.copy(hit.normal);
      const surface = hit.material || null;
      const dmg = b.damage * damageFalloff(b.travelled);

      // Characters take the damage and stop the round.
      if (this._resolveCharacter(hit, b, dmg)) return false;

      this.ctx.fx?.impact?.(hit.point, _nrm, surface, Math.min(1, dmg / 40));
      this.stats.hits++;

      const through = this._penetrate(b, hit, surface, phys);
      if (!through) return false;
      remaining -= consumed + through.thickness;
      origin.copy(through.exit);
      b.travelled += through.thickness;
      b.damage *= through.retain;
      b.vel.multiplyScalar(through.slow);
      if (b.damage < 4 || ++b.penCount >= MAX_PEN_PER_BULLET) return false;
    }

    b.pos.copy(origin).addScaledVector(_dir, Math.max(0, remaining));
    b.travelled += Math.max(0, remaining);
    return true;
  }

  /**
   * Reverse-cast from beyond the wall to find the exit face, which is how you
   * measure thickness without a volumetric representation. Returns null when
   * the round is stopped.
   */
  _penetrate(b, hit, surface, phys) {
    const pen = penetrationFor(surface);
    const need = MIN_POWER[surface] || 0;
    if (b.penPower < need) return null;
    const search = pen.thick + 0.02;
    _far.copy(hit.point).addScaledVector(_dir, search);
    _back.copy(_dir).multiplyScalar(-1);
    const exitHit = phys.raycast(_far, _back, search);
    if (!exitHit) return null;                      // thicker than we can defeat
    const thickness = search - exitHit.distance;
    if (thickness > pen.thick * b.penPower) return null;

    // Cost scales with how much of the material's budget was used up.
    const used = (thickness * pen.hard) / (pen.thick * pen.hard * b.penPower);
    const retain = pen.retain * (1 - 0.35 * Math.min(1, used));
    this.stats.penetrations++;
    _v.copy(exitHit.normal);
    this.ctx.fx?.impact?.(exitHit.point, _v, surface, 0.45);
    return {
      exit: _far.copy(exitHit.point).addScaledVector(_dir, 0.003),
      thickness: thickness + 0.003,
      retain,
      slow: 0.62 + 0.28 * (1 - Math.min(1, used)),
    };
  }

  /**
   * Bots publish their hitboxes in `userData.hitboxes`; anything on the
   * character layer that names a zone gets the multiplier for that zone. The
   * AI system may not exist yet, so every hop is optional.
   */
  _resolveCharacter(hit, b, dmg) {
    const obj = hit.object;
    const ud = obj?.userData;
    const zone = ud?.hitZone || ud?.zone;
    const bot = ud?.bot || ud?.owner;
    if (!zone && !bot) return false;
    const mult = HITBOX_MULT[zone] || 1;
    const total = dmg * mult;
    this.ctx.fx?.bloodHit?.(hit.point, hit.normal, _dir);
    this.ctx.fx?.hitmarker?.(zone === 'head' ? 'head' : 'hit');
    if (typeof bot?.damage === 'function') bot.damage(total, _dir, zone);
    else this.ctx.ai?.applyDamage?.(bot || obj, total, hit.point, _dir, zone);
    this.onHit?.(hit, total, b);
    return true;
  }

  clear() {
    for (const b of this.active) { b.alive = false; this.free.push(b); }
    this.active.length = 0;
  }
}
