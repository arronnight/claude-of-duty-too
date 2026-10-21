import {
  PAL, rgba, font, roundRect, shadow, noShadow, setTracking, clearTracking,
  clamp01, approach, easeOutQuint, easeOutCubic,
} from './theme.js';

const MAX_ROWS = 5;
const HOLD = 5.0;
const FADE = 0.7;

/**
 * Top-right killfeed.
 *
 * Rows are a fixed pool — `killfeed()` recycles the oldest slot rather than
 * allocating — and each row animates independently: a short slide in from the
 * right, a hold, then a fade, with the whole stack easing toward its target
 * position so an expiring row above does not make the rest jump.
 *
 * The weapon between the two names is drawn as a small vector glyph rather than
 * typeset. Real killfeeds use a weapon silhouette and the shape is what makes
 * the row scannable at a glance; a word there reads as a debug log.
 */
export class Killfeed {
  constructor() {
    this.rows = [];
    for (let i = 0; i < MAX_ROWS; i++) {
      this.rows.push({ live: false, t: 0, killer: '', victim: '', glyph: 'rifle', headshot: false, mine: false, victimIsMe: false, y: 0, ty: 0, slide: 0 });
    }
    this.seq = 0;
    this.x = 0; this.y0 = 0; this.k = 1; this.rowH = 0;
    this.fName = '';
  }

  layout(w, h) {
    const k = this.k = Math.min(Math.max(h / 900, 0.85), 1.5);
    const m = Math.round(Math.min(w, h) * 0.058);
    this.x = w - m;
    this.y0 = Math.round(Math.min(w, h) * 0.040) + 46 * k;
    this.rowH = 21 * k;
    this.fName = font(600, 11 * k);
  }

  push(e) {
    if (!e) return;
    const entry = typeof e === 'string' ? { killer: e, victim: '' } : e;
    // Oldest slot, or a free one.
    let slot = null;
    let oldest = -1;
    for (const r of this.rows) {
      if (!r.live) { slot = r; break; }
      if (r.t > oldest) { oldest = r.t; slot = r; }
    }
    slot.live = true;
    slot.t = 0;
    slot.slide = 1;
    slot.killer = String(entry.killer ?? entry.by ?? 'UNKNOWN').toUpperCase();
    slot.victim = String(entry.victim ?? entry.target ?? entry.bot ?? '').toUpperCase();
    slot.glyph = glyphFor(entry.weapon || entry.glyph);
    slot.headshot = !!entry.headshot;
    slot.mine = !!(entry.mine ?? entry.byPlayer ?? /^(YOU|PLAYER)$/.test(slot.killer));
    slot.victimIsMe = /^(YOU|PLAYER)$/.test(slot.victim);
    slot.order = this.seq++;
  }

  clear() { for (const r of this.rows) r.live = false; }

  update(dt) {
    // Live rows sorted newest-first define the target stack positions.
    let idx = 0;
    for (let i = 0; i < MAX_ROWS; i++) {
      let newest = null;
      let best = -1;
      for (const r of this.rows) {
        if (!r.live || r._placed) continue;
        if (r.order > best) { best = r.order; newest = r; }
      }
      if (!newest) break;
      newest._placed = true;
      newest.ty = this.y0 + idx * this.rowH;
      idx++;
    }
    for (const r of this.rows) {
      r._placed = false;
      if (!r.live) continue;
      r.t += dt;
      if (r.t > HOLD + FADE) { r.live = false; continue; }
      r.slide = approach(r.slide, 0, 16, dt);
      r.y = r.y === 0 ? r.ty : approach(r.y, r.ty, 14, dt);
    }
  }

  draw(c, s) {
    const k = this.k;
    for (const r of this.rows) {
      if (!r.live) continue;
      const fadeIn = clamp01(r.t / 0.16);
      const fadeOut = r.t > HOLD ? 1 - clamp01((r.t - HOLD) / FADE) : 1;
      const a = fadeIn * fadeOut * s.alpha;
      if (a <= 0.01) continue;
      const x = this.x + easeOutCubic(r.slide) * 26 * k;
      const y = r.y;

      c.textBaseline = 'middle';
      c.textAlign = 'right';
      c.font = this.fName;
      setTracking(c, 0.1, 11 * k);

      // A kill of your own gets a faint highlight rule *behind* the row. It has
      // to be measured before anything is drawn, hence the dry-run measure.
      if (r.mine) {
        const wv = c.measureText(r.victim).width;
        const wk = c.measureText(r.killer).width;
        const total = wv + wk + 22 * k + 16 * k;
        noShadow(c);
        c.fillStyle = rgba(PAL.friend, 0.10 * a);
        roundRect(c, x - total - 7 * k, y - 9.5 * k, total + 14 * k, 19 * k, 2 * k);
        c.fill();
      }
      shadow(c, 5 * k, 0.7, 1);

      const victimCol = r.victimIsMe ? PAL.danger : PAL.dim;
      c.fillStyle = rgba(victimCol, (r.victimIsMe ? 0.95 : 0.8) * a);
      c.fillText(r.victim, x, y);
      const vw = c.measureText(r.victim).width;

      const glyphW = 22 * k;
      const gx = x - vw - 8 * k - glyphW;
      this._glyph(c, gx, y, glyphW, k, r, a);

      const kx = gx - 8 * k;
      c.fillStyle = rgba(r.mine ? PAL.friend : PAL.dim, (r.mine ? 0.98 : 0.75) * a);
      c.fillText(r.killer, kx, y);
      clearTracking(c);
      noShadow(c);
    }
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
  }

  /** Tiny weapon silhouette. Shape, not text — a word here reads as a log line. */
  _glyph(c, x, y, w, k, r, a) {
    const col = r.headshot ? PAL.amber : PAL.white;
    c.fillStyle = rgba(col, 0.85 * a);
    c.strokeStyle = rgba(col, 0.85 * a);
    c.lineWidth = 1.3 * k;
    const g = r.glyph;
    const cy = y;
    if (g === 'pistol') {
      c.fillRect(x + 6 * k, cy - 3 * k, 11 * k, 2.6 * k);
      c.fillRect(x + 6 * k, cy - 1 * k, 3.2 * k, 6 * k);
    } else if (g === 'shotgun') {
      c.fillRect(x + 1 * k, cy - 2.4 * k, 19 * k, 2.2 * k);
      c.fillRect(x + 1 * k, cy + 0.2 * k, 19 * k, 1.4 * k);
      c.fillRect(x + 13 * k, cy + 1 * k, 5 * k, 3.4 * k);
    } else if (g === 'knife') {
      c.beginPath();
      c.moveTo(x + 2 * k, cy + 4 * k);
      c.lineTo(x + 14 * k, cy - 4 * k);
      c.lineTo(x + 17 * k, cy - 1 * k);
      c.lineTo(x + 5 * k, cy + 5 * k);
      c.closePath();
      c.fill();
    } else if (g === 'explosive') {
      c.beginPath();
      c.arc(x + 11 * k, cy + 1 * k, 4.4 * k, 0, Math.PI * 2);
      c.fill();
      c.fillRect(x + 9.5 * k, cy - 5 * k, 3 * k, 2.4 * k);
    } else {
      // rifle / smg / dmr — receiver, barrel, magazine, stock. Length and mag
      // rake differ enough per class to be told apart at 11 px.
      const len = g === 'smg' ? 13 : g === 'dmr' ? 21 : 18;
      c.fillRect(x + 2 * k, cy - 2.6 * k, len * k, 2.6 * k);
      c.fillRect(x + (len - 4) * k, cy - 4.2 * k, 4 * k, 1.6 * k);
      c.beginPath();
      c.moveTo(x + 7 * k, cy);
      c.lineTo(x + 10.5 * k, cy);
      c.lineTo(x + 9 * k, cy + (g === 'smg' ? 6.5 : 5) * k);
      c.lineTo(x + 5.8 * k, cy + (g === 'smg' ? 6.5 : 5) * k);
      c.closePath();
      c.fill();
      c.fillRect(x, cy - 2.2 * k, 3 * k, 4.4 * k);
    }
    if (r.headshot) {
      c.beginPath();
      c.arc(x + w + 3.5 * k, cy - 3 * k, 1.6 * k, 0, Math.PI * 2);
      c.fill();
    }
  }
}

function glyphFor(w) {
  if (!w) return 'rifle';
  const s = String(w).toLowerCase();
  if (s.includes('mp5') || s.includes('smg')) return 'smg';
  if (s.includes('870') || s.includes('shot')) return 'shotgun';
  if (s.includes('dmr') || s.includes('sniper') || s.includes('marks')) return 'dmr';
  if (s.includes('deagle') || s.includes('pistol')) return 'pistol';
  if (s.includes('knife') || s.includes('melee')) return 'knife';
  if (s.includes('nade') || s.includes('grenade') || s.includes('explo')) return 'explosive';
  return 'rifle';
}

/**
 * Centre-screen notification. One line at a time, letterspaced caps, sitting
 * above the reticle where CoD puts objective callouts.
 */
export class Notify {
  constructor() {
    this.text = '';
    this.sub = '';
    this.t = -1;
    this.life = 2.4;
    this.cx = 0; this.y = 0; this.k = 1;
    this.fMain = ''; this.fSub = '';
  }

  layout(w, h) {
    const k = this.k = Math.min(Math.max(h / 900, 0.85), 1.5);
    this.cx = Math.round(w * 0.5);
    this.y = Math.round(h * 0.29);
    this.fMain = font(300, 22 * k);
    this.fSub = font(600, 10.5 * k);
  }

  push(text, sub, life) {
    this.text = String(text ?? '').toUpperCase();
    this.sub = sub ? String(sub).toUpperCase() : '';
    this.life = life || 2.4;
    this.t = 0;
  }

  update(dt) {
    if (this.t < 0) return;
    this.t += dt;
    if (this.t > this.life) this.t = -1;
  }

  draw(c, s) {
    if (this.t < 0 || !this.text) return;
    const k = this.k;
    const inA = clamp01(this.t / 0.2);
    const outA = 1 - clamp01((this.t - (this.life - 0.55)) / 0.55);
    const a = inA * outA * s.alpha;
    if (a <= 0.01) return;
    const rise = (1 - easeOutQuint(inA)) * 8 * k;

    c.textAlign = 'center';
    shadow(c, 8 * k, 0.75, 1);
    c.font = this.fMain;
    setTracking(c, 0.22, 22 * k);
    c.fillStyle = rgba(PAL.white, 0.94 * a);
    c.fillText(this.text, this.cx, this.y + rise);
    clearTracking(c);

    if (this.sub) {
      c.font = this.fSub;
      setTracking(c, 0.26, 10.5 * k);
      c.fillStyle = rgba(PAL.steel, 0.7 * a);
      c.fillText(this.sub, this.cx, this.y + 20 * k + rise);
      clearTracking(c);
    }
    noShadow(c);
    c.textAlign = 'left';
  }
}
