import * as THREE from 'three';

/**
 * Convex-polygon navigation mesh: A* over polygons, then the simple stupid
 * funnel algorithm to pull the corridor into a straight-line path.
 *
 * `ctx.level.navPolys` is a list of `{ y, points: [[x,z], ...] }` convex
 * polygons. Nothing in the contract says they share edges, and in the current
 * blockout they do not — the street quad and the room quad are 1.4 m apart
 * across a pavement — so adjacency is recovered geometrically: any two edges
 * that are near-collinear, facing each other and overlapping get a portal,
 * provided a line-of-sight probe across the gap is clear. That makes the door
 * of a room connect to the street it opens onto without the level author
 * having to author the link, and it degrades to exact shared-edge matching
 * when a real navmesh arrives.
 *
 * Everything runs on flat typed arrays and preallocated scratch, so a path
 * query allocates nothing. Paths are only recomputed when a bot's goal moves
 * more than a metre, so the cost is a handful of queries a second across the
 * whole squad.
 */

const MAX_POLYS = 256;
const MAX_PORTALS = 1024;
const MAX_PATH = 64;
const EPS = 1e-5;

/** 2D cross product in the XZ plane. */
function crossXZ(ax, az, bx, bz) {
  return ax * bz - az * bx;
}

/**
 * Twice the signed area of triangle abc in XZ — the funnel's core predicate.
 * Sign convention follows Mononen's reference implementation exactly
 * (`bx*ay - ax*by`, i.e. the negated XZ cross product); getting it backwards
 * inverts left and right and the funnel walks to the far side of every corner.
 */
function triarea2(ax, az, bx, bz, cx, cz) {
  return (cx - ax) * (bz - az) - (bx - ax) * (cz - az);
}

const _v = new THREE.Vector3();

export class NavMesh {
  constructor() {
    this.polys = [];
    this.portals = [];
    this.bounds = new THREE.Box3();
    this.ready = false;

    // A* working set, sized once.
    this._g = new Float32Array(MAX_POLYS);
    this._f = new Float32Array(MAX_POLYS);
    this._from = new Int32Array(MAX_POLYS);
    this._state = new Uint8Array(MAX_POLYS);   // 0 unseen, 1 open, 2 closed
    this._open = new Int32Array(MAX_POLYS);
    this._openN = 0;
    this._corridor = new Int32Array(MAX_PATH);
    this._corridorN = 0;
    // Funnel portals: [leftX, leftZ, rightX, rightZ] per entry.
    this._fx = new Float32Array(MAX_PATH * 4);
    this._fn = 0;
    this.stats = { queries: 0, expansions: 0 };
  }

  /**
   * @param {Array} navPolys      from `ctx.level.navPolys`
   * @param {(ax,az,bx,bz,y)=>boolean} losFn  optional walkable-gap probe
   */
  build(navPolys, losFn) {
    this.polys.length = 0;
    this.portals.length = 0;
    this.ready = false;
    if (!Array.isArray(navPolys) || navPolys.length === 0) return this;

    for (const src of navPolys) {
      const raw = src?.points || src?.pts || src;
      if (!Array.isArray(raw) || raw.length < 3) continue;
      if (this.polys.length >= MAX_POLYS) break;
      const n = raw.length;
      const pts = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const p = raw[i];
        pts[i * 2] = Array.isArray(p) ? p[0] : p.x;
        pts[i * 2 + 1] = Array.isArray(p) ? (p.length > 2 ? p[2] : p[1]) : (p.z ?? p.y);
      }
      // Normalise to counter-clockwise-in-XZ so edge order is predictable.
      let area = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        area += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
      }
      if (area < 0) {
        for (let i = 0, k = n - 1; i < k; i++, k--) {
          const x = pts[i * 2], z = pts[i * 2 + 1];
          pts[i * 2] = pts[k * 2]; pts[i * 2 + 1] = pts[k * 2 + 1];
          pts[k * 2] = x; pts[k * 2 + 1] = z;
        }
      }
      let cx = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; }
      this.polys.push({
        id: this.polys.length,
        y: src?.y ?? 0,
        pts, n,
        cx: cx / n, cz: cz / n,
        area: Math.abs(area) * 0.5,
        links: [],
      });
    }

    this._link(losFn);
    this._computeBounds();
    this.ready = this.polys.length > 0;
    return this;
  }

  /** Portal recovery. See the class comment for why this is geometric. */
  _link(losFn) {
    const TOL = 2.2;          // widest gap that still counts as connected
    const MIN_OVERLAP = 0.45; // narrower than a shoulder is not a doorway
    const polys = this.polys;
    for (let a = 0; a < polys.length; a++) {
      for (let b = a + 1; b < polys.length; b++) {
        const pa = polys[a], pb = polys[b];
        for (let i = 0; i < pa.n; i++) {
          const ax0 = pa.pts[i * 2], az0 = pa.pts[i * 2 + 1];
          const j0 = (i + 1) % pa.n;
          const ax1 = pa.pts[j0 * 2], az1 = pa.pts[j0 * 2 + 1];
          const adx = ax1 - ax0, adz = az1 - az0;
          const alen = Math.hypot(adx, adz);
          if (alen < MIN_OVERLAP) continue;
          const aux = adx / alen, auz = adz / alen;

          for (let k = 0; k < pb.n; k++) {
            const bx0 = pb.pts[k * 2], bz0 = pb.pts[k * 2 + 1];
            const k0 = (k + 1) % pb.n;
            const bx1 = pb.pts[k0 * 2], bz1 = pb.pts[k0 * 2 + 1];
            const bdx = bx1 - bx0, bdz = bz1 - bz0;
            const blen = Math.hypot(bdx, bdz);
            if (blen < MIN_OVERLAP) continue;
            // Edges must be near parallel; shared edges are antiparallel
            // because both polys wind the same way.
            const dot = (adx * bdx + adz * bdz) / (alen * blen);
            if (Math.abs(dot) < 0.965) continue;

            // Perpendicular separation, and the overlap of B projected on A.
            const perp0 = crossXZ(aux, auz, bx0 - ax0, bz0 - az0);
            const perp1 = crossXZ(aux, auz, bx1 - ax0, bz1 - az0);
            if (Math.abs(perp0) > TOL || Math.abs(perp1) > TOL) continue;
            if (Math.abs(perp0 - perp1) > 0.35) continue;

            let t0 = (bx0 - ax0) * aux + (bz0 - az0) * auz;
            let t1 = (bx1 - ax0) * aux + (bz1 - az0) * auz;
            if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
            const lo = Math.max(0, t0), hi = Math.min(alen, t1);
            if (hi - lo < MIN_OVERLAP) continue;

            const half = (perp0 + perp1) * 0.25; // half the gap, signed
            const y = Math.max(pa.y, pb.y);
            let s0 = lo, s1 = hi;

            if (Math.abs(half) > 0.06 && losFn) {
              // A real gap between two polygons is only a portal where it is
              // actually open. Sample across the overlap and keep the longest
              // clear run — that finds the doorway in a wall instead of
              // declaring the whole wall walkable because its midpoint
              // happened to be a door.
              const span = hi - lo;
              const steps = Math.max(2, Math.min(24, Math.round(span / 0.3)));
              const px = -auz * Math.abs(half) * 2.6, pz = aux * Math.abs(half) * 2.6;
              let runStart = -1, bestA = 0, bestB = -1;
              for (let q = 0; q <= steps; q++) {
                const t = lo + (span * q) / steps;
                const sx = ax0 + aux * t - auz * half;
                const sz = az0 + auz * t + aux * half;
                const clear = losFn(sx - px, sz - pz, sx + px, sz + pz, y);
                if (clear && runStart < 0) runStart = t;
                if ((!clear || q === steps) && runStart >= 0) {
                  const end = clear ? t : lo + (span * (q - 0.5)) / steps;
                  if (end - runStart > bestB - bestA) { bestA = runStart; bestB = end; }
                  runStart = -1;
                }
              }
              if (bestB - bestA < MIN_OVERLAP) continue;
              s0 = bestA; s1 = bestB;
            }

            // Shrink a little so an agent hugging the edge misses the jamb.
            const inset = Math.min(0.3, (s1 - s0) * 0.28);
            s0 += inset; s1 -= inset;
            this._addPortal(pa, pb,
              ax0 + aux * s0 - auz * half, az0 + auz * s0 + aux * half,
              ax0 + aux * s1 - auz * half, az0 + auz * s1 + aux * half);
            i = pa.n; // one portal per poly pair is plenty at this scale
            break;
          }
        }
      }
    }
  }

  _addPortal(pa, pb, x0, z0, x1, z1) {
    if (this.portals.length >= MAX_PORTALS) return;
    const p = {
      id: this.portals.length,
      a: pa.id, b: pb.id,
      x0, z0, x1, z1,
      mx: (x0 + x1) * 0.5, mz: (z0 + z1) * 0.5,
    };
    this.portals.push(p);
    pa.links.push({ poly: pb.id, portal: p.id });
    pb.links.push({ poly: pa.id, portal: p.id });
  }

  _computeBounds() {
    this.bounds.makeEmpty();
    for (const p of this.polys) {
      for (let i = 0; i < p.n; i++) {
        _v.set(p.pts[i * 2], p.y, p.pts[i * 2 + 1]);
        this.bounds.expandByPoint(_v);
      }
    }
  }

  // ------------------------------------------------------------- containment

  containsXZ(poly, x, z) {
    const p = poly.pts, n = poly.n;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ex = p[i * 2] - p[j * 2], ez = p[i * 2 + 1] - p[j * 2 + 1];
      if (crossXZ(ex, ez, x - p[j * 2], z - p[j * 2 + 1]) < -EPS) return false;
    }
    return true;
  }

  /** Index of the poly containing (x,z), or the nearest one within `maxDist`. */
  findPoly(x, z, maxDist = 6) {
    let best = -1, bestD = maxDist * maxDist;
    for (let i = 0; i < this.polys.length; i++) {
      if (this.containsXZ(this.polys[i], x, z)) return i;
    }
    for (let i = 0; i < this.polys.length; i++) {
      const d = this._distToPolySq(this.polys[i], x, z);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  _distToPolySq(poly, x, z) {
    const p = poly.pts, n = poly.n;
    let best = Infinity;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = p[j * 2], az = p[j * 2 + 1];
      const bx = p[i * 2], bz = p[i * 2 + 1];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t - x, qz = az + dz * t - z;
      const d = qx * qx + qz * qz;
      if (d < best) best = d;
    }
    return best;
  }

  /** Nearest walkable point to (x,z); writes into `out` and returns the poly index. */
  clamp(x, z, out) {
    const pi = this.findPoly(x, z, 1e6);
    if (pi < 0) { out.set(x, 0, z); return -1; }
    const poly = this.polys[pi];
    if (this.containsXZ(poly, x, z)) { out.set(x, poly.y, z); return pi; }
    const p = poly.pts, n = poly.n;
    let best = Infinity, bx = x, bz = z;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = p[j * 2], az = p[j * 2 + 1];
      const cx = p[i * 2], cz = p[i * 2 + 1];
      const dx = cx - ax, dz = cz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t, qz = az + dz * t;
      const d = (qx - x) * (qx - x) + (qz - z) * (qz - z);
      if (d < best) { best = d; bx = qx; bz = qz; }
    }
    // Nudge inside so the point is not exactly on the boundary.
    out.set(bx + (poly.cx - bx) * 0.02, poly.y, bz + (poly.cz - bz) * 0.02);
    return pi;
  }

  /** Floor height at (x,z), or `fallback` when off-mesh. */
  heightAt(x, z, fallback = 0) {
    const pi = this.findPoly(x, z, 2);
    return pi >= 0 ? this.polys[pi].y : fallback;
  }

  /** True when the straight XZ segment stays on the mesh. */
  isStraightWalkable(ax, az, bx, bz, step = 0.7) {
    if (!this.ready) return true;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (this.findPoly(ax + dx * t, az + dz * t, 0.35) < 0) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------- A*

  /**
   * @param {THREE.Vector3} start
   * @param {THREE.Vector3} goal
   * @param {{xz: Float32Array, count: number}} out preallocated result
   * @returns {boolean} true when a corridor was found (out holds the pulled path)
   */
  findPath(start, goal, out) {
    out.count = 0;
    if (!this.ready) return false;
    this.stats.queries++;
    const sp = this.findPoly(start.x, start.z, 4);
    const gp = this.findPoly(goal.x, goal.z, 4);
    if (sp < 0 || gp < 0) return false;

    if (sp === gp) {
      out.xz[0] = start.x; out.xz[1] = start.z;
      out.xz[2] = goal.x; out.xz[3] = goal.z;
      out.count = 2;
      return true;
    }

    const polys = this.polys;
    const n = polys.length;
    this._state.fill(0, 0, n);
    this._openN = 0;
    this._g[sp] = 0;
    this._f[sp] = Math.hypot(polys[gp].cx - start.x, polys[gp].cz - start.z);
    this._from[sp] = -1;
    this._state[sp] = 1;
    this._open[this._openN++] = sp;

    let found = false;
    while (this._openN > 0) {
      // Linear scan: with a few dozen polys a binary heap is slower.
      let bi = 0;
      for (let i = 1; i < this._openN; i++) if (this._f[this._open[i]] < this._f[this._open[bi]]) bi = i;
      const cur = this._open[bi];
      this._open[bi] = this._open[--this._openN];
      if (cur === gp) { found = true; break; }
      this._state[cur] = 2;
      this.stats.expansions++;

      const links = polys[cur].links;
      for (let i = 0; i < links.length; i++) {
        const nb = links[i].poly;
        if (this._state[nb] === 2) continue;
        const portal = this.portals[links[i].portal];
        const cost = this._g[cur] +
          Math.hypot(portal.mx - polys[cur].cx, portal.mz - polys[cur].cz) +
          Math.hypot(polys[nb].cx - portal.mx, polys[nb].cz - portal.mz);
        if (this._state[nb] === 1 && cost >= this._g[nb]) continue;
        this._g[nb] = cost;
        this._f[nb] = cost + Math.hypot(goal.x - polys[nb].cx, goal.z - polys[nb].cz);
        this._from[nb] = cur;
        if (this._state[nb] !== 1) {
          this._state[nb] = 1;
          if (this._openN < MAX_POLYS) this._open[this._openN++] = nb;
        }
      }
    }
    if (!found) return false;

    // Unwind into the corridor, start-first.
    let c = gp, len = 0;
    while (c >= 0 && len < MAX_PATH) { this._corridor[len++] = c; c = this._from[c]; }
    for (let i = 0, j = len - 1; i < j; i++, j--) {
      const t = this._corridor[i]; this._corridor[i] = this._corridor[j]; this._corridor[j] = t;
    }
    this._corridorN = len;
    this._buildFunnel(start, goal);
    return this._pull(start, goal, out);
  }

  /** Ordered left/right portal pairs along the corridor. */
  _buildFunnel(start, goal) {
    const f = this._fx;
    let m = 0;
    f[0] = start.x; f[1] = start.z; f[2] = start.x; f[3] = start.z;
    m = 1;
    for (let i = 0; i < this._corridorN - 1; i++) {
      const a = this.polys[this._corridor[i]];
      const b = this.polys[this._corridor[i + 1]];
      let portal = null;
      for (const l of a.links) if (l.poly === b.id) { portal = this.portals[l.portal]; break; }
      if (!portal) continue;
      // "Left" is the endpoint on the positive side of the travel direction:
      // with triarea2's XZ cross this is the endpoint p where
      // cross(dir, p - mid) > 0, which is what the funnel below expects.
      const dx = b.cx - a.cx, dz = b.cz - a.cz;
      const s = crossXZ(dx, dz, portal.x0 - portal.mx, portal.z0 - portal.mz);
      const lx = s > 0 ? portal.x0 : portal.x1;
      const lz = s > 0 ? portal.z0 : portal.z1;
      const rx = s > 0 ? portal.x1 : portal.x0;
      const rz = s > 0 ? portal.z1 : portal.z0;
      f[m * 4] = lx; f[m * 4 + 1] = lz; f[m * 4 + 2] = rx; f[m * 4 + 3] = rz;
      m++;
    }
    f[m * 4] = goal.x; f[m * 4 + 1] = goal.z; f[m * 4 + 2] = goal.x; f[m * 4 + 3] = goal.z;
    m++;
    this._fn = m;
  }

  /** Simple stupid funnel (Mononen). */
  _pull(start, goal, out) {
    const f = this._fx;
    const n = this._fn;
    let apexX = start.x, apexZ = start.z;
    let leftX = start.x, leftZ = start.z;
    let rightX = start.x, rightZ = start.z;
    let apexI = 0, leftI = 0, rightI = 0;
    let count = 0;
    const push = (x, z) => {
      if (count > 0 && Math.abs(out.xz[(count - 1) * 2] - x) < 1e-4 &&
        Math.abs(out.xz[(count - 1) * 2 + 1] - z) < 1e-4) return;
      if (count * 2 + 1 >= out.xz.length) return;
      out.xz[count * 2] = x; out.xz[count * 2 + 1] = z; count++;
    };
    push(start.x, start.z);

    for (let i = 1; i < n; i++) {
      const lx = f[i * 4], lz = f[i * 4 + 1];
      const rx = f[i * 4 + 2], rz = f[i * 4 + 3];

      if (triarea2(apexX, apexZ, rightX, rightZ, rx, rz) <= 0) {
        if ((apexX === rightX && apexZ === rightZ) ||
          triarea2(apexX, apexZ, leftX, leftZ, rx, rz) > 0) {
          rightX = rx; rightZ = rz; rightI = i;
        } else {
          push(leftX, leftZ);
          apexX = leftX; apexZ = leftZ; apexI = leftI;
          leftX = apexX; leftZ = apexZ; rightX = apexX; rightZ = apexZ;
          leftI = apexI; rightI = apexI;
          i = apexI;
          continue;
        }
      }
      if (triarea2(apexX, apexZ, leftX, leftZ, lx, lz) >= 0) {
        if ((apexX === leftX && apexZ === leftZ) ||
          triarea2(apexX, apexZ, rightX, rightZ, lx, lz) < 0) {
          leftX = lx; leftZ = lz; leftI = i;
        } else {
          push(rightX, rightZ);
          apexX = rightX; apexZ = rightZ; apexI = rightI;
          leftX = apexX; leftZ = apexZ; rightX = apexX; rightZ = apexZ;
          leftI = apexI; rightI = apexI;
          i = apexI;
          continue;
        }
      }
    }
    push(goal.x, goal.z);
    out.count = count;
    return count > 0;
  }
}

/** Result buffer for `findPath`, one per agent. */
export function makePathBuffer(max = MAX_PATH) {
  return { xz: new Float32Array(max * 2), count: 0, cursor: 0 };
}
