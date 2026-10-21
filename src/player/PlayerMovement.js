import * as THREE from 'three';
import { PlayerConfig } from './PlayerConfig.js';
import { makeHit } from './PhysicsBridge.js';
import { clamp, lerp, easeOutCubic, easeInCubic, smootherstep } from './Springs.js';

/**
 * Ground/air locomotion, the stance machine and the slide. Velocity is
 * integrated with explicit acceleration and friction coefficients rather than
 * lerped toward a target speed: friction is what produces the short authored
 * skid when you release a key, and a lerp cannot reproduce it.
 *
 * Runs on a fixed 120 Hz substep so the exponential terms are stable regardless
 * of frame rate. All collision goes through `PhysicsBridge`.
 */

const UP = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _hit = makeHit();

const STANCE_MUL = { stand: 1, crouch: PlayerConfig.speed.crouchMul, prone: PlayerConfig.speed.proneMul, slide: 1, mantle: 0 };

export class PlayerMovement {
  constructor(bridge, events) {
    this.cfg = PlayerConfig;
    this.bridge = bridge;
    this.ev = events;

    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.grounded = true;
    this.wasGrounded = true;
    this.hitWall = false;

    this.stance = 'stand';
    this.wantProne = false;
    this.standBlocked = false;
    this.eyeHeight = this.cfg.eye.stand;
    this.capsuleHeight = this.cfg.capsule.stand;
    this.stanceMul = 1;
    this.stanceBlend = 1;
    this._from = { eye: this.cfg.eye.stand, cap: this.cfg.capsule.stand, mul: 1 };
    this._to = { eye: this.cfg.eye.stand, cap: this.cfg.capsule.stand, mul: 1 };
    this._stanceT = 1;
    this._stanceDur = 1;
    this._stanceEase = easeOutCubic;
    this._proneLock = 0;

    this.sprinting = false;
    this.tacSprinting = false;
    this._tacRequested = false;
    this._lastSprintPress = -10;
    this.stamina = this.cfg.stamina.max;
    this.exhausted = false;
    this._staminaHold = 0;

    this.sliding = false;
    this.slideTime = 0;
    this.slideSpeed = 0;
    this.slideDir = new THREE.Vector3(0, 0, -1);
    this.slideCooldown = 0;
    this.slideJumpBoost = 0;

    this.speed = 0;
    this.speedPeak = 0;
    this.time = 0;
    this.landImpact = 0;
    this._justJumped = false;
    this._fitCache = { stance: '', t: -1, ok: true };
  }

  get moveSpeedCap() {
    const s = this.cfg.speed;
    if (this.tacSprinting) return s.tacSprint;
    if (this.sprinting) return s.sprint;
    return s.run;
  }

  /** One fixed substep. `cmd` is a reused command struct owned by PlayerSystem. */
  step(dt, cmd) {
    this.time += dt;
    if (this.slideCooldown > 0) this.slideCooldown -= dt;
    if (this._proneLock > 0) this._proneLock -= dt;

    this._advanceStance(dt);
    if (cmd.frozen) { this._integrateStanceOnly(dt); return; }

    this._updateSprint(dt, cmd);
    this._updateSlide(dt, cmd);
    this._updateStanceIntent(dt, cmd);
    this._updateStamina(dt);

    _fwd.set(-Math.sin(cmd.yaw), 0, -Math.cos(cmd.yaw));
    _right.set(Math.cos(cmd.yaw), 0, -Math.sin(cmd.yaw));

    let mx = cmd.moveX;
    let mz = cmd.moveZ;
    if (this.tacSprinting) mx *= this.cfg.speed.tacStrafeScale;
    const sx = mx * this.cfg.speed.strafeScale;
    const sz = mz >= 0 ? mz : mz * this.cfg.speed.backScale;
    const mag = Math.min(1, Math.hypot(sx, sz));

    _wish.set(0, 0, 0).addScaledVector(_fwd, sz).addScaledVector(_right, sx);
    if (_wish.lengthSq() > 1e-8) _wish.normalize();

    let base = this.cfg.speed.run;
    if (this.tacSprinting) base = this.cfg.speed.tacSprint;
    else if (this.sprinting) base = this.cfg.speed.sprint;
    else if (cmd.ads) base = Math.min(this.cfg.speed.walk, this.cfg.speed.run * this.cfg.speed.adsMul);
    else if (cmd.walk) base = this.cfg.speed.walk;
    base *= this.stanceMul;
    if (cmd.lean !== 0 && !this.sprinting) base *= this.cfg.view.lean.speedMul;
    const wishSpeed = base * mag;

    if (this.sliding) {
      this._slideMotion(dt, _wish, mag);
    } else if (this.grounded) {
      this._friction(dt);
      this._accelerate(_wish, wishSpeed, this.cfg.accel.ground, dt);
    } else {
      this._accelerate(_wish, wishSpeed, this.cfg.accel.ground * this.cfg.accel.airControl, dt);
    }

    this._jump(cmd);

    if (this.grounded && !this._justJumped) {
      this.velocity.y = this.cfg.accel.groundStick;
    } else {
      this.velocity.y -= this.cfg.accel.gravity * dt;
    }
    this._justJumped = false;

    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (hSpeed > this.cfg.accel.maxSpeed) {
      const k = this.cfg.accel.maxSpeed / hSpeed;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }

    this.wasGrounded = this.grounded;
    const prevVy = this.velocity.y;
    const res = this.bridge.move(this.position, this.velocity, dt, this.cfg.capsule.radius, this.capsuleHeight);
    this.grounded = res.grounded;
    this.hitWall = res.hitWall;
    this.groundNormal.copy(res.normal);
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;

    if (this.grounded && !this.wasGrounded) {
      this.landImpact = Math.max(0, -prevVy);
      this.ev.land?.(this.landImpact);
      if (this.landImpact > 9.5) this.ev.hardLand?.(this.landImpact);
    }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    // A wall impact zeroes speed instantly, so traversal decisions read a
    // short-memory peak instead: you vault what you *ran into*, not what you
    // are standing against.
    this.speedPeak = Math.max(this.speed, this.speedPeak - 9 * dt);
  }

  _integrateStanceOnly(dt) {
    this.velocity.multiplyScalar(Math.exp(-6 * dt));
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  // --- locomotion primitives (Quake-derived; unitless accel/friction) ---

  _accelerate(wishDir, wishSpeed, accel, dt) {
    if (wishSpeed <= 0) return;
    const cur = this.velocity.x * wishDir.x + this.velocity.z * wishDir.z;
    const add = wishSpeed - cur;
    if (add <= 0) return;
    let a = accel * wishSpeed * dt;
    if (a > add) a = add;
    this.velocity.x += wishDir.x * a;
    this.velocity.z += wishDir.z * a;
  }

  _friction(dt) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed < 0.02) { this.velocity.x = 0; this.velocity.z = 0; return; }
    const control = Math.max(speed, this.cfg.accel.stopSpeed);
    const drop = control * this.cfg.accel.friction * dt;
    const k = Math.max(0, speed - drop) / speed;
    this.velocity.x *= k;
    this.velocity.z *= k;
  }

  _jump(cmd) {
    if (!cmd.jumpPressed || !this.grounded) return;
    if (this.stance === 'prone') { this.wantProne = false; return; }
    if (this.sliding) { this._slideJump(); return; }
    if (this.stance === 'crouch' && !this._canFit('stand')) return;
    const mul = this.stance === 'crouch' ? this.cfg.accel.crouchJumpMul : 1;
    this.velocity.y = this.cfg.accel.jump * mul;
    this.grounded = false;
    this._justJumped = true;
    this.stamina = Math.max(0, this.stamina - this.cfg.stamina.jumpCost);
    this._staminaHold = this.cfg.stamina.regenDelay;
    this.ev.jump?.();
  }

  // --- stance machine ---

  _updateStanceIntent(dt, cmd) {
    if (this.sliding || this.stance === 'mantle') return;
    if (cmd.pronePressed) {
      if (this.stance === 'prone') { if (this._proneLock <= 0) this.wantProne = false; }
      else this.wantProne = true;
    }
    if (cmd.crouchPressed && this.stance === 'prone' && this._proneLock <= 0) this.wantProne = false;

    let desired = 'stand';
    if (this.wantProne) desired = 'prone';
    else if (cmd.crouchHeld) desired = 'crouch';
    if (desired === this.stance) { this.standBlocked = false; return; }

    const taller = this.cfg.capsule[desired] > this.cfg.capsule[this.stance];
    if (taller && !this._canFit(desired)) {
      this.standBlocked = true;
      if (desired === 'stand' && this.stance === 'prone' && this._canFit('crouch')) desired = 'crouch';
      else return;
    } else {
      this.standBlocked = false;
    }
    this._enterStance(desired);
  }

  _enterStance(next) {
    const st = this.cfg.stance;
    const prev = this.stance;
    let dur = st.toStand;
    let ease = easeOutCubic;
    if (next === 'crouch') { dur = prev === 'prone' ? st.fromProne * 0.7 : st.toCrouch; ease = prev === 'prone' ? smootherstep : easeOutCubic; }
    else if (next === 'prone') { dur = st.toProne; ease = easeInCubic; this._proneLock = st.proneLockout; }
    else if (next === 'stand') { dur = prev === 'prone' ? st.fromProne : st.toStand; ease = prev === 'prone' ? smootherstep : easeOutCubic; }
    else if (next === 'slide') { dur = st.toSlide; ease = easeOutCubic; }
    this._beginStanceBlend(next, dur, ease);
    this.stance = next;
    this.ev.stance?.(next, prev);
  }

  _beginStanceBlend(next, dur, ease) {
    this._from.eye = this.eyeHeight;
    this._from.cap = this.capsuleHeight;
    this._from.mul = this.stanceMul;
    this._to.eye = this.cfg.eye[next];
    this._to.cap = this.cfg.capsule[next];
    this._to.mul = STANCE_MUL[next] ?? 1;
    this._stanceT = 0;
    this._stanceDur = Math.max(0.01, dur);
    this._stanceEase = ease;
  }

  _advanceStance(dt) {
    if (this._stanceT >= this._stanceDur) {
      this.eyeHeight = this._to.eye;
      this.capsuleHeight = this._to.cap;
      this.stanceMul = this._to.mul;
      this.stanceBlend = 1;
      return;
    }
    this._stanceT += dt;
    const k = this._stanceEase(clamp(this._stanceT / this._stanceDur, 0, 1));
    this.stanceBlend = k;
    this.eyeHeight = lerp(this._from.eye, this._to.eye, k);
    this.capsuleHeight = lerp(this._from.cap, this._to.cap, k);
    this.stanceMul = lerp(this._from.mul, this._to.mul, k);
  }

  /** Cached: a blocked stand-up is re-tested at 8 Hz, not once per 120 Hz substep. */
  _canFit(stance) {
    const c = this._fitCache;
    if (c.stance === stance && this.time - c.t < 0.12) return c.ok;
    c.stance = stance;
    c.t = this.time;
    c.ok = this.bridge.canGrowTo(this.position, this.cfg.capsule[stance] + 0.06);
    return c.ok;
  }

  // --- sprint / stamina ---

  _updateSprint(dt, cmd) {
    if (cmd.sprintPressed) {
      if (this.time - this._lastSprintPress < 0.34) this._tacRequested = true;
      this._lastSprintPress = this.time;
    }
    if (!cmd.sprintHeld) this._tacRequested = false;

    const forward = cmd.moveZ > 0.3 && Math.abs(cmd.moveX) < 0.95;
    const stanceOk = this.stance !== 'prone' && this.stance !== 'mantle' && !(this.stance === 'crouch' && cmd.crouchHeld);
    const allowed = cmd.sprintHeld && forward && !cmd.ads && !this.sliding && stanceOk && this.stamina > 0.5;
    this.sprinting = allowed;
    if (!allowed) { this.tacSprinting = false; return; }
    const tacOk = this._tacRequested && !this.exhausted && this.stamina > this.cfg.stamina.tacMinimum * 0.35;
    this.tacSprinting = tacOk && this.stance !== 'crouch';
  }

  _updateStamina(dt) {
    const s = this.cfg.stamina;
    if (this.tacSprinting) {
      this.stamina -= s.tacDrain * dt;
      this._staminaHold = s.regenDelay;
    } else if (this.sprinting) {
      this.stamina -= s.sprintDrain * dt;
      this._staminaHold = s.regenDelay;
    } else if (this._staminaHold > 0) {
      this._staminaHold -= dt;
    } else if (this.stamina < s.max) {
      this.stamina += s.regen * dt;
    }
    this.stamina = clamp(this.stamina, 0, s.max);
    if (this.stamina <= 0.01) this.exhausted = true;
    else if (this.exhausted && this.stamina > s.exhaustedRecovery) this.exhausted = false;
  }

  // --- slide ---

  canSlide() {
    return this.grounded && !this.sliding && this.stance !== 'prone'
      && this.slideCooldown <= 0 && this.sprinting
      && this.speed >= this.cfg.slide.enterSpeed;
  }

  _updateSlide(dt, cmd) {
    const c = this.cfg.slide;
    if (!this.sliding) {
      if (cmd.crouchPressed && this.canSlide()) this._beginSlide();
      return;
    }
    this.slideTime += dt;
    if (cmd.pronePressed) { this._endSlide(true); return; }
    const expired = this.slideTime >= c.minDuration &&
      (this.slideSpeed <= c.exitSpeed || this.slideTime >= c.maxDuration || !cmd.crouchHeld || !this.grounded);
    if (expired) this._endSlide(false);
  }

  _beginSlide() {
    const c = this.cfg.slide;
    this.sliding = true;
    this.slideTime = 0;
    this.slideSpeed = clamp(this.speed * c.boostMul, c.minSpeed, c.maxSpeed);
    if (this.speed > 0.1) this.slideDir.set(this.velocity.x, 0, this.velocity.z).normalize();
    this.stamina = Math.max(0, this.stamina - this.cfg.stamina.slideCost);
    this._staminaHold = this.cfg.stamina.regenDelay;
    this.sprinting = false;
    this.tacSprinting = false;
    this._enterStance('slide');
    this.ev.slide?.('start', this.slideSpeed);
  }

  _slideMotion(dt, wishDir, mag) {
    const c = this.cfg.slide;
    if (mag > 0.1) {
      // Small authored steering window — enough to line up a corner, not enough
      // to turn the slide into a strafe.
      const maxRad = c.steerRate * (Math.PI / 180) * dt;
      const cross = this.slideDir.x * wishDir.z - this.slideDir.z * wishDir.x;
      const dot = clamp(this.slideDir.x * wishDir.x + this.slideDir.z * wishDir.z, -1, 1);
      const ang = Math.atan2(cross, dot);
      const turn = clamp(ang, -maxRad, maxRad);
      const cs = Math.cos(turn), sn = Math.sin(turn);
      const nx = this.slideDir.x * cs + this.slideDir.z * sn;
      const nz = -this.slideDir.x * sn + this.slideDir.z * cs;
      this.slideDir.set(nx, 0, nz).normalize();
    }
    this.slideSpeed *= Math.exp(-c.decay * dt);
    const slope = -(this.groundNormal.x * this.slideDir.x + this.groundNormal.z * this.slideDir.z);
    this.slideSpeed += slope * this.cfg.accel.gravity * c.slopeGain * dt;
    this.slideSpeed = clamp(this.slideSpeed, 0, c.maxSpeed);
    this.velocity.x = this.slideDir.x * this.slideSpeed;
    this.velocity.z = this.slideDir.z * this.slideSpeed;
  }

  _slideJump() {
    const c = this.cfg.slide;
    this.velocity.x = this.slideDir.x * this.slideSpeed * c.jumpKeep;
    this.velocity.z = this.slideDir.z * this.slideSpeed * c.jumpKeep;
    this.velocity.y = this.cfg.accel.jump * c.jumpMul;
    this.grounded = false;
    this._justJumped = true;
    this._endSlide(false, true);
    this.ev.jump?.(true);
  }

  _endSlide(toProne, fromJump = false) {
    this.sliding = false;
    this.slideCooldown = this.cfg.slide.cooldown;
    this.ev.slide?.('end', this.slideSpeed);
    if (toProne) { this.wantProne = true; this._enterStance('prone'); return; }
    if (fromJump && this._canFit('stand')) { this._enterStance('stand'); return; }
    this._enterStance('crouch');   // stance intent pops back to stand next step if crouch is not held
  }

  /** Hand control to a scripted move (mantle); locomotion pauses meanwhile. */
  enterScripted() {
    this.sliding = false;
    this.sprinting = false;
    this.tacSprinting = false;
    this.velocity.set(0, 0, 0);
    const prev = this.stance;
    this.stance = 'mantle';
    this.ev.stance?.('mantle', prev);
  }

  exitScripted(position, exitDir, exitSpeed) {
    this.position.copy(position);
    this.velocity.set(exitDir.x * exitSpeed, 0, exitDir.z * exitSpeed);
    this.grounded = true;
    this.wasGrounded = true;
    this.stance = this._canFit('stand') ? 'stand' : 'crouch';
    this._beginStanceBlend(this.stance, 0.14, easeOutCubic);
    this.ev.stance?.(this.stance, 'mantle');
  }

  /** Slide state is not resumable across a teleport/override, so drop it hard. */
  resetTransient() {
    this.sliding = false;
    this.slideTime = 0;
    this.slideSpeed = 0;
    this.slideCooldown = 0;
    this.wantProne = false;
    this.velocity.set(0, 0, 0);
    this.stance = 'stand';
    this.eyeHeight = this.cfg.eye.stand;
    this.capsuleHeight = this.cfg.capsule.stand;
    this.stanceMul = 1;
    this._stanceT = 1;
    this._stanceDur = 1;
    this._to.eye = this.cfg.eye.stand;
    this._to.cap = this.cfg.capsule.stand;
    this._to.mul = 1;
    this.sprinting = false;
    this.tacSprinting = false;
  }

  /** Lateral room for a lean, so the camera never pokes through a wall. */
  leanClearance(yaw, sign, maxOffset) {
    _dir.set(Math.cos(yaw) * sign, 0, -Math.sin(yaw) * sign);
    _tmp.copy(this.position).addScaledVector(UP, this.eyeHeight);
    const pad = this.cfg.view.lean.probePad;
    const hit = this.bridge.ray(_tmp, _dir, maxOffset + pad, 1 | 2, _hit);
    if (!hit) return maxOffset;
    return clamp(hit.distance - pad, 0, maxOffset);
  }
}
