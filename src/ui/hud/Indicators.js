import { PAL, rgba, clamp01, easeOutCubic } from './theme.js';

const MAX = 6;
const LIFE = 1.2;          // spec: fade over 1.2 s
const SPAN = 0.62;         // arc width, radians (~36 degrees)
const SEGS = 9;

/**
 * Directional damage indicators.
 *
 * Red arcs on a ring around the reticle pointing at the source of the hit,
 * fading over 1.2 s. Two details do most of the work:
 *
 *  - The angular taper is real, not a rectangle with rounded ends. Each arc is
 *    drawn as nine short strokes whose width and alpha follow a cosine window,
 *    so it reads as a soft directional smear rather than a UI widget.
 *  - Repeat hits from roughly the same bearing refresh the existing arc and
 *    push its intensity up instead of stacking a second identical arc on top,
 *    which is what makes sustained fire from one direction read as sustained
 *    fire rather than as flicker.
 */
export class Indicators {
  constructor() {
    this.slots = [];
    for (let i = 0; i < MAX; i++) this.slots.push({ live: false, t: 0, angle: 0, power: 1 });
    this.cx = 0; this.cy = 0; this.r = 0; this.k = 1;
  }

  layout(w, h) {
    this.cx = w * 0.5;
    this.cy = h * 0.5;
    this.r = Math.min(w, h) * 0.285;
    this.k = Math.min(Math.max(h / 900, 0.85), 1.5);
  }

  /** `angle` is screen-relative: 0 straight ahead, +pi/2 to the player's right. */
  add(angle, power) {
    if (!Number.isFinite(angle)) return;
    for (const s of this.slots) {
      if (!s.live) continue;
      let d = Math.abs(((s.angle - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d < 0.45) {
        s.t = Math.min(s.t, 0.08);
        s.power = Math.min(1.6, s.power + 0.35);
        s.angle = s.angle + (angle - s.angle) * 0.4;
        return;
      }
    }
    let slot = null, oldest = -1;
    for (const s of this.slots) {
      if (!s.live) { slot = s; break; }
      if (s.t > oldest) { oldest = s.t; slot = s; }
    }
    slot.live = true;
    slot.t = 0;
    slot.angle = angle;
    slot.power = clamp01(power ?? 0.6) * 0.6 + 0.55;
  }

  clear() { for (const s of this.slots) s.live = false; }

  update(dt) {
    for (const s of this.slots) {
      if (!s.live) continue;
      s.t += dt;
      if (s.t > LIFE) s.live = false;
    }
  }

  draw(c, st) {
    const { cx, cy, r, k } = this;
    c.lineCap = 'butt';
    for (const s of this.slots) {
      if (!s.live) continue;
      const p = s.t / LIFE;
      // Snap in, then a long ease out — the arrival must be instant to be useful.
      const a = (p < 0.06 ? easeOutCubic(p / 0.06) : 1 - Math.pow((p - 0.06) / 0.94, 1.35)) * st.alpha;
      if (a <= 0.01) continue;
      // Canvas 0 rad is +X; screen-forward is -Y, hence the quarter turn.
      const base = s.angle - Math.PI * 0.5;
      const grow = 1 + (1 - clamp01(p / 0.12)) * 0.06;

      for (let pass = 0; pass < 2; pass++) {
        const outline = pass === 0;
        for (let i = 0; i < SEGS; i++) {
          const t0 = i / SEGS, t1 = (i + 1) / SEGS;
          const mid = (t0 + t1) * 0.5;
          const win = Math.pow(Math.cos((mid - 0.5) * Math.PI), 1.4);
          const aa = a * win * s.power;
          if (aa <= 0.02) continue;
          c.strokeStyle = outline ? rgba(PAL.ink, aa * 0.45) : rgba(PAL.danger, Math.min(0.92, aa));
          c.lineWidth = (outline ? 13 : 8.2) * k * (0.42 + 0.58 * win);
          c.beginPath();
          c.arc(cx, cy, r * grow, base + (t0 - 0.5) * SPAN, base + (t1 - 0.5) * SPAN);
          c.stroke();
        }
      }
    }
  }
}
