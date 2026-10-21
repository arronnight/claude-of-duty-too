import * as THREE from 'three';
import { getRigGeometry, createSkeleton, HITBOX_DEFS, MUZZLE } from './BotRig.js';
import { BotAnimator, solveTwoBone } from './BotAnimator.js';
import { Perception } from './Perception.js';
import { buildTree } from './Behaviour.js';
import { makePathBuffer } from './NavMesh.js';

/**
 * One combatant: body, brain and the bookkeeping that joins them.
 *
 * The two skinned meshes share geometry with every other bot and live directly
 * under the AI root with an identity transform — only the bone hierarchy is
 * parented to the bot's pivot. That is deliberate: if the mesh moved with the
 * pivot as well as the bones, the bot's transform would be applied twice. The
 * cost is that frustum culling has to be told where the bot is, which is one
 * vector copy per frame into `mesh.boundingSphere`.
 *
 * Hitboxes are oriented boxes attached to bones and resolved lazily at the
 * moment of a hitscan, so nothing is spent maintaining them for bots nobody is
 * shooting at.
 */

const MASK_WORLD = 1 | 2;
const RIFLE = {
  rpm: 620, mag: 30, damage: 24, velocity: 860,
  burst: [3, 6], burstGap: [0.35, 1.0], reload: 2.3,
};

// Sound signature per team. Both sides carry the same ballistic profile, but a
// firefight where you cannot tell incoming from outgoing by ear is a worse
// firefight; the audio system already has six distinct gun signatures.
const TEAM_GUN = { a: 'm4', b: 'ak74' };

/**
 * How far the torso may twist away from the feet before the body has to turn.
 * Kept comfortably inside the animator's own +/-1.25 rad aim clamp so the clamp
 * is a backstop rather than the thing the pose runs into.
 */
export const MAX_TWIST = 1.10;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _w0 = new THREE.Vector3();
const _w1 = new THREE.Vector3();
const _w2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

function shortAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Deterministic per-bot noise: reproducible screenshots, varied bots. */
function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class Bot {
  constructor(ai, index) {
    this.ai = ai;
    this.index = index;
    this.seed = index * 0.6180339887 % 1;
    this.rand = rng(index + 7);

    const geo = getRigGeometry();
    const rig = createSkeleton();
    this.rig = rig;
    this.pivot = new THREE.Group();
    this.pivot.name = `bot${index}`;
    this.pivot.add(rig.root);
    this.pivot.matrixAutoUpdate = true;

    // ONE skinned mesh. Everything a bot is made of samples one packed kit
    // atlas, so the two halves that used to cost two colour draws and two draws
    // per shadow cascade are now one of each. `meshes` stays an array because a
    // bot may still legitimately grow a second mesh (a dropped weapon, a
    // detached helmet) and every consumer already iterates it.
    const mesh = new THREE.SkinnedMesh(geo.kit, ai.botMaterial(index));
    mesh.name = `bot${index}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Bind in the mesh's own (identity) space: the bones carry the world
    // transform, the mesh must not.
    mesh.bind(rig.skeleton, new THREE.Matrix4());
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.65);
    mesh.visible = false;
    this.meshes = [mesh];
    this.body = mesh;

    this.anim = new BotAnimator(rig.byName);
    this.sense = new Perception(this);
    this.tree = buildTree();
    this.path = makePathBuffer();

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.desired = new THREE.Vector3();
    this.goal = new THREE.Vector3();
    this.aimPoint = new THREE.Vector3();
    this.patrolPoint = null;
    this.capsule = null;

    this.hitboxes = HITBOX_DEFS.map((d) => ({
      part: d.part,
      mult: d.mult,
      bone: rig.byName.get(d.bone),
      off: new THREE.Vector3(d.off[0], d.off[1], d.off[2]),
      half: new THREE.Vector3(d.half[0], d.half[1], d.half[2]),
    }));
    this.body.userData.bot = this;
    this.body.userData.hitboxes = this.hitboxes;

    this.mem = {};
    this.alive = false;
    this.active = false;
    this.reset();
  }

  reset() {
    this.team = 'b';
    this.health = 100;
    this.maxHealth = 100;
    this.alive = false;
    this.active = false;
    this.frozen = false;
    this.yaw = 0;
    this.aimYaw = 0;
    this.speed = 0;
    this.crouch = 0;
    this.aiming = 0;
    this.carry = null;
    this.wantFire = false;
    this.suppressing = false;
    this.inCover = false;
    this.peeking = false;
    this.peekSide = 1;
    this.cover = null;
    this.hasGoal = false;
    this.goalSpeed = 1;
    this.state = 'idle';
    this.stateTime = 0;
    this.combatTime = 0;
    this.ammo = RIFLE.mag;
    this.magSize = RIFLE.mag;
    this.reloadTimer = 0;
    this.shotTimer = 0;
    this.burstLeft = 0;
    this.burstGap = 0;
    this.aimError = 0.12;
    this.pathAge = 99;
    this.ragdoll = null;
    this.muzzleFlash = 0;
    this.stuck = 0;
    this.avoidDir = 0;
    this.velocity.set(0, 0, 0);
    for (const k in this.mem) delete this.mem[k];
    this.sense.reset();
  }

  // ------------------------------------------------------------ lifecycle

  spawn(team, position, yaw, ctx) {
    this.reset();
    this.team = team;
    this.alive = true;
    this.active = true;
    this.position.copy(position);
    this.yaw = yaw ?? 0;
    this.aimYaw = this.yaw;
    this.peekSide = this.rand() < 0.5 ? -1 : 1;
    this.aimPoint.set(
      position.x + Math.sin(this.yaw) * 12, position.y + 1.5, position.z + Math.cos(this.yaw) * 12,
    );

    if (ctx.physics?.createCapsule) {
      this.capsule = this.capsule || ctx.physics.createCapsule(this.position, 0.34, 1.78);
      this.capsule.position.copy(this.position);
      ctx.physics.moveCharacter?.(this.capsule, _v0.set(0, 0, 0), 1 / 120);
    }
    this.anim.reset(this.position, this.yaw);
    this._castShadow = true;
    for (const m of this.meshes) { m.visible = true; m.castShadow = true; }
    this._syncBounds(ctx);
    this.pivot.position.copy(this.position);
    this.pivot.rotation.set(0, this.yaw, 0);
    this.pivot.updateMatrixWorld(true);
    return this;
  }

  despawn() {
    this.active = false;
    this.alive = false;
    for (const m of this.meshes) m.visible = false;
    if (this.cover && this.ai.coverTaken.get(this.cover) === this) this.ai.coverTaken.delete(this.cover);
    this.cover = null;
    this.ragdoll?.release?.();
    this.ragdoll = null;
  }

  eyePosition(out) {
    return out.set(
      this.position.x,
      this.position.y + (this.crouch > 0.5 ? 1.20 : 1.62),
      this.position.z,
    );
  }

  get eyeHeight() { return this.crouch > 0.5 ? 1.20 : 1.62; }
  get stance() { return this.crouch > 0.5 ? 'crouch' : 'stand'; }
  get sprinting() { return this.speed > 3.2; }

  // -------------------------------------------------------- brain plumbing

  moveTo(target, speedScale = 1) {
    this.hasGoal = true;
    this.goalSpeed = speedScale;
    if (this.goal.distanceToSquared(target) > 1.4 || this.pathAge > 1.6) {
      this.goal.copy(target);
      this._repath();
    }
  }

  stop() {
    this.hasGoal = false;
  }

  aimAt(point, lag = 1) {
    this.aimPoint.lerp(point, lag);
    this.aiming = 1;
  }

  aimAtKnown(lag = 1) {
    if (this.sense.visible && this.sense.target) {
      const t = this.sense.target;
      _v0.copy(t.position);
      _v0.y += (t.eyeHeight || 1.6) * 0.62;
      // Lead a moving target by a fraction of the flight time — enough to look
      // deliberate, never enough to be perfect.
      if (t.velocity) {
        const flight = _v0.distanceTo(this.position) / RIFLE.velocity;
        _v0.addScaledVector(t.velocity, flight * (0.35 + this.ai.difficulty * 0.5));
      }
      this.aimPoint.lerp(_v0, lag);
      this.aiming = 1;
    } else if (this.sense.hasLastKnown) {
      this.aimPoint.lerp(this.sense.lastKnown, lag * 0.5);
      this.aiming = 1;
    } else {
      this.aimAhead();
    }
  }

  aimAhead() {
    const d = this.hasGoal && this.speed > 0.4 ? 1 : 0;
    _v0.set(
      this.position.x + Math.sin(this.yaw) * 14,
      this.position.y + 1.5,
      this.position.z + Math.cos(this.yaw) * 14,
    );
    this.aimPoint.lerp(_v0, 0.06 + d * 0.04);
    this.aiming = 0.25;
  }

  pickPatrolPoint(ctx) {
    const nav = this.ai.nav;
    const pts = ctx.level?.coverPoints;
    // Prefer walking between cover points — that is where a soldier goes —
    // falling back to a random spot on the navmesh.
    if (pts && pts.length && this.rand() < 0.75) {
      const cp = pts[(this.rand() * pts.length) | 0];
      if (cp?.position) {
        this.patrolPoint = this.patrolPoint || new THREE.Vector3();
        this.patrolPoint.copy(cp.position);
        if (cp.normal) this.patrolPoint.addScaledVector(cp.normal, 1.4);
        this.patrolPoint.y = this.position.y;
        return;
      }
    }
    if (nav?.ready && nav.polys.length) {
      const poly = nav.polys[(this.rand() * nav.polys.length) | 0];
      this.patrolPoint = this.patrolPoint || new THREE.Vector3();
      // A point inside a convex polygon: the centroid pulled toward a vertex.
      const vi = (this.rand() * poly.n) | 0;
      const t = 0.25 + this.rand() * 0.6;
      this.patrolPoint.set(
        THREE.MathUtils.lerp(poly.cx, poly.pts[vi * 2], t),
        poly.y,
        THREE.MathUtils.lerp(poly.cz, poly.pts[vi * 2 + 1], t),
      );
    }
  }

  _repath() {
    this.pathAge = 0;
    const nav = this.ai.nav;
    if (nav?.ready && nav.findPath(this.position, this.goal, this.path)) {
      this.path.cursor = Math.min(1, this.path.count - 1);
      return;
    }
    // No navmesh answer: head straight there and let steering sort it out.
    this.path.xz[0] = this.position.x; this.path.xz[1] = this.position.z;
    this.path.xz[2] = this.goal.x; this.path.xz[3] = this.goal.z;
    this.path.count = 2;
    this.path.cursor = 1;
  }

  // ------------------------------------------------------------ simulation

  update(dt, ctx, contacts) {
    if (!this.active) return;
    if (!this.alive) { this._updateRagdoll(dt, ctx); return; }

    if (this.frozen) {
      this._animate(dt, ctx);
      return;
    }

    this.pathAge += dt;
    this.sense.update(dt, ctx, contacts);
    if (this.sense.visible) this.combatTime += dt;
    else if (ctx.time - this.sense.lastSeen > 6) this.combatTime = 0;

    this.aiming = 0;
    this.wantFire = false;
    this.tree.tick(this, dt, ctx);

    this._steer(dt, ctx);
    this._face(dt);
    this._shoot(dt, ctx);
    this._animate(dt, ctx);
  }

  /** Path following, separation and the character sweep. */
  _steer(dt, ctx) {
    const cfg = this.ai.speeds;
    let want = 0;
    this.desired.set(0, 0, 0);

    if (this.hasGoal && this.path.count > 0) {
      // Advance along the pulled path.
      let cur = Math.min(this.path.cursor, this.path.count - 1);
      let wx = this.path.xz[cur * 2], wz = this.path.xz[cur * 2 + 1];
      let d = Math.hypot(wx - this.position.x, wz - this.position.z);
      while (d < 0.65 && cur < this.path.count - 1) {
        cur++;
        wx = this.path.xz[cur * 2]; wz = this.path.xz[cur * 2 + 1];
        d = Math.hypot(wx - this.position.x, wz - this.position.z);
      }
      this.path.cursor = cur;
      const goalDist = Math.hypot(this.goal.x - this.position.x, this.goal.z - this.position.z);
      if (goalDist > 0.55) {
        want = cfg.walk + (cfg.run - cfg.walk) * THREE.MathUtils.clamp(this.goalSpeed, 0, 1);
        want *= (1 - this.crouch * 0.45);
        // Ease into the last metre so bots do not skid to a halt.
        want *= THREE.MathUtils.clamp(goalDist / 1.1, 0.25, 1);
        if (d > 1e-4) this.desired.set((wx - this.position.x) / d, 0, (wz - this.position.z) / d);
      }
    }
    if (this.avoidDir && want > 0) {
      // Slide sideways along whatever is blocking us.
      const a = this.avoidDir * 1.15;
      const cx = Math.cos(a), sx = Math.sin(a);
      const dx = this.desired.x, dz = this.desired.z;
      this.desired.x = dx * cx + dz * sx;
      this.desired.z = -dx * sx + dz * cx;
    }
    this.desired.multiplyScalar(want);

    // Separation. Bots are not physics-solid against each other — a push-apart
    // force is cheaper, never jitters, and looks like people avoiding people.
    for (const other of this.ai.bots) {
      if (other === this || !other.active || !other.alive) continue;
      _v0.copy(this.position).sub(other.position).setY(0);
      const dsq = _v0.lengthSq();
      if (dsq > 2.4 * 2.4 || dsq < 1e-6) continue;
      const dd = Math.sqrt(dsq);
      _v0.multiplyScalar((1 / dd) * (2.4 - dd) * 1.5);
      this.desired.add(_v0);
    }
    if (this.desired.lengthSq() > cfg.run * cfg.run) this.desired.setLength(cfg.run);

    // Accelerate toward the desired velocity, then let the character sweep
    // resolve the world.
    const accel = 13 * dt;
    _v0.copy(this.desired).sub(this.velocity).setY(0);
    const mag = _v0.length();
    if (mag > accel) _v0.multiplyScalar(accel / mag);
    this.velocity.add(_v0);
    this.velocity.y = -6;

    const phys = ctx.physics;
    _v1.copy(this.position);
    if (phys?.moveCharacter && this.capsule) {
      const res = phys.moveCharacter(this.capsule, this.velocity, dt, MASK_WORLD);
      this.position.copy(this.capsule.position);
      if (res?.grounded) this.velocity.y = 0;
    } else {
      this.position.addScaledVector(this.velocity, dt);
      this.position.y = this.ai.nav?.heightAt(this.position.x, this.position.z, this.position.y) ?? 0;
    }

    // Adopt what actually happened as the velocity. Without this a bot walking
    // into a wall keeps its intended 3.6 m/s for ever: the animator leans it
    // into a sprint it is not doing, and the acceleration term never notices.
    const inv = 1 / Math.max(dt, 1e-4);
    this.velocity.x = (this.position.x - _v1.x) * inv;
    this.velocity.z = (this.position.z - _v1.z) * inv;
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // Unstick. The navmesh knows about the level, not about the props dropped
    // on top of it, so a bot will occasionally path straight into a crate.
    // Wall-follow for a moment, then give up on the goal entirely.
    if (want > 0.6 && this.speed < want * 0.35) {
      this.stuck += dt;
      if (this.stuck > 0.45 && !this.avoidDir) this.avoidDir = this.rand() < 0.5 ? -1 : 1;
      if (this.stuck > 2.6) {
        this.stuck = 0;
        this.avoidDir = 0;
        this.pathAge = 99;
        this.goal.set(9e9, 0, 9e9);
        if (this.cover && this.ai.coverTaken.get(this.cover) === this) {
          this.ai.coverTaken.delete(this.cover);
        }
        this.cover = null;
      }
    } else if (this.stuck > 0) {
      this.stuck = Math.max(0, this.stuck - dt * 2.5);
      if (this.stuck === 0) this.avoidDir = 0;
    }
  }

  /** Body yaw: toward the threat when fighting, toward travel when not. */
  _face(dt) {
    const engaged = this.aiming > 0.5;
    _v0.copy(this.aimPoint).sub(this.position);
    this.aimYaw = Math.atan2(_v0.x, _v0.z);
    let target;
    if (engaged) {
      target = this.aimYaw;
    } else if (this.speed > 0.35) {
      target = Math.atan2(this.velocity.x, this.velocity.z);
    } else {
      target = this.aimYaw;
    }
    const err = shortAngle(target - this.yaw);
    // Turn faster when there is a threat and when the error is large; a
    // constant rate reads as a turret.
    const rate = (engaged ? 5.5 : 3.4) * (0.35 + Math.min(Math.abs(err), 1.6));
    const step = THREE.MathUtils.clamp(err, -rate * dt, rate * dt);
    this.yaw += step;

    // The upper body may twist MAX_TWIST toward the aim and no further. Past
    // that the animator's own clamp saturates, the weapon-bone target lands
    // behind the chest, and the arm solver reaches past it and splays into a
    // T-pose — which is exactly what the far bot in `combat` was doing. A
    // soldier turns his feet; he does not twist his neck 180 degrees. So the
    // excess goes into the body yaw instead, every frame, unconditionally.
    const rel = shortAngle(this.aimYaw - this.yaw);
    if (Math.abs(rel) > MAX_TWIST) this.yaw += rel - Math.sign(rel) * MAX_TWIST;
  }

  _animate(dt, ctx) {
    const a = this.anim;
    _v0.copy(this.velocity).setY(0);
    this._animState = this._animState || {
      pos: this.position, velocity: _v0, yaw: 0, speed: 0, crouch: 0, aiming: 0,
      aimPoint: this.aimPoint, aimYaw: 0, dt: 0, carry: null,
      groundAt: (x, z, fallback) => this._groundAt(x, z, fallback, ctx),
      onFootDown: (foot, speed) => this._footstep(foot, speed, ctx),
    };
    const s = this._animState;
    s.velocity = _v0;
    s.yaw = this.yaw;
    s.speed = this.speed;
    s.crouch = this.crouch;
    s.aiming = this.aiming > 0.5 ? 1 : 0;
    s.aimYaw = this.aimYaw;
    s.carry = this.carry;
    s.dt = dt;
    s.ctx = ctx;
    a.update(s);

    this.pivot.position.copy(this.position);
    this.pivot.rotation.set(0, this.yaw, 0);
    this.pivot.updateMatrixWorld(true);
    this._syncBounds(ctx);
    if (this.muzzleFlash > 0) this.muzzleFlash -= dt;
  }

  _syncBounds(ctx) {
    // Culling has to be told where a skinned mesh is: its bones carry the
    // transform, its own matrix is identity, and three caches the first
    // computed sphere for ever.
    for (const m of this.meshes) {
      m.boundingSphere.center.set(this.position.x, this.position.y + 0.95, this.position.z);
    }
    // A bot two blocks away contributes a few pixels of shadow and costs one
    // draw in every cascade it touches. Past 22 m it stops casting: a cast
    // shadow at 30 m through this much haze is a handful of pixels, and the
    // cutoff is what caps the worst case as the bot count rises.
    const cam = ctx?.camera;
    if (cam) {
      const dx = cam.position.x - this.position.x, dz = cam.position.z - this.position.z;
      const near = dx * dx + dz * dz < 22 * 22;
      if (near !== this._castShadow) {
        this._castShadow = near;
        for (const m of this.meshes) m.castShadow = near;
      }
    }
  }

  _groundAt(x, z, fallback, ctx) {
    const phys = ctx?.physics;
    if (!phys?.raycast) return fallback;
    _v1.set(x, this.position.y + 0.9, z);
    _v2.set(0, -1, 0);
    const hit = phys.raycast(_v1, _v2, 2.4, MASK_WORLD);
    return hit ? hit.point.y : fallback;
  }

  _footstep(foot, speed, ctx) {
    if (speed < 0.5) return;
    _v1.copy(foot.plant);
    ctx?.audio?.playAt?.('footstep', _v1, { volume: Math.min(1, speed / 3) });
    // Footsteps are audible: a sprinting bot gives itself away.
    this.ai.emitNoise(_v1, speed > 2.6 ? 0.22 : 0.10, this.team, ctx);
  }

  // ---------------------------------------------------------------- combat

  _shoot(dt, ctx) {
    if (this.reloadTimer > 0) { this.reloadTimer -= dt; return; }
    this.shotTimer -= dt;
    this.burstGap -= dt;

    // Aim error decays toward the difficulty floor while the bot holds the
    // target, and is kicked back up whenever the situation changes. This is
    // what makes the first burst go wide and the third one hurt.
    const settle = this.speed > 1.2 ? 0.35 : 1;
    const floor = this.ai.aimFloor * (this.crouch > 0.5 ? 0.72 : 1);
    this.aimError += (floor - this.aimError) * Math.min(1, dt * 1.5 * settle);

    if (!this.wantFire || this.ammo <= 0) { this.burstLeft = 0; return; }
    if (this.burstLeft <= 0) {
      if (this.burstGap > 0) return;
      const [lo, hi] = RIFLE.burst;
      this.burstLeft = lo + ((this.rand() * (hi - lo + 1)) | 0);
      if (this.suppressing) this.burstLeft += 2;
      this.aimError = Math.max(this.aimError, this.ai.aimBurst * (this.suppressing ? 1.5 : 1));
    }
    if (this.shotTimer > 0) return;

    this.shotTimer = 60 / RIFLE.rpm;
    this.burstLeft--;
    this.ammo--;
    if (this.burstLeft <= 0) {
      const [lo, hi] = RIFLE.burstGap;
      this.burstGap = lo + this.rand() * (hi - lo);
    }
    if (this.ammo <= 0) this.reloadTimer = RIFLE.reload;
    this._fireShot(ctx);
  }

  _fireShot(ctx) {
    const muzzle = this.anim.muzzleWorld(this.position, this.yaw, MUZZLE, _v1);
    _v2.copy(this.aimPoint).sub(muzzle);
    const dist = _v2.length();
    if (dist < 1e-3) return;
    _v2.multiplyScalar(1 / dist);

    // Scatter inside a cone: a uniform disc on the plane normal to the bore.
    const ang = this.rand() * Math.PI * 2;
    const rad = Math.sqrt(this.rand()) * this.aimError;
    _v3.set(-_v2.z, 0, _v2.x);
    if (_v3.lengthSq() < 1e-6) _v3.set(1, 0, 0);
    _v3.normalize();
    _v4.crossVectors(_v2, _v3);
    _v2.addScaledVector(_v3, Math.cos(ang) * rad).addScaledVector(_v4, Math.sin(ang) * rad).normalize();

    this.anim.fire(1);
    this.muzzleFlash = 0.06;

    // Muzzle flash and report.
    _m0.makeRotationFromQuaternion(_q0.setFromUnitVectors(UP, _v2));
    _m0.setPosition(muzzle);
    ctx.fx?.muzzleFlash?.(_m0, 0.7);
    // The report goes out on the bus only. It used to *also* go straight to
    // ctx.audio, which was the sole reason bots were audible at all — the
    // audio system's listener was bound to `bot:fired`, an event nothing
    // emits. With the listener corrected, playing it here as well would fire
    // every bot shot twice.
    ctx.bus?.emit('ai:fired', {
      bot: this, muzzle, dir: _v2, team: this.team,
      weapon: TEAM_GUN[this.team] || 'ak74',
    });
    this.ai.emitNoise(muzzle, 1, this.team, ctx);

    // Resolve the shot: nearest of world geometry and any character.
    const phys = ctx.physics;
    const worldHit = phys?.raycast ? phys.raycast(muzzle, _v2, 140, MASK_WORLD) : null;
    let limit = worldHit ? worldHit.distance : 140;
    const charHit = this.ai.hitscan(muzzle, _v2, limit, this);

    if (charHit) {
      limit = charHit.distance;
      _v3.copy(_v2).multiplyScalar(limit).add(muzzle);
      const falloff = limit <= 25 ? 1 : limit >= 55 ? 0.6 : 1 - 0.4 * (limit - 25) / 30;
      const dmg = RIFLE.damage * falloff * charHit.mult;
      ctx.fx?.bloodHit?.(_v3, _v2, _v2);
      if (charHit.bot) charHit.bot.applyDamage(dmg, _v2, charHit.part, this, ctx);
      else if (ctx.player?.damage) {
        _v4.copy(this.position).sub(ctx.player.position).setY(0).normalize();
        ctx.player.damage(dmg, _v4);
      }
    } else {
      if (worldHit) ctx.fx?.impact?.(worldHit.point, worldHit.normal, worldHit.material || 'concrete_wall', 1);
      // A round that missed but went past the player's head. `bullet:whizz`
      // had a listener in the audio system and no emitter anywhere, so the
      // single loudest cue that you are being shot at was missing. Note this
      // is outside the `worldHit` test: a round down an open street hits
      // nothing at all and is exactly the one you most need to hear.
      this._whizz(muzzle, _v2, limit, ctx);
    }
    ctx.fx?.tracer?.(muzzle, _v3.copy(_v2).multiplyScalar(limit).add(muzzle), 900);
  }

  /**
   * Perpendicular miss distance from the player's head to this shot.
   *
   * Its own scratch, deliberately: `muzzle` is `_v1` and `dir` is `_v2` for the
   * whole of `_fireShot`, and the tracer is emitted after this call.
   */
  _whizz(muzzle, dir, limit, ctx) {
    const p = ctx.player;
    if (!p?.position || !ctx.bus) return;
    _w0.copy(p.position);
    _w0.y += (p.eyeHeight ?? 1.6) * 0.92;
    _w0.sub(muzzle);
    const t = _w0.dot(dir);
    if (t < 1 || t > limit) return;              // behind the muzzle, or short of the player
    _w1.copy(dir).multiplyScalar(t).sub(_w0);    // closest-approach offset
    const miss = _w1.length();
    if (miss > 3.2 || miss < 0.001) return;
    // Which ear it went past: sign of the offset along the shot's right.
    _w2.set(dir.z, 0, -dir.x);
    const side = _w2.lengthSq() > 1e-6 && _w1.dot(_w2) < 0 ? -1 : 1;
    ctx.bus.emit('bullet:whizz', { distance: miss, side });
  }

  applyDamage(amount, dirWorld, part, from, ctx) {
    if (!this.alive) return;
    this.health -= amount;
    // Being shot at is information even when you cannot see the shooter.
    if (from && !this.sense.visible) {
      this.sense.hasLastKnown = true;
      this.sense.lastKnown.copy(from.position);
      this.sense.lastKnown.y += 1.4;
      this.sense.lastSeen = ctx.time - 0.4;
      this.sense.awareness = 1;
      this.sense.firstSeen = Math.min(this.sense.firstSeen, ctx.time - 0.2);
    }
    if (this.health <= 0) this.kill(dirWorld, amount, from, ctx);
  }

  kill(dirWorld, energy, by, ctx) {
    if (!this.alive) return;
    this.alive = false;
    this.wantFire = false;
    if (this.cover && this.ai.coverTaken.get(this.cover) === this) this.ai.coverTaken.delete(this.cover);
    this.cover = null;

    // Hand the pose to physics with the killing impulse: no death animation,
    // the body falls the way it was hit.
    const t = this.ai.ragdollBones;
    this.pivot.updateMatrixWorld(true);
    this._bonePos('hips', t.pelvis);
    this._bonePos('chest', t.spine);
    this._bonePos('head', t.head);
    this._bonePos('forearmL', t.armL);
    this._bonePos('forearmR', t.armR);
    this._bonePos('footL', t.legL);
    this._bonePos('footR', t.legR);

    // Tuck the rifle against the chest for the fall. The weapon bone is driven
    // by the animator, which stops running the moment the bot dies, so without
    // this a corpse keeps its last aim pose and the barrel ends up pointing at
    // the sky.
    const w = this.rig.byName.get('weapon');
    if (w) { w.position.set(0.115, -0.150, 0.150); w.quaternion.set(0, 0, 0, 1); }

    const impulse = this.ai.ragdollImpulse;
    impulse.copy(dirWorld || UP).setY(0);
    if (impulse.lengthSq() < 1e-6) impulse.set(0, 0, 1);
    impulse.normalize().multiplyScalar(2.2 + Math.min(energy, 60) * 0.055);
    impulse.y += 1.1;

    this.ragdoll = ctx.physics?.spawnRagdoll?.(t, impulse) || null;
    if (!this.ragdoll) {
      // No ragdoll pool: at least stop animating and sink out of sight.
      this.deadFallback = 0;
    }
    ctx.bus?.emit('bot:killed', { bot: this, by });
    ctx.audio?.playAt?.('body_fall', this.position, {});
  }

  _bonePos(name, out) {
    const b = this.rig.byName.get(name);
    if (b) out.setFromMatrixPosition(b.matrixWorld);
    return out;
  }

  /**
   * Drive the skeleton from the seven ragdoll nodes. The chain is aimed rather
   * than keyframed: each segment points at the node below it and the limbs use
   * the same two-bone solver the living pose does, so a corpse keeps its
   * proportions instead of stretching.
   */
  _updateRagdoll(dt, ctx) {
    const rd = this.ragdoll;
    if (!rd || !rd.active) {
      if (this.deadFallback !== undefined) {
        this.deadFallback += dt;
        if (this.deadFallback > 8) this.despawn();
      }
      return;
    }
    const B = rd.bones;
    const pelvis = B[0].position, spine = B[1].position, head = B[2].position;
    const armL = B[3].position, armR = B[4].position;
    const legL = B[5].position, legR = B[6].position;

    // The pivot goes to identity: ragdoll nodes are already world space.
    this.pivot.position.set(0, 0, 0);
    this.pivot.rotation.set(0, 0, 0);
    this.position.copy(pelvis);
    this.position.y -= 0.9;

    const rig = this.rig.byName;
    const hips = rig.get('hips');
    hips.position.copy(pelvis);
    _v0.copy(spine).sub(pelvis);
    if (_v0.lengthSq() < 1e-8) _v0.copy(UP);
    _v0.normalize();
    _q0.setFromUnitVectors(UP, _v0);
    hips.quaternion.copy(_q0);

    _v1.copy(head).sub(spine);
    if (_v1.lengthSq() < 1e-8) _v1.copy(UP);
    _v1.normalize();
    _q1.setFromUnitVectors(UP, _v1);
    // spine and chest split the bend between pelvis and head.
    _q0.invert();
    rig.get('spine').quaternion.copy(_q0).multiply(_q1).slerp(IDENT, 0.5);
    rig.get('chest').quaternion.copy(rig.get('spine').quaternion);
    rig.get('neck').quaternion.identity();
    rig.get('head').quaternion.identity();

    this.pivot.updateMatrixWorld(true);
    this._ragLimb('arm', 'L', armL);
    this._ragLimb('arm', 'R', armR);
    this._ragLimb('leg', 'L', legL);
    this._ragLimb('leg', 'R', legR);
    this.pivot.updateMatrixWorld(true);
    this._syncBounds(ctx);
  }

  _ragLimb(kind, S, targetWorld) {
    const rig = this.rig.byName;
    const isArm = kind === 'arm';
    const upper = rig.get((isArm ? 'arm' : 'thigh') + S);
    const lower = rig.get((isArm ? 'forearm' : 'shin') + S);
    const tip = rig.get((isArm ? 'hand' : 'foot') + S);
    if (!upper || !lower || !tip) return;

    _v0.setFromMatrixPosition(upper.matrixWorld);
    _v1.setFromMatrixPosition(lower.matrixWorld);
    _v2.setFromMatrixPosition(tip.matrixWorld);
    const l1 = _v0.distanceTo(_v1);
    const l2 = _v1.distanceTo(_v2);
    _v3.set(isArm ? (S === 'L' ? -0.6 : 0.6) : 0, -0.4, isArm ? -0.7 : 0.9).normalize();
    solveTwoBone(_v0, targetWorld, l1, l2, _v3, _v1, _v2);

    // World -> local, using the parent's world rotation.
    upper.parent.getWorldQuaternion(_q0).invert();
    _q1.setFromUnitVectors(UP_NEG, _v1);
    upper.quaternion.copy(_q0).multiply(_q1);
    _q0.copy(_q1).invert();
    _q1.setFromUnitVectors(UP_NEG, _v2);
    lower.quaternion.copy(_q0).multiply(_q1);
  }

  // ------------------------------------------------------------- hitboxes

  /**
   * Ray against this bot's oriented hitboxes. Returns the nearest hit or null.
   * Bone matrices are current because `update` finishes with
   * `pivot.updateMatrixWorld`.
   */
  raycastHitboxes(origin, dir, maxDist, out) {
    if (!this.active || !this.alive) return null;
    // Cheap reject against the bounding sphere first.
    _v0.copy(this.position); _v0.y += 0.95;
    _v0.sub(origin);
    const along = _v0.dot(dir);
    if (along < -1.8 || along > maxDist + 1.8) return null;
    if (_v0.lengthSq() - along * along > 1.7 * 1.7) return null;

    let best = -1, bestBox = null;
    for (let i = 0; i < this.hitboxes.length; i++) {
      const hb = this.hitboxes[i];
      if (!hb.bone) continue;
      _m0.copy(hb.bone.matrixWorld).invert();
      _v1.copy(origin).applyMatrix4(_m0).sub(hb.off);
      _v2.copy(dir).transformDirection(_m0);
      const t = slabHit(_v1, _v2, hb.half, maxDist);
      if (t >= 0 && (best < 0 || t < best)) { best = t; bestBox = hb; }
    }
    if (best < 0) return null;
    out.distance = best;
    out.part = bestBox.part;
    out.mult = bestBox.mult;
    out.bot = this;
    out.point.copy(dir).multiplyScalar(best).add(origin);
    return out;
  }
}

const IDENT = new THREE.Quaternion();
const UP_NEG = new THREE.Vector3(0, -1, 0);

/** Slab test of a ray against an axis-aligned box centred on the origin. */
function slabHit(o, d, half, maxDist) {
  let tmin = 0, tmax = maxDist;
  for (let a = 0; a < 3; a++) {
    const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
    const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
    const ha = a === 0 ? half.x : a === 1 ? half.y : half.z;
    if (Math.abs(da) < 1e-8) {
      if (oa < -ha || oa > ha) return -1;
      continue;
    }
    const inv = 1 / da;
    let t1 = (-ha - oa) * inv;
    let t2 = (ha - oa) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}
