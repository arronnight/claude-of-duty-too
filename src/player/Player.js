import * as THREE from 'three';
import { PlayerConfig } from './PlayerConfig.js';
import { PhysicsBridge, makeHit } from './PhysicsBridge.js';
import { PlayerMovement } from './PlayerMovement.js';
import { MantleController } from './Mantle.js';
import { ViewMotion } from './ViewMotion.js';
import { CameraRig } from './CameraRig.js';
import { approach, clamp, deg } from './Springs.js';

/**
 * The player: locomotion, stance, traversal, and camera feel.
 *
 * Simulation runs on its own 120 Hz accumulator inside `update()` rather than in
 * `fixedUpdate()`, because this frame's mouse delta must be folded into yaw
 * *before* the movement steps that consume it — the engine's fixedUpdate pass
 * runs first and would always be one frame stale.
 *
 * Layering, outermost last: physics-solved capsule position -> stance eye height
 * -> additive procedural view motion -> camera rig (FOV + final transform). Each
 * layer only reads the one below it, so any of them can be weighted out in
 * isolation while tuning.
 */

const FIXED = 1 / 120;
const MAX_STEPS = 6;
const PITCH_LIMIT = 1.5359; // 88 degrees
const DEG = Math.PI / 180;

const CMD = {
  moveX: 0, moveZ: 0, yaw: 0, lean: 0,
  jumpPressed: false, crouchHeld: false, crouchPressed: false, pronePressed: false,
  sprintHeld: false, sprintPressed: false, ads: false, walk: false, frozen: false,
};

const VS = {
  velocity: new THREE.Vector3(),
  right: new THREE.Vector3(),
  forward: new THREE.Vector3(),
  speed: 0, grounded: true, sliding: false, sprinting: false, tacSprinting: false,
  stanceKey: 'stand', adsW: 0, holdBreath: false, stamina01: 1,
  leanInput: 0, leanLimit: 0, lookDx: 0, lookDy: 0,
  slideW: 0, slideRoll: 0, slidePitch: 0, crouchDip: 0,
};

const RS = {
  position: new THREE.Vector3(), eyeHeight: 1.62, yaw: 0, pitch: 0,
  offset: new THREE.Vector3(), viewPitch: 0, viewYaw: 0, viewRoll: 0,
  sprintW: 0, tacW: 0, slideW: 0, adsW: 0, adsFov: 0, extraFov: 0,
};

const _resume = { yaw: 0, pitch: 0, position: new THREE.Vector3() };
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _surfHit = makeHit();

export class PlayerSystem {
  async init(ctx) {
    this.ctx = ctx;
    this.cfg = PlayerConfig;
    this.bridge = new PhysicsBridge(ctx);

    const ev = {
      land: (v) => this._onLand(v),
      jump: (fromSlide) => ctx.bus.emit('player:jump', { fromSlide: !!fromSlide }),
      stance: (next, prev) => ctx.bus.emit('player:stance', { stance: next, prev }),
      slide: (phase, speed) => ctx.bus.emit('player:slide', { phase, speed }),
      hardLand: (v) => ctx.fx?.screenShake?.(clamp(v * 0.012, 0, 0.35), 0.28),
    };

    this.move = new PlayerMovement(this.bridge, ev);
    this.mantle = new MantleController(this.cfg, this.bridge);
    this.view = new ViewMotion();
    this.rig = new CameraRig(ctx.camera);
    this.view.onFootstep = (foot, vol) => this._onFootstep(foot, vol);

    this.yaw = 0;
    this.pitch = 0;
    this.accum = 0;
    this.override = false;
    this.adsW = 0;
    this.tacW = 0;
    this.sprintW = 0;
    this.slideW = 0;
    this.leanInput = 0;
    this.leanLimit = this.cfg.view.lean.offset;
    this._leanProbeTick = 3;
    this.holdBreath = false;

    this.health = this.cfg.health.max;
    this.armour = this.cfg.health.armour;
    this.dead = false;
    this._regenHold = 0;
    this._respawnIn = 0;
    this.cameraRotation = new THREE.Euler(0, 0, 0, 'YXZ');

    this._spawn = new THREE.Vector3(2.2, 0.05, 20);
    this._spawnYaw = 0;
    this._placed = false;
    this._placeDeadline = 8;   // stop waiting on a level that never publishes spawns
    this._hooksBound = false;

    ctx.bus.on('camera:override', (v) => this._setOverride(v));
    ctx.canvas.addEventListener('click', () => ctx.input.requestLock());

    this._placeAtSpawn();

    ctx.player = {
      position: this.move.position,
      velocity: this.move.velocity,
      yaw: 0, pitch: 0,
      stance: 'stand',
      sprinting: false, tacSprinting: false, grounded: true, sliding: false, mantling: false,
      health: this.health, armour: this.armour, stamina: this.cfg.stamina.max, dead: false,
      eyeHeight: this.cfg.eye.stand,
      cameraRotation: this.cameraRotation,
      speed: 0, moveSpeed01: 0, lean: 0,
      isADS: false,
      adsProgress: 0,
      // Live references so the viewmodel can counter-animate against the head.
      viewOffset: this.view.offset,
      viewRot: { pitch: 0, yaw: 0, roll: 0 },
      bobPhase: 0,
      fov: this.cfg.fov.base,
      sensScale: 1,
      applyRecoil: (p, y) => this.applyRecoil(p, y),
      damage: (a, dir) => this.damage(a, dir),
      heal: (a) => { this.health = clamp(this.health + a, 0, this.cfg.health.max); },
      setBaseFOV: (v) => this.rig.setBaseFOV(v),
      getBaseFOV: () => this.rig.baseFov,
      teleport: (pos, yaw) => this.teleport(pos, yaw),
      respawn: () => this._respawn(),
      config: this.cfg,
    };
    this.api = ctx.player;
  }

  // --- public API ---

  applyRecoil(pitchKick, yawKick) {
    this.view.applyRecoil(pitchKick || 0, yawKick || 0);
  }

  damage(amount, fromDir) {
    if (this.dead || !(amount > 0)) return;
    const h = this.cfg.health;
    let left = amount;
    if (this.armour > 0) {
      const absorbed = Math.min(this.armour, left * h.armourAbsorb);
      this.armour -= absorbed;
      left -= absorbed;
    }
    this.health = clamp(this.health - left, 0, h.max);
    this._regenHold = h.regenDelay;
    this.move.stamina = Math.max(0, this.move.stamina - amount * 0.4);

    let dirX = 0, dirZ = 0;
    if (fromDir) {
      _tmp.set(fromDir.x || 0, 0, fromDir.z || 0);
      if (_tmp.lengthSq() > 1e-6) {
        _tmp.normalize();
        _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        dirX = _tmp.dot(_right);
        dirZ = _tmp.dot(_fwd);
      }
    }
    const kick = deg(h.hitKickDeg) * clamp(amount / 30, 0.25, 1.6);
    this.view.applyHit(kick * (0.6 + 0.4 * Math.abs(dirZ)), -kick * dirX * 0.9);
    this.ctx.bus.emit('player:damaged', { amount, dir: fromDir ?? null, health: this.health, armour: this.armour });

    if (this.health <= 0 && !this.dead) {
      this.dead = true;
      this._respawnIn = 3.0;
      this.ctx.bus.emit('player:died', { by: null });
    }
  }

  teleport(pos, yaw) {
    this.move.resetTransient();
    this.move.position.copy(pos);
    if (typeof yaw === 'number') this.yaw = yaw;
    this.mantle.cancel();
    this.view.reset();
    this.accum = 0;
  }

  // --- frame ---

  update(dt, ctx) {
    if (!(dt > 0)) dt = 1e-4;
    this.bridge.tick(dt);
    if (!this._placed) {
      this._placeDeadline -= dt;
      if (this._placeDeadline <= 0) this._placed = true;
      else this._placeAtSpawn();
    }
    this._bindAutomation();

    const input = ctx.input;
    const locked = !!input.locked && !this.override && !this.dead;

    // ADS state is owned by weapons; blended here for FOV, sway and sensitivity.
    const adsTarget = ctx.weapons?.adsProgress ?? (this.api.isADS ? 1 : 0);
    this.adsW = approach(this.adsW, clamp(adsTarget, 0, 1), this.cfg.fov.adsEaseRate, dt);
    this.api.adsProgress = this.adsW;

    let lookDx = 0;
    let lookDy = 0;
    if (locked) {
      const sens = input.sensitivity * this.rig.sensScale;
      lookDx = -input.mouse.dx * sens;
      lookDy = (input.invertY ? input.mouse.dy : -input.mouse.dy) * sens;
      this.yaw += lookDx;
      this.pitch = clamp(this.pitch + lookDy, -PITCH_LIMIT, PITCH_LIMIT);
    }

    this._readCommand(ctx, locked, dt);
    this._updateLean(ctx, locked);

    let steps = 0;
    this.accum = Math.min(this.accum + dt, FIXED * MAX_STEPS);
    while (this.accum >= FIXED && steps < MAX_STEPS) {
      this._simulate(FIXED);
      this.accum -= FIXED;
      steps++;
      CMD.jumpPressed = false;
      CMD.crouchPressed = false;
      CMD.pronePressed = false;
      CMD.sprintPressed = false;
    }

    this._updateHealth(dt);
    this._updateWeights(dt);
    this._updateView(dt, lookDx, lookDy);
    this._publish();
  }

  _simulate(dt) {
    if (this.mantle.active) {
      if (this.mantle.update(dt)) {
        this.move.position.copy(this.mantle.position);
      } else {
        this.move.exitScripted(this.mantle.position, this.mantle.exitDir, this.mantle.exitSpeed());
        this.ctx.bus.emit('player:mantle', { phase: 'end', kind: this.mantle.kind });
      }
      this.move._advanceStance(dt);
      return;
    }
    this.mantle.update(dt); // ticks the cooldown
    this._tryMantle(dt);
    this.move.step(dt, CMD);
  }

  _readCommand(ctx, locked, dt) {
    const inp = ctx.input;
    const on = locked;
    CMD.moveX = (on && inp.action('right') ? 1 : 0) - (on && inp.action('left') ? 1 : 0);
    CMD.moveZ = (on && inp.action('forward') ? 1 : 0) - (on && inp.action('back') ? 1 : 0);
    CMD.yaw = this.yaw;
    CMD.jumpPressed = on && inp.actionPressed('jump');
    CMD.crouchHeld = on && inp.action('crouch');
    CMD.crouchPressed = on && inp.actionPressed('crouch');
    CMD.pronePressed = on && inp.actionPressed('prone');
    CMD.sprintHeld = on && inp.action('sprint');
    CMD.sprintPressed = on && inp.actionPressed('sprint');
    CMD.ads = this.adsW > 0.5;
    CMD.walk = false;
    CMD.lean = this.leanInput;
    CMD.frozen = this.dead || !!ctx.engine.paused;

    // Shift while aiming steadies the sight picture instead of sprinting.
    this.holdBreath = CMD.ads && CMD.sprintHeld && this.move.stamina > 1;
    if (this.holdBreath) {
      CMD.sprintHeld = false;
      CMD.sprintPressed = false;
      this.move.stamina = Math.max(0, this.move.stamina - 11 * dt);
    }
  }

  /** Jumping at a ledge mantles it; running into a low one vaults automatically. */
  _tryMantle(dt) {
    if (this.mantle.active || this.move.stance === 'prone' || this.dead) return;
    const m = this.move;
    if (CMD.moveZ <= 0.1 && !CMD.jumpPressed) return;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const c = this.mantle.probe(m.position, _fwd, dt, CMD.jumpPressed);
    if (!c || !c.valid) return;
    const auto = m.grounded && m.hitWall && m.speedPeak > this.cfg.mantle.autoVaultSpeed
      && c.kind === 'vault' && CMD.moveZ > 0.5;
    if (!CMD.jumpPressed && !auto) return;
    CMD.jumpPressed = false;
    m.enterScripted();
    this.mantle.begin(m.position, _fwd, c);
    this.rig.fovPunch(this.cfg.mantle.fovPunch * (c.kind === 'vault' ? 0.6 : 1) * 0.055);
    this.ctx.bus.emit('player:mantle', { phase: 'start', kind: c.kind, height: c.height });
  }

  _updateLean(ctx, locked) {
    const inp = ctx.input;
    const blocked = this.move.sliding || this.mantle.active || this.move.sprinting || this.move.stance === 'prone';
    let want = 0;
    if (locked && !blocked) {
      if (inp.action('lean_left')) want -= 1;
      if (inp.action('lean_right')) want += 1;
    }
    this.leanInput = want;
    if (want !== 0) {
      if (++this._leanProbeTick >= 3) {
        this._leanProbeTick = 0;
        this.leanLimit = this.move.leanClearance(this.yaw, Math.sign(want), this.cfg.view.lean.offset);
      }
    } else {
      this.leanLimit = this.cfg.view.lean.offset;
      this._leanProbeTick = 3;
    }
  }

  _updateWeights(dt) {
    const m = this.move;
    this.sprintW = approach(this.sprintW, m.sprinting ? 1 : 0, 8, dt);
    this.tacW = approach(this.tacW, m.tacSprinting ? 1 : 0, 6, dt);
    this.slideW = approach(this.slideW, m.sliding ? 1 : 0, m.sliding ? 14 : 7, dt);
  }

  _updateView(dt, lookDx, lookDy) {
    const m = this.move;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    VS.velocity.copy(m.velocity);
    VS.right.copy(_right);
    VS.forward.copy(_fwd);
    VS.speed = m.speed;
    VS.grounded = m.grounded;
    VS.sliding = m.sliding;
    VS.sprinting = m.sprinting;
    VS.tacSprinting = m.tacSprinting;
    VS.stanceKey = m.stance === 'slide' || m.stance === 'mantle' ? 'crouch' : m.stance;
    VS.adsW = this.adsW;
    VS.holdBreath = this.holdBreath;
    VS.stamina01 = m.stamina / this.cfg.stamina.max;
    VS.leanInput = this.leanInput;
    VS.leanLimit = this.leanLimit;
    VS.lookDx = lookDx;
    VS.lookDy = lookDy;

    const sc = this.cfg.slide;
    const steer = this.slideW > 0.001 ? clamp(m.slideDir.dot(_right), -1, 1) : 0;
    VS.slideW = this.slideW;
    VS.slideRoll = -deg(sc.rollDeg) * clamp(steer + 0.55, -1, 1) * this.slideW;
    VS.slidePitch = -deg(sc.pitchDeg) * this.slideW;
    VS.crouchDip = this.mantle.active ? this.mantle.riseOffset : 0;

    this.view.update(dt, VS);

    RS.position.copy(m.position);
    RS.eyeHeight = m.eyeHeight;
    RS.yaw = this.yaw;
    RS.pitch = this.pitch;
    RS.offset.copy(this.view.offset);
    RS.viewPitch = this.view.pitch + this.mantle.pitchDeg * DEG;
    RS.viewYaw = this.view.yaw;
    RS.viewRoll = this.view.roll + this.mantle.rollDeg * DEG;
    RS.sprintW = this.sprintW;
    RS.tacW = this.tacW;
    RS.slideW = this.slideW;
    RS.adsW = this.adsW;
    RS.adsFov = this._weaponAdsFov();
    RS.extraFov = this.mantle.fovAdd;

    // Harness handed the camera back: adopt its transform so nothing pops.
    if (this.rig.consumeResume(_resume)) {
      this.yaw = _resume.yaw;
      this.pitch = clamp(_resume.pitch, -PITCH_LIMIT, PITCH_LIMIT);
      this.move.resetTransient();
      this.move.position.copy(_resume.position);
      this.move.position.y -= this.move.eyeHeight;
      this.mantle.cancel();
      this.view.reset();
      this.accum = 0;
      RS.position.copy(this.move.position);
      RS.eyeHeight = this.move.eyeHeight;
      RS.yaw = this.yaw;
      RS.pitch = this.pitch;
      RS.offset.set(0, 0, 0);
      RS.viewPitch = RS.viewYaw = RS.viewRoll = 0;
      RS.extraFov = 0;
    }

    this.rig.update(dt, RS);
    this.cameraRotation.set(RS.pitch + RS.viewPitch, RS.yaw + RS.viewYaw, RS.viewRoll, 'YXZ');
  }

  _weaponAdsFov() {
    const w = this.ctx.weapons;
    const cur = w?.current;
    const v = cur?.adsFov ?? cur?.fovADS ?? cur?.spec?.adsFov ?? w?.adsFov;
    return typeof v === 'number' && v > 10 ? v : this.cfg.fov.ads;
  }

  _updateHealth(dt) {
    const h = this.cfg.health;
    if (this.dead) {
      this._respawnIn -= dt;
      if (this._respawnIn <= 0) this._respawn();
      return;
    }
    if (this._regenHold > 0) this._regenHold -= dt;
    else if (this.health < h.max) this.health = Math.min(h.max, this.health + h.regenRate * dt);
  }

  _respawn() {
    this.dead = false;
    this.health = this.cfg.health.max;
    this.armour = this.cfg.health.armour;
    this.move.stamina = this.cfg.stamina.max;
    this._regenHold = 0;
    this._placeAtSpawn(true);
    this.view.reset();
    this.ctx.bus.emit('player:respawn', { position: this.move.position });
  }

  _placeAtSpawn(force = false) {
    const spawn = this.ctx.level?.spawns?.[0];
    if (spawn?.position) {
      this._spawn.copy(spawn.position);
      if (typeof spawn.yaw === 'number') this._spawnYaw = spawn.yaw;
      this._placed = true;
    } else if (this.ctx.level) {
      this._placed = true;
    }
    if (this._placed || force) {
      this.move.resetTransient();
      this.move.position.copy(this._spawn);
      this.yaw = this._spawnYaw;
      this.pitch = 0;
      this.accum = 0;
    }
  }

  _onLand(impact) {
    this.view.land(impact);
    this.rig.fovPunch(-clamp(impact * 0.010, 0, 0.20));
    const surface = this.bridge.surfaceUnder(this.move.position, _surfHit);
    this.ctx.bus.emit('player:land', {
      position: this.move.position.clone(),
      impact,
      surface,
      volume: clamp(impact / 9, 0.2, 1),
    });
  }

  _onFootstep(foot, volume) {
    const m = this.move;
    const surface = this.bridge.surfaceUnder(m.position, _surfHit);
    const stanceMul = m.stance === 'crouch' ? 0.45 : m.stance === 'prone' ? 0.25 : 1;
    this.ctx.bus.emit('player:footstep', {
      position: m.position.clone(),
      foot,
      surface,
      speed: m.speed,
      stance: m.stance,
      sprinting: m.sprinting,
      volume: volume * stanceMul * (m.tacSprinting ? 1.15 : 1),
    });
  }

  _setOverride(v) {
    this.override = !!v;
    this.rig.setOverride(v);
  }

  _publish() {
    const p = this.api;
    const m = this.move;
    p.yaw = this.yaw;
    p.pitch = this.pitch;
    p.stance = m.stance;
    p.sprinting = m.sprinting;
    p.tacSprinting = m.tacSprinting;
    p.grounded = m.grounded;
    p.sliding = m.sliding;
    p.mantling = this.mantle.active;
    p.health = this.health;
    p.armour = this.armour;
    p.stamina = m.stamina;
    p.dead = this.dead;
    p.eyeHeight = m.eyeHeight;
    p.speed = m.speed;
    p.moveSpeed01 = clamp(m.speed / this.cfg.speed.tacSprint, 0, 1);
    p.lean = this.view.leanSpring.value;
    p.fov = this.rig.fov;
    p.sensScale = this.rig.sensScale;
    p.bobPhase = this.view.phase;
    p.viewRot.pitch = this.view.pitch;
    p.viewRot.yaw = this.view.yaw;
    p.viewRot.roll = this.view.roll;
  }

  /** Deterministic posing hooks for the screenshot harness, attached lazily. */
  _bindAutomation() {
    if (this._hooksBound) return;
    const api = typeof window !== 'undefined' ? window.__COD__ : null;
    if (!api) return;
    this._hooksBound = true;
    api.setStance = (s) => {
      if (s === 'prone') { this.move.wantProne = true; this.move._enterStance('prone'); }
      else { this.move.wantProne = false; this.move._enterStance(s); }
    };
    api.teleportPlayer = (pos, yaw) => this.teleport(_tmp.set(pos[0], pos[1], pos[2]), yaw);
    api.playerRecoil = (p, y) => this.applyRecoil(p, y);
    api.playerState = () => ({
      pos: this.move.position.toArray(), yaw: this.yaw, pitch: this.pitch,
      stance: this.move.stance, speed: this.move.speed, fov: this.rig.fov,
      stamina: this.move.stamina, health: this.health,
      physics: this.bridge.usedFallback ? 'fallback' : 'solver',
    });
  }

  dispose() {
    this.view.onFootstep = null;
  }
}
