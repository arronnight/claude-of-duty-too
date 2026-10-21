import * as THREE from 'three';
import { Sweeper } from './Sweeper.js';

/**
 * Seven-node Verlet ragdoll (pelvis, spine, head, two arms, two legs).
 *
 * Verlet with hard distance constraints is used instead of a full articulated
 * solver because it cannot explode: positions are projected, never integrated
 * from accumulated impulses, so a body wedged into a doorway settles instead of
 * vibrating. Limb angle limits are expressed as min/max range constraints
 * between non-adjacent nodes, which keeps knees and elbows from folding through
 * the torso without any rotational maths. Collision is a per-node sphere push
 * out of the BVH plus tangential friction folded into the previous position, so
 * a corpse comes to rest on a slope and stays there.
 */

const BONE_NAMES = ['pelvis', 'spine', 'head', 'armL', 'armR', 'legL', 'legR'];
const OFFSETS = [
  [0, 0, 0], [0, 0.42, 0], [0, 0.74, 0],
  [-0.32, 0.36, 0], [0.32, 0.36, 0],
  [-0.13, -0.82, 0], [0.13, -0.82, 0],
];
const RADII = [0.16, 0.17, 0.13, 0.09, 0.09, 0.10, 0.10];
// [a, b, stiffness, minScale, maxScale] — minScale < 1 marks a range limiter.
const LINKS = [
  [0, 1, 1, 1, 1], [1, 2, 1, 1, 1],
  [1, 3, 0.9, 1, 1], [1, 4, 0.9, 1, 1],
  [0, 5, 1, 1, 1], [0, 6, 1, 1, 1],
  [0, 2, 0.5, 0.72, 1.06], [3, 4, 0.35, 0.55, 1.2],
  [5, 6, 0.4, 0.45, 1.25], [0, 3, 0.4, 0.7, 1.1],
  [0, 4, 0.4, 0.7, 1.1], [1, 5, 0.4, 0.7, 1.12], [1, 6, 0.4, 0.7, 1.12],
];
const GRAVITY = -17;
const ITERATIONS = 7;
const SLEEP_MOVE = 0.0016;
const SLEEP_TIME = 0.5;
const UP = new THREE.Vector3(0, 1, 0);

const _d = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class RagdollPool {
  constructor(physics, max = 6) {
    this.phys = physics;
    this.sweeper = new Sweeper(physics.bvh, 512);
    this.max = max;
    this.pool = [];
    this.active = [];
    this.serial = 0;
    for (let i = 0; i < max; i++) this.pool.push(makeRagdoll(i, this));
  }

  spawn(boneTransforms, impulse) {
    let rd = this.pool.find((r) => !r.active);
    if (!rd) {
      let oldest = this.active[0];
      for (let i = 1; i < this.active.length; i++) {
        if (this.active[i].serial < oldest.serial) oldest = this.active[i];
      }
      this.release(oldest);
      rd = this.pool.find((r) => !r.active);
    }
    rd.active = true;
    rd.sleeping = false;
    rd.age = 0;
    rd.sleepTimer = 0;
    rd.serial = ++this.serial;
    rd.mask = this.phys.defaultMask;

    readBonePositions(boneTransforms, rd.particles);

    const vx = impulse?.x || 0, vy = impulse?.y || 0, vz = impulse?.z || 0;
    const dt = 1 / 120;
    for (let i = 0; i < rd.particles.length; i++) {
      const p = rd.particles[i];
      // Verlet velocity is the position delta, so seed prev to inject the hit.
      const jitter = i === 0 ? 1 : 0.75 + (i % 3) * 0.16;
      p.prev.set(
        p.position.x - vx * dt * jitter,
        p.position.y - vy * dt * jitter,
        p.position.z - vz * dt * jitter,
      );
    }
    for (let i = 0; i < LINKS.length; i++) {
      const a = rd.particles[LINKS[i][0]].position;
      const b = rd.particles[LINKS[i][1]].position;
      rd.rest[i] = Math.max(0.04, a.distanceTo(b));
    }
    this.updateBones(rd);
    this.active.push(rd);
    return rd;
  }

  release(rd) {
    if (!rd || !rd.active) return;
    rd.active = false;
    const i = this.active.indexOf(rd);
    if (i >= 0) {
      this.active[i] = this.active[this.active.length - 1];
      this.active.pop();
    }
  }

  clear() {
    for (let i = this.active.length - 1; i >= 0; i--) this.release(this.active[i]);
  }

  step(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const rd = this.active[i];
      rd.age += dt;
      if (rd.sleeping) continue;
      this._integrate(rd, dt);
      for (let it = 0; it < ITERATIONS; it++) this._constrain(rd);
      const moved = this._collide(rd);
      this._constrain(rd);
      this.updateBones(rd);
      if (moved < SLEEP_MOVE) {
        rd.sleepTimer += dt;
        if (rd.sleepTimer > SLEEP_TIME) {
          rd.sleeping = true;
          for (const p of rd.particles) p.prev.copy(p.position);
        }
      } else {
        rd.sleepTimer = 0;
      }
    }
  }

  _integrate(rd, dt) {
    const damp = 0.994;
    const g = GRAVITY * dt * dt;
    for (const p of rd.particles) {
      const vx = (p.position.x - p.prev.x) * damp;
      const vy = (p.position.y - p.prev.y) * damp;
      const vz = (p.position.z - p.prev.z) * damp;
      p.prev.copy(p.position);
      p.position.x += vx;
      p.position.y += vy + g;
      p.position.z += vz;
    }
  }

  _constrain(rd) {
    const ps = rd.particles;
    for (let i = 0; i < LINKS.length; i++) {
      const l = LINKS[i];
      const a = ps[l[0]].position, b = ps[l[1]].position;
      _d.subVectors(b, a);
      const d = _d.length();
      if (d < 1e-6) continue;
      const rest = rd.rest[i];
      let target = rest;
      if (l[3] < 1) {
        const lo = rest * l[3], hi = rest * l[4];
        if (d >= lo && d <= hi) continue;
        target = d < lo ? lo : hi;
      }
      const diff = ((d - target) / d) * 0.5 * l[2];
      a.x += _d.x * diff; a.y += _d.y * diff; a.z += _d.z * diff;
      b.x -= _d.x * diff; b.y -= _d.y * diff; b.z -= _d.z * diff;
    }
  }

  _collide(rd) {
    const sw = this.sweeper;
    const hasWorld = this.phys.bvh.triCount > 0;
    const groundY = this.phys.groundY;
    let moved = 0;
    for (let i = 0; i < rd.particles.length; i++) {
      const p = rd.particles[i];
      const r = RADII[i];
      if (hasWorld) {
        const cp = sw.closestPoint(p.position.x, p.position.y, p.position.z, r + 0.12, rd.mask);
        if (cp.hit && cp.distance < r) {
          const depth = r - cp.distance;
          p.position.addScaledVector(cp.normal, depth);
          applyContactFriction(p, cp.normal);
        }
      }
      if (p.position.y - r < groundY && !hasWorld) {
        p.position.y = groundY + r;
        applyContactFriction(p, UP);
      }
      moved += Math.abs(p.position.x - p.prev.x) + Math.abs(p.position.y - p.prev.y) + Math.abs(p.position.z - p.prev.z);
    }
    return moved / rd.particles.length;
  }

  /** Derive a usable bone orientation by aiming each node at its child. */
  updateBones(rd) {
    const ps = rd.particles;
    for (let i = 0; i < BONE_NAMES.length; i++) {
      const bone = rd.bones[i];
      bone.position.copy(ps[i].position);
      let from = i, to = i;
      switch (i) {
        case 0: from = 0; to = 1; break;
        case 1: from = 1; to = 2; break;
        case 2: from = 1; to = 2; break;
        case 3: from = 1; to = 3; break;
        case 4: from = 1; to = 4; break;
        case 5: from = 0; to = 5; break;
        default: from = 0; to = 6; break;
      }
      _dir.subVectors(ps[to].position, ps[from].position);
      if (_dir.lengthSq() < 1e-8) _dir.set(0, 1, 0);
      _dir.normalize();
      bone.quaternion.setFromUnitVectors(UP, _dir);
    }
  }
}

function applyContactFriction(p, n) {
  _vel.subVectors(p.position, p.prev);
  const vn = _vel.dot(n);
  _vel.addScaledVector(n, -vn);
  _vel.multiplyScalar(0.55);
  if (vn < 0) _vel.addScaledVector(n, -vn * 0.08);
  p.prev.copy(p.position).sub(_vel);
}

function makeRagdoll(id, pool) {
  const particles = [];
  const bones = [];
  for (let i = 0; i < BONE_NAMES.length; i++) {
    particles.push({ position: new THREE.Vector3(), prev: new THREE.Vector3(), radius: RADII[i] });
    bones.push({ name: BONE_NAMES[i], position: new THREE.Vector3(), quaternion: new THREE.Quaternion() });
  }
  const rd = {
    id,
    serial: 0,
    active: false,
    sleeping: false,
    age: 0,
    sleepTimer: 0,
    mask: 1,
    particles,
    bones,
    rest: new Float32Array(LINKS.length),
    release() { pool.release(rd); },
  };
  return rd;
}

/** Accept an array, a name-keyed map, Object3Ds, Matrix4s or bare Vector3s. */
function readBonePositions(src, particles) {
  const root = new THREE.Vector3();
  let rootFound = false;
  const tmp = new THREE.Vector3();
  const got = new Array(BONE_NAMES.length).fill(false);

  const extract = (v, out) => {
    if (!v) return false;
    if (v.isVector3) { out.copy(v); return true; }
    if (v.isObject3D) { v.getWorldPosition(out); return true; }
    if (v.isMatrix4) { out.setFromMatrixPosition(v); return true; }
    if (v.position) { out.copy(v.position); return true; }
    if (typeof v.x === 'number') { out.set(v.x, v.y, v.z); return true; }
    return false;
  };

  if (Array.isArray(src)) {
    for (let i = 0; i < Math.min(src.length, BONE_NAMES.length); i++) {
      const entry = src[i];
      const named = entry?.name ? BONE_NAMES.indexOf(entry.name) : -1;
      const slot = named >= 0 ? named : i;
      if (extract(entry, tmp)) { particles[slot].position.copy(tmp); got[slot] = true; }
    }
  } else if (src && typeof src === 'object') {
    for (let i = 0; i < BONE_NAMES.length; i++) {
      if (extract(src[BONE_NAMES[i]], tmp)) { particles[i].position.copy(tmp); got[i] = true; }
    }
    if (!got[0] && extract(src, tmp)) { particles[0].position.copy(tmp); got[0] = true; }
  }

  if (got[0]) { root.copy(particles[0].position); rootFound = true; }
  else {
    for (let i = 0; i < BONE_NAMES.length; i++) {
      if (got[i]) { root.copy(particles[i].position).sub(tmp.set(...OFFSETS[i])); rootFound = true; break; }
    }
  }
  if (!rootFound) root.set(0, 1, 0);

  for (let i = 0; i < BONE_NAMES.length; i++) {
    if (got[i]) continue;
    particles[i].position.set(root.x + OFFSETS[i][0], root.y + OFFSETS[i][1], root.z + OFFSETS[i][2]);
  }
}
