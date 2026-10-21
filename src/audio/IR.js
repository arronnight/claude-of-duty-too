import { mulberry32 } from './Buffers.js';

/**
 * Procedurally generated impulse responses, one per acoustic space.
 *
 * A reverb is two things and they have to be built separately or it sounds
 * like a plugin preset rather than a place:
 *
 *  1. **Early reflections** — a handful of discrete, hard, panned taps whose
 *     delays come from an actual room geometry (first-order image sources off
 *     the facades, the road and the ceiling if there is one). These are what
 *     tell the ear how big the space is and how far away the walls are. A
 *     street's first reflection off the opposite facade at 11 m is a 64 ms slap
 *     you can hear as a distinct event; that slap is the sound of a street.
 *  2. **Late diffuse tail** — exponentially decaying noise with a cutoff that
 *     falls as the tail progresses, because every bounce costs high frequency
 *     to air absorption and to the plaster. A tail whose spectrum is constant
 *     reads as white noise fading out.
 *
 * The two channels are decorrelated (different noise seeds, mirrored early-tap
 * pans) so the tail opens up in stereo instead of collapsing to the centre.
 *
 * Cost: ~170 k float writes per second of IR. The four spaces together are a
 * few milliseconds, generated once after the audio context unlocks and
 * deliberately staggered across frames so nothing hitches.
 */

export const SPACES = {
  /**
   * Open street between two facade rows ~22 m apart. Long, bright, and
   * dominated by the flutter between the two walls.
   */
  street: {
    rt60: 1.35, predelay: 0.011, tone: 5200, toneEnd: 900, density: 0.55,
    taps: [
      [0.011, 0.62, -0.75], [0.019, 0.48, 0.80], [0.031, 0.44, -0.35],
      [0.043, 0.36, 0.42], [0.064, 0.40, -0.88], [0.079, 0.26, 0.55],
      [0.098, 0.22, -0.20], [0.131, 0.18, 0.66], [0.167, 0.13, -0.48],
    ],
    wet: 1.0,
  },
  /** A concrete room, 6 x 5 x 3 m. Short, boxy, dark, dense early cluster. */
  interior: {
    rt60: 0.62, predelay: 0.004, tone: 3400, toneEnd: 520, density: 0.9,
    taps: [
      [0.0042, 0.72, -0.30], [0.0071, 0.66, 0.36], [0.0098, 0.58, 0.12],
      [0.0143, 0.52, -0.52], [0.0186, 0.44, 0.48], [0.0231, 0.38, -0.18],
      [0.0295, 0.30, 0.62], [0.0384, 0.24, -0.44],
    ],
    wet: 0.85,
  },
  /** Underpass: hard parallel surfaces, low ceiling, long dark flutter. */
  underpass: {
    rt60: 2.1, predelay: 0.006, tone: 2600, toneEnd: 320, density: 0.75,
    taps: [
      [0.0058, 0.78, -0.62], [0.0092, 0.70, 0.66], [0.0146, 0.60, -0.28],
      [0.0212, 0.54, 0.34], [0.0288, 0.46, -0.70], [0.0371, 0.40, 0.58],
      [0.0466, 0.33, -0.24], [0.0602, 0.27, 0.50], [0.0791, 0.20, -0.60],
      [0.1044, 0.15, 0.40],
    ],
    wet: 1.15,
  },
  /**
   * The whole district heard from far away — no early structure at all, just a
   * long diffuse smear off everything in the map. This is what a distant
   * gunshot's boom is convolved with, and it is the layer that sells scale.
   */
  distant: {
    rt60: 2.8, predelay: 0.045, tone: 1500, toneEnd: 210, density: 0.35,
    taps: [[0.045, 0.30, -0.4], [0.088, 0.26, 0.5], [0.152, 0.20, -0.2], [0.244, 0.14, 0.35]],
    wet: 1.4,
  },
};

/**
 * @param {BaseAudioContext} ac
 * @param {object} spec one of SPACES
 * @param {number} seed
 * @returns {AudioBuffer} stereo impulse response
 */
export function buildIR(ac, spec, seed = 1) {
  const sr = ac.sampleRate;
  const len = Math.max(64, Math.floor(sr * (spec.rt60 + spec.predelay + 0.05)));
  const buf = ac.createBuffer(2, len, sr);
  // -60 dB over rt60 seconds.
  const decayK = Math.log(1000) / (spec.rt60 * sr);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rnd = mulberry32(seed * 7919 + ch * 104729);

    // --- late diffuse tail ---------------------------------------------------
    // One-pole lowpass whose coefficient tracks a cutoff falling from `tone`
    // to `toneEnd` across the tail: high frequencies die first, always.
    const pre = Math.floor(spec.predelay * sr);
    let lp = 0;
    const twoPiOverSr = (Math.PI * 2) / sr;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      const env = Math.exp(-decayK * (i - pre));
      // Density: below full density, only a fraction of samples get an impulse,
      // which makes a sparser, grainier tail (right for large open spaces).
      const w = rnd() < spec.density ? rnd() * 2 - 1 : 0;
      const cut = spec.tone * Math.pow(spec.toneEnd / spec.tone, t);
      const a = 1 - Math.exp(-twoPiOverSr * cut);
      lp += a * (w - lp);
      d[i] = lp * env;
    }

    // Normalise the tail before the early taps go on top, so `wet` means the
    // same thing across spaces with wildly different decay times.
    let peak = 1e-6;
    for (let i = 0; i < len; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    const norm = 0.42 / peak;
    for (let i = 0; i < len; i++) d[i] *= norm;

    // --- early reflections ---------------------------------------------------
    // Each tap is a short filtered burst rather than a single sample: a real
    // reflection off plaster is smeared by the surface, not a Dirac.
    for (const [delay, amp, pan] of spec.taps) {
      const at = Math.floor((delay + spec.predelay) * sr);
      if (at >= len - 8) continue;
      // Equal-power pan, mirrored per channel.
      const p = ch === 0 ? -pan : pan;
      const g = amp * Math.cos((p * 0.5 + 0.5) * Math.PI * 0.5) * Math.SQRT2 * 0.62;
      const width = 3 + Math.floor(rnd() * 5);
      for (let k = 0; k < width; k++) {
        const w = Math.exp(-k * 0.9) * (k === 0 ? 1 : rnd() * 2 - 1);
        d[at + k] += g * w;
      }
    }

    // Direct-path spike removed on purpose: the dry signal already carries it,
    // and leaving one in the IR doubles every transient.
    for (let i = 0; i < len; i++) d[i] *= spec.wet;
  }
  return buf;
}
