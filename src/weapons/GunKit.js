import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Geometry toolbox for procedural firearms.
 *
 * Two rules run through all of it:
 *
 * 1. **Nothing has a raw 90 degree edge.** A perfectly sharp box catches no
 *    specular highlight along its edges, which is exactly the cue that reads as
 *    "untextured primitive". Every box here is an extruded rounded rectangle
 *    with a bevel, so every edge has a 1-2 mm chamfer that lights up.
 * 2. **Parts merge per material, not per weapon.** A gun is 60-90 primitives;
 *    drawing them individually would eat a quarter of the frame budget. The
 *    `Part` builder accumulates transformed geometry and emits one mesh per
 *    material, so an M4 is ~14 draw calls (one per animated part) rather than
 *    ninety.
 *
 * Model space convention, shared by every weapon:
 *   -Z forward (down the bore), +Y up, +X to the shooter's right,
 *   y = 0 on the bore axis, z = 0 at the middle of the receiver.
 */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

// --------------------------------------------------------------------------
// profiles

/** Rounded rectangle centred on the origin, in the XY plane. */
export function roundedRect(w, h, r) {
  const rr = Math.max(0.00005, Math.min(r, Math.min(w, h) * 0.4999));
  const x = w / 2 - rr;
  const y = h / 2 - rr;
  const s = new THREE.Shape();
  s.moveTo(-x, -y - rr);
  s.lineTo(x, -y - rr);
  s.absarc(x, -y, rr, -Math.PI / 2, 0, false);
  s.lineTo(x + rr, y);
  s.absarc(x, y, rr, 0, Math.PI / 2, false);
  s.lineTo(-x, y + rr);
  s.absarc(-x, y, rr, Math.PI / 2, Math.PI, false);
  s.lineTo(-x - rr, -y);
  s.absarc(-x, -y, rr, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Arbitrary closed polygon in XY, given as a flat [x0,y0, x1,y1, ...] list. */
export function polyShape(pts) {
  const s = new THREE.Shape();
  s.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) s.lineTo(pts[i], pts[i + 1]);
  s.closePath();
  return s;
}

// --------------------------------------------------------------------------
// primitives

/**
 * Chamfered box extruded along Z and centred on the origin.
 * `r` rounds the four long edges, `bevel` chamfers the two end faces.
 */
export function chamferBox(w, h, d, opts = {}) {
  const bevel = Math.min(opts.bevel ?? 0.0013, w * 0.24, h * 0.24, d * 0.4);
  const r = opts.r ?? 0.0022;
  const seg = opts.curveSegments ?? 2;
  const shape = roundedRect(Math.max(1e-4, w - bevel * 2), Math.max(1e-4, h - bevel * 2), Math.max(1e-4, r - bevel));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, d - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: opts.bevelSegments ?? 1,
    curveSegments: seg,
    steps: 1,
  });
  g.translate(0, 0, -(d - bevel * 2) / 2);
  return g;
}

/** Chamfered extrusion of an arbitrary XY profile, centred on Z. */
export function chamferProfile(shape, d, opts = {}) {
  const bevel = Math.min(opts.bevel ?? 0.0012, d * 0.4);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, d - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: opts.bevelSegments ?? 1,
    curveSegments: opts.curveSegments ?? 4,
    steps: 1,
  });
  g.translate(0, 0, -(d - bevel * 2) / 2);
  return g;
}

/**
 * Lathed body about the Z axis (so it points down the bore without an extra
 * rotation). `profile` is [[radius, z], ...] ordered front to back.
 */
export function lathe(profile, seg = 16) {
  const pts = [];
  for (let i = 0; i < profile.length; i++) pts.push(new THREE.Vector2(Math.max(1e-5, profile[i][0]), profile[i][1]));
  const g = new THREE.LatheGeometry(pts, seg);
  // Lathe spins about +Y; stand it up along -Z with the profile's y becoming z.
  g.rotateX(Math.PI / 2);
  return g;
}

/** Cylinder along the Z axis. */
export function cyl(rTop, rBottom, len, seg = 14, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, len, seg, 1, open);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Hollow tube along Z — an outer and inner wall plus two annular end caps. */
export function tube(rOuter, rInner, len, seg = 20) {
  const parts = [];
  const outer = new THREE.CylinderGeometry(rOuter, rOuter, len, seg, 1, true);
  outer.rotateX(Math.PI / 2);
  parts.push(outer);
  const inner = new THREE.CylinderGeometry(rInner, rInner, len, seg, 1, true);
  inner.rotateX(Math.PI / 2);
  inner.scale(1, 1, -1); // flip winding so the bore faces inward
  parts.push(inner);
  for (const sign of [-1, 1]) {
    const ring = new THREE.RingGeometry(rInner, rOuter, seg, 1);
    if (sign < 0) ring.scale(-1, 1, 1);
    ring.translate(0, 0, (sign * len) / 2);
    parts.push(ring);
  }
  return mergeGeometries(parts.map(prep), false);
}

/** Torus around the Z axis (sling loops, trigger guard rings, lens rims). */
export function ring(radius, thickness, seg = 18, tubeSeg = 6, arc = Math.PI * 2) {
  return new THREE.TorusGeometry(radius, thickness, tubeSeg, seg, arc);
}

export function sphere(r, seg = 10) {
  return new THREE.SphereGeometry(r, seg, Math.max(5, seg >> 1));
}

/** Capsule along Z — knuckles, fingers, buffer springs. */
export function capsuleZ(r, len, seg = 8) {
  const g = new THREE.CapsuleGeometry(r, Math.max(1e-4, len), 2, seg);
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * MIL-STD-1913 rail: a 21.2 mm wide slotted top rail with the classic angled
 * flanks. Modelled as a base bar plus N cross ribs so the slots read as real
 * recesses in raking light instead of a texture.
 */
export function picatinny(length, opts = {}) {
  const w = opts.width ?? 0.0212;
  const baseH = opts.baseHeight ?? 0.0042;
  const ribH = opts.ribHeight ?? 0.0048;
  const pitch = opts.pitch ?? 0.0102;
  const parts = [];

  const base = chamferBox(w, baseH, length, { r: 0.0008, bevel: 0.0006 });
  base.translate(0, baseH / 2, 0);
  parts.push(base);

  const n = Math.max(1, Math.floor(length / pitch));
  const span = (n - 1) * pitch;
  for (let i = 0; i < n; i++) {
    const z = -span / 2 + i * pitch;
    // Dovetail cross-section: wide at the top, undercut on both flanks.
    const rib = chamferProfile(
      polyShape([
        -w / 2, 0,
        w / 2, 0,
        w / 2, ribH * 0.42,
        w / 2 - 0.0016, ribH,
        -w / 2 + 0.0016, ribH,
        -w / 2, ribH * 0.42,
      ]),
      pitch * 0.56,
      { bevel: 0.00045, curveSegments: 1 },
    );
    rib.translate(0, baseH, z);
    parts.push(rib);
  }
  return mergeGeometries(parts.map(prep), false);
}

/** Hex or slotted screw head, standing proud of a surface, facing +Y. */
export function screw(r = 0.0022, h = 0.0012, slot = true) {
  const parts = [];
  const head = new THREE.CylinderGeometry(r, r * 0.94, h, 10);
  head.translate(0, h / 2, 0);
  parts.push(head);
  if (slot) {
    const g = new THREE.BoxGeometry(r * 1.7, h * 0.5, r * 0.34);
    g.translate(0, h * 0.86, 0);
    parts.push(g);
  }
  return mergeGeometries(parts.map(prep), false);
}

/** Knurled cylinder — turret caps, suppressor collars, adjustment wheels. */
export function knurled(r, len, teeth = 18) {
  const parts = [];
  const body = cyl(r * 0.965, r * 0.965, len, Math.max(12, teeth));
  parts.push(body);
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const t = new THREE.BoxGeometry(r * 0.13, r * 0.09, len * 0.92);
    t.translate(0, r * 0.985, 0);
    t.rotateZ(a);
    parts.push(t);
  }
  return mergeGeometries(parts.map(prep), false);
}

/**
 * A curved body built as a stack of chamfered slices swept along an arc in the
 * YZ plane, running downward from the origin. Used for magazines and grips.
 *
 * A single `ExtrudeGeometry` along an `extrudePath` would be tidier, but its
 * Frenet frames are unstable for a nearly straight path and it cannot bevel,
 * so the silhouette would come out with hard edges. Stacked slices give the
 * curve *and* the horizontal witness ribs a real magazine has.
 *
 * @param w        width (X)
 * @param depth    fore/aft thickness (Z)
 * @param length   total length down -Y
 * @param bend     total sweep in radians (positive curls the bottom forward)
 * @param slices   number of ribs
 */
export function curvedStack(w, depth, length, bend, slices = 8, opts = {}) {
  const parts = [];
  const gap = opts.gap ?? 0.0006;
  const seg = length / slices;
  // Arc of radius R starting at the origin heading -Y and curling toward -Z:
  //   tangent(t) = (0, -cos t, -sin t)   =>   p(t) = R * (0, -sin t, cos t - 1)
  const R = Math.abs(bend) > 1e-4 ? length / bend : 1e7;
  for (let i = 0; i < slices; i++) {
    const u = (i + 0.5) / slices;
    const t = u * bend;
    const taper = 1 - (opts.taper ?? 0) * u;
    const g = chamferBox(w * taper, seg - gap, depth * taper, {
      r: opts.r ?? Math.min(w, depth) * 0.3,
      bevel: opts.bevel ?? 0.0009,
      curveSegments: opts.curveSegments ?? 2,
    });
    _e.set(t, 0, 0, 'XYZ');
    _q.setFromEuler(_e);
    _v.set(0, -R * Math.sin(t), R * (Math.cos(t) - 1));
    _s.setScalar(1);
    _m4.compose(_v, _q, _s);
    g.applyMatrix4(_m4);
    parts.push(prep(g));
  }
  return mergeGeometries(parts, false);
}

// --------------------------------------------------------------------------
// assembly

/**
 * Normalise attributes so anything can be merged with anything else.
 *
 * `mergeGeometries` refuses to mix indexed and non-indexed inputs, and
 * `ExtrudeGeometry` is the one primitive here that is always non-indexed, so
 * everything is flattened rather than the other way round. A whole weapon is
 * under 10 k triangles; the duplicated vertices are not worth an index pass.
 */
export function prep(g) {
  if (!g) return g;
  let out = g.index !== null ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  out.deleteAttribute('uv2');
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) {
    const n = out.attributes.position.count;
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  // Some library materials bind an AO map to the second UV channel; without a
  // uv1 attribute those draws would fail to link.
  if (!out.attributes.uv1) out.setAttribute('uv1', out.attributes.uv.clone());
  return out;
}

/** Mirror a non-indexed geometry across X, fixing the winding order. */
export function mirrorX(g) {
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, -pos.getX(i));
    if (nrm) nrm.setX(i, -nrm.getX(i));
  }
  for (const name in g.attributes) {
    const a = g.attributes[name];
    const s = a.itemSize;
    const arr = a.array;
    for (let t = 0; t + 2 < a.count; t += 3) {
      for (let c = 0; c < s; c++) {
        const i0 = t * s + c;
        const i2 = (t + 2) * s + c;
        const tmp = arr[i0]; arr[i0] = arr[i2]; arr[i2] = tmp;
      }
    }
    a.needsUpdate = true;
  }
  return g;
}

/**
 * Accumulates geometry under a material name, then emits one merged mesh per
 * material. `add()` takes a transform so callers stay declarative.
 */
export class Part {
  /**
   * @param {string} name  part name, also the Object3D name
   * @param {(key:string)=>THREE.Material} resolve  material key -> material
   */
  constructor(name, resolve) {
    this.name = name;
    this.resolve = resolve;
    this.buckets = new Map();
    this.group = new THREE.Group();
    this.group.name = name;
  }

  /**
   * @param {string} mat  material key
   * @param {THREE.BufferGeometry} geom
   * @param {object} [t]  { x,y,z, rx,ry,rz, sx,sy,sz } — all optional
   */
  add(mat, geom, t) {
    if (!geom) return this;
    if (t) {
      _e.set(t.rx || 0, t.ry || 0, t.rz || 0, 'XYZ');
      _q.setFromEuler(_e);
      _v.set(t.x || 0, t.y || 0, t.z || 0);
      _s.set(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1);
      _m4.compose(_v, _q, _s);
      geom.applyMatrix4(_m4);
    }
    let list = this.buckets.get(mat);
    if (!list) { list = []; this.buckets.set(mat, list); }
    list.push(prep(geom));
    return this;
  }

  /** Add a part and its mirror image across X — symmetric side details. */
  addMirrored(mat, geom, t) {
    const flipped = prep(geom.clone());
    this.add(mat, geom, t);
    if (t) {
      const mt = { ...t, x: -(t.x || 0), ry: -(t.ry || 0), rz: -(t.rz || 0) };
      _e.set(mt.rx || 0, mt.ry || 0, mt.rz || 0, 'XYZ');
      _q.setFromEuler(_e);
      _v.set(mt.x, mt.y || 0, mt.z || 0);
      _s.set(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1);
      _m4.compose(_v, _q, _s);
      mirrorX(flipped).applyMatrix4(_m4);
    } else {
      mirrorX(flipped);
    }
    this.buckets.get(mat).push(flipped);
    return this;
  }

  build() {
    for (const [key, list] of this.buckets) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, this.resolve(key));
      mesh.name = `${this.name}:${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
    }
    this.buckets.clear();
    return this.group;
  }
}

/** Triangle count of a built weapon, for the perf report. */
export function countTris(root) {
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return n;
}
