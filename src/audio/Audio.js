import * as THREE from 'three';
import { AudioGraph } from './Graph.js';
import { gunshot, signature, SIGNATURES } from './Guns.js';
import * as Foley from './Foley.js';
import { Ambience } from './Ambience.js';
import { clamp } from './Buffers.js';

/**
 * The audio system.
 *
 * Everything is synthesised — there is not a single sample file in the build,
 * which is a hard constraint of the project and also the reason the whole thing
 * is about 40 kB of code instead of 200 MB of assets.
 *
 * ## The gesture problem
 *
 * A browser will not let a page make sound before the user interacts with it,
 * and constructing an `AudioContext` early gets you a console warning and a
 * context stuck in `suspended`. So nothing is built at `init()` — no context,
 * no buffers, no impulse responses. The first pointer or key event, or an
 * explicit `ctx.audio.unlock()`, builds the whole graph. Everything published
 * on `ctx.audio` is safe to call before that and does nothing.
 *
 * This also means the screenshot harness — which never clicks — runs completely
 * silently with no context created and no warnings in the console.
 *
 * ## Space
 *
 * The listener's acoustic space is probed from the world itself rather than
 * from hand-authored trigger volumes: one ray up and eight around, four times a
 * second, through the same BVH the bullets use. A ceiling overhead plus walls
 * all round is an interior; a ceiling with open ends is an underpass; no
 * ceiling is the street. The three impulse responses are crossfaded on those
 * weights, so walking into a doorway audibly closes the space down and no level
 * data is needed for it to work.
 */

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const RING = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  RING.push([Math.cos(a), Math.sin(a)]);
}

// --- sound id normalisation --------------------------------------------------
//
// The dispatcher's scheme is `family:variant`. Nothing outside this directory
// used it: fx spells impacts `impact_concrete`, shells `shell_tick` and
// hitmarkers `hitmarker`; ai asks for `rifle` and `body_fall`. All of those
// fell through to `default:` and returned `undefined` — silently, because
// every call site is optional-chained. Accepting `_` as a separator when the
// leading token names a real family, plus a small table for the bare nouns,
// makes both spellings valid rather than making eight callers agree on one.

const FAMILIES = new Set([
  'shot', 'gun', 'fire', 'step', 'footstep', 'impact', 'hit', 'shell', 'casing',
  'reload', 'whizz', 'snap', 'explosion', 'boom', 'land', 'body', 'gear', 'cloth',
  'hurt', 'ui', 'blip',
]);

const ID_ALIAS = {
  rifle: 'shot:m4', carbine: 'shot:m4', ak: 'shot:ak74', assault: 'shot:m4',
  smg: 'shot:mp5', pistol: 'shot:deagle', shotgun: 'shot:m870', sniper: 'shot:dmr',
  bodyfall: 'body:fall', body_fall: 'body:fall', corpse: 'body:fall',
  hitmarker: 'ui:blip', hitmarker_kill: 'ui:kill', hitmarkerkill: 'ui:kill',
  ricochet: 'impact:metal', bullet_whizz: 'whizz', bullethit: 'impact',
  brass: 'shell', casing_bounce: 'shell',
};

/** `impact_concrete` -> `impact:concrete`, `rifle` -> `shot:m4`, `shot:m4` -> itself. */
export function normaliseSoundId(id) {
  const s = String(id || '').toLowerCase();
  const alias = ID_ALIAS[s];
  if (alias) return alias;
  if (s.includes(':')) return s;
  const u = s.indexOf('_');
  if (u > 0 && FAMILIES.has(s.slice(0, u))) return `${s.slice(0, u)}:${s.slice(u + 1)}`;
  return s;
}

export class AudioSystem {
  constructor() {
    this.ac = null;
    this.graph = null;
    this.ambience = null;
    this.enabled = true;
    this.volume = 0.85;
    this.unlocking = null;
    this._probeAcc = 9;
    this._space = { street: 1, interior: 0, underpass: 0 };
    this._pendingIR = true;
    this._lastFire = 0;
  }

  async init(ctx) {
    this.ctx = ctx;

    ctx.audio = {
      unlock: () => this.unlock(),
      get ready() { return !!this.__sys.ac && this.__sys.ac.state === 'running'; },
      __sys: this,
      play: (id, opts) => this.play(id, opts),
      playAt: (id, worldPos, opts) => this.playAt(id, worldPos, opts),
      setListener: (camera) => { this._listenerSource = camera; },
      music: () => { /* no music track in this build; the ambient bed is the score */ },
      setVolume: (v) => { this.volume = clamp(v, 0, 1.5); this.graph?.setVolume(this.volume); },
      setAmbience: (v) => this.ambience?.setIntensity(v),
      duck: (amount, hold, release) => this.graph?.duck(amount, hold, release),
      muffle: (strength, seconds) => this.graph?.muffleSweep(strength, seconds),
      // Direct handles, so weapons/fx can drive the layered synths precisely
      // rather than through a string id when they have the data to hand.
      gunshot: (weaponId, opts) => this.graph && gunshot(this.graph, weaponId, opts),
      footstep: (opts) => this.graph && Foley.footstep(this.graph, opts),
      impact: (opts) => this.graph && Foley.impact(this.graph, opts),
      whizz: (opts) => this.graph && Foley.whizz(this.graph, opts),
      shell: (opts) => this.graph && Foley.shell(this.graph, opts),
      reload: (stage, weaponId, opts) => this.graph && Foley.reload(this.graph, stage, weaponId, opts),
      explosion: (opts) => this.graph && Foley.explosion(this.graph, opts),
      weapons: Object.keys(SIGNATURES),
      info: () => this.info(),
    };

    this._bindGesture();
    this._bindBus(ctx);
    this._bindAutomation();
  }

  // --- unlocking ------------------------------------------------------------

  _bindGesture() {
    const go = () => this.unlock();
    this._gestureOff = () => {
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('keydown', go, true);
      window.removeEventListener('touchstart', go, true);
    };
    window.addEventListener('pointerdown', go, true);
    window.addEventListener('keydown', go, true);
    window.addEventListener('touchstart', go, true);
    this.ctx.bus.on('input:lock', (v) => { if (v) this.unlock(); });
  }

  /**
   * Builds the context and the whole graph. Idempotent, and safe to call from
   * anywhere including before a gesture (in which case the context is created
   * suspended and resumes when one arrives).
   */
  unlock() {
    if (this.unlocking) return this.unlocking;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return (this.unlocking = Promise.resolve(false));

    this.unlocking = (async () => {
      try {
        const ac = this.ac = new AC({ latencyHint: 'interactive' });
        this.graph = new AudioGraph(ac);
        this.graph.setVolume(this.volume);
        this.ambience = new Ambience(this.graph);
        if (ac.state === 'suspended') await ac.resume().catch(() => {});
        this._gestureOff?.();
        this._gestureOff = null;
        this.ctx.bus.emit('audio:ready', ac);
        return true;
      } catch (e) {
        this.ac = null;
        this.graph = null;
        return false;
      }
    })();
    return this.unlocking;
  }

  // --- bus ------------------------------------------------------------------

  _bindBus(ctx) {
    const bus = ctx.bus;

    bus.on('weapon:fired', (e) => {
      if (!this.graph) return;
      const id = e?.weapon?.id || e?.weapon || e?.id || ctx.weapons?.current?.id || 'm4';
      const muzzle = e?.muzzle;
      const local = e?.local !== false && !e?.bot;
      if (local) {
        gunshot(this.graph, id, { local: true, suppressed: !!e?.suppressed, indoors: this._space.interior > 0.4 });
        Foley.shell(this.graph, {
          local: true, pan: 0.4,
          caliber: id === 'deagle' ? 'pistol' : id === 'm870' ? 'shotgun' : 'rifle',
        });
      } else {
        const p = muzzle?.position || muzzle || e?.position || e?.pos;
        gunshot(this.graph, id, { x: p?.x ?? 0, y: p?.y ?? 1.5, z: p?.z ?? 0, suppressed: !!e?.suppressed });
      }
    });

    bus.on('weapon:reload', (e) => {
      if (!this.graph) return;
      Foley.reload(this.graph, e?.stage, e?.weapon?.id || e?.weapon || ctx.weapons?.current?.id);
    });

    bus.on('weapon:switch', () => {
      if (this.graph) Foley.reload(this.graph, 'raise', ctx.weapons?.current?.id);
    });

    bus.on('player:footstep', (e) => {
      if (!this.graph) return;
      Foley.footstep(this.graph, {
        local: true, surface: e?.surface, foot: e?.foot,
        speed: e?.speed, stance: e?.stance, sprinting: e?.sprinting, volume: e?.volume,
      });
    });

    bus.on('player:land', (e) => {
      if (this.graph) Foley.land(this.graph, { local: true, impact: e?.impact, surface: e?.surface });
    });

    bus.on('player:jump', () => {
      if (this.graph) Foley.gearRustle(this.graph, this.ac, this.graph.bus.foley, this.ac.currentTime, 0.9);
    });

    bus.on('player:damaged', (e) => {
      if (this.graph) Foley.playerHurt(this.graph, e?.amount);
    });

    bus.on('player:died', () => {
      if (this.graph) this.graph.muffleSweep(0.7, 3.0);
    });

    bus.on('bot:killed', (e) => {
      if (!this.graph) return;
      const p = e?.bot?.position || e?.position;
      if (p) Foley.impact(this.graph, { x: p.x, y: p.y ?? 1, z: p.z, surface: 'flesh', energy: 1.4 });
      // Confirmation blip on the UI bus for the player's own kills.
      if (e?.by == null || e?.by === 'player' || e?.by === ctx.player) this._blip(1180, 0.055, 0.11);
    });

    // The AI emits `ai:fired`, not `bot:fired`. This listener spent the whole
    // of Wave 2 bound to an event nothing has ever emitted.
    bus.on('ai:fired', (e) => {
      if (!this.graph) return;
      const p = e?.position || e?.muzzle;
      const gun = e?.weapon || (e?.team === 'b' || e?.bot?.team === 'b' ? 'ak74' : 'm4');
      gunshot(this.graph, gun, { x: p?.x ?? 0, y: p?.y ?? 1.5, z: p?.z ?? 0 });
    });

    bus.on('bullet:whizz', (e) => {
      if (this.graph) Foley.whizz(this.graph, { distance: e?.distance, side: e?.side });
    });

    bus.on('bullet:impact', (e) => {
      if (!this.graph) return;
      const p = e?.point || e?.position || e;
      Foley.impact(this.graph, { x: p?.x ?? 0, y: p?.y ?? 1, z: p?.z ?? 0, surface: e?.surface || e?.material, energy: e?.energy });
    });

    bus.on('fx:explosion', (e) => {
      if (!this.graph) return;
      const p = e?.pos || e?.position || e;
      Foley.explosion(this.graph, { x: p?.x ?? 0, y: p?.y ?? 1, z: p?.z ?? 0, radius: e?.radius });
    });

    bus.on('hud:hitmarker', (e) => {
      const kind = typeof e === 'string' ? e : e?.kind;
      this._blip(kind === 'kill' ? 1180 : 1560, 0.04, kind === 'kill' ? 0.10 : 0.07);
    });

    bus.on('sky:timeOfDay', (t) => {
      // Night is quieter and thinner: less traffic, less wind, fewer events.
      const day = Math.sin(Math.PI * clamp(t ?? 0.5, 0, 1)) ** 0.6;
      this.ambience?.setIntensity(0.45 + 0.55 * day, undefined, 4);
    });
  }

  /** A short sine blip on the UI bus — hitmarkers and confirmations. */
  _blip(freq, decay, level) {
    const g = this.graph;
    if (!g) return;
    const ac = this.ac;
    const route = g.local({ bus: 'ui', gain: level });
    if (!route) return;
    const t = route.when;
    const osc = ac.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.82, t + decay);
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(env); env.connect(route.input);
    osc.start(t); osc.stop(t + decay + 0.02);
    osc.onended = () => { osc.disconnect(); env.disconnect(); route.release(); };
  }

  // --- public play ----------------------------------------------------------

  /**
   * Registry-style entry point. `id` is `family:variant` — `shot:m4`,
   * `impact:concrete`, `reload:bolt`. Systems that have the full data should
   * prefer the direct handles on `ctx.audio`, but this keeps the contract's
   * `play(id, opts)` signature honest.
   *
   * Ids are normalised first (see `normaliseSoundId`). Every caller outside
   * this directory was written against `family_variant` or a bare noun, so
   * before normalisation every bullet impact, every bot rifle shot, every
   * shell tick and every hitmarker in the game hit the `default:` arm and
   * returned silently.
   */
  play(id, opts = {}) {
    const g = this.graph;
    if (!g || !this.enabled) return;
    const s = normaliseSoundId(id);
    const i = s.indexOf(':');
    const fam = i < 0 ? s : s.slice(0, i);
    const variant = i < 0 ? '' : s.slice(i + 1);
    switch (fam) {
      case 'shot': case 'gun': case 'fire':
        return gunshot(g, variant || opts.weapon || 'm4', { local: true, ...opts });
      case 'step': case 'footstep':
        return Foley.footstep(g, { local: true, surface: variant || opts.surface, ...opts });
      case 'impact': case 'hit':
        return Foley.impact(g, { surface: variant || opts.surface, ...opts, x: opts.x ?? 0, y: opts.y ?? 1, z: opts.z ?? 0 });
      case 'shell': case 'casing':
        return Foley.shell(g, { local: true, caliber: variant || opts.caliber, ...opts });
      case 'reload':
        return Foley.reload(g, variant || opts.stage, opts.weapon);
      case 'whizz': case 'snap':
        return Foley.whizz(g, opts);
      case 'explosion': case 'boom':
        return Foley.explosion(g, { x: opts.x ?? 0, y: opts.y ?? 1, z: opts.z ?? 0, ...opts });
      case 'land':
        return Foley.land(g, { local: true, ...opts });
      case 'body':
        // A body hitting the ground: the landing thump voiced as flesh, not boots.
        return Foley.land(g, { impact: 9, surface: 'flesh', ...opts });
      case 'gear': case 'cloth':
        return Foley.gearRustle(g, this.ac, g.bus.foley, this.ac.currentTime, opts.level ?? 1);
      case 'hurt':
        return Foley.playerHurt(g, opts.amount);
      case 'ui': case 'blip':
        return this._blip(variant === 'kill' ? 1180 : variant === 'low' ? 620 : 1560, 0.05, opts.gain ?? 0.09);
      default:
        return undefined;
    }
  }

  playAt(id, worldPos, opts = {}) {
    const p = worldPos || _v;
    return this.play(id, {
      ...opts, local: false,
      x: p.x ?? p[0] ?? 0, y: p.y ?? p[1] ?? 1, z: p.z ?? p[2] ?? 0,
    });
  }

  // --- frame ----------------------------------------------------------------

  update(dt, ctx) {
    const g = this.graph;
    if (!g) return;

    // Impulse responses are staggered one per frame after unlock so the first
    // second of audio does not hitch while ~700 k samples are generated.
    if (!g.spaceReady) g.buildSpacesIncremental();
    else if (this._pendingIR) {
      this._pendingIR = false;
      this.ambience.start();
      this.ambience.setIntensity(0.9, this._space.interior, 2.5);
    }

    const cam = this._listenerSource || ctx.camera;
    if (cam) {
      cam.getWorldPosition(_v);
      cam.getWorldDirection(_fwd);
      g.setListener(_v.x, _v.y, _v.z, _fwd.x, _fwd.y, _fwd.z);
    }

    this._probeAcc += dt;
    if (this._probeAcc > 0.25) {
      this._probeAcc = 0;
      this._probeSpace(ctx, _v);
    }

    this.ambience?.update(dt, _v);
  }

  /**
   * Nine rays: one up for a ceiling, eight around for enclosure. Cheap enough
   * at 4 Hz to be free, and it means the reverb follows the geometry with no
   * authored volumes anywhere.
   */
  _probeSpace(ctx, pos) {
    const phys = ctx.physics;
    const g = this.graph;
    if (!phys?.raycast || !g) return;

    _dir.set(0, 1, 0);
    const ceil = phys.raycast(pos, _dir, 9, 1 | 2);
    const ceilDist = ceil ? ceil.distance : Infinity;

    let walls = 0;
    for (let i = 0; i < 8; i++) {
      _dir.set(RING[i][0], 0, RING[i][1]);
      if (phys.raycast(pos, _dir, 7, 1 | 2)) walls++;
    }

    // Enclosure 0..1 from the wall count; a ceiling is what turns it from
    // "standing in an alley" into "standing in a room".
    const enclosure = walls / 8;
    let street = 1, interior = 0, underpass = 0;
    if (ceilDist < 9) {
      const low = clamp(1 - (ceilDist - 2.4) / 4.5, 0, 1);
      if (enclosure > 0.72) { interior = low; street = 1 - low; }
      else { underpass = low * clamp(enclosure / 0.7, 0.2, 1); street = 1 - underpass; }
    }
    // Smooth so a doorway frame flickering in and out of a ray does not
    // modulate the reverb.
    const s = this._space;
    const k = 0.35;
    s.street += (street - s.street) * k;
    s.interior += (interior - s.interior) * k;
    s.underpass += (underpass - s.underpass) * k;
    g.setSpaceWeights(s.street, s.interior, s.underpass);
    this.ambience?.setIntensity(this.ambience.intensity, clamp(s.interior + s.underpass * 0.5, 0, 1), 0.8);
  }

  info() {
    return {
      state: this.ac?.state ?? 'not-created',
      sampleRate: this.ac?.sampleRate ?? 0,
      voices: this.graph?.voices ?? 0,
      spaceReady: !!this.graph?.spaceReady,
      space: { ...this._space },
      ambience: !!this.ambience?.started,
      weapons: Object.keys(SIGNATURES),
    };
  }

  // --- automation -----------------------------------------------------------

  _bindAutomation() {
    if (typeof window === 'undefined') return;
    const api = (window.__COD__ = window.__COD__ || {});
    api.audioInfo = () => this.info();
    api.audioUnlock = () => this.unlock();

    /**
     * A scripted tour of the whole synth, because audio cannot be
     * screenshotted and "no console errors" is not the same as "it sounds
     * right". Run `__COD__.audioTest()` in the console with the page focused.
     * Returns a promise that resolves when the sequence finishes.
     */
    api.audioTest = async (opts = {}) => {
      await this.unlock();
      const g = this.graph;
      if (!g) return { ok: false, reason: 'no audio context' };
      // Give the IRs a moment if the game loop has not built them yet.
      for (let i = 0; i < 8 && !g.spaceReady; i++) g.buildSpacesIncremental();
      this.ambience?.start();

      const log = opts.quiet ? () => {} : (m) => console.info(`[audioTest] ${m}`);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const script = [];

      script.push(['ambient bed: wind, rumble, air', 1800, () => {}]);

      for (const id of Object.keys(SIGNATURES)) {
        script.push([`${id} — single shot, close`, 900, () => gunshot(g, id, { local: true })]);
      }
      script.push(['m4 — full auto burst at 800 rpm', 1600, () => {
        for (let i = 0; i < 8; i++) setTimeout(() => gunshot(g, 'm4', { local: true }), i * 75);
      }]);
      script.push(['ak74 at 12 m, off to the left', 1200, () => {
        gunshot(g, 'ak74', { x: g.lx - 11, y: 1.5, z: g.lz - 4 });
      }]);
      script.push(['dmr at 55 m — listen for crack, then boom', 2000, () => {
        gunshot(g, 'dmr', { x: g.lx + 20, y: 1.5, z: g.lz - 51 });
      }]);
      script.push(['ak74 at 120 m — the gap is ~0.2 s now', 2400, () => {
        for (let i = 0; i < 4; i++) setTimeout(() => gunshot(g, 'ak74', { x: g.lx + 60, y: 1.5, z: g.lz - 104 }), i * 95);
      }]);
      script.push(['footsteps: concrete, gravel, dirt, metal, wood', 3000, () => {
        const surfaces = ['concrete_floor', 'gravel', 'dirt', 'metal_corrugated', 'wood_plank'];
        surfaces.forEach((s, i) => setTimeout(() => {
          Foley.footstep(g, { local: true, surface: s, speed: 3.4, foot: i & 1 });
        }, i * 520));
      }]);
      script.push(['sprinting on gravel', 1600, () => {
        for (let i = 0; i < 6; i++) {
          setTimeout(() => Foley.footstep(g, { local: true, surface: 'gravel', speed: 6.4, sprinting: true, foot: i & 1 }), i * 240);
        }
      }]);
      script.push(['crouched on concrete — quieter, darker', 1400, () => {
        for (let i = 0; i < 4; i++) {
          setTimeout(() => Foley.footstep(g, { local: true, surface: 'concrete_floor', speed: 1.6, stance: 'crouch', foot: i & 1 }), i * 330);
        }
      }]);
      script.push(['impacts: concrete, metal (ricochet), wood, glass, flesh', 3200, () => {
        const s = ['concrete_wall', 'metal_painted', 'wood_plank', 'glass', 'flesh'];
        s.forEach((k, i) => setTimeout(() => {
          Foley.impact(g, { x: g.lx + 3, y: 1.4, z: g.lz - 5, surface: k, energy: 1.2 });
        }, i * 560));
      }]);
      script.push(['bullets going past — left, right, close', 1500, () => {
        [[-1, 3], [1, 1.2], [-1, 0.6]].forEach(([side, d], i) =>
          setTimeout(() => Foley.whizz(g, { side, distance: d }), i * 420));
      }]);
      script.push(['shell casings on the ground', 1800, () => {
        for (let i = 0; i < 4; i++) setTimeout(() => Foley.shell(g, { local: true }), i * 220);
      }]);
      script.push(['reload — release, out, in, seat, bolt', 2600, () => {
        ['mag_release', 'mag_out', 'mag_in', 'seat', 'bolt'].forEach((s, i) =>
          setTimeout(() => Foley.reload(g, s, 'm4'), i * 380));
      }]);
      script.push(['reverb: street', 1400, () => {
        g.setSpaceWeights(1, 0, 0, 0.05);
        setTimeout(() => gunshot(g, 'm4', { local: true }), 120);
      }]);
      script.push(['reverb: interior — short, boxy, dark', 1400, () => {
        g.setSpaceWeights(0, 1, 0, 0.05);
        setTimeout(() => gunshot(g, 'm4', { local: true }), 120);
      }]);
      script.push(['reverb: underpass — long dark flutter', 1800, () => {
        g.setSpaceWeights(0, 0, 1, 0.05);
        setTimeout(() => gunshot(g, 'm4', { local: true }), 120);
      }]);
      script.push(['back to street', 600, () => g.setSpaceWeights(1, 0, 0, 0.4)]);
      script.push(['ambience ducking under sustained fire', 2200, () => {
        for (let i = 0; i < 14; i++) setTimeout(() => gunshot(g, 'm4', { local: true, gain: 0.8 }), i * 75);
      }]);
      script.push(['explosion + muffle sweep + tinnitus', 5200, () => {
        Foley.explosion(g, { x: g.lx + 4, y: 1, z: g.lz - 5, radius: 9 });
      }]);
      script.push(['taking a hit', 1200, () => Foley.playerHurt(g, 34)]);
      script.push(['done', 200, () => {}]);

      for (const [label, ms, fn] of script) {
        log(label);
        try { fn(); } catch (e) { console.error('[audioTest]', label, e); }
        await wait(opts.fast ? Math.min(ms, 400) : ms);
      }
      return { ok: true, steps: script.length, info: this.info() };
    };
  }

  dispose() {
    this.ambience?.stop();
    this._gestureOff?.();
    try { this.ac?.close(); } catch {}
    this.ac = null;
    this.graph = null;
  }
}
