import * as THREE from 'three';

/**
 * Guarded adapter over `ctx.physics`. The physics system may not exist yet, may
 * publish a half-written API, or may throw mid-refactor — none of which may take
 * the player down. Every call is feature-probed and wrapped; on failure we fall
 * back to a swept ground-plane solver so the game still moves, and re-probe
 * periodically so the real solver is picked up the moment it lands.
 */

const RETRY_AFTER = 2.0;
const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _step = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _slide = new THREE.Vector3();
const _capsule = { position: new THREE.Vector3(), radius: 0.34, height: 1.8, halfHeight: 0.9 };
const _velIn = new THREE.Vector3();
const _groundHit = makeHit();
const _wallHit = makeHit();

export function makeHit() {
  return {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    material: 'concrete_floor',
    object: null,
  };
}

export class PhysicsBridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.moveOk = true;
    this.rayOk = true;
    this._moveRetry = 0;
    this._rayRetry = 0;
    this.usedFallback = false;
    this.groundMaterial = null;
    this.result = { position: new THREE.Vector3(), grounded: false, normal: new THREE.Vector3(0, 1, 0), hitWall: false, steppedUp: false };
    this.fallbackGroundY = 0;
  }

  tick(dt) {
    if (!this.moveOk) { this._moveRetry -= dt; if (this._moveRetry <= 0) this.moveOk = true; }
    if (!this.rayOk) { this._rayRetry -= dt; if (this._rayRetry <= 0) this.rayOk = true; }
  }

  /**
   * Cast and normalise into a caller-owned record so several probes can be held
   * at once (the mantle solver needs three simultaneously).
   */
  ray(origin, dir, maxDist, mask, out) {
    const api = this.ctx.physics;
    if (!api?.raycast || !this.rayOk) return null;
    let h;
    try {
      h = api.raycast(origin, dir, maxDist, mask);
    } catch {
      this.rayOk = false;
      this._rayRetry = RETRY_AFTER;
      return null;
    }
    if (!h) return null;
    if (h.point) out.point.copy(h.point);
    else out.point.copy(origin).addScaledVector(dir, h.distance || 0);
    out.distance = typeof h.distance === 'number' ? h.distance : out.point.distanceTo(origin);
    if (out.distance > maxDist + 1e-3) return null;
    if (h.normal) {
      out.normal.copy(h.normal);
    } else if (h.face?.normal) {
      out.normal.copy(h.face.normal);
      if (h.object) out.normal.transformDirection(h.object.matrixWorld);
    } else {
      out.normal.copy(UP);
    }
    if (out.normal.lengthSq() < 1e-6) out.normal.copy(UP);
    out.object = h.object ?? null;
    const m = h.material;
    out.material = typeof m === 'string' ? m
      : h.object?.userData?.material ?? h.object?.userData?.surface ?? m?.name ?? out.object?.material?.name ?? 'concrete_floor';
    return out;
  }

  /**
   * Can the capsule grow to `height` here? Prefers the solver's volume test —
   * a single upward ray misses an overhang the shoulders would still clip.
   */
  canGrowTo(feet, height) {
    const api = this.ctx.physics;
    if (api?.canStand && !this.usedFallback) {
      try {
        _capsule.position.copy(feet);
        return api.canStand(_capsule, height) !== false;
      } catch { /* fall through to the ray test */ }
    }
    _probe.copy(feet).addScaledVector(UP, 0.20);
    const hit = this.ray(_probe, UP, height, 1 | 2, _groundHit);
    return !hit || 0.20 + hit.distance >= height;
  }

  /** Surface key under the player, for footstep audio and FX. */
  surfaceUnder(feet, out) {
    if (this.groundMaterial) return this.groundMaterial;
    _probe.copy(feet).addScaledVector(UP, 0.6);
    _dir.set(0, -1, 0);
    const hit = this.ray(_probe, _dir, 3.0, 1 | 2, out);
    return hit ? hit.material : 'concrete_floor';
  }

  /**
   * Swept character move. Prefers `ctx.physics.moveCharacter(capsule, velocity, dt)`
   * and tolerates either a returned position or an in-place mutation.
   */
  move(position, velocity, dt, radius, height) {
    const api = this.ctx.physics;
    const res = this.result;
    if (api?.moveCharacter && this.moveOk) {
      _capsule.position.copy(position);
      _capsule.radius = radius;
      _capsule.height = height;
      _capsule.halfHeight = height * 0.5;
      _velIn.copy(velocity);
      let r;
      try {
        r = api.moveCharacter(_capsule, _velIn, dt);
      } catch {
        this.moveOk = false;
        this._moveRetry = RETRY_AFTER;
        r = null;
      }
      if (r) {
        const p = r.position ?? ('grounded' in r ? _capsule.position : null);
        if (p && Number.isFinite(p.x)) {
          res.position.copy(p);
          res.grounded = !!r.grounded;
          if (r.normal) res.normal.copy(r.normal); else res.normal.copy(UP);
          res.hitWall = !!r.hitWall;
          res.steppedUp = !!r.steppedUp;
          if (r.velocity) velocity.copy(r.velocity);
          position.copy(res.position);
          this.groundMaterial = r.groundMaterial || null;
          this.usedFallback = false;
          return res;
        }
      }
    }
    this.usedFallback = true;
    this.groundMaterial = null;
    return this._fallbackMove(position, velocity, dt, radius, height);
  }

  /** Ground-plane + ray-probed wall slide. Good enough to keep the game playable. */
  _fallbackMove(position, velocity, dt, radius, height) {
    const res = this.result;
    res.normal.copy(UP);
    res.steppedUp = false;
    res.hitWall = false;

    _step.copy(velocity).multiplyScalar(dt);
    const hLen = Math.hypot(_step.x, _step.z);
    if (hLen > 1e-4) {
      _dir.set(_step.x / hLen, 0, _step.z / hLen);
      _probe.copy(position).addScaledVector(UP, Math.min(0.9, height * 0.5));
      const hit = this.ray(_probe, _dir, hLen + radius, 1 | 2, _wallHit);
      if (hit && Math.abs(hit.normal.y) < 0.7) {
        res.hitWall = true;
        _slide.copy(hit.normal);
        _slide.y = 0;
        if (_slide.lengthSq() > 1e-6) {
          _slide.normalize();
          const into = _step.x * _slide.x + _step.z * _slide.z;
          if (into < 0) { _step.x -= _slide.x * into; _step.z -= _slide.z * into; }
          const vInto = velocity.x * _slide.x + velocity.z * _slide.z;
          if (vInto < 0) { velocity.x -= _slide.x * vInto; velocity.z -= _slide.z * vInto; }
        }
      }
    }

    position.add(_step);

    _probe.copy(position).addScaledVector(UP, 1.2);
    _dir.set(0, -1, 0);
    const g = this.ray(_probe, _dir, 8, 1 | 2, _groundHit);
    const groundY = g ? g.point.y : this.fallbackGroundY;
    if (g) res.normal.copy(g.normal);
    if (position.y <= groundY + 0.02 && velocity.y <= 0.05) {
      position.y = groundY;
      res.grounded = true;
    } else {
      res.grounded = false;
    }
    res.position.copy(position);
    return res;
  }
}
