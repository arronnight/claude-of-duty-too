import * as THREE from 'three';
import { BVH } from './BVH.js';
import { StaticGeometry, LAYER } from './StaticGeometry.js';
import { Sweeper } from './Sweeper.js';
import { CharacterController, STANCE_HEIGHT } from './CharacterController.js';
import { RigidBodyPool } from './RigidBodies.js';
import { RagdollPool } from './Ragdoll.js';
import { DebugDraw } from './DebugDraw.js';

/**
 * Collision, character movement and rigid-body dynamics.
 *
 * All static level geometry is merged into a single triangle soup and indexed
 * by one binned-SAH BVH, so a bullet raycast, a grenade sphere cast, a footstep
 * probe and a shell casing all hit the same acceleration structure and the same
 * per-triangle surface key. Dynamic state (character capsules, rigid bodies,
 * ragdolls) is pooled and stepped at the engine's fixed 120 Hz rate; nothing in
 * `step()` allocates once the pools are warm.
 *
 * Raycast results come from a ring of preallocated hit records rather than a
 * fresh object per call — copy anything you need to keep beyond the next ~96
 * queries.
 */

const HIT_RING = 96;
const ALL_LAYERS = LAYER.WORLD | LAYER.PROPS | LAYER.CHARACTERS | LAYER.DEBRIS;

const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();

export class PhysicsSystem {
  constructor() {
    this.statics = new StaticGeometry();
    this.bvh = new BVH();
    this.sweeper = new Sweeper(this.bvh, 2048);
    this.character = new CharacterController(this);
    this.bodies = new RigidBodyPool(this, 120);
    this.ragdolls = new RagdollPool(this, 6);
    this.capsules = [];
    this._loose = new WeakMap();
    this.groundY = 0;
    this.defaultMask = LAYER.WORLD | LAYER.PROPS;
    this._dirty = false;
    this._rebuildTimer = 0;
    this._fallbackIds = [];
    this._hits = [];
    this._hitIdx = 0;
    for (let i = 0; i < HIT_RING; i++) {
      this._hits.push({
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 1, 0),
        faceNormal: new THREE.Vector3(0, 1, 0),
        distance: 0,
        object: null,
        material: null,
        triangle: -1,
        layer: 1,
      });
    }
    this.stats = { triangles: 0, nodes: 0, buildMs: 0, rays: 0, bodies: 0, ragdolls: 0, depth: 0 };
  }

  async init(ctx) {
    this.ctx = ctx;
    this.debugDraw = new DebugDraw(this);

    ctx.physics = {
      LAYER,
      stanceHeights: STANCE_HEIGHT,
      stats: this.stats,

      addStatic: (source, transform, opts) => {
        // The owning system has taken over; drop anything the fallback adopted.
        if (this._fallbackIds.length) {
          for (const fid of this._fallbackIds) this.statics.remove(fid);
          this._fallbackIds.length = 0;
          this._dirty = true;
        }
        const id = this.statics.add(source, transform, opts);
        if (id > 0) this._dirty = true;
        return id;
      },
      removeStatic: (id) => {
        if (this.statics.remove(id)) this._dirty = true;
      },
      buildStaticBVH: () => this.buildStaticBVH(),

      raycast: (origin, dir, maxDist = 1000, mask = ALL_LAYERS) => this.raycast(origin, dir, maxDist, mask),
      sphereCast: (origin, dir, radius, maxDist = 1000, mask = ALL_LAYERS) =>
        this.sphereCast(origin, dir, radius, maxDist, mask),

      createCapsule: (position, radius, height) => this.createCapsule(position, radius, height),
      destroyCapsule: (cap) => this.destroyCapsule(cap),
      moveCharacter: (capsule, velocity, dt, mask) => this.moveCharacter(capsule, velocity, dt, mask),
      setStance: (capsule, stance, mask) => this.character.setStance(capsule, stance, mask),
      canStand: (capsule, height, mask) =>
        this.character.canResize(capsule, height ?? STANCE_HEIGHT.stand, mask),
      setCapsuleHeight: (capsule, height, mask) => {
        if (height > capsule.height && !this.character.canResize(capsule, height, mask)) return false;
        capsule.height = height;
        this.character.refresh(capsule);
        return true;
      },

      addRigidBody: (opts) => this.bodies.acquire(opts),
      removeRigidBody: (body) => this.bodies.release(body),
      clearRigidBodies: () => this.bodies.clear(),
      activeBodies: this.bodies.active,

      spawnRagdoll: (boneTransforms, impulse) => this.ragdolls.spawn(boneTransforms, impulse),
      clearRagdolls: () => this.ragdolls.clear(),
      activeRagdolls: this.ragdolls.active,

      setDebugDraw: (v) => this.debugDraw.setEnabled(v, this.ctx.scene),
      step: (dt) => this.step(dt),
    };

    // Level and props register colliders during their own init; build once the
    // whole chain has published rather than per registration.
    ctx.bus.on('engine:ready', () => {
      this._adoptSceneFallback();
      if (this._dirty) this.buildStaticBVH();
    });
  }

  /**
   * If nothing registered a collider by the time the engine is up, adopt the
   * level and prop roots wholesale. A world you can walk through is a far
   * worse failure than a slightly over-detailed BVH, and this keeps the game
   * playable while the owning systems are still being written. Vegetation is
   * deliberately excluded — nobody should collide with grass.
   */
  _adoptSceneFallback() {
    if (this.statics.records.size > 0) return;
    const ctx = this.ctx;
    let adopted = 0;
    for (const root of [ctx.level?.root, ctx.props?.root]) {
      if (!root || !root.isObject3D) continue;
      const id = this.statics.add(root);
      if (id > 0) { this._fallbackIds.push(id); adopted++; this._dirty = true; }
    }
    if (!adopted && ctx.scene) {
      for (const child of ctx.scene.children) {
        if (child.isLight || child.isCamera || child === this.debugDraw?.mesh) continue;
        if (isBackdrop(child)) continue;
        const id = this.statics.add(child);
        if (id > 0) { this._fallbackIds.push(id); this._dirty = true; }
      }
    }
  }

  buildStaticBVH() {
    const s = this.statics;
    const count = s.compile();
    this.bvh.build(s.pos, s.nrm, s.obj, s.mat, s.layer, count);
    this._dirty = false;
    this.stats.triangles = count;
    this.stats.nodes = this.bvh.nodeCount;
    this.stats.buildMs = Math.round(this.bvh.buildMs * 10) / 10;
    this.stats.depth = this.bvh.maxDepth;
    return count;
  }

  materialOf(tri) {
    if (tri < 0 || !this.bvh.mat) return null;
    return this.statics.materialKeys[this.bvh.mat[tri]] || null;
  }

  objectOf(tri) {
    if (tri < 0 || !this.bvh.obj) return null;
    const i = this.bvh.obj[tri];
    return i >= 0 ? this.statics.objects[i] || null : null;
  }

  _nextHit() {
    const h = this._hits[this._hitIdx];
    this._hitIdx = (this._hitIdx + 1) % HIT_RING;
    return h;
  }

  raycast(origin, dir, maxDist = 1000, mask = ALL_LAYERS) {
    if (this._dirty) this.buildStaticBVH();
    if (!this.bvh.triCount) return null;
    _dir.copy(dir);
    const l = _dir.length();
    if (l < 1e-9) return null;
    _dir.multiplyScalar(1 / l);
    const tri = this.bvh.raycast(origin.x, origin.y, origin.z, _dir.x, _dir.y, _dir.z, maxDist, mask);
    this.stats.rays++;
    if (tri < 0) return null;
    const t = this.bvh.hitT;
    const h = this._nextHit();
    h.distance = t;
    h.triangle = tri;
    h.layer = this.bvh.layer[tri];
    h.point.set(origin.x + _dir.x * t, origin.y + _dir.y * t, origin.z + _dir.z * t);
    this.bvh.faceNormal(tri, h.faceNormal);
    this.bvh.shadingNormal(tri, this.bvh.hitU, this.bvh.hitV, h.normal);
    if (h.faceNormal.dot(_dir) > 0) h.faceNormal.negate();
    if (h.normal.dot(_dir) > 0) h.normal.negate();
    h.object = this.objectOf(tri);
    h.material = this.materialOf(tri);
    return h;
  }

  sphereCast(origin, dir, radius, maxDist = 1000, mask = ALL_LAYERS) {
    if (this._dirty) this.buildStaticBVH();
    if (!this.bvh.triCount) return null;
    _dir.copy(dir);
    const l = _dir.length();
    if (l < 1e-9) return null;
    _dir.multiplyScalar(maxDist / l);
    _origin.copy(origin);
    const sw = this.sweeper;
    const hit = sw.sweepCapsule(
      _origin.x, _origin.y, _origin.z, _origin.x, _origin.y, _origin.z,
      radius, _dir.x, _dir.y, _dir.z, mask, sw.result,
    );
    if (!hit) return null;
    const tri = sw.result.tri;
    const h = this._nextHit();
    h.distance = sw.result.t * maxDist;
    h.triangle = tri;
    h.layer = this.bvh.layer[tri];
    h.point.copy(sw.result.point);
    h.normal.copy(sw.result.normal);
    this.bvh.faceNormal(tri, h.faceNormal);
    if (h.faceNormal.dot(_dir) > 0) h.faceNormal.negate();
    h.object = this.objectOf(tri);
    h.material = this.materialOf(tri);
    return h;
  }

  /**
   * Accepts a capsule handle or a bare feet-position Vector3 — callers that
   * have not adopted the handle yet get a capsule bound to their vector rather
   * than a crash.
   */
  moveCharacter(capsule, velocity, dt, mask) {
    if (!capsule) return null;
    let cap = capsule;
    if (capsule.isVector3) {
      cap = this._loose.get(capsule);
      if (!cap) {
        cap = this.character.createCapsule(capsule);
        cap.position = capsule;
        cap.mask = this.defaultMask;
        this.character.refresh(cap);
        this._loose.set(capsule, cap);
        this.capsules.push(cap);
      }
    }
    return this.character.move(cap, velocity, dt ?? this.ctx?.fixedDt ?? 1 / 120, mask);
  }

  createCapsule(position, radius = 0.35, height = STANCE_HEIGHT.stand) {
    const cap = this.character.createCapsule(position, radius, height);
    cap.mask = this.defaultMask;
    this.capsules.push(cap);
    return cap;
  }

  destroyCapsule(cap) {
    const i = this.capsules.indexOf(cap);
    if (i >= 0) {
      this.capsules[i] = this.capsules[this.capsules.length - 1];
      this.capsules.pop();
    }
  }

  step(dt) {
    this.bodies.step(dt);
    this.ragdolls.step(dt);
    this.stats.bodies = this.bodies.active.length;
    this.stats.ragdolls = this.ragdolls.active.length;
  }

  fixedUpdate(dt) {
    // Props and destructibles can register colliders at any time; coalesce
    // rebuilds so a burst of registrations costs one build, not fifty.
    if (this._dirty) {
      this._rebuildTimer += dt;
      if (this._rebuildTimer > 0.25) {
        this._rebuildTimer = 0;
        this.buildStaticBVH();
      }
    } else {
      this._rebuildTimer = 0;
    }
    this.step(dt);
  }

  lateUpdate(dt, ctx) {
    if (this.debugDraw?.enabled) this.debugDraw.update(ctx.camera);
  }

  dispose() {
    this.debugDraw?.dispose();
    this.statics.clear();
  }
}

/** Sky domes and backdrops are inside-out and must never become colliders. */
function isBackdrop(o) {
  if (o.userData?.noCollide) return true;
  if (/sky|cloud|backdrop|star|sun|moon|horizon|fog/i.test(o.name || '')) return true;
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  return !!m && m.side === THREE.BackSide;
}
