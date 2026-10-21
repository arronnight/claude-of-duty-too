import * as THREE from 'three';
import { PlayerConfig } from './PlayerConfig.js';
import { Spring1, approach, clamp, lerp } from './Springs.js';

/**
 * Assembles the final camera transform and owns field of view.
 *
 * Two responsibilities beyond composition:
 *  - FOV is a stack (base + sprint + slide + one-shot punches, then pulled to the
 *    weapon's ADS FOV), each layer eased by its own spring so they can overlap.
 *  - Aim sensitivity is rescaled against that FOV using the monitor-distance
 *    convention, so a given mouse sweep covers the same on-screen distance
 *    hip-fire and scoped. Without it every optic feels like a different game.
 *
 * When the screenshot harness takes the camera (`camera:override`) the rig stops
 * writing entirely; on release it re-derives player yaw/pitch/position from
 * whatever transform the harness left behind, so control resumes with no pop.
 */

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
const RAD = Math.PI / 180;

/** Zoom-ratio aim compensation. coef 0 => "relative to FOV" (pure tan ratio). */
export function zoomSensitivity(fovNewDeg, fovOldDeg, coef = 0, aspect = 16 / 9) {
  const hNew = Math.atan(Math.tan(fovNewDeg * RAD * 0.5) * aspect);
  const hOld = Math.atan(Math.tan(fovOldDeg * RAD * 0.5) * aspect);
  if (coef <= 1e-4) return Math.tan(hNew) / Math.tan(hOld);
  return Math.atan(coef * Math.tan(hNew)) / Math.atan(coef * Math.tan(hOld));
}

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.cfg = PlayerConfig.fov;
    this.baseFov = this.cfg.base;
    this.fov = this.cfg.base;
    this.sensScale = 1;
    this.override = false;
    this.resumeRequested = false;

    this.addSpring = new Spring1(this.cfg.ease.freq, this.cfg.ease.zeta, 0);
    this.punch = new Spring1(4.2, 0.55, 0);
    this.adsW = 0;
    this.adsFov = this.cfg.ads;
    this._lastFov = -1;
    camera.rotation.order = 'YXZ';
    camera.fov = this.baseFov;
    camera.updateProjectionMatrix();
  }

  setBaseFOV(v) {
    this.baseFov = clamp(v, 45, 120);
  }

  setOverride(v) {
    const next = !!v;
    if (next === this.override) return;
    this.override = next;
    if (!next) this.resumeRequested = true;
  }

  /** Reads the harness camera back into player state so release does not snap. */
  consumeResume(out) {
    if (!this.resumeRequested) return false;
    this.resumeRequested = false;
    const cam = this.camera;
    cam.getWorldDirection(_dir);
    out.yaw = Math.atan2(-_dir.x, -_dir.z);
    out.pitch = Math.asin(clamp(_dir.y, -1, 1));
    out.position.copy(cam.position);
    this.punch.reset(0);
    this.addSpring.reset(0);
    // Ease the harness FOV back to the player's own rather than cutting.
    this.fov = cam.fov;
    cam.rotation.order = 'YXZ';
    return true;
  }

  fovPunch(amount) {
    this.punch.impulse(amount * 18);
  }

  /**
   * @param s per-frame state: position, eyeHeight, yaw, pitch, offset (local),
   *          viewPitch/viewYaw/viewRoll, sprintW, tacW, slideW, adsW, adsFov, extraFov.
   */
  update(dt, s) {
    const c = this.cfg;
    this.adsFov = s.adsFov > 0 ? s.adsFov : c.ads;
    this.adsW = s.adsW;

    this.addSpring.target = s.sprintW * c.sprint + s.tacW * (c.tacSprint - c.sprint) + s.slideW * PlayerConfig.slide.fovAdd;
    this.addSpring.update(dt);
    this.punch.update(dt);

    const hip = this.baseFov + this.addSpring.value + this.punch.value + s.extraFov;
    const target = lerp(hip, this.adsFov + this.punch.value * 0.35, s.adsW);
    this.fov = this.override ? this.fov : approach(this.fov, target, 26, dt);

    // Sensitivity tracks the ADS blend only — sprint FOV must not change aim feel.
    const sensFov = lerp(this.baseFov, this.adsFov, s.adsW);
    const aspect = this.camera.aspect || 16 / 9;
    this.sensScale = zoomSensitivity(sensFov, this.baseFov, c.sensCoefficient, aspect);

    if (this.override) return;

    _fwd.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
    _right.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));

    const cam = this.camera;
    cam.position.copy(s.position);
    cam.position.y += s.eyeHeight;
    cam.position.addScaledVector(_right, s.offset.x);
    cam.position.y += s.offset.y;
    cam.position.addScaledVector(_fwd, s.offset.z);
    cam.rotation.set(s.pitch + s.viewPitch, s.yaw + s.viewYaw, s.viewRoll, 'YXZ');

    if (Math.abs(this.fov - this._lastFov) > 0.008) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
      this._lastFov = this.fov;
    }
  }
}
