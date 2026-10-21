import * as THREE from 'three';
import { Spring1, Spring3, ValueNoise, clamp, lerp, smoothstep, easeOutCubic, easeOutBack, approach, deg } from './Springs.js';
import { buildWeaponModel } from './models/index.js';
import { buildHands } from './models/Hands.js';

/**
 * The viewmodel rig: everything between "a pile of meshes" and "a weapon that
 * feels alive in the hands".
 *
 * Nothing here is keyframe data on disk. The pose is composed every frame from
 * a stack of independent, spring-driven contributions:
 *
 *   base pose (hip / ADS / sprint / low-ready)
 *     + idle sway lagging the camera
 *     + breathing
 *     + movement bob
 *     + fire kick along the bore axis
 *     + reload choreography
 *     + inspect flourish
 *
 * The one thing that is *solved* rather than authored is the ADS pose. The
 * model publishes a `sight` node on the optical axis; the rig places the
 * weapon root so that node lands exactly on the camera axis at the weapon's
 * eye relief. A hand-tuned ADS offset drifts the moment any dimension changes,
 * and a misaligned sight is the most obvious bug an FPS can ship.
 */

const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Reload choreography, shared by every weapon: (t01, pos, rot-in-degrees).
 *
 * The weapon comes *in and up*, not down. The hip pose already sits on the
 * bottom edge of the frame, so an authored "lower the weapon" translation
 * simply posts the whole animation off-screen — which is what the first pass
 * did. Modern Call of Duty brings the receiver toward the middle of the frame
 * and rolls the magwell over to face the camera; the sense of lowering comes
 * from the muzzle pitching down, not from the weapon dropping.
 */
const RELOAD_KEYS = [
  [0.00, 0, 0, 0, 0, 0, 0],
  [0.16, -0.024, 0.012, 0.020, -10, 16, -12],
  [0.34, -0.034, 0.021, 0.028, -14, 23, -18],
  [0.62, -0.030, 0.018, 0.025, -13, 21, -17],
  [0.82, -0.014, 0.008, 0.012, -7, 12, -9],
  [1.00, 0, 0, 0, 0, 0, 0],
];

/** Inspect flourish: rotate the weapon to show both sides, then present it. */
const INSPECT_KEYS = [
  [0.00, 0, 0, 0, 0, 0, 0],
  [0.18, -0.032, 0.030, 0.052, 6, -36, -15],
  [0.42, -0.050, 0.046, 0.072, 3, -104, -21],
  [0.66, -0.022, 0.040, 0.066, -6, 46, 25],
  [0.84, -0.026, 0.020, 0.038, 9, -14, 8],
  [1.00, 0, 0, 0, 0, 0, 0],
];

function sampleKeys(keys, t, out) {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const u = smoothstep((t - a[0]) / Math.max(1e-5, b[0] - a[0]));
  out.px = lerp(a[1], b[1], u);
  out.py = lerp(a[2], b[2], u);
  out.pz = lerp(a[3], b[3], u);
  out.rx = deg(lerp(a[4], b[4], u));
  out.ry = deg(lerp(a[5], b[5], u));
  out.rz = deg(lerp(a[6], b[6], u));
  return out;
}

const _key = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
const _key2 = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };

export class Viewmodel {
  constructor(ctx, resolve) {
    this.ctx = ctx;
    this.resolve = resolve;
    this.root = new THREE.Group();
    this.root.name = 'viewmodelRoot';
    this.root.matrixAutoUpdate = true;
    ctx.viewScene.add(this.root);

    this.models = new Map();
    this.model = null;
    this.def = null;
    this.visible = true;

    // --- pose state -------------------------------------------------------
    this.adsRaw = 0;          // 0..1 raw transition timer
    this.adsW = 0;            // eased weight with overshoot
    this.adsTarget = 0;
    this.sprintW = 0;
    this.lowReadyW = 0;

    this.swayRot = new Spring3(4.6, 0.62);   // lags camera rotation
    this.swayPos = new Spring3(7.0, 0.70);
    this.kickBack = new Spring1(15.0, 0.42);
    this.kickPitch = new Spring1(14.0, 0.40);
    this.kickRoll = new Spring1(12.0, 0.45);
    this.landDip = new Spring1(8.0, 0.55);
    this.breathe = new ValueNoise(7717);
    this.drift = new ValueNoise(3391);

    this.bobPhase = 0;
    this.time = 0;
    this._prevYaw = null;
    this._prevPitch = 0;

    // --- part animation state --------------------------------------------
    this.boltT = 1;           // 0..1 through a cycle, 1 = at rest
    this.triggerT = 0;
    this.chargeT = 0;
    this.reload = null;       // { t, dur, stages, next, empty }
    this.inspectT = -1;
    this.magHidden = false;
    this.magOffset = new THREE.Vector3();

    this._lights(ctx);
  }

  /**
   * The viewmodel scene is rendered on its own, so it needs its own lighting.
   * Everything is mirrored from the world and rotated into view space, which
   * is what makes the weapon's key light swing across it as the player turns —
   * a viewmodel lit by a fixed headlight is the classic tell of a demo.
   */
  _lights(ctx) {
    const s = ctx.viewScene;
    this.key = new THREE.DirectionalLight(0xffffff, 2.2);
    this.key.position.set(-0.4, 0.8, 0.45);
    this.key.castShadow = false;
    s.add(this.key);
    s.add(this.key.target);

    // Ambient comes from the same PMREM probe the world uses (see
    // `_updateLights`), so this is only a floor to keep the shadow side of the
    // receiver from going to literal black. Its colour is taken from the sky
    // but *normalised* — `sky.skyColor` is HDR radiance in `sky.exposure`
    // units, and feeding those straight into a light blows the weapon out by
    // more than a stop and stains it blue.
    this.fill = new THREE.HemisphereLight(0x9fc4ff, 0x3a352c, 0.0);
    s.add(this.fill);
  }

  /** Build (or fetch) a weapon model and make it the active one. */
  select(id, def) {
    let m = this.models.get(id);
    if (!m) {
      m = buildWeaponModel(id, this.resolve);
      if (!m) return null;
      m.root.visible = false;
      this.root.add(m.root);
      this.models.set(id, m);
      m.adsPose = this._solveADS(m, def);
      this._attachHands(m);
    }
    if (this.model && this.model !== m) this.model.root.visible = false;
    this.model = m;
    this.def = def;
    m.root.visible = true;
    this.magHidden = false;
    this.boltT = 1;
    this.reload = null;
    return m;
  }

  /**
   * Parent a pair of gloved hands to the model's grip nodes. Every weapon
   * publishes `gripRear`/`gripFront` in the right place, so the hands come for
   * free and land correctly without per-weapon authoring.
   */
  _attachHands(m) {
    if (!m.nodes.gripRear || m.hands) return;
    const h = buildHands(this.resolve, { gripRadius: m.gripRadius ?? 0.0218 });
    m.nodes.gripRear.add(h.rear);
    if (m.nodes.gripFront && !m.noSupportHand) m.nodes.gripFront.add(h.front);
    m.hands = h;
    // Registered as parts so the rig can animate them like anything else.
    m.parts.handRear = { group: h.rear };
    m.parts.handFront = { group: h.front };
  }

  /**
   * Solve the ADS transform so the sight node lands on the camera axis.
   *
   * With the desired weapon orientation fixed at identity (a canted sight is a
   * miss, not a style choice), the root position is simply
   *   root = desiredSightPos - R * sightLocalPos
   * evaluated once, at build time.
   */
  _solveADS(m, def) {
    const sight = m.nodes.sight;
    sight.updateMatrix();
    _v.setFromMatrixPosition(sight.matrix);
    const relief = def.pose.adsEyeRelief;
    return {
      pos: new THREE.Vector3(-_v.x, -_v.y, -relief - _v.z),
      quat: new THREE.Quaternion(),
    };
  }

  // ---------------------------------------------------------------- actions

  setADS(v) { this.adsTarget = v ? 1 : 0; }

  /** Called on every shot: kick, bolt cycle, trigger break. */
  fire(strength = 1) {
    const k = this.def?.kick;
    if (!k) return;
    this.kickBack.impulse(k.back * 62 * strength);
    this.kickPitch.impulse(deg(k.rise) * 60 * strength);
    this.kickRoll.impulse(deg(k.roll) * 46 * strength * (Math.random() < 0.5 ? 1 : -1));
    this.boltT = 0;
    this.triggerT = 1;
  }

  startReload(empty) {
    const table = empty ? this.def.reload.empty : this.def.reload.tactical;
    this.reload = { t: 0, dur: table.duration, stages: table.stages, next: 0, empty: !!empty, fired: [] };
    return table;
  }

  cancelReload() { this.reload = null; this.magHidden = false; }

  inspect() { if (this.inspectT < 0) this.inspectT = 0; }

  land(speed) { this.landDip.impulse(-Math.min(0.09, speed * 0.006) * 42); }

  // ------------------------------------------------------------------ frame

  /**
   * @param dt seconds
   * @param s  player snapshot: { yaw, pitch, speed01, sprint, grounded, stance }
   * @returns  the stage name crossed this frame, or null
   */
  update(dt, s) {
    this.time += dt;
    const def = this.def;
    if (!def || !this.model) return null;
    const pose = def.pose;

    // --- ADS transition, with the ~4 % overshoot the spec calls for ---------
    const adsRate = 1 / Math.max(0.05, def.adsTime);
    const goingIn = this.adsTarget > 0.5;
    // Sprinting and reloading both lock ADS out.
    const allowed = goingIn && this.sprintW < 0.35 && !this.reload;
    this.adsRaw = clamp(this.adsRaw + (allowed ? dt * adsRate : -dt * adsRate * 1.35), 0, 1);
    this.adsW = allowed ? easeOutBack(this.adsRaw, 0.62) : easeOutCubic(this.adsRaw);

    const sprintTarget = s.sprint && this.adsRaw < 0.2 && !this.reload ? 1 : 0;
    this.sprintW = approach(this.sprintW, sprintTarget, 9.0, dt);
    this.lowReadyW = approach(this.lowReadyW, 0, 6.0, dt);

    // --- base pose ---------------------------------------------------------
    const hip = pose.hip;
    const spr = pose.sprint;
    let px = lerp(hip.pos[0], spr.pos[0], this.sprintW);
    let py = lerp(hip.pos[1], spr.pos[1], this.sprintW);
    let pz = lerp(hip.pos[2], spr.pos[2], this.sprintW);
    _e.set(
      lerp(hip.rot[0], spr.rot[0], this.sprintW),
      lerp(hip.rot[1], spr.rot[1], this.sprintW),
      lerp(hip.rot[2], spr.rot[2], this.sprintW),
      'YXZ',
    );
    _qa.setFromEuler(_e);

    const a = this.adsW;
    if (a > 0.0001) {
      const ap = this.model.adsPose;
      px = lerp(px, ap.pos.x, a);
      py = lerp(py, ap.pos.y, a);
      pz = lerp(pz, ap.pos.z, a);
      _qa.slerp(ap.quat, clamp(a, 0, 1));
    }

    // --- idle sway: the weapon lags the camera ----------------------------
    if (this._prevYaw === null) { this._prevYaw = s.yaw; this._prevPitch = s.pitch; }
    let dYaw = s.yaw - this._prevYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = s.pitch - this._prevPitch;
    this._prevYaw = s.yaw;
    this._prevPitch = s.pitch;

    // Heavier weapons lag further; ADS clamps the sway hard or the sight would
    // swim off the target.
    const mass = clamp(def.mass / 3.4, 0.6, 1.5);
    const swayGain = (1 - a * 0.78) * mass;
    const rate = dt > 1e-5 ? 1 / dt : 0;
    this.swayRot.impulse(-clamp(dPitch, -0.14, 0.14) * 26 * swayGain, -clamp(dYaw, -0.14, 0.14) * 26 * swayGain, clamp(dYaw, -0.14, 0.14) * 14 * swayGain);
    this.swayPos.impulse(clamp(dYaw, -0.12, 0.12) * 0.90 * swayGain, clamp(dPitch, -0.12, 0.12) * 0.75 * swayGain, 0);
    this.swayRot.update(dt, 0, 0, 0);
    this.swayPos.update(dt, 0, 0, 0);

    // --- breathing + slow drift -------------------------------------------
    // Amplitudes drop hard under ADS: 1 mm at 0.2 m eye relief is already
    // 5 mrad of aim wobble, which is about right for a held breath and about
    // as much as the reticle can move before it reads as a bug.
    const breathAmp = lerp(0.0036, 0.0009, a) * (1 - this.sprintW * 0.5);
    const bt = this.time * 0.31;
    const breath = Math.sin(bt * Math.PI * 2) * 0.6 + this.breathe.at(bt * 1.7) * 0.4;
    const driftX = this.drift.at(this.time * 0.23) * lerp(0.0026, 0.0006, a);
    const driftY = this.drift.at(this.time * 0.19 + 31) * lerp(0.0022, 0.0005, a);

    // --- movement bob ------------------------------------------------------
    const moveW = clamp(s.speed01, 0, 1.4);
    const bobRate = (1.9 + 1.5 * this.sprintW) * moveW;
    this.bobPhase += dt * bobRate * Math.PI * 2;
    const bobAmp = moveW * (1 - a * 0.82) * (0.011 + 0.014 * this.sprintW) * (s.grounded ? 1 : 0.25);
    const bobX = Math.sin(this.bobPhase) * bobAmp;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * bobAmp * 0.85;
    const bobRoll = Math.sin(this.bobPhase) * bobAmp * 5.5;

    // --- fire kick ---------------------------------------------------------
    const k = def.kick;
    this.kickBack.freq = k.freq; this.kickBack.zeta = k.zeta;
    this.kickPitch.freq = k.freq * 0.92; this.kickPitch.zeta = k.zeta + 0.03;
    this.kickRoll.freq = k.freq * 0.8; this.kickRoll.zeta = k.zeta + 0.08;
    this.kickBack.update(dt, 0);
    this.kickPitch.update(dt, 0);
    this.kickRoll.update(dt, 0);
    this.landDip.update(dt, 0);

    // --- reload / inspect choreography -------------------------------------
    let stageFired = null;
    let rl = _key;
    rl.px = rl.py = rl.pz = rl.rx = rl.ry = rl.rz = 0;
    if (this.reload) {
      this.reload.t += dt;
      const r = this.reload;
      const t01 = clamp(r.t / r.dur, 0, 1);
      sampleKeys(RELOAD_KEYS, t01, rl);
      while (r.next < r.stages.length && r.t >= r.stages[r.next][0]) {
        stageFired = r.stages[r.next][1];
        r.next++;
      }
      this._animateMag(r);
      if (r.t >= r.dur) { this.reload = null; this.magHidden = false; this.magOffset.set(0, 0, 0); }
    } else if (this.magOffset.lengthSq() > 0) {
      this.magOffset.multiplyScalar(0.0);
    }

    let ins = _key2;
    ins.px = ins.py = ins.pz = ins.rx = ins.ry = ins.rz = 0;
    if (this.inspectT >= 0) {
      this.inspectT += dt / 2.05;
      if (this.inspectT >= 1) { this.inspectT = -1; }
      else sampleKeys(INSPECT_KEYS, this.inspectT, ins);
    }

    // --- compose -----------------------------------------------------------
    const sr = this.swayRot.value;
    const sp = this.swayPos.value;
    const root = this.root;
    root.position.set(
      px + sp.x + bobX + driftX + rl.px + ins.px,
      py + sp.y + bobY + driftY + breath * breathAmp + this.landDip.value + rl.py + ins.py,
      pz + this.kickBack.value + rl.pz + ins.pz,
    );
    _e.set(
      sr.x + this.kickPitch.value + rl.rx + ins.rx,
      sr.y + rl.ry + ins.ry,
      sr.z + this.kickRoll.value + deg(bobRoll) + rl.rz + ins.rz,
      'YXZ',
    );
    _qb.setFromEuler(_e);
    root.quaternion.copy(_qa).multiply(_qb);

    // Authoring aid: `__COD__.ctx.engine.get('weapons').view.studio = {pos,rot}`
    // parks the weapon at a fixed pose so the model can be judged on its own
    // against clean sky instead of through a hip-fire frame. Never set in play.
    if (this.studio) {
      root.position.fromArray(this.studio.pos);
      root.rotation.fromArray(this.studio.rot);
      root.quaternion.setFromEuler(root.rotation);
    }

    this._animateParts(dt);
    this._updateLights(dt);
    return stageFired;
  }

  /** Magazine in/out, driven off the reload stage times. */
  _animateMag(r) {
    const st = r.stages;
    const tOut = st.find((x) => x[1] === 'magout')?.[0] ?? 0.3;
    const tIn = st.find((x) => x[1] === 'maginsert')?.[0] ?? 0.8;
    const tSeat = st.find((x) => x[1] === 'magseat')?.[0] ?? 1.1;
    const t = r.t;
    if (t < tOut) {
      this.magOffset.set(0, 0, 0);
      this.magHidden = false;
    } else if (t < tIn) {
      const u = clamp((t - tOut) / 0.20, 0, 1);
      this.magOffset.set(0, -0.16 * u, 0.028 * u);
      this.magHidden = u >= 0.85;
    } else if (t < tSeat) {
      const u = smoothstep(clamp((t - tIn) / Math.max(0.01, tSeat - tIn), 0, 1));
      this.magHidden = false;
      this.magOffset.set(0, -0.155 * (1 - u), 0.030 * (1 - u));
    } else {
      // Seat it with a short overshoot so it reads as a slap, not a slide.
      const u = clamp((t - tSeat) / 0.10, 0, 1);
      this.magOffset.set(0, -0.0035 * Math.sin(u * Math.PI) , 0);
      this.magHidden = false;
    }
  }

  _animateParts(dt) {
    const m = this.model;
    const def = this.def;
    const p = m.parts;

    // Bolt / slide cycle.
    if (this.boltT < 1) {
      this.boltT = Math.min(1, this.boltT + dt / Math.max(0.01, def.bolt.time));
      const u = this.boltT < 0.42 ? this.boltT / 0.42 : 1 - (this.boltT - 0.42) / 0.58;
      if (p.bolt) p.bolt.group.position.z = def.bolt.travel * smoothstep(u);
      if (p.slide) p.slide.group.position.z = def.bolt.travel * smoothstep(u);
    } else {
      if (p.bolt) p.bolt.group.position.z = 0;
      if (p.slide) p.slide.group.position.z = 0;
    }

    // Trigger break and reset.
    if (this.triggerT > 0) {
      this.triggerT = Math.max(0, this.triggerT - dt / 0.075);
      if (p.trigger) p.trigger.group.rotation.x = -0.38 * smoothstep(this.triggerT);
    } else if (p.trigger) p.trigger.group.rotation.x = 0;

    // Magazine.
    if (p.magazine) {
      p.magazine.group.position.copy(this.magOffset);
      p.magazine.group.visible = !this.magHidden;
    }

    // Charging handle: yanked on the bolt-catch release of an empty reload.
    if (p.chargingHandle) {
      const target = this.chargeT;
      p.chargingHandle.group.position.z = 0.052 * target;
      this.chargeT = Math.max(0, this.chargeT - dt / 0.16);
    }

    // The support hand leaves the handguard to fetch and seat the magazine.
    if (p.handFront) {
      const r = this.reload;
      let u = 0;
      if (r) {
        const t = r.t / r.dur;
        u = t < 0.10 ? t / 0.10 : t > 0.80 ? Math.max(0, (0.95 - t) / 0.15) : 1;
      }
      const g = p.handFront.group;
      g.position.set(0.012 * u, -0.105 * u, 0.205 * u);
      g.rotation.set(-0.55 * u, 0.30 * u, 0.20 * u);
    }

    // Selector rotates to the current fire mode.
    if (p.selector) {
      const idx = Math.max(0, def.modes.indexOf(this._fireMode || def.fireMode));
      p.selector.group.rotation.x = approach(p.selector.group.rotation.x, -0.7 + idx * 0.7, 14, dt);
    }
  }

  pullChargingHandle() { this.chargeT = 1; }
  setFireMode(mode) { this._fireMode = mode; }

  /**
   * Mirror the world's key light into view space so the weapon is lit by the
   * same sun the street is, and rotate the environment probe with the camera
   * so its reflections track where the player is actually looking.
   */
  _updateLights(dt) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    const sky = ctx.sky;
    const sun = ctx.lighting?.sun;
    if (!cam) return;
    _q.copy(cam.quaternion).invert();

    // Is the shooter actually standing in the sun? The world casts shadows on
    // itself, but the viewmodel scene has no shadow map of its own, so without
    // this one raycast the weapon is lit as if in full sun while the player
    // stands in the shade of a fifteen-metre block — which is precisely how
    // the first pass of this viewmodel read as pasted on.
    if (sky?.sunDirection && ctx.physics?.raycast) {
      this._shadowT = (this._shadowT || 0) + dt;
      if (this._shadowT > 0.1) {
        this._shadowT = 0;
        cam.getWorldPosition(_v2);
        _v.copy(sky.sunDirection).normalize();
        if (_v.y < 0) _v.negate();
        this._sunTarget = ctx.physics.raycast(_v2, _v, 90) ? 0.05 : 1;
      }
    }
    this._sunVis = approach(this._sunVis ?? 1, this._sunTarget ?? 1, 7, dt);

    if (sky?.sunDirection) {
      _v.copy(sky.sunDirection).applyQuaternion(_q).normalize();
      // Never let the key fall exactly behind the weapon; a viewmodel with no
      // form at all reads worse than a slightly wrong one.
      if (_v.z > 0.55) _v.z = 0.55;
      this.key.position.copy(_v).multiplyScalar(6);
    }
    // Match the world's key exactly. Anything else and the weapon is exposed
    // differently from the street it is standing in, which is instantly
    // legible even when you cannot say why.
    if (sun) {
      this.key.color.copy(sun.color);
      this.key.intensity = sun.intensity * this._sunVis;
    }
    if (sky?.skyColor) {
      const c = this.fill.color.copy(sky.skyColor);
      const peak = Math.max(c.r, c.g, c.b, 1e-4);
      c.multiplyScalar(1 / peak);
      this.fill.groundColor.setRGB(c.r * 0.30, c.g * 0.28, c.b * 0.22);
      this.fill.intensity = Math.max(0.05, (sun?.intensity ?? 1) * 0.05);
    }

    const env = ctx.scene?.environment || null;
    const vs = ctx.viewScene;
    if (vs.environment !== env) vs.environment = env;
    if (env) {
      _e.setFromQuaternion(_q, 'XYZ');
      vs.environmentRotation.set(_e.x, _e.y, _e.z, 'XYZ');
      // Below 1.0 deliberately: the weapon is held against the shooter's body,
      // so roughly a third of its sky hemisphere is occluded by a torso the
      // viewmodel scene does not contain and cannot shadow.
      vs.environmentIntensity = 0.62;
    }
  }

  /** World matrix of the muzzle, in *view* space (the viewmodel's own space). */
  muzzleMatrix(out) {
    const n = this.model?.nodes?.muzzle;
    if (!n) return null;
    this.root.updateMatrixWorld(true);
    return out.copy(n.matrixWorld);
  }

  ejectMatrix(out) {
    const n = this.model?.nodes?.eject;
    if (!n) return null;
    this.root.updateMatrixWorld(true);
    return out.copy(n.matrixWorld);
  }

  setVisible(v) {
    this.visible = !!v;
    this.root.visible = !!v;
  }

  dispose() {
    for (const m of this.models.values()) {
      m.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    }
    this.models.clear();
  }
}
