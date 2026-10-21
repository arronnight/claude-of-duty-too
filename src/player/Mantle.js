import * as THREE from 'three';
import { makeHit } from './PhysicsBridge.js';
import { clamp, lerp, smootherstep, easeOutCubic, easeOutBack, bump } from './Springs.js';

/**
 * Ledge detection and the scripted traversal that follows. This is the single
 * most identity-defining move in a CoD-like: the camera must travel on an
 * authored curve rather than be shoved by the collision solver, so the whole
 * thing runs open-loop for its duration and hands a finished transform back to
 * the player each frame.
 *
 * Two variants share the solver: a fast low vault that carries momentum over an
 * obstacle, and a slower high mantle that pulls up onto it and lands heavy.
 */

const UP = new THREE.Vector3(0, 1, 0);
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _wallHit = makeHit();
const _topHit = makeHit();
const _headHit = makeHit();
const _farHit = makeHit();

export class MantleController {
  constructor(cfg, bridge) {
    this.cfg = cfg.mantle;
    this.bridge = bridge;
    this.active = false;
    this.kind = 'vault';
    this.t = 0;
    this.duration = 0.4;
    this.side = 1;
    this.height = 0;
    this.over = false;
    this.apexY = 0;
    this.start = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.exitDir = new THREE.Vector3(0, 0, -1);
    this.rollDeg = 0;
    this.pitchDeg = 0;
    this.fovAdd = 0;
    this.riseOffset = 0;
    this.cooldown = 0;
    this._probeTimer = 0;
    this.candidate = { valid: false, kind: 'vault', height: 0, x: 0, y: 0, z: 0, over: false, apexY: 0 };
  }

  /**
   * Cheap staged probe: wall in front, walkable top above it, headroom on top,
   * and (for low obstacles) whether there is floor to drop onto on the far side.
   * Throttled — three raycasts per probe is plenty at 11 Hz.
   */
  probe(feet, forward, dt, force) {
    this._probeTimer -= dt;
    const c = this.candidate;
    if (!force && this._probeTimer > 0) return c.valid ? c : null;
    this._probeTimer = this.cfg.probeInterval;
    c.valid = false;
    if (this.cooldown > 0) return null;

    _flat.set(forward.x, 0, forward.z);
    if (_flat.lengthSq() < 1e-6) return null;
    _flat.normalize();

    _o.copy(feet).addScaledVector(UP, 0.50);
    const wall = this.bridge.ray(_o, _flat, this.cfg.reach, 1 | 2, _wallHit);
    if (!wall || Math.abs(wall.normal.y) > 0.55) return null;
    if (_flat.dot(wall.normal) > -0.35) return null;

    const topScan = this.cfg.maxHeight + 0.30;
    _o.copy(feet).addScaledVector(UP, topScan).addScaledVector(_flat, wall.distance + 0.30);
    _d.set(0, -1, 0);
    const top = this.bridge.ray(_o, _d, topScan + 0.10, 1 | 2, _topHit);
    if (!top || top.normal.y < 0.62) return null;

    const height = top.point.y - feet.y;
    if (height < this.cfg.minHeight || height > this.cfg.maxHeight) return null;

    _o.copy(top.point).addScaledVector(UP, 0.06);
    const head = this.bridge.ray(_o, UP, this.cfg.clearance + 0.2, 1 | 2, _headHit);
    if (head && head.distance < this.cfg.clearance) return null;

    const vault = height <= this.cfg.vaultHeight;
    c.kind = vault ? 'vault' : 'mantle';
    c.height = height;
    c.x = top.point.x + _flat.x * this.cfg.landOffset;
    c.y = top.point.y;
    c.z = top.point.z + _flat.z * this.cfg.landOffset;
    c.over = false;
    c.apexY = top.point.y;

    // A thin low obstacle is vaulted clean over rather than stood on top of.
    if (vault) {
      _o.set(c.x, top.point.y + 0.35, c.z).addScaledVector(_flat, 0.45);
      _d.set(0, -1, 0);
      const far = this.bridge.ray(_o, _d, height + 1.60, 1 | 2, _farHit);
      if (far && far.point.y < top.point.y - 0.30 && far.normal.y > 0.6) {
        c.x = _o.x;
        c.y = far.point.y;
        c.z = _o.z;
        c.over = true;
      }
    }
    c.apexY = top.point.y + 0.17;   // feet must clear the ledge, not pass through it
    c.valid = true;
    return c;
  }

  begin(feet, forward, candidate) {
    const cfg = this.cfg;
    this.active = true;
    this.kind = candidate.kind;
    this.height = candidate.height;
    this.over = candidate.over;
    this.apexY = candidate.apexY;
    this.t = 0;
    this.duration = candidate.kind === 'vault'
      ? cfg.vaultTime * (candidate.over ? 1.18 : 1)
      : cfg.mantleTime + (candidate.height - cfg.vaultHeight) * cfg.mantleTimePerMetre;
    this.start.copy(feet);
    this.target.set(candidate.x, candidate.y, candidate.z);
    this.position.copy(feet);
    _flat.set(forward.x, 0, forward.z).normalize();
    this.exitDir.copy(_flat);
    this.side = ((this.start.x * 7.31 + this.start.z * 3.17) % 2 < 1) ? 1 : -1;
    this.rollDeg = 0;
    this.pitchDeg = 0;
    this.fovAdd = 0;
    this.riseOffset = 0;
    return this;
  }

  /** Advances the scripted arc; returns true while still running. */
  update(dt) {
    if (!this.active) { if (this.cooldown > 0) this.cooldown -= dt; return false; }
    this.t += dt;
    const k = clamp(this.t / this.duration, 0, 1);
    const vault = this.kind === 'vault';

    // Vertical leads, horizontal follows — that read of "up first, then over" is
    // what separates a mantle from a teleport.
    const kv = vault ? easeOutCubic(clamp(k / 0.72, 0, 1)) : easeOutBack(clamp(k / 0.78, 0, 1), 0.9);
    const kh = vault ? smootherstep(k) : smootherstep(clamp((k - 0.30) / 0.70, 0, 1));

    this.position.x = lerp(this.start.x, this.target.x, kh);
    this.position.z = lerp(this.start.z, this.target.z, kh);
    if (this.over) {
      // Quadratic through an apex above the ledge, so the body goes over it.
      const y0 = this.start.y, y1 = this.target.y;
      const yc = (4 * this.apexY - y0 - y1) * 0.5;
      const u = 1 - k;
      this.position.y = u * u * y0 + 2 * u * k * yc + k * k * y1;
    } else {
      const arc = vault ? bump(k) * 0.09 : 0;
      this.position.y = lerp(this.start.y, this.target.y, kv) + arc;
    }

    const env = bump(k, vault ? 1.0 : 1.3);
    this.rollDeg = env * this.cfg.rollDeg * this.side * (vault ? 1 : 1.25);
    this.pitchDeg = vault
      ? -env * this.cfg.pitchDeg * 0.7
      : (Math.sin(Math.PI * 2 * k) * this.cfg.pitchDeg) * (1 - k * 0.35);
    this.fovAdd = bump(k, 1.4) * this.cfg.fovPunch * (vault ? 0.75 : 1);
    // Hands/eyes rise slightly ahead of the body on the pull-up.
    this.riseOffset = vault ? -env * 0.045 : -env * 0.075;

    if (k >= 1) {
      this.active = false;
      this.cooldown = this.cfg.cooldown;
      this.position.copy(this.target);
      return false;
    }
    return true;
  }

  exitSpeed() {
    return this.kind === 'vault' ? this.cfg.exitSpeedVault : this.cfg.exitSpeedMantle;
  }

  cancel() {
    this.active = false;
    this.rollDeg = 0;
    this.pitchDeg = 0;
    this.fovAdd = 0;
    this.riseOffset = 0;
  }
}
