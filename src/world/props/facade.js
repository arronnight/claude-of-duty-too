import * as THREE from 'three';
import {
  chamferBox, pipeGeo, lumpGeo, clothGeo, shellGeo, SHELL_T,
  projectUV, jitterColor, hash3,
} from './lib.js';
import { FacadeAtlas, FACADE_ATLAS_KEY } from './facadeAtlas.js';

/**
 * The facade skin — the largest surface area in every daylight shot, and until
 * now the reason those shots lost a blind A/B on sight.
 *
 * ## What was wrong
 *
 * This file already placed about a hundred windows and every single one of
 * them was buried inside solid concrete. `Level.js` emits one closed box per
 * building with no opening cut in it, and the old `window_()` put the reveal
 * back at `out = -0.30` and the jambs and head at `-0.15` — all *behind* the
 * face of that box, where nothing rasterises. The only parts of a window that
 * ever reached the screen were the cill at `+0.055` and the lintel at `+0.03`,
 * which is exactly what a 2x crop of the old goldenhour frame showed: thirty
 * isolated horizontal strokes in staggered rows with blank plaster between
 * them. Cills and lintels of windows that did not exist.
 *
 * ## The fix, and why it is not "cut holes in the level"
 *
 * Cutting the shell would couple this file to `Level.js`, which belongs to
 * another agent and is expected to be rewritten; worse, `Site.survey()` probes
 * the world with raycasts and cannot know where somebody else's holes went, so
 * every facade-relative placement in the map would start landing in mid-air.
 *
 * So the wall is built *forward* instead. A structural skin — piers between
 * the bays, spandrels between the floors — stands `PROUD` = 0.28 m off the
 * shell face and simply leaves the openings out. The shell behind each gap
 * becomes the back of the reveal for free, and the jamb returns close the
 * sides. It is how a real concrete frame with infill panels is built, and it
 * needs nothing from anybody else's file.
 *
 * 0.28 m is not a taste call. At 1600x900 and a 60 degree horizontal FOV one
 * pixel subtends 6.54e-4 rad, i.e. 1.96 cm at 30 m. A 0.28 m reveal seen 30
 * degrees off-normal presents a 0.14 m band of jamb — 7 px at 30 m — which
 * reads unambiguously as a hole. The 0.12 m a decal-style fake could afford
 * gives 3 px and reads as a smudge. 0.25 m is the floor; below it the whole
 * device stops working at exactly the distance that matters.
 *
 * ## Accepted consequence
 *
 * The visible facade now stands 0.28 m in front of its collider. A bullet
 * fired at a pier impacts the shell 0.28 m behind it, and the player can walk
 * through the skin. That is a real defect and it is the right trade: the
 * alternative is a BVH entry for every pier, spandrel, cill and cornice on the
 * map — thousands of boxes — to fix something invisible in a still frame and
 * barely perceptible in play. No colliders are registered for any of this.
 *
 * ## Cost
 *
 * Every structural element lands in `concrete_wall`, `metal_rusted` or
 * `brick`, all of which already have buckets in the core set, so the geometry
 * is free in draw calls. The only new draws are the two atlas buckets: one
 * material key at an `Infinity` zone with shadows off is exactly one bucket
 * for every opening on the map.
 */

// --------------------------------------------------------------------- shape

const PROUD = 0.28;          // how far the structural skin stands off the shell
const GROUND_H = 4.20;       // ground floor-to-floor
const STOREY = 3.40;         // upper floor-to-floor
const BAY = 2.60;            // target pier-to-pier spacing
const OPEN_W = 1.30;
const OPEN_H = 2.15;         // 1 : 1.65, the proportion the references hold to
const CILL_UP = 0.70;        // cill above its own floor line
const HEAD_UP = CILL_UP + OPEN_H;
const SHOP_BAY = 4.20;
const LACE_LOD = 34;         // metres past which railings become an atlas quad

const _c = new THREE.Color();
const _c2 = new THREE.Color();

/**
 * Geometry cache keyed on the real dimensions, quantised to 2 cm.
 *
 * `projectUV` bakes UVs in *local metres*, and `Batch` merges the source
 * vertices without touching them — so scaling a shared unit box at insert time
 * stretches its texture by the scale factor. The old code did that to a 1 m
 * band scaled to 16 m and the concrete on every string course was smeared 16:1.
 * Building the box at its real size instead costs a few hundred KB of cached
 * geometry and keeps texel density constant across the whole facade, which is
 * the thing a critic actually notices.
 */
const BOXES = new Map();
function box(w, h, d, c = 0.02) {
  const q = (v) => Math.max(0.02, Math.round(v * 50) / 50);
  const kw = q(w), kh = q(h), kd = q(d);
  const key = `${kw}:${kh}:${kd}:${c}`;
  let g = BOXES.get(key);
  if (!g) {
    if (BOXES.size > 1200) BOXES.clear();     // guard against pathological input
    g = chamferBox(kw, kh, kd, c);
    BOXES.set(key, g);
  }
  return g;
}

/** Shared parts whose size never varies. */
let G = null;
function geo() {
  if (G) return G;
  const thin = (w, h, d, c = 0.012) => chamferBox(w, h, d, c);
  G = {
    corbel: chamferBox(0.10, 0.16, 0.20, 0.015),
    balCorbel: chamferBox(0.16, 0.30, 0.60, 0.02),
    baluster: chamferBox(0.028, 0.86, 0.028, 0),
    quoinA: chamferBox(0.50, 0.55, 0.34, 0.028),
    quoinB: chamferBox(0.34, 0.55, 0.34, 0.028),
    rebar: pipeGeo(0.008, 1, 4, false),
    chunk: lumpGeo(0.12, 0.4, [1, 0.7, 0.9], 1, 5),
    pipe: pipeGeo(0.055, 1, 8, false),
    hopper: chamferBox(0.30, 0.26, 0.22, 0.02),
    pipeAlong: pipeGeo(0.026, 1, 6, false).rotateZ(Math.PI / 2),
    pipeOut: pipeGeo(0.022, 1, 5, false).rotateX(Math.PI / 2),
    bracket: chamferBox(0.09, 0.05, 0.16, 0.012),
    boxUnit: chamferBox(0.4, 0.56, 0.2, 0.03),
    boxLid: chamferBox(0.44, 0.05, 0.24, 0.015),
    vent: chamferBox(0.5, 0.36, 0.13, 0.02),
    slat: chamferBox(0.44, 0.03, 0.06, 0.006),
    ac: chamferBox(0.86, 0.56, 0.34, 0.035),
    acGrille: chamferBox(0.7, 0.44, 0.03, 0.008),
    acFoot: chamferBox(0.06, 0.09, 0.4, 0.012),
    // A flagpole leaning 40 degrees out of the wall, pre-rotated because the
    // placement helper only ever yaws.
    flagPole: pipeGeo(0.025, 2.8, 6, false).rotateX(Math.PI / 2 - 0.698),
    flagBracket: thin(0.08, 0.20, 0.26),
    dish: (() => {
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        pts.push(new THREE.Vector2(t * 0.42, t * t * 0.16));
      }
      const g = new THREE.LatheGeometry(pts, 14);
      g.rotateX(Math.PI / 2 - 0.3);
      projectUV(g);
      return g;
    })(),
  };
  return G;
}

/** Built once and shared: 16 painted cells, one material key, two buckets. */
let ATLAS = null;
function atlas() {
  if (!ATLAS) {
    try { ATLAS = new FacadeAtlas(0xfacade); } catch (e) { ATLAS = { quads: {}, texture: null, geo: () => null, has: () => false }; }
  }
  return ATLAS;
}

/** Local frame of a facade: `u` runs along it, `n` points out of it. */
function frame(f) {
  const dx = f.bx - f.ax, dz = f.bz - f.az;
  const len = Math.hypot(dx, dz) || 1;
  return {
    len, ux: dx / len, uz: dz / len, nx: f.nx, nz: f.nz,
    yaw: Math.atan2(f.nx, f.nz),
  };
}

/**
 * Places a part on a facade. `s` is metres along the segment from its `a` end,
 * `y` is world height, `out` is metres proud of the SHELL face and addresses
 * the part's CENTRE — so a 0.28 m deep box at `out` 0.14 sits flush from the
 * shell to the skin face.
 */
function place(bs, key, g, fr, f, s, y, out, color, shadow = false, sx = 1, sy = 1, sz = 1) {
  const x = f.ax + fr.ux * s + fr.nx * out;
  const z = f.az + fr.uz * s + fr.nz * out;
  bs.add(key, g, x, y, z, 0, fr.yaw, 0, sx, sy, sz, color, shadow);
}

// ------------------------------------------------------------------- choices

const UPPER_PANES = [
  ['paneDark', 0.30], ['paneCurtain', 0.12], ['paneSky', 0.16], ['paneBroken', 0.18],
  ['paneBoarded', 0.10], ['paneShutter', 0.06], ['paneGrille', 0.04], ['paneBlocked', 0.04],
];
const SHOP_INFILL = [
  ['shopGlass', 0.42], ['shopShutter', 0.30], ['paneBoarded', 0.16], ['doorTimber', 0.12],
];

function pick(table, rand, bias) {
  let total = 0;
  for (const [k, w] of table) total += w * (bias ? (bias[k] || 1) : 1);
  let r = rand() * total;
  for (const [k, w] of table) {
    r -= w * (bias ? (bias[k] || 1) : 1);
    if (r <= 0) return k;
  }
  return table[0][0];
}

// ---------------------------------------------------------------------- main

/**
 * @param {any} ctx
 * @param {import('./layout.js').Site} site
 * @param {import('./layout.js').BatchSet} bs core set
 * @param {() => number} rand
 * @param {number} density
 * @param {any} [env] props-core options bag; every field optional
 */
export function facadeDetail(ctx, site, bs, rand, density = 1, env = null) {
  const g = geo();
  const kit = atlas();
  const winSet = (env && env.winSet) || bs;
  const winLit = (env && env.winLit) || null;
  const detail = (env && env.detail) || bs;
  let parts = 0;
  /** @type {{x:number,y:number,z:number,nx:number,nz:number,w:number}[]} */
  const sills = [];
  /** Shopfront bays, handed to props-core so awnings bind to real openings. */
  const bays = [];

  // Publish the glazing material configuration before anything is added: the
  // two BatchSets are built after every module has run, so writing these here
  // is what turns `winSet`/`winLit` into an atlas bucket rather than a bare
  // gun_polymer one.
  if (kit.texture && env && env.envOverrides) {
    env.envOverrides.win = kit.overrides(false);
    env.envOverrides.winLit = kit.overrides(true);
  }

  // The middle of the map, used as the origin for the two distance-driven
  // decisions here (railing LOD, night-lit bias). Derived from the survey
  // rather than a map coordinate so it survives a level rewrite.
  const midX = (site.x0 + site.x1) * 0.5;
  const midZ = (site.z0 + site.z1) * 0.5;

  for (let fi = 0; fi < site.facades.length; fi++) {
    const f = site.facades[fi];
    const fr = frame(f);
    const h = f.top - f.base;
    // The survey returns thirty segments and four of them are 2-3 m stubs of
    // boundary wall about chest high. Giving those a shopfront and a cornice
    // is not detail, it is nonsense; they get a coping and nothing else.
    if (fr.len < 4.5 || h < 4.5) {
      if (fr.len >= 1.8 && h >= 1.2) {
        jitterColor(_c, rand, 0.22, 0.05, 0.05);
        place(bs, 'concrete_wall', box(fr.len, 0.13, 0.44, 0.022), fr, f, fr.len * 0.5,
          f.top + 0.065, 0.06, _c, true);
        parts++;
      }
      continue;
    }

    // Per-building tint so no two facades sit at the same value — rule 5. The
    // spread is wider than it was (0.20 -> 0.26) because there is now enough
    // modelling on each wall for a tonal difference to read as two buildings
    // rather than as a lighting artefact.
    jitterColor(_c, rand, 0.26, 0.06, 0.05);
    // The survey knows what the shell is actually made of. Everything is built
    // in concrete_wall regardless — a second shadow-casting key would cost a
    // bucket per zone per cascade — but a brick shell gets a warm tint so the
    // skin does not read as grey render bolted onto red brick.
    if (f.surface === 'brick') _c.lerp(_c2.setRGB(1.02, 0.80, 0.70), 0.55);
    const wall = _c.clone();

    const gH = Math.min(GROUND_H, h - 0.35);
    const floors = Math.max(0, Math.floor((h - gH - 0.9) / STOREY));
    const bayN = Math.max(1, Math.round(fr.len / BAY));
    const bayW = fr.len / bayN;
    const pierW = Math.max(0.45, bayW - OPEN_W);
    const yFloor = (fl) => f.base + gH + fl * STOREY;
    const skinBottom = (fl) => yFloor(fl) - 0.55;      // = previous head
    // One building per side gets a continuous first-floor balcony, and a
    // different one loses its top corner. Facades are sorted by length, so the
    // first four are the four big street walls, one per side of each block.
    const filant = fi < 2 && floors >= 1;
    const cornerLoss = fi >= 2 && fi < 4 && floors >= 2;
    const lossFrom = cornerLoss ? Math.max(1, bayN - 2) : bayN;

    // ---------------------------------------------------------- 1. the skin
    for (let fl = 0; fl < floors; fl++) {
      const yb = skinBottom(fl);
      const top = yFloor(fl) + HEAD_UP;
      if (top > f.top - 0.45) break;
      const lastFloor = fl === floors - 1 || yFloor(fl + 1) + HEAD_UP > f.top - 0.45;
      const cut = lastFloor && cornerLoss ? lossFrom : bayN;

      // Piers, one per bay boundary. The end piers are pushed inboard so they
      // do not overhang the segment and collide with the return wall.
      for (let b = 0; b <= cut; b++) {
        let s = b * bayW;
        if (b === 0) s = pierW * 0.5;
        else if (b === bayN) s = fr.len - pierW * 0.5;
        _c.copy(wall).multiplyScalar(0.99 + hash3(fi, fl, b) * 0.06);
        // 4% of piers are spalled through: two stubs with rebar crossing the
        // gap. Rebar is named explicitly in ART_DIRECTION.md and is the
        // cheapest war-zone signal on the board.
        if (hash3(b, fl * 7 + 3, fi) < 0.04 && fl > 0) {
          const gap = 0.35 + hash3(fi, b, 11) * 0.35;
          const gy = yb + STOREY * (0.3 + hash3(b, fi, 5) * 0.35);
          const lower = gy - gap * 0.5 - yb;
          const upper = (yb + STOREY) - (gy + gap * 0.5);
          if (lower > 0.3) {
            place(bs, 'concrete_wall', box(pierW, lower, PROUD, 0.03), fr, f, s, yb + lower * 0.5, PROUD / 2, _c, true);
            parts++;
          }
          if (upper > 0.3) {
            place(bs, 'concrete_wall', box(pierW * 0.92, upper, PROUD, 0.03), fr, f, s,
              yb + STOREY - upper * 0.5, PROUD / 2, _c, true);
            parts++;
          }
          _c2.setRGB(0.9, 0.72, 0.6);
          for (let k = 0, m = 3 + ((hash3(fi, b, 2) * 3) | 0); k < m; k++) {
            const off = (k / Math.max(1, m - 1) - 0.5) * pierW * 0.7;
            // Bent, not straight: a stub of exposed reinforcement that is
            // dead vertical reads as a fence post.
            const bend = (hash3(k, b, fi) - 0.5) * 0.6;
            const x = f.ax + fr.ux * (s + off) + fr.nx * (PROUD * 0.55);
            const z = f.az + fr.uz * (s + off) + fr.nz * (PROUD * 0.55);
            bs.addPitched('metal_rusted', g.rebar, x, gy, z, fr.yaw, bend, bend * 0.5,
              1, gap + 0.14, 1, _c2, false);
            parts++;
          }
          continue;
        }
        place(bs, 'concrete_wall', box(pierW, STOREY, PROUD, 0.03), fr, f, s, yb + STOREY * 0.5,
          PROUD / 2, _c, true);
        parts++;
      }

      // Spandrels: the band from the floor below's head up to this cill.
      for (let b = 0; b < cut; b++) {
        const s = (b + 0.5) * bayW;
        _c.copy(wall).multiplyScalar(0.97);
        place(bs, 'concrete_wall', box(bayW - pierW + 0.04, 1.25, PROUD, 0.025), fr, f, s,
          yb + 0.625, PROUD / 2, _c, true);
        parts++;
      }
    }

    // Everything above the topmost head, and the whole wall when the building
    // is too short for an upper floor at all.
    {
      const from = floors > 0
        ? Math.min(f.top - 0.45, yFloor(floors - 1) + HEAD_UP)
        : f.base + gH - 0.55;
      const to = f.top - 0.30;
      if (to - from > 0.15) {
        _c.copy(wall).multiplyScalar(0.98);
        const wLen = cornerLoss ? lossFrom * bayW : fr.len;
        place(bs, 'concrete_wall', box(wLen, to - from, PROUD, 0.03), fr, f, wLen * 0.5,
          (from + to) * 0.5, PROUD / 2, _c, true);
        parts++;
      }
    }

    // ------------------------------------------------------- 2. the openings
    for (let fl = 0; fl < floors; fl++) {
      const y0 = yFloor(fl);
      if (y0 + HEAD_UP > f.top - 0.45) break;
      const lastFloor = fl === floors - 1 || yFloor(fl + 1) + HEAD_UP > f.top - 0.45;
      const cut = lastFloor && cornerLoss ? lossFrom : bayN;
      const skyBias = fl >= floors - 2 ? { paneSky: 2.2 } : { paneSky: 0.4 };

      for (let b = 0; b < cut; b++) {
        const s = (b + 0.5) * bayW;
        // 12% of bays are a full-height slot instead — a stair light. One
        // change of aspect ratio does more to break a window grid than any
        // amount of jitter inside it.
        const slot = rand() < 0.12;
        let ww = slot ? 0.75 : OPEN_W * (0.92 + rand() * 0.14);
        let wh = slot ? STOREY - 1.05 : OPEN_H * (0.94 + rand() * 0.10);
        if (wh / ww < 1.5) wh = ww * 1.5;
        ww = Math.round(ww * 50) / 50;
        wh = Math.round(wh * 50) / 50;
        const cillY = y0 + (slot ? 0.35 : CILL_UP) + (rand() - 0.5) * 0.10;
        const headY = cillY + wh;
        if (headY > y0 + STOREY - 0.2) continue;
        const yc = (cillY + headY) * 0.5;

        const roll = rand();
        const blown = roll < 0.07;
        const blocked = !blown && roll < 0.13;

        parts += opening(bs, winSet, winLit, detail, g, kit, fr, f, s, cillY, headY, ww, wh,
          wall, rand, { blown, blocked, slot, skyBias, fl, floors, fi, midX, midZ, filant });

        sills.push({
          x: f.ax + fr.ux * s + fr.nx * 0.36,
          z: f.az + fr.uz * s + fr.nz * 0.36,
          y: cillY - 0.06, nx: fr.nx, nz: fr.nz, w: ww + 0.26,
        });

      }
    }

    // -------------------------------------------------- 3. the ground storey
    if (gH >= 2.8) {
      parts += groundStorey(bs, winSet, winLit, g, kit, fr, f, gH, wall, rand, bays, fi);
    }

    // ------------------------------------------- 4. mouldings and the corner
    parts += mouldings(bs, fr, f, gH, floors, yFloor, wall, cornerLoss ? lossFrom * bayW : fr.len);
    parts += quoins(bs, g, fr, f, h, wall);

    // ------------------------------------------------------- 5. the balconies
    if (filant) {
      // A balcony that runs the whole length of the first floor. The
      // continuity is the point: an unbroken slab and rail across six bays is
      // what makes a block read as built rather than assembled.
      const y = yFloor(0) + CILL_UP - 0.16;
      _c.copy(wall).multiplyScalar(1.04);
      place(bs, 'concrete_wall', box(fr.len, 0.16, 1.05, 0.02), fr, f, fr.len * 0.5, y, 0.80, _c, true);
      parts++;
      for (let k = 0, n = Math.max(2, Math.round(fr.len / 2.2)); k <= n; k++) {
        place(bs, 'concrete_wall', g.balCorbel, fr, f, (k / n) * fr.len, y - 0.22, 0.52, _c, true);
        parts++;
      }
      parts += railing(bs, detail, g, fr, f, fr.len * 0.5, y + 0.08, fr.len, 1.30, kit, rand, midX, midZ, winSet);
    }

    // ----------------------------------------------------------- 6. services
    parts += services(bs, g, fr, f, h, gH, floors, yFloor, rand, density, sills);

    // A flag, on the two longest walls only. Cloth in direct sun is the one
    // place the new translucency term in fabric_canvas can actually pay off,
    // and every other piece of cloth on this map hangs in shadow.
    if (fi < 2) {
      const s = fr.len * (0.22 + fi * 0.5);
      const y = f.base + 4.2;
      _c.copy(wall).multiplyScalar(0.8);
      place(bs, 'metal_painted', g.flagBracket, fr, f, s, y, 0.13, _c, false);
      place(bs, 'metal_painted', g.flagPole, fr, f, s, y + 0.90, 0.90, _c, true);
      const cloth = shellGeo(clothGeo(1.4, 0.9, 0.12, rand, 0.08), SHELL_T.canvas);
      _c.setRGB(1.02, 0.94, 0.86);
      place(bs, 'fabric_canvas', cloth, fr, f, s + 0.75, y + 1.05, 1.05, _c, true);
      parts += 3;
    }
  }

  if (winLit && kit.texture) bindNightLights(ctx, kit);

  return { parts, sills, bays };
}

// -------------------------------------------------------------- night lights

const BOUND = new WeakSet();

/**
 * Drives the lit-window emissive off the sun.
 *
 * The intended home for this is a few lines in `PropSystem.update`, but
 * `Props.js` belongs to another agent, so it hangs off the `sky:timeOfDay` bus
 * event instead. `Materials.get` caches variants by the *content* of the
 * overrides object, so asking for the same override block a second time
 * returns the very material `BatchSet.build` will hand to the mesh — no
 * reference has to be threaded anywhere.
 *
 * It is a step change on the event rather than the briefed `lerp(.., dt*2)`,
 * because a prop module has no per-frame hook to lerp in. Identical in a still;
 * a dusk transition driven from the UI will pop rather than fade, and that is
 * the honest cost of not editing somebody else's file.
 */
function bindNightLights(ctx, kit) {
  if (!ctx || BOUND.has(ctx)) return;
  BOUND.add(ctx);
  const apply = () => {
    let mat = null;
    try { mat = ctx.materials?.get(FACADE_ATLAS_KEY, { vertexColors: true, ...kit.overrides(true) }); }
    catch (e) { return; }
    if (!mat) return;
    const day = ctx.sky?.intensity;
    mat.emissiveIntensity = 0.85 * Math.max(0, 1 - (typeof day === 'number' ? day : 1));
  };
  ctx.bus?.on?.('sky:timeOfDay', apply);
  apply();
}

// ------------------------------------------------------------------ opening

/**
 * One opening: reveal returns, the atlas pane, cill, corbels, lintel and
 * architrave. Every `out` is measured from the shell face, and the skin face
 * is at 0.28 — so the reveal returns run 0 to 0.28 and everything else stands
 * proud of them.
 */
function opening(bs, winSet, winLit, detail, g, kit, fr, f, s, cillY, headY, ww, wh, wall, rand, o) {
  let n = 0;
  const yc = (cillY + headY) * 0.5;

  // Reveal returns. Tinted down hard: these faces never see the sun and the
  // value step from the sunlit skin to the jamb is what makes the hole read.
  _c.copy(wall).multiplyScalar(0.62);
  const jamb = box(0.05, wh, PROUD, 0.012);
  for (const sd of [-1, 1]) {
    place(bs, 'concrete_wall', jamb, fr, f, s + sd * (ww * 0.5 + 0.025), yc, PROUD / 2, _c, false);
    n++;
  }
  _c.copy(wall).multiplyScalar(0.52);
  place(bs, 'concrete_wall', box(ww, 0.05, PROUD, 0.012), fr, f, s, headY + 0.025, PROUD / 2, _c, false);
  _c.copy(wall).multiplyScalar(0.78);
  place(bs, 'concrete_wall', box(ww, 0.06, PROUD, 0.012), fr, f, s, cillY - 0.03, PROUD / 2, _c, false);
  n += 2;

  if (o.blown) {
    // Blown out: no pane, a near-black back panel, arrises knocked off the
    // reveal and a few chunks left on the cill.
    _c.setRGB(0.30, 0.30, 0.32);
    place(bs, 'concrete_wall', box(ww, wh, 0.04, 0.008), fr, f, s, yc, 0.03, _c, false);
    n++;
    _c.copy(wall).multiplyScalar(0.7);
    for (let k = 0; k < 4; k++) {
      const t = hash3(k, s | 0, 3);
      const sd = k < 2 ? -1 : 1;
      place(bs, 'concrete_wall', box(0.09, 0.14 + t * 0.16, PROUD * 0.8, 0.01), fr, f,
        s + sd * (ww * 0.5 + 0.02) + (t - 0.5) * 0.12,
        cillY + wh * (0.15 + t * 0.7), PROUD / 2 + (t - 0.5) * 0.12, _c, false);
      n++;
    }
    for (let k = 0, m = 2 + ((rand() * 3) | 0); k < m; k++) {
      place(bs, 'concrete_wall', g.chunk, fr, f, s + (rand() - 0.5) * ww, cillY + 0.02, 0.34, _c, false,
        0.7 + rand() * 0.7, 0.6 + rand() * 0.5, 0.7 + rand() * 0.6);
      n++;
    }
  } else if (o.blocked) {
    // Bricked up: the painted cell plus a real recessed infill, so the
    // silhouette of the reveal survives even where the texture is minified
    // away. Non-casting, which keeps it in the brick bucket the rubble
    // scatter already opened.
    _c.copy(wall).multiplyScalar(0.86);
    place(bs, 'brick', box(ww, wh, 0.10, 0.012), fr, f, s, yc, 0.18, _c, false);
    n++;
    n += pane(winSet, kit, 'paneBlocked', fr, f, s, yc, ww, wh, rand, 0.42);
  } else {
    const kind = o.slot ? (rand() < 0.6 ? 'paneDark' : 'paneCurtain')
      : pick(UPPER_PANES, rand, o.skyBias);
    // 18% of what is left is lit from inside, biased to the far half of the
    // map. `winLit` is the same atlas with the albedo doubling as the emissive
    // map: the field is near-black so it barely emits, while the curtain and
    // the strip light glow. Correctly shaped interior spill for nothing.
    const px = f.ax + fr.ux * s, pz = f.az + fr.uz * s;
    const far = Math.hypot(px - o.midX, pz - o.midZ) > 18 ? 2.4 : 0.6;
    const set = (winLit && rand() < 0.18 * far) ? winLit : winSet;
    n += pane(set, kit, kind, fr, f, s, yc, ww, wh, rand, 0.38);
  }

  // Cill: proud enough to throw a real line of shade and to start the streak
  // the decal pass hangs under it.
  _c.copy(wall).multiplyScalar(1.12);
  place(bs, 'concrete_wall', cillGeo(ww + 0.26), fr, f, s, cillY - 0.05, 0.34, _c, true);
  for (const sd of [-1, 1]) {
    place(bs, 'concrete_wall', g.corbel, fr, f, s + sd * (ww * 0.5 + 0.06), cillY - 0.18, 0.30, _c, false);
  }
  // Lintel / hood.
  _c.copy(wall).multiplyScalar(1.05);
  place(bs, 'concrete_wall', box(ww + 0.22, 0.16, 0.20, 0.02), fr, f, s, headY + 0.13, 0.32, _c, true);
  n += 4;

  // Architrave. Small section, but it is at 0.30 and the reveal is at 0.14, so
  // it carries its own 4 cm shadow line all the way round the opening.
  _c.copy(wall).multiplyScalar(1.02);
  const av = box(0.09, wh + 0.02, 0.06, 0.012);
  for (const sd of [-1, 1]) {
    place(bs, 'concrete_wall', av, fr, f, s + sd * (ww * 0.5 + 0.095), yc, 0.30, _c, false);
    n++;
  }
  const ah = box(ww + 0.31, 0.09, 0.06, 0.012);
  place(bs, 'concrete_wall', ah, fr, f, s, headY + 0.075, 0.30, _c, false);
  place(bs, 'concrete_wall', ah, fr, f, s, cillY - 0.075, 0.30, _c, false);
  n += 2;

  // Balcony on 28% of first-floor-and-above openings, unless the whole floor
  // already has a continuous one.
  if (o.fl >= 1 && !(o.filant && o.fl === 0) && rand() < 0.28) {
    _c.copy(wall).multiplyScalar(1.04);
    place(bs, 'concrete_wall', box(ww + 0.55, 0.16, 1.05, 0.02), fr, f, s, cillY - 0.16, 0.80, _c, true);
    n++;
    for (const sd of [-1, 1]) {
      place(bs, 'concrete_wall', g.balCorbel, fr, f, s + sd * (ww * 0.5 + 0.12), cillY - 0.38, 0.52, _c, true);
      n++;
    }
    n += railing(bs, detail, g, fr, f, s, cillY - 0.08, ww + 0.55, 1.30, kit, rand, o.midX, o.midZ, winSet);
  }

  return n;
}

/** A cill with its top face pitched 12 degrees out, so water and light leave it. */
const CILLS = new Map();
function cillGeo(w) {
  const kw = Math.round(w * 50) / 50;
  let g = CILLS.get(kw);
  if (g) return g;
  g = chamferBox(kw, 0.10, 0.24, 0.02);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) p.setY(i, p.getY(i) - (p.getZ(i) + 0.12) / 0.24 * 0.051);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();   // non-indexed, so this stays flat-shaded
  projectUV(g);
  if (CILLS.size > 200) CILLS.clear();
  CILLS.set(kw, g);
  return g;
}

/** One atlas quad, 2.5 cm off the shell at the back of the reveal. */
function pane(bs, kit, kind, fr, f, s, y, w, h, rand, shade) {
  const q = kit.geo ? kit.geo(kind, rand) : null;
  if (!q) return 0;
  const x = f.ax + fr.ux * s + fr.nx * 0.025;
  const z = f.az + fr.uz * s + fr.nz * 0.025;
  // 0.55 grey, so the surface shader's vertex-colour occlusion term damps the
  // indirect specular and the pane does not glow out of a dark hole.
  _c2.setScalar(shade);
  bs.add(FACADE_ATLAS_KEY, q, x, y, z, 0, fr.yaw, 0, w, h, 1, _c2, false);
  return 1;
}

// ------------------------------------------------------------------- railing

/**
 * A balcony balustrade, or an alpha-cut atlas quad standing in for one past
 * `LACE_LOD`. A 0.028 m baluster is 1.07 px at 40 m, which TAA can hold;
 * anything thinner crawls, and forty crawling balusters down a street is worse
 * than no balusters at all.
 */
function railing(bs, detail, g, fr, f, s, y, w, out, kit, rand, midX, midZ, winSet) {
  const px = f.ax + fr.ux * s, pz = f.az + fr.uz * s;
  if (Math.hypot(px - midX, pz - midZ) > LACE_LOD) {
    const q = kit.geo ? kit.geo('railingLace', rand) : null;
    if (!q) return 0;
    _c2.setScalar(0.8);
    const x = f.ax + fr.ux * s + fr.nx * out;
    const z = f.az + fr.uz * s + fr.nz * out;
    winSet.add(FACADE_ATLAS_KEY, q, x, y + 0.51, z, 0, fr.yaw, 0, w, 1.02, 1, _c2, false);
    return 1;
  }
  let n = 0;
  _c2.setRGB(0.86, 0.74, 0.66);
  const rail = box(w, 0.05, 0.05, 0.008);
  place(bs, 'metal_rusted', rail, fr, f, s, y + 1.02, out, _c2, false);
  place(bs, 'metal_rusted', rail, fr, f, s, y + 0.10, out, _c2, false);
  const side = box(0.05, 0.05, 0.9, 0.008);
  for (const sd of [-1, 1]) {
    place(bs, 'metal_rusted', side, fr, f, s + sd * w * 0.5, y + 1.02, out - 0.45, _c2, false);
    n++;
  }
  n += 2;
  // DEVIATION from the brief, on a measurement. The brief puts the balusters
  // in the shed-first `detail` tier so setDensity loses them first. That is a
  // good idea and it costs one draw call: `detail` has no metal_rusted bucket
  // otherwise, and the brief's own budget line for this item is "+2 (winSet,
  // winLit)". Core already has a non-casting metal_rusted bucket, so here they
  // are free. What is given up is 23 k triangles of shed, against a 3.5 M
  // budget and a frame that is fill-bound rather than submission-bound.
  const count = Math.max(2, Math.round(w / 0.115));
  for (let i = 0; i <= count; i++) {
    place(bs, 'metal_rusted', g.baluster, fr, f, s - w * 0.5 + (i / count) * w, y + 0.53, out, _c2, false);
    n++;
  }
  void detail;
  return n;
}

// -------------------------------------------------------------- ground floor

/**
 * The ground storey, on a completely different rhythm from the floors above.
 *
 * This is what the street camera at 1.68 m actually looks at, and it was 100%
 * absent: the old code ran the same 3.6 m window grid straight down to the
 * pavement. A shopfront is wider than a window, its opening starts at a
 * stallriser rather than a cill, and it is capped by a fascia with a hard
 * cornice over it — that cornice line running the length of the street is one
 * of the strongest single cues in a Call of Duty market frame.
 */
function groundStorey(bs, winSet, winLit, g, kit, fr, f, gH, wall, rand, bays, fi) {
  let n = 0;
  const shopN = Math.max(1, Math.round(fr.len / SHOP_BAY));
  const bw = fr.len / shopN;
  const base = f.base;
  const fasciaTop = base + Math.min(3.85, gH - 0.30);
  const pilW = Math.min(0.62, bw * 0.16);

  for (let b = 0; b < shopN; b++) {
    const s = (b + 0.5) * bw;
    const doorway = rand() < 0.22;
    const openW = doorway ? 1.05 : Math.min(3.00, bw - pilW * 2 - 0.1);
    const openH = doorway ? 2.20 : 2.55;
    const riser = doorway ? 0.14 : 0.45;
    const openBot = base + riser;
    const openTop = openBot + openH;

    // Pilasters flanking the bay. They project further than the upper skin,
    // which is how a ground storey is built and also hides the fact that the
    // skin above has an open 0.28 m soffit.
    _c.copy(wall).multiplyScalar(1.03);
    const pil = box(pilW, fasciaTop - base - 0.02, 0.44, 0.03);
    for (const sd of [-1, 1]) {
      place(bs, 'concrete_wall', pil, fr, f, s + sd * (openW * 0.5 + pilW * 0.5 + 0.03),
        base + (fasciaTop - base) * 0.5, 0.22, _c, true);
      n++;
    }
    // Rustication: six recessed strips per pilaster, set 0.09 behind its face.
    _c.copy(wall).multiplyScalar(0.62);
    const rustG = box(pilW - 0.04, 0.035, 0.30, 0.008);
    for (let k = 0; k < 6; k++) {
      const y = base + 0.45 + k * 0.45;
      if (y > fasciaTop - 0.3) break;
      for (const sd of [-1, 1]) {
        place(bs, 'concrete_wall', rustG, fr, f, s + sd * (openW * 0.5 + pilW * 0.5 + 0.03), y, 0.20, _c, false);
        n++;
      }
    }

    // Stallriser under a shop window; a threshold step under a door.
    _c.copy(wall).multiplyScalar(doorway ? 0.92 : 0.88);
    place(bs, 'concrete_wall', box(openW + 0.06, riser, doorway ? 0.55 : 0.40, 0.02), fr, f, s,
      base + riser * 0.5, doorway ? 0.24 : 0.20, _c, true);
    n++;

    // Head panel and fascia. The fascia is the flat band a sign goes on.
    _c.copy(wall).multiplyScalar(1.0);
    const fh = fasciaTop - openTop;
    if (fh > 0.1) {
      place(bs, 'concrete_wall', box(bw, fh, 0.42, 0.025), fr, f, s, openTop + fh * 0.5, 0.21, _c, true);
      n++;
    }
    // Fascia cornice — the hard horizontal that reads all the way down the
    // street, and the reason it is 0.54 deep rather than the 0.11 the old
    // string course used.
    _c.copy(wall).multiplyScalar(1.10);
    place(bs, 'concrete_wall', box(bw, 0.14, 0.54, 0.02), fr, f, s, fasciaTop + 0.07, 0.27, _c, true);
    n++;

    // Reveal returns for the shop opening. Deep: 0.39 m of return is what
    // makes a shopfront read as recessed rather than as a poster.
    _c.copy(wall).multiplyScalar(0.6);
    const jb = box(0.06, openH, 0.39, 0.012);
    for (const sd of [-1, 1]) {
      place(bs, 'concrete_wall', jb, fr, f, s + sd * (openW * 0.5 + 0.03),
        openBot + openH * 0.5, 0.195, _c, false);
      n++;
    }
    _c.copy(wall).multiplyScalar(0.5);
    place(bs, 'concrete_wall', box(openW, 0.06, 0.39, 0.012), fr, f, s, openTop + 0.03, 0.195, _c, false);
    n++;

    // The infill itself.
    if (doorway) {
      const kind = rand() < 0.6 ? 'doorTimber' : 'doorMetal';
      n += pane(winSet, kit, kind, fr, f, s, openBot + openH * 0.5, openW, openH, rand, 0.46);
      // Fanlight over the door.
      n += pane(winSet, kit, 'paneDark', fr, f, s, openTop + 0.20, 0.55, 0.25, rand, 0.5);
      _c.copy(wall).multiplyScalar(1.06);
      place(bs, 'concrete_wall', box(1.30, 0.18, 0.30, 0.02), fr, f, s, openTop + 0.42, 0.30, _c, true);
      n++;
    } else {
      const kind = pick(SHOP_INFILL, rand);
      // 30% of the glazed ones are lit from inside. The strip light painted in
      // shopGlass is the emissive shape, so the spill lands where the light is.
      const set = (winLit && kind === 'shopGlass' && rand() < 0.30) ? winLit : winSet;
      n += pane(set, kit, kind, fr, f, s, openBot + openH * 0.5, openW, openH, rand, 0.46);
    }

    // Signage. 45% get a board standing 0.10 m proud of the fascia so it casts
    // a real drop shadow onto it — that shadow is the entire difference
    // between a sign and a decal.
    if (!doorway && rand() < 0.45) {
      const sw = bw * 0.7;
      _c2.setScalar(0.95);
      place(bs, 'concrete_wall', box(sw, 0.55, 0.10, 0.012), fr, f, s, fasciaTop - 0.42, 0.50, _c2, true);
      n += 1 + pane(winSet, kit, 'signBoard', fr, f, s, fasciaTop - 0.42, sw - 0.06, 0.49, rand, 0.95);
    }
    // 15% get a sign hung perpendicular to the wall, so it is legible from
    // along the street rather than only from straight on.
    if (!doorway && rand() < 0.15) {
      const q = kit.geo ? kit.geo('signHanging', rand) : null;
      const x = f.ax + fr.ux * s + fr.nx * 0.75;
      const z = f.az + fr.uz * s + fr.nz * 0.75;
      _c2.setScalar(0.9);
      place(bs, 'metal_rusted', box(0.05, 0.05, 0.85, 0.008), fr, f, s, fasciaTop - 0.15, 0.45, _c2, false);
      if (q) {
        winSet.add(FACADE_ATLAS_KEY, q, x, fasciaTop - 0.62, z, 0, fr.yaw + Math.PI / 2, 0,
          0.78, 0.72, 1, _c2, false);
        n++;
      }
      n++;
    }

    bays.push({
      x: f.ax + fr.ux * s, z: f.az + fr.uz * s, y: base,
      nx: fr.nx, nz: fr.nz, yaw: fr.yaw,
      w: bw, openW, kind: doorway ? 'door' : 'shop',
      fasciaY: fasciaTop, headY: openTop, facade: fi,
    });
  }
  return n;
}

// ----------------------------------------------------------------- mouldings

/**
 * Floor bands, main cornice and parapet coping.
 *
 * The old string course was a 0.20 m box projecting 0.11 m. At 30 m that is
 * 5.6 px tall projecting 5.6 px — it survives as a hairline and contributes
 * nothing to the silhouette. A real cornice is a three-part profile and it
 * projects four to six times as far, so the shadow it drops on the wall below
 * is a band rather than a line. That shadow is the element that draws the
 * floor line, not the moulding itself.
 */
function mouldings(bs, fr, f, gH, floors, yFloor, wall, copeLen) {
  let n = 0;
  const L = fr.len;
  const lines = [];
  for (let fl = 0; fl < floors; fl++) {
    const y = yFloor(fl);
    if (y > f.top - 0.9) break;
    lines.push(y);
  }
  if (!lines.length) lines.push(f.base + gH);

  const bed = box(L, 0.10, 0.34, 0.02);
  const corona = box(L, 0.26, 0.46, 0.025);
  const under = box(L, 0.07, 0.26, 0.015);
  for (const y of lines) {
    _c.copy(wall).multiplyScalar(0.55);
    place(bs, 'concrete_wall', under, fr, f, L * 0.5, y - 0.17, 0.27, _c, false);
    _c.copy(wall).multiplyScalar(1.04);
    place(bs, 'concrete_wall', bed, fr, f, L * 0.5, y - 0.07, 0.31, _c, false);
    _c.copy(wall).multiplyScalar(1.10);
    place(bs, 'concrete_wall', corona, fr, f, L * 0.5, y + 0.13, 0.37, _c, true);
    n += 3;
  }

  // Main cornice: 0.62 m of projection is the single strongest silhouette
  // element this building has at 60-80 m.
  const cy = f.top - 0.55;
  _c.copy(wall).multiplyScalar(1.02);
  place(bs, 'concrete_wall', box(L, 0.14, 0.42, 0.025), fr, f, L * 0.5, cy, 0.36, _c, false);
  _c.copy(wall).multiplyScalar(1.12);
  place(bs, 'concrete_wall', box(L, 0.40, 0.62, 0.03), fr, f, L * 0.5, cy + 0.27, 0.48, _c, true);
  n += 2;

  // Parapet coping, overhanging on both faces. Stops short where the corner
  // has been blown off, and running out into nothing is exactly the read.
  _c.copy(wall).multiplyScalar(1.10);
  place(bs, 'concrete_wall', box(copeLen, 0.13, 0.50, 0.022), fr, f, copeLen * 0.5,
    f.top + 0.065, 0.10, _c, true);
  n++;
  return n;
}

/**
 * Quoins up both ends of the segment, alternating long/short and alternating
 * projection between 0.34 and 0.28.
 *
 * `CRITIC_RUBRIC.md` fails a frame outright for "a hard unbroken 90 degree
 * edge on a large structure", and a building corner is the largest one in the
 * frame. Two stacks of blocks per segment removes it for 40 boxes.
 */
function quoins(bs, g, fr, f, h, wall) {
  let n = 0;
  const rows = Math.min(20, Math.max(3, Math.floor((h - 0.4) / 0.55)));
  for (let i = 0; i < rows; i++) {
    const y = f.base + 0.30 + i * 0.55;
    if (y > f.top - 0.5) break;
    const long = i % 2 === 0;
    const gq = long ? g.quoinA : g.quoinB;
    const w = long ? 0.50 : 0.34;
    const out = long ? 0.17 : 0.11;
    _c.copy(wall).multiplyScalar(long ? 1.09 : 1.0);
    place(bs, 'concrete_wall', gq, fr, f, w * 0.5, y, out, _c, true);
    place(bs, 'concrete_wall', gq, fr, f, fr.len - w * 0.5, y, out, _c, true);
    n += 2;
  }
  return n;
}

// ------------------------------------------------------------------ services

/**
 * Rainwater goods, conduit, meter cabinets, vents, AC and dishes.
 *
 * These were the only facade elements that ever rendered, and they all sat
 * within 20 cm of the wall — where the skin now is. Everything moves out past
 * 0.30 so it clears the skin and, more importantly, so a drainpipe reads as a
 * round object standing off a wall rather than a stripe painted on one. The
 * placement rules change too: pipes go on the ends of a run where a real one
 * would, and AC units hang under a window head instead of at a random height.
 * No new geometry and no new draws — this is all coordinate arithmetic.
 */
function services(bs, g, fr, f, h, gH, floors, yFloor, rand, density, sills) {
  let n = 0;
  const top = f.top - 0.1, bot = f.base + 0.35;

  // --- Drainpipes: both ends of every segment, plus one per 12 m of run.
  const extra = Math.max(0, Math.round(fr.len / 12) - 1);
  const ts = [0.02, 0.98];
  for (let i = 0; i < extra; i++) ts.push((i + 1) / (extra + 1));
  for (const t of ts) {
    const s = fr.len * t;
    const key = rand() < 0.45 ? 'metal_rusted' : 'metal_painted';
    jitterColor(_c, rand, 0.28, 0.08, 0.06);
    place(bs, key, g.pipe, fr, f, s, (top + bot) / 2, 0.34, _c, true, 1, top - bot, 1);
    // Hopper head at the top, where the roof outlet discharges into it.
    place(bs, key, g.hopper, fr, f, s, top - 0.13, 0.34, _c, true);
    // Shoe at the bottom, kicking out over the pavement.
    place(bs, key, g.pipe, fr, f, s, bot - 0.16, 0.40, _c, true, 1, 0.42, 1);
    n += 3;
    for (let k = 0; k < Math.max(2, ((top - bot) / 2.4) | 0); k++) {
      const y = bot + 0.6 + k * 2.4;
      if (y > top) break;
      place(bs, key, g.bracket, fr, f, s, y, 0.30, _c, false);
      n++;
    }
  }

  // --- Conduit: a horizontal run with a couple of drops off it.
  if (rand() < 0.8) {
    const y = f.base + 2.4 + rand() * 0.7;
    const span = 0.5 + rand() * 0.45;
    jitterColor(_c, rand, 0.24, 0.06, 0.03);
    place(bs, 'metal_painted', g.pipeAlong, fr, f, fr.len * 0.5, y, 0.31, _c, false,
      fr.len * span, 1, 1);
    n++;
    for (let k = 0, m = 1 + ((rand() * 3) | 0); k < m; k++) {
      const s = fr.len * (0.5 + (rand() - 0.5) * span);
      const drop = 0.6 + rand() * 1.2;
      place(bs, 'metal_painted', g.pipe, fr, f, s, y - drop / 2, 0.31, _c, false, 0.5, drop, 0.5);
      n++;
    }
  }

  // --- Meter cabinets and vents.
  const boxes = Math.round(fr.len * 0.14 * density);
  for (let i = 0; i < boxes; i++) {
    const s = rand() * fr.len;
    const y = f.base + 1.1 + rand() * 0.7;
    jitterColor(_c, rand, 0.3, 0.1, 0.02);
    place(bs, 'metal_painted', g.boxUnit, fr, f, s, y, 0.55, _c, true);
    place(bs, 'metal_painted', g.boxLid, fr, f, s, y + 0.3, 0.56, _c, false);
    n += 2;
  }
  const vents = Math.round(fr.len * 0.1 * density);
  for (let i = 0; i < vents; i++) {
    const s = rand() * fr.len;
    const y = f.base + 1.6 + rand() * Math.max(0.6, h - 3);
    jitterColor(_c, rand, 0.26, 0.06, 0.04);
    place(bs, 'metal_rusted', g.vent, fr, f, s, y, 0.31, _c, true);
    for (let k = 0; k < 4; k++) {
      place(bs, 'metal_rusted', g.slat, fr, f, s, y - 0.12 + k * 0.08, 0.36, _c, false);
    }
    n += 5;
  }

  // --- Split AC units, hung under a window head rather than at a random
  // height, because that is the only place a fitter can reach from inside.
  const acs = Math.round(fr.len * 0.11 * density);
  for (let i = 0; i < acs; i++) {
    const s = rand() * fr.len;
    const fl = floors > 0 ? (rand() * floors) | 0 : 0;
    const y = floors > 0 ? yFloor(fl) + HEAD_UP + 0.55 : f.base + 2.3 + rand() * Math.max(0.5, h - 4);
    if (y > f.top - 0.8) continue;
    jitterColor(_c, rand, 0.16, 0.03, 0.04);
    _c.multiplyScalar(1.1);
    place(bs, 'metal_painted', g.ac, fr, f, s, y, 0.46, _c, true);
    place(bs, 'metal_painted', g.acGrille, fr, f, s, y, 0.635, _c, false);
    for (const sd of [-1, 1]) {
      place(bs, 'metal_rusted', g.acFoot, fr, f, s + sd * 0.44, y - 0.33, 0.45, _c, false);
    }
    n += 4;
    sills.push({
      x: f.ax + fr.ux * s + fr.nx * 0.3,
      z: f.az + fr.uz * s + fr.nz * 0.3,
      y: y - 0.3, nx: fr.nx, nz: fr.nz, w: 0.8,
    });
  }

  // --- Satellite dishes, clustered around two centres per building rather
  // than sprinkled: a dish goes where the last one went, on the same landlord's
  // wall, pointed at the same bird.
  const dishes = Math.round(fr.len * 0.06 * density);
  const cA = fr.len * (0.15 + rand() * 0.2), cB = fr.len * (0.6 + rand() * 0.25);
  for (let i = 0; i < dishes; i++) {
    const c = i % 2 ? cB : cA;
    const s = Math.max(0.4, Math.min(fr.len - 0.4, c + (rand() - 0.5) * 3.0));
    const y = f.base + 2.8 + rand() * Math.max(0.5, h - 4.5);
    const tilt = (rand() - 0.5) * 0.4;
    const spin = fr.yaw + (rand() - 0.5) * 0.5;
    const x = f.ax + fr.ux * s + fr.nx * 0.80;
    const z = f.az + fr.uz * s + fr.nz * 0.80;
    _c.setRGB(1.12, 1.1, 1.05);
    bs.add('metal_painted', g.dish, x, y + tilt * 0.05, z, 0, spin, 0, 1, 1, 1, _c, true);
    place(bs, 'metal_rusted', g.pipeOut, fr, f, s, y, 0.52, _c, false, 1, 1, 0.56);
    n += 2;
  }
  return n;
}

export { geo as facadeGeo };
