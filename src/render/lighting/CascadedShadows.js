import * as THREE from 'three';
import { CSM_DEPTH_RANGE, CSM_SHADOW_NEAR } from './ShadowShaders.js';

/**
 * Cascaded shadow maps for the key light.
 *
 * One DirectionalLight per cascade (three binds exactly one shadow map per
 * light); the patched `lights_fragment_begin` collapses them back into a single
 * lighting contribution. Cascades are fitted to the *bounding sphere* of each
 * view-frustum slice rather than a light-space AABB: the sphere is invariant to
 * camera yaw/pitch, so combined with texel snapping the shadow texels stay
 * locked to world space and the map does not crawl while the player moves.
 *
 * Every cascade shares one orthographic depth span so the shader can recover
 * blocker distance in metres from a compile-time constant (see ShadowShaders).
 */

const _center = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ALT_UP = new THREE.Vector3(0, 0, 1);

export class CascadedShadows {
  constructor(scene, { count = 3, mapSize = 2048, shadowDistance = 110, lambda = 0.7, overlap = 0.06 } = {}) {
    this.count = Math.max(1, Math.min(4, count | 0));
    this.mapSize = mapSize;
    this.shadowDistance = shadowDistance;
    this.lambda = lambda;
    this.overlap = overlap;
    this.angularRadius = 0.032;

    this.root = new THREE.Group();
    this.root.name = 'CSM';
    this.root.matrixAutoUpdate = false;

    this.lights = [];
    this.splits = new Float32Array(this.count + 1);
    this.radii = new Float32Array(this.count);
    this._fingerprint = '';

    for (let i = 0; i < this.count; i++) {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, CSM_SHADOW_NEAR, CSM_SHADOW_NEAR + CSM_DEPTH_RANGE);
      const light = new THREE.DirectionalLight(0xffffff, 0);
      light.name = `SunCascade${i}`;
      light.castShadow = true;
      light.shadow.camera = cam;
      light.shadow.mapSize.set(mapSize, mapSize);
      light.shadow.intensity = 1;
      light.shadow.bias = -0.0002;
      light.shadow.normalBias = 0.02;
      light.shadow.radius = 0.05;
      light.target.name = `SunCascade${i}Target`;
      this.root.add(light, light.target);
      this.lights.push(light);
    }

    scene.add(this.root);
    this.sun = this.lights[0];
  }

  setDirection(dir) {
    _dir.copy(dir);
    if (_dir.lengthSq() < 1e-8) _dir.set(0.3, 0.8, 0.4);
    _dir.normalize();
  }

  setColor(color, intensity) {
    for (const l of this.lights) {
      l.color.copy(color);
      l.intensity = intensity;
    }
  }

  /** Practical (PSSM) split scheme — logarithmic blended with uniform. */
  _computeSplits(near) {
    const n = Math.max(near, 0.25);
    const far = this.shadowDistance;
    const N = this.count;
    this.splits[0] = n;
    for (let i = 1; i <= N; i++) {
      const p = i / N;
      const log = n * Math.pow(far / n, p);
      const uni = n + (far - n) * p;
      this.splits[i] = this.lambda * log + (1 - this.lambda) * uni;
    }
    this.splits[N] = far;
  }

  /** Minimal sphere enclosing the frustum slice, in view space. */
  _sliceSphere(z0, z1, tanH, tanV, out) {
    const a = tanH * tanH + tanV * tanV;
    let zc = 0.5 * (z0 + z1) * (1 + a);
    if (zc > z1) zc = z1;
    if (zc < z0) zc = z0;
    const dz1 = z1 - zc;
    const dz0 = z0 - zc;
    const r = Math.sqrt(Math.max(dz1 * dz1 + a * z1 * z1, dz0 * dz0 + a * z0 * z0));
    out.z = zc;
    out.r = r;
  }

  update(camera, direction) {
    if (direction) this.setDirection(direction);

    const fingerprint = `${camera.fov}|${camera.aspect}|${camera.near}|${this.shadowDistance}`;
    if (fingerprint !== this._fingerprint) {
      this._fingerprint = fingerprint;
      this._computeSplits(camera.near);
      this._dirty = true;
    }

    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const tanH = tanV * camera.aspect;

    _up.copy(Math.abs(_dir.y) > 0.995 ? ALT_UP : WORLD_UP);
    _axisZ.copy(_dir);
    _axisX.copy(_up).cross(_axisZ).normalize();
    _axisY.copy(_axisZ).cross(_axisX);

    const slice = this._slice || (this._slice = { z: 0, r: 0 });
    const halfDepth = CSM_DEPTH_RANGE * 0.5;

    for (let i = 0; i < this.count; i++) {
      const z0 = i === 0 ? this.splits[0] : this.splits[i] * (1 - this.overlap);
      const z1 = this.splits[i + 1];
      this._sliceSphere(z0, z1, tanH, tanV, slice);

      // Quantise the radius so a slowly changing fov/aspect does not resize the
      // ortho box every frame, which would defeat texel snapping. A wide FOV
      // makes the outer slice's sphere balloon far past the shadow distance, so
      // cap it — better a soft fade at the edge than a whole cascade of texels
      // spent on ground the player cannot make out anyway.
      const r = Math.min(Math.ceil(slice.r * 4) / 4, this.shadowDistance * 0.8);
      _center.set(0, 0, -slice.z).applyMatrix4(camera.matrixWorld);

      const texelWorld = (2 * r) / this.mapSize;
      const px = Math.round(_center.dot(_axisX) / texelWorld) * texelWorld;
      const py = Math.round(_center.dot(_axisY) / texelWorld) * texelWorld;
      const pz = _center.dot(_axisZ);
      _center.set(0, 0, 0).addScaledVector(_axisX, px).addScaledVector(_axisY, py).addScaledVector(_axisZ, pz);
      _eye.copy(_center).addScaledVector(_axisZ, halfDepth + CSM_SHADOW_NEAR);

      const light = this.lights[i];
      const cam = light.shadow.camera;
      if (this.radii[i] !== r) {
        this.radii[i] = r;
        cam.left = -r;
        cam.right = r;
        cam.top = r;
        cam.bottom = -r;
        cam.updateProjectionMatrix();
      }
      cam.up.copy(_up);
      light.position.copy(_eye);
      light.target.position.copy(_center);

      // Normal-offset plus a texel-proportional constant bias: the offset does
      // the heavy lifting on slopes, the constant kills residual self-shadow.
      light.shadow.normalBias = texelWorld * 1.45 + 0.008;
      light.shadow.bias = -(0.012 + texelWorld * 1.1) / CSM_DEPTH_RANGE;
      // Penumbra scale in UV per unit of normalised depth delta.
      light.shadow.radius = (this.angularRadius * CSM_DEPTH_RANGE) / (2 * r);
    }
  }

  dispose() {
    for (const l of this.lights) {
      l.shadow.dispose();
      l.dispose();
    }
    this.root.removeFromParent();
    this.lights.length = 0;
  }
}
