import * as THREE from 'three';
import { makeRng, Batch } from './props/lib.js';
import { Site, BatchSet } from './props/layout.js';
import { scatterGround, rubblePiles, wallDrifts, wallBerms } from './props/clutter.js';
import {
  DecalKit, groundDecals, wallDecals, tyreTracks, hotspotDecals, groundingDust,
} from './props/decals.js';
import { facadeDetail } from './props/facade.js';
import { overheadLines, awnings, rooftops, fireEscape } from './props/overhead.js';
import { streetFurniture } from './props/furniture.js';

/**
 * Everything in the world that is not the building shell.
 *
 * The blockout renders correctly and is completely empty, and emptiness — not
 * shader quality — is what loses a blind comparison against a real Call of Duty
 * frame. `docs/CRITIC_RUBRIC.md` fails a shot outright for a bare ground plane;
 * `docs/ART_DIRECTION.md` lists eight density rules and the blockout satisfies
 * none of them. This system is the fix, and it is organised around the two
 * budgets that actually constrain the answer.
 *
 * **Draw calls, not triangles.** 350 budget, 178 spent by the shell, and a
 * shadow caster costs one draw per cascade on top of its own. So no prop is
 * ever its own mesh: `BatchSet` merges everything into buffers keyed by
 * material x spatial zone x casts-shadow. Ten thousand pieces come out as a few
 * dozen draws, each still frustum-culled to a 30 m band of street.
 *
 * **Placement must outlive the level.** `Level.js` belongs to another agent and
 * is expected to be rewritten. Nothing here knows a single map coordinate:
 * `Site` surveys the world at init through `ctx.physics.raycast` and hands back
 * walkable ground, a distance transform to the nearest obstruction, exposed
 * facade segments and rooftop rectangles. Every module places against those.
 *
 * Published API:
 * ```js
 * ctx.props = {
 *   root,                  // THREE.Group, added to the scene
 *   setDensity(0..1),      // hides the optional detail tiers, instantly
 *   density,               // current value
 *   stats,                 // { pieces, decals, draws, ... }
 *   site,                  // the survey, for anything that wants to place things
 * }
 * ```
 */

const SEED = 0x5eed1;

/**
 * Optional prop modules that may not exist yet.
 *
 * `import.meta.glob` is resolved by Vite at build time against the files that
 * are actually on disk, so a wave where `groundworks.js` or `streetside.js`
 * has not landed yet produces an empty map and no runtime request at all. A
 * plain `import()` of a missing path would 404 at runtime and put a console
 * error in every screenshot report, which is exactly what the harness gates on.
 */
const OPTIONAL_MODULES = import.meta.glob([
  './props/groundworks.js',
  './props/streetside.js',
]);

/**
 * Damp-patch decal bucket configuration. Blended, no depth write, pulled
 * towards the camera so it never z-fights the surface it darkens, and
 * noticeably smoother than the dry material underneath — that roughness delta
 * is the whole reason it exists.
 */
const DAMP_OVERRIDES = {
  transparent: true,
  depthWrite: false,
  alphaTest: 0.03,
  roughness: 0.40,
  metalness: 0,
  envMapIntensity: 0.85,
  polygonOffset: true,
  polygonOffsetFactor: -3,
  polygonOffsetUnits: -8,
  vertexColors: true,
};

/**
 * Paint / trim / glazing variants for the vehicle set.
 *
 * A merged batch shares one material per bucket, so a car built from a single
 * material key is a car made of one substance. The variant registry keys a
 * bucket by name instead, and `Materials.get` returns a program-inheriting
 * clone for non-structural overrides — so this table costs zero shader
 * programs and one draw per variant actually used.
 */
const VEHICLE_VARIANTS = [
  ['car_paint', 'metal_painted', { clearcoat: 1.0, clearcoatRoughness: 0.06, roughness: 0.34, metalness: 0.15 }],
  ['car_paint_dull', 'metal_painted', { roughness: 0.62, metalness: 0.1 }],
  ['car_trim', 'metal_painted', { roughness: 0.48, metalness: 0.55, color: 0x6a6a68 }],
  ['car_chrome', 'steel_brushed', { roughness: 0.18, metalness: 1.0, envMapIntensity: 1.4 }],
  ['car_glass', 'glass', { roughness: 0.08, metalness: 0, envMapIntensity: 1.25 }],
  ['car_rubber', 'rubber', { roughness: 0.86, metalness: 0 }],
  ['car_rust', 'metal_rusted', { roughness: 0.82, metalness: 0.25 }],
  ['car_underside', 'metal_rusted', { roughness: 0.95, metalness: 0.1, color: 0x3a352f }],
];

export class PropSystem {
  async init(ctx) {
    this.ctx = ctx;
    this.density = 1;
    /** @type {THREE.Mesh[][]} meshes bucketed by the density tier that owns them. */
    this.tiers = [[], [], []];
    this.stats = { pieces: 0, decals: 0, draws: 0, tris: 0, rays: 0, ms: 0 };
    this._colliders = [];
    this._staticId = -1;

    const root = new THREE.Group();
    root.name = 'Props';
    this.root = root;

    // Publish first, populate second: a later system that resolves ctx.props
    // during its own init must never see undefined, and nothing here may throw.
    ctx.props = {
      root,
      density: 1,
      stats: this.stats,
      site: null,
      setDensity: (v) => this.setDensity(v),
    };

    const parent = ctx.level?.root || ctx.scene;
    if (parent) parent.add(root); else return;

    // Resolve the optional modules before the build, which is synchronous.
    this._optional = {};
    for (const load of Object.values(OPTIONAL_MODULES)) {
      try {
        Object.assign(this._optional, await load());
      } catch (e) {
        console.warn('[props] optional module failed to load, skipping', e);
      }
    }

    const t0 = (globalThis.performance || Date).now();
    try {
      this._build(ctx);
    } catch (e) {
      console.warn('[props] build failed, continuing with what landed', e);
    }
    this.stats.ms = Math.round(((globalThis.performance || Date).now() - t0) * 10) / 10;
    ctx.props.site = this.site || null;
    this._registerColliders(ctx);
  }

  // ------------------------------------------------------------------ build

  _build(ctx) {
    const rand = makeRng(SEED);
    const site = new Site(ctx);
    site.survey();
    this.site = site;
    this.stats.rays = site.rayCount;

    // Tier 0 is the frame; tiers 1 and 2 are shed by setDensity in that order.
    // Only the core tier is worth splitting spatially and worth casting
    // shadows: it holds the readable silhouettes. Gravel and litter are merged
    // whole-map and never cast — 3 cascade draws for a 4 cm stone is the
    // definition of a bad trade against a 350 draw budget.
    const core = new BatchSet('core');
    const detail = new BatchSet('detail', Infinity, false);
    const fine = new BatchSet('fine', Infinity, false);
    // Decals get their own set: they need a different material configuration
    // (blended, depth-write off, polygon-offset) and a render order after the
    // opaque props they sit on.
    const decalSoft = new BatchSet('decalSoft', Infinity, false);
    const decalHard = new BatchSet('decalHard', Infinity, false);

    // New sets, all empty until a consumer puts geometry in one. A BatchSet
    // with no buckets emits no mesh, so publishing these costs nothing.
    const winSet = new BatchSet('windows', Infinity, false);   // facade glazing atlas
    const winLit = new BatchSet('winLit', Infinity, false);    // emissive night variant
    const decalDamp = new BatchSet('decalDamp', Infinity, false);
    // Default zone length (45 m) and shadows on, exactly like `core`. Raising
    // ZONE_LEN to 80 to fund the vehicle draws was considered and rejected: on
    // a 110x80 m map it collapses three Z-zones into two and therefore doubles
    // what a down-the-street shot rasterises. The frame is shading-bound, not
    // submission-bound, so trading fill for draws is backwards.
    const vehicles = new BatchSet('vehicles');
    for (const [name, key, over] of VEHICLE_VARIANTS) vehicles.variant(name, key, over);

    const kit = new DecalKit(0xd3ca1);
    this.decalKit = kit;

    /**
     * THE WAVE'S COORDINATION MECHANISM.
     *
     * Every prop module now takes one trailing options object. JS ignores
     * extra arguments, so appending it is a no-op for a module that has not
     * been updated, and a module that wants a new bucket or a piece of
     * cross-module data reads its own field out of here with no further edit
     * to this file. That is what lets six agents extend the prop system in
     * parallel without ever touching the same line.
     *
     * Consumers must treat every field as possibly absent and degrade.
     */
    const envOverrides = {};
    const env = {
      site, kit, rand,
      core, detail, fine,
      decalSoft, decalHard, decalDamp,
      winSet, winLit, vehicles,
      envOverrides,
      bays: [],
      hotspots: [],
      colliders: [],
    };

    let pieces = 0;
    // Structure before scatter: the facade and roof passes claim their ground
    // with site.occupy(), and the clutter fields respect it.
    const fac = facadeDetail(ctx, site, core, rand, 1, env);
    pieces += fac.parts;
    env.bays = fac.bays || [];
    pieces += rooftops(ctx, site, core, rand, 1, env).parts;
    pieces += awnings(ctx, site, core, rand, 1, env).parts;
    pieces += overheadLines(ctx, site, core, rand, 1, env).parts;
    pieces += fireEscape(ctx, site, core, rand, env).parts;
    const furniture = streetFurniture(ctx, site, core, rand, 1, env);
    pieces += furniture.parts;
    this._colliders = furniture.colliders;
    env.colliders = this._colliders;
    env.hotspots = furniture.hotspots || [];
    pieces += this._optionalPass('streetside', ctx, site, core, rand, 1, env);
    pieces += rubblePiles(ctx, site, core, rand, 1, 26, env).pieces;
    pieces += wallDrifts(ctx, site, detail, rand, 1, env).pieces;
    pieces += wallBerms(ctx, site, core, rand, 1, env).pieces;
    pieces += scatterGround(ctx, site, fine, rand, 1, env).pieces;

    let dec = 0;
    dec += groundDecals(ctx, site, decalSoft, decalHard, kit, rand, 1, env).count;
    dec += tyreTracks(ctx, site, decalHard, kit, rand, 1, env).count;
    dec += wallDecals(ctx, site, decalSoft, decalHard, kit, rand, 1, env).count;
    dec += hotspotDecals(ctx, site, decalSoft, decalHard, kit, rand, furniture.hotspots, env).count;
    dec += groundingDust(ctx, site, decalSoft, kit, rand, this._colliders, env).count;
    dec += this._optionalPass('groundworks', ctx, site, decalHard, rand, 1, env);

    // Tier order is "what to shed first", and that is decided by cost per unit
    // of frame, not by how much geometry it is. The blended decals are one mesh
    // and they are the single most expensive thing here, because a transparent
    // surface writes no depth and every pixel it covers re-runs the standard
    // shader with a three-cascade PCSS lookup. So they go last-in, first-out.
    this.tiers[0] = core.build(ctx, this.root);
    this.tiers[0].push(...vehicles.build(ctx, this.root));
    this.tiers[0].push(...winSet.build(ctx, this.root, { overrides: envOverrides.win || undefined }));
    this.tiers[0].push(...winLit.build(ctx, this.root, { overrides: envOverrides.winLit || undefined }));
    this.tiers[1] = detail.build(ctx, this.root);
    this.tiers[1].push(...fine.build(ctx, this.root));
    this.tiers[1].push(...decalHard.build(ctx, this.root, { overrides: kit.overrides(false) }));
    this.tiers[2] = decalSoft.build(ctx, this.root, {
      overrides: kit.overrides(true), renderOrder: 3,
    });
    // Damp patches shed first: a blended surface with no depth write re-runs
    // the full PCSS-lit standard shader for every pixel it covers.
    this.tiers[2].push(...decalDamp.build(ctx, this.root, {
      overrides: { ...DAMP_OVERRIDES, ...(envOverrides.damp || null) }, renderOrder: 3,
    }));

    this.stats.pieces = pieces;
    this.stats.decals = dec;
    this._tally();
  }

  /**
   * Runs an optional module if it landed. Wrapped so a half-finished wave
   * still boots with everything else intact — a module that throws costs its
   * own content and nothing more.
   */
  _optionalPass(name, ...args) {
    const fn = this._optional?.[name];
    if (typeof fn !== 'function') return 0;
    try {
      const r = fn(...args);
      return (r?.parts || 0) + (r?.pieces || 0) + (r?.count || 0);
    } catch (e) {
      console.warn(`[props] ${name}() failed, skipping`, e);
      return 0;
    }
  }

  _tally() {
    let draws = 0, tris = 0;
    for (const tier of this.tiers) {
      for (const m of tier) {
        if (!m.visible) continue;
        draws++;
        if (m.castShadow) draws += Math.max(0, (this.ctx.quality?.cascades || 3) - 1);
        const pos = m.geometry.attributes.position;
        tris += pos ? pos.count / 3 : 0;
      }
    }
    this.stats.draws = draws;
    this.stats.tris = Math.round(tris);
  }

  /**
   * Colliders are registered as one merged soup with a PROPS mask, and only for
   * things a player can actually stand on or be stopped by. Bedding six
   * thousand gravel chips into the BVH would cost more than it is worth and
   * would make the character controller trip over pebbles.
   */
  _registerColliders(ctx) {
    const phys = ctx.physics;
    if (!phys?.addStatic || !this._colliders?.length) return;
    const layer = phys.LAYER?.PROPS || 2;
    // One merged soup per surface key, so a bullet still gets the right impact
    // material without one addStatic call per crate.
    const bySurface = new Map();
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const c of this._colliders) {
      let b = bySurface.get(c.surface);
      if (!b) { b = new Batch('collider:' + c.surface); bySurface.set(c.surface, b); }
      e.set(0, c.yaw || 0, 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(c.x, c.y, c.z), q, new THREE.Vector3(c.w, c.h, c.d));
      b.addMatrix(unit, m, null);
    }
    this.staticIds = [];
    for (const [surface, batch] of bySurface) {
      const g = batch.build();
      if (!g) continue;
      const id = phys.addStatic(g, undefined, { material: surface, mask: layer });
      if (id > 0) this.staticIds.push(id);
      g.dispose();
    }
    unit.dispose();
    phys.buildStaticBVH?.();
  }

  // -------------------------------------------------------------- runtime

  /**
   * 1 keeps everything; lower values shed the optional tiers so a weak GPU can
   * still hold 60. Visibility only — nothing is rebuilt, so it is instant and
   * reversible.
   */
  setDensity(v) {
    const d = THREE.MathUtils.clamp(Number(v) || 0, 0, 1);
    this.density = d;
    if (this.ctx?.props) this.ctx.props.density = d;
    const thresholds = [0, 0.34, 0.67];
    for (let t = 0; t < this.tiers.length; t++) {
      const on = d > thresholds[t] - 1e-6;
      for (const m of this.tiers[t]) m.visible = on;
    }
    this._tally();
    return d;
  }

  update(dt, ctx) {
    // main.js merges into window.__COD__ rather than replacing it, but the
    // harness may load before this system has run, so attach lazily.
    const api = globalThis.window && window.__COD__;
    if (api && !api.setPropDensity) {
      api.setPropDensity = (v) => this.setDensity(v);
      api.propStats = () => this.stats;
      api.propField = (name) => this._dumpField(name);
    }
  }

  /**
   * ASCII dump of one of the survey's scalar fields, for eyeballing.
   *
   * `site.lee` is a new survey pass that six placement fields will depend on,
   * and its failure mode is silent: if the wind vector comes out perpendicular
   * to the street, every drift in the map points the wrong way and the frame
   * still renders happily. Text is enough to check that, costs no GPU, and
   * this returns null unless something asks for it.
   */
  _dumpField(name = 'lee') {
    const s = this.site;
    const arr = s && s[name];
    if (!arr || !arr.length) return null;
    const RAMP = ' .:-=+*#%@';
    let max = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    const rows = [];
    for (let iz = 0; iz < s.nz; iz += 2) {
      let line = '';
      for (let ix = 0; ix < s.nx; ix++) {
        const i = s.index(ix, iz);
        if (!s.open[i]) { line += '█'; continue; }
        const t = max > 0 ? arr[i] / max : 0;
        line += RAMP[Math.min(RAMP.length - 1, Math.round(t * (RAMP.length - 1)))];
      }
      rows.push(line);
    }
    return {
      name, max, nx: s.nx, nz: s.nz,
      windYaw: s.windYaw, windX: s.windX, windZ: s.windZ,
      facade0: s.facades[0] || null,
      rows,
    };
  }

  dispose() {
    for (const tier of this.tiers) {
      for (const m of tier) m.geometry?.dispose();
      tier.length = 0;
    }
    this.root?.removeFromParent();
  }
}
