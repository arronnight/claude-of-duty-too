import * as THREE from 'three';
import { segmentTriangleDistSq, closestPointOnTriangle } from './Geom.js';

/**
 * Continuous capsule/sphere queries against the static BVH.
 *
 * Sweeps use conservative advancement: the distance between two convex sets
 * under a linear translation is a convex, 1-Lipschitz function of time, so
 * stepping forward by (distance - skin) / speed can never step past a contact.
 * That gives an exact time of impact with no substepping and no tunnelling at
 * any speed, and the same distance routine drives depenetration, so the sweep
 * and the solver can never disagree about what is touching.
 *
 * One Sweeper owns all of its scratch; give concurrent users their own
 * instance rather than sharing.
 */

const MAX_ADVANCE_ITERS = 24;

export class SweepHit {
  constructor() {
    this.hit = false;
    this.t = 1;
    this.distance = 0;
    this.tri = -1;
    this.point = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
  }
}

export class Sweeper {
  constructor(bvh, maxCandidates = 2048, skin = 0.004) {
    this.bvh = bvh;
    // Sweeps stop this far short of the surface. A player capsule wants a few
    // millimetres of slack; a 6 mm shell casing would visibly float.
    this.skin = skin;
    this.cand = new Int32Array(maxCandidates);
    this.candCount = 0;
    this.result = new SweepHit();
    this.closest = { hit: false, distance: 0, tri: -1, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) };
    this._segPt = new THREE.Vector3();
    this._triPt = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._face = new THREE.Vector3();
    this.push = new THREE.Vector3();
    this.contactNormal = new THREE.Vector3(0, 1, 0);
    this.contactCount = 0;
  }

  /**
   * Resolve a contact direction into `this._n`, oriented from the triangle
   * towards the capsule. Interior contacts and contacts on triangulation seams
   * use the face normal; contacts on genuinely convex edges keep the exact
   * closest-point direction so a capsule still rolls over a kerb properly.
   */
  _contactNormal(tri, d, segPt, triPt, ux, uy, uz) {
    const bvh = this.bvh;
    bvh.faceNormal(tri, this._face);
    const fx = this._face.x, fy = this._face.y, fz = this._face.z;
    if (d <= 1e-6) {
      const s = ux * fx + uy * fy + uz * fz;
      this._n.set(s > 0 ? -fx : fx, s > 0 ? -fy : fy, s > 0 ? -fz : fz);
      return;
    }
    const sx = segPt.x - triPt.x, sy = segPt.y - triPt.y, sz = segPt.z - triPt.z;
    const side = sx * fx + sy * fy + sz * fz;
    const flip = side < 0 ? -1 : 1;
    if (Math.abs(side) >= d - 1e-5 || this._seamContact(tri, triPt)) {
      this._n.set(fx * flip, fy * flip, fz * flip);
      return;
    }
    const inv = 1 / d;
    this._n.set(sx * inv, sy * inv, sz * inv);
  }

  _seamContact(tri, p) {
    const flags = this.bvh.edgeFlags[tri];
    if (!flags) return false;
    const pos = this.bvh.pos, o = tri * 9;
    let bestE = -1, best = Infinity;
    for (let e = 0; e < 3; e++) {
      const a = o + e * 3, b = o + ((e + 1) % 3) * 3;
      const ex = pos[b] - pos[a], ey = pos[b + 1] - pos[a + 1], ez = pos[b + 2] - pos[a + 2];
      const wx = p.x - pos[a], wy = p.y - pos[a + 1], wz = p.z - pos[a + 2];
      const ll = ex * ex + ey * ey + ez * ez;
      let s = ll > 1e-12 ? (wx * ex + wy * ey + wz * ez) / ll : 0;
      if (s < 0) s = 0; else if (s > 1) s = 1;
      const cx = wx - ex * s, cy = wy - ey * s, cz = wz - ez * s;
      const dd = cx * cx + cy * cy + cz * cz;
      if (dd < best) { best = dd; bestE = e; }
    }
    return bestE >= 0 && (flags & (1 << bestE)) !== 0;
  }

  gather(minx, miny, minz, maxx, maxy, maxz, mask) {
    this.candCount = this.bvh.queryBox(minx, miny, minz, maxx, maxy, maxz, mask, this.cand);
    return this.candCount;
  }

  /**
   * Swept capsule (segment A-B, radius r) along (dx,dy,dz). `out.t` is the
   * fraction of the motion consumed before contact.
   */
  sweepCapsule(ax, ay, az, bx, by, bz, r, dx, dy, dz, mask, out) {
    out.hit = false;
    out.t = 1;
    out.tri = -1;
    const bvh = this.bvh;
    if (!bvh.triCount) return false;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return false;

    const skin = this.skin;
    const pad = r + skin * 2;
    const minx = Math.min(ax, bx) + Math.min(0, dx) - pad;
    const miny = Math.min(ay, by) + Math.min(0, dy) - pad;
    const minz = Math.min(az, bz) + Math.min(0, dz) - pad;
    const maxx = Math.max(ax, bx) + Math.max(0, dx) + pad;
    const maxy = Math.max(ay, by) + Math.max(0, dy) + pad;
    const maxz = Math.max(az, bz) + Math.max(0, dz) + pad;
    const n = this.gather(minx, miny, minz, maxx, maxy, maxz, mask);
    if (!n) return false;

    const pos = bvh.pos;
    const invLen = 1 / len;
    const ux = dx * invLen, uy = dy * invLen, uz = dz * invLen;
    let bestT = 1;

    for (let ci = 0; ci < n; ci++) {
      const tri = this.cand[ci];
      const p = tri * 9;
      const t0x = pos[p], t0y = pos[p + 1], t0z = pos[p + 2];
      const t1x = pos[p + 3], t1y = pos[p + 4], t1z = pos[p + 5];
      const t2x = pos[p + 6], t2y = pos[p + 7], t2z = pos[p + 8];

      let nx = 0, ny = 0, nz = 0;
      let oriented = false;
      let t = 0;
      let hitThis = false;
      for (let it = 0; it < MAX_ADVANCE_ITERS; it++) {
        const ox = dx * t, oy = dy * t, oz = dz * t;
        const d2 = segmentTriangleDistSq(
          ax + ox, ay + oy, az + oz, bx + ox, by + oy, bz + oz,
          t0x, t0y, t0z, t1x, t1y, t1z, t2x, t2y, t2z,
          this._segPt, this._triPt,
        );
        const d = Math.sqrt(d2);
        const gap = d - r;
        if (!oriented) {
          oriented = true;
          this._contactNormal(tri, d, this._segPt, this._triPt, ux, uy, uz);
          nx = this._n.x; ny = this._n.y; nz = this._n.z;
          // Distance between two convex sets under a linear translation is
          // convex, so it never dips below its tangent at t=0: if the tangent
          // still clears the triangle at the end of the sweep, contact is
          // impossible. This is what lets a capsule already resting on a
          // surface keep sliding along it instead of blocking every tick.
          if (gap >= 0) {
            const closing = ux * nx + uy * ny + uz * nz;
            if (closing >= -1e-9 || gap + closing * len > 0) break;
          }
        }
        if (gap <= skin) { hitThis = true; break; }
        t += (gap - skin * 0.5) * invLen;
        if (t >= bestT) break;
      }
      if (!hitThis || t >= bestT) continue;

      bestT = t < 0 ? 0 : t;
      out.hit = true;
      out.tri = tri;
      out.t = bestT;
      out.point.copy(this._triPt);
      out.normal.set(nx, ny, nz);
    }
    out.distance = out.hit ? bestT * len : len;
    return out.hit;
  }

  /**
   * Gauss-Seidel depenetration. Accumulates the offset that lifts the capsule
   * out of every overlapping triangle into `this.push` and reports the most
   * upward contact normal in `this.contactNormal`.
   *
   * Surface contacts are resolved along the closest-point direction, which is
   * always correct while the capsule centre is outside. If a pass finds only
   * back-face contacts the capsule is genuinely buried in a solid (a bad spawn,
   * a door closing on it), and the closest-point direction would just bounce it
   * between two faces forever — so it takes the shallowest face-normal exit
   * instead, which is the minimum translation out of the volume.
   */
  depenetrate(ax, ay, az, bx, by, bz, r, mask, passes) {
    this.push.set(0, 0, 0);
    this.contactCount = 0;
    this.contactNormal.set(0, 1, 0);
    const bvh = this.bvh;
    if (!bvh.triCount) return 0;
    const pad = r + 0.35;
    const n = this.gather(
      Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.min(az, bz) - pad,
      Math.max(ax, bx) + pad, Math.max(ay, by) + pad, Math.max(az, bz) + pad,
      mask,
    );
    if (!n) return 0;
    const pos = bvh.pos;
    let ox = 0, oy = 0, oz = 0;
    let bestUp = -2;
    for (let pass = 0; pass < passes; pass++) {
      let surfaceHits = 0;
      let buriedExit = Infinity;
      let bnx = 0, bny = 0, bnz = 0;
      for (let ci = 0; ci < n; ci++) {
        const tri = this.cand[ci];
        const p = tri * 9;
        const d2 = segmentTriangleDistSq(
          ax + ox, ay + oy, az + oz, bx + ox, by + oy, bz + oz,
          pos[p], pos[p + 1], pos[p + 2], pos[p + 3], pos[p + 4], pos[p + 5], pos[p + 6], pos[p + 7], pos[p + 8],
          this._segPt, this._triPt,
        );
        const d = Math.sqrt(d2);
        if (d >= r) continue;
        bvh.faceNormal(tri, this._face);
        const side = this._face.x * (this._segPt.x - this._triPt.x)
          + this._face.y * (this._segPt.y - this._triPt.y)
          + this._face.z * (this._segPt.z - this._triPt.z);
        if (side < 0 || d <= 1e-6) {
          const exit = r - side;
          if (exit < buriedExit) {
            buriedExit = exit;
            bnx = this._face.x; bny = this._face.y; bnz = this._face.z;
          }
          continue;
        }
        this._contactNormal(tri, d, this._segPt, this._triPt, 0, 0, 0);
        const nx = this._n.x, ny = this._n.y, nz = this._n.z;
        const depth = r - d + 1e-4;
        ox += nx * depth; oy += ny * depth; oz += nz * depth;
        if (depth > 1e-3) surfaceHits++;
        if (pass === 0) {
          this.contactCount++;
          if (ny > bestUp) { bestUp = ny; this.contactNormal.set(nx, ny, nz); }
        }
      }
      if (surfaceHits === 0) {
        if (buriedExit === Infinity) break;
        ox += bnx * (buriedExit + 1e-3);
        oy += bny * (buriedExit + 1e-3);
        oz += bnz * (buriedExit + 1e-3);
        this.contactCount++;
        if (bny > bestUp) { bestUp = bny; this.contactNormal.set(bnx, bny, bnz); }
      }
    }
    this.push.set(ox, oy, oz);
    return this.contactCount;
  }

  /** Nearest point on the static world within `maxDist` of a point. */
  closestPoint(px, py, pz, maxDist, mask) {
    const c = this.closest;
    c.hit = false;
    c.distance = maxDist;
    c.tri = -1;
    const bvh = this.bvh;
    if (!bvh.triCount) return c;
    const n = this.gather(px - maxDist, py - maxDist, pz - maxDist, px + maxDist, py + maxDist, pz + maxDist, mask);
    if (!n) return c;
    const pos = bvh.pos;
    let best = maxDist * maxDist;
    for (let ci = 0; ci < n; ci++) {
      const tri = this.cand[ci];
      const p = tri * 9;
      closestPointOnTriangle(
        px, py, pz,
        pos[p], pos[p + 1], pos[p + 2], pos[p + 3], pos[p + 4], pos[p + 5], pos[p + 6], pos[p + 7], pos[p + 8],
        this._triPt,
      );
      const dx = px - this._triPt.x, dy = py - this._triPt.y, dz = pz - this._triPt.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) {
        best = d2;
        c.hit = true;
        c.tri = tri;
        c.point.copy(this._triPt);
      }
    }
    if (c.hit) {
      c.distance = Math.sqrt(best);
      if (c.distance > 1e-6) {
        c.normal.set(px - c.point.x, py - c.point.y, pz - c.point.z).multiplyScalar(1 / c.distance);
      } else {
        bvh.faceNormal(c.tri, c.normal);
      }
    }
    return c;
  }
}
