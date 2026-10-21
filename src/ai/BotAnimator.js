import * as THREE from 'three';
import { LIMB, restPos, GRIP_L, GRIP_R, SIGHT } from './BotRig.js';

/**
 * Procedural locomotion for one bot. No clips, no keyframe data: the pose is
 * solved every frame from the bot's velocity, facing, stance and aim target.
 *
 * The core idea is that **feet are planted in world space**, not in body space.
 * A foot picks a spot on the ground, stays exactly there while the body moves
 * over it, and only moves during an explicit swing. Sliding feet are the single
 * loudest animation tell in a game, and they are impossible here by
 * construction — the same mechanism gives turn-in-place shuffles, stopping
 * without a skate, and correct steps on the kerb, all for free.
 *
 * Everything above the ankles is spring-driven: hip height falls out of leg
 * reach, the pelvis rolls and yaws with the stride, the chest counter-rotates
 * against the pelvis, and the weapon is placed so its sight sits in front of
 * the eye with the hands IK'd onto its grips. The arms therefore never swing
 * independently — a soldier's arms are locked to his rifle and the swing you
 * see is torso counter-rotation, which is what makes a rifle carry read as a
 * rifle carry rather than as a jog.
 *
 * Solved in "rig space" (the bot's own frame: +Z forward, origin at the feet)
 * so a planted foot is the only thing that needs a world round-trip.
 */

// ------------------------------------------------------------------ constants

const REST = {
  hips: restPos('hips'),
  spine: restPos('spine'),
  chest: restPos('chest'),
  neck: restPos('neck'),
  head: restPos('head'),
  shoulderL: restPos('shoulderL'), armL: restPos('armL'),
  forearmL: restPos('forearmL'), handL: restPos('handL'),
  shoulderR: restPos('shoulderR'), armR: restPos('armR'),
  forearmR: restPos('forearmR'), handR: restPos('handR'),
  thighL: restPos('thighL'), shinL: restPos('shinL'), footL: restPos('footL'), toeL: restPos('toeL'),
  thighR: restPos('thighR'), shinR: restPos('shinR'), footR: restPos('footR'), toeR: restPos('toeR'),
  weapon: restPos('weapon'),
};

const ANKLE_Y = REST.footL.y;                       // sole on the ground = ankle at this height
const LEG_MAX = (LIMB.thigh + LIMB.shin) * 0.985;
const ARM_MAX = (LIMB.upperArm + LIMB.forearm) * 0.995;
const HIP_HALF = LIMB.hipHalf;
// How far a rolled foot lifts and pulls its ankle back toward the hip.
const ROLL_LIFT = 0.118;
const ROLL_PULL = 0.07;

// Structural pose limits. These are not tuning values — they are the two
// constraints that make a T-pose unreachable rather than merely unlikely.
// An elbow may rise 0.42 rad above the shoulder plane; a wrist may sit 0.55 m
// to the side of the sternum. Both are generous for any real rifle carry.
const ELBOW_RISE = Math.sin(0.42);
const WRIST_LATERAL = 0.55;

// Standing hip height is deliberately 3.5 cm below the rest pose's 0.940. At
// 0.940 the leg is dead straight — the rig's hip-to-ankle distance is 0.841 and
// the drop from hip to ankle is 0.840 — so there is literally no fore-aft
// budget left and the first step drives the pelvis into a squat. A soldier
// stands with soft knees anyway.
const STANCE = {
  stand: { hip: 0.905, lean: 0.02, width: 1.00, eye: 1.630 },
  crouch: { hip: 0.645, lean: 0.24, width: 1.06, eye: 1.185 },
};

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

// Module scratch — the animator runs for every bot every frame and must not
// allocate a byte.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _g = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _eu = new THREE.Euler();

function damp(current, target, lambda, dt) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

function shortAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Critically-damped second-order spring. Used for anything that has weight:
 * hips, lean, aim. A lerp cannot overshoot and a body that never overshoots
 * reads as weightless.
 */
class Spring {
  constructor(value = 0, freq = 9) { this.x = value; this.v = 0; this.freq = freq; }
  step(target, dt) {
    const w = this.freq;
    const a = (target - this.x) * w * w - this.v * 2 * w;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

/** One foot's planting state. Plant positions are WORLD space. */
class Foot {
  constructor(side) {
    this.side = side;                       // -1 left, +1 right
    this.plant = new THREE.Vector3();       // where the sole is standing
    this.prev = new THREE.Vector3();        // where the swing came from
    this.target = new THREE.Vector3();      // where the swing is going
    this.pos = new THREE.Vector3();         // current sole position (world)
    this.plantYaw = 0;
    this.prevYaw = 0;
    this.targetYaw = 0;
    this.swinging = false;
    this.t = 0;
    this.duration = 0.3;
    this.lift = 0.08;
    this.pitch = 0;
    this.heel = 0;
    this.heelLift = 0;
    this.lead = 0;
    this.nx = 0;
    this.nz = 0;
  }
}

// One-shot so a genuinely broken pose reports itself once instead of filling
// the console at 60 Hz with the same line.
let _warned = false;

export class BotAnimator {
  /**
   * @param {Map<string, THREE.Bone>} bones  from `createSkeleton().byName`
   */
  constructor(bones) {
    this.bones = bones;
    this.feet = [new Foot(-1), new Foot(1)];
    this.phase = 0;
    this.hipSpring = new Spring(STANCE.stand.hip, 13);
    this.leanX = new Spring(0, 8);
    this.leanZ = new Spring(0, 8);
    this.aimBlend = new Spring(0, 7);
    this.crouchBlend = new Spring(0, 9);
    this.aimYaw = new Spring(0, 11);
    this.aimPitch = new Spring(0, 11);
    this.recoil = new Spring(0, 26);
    this.bobT = 0;
    this.speedSmooth = 0;
    // [left, right] wrist-to-grip error in metres; see `_solveArm`.
    this.gripMiss = new Float32Array(2);
    this.yaw = 0;
    this.prevYaw = 0;
    this.turnRate = 0;
    this.initialised = false;

    // Rig-space forward kinematics cache for the bones the solver needs.
    this._P = { hips: new THREE.Vector3(), spine: new THREE.Vector3(), chest: new THREE.Vector3() };
    this._Q = { hips: new THREE.Quaternion(), spine: new THREE.Quaternion(), chest: new THREE.Quaternion() };
    this._weaponP = new THREE.Vector3();
    this._weaponQ = new THREE.Quaternion();
    this._muzzle = new THREE.Vector3();
  }

  bone(name) { return this.bones.get(name); }

  /** Snap both feet under the bot; call on spawn and after a teleport. */
  reset(pos, yaw) {
    this.yaw = yaw;
    this.prevYaw = yaw;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    for (const f of this.feet) {
      const lx = f.side * HIP_HALF;
      // Offset fore/aft. Two feet exactly abreast is a degenerate state: both
      // want to step on the same frame forever, one always waits out the
      // other's swing, and the waiting foot ends up further behind than the
      // leg can reach. A natural stance breaks it permanently.
      const lz = f.side * 0.085;
      f.plant.set(pos.x + c * lx + s * lz, pos.y, pos.z - s * lx + c * lz);
      f.pos.copy(f.plant);
      f.prev.copy(f.plant);
      f.target.copy(f.plant);
      f.plantYaw = f.prevYaw = f.targetYaw = yaw;
      f.swinging = false;
      f.t = 0;
    }
    this.phase = 0.5;
    this.hipSpring.x = STANCE.stand.hip;
    this.hipSpring.v = 0;
    this.initialised = true;
  }

  /**
   * @param {object} s  bot state:
   *   pos (Vector3, feet, world), yaw, speed, velocity, crouch (0..1),
   *   aiming (0..1), aimPoint (Vector3|null), groundAt(x, z) -> y, dt
   */
  update(s) {
    const dt = Math.min(s.dt, 0.05);
    if (!this.initialised) this.reset(s.pos, s.yaw);

    this.prevYaw = this.yaw;
    this.yaw = s.yaw;
    this.turnRate = damp(this.turnRate, shortAngle(this.yaw - this.prevYaw) / Math.max(dt, 1e-4), 8, dt);
    this.speedSmooth = damp(this.speedSmooth, s.speed, 9, dt);

    const crouch = this.crouchBlend.step(s.crouch || 0, dt);
    const aim = this.aimBlend.step(s.aiming || 0, dt);

    // `frozen` holds the feet exactly where they are while everything above
    // them keeps solving — the screenshot harness needs a bot posed mid-stride
    // that does not walk out of frame between the pose and the shutter.
    if (!this.frozen) this._stepFeet(s, dt, crouch);
    this._solveBody(s, dt, crouch, aim);
    this._solveLegs(s, crouch);
    this._solveUpper(s, dt, crouch, aim);
  }

  // ----------------------------------------------------------------- footwork

  /**
   * The gait is driven by the feet themselves, not by a free-running phase
   * clock. A foot steps when it has been left more than half a stride behind
   * where the body wants it, and it lands half a stride ahead of where the body
   * will be when the swing ends. That is self-synchronising: the two feet fall
   * into alternation on their own, the rhythm tracks any speed change
   * instantly, and a planted foot can never be left further behind than the
   * legs can reach — which a phase clock cannot promise, and which shows up
   * immediately as a bot walking in a permanent squat.
   */
  _stepFeet(s, dt, crouch) {
    const st = crouch > 0.5 ? STANCE.crouch : STANCE.stand;
    const speed = this.speedSmooth;
    const running = speed > 2.2;
    // 0.75 m step at a 1.4 m/s walk, 1.25 m at a 4.5 m/s run.
    const stride = THREE.MathUtils.clamp(0.46 + speed * 0.175, 0.42, 1.28) * (1 - crouch * 0.28);
    const swingTime = THREE.MathUtils.clamp(0.38 - speed * 0.020, 0.26, 0.38);
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const invSpeed = speed > 1e-3 ? 1 / speed : 0;

    if (speed > 0.12) this.phase += (speed * dt) / (2 * stride);
    this.phase -= Math.floor(this.phase);

    let swinging = -1;
    let want = -1, wantErr = 0;

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const lx = f.side * HIP_HALF * st.width;
      f.nx = s.pos.x + c * lx;
      f.nz = s.pos.z - sn * lx;

      if (f.swinging) {
        swinging = i;
        f.t += dt / f.duration;
        if (f.t >= 1) {
          f.t = 1;
          f.swinging = false;
          swinging = -1;
          f.plant.copy(f.target);
          f.plantYaw = f.targetYaw;
          // Keep the cosmetic phase (weapon bob) locked to real footfalls.
          this.phase = f.side < 0 ? 0.0 : 0.5;
          if (s.onFootDown) s.onFootDown(f, speed);
        } else {
          const t = f.t;
          // Ease-out horizontally so the foot decelerates into the plant, and a
          // sine arc vertically. Both separate a step from a slide.
          const e = t * t * (3 - 2 * t);
          const eo = 1 - (1 - t) * (1 - t);
          f.pos.lerpVectors(f.prev, f.target, eo);
          f.pos.y = THREE.MathUtils.lerp(f.prev.y, f.target.y, e) + Math.sin(Math.PI * t) * f.lift;
          // Carry the raised heel into the first third of the swing: the foot
          // rolls off the toe rather than snapping flat, and without it the
          // ankle target drops 9 cm on the frame the foot lifts, which the leg
          // cannot reach and which pops.
          f.heel = f.heelLift * Math.max(0, 1 - t / 0.34);
          // Dorsiflex through the rest of the swing so the toe clears the
          // ground, then land heel first. Positive pitch is toe-down.
          f.pitch = f.heel * 0.62 - Math.sin(Math.PI * t) * (running ? 0.42 : 0.26);
          continue;
        }
      }

      f.pos.copy(f.plant);
      // Toe-off: `heel` is set by the hip solver when the leg runs out of reach.
      f.pitch = damp(f.pitch, f.heel * (f.lead < 0 ? 0.75 : -0.42), 16, dt);

      const err = Math.hypot(f.plant.x - f.nx, f.plant.z - f.nz);
      const yawErr = Math.abs(shortAngle(f.plantYaw - this.yaw));
      const threshold = THREE.MathUtils.clamp(stride * 0.5, 0.26, 0.42);
      const score = err / threshold + yawErr / 0.5;
      if (score > 1 && score > wantErr) { want = i; wantErr = score; }
    }

    // One foot on the ground at a time, except in a run, where a brief flight
    // phase is correct and is most of what makes a run read as a run.
    if (want < 0) return;
    if (swinging >= 0) {
      const other = this.feet[swinging];
      // Overlap is allowed late in a swing (a run's flight phase), and forced
      // when the waiting foot has been left further behind than the leg can
      // reach — a stalled step is what makes a bot walk in a squat.
      const lag = Math.hypot(this.feet[want].plant.x - this.feet[want].nx,
        this.feet[want].plant.z - this.feet[want].nz);
      if (other.t > (running ? 0.55 : 0.80) || lag > 0.46) {
        // fall through and start the second swing
      } else if (lag > 0.50 && other.t > 0.40) {
        other.t = 1;
        other.swinging = false;
        other.plant.copy(other.target);
        other.pos.copy(other.target);
        other.plantYaw = other.targetYaw;
      } else {
        return;
      }
    }

    const f = this.feet[want];
    f.prev.copy(f.pos);
    f.prevYaw = f.plantYaw;
    // Land half a stride ahead of where the body will be at touchdown — but
    // never further ahead than the leg can reach, or the pelvis has to dive to
    // meet the foot on the frame it lands. At a run the extra step length comes
    // out of the flight phase instead, which is where it comes from in life.
    // The landing offset has to stay clear of the step trigger, or the foot
    // arrives already past the threshold and re-triggers on the frame it lands.
    const ahead = speed > 0.3
      ? swingTime + Math.min(stride * 0.42, 0.30) * invSpeed
      : 0;
    f.target.set(
      f.nx + s.velocity.x * ahead,
      s.pos.y,
      f.nz + s.velocity.z * ahead,
    );
    f.target.y = s.groundAt ? s.groundAt(f.target.x, f.target.z, s.pos.y) : s.pos.y;
    f.targetYaw = this.yaw;
    f.duration = swingTime;
    f.lift = 0.04 + speed * 0.026 + Math.abs(f.target.y - f.prev.y) * 0.6;
    f.t = 0;
    f.heelLift = f.heel;
    f.swinging = true;
  }

  // ------------------------------------------------------------------ torso

  _solveBody(s, dt, crouch, aim) {
    const st = crouch > 0.5 ? STANCE.crouch : STANCE.stand;
    const speed = this.speedSmooth;
    const hipBase = THREE.MathUtils.lerp(STANCE.stand.hip, STANCE.crouch.hip, crouch);

    // Every gait quantity below is read off the feet rather than off a clock,
    // so the bob, the weight shift and the pelvic rotation cannot drift out of
    // sync with the steps that are actually happening.
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const fL = this.feet[0], fR = this.feet[1];
    const supL = fL.swinging ? THREE.MathUtils.smoothstep(fL.t, 0.72, 1) : 1;
    const supR = fR.swinging ? THREE.MathUtils.smoothstep(fR.t, 0.72, 1) : 1;
    const supSum = supL + supR + 1e-3;
    const lxL = (fL.pos.x - s.pos.x) * c - (fL.pos.z - s.pos.z) * sn;
    const lzL = (fL.pos.x - s.pos.x) * sn + (fL.pos.z - s.pos.z) * c;
    const lxR = (fR.pos.x - s.pos.x) * c - (fR.pos.z - s.pos.z) * sn;
    const lzR = (fR.pos.x - s.pos.x) * sn + (fR.pos.z - s.pos.z) * c;
    const spread = Math.hypot(lxL - lxR, lzL - lzR);
    fL.lead = lzL; fR.lead = lzR;

    // The pelvis is lowest when the feet are furthest apart — that IS the bob.
    let hipTarget = s.pos.y + hipBase - Math.min(Math.max(spread - 0.2, 0) * 0.075, 0.06);

    // Hip height is then whatever the legs can actually reach. Two things do
    // the work at full stride, and without both the ankle IK simply cannot
    // touch its target and the foot floats:
    //   - the pelvis drops, exactly as a real one does at double support;
    //   - the trailing heel comes off the ground, which buys back ~8 cm of
    //     reach and is the single most recognisable moment in a walk cycle.
    for (let pass = 0; pass < 2; pass++) {
      for (const f of this.feet) {
        if (f.swinging) continue;   // its heel is driven by the swing roll-off
        const lx = f.side * HIP_HALF;
        const jx = s.pos.x + c * lx, jz = s.pos.z - sn * lx;
        const dxz = Math.hypot(f.pos.x - jx, f.pos.z - jz);
        const vert = Math.sqrt(Math.max(LEG_MAX * LEG_MAX - dxz * dxz, 0.02));
        let limit = f.pos.y + ANKLE_Y + vert + (REST.hips.y - REST.thighL.y);
        // Contact roll, demand-driven: the foot only comes off flat when the
        // leg is running out of reach, and it rolls the way the geometry
        // wants — onto the toe behind the body, onto the heel in front of it.
        f.heel = THREE.MathUtils.clamp((hipTarget - limit) / 0.14, 0, 1);
        limit += f.heel * ROLL_LIFT;
        hipTarget = Math.min(hipTarget, Math.max(limit, f.pos.y + 0.46));
      }
    }
    this.hipSpring.step(hipTarget, dt);

    // Lean: forward into acceleration and speed, inward into a turn.
    const leanPitch = st.lean + Math.min(speed * 0.055, 0.26) + crouch * 0.06;
    const leanRoll = THREE.MathUtils.clamp(-this.turnRate * 0.10 * Math.min(speed, 4) / 4, -0.16, 0.16);
    this.leanX.step(leanPitch, dt);
    this.leanZ.step(leanRoll, dt);

    const hips = this.bone('hips');
    // Pelvic list: the swing-side hip drops. Pelvic yaw: the forward leg pulls
    // its hip forward. The shoulders then counter-rotate against both. All
    // three are small and all three are load-bearing.
    const list = -(supL - supR) * 0.075;
    const pelvisYaw = THREE.MathUtils.clamp(-(lzR - lzL) * 0.24, -0.22, 0.22);
    const sway = (lxL * supL + lxR * supR) / supSum * 0.34;

    hips.position.set(
      sway * (1 - crouch * 0.4),
      this.hipSpring.x - s.pos.y,
      -0.02 - crouch * 0.05 - Math.min(speed * 0.012, 0.05),
    );
    _eu.set(this.leanX.x * 0.45, pelvisYaw, this.leanZ.x + list, 'YXZ');
    hips.quaternion.setFromEuler(_eu);
    this._P.hips.copy(hips.position);
    this._Q.hips.copy(hips.quaternion);

    // Spine and chest carry the rest of the lean plus the counter-rotation.
    const spine = this.bone('spine');
    _eu.set(this.leanX.x * 0.30, -pelvisYaw * 0.55, this.leanZ.x * 0.4 - list * 0.4, 'YXZ');
    spine.quaternion.setFromEuler(_eu);
    fk(this._P.hips, this._Q.hips, REST.hips, REST.spine, spine.quaternion, this._P.spine, this._Q.spine);

    // Torso twist toward the aim, so a bot walking one way while watching
    // another is not a mannequin bolted to its hips.
    const twist = THREE.MathUtils.clamp(shortAngle((s.aimYaw ?? this.yaw) - this.yaw), -0.9, 0.9);
    const chest = this.bone('chest');
    _eu.set(
      this.leanX.x * 0.25 - aim * 0.05,
      -pelvisYaw * 0.9 + twist * 0.55 + aim * 0.16,
      this.leanZ.x * 0.3 - list * 0.3,
      'YXZ',
    );
    chest.quaternion.setFromEuler(_eu);
    fk(this._P.spine, this._Q.spine, REST.spine, REST.chest, chest.quaternion, this._P.chest, this._Q.chest);
    this._twist = twist;
  }

  // ------------------------------------------------------------------- legs

  _solveLegs(s, crouch) {
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    for (const f of this.feet) {
      const S = f.side < 0 ? 'L' : 'R';
      // Sole (world) -> ankle target (rig space). A raised heel pivots the
      // ankle up and forward over the ball of the foot.
      const wx = f.pos.x - s.pos.x, wz = f.pos.z - s.pos.z;
      const heel = f.heel;
      const yawRel0 = shortAngle(f.plantYaw - this.yaw);
      // Rolling onto the toe (or the heel) lifts the ankle and pulls it back
      // toward the hip; `f.lead` is the signed fore-aft offset that decides
      // which end of the foot is still on the ground.
      const roll = heel * ROLL_PULL * (f.lead < 0 ? 1 : -1);
      _a.set(
        c * wx - sn * wz,
        f.pos.y - s.pos.y + ANKLE_Y + heel * ROLL_LIFT,
        sn * wx + c * wz + roll,
      );

      const thighRest = f.side < 0 ? REST.thighL : REST.thighR;
      _b.copy(thighRest).sub(REST.hips).applyQuaternion(this._Q.hips).add(this._P.hips);

      // Guarantee the target is reachable, and do it by RAISING the ankle
      // rather than by pulling it in. Horizontal position is the only thing a
      // viewer can see sliding; two centimetres of lift at the extreme of a
      // stride is invisible and reads as the heel coming up anyway. Without
      // this the two-bone solver clamps, the foot falls short of its plant by
      // a varying amount, and the shortfall drags across the ground.
      const dxz2 = (_a.x - _b.x) * (_a.x - _b.x) + (_a.z - _b.z) * (_a.z - _b.z);
      if (dxz2 + (_a.y - _b.y) * (_a.y - _b.y) > LEG_MAX * LEG_MAX) {
        if (dxz2 < LEG_MAX * LEG_MAX * 0.98) {
          _a.y = _b.y - Math.sqrt(LEG_MAX * LEG_MAX - dxz2);
        } else {
          const k = (LEG_MAX * 0.99) / Math.sqrt(dxz2);
          _a.x = _b.x + (_a.x - _b.x) * k;
          _a.z = _b.z + (_a.z - _b.z) * k;
          _a.y = _b.y;
        }
      }

      // Knee points forward, opened out in a crouch and rolled with the lean.
      _c.set(f.side * (0.17 + crouch * 0.16), 0.05, 1).normalize();
      solveTwoBone(_b, _a, LIMB.thigh, LIMB.shin, _c, _d, _e);

      const thigh = this.bone('thigh' + S);
      const shin = this.bone('shin' + S);
      const foot = this.bone('foot' + S);

      _f.copy(f.side < 0 ? REST.shinL : REST.shinR).sub(thighRest).normalize();
      _q0.setFromUnitVectors(_f, _d);                       // thigh, rig space
      _q1.copy(this._Q.hips).invert().multiply(_q0);
      thigh.quaternion.copy(_q1);

      _f.copy(f.side < 0 ? REST.footL : REST.footR)
        .sub(f.side < 0 ? REST.shinL : REST.shinR).normalize();
      _q2.setFromUnitVectors(_f, _e);                       // shin, rig space
      _q1.copy(_q0).invert().multiply(_q2);
      shin.quaternion.copy(_q1);

      // The ankle is solved in rig space, not relative to the shin, so the sole
      // stays flat on the ground whatever the leg is doing.
      const yawRel = shortAngle(f.plantYaw - this.yaw) * (f.swinging ? 1 - f.t : 1);
      _eu.set(f.pitch, yawRel, 0, 'YXZ');
      _q3.setFromEuler(_eu);
      _q1.copy(_q2).invert().multiply(_q3);
      foot.quaternion.copy(_q1);
      const toe = this.bone('toe' + S);
      _eu.set(Math.max(0, -f.pitch) * 0.8 + (f.swinging ? 0 : 0.02), 0, 0, 'YXZ');
      toe.quaternion.setFromEuler(_eu);
    }
  }

  // ------------------------------------------------- weapon, arms, head

  _solveUpper(s, dt, crouch, aim) {
    const speed = this.speedSmooth;
    const gait = this.phase * Math.PI * 2;
    const recoil = this.recoil.step(0, dt);

    // Aim direction in rig space.
    const hipDrop = this.hipSpring.x - s.pos.y -
      THREE.MathUtils.lerp(STANCE.stand.hip, STANCE.crouch.hip, crouch);
    const eyeY = THREE.MathUtils.lerp(STANCE.stand.eye, STANCE.crouch.eye, crouch) + hipDrop;
    _g.set(0, eyeY - 0.02, 0.06);                     // eye, rig space
    if (s.aimPoint) {
      const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
      const wx = s.aimPoint.x - s.pos.x, wz = s.aimPoint.z - s.pos.z;
      _a.set(c * wx - sn * wz, s.aimPoint.y - s.pos.y, sn * wx + c * wz).sub(_g);
      if (_a.lengthSq() < 1e-6) _a.set(0, 0, 1);
      _a.normalize();
    } else {
      _a.set(0, -0.05, 1).normalize();
    }
    const wantYaw = Math.atan2(_a.x, _a.z);
    const wantPitch = Math.asin(THREE.MathUtils.clamp(_a.y, -1, 1));
    this.aimYaw.step(THREE.MathUtils.clamp(wantYaw, -1.25, 1.25), dt);
    this.aimPitch.step(THREE.MathUtils.clamp(wantPitch, -0.85, 0.7), dt);
    const ay = this.aimYaw.x, ap = this.aimPitch.x;
    _a.set(Math.sin(ay) * Math.cos(ap), Math.sin(ap), Math.cos(ay) * Math.cos(ap));

    // ---- weapon placement -------------------------------------------------
    // Aimed: the sight sits a cheek-weld in front of the eye and the bore is
    // on the aim line, so the head, the optic and the shot all agree.
    // Low ready: the weapon drops and cants, muzzle down and out.
    lookQuat(_a, _q0);                                    // bore -> aim, rig space
    const bobY = Math.sin(gait * 2) * 0.010 * Math.min(speed / 3, 1);
    const bobX = Math.sin(gait) * 0.016 * Math.min(speed / 3, 1);

    _b.copy(_g).addScaledVector(_a, 0.235 - recoil * 0.06);   // sight target
    _b.x += 0.030 + bobX * 0.4;
    _b.y += bobY;
    _c.copy(SIGHT).applyQuaternion(_q0);
    _b.sub(_c);                                              // aimed weapon origin

    // The UNAIMED carry. Authored as an explicit bore direction rather than as
    // an euler triple, because the weapon's forward is +Z and a positive X
    // euler tips +Z DOWNWARD — the pose this replaces asked for "muzzle down"
    // and got 26 degrees of muzzle UP.
    //
    // Two carries, and the pose is forced rather than blended toward rest: a
    // bot that is not aiming still has both hands on the weapon, always.
    if (s.carry === 'high-port') {
      // Weapon at 62 degrees muzzle-up, held high across the chest so the
      // barrel crosses the head silhouette on a diagonal. That single dark bar
      // is most of what makes mw3_05's runner read instantly as a soldier.
      boreQuat(1.082, ay * 0.25 - 0.35, 0.34, _q1);
      _d.set(0.020 + bobX, 1.300 - crouch * 0.16 + bobY, 0.160);
    } else {
      // Low ready: muzzle depressed 25 degrees and swung 15 degrees across the
      // body, carried far enough forward that the arms extend rather than fold.
      boreQuat(-0.436 + ap * 0.30, ay * 0.50 - 0.262, 0.24, _q1);
      _d.set(0.120 + bobX, 1.075 - crouch * 0.19 + bobY, 0.285 - crouch * 0.02);
    }
    _d.y += this.hipSpring.x - s.pos.y - STANCE.stand.hip;

    // Snap rather than mush: below 0.35 the carry is fully committed, above
    // 0.85 the sights are fully up, and the transition happens in between. A
    // linear blend leaves a bot at aim 0.25 holding the rifle in a pose that is
    // neither, which reads as a mannequin being posed by a level editor.
    const carry = THREE.MathUtils.smoothstep(aim, 0.35, 0.85);
    this._weaponP.lerpVectors(_d, _b, carry);
    this._weaponQ.copy(_q1).slerp(_q0, carry);
    // Recoil: straight back down the bore, with a muzzle rise.
    this._weaponP.addScaledVector(_a, -recoil * 0.055);
    _eu.set(-recoil * 0.22, 0, 0, 'YXZ');
    _q2.setFromEuler(_eu);
    this._weaponQ.multiply(_q2);

    const weapon = this.bone('weapon');
    _q3.copy(this._Q.chest).invert();
    weapon.position.copy(this._weaponP).sub(this._P.chest).applyQuaternion(_q3);
    weapon.quaternion.copy(_q3).multiply(this._weaponQ);

    // ---- head: eyes on the aim line --------------------------------------
    const headYaw = shortAngle(ay - this._twist * 0.55);
    const neck = this.bone('neck');
    const head = this.bone('head');
    _eu.set(ap * 0.30 - 0.02, headYaw * 0.38, 0, 'YXZ');
    neck.quaternion.setFromEuler(_eu);
    _eu.set(ap * 0.55 + aim * 0.10, headYaw * 0.62, aim * 0.13, 'YXZ');
    head.quaternion.setFromEuler(_eu);

    // ---- arms: hands onto the grips --------------------------------------
    this._solveArm('R', GRIP_R, aim, crouch);
    this._solveArm('L', GRIP_L, aim, crouch);
  }

  /**
   * Clavicle + two-bone arm IK onto a grip point on the weapon. The clavicle
   * protracts toward the target, which is both what a shoulder actually does
   * and what buys the support arm the ~5 cm of reach it needs to hold a
   * shouldered rifle without the elbow locking straight.
   */
  _solveArm(S, grip, aim, crouch) {
    const left = S === 'L';
    _a.copy(grip).applyQuaternion(this._weaponQ).add(this._weaponP);  // grip, rig

    // WRIST LATERAL LIMIT. A hand may never be further than 0.55 m to the side
    // of the sternum. Every T-pose this rig has ever produced started with a
    // grip target that had wandered out past the shoulder, and clamping the
    // TARGET is the only place the constraint can be enforced without fighting
    // the analytic solver.
    const lateral = _a.x - this._P.chest.x;
    if (Math.abs(lateral) > WRIST_LATERAL) {
      _a.x = this._P.chest.x + Math.sign(lateral) * WRIST_LATERAL;
    }

    const shoulderRest = left ? REST.shoulderL : REST.shoulderR;
    const armRest = left ? REST.armL : REST.armR;
    _b.copy(shoulderRest).sub(REST.chest).applyQuaternion(this._Q.chest).add(this._P.chest);

    // Protraction: swing the clavicle toward the grip, capped hard.
    _c.copy(_a).sub(_b);
    const reach = _c.length();
    const slack = THREE.MathUtils.clamp((reach - ARM_MAX * 0.82) / (ARM_MAX * 0.35), 0, 1);
    const prot = slack * (left ? 0.55 : 0.30) * (0.4 + aim * 0.6);
    const clav = this.bone('shoulder' + S);
    // Roll sign matters: on the left clavicle (-X) a negative Z rotation
    // lifts the shoulder, and two shrugging shoulders read as a surrender.
    _eu.set(-slack * 0.12, left ? prot : -prot, left ? prot * 0.30 : -prot * 0.30, 'YXZ');
    clav.quaternion.setFromEuler(_eu);

    _q0.copy(this._Q.chest).multiply(clav.quaternion);               // clavicle, rig
    _b.copy(armRest).sub(shoulderRest).applyQuaternion(_q0);
    _d.copy(shoulderRest).sub(REST.chest).applyQuaternion(this._Q.chest).add(this._P.chest).add(_b);

    // Elbow hangs. The pole has to be dominated by -Y: with a grip close to
    // the chest a laterally-weighted pole throws both elbows out horizontally
    // and the bot reads as a scarecrow, which is exactly what it did.
    _c.set(left ? -0.26 : 0.30, -1.0, -0.30 + crouch * 0.1).normalize();
    solveTwoBone(_d, _a, LIMB.upperArm, LIMB.forearm, _c, _e, _f);
    // ELBOW CEILING. The pole vector makes a splayed elbow unlikely; this makes
    // it impossible. The elbow is rolled about the shoulder-to-grip axis until
    // it is back under the ceiling, which is the one degree of freedom a
    // two-bone solve has left and therefore the only correction that does not
    // move the hand off the grip.
    clampElbowRise(_d, _a, _e, _f, LIMB.upperArm, ELBOW_RISE);

    // How far the wrist actually ended up from the grip it was asked to hold.
    // Free — the solved directions are already here — and it is the assertion
    // that a forced low-ready really does keep both hands on the weapon.
    _g.copy(_d).addScaledVector(_e, LIMB.upperArm).addScaledVector(_f, LIMB.forearm);
    this.gripMiss[left ? 0 : 1] = _g.distanceTo(_a);
    if (BotAnimator.assertPose && this.gripMiss[left ? 0 : 1] > 0.35 && !_warned) {
      _warned = true;
      console.warn('[BotAnimator] hand %s is %s m off the weapon centreline',
        S, this.gripMiss[left ? 0 : 1].toFixed(3));
    }

    const arm = this.bone('arm' + S);
    const fore = this.bone('forearm' + S);
    const hand = this.bone('hand' + S);
    _g.copy(left ? REST.forearmL : REST.forearmR).sub(armRest).normalize();
    _q1.setFromUnitVectors(_g, _e);
    _q2.copy(_q0).invert().multiply(_q1);
    arm.quaternion.copy(_q2);

    _g.copy(left ? REST.handL : REST.handR).sub(left ? REST.forearmL : REST.forearmR).normalize();
    _q2.setFromUnitVectors(_g, _f);
    _q3.copy(_q1).invert().multiply(_q2);
    fore.quaternion.copy(_q3);

    // Wrist: roll the hand onto the grip so the knuckles face the weapon.
    // Set outright rather than smoothed — a wrist that integrates its own
    // offset every frame walks off to a fixed point that is not the pose.
    _q3.copy(_q2).invert().multiply(this._weaponQ);
    _eu.set(left ? -0.35 : -0.5, 0, left ? 0.5 : -0.35, 'YXZ');
    _q1.setFromEuler(_eu);
    hand.quaternion.copy(_q3).multiply(_q1);
  }

  /** Kick the weapon on a shot. */
  fire(strength = 1) {
    this.recoil.x += 0.55 * strength;
    this.recoil.v += 5.5 * strength;
  }

  /** Muzzle position in world space (needs the pivot transform). */
  muzzleWorld(pos, yaw, muzzleLocal, out) {
    _a.copy(muzzleLocal).applyQuaternion(this._weaponQ).add(this._weaponP);
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    out.set(pos.x + c * _a.x + sn * _a.z, pos.y + _a.y, pos.z - sn * _a.x + c * _a.z);
    return out;
  }
}

/** Opt-in pose assertion; off by default because it costs a branch per arm. */
BotAnimator.assertPose = false;

// -------------------------------------------------------------------- helpers

/** Forward kinematics for one bone with an unmodified rest offset. */
function fk(parentP, parentQ, parentRest, childRest, localQ, outP, outQ) {
  outP.copy(childRest).sub(parentRest).applyQuaternion(parentQ).add(parentP);
  outQ.copy(parentQ).multiply(localQ);
}

const _ik0 = new THREE.Vector3();
const _ik1 = new THREE.Vector3();
const _ik2 = new THREE.Vector3();
const _ikq = new THREE.Quaternion();

/**
 * Two-bone analytic IK. Writes unit directions for the upper and lower segment
 * into `outUpper` / `outLower`. Out-of-reach targets straighten the limb rather
 * than failing, which is both stable and what a real limb does.
 */
export function solveTwoBone(root, target, l1, l2, pole, outUpper, outLower) {
  _ik0.copy(target).sub(root);
  let len = _ik0.length();
  if (len < 1e-5) { _ik0.set(0, -1, 0); len = 1; }
  _ik0.multiplyScalar(1 / len);
  const maxLen = (l1 + l2) * 0.999;
  const minLen = Math.abs(l1 - l2) * 1.001 + 1e-4;
  len = THREE.MathUtils.clamp(len, minLen, maxLen);

  const cosA = THREE.MathUtils.clamp((l1 * l1 + len * len - l2 * l2) / (2 * l1 * len), -1, 1);
  const alpha = Math.acos(cosA);

  _ik1.crossVectors(_ik0, pole);
  if (_ik1.lengthSq() < 1e-8) {
    _ik1.crossVectors(_ik0, Math.abs(_ik0.y) > 0.95 ? FWD : UP);
    if (_ik1.lengthSq() < 1e-8) _ik1.set(1, 0, 0);
  }
  _ik1.normalize();
  _ikq.setFromAxisAngle(_ik1, alpha);
  outUpper.copy(_ik0).applyQuaternion(_ikq).normalize();
  _ik2.copy(root).addScaledVector(outUpper, l1);
  outLower.copy(target).sub(_ik2);
  if (outLower.lengthSq() < 1e-8) outLower.copy(outUpper);
  outLower.normalize();
}

const _cl0 = new THREE.Vector3();
const _cl1 = new THREE.Vector3();
const _cl2 = new THREE.Vector3();

/**
 * Roll a solved elbow about the shoulder-to-grip axis until it sits no higher
 * than `maxRise` (as sin of the angle above the shoulder plane).
 *
 * The two-bone solve fixes the elbow's distance from both ends; the only thing
 * still free is where it sits on the circle round the root-to-target axis. So
 * the correction is exactly a rotation about that axis, which means the hand
 * cannot move and the segment lengths cannot change — the constraint is
 * satisfied without perturbing anything else. Writing `upper` also requires
 * re-deriving `lower`, since the elbow has moved.
 */
function clampElbowRise(root, target, upper, lower, l1, maxRise) {
  if (upper.y <= maxRise) return;
  _cl0.copy(target).sub(root);
  const len = _cl0.length();
  if (len < 1e-6) return;
  _cl0.multiplyScalar(1 / len);                     // axis
  const along = upper.dot(_cl0);
  _cl1.copy(upper).addScaledVector(_cl0, -along);   // perpendicular component
  _cl2.crossVectors(_cl0, _cl1);                    // its quarter turn
  // upper.y after rotating by t is A cos t + B sin t + axis.y * along.
  const A = _cl1.y, B = _cl2.y;
  const m = maxRise - _cl0.y * along;
  const R = Math.hypot(A, B);
  if (R < 1e-9) return;
  const phase = Math.atan2(B, A);
  const c = THREE.MathUtils.clamp(m / R, -1, 1);
  const d = Math.acos(c);
  // Two solutions; take whichever is the smaller correction.
  let t = shortAngle(phase + d);
  const t2 = shortAngle(phase - d);
  if (Math.abs(t2) < Math.abs(t)) t = t2;
  const ct = Math.cos(t), st = Math.sin(t);
  upper.set(
    _cl0.x * along + _cl1.x * ct + _cl2.x * st,
    _cl0.y * along + _cl1.y * ct + _cl2.y * st,
    _cl0.z * along + _cl1.z * ct + _cl2.z * st,
  ).normalize();
  lower.copy(target).sub(root).addScaledVector(upper, -l1);
  if (lower.lengthSq() < 1e-10) lower.copy(upper);
  lower.normalize();
}

const _bq = new THREE.Vector3();

/**
 * Orientation whose bore (+Z) is `pitch` above horizontal and `yaw` to the
 * left, with `roll` of cant. Positive pitch is muzzle UP, which an euler triple
 * on this rig is not.
 */
function boreQuat(pitch, yaw, roll, out) {
  const cp = Math.cos(pitch);
  _bq.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
  lookQuat(_bq, out);
  if (roll) {
    _eu.set(0, 0, roll, 'YXZ');
    out.multiply(_q3.setFromEuler(_eu));
  }
  return out;
}

const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _lm = new THREE.Matrix4();

/** Quaternion whose +Z axis is `dir`, with world up as the roll reference. */
function lookQuat(dir, out) {
  _lx.crossVectors(UP, dir);
  if (_lx.lengthSq() < 1e-6) _lx.set(1, 0, 0);
  _lx.normalize();
  _ly.crossVectors(dir, _lx);
  _lm.makeBasis(_lx, _ly, dir);
  return out.setFromRotationMatrix(_lm);
}
