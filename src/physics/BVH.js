import * as THREE from 'three';

/**
 * Binned-SAH bounding volume hierarchy over a flat triangle soup.
 *
 * Everything lives in typed arrays — node boxes in one interleaved
 * Float32Array, child/leaf links in Int32Arrays, triangle vertices packed nine
 * floats at a time — because a bullet-heavy frame issues 100+ rays and a tree
 * of JS objects would spend all of its time chasing pointers. After the build
 * the triangle data is permuted into leaf order so a leaf's vertices are
 * contiguous in memory.
 */

const BINS = 12;
const LEAF_TRIS = 4;
const TRAVERSE_COST = 0.6;
const MAX_DEPTH = 56;

const _leftArea = new Float32Array(BINS - 1);
const _leftCount = new Int32Array(BINS - 1);
const _binCount = new Int32Array(BINS);
const _binBox = new Float32Array(BINS * 6);

export class BVH {
  constructor() {
    this.triCount = 0;
    this.nodeCount = 0;
    this.maxDepth = 0;
    this.buildMs = 0;
    this.pos = null;      // Float32Array, 9 floats per triangle
    this.nrm = null;      // Float32Array, 9 floats per triangle (vertex normals)
    this.obj = null;      // Int32Array, source object index per triangle
    this.mat = null;      // Int32Array, material-key index per triangle
    this.layer = null;    // Uint8Array, collision mask bits per triangle
    this.nodeBox = null;  // Float32Array, [minx,miny,minz,maxx,maxy,maxz] per node
    this.nodeLeft = null; // Int32Array, first triangle (leaf) or left child (interior)
    this.nodeTris = null; // Int32Array, triangle count, 0 for interior nodes
    this.edgeFlags = new Uint8Array(0); // bit k set = edge k is a triangulation seam
    this.bounds = new THREE.Box3();
    this.hitTri = -1;
    this.hitT = 0;
    this.hitU = 0;
    this.hitV = 0;
    this._stack = new Int32Array(128);
    this._qstack = new Int32Array(128);
  }

  build(pos, nrm, obj, mat, layer, count) {
    const t0 = performance.now();
    this.triCount = count | 0;
    this.nodeCount = 0;
    this.maxDepth = 0;
    this.pos = pos; this.nrm = nrm; this.obj = obj; this.mat = mat; this.layer = layer;
    if (!count) {
      this.bounds.makeEmpty();
      this.buildMs = 0;
      return;
    }

    const maxNodes = 2 * count;
    const nodeBox = this.nodeBox = new Float32Array(maxNodes * 6);
    const nodeLeft = this.nodeLeft = new Int32Array(maxNodes);
    const nodeTris = this.nodeTris = new Int32Array(maxNodes);

    const idx = new Int32Array(count);
    const cen = new Float32Array(count * 3);
    const tb = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      idx[i] = i;
      const p = i * 9;
      const x0 = pos[p], y0 = pos[p + 1], z0 = pos[p + 2];
      const x1 = pos[p + 3], y1 = pos[p + 4], z1 = pos[p + 5];
      const x2 = pos[p + 6], y2 = pos[p + 7], z2 = pos[p + 8];
      const b = i * 6;
      tb[b] = Math.min(x0, x1, x2); tb[b + 1] = Math.min(y0, y1, y2); tb[b + 2] = Math.min(z0, z1, z2);
      tb[b + 3] = Math.max(x0, x1, x2); tb[b + 4] = Math.max(y0, y1, y2); tb[b + 5] = Math.max(z0, z1, z2);
      const c = i * 3;
      cen[c] = (x0 + x1 + x2) / 3; cen[c + 1] = (y0 + y1 + y2) / 3; cen[c + 2] = (z0 + z1 + z2) / 3;
    }

    nodeLeft[0] = 0;
    nodeTris[0] = count;
    let nodesUsed = 1;
    const stack = [0];
    const dstack = [0];

    while (stack.length) {
      const n = stack.pop();
      const depth = dstack.pop();
      if (depth > this.maxDepth) this.maxDepth = depth;
      const first = nodeLeft[n];
      const cnt = nodeTris[n];

      let nx0 = Infinity, ny0 = Infinity, nz0 = Infinity;
      let nx1 = -Infinity, ny1 = -Infinity, nz1 = -Infinity;
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity;
      let cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let i = first, e = first + cnt; i < e; i++) {
        const t = idx[i], b = t * 6, c = t * 3;
        if (tb[b] < nx0) nx0 = tb[b];
        if (tb[b + 1] < ny0) ny0 = tb[b + 1];
        if (tb[b + 2] < nz0) nz0 = tb[b + 2];
        if (tb[b + 3] > nx1) nx1 = tb[b + 3];
        if (tb[b + 4] > ny1) ny1 = tb[b + 4];
        if (tb[b + 5] > nz1) nz1 = tb[b + 5];
        if (cen[c] < cx0) cx0 = cen[c];
        if (cen[c + 1] < cy0) cy0 = cen[c + 1];
        if (cen[c + 2] < cz0) cz0 = cen[c + 2];
        if (cen[c] > cx1) cx1 = cen[c];
        if (cen[c + 1] > cy1) cy1 = cen[c + 1];
        if (cen[c + 2] > cz1) cz1 = cen[c + 2];
      }
      const nb = n * 6;
      nodeBox[nb] = nx0; nodeBox[nb + 1] = ny0; nodeBox[nb + 2] = nz0;
      nodeBox[nb + 3] = nx1; nodeBox[nb + 4] = ny1; nodeBox[nb + 5] = nz1;
      if (cnt <= LEAF_TRIS || depth >= MAX_DEPTH) continue;

      const ex = nx1 - nx0, ey = ny1 - ny0, ez = nz1 - nz0;
      const parentArea = 2 * (ex * ey + ey * ez + ez * ex) || 1e-9;
      let bestAxis = -1, bestPos = 0, bestCost = cnt;

      // Above a few thousand triangles the SAH gain from testing all three axes
      // is not worth the build time; the widest axis is a good proxy.
      let axis0 = 0, axis1 = 3;
      if (cnt > 8192) {
        axis0 = ex > ey ? (ex > ez ? 0 : 2) : (ey > ez ? 1 : 2);
        axis1 = axis0 + 1;
      }

      for (let a = axis0; a < axis1; a++) {
        const cmin = a === 0 ? cx0 : a === 1 ? cy0 : cz0;
        const cmax = a === 0 ? cx1 : a === 1 ? cy1 : cz1;
        const extent = cmax - cmin;
        if (extent < 1e-9) continue;
        const scale = BINS / extent;
        for (let k = 0; k < BINS; k++) {
          _binCount[k] = 0;
          const bb = k * 6;
          _binBox[bb] = Infinity; _binBox[bb + 1] = Infinity; _binBox[bb + 2] = Infinity;
          _binBox[bb + 3] = -Infinity; _binBox[bb + 4] = -Infinity; _binBox[bb + 5] = -Infinity;
        }
        for (let i = first, e = first + cnt; i < e; i++) {
          const t = idx[i];
          let k = ((cen[t * 3 + a] - cmin) * scale) | 0;
          if (k < 0) k = 0; else if (k >= BINS) k = BINS - 1;
          _binCount[k]++;
          const bb = k * 6, tb6 = t * 6;
          if (tb[tb6] < _binBox[bb]) _binBox[bb] = tb[tb6];
          if (tb[tb6 + 1] < _binBox[bb + 1]) _binBox[bb + 1] = tb[tb6 + 1];
          if (tb[tb6 + 2] < _binBox[bb + 2]) _binBox[bb + 2] = tb[tb6 + 2];
          if (tb[tb6 + 3] > _binBox[bb + 3]) _binBox[bb + 3] = tb[tb6 + 3];
          if (tb[tb6 + 4] > _binBox[bb + 4]) _binBox[bb + 4] = tb[tb6 + 4];
          if (tb[tb6 + 5] > _binBox[bb + 5]) _binBox[bb + 5] = tb[tb6 + 5];
        }
        let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity;
        let lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, lc = 0;
        for (let k = 0; k < BINS - 1; k++) {
          const bb = k * 6;
          lc += _binCount[k];
          if (_binBox[bb] < lx0) lx0 = _binBox[bb];
          if (_binBox[bb + 1] < ly0) ly0 = _binBox[bb + 1];
          if (_binBox[bb + 2] < lz0) lz0 = _binBox[bb + 2];
          if (_binBox[bb + 3] > lx1) lx1 = _binBox[bb + 3];
          if (_binBox[bb + 4] > ly1) ly1 = _binBox[bb + 4];
          if (_binBox[bb + 5] > lz1) lz1 = _binBox[bb + 5];
          _leftCount[k] = lc;
          const dx = lx1 - lx0, dy = ly1 - ly0, dz = lz1 - lz0;
          _leftArea[k] = lc ? 2 * (dx * dy + dy * dz + dz * dx) : 0;
        }
        let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity;
        let rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rc = 0;
        for (let k = BINS - 1; k > 0; k--) {
          const bb = k * 6;
          rc += _binCount[k];
          if (_binBox[bb] < rx0) rx0 = _binBox[bb];
          if (_binBox[bb + 1] < ry0) ry0 = _binBox[bb + 1];
          if (_binBox[bb + 2] < rz0) rz0 = _binBox[bb + 2];
          if (_binBox[bb + 3] > rx1) rx1 = _binBox[bb + 3];
          if (_binBox[bb + 4] > ry1) ry1 = _binBox[bb + 4];
          if (_binBox[bb + 5] > rz1) rz1 = _binBox[bb + 5];
          if (!rc || !_leftCount[k - 1]) continue;
          const dx = rx1 - rx0, dy = ry1 - ry0, dz = rz1 - rz0;
          const rArea = 2 * (dx * dy + dy * dz + dz * dx);
          const cost = TRAVERSE_COST + (_leftArea[k - 1] * _leftCount[k - 1] + rArea * rc) / parentArea;
          if (cost < bestCost) {
            bestCost = cost;
            bestAxis = a;
            bestPos = cmin + extent * (k / BINS);
          }
        }
      }

      let leftCount = -1;
      if (bestAxis >= 0) {
        let i = first, j = first + cnt - 1;
        while (i <= j) {
          if (cen[idx[i] * 3 + bestAxis] < bestPos) i++;
          else { const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; j--; }
        }
        leftCount = i - first;
      }
      // Coincident centroids defeat the SAH; fall back to a median index split
      // rather than leaving a pathologically fat leaf behind.
      if (leftCount <= 0 || leftCount >= cnt) {
        if (cnt <= 16) continue;
        leftCount = cnt >> 1;
      }

      const left = nodesUsed;
      nodesUsed += 2;
      nodeLeft[left] = first; nodeTris[left] = leftCount;
      nodeLeft[left + 1] = first + leftCount; nodeTris[left + 1] = cnt - leftCount;
      nodeLeft[n] = left; nodeTris[n] = 0;
      stack.push(left, left + 1);
      dstack.push(depth + 1, depth + 1);
    }

    this.nodeCount = nodesUsed;
    this._reorder(idx, count);
    this._buildEdgeFlags(count);
    this.bounds.min.set(nodeBox[0], nodeBox[1], nodeBox[2]);
    this.bounds.max.set(nodeBox[3], nodeBox[4], nodeBox[5]);
    this.buildMs = performance.now() - t0;
  }

  /**
   * Flag each triangle edge that is shared with a coplanar or concave
   * neighbour. Contacts on those edges are artefacts of triangulation — the
   * merged surface has no crease there — so the solver must use the face
   * normal instead of the closest-point direction, or a capsule crossing the
   * diagonal of any quad picks up a phantom wall. Convex edges keep their true
   * edge normal, which is what lets a capsule roll over a kerb.
   */
  _buildEdgeFlags(count) {
    this.edgeFlags = new Uint8Array(count);
    if (count > 260000) return;
    const pos = this.pos;
    const vmap = new Map();
    const vid = new Int32Array(count * 3);
    for (let i = 0, n = count * 3; i < n; i++) {
      const p = i * 3;
      const key = `${Math.round(pos[p] * 2048)},${Math.round(pos[p + 1] * 2048)},${Math.round(pos[p + 2] * 2048)}`;
      let id = vmap.get(key);
      if (id === undefined) { id = vmap.size; vmap.set(key, id); }
      vid[i] = id;
    }
    const emap = new Map();
    const nrm = new THREE.Vector3();
    for (let t = 0; t < count; t++) {
      for (let e = 0; e < 3; e++) {
        const a = vid[t * 3 + e], b = vid[t * 3 + (e + 1) % 3];
        const key = a < b ? a * 33554432 + b : b * 33554432 + a;
        const prev = emap.get(key);
        if (prev === undefined) { emap.set(key, t * 4 + e); continue; }
        const t2 = prev >> 2, e2 = prev & 3;
        this.faceNormal(t, nrm);
        const ap = (t * 3 + e) * 3;
        const op = (t2 * 3 + (e2 + 2) % 3) * 3;
        const dx = pos[op] - pos[ap], dy = pos[op + 1] - pos[ap + 1], dz = pos[op + 2] - pos[ap + 2];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        if ((nrm.x * dx + nrm.y * dy + nrm.z * dz) / l >= -0.002) {
          this.edgeFlags[t] |= 1 << e;
          this.edgeFlags[t2] |= 1 << e2;
        }
      }
    }
  }

  /** Permute triangle data into leaf order so leaves read sequential memory. */
  _reorder(idx, count) {
    const pos = this.pos, nrm = this.nrm, obj = this.obj, mat = this.mat, layer = this.layer;
    const np = new Float32Array(count * 9);
    const nn = new Float32Array(count * 9);
    const no = new Int32Array(count);
    const nm = new Int32Array(count);
    const nl = new Uint8Array(count);
    for (let k = 0; k < count; k++) {
      const s = idx[k], d9 = k * 9, s9 = s * 9;
      for (let c = 0; c < 9; c++) { np[d9 + c] = pos[s9 + c]; nn[d9 + c] = nrm[s9 + c]; }
      no[k] = obj[s]; nm[k] = mat[s]; nl[k] = layer[s];
    }
    this.pos = np; this.nrm = nn; this.obj = no; this.mat = nm; this.layer = nl;
  }

  _slab(n, ox, oy, oz, ix, iy, iz, tmax) {
    const nb = this.nodeBox, b = n * 6;
    let t0 = (nb[b] - ox) * ix, t1 = (nb[b + 3] - ox) * ix;
    let tmin = t0 < t1 ? t0 : t1;
    let tfar = t0 < t1 ? t1 : t0;
    t0 = (nb[b + 1] - oy) * iy; t1 = (nb[b + 4] - oy) * iy;
    let a = t0 < t1 ? t0 : t1, c = t0 < t1 ? t1 : t0;
    if (a > tmin) tmin = a;
    if (c < tfar) tfar = c;
    t0 = (nb[b + 2] - oz) * iz; t1 = (nb[b + 5] - oz) * iz;
    a = t0 < t1 ? t0 : t1; c = t0 < t1 ? t1 : t0;
    if (a > tmin) tmin = a;
    if (c < tfar) tfar = c;
    if (tfar >= tmin && tmin < tmax && tfar > 0) return tmin > 0 ? tmin : 0;
    return Infinity;
  }

  /**
   * Front-to-back ordered traversal with Möller–Trumbore leaves. Returns the
   * triangle index or -1; `hitT`/`hitU`/`hitV` carry the barycentric result.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, mask) {
    this.hitTri = -1;
    this.hitT = maxDist;
    if (!this.triCount) return -1;
    // Nudge zero components instead of using Infinity so the slab test never
    // produces 0 * Infinity = NaN.
    const ix = 1 / (dx >= 0 ? (dx > 1e-9 ? dx : 1e-9) : (dx < -1e-9 ? dx : -1e-9));
    const iy = 1 / (dy >= 0 ? (dy > 1e-9 ? dy : 1e-9) : (dy < -1e-9 ? dy : -1e-9));
    const iz = 1 / (dz >= 0 ? (dz > 1e-9 ? dz : 1e-9) : (dz < -1e-9 ? dz : -1e-9));
    const pos = this.pos, layer = this.layer, stack = this._stack;
    let node = 0, sp = 0;

    if (this._slab(0, ox, oy, oz, ix, iy, iz, this.hitT) === Infinity) return -1;

    for (;;) {
      const cnt = this.nodeTris[node];
      if (cnt > 0) {
        const first = this.nodeLeft[node];
        for (let i = first, e = first + cnt; i < e; i++) {
          if ((layer[i] & mask) === 0) continue;
          const p = i * 9;
          const ax = pos[p], ay = pos[p + 1], az = pos[p + 2];
          const e1x = pos[p + 3] - ax, e1y = pos[p + 4] - ay, e1z = pos[p + 5] - az;
          const e2x = pos[p + 6] - ax, e2y = pos[p + 7] - ay, e2z = pos[p + 8] - az;
          const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
          const det = e1x * hx + e1y * hy + e1z * hz;
          if (det > -1e-12 && det < 1e-12) continue;
          const inv = 1 / det;
          const sx = ox - ax, sy = oy - ay, sz = oz - az;
          const u = (sx * hx + sy * hy + sz * hz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > 1e-5 && t < this.hitT) {
            this.hitT = t; this.hitTri = i; this.hitU = u; this.hitV = v;
          }
        }
        if (sp === 0) break;
        node = stack[--sp];
        continue;
      }
      let c1 = this.nodeLeft[node], c2 = c1 + 1;
      let d1 = this._slab(c1, ox, oy, oz, ix, iy, iz, this.hitT);
      let d2 = this._slab(c2, ox, oy, oz, ix, iy, iz, this.hitT);
      if (d1 > d2) { const td = d1; d1 = d2; d2 = td; const tc = c1; c1 = c2; c2 = tc; }
      if (d1 === Infinity) {
        if (sp === 0) break;
        node = stack[--sp];
      } else {
        node = c1;
        if (d2 !== Infinity && sp < stack.length) stack[sp++] = c2;
      }
    }
    return this.hitTri;
  }

  /** Collect triangle indices whose AABB overlaps the query box. */
  queryBox(minx, miny, minz, maxx, maxy, maxz, mask, out) {
    if (!this.triCount) return 0;
    const nb = this.nodeBox, pos = this.pos, layer = this.layer, stack = this._qstack;
    const cap = out.length;
    let count = 0, node = 0, sp = 0;
    for (;;) {
      const b = node * 6;
      if (nb[b] <= maxx && nb[b + 3] >= minx && nb[b + 1] <= maxy && nb[b + 4] >= miny &&
          nb[b + 2] <= maxz && nb[b + 5] >= minz) {
        const cnt = this.nodeTris[node];
        if (cnt === 0) {
          const l = this.nodeLeft[node];
          if (sp < stack.length) stack[sp++] = l + 1;
          node = l;
          continue;
        }
        const first = this.nodeLeft[node];
        for (let i = first, e = first + cnt; i < e; i++) {
          if (count >= cap) break;
          if ((layer[i] & mask) === 0) continue;
          const p = i * 9;
          const x0 = pos[p], y0 = pos[p + 1], z0 = pos[p + 2];
          const x1 = pos[p + 3], y1 = pos[p + 4], z1 = pos[p + 5];
          const x2 = pos[p + 6], y2 = pos[p + 7], z2 = pos[p + 8];
          if (Math.min(x0, x1, x2) > maxx || Math.max(x0, x1, x2) < minx) continue;
          if (Math.min(y0, y1, y2) > maxy || Math.max(y0, y1, y2) < miny) continue;
          if (Math.min(z0, z1, z2) > maxz || Math.max(z0, z1, z2) < minz) continue;
          out[count++] = i;
        }
      }
      if (sp === 0) break;
      node = stack[--sp];
    }
    return count;
  }

  /** Geometric (winding) normal of a triangle, written into `out`. */
  faceNormal(tri, out) {
    const p = tri * 9, pos = this.pos;
    const ax = pos[p], ay = pos[p + 1], az = pos[p + 2];
    const e1x = pos[p + 3] - ax, e1y = pos[p + 4] - ay, e1z = pos[p + 5] - az;
    const e2x = pos[p + 6] - ax, e2y = pos[p + 7] - ay, e2z = pos[p + 8] - az;
    out.set(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    const l = out.length();
    if (l > 1e-12) out.multiplyScalar(1 / l); else out.set(0, 1, 0);
    return out;
  }

  /** Barycentric-interpolated vertex normal, falling back to the face normal. */
  shadingNormal(tri, u, v, out) {
    const n = this.nrm, p = tri * 9;
    const w = 1 - u - v;
    out.set(
      n[p] * w + n[p + 3] * u + n[p + 6] * v,
      n[p + 1] * w + n[p + 4] * u + n[p + 7] * v,
      n[p + 2] * w + n[p + 5] * u + n[p + 8] * v,
    );
    const l = out.length();
    if (l > 1e-6) out.multiplyScalar(1 / l);
    else this.faceNormal(tri, out);
    return out;
  }
}
