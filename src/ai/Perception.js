import * as THREE from 'three';

/**
 * What a bot knows, and when it is allowed to know it.
 *
 * Sight is a 110° cone whose range falls off with the target's stance, with
 * the ambient light level and with how far off the cone's axis the target is,
 * gated by a physics raycast so a wall really does hide you. Detection is not
 * a boolean flip: awareness accumulates at a rate set by all of the above, so
 * a crouched target at 50 m in the dark takes seconds to notice and a sprinting
 * one at 8 m is instant. That accumulation is what stops bots from snapping
 * onto a target the frame it clears a corner.
 *
 * Hearing is a radius scaled by the event's loudness, unblocked by geometry
 * (sound goes round corners) but degraded in accuracy with distance, so a bot
 * investigates roughly where a shot came from rather than exactly.
 *
 * Cost control: one line-of-sight ray per bot per perception tick, ticks are
 * ~7 Hz and staggered per bot, and the cone/range rejections happen before any
 * ray is cast. A twelve-bot firefight is therefore under 100 rays a second.
 */

const FOV_COS = Math.cos((110 * Math.PI / 180) / 2);
const PERIPHERAL_COS = Math.cos((170 * Math.PI / 180) / 2);
const TICK = 0.14;
const MASK_WORLD = 1 | 2;   // LAYER.WORLD | LAYER.PROPS

const _eye = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class Perception {
  constructor(bot) {
    this.bot = bot;
    this.timer = Math.random() * TICK;

    /** @type {object|null} the contact currently being engaged */
    this.target = null;
    this.visible = false;
    this.awareness = 0;              // 0..1 toward first acquisition
    this.lastSeen = -999;
    this.firstSeen = -999;
    this.lastKnown = new THREE.Vector3();
    this.lastKnownVel = new THREE.Vector3();
    this.hasLastKnown = false;

    this.noise = new THREE.Vector3();
    this.noiseTime = -999;
    this.hasNoise = false;
    this.threatDir = new THREE.Vector3(0, 0, 1);
  }

  reset() {
    this.target = null;
    this.visible = false;
    this.awareness = 0;
    this.hasLastKnown = false;
    this.hasNoise = false;
    this.lastSeen = -999;
  }

  /** Sight range in metres for this target right now. */
  _range(target, light) {
    let r = 72 * (0.42 + 0.58 * light);
    if (target.stance === 'crouch') r *= 0.74;
    if (target.stance === 'prone') r *= 0.5;
    if (target.sprinting) r *= 1.25;
    if (target.muzzleFlash) r *= 1.6;
    return r;
  }

  /**
   * @param {number} dt
   * @param {object} ctx
   * @param {Array} contacts  candidate enemies: { position, eyeHeight, team, alive, stance }
   */
  update(dt, ctx, contacts) {
    const bot = this.bot;
    this.timer -= dt;
    const now = ctx.time;

    // Between ticks, keep tracking a target we already see — losing sight is
    // allowed to be laggy, but the aim must not be.
    if (this.timer > 0) {
      if (this.target && this.visible) {
        this.lastKnown.copy(this.target.position);
        this.lastKnown.y += (this.target.eyeHeight || 1.6) * 0.62;
        this.lastSeen = now;
      }
      return;
    }
    const step = TICK + (-this.timer);
    this.timer = TICK * (0.85 + Math.random() * 0.3);

    const light = THREE.MathUtils.clamp(ctx.sky?.intensity ?? 1, 0.12, 1);
    bot.eyePosition(_eye);
    _fwd.set(Math.sin(bot.yaw), 0, Math.cos(bot.yaw));

    let best = null, bestScore = -1, bestVisible = false;
    for (let i = 0; i < contacts.length; i++) {
      const t = contacts[i];
      if (!t || t.alive === false || t.team === bot.team) continue;
      _to.copy(t.position);
      _to.y += (t.eyeHeight || 1.6) * 0.62;
      _dir.copy(_to).sub(_eye);
      const dist = _dir.length();
      if (dist < 1e-3) continue;
      _dir.multiplyScalar(1 / dist);

      const cosA = _dir.x * _fwd.x + _dir.z * _fwd.z;
      // Behind the head is not merely unseen, it is unseeable — except very
      // close, where you would feel someone standing on you.
      const inCone = cosA > FOV_COS || (dist < 4 && cosA > PERIPHERAL_COS);
      if (!inCone && !(this.target === t && this.visible)) continue;
      if (dist > this._range(t, light)) continue;

      if (!this._los(ctx, _eye, _dir, dist, t)) continue;

      // Prefer the closest thing in the middle of the view.
      const score = (1 / (1 + dist * 0.08)) * (0.4 + 0.6 * Math.max(cosA, 0));
      if (score > bestScore) { bestScore = score; best = t; bestVisible = true; }
    }

    if (best) {
      if (best !== this.target) {
        // A new contact starts from whatever awareness the old one had built,
        // heavily discounted: a bot already alert reacts faster to the next
        // man through the door.
        this.awareness *= 0.35;
        this.firstSeen = now;
      }
      this.target = best;
      const dist = _eye.distanceTo(best.position);
      const gain = THREE.MathUtils.clamp(2.6 - dist * 0.022, 0.55, 2.6) *
        (best.sprinting ? 1.5 : 1) * (0.55 + 0.45 * light);
      this.awareness = Math.min(1, this.awareness + gain * step);
      this.visible = true;
      this.lastSeen = now;
      this.hasLastKnown = true;
      this.lastKnown.copy(best.position);
      this.lastKnown.y += (best.eyeHeight || 1.6) * 0.62;
      if (best.velocity) this.lastKnownVel.copy(best.velocity);
      this.threatDir.copy(this.lastKnown).sub(_eye).setY(0).normalize();
    } else {
      this.visible = false;
      this.awareness = Math.max(0, this.awareness - step * 0.22);
      if (this.target && now - this.lastSeen > 7) this.target = null;
    }
  }

  _los(ctx, eye, dir, dist, target) {
    const phys = ctx.physics;
    if (!phys?.raycast) return true;
    const hit = phys.raycast(eye, dir, dist - 0.25, MASK_WORLD);
    if (!hit) return true;
    // A shoulder-height second ray catches the case of a target crouched
    // behind low cover with only a head showing.
    _to.copy(target.position);
    _to.y += (target.eyeHeight || 1.6) * 0.98;
    _dir.copy(_to).sub(eye);
    const d2 = _dir.length();
    if (d2 < 1e-3) return false;
    _dir.multiplyScalar(1 / d2);
    return !phys.raycast(eye, _dir, d2 - 0.25, MASK_WORLD);
  }

  /** A world event the bot might hear. `loudness` 0..1 maps to 8..70 m. */
  hear(pos, loudness, time, sourceTeam) {
    if (sourceTeam && sourceTeam === this.bot.team) return false;
    const radius = 8 + loudness * 62;
    const d = this.bot.position.distanceTo(pos);
    if (d > radius) return false;
    // Louder and closer means a better fix on where it came from.
    const error = THREE.MathUtils.clamp(d * 0.10 * (1.2 - loudness), 0, 7);
    this.noise.set(
      pos.x + (Math.random() * 2 - 1) * error,
      pos.y,
      pos.z + (Math.random() * 2 - 1) * error,
    );
    this.noiseTime = time;
    this.hasNoise = true;
    this.awareness = Math.min(1, this.awareness + 0.25 * loudness);
    return true;
  }

  /** True once the bot has both acquired and had time to react. */
  alerted(now, reactionTime) {
    return this.awareness >= 1 && now - this.firstSeen >= reactionTime;
  }
}
