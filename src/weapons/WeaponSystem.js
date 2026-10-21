import * as THREE from 'three';
import { WEAPONS, DEFAULT_LOADOUT, makeResolver } from './WeaponDefs.js';
import { Viewmodel } from './Viewmodel.js';
import { Ballistics } from './Ballistics.js';
import { RecoilController } from './Recoil.js';
import { clamp } from './Springs.js';

/**
 * Weapons: viewmodel, firing, ballistics, recoil and all of the procedural
 * animation that sits between them.
 *
 * Ownership boundaries worth keeping in mind while editing:
 *  - the viewmodel lives in `ctx.viewScene`, never in `ctx.scene`;
 *  - materials always come from `ctx.materials.get`;
 *  - FX are called through the `ctx.fx` contract and every one of them is
 *    optional, because the FX system may still be a stub;
 *  - the camera belongs to the player, so recoil is *requested* through
 *    `ctx.player.applyRecoil` rather than applied here.
 *
 * Rounds are fired from the eye along the camera axis (which already carries
 * the recoil the player is fighting) and the tracer is drawn from the muzzle.
 * That is what every shooter does, and it is what stops close-range shots
 * landing where the barrel points rather than where the crosshair is.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mw = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _magHalf = new THREE.Vector3(0.026, 0.070, 0.032);
const _angVel = new THREE.Vector3();
const _snapshot = { yaw: 0, pitch: 0, speed01: 0, sprint: false, grounded: true, stance: 'stand', adsW: 0 };

const MAG_POOL = 3;

export class WeaponSystem {
  async init(ctx) {
    this.ctx = ctx;
    this.time = 0;
    this.resolve = makeResolver(ctx.materials);
    this.view = new Viewmodel(ctx, this.resolve);
    this.ballistics = new Ballistics(ctx);
    this.recoil = new RecoilController();

    this.loadout = DEFAULT_LOADOUT.slice();
    this.ammo = {};
    for (const id of this.loadout) {
      const d = WEAPONS[id];
      this.ammo[id] = { mag: d.mag, reserve: d.reserve };
    }

    this.currentId = null;
    this.def = null;
    this.lastShot = -99;
    this.burstLeft = 0;
    this.triggerHeld = false;
    this.reloading = false;
    this.reloadEmpty = false;
    this.pendingAutoReload = 0;
    this.fireModeIdx = 0;
    this.visible = true;

    // The muzzle flash light lives in the viewmodel scene: a flash that does
    // not light the weapon it comes out of is the single most common tell.
    this.flash = new THREE.PointLight(0xffd39a, 0, 1.4, 2.0);
    this.flash.castShadow = false;
    ctx.viewScene.add(this.flash);
    this.flashT = 0;

    this._magPool = [];
    this._magActive = [];

    this.switchTo(this.loadout[0]);

    const self = this;
    ctx.weapons = {
      get current() { return self.currentId; },
      get def() { return self.def; },
      loadout: this.loadout,
      ammo: this.ammo[this.currentId],
      isADS: false,
      adsProgress: 0,
      spread: 0,
      reloading: false,
      fireMode: this.def?.fireMode ?? 'auto',
      weapons: WEAPONS,
      switchTo: (id) => this.switchTo(id),
      next: () => this.cycle(1),
      fire: () => this.tryFire(true),
      reload: () => this.startReload(),
      setADS: (v) => this.setADS(v),
      inspect: () => this.view.inspect(),
      setVisible: (v) => this.setVisible(v),
      getMuzzleWorldMatrix: (out) => this.getMuzzleWorldMatrix(out || _mw),
      stats: this.ballistics.stats,
    };

    this._attachAutomation();
    // The player emits `player:land` with an `impact` (m/s of arrested fall),
    // not `player:landed` with a `speed`. Both halves were wrong, so the
    // weapon never dipped on landing — an event that never fires reading a
    // field that does not exist is invisible until someone diffs the two files.
    ctx.bus.on('player:land', (e) => this.view.land(e?.impact ?? e?.speed ?? 0));
  }

  // ------------------------------------------------------------- automation

  _attachAutomation() {
    const api = (window.__COD__ = window.__COD__ || {});
    if (api.setViewmodelVisible) return;
    api.setViewmodelVisible = (v) => this.setVisible(v);
    api.setADS = (v) => { this.setADS(v); this._snapADS(); };
    api.setWeapon = (id) => this.switchTo(id);
    api.weaponFire = () => this.tryFire(true);
    api.weaponInspect = () => this.view.inspect();
    api.weaponReload = () => this.startReload();
    api.weaponState = () => ({
      id: this.currentId,
      mag: this.ammo[this.currentId]?.mag,
      reserve: this.ammo[this.currentId]?.reserve,
      ads: this.view.adsW,
      spread: this.recoil.spread,
      tris: this.view.model?.tris ?? 0,
      draws: this.viewDrawCount(),
      sight: this.sightNDC(),
    });
  }

  /**
   * Screen position of the optical axis, in NDC. A misaligned sight is the
   * most noticeable bug an FPS can have and eyeballing a screenshot is not
   * good enough, so the alignment is measurable: under ADS this must read
   * (0, 0) to within the breathing amplitude.
   */
  sightNDC() {
    const n = this.view.model?.nodes?.sight;
    if (!n) return null;
    this.view.root.updateMatrixWorld(true);
    _v.setFromMatrixPosition(n.matrixWorld).project(this.ctx.viewCamera);
    return { x: +_v.x.toFixed(5), y: +_v.y.toFixed(5) };
  }

  viewDrawCount() {
    let n = 0;
    this.view.model?.root.traverse((o) => { if (o.isMesh && o.visible) n++; });
    return n;
  }

  /** Jump the ADS transition to its end state for a deterministic screenshot. */
  _snapADS() {
    this.view.adsRaw = this.view.adsTarget;
    this.view.adsW = this.view.adsTarget;
    this.view.sprintW = 0;
    const cam = this.ctx.viewCamera;
    if (cam && this.def) {
      cam.fov = this.def.viewFov[this.view.adsTarget > 0.5 ? 1 : 0];
      cam.updateProjectionMatrix();
    }
  }

  // ---------------------------------------------------------------- loadout

  switchTo(id) {
    const def = WEAPONS[id];
    if (!def || id === this.currentId) return;
    this.currentId = id;
    this.def = def;
    if (!this.ammo[id]) this.ammo[id] = { mag: def.mag, reserve: def.reserve };
    this.reloading = false;
    this.burstLeft = 0;
    this.fireModeIdx = Math.max(0, def.modes.indexOf(def.fireMode));
    this.recoil.setWeapon(def);
    this.view.select(id, def);
    this.view.setFireMode(def.modes[this.fireModeIdx]);
    if (this.ctx.weapons) {
      this.ctx.weapons.ammo = this.ammo[id];
      this.ctx.weapons.fireMode = def.modes[this.fireModeIdx];
    }
    const cam = this.ctx.viewCamera;
    if (cam) { cam.fov = def.viewFov[0]; cam.updateProjectionMatrix(); }
    this.ctx.bus.emit('weapon:switch', { weapon: id, def });
  }

  cycle(dir = 1) {
    const i = this.loadout.indexOf(this.currentId);
    const n = this.loadout.length;
    this.switchTo(this.loadout[(i + dir + n) % n]);
  }

  cycleFireMode() {
    const modes = this.def.modes;
    if (modes.length < 2) return;
    this.fireModeIdx = (this.fireModeIdx + 1) % modes.length;
    this.view.setFireMode(modes[this.fireModeIdx]);
    if (this.ctx.weapons) this.ctx.weapons.fireMode = modes[this.fireModeIdx];
  }

  setADS(v) { this.view.setADS(v); }

  setVisible(v) {
    this.visible = !!v;
    this.view.setVisible(!!v);
    // PostFX skips the viewmodel layer when the scene is hidden, and it counts
    // children — the lights alone would keep the scene "non-empty".
    this.ctx.viewScene.visible = !!v;
  }

  // ------------------------------------------------------------------ firing

  get canFire() {
    if (!this.def || this.reloading) return false;
    if (this.ammo[this.currentId].mag <= 0) return false;
    if (this.view.sprintW > 0.55) return false;
    return this.time - this.lastShot >= this.def.fireInterval;
  }

  tryFire(single = false) {
    if (!this.canFire) return false;
    const mode = this.def.modes[this.fireModeIdx];
    if (mode === 'burst' && single) this.burstLeft = 3;
    this._shoot();
    if (mode === 'burst' && this.burstLeft > 0) this.burstLeft--;
    return true;
  }

  _shoot() {
    const ctx = this.ctx;
    const d = this.def;
    const ammo = this.ammo[this.currentId];
    ammo.mag--;
    this.lastShot = this.time;

    const cam = ctx.camera;
    cam.getWorldPosition(_origin);
    cam.getWorldDirection(_dir);
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    // Start a little forward so a round never spawns inside the player capsule
    // and reports an instant impact on its owner.
    _origin.addScaledVector(_dir, 0.18);

    const cone = this.recoil.coneRadians;
    const pellets = d.pellets || 1;
    for (let i = 0; i < pellets; i++) {
      const a = Math.random() * Math.PI * 2;
      // sqrt keeps the distribution uniform over the disc instead of piling
      // every round into the middle of the cone.
      const r = Math.sqrt(Math.random()) * cone;
      _v.copy(_dir)
        .addScaledVector(_right, Math.cos(a) * Math.tan(r))
        .addScaledVector(_up, Math.sin(a) * Math.tan(r))
        .normalize();
      this.ballistics.spawn(_origin, _v, d, d.damage, 'player');
    }

    this.recoil.fire(ctx.player);
    this.view.fire(1);
    this.flashT = 1;

    this.getMuzzleWorldMatrix(_mw);
    const scale = d.class === 'pistol' ? 0.8 : d.class === 'shotgun' ? 1.5 : 1.0;
    ctx.fx?.muzzleFlash?.(_mw, scale);
    if (ctx.fx?.tracer) {
      _v.setFromMatrixPosition(_mw);
      _v2.copy(_v).addScaledVector(_dir, 90);
      ctx.fx.tracer(_v, _v2, d.muzzleVelocity);
    }
    this.getEjectWorldMatrix(_m);
    _right.setFromMatrixColumn(_m, 0).normalize().multiplyScalar(d.shell.speed);
    ctx.fx?.shellEject?.(_m, _right, d.caliber);
    ctx.fx?.screenShake?.(0.12 * (d.recoil.vert / 1.4), 0.09);

    ctx.bus.emit('weapon:fired', { weapon: this.currentId, def: d, muzzle: _mw, ammo: ammo.mag });

    if (ammo.mag <= 0) this.pendingAutoReload = 0.22;
  }

  // ----------------------------------------------------------------- reload

  startReload() {
    const ammo = this.ammo[this.currentId];
    if (this.reloading || ammo.reserve <= 0 || ammo.mag >= this.def.mag) return false;
    this.reloadEmpty = ammo.mag <= 0;
    this.reloading = true;
    this.pendingAutoReload = 0;
    this.view.startReload(this.reloadEmpty);
    this.ctx.bus.emit('weapon:reload', { weapon: this.currentId, stage: 'start', empty: this.reloadEmpty });
    return true;
  }

  _reloadStage(name) {
    this.ctx.bus.emit('weapon:reload', { weapon: this.currentId, stage: name, empty: this.reloadEmpty });
    if (name === 'magout') this._dropMagazine();
    if (name === 'boltrelease') this.view.pullChargingHandle();
    if (name === 'magseat') {
      const ammo = this.ammo[this.currentId];
      const take = Math.min(this.def.mag - ammo.mag, ammo.reserve);
      ammo.mag += take;
      ammo.reserve -= take;
    }
    if (name === 'raise') this.reloading = false;
  }

  /**
   * The spent magazine leaves as a real rigid body carrying the player's own
   * motion, so it bounces off the kerb rather than fading out.
   */
  _dropMagazine() {
    const ctx = this.ctx;
    const model = this.view.model;
    const node = model?.nodes?.magSocket;
    if (!node || !ctx.physics?.addRigidBody) return;
    this.view.root.updateMatrixWorld(true);
    _mw.multiplyMatrices(ctx.camera.matrixWorld, node.matrixWorld);
    _v.setFromMatrixPosition(_mw);
    _q.setFromRotationMatrix(_mw);

    const mesh = this._acquireMagMesh(model);
    if (!mesh) return;
    _up.set(0, -0.6, 0.15).applyQuaternion(ctx.camera.quaternion);
    if (ctx.player?.velocity) _up.addScaledVector(ctx.player.velocity, 0.85);
    const L = ctx.physics.LAYER;
    const body = ctx.physics.addRigidBody({
      type: 'box',
      // Inflated relative to the real 26 x 62 x 185 mm magazine on purpose: the
      // rigid-body solver resolves boxes as eight corner contacts with an 18 mm
      // skin, so a half-extent below that is permanently self-penetrating and
      // the body launches itself to infinity on the first step. Measured.
      halfExtents: _magHalf,
      mass: 0.11,
      position: _v,
      quaternion: _q,
      velocity: _up,
      angularVelocity: _angVel.set(
        (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 7,
      ),
      restitution: 0.16,
      friction: 0.75,
      linearDamping: 0.10,
      angularDamping: 0.9,
      life: 9,
      mask: L ? L.WORLD | L.PROPS : undefined,
    });
    if (!body) { this._releaseMagMesh(mesh); return; }
    mesh.visible = true;
    // The clone is authored in weapon space, so its origin is the receiver, not
    // the magazine. Ride the body back down the socket offset to line them up.
    this._magActive.push({ body, mesh, t: 0, off: node.position.clone() });
  }

  _acquireMagMesh(model) {
    let m = this._magPool.pop();
    if (m) return m;
    if (this._magActive.length >= MAG_POOL) {
      const oldest = this._magActive.shift();
      this.ctx.physics?.removeRigidBody?.(oldest.body);
      oldest.mesh.visible = false;
      return oldest.mesh;
    }
    const src = model.parts.magazine?.group;
    if (!src) return null;
    m = src.clone(true);
    m.position.set(0, 0, 0);
    m.quaternion.identity();
    m.visible = false;
    m.traverse((o) => { if (o.isMesh) { o.frustumCulled = true; o.matrixAutoUpdate = false; o.castShadow = true; } });
    this.ctx.scene.add(m);
    return m;
  }

  _releaseMagMesh(m) { m.visible = false; this._magPool.push(m); }

  _updateMags(dt) {
    for (let i = this._magActive.length - 1; i >= 0; i--) {
      const e = this._magActive[i];
      e.t += dt;
      const b = e.body;
      if (!b || b.active === false || e.t > 9) {
        this.ctx.physics?.removeRigidBody?.(b);
        this._releaseMagMesh(e.mesh);
        this._magActive.splice(i, 1);
        continue;
      }
      // The magazine hangs from its mouth, so ride the body's centre up its
      // own local axis to put the geometry where the collider is.
      e.mesh.position.copy(b.position);
      e.mesh.quaternion.copy(b.quaternion);
      e.mesh.translateX(-e.off.x);
      e.mesh.translateY(-e.off.y);
      e.mesh.translateZ(-e.off.z);
      e.mesh.updateMatrix();
      e.mesh.updateMatrixWorld(true);
    }
  }

  // ------------------------------------------------------------------ frame

  fixedUpdate(fixedDt) {
    this.ballistics.fixedUpdate(fixedDt);
  }

  update(dt, ctx) {
    this.time += dt;
    if (!this.def) return;
    this._attachAutomation();

    const p = ctx.player;
    const input = ctx.input;
    const locked = !!input?.locked;

    if (locked) {
      this.setADS(!!input.mouse.right);
      this.triggerHeld = !!input.mouse.left;
      if (input.actionPressed('reload')) this.startReload();
      if (input.actionPressed('nextWeapon')) this.cycle(1);
      if (input.actionPressed('inspect')) this.view.inspect();
      if (input.actionPressed('melee')) this.cycleFireMode();

      const mode = this.def.modes[this.fireModeIdx];
      if (mode === 'auto') { if (this.triggerHeld) this.tryFire(); }
      else if (mode === 'burst') {
        if (input.mousePressed.left) this.tryFire(true);
        else if (this.burstLeft > 0) this.tryFire(false);
      } else if (input.mousePressed.left) this.tryFire(true);
    } else {
      this.triggerHeld = false;
    }

    if (this.pendingAutoReload > 0) {
      this.pendingAutoReload -= dt;
      if (this.pendingAutoReload <= 0) this.startReload();
    }

    // --- viewmodel ---------------------------------------------------------
    _snapshot.yaw = p?.yaw ?? 0;
    _snapshot.pitch = p?.pitch ?? 0;
    _snapshot.speed01 = clamp(p?.moveSpeed01 ?? 0, 0, 1.4);
    _snapshot.sprint = !!p?.sprinting;
    _snapshot.grounded = p?.grounded !== false;
    _snapshot.stance = p?.stance || 'stand';
    _snapshot.adsW = this.view.adsW;

    const stage = this.view.update(dt, _snapshot);
    if (stage) this._reloadStage(stage);

    this.recoil.update(dt, p, _snapshot);
    this._updateMags(dt);

    // Muzzle flash light decay, in viewmodel space.
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt / 0.045);
      const n = this.view.model?.nodes?.muzzle;
      if (n) {
        this.view.root.updateMatrixWorld(true);
        this.flash.position.setFromMatrixPosition(n.matrixWorld);
        this.flash.position.z += 0.06;
      }
      this.flash.intensity = 26 * this.flashT * this.flashT;
    } else if (this.flash.intensity !== 0) {
      this.flash.intensity = 0;
    }

    // Viewmodel FOV tracks the ADS blend so the optic grows into frame rather
    // than the whole weapon snapping scale.
    const cam = ctx.viewCamera;
    if (cam) {
      const f = this.def.viewFov;
      const want = f[0] + (f[1] - f[0]) * clamp(this.view.adsW, 0, 1);
      if (Math.abs(cam.fov - want) > 0.01) { cam.fov = want; cam.updateProjectionMatrix(); }
    }

    this._updateFocus(dt, ctx);

    // --- publish -----------------------------------------------------------
    const api = ctx.weapons;
    api.ammo = this.ammo[this.currentId];
    api.isADS = this.view.adsW > 0.5;
    api.adsProgress = clamp(this.view.adsRaw, 0, 1);
    api.spread = this.recoil.spread;
    api.reloading = this.reloading;
    api.fireMode = this.def.modes[this.fireModeIdx];
    if (p) p.isADS = api.isADS;
  }

  /**
   * Rack the world depth of field onto whatever the shooter is actually
   * aiming at while aiming.
   *
   * PostFX enables its DOF pass whenever `isADS` is true, and its defaults are
   * authored for the cinematic camera: 8 m focus over a 0.55 range, which
   * blurs everything past about 12 m into mush. That is wrong for ADS — a real
   * shooter's eye focuses at the target and the world stays legible; it is the
   * *weapon* that goes soft, and the viewmodel composite already does that.
   * Both values are restored on exit so the cinematic look is untouched.
   */
  _updateFocus(dt, ctx) {
    const fx = ctx.postfx;
    if (!fx?.set) return;
    const ads = this.view.adsW > 0.02;
    if (ads) {
      if (this._dofSaved === undefined) {
        this._dofSaved = { focus: fx.get('dofFocus'), range: fx.get('dofRange'), radius: fx.get('dofRadius') };
      }
      ctx.camera.getWorldPosition(_origin);
      ctx.camera.getWorldDirection(_dir);
      const hit = ctx.physics?.raycast?.(_origin, _dir, 220);
      const want = hit ? clamp(hit.distance, 3, 160) : 70;
      this._focus = this._focus === undefined ? want : this._focus + (want - this._focus) * (1 - Math.exp(-5 * dt));
      fx.set('dofFocus', this._focus);
      // Wide range, small radius: enough separation to read as an eye focused
      // downrange, not enough to stop the player identifying what they are
      // aiming at. Call of Duty keeps the world sharp under ADS.
      fx.set('dofRange', 3.2);
      fx.set('dofRadius', 2.6);
    } else if (this._dofSaved !== undefined) {
      fx.set('dofFocus', this._dofSaved.focus);
      fx.set('dofRange', this._dofSaved.range);
      fx.set('dofRadius', this._dofSaved.radius);
      this._dofSaved = undefined;
      this._focus = undefined;
    }
  }

  // -------------------------------------------------------------- transforms

  /**
   * The viewmodel lives in camera space, so its world transform is the camera
   * matrix times the node's local-to-viewscene matrix. FX consume this to
   * place flashes and casings in the world.
   */
  getMuzzleWorldMatrix(out) {
    const n = this.view.model?.nodes?.muzzle;
    if (!n) return out.identity();
    this.view.root.updateMatrixWorld(true);
    return out.multiplyMatrices(this.ctx.camera.matrixWorld, n.matrixWorld);
  }

  getEjectWorldMatrix(out) {
    const n = this.view.model?.nodes?.eject;
    if (!n) return out.identity();
    this.view.root.updateMatrixWorld(true);
    return out.multiplyMatrices(this.ctx.camera.matrixWorld, n.matrixWorld);
  }

  dispose() {
    this.view.dispose();
    this.ballistics.clear();
  }
}
