import { PAL, rgba, shadow, noShadow, clamp, clamp01, approach, easeOutQuint } from './theme.js';

/**
 * Dynamic crosshair and hitmarker.
 *
 * The gap is driven by the weapon's *actual* current spread cone rather than by
 * an animation, so the reticle is honest: it is the projection of the cone onto
 * the near plane, which means the four ticks sit exactly where the outer edge of
 * the bullet cone will land. That is the whole point of a dynamic crosshair and
 * it is the thing most clones get wrong (they animate a "bloom" number that has
 * no relationship to where the bullets go).
 *
 *   gapPx = tan(spreadHalfAngle) / tan(fov/2) * (viewportHeight / 2)
 *
 * The reticle fades out under ADS, because the optic is the sight then.
 */

const MIN_GAP = 3.0;
const TICK_LEN = 7.0;
const TICK_W = 1.5;

export class Crosshair {
  constructor() {
    this.gap = 6;             // smoothed, px
    this.hitT = -1;           // seconds since hitmarker, <0 = inactive
    this.hitKind = 'hit';
    this.hitStack = 0;        // consecutive hits, drives a small size bonus
    this.firePunch = 0;       // 0..1, brief outward kick on each shot
    this.alpha = 1;
    this.cx = 0;
    this.cy = 0;
    this.scale = 1;
  }

  layout(w, h) {
    this.cx = Math.round(w * 0.5) + 0.5;
    this.cy = Math.round(h * 0.5) + 0.5;
    this.scale = clamp(h / 900, 0.8, 1.6);
  }

  hitmarker(kind) {
    // Re-triggering while one is live stacks slightly instead of restarting
    // flat, so a fast burst reads as sustained hits rather than one flicker.
    if (this.hitT >= 0 && this.hitT < 0.16) this.hitStack = Math.min(this.hitStack + 1, 4);
    else this.hitStack = 0;
    this.hitT = 0;
    this.hitKind = kind || 'hit';
  }

  fired() {
    this.firePunch = 1;
  }

  update(dt, s) {
    // Target gap from the live spread cone.
    const target = Math.max(MIN_GAP * this.scale, s.spreadPx) + this.firePunch * 5 * this.scale;
    // Opening is fast (the cone opens the instant the shot leaves), closing
    // tracks the weapon's recovery, so the reticle lags the way CoD's does.
    const rate = target > this.gap ? 34 : 13;
    this.gap = approach(this.gap, target, rate, dt);
    this.firePunch = approach(this.firePunch, 0, 11, dt);

    if (this.hitT >= 0) {
      this.hitT += dt;
      if (this.hitT > 0.42) this.hitT = -1;
    }
    // Fade with ADS and hide entirely when dead.
    const want = (1 - clamp01(s.ads * 1.25)) * (s.dead ? 0 : 1);
    this.alpha = approach(this.alpha, want, 18, dt);
  }

  draw(c, s) {
    const a = this.alpha;
    if (a > 0.01) this._reticle(c, a, s);
    if (this.hitT >= 0) this._hitmarker(c);
  }

  _reticle(c, a, s) {
    const { cx, cy } = this;
    const k = this.scale;
    const gap = this.gap;
    const len = TICK_LEN * k * (s.moving ? 1.08 : 1);
    const wpx = TICK_W * k;

    // Dark underlay first: a slightly wider stroke in near-black keeps the
    // reticle readable against blown-out concrete and sky both.
    noShadow(c);
    c.lineCap = 'butt';
    for (let pass = 0; pass < 2; pass++) {
      const outline = pass === 0;
      c.strokeStyle = outline ? rgba(PAL.ink, 0.5 * a) : rgba(PAL.white, 0.93 * a);
      c.lineWidth = outline ? wpx + 1.7 : wpx;
      c.beginPath();
      // up / down / left / right
      c.moveTo(cx, cy - gap); c.lineTo(cx, cy - gap - len);
      c.moveTo(cx, cy + gap); c.lineTo(cx, cy + gap + len);
      c.moveTo(cx - gap, cy); c.lineTo(cx - gap - len, cy);
      c.moveTo(cx + gap, cy); c.lineTo(cx + gap + len, cy);
      c.stroke();
    }

    // Centre dot.
    c.fillStyle = rgba(PAL.ink, 0.5 * a);
    c.beginPath();
    c.arc(cx, cy, 1.55 * k, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = rgba(PAL.white, 0.95 * a);
    c.beginPath();
    c.arc(cx, cy, 0.95 * k, 0, Math.PI * 2);
    c.fill();
  }

  _hitmarker(c) {
    const t = this.hitT;
    const kill = this.hitKind === 'kill';
    const k = this.scale;

    // 90 ms scale punch: overshoot out to 1.5x and settle, then fade.
    const punch = t < 0.09 ? 1.5 - 0.5 * easeOutQuint(t / 0.09) : 1;
    const fade = t < 0.16 ? 1 : 1 - (t - 0.16) / 0.26;
    const a = clamp01(fade) * (kill ? 1 : 0.92);
    if (a <= 0) return;

    const inner = (5.5 + this.hitStack * 0.45) * k * punch;
    const len = (kill ? 7.5 : 6.0) * k * punch;
    const col = kill ? PAL.kill : PAL.white;
    const d = Math.SQRT1_2;

    c.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      const outline = pass === 0;
      c.strokeStyle = outline ? rgba(PAL.ink, 0.55 * a) : rgba(col, a);
      c.lineWidth = (outline ? 3.5 : 1.9) * k;
      c.beginPath();
      for (let i = 0; i < 4; i++) {
        const sx = i & 1 ? d : -d;
        const sy = i & 2 ? d : -d;
        c.moveTo(this.cx + sx * inner, this.cy + sy * inner);
        c.lineTo(this.cx + sx * (inner + len), this.cy + sy * (inner + len));
      }
      c.stroke();
    }

    // A kill gets an extra expanding ring — the "confirmed" beat.
    if (kill) {
      const rt = clamp01(t / 0.34);
      const r = (9 + 26 * easeOutQuint(rt)) * k;
      c.strokeStyle = rgba(PAL.kill, 0.55 * (1 - rt));
      c.lineWidth = 1.4 * k;
      c.beginPath();
      c.arc(this.cx, this.cy, r, 0, Math.PI * 2);
      c.stroke();
    }
    shadow(c);
  }
}
