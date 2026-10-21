import * as THREE from 'three';

/**
 * Procedural 32³ colour-grading LUTs.
 *
 * Baking the grade into a 3D texture rather than evaluating it per pixel keeps
 * the final shader to one texture fetch no matter how elaborate the look gets,
 * and it means looks can cross-fade by blending two fetches instead of
 * interpolating a dozen uncorrelated parameters.
 *
 * The transfer runs on the post-tone-map display signal: linearise, white
 * balance, ASC CDL (slope/offset/power), back to display, S-curve around a
 * pivot, split-tone, luminance-weighted saturation, a selective boost on the
 * orange/teal axis, then a print black lift.
 *
 * The orange/teal step (`otBoost`) is the recognisable half of the look.
 * `ART_DIRECTION.md` asks for a global desaturation of ~12% followed by a
 * selective saturation boost on that one axis, which is exactly what the
 * blockbuster grade does: everything off-axis (greens, magentas) goes muddy
 * while warm keys and cool fills stay vivid, so the frame reads as two
 * temperatures rather than a wash of colour.
 */

export const LUT_SIZE = 32;

const LOOKS = {
  neutral: {
    wb: [1.0, 1.0, 1.0],
    exposure: 0.0,
    gain: [1.0, 1.0, 1.0],
    lift: [0.0, 0.0, 0.0],
    gamma: [1.0, 1.0, 1.0],
    contrast: 0.14,
    pivot: 0.42,
    sat: 1.03,
    satShadow: 0.94,
    satHighlight: 0.96,
    shadowTint: [-0.004, 0.0, 0.010],
    highlightTint: [0.010, 0.005, -0.004],
    splitStrength: 1.0,
    otBoost: 0.0,
    shoulder: 0.0,
    blackLift: 0.012,
    whiteCut: 0.0,
  },
  // The daylight look. Global desat then an orange/teal boost, a hard teal lift
  // in the toe and a warm highlight bias — the warm-key / cool-fill separation
  // ART_DIRECTION.md calls "what makes CoD's daylight read as expensive".
  warm_desert: {
    wb: [1.068, 1.0, 0.888],
    exposure: 0.02,
    gain: [1.03, 1.0, 0.955],
    lift: [0.002, 0.0, 0.006],
    gamma: [0.972, 1.0, 1.048],
    contrast: 0.30,
    pivot: 0.40,
    sat: 0.88,
    satShadow: 0.94,
    satHighlight: 1.00,
    shadowTint: [-0.022, -0.002, 0.046],
    highlightTint: [0.050, 0.021, -0.038],
    splitStrength: 1.0,
    otBoost: 0.42,
    // Soft print shoulder instead of a hard white cut, so the sky can still go
    // bright while sunlit concrete keeps tonal separation at the top.
    shoulder: 0.30,
    shoulderStart: 0.70,
    // ART_DIRECTION.md: the toe must not clip before ~0.02. Never pure #000.
    blackLift: 0.022,
    whiteCut: 0.0,
  },
  cold_urban: {
    wb: [0.936, 0.988, 1.078],
    exposure: -0.03,
    gain: [0.985, 1.0, 1.02],
    lift: [0.0, 0.001, 0.004],
    gamma: [1.03, 1.0, 0.97],
    contrast: 0.32,
    pivot: 0.38,
    sat: 0.87,
    satShadow: 0.80,
    satHighlight: 0.88,
    shadowTint: [-0.016, 0.006, 0.032],
    highlightTint: [0.006, 0.012, 0.018],
    splitStrength: 1.0,
    otBoost: 0.20,
    shoulder: 0.26,
    shoulderStart: 0.70,
    blackLift: 0.022,
    whiteCut: 0.0,
  },
  night_teal: {
    wb: [0.888, 0.976, 1.145],
    exposure: 0.06,
    gain: [0.96, 0.99, 1.05],
    lift: [0.0, 0.002, 0.008],
    gamma: [1.06, 1.01, 0.94],
    contrast: 0.20,
    pivot: 0.34,
    sat: 0.80,
    satShadow: 0.68,
    satHighlight: 0.98,
    shadowTint: [-0.024, 0.010, 0.052],
    highlightTint: [0.052, 0.024, -0.026],
    splitStrength: 1.0,
    // Night is already two temperatures — moon blue against sodium orange —
    // so it wants the axis boost too, just gentler than daylight.
    otBoost: 0.30,
    shoulder: 0.18,
    shoulderStart: 0.74,
    blackLift: 0.030,
    whiteCut: 0.0,
  },
};

export const LOOK_NAMES = Object.keys(LOOKS);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Print shoulder. A Reinhard knee above `start`: unit slope where it joins, then
 * a smooth compression so the top of the range is approached asymptotically and
 * never actually reached.
 *
 * ART_DIRECTION.md: "Highlight rolloff must be soft. Blown sky is fine and
 * correct; blown concrete is not." Measured against `refs/`, real Call of Duty
 * daylight frames put p95 at 150-225 and p99 at 197-242; without a shoulder ours
 * sat at 243-247 / 246-250, i.e. several percent of every frame pinned flat
 * against the ceiling with no tonal separation left in it. This is the curve
 * that buys that separation back.
 */
function shoulder(x, start, k) {
  if (k <= 0 || x <= start) return x;
  const span = 1 - start;
  const t = (x - start) / span;
  return start + span * (t / (1 + k * t));
}

function sCurve(x, amount, pivot) {
  const t = clamp01(x);
  const s = t * t * (3 - 2 * t);
  const blended = t + (s - t) * amount;
  // Re-anchor so the pivot keeps its value; without this every look drifts dark.
  const p = pivot;
  const ps = p * p * (3 - 2 * p);
  const shift = (ps - p) * amount;
  return clamp01(blended - shift * (1 - Math.abs(2 * t - 1)));
}

/**
 * Unit chroma direction of a saturated orange (255,140,38) with its luminance
 * removed. Its dot product with the CIE luma weights is ~2e-4, so pushing a
 * colour along it changes hue and chroma without touching brightness — and
 * because teal is the same axis negated, one projection boosts both ends.
 */
const OT_AXIS = [0.6303, -0.1102, -0.7684];

function bake(look, out) {
  const N = LUT_SIZE;
  const inv = 1 / (N - 1);
  let o = 0;
  for (let bi = 0; bi < N; bi++) {
    for (let gi = 0; gi < N; gi++) {
      for (let ri = 0; ri < N; ri++) {
        let r = srgbToLin(ri * inv);
        let g = srgbToLin(gi * inv);
        let b = srgbToLin(bi * inv);

        const e = Math.pow(2, look.exposure);
        r *= look.wb[0] * e;
        g *= look.wb[1] * e;
        b *= look.wb[2] * e;

        r = Math.pow(Math.max(0, r * look.gain[0] + look.lift[0]), look.gamma[0]);
        g = Math.pow(Math.max(0, g * look.gain[1] + look.lift[1]), look.gamma[1]);
        b = Math.pow(Math.max(0, b * look.gain[2] + look.lift[2]), look.gamma[2]);

        let dr = linToSrgb(Math.min(r, 1));
        let dg = linToSrgb(Math.min(g, 1));
        let db = linToSrgb(Math.min(b, 1));

        dr = sCurve(dr, look.contrast, look.pivot);
        dg = sCurve(dg, look.contrast, look.pivot);
        db = sCurve(db, look.contrast, look.pivot);

        const l0 = lum(dr, dg, db);
        const sw = (1 - l0) * (1 - l0) * look.splitStrength;
        const hw = l0 * l0 * look.splitStrength;
        dr += look.shadowTint[0] * sw + look.highlightTint[0] * hw;
        dg += look.shadowTint[1] * sw + look.highlightTint[1] * hw;
        db += look.shadowTint[2] * sw + look.highlightTint[2] * hw;

        const l1 = lum(dr, dg, db);
        const sat = look.sat * (look.satShadow + (look.satHighlight - look.satShadow) * l1);
        dr = l1 + (dr - l1) * sat;
        dg = l1 + (dg - l1) * sat;
        db = l1 + (db - l1) * sat;

        // Selective saturation on the orange/teal axis only. Project the
        // residual chroma onto the axis and re-add a fraction of it, so warm
        // keys and cool fills recover the chroma the global desat took while
        // everything off-axis stays muted.
        const ot = look.otBoost || 0;
        if (ot !== 0) {
          const cr = dr - l1, cg = dg - l1, cb = db - l1;
          const p = cr * OT_AXIS[0] + cg * OT_AXIS[1] + cb * OT_AXIS[2];
          const k = p * ot;
          dr += OT_AXIS[0] * k;
          dg += OT_AXIS[1] * k;
          db += OT_AXIS[2] * k;
        }

        const sk = look.shoulder || 0;
        if (sk > 0) {
          const ss = look.shoulderStart ?? 0.70;
          dr = shoulder(clamp01(dr), ss, sk);
          dg = shoulder(clamp01(dg), ss, sk);
          db = shoulder(clamp01(db), ss, sk);
        }

        const span = 1 - look.blackLift - look.whiteCut;
        dr = look.blackLift + clamp01(dr) * span;
        dg = look.blackLift + clamp01(dg) * span;
        db = look.blackLift + clamp01(db) * span;

        out[o++] = clamp01(dr) * 255;
        out[o++] = clamp01(dg) * 255;
        out[o++] = clamp01(db) * 255;
        out[o++] = 255;
      }
    }
  }
}

export function buildLookTextures() {
  const N = LUT_SIZE;
  const textures = {};
  for (const name of LOOK_NAMES) {
    const data = new Uint8Array(N * N * N * 4);
    bake(LOOKS[name], data);
    const tex = new THREE.Data3DTexture(data, N, N, N);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    tex.name = `lut:${name}`;
    textures[name] = tex;
  }
  return textures;
}
