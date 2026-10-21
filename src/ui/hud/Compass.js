import {
  PAL, rgba, font, triangle, shadow, noShadow, setTracking, clearTracking,
  clamp01, approach,
} from './theme.js';

/**
 * Top-centre compass strip.
 *
 * A 90-degree window onto a 360-degree ribbon: minor ticks every 15 degrees,
 * cardinals and inter-cardinals as letters, and objective bearings as lettered
 * pips that slide along the ribbon as the player turns. Marks fade toward the
 * ends of the strip on a squared falloff so the ribbon appears to wrap into the
 * distance instead of being clipped by a hard edge.
 *
 * World convention: -Z is north, +X is east, which matches the level's layout
 * and the player's yaw basis (forward = (-sin yaw, 0, -cos yaw)), so the
 * player's bearing is simply -yaw.
 */

const SPAN_DEG = 90;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class Compass {
  constructor() {
    this.alpha = 1;
    this.cx = 0; this.y = 0; this.halfW = 0; this.k = 1;
    this.fCard = ''; this.fSub = ''; this.fObj = '';
    this.objBearings = [];   // [{ label, bearing }] rebuilt at ~4 Hz
    this._objAcc = 9;
  }

  layout(w, h) {
    const k = this.k = Math.min(Math.max(h / 900, 0.85), 1.5);
    this.cx = Math.round(w * 0.5);
    this.y = Math.round(Math.min(w, h) * 0.040);
    // Wide enough that the ribbon reads as a ribbon. At 21 % of the frame the
    // 90-degree window only ever showed two or three marks and looked like a
    // stray glyph rather than a compass.
    this.halfW = Math.round(Math.min(w * 0.30, 430 * k));
    this.fCard = font(600, 14 * k);
    this.fSub = font(500, 10.5 * k);
    this.fObj = font(700, 10 * k);
  }

  update(dt, s, ctx) {
    this.alpha = approach(this.alpha, s.dead ? 0 : 1, 8, dt);
    this._objAcc += dt;
    if (this._objAcc > 0.25) {
      this._objAcc = 0;
      this._refreshObjectives(s, ctx);
    }
  }

  /**
   * Objective bearings come from whatever the level published, without assuming
   * a schema that does not exist yet: an explicit `objectives` list wins, and
   * failing that the team spawns stand in as A/B, which is real map data rather
   * than an invented decoration.
   */
  _refreshObjectives(s, ctx) {
    const list = this.objBearings;
    list.length = 0;
    const lvl = ctx?.level;
    if (!lvl) return;
    const px = s.px, pz = s.pz;
    const push = (label, p) => {
      if (!p) return;
      const dx = (p.x ?? p[0] ?? 0) - px;
      const dz = (p.z ?? p[2] ?? 0) - pz;
      if (dx * dx + dz * dz < 1) return;
      list.push({ label, bearing: Math.atan2(dx, -dz) * 180 / Math.PI });
    };
    const objs = lvl.objectives;
    if (Array.isArray(objs) && objs.length) {
      for (let i = 0; i < objs.length && i < 4; i++) {
        const o = objs[i];
        push(o.label || o.name || String.fromCharCode(65 + i), o.position || o.pos || o);
      }
      return;
    }
    const spawns = lvl.spawns;
    if (Array.isArray(spawns)) {
      let a = null, b = null;
      for (const sp of spawns) {
        if (!sp?.position) continue;
        if (sp.team === 'b' && !b) b = sp.position;
        else if (!a) a = sp.position;
        if (a && b) break;
      }
      push('A', a);
      push('B', b);
    }
  }

  draw(c, s) {
    const a = this.alpha;
    if (a < 0.01) return;
    const { cx, y, halfW, k } = this;
    const pxPerDeg = halfW / (SPAN_DEG * 0.5);
    const heading = s.bearing;   // degrees, 0 = north, clockwise

    // Baseline rule, fading at both ends. Two passes: a dark one a pixel below
    // the light one. Every mark on this strip is a hairline sitting over a
    // blown-out sky, and a single 26 %-alpha white pixel row simply does not
    // survive that — the dark shoulder is what makes the ribbon legible.
    noShadow(c);
    if (!this._grad || this._gradFor !== halfW) {
      this._gradFor = halfW;
      const g = c.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.22, 'rgba(255,255,255,0.24)');
      g.addColorStop(0.78, 'rgba(255,255,255,0.24)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      this._grad = g;
      const gd = c.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
      gd.addColorStop(0, 'rgba(0,0,0,0)');
      gd.addColorStop(0.22, 'rgba(0,0,0,0.40)');
      gd.addColorStop(0.78, 'rgba(0,0,0,0.40)');
      gd.addColorStop(1, 'rgba(0,0,0,0)');
      this._gradDark = gd;
    }
    const prevAlpha = c.globalAlpha;
    c.globalAlpha = prevAlpha * a;
    c.fillStyle = this._gradDark;
    c.fillRect(cx - halfW, y + 16 * k, halfW * 2, 1);
    c.fillStyle = this._grad;
    c.fillRect(cx - halfW, y + 15 * k, halfW * 2, 1);
    c.globalAlpha = prevAlpha;

    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';

    // Half-step hairlines between the labelled marks. 15 degrees alone across a
    // 90-degree window is seven marks over 860 px, which reads as a bare rule
    // with a couple of specks on it rather than as a graduated ribbon.
    const firstHalf = Math.ceil((heading - SPAN_DEG * 0.5) / 7.5) * 7.5;
    for (let d = firstHalf; d <= heading + SPAN_DEG * 0.5; d += 7.5) {
      if (Math.abs(d % 15) < 0.01) continue;
      const off = (d - heading) * pxPerDeg;
      const fade = 1 - Math.pow(Math.abs(off) / halfW, 2.2);
      if (fade <= 0.02) continue;
      this._tick(c, cx + off, y + 15 * k, 2.2 * k, k, 0.32 * fade * a);
    }

    // Ticks every 15 degrees across the visible window.
    const first = Math.ceil((heading - SPAN_DEG * 0.5) / 15) * 15;
    for (let d = first; d <= heading + SPAN_DEG * 0.5; d += 15) {
      const off = (d - heading) * pxPerDeg;
      const fade = 1 - Math.pow(Math.abs(off) / halfW, 2.2);
      if (fade <= 0.02) continue;
      const x = cx + off;
      const norm = ((d % 360) + 360) % 360;
      const isCardinal = norm % 45 === 0;

      if (isCardinal) {
        const label = CARDINALS[(norm / 45) | 0];
        const major = norm % 90 === 0;
        c.font = major ? this.fCard : this.fSub;
        setTracking(c, 0.12, major ? 14 * k : 10.5 * k);
        shadow(c, 5 * k, 0.8, 1);
        c.fillStyle = rgba(major ? PAL.white : PAL.dim, (major ? 0.95 : 0.62) * fade * a);
        c.fillText(label, x, y + 10 * k);
        clearTracking(c);
        noShadow(c);
        this._tick(c, x, y + 15 * k, 5.5 * k, k, 0.72 * fade * a);
      } else {
        this._tick(c, x, y + 15 * k, 3.5 * k, k, 0.52 * fade * a);
      }
    }

    // Objective pips.
    for (let i = 0; i < this.objBearings.length; i++) {
      const o = this.objBearings[i];
      let rel = o.bearing - heading;
      rel = ((rel + 540) % 360) - 180;
      const clamped = Math.max(-SPAN_DEG * 0.5, Math.min(SPAN_DEG * 0.5, rel));
      const edge = Math.abs(rel) > SPAN_DEG * 0.5;
      const x = cx + clamped * pxPerDeg;
      const fade = edge ? 0.4 : 1 - Math.pow(Math.abs(clamped * pxPerDeg) / halfW, 2.2) * 0.8;
      c.font = this.fObj;
      shadow(c, 4 * k, 0.7, 1);
      c.fillStyle = rgba(PAL.friend, 0.85 * fade * a);
      c.fillText(o.label, x, y + 28 * k);
      noShadow(c);
      c.fillStyle = rgba(PAL.friend, 0.55 * fade * a);
      c.fillRect(Math.round(x), y + 16 * k, 1, 4 * k);
    }

    // Heading marker.
    shadow(c, 4 * k, 0.85, 1);
    c.fillStyle = rgba(PAL.white, 0.95 * a);
    triangle(c, cx, y + 19.5 * k, 7 * k, 5 * k, false);
    c.fill();
    noShadow(c);
    c.textAlign = 'left';
  }

  /** A tick is two rects: black shoulder, then the light mark over it. */
  _tick(c, x, y, len, k, alpha) {
    if (alpha <= 0.01) return;
    const px = Math.round(x);
    c.fillStyle = rgba(PAL.ink, Math.min(0.8, alpha * 1.25));
    c.fillRect(px - 1, y, 3, len + 1);
    c.fillStyle = rgba(PAL.white, alpha);
    c.fillRect(px, y, 1, len);
  }
}
