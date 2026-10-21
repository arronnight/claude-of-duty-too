/**
 * Shared HUD look: palette, type scale and the drawing primitives every widget
 * uses.
 *
 * The reference is modern Call of Duty, which is far more restrained than most
 * people remember: thin strokes, no chunky borders, no gradients or bevels,
 * almost everything is white or near-white at partial alpha and legibility
 * comes from a tight drop shadow rather than from an outline or a panel. Colour
 * is spent only where it carries meaning — amber for low ammo, red for damage
 * and kills, pale blue for friendlies.
 *
 * Everything here is allocation-free in steady state: colour strings are
 * memoised by quantised alpha and font strings are built once per layout.
 */

// --- palette (linear-ish sRGB byte triples, alpha supplied at the call site) ---
export const PAL = {
  white: [255, 255, 255],
  ink: [0, 0, 0],
  dim: [214, 219, 224],
  steel: [150, 161, 172],
  amber: [255, 176, 62],
  danger: [255, 74, 58],
  kill: [255, 58, 46],
  friend: [138, 199, 255],
  health: [226, 232, 238],
  healthLow: [255, 92, 74],
  chip: [176, 46, 38],
  stamina: [198, 228, 255],
};

const _rgbaCache = new Map();
/** Memoised `rgba()` string. Alpha is quantised to 1/64 so the cache stays tiny. */
export function rgba(c, a) {
  const qa = a <= 0 ? 0 : a >= 1 ? 64 : (a * 64) | 0;
  const key = (((c[0] << 8) | c[1]) << 8 | c[2]) * 65 + qa;
  let s = _rgbaCache.get(key);
  if (s === undefined) {
    s = `rgba(${c[0]},${c[1]},${c[2]},${(qa / 64).toFixed(3)})`;
    _rgbaCache.set(key, s);
  }
  return s;
}

/**
 * No webfonts are available (hard offline constraint), so the stack is the
 * platform grotesques in rough order of how condensed they are. Weight does the
 * work instead: 200-300 for numerals, 500-600 for small letterspaced labels.
 */
const FAMILY = '"Helvetica Neue",Helvetica,"Segoe UI",Roboto,system-ui,Arial,sans-serif';
export const font = (weight, px) => `${weight} ${px.toFixed(1)}px ${FAMILY}`;

/** True when the 2D context supports canvas letter-spacing (Chromium 99+). */
export function supportsTracking(c) {
  return typeof c.letterSpacing === 'string';
}

export function setTracking(c, em, px) {
  if (typeof c.letterSpacing === 'string') c.letterSpacing = `${(em * px).toFixed(2)}px`;
}

export function clearTracking(c) {
  if (typeof c.letterSpacing === 'string') c.letterSpacing = '0px';
}

/**
 * The HUD's only "background": a soft dark shadow under every mark. This is
 * what keeps white type readable against a blown sky without drawing a panel.
 */
export function shadow(c, blur = 4, alpha = 0.55, dy = 1) {
  c.shadowColor = rgba(PAL.ink, alpha);
  c.shadowBlur = blur;
  c.shadowOffsetY = dy;
}

export function noShadow(c) {
  c.shadowColor = 'rgba(0,0,0,0)';
  c.shadowBlur = 0;
  c.shadowOffsetY = 0;
}

export function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) * 0.5, Math.abs(h) * 0.5);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}

/** Small upward-pointing triangle, used for the compass heading marker. */
export function triangle(c, x, y, w, h, up = true) {
  c.beginPath();
  if (up) {
    c.moveTo(x, y);
    c.lineTo(x - w * 0.5, y + h);
    c.lineTo(x + w * 0.5, y + h);
  } else {
    c.moveTo(x, y + h);
    c.lineTo(x - w * 0.5, y);
    c.lineTo(x + w * 0.5, y);
  }
  c.closePath();
}

// --- easing / timing -------------------------------------------------------

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential approach. `rate` is roughly 1/seconds. */
export function approach(cur, target, rate, dt) {
  return target + (cur - target) * Math.exp(-rate * dt);
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeInQuad = (t) => t * t;
/** Slight overshoot, for scale punches. */
export const easeOutBack = (t) => {
  const s = 1.9;
  const u = t - 1;
  return 1 + u * u * ((s + 1) * u + s);
};
