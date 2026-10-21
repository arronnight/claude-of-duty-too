import {
  PAL, rgba, font, roundRect, shadow, noShadow, setTracking, clearTracking,
  clamp01, approach, lerp,
} from './theme.js';

/**
 * Lower-left vitals: health, stance and stamina.
 *
 * Health is deliberately absent at full health — CoD only ever shows it while
 * you are hurt, which keeps the frame clean and makes its appearance meaningful.
 * Behind the live bar is a "chip" bar that holds the pre-damage value for a
 * beat and then drains, so a burst reads as a distinct chunk of damage rather
 * than a value that has silently changed between glances.
 *
 * The stance glyph is drawn rather than typeset: a standing bar, a stepped
 * crouch, and a flat prone dash, all in the same 14 px cell so the eye can read
 * it in peripheral vision without focusing.
 */
export class Vitals {
  constructor() {
    this.shown = 0;      // 0..1 presence of the health bar
    this.hp = 1;         // smoothed health fraction
    this.chip = 1;       // trailing damage bar
    this.chipHold = 0;
    this.stamina = 1;
    this.x = 0; this.y = 0; this.k = 1; this.barW = 0;
    this.fLabel = '';
  }

  layout(w, h) {
    const k = this.k = Math.min(Math.max(h / 900, 0.85), 1.5);
    const m = Math.round(Math.min(w, h) * 0.058);
    this.x = m;
    this.y = h - m;
    this.barW = Math.round(186 * k);
    this.fLabel = font(600, 10 * k);
  }

  update(dt, s) {
    const frac = clamp01(s.maxHealth > 0 ? s.health / s.maxHealth : 1);
    this.hp = approach(this.hp, frac, 16, dt);

    if (frac < this.chip - 0.001) {
      this.chipHold = 0.45;
    } else if (frac > this.chip) {
      this.chip = this.hp;
    }
    if (this.chipHold > 0) this.chipHold -= dt;
    else this.chip = approach(this.chip, frac, 3.4, dt);

    this.stamina = approach(this.stamina, clamp01(s.stamina), 12, dt);

    // Visible while hurt, while regenerating back up, and for a moment after.
    const want = frac < 0.995 || s.dead ? 1 : 0;
    this.shown = approach(this.shown, want, want ? 12 : 2.2, dt);
  }

  draw(c, s) {
    const k = this.k;
    const x = this.x;
    const y = this.y;

    // --- stance + stamina row ----------------------------------------------
    const rowY = y - 4 * k;
    this._stance(c, x + 7 * k, rowY - 13 * k, k, s);

    // Stamina pips: seven thin segments that drain from the right. Hidden at
    // full stamina unless the player is actually sprinting.
    const pipShow = this.stamina < 0.995 || s.sprinting ? 1 : 0;
    if (pipShow > 0.01) {
      const n = 7;
      const pw = 13 * k;
      const gap = 3 * k;
      const px0 = x + 22 * k;
      const py = rowY - 8 * k;
      noShadow(c);
      for (let i = 0; i < n; i++) {
        const seg = clamp01(this.stamina * n - i);
        const px = px0 + i * (pw + gap);
        c.fillStyle = rgba(PAL.ink, 0.34);
        c.fillRect(px, py, pw, 2.4 * k);
        if (seg > 0) {
          const col = this.stamina < 0.25 ? PAL.amber : PAL.stamina;
          c.fillStyle = rgba(col, 0.8 * (0.5 + 0.5 * seg));
          c.fillRect(px, py, pw * seg, 2.4 * k);
        }
      }
    }

    // --- health bar ---------------------------------------------------------
    const a = this.shown;
    if (a < 0.01) return;
    const bw = this.barW;
    const bh = 4.5 * k;
    const by = y - 30 * k;
    const lowT = clamp01((0.45 - this.hp) / 0.45);
    const col = [
      Math.round(lerp(PAL.health[0], PAL.healthLow[0], lowT)),
      Math.round(lerp(PAL.health[1], PAL.healthLow[1], lowT)),
      Math.round(lerp(PAL.health[2], PAL.healthLow[2], lowT)),
    ];
    // Critical health throbs, at a rate that rises as it drops.
    const throb = this.hp < 0.3 ? 0.82 + 0.18 * Math.sin(s.time * (7 + (1 - this.hp) * 9)) : 1;

    noShadow(c);
    c.fillStyle = rgba(PAL.ink, 0.42 * a);
    roundRect(c, x, by, bw, bh, bh * 0.5);
    c.fill();

    if (this.chip > this.hp + 0.002) {
      c.fillStyle = rgba(PAL.chip, 0.85 * a);
      roundRect(c, x, by, bw * this.chip, bh, bh * 0.5);
      c.fill();
    }

    shadow(c, 6 * k, 0.5, 0);
    c.fillStyle = rgba(col, 0.95 * a * throb);
    roundRect(c, x, by, bw * this.hp, bh, bh * 0.5);
    c.fill();
    noShadow(c);

    // Armour, as a thinner rule immediately above the health bar.
    if (s.armour > 0) {
      const af = clamp01(s.armour / (s.maxArmour || 100));
      c.fillStyle = rgba(PAL.ink, 0.4 * a);
      c.fillRect(x, by - 5 * k, bw, 2 * k);
      c.fillStyle = rgba(PAL.friend, 0.8 * a);
      c.fillRect(x, by - 5 * k, bw * af, 2 * k);
    }

    // Numeric readout, small, only when it matters.
    if (this.hp < 0.6) {
      c.font = this.fLabel;
      setTracking(c, 0.18, 10 * k);
      c.textAlign = 'left';
      shadow(c, 4 * k, 0.6, 1);
      c.fillStyle = rgba(lowT > 0.5 ? PAL.healthLow : PAL.dim, 0.8 * a);
      c.fillText(String(Math.max(0, Math.ceil(s.health))), x, by - 9 * k);
      clearTracking(c);
      noShadow(c);
    }
  }

  /** 14 px stance glyph — bar / stepped / dash. */
  _stance(c, x, y, k, s) {
    const w = 2.2 * k;
    c.fillStyle = rgba(PAL.dim, 0.62);
    shadow(c, 4 * k, 0.55, 1);
    const st = s.stance;
    if (st === 'prone') {
      c.fillRect(x - 6 * k, y + 10 * k, 13 * k, w);
    } else if (st === 'crouch' || st === 'slide') {
      c.fillRect(x - 1 * k, y + 4 * k, w, 8 * k);
      c.fillRect(x - 5 * k, y + 10 * k, 9 * k, w);
    } else {
      c.fillRect(x - 1 * k, y, w, 12 * k);
      c.fillRect(x - 4 * k, y + 12 * k, 8 * k, w);
    }
    noShadow(c);
  }
}
