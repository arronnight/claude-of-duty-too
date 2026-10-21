import * as THREE from 'three';
import { chamferBox, shardGeo, lumpGeo, jitterColor } from './lib.js';

/**
 * The edge of the road.
 *
 * `Level.js` lays each pavement as a single box, so the street currently meets
 * the carriageway along one perfectly straight, perfectly clean, perfectly
 * continuous extruded lip. That silhouette is a strong tell on its own — but
 * the bigger loss is everything the real edge collects. In every reference
 * frame the most detailed 60 cm of the whole street is the strip against the
 * kerb: laid granite units with open joints and at least one broken corner, a
 * band of silt and grit that the wheels never sweep, and a gully every twenty
 * metres with a dark opening and a damp halo round it. None of that existed.
 *
 * **Nothing here knows a map coordinate.** The kerb line is *derived* from the
 * survey: any pair of adjacent open cells whose floor heights differ by more
 * than 60 mm has a kerb face between them, and the outward normal points from
 * the high cell to the low one. Runs of those faces sharing a normal are
 * chained into lines. Hard-coding "the kerb is at x = +/-7" would be shorter
 * and would be wrong the next time the level agent moves a pavement, which is
 * precisely the failure mode `Site` exists to prevent. It also means this
 * module lights up automatically on any future raised platform, loading bay or
 * kerbed traffic island without another line of code.
 *
 * **Draw cost: zero.** Every piece goes into a bucket that already exists —
 * `concrete_floor` (shadowed) and `dirt` (unshadowed) in `core`, `gravel` in
 * `fine`, and the decal carrier key `gun_polymer` in the two decal sets. The
 * budget is fill-bound, not submission-bound, so more triangles inside an
 * existing bucket are close to free and are exactly the right thing to spend.
 */

const _c = new THREE.Color();
const _c2 = new THREE.Color();

/** Minimum floor-height difference that counts as a kerb face, metres. */
const KERB_STEP = 0.06;
/** Shortest run worth laying a kerb course along, in grid cells. */
const MIN_RUN = 4;

/** Nominal kerbstone: 900 long x 150 high x 300 deep, 10 mm arris. */
const UNIT_LEN = 0.90;
const UNIT_DEEP = 0.30;
const JOINT = 0.010;
/** How far the kerb face stands in front of the pavement box's own side face. */
const PROUD_Z = 0.015;
/** How far the kerb top stands above the pavement surface. */
const PROUD_Y = 0.010;

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// --------------------------------------------------------------- kerb lines

/**
 * True when the cell at (ix, iz) is the HIGH side of a kerb face whose outward
 * normal is (dx, dz).
 */
function isKerbCell(site, ix, iz, dx, dz) {
  if (!site.inside(ix, iz)) return false;
  const i = site.index(ix, iz);
  if (!site.open[i]) return false;
  const jx = ix + dx, jz = iz + dz;
  if (!site.inside(jx, jz)) return false;
  const j = site.index(jx, jz);
  if (!site.open[j]) return false;
  return site.gy[i] - site.gy[j] > KERB_STEP;
}

/**
 * Every kerb line on the map, as a start point, a unit direction along it, a
 * length, an outward normal into the low ground, and the two floor heights
 * sampled per metre.
 *
 * Four passes, one per outward normal, so a run never turns a corner mid-line
 * and a kerbstone is never laid diagonally across one.
 */
function kerbRuns(site) {
  const runs = [];
  const n = site.nx * site.nz;
  for (const [dx, dz] of DIRS) {
    const seen = new Uint8Array(n);
    // Walk perpendicular to the outward normal.
    const sx = dx ? 0 : 1, sz = dx ? 1 : 0;
    for (let iz = 0; iz < site.nz; iz++) {
      for (let ix = 0; ix < site.nx; ix++) {
        if (seen[site.index(ix, iz)]) continue;
        if (!isKerbCell(site, ix, iz, dx, dz)) continue;
        // Only start at the head of a run, or the raster order would chop
        // every line into fragments beginning wherever the scan first met it.
        if (isKerbCell(site, ix - sx, iz - sz, dx, dz)) continue;
        const top = [], low = [];
        let jx = ix, jz = iz;
        while (isKerbCell(site, jx, jz, dx, dz) && !seen[site.index(jx, jz)]) {
          const i = site.index(jx, jz);
          seen[i] = 1;
          top.push(site.gy[i]);
          low.push(site.gy[site.index(jx + dx, jz + dz)]);
          jx += sx; jz += sz;
        }
        if (top.length < MIN_RUN) continue;
        runs.push({
          // The face sits on the boundary between the two cells, i.e. half a
          // grid step out from the high cell's centre.
          x0: site.xOf(ix) + dx * 0.5,
          z0: site.zOf(iz) + dz * 0.5,
          ux: sx, uz: sz,
          nx: dx, nz: dz,
          yaw: Math.atan2(dx, dz),
          len: top.length,
          top, low,
        });
      }
    }
  }
  runs.sort((a, b) => b.len - a.len);
  return runs;
}

/**
 * RUN COORDINATE: `t` is metres from the START BOUNDARY of the run, so it goes
 * 0 .. run.len and never overhangs either end. The stored heights are sampled
 * at cell CENTRES, which sit half a metre in, hence the -0.5 on the position
 * and the floor() on the index.
 */
function alongX(run, t) { return run.x0 + run.ux * (t - 0.5); }
function alongZ(run, t) { return run.z0 + run.uz * (t - 0.5); }

function sampleAt(arr, t) {
  const i = Math.max(0, Math.min(arr.length - 1, Math.floor(t)));
  return arr[i];
}

/** Floor height on the high (pavement) side. */
function topAt(run, t) { return sampleAt(run.top, t); }

/** Floor height on the low (carriageway) side. */
function lowAt(run, t) { return sampleAt(run.low, t); }

// ----------------------------------------------------------------- geometry

let POOL = null;

function pools(rand) {
  if (POOL) return POOL;
  const kerb = [];
  const broken = [];
  for (let i = 0; i < 5; i++) {
    // No `loopsY`: lib's own guidance is loops above ~0.6 m, and a 150 mm
    // kerbstone lit by a raking sun does not need them. 44 triangles a unit.
    kerb.push(chamferBox(UNIT_LEN, 0.15, UNIT_DEEP, 0.010));
    broken.push(shardGeo(UNIT_LEN, 0.15, UNIT_DEEP, rand, 0.30));
  }
  // Squashed silt lumps. Built at unit radius and scaled per instance, so the
  // whole gutter is five geometries however long the street is.
  const silt = [];
  for (let i = 0; i < 5; i++) silt.push(lumpGeo(1.0, 0.34, [1, 1, 1], 1, 3.7 + i));
  const grit = [];
  for (let i = 0; i < 4; i++) grit.push(lumpGeo(1.0, 0.46, [1, 0.7, 1], 0, 11.3 + i));
  POOL = {
    kerb, broken, silt, grit,
    frame: chamferBox(0.50, 0.05, 0.36, 0.008),
    voidPlate: chamferBox(0.42, 0.02, 0.28, 0.004),
    bar: chamferBox(0.012, 0.018, 0.28, 0.003),
  };
  return POOL;
}

const pick = (list, rand) => list[(rand() * list.length) | 0];

// ------------------------------------------------------------------ ledger

/**
 * Makes "zero new draw calls" a property of the code rather than a claim in a
 * commit message.
 *
 * A `BatchSet` emits one mesh per `material | zone | castsShadow` bucket, and a
 * shadow-casting bucket costs one draw per cascade on top of its own — four
 * draws for one mesh, at three cascades. This module runs LAST in the prop
 * build, so every bucket that any other module is going to open is already
 * open when it starts; snapshotting the bucket keys on entry therefore says
 * exactly which of its own pieces would open a new one.
 *
 * That was not a hypothetical. Measured on this map, the kerb runs the full
 * length of the street and reaches `core`'s third Z zone, where nothing else
 * casts a shadow from `concrete_floor` — one new bucket, three draws, on a
 * budget sitting at 348 of 350. A 150 mm kerbstone 70 m down the street
 * contributes a shadow nobody can resolve, so the flag is simply dropped
 * there. `shadowOk` is how that decision gets made per piece instead of by
 * hard-coding a Z threshold that a level rewrite would invalidate.
 */
class Ledger {
  constructor(pairs) {
    this.sets = pairs.filter(([, s]) => !!s);
    this.snap = new Map();
    for (const [n, s] of this.sets) this.snap.set(n, new Set(s.buckets.keys()));
  }

  /**
   * The shadow flag to place this piece with, or `null` for "do not place it".
   *
   * Preference order: the shadowed bucket if the caller wants one and it is
   * already open, then the unshadowed one, then nothing. Declining to place a
   * piece sounds drastic and is not: the only place it triggers on this map is
   * `core`'s third Z zone, which is the last three metres of street before the
   * far map edge, seventy metres from the player camera and under a pixel
   * wide. Three draw calls is a bad price for that.
   */
  resolve(name, bs, key, z, wantShadow) {
    const set = this.snap.get(name);
    if (!set) return wantShadow;
    const zone = bs.zoneOf(z);
    if (wantShadow && set.has(`${key}|${zone}|1`)) return true;
    if (set.has(`${key}|${zone}|0`)) return false;
    return null;
  }

  /** Bucket ids this module opened that nobody else had. Should be empty. */
  opened() {
    const out = [];
    for (const [n, s] of this.sets) {
      for (const k of s.buckets.keys()) if (!this.snap.get(n).has(k)) out.push(`${n}/${k}`);
    }
    return out;
  }
}

/** Value noise in one dimension, for a thickness that wanders along a line. */
function fbm1(t) {
  let v = 0, a = 0.5, f = 1;
  for (let o = 0; o < 4; o++) {
    const i = Math.floor(t * f);
    const fr = t * f - i;
    const s = fr * fr * (3 - 2 * fr);
    const h0 = Math.sin(i * 127.1 + o * 31.7) * 43758.5453;
    const h1 = Math.sin((i + 1) * 127.1 + o * 31.7) * 43758.5453;
    v += a * ((h0 - Math.floor(h0)) * (1 - s) + (h1 - Math.floor(h1)) * s);
    a *= 0.5; f *= 2;
  }
  return v;
}

// ------------------------------------------------------------------ passes

/**
 * A laid granite kerb course.
 *
 * The single thing that makes a kerb read as *laid* rather than as extruded is
 * that the units do not agree with each other: each one is a few millimetres
 * high or low, a fraction of a degree off line, and separated from its
 * neighbour by a dark joint. Those are sub-centimetre errors and they are what
 * the eye uses to tell a photograph from a model, so they are the whole point
 * of this pass rather than a garnish on it.
 */
function kerbCourse(runs, bs, rand, density, ledger) {
  let parts = 0;
  const yawJit = 0.4 * Math.PI / 180;
  for (const run of runs) {
    const pitch = UNIT_LEN + JOINT;
    const count = Math.floor(run.len / pitch);
    for (let k = 0; k < count; k++) {
      // Lateral jitter of +/-2 mm on a nominal 10 mm joint, so the dark line
      // between neighbours opens and closes between about 8 and 12 mm.
      const t = (k + 0.5) * pitch + (rand() - 0.5) * 0.004;
      const py = topAt(run, t);
      const ly = lowAt(run, t);
      // Height follows the actual step, so the unit never floats above the
      // carriageway on a level whose kerb is taller than the nominal 150 mm.
      const h = Math.max(0.15, (py - ly) + 0.05);
      const yTop = py + PROUD_Y + (rand() - 0.5) * 0.006;
      // Centre sits back inside the pavement: only PROUD_Z of the unit stands
      // in front of the pavement box, which is what keeps the two faces from
      // z-fighting along the whole street.
      const back = UNIT_DEEP / 2 - PROUD_Z + (rand() - 0.5) * 0.003;
      const x = alongX(run, t) - run.nx * back;
      const z = alongZ(run, t) - run.nz * back;

      const shadow = ledger.resolve('core', bs, 'concrete_floor', z, true);
      if (shadow === null) continue;
      const broken = rand() < (1 / 6) * density;
      const geo = broken ? pick(POOL.broken, rand) : pick(POOL.kerb, rand);
      // Granite is a good deal darker than the concrete_floor base tint, and
      // no two setts out of the same quarry match.
      jitterColor(_c, rand, 0.22, 0.03, 0.01);
      _c.multiplyScalar(0.82);
      bs.add('concrete_floor', geo,
        x, yTop - h / 2, z,
        0, run.yaw + (rand() - 0.5) * 2 * yawJit, 0,
        1, h / 0.15, 1, _c, shadow);
      parts++;
    }
  }
  return parts;
}

/**
 * The silt drift in the channel.
 *
 * A gutter is never clean and it is never evenly dirty: the thickness wanders
 * along its length and it banks up wherever the wind does not reach, which is
 * what `site.lee` is for. The acceptance test is that it thins to nothing
 * rather than ending on an edge, so every run tapers over its first and last
 * 1.5 m and the thickness is a noise field, not a constant.
 */
function gutterDrift(runs, core, fine, site, rand, density, skip, ledger) {
  let pieces = 0;
  const STEP = 0.25;
  for (const run of runs) {
    if (run.len < 3) continue;
    for (let t = STEP * 0.5; t < run.len; t += STEP) {
      const x0 = alongX(run, t);
      const z0 = alongZ(run, t);
      let blocked = false;
      for (const g of skip) {
        if (Math.abs(g.x - x0) < 0.55 && Math.abs(g.z - z0) < 0.55) { blocked = true; break; }
      }
      if (blocked) continue;
      if (ledger.resolve('core', core, 'dirt', z0, false) === null) continue;
      const gritOk = ledger.resolve('fine', fine, 'gravel', z0, false) !== null;
      const ly = lowAt(run, t);
      const lee = site.leeAt(x0 + run.nx * 0.4, z0 + run.nz * 0.4);
      const leeK = Math.max(0.2, Math.min(1.0, lee));
      // The brief's coefficient is 0.20, which at the noise peak gives a
      // 0.94 m mound — wider than the 0.60 m cap the same paragraph imposes,
      // and `wallBerms` records that a wide dome squashed flat bands the
      // shadow map with acne. Clamped to the cap instead of quietly ignoring
      // one half of the spec.
      let T = 0.02 + 0.20 * fbm1(t / 6.0) * leeK;
      if (T > 0.105) T = 0.105;
      // Taper to nothing at both ends of the run.
      const edge = Math.min(t, run.len - t) / 1.5;
      if (edge < 1) T *= edge * edge * (3 - 2 * edge);
      if (T < 0.006) continue;
      const halfW = 0.12 + T * 1.6;
      const cx = x0 + run.nx * (halfW * 0.72);
      const cz = z0 + run.nz * (halfW * 0.72);

      // Grey-brown road silt rather than the `dirt` key's dry-soil ochre. The
      // brief's #4a463f target would need a ~0.15 multiplier, and lib.js's own
      // note on jitterColor warns that a very dark instance tint double-dips
      // into the indirect term because SurfaceShader reads vertex colour as
      // occlusion as well as albedo. This is as far towards it as is safe.
      _c.setRGB(0.32, 0.35, 0.40).multiplyScalar(0.86 + rand() * 0.3);
      core.add('dirt', pick(POOL.silt, rand),
        cx, ly + T * 0.05, cz,
        0, run.yaw, 0,
        0.20, T, halfW, _c, false);
      pieces++;

      // A handful of individually resolvable stones on top, so the drift does
      // not read as a smooth extruded fillet up close.
      const n = gritOk ? 3 + ((rand() * 4) | 0) : 0;
      for (let i = 0; i < n * density; i++) {
        const along = (rand() - 0.5) * STEP * 1.4;
        const across = (rand() - 0.5) * halfW * 1.7;
        const r = 0.008 + rand() * 0.018;
        _c2.setRGB(0.46, 0.47, 0.50).multiplyScalar(0.8 + rand() * 0.45);
        fine.add('gravel', pick(POOL.grit, rand),
          cx + run.ux * along + run.nx * across,
          ly + T * 0.5 - r * 0.6,          // sink 0.6 of the piece
          cz + run.uz * along + run.nz * across,
          rand() * 3.1, rand() * 6.28, rand() * 3.1,
          r, r * 0.72, r, _c2, false);
        pieces++;
      }
    }
  }
  return pieces;
}

/**
 * Road gullies, one every 20 m.
 *
 * A gully is one of the few objects on a street whose spacing a viewer knows
 * without being able to say so, and its absence is felt as "this road does not
 * drain anywhere". The frame is sunk so only its 15 mm lip shows; the opening
 * is a near-black recess with bars over it, because a dark hole is what reads
 * at 10 m and the bars are what reads at 2 m.
 */
function gullies(runs, core, fine, hard, kit, site, rand, ledger) {
  const placed = [];
  let parts = 0;
  for (const run of runs) {
    if (run.len < 14) continue;
    for (let t = 10; t < run.len - 4; t += 20) {
      const ly = lowAt(run, t);
      // 0.20 m out from the kerb face puts the 0.36 m frame just clear of it.
      const x = alongX(run, t) + run.nx * 0.20;
      const z = alongZ(run, t) + run.nz * 0.20;
      if (!site.free(x, z, 0.45)) continue;
      const shadow = ledger.resolve('core', core, 'concrete_floor', z, true);
      const gritOk = ledger.resolve('fine', fine, 'metal_rusted', z, false);
      if (shadow === null || gritOk === null) continue;
      site.occupy(x, z, 0.35);
      placed.push({ x, z, y: ly, yaw: run.yaw });

      jitterColor(_c, rand, 0.14, 0.02, 0.01);
      _c.multiplyScalar(0.78);
      core.add('concrete_floor', POOL.frame, x, ly - 0.010, z, 0, run.yaw, 0,
        1, 1, 1, _c, shadow);
      parts++;
      // The opening. Almost black, and 60 mm down, so it reads as a hole.
      _c2.setRGB(0.30, 0.30, 0.30);
      fine.add('metal_rusted', POOL.voidPlate, x, ly - 0.065, z, 0, run.yaw, 0,
        1, 1, 1, _c2, false);
      parts++;
      for (let b = 0; b < 6; b++) {
        const off = (b - 2.5) * 0.062;
        _c2.setRGB(0.62, 0.60, 0.56);
        fine.add('metal_rusted', POOL.bar,
          x + run.ux * off, ly - 0.004, z + run.uz * off,
          0, run.yaw, 0, 1, 1, 1, _c2, false);
        parts++;
      }
      // The atlas cells belong to the decal module. Guarded rather than
      // assumed: this module has to boot on a tree where that has not landed.
      const drain = kit && kit.geo && kit.geo('drain', rand);
      if (drain) {
        _c.setRGB(1, 1, 1);
        hard.add('gun_polymer', drain, x, ly + 0.006, z,
          -Math.PI / 2, 0, run.yaw, 0.45, 0.30, 1, _c, false);
        parts++;
      }
    }
  }
  return { parts, placed };
}

/**
 * The damp ring round each gully.
 *
 * Water reaches a gully before it goes down it, so the metre and a half around
 * one is darker and smoother than the rest of the road for most of the year.
 * It goes in the SOFT decal set rather than the new `decalDamp` set: soft
 * already has a bucket, so this costs no draw, and `decalDamp` has no atlas
 * bound to it here — writing `env.envOverrides.damp` to fix that would race
 * with whoever else is setting it this wave.
 */
function dampHalos(spots, soft, kit, rand) {
  if (!kit || !kit.geo) return 0;
  let count = 0;
  for (const g of spots) {
    const geo = kit.geo('damp', rand) || kit.geo('wet', rand);
    if (!geo) continue;
    const r = 1.4 + rand() * 0.4;
    _c.setRGB(0.72, 0.72, 0.74);
    soft.add('gun_polymer', geo, g.x, g.y + 0.0015, g.z,
      -Math.PI / 2, 0, rand() * 6.2832, r, r * (0.8 + rand() * 0.3), 1, _c, false);
    count++;
  }
  return count;
}

// -------------------------------------------------------------------- entry

/**
 * @param {any} ctx
 * @param {import('./layout.js').Site} site
 * @param {import('./layout.js').BatchSet} decalHard
 * @param {() => number} rand
 * @param {number} density
 * @param {any} env the wave's shared options object; every field optional
 */
export function groundworks(ctx, site, decalHard, rand, density = 1, env = {}) {
  const core = env.core;
  const fine = env.fine || core;
  const soft = env.decalSoft;
  const hard = env.decalHard || decalHard;
  const kit = env.kit;
  if (!site || !core) return { pieces: 0 };

  pools(rand);
  const runs = kerbRuns(site);
  if (!runs.length) return { pieces: 0 };

  const ledger = new Ledger([['core', core], ['fine', fine], ['soft', soft], ['hard', hard]]);

  let pieces = kerbCourse(runs, core, rand, density, ledger);
  const g = gullies(runs, core, fine, hard, kit, site, rand, ledger);
  pieces += g.parts;
  pieces += gutterDrift(runs, core, fine, site, rand, density, g.placed, ledger);
  if (soft) pieces += dampHalos(g.placed, soft, kit, rand);

  // Reported, not asserted: a bucket this module opened alone is a draw-call
  // regression, and it should be visible without re-running the A/B.
  const opened = ledger.opened();
  if (opened.length) console.warn('[groundworks] opened new batch buckets', opened);

  // The pavement surface itself is item 3's material swap on Level.js at zero
  // draws. Laying our own paver slab over the top would cost a draw and would
  // z-fight whatever is already there, so it is deliberately not done — see
  // the report if `paver` is present and the pavement still looks like
  // concrete.
  return { pieces, runs: runs.length, newBuckets: opened };
}

export { kerbRuns };
