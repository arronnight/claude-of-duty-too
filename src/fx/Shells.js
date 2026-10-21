import * as THREE from 'three';

/**
 * Ejected brass — real rigid bodies, one instanced draw call.
 *
 * Casings are the cheapest possible credibility win in a shooter: they are
 * *physical*, so they tumble differently every shot, bounce off the kerb, come
 * to rest and stay there. Faking them with a canned arc reads instantly.
 * `ctx.physics.addRigidBody` already sweeps small bodies continuously (a 1 cm
 * casing at 8 m/s would tunnel through the road otherwise) and sleeps them the
 * moment they settle, so a magazine dump costs almost nothing once it lands.
 *
 * The pool is fixed and recycled oldest-first, and the mesh count tracks the
 * live set so an idle scene pays one skipped draw call and no more.
 *
 * Each body carries an `onImpact` hook that fires the metallic tick through
 * `ctx.audio.playAt` — pitch-randomised by the audio system, gain scaled by the
 * impact speed so a casing that rolls does not ring like one that drops.
 */

const MAX = 56;
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _scale = new THREE.Vector3(1, 1, 1);
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _dead = new THREE.Matrix4().makeScale(0, 0, 0);
const _half = new THREE.Vector3();
const _bodyOpts = {
  type: 'box', halfExtents: _half, mass: 0.012, restitution: 0.34, friction: 0.44,
  linearDamping: 0.03, angularDamping: 0.14, life: 22, position: null, velocity: null,
  angularVelocity: null, onImpact: null, mask: 1 | 2,
};

/** Calibres, in metres. Rifle brass, 9 mm, buckshot hull. */
const CALIBRE = {
  rifle: { len: 0.049, rad: 0.0058, mass: 0.0115, color: 0xc7a04a },
  pistol: { len: 0.0195, rad: 0.0048, mass: 0.0058, color: 0xc9a94f },
  shotgun: { len: 0.070, rad: 0.0098, mass: 0.021, color: 0x8f2f2a },
  sniper: { len: 0.063, rad: 0.0062, mass: 0.0155, color: 0xc7a04a },
};

/** Lathed case profile: rim, extractor groove, taper, neck, open mouth. */
function caseGeometry(len, rad) {
  const pts = [];
  const P = (r, y) => pts.push(new THREE.Vector2(r * rad, y * len));
  P(0.0, -0.5);
  P(0.98, -0.5);
  P(1.05, -0.47);
  P(1.05, -0.42);
  P(0.80, -0.40);
  P(0.80, -0.34);
  P(1.00, -0.30);
  P(0.99, 0.10);
  P(0.93, 0.24);
  P(0.74, 0.34);
  P(0.72, 0.5);
  P(0.60, 0.5);
  P(0.62, 0.30);
  const geo = new THREE.LatheGeometry(pts, 9);
  geo.computeVertexNormals();
  return geo;
}

export class Shells {
  constructor(ctx, capacity = MAX) {
    this.ctx = ctx;
    this.capacity = capacity;
    this.frozen = false;

    // One geometry sized for rifle brass; per-instance scale covers the rest.
    const base = CALIBRE.rifle;
    const geo = caseGeometry(base.len, base.rad);
    const mat = ctx.materials?.get
      ? ctx.materials.get('steel_brushed', {
        color: 0xc9a244, roughness: 0.33, metalness: 1.0, envMapIntensity: 1.45,
      })
      : new THREE.MeshStandardMaterial({ color: 0xc9a244, roughness: 0.33, metalness: 1 });

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.name = 'FXShells';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _dead);
    this.mesh.instanceMatrix.needsUpdate = true;

    /** slot -> { body, scale, staged } */
    this.slots = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.slots[i] = { body: null, sx: 1, sy: 1, staged: false, m: new THREE.Matrix4() };
    this.head = 0;
    this.live = 0;

    const self = this;
    this._onImpact = (body, speed) => {
      if (speed < 0.9) return;
      self.ctx.audio?.playAt?.('shell_tick', body.position, {
        gain: Math.min(1, speed * 0.28),
        pitch: 0.86 + Math.random() * 0.34,
      });
    };
  }

  _take() {
    const slot = this.slots[this.head];
    this.head = (this.head + 1) % this.capacity;
    if (slot.body) {
      this.ctx.physics?.removeRigidBody?.(slot.body);
      slot.body = null;
    }
    slot.staged = false;
    return slot;
  }

  /**
   * @param {THREE.Matrix4|{x,y,z}} worldMatrix ejection port transform (or a point)
   * @param {THREE.Vector3} [velocity] extra inherited velocity
   * @param {string} [caliber] key into CALIBRE
   */
  eject(worldMatrix, velocity, caliber = 'rifle') {
    const cal = CALIBRE[caliber] || CALIBRE.rifle;
    if (worldMatrix?.elements) {
      _pos.setFromMatrixPosition(worldMatrix);
      _right.setFromMatrixColumn(worldMatrix, 0).normalize();
      _up.setFromMatrixColumn(worldMatrix, 1).normalize();
      _fwd.setFromMatrixColumn(worldMatrix, 2).normalize();
    } else {
      _pos.set(worldMatrix?.x ?? 0, worldMatrix?.y ?? 0, worldMatrix?.z ?? 0);
      _right.set(1, 0, 0);
      _up.set(0, 1, 0);
      _fwd.set(0, 0, 1);
    }

    // Right, up and slightly back — the classic AR-15 four-o'clock throw.
    const s = 2.5 + Math.random() * 1.5;
    _vel.copy(_right).multiplyScalar(s)
      .addScaledVector(_up, 1.5 + Math.random() * 0.9)
      .addScaledVector(_fwd, -(0.4 + Math.random() * 0.5));
    if (velocity) _vel.add(velocity);

    _spin.set(
      (Math.random() - 0.5) * 46,
      (Math.random() - 0.5) * 30,
      (Math.random() - 0.5) * 52,
    );

    const slot = this._take();
    slot.sx = cal.rad / CALIBRE.rifle.rad;
    slot.sy = cal.len / CALIBRE.rifle.len;

    const phys = this.ctx.physics;
    if (phys?.addRigidBody) {
      _half.set(cal.rad, cal.len * 0.5, cal.rad);
      _bodyOpts.mass = cal.mass;
      _bodyOpts.position = _pos;
      _bodyOpts.velocity = _vel;
      _bodyOpts.angularVelocity = _spin;
      _bodyOpts.onImpact = this._onImpact;
      slot.body = phys.addRigidBody(_bodyOpts);
      if (slot.body) {
        // Start the case broadside on, not nose-up.
        _q.setFromAxisAngle(_fwd, Math.PI * 0.5);
        slot.body.quaternion.copy(_q);
      }
    } else {
      // No physics yet: park it as a static staged casing so nothing throws.
      slot.staged = true;
      _q.setFromEuler(_euler.set(Math.random() * 3, Math.random() * 3, Math.random() * 3));
      slot.m.compose(_pos, _q, _scale.set(slot.sx, slot.sy, slot.sx));
    }
    return slot;
  }

  /**
   * Places a casing with an explicit transform and no physics — used to freeze
   * brass in mid-air for the staged combat screenshot.
   */
  place(pos, quaternion, caliber = 'rifle') {
    const cal = CALIBRE[caliber] || CALIBRE.rifle;
    const slot = this._take();
    slot.staged = true;
    slot.sx = cal.rad / CALIBRE.rifle.rad;
    slot.sy = cal.len / CALIBRE.rifle.len;
    slot.m.compose(pos, quaternion, _scale.set(slot.sx, slot.sy, slot.sx));
    return slot;
  }

  clear() {
    for (const slot of this.slots) {
      if (slot.body) this.ctx.physics?.removeRigidBody?.(slot.body);
      slot.body = null;
      slot.staged = false;
    }
    this.head = 0;
    this.live = 0;
    this.mesh.count = 0;
  }

  update() {
    let n = 0;
    let dirty = false;
    for (let i = 0; i < this.capacity; i++) {
      const slot = this.slots[i];
      if (slot.staged) {
        this.mesh.setMatrixAt(i, slot.m);
        dirty = true;
        n = Math.max(n, i + 1);
        continue;
      }
      const b = slot.body;
      if (!b || !b.active) {
        if (b && !b.active) { slot.body = null; this.mesh.setMatrixAt(i, _dead); dirty = true; }
        continue;
      }
      if (!this.frozen) {
        _scale.set(slot.sx, slot.sy, slot.sx);
        _m.compose(b.position, b.quaternion, _scale);
        this.mesh.setMatrixAt(i, _m);
        dirty = true;
      }
      n = Math.max(n, i + 1);
    }
    this.live = n;
    this.mesh.count = n;
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.clear();
    this.mesh.geometry.dispose();
  }
}

const _euler = new THREE.Euler();
