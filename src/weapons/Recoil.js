import { clamp, lerp, deg, Rand } from './Springs.js';

/**
 * Deterministic recoil and honest spread.
 *
 * The pattern is authored, indexed by shot number, and only ±8 % jittered, so
 * a player can learn it and pull against it. Everything else — first-shot
 * multiplier, the 82 % spring return, spread growth and recovery — follows the
 * numbers in `docs/GAMEPLAY.md` exactly.
 *
 * One subtlety worth reading before changing it: the *camera* spring lives in
 * the player system (`PlayerConfig.view.recoil`) and permanently retains 34 %
 * of every kick. The spec asks for 18 %. Rather than reach across an ownership
 * boundary to retune someone else's config, the extra 16 % is handed back here
 * as a smooth negative trickle over the recovery window — the same spring
 * absorbs it, and the visible result is the muzzle settling back further.
 */

const PLAYER_RETAIN = 0.34;   // must match PlayerConfig.view.recoil.retain
const TARGET_RETAIN = 0.18;   // GAMEPLAY.md
const GIVEBACK = (PLAYER_RETAIN - TARGET_RETAIN) / PLAYER_RETAIN;

export class RecoilController {
  constructor(seed = 0x1f2e3d4c) {
    this.rand = new Rand(seed);
    this.shot = 0;
    this.sinceShot = 99;
    this.owedPitch = 0;
    this.owedYaw = 0;
    this.tau = 0.117;          // ~350 ms to give back ~95 % of the excess
    this.spread = 0;
    this.def = null;
  }

  setWeapon(def) {
    this.def = def;
    this.shot = 0;
    this.spread = def ? def.spread.hipBase : 0;
  }

  reset() {
    this.shot = 0;
    this.owedPitch = 0;
    this.owedYaw = 0;
  }

  /**
   * Roll the kick for this shot and hand it to the player.
   * @returns {{pitch:number, yaw:number}} in radians, for logging/telemetry
   */
  fire(player) {
    const d = this.def;
    if (!d) return { pitch: 0, yaw: 0 };
    const r = d.recoil;
    const p = r.pattern[Math.min(this.shot, r.pattern.length - 1)];
    const first = this.shot === 0 ? r.firstShot : 1;
    const jp = 1 + this.rand.sym() * 0.08;
    const jy = 1 + this.rand.sym() * 0.08;

    const pitch = deg(p[0] * r.vert * first * jp);
    const yaw = deg(p[1] * r.horiz * first * jy);

    player?.applyRecoil?.(pitch, yaw);
    this.owedPitch += pitch * GIVEBACK;
    this.owedYaw += yaw * GIVEBACK;

    this.shot++;
    this.sinceShot = 0;
    this.spread = Math.min(d.spread.max, this.spread + d.spread.perShot);
    return { pitch, yaw };
  }

  /**
   * @param s player snapshot: { speed01, grounded, stance, adsW }
   */
  update(dt, player, s) {
    const d = this.def;
    this.sinceShot += dt;
    if (!d) return;

    // Hand back the excess permanent kick.
    if (this.owedPitch !== 0 || this.owedYaw !== 0) {
      const k = 1 - Math.exp(-dt / this.tau);
      const gp = this.owedPitch * k;
      const gy = this.owedYaw * k;
      this.owedPitch -= gp;
      this.owedYaw -= gy;
      if (Math.abs(gp) > 1e-7 || Math.abs(gy) > 1e-7) player?.applyRecoil?.(-gp, -gy);
      if (Math.abs(this.owedPitch) < 1e-6) this.owedPitch = 0;
      if (Math.abs(this.owedYaw) < 1e-6) this.owedYaw = 0;
    }

    // The pattern resets once the shooter comes off the trigger for long
    // enough that the burst is over — same feel as CoD's reset window.
    if (this.sinceShot > Math.max(0.35, d.fireInterval * 3.2)) this.shot = 0;

    // Spread floor: ADS + crouch + stationary must reach the weapon's minimum
    // within ~400 ms, so the recovery rate is expressed per second toward it.
    const sp = d.spread;
    let floor = lerp(sp.hipBase, sp.adsBase, clamp(s.adsW, 0, 1));
    if (s.stance === 'crouch') floor *= sp.crouchMul;
    else if (s.stance === 'prone') floor *= sp.proneMul;
    floor *= 1 + sp.moveMul * clamp(s.speed01, 0, 1.4) * 0.55;
    if (!s.grounded) floor *= sp.airMul;
    floor = Math.min(floor, sp.max);

    if (this.spread > floor) {
      this.spread = floor + (this.spread - floor) * Math.exp(-sp.recovery * dt);
    } else {
      this.spread = floor + (this.spread - floor) * Math.exp(-sp.recovery * 2 * dt);
    }
    this.spread = clamp(this.spread, 0, sp.max);
  }

  /** Half-angle of the current cone, in radians. */
  get coneRadians() { return deg(this.spread) * 0.5; }
}
