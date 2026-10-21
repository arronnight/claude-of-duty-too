import * as THREE from 'three';
import { chamferBox, pipeGeo, projectUV, jitterColor, bedGeo, wearEdges, twoSided } from './lib.js';
import { tintFor } from './overhead.js';

/**
 * The fine vertical dressing the street has literally none of.
 *
 * Look at bo6_03 or bo6_05 next to street.png and the difference that reads
 * first is not material quality, it is that the reference frames are full of
 * THIN REPEATED VERTICALS — guardrail infill, bollards, sign posts, planter
 * stems — at a spacing of 15 to 30 cm, and ours has nothing between the
 * ground plane and the facade. Repetition at that pitch is what a real street
 * kerb looks like, it is what gives the eye a scale reference, and it is very
 * nearly free: every part here lands in a `metal_painted`, `concrete_wall`,
 * `wood_plank` or `metal_rusted` bucket that the core set has already opened,
 * and `BatchSet` merges by material x zone x shadow, so a ninety-part
 * guardrail run costs exactly what one bollard costs. Nothing.
 *
 * Placement is against the survey's kerb steps, which is the one field that
 * knows where a pavement edge is without knowing any map coordinate.
 */

const _c = new THREE.Color();
const _w = new THREE.Color();
const BASE_METAL_PAINTED = new THREE.Color(0x59666b);
const BASE_CONCRETE = new THREE.Color(0x9a958c);

let G = null;
function geo() {
  if (G) return G;
  const cb = chamferBox;
  G = {
    // Guardrail. 0.11 m OD top rail, 0.016 m infill, 0.06 m posts.
    railTop: pipeGeo(0.055, 1, 8, false).rotateZ(Math.PI / 2),
    railMid: pipeGeo(0.020, 1, 6, false).rotateZ(Math.PI / 2),
    infill: pipeGeo(0.008, 1, 5, false),
    post: pipeGeo(0.030, 1, 8, false),
    postBase: cb(0.20, 0.10, 0.12, 0.020),

    // Bollard.
    bollard: pipeGeo(0.045, 1.00, 10, false),
    bollardCap: (() => {
      const g = new THREE.SphereGeometry(0.045, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      projectUV(g);
      return g;
    })(),
    band: pipeGeo(0.048, 0.04, 10, false),

    // Planter. 0.020-0.030 chamfer on concrete, per the readability minimum:
    // one pixel is 4.4 mm at 5 m, so a chamfer needs 8 mm to read at all and
    // concrete arrises are much coarser than that in reality anyway.
    planter: cb(1.20, 0.55, 0.55, 0.026),
    planterLip: cb(1.26, 0.06, 0.61, 0.026),
    soil: cb(1.06, 0.06, 0.41, 0.010),
    leafCard: (() => {
      const g = new THREE.PlaneGeometry(0.42, 0.52, 1, 2);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        // Bow the card so a crossed pair does not read as a flat X.
        const v = p.getY(i) / 0.52 + 0.5;
        p.setZ(i, 0.05 * Math.sin(v * Math.PI));
      }
      g.computeVertexNormals();
      g.translate(0, 0.26, 0);
      return twoSided(g);
    })(),
    flower: new THREE.SphereGeometry(0.035, 6, 4),

    // Signs.
    signPost: pipeGeo(0.030, 2.20, 8, false),
    signRound: pipeGeo(0.225, 0.022, 14, true, 0.006).rotateX(Math.PI / 2),
    signTri: (() => {
      const g = new THREE.CylinderGeometry(0.29, 0.29, 0.022, 3);
      g.rotateX(Math.PI / 2);
      g.rotateZ(Math.PI);
      projectUV(g);
      return g;
    })(),
    timberPost: cb(0.09, 1.70, 0.09, 0.012),
    handBoard: cb(0.86, 0.34, 0.026, 0.012),
  };
  wearEdges(G.postBase, 0xbdb6a8, 0.30, null);
  wearEdges(G.planter, 0xbdb6a8, 0.30, null);
  wearEdges(G.planterLip, 0xbdb6a8, 0.30, null);
  wearEdges(G.timberPost, 0x6a4d33, 0.60, null);
  wearEdges(G.handBoard, 0x6a4d33, 0.60, null);
  return G;
}

/**
 * Kerb runs: contiguous strips of pavement cell that sit next to a height
 * step, walked in grid order and turned into straight segments.
 *
 * `site.step` is the biggest height difference from a cell to its four
 * neighbours, so a value over 6 cm is a kerb face, a doorstep or the lip of a
 * platform — all of them places a real street puts a railing.
 */
function kerbRuns(site, minLen) {
  const runs = [];
  let seen = null;
  const cell = (ix, iz) => {
    if (!site.inside(ix, iz)) return -1;
    const i = site.index(ix, iz);
    return site.open[i] && site.step[i] > 0.06 && site.dist[i] > 0.8 ? i : -1;
  };
  // One visited map PER DIRECTION. Sharing it was a real bug: the X sweep ran
  // first, chopped every kerb cell in the map into 1-2 cell runs that were
  // then rejected for being too short, and left the whole grid marked visited,
  // so the Z sweep — which is the one that finds the long kerbs down the main
  // street — found nothing. Measured: 2 runs, both at the far map edge.
  for (const [sx, sz] of [[1, 0], [0, 1]]) {
    seen = new Uint8Array(site.open.length);
    for (let iz = 0; iz < site.nz; iz++) {
      for (let ix = 0; ix < site.nx; ix++) {
        if (cell(ix, iz) < 0) continue;
        const i0 = site.index(ix, iz);
        if (seen[i0]) continue;
        let jx = ix, jz = iz, len = 0;
        while (cell(jx, jz) >= 0 && !seen[site.index(jx, jz)]) {
          seen[site.index(jx, jz)] = 1;
          len++; jx += sx; jz += sz;
        }
        if (len < minLen) continue;
        runs.push({
          ax: site.xOf(ix), az: site.zOf(iz),
          bx: site.xOf(jx - sx), bz: site.zOf(jz - sz),
          len: Math.hypot(site.xOf(jx - sx) - site.xOf(ix), site.zOf(jz - sz) - site.zOf(iz)),
          y: site.gy[i0],
        });
      }
    }
  }
  runs.sort((a, b) => b.len - a.len);
  // The two sweeps can both claim the same corner, so keep runs whose
  // midpoints are at least 4 m apart. Without this the longest three are
  // sometimes one kerb described three ways, and three guardrails land on top
  // of each other.
  const kept = [];
  for (const r of runs) {
    const mx = (r.ax + r.bx) / 2, mz = (r.az + r.bz) / 2;
    if (kept.some((k) => Math.hypot((k.ax + k.bx) / 2 - mx, (k.az + k.bz) / 2 - mz) < 4)) continue;
    kept.push(r);
  }
  return kept;
}

/** Pedestrian guardrail: posts, a top rail, a mid rail and 0.15 m infill. */
function guardrail(bs, site, rand, r, frac) {
  const g = geo();
  const ux = (r.bx - r.ax) / r.len, uz = (r.bz - r.az) / r.len;
  const yaw = Math.atan2(ux, uz);
  const L = Math.min(14, r.len);
  // Start somewhere along the run rather than always at its first cell. The
  // longest kerb on this map is the whole 102 m street, and anchoring at s = 0
  // put every railing at the far end of it, in the fog.
  const s0 = (r.len - L) * frac;
  tintFor(_c, _w.set(0x8f9598), BASE_METAL_PAINTED, 2.6);
  const steel = _c.clone();
  let n = 0;
  const put = (key, gm, s0i, oy, sx, sy, sz, col, shadow) => {
    const s = s0 + s0i;
    const y = site.groundAt(r.ax + ux * s, r.az + uz * s);
    if (y === null) return;
    bs.bed(y);
    bs.addPitched(key, gm, r.ax + ux * s, y + oy, r.az + uz * s,
      yaw, 0, 0, sx, sy, sz, col, shadow);
    bs.bed(null);
    n++;
  };
  // Posts every 2 m in a concrete base.
  const posts = Math.max(2, Math.round(L / 2));
  for (let k = 0; k <= posts; k++) {
    const s = (k / posts) * L;
    put('metal_painted', g.post, s, 0.60, 1, 1.20, 1, steel, true);
    jitterColor(_c, rand, 0.12, 0.02, 0.02);
    put('concrete_wall', g.postBase, s, 0.05, 1, 1, 1, _c, false);
  }
  // Rails.
  const seg = Math.max(1, Math.round(L / 3));
  for (let k = 0; k < seg; k++) {
    const s = (k + 0.5) / seg * L;
    put('metal_painted', g.railTop, s, 1.10, L / seg * 1.02, 1, 1, steel, true);
    put('metal_painted', g.railMid, s, 0.44, L / seg * 1.02, 1, 1, steel, false);
  }
  // Infill every 0.15 m: this is the actual point of the whole prop.
  _c.copy(steel).multiplyScalar(0.94);
  const bars = Math.floor(L / 0.15);
  for (let k = 1; k < bars; k++) {
    put('metal_painted', g.infill, k * 0.15, 0.76, 1, 0.66, 1, _c, false);
  }
  return n;
}

/** Bollards down the pavement edge. */
function bollards(bs, site, rand, r, count) {
  const g = geo();
  const ux = (r.bx - r.ax) / r.len, uz = (r.bz - r.az) / r.len;
  let n = 0;
  for (let k = 0; k < count; k++) {
    const s = 0.6 + k * 1.8;
    if (s > r.len) break;
    const x = r.ax + ux * s, z = r.az + uz * s;
    const y = site.groundAt(x, z);
    if (y === null || !site.free(x, z, 0.25)) continue;
    site.occupy(x, z, 0.22);
    tintFor(_c, _w.set(0x2c3236), BASE_METAL_PAINTED, 1.6);
    _c.multiplyScalar(0.9 + rand() * 0.2);
    const tilt = (rand() - 0.5) * 0.06;
    bs.bed(y);
    bs.addPitched('metal_painted', g.bollard, x, y + 0.50, z, 0, tilt, tilt * 0.5, 1, 1, 1, _c, true);
    bs.addPitched('metal_painted', g.bollardCap, x, y + 1.00, z, 0, tilt, 0, 1, 1, 1, _c, false);
    // The reflective band is the reason a bollard reads at 30 m: it is the
    // only high-value horizontal in an otherwise dark vertical.
    tintFor(_c, _w.set(0xd8d2c4), BASE_METAL_PAINTED, 2.8);
    bs.addPitched('metal_painted', g.band, x, y + 0.85, z, 0, tilt, 0, 1, 1, 1, _c, false);
    bs.bed(null);
    n += 3;
  }
  return n;
}

/** A concrete planter with a shrub in it — the one green accent in the street. */
function planter(bs, leaves, site, rand, x, y, z, yaw) {
  const g = geo();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  let n = 0;
  bs.bed(y);
  const put = (key, gm, ox, oy, oz, sx, sy, sz, col, shadow) =>
    bs.addPitched(key, gm, x + ox * c + oz * s, y + oy, z - ox * s + oz * c,
      yaw, 0, 0, sx, sy, sz, col, shadow);
  jitterColor(_c, rand, 0.14, 0.03, 0.03);
  const stone = _c.clone();
  put('concrete_wall', g.planter, 0, 0.275, 0, 1, 1, 1, stone, true);
  _c.copy(stone).multiplyScalar(1.06);
  put('concrete_wall', g.planterLip, 0, 0.545, 0, 1, 1, 1, _c, true);
  n += 2;
  tintFor(_c, _w.set(0x2e2519), BASE_CONCRETE, 1.4);
  put('concrete_floor', g.soil, 0, 0.49, 0, 1, 1, 1, _c, false);
  n++;
  bs.bed(null);

  // Crossed alpha cards on the existing foliage key, which already carries
  // translucency and alphaTest, so a leaf lit from behind glows.
  //
  // These go to the DETAIL set rather than to core. `foliage` is a key nothing
  // else in the prop system uses, so it opens a bucket wherever it lands, and
  // core is zoned — two zones, two draws. `detail` is un-zoned and never casts
  // shadow, so the whole map's greenery is one draw, and it is also the right
  // tier: a shrub is the first thing that should go on a weak GPU.
  for (let k = 0, m = 5 + ((rand() * 4) | 0); k < m; k++) {
    const ox = (rand() - 0.5) * 0.9, oz = (rand() - 0.5) * 0.32;
    const sc = 0.75 + rand() * 0.5;
    const spin = rand() * 3.14;
    jitterColor(_c, rand, 0.26, 0.06, -0.1);
    for (const a of [0, 1.05, 2.1]) {
      leaves.addPitched('foliage', g.leafCard, x + ox * c + oz * s, y + 0.52,
        z - ox * s + oz * c, yaw + spin + a, 0, 0, sc, sc, sc, _c, false);
      n++;
    }
  }
  for (let k = 0, m = 3 + ((rand() * 3) | 0); k < m; k++) {
    tintFor(_c, _w.set(rand() < 0.5 ? 0x8a4fa8 : 0xc25a2a), BASE_CONCRETE, 2.6);
    put('concrete_floor', g.flower, (rand() - 0.5) * 0.9, 0.62 + rand() * 0.28,
      (rand() - 0.5) * 0.3, 1, 1, 1, _c, false);
    n++;
  }
  return n;
}

/** Traffic sign, or a leaning splintered hand-painted board. */
function signPost(bs, site, rand, x, y, z, yaw) {
  const g = geo();
  let n = 0;
  bs.bed(y);
  if (rand() < 0.7) {
    tintFor(_c, _w.set(0x8f9598), BASE_METAL_PAINTED, 2.5);
    const tilt = (rand() - 0.5) * 0.05;
    bs.addPitched('metal_painted', g.signPost, x, y + 1.10, z, yaw, tilt, 0, 1, 1, 1, _c, true);
    const round = rand() < 0.6;
    tintFor(_c, _w.set(round ? 0xb8443a : 0xd8d2c4), BASE_METAL_PAINTED, 2.6);
    bs.addPitched('metal_painted', round ? g.signRound : g.signTri,
      x, y + 2.05, z, yaw, 0, 0, 1, 1, 1, _c, true);
    n += 2;
  } else {
    // mw3_04 has exactly this: a hand-painted board on a timber post, leaning.
    jitterColor(_c, rand, 0.24, 0.07, 0.06);
    const lean = 0.10 + rand() * 0.10;
    bs.addPitched('wood_plank', g.timberPost, x, y + 0.84, z, yaw, lean, 0, 1, 1, 1, _c, true);
    _c.multiplyScalar(1.14);
    bs.addPitched('wood_plank', g.handBoard, x + Math.sin(yaw) * 0.02, y + 1.44, z,
      yaw, lean, (rand() - 0.5) * 0.12, 1, 1, 1, _c, true);
    n += 2;
  }
  bs.bed(null);
  return n;
}

/**
 * The module Props resolves through `import.meta.glob`.
 *
 * @param {object} core the core BatchSet — every part here reuses one of its
 *   existing material buckets, so the whole module is zero extra draws except
 *   for `foliage`, which the planters need and which nothing else in the prop
 *   system has opened.
 */
export function streetside(ctx, site, core, rand, density = 1, env = null) {
  const bs = core || env?.core;
  if (!bs || !site?.step) return { parts: 0 };
  geo();
  let parts = 0;

  const runs = kerbRuns(site, 8);
  if (globalThis.window) window.__SSDBG__ = { runs: runs.slice(0, 6) };
  // Two or three guardrail runs, on the longest kerbs available.
  const nRail = Math.min(runs.length, Math.max(2, Math.round(3 * density)));
  for (let i = 0; i < nRail; i++) parts += guardrail(bs, site, rand, runs[i], 0.32 + i * 0.24);
  // Bollards on the next kerbs along, so the two do not fight for the same
  // metre of pavement.
  for (let i = nRail; i < Math.min(runs.length, nRail + 3); i++) {
    parts += bollards(bs, site, rand, runs[i], 8 + ((rand() * 7) | 0));
  }

  // Planters and signs against facades, where street furniture actually goes.
  const edge = site.field((d, corner, surf, x, z, indoor) =>
    (d < 1.0 || d > 3.0 || indoor ? 0 : 1));
  const spot = (r, tries) => {
    for (let i = 0; i < tries; i++) {
      const p = edge.sample(rand);
      if (!p) return null;
      if (!site.free(p.x, p.z, r)) continue;
      site.occupy(p.x, p.z, r);
      return p;
    }
    return null;
  };
  for (let i = 0, k = Math.round(4 * density); i < k; i++) {
    const p = spot(0.9, 30);
    if (!p) break;
    parts += planter(bs, env?.detail || bs, site, rand, p.x, p.y, p.z,
      (p.nx || p.nz) ? Math.atan2(p.nx, p.nz) + Math.PI / 2 : rand() * 6.2832);
  }
  for (let i = 0, k = Math.round(6 * density); i < k; i++) {
    const p = spot(0.4, 24);
    if (!p) break;
    parts += signPost(bs, site, rand, p.x, p.y, p.z,
      (p.nx || p.nz) ? Math.atan2(p.nx, p.nz) : rand() * 6.2832);
  }
  return { parts };
}

// `bedGeo` is applied per-instance through `BatchSet.bed`, which does the same
// job at merge time without cloning a geometry per piece.
void bedGeo;
