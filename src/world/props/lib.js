import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Geometry toolkit shared by every prop module.
 *
 * Two ideas drive all of it.
 *
 * **Draw calls, not triangles, are the scarce resource.** The frame budget is
 * 350 draws and the blockout already spends 178; the triangle budget is 3.5 M
 * and the blockout spends 2.2 k. So the primitive here is not `InstancedMesh`
 * but `Batch` — a merge buffer that swallows hundreds of small transformed
 * geometries and emits one `BufferGeometry`. A merged pile of 400 rubble
 * chunks costs exactly the same one draw call as an InstancedMesh of 400
 * rubble chunks, while allowing every chunk to be a *different shape*, which is
 * what actually breaks up a silhouette. Instancing is kept for the cases where
 * the shape genuinely repeats and the count is in the thousands (gravel).
 *
 * **Nothing in this game may have a sharp 90 degree edge** (`ART_DIRECTION.md`
 * rule 3). `chamferBox` is therefore the box primitive: same call signature as
 * `THREE.BoxGeometry` plus a chamfer width, and the bevel quads it adds are
 * what catch a specular line along every edge and stop a crate reading as an
 * untextured cuboid.
 *
 * UV convention is the library's: 1 UV unit = 1 metre, so every generator here
 * writes metre-scaled UVs and materials tile at their authored physical size.
 */

const _m4 = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();

/** Deterministic PRNG. Every prop layout is seeded so shots are comparable. */
export function makeRng(seed) {
  let a = (seed | 0) || 1;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap deterministic 3-in 1-out hash, for per-vertex displacement. */
export function hash3(x, y, z) {
  let h = Math.imul(Math.round(x * 8192) ^ 0x27d4eb2d, 0x9e3779b1);
  h = Math.imul(h ^ Math.round(y * 8192), 0x85ebca6b);
  h = Math.imul(h ^ Math.round(z * 8192), 0xc2b2ae35);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// --------------------------------------------------------------------- UVs

/**
 * Rewrites box-style 0..1-per-face UVs into metres so the material library's
 * per-key repeat lands the tile at its authored physical size. Same trick
 * `Level.js` uses; duplicated rather than imported because that file belongs to
 * another agent and its exports are not part of the contract.
 */
export function worldUV(geo) {
  geo.computeBoundingBox();
  geo.boundingBox.getSize(_size);
  const uv = geo.attributes.uv, nrm = geo.attributes.normal;
  if (!uv || !nrm) return geo;
  const size = [_size.x, _size.y, _size.z];
  for (let i = 0; i < uv.count; i++) {
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let su, sv;
    if (ax > ay && ax > az) { su = size[2]; sv = size[1]; }
    else if (ay > az) { su = size[0]; sv = size[2]; }
    else { su = size[0]; sv = size[1]; }
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Multiplies existing UVs — for lathes/tubes whose 0..1 span a known length. */
export function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

/**
 * Projects UVs from world position on the dominant axis of each face, in
 * metres. The general fallback for anything without a sane UV layout
 * (lathes, tubes, jittered convex hulls) that must not be triplanar.
 */
export function projectUV(geo) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  let uv = geo.attributes.uv;
  if (!uv || uv.count !== pos.count) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    if (ax > ay && ax > az) uv.setXY(i, z, y);
    else if (ay > az) uv.setXY(i, x, z);
    else uv.setXY(i, x, y);
  }
  uv.needsUpdate = true;
  return geo;
}

// -------------------------------------------------------------- primitives

/**
 * A box with every edge bevelled: 6 inset faces, 12 edge quads, 8 corner
 * triangles. 44 triangles against BoxGeometry's 12, which at this project's
 * triangle headroom is free, and it is the difference between "a crate" and
 * "a grey cuboid".
 *
 * `loopsY` inserts horizontal vertex loops low on the box. Without them the
 * contact-darkening ramp `bedGeo` writes into the colour attribute has nowhere
 * to land: on anything taller than about 0.6 m the ramp is Gouraud-smeared
 * from the base vertices all the way to the top ones and reads as a flat tint
 * over the whole object rather than as a contact band at the ground. Three
 * loops at 8 / 20 / 35 percent of the height take a box from 44 triangles to
 * about 190 — measured, not estimated — and are the difference between an
 * object sitting on the ground and an object floating above it. Off by
 * default; turn it on for anything over ~0.6 m that `bedGeo` will touch.
 *
 * Note that `wearEdges` reads the `codEdge` attribute written here, and both
 * `twoSided` and `shellGeo` drop it, so wear must be applied first.
 *
 * @param {number} w @param {number} h @param {number} d
 * @param {number} c chamfer width in metres (clamped to a third of the box)
 * @param {boolean|number[]} [loopsY] true for the default 0.08/0.20/0.35
 *   fractions of the height, or an explicit array of fractions
 */
export function chamferBox(w, h, d, c = 0.02, loopsY = false) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  c = Math.min(c, hx * 0.6, hy * 0.6, hz * 0.6);
  const inner = [hx - c, hy - c, hz - c];
  const outer = [hx, hy, hz];

  // corner[sx][sy][sz][axis] -> the vertex belonging to the `axis` face.
  const vert = (sx, sy, sz, axis) => {
    const s = [sx, sy, sz];
    return [
      s[0] * (axis === 0 ? outer[0] : inner[0]),
      s[1] * (axis === 1 ? outer[1] : inner[1]),
      s[2] * (axis === 2 ? outer[2] : inner[2]),
    ];
  };

  const tris = [];
  const quad = (a, b, cc, d2) => { tris.push(a, b, cc, a, cc, d2); };
  const S = [-1, 1];
  // Everything after the 6 inset faces is a bevel quad or a corner triangle,
  // i.e. an edge. `wearEdges` needs to know which is which and cannot tell
  // from the geometry afterwards, so the split is recorded here.
  let faceVerts = 0;

  // 6 inset faces
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const sa of S) {
      const corner = (su, sv) => {
        const s = [0, 0, 0]; s[axis] = sa; s[u] = su; s[v] = sv;
        return vert(s[0], s[1], s[2], axis);
      };
      quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1));
    }
  }
  faceVerts = tris.length;
  // 12 edge bevels: fix two signs, sweep the third axis
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const su of S) for (const sv of S) {
      const at = (sa, faceAxis) => {
        const s = [0, 0, 0]; s[axis] = sa; s[u] = su; s[v] = sv;
        return vert(s[0], s[1], s[2], faceAxis);
      };
      quad(at(-1, u), at(1, u), at(1, v), at(-1, v));
    }
  }
  // 8 corners
  for (const sx of S) for (const sy of S) for (const sz of S) {
    tris.push(vert(sx, sy, sz, 0), vert(sx, sy, sz, 1), vert(sx, sy, sz, 2));
  }

  const n = tris.length;
  let pos = new Array(n * 3);
  let edge = new Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = tris[i][0]; pos[i * 3 + 1] = tris[i][1]; pos[i * 3 + 2] = tris[i][2];
    edge[i] = i < faceVerts ? 0 : 1;
  }

  if (loopsY) {
    const fracs = Array.isArray(loopsY) ? loopsY : LOOP_FRACS;
    const planes = fracs.map((f) => -hy + h * f).filter((y) => y > -hy + 1e-4 && y < hy - 1e-4);
    if (planes.length) {
      const cut = cutTrianglesY(pos, edge, planes);
      pos = cut.pos; edge = cut.mask;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('codEdge', new THREE.BufferAttribute(new Float32Array(edge), 1));
  fixWindingConvex(geo);
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** Default horizontal loop positions, as fractions of the height. */
const LOOP_FRACS = [0.08, 0.20, 0.35];

/**
 * Splits a non-indexed triangle soup against a list of horizontal planes.
 *
 * Inserting vertex loops by editing the generator's three nested sign loops is
 * error-prone and has to be redone for every primitive; cutting the finished
 * soup works for all of them and only ever adds vertices in the plane of an
 * existing triangle, so face normals and the projected UVs are unchanged.
 *
 * @param {number[]} pos flat xyz, 9 numbers per triangle
 * @param {number[]|null} mask one scalar per vertex, carried (not interpolated)
 * @param {number[]} planes world-space Y values to cut at
 */
function cutTrianglesY(pos, mask, planes) {
  const EPS = 1e-6;
  let cur = pos, curM = mask;
  for (const y of planes) {
    const out = [], outM = [];
    const emit = (a, b, c, m) => {
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      if (curM) outM.push(m, m, m);
    };
    const lerpY = (a, b) => {
      const t = (y - a[1]) / (b[1] - a[1]);
      return [a[0] + (b[0] - a[0]) * t, y, a[2] + (b[2] - a[2]) * t];
    };
    for (let t = 0; t < cur.length; t += 9) {
      const P = [
        [cur[t], cur[t + 1], cur[t + 2]],
        [cur[t + 3], cur[t + 4], cur[t + 5]],
        [cur[t + 6], cur[t + 7], cur[t + 8]],
      ];
      const m = curM ? curM[t / 3] : 0;
      const s = P.map((p) => (p[1] - y > EPS ? 1 : p[1] - y < -EPS ? -1 : 0));
      if (!(s.includes(1) && s.includes(-1))) { emit(P[0], P[1], P[2], m); continue; }
      const iz = s.indexOf(0);
      if (iz >= 0) {
        // One vertex sits on the plane: one cut, from it to the far edge.
        const b = (iz + 1) % 3, c = (iz + 2) % 3;
        const M = lerpY(P[b], P[c]);
        emit(P[iz], P[b], M, m);
        emit(P[iz], M, P[c], m);
      } else {
        const lone = s[0] === s[1] ? 2 : s[0] === s[2] ? 1 : 0;
        const b = (lone + 1) % 3, c = (lone + 2) % 3;
        const Mb = lerpY(P[lone], P[b]);
        const Mc = lerpY(P[lone], P[c]);
        emit(P[lone], Mb, Mc, m);
        emit(Mb, P[b], P[c], m);
        emit(Mb, P[c], Mc, m);
      }
    }
    cur = out; curM = curM ? outM : null;
  }
  return { pos: cur, mask: curM };
}

/**
 * Flips any triangle whose normal faces the origin. Valid for convex shapes
 * built around their own centre, which is every generator here; it removes the
 * need to get the winding right by hand in three nested sign loops.
 */
export function fixWindingConvex(geo) {
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const fx = cx - ax, fy = cy - ay, fz = cz - az;
    const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
    if (nx * mx + ny * my + nz * mz < 0) {
      p[i + 3] = cx; p[i + 4] = cy; p[i + 5] = cz;
      p[i + 6] = bx; p[i + 7] = by; p[i + 8] = bz;
    }
  }
  geo.attributes.position.needsUpdate = true;
  return geo;
}

/**
 * A faceted convex lump: an icosahedron pushed around by a positional hash.
 * The hash is evaluated on the *direction*, so the duplicated vertices of a
 * non-indexed mesh all move together and the hull stays closed.
 *
 * @param {number} r radius
 * @param {number} amp 0..1 displacement amplitude
 * @param {number[]} [squash] per-axis scale applied after displacement
 */
export function lumpGeo(r, amp, squash = [1, 1, 1], detail = 0, seed = 0) {
  // IcosahedronGeometry is already non-indexed; calling toNonIndexed() on
  // it only earns a console warning.
  const geo = new THREE.IcosahedronGeometry(r, detail);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const l = Math.hypot(x, y, z) || 1;
    const dx = x / l, dy = y / l, dz = z / l;
    const n = hash3(dx + seed * 3.17, dy - seed * 1.93, dz + seed * 7.71);
    const n2 = hash3(dx * 3.1 + 11.3, dy * 3.1 - 4.7, dz * 3.1 + 9.1);
    const k = r * (1 + amp * (n - 0.5) * 2 + amp * 0.45 * (n2 - 0.5));
    pos.setXYZ(i, dx * k * squash[0], dy * k * squash[1], dz * k * squash[2]);
  }
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** A thin slab with a jagged broken edge — brick halves, concrete plate. */
export function shardGeo(w, h, d, rand, chip = 0.35) {
  const geo = chamferBox(w, h, d, Math.min(w, h, d) * 0.12);
  const pos = geo.attributes.position;
  const hx = w / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (x < hx * 0.55) continue;
    // Only the +X end breaks up, so the shard keeps one clean fracture face.
    const n = hash3(pos.getX(i), pos.getY(i), pos.getZ(i));
    pos.setX(i, x - w * chip * n);
    pos.setY(i, pos.getY(i) * (1 - 0.25 * n));
  }
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** A tapered splinter: one end square, the other drawn to a ragged point. */
export function splinterGeo(len, w, h, rand) {
  const geo = chamferBox(len, h, w, Math.min(w, h) * 0.2);
  const pos = geo.attributes.position;
  const hl = len / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = THREE.MathUtils.clamp((x + hl) / len, 0, 1);
    const k = 1 - 0.82 * t * t;
    const n = hash3(x, pos.getY(i), pos.getZ(i));
    pos.setY(i, pos.getY(i) * k * (0.7 + 0.6 * n));
    pos.setZ(i, pos.getZ(i) * k);
    if (t > 0.9) pos.setX(i, x - len * 0.18 * n);
  }
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** Bent sheet metal / torn roofing: a strip with per-row bend and curl. */
export function bentPlateGeo(w, h, segs, bend, rand) {
  const geo = new THREE.PlaneGeometry(w, h, segs, Math.max(1, segs >> 1));
  const pos = geo.attributes.position;
  const ph = rand() * 6.28, ph2 = rand() * 6.28;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = x / w, v = y / h;
    pos.setZ(i, bend * (Math.sin(u * 5.1 + ph) * 0.6 + Math.sin(v * 3.7 + ph2) * 0.4 + u * u * 1.4));
  }
  geo.computeVertexNormals();
  scaleUV(geo, w, h);
  return geo;
}

/** Corrugated sheet — awnings, shutters, shack walls. Ribs run along X. */
export function corrugatedGeo(w, h, ribs = 14, depth = 0.02) {
  const geo = new THREE.PlaneGeometry(w, h, ribs * 2, 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, Math.sin((x / w) * ribs * Math.PI * 2) * depth);
  }
  geo.computeVertexNormals();
  scaleUV(geo, w, h);
  return geo;
}

/**
 * A hanging cloth: folds radiating from the attached edge, a spanwise
 * catenary, a scalloped free hem and an optional torn edge.
 *
 * The old 8x6 grid could not hold a fold — a fold needs at least three
 * columns to have a crest and two valleys, and eight columns across a 1.5 m
 * banner is one crest every 19 cm of *geometry* against a fold spacing that
 * wants to be about 22 cm. So the whole sheet read as one smooth curved quad,
 * which is exactly what a game engine's cloth looks like and exactly what a
 * photograph's does not. 14x10 is 280 triangles, which at this project's
 * triangle headroom is free.
 *
 * Displacement order matters and is: folds out of plane, then the spanwise
 * droop, then the hem scallop, then the tear. `v = 0` is the free hem and
 * `v = 1` the attached edge — that is the convention every existing caller
 * already relies on, and the tear stays there.
 */
export function clothGeo(w, h, sag, rand, torn = 0.0) {
  // One fold per ~22 cm of width, never fewer than three.
  let k = Math.max(3, Math.round(w / 0.22));
  // 14 columns is the floor, not the answer. The hem scallop runs at twice the
  // fold frequency, so a 2.5 m canopy wants k = 11 and 22 scallops across it;
  // sampled on 14 columns that is well past Nyquist and the sheet comes out as
  // an aliased bunting sawtooth instead of cloth — verified in street.png
  // before this clamp went in. Four columns per fold keeps the crests round.
  const nx = Math.min(28, Math.max(14, k * 4)), ny = 10;
  k = Math.min(k, Math.floor(nx / 4));
  const geo = new THREE.PlaneGeometry(w, h, nx, ny);
  const pos = geo.attributes.position;
  const ph = rand() * 10;
  const A = 0.035 * w;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = (x / w) + 0.5, v = (y / h) + 0.5;
    // The top row lands on v = 1 only to within float error, and
    // Math.pow(-1e-7, 1.6) is NaN, which poisons the whole merged buffer.
    const iv = Math.max(0, 1 - v);

    // 1. Folds. Out of plane, strongest at the free hem and pinched out
    //    towards the attachment, which is how fabric pinned along an edge
    //    actually hangs.
    let dz = A * Math.sin(Math.PI * u * k) * Math.pow(iv, 1.6);

    // 2. Spanwise catenary, unchanged: the sheet is slung between two points
    //    at u = 0 and u = 1 and bellies in the middle.
    let dy = -sag * 4 * u * (1 - u) * v;

    // 3. Hem scallop. The free edge waves *between* the folds instead of
    //    running dead straight, which is the single most visible tell on a
    //    backlit sheet. Applied on (1 - v) so it lands on the hem, not on the
    //    pinned edge where it would be invisible.
    dy -= 0.02 * (1 - Math.cos(2 * Math.PI * u * k)) * iv;

    // 4. Tear along the free edge.
    if (torn > 0 && v < 0.12) {
      const n = hash3(x * 3.3, ph, 0.5);
      dy += torn * h * n;
      dz += (hash3(x * 5.7, ph + 3.1, 1.7) - 0.5) * 0.03;
    }
    pos.setY(i, y + dy);
    pos.setZ(i, dz);
  }
  geo.computeVertexNormals();
  scaleUV(geo, w, h);
  return geo;
}

/**
 * A hanging cable in a real catenary between two points, as a low-radial tube.
 * Cables are the cheapest possible fix for `ART_DIRECTION.md` rule 6 (an empty
 * upper third of frame) and they read at any distance because they are a
 * silhouette, not a surface.
 */
export function cableGeo(a, b, sag, radius = 0.022, segs = 14, radial = 4) {
  const pts = [];
  const span = Math.hypot(b.x - a.x, b.z - a.z) || 0.001;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // cosh-shaped droop normalised so the ends stay pinned.
    const k = 2.6;
    const droop = (Math.cosh(k * (t - 0.5)) - Math.cosh(k * 0.5)) / (1 - Math.cosh(k * 0.5));
    pts.push(new THREE.Vector3(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t - sag * droop,
      a.z + (b.z - a.z) * t,
    ));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, segs, radius, radial, false);
  scaleUV(geo, span + sag, radius * 6.28);
  return geo;
}

/** Rounded cylinder with chamfered rims — drums, posts, pipes. */
export function pipeGeo(r, len, radial = 8, capped = true, chamfer = 0) {
  const geo = new THREE.CylinderGeometry(r, r, len, radial, 1, !capped);
  scaleUV(geo, r * 6.28, len);
  if (chamfer > 0) {
    const pos = geo.attributes.position;
    const hl = len / 2;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (Math.abs(Math.abs(y) - hl) < 1e-4) {
        const k = 1 - chamfer / r;
        pos.setX(i, pos.getX(i) * k);
        pos.setZ(i, pos.getZ(i) * k);
        pos.setY(i, y - Math.sign(y) * chamfer * 0.5);
      }
    }
    geo.computeVertexNormals();
  }
  return geo;
}

/**
 * Returns a copy of a thin surface with both facings present.
 *
 * Awnings, canopies, laundry and shutters are single quads, and a merged batch
 * cannot set `side` per instance — the material is shared by the whole bucket
 * and turning off backface culling for every prop would cost real fill rate.
 * Duplicating the ~50 triangles of a sheet is by far the cheaper answer, and it
 * is the difference between standing under an awning and standing under a hole.
 */
export function twoSided(geo) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const sp = src.attributes.position.array;
  const sn = src.attributes.normal ? src.attributes.normal.array : null;
  const su = src.attributes.uv ? src.attributes.uv.array : null;
  const n = sp.length / 3;
  const pos = new Float32Array(n * 6);
  const nrm = new Float32Array(n * 6);
  const uv = new Float32Array(n * 4);
  pos.set(sp, 0);
  if (sn) nrm.set(sn, 0);
  if (su) uv.set(su, 0);
  // Second copy with the winding and the normals reversed.
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const src3 = (t + (2 - k)) * 3, dst3 = (n + t + k) * 3;
      pos[dst3] = sp[src3]; pos[dst3 + 1] = sp[src3 + 1]; pos[dst3 + 2] = sp[src3 + 2];
      if (sn) { nrm[dst3] = -sn[src3]; nrm[dst3 + 1] = -sn[src3 + 1]; nrm[dst3 + 2] = -sn[src3 + 2]; }
      const src2 = (t + (2 - k)) * 2, dst2 = (n + t + k) * 2;
      if (su) { uv[dst2] = su[src2]; uv[dst2 + 1] = su[src2 + 1]; }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

/** Default shell thicknesses, metres. */
export const SHELL_T = { laundry: 0.004, canvas: 0.008, tarpaulin: 0.014 };

/**
 * Gives a thin surface real thickness: a front copy, a back copy, and — the
 * entire point — a rim strip of quads stitching the two together around the
 * boundary loop.
 *
 * `twoSided()` duplicates the quad at *zero* offset, so a sheet has two
 * facings and no edge. Under a low sun a backlit awning or a hanging sheet
 * then terminates in a mathematically sharp silhouette with no lit rim, which
 * is one of the most reliable ways to spot a real-time frame: real fabric,
 * card, sheet metal and plywood all catch a bright line along their cut edge.
 * The rim is 4 quads per boundary segment of geometry — about 40 triangles on
 * a small sheet — and it is the difference between a cut-out and an object.
 *
 * @param {THREE.BufferGeometry} geo an open surface (a plane, a corrugation)
 * @param {number} t thickness in metres; see `SHELL_T`
 */
export function shellGeo(geo, t = SHELL_T.canvas) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const sp = src.attributes.position.array;
  let sn = src.attributes.normal ? src.attributes.normal.array : null;
  if (!sn) { src.computeVertexNormals(); sn = src.attributes.normal.array; }
  const su = src.attributes.uv ? src.attributes.uv.array : null;
  const n = sp.length / 3;
  const half = t * 0.5;

  // Boundary detection. Vertex positions are quantised to 0.1 mm so the
  // duplicated vertices of a non-indexed mesh collapse onto one key; an edge
  // shared by two triangles appears twice and is interior, an edge that
  // appears once is on the boundary loop.
  const key = (i) => `${Math.round(sp[i * 3] * 1e4)},${Math.round(sp[i * 3 + 1] * 1e4)},${Math.round(sp[i * 3 + 2] * 1e4)}`;
  const keys = new Array(n);
  for (let i = 0; i < n; i++) keys[i] = key(i);
  const seen = new Map();
  for (let tri = 0; tri < n; tri += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tri + e, b = tri + ((e + 1) % 3);
      const ka = keys[a], kb = keys[b];
      const id = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      const prev = seen.get(id);
      if (prev === undefined) seen.set(id, a); else seen.set(id, -1);
    }
  }
  /** @type {number[]} first vertex index of each boundary edge, in triangle winding order */
  const rim = [];
  for (const v of seen.values()) if (v >= 0) rim.push(v);

  const rimTris = rim.length * 2;
  const total = n * 2 + rimTris * 3;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  // Front copy, pushed out along its own normal.
  for (let i = 0; i < n; i++) {
    pos[i * 3] = sp[i * 3] + sn[i * 3] * half;
    pos[i * 3 + 1] = sp[i * 3 + 1] + sn[i * 3 + 1] * half;
    pos[i * 3 + 2] = sp[i * 3 + 2] + sn[i * 3 + 2] * half;
    nrm[i * 3] = sn[i * 3]; nrm[i * 3 + 1] = sn[i * 3 + 1]; nrm[i * 3 + 2] = sn[i * 3 + 2];
    if (su) { uv[i * 2] = su[i * 2]; uv[i * 2 + 1] = su[i * 2 + 1]; }
  }
  // Back copy, pulled in, wound and normalled the other way.
  for (let tri = 0; tri < n; tri += 3) {
    for (let e = 0; e < 3; e++) {
      const s = tri + (2 - e), dOff = n + tri + e;
      pos[dOff * 3] = sp[s * 3] - sn[s * 3] * half;
      pos[dOff * 3 + 1] = sp[s * 3 + 1] - sn[s * 3 + 1] * half;
      pos[dOff * 3 + 2] = sp[s * 3 + 2] - sn[s * 3 + 2] * half;
      nrm[dOff * 3] = -sn[s * 3]; nrm[dOff * 3 + 1] = -sn[s * 3 + 1]; nrm[dOff * 3 + 2] = -sn[s * 3 + 2];
      if (su) { uv[dOff * 2] = su[s * 2]; uv[dOff * 2 + 1] = su[s * 2 + 1]; }
    }
  }

  // Rim. For a front-facing triangle wound CCW about normal `nn`, walking a
  // boundary edge a->b in that winding puts the surface interior on one side
  // and cross(edge, nn) pointing out of it — so the strip normal is exact and
  // does not need a smoothing pass to find.
  let o = n * 2;
  for (const a of rim) {
    const tri = a - (a % 3);
    const b = tri + ((a - tri + 1) % 3);
    _v.set(sp[b * 3] - sp[a * 3], sp[b * 3 + 1] - sp[a * 3 + 1], sp[b * 3 + 2] - sp[a * 3 + 2]);
    _v2.set(
      (sn[a * 3] + sn[b * 3]) * 0.5,
      (sn[a * 3 + 1] + sn[b * 3 + 1]) * 0.5,
      (sn[a * 3 + 2] + sn[b * 3 + 2]) * 0.5,
    );
    _v3.crossVectors(_v, _v2);
    if (_v3.lengthSq() < 1e-12) continue;
    _v3.normalize();
    const put = (vi, sign, uu) => {
      pos[o * 3] = sp[vi * 3] + sn[vi * 3] * half * sign;
      pos[o * 3 + 1] = sp[vi * 3 + 1] + sn[vi * 3 + 1] * half * sign;
      pos[o * 3 + 2] = sp[vi * 3 + 2] + sn[vi * 3 + 2] * half * sign;
      nrm[o * 3] = _v3.x; nrm[o * 3 + 1] = _v3.y; nrm[o * 3 + 2] = _v3.z;
      if (su) { uv[o * 2] = su[vi * 2]; uv[o * 2 + 1] = su[vi * 2 + 1] + uu; }
      o++;
    };
    // (Af, Ab, Bb) and (Af, Bb, Bf) — outward.
    put(a, 1, 0); put(a, -1, t); put(b, -1, t);
    put(a, 1, 0); put(b, -1, t); put(b, 1, 0);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o * 3), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, o * 3), 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, o * 2), 2));
  return out;
}

// ------------------------------------------------------------ contact / wear

/** Shared by `bedGeo` and `Batch`'s insert-time ramp so they cannot diverge. */
const BED_RAMP = 0.30;
const BED_FLOOR = 0.42;

function smoothstep01(e0, e1, x) {
  const t = e1 === e0 ? (x >= e1 ? 1 : 0) : (x - e0) / (e1 - e0);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * The ambient darkening an object owes the ground it is standing on.
 *
 * A prop placed on a surface with no contact shadow floats, and this is the
 * single most common reason a rendered still reads as fake. `Batch.build`
 * already carries a per-vertex colour attribute and `SurfaceShader` folds that
 * colour into the *indirect* diffuse term as well as albedo — so writing a
 * ramp here kills the ambient light on the bottom of the object, which is
 * exactly what contact occlusion does, at the cost of nothing per frame.
 *
 * Undersides get a further 0.55: a face pointing at the ground can see almost
 * no sky at all.
 *
 * @param {THREE.BufferGeometry} geo modified in place
 * @param {number} groundLocalY the geometry-local Y of the ground plane
 * @param {number} [rampH] metres over which the darkening lifts
 * @param {number} [floor] darkest multiplier, at the contact line
 */
export function bedGeo(geo, groundLocalY = 0, rampH = BED_RAMP, floor = BED_FLOOR) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  let col = geo.attributes.color;
  if (!col || col.count !== pos.count) {
    col = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3);
    geo.setAttribute('color', col);
  }
  for (let i = 0; i < pos.count; i++) {
    let k = floor + (1 - floor) * smoothstep01(0, rampH, pos.getY(i) - groundLocalY);
    if (nrm && nrm.getY(i) < -0.3) k *= 0.55;
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  col.needsUpdate = true;
  return geo;
}

/**
 * Rubs the paint off the edges of a `chamferBox`.
 *
 * Every worn object in a photograph is worn on its *edges* — that is where a
 * hand, a boot or another crate touches it — and the wear is patchy, never a
 * uniform outline, because contact is patchy. `chamferBox` tags its bevel
 * quads and corner triangles at build time (`codEdge`), so this only has to
 * look them up and blend a hash into the colour attribute.
 *
 * Silently does nothing on a geometry that was not built by `chamferBox`,
 * which is deliberate: the alternative is a caller-side guard at every site.
 *
 * @param {THREE.BufferGeometry} geo modified in place
 * @param {THREE.Color|number} wearColor the exposed substrate
 * @param {number} amount 0..1 maximum blend towards it
 */
export function wearEdges(geo, wearColor = 0x9a9086, amount = 0.55, rand = null) {
  const mask = geo.attributes.codEdge;
  const pos = geo.attributes.position;
  if (!mask || !pos) return geo;
  let col = geo.attributes.color;
  if (!col || col.count !== pos.count) {
    col = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3);
    geo.setAttribute('color', col);
  }
  _c.set(wearColor);
  const jitter = rand ? rand() * 7.3 : 0;
  for (let i = 0; i < pos.count; i++) {
    if (mask.getX(i) < 0.5) continue;
    const n = hash3(pos.getX(i) * 4.1 + jitter, pos.getY(i) * 4.1, pos.getZ(i) * 4.1);
    // Squared so most of the edge stays intact and a few patches go bare.
    const k = amount * n * n;
    col.setXYZ(
      i,
      col.getX(i) * (1 - k) + _c.r * k,
      col.getY(i) * (1 - k) + _c.g * k,
      col.getZ(i) * (1 - k) + _c.b * k,
    );
  }
  col.needsUpdate = true;
  return geo;
}

/**
 * Lofts a closed surface through a list of cross sections along +Z.
 *
 * Vehicles are the one prop class that cannot be assembled out of chamfered
 * boxes — a car reads as a car because of a continuous shoulder line running
 * the length of the body and a roof that flows into the pillars, and a stack
 * of boxes has neither. A loft gives both for a few hundred triangles.
 *
 * Each station is `{ z, pts: [[x,y], ...], wScale?, cutY? }` where `pts` is
 * the RIGHT half of the profile only, ordered from the bottom of the section
 * to the top; the left half is mirrored about x = 0, so a section is
 * guaranteed symmetric and cannot be authored crooked. `wScale` scales the
 * half-width of that station (tapering a nose or a tail), `cutY` clamps the
 * profile up to a sill line.
 *
 * Normals are creased at 40 degrees so the shoulder stays a continuous smooth
 * highlight while the sill crease below it stays a hard line — one smoothing
 * pass cannot do both and a car needs both.
 */
export function loftGeo(sections, creaseDeg = 40) {
  const rings = [];
  for (const s of sections) {
    const ws = s.wScale === undefined ? 1 : s.wScale;
    const half = [];
    for (const [px, py] of s.pts) {
      const y = s.cutY === undefined ? py : Math.max(py, s.cutY);
      half.push([px * ws, y]);
    }
    const ring = [];
    for (const p of half) ring.push([p[0], p[1], s.z]);
    // Mirror back down the left side, skipping any point already on the axis.
    for (let i = half.length - 1; i >= 0; i--) {
      if (Math.abs(half[i][0]) < 1e-5) continue;
      ring.push([-half[i][0], half[i][1], s.z]);
    }
    rings.push(ring);
  }
  if (rings.length < 2) return new THREE.BufferGeometry();
  const m = rings[0].length;
  const out = [];
  const push = (p) => out.push(p[0], p[1], p[2]);

  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    if (A.length !== m || B.length !== m) continue;   // stations must agree
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      push(A[j]); push(A[j2]); push(B[j2]);
      push(A[j]); push(B[j2]); push(B[j]);
    }
  }
  // Flat caps, so the ends are not open holes when seen from in front.
  const cap = (ring, flip) => {
    let cx = 0, cy = 0, cz = ring[0][2];
    for (const p of ring) { cx += p[0]; cy += p[1]; }
    cx /= ring.length; cy /= ring.length;
    for (let j = 0; j < ring.length; j++) {
      const j2 = (j + 1) % ring.length;
      if (flip) { push([cx, cy, cz]); push(ring[j2]); push(ring[j]); }
      else { push([cx, cy, cz]); push(ring[j]); push(ring[j2]); }
    }
  };
  cap(rings[0], true);
  cap(rings[rings.length - 1], false);

  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  geo.computeVertexNormals();
  try {
    geo = toCreasedNormals(geo, creaseDeg * Math.PI / 180);
  } catch (e) { /* faceted normals are a survivable fallback */ }
  projectUV(geo);
  return geo;
}

/**
 * Lays a sheet authored in the XY plane flat, normal up, with its former
 * "height" axis running out along +Z.
 *
 * The two rotations are not interchangeable with one: a single rotateX puts the
 * depth axis where it is wanted but leaves the front face pointing at the
 * ground, because X cross Y is Z and the handedness does not care what was
 * intended. The extra half turn about Y fixes the facing without disturbing the
 * depth axis.
 */
export function layFlat(geo) {
  return geo.rotateX(-Math.PI / 2).rotateY(Math.PI);
}

// ------------------------------------------------------------------ merging

/**
 * Accumulates transformed geometries and emits one merged, non-indexed
 * `BufferGeometry` with position / normal / uv / color.
 *
 * Colour goes into a vertex-colour attribute, which the material library's
 * surface shader multiplies into albedo (`color_fragment`) and folds into its
 * ambient-occlusion term. That is `ART_DIRECTION.md` rule 5 — per-instance hue
 * and value jitter — for the price of three floats a vertex, and it is what
 * stops four hundred rubble chunks reading as four hundred copies.
 */
export class Batch {
  constructor(name = 'batch') {
    this.name = name;
    this._parts = [];
    this.tris = 0;
  }

  get empty() { return this._parts.length === 0; }

  /**
   * @param {THREE.BufferGeometry} geo source (not modified, not retained after build)
   * @param {THREE.Matrix4} m world transform
   * @param {THREE.Color|null} color per-part tint, or null for white
   * @param {number|null} [groundY] world Y of the ground this piece sits on.
   *   When given, `build()` applies the `bedGeo` contact ramp per vertex as it
   *   merges. Doing it here rather than in the caller is the whole point:
   *   scattered clutter reuses one shared source geometry hundreds of times,
   *   and baking the ramp would need a geometry clone per piece.
   */
  addMatrix(geo, m, color, groundY = null) {
    const pos = geo.attributes.position;
    if (!pos) return this;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    this._parts.push({
      geo, m: m.clone(),
      r: color ? color.r : 1, g: color ? color.g : 1, b: color ? color.b : 1,
      bedY: typeof groundY === 'number' ? groundY : null,
    });
    this.tris += count / 3;
    return this;
  }

  /** Convenience: position + euler + uniform-or-vector scale. */
  add(geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx, color = null, groundY = null) {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m4.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
    return this.addMatrix(geo, _m4, color, groundY);
  }

  /** Merged geometry, or null if nothing was added. Clears the part list. */
  build() {
    if (!this._parts.length) return null;
    let total = 0;
    for (const p of this._parts) {
      const idx = p.geo.index;
      total += idx ? idx.count : p.geo.attributes.position.count;
    }
    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const color = new Float32Array(total * 3);
    let o = 0;

    for (const p of this._parts) {
      const g = p.geo;
      const sp = g.attributes.position;
      const sn = g.attributes.normal;
      const su = g.attributes.uv;
      const sc = g.attributes.color;
      const idx = g.index;
      const n = idx ? idx.count : sp.count;
      _m3.getNormalMatrix(p.m);
      for (let i = 0; i < n; i++) {
        const j = idx ? idx.getX(i) : i;
        _v.set(sp.getX(j), sp.getY(j), sp.getZ(j)).applyMatrix4(p.m);
        position[(o + i) * 3] = _v.x; position[(o + i) * 3 + 1] = _v.y; position[(o + i) * 3 + 2] = _v.z;
        if (sn) {
          _v2.set(sn.getX(j), sn.getY(j), sn.getZ(j)).applyMatrix3(_m3).normalize();
          normal[(o + i) * 3] = _v2.x; normal[(o + i) * 3 + 1] = _v2.y; normal[(o + i) * 3 + 2] = _v2.z;
        }
        if (su) { uv[(o + i) * 2] = su.getX(j); uv[(o + i) * 2 + 1] = su.getY(j); }
        const cr = sc ? sc.getX(j) : 1, cg = sc ? sc.getY(j) : 1, cb = sc ? sc.getZ(j) : 1;
        // Contact ramp, in world space, off the already-transformed vertex.
        let bed = 1;
        if (p.bedY !== null) {
          bed = BED_FLOOR + (1 - BED_FLOOR) * smoothstep01(0, BED_RAMP, _v.y - p.bedY);
          if (sn && normal[(o + i) * 3 + 1] < -0.3) bed *= 0.55;
        }
        color[(o + i) * 3] = cr * p.r * bed;
        color[(o + i) * 3 + 1] = cg * p.g * bed;
        color[(o + i) * 3 + 2] = cb * p.b * bed;
      }
      o += n;
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(position, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('color', new THREE.BufferAttribute(color, 3));
    out.computeBoundingSphere();
    out.computeBoundingBox();
    out.name = this.name;
    this._parts.length = 0;
    return out;
  }
}

// ------------------------------------------------------------------ colour

/**
 * Value/hue jitter around a base tint. Kept centred near 1.0: the surface
 * shader also reads vertex colour as a baked occlusion term, so a very dark
 * instance tint would double-dip into the indirect lighting.
 */
export function jitterColor(out, rand, value = 0.16, hue = 0.02, warm = 0) {
  const v = 1 - value * 0.5 + rand() * value;
  const h = (rand() - 0.5) * hue;
  out.setRGB(
    THREE.MathUtils.clamp(v * (1 + h + warm), 0.25, 1.25),
    THREE.MathUtils.clamp(v * (1 + h * 0.2 + warm * 0.45), 0.25, 1.25),
    THREE.MathUtils.clamp(v * (1 - h * 0.9 - warm * 0.75), 0.25, 1.25),
  );
  return out;
}

export const scratch = { v: _v, v2: _v2, v3: _v3, q: _q, e: _e, m4: _m4, c: _c, box: _box };
