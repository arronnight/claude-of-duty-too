import * as THREE from 'three';
import { DT } from './Atlas.js';

/**
 * Projected decal pool — bullet holes, scorch, blood, scuffs.
 *
 * One `InstancedMesh`, one program, one draw call for the whole map's worth of
 * damage, capped and recycled oldest-first.
 *
 * The interesting part is the blend. Decals are drawn with
 *
 *     src = DST_COLOR, dst = ONE_MINUS_SRC_ALPHA
 *     out = dst · mix(1, tint, coverage)
 *
 * i.e. they *modulate* whatever is already in the framebuffer instead of
 * replacing it. That buys correct lighting for free: a bullet hole on a sunlit
 * wall is bright, the same hole in shadow is dark, and neither needs a light
 * loop, a normal, or a second shadow lookup. A decal that ignores the lighting
 * it lands in is one of the clearest tells of a hobby renderer, and this makes
 * getting it wrong impossible. `tint` can exceed 1, which is how the pale
 * exposed-aggregate ring around a concrete impact reads as brighter than the
 * wall.
 *
 * Placement snaps to the surface normal with a small standoff and shrinks the
 * quad if its corners are not backed by geometry, so decals do not sail off the
 * edge of the thing they hit.
 */

const UP = new THREE.Vector3(0, 1, 0);
const ALT = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _drift = new THREE.Vector3();
const _fitPoint = new THREE.Vector3();

export const DECAL_KINDS = {
  bullet_concrete: { tiles: [DT.HOLE_CONCRETE_A, DT.HOLE_CONCRETE_B], tint: [0.98, 0.97, 0.95], size: 0.18, life: 90 },
  bullet_plaster: { tiles: [DT.HOLE_CONCRETE_A, DT.HOLE_CONCRETE_B], tint: [1.02, 1, 0.95], size: 0.24, life: 90 },
  bullet_brick: { tiles: [DT.HOLE_CONCRETE_B, DT.HOLE_CONCRETE_A], tint: [1.02, 0.94, 0.88], size: 0.2, life: 90 },
  bullet_metal: { tiles: [DT.HOLE_METAL], tint: [1, 1, 1.02], size: 0.14, life: 90 },
  bullet_wood: { tiles: [DT.HOLE_WOOD], tint: [1, 0.96, 0.9], size: 0.18, life: 90 },
  bullet_glass: { tiles: [DT.CRACK_GLASS], tint: [1, 1, 1], size: 0.3, life: 90 },
  bullet_sand: { tiles: [DT.DIVOT_SAND], tint: [1.04, 1, 0.9], size: 0.26, life: 45 },
  spall: { tiles: [DT.SPALL_CLUSTER], tint: [0.98, 0.97, 0.95], size: 0.6, life: 90 },
  scorch: { tiles: [DT.SCORCH], tint: [1, 0.97, 0.93], size: 2.6, life: 120 },
  blood: { tiles: [DT.BLOOD_A, DT.BLOOD_B], tint: [0.34, 0.055, 0.05], size: 0.42, life: 40 },
  scuff: { tiles: [DT.SCUFF], tint: [1, 0.99, 0.97], size: 0.9, life: 60 },
  oil: { tiles: [DT.OIL], tint: [0.85, 0.88, 0.95], size: 1.2, life: 120 },
};

const VERT = /* glsl */ `
precision highp float;
attribute vec4 iTint;   // rgb tint, a peak opacity
attribute vec4 iMeta;   // tile, birth, life, fadeOut

uniform float uTime;

varying vec2 vUv;
varying vec3 vTint;
varying float vAlpha;

void main(){
  float age = uTime - iMeta.y;
  float life = iMeta.z;
  float fade = smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(life - iMeta.w, life, age));
  vAlpha = iTint.a * fade;

  float tx = mod(iMeta.x, 4.0);
  float ty = floor(iMeta.x * 0.25);
  vec2 iuv = mix(vec2(0.008), vec2(0.992), uv);
  vUv = vec2((tx + iuv.x) * 0.25, 1.0 - (ty + 1.0 - iuv.y) * 0.25);
  vTint = iTint.rgb;

  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  if (vAlpha <= 0.001) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec3 vTint;
varying float vAlpha;

void main(){
  vec4 t = texture2D(uAtlas, vUv);
  float cov = t.a * vAlpha;
  if (cov < 0.004) discard;
  // Premultiplied modulate: with src=DST_COLOR, dst=1-SRC_ALPHA this resolves
  // to dst * mix(1.0, tint, cov).
  vec3 tint = t.rgb * 2.0 * vTint;
  gl_FragColor = vec4(tint * cov, cov);
}
`;

export class Decals {
  constructor(ctx, atlas, capacity = 320) {
    this.ctx = ctx;
    this.capacity = capacity;
    this.head = 0;
    this.count = 0;
    this.time = 0;

    const geo = new THREE.PlaneGeometry(1, 1);
    this.tint = new Float32Array(capacity * 4);
    this.meta = new Float32Array(capacity * 4);
    const tintAttr = new THREE.InstancedBufferAttribute(this.tint, 4);
    const metaAttr = new THREE.InstancedBufferAttribute(this.meta, 4);
    tintAttr.setUsage(THREE.DynamicDrawUsage);
    metaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iTint', tintAttr);
    geo.setAttribute('iMeta', metaAttr);
    this.tintAttr = tintAttr;
    this.metaAttr = metaAttr;

    this.uniforms = {
      uAtlas: { value: atlas },
      uTime: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -6,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.name = 'FXDecals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Park every slot so an untouched instance never renders a unit quad at
    // the origin.
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {THREE.Vector3|{x,y,z}} point surface point
   * @param {THREE.Vector3|{x,y,z}} normal surface normal (outward)
   * @param {string} kind key into DECAL_KINDS
   * @param {number} [size] override diameter in metres
   * @param {number} [opacity]
   */
  add(point, normal, kind, size, opacity = 1) {
    const def = DECAL_KINDS[kind] || DECAL_KINDS.bullet_concrete;
    _n.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();

    // Copy: `_fit` nudges the centre to keep the quad on the surface, and the
    // caller's vector is very often a pooled physics hit that must not move.
    _fitPoint.set(point.x, point.y, point.z);
    let s = size || def.size;
    s *= 0.85 + 0.3 * Math.random();
    s = this._fit(_fitPoint, _n, s);

    // Orthonormal basis with a random roll so repeated hits never tile.
    _t.copy(Math.abs(_n.y) > 0.94 ? ALT : UP).cross(_n).normalize();
    _b.copy(_n).cross(_t).normalize();
    const roll = Math.random() * Math.PI * 2;
    const cs = Math.cos(roll);
    const sn = Math.sin(roll);
    _p.copy(_t).multiplyScalar(cs).addScaledVector(_b, sn);
    _b.copy(_t).multiplyScalar(-sn).addScaledVector(_b, cs);
    _t.copy(_p);
    _basis.makeBasis(_t, _b, _n);
    _q.setFromRotationMatrix(_basis);

    _origin.copy(_fitPoint).addScaledVector(_n, 0.012 + s * 0.012);
    _scale.set(s, s, s);
    _m.compose(_origin, _q, _scale);

    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;

    const o = i * 4;
    const tiles = def.tiles;
    this.meta[o] = tiles[(Math.random() * tiles.length) | 0];
    this.meta[o + 1] = this.time;
    this.meta[o + 2] = def.life;
    this.meta[o + 3] = Math.min(6, def.life * 0.2);
    this.tint[o] = def.tint[0];
    this.tint[o + 1] = def.tint[1];
    this.tint[o + 2] = def.tint[2];
    this.tint[o + 3] = opacity;
    this.tintAttr.needsUpdate = true;
    this.metaAttr.needsUpdate = true;
    this.mesh.count = this.count;
    return i;
  }

  /**
   * Fits the decal to the surface it landed on.
   *
   * A flat quad projected onto a wall will hang off the corner of that wall
   * into open air, which is the single most obvious decal artefact there is.
   * This walks eight points around the rim, casts each one back at the surface,
   * and both shrinks the quad *and* nudges its centre away from whichever side
   * is unsupported until it fits or gets too small to matter.
   *
   * The rim samples are radial, not the quad's own corners, so the result does
   * not depend on the random roll applied afterwards.
   */
  _fit(point, normal, size) {
    const phys = this.ctx.physics;
    if (!phys?.raycast) return size;
    _t.copy(Math.abs(normal.y) > 0.94 ? ALT : UP).cross(normal).normalize();
    _b.copy(normal).cross(_t).normalize();

    let s = size;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = s * 0.46;
      let missed = 0;
      _drift.set(0, 0, 0);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const dx = Math.cos(a) * r;
        const dz = Math.sin(a) * r;
        _p.set(point.x, point.y, point.z)
          .addScaledVector(_t, dx)
          .addScaledVector(_b, dz)
          .addScaledVector(normal, 0.12);
        _origin.copy(normal).multiplyScalar(-1);
        const hit = phys.raycast(_p, _origin, 0.26, 1 | 2);
        if (!hit || hit.normal.dot(normal) < 0.65) {
          missed++;
          // Pull away from the unsupported side.
          _drift.addScaledVector(_t, -dx).addScaledVector(_b, -dz);
        }
      }
      if (missed === 0) return s;
      if (missed < 4) {
        _drift.multiplyScalar(0.55 / missed);
        point.x += _drift.x; point.y += _drift.y; point.z += _drift.z;
      }
      s *= 0.55;
      if (s < 0.05) return s;
    }
    return s;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) this.tint[i * 4 + 3] = 0;
    this.tintAttr.needsUpdate = true;
    this.head = 0;
    this.count = 0;
    this.mesh.count = 0;
  }

  update(time) {
    this.time = time;
    this.uniforms.uTime.value = time;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
