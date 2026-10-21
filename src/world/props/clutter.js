import * as THREE from 'three';
import {
  chamferBox, lumpGeo, shardGeo, splinterGeo, bentPlateGeo, pipeGeo,
  projectUV, jitterColor, hash3, bedGeo,
} from './lib.js';
import { wallFalloff } from './layout.js';
import { contactDecal, gritSeam, carriagewayAxis } from './decals.js';

/**
 * Ground clutter. The single highest-value thing in the whole content pass.
 *
 * `docs/CRITIC_RUBRIC.md` fails a frame outright when "the ground plane is
 * visible and empty for more than ~4 square metres", and every current shot
 * fails on exactly that. So this module puts roughly six thousand individual
 * pieces on the floor, and the two things that decide whether that reads as a
 * bombed district or as confetti are:
 *
 * **Silhouette variety.** One rock scaled randomly stays one rock — the eye
 * locks onto the repeated outline immediately. There are eleven distinct base
 * shapes here, each generated in six hash-seeded variants, so ~66 unique
 * outlines are in play before any transform is applied. They are merged rather
 * than instanced precisely because merging lets every piece be a different
 * shape for the same one draw call.
 *
 * **Distribution.** Debris is not uniform noise. It piles against wall bases,
 * silts into gutters and corners, and gets swept off the middle of a road that
 * is still driven on. That comes out of `Site`'s distance transform and step
 * channel rather than from hand placement, which is why the same code produces
 * a correct-looking result on a map it has never seen.
 */

const _c = new THREE.Color();
const _v = new THREE.Vector3();

// ------------------------------------------------------------------- shapes

/** n hash-seeded variants of a generator, built once and shared. */
function variants(n, make) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = make(i);
  return out;
}

function pick(list, rand) { return list[(rand() * list.length) | 0]; }

/** Longest horizontal axis of a pooled shape, at scale 1. */
function footprint(geo) {
  const bb = geo.boundingBox || (geo.computeBoundingBox(), geo.boundingBox);
  return Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
}

/**
 * Bends and twists a thin slab about its long axis. Sheet metal, card and
 * paper never lie flat, and a flat quad on the ground reads as a decal that
 * forgot to project.
 */
function warpSlab(geo, bend, twist, seed = 0) {
  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const hx = Math.max(1e-4, geo.boundingBox.max.x);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = x / hx;
    const a = twist * t;
    const ca = Math.cos(a), sa = Math.sin(a);
    const n = hash3(x * 5 + seed, z * 5, 0.3) - 0.5;
    pos.setY(i, y * ca - z * sa + bend * t * t + n * bend * 0.35);
    pos.setZ(i, y * sa + z * ca);
  }
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** A short length of reinforcing bar, bent where it tore out of the slab. */
function rebarGeo(len, r, seed) {
  const pts = [];
  const segs = 5;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const k = hash3(t * 9.1 + seed, seed * 1.7, 0.11) - 0.5;
    pts.push(new THREE.Vector3(
      (t - 0.5) * len,
      k * len * 0.16 + Math.sin(t * 2.4 + seed) * len * 0.09,
      (hash3(t * 3.3, seed, 0.7) - 0.5) * len * 0.12,
    ));
  }
  const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs * 2, r, 4, false);
  projectUV(geo);
  return geo;
}

/** A crushed drinks can: squashed cylinder with a dented waist. */
function canGeo(seed) {
  const geo = pipeGeo(0.033, 0.115, 7, true, 0.006);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = (y / 0.115) + 0.5;
    const crush = 0.42 + 0.5 * Math.abs(Math.sin(t * 4.2 + seed));
    const n = hash3(x * 30 + seed, y * 30, z * 30) - 0.5;
    pos.setX(i, x * crush + n * 0.006);
    pos.setZ(i, z * (0.78 + 0.3 * crush) + n * 0.004);
    pos.setY(i, y * 0.82);
  }
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** A fragment of curved clay roof tile. */
function roofTileGeo(w, l, seed) {
  const geo = new THREE.PlaneGeometry(l, w, 4, 3);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = y / w;
    pos.setZ(i, (0.25 - u * u) * w * 0.55);
    if (x > l * 0.22) pos.setX(i, x - (hash3(x * 7 + seed, y * 7, 0.9)) * l * 0.3);
  }
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** Shape pools. Built lazily so nothing is generated for a disabled tier. */
let POOL = null;
function pools() {
  if (POOL) return POOL;
  POOL = {
    // Angular concrete lumps — the workhorse.
    chunk: variants(7, (i) => lumpGeo(0.17, 0.62, [1, 0.62, 1.15], 0, i * 13 + 5)),
    chunkBig: variants(5, (i) => lumpGeo(0.4, 0.55, [1.15, 0.5, 0.95], 1, i * 29 + 11)),
    // Flat plates with one clean fracture face.
    slab: variants(5, (i) => shardGeo(0.62, 0.09, 0.44, () => hash3(i, 3, 7), 0.4)),
    slabSmall: variants(5, (i) => shardGeo(0.3, 0.055, 0.22, () => hash3(i, 5, 2), 0.45)),
    // Masonry.
    brick: variants(3, (i) => chamferBox(0.215, 0.065, 0.1025, 0.006 + i * 0.002)),
    brickHalf: variants(5, (i) => shardGeo(0.14, 0.065, 0.1025, () => hash3(i, 9, 1), 0.5)),
    plaster: variants(5, (i) => lumpGeo(0.13, 0.7, [1.3, 0.34, 1.1], 0, i * 7 + 2)),
    // Timber.
    splinter: variants(5, (i) => splinterGeo(0.5, 0.035, 0.05, () => hash3(i, 4, 8))),
    plank: variants(4, (i) => warpSlab(chamferBox(0.9 + i * 0.16, 0.026, 0.13, 0.005), 0.02, 0.16, i)),
    // Sheet goods.
    //
    // Paper is split in two because one pool cannot be both. A sheet that has
    // been rained on and driven over lies dead flat and is the overwhelmingly
    // common case; a dry scrap in a sheltered corner curls. The old single pool
    // was authored as the curled one (bend 0.035, twist 0.9), which bends its
    // facets steeply skyward — at 0.9 rad of twist across a 0.21 m sheet the
    // outer facets stand at nearly 26 degrees, catch close to full N.L against
    // a 0.12-linear road, and read as specular glints hovering over the tarmac.
    // That is the "floating white confetti" in street.png, and it is geometry,
    // not lighting.
    card: variants(5, (i) => warpSlab(chamferBox(0.42, 0.008, 0.32, 0.003), 0.03, 0.2, i * 3)),
    paperFlat: variants(4, (i) => warpSlab(chamferBox(0.21, 0.0025, 0.15, 0.001), 0.006, 0.10, i * 5 + 1)),
    paperCurl: variants(3, (i) => warpSlab(chamferBox(0.21, 0.0035, 0.15, 0.001), 0.06, 0.25, i * 7 + 3)),
    // Metal.
    twist: variants(5, (i) => warpSlab(chamferBox(0.52, 0.007, 0.24, 0.003), 0.11, 1.5, i * 11)),
    rebar: variants(5, (i) => rebarGeo(0.6 + i * 0.18, 0.011, i * 2.7)),
    can: variants(4, (i) => canGeo(i * 1.9)),
    // Ceramic.
    tile: variants(4, (i) => roofTileGeo(0.17, 0.28, i * 4.3)),
    // Organic litter. A leaf is the counter-example to the paper problem: same
    // footprint, dead flat, low albedo close to the ground's own value, and it
    // only ever appears in drifts. It rides the wood_plank bucket, so it is
    // zero new draws and zero new programs.
    leaf: variants(5, (i) => warpSlab(chamferBox(0.06, 0.0018, 0.035, 0.0005), 0.010, 0.35, i * 9 + 4)),
    // Grit.
    grit: variants(6, (i) => lumpGeo(0.038, 0.55, [1, 0.55, 1], 0, i * 17 + 3)),
    pebble: variants(5, (i) => lumpGeo(0.075, 0.6, [1, 0.6, 1.1], 0, i * 23 + 7)),
    // Mound cores. Detail 2 rather than 1: a heap is metres across and an
    // 80-triangle dome at that size shows every facet, and worse, gives the
    // shadow map enough normal variation across one texel to band.
    mound: variants(4, (i) => lumpGeo(1, 0.26, [1, 0.5, 0.9], 2, i * 31 + 13)),
  };
  bedPools();
  return POOL;
}

/**
 * Contact occlusion, baked once per shape, for free.
 *
 * A piece of debris with a uniform tint has no idea it is touching anything,
 * and that — not the shadow, which moves with the sun and disappears in shade —
 * is what makes scattered clutter read as stickers. `SurfaceShader.fragmentAO`
 * folds vertex-colour luminance into the *indirect* diffuse term as well as
 * into albedo, so a ramp written into the colour attribute correctly kills the
 * ambient on the underside of a piece under any sun direction, for three floats
 * a vertex that are already allocated. Zero fill cost, zero draws.
 *
 * Two deliberate choices:
 *
 * The ramp is normalised to *each shape's own height*, not to an absolute
 * distance. `BatchSet.bed()` exists and is world-space, which is strictly more
 * correct, but its ramp is fixed at 0.30 m — applied to a 40 mm grit chip that
 * multiplies the entire stone by 0.45 with no gradient at all, and the road
 * loses the bright speckle that stops asphalt reading as vinyl. Normalising by
 * height gives every piece the same *relative* contact darkening whatever its
 * size, which is what the eye is actually reading.
 *
 * The floor is relaxed for shapes that tumble. A sheet of card lands one way up
 * and its local -Y really is down; a concrete lump lands any way up, so the
 * baked gradient points in a random direction and has to read as tonal variety
 * rather than as contact. Flat kinds get the full 0.42; a fully tumbling kind
 * gets 0.64 and relies on its cast shadow and its contact decal instead.
 */
function bedPools() {
  for (const name of Object.keys(POOL)) {
    const k = KINDS[name];
    if (!k) continue;
    const floor = 0.42 + 0.22 * (1 - k.flat);
    for (const g of POOL[name]) {
      g.computeBoundingBox();
      const bb = g.boundingBox;
      const h = Math.max(1e-4, bb.max.y - bb.min.y);
      bedGeo(g, bb.min.y, h * 0.55, floor);
    }
  }
}

/**
 * Material per shape, how far its albedo is allowed to drift, and how it lands.
 *
 *   value/hue/warm  spread of the per-piece vertex tint — rule 5, no two the same
 *   tone            base multiplier on that tint. Masonry debris in a dusty
 *                   street is pale buff, and every generator here is authored
 *                   for a *surface*, which is uniformly darker than its own
 *                   spall. Without this every chunk reads as coal.
 *   flat            1 = lies down (a plank, a sheet), 0 = lands any way up
 *   h               nominal height in metres, so a piece can be bedded into the
 *                   ground by a fraction of its own size instead of floating
 *   lift            overrides the sink entirely: metres above nominal ground.
 *                   Only for sheet litter, which does not bury at all — see
 *                   `drop()` for why sinking it is actively wrong.
 * */
const KINDS = {
  chunk: { key: 'rubble', value: 0.3, hue: 0.05, warm: 0.06, tone: 1.34, flat: 0.25, h: 0.2, shadow: 1 },
  chunkBig: { key: 'rubble', value: 0.26, hue: 0.05, warm: 0.05, tone: 1.30, flat: 0.2, h: 0.42, shadow: 1 },
  slab: { key: 'concrete_floor', value: 0.24, hue: 0.03, warm: 0.03, tone: 1.26, flat: 0.85, h: 0.1, shadow: 1 },
  slabSmall: { key: 'concrete_floor', value: 0.26, hue: 0.04, warm: 0.03, tone: 1.26, flat: 0.8, h: 0.06, shadow: 1 },
  brick: { key: 'brick', value: 0.3, hue: 0.09, warm: 0.1, tone: 1.18, flat: 0.55, h: 0.07, shadow: 0 },
  brickHalf: { key: 'brick', value: 0.32, hue: 0.1, warm: 0.09, tone: 1.18, flat: 0.5, h: 0.07, shadow: 0 },
  plaster: { key: 'plaster', value: 0.28, hue: 0.04, warm: 0.07, tone: 1.05, flat: 0.75, h: 0.09, shadow: 0 },
  splinter: { key: 'wood_plank', value: 0.34, hue: 0.07, warm: 0.06, tone: 1.1, flat: 0.7, h: 0.05, shadow: 0 },
  plank: { key: 'wood_plank', value: 0.3, hue: 0.07, warm: 0.05, tone: 1.1, flat: 0.9, h: 0.03, shadow: 0 },
  card: { key: 'wood_plank', value: 0.3, hue: 0.06, warm: -0.04, tone: 1.05, flat: 0.96, h: 0.02, shadow: 0, lift: 0.006 },
  // tone 0.52, not 0.95. `plaster`'s albedo is 0xb4ada1 and a 0.95 multiplier
  // on it is a near-white scrap sitting at roughly 8:1 against a 0.12-linear
  // road. Street paper is grey and filthy; the target is sRGB #7d776e.
  // `lift` is 6 mm, not the 0.6 mm the analysis called for, and the reason is
  // the contact decal. A soft decal sits 1.5 mm off the surface; litter has to
  // clear it or the patch that is supposed to be grounding the scrap renders
  // over the top of it. 6 mm is under half a pixel at 5 m and it is the first
  // time in this file that flat litter has been unambiguously *above* the road
  // rather than sunk 8 mm into it and peering out from between the parallaxed
  // stone tops.
  paperFlat: { key: 'plaster', value: 0.24, hue: 0.02, warm: 0.07, tone: 0.52, flat: 0.99, h: 0.01, shadow: 0, lift: 0.006 },
  paperCurl: { key: 'plaster', value: 0.24, hue: 0.03, warm: 0.07, tone: 0.56, flat: 0.90, h: 0.02, shadow: 0, lift: 0.006 },
  leaf: { key: 'wood_plank', value: 0.30, hue: 0.16, warm: 0.14, tone: 1.22, flat: 0.98, h: 0.006, shadow: 0, lift: 0.004 },
  twist: { key: 'metal_rusted', value: 0.36, hue: 0.1, warm: 0.1, tone: 1.14, flat: 0.6, h: 0.04, shadow: 0 },
  rebar: { key: 'metal_rusted', value: 0.34, hue: 0.09, warm: 0.09, tone: 1.12, flat: 0.75, h: 0.03, shadow: 0 },
  can: { key: 'metal_painted', value: 0.42, hue: 0.22, warm: 0.0, tone: 1.0, flat: 0.8, h: 0.05, shadow: 0 },
  tile: { key: 'tile_roof', value: 0.3, hue: 0.08, warm: 0.08, tone: 1.16, flat: 0.7, h: 0.05, shadow: 0 },
  grit: { key: 'gravel', value: 0.3, hue: 0.04, warm: 0.04, tone: 1.24, flat: 0.4, h: 0.05, shadow: 0 },
  pebble: { key: 'gravel', value: 0.3, hue: 0.05, warm: 0.04, tone: 1.24, flat: 0.4, h: 0.09, shadow: 0 },
  mound: { key: 'rubble', value: 0.14, hue: 0.03, warm: 0.06, tone: 1.32, flat: 0.0, h: 1, shadow: 1 },
  berm: { key: 'sand', value: 0.16, hue: 0.04, warm: 0.1, tone: 1.16, flat: 0.0, h: 1, shadow: 0 },
};

/** Per-piece tint: jitter about the kind's base tone. */
function tintFor(kind, rand, extraWarm = 0) {
  const k = KINDS[kind];
  jitterColor(_c, rand, k.value, k.hue, k.warm + extraWarm);
  _c.multiplyScalar(k.tone);
  return _c;
}

/** Surfaces a piece can land on, and how far into each one it settles. */
const SOFT_SURF = { dirt: 1, sand: 1, gravel: 1, rubble: 1 };
const HARD_SURF = {
  asphalt: 1, asphalt_worn: 1, concrete_floor: 1, paver: 1, tile_floor: 1, concrete_wall: 1,
};

/**
 * How far a piece buries itself, decided by what it landed on rather than by
 * the caller.
 *
 * `sink` used to be a constant chosen at each call site, so the same brick
 * fragment sat 45 % buried whether it had fallen on tarmac or into a sand
 * drift. `Site` already knows the surface per cell, and the difference is one
 * of the cheapest reads of "this material is soft" available: debris barely
 * marks asphalt, sits half-swallowed in dirt, and all but disappears into a
 * mound.
 */
function sinkFor(surface, rand, drift = 0) {
  if (drift) return 0.45 + rand() * 0.20;
  if (SOFT_SURF[surface]) return 0.30 + rand() * 0.15;
  if (HARD_SURF[surface]) return 0.10 + rand() * 0.08;
  return 0.18 + rand() * 0.12;
}

/**
 * Drops one piece with a plausible resting pose. `sink` is the fraction of the
 * piece's own height buried in whatever it landed on — nothing in a street
 * balances on a single contact point.
 *
 * Two things here are load-bearing for the "nothing floats" read.
 *
 * The unconditional `(rand()-0.5)*0.28` that used to be added to both `rx` and
 * `rz` gave *every* kind sixteen degrees of tilt in two axes, including the
 * ones whose whole definition is that they lie flat. On a sheet of paper that
 * is the difference between litter and a shard of mirror. It is now scaled by
 * `(1 - flat)`, so a kind that claims to lie down actually does: paperFlat's
 * total tilt envelope is under 0.6 degrees.
 *
 * Sheet litter uses `lift` instead of `sink`. Burying a 2.5 mm sheet by 85 % of
 * its own height puts it 2 mm *under* nominal ground, and the road material's
 * 10 mm parallax lifts the visible stone tops above that — so the scrap ends up
 * hovering inside a gap it cannot be seen to touch. Sitting it 0.6 mm proud
 * with a contact decal under it is both cheaper and correct.
 */
function drop(bs, kind, geo, x, y, z, rand, scale, sink = 0.3, tint = 0, yaw = null) {
  const k = KINDS[kind];
  const lean = (1 - k.flat) * 1.3;
  const jit = 0.28 * (1 - k.flat);
  const rx = (rand() - 0.5) * Math.PI * lean + (rand() - 0.5) * jit;
  const rz = (rand() - 0.5) * Math.PI * lean + (rand() - 0.5) * jit;
  const ry = yaw === null ? rand() * Math.PI * 2 : yaw;
  tintFor(kind, rand, tint);
  const s = scale;
  const yy = k.lift === undefined ? y - sink * k.h * s : y + k.lift;
  bs.add(k.key, geo, x, yy, z, rx, ry, rz, s, s * (0.8 + rand() * 0.45), s, _c, !!k.shadow);
}

// ------------------------------------------------------------------ fields

const sq = (a) => a * a;

function smoothstep(e0, e1, x) {
  const t = e1 === e0 ? (x >= e1 ? 1 : 0) : (x - e0) / (e1 - e0);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Two Gaussian bands per half-carriageway at 1.75 m and 4.55 m from the crown:
 * a 3.5 m gauge — one pair of wheels — inside each lane. Debris survives under
 * the axle line and between the lanes; the crown and the wheel paths themselves
 * are swept. Shares `carriagewayAxis` with the wheel-polish decals, so the
 * debris banks in exactly the gaps the polished bands leave.
 */
function rutFn(axis) {
  if (!axis) return () => 0;
  const { px, pz, c0 } = axis;
  return (x, z) => {
    const p = Math.abs(x * px + z * pz - c0);
    return Math.exp(-sq((p - 1.75) / 0.55)) + Math.exp(-sq((p - 4.55) / 0.55));
  };
}

/**
 * Rejection-sampled cluster centres with pieces drawn around each one.
 *
 * Independent samples from a weighted field are a Poisson process, and a
 * Poisson process is *exactly* what the eye reads as confetti — the field
 * controls the local mean and nothing controls the local variance, so every
 * square metre gets its fair share. Real drifts are the opposite: long stretches
 * of nothing, then a hundred leaves banked in one corner.
 *
 * Two things break the isotropy. The offset ellipse is stretched 1.7x along the
 * prevailing wind and squashed 0.55x across it, so a drift is a streak and not a
 * disc. And every piece's yaw is drawn about the wind direction rather than
 * uniformly, so the drift has a visible grain — which is the single cue that
 * separates "blown here" from "sprinkled here".
 *
 * @param {(x:number,y:number,z:number,ry:number,t:number)=>void} place
 */
function clusterScatter(site, field, rand, opts, place) {
  if (!field || field.empty) return 0;
  const K = opts.K | 0;
  const nMin = opts.nMin, nMax = opts.nMax;
  const rMin = opts.rMin, rMax = opts.rMax;
  const sep = sq(opts.minSep === undefined ? 2.2 : opts.minSep);
  const yaw = opts.windYaw || 0;
  const wx = Math.sin(yaw), wz = Math.cos(yaw);

  const cx = [], cz = [], cR = [];
  for (let t = 0; t < K * 24 && cx.length < K; t++) {
    const p = field.sample(rand);
    if (!p) break;
    let ok = true;
    for (let i = 0; i < cx.length; i++) {
      if (sq(cx[i] - p.x) + sq(cz[i] - p.z) < sep) { ok = false; break; }
    }
    if (!ok) continue;
    cx.push(p.x); cz.push(p.z); cR.push(rMin + rand() * (rMax - rMin));
  }

  let placed = 0;
  for (let i = 0; i < cx.length; i++) {
    const R = cR[i];
    const n = nMin + ((rand() * (nMax - nMin + 1)) | 0);
    for (let j = 0; j < n; j++) {
      // Box-Muller radius, clamped, so the centre is dense and the rim thins.
      const r = Math.min(R, R * 0.42 * Math.sqrt(-2 * Math.log(Math.max(1e-6, rand()))));
      const a = rand() * Math.PI * 2;
      const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
      const along = ox * wx + oz * wz;
      const x = cx[i] + wx * along * 1.7 + (ox - along * wx) * 0.55;
      const z = cz[i] + wz * along * 1.7 + (oz - along * wz) * 0.55;
      const y = site.groundAt(x, z);
      if (y === null) continue;
      const cell = site.cellAt(x, z);
      if (cell < 0 || site.taken[cell] > 0.7) continue;
      place(x, y, z, yaw + (rand() - 0.5) * 1.4, R > 0 ? r / R : 0);
      placed++;
    }
  }
  return placed;
}

// ------------------------------------------------------------------- scatter

/**
 * The main scatter. Weighted by the site's distance field so density collapses
 * toward the middle of the carriageway and piles up along wall bases, kerb
 * gutters and inside corners.
 *
 * @param {any} ctx
 * @param {import('./layout.js').Site} site
 * @param {import('./layout.js').BatchSet} bs
 * @param {() => number} rand
 * @param {number} density 0..1 multiplier on every count
 */
export function scatterGround(ctx, site, bs, rand, density = 1, env = null) {
  pools();
  const P = POOL;
  const kit = env?.kit || null;
  const soft = env?.decalSoft || null;

  /**
   * THREE TRANSPORT CLASSES, not three falloff scales.
   *
   * The three fields this replaces differed only in the scale of one
   * `wallFalloff` — 0.9, 2.6 and 1.1 — which meant they described the same
   * shape at three widths, and therefore co-located a brick fragment, a sheet
   * of paper and a handful of grit at every point in the map. Nothing carries
   * those three materials to the same place. They are moved by gravity, by
   * water and by wind respectively, and those three processes have completely
   * different fields.
   */

  // CONSTRUCTION — masonry, timber, steel. Heavy: it lands where it fell off
  // the building and blows precisely nowhere, so this gates hard on
  // distance-to-facade rather than merely weighting it.
  const build = site.field((d, corner, surf, x, z, indoor) =>
    (d > 6.5 ? 0 : 1) * (wallFalloff(d, 2.2, 0.05) + corner * 0.4 + (indoor ? 3.0 : 0)));

  // FINES — grit and pebbles, graded by running water. Water goes to the kerb
  // line and to every height step, and it does that everywhere, including the
  // middle of the road, so this one has no distance gate at all.
  const fines = site.field((d, corner, surf, x, z, indoor, step, lee, gutter) =>
    3.2 * gutter + 1.8 * wallFalloff(d, 0.75, 0.02) + step * 7 + 0.35 * lee);

  // ORGANIC / LIGHT — paper, card, cans, leaves. Wind-transported, and wind
  // only ever puts them somewhere it stops: a lee, a gutter, an inside corner.
  // The smoothstep is the important half. Without it a wind field still has a
  // long tail out into the open, and a crisp packet lying alone in the middle
  // of a carriageway is one of the loudest "generated" tells there is.
  const anchored = (d, x, z) => {
    const i = site.cellAt(x, z);
    const kd = i < 0 ? 60 : site.kerbDist[i];
    return 1 - smoothstep(0.6, 1.6, Math.min(d, kd));
  };
  const organic = site.field((d, corner, surf, x, z, indoor, step, lee, gutter) =>
    (2.4 * lee + 2.0 * gutter + corner * 1.2 + (indoor ? 2.0 : 0)) * anchored(d, x, z));

  if (build.empty && fines.empty) return { pieces: 0 };

  const N = (n) => Math.max(0, Math.round(n * density));
  let pieces = 0;

  const run = (field, count, kind, list, sMin, sMax) => {
    if (!field || field.empty) return;
    for (let i = 0; i < count; i++) {
      const p = field.sample(rand);
      if (!p) break;
      const cell = site.cellAt(p.x, p.z);
      if (cell < 0 || site.taken[cell] > 0.7) continue;
      const s = sMin + rand() * (sMax - sMin);
      const geo = pick(list, rand);
      drop(bs, kind, geo, p.x, p.y, p.z, rand, s, sinkFor(p.surface, rand));
      // Anything with a readable footprint gets an occlusion patch under it —
      // one piece in eight, not every piece. The budget is a couple of hundred
      // quads against a few thousand eligible pieces, and taking them in scatter
      // order spends the entire allowance inside the first `run()` call, which
      // put every contact patch in the map on chunk fragments and none on
      // anything the camera was pointed at. A coin flip spreads them.
      if (soft && kit && rand() < 0.12) {
        contactDecal(soft, kit, rand, p.x, p.y, p.z, footprint(geo) * s);
      }
      pieces++;
    }
  };

  // --- FINES: 4200. The base layer that stops asphalt reading as vinyl.
  // 60 % of it clustered on gutter maxima, the rest loose.
  const fineCluster = clusterScatter(site, fines, rand, {
    K: 40, nMin: 20, nMax: 60, rMin: 0.5, rMax: 1.4, minSep: 2.2, windYaw: site.windYaw,
  }, (x, y, z, ry) => {
    const grit = rand() < 0.78;
    drop(bs, grit ? 'grit' : 'pebble', pick(grit ? P.grit : P.pebble, rand),
      x, y, z, rand, 0.6 + rand() * (grit ? 1.1 : 0.9), 0.45 + rand() * 0.2, 0, ry);
    pieces++;
  });
  run(fines, N(Math.max(0, 3150 - fineCluster * 0.78)), 'grit', P.grit, 0.6, 1.7);
  run(fines, N(Math.max(0, 1050 - fineCluster * 0.22)), 'pebble', P.pebble, 0.6, 1.5);

  // --- CONSTRUCTION: 2600.
  run(build, N(580), 'chunk', P.chunk, 0.45, 1.35);
  run(build, N(160), 'chunkBig', P.chunkBig, 0.5, 1.2);
  run(build, N(200), 'slabSmall', P.slabSmall, 0.6, 1.5);
  run(build, N(80), 'slab', P.slab, 0.55, 1.3);
  run(build, N(400), 'brickHalf', P.brickHalf, 0.7, 1.5);
  run(build, N(180), 'brick', P.brick, 0.85, 1.15);
  run(build, N(360), 'plaster', P.plaster, 0.5, 1.5);
  run(build, N(140), 'tile', P.tile, 0.6, 1.4);
  run(build, N(215), 'splinter', P.splinter, 0.5, 1.3);
  run(build, N(65), 'plank', P.plank, 0.7, 1.25);
  run(build, N(115), 'twist', P.twist, 0.6, 1.5);
  run(build, N(105), 'rebar', P.rebar, 0.6, 1.4);

  // --- ORGANIC / LIGHT. Clustered first: 60 % of the budget banks into drifts
  // and the remaining 40 % stays as loose singles, because a street that has
  // *only* drifts is as obviously authored as one that has only noise.
  const lit = clusterScatter(site, organic, rand, {
    K: 26, nMin: 8, nMax: 25, rMin: 0.35, rMax: 1.1, minSep: 2.2, windYaw: site.windYaw,
  }, (x, y, z, ry) => {
    const roll = rand();
    // paperCurl only where the wind genuinely stops: a curled scrap out on an
    // exposed surface would have been flattened or blown away long ago.
    const curl = site.leeAt(x, z) > 1.2 && rand() < 0.3;
    if (roll < 0.55) {
      drop(bs, curl ? 'paperCurl' : 'paperFlat', pick(curl ? P.paperCurl : P.paperFlat, rand),
        x, y, z, rand, 0.6 + rand() * 0.6, 0, 0, ry);
      if (soft && kit) contactDecal(soft, kit, rand, x, y, z, 0.20, 1.35);
    } else if (roll < 0.78) {
      drop(bs, 'card', pick(P.card, rand), x, y, z, rand, 0.55 + rand() * 0.65, 0, 0, ry);
      if (soft && kit) contactDecal(soft, kit, rand, x, y, z, 0.40, 1.35);
    } else {
      drop(bs, 'can', pick(P.can, rand), x, y, z, rand, 0.8 + rand() * 0.5,
        sinkFor(site.surf[site.cellAt(x, z)] || '', rand), 0, ry);
    }
    pieces++;
  });
  run(organic, N(Math.max(0, 400 - lit * 0.4)), 'paperFlat', P.paperFlat, 0.6, 1.2);
  run(organic, N(90), 'card', P.card, 0.55, 1.2);
  run(organic, N(70), 'can', P.can, 0.8, 1.3);

  // --- LEAVES, entirely in drifts. Never a single leaf on open ground.
  const leaves = clusterScatter(site, organic, rand, {
    K: 30, nMin: 15, nMax: 40, rMin: 0.3, rMax: 0.9, minSep: 1.6, windYaw: site.windYaw,
  }, (x, y, z, ry) => {
    drop(bs, 'leaf', pick(P.leaf, rand), x, y, z, rand, 0.7 + rand() * 0.8, 0, 0, ry);
    pieces++;
  });

  // --- THE CARRIAGEWAY.
  //
  // The weight this replaces was `(d < 2.4 || d > 12 ? 0 : 1)`, i.e. zero
  // debris within 2.4 m of any wall or kerb — which is precisely where debris
  // drifts — and flat uniform probability across the whole open road, which is
  // where traffic and feet sweep it clear. It was inverted from reality in both
  // halves at once, and 3270 pieces went through it. That is the confetti.
  //
  // The 0.04 floor is deliberately tiny. The crown of a driven road is swept
  // clean, and the rubric's bare-ground failure is answered by surface detail —
  // seams, patches, wheel polish, damp — not by sprinkling gravel on it.
  const axis = carriagewayAxis(site);
  const rut = rutFn(axis);
  const road = site.field((d, corner, surf, x, z, indoor, step, lee, gutter) =>
    (indoor || d > 17 ? 0 : 1)
    * ((surf === 'asphalt' || surf === 'asphalt_worn') ? 1 : 0.2)
    * (2.6 * gutter + 1.4 * lee + 0.9 * rut(x, z) + 0.04));
  if (!road.empty) {
    run(road, N(380), 'grit', P.grit, 0.6, 1.8);
    run(road, N(150), 'chunk', P.chunk, 0.4, 1.1);
    run(road, N(120), 'brickHalf', P.brickHalf, 0.65, 1.35);
    run(road, N(90), 'plaster', P.plaster, 0.5, 1.4);
    run(road, N(70), 'slabSmall', P.slabSmall, 0.55, 1.3);
    run(road, N(50), 'splinter', P.splinter, 0.5, 1.2);
    run(road, N(40), 'twist', P.twist, 0.55, 1.3);
    // No paper, no card, no cans. Nothing light stays on a carriageway.
  }

  // --- MATERIAL TRANSITIONS. A kerb line where the pavers stop and the tarmac
  // starts with nothing crossing it is a knife edge, and a knife edge between
  // two ground materials is a texture-atlas seam, not a street.
  pieces += edgeSpill(site, bs, rand, density, soft, kit);

  return { pieces };
}

/**
 * Softens every ground-material boundary by throwing a little of the loose
 * material across it.
 *
 * `Site` does not store a material-id gradient, but it stores something better
 * for this purpose: `kerbDist`, the metres to the nearest height step. Every
 * transition that matters in this map — pavement to road, threshold to floor,
 * mound to slab — is also a height step, so the seam cells are exactly the
 * `kerbDist < 1.2` band and the spill is an exponential falloff off them.
 */
function edgeSpill(site, bs, rand, density, soft, kit) {
  const P = POOL;
  const seam = site.field((d, corner, surf, x, z, indoor, step) =>
    (step > 0.04 ? 1 : 0) * (1 + step * 4));
  if (seam.empty) return 0;
  let n = 0;
  const want = Math.round(340 * density);
  for (let i = 0; i < want; i++) {
    const p = seam.sample(rand);
    if (!p) break;
    // Exponential displacement across the seam, biased downhill-ish by using
    // the wall normal where there is one and the wind where there is not.
    const a = rand() * Math.PI * 2;
    const r = -0.22 * Math.log(Math.max(1e-6, rand()));
    if (r > 0.6) continue;
    const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
    const y = site.groundAt(x, z);
    if (y === null) continue;
    const cell = site.cellAt(x, z);
    if (cell < 0 || site.taken[cell] > 0.7) continue;
    const roll = rand();
    if (roll < 0.6) drop(bs, 'grit', pick(P.grit, rand), x, y, z, rand, 0.6 + rand() * 1.1, 0.35);
    else if (roll < 0.85) drop(bs, 'pebble', pick(P.pebble, rand), x, y, z, rand, 0.6 + rand() * 0.9, 0.35);
    else drop(bs, 'plaster', pick(P.plaster, rand), x, y, z, rand, 0.5 + rand() * 0.8, 0.4);
    n++;
  }
  // One dust seam per few metres of kerb, so the spill has something to sit in.
  if (soft && kit) gritSeam(soft, kit, site, seam, rand, Math.round(40 * density));
  return n;
}

/**
 * Mounded rubble piles: a collapsed-masonry heap with chunks bedded into it and
 * rebar and slabs breaking the outline. Placed against wall bases and in
 * corners, where a collapse would actually have dumped its material.
 */
export function rubblePiles(ctx, site, bs, rand, density = 1, count = 26, env = null) {
  pools();
  const P = POOL;
  const kit = env?.kit || null;
  const soft = env?.decalSoft || null;
  // Collapses happen at buildings, not in the middle of the carriageway; a heap
  // sitting in open road reads as a set-dressing mistake, so gate hard on
  // distance-to-wall instead of merely weighting it.
  const field = site.field((d, corner, surf, x, z, indoor) =>
    (d > 4.5 ? 0 : 1) * (wallFalloff(d, 1.5, 0.02) + corner * 1.1 + (indoor ? 0.3 : 0)));
  if (field.empty) return { piles: 0, pieces: 0 };

  let piles = 0, pieces = 0;
  const want = Math.round(count * density);
  for (let attempt = 0; attempt < want * 16 && piles < want; attempt++) {
    const p = field.sample(rand);
    if (!p) break;
    const rw = 0.6 + rand() * 1.15;
    if (!site.free(p.x, p.z, rw * 0.7)) continue;
    site.occupy(p.x, p.z, rw * 0.75);
    piles++;

    const h = rw * (0.2 + rand() * 0.22);
    const yaw = rand() * Math.PI * 2;
    // Pull the mound toward the wall it fell off, if there is one.
    const cx = p.x + p.nx * rw * 0.22, cz = p.z + p.nz * rw * 0.22;

    // The core is bedded low and stays mostly hidden: it is a support surface
    // for the chunks, not the silhouette. A visible smooth dome reads as a rock.
    tintFor('mound', rand);
    bs.add('rubble', pick(P.mound, rand), cx, p.y + h * 0.18, cz,
      0, yaw, 0, rw, h * 1.7, rw * (0.75 + rand() * 0.5), _c, true);
    pieces++;

    // A contact patch under the whole heap, so the mound itself has a base line
    // rather than a clean ellipse against the tarmac.
    if (soft && kit) contactDecal(soft, kit, rand, cx, p.y, cz, rw * 2, 1.15, true);

    // Chunks bedded over the mound surface, densest at the crown.
    //
    // Aligned to the mound's own slope, which is the fix for the thing that
    // made the old heaps read as a bag of rocks tipped out: every rim piece was
    // given a fully random lean, so half of them cantilevered off the side of a
    // slope they were supposed to be resting on. The profile is y = h(1 - t^2)
    // with t = r/rw, so the analytic normal is (2h t cos a / rw, 1, 2h t sin a
    // / rw) normalised — plus up to 12 degrees of random tip, because a broken
    // lump does not lie flush either.
    const n = Math.round((26 + rw * 34) * density);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const t = Math.sqrt(rand());
      const r = t * rw * 1.05;
      const y = p.y + h * (1 - t * t) * (0.5 + rand() * 0.85);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const g = 2 * h * t / Math.max(0.05, rw);
      _v.set(g * Math.cos(a), 1, g * Math.sin(a)).normalize();
      // +/- 12 degrees of tip, applied to the normal so `addOriented` carries it.
      _v.x += (rand() - 0.5) * 0.42;
      _v.z += (rand() - 0.5) * 0.42;
      _v.normalize();
      const spin = rand() * Math.PI * 2;
      const roll = rand();
      let kind, list, s;
      if (roll < 0.34) { kind = 'chunk'; list = P.chunk; s = 0.45 + rand() * 0.85; }
      else if (roll < 0.54) { kind = 'brickHalf'; list = P.brickHalf; s = 0.8 + rand() * 0.6; }
      else if (roll < 0.68) { kind = 'plaster'; list = P.plaster; s = 0.7 + rand() * 0.9; }
      else if (roll < 0.8) { kind = 'slabSmall'; list = P.slabSmall; s = 0.6 + rand() * 0.8; }
      else if (roll < 0.87) { kind = 'chunkBig'; list = P.chunkBig; s = 0.35 + rand() * 0.5; }
      else if (roll < 0.94) { kind = 'brick'; list = P.brick; s = 0.9 + rand() * 0.25; }
      else { kind = 'pebble'; list = P.pebble; s = 0.8 + rand() * 0.9; }
      const k = KINDS[kind];
      tintFor(kind, rand);
      bs.addOriented(k.key, pick(list, rand), x, y - 0.55 * k.h * s, z, _v, spin,
        s, s * (0.8 + rand() * 0.45), s, _c, !!k.shadow);
      pieces++;
    }

    // Reinforcement torn out of the slab: the thing that says "concrete
    // frame", not "pile of gravel".
    const bars = 2 + ((rand() * 4) | 0);
    for (let i = 0; i < bars; i++) {
      const a = rand() * Math.PI * 2;
      const r = rand() * rw * 0.7;
      tintFor('rebar', rand);
      bs.add('metal_rusted', pick(P.rebar, rand),
        cx + Math.cos(a) * r, p.y + h * (0.7 + rand() * 0.9), cz + Math.sin(a) * r,
        (rand() - 0.5) * 1.6, rand() * 6.28, (rand() - 0.5) * 1.6,
        0.9 + rand() * 1.3, 1, 1, _c, false);
      pieces++;
    }

    // A couple of big plates propped against the heap read as floor slab.
    const plates = 1 + ((rand() * 3) | 0);
    for (let i = 0; i < plates; i++) {
      const a = rand() * Math.PI * 2;
      const r = rw * (0.4 + rand() * 0.5);
      tintFor('slab', rand);
      bs.add('concrete_floor', pick(P.slab, rand),
        cx + Math.cos(a) * r, p.y + h * (0.35 + rand() * 0.7), cz + Math.sin(a) * r,
        (rand() - 0.5) * 1.1, a + (rand() - 0.5), (rand() - 0.5) * 1.1,
        0.9 + rand() * 1.5, 1, 1, _c, true);
      pieces++;
    }
  }
  return { piles, pieces };
}

/**
 * A drift of debris hugging every facade base — a continuous, thinning band
 * rather than a statistical spray. Real streets have this and a random scatter
 * never quite produces it, because a scatter has no notion of "along".
 */
export function wallDrifts(ctx, site, bs, rand, density = 1, env = null) {
  pools();
  const P = POOL;
  let pieces = 0;
  // One prevailing wind for the whole map, so every drift banks the same way.
  // Independent per-drift orientation is the single loudest generated-scene
  // tell there is: real streets are asymmetric in one consistent direction.
  const wx = site.windX, wz = site.windZ;
  for (const f of site.facades) {
    if (f.len < 1.6) continue;
    const dx = f.bx - f.ax, dz = f.bz - f.az;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    // How much of the wind runs along this facade. A wall parallel to the wind
    // collects a long tapered drift; a wall across it collects a short deep one.
    const along = ux * wx + uz * wz;
    const per = Math.round(len * 5.5 * density);
    for (let i = 0; i < per; i++) {
      const t = rand();
      // Squared-cosine bulge so the drift thickens in the middle of each run,
      // then skewed downwind so the thick end is at the sheltered end.
      const skew = THREE.MathUtils.clamp(t + along * 0.28, 0, 1);
      const thick = 0.18 + 0.75 * Math.pow(Math.sin(Math.PI * skew), 0.6) * rand();
      const off = 0.12 + thick * rand();
      const x = f.ax + ux * len * t + f.nx * off;
      const z = f.az + uz * len * t + f.nz * off;
      const y = site.groundAt(x, z);
      if (y === null) continue;
      const roll = rand();
      const near = 1 - off / 1.1;
      // Everything in a drift is half-buried in the drift, whatever the
      // underlying surface is.
      const sink = sinkFor(null, rand, 1);
      const ry = site.windYaw + (rand() - 0.5) * 1.4;
      if (roll < 0.42) drop(bs, 'grit', pick(P.grit, rand), x, y, z, rand, 0.7 + rand() * 1.2, sink, 0, ry);
      else if (roll < 0.6) drop(bs, 'plaster', pick(P.plaster, rand), x, y, z, rand, 0.5 + rand() * 1.1, sink, 0, ry);
      else if (roll < 0.74) drop(bs, 'chunk', pick(P.chunk, rand), x, y, z, rand, 0.35 + rand() * 0.7, sink, 0, ry);
      else if (roll < 0.85) drop(bs, 'brickHalf', pick(P.brickHalf, rand), x, y, z, rand, 0.7 + rand() * 0.6, sink, 0, ry);
      else if (roll < 0.93) drop(bs, 'pebble', pick(P.pebble, rand), x, y, z, rand, 0.6 + rand() * 1.0, sink, 0, ry);
      else if (near > 0.4) drop(bs, 'paperFlat', pick(P.paperFlat, rand), x, y, z, rand, 0.7 + rand() * 0.5, 0, 0, ry);
      else drop(bs, 'splinter', pick(P.splinter, rand), x, y, z, rand, 0.5 + rand() * 0.7, sink, 0, ry);
      pieces++;
    }
  }
  return { pieces };
}

/**
 * Sand berms in the angle where a wall meets the ground.
 *
 * These used to be broad flat drifts out in the road and they were a mistake
 * twice over: a two-metre dome squashed to 80 mm has enough normal variation
 * inside one shadow-map texel to band the whole foreground with acne, and a
 * dust *patch* is a decal's job, not geometry's. What geometry is genuinely
 * needed for is the small triangular fillet against a wall base, which a
 * projected quad cannot produce because it has to bridge two surfaces.
 */
export function wallBerms(ctx, site, bs, rand, density = 1, env = null) {
  pools();
  const P = POOL;
  let pieces = 0;
  for (const f of site.facades) {
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    if (len < 2.5) continue;
    const ux = (f.bx - f.ax) / (len || 1), uz = (f.bz - f.az) / (len || 1);
    const n = Math.round(len * 0.42 * density);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.15 + rand() * 0.7) / Math.max(1, n);
      // A wedge grows where the wind stops, so its size follows the lee field
      // rather than a flat random: 0.45 m of sand in an exposed spot, up to
      // 1.4 m in the corner the wind dumps into.
      const shelter = 0.55 + 0.22 * site.leeAt(
        f.ax + ux * len * t + f.nx * 0.3, f.az + uz * len * t + f.nz * 0.3);
      const r = (0.45 + rand() * 0.85) * THREE.MathUtils.clamp(shelter, 0.5, 1.5);
      const h = 0.05 + rand() * 0.085;
      const off = 0.05 + rand() * 0.18;
      const x = f.ax + ux * len * t + f.nx * off;
      const z = f.az + uz * len * t + f.nz * off;
      const y = site.groundAt(x, z);
      if (y === null) continue;
      tintFor('berm', rand);
      // Long axis follows the wall, short axis rolls out into the street.
      const along = Math.atan2(ux, uz);
      bs.add('dirt', pick(P.mound, rand),
        x, y + h * 0.1, z, 0, along, 0,
        r * (1.1 + rand() * 1.4), h * 1.9, r * 0.72, _c, false);
      pieces++;
    }
  }
  return { pieces };
}

export {
  pools as clutterPools, pick as pickShape, warpSlab, rebarGeo, canGeo, roofTileGeo,
  variants, clusterScatter, rutFn, sinkFor, footprint, KINDS as CLUTTER_KINDS,
};
