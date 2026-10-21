import { noiseSource, driveCurve, biquad, gain, hit, sweep, fire, mulberry32, clamp } from './Buffers.js';

/**
 * Gunshot synthesis.
 *
 * A gunshot is not one sound, it is five events that happen within 200 ms, and
 * the reason a single filtered noise burst reads as fake is that it only has
 * one of them. What is layered here, in the order the ear resolves them:
 *
 *  1. **Crack** — the muzzle blast's leading edge. Broadband noise through a
 *     resonant bandpass, hard-driven into saturation, decaying in 15-40 ms.
 *     This is the layer that carries calibre: a 5.56 cracks around 1.8 kHz, a
 *     7.62 nearer 1.1 kHz, a 12-gauge is a wide 700 Hz wall.
 *  2. **Body** — a sine sweeping down fast (the expanding gas ball) through a
 *     lowpass. This is the "thump" in the chest and it is what most browser
 *     gunshots are missing entirely.
 *  3. **Sub** — a very short 45 Hz half-cycle. Inaudible on laptop speakers,
 *     which is fine; on anything with a woofer it is most of the weight.
 *  4. **Punch/bark** — a mid-band noise layer with a longer decay than the
 *     crack, which is the shot's "colour" and where weapons differ most.
 *  5. **Mechanism** — the bolt/slide, 6-10 ms of bandpassed noise plus a high-Q
 *     metallic ring. Dry, close, and unaffected by distance, because on your
 *     own weapon it happens at your shoulder. Omitted entirely on other
 *     people's guns past ~8 m, where you would never hear it.
 *
 * Distance adds a sixth: past 40 m the supersonic **ballistic crack** and the
 * **muzzle boom** separate in time, because the bullet outruns its own report.
 * The gap is d x (1/343 - 1/900) — 100 ms at 55 m, 180 ms at 100 m — and
 * reproducing it is the single most effective thing you can do to make a map
 * sound big.
 */

/**
 * Per-weapon spectral signature. Values are deliberately specific: they were
 * tuned against the calibres in docs/GAMEPLAY.md, not picked to be different.
 */
export const SIGNATURES = {
  m4: {
    level: 0.85, crackF: 1850, crackQ: 1.05, crackDecay: 0.030, drive: 4.5,
    barkF: 620, barkQ: 0.9, barkDecay: 0.085, barkLevel: 0.52,
    bodyF0: 210, bodyF1: 62, bodyDecay: 0.075, bodyLevel: 0.5,
    subLevel: 0.34, hiss: 0.30, hissDecay: 0.20,
    ringF: 3050, ringLevel: 0.22, mechF: 2400, mechLevel: 0.30,
    send: 0.40, tail: 0.85,
  },
  ak74: {
    level: 0.95, crackF: 1180, crackQ: 0.85, crackDecay: 0.042, drive: 5.6,
    barkF: 430, barkQ: 0.8, barkDecay: 0.115, barkLevel: 0.66,
    bodyF0: 175, bodyF1: 48, bodyDecay: 0.105, bodyLevel: 0.66,
    subLevel: 0.48, hiss: 0.26, hissDecay: 0.24,
    ringF: 2280, ringLevel: 0.26, mechF: 1900, mechLevel: 0.38,
    send: 0.46, tail: 1.0,
  },
  mp5: {
    level: 0.86, crackF: 2450, crackQ: 1.3, crackDecay: 0.019, drive: 3.4,
    barkF: 880, barkQ: 1.1, barkDecay: 0.052, barkLevel: 0.40,
    bodyF0: 260, bodyF1: 88, bodyDecay: 0.046, bodyLevel: 0.44,
    subLevel: 0.16, hiss: 0.34, hissDecay: 0.13,
    ringF: 3900, ringLevel: 0.30, mechF: 3100, mechLevel: 0.44,
    send: 0.32, tail: 0.6,
  },
  m870: {
    level: 1.0, crackF: 720, crackQ: 0.55, crackDecay: 0.070, drive: 6.4,
    barkF: 300, barkQ: 0.6, barkDecay: 0.185, barkLevel: 0.95,
    bodyF0: 140, bodyF1: 38, bodyDecay: 0.150, bodyLevel: 0.85,
    subLevel: 0.68, hiss: 0.22, hissDecay: 0.34,
    ringF: 1650, ringLevel: 0.14, mechF: 1400, mechLevel: 0.26,
    send: 0.55, tail: 1.25,
  },
  dmr: {
    level: 1.0, crackF: 2050, crackQ: 1.5, crackDecay: 0.026, drive: 6.0,
    barkF: 520, barkQ: 0.75, barkDecay: 0.135, barkLevel: 0.70,
    bodyF0: 190, bodyF1: 44, bodyDecay: 0.125, bodyLevel: 0.72,
    subLevel: 0.55, hiss: 0.30, hissDecay: 0.34,
    ringF: 2650, ringLevel: 0.34, mechF: 2100, mechLevel: 0.34,
    send: 0.60, tail: 1.35,
  },
  deagle: {
    level: 0.90, crackF: 1420, crackQ: 1.15, crackDecay: 0.034, drive: 5.2,
    barkF: 700, barkQ: 1.0, barkDecay: 0.095, barkLevel: 0.62,
    bodyF0: 230, bodyF1: 58, bodyDecay: 0.088, bodyLevel: 0.60,
    subLevel: 0.40, hiss: 0.24, hissDecay: 0.18,
    ringF: 4200, ringLevel: 0.40, mechF: 2900, mechLevel: 0.46,
    send: 0.44, tail: 0.9,
  },
};

const DEFAULT = SIGNATURES.m4;
const rnd = mulberry32(0xC0DE);

export function signature(id) {
  return SIGNATURES[id] || DEFAULT;
}

/**
 * @param {AudioGraph} g
 * @param {string} id weapon id
 * @param {object} o `{ x,y,z }` world position, or `local:true` for the player's
 *                   own weapon; plus `suppressed`, `gain`, `indoors`.
 */
export function gunshot(g, id, o = {}) {
  const sig = signature(id);
  const ac = g.ac;
  const local = !!o.local;

  const route = local
    ? g.local({ bus: 'weapons', gain: (o.gain ?? 1) * sig.level * 0.8, send: sig.send * 0.55, pan: o.pan || 0 })
    : g.spatial(o.x || 0, o.y || 1.5, o.z || 0, {
      bus: 'weapons', gain: (o.gain ?? 1) * sig.level * 2.2,
      ref: 16, rolloff: 1.05, airRef: 58, send: sig.send,
      far: 0,
    });
  if (!route) return;

  const t = route.when;
  const dist = route.distance;
  const dry = route.input;

  // Air and windows swallow the top end; a shot heard through a wall or from
  // 60 m has almost no crack left, only bark and body.
  const closeness = local ? 1 : clamp(1 - dist / 70, 0.12, 1);
  const sup = o.suppressed ? 0.35 : 1;
  let last = t;

  // --- 1. crack -------------------------------------------------------------
  {
    const src = noiseSource(ac, 'white', 1, rnd);
    const bp = biquad(ac, 'bandpass', sig.crackF * (0.97 + rnd() * 0.06), sig.crackQ);
    const hp = biquad(ac, 'highpass', 260, 0.7);
    const shaper = ac.createWaveShaper();
    shaper.curve = driveCurve(ac, sig.drive);
    shaper.oversample = '2x';
    const env = gain(ac, 0);
    const decay = sig.crackDecay * (o.suppressed ? 1.7 : 1);
    src.connect(bp); bp.connect(shaper); shaper.connect(hp); hp.connect(env); env.connect(dry);
    last = Math.max(last, hit(env.gain, t, 1.0 * closeness * sup, 0.0007, decay));
    fire(src, t, decay + 0.02, () => { src.disconnect(); bp.disconnect(); shaper.disconnect(); hp.disconnect(); env.disconnect(); });
  }

  // --- 2. bark / punch ------------------------------------------------------
  {
    const src = noiseSource(ac, 'pink', 1, rnd);
    const bp = biquad(ac, 'bandpass', sig.barkF * (0.95 + rnd() * 0.1), sig.barkQ);
    const env = gain(ac, 0);
    src.connect(bp); bp.connect(env); env.connect(dry);
    last = Math.max(last, hit(env.gain, t, sig.barkLevel * sup, 0.0015, sig.barkDecay));
    fire(src, t, sig.barkDecay + 0.02, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });
  }

  // --- 3. body: the gas ball, a fast downward sine sweep --------------------
  {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    const lp = biquad(ac, 'lowpass', 900, 0.9);
    const env = gain(ac, 0);
    osc.frequency.setValueAtTime(sig.bodyF0 * (0.96 + rnd() * 0.08), t);
    osc.frequency.exponentialRampToValueAtTime(sig.bodyF1, t + sig.bodyDecay * 0.9);
    osc.connect(lp); lp.connect(env); env.connect(dry);
    hit(env.gain, t, sig.bodyLevel * sup, 0.0012, sig.bodyDecay);
    osc.start(t);
    osc.stop(t + sig.bodyDecay + 0.03);
    osc.onended = () => { osc.disconnect(); lp.disconnect(); env.disconnect(); };
  }

  // --- 4. sub ---------------------------------------------------------------
  if (sig.subLevel > 0.05) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(78, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.09);
    const env = gain(ac, 0);
    osc.connect(env); env.connect(dry);
    hit(env.gain, t, sig.subLevel * sup, 0.002, 0.11);
    osc.start(t);
    osc.stop(t + 0.14);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
  }

  // --- 5. hiss tail: the blast decaying into the space ----------------------
  {
    const src = noiseSource(ac, 'white', 1, rnd);
    const lp = biquad(ac, 'lowpass', 7000, 0.6);
    const hp = biquad(ac, 'highpass', 700, 0.5);
    const env = gain(ac, 0);
    sweep(lp.frequency, t, 7000 * closeness + 500, 900, sig.hissDecay);
    src.connect(hp); hp.connect(lp); lp.connect(env); env.connect(dry);
    const d = sig.hissDecay * (o.indoors ? 1.35 : 1);
    hit(env.gain, t, sig.hiss * closeness * sup, 0.004, d);
    fire(src, t, d + 0.03, () => { src.disconnect(); lp.disconnect(); hp.disconnect(); env.disconnect(); });
  }

  // --- 6. mechanism ---------------------------------------------------------
  // Only audible on your own weapon and on someone standing right next to you.
  if (local || dist < 9) {
    const mech = clamp(local ? 1 : 1 - dist / 9, 0, 1);
    action(g, ac, dry, t + 0.010, sig, mech * 0.9);
  }

  // --- 7. distance: crack-then-boom -----------------------------------------
  if (!local && dist > 34) distantReport(g, sig, o, dist, t);

  // Tear down the routing once the longest layer has finished.
  const life = (last - t) + 0.35 + sig.tail * 0.4;
  scheduleRelease(ac, route, life);

  g.duck(clamp(0.35 + sig.level * 0.3, 0, 0.8) * (local ? 1 : clamp(1 - dist / 60, 0.15, 1)));
}

/** Bolt/slide cycling: a short noise chuff plus a high-Q metallic ring. */
export function action(g, ac, dest, t, sig, level = 1) {
  const src = noiseSource(ac, 'white', 1, rnd);
  const bp = biquad(ac, 'bandpass', sig.mechF, 2.2);
  const env = gain(ac, 0);
  src.connect(bp); bp.connect(env); env.connect(dest);
  hit(env.gain, t, 0.30 * level, 0.0008, 0.028);
  fire(src, t, 0.05, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });

  const ring = noiseSource(ac, 'white', 1, rnd);
  const rq = biquad(ac, 'bandpass', sig.ringF * (0.98 + rnd() * 0.04), 26);
  const renv = gain(ac, 0);
  ring.connect(rq); rq.connect(renv); renv.connect(dest);
  hit(renv.gain, t + 0.002, sig.ringLevel * level, 0.001, 0.075);
  fire(ring, t + 0.002, 0.1, () => { ring.disconnect(); rq.disconnect(); renv.disconnect(); });
}

/**
 * The far layer. Two events, separated in time:
 *
 *   t + d/343 - d x (1/343 - 1/900)   ballistic crack  (bright, dry, short)
 *   t + d/343                         muzzle boom      (dark, wet, long)
 *
 * The crack only exists if the round passed near the listener, which for our
 * purposes means "the shooter was roughly facing us". Without a shot direction
 * we assume they were — a firefight in which you never hear the crack sounds
 * like it is happening on television.
 */
export function distantReport(g, sig, o, dist, t0) {
  const ac = g.ac;
  const far = clamp((dist - 30) / 70, 0, 1);

  // --- muzzle boom ----------------------------------------------------------
  const boom = g.spatial(o.x || 0, o.y || 1.5, o.z || 0, {
    bus: 'weapons', gain: 1.35 + far * 0.9, ref: 34, rolloff: 0.72,
    airRef: 150, tone: 0.30, send: 0.25, far: 0.55 + far * 0.6,
  });
  if (boom) {
    const t = boom.when + 0.004;
    const src = noiseSource(ac, 'pink', 1, rnd);
    const lp = biquad(ac, 'lowpass', 520 - far * 200, 1.1);
    const bp = biquad(ac, 'bandpass', 150 + sig.bodyF1 * 1.4, 0.7);
    const env = gain(ac, 0);
    src.connect(bp); bp.connect(lp); lp.connect(env); env.connect(boom.input);
    const decay = 0.16 + far * 0.30;
    hit(env.gain, t, 0.9, 0.008, decay);
    fire(src, t, decay + 0.05, () => { src.disconnect(); lp.disconnect(); bp.disconnect(); env.disconnect(); });

    // A rolling low thud underneath — the part that arrives as pressure.
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(96, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    const oe = gain(ac, 0);
    osc.connect(oe); oe.connect(boom.input);
    hit(oe.gain, t, 0.55, 0.006, 0.20 + far * 0.2);
    osc.start(t); osc.stop(t + 0.45);
    osc.onended = () => { osc.disconnect(); oe.disconnect(); };

    scheduleRelease(ac, boom, decay + 1.6);
  }

  // --- ballistic crack ------------------------------------------------------
  // Arrives first. Dry and bright: it is generated by the bullet a few metres
  // from your head, not at the muzzle, so it has no room on it at all.
  const lead = dist * (1 / 343 - 1 / 900);
  // The crack is generated by the bullet a few metres from your head, not at
  // the muzzle, so it barely attenuates with the shooter's distance — hence the
  // large `ref` and shallow `rolloff`. Measured against the boom layer it came
  // out 25 dB down on the first pass, which is inaudible; in life the crack is
  // the *louder* of the two and the boom is the duller thump behind it.
  const crack = g.spatial(o.x || 0, o.y || 1.5, o.z || 0, {
    bus: 'weapons', gain: 3.4, ref: 70, rolloff: 0.45, airRef: 260,
    send: 0.08, noDelay: true, delay: Math.max(0, dist / 343 - lead),
  });
  if (crack && dist > 40) {
    const t = crack.when;
    const src = noiseSource(ac, 'white', 1, rnd);
    const bp = biquad(ac, 'bandpass', 2750 + rnd() * 500, 0.62);
    const shaper = ac.createWaveShaper();
    shaper.curve = driveCurve(ac, 3.2);
    const env = gain(ac, 0);
    src.connect(bp); bp.connect(shaper); shaper.connect(env); env.connect(crack.input);
    hit(env.gain, t, 0.95 * (1 - far * 0.30), 0.0005, 0.019);
    fire(src, t, 0.05, () => { src.disconnect(); bp.disconnect(); shaper.disconnect(); env.disconnect(); });

    // The whip underneath it — the pressure wave, an octave and a half down.
    // Without this the crack is a tick; with it, it snaps.
    const w = noiseSource(ac, 'white', 1, rnd);
    const wbp = biquad(ac, 'bandpass', 900, 1.4);
    const wenv = gain(ac, 0);
    w.connect(wbp); wbp.connect(wenv); wenv.connect(crack.input);
    hit(wenv.gain, t + 0.001, 0.55 * (1 - far * 0.25), 0.0008, 0.038);
    fire(w, t, 0.07, () => { w.disconnect(); wbp.disconnect(); wenv.disconnect(); });

    scheduleRelease(ac, crack, 0.35);
  } else if (crack) {
    crack.release();
  }
}

/**
 * Voices are torn down on a timer rather than on the last node's `onended`,
 * because the send gains outlive their sources by the length of the reverb and
 * disconnecting them early chops the tail.
 *
 * Two things this has to get right, both of which were wrong first time and
 * both of which only show up at distance:
 *
 *  - `seconds` is a lifetime measured from when the voice *sounds*, not from
 *    now. A shot 120 m away is scheduled 350 ms into the future; tearing its
 *    routing down 250 ms from now disconnects it before it has made a sound.
 *  - An OfflineAudioContext renders faster than real time, so a wall-clock
 *    timer fires in the middle of the render and cuts the output. Offline
 *    contexts are single-use and thrown away, so there is nothing to release.
 */
export function scheduleRelease(ac, route, seconds) {
  if (typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext) return;
  const lead = Math.max(0, route.when - ac.currentTime);
  setTimeout(route.release, Math.max(120, (lead + seconds) * 1000));
}

export { rnd as gunRnd };
