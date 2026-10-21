import * as THREE from 'three';
import { PlayerConfig } from './PlayerConfig.js';
import { Spring1, Spring3, ValueNoise, approach, clamp, lerp, deg } from './Springs.js';

/**
 * Procedural, purely additive head motion. Nothing here moves the player — it
 * only produces an offset/rotation the camera rig adds on top of the simulated
 * eye transform, so any single term can be weighted to zero without changing
 * how the character handles.
 *
 * Every term is either spring-driven or driven by a continuous curve (lissajous
 * bob, smooth value noise), never a raw sine sampled straight into the camera:
 * that is what keeps state changes — starting to sprint, landing mid-stride,
 * ADSing while strafing — from stepping the view.
 *
 * The stride phase is authoritative for footsteps: audio and FX subscribe to
 * `player:footstep`, which fires exactly at the bottom of the bob, so sound and
 * camera stay locked together at any speed.
 */

const _v = new THREE.Vector3();
const V = PlayerConfig.view;

export class ViewMotion {
  constructor() {
    this.offset = new THREE.Vector3();
    this.pitch = 0;
    this.yaw = 0;
    this.roll = 0;

    this.bobSpring = new Spring3(V.bob.freq, V.bob.zeta);
    this.lagSpring = new Spring3(V.lag.freq, V.lag.zeta);
    this.landSpring = new Spring1(V.land.freq, V.land.zeta);
    this.landPitch = new Spring1(V.land.freq * 1.15, V.land.zeta + 0.08);
    this.rollSpring = new Spring1(V.roll.freq, V.roll.zeta);
    this.leanSpring = new Spring1(V.lean.freq, V.lean.zeta);
    this.recoilPitch = new Spring1(V.recoil.freq, V.recoil.zeta);
    this.recoilYaw = new Spring1(V.recoil.freq * 0.9, V.recoil.zeta + 0.05);
    this.hitPitch = new Spring1(5.2, 0.45);
    this.hitYaw = new Spring1(4.8, 0.45);

    this.noise = new ValueNoise(9173);
    this.adsNoise = new ValueNoise(4421);

    this.phase = 0;
    this._stepIndex = 0;
    this.bobPitch = 0;
    this.bobRoll = 0;
    this.bobYaw = 0;

    this.moveW = 0;
    this.sprintW = 0;
    this.airW = 0;
    this.leanOffset = 0;

    this._retainPitch = 0;
    this._retainYaw = 0;
    this._yawRate = 0;
    this._pitchRate = 0;
    this._prevVel = new THREE.Vector3();
    this._accel = new THREE.Vector3();
    this._t = 0;

    this.onFootstep = null;
  }

  applyRecoil(pitchKick, yawKick) {
    const r = V.recoil;
    this.recoilPitch.value += pitchKick;
    this.recoilPitch.velocity += pitchKick * r.kickVel;
    this.recoilYaw.value += yawKick;
    this.recoilYaw.velocity += yawKick * r.kickVel;
    const cap = deg(r.maxRetainDeg);
    this._retainPitch = clamp(this._retainPitch + pitchKick * r.retain, -cap, cap);
    this._retainYaw = clamp(this._retainYaw + yawKick * r.retain, -cap * 0.5, cap * 0.5);
  }

  applyHit(pitchKick, yawKick) {
    this.hitPitch.impulse(pitchKick * 12);
    this.hitYaw.impulse(yawKick * 12);
  }

  /**
   * Impulse, not displacement: the dip has to build over ~70 ms or it reads as a
   * teleport. The 1.8 factor converts the intended peak into the launch velocity
   * an underdamped spring needs to actually reach it.
   */
  land(impactSpeed) {
    const l = V.land;
    const dip = Math.min(l.max, impactSpeed * l.perSpeed);
    this.landSpring.impulse(-dip * (Math.PI * 2 * l.freq) * 1.8);
    const p = Math.min(deg(l.pitchMax), deg(impactSpeed * l.pitchPerSpeed));
    this.landPitch.impulse(p * (Math.PI * 2 * l.freq * 1.15) * 1.7);
  }

  reset() {
    this.bobSpring.reset();
    this.lagSpring.reset();
    this.landSpring.reset();
    this.landPitch.reset();
    this.rollSpring.reset();
    this.leanSpring.reset();
    this.recoilPitch.reset();
    this.recoilYaw.reset();
    this.hitPitch.reset();
    this.hitYaw.reset();
    this._retainPitch = 0;
    this._retainYaw = 0;
    this.offset.set(0, 0, 0);
    this.pitch = this.yaw = this.roll = 0;
    this.moveW = this.sprintW = this.airW = 0;
    this._prevVel.set(0, 0, 0);
  }

  /**
   * @param s snapshot of player state for this frame, reused by the caller.
   */
  update(dt, s) {
    this._t += dt;
    const t = this._t;

    this._advanceStride(dt, s);
    this._springTargets(dt, s);

    this.bobSpring.update(dt);
    this.lagSpring.update(dt);
    this.landSpring.update(dt);
    this.landPitch.update(dt);
    this.rollSpring.update(dt);
    this.leanSpring.update(dt);
    this.recoilPitch.update(dt);
    this.recoilYaw.update(dt);
    this.hitPitch.update(dt);
    this.hitYaw.update(dt);

    const decay = Math.exp(-V.recoil.retainDecay * dt);
    this._retainPitch *= decay;
    this._retainYaw *= decay;
    this.recoilPitch.target = this._retainPitch;
    this.recoilYaw.target = this._retainYaw;

    // Idle breathing: slow noise, amplified as stamina runs out so a winded
    // player visibly cannot hold a sight picture.
    const idleW = clamp(1 - this.moveW * 1.35, 0, 1);
    const winded = 1 + (1 - s.stamina01) * (1 - s.stamina01) * V.breath.staminaGain;
    const br = V.breath;
    const bn1 = this.noise.fbm(t * br.rate);
    const bn2 = this.noise.fbm(t * br.rate * 0.83 + 53.7);
    const breathW = idleW * winded * (1 - s.adsW * 0.55);
    const bx = bn1 * br.amp * breathW;
    const by = bn2 * br.amp * 0.8 * breathW;

    // ADS micro-sway: tighter and faster than breathing, killed by held breath.
    const a = V.ads;
    const hb = s.holdBreath ? a.holdBreathMul : 1;
    const adsAmp = s.adsW * hb * winded;
    const an1 = this.adsNoise.fbm(t * a.rate);
    const an2 = this.adsNoise.fbm(t * a.rate * 1.27 + 19.1);
    const adsPitch = an1 * deg(a.pitchDeg) * adsAmp;
    const adsYaw = an2 * deg(a.yawDeg) * adsAmp;

    const lag = this.lagSpring.value;
    const lean = this.leanSpring.value;
    this.leanOffset = lean * s.leanLimit;

    const bob = this.bobSpring.value;
    this.offset.set(
      bob.x + lag.x + bx + this.leanOffset,
      bob.y + lag.y + by + this.landSpring.value + s.crouchDip,
      bob.z + lag.z,
    );

    this.pitch = this.recoilPitch.value + this.hitPitch.value + this.landPitch.value
      + this.bobPitch + adsPitch + bn2 * deg(br.rotDeg) * breathW + s.slidePitch;
    this.yaw = this.recoilYaw.value + this.hitYaw.value + this.bobYaw + adsYaw
      + bn1 * deg(br.rotDeg) * breathW;
    this.roll = this.rollSpring.value + this.bobRoll - lean * deg(V.lean.rollDeg);
  }

  _advanceStride(dt, s) {
    const grounded = s.grounded && !s.sliding;
    const target = grounded ? clamp(s.speed / PlayerConfig.speed.run, 0, 1.6) : 0;
    this.moveW = approach(this.moveW, target, grounded ? 9 : 6, dt);
    this.sprintW = approach(this.sprintW, s.sprinting ? (s.tacSprinting ? 1 : 0.72) : 0, 6.5, dt);
    this.airW = approach(this.airW, grounded ? 0 : 1, 8, dt);

    if (!grounded || s.speed < 0.4) return;
    const st = V.stride;
    const stride = s.speed < PlayerConfig.speed.run
      ? lerp(st.walk, st.run, clamp(s.speed / PlayerConfig.speed.run, 0, 1))
      : lerp(st.run, st.sprint, clamp((s.speed - PlayerConfig.speed.run) / (PlayerConfig.speed.tacSprint - PlayerConfig.speed.run), 0, 1));
    const rate = (Math.PI * s.speed) / (stride * (s.stanceKey === 'crouch' ? 0.78 : s.stanceKey === 'prone' ? 0.55 : 1));
    this.phase += rate * dt;
    if (this.phase > 1e6) { this.phase %= Math.PI * 2; this._stepIndex = Math.floor(this.phase / Math.PI); }
    const idx = Math.floor(this.phase / Math.PI);
    if (idx !== this._stepIndex) {
      this._stepIndex = idx;
      this.onFootstep?.(idx & 1 ? 'right' : 'left', clamp(s.speed / PlayerConfig.speed.tacSprint, 0.25, 1));
    }
  }

  _springTargets(dt, s) {
    const stanceMul = V.stanceBobMul[s.stanceKey] ?? 1;
    const sb = V.sprintBob;
    const b = V.bob;
    const adsMul = lerp(1, V.ads.bobMul, s.adsW);
    const w = clamp(this.moveW, 0, 1.25) * stanceMul * adsMul * (1 - this.airW * 0.85) * (1 - s.slideW);
    const ax = lerp(b.x, sb.x, this.sprintW) * w;
    const ay = lerp(b.y, sb.y, this.sprintW) * w;

    const p = this.phase;
    const sinP = Math.sin(p);
    const cos2P = Math.cos(p * 2);
    // Lissajous 1:2 — a true figure eight, with the vertical minimum landing on
    // the footstep so the step sound sits on the impact.
    this.bobSpring.target.set(sinP * ax, -cos2P * ay, Math.abs(sinP) * ay * 0.35);
    this.bobRoll = sinP * deg(lerp(b.rollDeg, sb.rollDeg, this.sprintW)) * w;
    this.bobPitch = -cos2P * deg(lerp(b.pitchDeg, sb.pitchDeg, this.sprintW)) * w * 0.8;
    // Sprint adds a lazy yaw sway at half stride frequency — the shoulder roll.
    this.bobYaw = Math.sin(p * 0.5) * deg(sb.yawDeg) * this.sprintW * w;

    // Acceleration lag: the head trails the body when the body changes velocity.
    _v.copy(s.velocity).sub(this._prevVel).multiplyScalar(dt > 1e-5 ? 1 / dt : 0);
    this._prevVel.copy(s.velocity);
    this._accel.lerp(_v, clamp(dt * 10, 0, 1));
    const g = V.lag.gain;
    const m = V.lag.max;
    const ar = this._accel.x * s.right.x + this._accel.z * s.right.z;
    const af = this._accel.x * s.forward.x + this._accel.z * s.forward.z;

    this._yawRate = approach(this._yawRate, dt > 1e-5 ? s.lookDx / dt : 0, 11, dt);
    this._pitchRate = approach(this._pitchRate, dt > 1e-5 ? s.lookDy / dt : 0, 11, dt);
    const lg = V.lag.lookGain;
    const lm = V.lag.lookMax;

    this.lagSpring.target.set(
      clamp(-ar * g, -m, m) + clamp(-this._yawRate * lg, -lm, lm),
      clamp(-this._accel.y * g * 0.45, -m, m) + clamp(-this._pitchRate * lg * 0.7, -lm, lm),
      clamp(-af * g, -m, m),
    );

    // Strafe roll plus a whisper of turn roll — ±1.2° is the whole budget.
    const lateral = s.velocity.x * s.right.x + s.velocity.z * s.right.z;
    const rollFromStrafe = -clamp(lateral / PlayerConfig.speed.run, -1, 1) * deg(V.strafeRollDeg);
    const rollFromTurn = -clamp(this._yawRate * 0.16, -1, 1) * deg(V.turnRollDeg);
    this.rollSpring.target = (rollFromStrafe + rollFromTurn) * (1 - s.adsW * 0.45) + s.slideRoll;

    this.leanSpring.target = s.leanInput;
  }
}
