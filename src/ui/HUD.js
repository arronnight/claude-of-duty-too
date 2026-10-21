import { Crosshair } from './hud/Crosshair.js';
import { Ammo } from './hud/Ammo.js';
import { Vitals } from './hud/Vitals.js';
import { Compass } from './hud/Compass.js';
import { Killfeed, Notify } from './hud/Killfeed.js';
import { Indicators } from './hud/Indicators.js';
import { Overlay } from './hud/Overlay.js';
import { clamp, clamp01, approach } from './hud/theme.js';

/**
 * Combat HUD.
 *
 * One Canvas2D surface inside `#ui-root`, sitting over the WebGL canvas. Never
 * a mesh in the 3D scene: a HUD drawn in the scene has to fight TAA, motion
 * blur, the tonemapper and the auto-exposure meter, and loses to all four.
 *
 * Structure: this file is the state pump and the compositor. Every widget is a
 * dumb object in `hud/` with `layout(w,h)`, `update(dt, state)` and
 * `draw(c, state)`, reading one shared plain-object state that is written in
 * place each frame — the HUD allocates nothing per frame in steady state.
 *
 * ## Hiding
 *
 * `setVisible(false)` must hide *everything*, because the blind A/B critic
 * compares our frames against real Call of Duty screenshots and any HUD in the
 * frame gives the game away instantly. So it takes the canvas out of the
 * document flow (`display:none`, not `opacity:0` — an opacity-0 canvas still
 * composites), drops the desaturation layer, and forces the dev debug overlay
 * down with it.
 *
 * It is also hidden automatically while the camera is overridden. The
 * screenshot harness drives the game through `window.__COD__.setCamera()`,
 * which emits `camera:override` — so a HUD can never leak into a critic frame
 * even if the harness forgets to ask.
 *
 * ## Reading other systems
 *
 * Weapons and AI publish their `ctx` APIs after this file was written, so every
 * read is optional-chained and re-resolved lazily each frame. The HUD degrades
 * to "no weapon, full health, compass only" rather than throwing.
 */

const DEG = 180 / Math.PI;
const MAX_DPR = 2;

export class HUDSystem {
  constructor() {
    this.visible = true;        // what the game asked for
    this.forced = null;         // explicit setVisible(false) wins over everything
    this.preview = false;       // HUD review tooling only — see _effective()
    this.override = false;      // camera:override from the harness
    this.alpha = 1;
    this.w = 1; this.h = 1; this.dpr = 1;

    this.crosshair = new Crosshair();
    this.ammo = new Ammo();
    this.vitals = new Vitals();
    this.compass = new Compass();
    this.killfeed = new Killfeed();
    this.notify = new Notify();
    this.indicators = new Indicators();
    this.overlay = new Overlay();

    /** Written in place every frame. Never reallocated. */
    this.s = {
      time: 0, alpha: 1,
      health: 100, maxHealth: 100, armour: 0, maxArmour: 50,
      stamina: 1, stance: 'stand', sprinting: false, dead: false, moving: false,
      px: 0, pz: 0, bearing: 0,
      hasWeapon: false, weaponName: '', fireMode: '',
      mag: 0, magSize: 0, reserve: 0,
      ads: 0, spreadPx: 6,
    };

    this._spreadFallback = 0.012;   // radians, used until weapons publishes
    this._firing = 0;
    this._desatApplied = -1;
  }

  async init(ctx) {
    this.ctx = ctx;
    const root = document.getElementById('ui-root');

    // Desaturation layer. `backdrop-filter` is the only way to touch the pixels
    // already composited from WebGL without a second render pass, and it costs
    // nothing while display:none, which is the case above 30 HP.
    const desat = document.createElement('div');
    desat.id = 'hud-desat';
    desat.style.display = 'none';
    root?.appendChild(desat);
    this.desatEl = desat;

    const canvas = document.createElement('canvas');
    canvas.id = 'hud-canvas';
    root?.appendChild(canvas);
    this.canvas = canvas;
    this.c = canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.overlay.bindContext(this.c);

    this._bindBus(ctx);

    ctx.hud = {
      /** Master switch. `false` removes every HUD pixel from the frame. */
      setVisible: (v) => this._setVisible(v),
      visible: true,                       // kept in sync by _apply()
      isVisible: () => this._effective(),
      notify: (text, sub, life) => this.notify.push(text, sub, life),
      killfeed: (entry) => this.killfeed.push(entry),
      damageIndicator: (dir, amount) => this._damageFrom(dir, amount),
      hitmarker: (kind) => this.crosshair.hitmarker(kind),
      flash: (amount) => this.overlay.blind(amount),
      /** Lets fx/weapons force the reticle open for a beat without a spread API. */
      fired: () => { this.crosshair.fired(); this.ammo.fired(); this._firing = 1; },
      clear: () => { this.killfeed.clear(); this.indicators.clear(); },
    };

    this._bindAutomation();
    this._layout();
  }

  // --- wiring -------------------------------------------------------------

  _bindBus(ctx) {
    const bus = ctx.bus;
    bus.on('camera:override', (v) => {
      this.override = !!v;
      this._apply();
    });

    bus.on('weapon:fired', () => {
      this.crosshair.fired();
      this.ammo.fired();
      this._firing = 1;
    });
    bus.on('weapon:reload', (e) => {
      const stage = e?.stage;
      if (!stage || stage === 'start' || stage === 'lower' || stage === 'mag_release') this.ammo.reloading();
    });
    bus.on('weapon:switch', () => this.ammo.reloading());

    bus.on('player:damaged', (e) => this._damaged(e));
    bus.on('player:died', () => {
      this.notify.push('YOU DIED', '', 3.0);
      this.indicators.clear();
    });
    bus.on('player:respawn', () => {
      this.overlay.death = 0;
      this.indicators.clear();
    });

    bus.on('bot:killed', (e) => this._botKilled(e));
    bus.on('hud:hitmarker', (e) => this.crosshair.hitmarker(typeof e === 'string' ? e : e?.kind));
    bus.on('hud:notify', (e) => this.notify.push(e?.text ?? e, e?.sub, e?.life));

    bus.on('fx:explosion', (e) => {
      const p = this.ctx.player?.position;
      const pos = e?.pos ?? e?.position;
      if (!p || !pos) { this.overlay.blind(0.20); return; }
      const dx = (pos.x ?? pos[0] ?? 0) - p.x;
      const dz = (pos.z ?? pos[2] ?? 0) - p.z;
      const d = Math.hypot(dx, dz);
      const r = e?.radius ?? 8;
      this.overlay.blind(clamp01(1 - d / (r * 2.2)) * 0.55);
    });
    bus.on('lighting:flashbang', (e) => this.overlay.blind(clamp01(e?.intensity ?? 0.8)));
  }

  _bindAutomation() {
    if (typeof window === 'undefined') return;
    // Merge, never replace: several systems attach their own hooks here.
    const api = (window.__COD__ = window.__COD__ || {});
    api.setHudVisible = (v) => this._setVisible(v);
    api.setHudPreview = (v) => { this.preview = !!v; this._apply(); };
    api.hud = {
      setVisible: (v) => this._setVisible(v),
      notify: (t, s) => this.notify.push(t, s),
      killfeed: (e) => this.killfeed.push(e),
      hitmarker: (k) => this.crosshair.hitmarker(k),
      damage: (deg, amount) => this._damageFrom((deg ?? 0) / DEG, amount ?? 20),
      /** Poses every widget at once so the HUD can be reviewed in one frame. */
      demo: () => this._demo(),
    };
  }

  /** One call that lights up every widget, for eyeballing the layout. */
  _demo() {
    if (!this.ctx.weapons?.current) {
      this._demoWeapon = { id: 'm4', name: 'M4A1', fireMode: 'auto', ammo: { mag: 17, reserve: 120, magSize: 30 } };
    }
    this.killfeed.push({ killer: 'YOU', victim: 'BRAVO-3', weapon: 'm4', headshot: true, mine: true });
    this.killfeed.push({ killer: 'ALPHA-1', victim: 'BRAVO-6', weapon: 'mp5' });
    this.killfeed.push({ killer: 'BRAVO-2', victim: 'ALPHA-4', weapon: 'm870' });
    this.notify.push('OBJECTIVE SECURED', 'HOLD THE MARKET', 4);
    this.crosshair.hitmarker('kill');
    this._damageFrom(-1.1, 34);
    this._damageFrom(2.4, 18);
    return true;
  }

  // --- events -------------------------------------------------------------

  _damaged(e) {
    const amount = e?.amount ?? 12;
    this._damageFrom(e?.dir ?? null, amount);
  }

  /**
   * Accepts a screen-relative angle in radians, a world-space direction toward
   * the source (what `player:damaged` carries), or a world position — the three
   * shapes different systems will plausibly hand us.
   */
  _damageFrom(dir, amount) {
    let ang = 0;
    if (typeof dir === 'number' && Number.isFinite(dir)) {
      ang = dir;
    } else if (dir) {
      const p = this.ctx.player;
      const yaw = p?.yaw ?? 0;
      let dx = dir.x ?? dir[0] ?? 0;
      let dz = dir.z ?? dir[2] ?? 0;
      // A position (rather than a direction) is anything far from unit length.
      const len = Math.hypot(dx, dz);
      if (len > 4 && p?.position) { dx -= p.position.x; dz -= p.position.z; }
      if (Math.hypot(dx, dz) < 1e-5) { dx = 0; dz = -1; }
      // Player basis: forward (-sin yaw, -cos yaw), right (cos yaw, -sin yaw).
      const f = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
      const r = dx * Math.cos(yaw) + dz * -Math.sin(yaw);
      ang = Math.atan2(r, f);
    }
    this.indicators.add(ang, clamp01((amount ?? 12) / 45));
    this.overlay.hit(amount, ang);
  }

  _botKilled(e) {
    const by = e?.by;
    const byName = typeof by === 'string' ? by : (by?.name ?? by?.id ?? (by === this.ctx.player || by == null ? 'YOU' : 'ENEMY'));
    const bot = e?.bot;
    const victim = typeof bot === 'string' ? bot : (bot?.name ?? bot?.id ?? 'ENEMY');
    const mine = /^(you|player)$/i.test(String(byName));
    this.killfeed.push({
      killer: byName, victim, mine,
      weapon: e?.weapon ?? this.ctx.weapons?.current?.id,
      headshot: !!e?.headshot,
    });
    if (mine) this.crosshair.hitmarker('kill');
  }

  // --- visibility ---------------------------------------------------------

  _setVisible(v) {
    this.forced = !!v;
    this.visible = !!v;
    this._apply();
  }

  /**
   * Visible only if the game wants it AND the harness is not driving.
   *
   * `preview` is the one escape hatch, and only the HUD's own review tooling
   * sets it — it exists so the layout can be screenshotted from a posed camera.
   * The screenshot harness never touches it, so a critic frame cannot get a HUD
   * in it by accident.
   */
  _effective() {
    if (this.preview) return true;
    if (this.forced === false) return false;
    if (this.override) return false;
    return this.visible;
  }

  _apply() {
    const on = this._effective();
    if (this.canvas) this.canvas.style.display = on ? 'block' : 'none';
    if (this.ctx?.hud) this.ctx.hud.visible = on;
    if (!on) {
      if (this.desatEl) this.desatEl.style.display = 'none';
      this._desatApplied = -1;
      // The dev overlay is not ours, but "no HUD in the frame" means no HUD in
      // the frame. It publishes ctx.debug after us, hence the optional chain.
      this.ctx?.debug?.setVisible?.(false);
      const el = document.getElementById('debug-overlay');
      if (el) el.style.display = 'none';
    }
    this.ctx?.bus?.emit('hud:visible', on);
  }

  // --- layout -------------------------------------------------------------

  resize(w, h, dpr) {
    this.w = w; this.h = h;
    this.dpr = Math.min(dpr || 1, MAX_DPR);
    this._layout();
  }

  _layout() {
    const w = this.w || window.innerWidth;
    const h = this.h || window.innerHeight;
    const dpr = this.dpr;
    if (!this.canvas) return;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.c.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const widget of [this.crosshair, this.ammo, this.vitals, this.compass,
      this.killfeed, this.notify, this.indicators, this.overlay]) {
      widget.layout(w, h);
    }
  }

  // --- frame --------------------------------------------------------------

  update(dt, ctx) {
    const s = this.s;
    s.time = ctx.time;
    this._firing = approach(this._firing, 0, 9, dt);

    const p = ctx.player;
    if (p) {
      s.health = p.health ?? 100;
      s.maxHealth = p.config?.health?.max ?? 100;
      s.armour = p.armour ?? 0;
      s.maxArmour = p.config?.health?.armour ?? 50;
      s.stamina = (p.stamina ?? 100) / (p.config?.stamina?.max ?? 100);
      s.stance = p.stance || 'stand';
      s.sprinting = !!p.sprinting;
      s.dead = !!p.dead;
      s.moving = (p.speed ?? 0) > 0.6;
      s.px = p.position?.x ?? 0;
      s.pz = p.position?.z ?? 0;
      s.bearing = -(p.yaw ?? 0) * DEG;
    }

    const w = ctx.weapons;
    let cur = w?.current;
    // Preview scaffolding: with no weapon system yet there is nothing to draw
    // in the ammo block, so the layout could not be reviewed. Only ever active
    // under the preview flag, which the screenshot harness never sets.
    if (!cur && this._demoWeapon) cur = this._demoWeapon;
    s.hasWeapon = !!cur;
    if (cur) {
      // `current` came back as a bare id string rather than an object, so
      // resolve both shapes: the definition is on `ctx.weapons.def` in that
      // case, and on the weapon itself in the other.
      const isId = typeof cur === 'string';
      const def = (isId ? w?.def : (cur.def || cur)) || null;
      const id = isId ? cur : (cur.id ?? def?.id ?? '');
      s.weaponName = def?.displayName || def?.name || def?.label || String(id).toUpperCase();
      s.fireMode = w?.fireMode || def?.fireMode || def?.mode || '';
      const obj = isId ? null : cur;
      const ammo = w?.ammo || obj?.ammo || null;
      s.mag = ammo?.mag ?? obj?.mag ?? 0;
      s.reserve = ammo?.reserve ?? obj?.reserve ?? 0;
      s.magSize = ammo?.magSize ?? def?.mag ?? def?.magSize ?? Math.max(s.mag, 1);
    }
    s.ads = clamp01(w?.adsProgress ?? p?.adsProgress ?? (w?.isADS || p?.isADS ? 1 : 0));
    s.spreadPx = this._spreadPx(ctx, dt);

    this.alpha = approach(this.alpha, this._effective() ? 1 : 0, 14, dt);
    s.alpha = this.alpha;

    this.crosshair.update(dt, s);
    this.ammo.update(dt, s);
    this.vitals.update(dt, s);
    this.compass.update(dt, s, ctx);
    this.killfeed.update(dt);
    this.notify.update(dt);
    this.indicators.update(dt);
    this.overlay.update(dt, s);
  }

  /**
   * Crosshair gap in CSS pixels, from the weapon's live spread cone.
   *
   *   gap = tan(halfAngle) / tan(fovY/2) * (viewportHeight / 2)
   *
   * That is the exact projection of the cone onto the screen, so the ticks sit
   * where the outer bullets will actually land. `ctx.weapons` had not published
   * its API when this was written, so several plausible field names are probed
   * and a movement/stance model stands in until one of them appears.
   */
  _spreadPx(ctx, dt) {
    let rad = readSpread(ctx.weapons);
    if (rad == null) {
      const p = ctx.player;
      const cur = ctx.weapons?.current;
      let base = (cur?.spreadBase ?? cur?.def?.spreadBase ?? 0.006);
      if (p) {
        if (p.stance === 'crouch') base *= 0.72;
        else if (p.stance === 'prone') base *= 0.55;
        base *= 1 + clamp01((p.speed ?? 0) / 5.2) * 1.35;
        if (p.sprinting) base *= 1.7;
        if (!p.grounded) base *= 2.1;
      }
      base *= 1 - 0.62 * this.s.ads;
      base += this._firing * 0.010;
      this._spreadFallback = approach(this._spreadFallback, base, 9, dt);
      rad = this._spreadFallback;
    }
    const fov = (ctx.camera?.fov ?? 70) / DEG;
    return Math.tan(clamp(rad, 0, 0.45)) / Math.tan(fov * 0.5) * (this.h * 0.5);
  }

  lateUpdate() {
    if (this.alpha < 0.004 || !this.c) return;
    const c = this.c;
    const s = this.s;
    c.clearRect(0, 0, this.w, this.h);

    // Full-screen effects sit under the widgets.
    this.overlay.draw(c, s);

    const a = s.alpha;
    c.globalAlpha = a;
    this.compass.draw(c, s);
    this.ammo.draw(c, s);
    this.vitals.draw(c, s);
    this.killfeed.draw(c, s);
    this.notify.draw(c, s);
    this.indicators.draw(c, s);
    this.crosshair.draw(c, s);
    c.globalAlpha = 1;

    this._syncDesat();
  }

  /**
   * The 30 HP desaturation. Quantised to 1/16 so the style string is only
   * rewritten when it visibly changes rather than every frame.
   */
  _syncDesat() {
    const el = this.desatEl;
    if (!el) return;
    const d = this._effective() ? this.overlay.desat : 0;
    const q = Math.round(d * 16);
    if (q === this._desatApplied) return;
    this._desatApplied = q;
    if (q <= 0) { el.style.display = 'none'; return; }
    const t = q / 16;
    el.style.display = 'block';
    el.style.backdropFilter = `saturate(${(1 - t * 0.62).toFixed(2)}) contrast(${(1 + t * 0.06).toFixed(2)})`;
    el.style.webkitBackdropFilter = el.style.backdropFilter;
  }

  dispose() {
    this.canvas?.remove();
    this.desatEl?.remove();
  }
}

/** Probes the field names `ctx.weapons` might publish a spread cone under. */
function readSpread(w) {
  if (!w) return null;
  const cur = w.current;
  const candidates = [
    w.spread, w.currentSpread, w.spreadRad, w.spreadRadians,
    typeof w.getSpread === 'function' ? w.getSpread() : undefined,
    w.state?.spread, cur?.spread, cur?.currentSpread, cur?.spreadRad,
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      // Anything above ~0.35 cannot be a half-angle in radians (that is a 20 deg
      // cone); treat it as degrees, which is the other unit anyone would use.
      return v > 0.35 ? v / DEG : v;
    }
    if (v && typeof v === 'object' && typeof v.current === 'number') {
      return v.current > 0.35 ? v.current / DEG : v.current;
    }
  }
  return null;
}
