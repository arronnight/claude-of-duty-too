import * as THREE from 'three';

/**
 * Collects world-space triangles from level/prop meshes into one soup that the
 * BVH can consume. Triangles are baked at registration time — the source
 * geometry is never referenced again — so a mesh can be disposed, re-skinned or
 * moved without corrupting collision. Each triangle carries the surface
 * material key so a bullet impact can pick the right decal and sound without a
 * second lookup.
 */

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();

export const LAYER = { WORLD: 1, PROPS: 2, CHARACTERS: 4, DEBRIS: 8 };
const DEFAULT_MATERIAL = 'concrete_wall';

export class StaticGeometry {
  constructor() {
    this.records = new Map();
    this.objects = [];
    this.materialKeys = [];
    this._matIndex = new Map();
    this._nextId = 1;
    this.triangleCount = 0;
    this.pos = new Float32Array(0);
    this.nrm = new Float32Array(0);
    this.obj = new Int32Array(0);
    this.mat = new Int32Array(0);
    this.layer = new Uint8Array(0);
  }

  materialIndex(key) {
    let i = this._matIndex.get(key);
    if (i === undefined) {
      i = this.materialKeys.length;
      this.materialKeys.push(key);
      this._matIndex.set(key, i);
    }
    return i;
  }

  /**
   * @param {THREE.Object3D|THREE.BufferGeometry} source
   * @param {THREE.Matrix4|THREE.Object3D} [transform] extra world transform
   * @param {{material?:string, mask?:number}} [opts]
   */
  add(source, transform, opts) {
    if (!source) return -1;
    const id = this._nextId++;
    const rec = { id, pos: [], nrm: [], obj: [], mat: [], layer: [], count: 0 };
    const extra = transform instanceof THREE.Matrix4
      ? transform
      : transform && transform.isObject3D
        ? (transform.updateWorldMatrix(true, false), transform.matrixWorld)
        : null;

    if (source.isBufferGeometry) {
      _m.identity();
      if (extra) _m.copy(extra);
      this._bakeGeometry(rec, source, _m, -1, opts?.material || DEFAULT_MATERIAL, opts?.mask || LAYER.WORLD, null);
    } else if (source.isObject3D) {
      source.updateWorldMatrix(true, true);
      source.traverse((o) => {
        if (!o.isMesh || o.userData?.noCollide) return;
        if (o.geometry?.attributes?.position === undefined) return;
        const objIndex = this.objects.length;
        this.objects.push(o);
        const key = opts?.material || surfaceKeyOf(o) || DEFAULT_MATERIAL;
        const mask = opts?.mask || o.userData?.physicsLayer || LAYER.WORLD;
        // A low-poly proxy on userData.collider keeps dense art geometry out of
        // the BVH without giving up collision.
        const geom = o.userData?.collider?.isBufferGeometry ? o.userData.collider : o.geometry;
        if (o.isInstancedMesh) {
          for (let i = 0; i < o.count; i++) {
            o.getMatrixAt(i, _m);
            _m.premultiply(o.matrixWorld);
            if (extra) _m.premultiply(extra);
            this._bakeGeometry(rec, geom, _m, objIndex, key, mask, o);
          }
        } else {
          _m.copy(o.matrixWorld);
          if (extra) _m.premultiply(extra);
          this._bakeGeometry(rec, geom, _m, objIndex, key, mask, o);
        }
      });
    } else {
      return -1;
    }

    rec.pos = Float32Array.from(rec.pos);
    rec.nrm = Float32Array.from(rec.nrm);
    rec.obj = Int32Array.from(rec.obj);
    rec.mat = Int32Array.from(rec.mat);
    rec.layer = Uint8Array.from(rec.layer);
    this.records.set(id, rec);
    return id;
  }

  remove(id) {
    return this.records.delete(id);
  }

  clear() {
    this.records.clear();
    this.objects.length = 0;
  }

  /** Pack every live record into contiguous arrays for the BVH build. */
  compile() {
    let total = 0;
    for (const rec of this.records.values()) total += rec.count;
    this.triangleCount = total;
    this.pos = new Float32Array(total * 9);
    this.nrm = new Float32Array(total * 9);
    this.obj = new Int32Array(total);
    this.mat = new Int32Array(total);
    this.layer = new Uint8Array(total);
    let t = 0;
    for (const rec of this.records.values()) {
      this.pos.set(rec.pos, t * 9);
      this.nrm.set(rec.nrm, t * 9);
      this.obj.set(rec.obj, t);
      this.mat.set(rec.mat, t);
      this.layer.set(rec.layer, t);
      t += rec.count;
    }
    return total;
  }

  _bakeGeometry(rec, geom, matrix, objIndex, defaultKey, mask, mesh) {
    const posAttr = geom.attributes.position;
    if (!posAttr) return;
    const nrmAttr = geom.attributes.normal || null;
    const index = geom.index;
    _nm.getNormalMatrix(matrix);
    const groups = geom.groups && geom.groups.length && Array.isArray(mesh?.material) ? geom.groups : null;
    const triTotal = (index ? index.count : posAttr.count) / 3;

    for (let tri = 0; tri < triTotal; tri++) {
      const base = tri * 3;
      let key = defaultKey;
      if (groups) {
        for (let g = 0; g < groups.length; g++) {
          const gr = groups[g];
          if (base >= gr.start && base < gr.start + gr.count) {
            key = mesh.material[gr.materialIndex]?.userData?.surface
              || mesh.material[gr.materialIndex]?.name
              || defaultKey;
            break;
          }
        }
      }
      const matIdx = this.materialIndex(key);
      let degenerate = false;
      const p0 = rec.pos.length;
      for (let c = 0; c < 3; c++) {
        const vi = index ? index.getX(base + c) : base + c;
        _v.fromBufferAttribute(posAttr, vi).applyMatrix4(matrix);
        rec.pos.push(_v.x, _v.y, _v.z);
        if (nrmAttr) {
          _v.fromBufferAttribute(nrmAttr, vi).applyMatrix3(_nm).normalize();
          rec.nrm.push(_v.x, _v.y, _v.z);
        } else {
          rec.nrm.push(0, 0, 0);
        }
      }
      const ax = rec.pos[p0], ay = rec.pos[p0 + 1], az = rec.pos[p0 + 2];
      const e1x = rec.pos[p0 + 3] - ax, e1y = rec.pos[p0 + 4] - ay, e1z = rec.pos[p0 + 5] - az;
      const e2x = rec.pos[p0 + 6] - ax, e2y = rec.pos[p0 + 7] - ay, e2z = rec.pos[p0 + 8] - az;
      const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
      if (cx * cx + cy * cy + cz * cz < 1e-16) degenerate = true;
      if (degenerate) {
        rec.pos.length = p0;
        rec.nrm.length = p0;
        continue;
      }
      rec.obj.push(objIndex);
      rec.mat.push(matIdx);
      rec.layer.push(mask);
      rec.count++;
    }
  }
}

function surfaceKeyOf(mesh) {
  const ud = mesh.userData;
  if (ud) {
    if (typeof ud.surface === 'string') return ud.surface;
    if (typeof ud.physicsMaterial === 'string') return ud.physicsMaterial;
    if (typeof ud.materialKey === 'string') return ud.materialKey;
  }
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (m) {
    if (typeof m.userData?.surface === 'string') return m.userData.surface;
    if (m.name) return m.name;
  }
  return null;
}
