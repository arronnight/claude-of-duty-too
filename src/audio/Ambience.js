import { noise, biquad, gain, mulberry32, clamp, lerp } from './Buffers.js';
import { gunshot } from './Guns.js';

/**
 * The ambient bed.
 *
 * A room tone that never changes is worse than silence — the ear locks onto it
 * in about fifteen seconds and it becomes a hiss. So this is four looping
 * layers with independent slow modulation plus a scheduler of one-off distant
 * events, and none of the periods are harmonically related, so the bed never
 * repeats audibly.
 *
 *  - **wind**: brown noise through two bandpasses (hard-panned, different
 *    centre frequencies) whose gain and cutoff are driven by slow LFOs. This
 *    is the gusting.
 *  - **rumble**: the whole district — traffic, generators, distance — as brown
 *    noise below 110 Hz.
 *  - **air**: a very quiet high band, the thing that makes "outdoors" not sound
 *    like a sealed room.
 *  - **events**: distant gunfire, a metal sheet flexing, a dog, a far explosion.
 *    Scheduled on a Poisson-ish timer, and the distant gunfire goes through the
 *    real gunshot synth at 90-160 m so it gets the same crack-boom treatment
 *    the player's own weapon does.
 *
 * Time of day matters: at night the wind drops, the rumble thins out and the
 * event rate halves.
 */

const rnd = mulberry32(0x4A11);

export class Ambience {
  constructor(g) {
    this.g = g;
    this.ac = g.ac;
    this.nodes = [];
    this.started = false;
    this.intensity = 1;       // scaled by time of day
    this.indoor = 0;
    this._eventIn = 4 + rnd() * 6;
    this._t = 0;
  }

  start() {
    if (this.started) return;
    const ac = this.ac;
    const dest = this.g.ambienceBus;
    this.started = true;

    // --- wind: two decorrelated bands, hard panned ---------------------------
    this.windGain = gain(ac, 0);
    this.windGain.connect(dest);
    for (let i = 0; i < 2; i++) {
      const src = ac.createBufferSource();
      src.buffer = noise(ac, 'brown');
      src.loop = true;
      src.playbackRate.value = 0.85 + i * 0.23;
      const bp = biquad(ac, 'bandpass', 260 + i * 430, 0.55);
      const hs = biquad(ac, 'highshelf', 1800, 0.7, -8);
      const pan = ac.createStereoPanner();
      pan.pan.value = i === 0 ? -0.72 : 0.68;
      const lvl = gain(ac, 0.5);
      src.connect(bp); bp.connect(hs); hs.connect(lvl); lvl.connect(pan); pan.connect(this.windGain);

      // Gusting: two LFOs at incommensurate rates, on gain and on cutoff.
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.043 + i * 0.017;
      const lg = gain(ac, 0.34);
      lfo.connect(lg); lg.connect(lvl.gain);
      const lfo2 = ac.createOscillator();
      lfo2.type = 'sine';
      lfo2.frequency.value = 0.081 + i * 0.029;
      const lg2 = gain(ac, 140 + i * 90);
      lfo2.connect(lg2); lg2.connect(bp.frequency);

      src.start();
      lfo.start();
      lfo2.start();
      this.nodes.push(src, bp, hs, pan, lvl, lfo, lg, lfo2, lg2);
    }

    // --- distant rumble ------------------------------------------------------
    this.rumbleGain = gain(ac, 0);
    this.rumbleGain.connect(dest);
    {
      const src = ac.createBufferSource();
      src.buffer = noise(ac, 'brown');
      src.loop = true;
      src.playbackRate.value = 0.61;
      const lp = biquad(ac, 'lowpass', 110, 0.8);
      src.connect(lp); lp.connect(this.rumbleGain);
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.027;
      const lg = gain(ac, 0.30);
      lfo.connect(lg); lg.connect(this.rumbleGain.gain);
      src.start(); lfo.start();
      this.nodes.push(src, lp, lfo, lg);
    }

    // --- high air ------------------------------------------------------------
    this.airGain = gain(ac, 0);
    this.airGain.connect(dest);
    {
      const src = ac.createBufferSource();
      src.buffer = noise(ac, 'pink');
      src.loop = true;
      src.playbackRate.value = 1.13;
      const hp = biquad(ac, 'highpass', 2600, 0.6);
      const lp = biquad(ac, 'lowpass', 9000, 0.6);
      src.connect(hp); hp.connect(lp); lp.connect(this.airGain);
      src.start();
      this.nodes.push(src, hp, lp);
    }

    this.setIntensity(1, 0);
  }

  /**
   * @param {number} v 0..1 overall level (time of day, cutscenes)
   * @param {number} indoor 0..1 how enclosed the listener is — indoors the wind
   *        drops away and the air band closes down, which is most of what makes
   *        walking through a doorway read as walking through a doorway.
   */
  setIntensity(v, indoor = this.indoor, ramp = 1.2) {
    this.intensity = clamp(v, 0, 1.5);
    this.indoor = clamp(indoor, 0, 1);
    if (!this.started) return;
    const t = this.ac.currentTime;
    const out = 1 - this.indoor;
    const set = (node, target) => {
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(node.gain.value, t);
      node.gain.linearRampToValueAtTime(Math.max(0.0001, target), t + ramp);
    };
    set(this.windGain, 0.34 * this.intensity * lerp(0.22, 1, out));
    set(this.rumbleGain, 0.30 * this.intensity * lerp(0.55, 1, out));
    set(this.airGain, 0.055 * this.intensity * lerp(0.15, 1, out));
  }

  /** Called every frame. Schedules the one-off distant events. */
  update(dt, listener) {
    if (!this.started) return;
    this._t += dt;
    this._eventIn -= dt * this.intensity;
    if (this._eventIn > 0) return;
    this._eventIn = 5 + rnd() * 13;

    const r = rnd();
    const lx = listener?.x ?? 0;
    const lz = listener?.z ?? 0;
    const bearing = rnd() * Math.PI * 2;
    const dist = 75 + rnd() * 95;
    const x = lx + Math.cos(bearing) * dist;
    const z = lz + Math.sin(bearing) * dist;

    if (r < 0.46) {
      // A distant burst. Real gunshot synthesis at real distance, so it gets
      // the crack-then-boom separation and the district reverb for free.
      const ids = ['ak74', 'm4', 'dmr', 'mp5'];
      const id = ids[(rnd() * ids.length) | 0];
      const rounds = id === 'dmr' ? 1 : 2 + ((rnd() * 4) | 0);
      const rpm = id === 'mp5' ? 900 : id === 'ak74' ? 660 : 800;
      for (let i = 0; i < rounds; i++) {
        setTimeout(() => gunshot(this.g, id, { x, y: 1.6, z, gain: 0.7 }), i * (60000 / rpm));
      }
    } else if (r < 0.68) {
      this._creak(x, z);
    } else if (r < 0.84) {
      this._dog(x, z);
    } else {
      this._farBlast(x, z);
    }
  }

  /** Corrugated metal flexing in the wind. */
  _creak(x, z) {
    const ac = this.ac;
    const route = this.g.spatial(x * 0.3, 4, z * 0.3, { bus: 'world', gain: 0.5, ref: 22, rolloff: 1.1, send: 0.5 });
    if (!route) return;
    const t = route.when;
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    const f = 90 + rnd() * 140;
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.linearRampToValueAtTime(f * (1.2 + rnd() * 0.5), t + 0.9);
    const bp = biquad(ac, 'bandpass', 780, 7);
    const env = gain(ac, 0);
    osc.connect(bp); bp.connect(env); env.connect(route.input);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.10, t + 0.25);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    osc.start(t); osc.stop(t + 1.2);
    osc.onended = () => { osc.disconnect(); bp.disconnect(); env.disconnect(); route.release(); };
  }

  /** A dog, two streets over. Formant-ish: a filtered pulse train burst. */
  _dog(x, z) {
    const ac = this.ac;
    const route = this.g.spatial(x * 0.5, 0.6, z * 0.5, { bus: 'world', gain: 0.65, ref: 26, rolloff: 1.0, send: 0.75 });
    if (!route) return;
    const barks = 2 + ((rnd() * 3) | 0);
    for (let i = 0; i < barks; i++) {
      const t = route.when + i * (0.28 + rnd() * 0.2);
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      const f = 190 + rnd() * 90;
      osc.frequency.setValueAtTime(f * 1.5, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.7, t + 0.13);
      const bp = biquad(ac, 'bandpass', 900 + rnd() * 400, 2.4);
      const env = gain(ac, 0);
      osc.connect(bp); bp.connect(env); env.connect(route.input);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.start(t); osc.stop(t + 0.2);
      osc.onended = () => { osc.disconnect(); bp.disconnect(); env.disconnect(); };
    }
    setTimeout(route.release, 3000);
  }

  /** Something heavy going off a long way away. Pressure, no detail. */
  _farBlast(x, z) {
    const ac = this.ac;
    const route = this.g.spatial(x, 2, z, { bus: 'world', gain: 3.0, ref: 60, rolloff: 0.6, airRef: 200, tone: 0.25, send: 0.3, far: 1.1 });
    if (!route) return;
    const t = route.when;
    const src = ac.createBufferSource();
    src.buffer = noise(ac, 'brown');
    src.loop = true;
    src.playbackRate.value = 0.7;
    const lp = biquad(ac, 'lowpass', 190, 1.0);
    const env = gain(ac, 0);
    src.connect(lp); lp.connect(env); env.connect(route.input);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.9, t + 0.035);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    src.start(t, rnd() * 1.2);
    src.stop(t + 1.4);
    src.onended = () => { src.disconnect(); lp.disconnect(); env.disconnect(); route.release(); };
  }

  stop() {
    for (const n of this.nodes) {
      try { n.stop?.(); } catch {}
      try { n.disconnect(); } catch {}
    }
    this.nodes.length = 0;
    this.started = false;
  }
}
