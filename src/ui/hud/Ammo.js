import {
  PAL, rgba, font, shadow, noShadow, setTracking, clearTracking,
  clamp01, approach, easeOutQuint,
} from './theme.js';

/**
 * Lower-right ammunition block.
 *
 * Layout follows modern CoD: a light-weight magazine numeral with the reserve
 * set smaller and dimmer behind a hairline slash, the weapon name above it in
 * small letterspaced caps, and the fire mode separated from the name by a thin
 * rule. Everything is right-aligned to a single margin so the block stays
 * anchored as the numbers change width.
 *
 * Signalling, in order of urgency:
 *   - reserve dims further at <= 2 magazines (the spec's rule),
 *   - the magazine numeral goes amber below 30 % and pulses when empty,
 *   - firing punches the numeral's scale by ~6 % so a shot is felt in the HUD.
 */
export class Ammo {
  constructor() {
    this.alpha = 0;         // fades in only once a weapon actually exists
    this.punch = 0;
    this.lastMag = -1;
    this.emptyPulse = 0;
    this.reloadT = -1;
    this.x = 0; this.y = 0; this.k = 1;
    this.fBig = ''; this.fRes = ''; this.fName = ''; this.fMode = ''; this.fSlash = '';
  }

  layout(w, h) {
    const k = this.k = Math.min(Math.max(h / 900, 0.85), 1.5);
    const m = Math.round(Math.min(w, h) * 0.058);
    this.x = w - m;
    this.y = h - m;
    this.fBig = font(250, 46 * k);
    this.fSlash = font(200, 26 * k);
    this.fRes = font(300, 22 * k);
    this.fName = font(600, 11.5 * k);
    this.fMode = font(600, 10 * k);
  }

  fired() { this.punch = 1; }
  reloading() { this.reloadT = 0; }

  update(dt, s) {
    const has = s.hasWeapon;
    this.alpha = approach(this.alpha, has ? 1 : 0, 9, dt);
    this.punch = approach(this.punch, 0, 13, dt);
    if (s.mag !== this.lastMag) {
      if (this.lastMag >= 0 && s.mag < this.lastMag) this.punch = Math.max(this.punch, 0.7);
      this.lastMag = s.mag;
    }
    this.emptyPulse = s.mag === 0 && has ? (this.emptyPulse + dt) % 1.0 : 0;
    if (this.reloadT >= 0) {
      this.reloadT += dt;
      if (this.reloadT > 2.6) this.reloadT = -1;
    }
  }

  draw(c, s) {
    const a = this.alpha;
    if (a < 0.01) return;
    const k = this.k;
    const x = this.x;
    const y = this.y;

    const magFrac = s.magSize > 0 ? s.mag / s.magSize : 1;
    const low = magFrac <= 0.3;
    const empty = s.mag === 0;
    const pulse = empty ? 0.6 + 0.4 * Math.sin(this.emptyPulse * Math.PI * 2) : 1;
    const magCol = empty || low ? PAL.amber : PAL.white;

    shadow(c, 5 * k, 0.6, 1);
    c.textBaseline = 'alphabetic';

    // --- reserve, right-aligned at the margin -------------------------------
    // Dims at <= 2 magazines so a glance tells you whether you can afford the
    // reload you are about to do.
    const mags = s.magSize > 0 ? s.reserve / s.magSize : 9;
    const resAlpha = (mags <= 2 ? 0.34 : 0.6) * a;
    c.textAlign = 'right';
    c.font = this.fRes;
    c.fillStyle = rgba(mags <= 2 ? PAL.amber : PAL.dim, resAlpha);
    c.fillText(String(s.reserve), x, y);
    const resW = c.measureText(String(s.reserve)).width;

    // --- slash --------------------------------------------------------------
    c.font = this.fSlash;
    c.fillStyle = rgba(PAL.steel, 0.42 * a);
    const slashX = x - resW - 8 * k;
    c.fillText('/', slashX, y);
    const slashW = c.measureText('/').width;

    // --- magazine count -----------------------------------------------------
    const magX = slashX - slashW - 6 * k;
    const sc = 1 + this.punch * 0.06;
    c.save();
    c.translate(magX, y);
    c.scale(sc, sc);
    c.font = this.fBig;
    c.fillStyle = rgba(magCol, (0.96 * pulse) * a);
    c.fillText(String(s.mag), 0, 0);
    const magW = c.measureText(String(s.mag)).width * sc;
    c.restore();

    // --- weapon name + fire mode, one line above ----------------------------
    const rowY = y - 34 * k;
    const nameTrack = 0.16;
    c.font = this.fName;
    setTracking(c, nameTrack, 11.5 * k);
    const name = (s.weaponName || '').toUpperCase();
    c.fillStyle = rgba(PAL.dim, 0.72 * a);
    c.fillText(name, x, rowY);
    const nameW = c.measureText(name).width;
    clearTracking(c);

    if (s.fireMode) {
      const modeX = x - nameW - 11 * k;
      c.font = this.fMode;
      setTracking(c, 0.2, 10 * k);
      c.fillStyle = rgba(PAL.steel, 0.55 * a);
      c.fillText(s.fireMode.toUpperCase(), modeX, rowY);
      const modeW = c.measureText(s.fireMode.toUpperCase()).width;
      clearTracking(c);
      // Hairline rule between mode and name.
      noShadow(c);
      c.strokeStyle = rgba(PAL.steel, 0.26 * a);
      c.lineWidth = 1;
      c.beginPath();
      const rx = Math.round(modeX - modeW - 6 * k) + 0.5;
      c.moveTo(rx, rowY - 8 * k);
      c.lineTo(rx, rowY + 1.5 * k);
      c.stroke();
      shadow(c, 5 * k, 0.6, 1);
    }

    // --- reload prompt ------------------------------------------------------
    // Sits under the magazine numeral, appears when the mag is dry, and is
    // replaced by a thin progress rule while the reload actually runs.
    if (this.reloadT >= 0) {
      const p = clamp01(this.reloadT / 2.0);
      noShadow(c);
      const barW = Math.max(magW + 20 * k, 74 * k);
      const bx = x - barW;
      const by = y + 8 * k;
      c.fillStyle = rgba(PAL.ink, 0.35 * a);
      c.fillRect(bx, by, barW, 2 * k);
      c.fillStyle = rgba(PAL.amber, 0.85 * a);
      c.fillRect(bx, by, barW * easeOutQuint(p), 2 * k);
      shadow(c, 5 * k, 0.6, 1);
    } else if (empty) {
      c.font = this.fMode;
      setTracking(c, 0.22, 10 * k);
      c.fillStyle = rgba(PAL.amber, (0.5 + 0.45 * Math.sin(this.emptyPulse * Math.PI * 2)) * a);
      c.fillText('RELOAD', x, y + 17 * k);
      clearTracking(c);
    }

    noShadow(c);
    c.textAlign = 'left';
  }
}
