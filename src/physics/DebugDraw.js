import * as THREE from 'three';

/**
 * Line-list visualiser for the collision world: BVH leaves near the camera,
 * the player capsule, live rigid bodies and ragdoll links. It writes into one
 * preallocated buffer and moves the draw range, so toggling it on costs a
 * single extra draw call and no allocation. Off by default.
 */

const MAX_VERTS = 48000;
const BOX_EDGES = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7];
const RAGDOLL_LINKS = [0, 1, 1, 2, 1, 3, 1, 4, 0, 5, 0, 6];
const _corners = new Float32Array(24);
const _c = new THREE.Vector3();

export class DebugDraw {
  constructor(physics) {
    this.phys = physics;
    this.enabled = false;
    this.range = 26;
    this.maxLeaves = 900;
    this.positions = new Float32Array(MAX_VERTS * 3);
    this.colors = new Float32Array(MAX_VERTS * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geom.setDrawRange(0, 0);
    this.mesh = new THREE.LineSegments(
      geom,
      new THREE.LineBasicMaterial({
        vertexColors: true, depthTest: false, transparent: true, opacity: 0.85, toneMapped: false,
      }),
    );
    this.mesh.name = 'PhysicsDebug';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 998;
    this.mesh.visible = false;
    this._n = 0;
    this._stack = new Int32Array(128);
  }

  setEnabled(v, scene) {
    this.enabled = !!v;
    this.mesh.visible = this.enabled;
    if (this.enabled && scene && !this.mesh.parent) scene.add(this.mesh);
    if (!this.enabled) this.mesh.geometry.setDrawRange(0, 0);
  }

  _line(x0, y0, z0, x1, y1, z1, r, g, b) {
    if (this._n + 2 > MAX_VERTS) return;
    const p = this.positions, c = this.colors;
    let i = this._n * 3;
    p[i] = x0; p[i + 1] = y0; p[i + 2] = z0;
    c[i] = r; c[i + 1] = g; c[i + 2] = b;
    i += 3;
    p[i] = x1; p[i + 1] = y1; p[i + 2] = z1;
    c[i] = r; c[i + 1] = g; c[i + 2] = b;
    this._n += 2;
  }

  _aabb(x0, y0, z0, x1, y1, z1, r, g, b) {
    for (let i = 0; i < 8; i++) {
      _corners[i * 3] = (i & 1) ? x1 : x0;
      _corners[i * 3 + 1] = (i & 2) ? y1 : y0;
      _corners[i * 3 + 2] = (i & 4) ? z1 : z0;
    }
    this._edges(r, g, b);
  }

  _edges(r, g, b) {
    for (let e = 0; e < 24; e += 2) {
      const a = BOX_EDGES[e] * 3, c = BOX_EDGES[e + 1] * 3;
      this._line(_corners[a], _corners[a + 1], _corners[a + 2], _corners[c], _corners[c + 1], _corners[c + 2], r, g, b);
    }
  }

  /** axis 0 = YZ plane, 1 = XZ plane, 2 = XY plane. */
  _ring(cx, cy, cz, radius, axis, r, g, b) {
    const seg = 18;
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const s = Math.sin(a) * radius, co = Math.cos(a) * radius;
      const x = axis === 0 ? cx : cx + co;
      const y = axis === 1 ? cy : axis === 0 ? cy + co : cy + s;
      const z = axis === 2 ? cz : axis === 0 ? cz + s : cz + s;
      if (i > 0) this._line(px, py, pz, x, y, z, r, g, b);
      px = x; py = y; pz = z;
    }
  }

  capsule(pos, radius, height, r, g, b) {
    const rr = Math.min(radius, height * 0.5);
    const ay = pos.y + rr, by = pos.y + height - rr;
    this._ring(pos.x, ay, pos.z, rr, 1, r, g, b);
    this._ring(pos.x, by, pos.z, rr, 1, r, g, b);
    this._ring(pos.x, (ay + by) * 0.5, pos.z, rr, 1, r, g, b);
    this._ring(pos.x, ay, pos.z, rr, 0, r, g, b);
    this._ring(pos.x, by, pos.z, rr, 2, r, g, b);
    this._line(pos.x - rr, ay, pos.z, pos.x - rr, by, pos.z, r, g, b);
    this._line(pos.x + rr, ay, pos.z, pos.x + rr, by, pos.z, r, g, b);
    this._line(pos.x, ay, pos.z - rr, pos.x, by, pos.z - rr, r, g, b);
    this._line(pos.x, ay, pos.z + rr, pos.x, by, pos.z + rr, r, g, b);
    this._line(pos.x, pos.y, pos.z, pos.x, pos.y + height, pos.z, r * 0.6, g * 0.6, b);
  }

  update(camera) {
    if (!this.enabled) return;
    this._n = 0;
    const phys = this.phys;
    const bvh = phys.bvh;

    if (bvh.triCount) {
      const nb = bvh.nodeBox;
      this._aabb(nb[0], nb[1], nb[2], nb[3], nb[4], nb[5], 0.85, 0.85, 1.0);
      const cx = camera ? camera.position.x : 0;
      const cy = camera ? camera.position.y : 0;
      const cz = camera ? camera.position.z : 0;
      const rng = this.range;
      const stack = this._stack;
      let node = 0, sp = 0, leaves = 0;
      for (;;) {
        const o = node * 6;
        if (nb[o] <= cx + rng && nb[o + 3] >= cx - rng
          && nb[o + 1] <= cy + rng && nb[o + 4] >= cy - rng
          && nb[o + 2] <= cz + rng && nb[o + 5] >= cz - rng) {
          if (bvh.nodeTris[node] === 0) {
            const l = bvh.nodeLeft[node];
            if (sp < stack.length) stack[sp++] = l + 1;
            node = l;
            continue;
          }
          if (leaves < this.maxLeaves) {
            leaves++;
            this._aabb(nb[o], nb[o + 1], nb[o + 2], nb[o + 3], nb[o + 4], nb[o + 5], 0.14, 0.62, 0.24);
          }
        }
        if (sp === 0) break;
        node = stack[--sp];
      }
    }

    for (const cap of phys.capsules) {
      if (cap.grounded) this.capsule(cap.position, cap.radius, cap.height, 0.25, 1.0, 0.4);
      else this.capsule(cap.position, cap.radius, cap.height, 1.0, 0.85, 0.2);
    }

    for (const b of phys.bodies.active) {
      const g = b.sleeping ? 0.35 : 1.0;
      if (b.type === 1) {
        for (let i = 0; i < 8; i++) {
          _c.set((i & 1) ? b.half.x : -b.half.x, (i & 2) ? b.half.y : -b.half.y, (i & 4) ? b.half.z : -b.half.z);
          _c.applyQuaternion(b.quaternion).add(b.position);
          _corners[i * 3] = _c.x; _corners[i * 3 + 1] = _c.y; _corners[i * 3 + 2] = _c.z;
        }
        this._edges(0.95 * g, 0.55 * g, 0.15 * g);
      } else {
        this._ring(b.position.x, b.position.y, b.position.z, b.radius, 1, 0.95 * g, 0.55 * g, 0.15 * g);
        this._ring(b.position.x, b.position.y, b.position.z, b.radius, 0, 0.95 * g, 0.55 * g, 0.15 * g);
      }
    }

    for (const rd of phys.ragdolls.active) {
      const ps = rd.particles;
      for (let i = 0; i < ps.length; i++) {
        this._ring(ps[i].position.x, ps[i].position.y, ps[i].position.z, ps[i].radius, 1, 0.9, 0.25, 0.5);
        this._ring(ps[i].position.x, ps[i].position.y, ps[i].position.z, ps[i].radius, 0, 0.9, 0.25, 0.5);
      }
      for (let e = 0; e < RAGDOLL_LINKS.length; e += 2) {
        const a = ps[RAGDOLL_LINKS[e]].position, b = ps[RAGDOLL_LINKS[e + 1]].position;
        this._line(a.x, a.y, a.z, b.x, b.y, b.z, 1.0, 0.35, 0.6);
      }
    }

    // Upload only the vertices actually written — the full buffer is 1 MB.
    const geom = this.mesh.geometry;
    const used = this._n * 3;
    for (const attr of [geom.attributes.position, geom.attributes.color]) {
      attr.clearUpdateRanges?.();
      attr.addUpdateRange?.(0, used);
      attr.needsUpdate = true;
    }
    geom.setDrawRange(0, this._n);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
