/**
 * Shared synthesis primitives: deterministic noise, cached noise buffers,
 * saturation curves and the small envelope helpers every voice uses.
 *
 * Everything a voice needs that is expensive to build is built once here and
 * cached on the AudioContext. A gunshot at 800 RPM fires thirteen times a
 * second and each one is five or six layers; allocating a fresh noise buffer
 * per layer would be the single most expensive thing in the game.
 */

/** Small, fast, seedable PRNG. Deterministic so a sound can be reproduced. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _cache = new WeakMap();
function bank(ac) {
  let b = _cache.get(ac);
  if (!b) _cache.set(ac, (b = {}));
  return b;
}

/**
 * Noise buffers, 2 s mono, generated once per context.
 *
 *  - `white` is flat; it is the crack of a rifle and the hiss of a ricochet.
 *  - `pink` (-3 dB/oct, Voss-McCartney style filtering) is the body of almost
 *    every natural sound: footsteps, cloth, debris.
 *  - `brown` (-6 dB/oct) is wind and distant rumble.
 *
 * Voices read from a random offset in the buffer, so re-using one buffer for
 * every noise layer never produces an audible repeat.
 */
export function noise(ac, kind = 'white') {
  const b = bank(ac);
  const key = `n_${kind}`;
  if (b[key]) return b[key];
  const n = Math.floor(ac.sampleRate * 2);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  const rnd = mulberry32(kind === 'white' ? 0x5eed : kind === 'pink' ? 0xa11ce : 0xb0b);
  if (kind === 'white') {
    for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
  } else if (kind === 'pink') {
    // Paul Kellet's economical pink filter — six one-poles summed.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  b[key] = buf;
  return buf;
}

/**
 * Soft asymmetric saturation. A gunshot that has not been driven into
 * something nonlinear sounds like a hiss; the harmonics a transient generates
 * when it clips are most of what the ear reads as "loud and close".
 */
export function driveCurve(ac, amount = 3) {
  const b = bank(ac);
  const key = `drive_${amount}`;
  if (b[key]) return b[key];
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount) * (1 - 0.06 * x * x);
  }
  b[key] = c;
  return c;
}

/** A one-shot noise source reading from a random offset. */
export function noiseSource(ac, kind, rate = 1, rnd = Math.random) {
  const src = ac.createBufferSource();
  const buf = noise(ac, kind);
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.loop = true;
  src._offset = rnd() * (buf.duration - 0.35);
  return src;
}

/**
 * Percussive envelope: instant (or near-instant) attack, exponential decay.
 * `setTargetAtTime` is deliberately avoided — its tail never reaches zero and
 * hundreds of never-ending gain nodes is a real leak in a shooter.
 */
/**
 * Web Audio throws a RangeError on a negative schedule time, and a voice that
 * wants to place a layer slightly *before* its nominal time (a cloth rustle
 * 40 ms ahead of the magazine seating, say) will go negative whenever the
 * context has only just started — which is exactly when the first shot of a
 * match is fired. Every scheduling entry point clamps.
 */
export const at = (t) => (t > 0 ? t : 0);

export function hit(param, t, peak, attack, decay, floor = 0.0001) {
  t = at(t);
  param.setValueAtTime(0.0001, t);
  if (attack > 0) param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  else param.setValueAtTime(Math.max(peak, 0.0002), t + 0.0005);
  param.exponentialRampToValueAtTime(floor, t + attack + decay);
  return t + attack + decay;
}

/** Linear ramp helper for filter cutoffs, which sound wrong swept exponentially. */
export function sweep(param, t, from, to, time) {
  t = at(t);
  param.setValueAtTime(Math.max(20, from), t);
  param.exponentialRampToValueAtTime(Math.max(20, to), t + time);
}

export function biquad(ac, type, freq, q = 0.7, gain = 0) {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  if (gain) f.gain.value = gain;
  return f;
}

export function gain(ac, v = 0) {
  const g = ac.createGain();
  g.gain.value = v;
  return g;
}

/** Starts `src` at `t` and tears the whole chain down when it finishes. */
export function fire(src, t, dur, onEnd) {
  t = at(t);
  try {
    src.start(t, src._offset || 0);
    src.stop(t + dur);
  } catch { /* a context torn down mid-schedule */ }
  if (onEnd) src.onended = onEnd;
  return src;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
