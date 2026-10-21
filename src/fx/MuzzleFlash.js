import * as THREE from 'three';
import { PT } from './Atlas.js';
import { resetSpec } from './ParticleField.js';

/**
 * Muzzle flash: a multi-lobe flash, a real light, and barrel smoke that
 * accumulates with sustained fire.
 *
 * Three things separate a convincing flash from a white circle:
 *
 *  1. **It is several lobes, not one sprite.** A star burst at the crown, one
 *     or two cones flaring down the bore, and a handful of unburnt-powder
 *     embers thrown forward. Each has its own life measured in *frames*, so the
 *     shape changes between consecutive shots even at 800 rpm.
 *  2. **It lights the world.** A flash that does not put an orange pulse on the
 *     wall next to the shooter reads as a decal. This routes through the
 *     lighting system's impulse-light pool, which never competes with the
 *     scene's fixture lights for a slot.
 *  3. **The barrel smokes afterwards.** A heat accumulator rises with rate of
 *     fire and decays over a couple of seconds; past a threshold the muzzle
 *     starts trailing smoke that lingers and drifts after the shooting stops.
 *     This is the detail that makes a firefight look like it has been going on.
 *
 * The bore axis is the **+Z column** of the matrix handed in. Weapons should
 * publish `getMuzzleWorldMatrix()` with +Z pointing down the barrel.
 */

const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();

const rnd = (a, b) => a + Math.random() * (b - a);

export class MuzzleFlash {
  constructor(ctx, add, smoke) {
    this.ctx = ctx;
    this.add = add;
    this.smoke = smoke;
    this.heat = 0;
    this.lastShot = -99;
    /** Set by FXSystem when `weapon:fired` already triggered a light this frame. */
    this.externalLightFrame = -1;
    this.frame = 0;
    this._smokeEmitter = null;
    this._staticLights = [];
  }

  _basis(worldMatrix, dirOverride) {
    if (worldMatrix?.elements) {
      _pos.setFromMatrixPosition(worldMatrix);
      _right.setFromMatrixColumn(worldMatrix, 0).normalize();
      _up.setFromMatrixColumn(worldMatrix, 1).normalize();
      _fwd.setFromMatrixColumn(worldMatrix, 2).normalize();
    } else {
      _pos.set(worldMatrix?.x ?? 0, worldMatrix?.y ?? 0, worldMatrix?.z ?? 0);
      _fwd.set(0, 0, 1);
      _right.set(1, 0, 0);
      _up.set(0, 1, 0);
    }
    if (dirOverride) {
      _fwd.set(dirOverride.x, dirOverride.y, dirOverride.z).normalize();
      _right.set(0, 1, 0).cross(_fwd);
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
      _right.normalize();
      _up.copy(_fwd).cross(_right).normalize();
    }
  }

  /**
   * @param {THREE.Matrix4|{x,y,z}} worldMatrix muzzle transform, +Z down bore
   * @param {number} scale 1 = rifle; 0.6 = SMG; 1.6 = shotgun/DMR
   * @param {{dir?: THREE.Vector3, light?: boolean, persist?: number}} [opts]
   */
  flash(worldMatrix, scale = 1, opts) {
    const k = THREE.MathUtils.clamp(scale || 1, 0.35, 3);
    this._basis(worldMatrix, opts?.dir);
    const sunVis = opts?.sunVis ?? 1;
    // `persist` freezes the flash at its peak for a staged screenshot: the
    // life becomes `persist` and the particle is born 10% of that in the past,
    // which lands it past the fade-in and well before the fade-out. Simply
    // lengthening the life would slow the fade-in down with everything else and
    // leave the flash invisible.
    const hold = opts?.persist || 0;
    const holdAge = -hold * 0.10;

    // --- crown star ---------------------------------------------------------
    const star = resetSpec(); star.sunVis = sunVis;
    star.x = _pos.x + _fwd.x * 0.045; star.y = _pos.y + _fwd.y * 0.045; star.z = _pos.z + _fwd.z * 0.045;
    star.life = hold > 0 ? hold : 0.035 + Math.random() * 0.018;
    star.delay = holdAge;
    star.gravity = 0; star.drag = 0;
    star.size0 = 0.30 * k; star.size1 = 0.44 * k;
    star.tile = PT.FLASH_STAR;
    star.rot = Math.random() * 6.28;
    star.rotSpeed = rnd(-6, 6);
    star.soft = 0.25;
    star.r0 = 7.5; star.g0 = 5.4; star.b0 = 2.6; star.a0 = 1;
    star.r1 = 3.4; star.g1 = 1.5; star.b1 = 0.32; star.a1 = 0.5;
    star.fadeIn = 0.02; star.fadeOut = 0.55;
    this.add.spawn(star);

    // --- bore cones ---------------------------------------------------------
    const lobes = 1 + ((Math.random() * 2) | 0);
    for (let i = 0; i < lobes; i++) {
      const len = (0.24 + Math.random() * 0.20) * k;
      const s = resetSpec(); s.sunVis = sunVis;
      // Velocity-aligned so the cone points down the bore regardless of where
      // the camera is; the offset puts the lobe's base at the crown.
      const speed = 6;
      s.x = _pos.x + _fwd.x * len * 0.5;
      s.y = _pos.y + _fwd.y * len * 0.5;
      s.z = _pos.z + _fwd.z * len * 0.5;
      s.vx = _fwd.x * speed; s.vy = _fwd.y * speed; s.vz = _fwd.z * speed;
      s.life = hold > 0 ? hold : 0.030 + Math.random() * 0.020;
      s.delay = holdAge;
      s.gravity = 0; s.drag = 0;
      s.size0 = (0.16 + Math.random() * 0.08) * k;
      s.size1 = s.size0 * 1.35;
      s.stretch = len / speed;
      s.tile = PT.FLASH_LOBE;
      s.soft = 0.25;
      s.r0 = 6.2; s.g0 = 4.0; s.b0 = 1.5; s.a0 = 1;
      s.r1 = 2.6; s.g1 = 0.95; s.b1 = 0.18; s.a1 = 0.4;
      s.fadeIn = 0.02; s.fadeOut = 0.6;
      this.add.spawn(s);
    }

    // --- unburnt powder -----------------------------------------------------
    const embers = 4 + ((Math.random() * 5) | 0);
    for (let i = 0; i < embers; i++) {
      const s = resetSpec(); s.sunVis = sunVis;
      s.x = _pos.x; s.y = _pos.y; s.z = _pos.z;
      const sp = rnd(3.5, 11) * k;
      _tmp.copy(_fwd)
        .addScaledVector(_right, rnd(-0.32, 0.32))
        .addScaledVector(_up, rnd(-0.28, 0.32))
        .normalize();
      s.vx = _tmp.x * sp; s.vy = _tmp.y * sp; s.vz = _tmp.z * sp;
      s.life = rnd(0.10, 0.34) + hold * 0.35;
      s.delay = holdAge * 0.5;
      s.drag = 4.5; s.gravity = -8;
      s.size0 = rnd(0.008, 0.018); s.size1 = s.size0 * 0.5;
      s.tile = PT.SPARK; s.stretch = 0.006; s.soft = 0.06;
      s.r0 = 4.6; s.g0 = 2.4; s.b0 = 0.7; s.a0 = 1;
      s.r1 = 1.5; s.g1 = 0.28; s.b1 = 0.03; s.a1 = 0.7;
      s.fadeIn = 0.02; s.fadeOut = 0.4;
      this.add.spawn(s);
    }

    // --- gas / dust kicked off the crown ------------------------------------
    for (let i = 0; i < 2; i++) {
      const s = resetSpec(); s.sunVis = sunVis;
      s.x = _pos.x + _fwd.x * 0.12; s.y = _pos.y + _fwd.y * 0.12; s.z = _pos.z + _fwd.z * 0.12;
      _tmp.copy(_fwd).addScaledVector(_right, rnd(-0.5, 0.5)).addScaledVector(_up, rnd(-0.2, 0.5));
      s.vx = _tmp.x * 2.2; s.vy = _tmp.y * 2.2; s.vz = _tmp.z * 2.2;
      s.life = rnd(0.35, 0.7) + hold * 0.6;
      s.delay = holdAge * 0.4;
      s.drag = 4.0; s.gravity = 0.25; s.turb = 0.25;
      s.size0 = 0.07 * k; s.size1 = rnd(0.35, 0.6) * k;
      s.tile = PT.SMOKE_B; s.soft = 0.45;
      s.rot = Math.random() * 6.28; s.rotSpeed = rnd(-1.2, 1.2);
      s.r0 = 0.50; s.g0 = 0.48; s.b0 = 0.45;
      s.r1 = 0.60; s.g1 = 0.59; s.b1 = 0.57;
      s.a0 = 0.22; s.a1 = 0;

      s.fadeIn = 0.06; s.fadeOut = 0.6;
      this.smoke.lit.spawn(s);
    }

    // --- impulse light ------------------------------------------------------
    const wantLight = opts?.light !== false && this.frame !== this.externalLightFrame;
    if (wantLight) {
      if (hold > 0) {
        // A frozen tableau needs a light that stays on; pulses expire.
        const h = this.ctx.lighting?.addPointLight?.(
          _pos, 0xffcf92, 26 * k, 9 * k, { decay: 2, weight: 4 },
        );
        if (h) this._staticLights.push(h);
      } else {
        this.ctx.lighting?.pulse?.(_pos, 0xffd39c, 1350 * k, 0.055, 16 * k);
      }
    }

    // --- barrel heat --------------------------------------------------------
    const now = this.ctx.time || 0;
    this.heat = Math.min(1.6, this.heat + 0.13 + (now - this.lastShot < 0.2 ? 0.07 : 0));
    this.lastShot = now;
    if (this.heat > 0.55 && (!this._smokeEmitter || !this._smokeEmitter.active)) {
      this._smokeEmitter = this.smoke.barrel(_pos, _fwd, Math.min(1, this.heat - 0.4));
    } else if (this._smokeEmitter?.active) {
      this._smokeEmitter.x = _pos.x; this._smokeEmitter.y = _pos.y; this._smokeEmitter.z = _pos.z;
      this._smokeEmitter.age = 0;
    }
  }

  releaseStaticLights() {
    for (const h of this._staticLights) this.ctx.lighting?.remove?.(h);
    this._staticLights.length = 0;
  }

  update(dt) {
    this.frame++;
    this.heat = Math.max(0, this.heat - dt * 0.45);
  }
}
