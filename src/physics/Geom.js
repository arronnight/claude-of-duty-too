import * as THREE from 'three';

/**
 * Closest-feature primitives shared by every collision query. These run
 * hundreds of times per 120 Hz tick, so they take raw scalars, write into
 * caller-owned vectors and never allocate. Algorithms follow Ericson,
 * "Real-Time Collision Detection".
 */

const _pt = new THREE.Vector3();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Barycentric region walk: 7 branches, no square roots. */
export function closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return out.set(ax, ay, az);

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return out.set(bx, by, bz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return out.set(ax + abx * v, ay + aby * v, az + abz * v);
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return out.set(cx, cy, cz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return out.set(ax + acx * w, ay + acy * w, az + acz * w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return out.set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return out.set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** Closest points between two segments; returns the squared distance. */
export function closestPtSegmentSegment(
  p1x, p1y, p1z, q1x, q1y, q1z,
  p2x, p2y, p2z, q2x, q2y, q2z,
  outA, outB,
) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0; t = 0;
  } else if (a <= 1e-12) {
    s = 0; t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-12) {
      t = 0; s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  outA.set(p1x + d1x * s, p1y + d1y * s, p1z + d1z * s);
  outB.set(p2x + d2x * t, p2y + d2y * t, p2z + d2z * t);
  const dx = outA.x - outB.x, dy = outA.y - outB.y, dz = outA.z - outB.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Squared distance between a segment (the capsule axis) and a triangle, with
 * the witness points. Crossing segments short-circuit to zero so deep
 * penetration still yields a usable contact point.
 */
export function segmentTriangleDistSq(
  pax, pay, paz, pbx, pby, pbz,
  ax, ay, az, bx, by, bz, cx, cy, cz,
  outSeg, outTri,
) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const dx = pbx - pax, dy = pby - pay, dz = pbz - paz;
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (det > 1e-14 || det < -1e-14) {
    const inv = 1 / det;
    const tx = pax - ax, ty = pay - ay, tz = paz - az;
    const u = (tx * hx + ty * hy + tz * hz) * inv;
    if (u >= 0 && u <= 1) {
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v >= 0 && u + v <= 1) {
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t >= 0 && t <= 1) {
          outSeg.set(pax + dx * t, pay + dy * t, paz + dz * t);
          outTri.copy(outSeg);
          return 0;
        }
      }
    }
  }

  closestPointOnTriangle(pax, pay, paz, ax, ay, az, bx, by, bz, cx, cy, cz, _pt);
  let ddx = _pt.x - pax, ddy = _pt.y - pay, ddz = _pt.z - paz;
  let best = ddx * ddx + ddy * ddy + ddz * ddz;
  outSeg.set(pax, pay, paz);
  outTri.copy(_pt);

  closestPointOnTriangle(pbx, pby, pbz, ax, ay, az, bx, by, bz, cx, cy, cz, _pt);
  ddx = _pt.x - pbx; ddy = _pt.y - pby; ddz = _pt.z - pbz;
  let d = ddx * ddx + ddy * ddy + ddz * ddz;
  if (d < best) { best = d; outSeg.set(pbx, pby, pbz); outTri.copy(_pt); }

  d = closestPtSegmentSegment(pax, pay, paz, pbx, pby, pbz, ax, ay, az, bx, by, bz, _sa, _sb);
  if (d < best) { best = d; outSeg.copy(_sa); outTri.copy(_sb); }
  d = closestPtSegmentSegment(pax, pay, paz, pbx, pby, pbz, bx, by, bz, cx, cy, cz, _sa, _sb);
  if (d < best) { best = d; outSeg.copy(_sa); outTri.copy(_sb); }
  d = closestPtSegmentSegment(pax, pay, paz, pbx, pby, pbz, cx, cy, cz, ax, ay, az, _sa, _sb);
  if (d < best) { best = d; outSeg.copy(_sa); outTri.copy(_sb); }
  return best;
}
