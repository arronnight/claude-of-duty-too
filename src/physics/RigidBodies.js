import * as THREE from 'three';
import { Sweeper } from './Sweeper.js';

/**
 * Fixed pool of small dynamic bodies: shell casings, debris chunks and dropped
 * weapons. A magazine dump fires thirty casings a second, so nothing here may
 * allocate — bodies are constructed once, recycled oldest-first when the cap is
 * reached, and put to sleep the moment they stop moving so a hundred settled
 * casings cost nothing.
 *
 * Spheres translate by continuous sweep (a 1 cm casing at 8 m/s would tunnel
 * through a floor otherwise). Boxes sweep their inradius for translation and
 * then resolve their eight corners as point contacts, which is what makes a
 * dropped rifle tumble once and lie flat instead of spinning forever.
 */

const GRAVITY = -18.5;
const SLEEP_LINEAR = 0.09;
// Sleep on surface speed, not raw spin: a 3 cm casing rolling at 1 m/s turns at
// 33 rad/s, so a fixed rad/s threshold would keep small debris awake forever.
const SLEEP_SURFACE = 0.06;
const SLEEP_TIME = 0.35;
const CONTACT_MEMORY = 0.2;
const CORNER_SKIN = 0.018;
const BODY_SKIN = 0.0008;

const _r = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _t = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _corner = new THREE.Vector3();
const _corr = new THREE.Vector3();
const CORNER_SIGNS = [
  -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1,
  -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1,
];

export class RigidBodyPool {
  constructor(physics, max = 120) {
    this.phys = physics;
    this.sweeper = new Sweeper(physics.bvh, 512, BODY_SKIN);
    this.max = max;
    this.bodies = [];
    this.active = [];
    this.free = [];
    this.serial = 0;
    this.awakeCount = 0;
    for (let i = 0; i < max; i++) {
      const b = makeBody(i);
      this.bodies.push(b);
      this.free.push(b);
    }
  }

  acquire(opts) {
    let b = this.free.pop();
    if (!b) {
      // Recycle the oldest live body rather than growing the pool.
      let oldest = this.active[0];
      for (let i = 1; i < this.active.length; i++) {
        if (this.active[i].serial < oldest.serial) oldest = this.active[i];
      }
      this.release(oldest);
      b = this.free.pop();
    }
    b.active = true;
    b.sleeping = false;
    b.serial = ++this.serial;
    b.age = 0;
    b.sleepTimer = 0;
    b.type = opts?.type === 'box' ? 1 : 0;
    b.radius = opts?.radius ?? 0.05;
    if (opts?.halfExtents) b.half.copy(opts.halfExtents);
    else b.half.setScalar(b.radius);
    if (b.type === 1) b.radius = Math.min(b.half.x, b.half.y, b.half.z);
    b.spinRadius = Math.max(0.015, b.type === 1 ? Math.max(b.half.x, b.half.y, b.half.z) : b.radius);
    const mass = opts?.mass ?? 0.05;
    b.mass = mass;
    b.invMass = mass > 0 ? 1 / mass : 0;
    const ext = b.type === 1
      ? b.half.x * b.half.x + b.half.y * b.half.y + b.half.z * b.half.z
      : b.radius * b.radius;
    b.invInertia = 1 / Math.max(1e-6, mass * ext * 0.5);
    b.restitution = opts?.restitution ?? 0.28;
    b.friction = opts?.friction ?? 0.55;
    b.linearDamping = opts?.linearDamping ?? 0.08;
    b.angularDamping = opts?.angularDamping ?? 0.6;
    b.gravityScale = opts?.gravityScale ?? 1;
    b.life = opts?.life ?? 0;
    b.mask = opts?.mask ?? this.phys.defaultMask;
    b.onImpact = opts?.onImpact ?? null;
    b.userData = opts?.userData ?? null;
    b.contacted = false;
    b.sinceContact = 99;
    b.impactSpeed = 0;
    if (opts?.position) b.position.copy(opts.position);
    else b.position.set(0, 0, 0);
    if (opts?.quaternion) b.quaternion.copy(opts.quaternion);
    else b.quaternion.set(0, 0, 0, 1);
    if (opts?.velocity) b.velocity.copy(opts.velocity);
    else b.velocity.set(0, 0, 0);
    if (opts?.angularVelocity) b.angularVelocity.copy(opts.angularVelocity);
    else b.angularVelocity.set(0, 0, 0);
    this.active.push(b);
    return b;
  }

  release(body) {
    if (!body || !body.active) return;
    body.active = false;
    body.onImpact = null;
    body.userData = null;
    const i = this.active.indexOf(body);
    if (i >= 0) {
      this.active[i] = this.active[this.active.length - 1];
      this.active.pop();
    }
    this.free.push(body);
  }

  clear() {
    for (let i = this.active.length - 1; i >= 0; i--) this.release(this.active[i]);
  }

  step(dt) {
    const list = this.active;
    let awake = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.age += dt;
      if (b.life > 0 && b.age > b.life) { this.release(b); continue; }
      if (b.sleeping) continue;
      awake++;
      b.contacted = false;
      b.impactSpeed = 0;
      if (b.type === 1) this._stepBox(b, dt);
      else this._stepSphere(b, dt);
      if (!this.phys.bvh.triCount) this._groundPlaneFallback(b);

      // A resting body only re-touches every few ticks (it falls a fraction of
      // a millimetre per step), so contact has to persist or it never sleeps.
      b.sinceContact = b.contacted ? 0 : b.sinceContact + dt;
      const lin = b.velocity.lengthSq();
      const surf = b.angularVelocity.length() * b.spinRadius;
      if (b.sinceContact < CONTACT_MEMORY && lin < SLEEP_LINEAR * SLEEP_LINEAR && surf < SLEEP_SURFACE) {
        b.sleepTimer += dt;
        if (b.sleepTimer > SLEEP_TIME) {
          b.sleeping = true;
          b.velocity.set(0, 0, 0);
          b.angularVelocity.set(0, 0, 0);
        }
      } else {
        b.sleepTimer = 0;
      }
      if (b.contacted && b.impactSpeed > 0.6 && b.onImpact) {
        b.onImpact(b, b.impactSpeed);
      }
    }
    this.awakeCount = awake;
  }

  /** Keeps debris out of the void when the level has no collision yet. */
  _groundPlaneFallback(b) {
    const rest = this.phys.groundY + (b.type === 1 ? b.half.y : b.radius);
    if (b.position.y >= rest) return;
    b.position.y = rest;
    b.contacted = true;
    if (b.velocity.y < 0) {
      const speed = -b.velocity.y;
      b.velocity.y = speed < 0.8 ? 0 : speed * b.restitution;
      b.velocity.x *= 1 - b.friction * 0.5;
      b.velocity.z *= 1 - b.friction * 0.5;
      b.angularVelocity.multiplyScalar(1 - Math.min(0.6, b.friction * 0.18));
    }
  }

  _integrateRotation(b, dt) {
    const w = b.angularVelocity;
    const damp = 1 - Math.min(1, b.angularDamping * dt);
    w.multiplyScalar(damp);
    if (w.lengthSq() < 1e-8) return;
    _q.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0);
    _q.multiply(b.quaternion);
    b.quaternion.x += _q.x; b.quaternion.y += _q.y;
    b.quaternion.z += _q.z; b.quaternion.w += _q.w;
    b.quaternion.normalize();
  }

  _stepSphere(b, dt) {
    const sw = this.sweeper;
    b.velocity.y += GRAVITY * b.gravityScale * dt;
    b.velocity.multiplyScalar(1 - Math.min(1, b.linearDamping * dt));
    this._integrateRotation(b, dt);

    let remaining = dt;
    for (let it = 0; it < 3 && remaining > 1e-6; it++) {
      const dx = b.velocity.x * remaining, dy = b.velocity.y * remaining, dz = b.velocity.z * remaining;
      if (dx * dx + dy * dy + dz * dz < 1e-12) break;
      const p = b.position;
      const hit = sw.sweepCapsule(p.x, p.y, p.z, p.x, p.y, p.z, b.radius, dx, dy, dz, b.mask, sw.result);
      if (!hit) { p.x += dx; p.y += dy; p.z += dz; break; }
      const t = sw.result.t;
      p.x += dx * t; p.y += dy * t; p.z += dz * t;
      remaining *= 1 - t;
      const n = sw.result.normal;
      const vn = b.velocity.dot(n);
      b.contacted = true;
      if (vn < 0) {
        const speed = -vn;
        if (speed > b.impactSpeed) b.impactSpeed = speed;
        _t.copy(b.velocity).addScaledVector(n, -vn);
        const tl = _t.length();
        const e = speed < 0.8 ? 0 : b.restitution;
        b.velocity.addScaledVector(n, -vn * (1 + e));
        if (tl > 1e-5) {
          const drop = Math.min(tl, b.friction * speed * (1 + e));
          b.velocity.addScaledVector(_t, -drop / tl);
          // Tangential impulse at the surface spins the sphere up.
          _cross.crossVectors(n, _t).multiplyScalar(-1.6 * drop / (tl * Math.max(0.01, b.radius)));
          b.angularVelocity.add(_cross).clampLength(0, 40);
        }
      }
      // Rolling resistance: without it a spun-up casing keeps rotating for
      // seconds after it has stopped translating and never sleeps.
      b.angularVelocity.multiplyScalar(1 - Math.min(0.6, b.friction * 0.18));
      // Nudge clear of the skin so the next sweep does not start in contact.
      b.position.addScaledVector(n, BODY_SKIN * 0.5);
    }
  }

  _stepBox(b, dt) {
    const sw = this.sweeper;
    b.velocity.y += GRAVITY * b.gravityScale * dt;
    b.velocity.multiplyScalar(1 - Math.min(1, b.linearDamping * dt));
    this._integrateRotation(b, dt);

    let remaining = dt;
    for (let it = 0; it < 2 && remaining > 1e-6; it++) {
      const dx = b.velocity.x * remaining, dy = b.velocity.y * remaining, dz = b.velocity.z * remaining;
      if (dx * dx + dy * dy + dz * dz < 1e-12) break;
      const p = b.position;
      const hit = sw.sweepCapsule(p.x, p.y, p.z, p.x, p.y, p.z, b.radius, dx, dy, dz, b.mask, sw.result);
      if (!hit) { p.x += dx; p.y += dy; p.z += dz; break; }
      const t = sw.result.t;
      p.x += dx * t; p.y += dy * t; p.z += dz * t;
      remaining *= 1 - t;
      const n = sw.result.normal;
      const vn = b.velocity.dot(n);
      b.contacted = true;
      if (vn < 0) {
        if (-vn > b.impactSpeed) b.impactSpeed = -vn;
        const e = -vn < 0.8 ? 0 : b.restitution;
        b.velocity.addScaledVector(n, -vn * (1 + e));
      }
      b.position.addScaledVector(n, BODY_SKIN * 0.5);
    }
    this._solveCorners(b);
  }

  _solveCorners(b) {
    const sw = this.sweeper;
    _corr.set(0, 0, 0);
    let contacts = 0;
    for (let c = 0; c < 8; c++) {
      const s = c * 3;
      _r.set(CORNER_SIGNS[s] * b.half.x, CORNER_SIGNS[s + 1] * b.half.y, CORNER_SIGNS[s + 2] * b.half.z);
      _r.applyQuaternion(b.quaternion);
      _corner.copy(b.position).add(_r);
      const cp = sw.closestPoint(_corner.x, _corner.y, _corner.z, CORNER_SKIN + 0.02, b.mask);
      if (!cp.hit || cp.distance >= CORNER_SKIN) continue;
      contacts++;
      const n = cp.normal;
      const depth = CORNER_SKIN - cp.distance;
      _corr.addScaledVector(n, depth);
      _vp.copy(b.velocity).add(_cross.crossVectors(b.angularVelocity, _r));
      const vn = _vp.dot(n);
      if (vn >= 0) continue;
      if (-vn > b.impactSpeed) b.impactSpeed = -vn;
      b.contacted = true;
      _cross.crossVectors(_r, n);
      const denom = b.invMass + b.invInertia * _cross.lengthSq();
      const e = -vn < 1 ? 0 : b.restitution;
      const j = (-(1 + e) * vn) / denom;
      b.velocity.addScaledVector(n, j * b.invMass);
      b.angularVelocity.addScaledVector(_cross, j * b.invInertia);
      _t.copy(_vp).addScaledVector(n, -vn);
      const tl = _t.length();
      if (tl > 1e-4) {
        _t.multiplyScalar(1 / tl);
        _cross.crossVectors(_r, _t);
        const denomT = b.invMass + b.invInertia * _cross.lengthSq();
        const jt = Math.max(-b.friction * j, Math.min(b.friction * j, -tl / denomT));
        b.velocity.addScaledVector(_t, jt * b.invMass);
        b.angularVelocity.addScaledVector(_cross, jt * b.invInertia);
      }
    }
    if (contacts) {
      b.position.addScaledVector(_corr, 0.45 / contacts);
      b.angularVelocity.multiplyScalar(1 - Math.min(0.5, b.friction * 0.15));
      b.angularVelocity.clampLength(0, 30);
    }
  }
}

function makeBody(id) {
  return {
    id,
    serial: 0,
    active: false,
    sleeping: false,
    type: 0,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    half: new THREE.Vector3(0.05, 0.05, 0.05),
    radius: 0.05,
    mass: 0.05,
    invMass: 20,
    invInertia: 1,
    restitution: 0.3,
    friction: 0.5,
    linearDamping: 0.08,
    angularDamping: 0.6,
    gravityScale: 1,
    life: 0,
    age: 0,
    sleepTimer: 0,
    mask: 1,
    spinRadius: 0.05,
    contacted: false,
    sinceContact: 99,
    impactSpeed: 0,
    onImpact: null,
    userData: null,
  };
}
