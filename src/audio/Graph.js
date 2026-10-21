import { SPACES, buildIR } from './IR.js';
import { biquad, gain, clamp } from './Buffers.js';

/**
 * The mix. Everything that is true of the whole game's sound lives here:
 * bus structure, the master compressor, distance handling, the reverb spaces
 * and the two global effects (ambience ducking and the post-explosion muffle).
 *
 * ## Signal flow
 *
 *   weapons ┐
 *   world   ├─▶ masterIn ─▶ muffle ─▶ compressor ─▶ limiter ─▶ out
 *   foley   │      ▲
 *   ui      ┘      │
 *   ambience ─▶ duck ┘
 *                    ▲
 *   revSend ─▶ [street|interior|underpass convolvers] ─┤
 *   farSend ─▶ [distant convolver] ────────────────────┘
 *
 * Two independent reverb sends, not one. The local send is crossfaded by where
 * the listener is standing; the far send is permanently the whole-district IR
 * and is what the distant-report layer of a far gunshot goes through. Trying to
 * serve both from one convolver is why most games' distant gunfire sounds like
 * near gunfire turned down.
 *
 * ## Distance
 *
 * Propagation delay is applied by *scheduling* rather than by a DelayNode —
 * exact, free, and it means a shot 90 m away genuinely arrives a quarter of a
 * second late. Air absorption is a one-pole lowpass whose cutoff falls
 * exponentially with distance, and the level follows a soft inverse law rather
 * than true inverse-square, which would make anything past 30 m inaudible.
 */

const SPEED_OF_SOUND = 343;
const MAX_VOICES = 44;

export class AudioGraph {
  constructor(ac) {
    this.ac = ac;
    this.voices = 0;
    this.spaceReady = false;

    // --- master chain -------------------------------------------------------
    const out = this.out = gain(ac, 0.9);

    // Limiter last: fast, high ratio, only catches what the compressor missed.
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -1.6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;

    // Master compressor: glue, and it is what stops a burst of automatic fire
    // from being three times as loud as a single shot.
    const comp = this.comp = ac.createDynamicsCompressor();
    comp.threshold.value = -15;
    comp.knee.value = 9;
    comp.ratio.value = 3.6;
    comp.attack.value = 0.004;
    comp.release.value = 0.17;

    // Post-explosion muffle. Idles wide open, so it is inaudible until used.
    const muffle = this.muffle = biquad(ac, 'lowpass', 20000, 0.55);
    const muffleTilt = this.muffleTilt = biquad(ac, 'peaking', 2600, 1.1, 0);

    const masterIn = this.masterIn = gain(ac, 1);
    masterIn.connect(muffle);
    muffle.connect(muffleTilt);
    muffleTilt.connect(comp);
    comp.connect(limiter);
    limiter.connect(out);
    out.connect(ac.destination);

    // --- buses --------------------------------------------------------------
    this.bus = {
      weapons: gain(ac, 1.0),
      world: gain(ac, 0.9),
      foley: gain(ac, 0.75),
      ui: gain(ac, 0.7),
    };
    for (const k in this.bus) this.bus[k].connect(masterIn);

    this.duckNode = gain(ac, 1);
    this.ambienceBus = gain(ac, 0.5);
    this.ambienceBus.connect(this.duckNode);
    this.duckNode.connect(masterIn);

    // --- reverb sends -------------------------------------------------------
    this.revSend = gain(ac, 1);
    this.farSend = gain(ac, 1);
    this.spaces = {};
    for (const name of ['street', 'interior', 'underpass']) {
      const conv = ac.createConvolver();
      conv.normalize = false;
      const g = gain(ac, name === 'street' ? 1 : 0);
      this.revSend.connect(conv);
      conv.connect(g);
      g.connect(masterIn);
      this.spaces[name] = { conv, gain: g, weight: name === 'street' ? 1 : 0 };
    }
    const farConv = ac.createConvolver();
    farConv.normalize = false;
    const farGain = gain(ac, 1);
    this.farSend.connect(farConv);
    farConv.connect(farGain);
    farGain.connect(masterIn);
    this.farSpace = { conv: farConv, gain: farGain };

    // --- listener -----------------------------------------------------------
    this.lx = 0; this.ly = 1.7; this.lz = 0;
    this.fx = 0; this.fy = 0; this.fz = -1;
    this.rx = 1; this.ry = 0; this.rz = 0;

    this._duckLevel = 1;
  }

  /**
   * IRs are heavy enough to be worth staggering. Called repeatedly (once per
   * frame is fine); does one space per call and reports when it is finished.
   */
  buildSpacesIncremental() {
    if (this.spaceReady) return true;
    this._pending = this._pending || ['street', 'interior', 'underpass', 'distant'];
    const name = this._pending.shift();
    if (!name) { this.spaceReady = true; return true; }
    const spec = SPACES[name];
    const ir = buildIR(this.ac, spec, name.length * 31 + 7);
    if (name === 'distant') this.farSpace.conv.buffer = ir;
    else this.spaces[name].conv.buffer = ir;
    if (!this._pending.length) this.spaceReady = true;
    return this.spaceReady;
  }

  setListener(px, py, pz, fx, fy, fz) {
    this.lx = px; this.ly = py; this.lz = pz;
    const len = Math.hypot(fx, fz) || 1;
    this.fx = fx / len; this.fy = fy; this.fz = fz / len;
    // Right = forward x up, flattened. Roll is not modelled; nobody hears it.
    this.rx = -this.fz; this.ry = 0; this.rz = this.fx;
  }

  /**
   * Crossfades the three local spaces. Weights need not be normalised.
   * Ramped rather than stepped: a hard cut between IRs on a listener walking
   * through a doorway is a very audible click in the reverb tail.
   */
  setSpaceWeights(street, interior, underpass, ramp = 0.35) {
    const total = street + interior + underpass || 1;
    const t = this.ac.currentTime;
    const w = { street: street / total, interior: interior / total, underpass: underpass / total };
    for (const name in w) {
      const s = this.spaces[name];
      if (Math.abs(s.weight - w[name]) < 0.01) continue;
      s.weight = w[name];
      s.gain.gain.cancelScheduledValues(t);
      s.gain.gain.setValueAtTime(s.gain.gain.value, t);
      s.gain.gain.linearRampToValueAtTime(w[name], t + ramp);
    }
  }

  /** Ambience pulls back under gunfire and pushes back up after it. */
  duck(amount = 0.55, hold = 0.09, release = 0.5) {
    const t = this.ac.currentTime;
    const g = this.duckNode.gain;
    const target = clamp(1 - amount, 0.05, 1);
    // Re-triggered on every shot: sustained fire holds the duck down rather
    // than pumping the ambience back up between rounds.
    g.cancelScheduledValues(t);
    g.setValueAtTime(clamp(g.value, 0.05, 1), t);
    g.linearRampToValueAtTime(target, t + 0.018);
    g.setValueAtTime(target, t + 0.018 + hold);
    g.linearRampToValueAtTime(1, t + 0.018 + hold + release);
  }

  /**
   * Post-explosion muffle: the world goes dark and quiet, then comes back over
   * a couple of seconds. Plus the tinnitus tone, which is the part everyone
   * actually remembers from the games.
   */
  muffleSweep(strength = 1, seconds = 2.6) {
    const ac = this.ac;
    const t = ac.currentTime;
    const s = clamp(strength, 0, 1);
    const floor = 380 + (1 - s) * 3000;

    const f = this.muffle.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(Math.max(f.value, floor), t);
    f.exponentialRampToValueAtTime(floor, t + 0.05);
    f.exponentialRampToValueAtTime(20000, t + seconds * (0.6 + s * 0.6));

    // A dip in the presence band as well, so it is not just "darker" but
    // genuinely deadened.
    const tilt = this.muffleTilt.gain;
    tilt.cancelScheduledValues(t);
    tilt.setValueAtTime(-14 * s, t + 0.05);
    tilt.linearRampToValueAtTime(0, t + seconds);

    const mg = this.masterIn.gain;
    mg.cancelScheduledValues(t);
    mg.setValueAtTime(1, t);
    mg.linearRampToValueAtTime(1 - 0.45 * s, t + 0.04);
    mg.linearRampToValueAtTime(1, t + seconds * 0.8);

    // Tinnitus: two close sines beating slightly, fading over four seconds.
    if (s > 0.35) {
      for (let i = 0; i < 2; i++) {
        const o = ac.createOscillator();
        o.type = 'sine';
        o.frequency.value = 4380 + i * 11;
        const g = gain(ac, 0);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.055 * s, t + 0.06);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3.4 + s * 1.6);
        o.connect(g);
        g.connect(this.out);
        o.start(t);
        o.stop(t + 5.2);
        o.onended = () => { try { g.disconnect(); } catch {} };
      }
    }
  }

  // --- per-voice routing ----------------------------------------------------

  /**
   * Builds the output chain for one positional voice and returns its input.
   *
   * Returns `null` when the voice is inaudible or the budget is spent, and the
   * caller must then not build the source layers at all — that check is the
   * only thing keeping a full-auto firefight with six bots from creating a
   * thousand nodes a second.
   *
   * @returns {{input: GainNode, when: number, gain: number, distance: number}|null}
   */
  spatial(x, y, z, opts = {}) {
    const ac = this.ac;
    const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const ref = opts.ref ?? 11;
    const rolloff = opts.rolloff ?? 1.15;
    const vol = (opts.gain ?? 1) / (1 + Math.pow(dist / ref, rolloff));
    if (vol < 0.0016) return null;
    if (this.voices >= MAX_VOICES && vol < 0.06) return null;

    const inv = dist > 1e-4 ? 1 / dist : 0;
    const ux = dx * inv, uy = dy * inv, uz = dz * inv;
    const side = ux * this.rx + uz * this.rz;
    const front = ux * this.fx + uz * this.fz;

    // Pan collapses toward centre as the source gets close — a sound at your
    // feet is not hard left just because it is 20 cm to the left.
    const prox = clamp(dist / 2.4, 0, 1);
    const pan = clamp(side * 0.92 * prox, -1, 1);

    // Air absorption, plus a gentle shelf for anything behind the listener.
    const air = 19000 * Math.exp(-dist / (opts.airRef ?? 46));
    const back = front < 0 ? 0.52 + 0.48 * (1 + front) : 1;
    const cut = clamp(air * back * (opts.tone ?? 1), 260, 20000);

    const input = gain(ac, 1);
    const lp = biquad(ac, 'lowpass', cut, 0.55);
    const g = gain(ac, vol);
    const p = ac.createStereoPanner();
    p.pan.value = pan;

    input.connect(lp);
    lp.connect(g);
    g.connect(p);
    p.connect(this.bus[opts.bus || 'world']);

    // Reverb sends. Wetness rises with distance: close things are dry, far
    // things are mostly room.
    const wet = (opts.send ?? 0.3) * (0.35 + 0.65 * clamp(dist / 28, 0, 1));
    if (wet > 0.004 && this.spaceReady) {
      const s = gain(ac, wet * vol);
      g.connect(s);
      s.connect(this.revSend);
      input._send = s;
    }
    if (opts.far && this.spaceReady) {
      const s = gain(ac, opts.far * vol);
      g.connect(s);
      s.connect(this.farSend);
      input._far = s;
    }

    input._chain = [lp, g, p, input._send, input._far];
    this.voices++;
    return {
      input,
      when: ac.currentTime + (opts.noDelay ? 0 : dist / SPEED_OF_SOUND) + (opts.delay || 0),
      gain: vol,
      distance: dist,
      release: () => this._release(input),
    };
  }

  /** Non-positional voice (UI, the player's own weapon, ambience). */
  local(opts = {}) {
    const ac = this.ac;
    if (this.voices >= MAX_VOICES) return null;
    const input = gain(ac, 1);
    const g = gain(ac, opts.gain ?? 1);
    input.connect(g);
    let panner = null;
    if (opts.pan || opts.panner) {
      panner = ac.createStereoPanner();
      panner.pan.value = clamp(opts.pan || 0, -1, 1);
      g.connect(panner);
      panner.connect(this.bus[opts.bus || 'ui']);
      input._chain = [g, panner];
    } else {
      g.connect(this.bus[opts.bus || 'ui']);
      input._chain = [g];
    }
    const wet = opts.send ?? 0;
    if (wet > 0.004 && this.spaceReady) {
      const s = gain(ac, wet * (opts.gain ?? 1));
      g.connect(s);
      s.connect(this.revSend);
      input._chain.push(s);
    }
    if (opts.far && this.spaceReady) {
      const s = gain(ac, opts.far * (opts.gain ?? 1));
      g.connect(s);
      s.connect(this.farSend);
      input._chain.push(s);
    }
    this.voices++;
    return {
      input, panner, when: ac.currentTime + (opts.delay || 0), gain: opts.gain ?? 1, distance: 0,
      release: () => this._release(input),
    };
  }

  _release(input) {
    this.voices = Math.max(0, this.voices - 1);
    const chain = input._chain;
    try { input.disconnect(); } catch {}
    if (!chain) return;
    for (const n of chain) { if (n) { try { n.disconnect(); } catch {} } }
    input._chain = null;
  }

  setVolume(v) {
    this.out.gain.setTargetAtTime(clamp(v, 0, 1.5), this.ac.currentTime, 0.02);
  }
}

export { SPEED_OF_SOUND };
