import { PAL, clamp01, approach, easeOutCubic, easeOutQuint } from './theme.js';

/**
 * Full-screen damage feedback: the red vignette, the edge hit-flash, the
 * low-health throb and the death fade.
 *
 * Three rules, all lifted from how modern CoD actually does this and all of
 * them things clones get wrong:
 *
 *  1. **It is a vignette, never a full-screen red wash.** The centre of the
 *     frame — where the player is aiming — stays completely clean. Every
 *     gradient here starts fully transparent well outside the reticle.
 *  2. **Two timescales.** A hit produces a fast, bright edge flash that decays
 *     in ~0.35 s; low health produces a slow, dark, breathing vignette that
 *     persists. Mixing them into one value makes damage feel mushy.
 *  3. **Desaturation under 30 HP** cannot be done on a 2D canvas over a WebGL
 *     frame, so it is a separate DOM layer driven from here via `desat` and
 *     applied by HUD.js with `backdrop-filter`. It is display:none above the
 *     threshold, so it costs nothing in the common case.
 *
 * The gradients are built once per layout and modulated with `globalAlpha`,
 * so drawing allocates nothing.
 */

const LOW_HP = 0.30;

export class Overlay {
  constructor() {
    this.flash = 0;         // 0..1 bright edge flash from a fresh hit
    this.flashDir = 0;      // screen-relative bearing of that hit, radians
    this.dmg = 0;           // 0..1 slower red vignette accumulator
    this.hp = 1;
    this.death = 0;         // 0..1 death fade
    this.white = 0;         // explosion / flashbang whiteout
    this.desat = 0;         // published for the DOM backdrop layer
    this.w = 0; this.h = 0;
    this._gRed = null;
    this._gEdge = null;
    this._gDir = null;
    this._pulse = 0;
  }

  layout(w, h) {
    this.w = w;
    this.h = h;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const r = Math.hypot(cx, cy);

    // Slow damage vignette — clean until 34 % of the way to the corner.
    const red = (a) => `rgba(${PAL.chip[0]},${Math.round(PAL.chip[1] * 0.55)},${Math.round(PAL.chip[2] * 0.5)},${a})`;
    let g = this._gRed = this._ctxGrad(cx, cy, r * 0.34, r);
    g.addColorStop(0, red(0));
    g.addColorStop(0.46, red(0.07));
    g.addColorStop(0.80, red(0.38));
    g.addColorStop(1, red(0.72));

    // Fast edge flash — brighter, hotter, and confined to the outer band.
    const hot = (a) => `rgba(255,${58},${44},${a})`;
    g = this._gEdge = this._ctxGrad(cx, cy, r * 0.66, r);
    g.addColorStop(0, hot(0));
    g.addColorStop(0.58, hot(0.24));
    g.addColorStop(1, hot(0.82));

    this._gDir = null;      // rebuilt lazily per hit bearing
  }

  /**
   * Gradients need a 2D context to exist. HUD.js hands us one at layout time
   * through `bindContext` so this stays a pure widget.
   */
  bindContext(c) { this._c = c; }

  _ctxGrad(cx, cy, r0, r1) {
    return this._c.createRadialGradient(cx, cy, r0, cx, cy, r1);
  }

  /** `angle` is screen-relative: 0 ahead, +pi/2 to the right. */
  hit(amount, angle) {
    const a = clamp01((amount ?? 12) / 45);
    this.flash = Math.min(1, this.flash + 0.45 + a * 0.55);
    this.dmg = Math.min(1, this.dmg + 0.35 + a * 0.5);
    if (Number.isFinite(angle)) this.flashDir = angle;
  }

  blind(amount) { this.white = Math.min(1.2, this.white + (amount ?? 0.6)); }

  update(dt, s) {
    this.hp = approach(this.hp, clamp01(s.maxHealth > 0 ? s.health / s.maxHealth : 1), 10, dt);
    this.flash = approach(this.flash, 0, 7.0, dt);
    this.dmg = approach(this.dmg, 0, 1.6, dt);
    this.white = approach(this.white, 0, 3.2, dt);
    this.death = approach(this.death, s.dead ? 1 : 0, s.dead ? 2.2 : 4, dt);
    this._pulse += dt * (2.2 + (1 - this.hp) * 3.4);

    // Low health keeps a floor under the vignette that breathes with the pulse.
    const lowT = clamp01((LOW_HP - this.hp) / LOW_HP);
    this._low = lowT * (0.42 + 0.18 * Math.sin(this._pulse * Math.PI));
    this.desat = clamp01(lowT * 0.85 + this.death * 0.6);
  }

  draw(c, s) {
    const a = s.alpha;
    const w = this.w, h = this.h;

    const slow = Math.max(this.dmg * 0.52, this._low || 0) * a;
    if (slow > 0.004) {
      c.globalAlpha = slow;
      c.fillStyle = this._gRed;
      c.fillRect(0, 0, w, h);
    }

    const fast = easeOutCubic(clamp01(this.flash)) * a;
    if (fast > 0.004) {
      c.globalAlpha = fast * 0.55;
      c.fillStyle = this._gEdge;
      c.fillRect(0, 0, w, h);
      // Directional bias: the quadrant the shot came from gets a hotter smear,
      // so the vignette itself carries some of the information the arcs do.
      this._directional(c, fast * 0.62);
    }

    if (this.white > 0.004) {
      c.globalAlpha = clamp01(this.white) * a;
      c.fillStyle = '#fff';
      c.fillRect(0, 0, w, h);
    }

    if (this.death > 0.004) {
      const d = easeOutQuint(clamp01(this.death));
      c.globalAlpha = d * 0.82 * a;
      c.fillStyle = 'rgb(14,6,6)';
      c.fillRect(0, 0, w, h);
    }

    c.globalAlpha = 1;
  }

  /** A linear wash from the hit's screen edge, tapering to nothing by centre. */
  _directional(c, amount) {
    if (amount <= 0.01) return;
    const w = this.w, h = this.h;
    const ang = this.flashDir;
    // Screen-space unit vector pointing at the source (+x right, -y up).
    const dx = Math.sin(ang);
    const dy = -Math.cos(ang);
    const cx = w * 0.5, cy = h * 0.5;
    const reach = Math.hypot(cx, cy);
    const g = c.createLinearGradient(cx - dx * reach * 0.15, cy - dy * reach * 0.15, cx + dx * reach, cy + dy * reach);
    g.addColorStop(0, 'rgba(255,54,40,0)');
    g.addColorStop(0.60, 'rgba(255,54,40,0.14)');
    g.addColorStop(1, 'rgba(255,60,44,0.52)');
    c.globalAlpha = amount;
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }
}
