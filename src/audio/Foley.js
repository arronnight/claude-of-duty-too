import { noiseSource, biquad, gain, hit, sweep, fire, mulberry32, clamp } from './Buffers.js';
import { scheduleRelease, signature, action } from './Guns.js';

/**
 * Everything that is not a gunshot: footsteps, impacts, ricochets, shell
 * casings, bullets going past your ear, and the reload mechanism.
 *
 * All of it is surface-driven. `ctx.physics.raycast` hands back a material key
 * from the level, the same key `ctx.materials.get()` uses, so the audio and the
 * visuals are guaranteed to agree about what was hit — footsteps on the cobbles
 * sound like cobbles because both systems are reading the same string.
 *
 * Surfaces are resolved to one of nine families by substring, so a key nobody
 * anticipated (`asphalt_worn`, `concrete_floor`, `metal_corrugated`) lands
 * somewhere sensible instead of falling through to a default click.
 */

const rnd = mulberry32(0x51EA);

/**
 * Per-family voicing.
 *   thud   — the low body of a foot or a bullet arriving
 *   mid    — the main mid-band character
 *   click  — the high transient; how "hard" the surface is
 *   grains — a scatter of loose particles (gravel, rubble, glass)
 *   ring   — a resonant partial (metal, wood, tile)
 */
const FAMILY = {
  concrete: { thud: [95, 0.055, 0.55], mid: [1250, 1.1, 0.035, 0.55], click: [5200, 0.006, 0.30], grains: 0, ring: 0, damp: 1 },
  asphalt: { thud: [80, 0.065, 0.60], mid: [820, 0.9, 0.045, 0.50], click: [3800, 0.008, 0.18], grains: 0, ring: 0, damp: 0.9 },
  gravel: { thud: [110, 0.040, 0.40], mid: [1500, 0.9, 0.030, 0.38], click: [6200, 0.005, 0.28], grains: 7, grainF: 4200, ring: 0, damp: 1.05 },
  dirt: { thud: [72, 0.075, 0.55], mid: [430, 0.8, 0.055, 0.42], click: [2200, 0.010, 0.08], grains: 3, grainF: 2400, ring: 0, damp: 0.75 },
  sand: { thud: [64, 0.085, 0.42], mid: [300, 0.7, 0.070, 0.34], click: [1600, 0.014, 0.05], grains: 4, grainF: 1800, ring: 0, damp: 0.58 },
  wood: { thud: [130, 0.050, 0.50], mid: [560, 1.4, 0.048, 0.60], click: [3400, 0.007, 0.24], grains: 0, ring: [340, 14, 0.13, 0.34], damp: 1.15 },
  metal: { thud: [150, 0.035, 0.40], mid: [1800, 1.6, 0.030, 0.62], click: [7400, 0.005, 0.40], grains: 0, ring: [1240, 30, 0.34, 0.55], damp: 1.45 },
  glass: { thud: [220, 0.020, 0.16], mid: [4200, 2.0, 0.022, 0.42], click: [9000, 0.004, 0.42], grains: 9, grainF: 7200, ring: [3300, 34, 0.20, 0.30], damp: 1.2 },
  rubble: { thud: [88, 0.060, 0.52], mid: [980, 0.9, 0.042, 0.45], click: [4600, 0.006, 0.26], grains: 6, grainF: 2900, ring: [900, 12, 0.09, 0.18], damp: 0.85 },
  fabric: { thud: [70, 0.055, 0.28], mid: [520, 0.6, 0.060, 0.26], click: [2600, 0.016, 0.06], grains: 0, ring: 0, damp: 0.4 },
  flesh: { thud: [58, 0.070, 0.62], mid: [340, 0.5, 0.075, 0.46], click: [1300, 0.020, 0.05], grains: 0, ring: 0, damp: 0.3 },
  water: { thud: [66, 0.060, 0.30], mid: [900, 0.5, 0.090, 0.40], click: [3000, 0.030, 0.14], grains: 5, grainF: 2600, ring: 0, damp: 0.5 },
};

/** Material key -> family. Order matters; first hit wins. */
const KEYMAP = [
  ['flesh', 'flesh'], ['blood', 'flesh'], ['body', 'flesh'], ['bot', 'flesh'],
  ['glass', 'glass'],
  ['sandbag', 'fabric'], ['canvas', 'fabric'], ['fabric', 'fabric'], ['foliage', 'fabric'], ['tarp', 'fabric'],
  ['sand', 'sand'],
  ['gravel', 'gravel'],
  ['dirt', 'dirt'], ['mud', 'dirt'], ['bark', 'wood'],
  ['rubble', 'rubble'], ['tile', 'rubble'], ['brick', 'rubble'], ['debris', 'rubble'],
  ['wood', 'wood'], ['plywood', 'wood'], ['plank', 'wood'],
  ['metal', 'metal'], ['steel', 'metal'], ['gun', 'metal'], ['corrugated', 'metal'], ['rubber', 'fabric'],
  ['asphalt', 'asphalt'], ['tarmac', 'asphalt'],
  ['water', 'water'], ['puddle', 'water'],
  ['concrete', 'concrete'], ['plaster', 'concrete'], ['stucco', 'concrete'], ['cobble', 'concrete'], ['stone', 'concrete'],
];

export function familyOf(key) {
  if (!key) return 'concrete';
  const s = String(key).toLowerCase();
  for (const [needle, fam] of KEYMAP) if (s.includes(needle)) return fam;
  return 'concrete';
}

/** Builds the shared thud/mid/click/grain/ring body used by steps and impacts. */
function surfaceBody(g, ac, dest, t, fam, o) {
  const f = FAMILY[fam] || FAMILY.concrete;
  const hard = o.hard ?? 1;      // 0 soft footfall .. 1.6 bullet impact
  const bright = o.bright ?? 1;
  // `damp` is how much energy the surface gives back. Sand swallows a boot;
  // corrugated metal returns more than you put in. Measured across the family
  // table, without it every surface came out within 2 dB of every other and
  // the whole point of having nine of them was lost.
  const level = (o.level ?? 1) * f.damp;

  // thud
  if (f.thud[2] * level > 0.02) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    const f0 = f.thud[0] * (0.9 + rnd() * 0.2) * (0.8 + hard * 0.35);
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.52, t + f.thud[1]);
    const env = gain(ac, 0);
    osc.connect(env); env.connect(dest);
    hit(env.gain, t, f.thud[2] * level, 0.0015, f.thud[1] * (0.7 + hard * 0.4));
    osc.start(t); osc.stop(t + f.thud[1] * 2 + 0.03);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
  }

  // mid band
  {
    const src = noiseSource(ac, hard > 0.9 ? 'white' : 'pink', 1, rnd);
    const bp = biquad(ac, 'bandpass', f.mid[0] * (0.88 + rnd() * 0.24) * (0.85 + bright * 0.2), f.mid[1]);
    const env = gain(ac, 0);
    src.connect(bp); bp.connect(env); env.connect(dest);
    const d = f.mid[2] * (0.7 + hard * 0.5);
    hit(env.gain, t, f.mid[3] * level * hard, 0.0009, d);
    fire(src, t, d + 0.02, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });
  }

  // high click
  if (f.click[2] * bright * level > 0.015) {
    const src = noiseSource(ac, 'white', 1, rnd);
    const hp = biquad(ac, 'highpass', f.click[0] * (0.9 + rnd() * 0.2), 0.8);
    const env = gain(ac, 0);
    src.connect(hp); hp.connect(env); env.connect(dest);
    hit(env.gain, t, f.click[2] * bright * level * hard, 0.0005, f.click[1] * (0.6 + hard * 0.6));
    fire(src, t, f.click[1] + 0.02, () => { src.disconnect(); hp.disconnect(); env.disconnect(); });
  }

  // loose grains
  const grains = Math.round((f.grains || 0) * (0.5 + hard * 0.7));
  for (let i = 0; i < grains; i++) {
    const gt = t + 0.004 + rnd() * (0.055 + hard * 0.09);
    const src = noiseSource(ac, 'white', 1, rnd);
    const bp = biquad(ac, 'bandpass', f.grainF * (0.55 + rnd() * 0.9), 6 + rnd() * 12);
    const env = gain(ac, 0);
    src.connect(bp); bp.connect(env); env.connect(dest);
    hit(env.gain, gt, (0.07 + rnd() * 0.11) * level * hard, 0.0004, 0.006 + rnd() * 0.018);
    fire(src, gt, 0.04, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });
  }

  // resonant ring
  if (f.ring) {
    const src = noiseSource(ac, 'white', 1, rnd);
    const bp = biquad(ac, 'bandpass', f.ring[0] * (0.95 + rnd() * 0.1), f.ring[1]);
    const env = gain(ac, 0);
    src.connect(bp); bp.connect(env); env.connect(dest);
    hit(env.gain, t + 0.001, f.ring[3] * level * hard, 0.001, f.ring[2] * (0.6 + hard * 0.6));
    fire(src, t, f.ring[2] + 0.05, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });
  }

  return f;
}

// --- footsteps --------------------------------------------------------------

/**
 * A footstep is a heel and a toe, 25-45 ms apart, plus gear. Playing one
 * transient per step is the single most obvious tell in an amateur mix; the
 * double-tap is most of what makes a footfall sound like a person.
 */
export function footstep(g, o = {}) {
  const ac = g.ac;
  const fam = familyOf(o.surface);
  const stance = o.stance || 'stand';
  const speed = clamp(o.speed ?? 3, 0, 9);
  const sprint = !!o.sprinting;

  const stanceMul = stance === 'crouch' ? 0.42 : stance === 'prone' ? 0.22 : 1;
  const level = (o.volume ?? 1) * stanceMul * (0.55 + clamp(speed / 6, 0, 1) * 0.6);
  if (level < 0.02) return;

  const route = o.local
    ? g.local({ bus: 'foley', gain: level * 0.85, send: 0.16, panner: true, pan: o.foot === 1 ? 0.16 : -0.16 })
    : g.spatial(o.x || 0, o.y || 0, o.z || 0, { bus: 'foley', gain: level * 2.4, ref: 6, rolloff: 1.5, airRef: 24, send: 0.30 });
  if (!route) return;

  const t = route.when;
  const bright = sprint ? 1.25 : stance === 'prone' ? 0.55 : 1;
  const hard = clamp(0.35 + speed / 7 + (sprint ? 0.2 : 0), 0.25, 1.25) * stanceMul;

  surfaceBody(g, ac, route.input, t, fam, { hard, bright, level: 1 });
  // Toe, quieter and later; the gap shortens as you run.
  const gap = clamp(0.048 - speed * 0.0035, 0.014, 0.05) * (1 + rnd() * 0.3);
  surfaceBody(g, ac, route.input, t + gap, fam, { hard: hard * 0.55, bright: bright * 0.9, level: 0.55 });

  // Gear: webbing, sling swivel, magazines in pouches. Only when moving fast.
  if (speed > 2.2 && stance !== 'prone') gearRustle(g, ac, route.input, t + 0.012, clamp(speed / 7, 0.2, 1) * stanceMul);

  scheduleRelease(ac, route, 0.9);
}

/** Cloth and webbing. Filtered pink noise with a fast, soft envelope. */
export function gearRustle(g, ac, dest, t, level = 1) {
  const src = noiseSource(ac, 'pink', 1, rnd);
  const bp = biquad(ac, 'bandpass', 2400 + rnd() * 1600, 0.7);
  const env = gain(ac, 0);
  src.connect(bp); bp.connect(env); env.connect(dest);
  hit(env.gain, t, 0.09 * level, 0.010, 0.075);
  fire(src, t, 0.12, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });

  // One metallic tick from a sling swivel or a mag catch, most steps.
  if (rnd() < 0.55) {
    const s2 = noiseSource(ac, 'white', 1, rnd);
    const bq = biquad(ac, 'bandpass', 3600 + rnd() * 2600, 22);
    const e2 = gain(ac, 0);
    s2.connect(bq); bq.connect(e2); e2.connect(dest);
    hit(e2.gain, t + 0.01 + rnd() * 0.03, 0.045 * level, 0.0006, 0.05);
    fire(s2, t, 0.12, () => { s2.disconnect(); bq.disconnect(); e2.disconnect(); });
  }
}

/** Landing from a fall: a big soft thud plus everything on the body rattling. */
export function land(g, o = {}) {
  const ac = g.ac;
  const impact = clamp(o.impact ?? 4, 0, 14);
  const level = clamp(0.25 + impact / 9, 0.2, 1.3);
  const route = o.local
    ? g.local({ bus: 'foley', gain: level, send: 0.2 })
    : g.spatial(o.x || 0, o.y || 0, o.z || 0, { bus: 'foley', gain: level * 2.2, ref: 8, rolloff: 1.4, send: 0.3 });
  if (!route) return;
  surfaceBody(g, ac, route.input, route.when, familyOf(o.surface), { hard: 1.15, bright: 0.9, level: level * 1.3 });
  gearRustle(g, ac, route.input, route.when + 0.008, level * 1.6);
  scheduleRelease(ac, route, 1.0);
}

// --- bullet impacts ---------------------------------------------------------

/**
 * A bullet hitting something is the surface body driven much harder, plus two
 * things unique to impacts: a supersonic slap that is the same on every
 * surface, and — on hard surfaces at a shallow angle — a ricochet whine.
 */
export function impact(g, o = {}) {
  const ac = g.ac;
  const fam = familyOf(o.surface);
  const energy = clamp(o.energy ?? 1, 0.15, 2);
  const route = g.spatial(o.x || 0, o.y || 1, o.z || 0, {
    bus: 'world', gain: 1.5 * energy, ref: 9, rolloff: 1.35, airRef: 40, send: 0.34,
  });
  if (!route) return;
  const t = route.when;

  // The slap of the projectile arriving, before the surface responds.
  {
    const src = noiseSource(ac, 'white', 1, rnd);
    const bp = biquad(ac, 'bandpass', 2600 + rnd() * 900, 0.9);
    const env = gain(ac, 0);
    src.connect(bp); bp.connect(env); env.connect(route.input);
    hit(env.gain, t, 0.55 * energy, 0.0004, 0.012);
    fire(src, t, 0.03, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });
  }

  surfaceBody(g, ac, route.input, t + 0.0015, fam, { hard: 1.45 * energy, bright: 1.15, level: energy });

  // Ricochet: a descending, warbling whine off hard surfaces.
  const ricoChance = fam === 'metal' ? 0.55 : fam === 'concrete' || fam === 'rubble' ? 0.28 : 0;
  if (rnd() < ricoChance) ricochet(g, ac, route.input, t + 0.006, energy);

  scheduleRelease(ac, route, 1.4);
}

export function ricochet(g, ac, dest, t, energy = 1) {
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  const f0 = 1600 + rnd() * 1800;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f0 * (0.24 + rnd() * 0.2), t + 0.32);
  // Warble: a small LFO on the pitch is what makes it read as a spinning
  // fragment rather than a synth sweep.
  const lfo = ac.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 18 + rnd() * 22;
  const lfoGain = gain(ac, f0 * 0.045);
  lfo.connect(lfoGain); lfoGain.connect(osc.frequency);

  const bp = biquad(ac, 'bandpass', 2200, 3.2);
  const env = gain(ac, 0);
  osc.connect(bp); bp.connect(env); env.connect(dest);
  hit(env.gain, t, 0.22 * energy, 0.004, 0.30);
  osc.start(t); lfo.start(t);
  osc.stop(t + 0.42); lfo.stop(t + 0.42);
  osc.onended = () => { osc.disconnect(); lfo.disconnect(); lfoGain.disconnect(); bp.disconnect(); env.disconnect(); };
}

/**
 * Bullet passing close by. Two parts: the crack of the shockwave and a very
 * short Doppler-swept hiss that sweeps across the stereo field. It has to be
 * fast — a whizz-by you can follow with your ear is too slow to be a bullet.
 */
export function whizz(g, o = {}) {
  const ac = g.ac;
  const miss = clamp(o.distance ?? 1.5, 0.2, 8);
  const level = clamp(1 - miss / 8, 0.1, 1);
  const side = o.side ?? (rnd() < 0.5 ? -1 : 1);
  const route = g.local({ bus: 'world', gain: level * 1.5, send: 0.18, panner: true, pan: side * 0.85 });
  if (!route) return;
  const t = route.when;
  const dur = 0.085 + miss * 0.012;

  if (route.panner) {
    route.panner.pan.setValueAtTime(side * 0.9, t);
    route.panner.pan.linearRampToValueAtTime(-side * 0.7, t + dur);
  }

  const src = noiseSource(ac, 'white', 1, rnd);
  const bp = biquad(ac, 'bandpass', 2400, 2.6);
  const env = gain(ac, 0);
  sweep(bp.frequency, t, 2600 + rnd() * 900, 780, dur);
  src.connect(bp); bp.connect(env); env.connect(route.input);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(1, t + dur * 0.35);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  fire(src, t, dur + 0.02, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });

  // The snap of the shockwave itself, right at closest approach.
  const snap = noiseSource(ac, 'white', 1, rnd);
  const hp = biquad(ac, 'highpass', 1800, 0.7);
  const senv = gain(ac, 0);
  snap.connect(hp); hp.connect(senv); senv.connect(route.input);
  hit(senv.gain, t + dur * 0.34, 0.6 * level, 0.0004, 0.010);
  fire(snap, t, dur + 0.04, () => { snap.disconnect(); hp.disconnect(); senv.disconnect(); });

  scheduleRelease(ac, route, 0.6);
}

/**
 * Shell casing. Three or four bounces with the interval and the level both
 * decaying, each one a bandpassed tick plus a high-Q brass ring at a slightly
 * different pitch. The pitch jitter between casings matters more than the
 * sound of any one of them.
 */
export function shell(g, o = {}) {
  const ac = g.ac;
  const caliber = o.caliber ?? 'rifle';
  const baseF = caliber === 'pistol' ? 4200 : caliber === 'shotgun' ? 1500 : 5200;
  const pitch = 0.82 + rnd() * 0.42;
  const route = o.local
    ? g.local({ bus: 'foley', gain: 1.35, send: 0.26, panner: true, pan: (o.pan ?? 0.35) })
    : g.spatial(o.x || 0, o.y || 0, o.z || 0, { bus: 'foley', gain: 2.6, ref: 5, rolloff: 1.6, send: 0.35 });
  if (!route) return;

  const bounces = caliber === 'shotgun' ? 2 : 3 + (rnd() < 0.5 ? 1 : 0);
  let t = route.when + 0.28 + rnd() * 0.16;   // time to fall to the ground
  let amp = 1;
  let gap = 0.10 + rnd() * 0.06;
  for (let i = 0; i < bounces; i++) {
    const f = baseF * pitch * (0.9 + rnd() * 0.22);
    const src = noiseSource(ac, 'white', 1, rnd);
    const bq = biquad(ac, 'bandpass', f, 3.5);
    const env = gain(ac, 0);
    src.connect(bq); bq.connect(env); env.connect(route.input);
    hit(env.gain, t, 0.30 * amp, 0.0004, 0.012 + rnd() * 0.01);
    fire(src, t, 0.05, () => { src.disconnect(); bq.disconnect(); env.disconnect(); });

    // Brass rings; that ring is the whole character of the sound.
    const rsrc = noiseSource(ac, 'white', 1, rnd);
    const rq = biquad(ac, 'bandpass', f * (1.5 + rnd() * 0.4), 40);
    const renv = gain(ac, 0);
    rsrc.connect(rq); rq.connect(renv); renv.connect(route.input);
    hit(renv.gain, t + 0.0008, 0.26 * amp, 0.0006, 0.06 + rnd() * 0.05);
    fire(rsrc, t, 0.14, () => { rsrc.disconnect(); rq.disconnect(); renv.disconnect(); });

    t += gap;
    gap *= 0.58;
    amp *= 0.46;
  }
  scheduleRelease(ac, route, (t - route.when) + 1.2);
}

// --- reload -----------------------------------------------------------------

/**
 * Reload stages. The weapons agent emits `weapon:reload` with a stage name and
 * this maps whatever it calls them onto the mechanical events. Substring
 * matching, because "magOut" / "mag_out" / "mag-out" are all going to happen.
 */
export function reload(g, stage, weaponId, o = {}) {
  const ac = g.ac;
  const sig = signature(weaponId);
  const s = String(stage || '').toLowerCase();
  const route = o.local === false
    ? g.spatial(o.x || 0, o.y || 1.2, o.z || 0, { bus: 'foley', gain: 1.6, ref: 6, rolloff: 1.5, send: 0.3 })
    : g.local({ bus: 'foley', gain: 0.8, send: 0.22, panner: true, pan: 0.12 });
  if (!route) return;
  const t = route.when;
  const dest = route.input;
  let life = 0.6;

  const click = (at, f, q, level, decay) => {
    const src = noiseSource(ac, 'white', 1, rnd);
    const bq = biquad(ac, 'bandpass', f, q);
    const env = gain(ac, 0);
    src.connect(bq); bq.connect(env); env.connect(dest);
    hit(env.gain, at, level, 0.0005, decay);
    fire(src, at, decay + 0.03, () => { src.disconnect(); bq.disconnect(); env.disconnect(); });
  };
  const thunk = (at, f0, level, decay) => {
    const osc = ac.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f0, at);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.55, at + decay);
    const env = gain(ac, 0);
    osc.connect(env); env.connect(dest);
    hit(env.gain, at, level, 0.0012, decay);
    osc.start(at); osc.stop(at + decay + 0.04);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
  };

  if (s.includes('release') || s === 'drop' || s.includes('catch')) {
    // Mag catch: a small, very hard button click.
    click(t, 3200, 9, 1.15, 0.016);
    click(t + 0.004, 6400, 14, 0.55, 0.010);
    click(t + 0.001, 1250, 4, 0.55, 0.022);
  } else if (s.includes('out') || s.includes('remove')) {
    // Polymer scraping out of the well, then the loose rounds rattling.
    const src = noiseSource(ac, 'pink', 1, rnd);
    const bp = biquad(ac, 'bandpass', 1500, 1.2);
    const env = gain(ac, 0);
    sweep(bp.frequency, t, 2100, 900, 0.13);
    src.connect(bp); bp.connect(env); env.connect(dest);
    hit(env.gain, t, 0.62, 0.006, 0.14);
    fire(src, t, 0.18, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });
    for (let i = 0; i < 3; i++) click(t + 0.05 + rnd() * 0.12, 2400 + rnd() * 2200, 16, 0.22, 0.02);
    life = 0.5;
  } else if (s.includes('in') || s.includes('insert') || s.includes('new')) {
    // The hand arrives before the magazine does, so the cloth leads the thunk.
    gearRustle(g, ac, dest, t, 0.7);
    thunk(t + 0.045, 210, 0.44, 0.055);
    click(t + 0.051, 1800, 5, 0.30, 0.03);
  } else if (s.includes('seat') || s.includes('slap') || s.includes('home')) {
    thunk(t, 165, 0.62, 0.075);
    click(t + 0.003, 1300, 3.5, 0.40, 0.045);
    click(t + 0.012, 4200, 12, 0.16, 0.02);
  } else if (s.includes('bolt') || s.includes('charge') || s.includes('slide') || s.includes('pump')) {
    // Two events: the carrier pulled back, then released to slam home.
    action(g, ac, dest, t, sig, 0.85);
    action(g, ac, dest, t + 0.115, sig, 1.15);
    thunk(t + 0.118, 190, 0.42, 0.05);
    life = 0.5;
  } else if (s.includes('lower') || s.includes('start') || s.includes('raise') || s.includes('end')) {
    gearRustle(g, ac, dest, t, 1.0);
    if (s.includes('raise') || s.includes('end')) click(t + 0.09, 2600, 8, 0.12, 0.02);
    life = 0.4;
  } else {
    // Unknown stage: a neutral mechanical tick is better than silence, and it
    // means a weapons agent that invents a stage name still gets feedback.
    click(t, 2600, 7, 0.22, 0.02);
    life = 0.3;
  }

  scheduleRelease(ac, route, life);
}

// --- misc -------------------------------------------------------------------

/** Player took a hit: a dull body thump plus a short pained breath of noise. */
export function playerHurt(g, amount = 20) {
  const ac = g.ac;
  const level = clamp(0.3 + amount / 60, 0.25, 1);
  const route = g.local({ bus: 'foley', gain: level * 2.6, send: 0.1 });
  if (!route) return;
  const t = route.when;
  surfaceBody(g, ac, route.input, t, 'flesh', { hard: 1.2, bright: 0.7, level: level * 1.4 });
  const src = noiseSource(ac, 'pink', 1, rnd);
  const bp = biquad(ac, 'bandpass', 620, 1.5);
  const env = gain(ac, 0);
  sweep(bp.frequency, t, 900, 380, 0.32);
  src.connect(bp); bp.connect(env); env.connect(route.input);
  hit(env.gain, t + 0.03, 0.16 * level, 0.03, 0.34);
  fire(src, t, 0.42, () => { src.disconnect(); bp.disconnect(); env.disconnect(); });
  scheduleRelease(ac, route, 1.0);
}

/** Explosion: not a gunshot, a pressure event. Feeds the muffle sweep. */
export function explosion(g, o = {}) {
  const ac = g.ac;
  const radius = o.radius ?? 8;
  const route = g.spatial(o.x || 0, o.y || 1, o.z || 0, {
    bus: 'world', gain: 3.2, ref: 40, rolloff: 0.8, airRef: 140, send: 0.6, far: 0.9,
  });
  if (!route) return;
  const t = route.when;
  const dest = route.input;

  // Blast: broadband, driven, long.
  const src = noiseSource(ac, 'white', 1, rnd);
  const lp = biquad(ac, 'lowpass', 3400, 0.7);
  const env = gain(ac, 0);
  sweep(lp.frequency, t, 3600, 260, 0.9);
  src.connect(lp); lp.connect(env); env.connect(dest);
  hit(env.gain, t, 1.0, 0.002, 0.85);
  fire(src, t, 1.1, () => { src.disconnect(); lp.disconnect(); env.disconnect(); });

  // Sub-bass punch.
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(74, t);
  osc.frequency.exponentialRampToValueAtTime(26, t + 0.55);
  const oe = gain(ac, 0);
  osc.connect(oe); oe.connect(dest);
  hit(oe.gain, t, 0.95, 0.004, 0.62);
  osc.start(t); osc.stop(t + 0.9);
  osc.onended = () => { osc.disconnect(); oe.disconnect(); };

  // Debris raining down afterwards.
  const n = 14;
  for (let i = 0; i < n; i++) {
    const dt = 0.18 + rnd() * 1.5;
    const src2 = noiseSource(ac, 'white', 1, rnd);
    const bq = biquad(ac, 'bandpass', 900 + rnd() * 4200, 5 + rnd() * 15);
    const e2 = gain(ac, 0);
    src2.connect(bq); bq.connect(e2); e2.connect(dest);
    hit(e2.gain, t + dt, 0.05 + rnd() * 0.08, 0.0005, 0.02 + rnd() * 0.05);
    fire(src2, t + dt, 0.09, () => { src2.disconnect(); bq.disconnect(); e2.disconnect(); });
  }

  scheduleRelease(ac, route, 3.6);
  g.duck(0.85, 0.4, 1.6);

  // Only muffle if it went off near the listener.
  const d = route.distance;
  const near = clamp(1 - d / (radius * 2.4), 0, 1);
  if (near > 0.08) setTimeout(() => g.muffleSweep(near, 2.2 + near * 1.4), Math.max(0, (t - ac.currentTime) * 1000));
}

export { FAMILY };
