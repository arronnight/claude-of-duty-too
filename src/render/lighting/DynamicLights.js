import * as THREE from 'three';
import { cookie } from './Cookies.js';

/**
 * Pooled dynamic light manager.
 *
 * The scene keeps a *fixed* set of THREE lights forever: adding, removing or
 * hiding a light changes NUM_POINT_LIGHTS / NUM_SPOT_LIGHT_SHADOWS, which
 * invalidates every shader program in the scene and hitches. So callers get
 * lightweight handles instead, and each frame the highest-scoring handles are
 * bound into the real light slots. Shadow-capable slots are a fixed subset, so
 * the shadow budget is structural rather than enforced by a runtime check.
 *
 * Score is `intensity / distance²` weighted by screen relevance, with a
 * stickiness bonus for the incumbent so lights do not thrash at the boundary.
 */

const MAX_HANDLES = 128;
const FADE_RATE = 6.5;
const PARK = new THREE.Vector3(0, -4000, 0);

const _v = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _camPos = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

let _nextId = 1;

function makeHandle() {
  return {
    id: 0,
    type: 'point',
    active: false,
    position: new THREE.Vector3(),
    direction: new THREE.Vector3(0, -1, 0),
    color: new THREE.Color(1, 1, 1),
    intensity: 1,
    radius: 10,
    angle: 0.7,
    penumbra: 0.45,
    decay: 2,
    cookie: 'soft',
    castShadow: false,
    weight: 1,
    flicker: 0,
    phase: 0,
    _slot: null,
    _score: 0,
    setPosition(x, y, z) {
      this.position.set(x, y, z);
      return this;
    },
    setIntensity(v) {
      this.intensity = v;
      return this;
    },
    setColor(c) {
      this.color.set(c);
      return this;
    },
  };
}

export class DynamicLights {
  constructor(scene, cfg) {
    this.cfg = cfg;
    this.scene = scene;
    this.time = 0;

    this.root = new THREE.Group();
    this.root.name = 'DynamicLights';
    scene.add(this.root);

    this.handles = new Array(MAX_HANDLES);
    this._free = [];
    for (let i = MAX_HANDLES - 1; i >= 0; i--) {
      this.handles[i] = makeHandle();
      this._free.push(this.handles[i]);
    }
    this._active = [];
    this._order = [];

    this.pointSlots = [];
    for (let i = 0; i < cfg.points; i++) {
      const shadowed = i < cfg.pointShadows;
      const light = new THREE.PointLight(0xffffff, 0, 1, 2);
      light.name = `PoolPoint${i}`;
      light.castShadow = shadowed;
      if (shadowed) {
        light.shadow.mapSize.set(cfg.pointShadowMapSize, cfg.pointShadowMapSize);
        light.shadow.bias = -0.004;
        light.shadow.normalBias = 0.04;
        light.shadow.radius = 2.5;
        light.shadow.camera.near = 0.12;
      }
      this.root.add(light);
      this.pointSlots.push({ light, shadowed, handle: null, want: null, fade: 0 });
    }

    // A spot's shadow map and its cookie each burn a fragment texture unit, and
    // the class of a light (shadow / map / neither) must never change or three
    // reorders the light array and recompiles every program. Both are therefore
    // decided once, here.
    this.spotSlots = [];
    for (let i = 0; i < cfg.spots; i++) {
      const shadowed = i < cfg.spotShadows;
      const cookied = i < cfg.spotCookies;
      const light = new THREE.SpotLight(0xffffff, 0, 1, 0.6, 0.5, 2);
      light.name = `PoolSpot${i}`;
      light.castShadow = shadowed;
      if (cookied) light.map = cookie('soft');
      if (shadowed) {
        light.shadow.mapSize.set(cfg.spotShadowMapSize, cfg.spotShadowMapSize);
        light.shadow.bias = -0.0009;
        light.shadow.normalBias = 0.025;
        light.shadow.radius = 2.2;
        light.shadow.camera.near = 0.2;
        light.shadow.focus = 1;
      }
      this.root.add(light, light.target);
      this.spotSlots.push({ light, shadowed, cookied, handle: null, want: null, fade: 0 });
    }

    // Impulse lights (muzzle flash, explosions, flashbangs) never compete for a
    // pool slot — a gunshot must always light the room it is fired in.
    this.pulseSlots = [];
    for (let i = 0; i < cfg.pulses; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, 2);
      light.name = `PoolPulse${i}`;
      light.castShadow = false;
      this.root.add(light);
      this.pulseSlots.push({ light, t: 0, dur: 0, peak: 0, hold: 0 });
    }

    for (const s of this.pointSlots) this._park(s);
    for (const s of this.spotSlots) this._park(s);
    for (const s of this.pulseSlots) s.light.position.copy(PARK);
  }

  _park(slot) {
    const l = slot.light;
    l.intensity = 0;
    l.distance = 0.25;
    l.position.copy(PARK);
    if (l.isSpotLight) {
      l.angle = 0.05;
      l.target.position.set(PARK.x, PARK.y - 1, PARK.z);
    }
  }

  addPointLight(pos, color = 0xffffff, intensity = 1, radius = 10, opts = {}) {
    const h = this._free.pop();
    if (!h) return null;
    h.id = _nextId++;
    h.type = 'point';
    h.active = true;
    h.position.copy(pos);
    h.color.set(color);
    h.intensity = intensity;
    h.radius = radius;
    h.decay = opts.decay ?? 2;
    h.castShadow = !!opts.castShadow;
    h.weight = opts.weight ?? 1;
    h.flicker = opts.flicker ?? 0;
    h.phase = Math.random() * 100;
    h._slot = null;
    h._score = 0;
    this._active.push(h);
    return h;
  }

  addSpotLight(pos, dir, opts = {}) {
    const h = this._free.pop();
    if (!h) return null;
    h.id = _nextId++;
    h.type = 'spot';
    h.active = true;
    h.position.copy(pos);
    h.direction.copy(dir).normalize();
    h.color.set(opts.color ?? 0xffffff);
    h.intensity = opts.intensity ?? 1;
    h.radius = opts.radius ?? 14;
    h.angle = opts.angle ?? 0.6;
    h.penumbra = opts.penumbra ?? 0.45;
    h.decay = opts.decay ?? 2;
    h.cookie = opts.cookie ?? 'soft';
    h.castShadow = opts.castShadow !== false;
    h.weight = opts.weight ?? 1;
    h.flicker = opts.flicker ?? 0;
    h.phase = Math.random() * 100;
    h._slot = null;
    h._score = 0;
    this._active.push(h);
    return h;
  }

  remove(handle) {
    if (!handle || !handle.active) return;
    handle.active = false;
    if (handle._slot) {
      handle._slot.want = null;
      handle._slot = null;
    }
    const i = this._active.indexOf(handle);
    if (i >= 0) this._active.splice(i, 1);
    this._free.push(handle);
  }

  clear() {
    for (let i = this._active.length - 1; i >= 0; i--) this.remove(this._active[i]);
  }

  pulse(pos, color, intensity, duration = 0.12, radius = 22, hold = 0) {
    let best = null;
    for (const s of this.pulseSlots) {
      const remaining = s.dur > 0 ? 1 - s.t / s.dur : -1;
      if (!best || remaining < best.remaining) best = { s, remaining };
    }
    if (!best) return;
    const s = best.s;
    s.light.position.copy(pos);
    s.light.color.set(color);
    s.light.distance = radius;
    s.peak = intensity;
    s.dur = duration;
    s.hold = hold;
    s.t = 0;
    s.light.intensity = intensity;
    return s;
  }

  /** Screen relevance: in-frustum lights that also sit near the view axis win. */
  _score(h, camera) {
    const d2 = Math.max(h.position.distanceToSquared(_camPos), 0.35);
    const d = Math.sqrt(d2);
    if (d > h.radius * 1.35 + 2) return 0.0001 * h.weight;

    _sphere.center.copy(h.position);
    _sphere.radius = h.radius;
    const inView = _frustum.intersectsSphere(_sphere);

    _v.copy(h.position).sub(_camPos);
    if (d > 0.001) _v.multiplyScalar(1 / d);
    const axial = 0.55 + 0.45 * Math.max(0, _v.dot(_camFwd));

    return (h.intensity / d2) * h.weight * axial * (inView ? 1 : 0.05);
  }

  _bind(slot, h, dt) {
    const l = slot.light;
    if (slot.want !== h) {
      slot.want = h;
    }
    if (slot.handle !== slot.want) {
      slot.fade = Math.max(0, slot.fade - dt * FADE_RATE);
      if (slot.fade <= 0.0001) slot.handle = slot.want;
    } else if (slot.handle) {
      slot.fade = Math.min(1, slot.fade + dt * FADE_RATE);
    }

    const bound = slot.handle;
    if (!bound || !bound.active) {
      if (slot.fade <= 0.0001) this._park(slot);
      else l.intensity = 0;
      return;
    }

    let k = slot.fade;
    if (bound.flicker > 0) {
      const t = this.time * 1.0 + bound.phase;
      const n =
        Math.sin(t * 11.3) * 0.5 + Math.sin(t * 23.7 + 1.7) * 0.32 + Math.sin(t * 47.1 + 4.1) * 0.18;
      k *= 1 + bound.flicker * n;
    }

    l.position.copy(bound.position);
    l.color.copy(bound.color);
    l.distance = bound.radius;
    l.decay = bound.decay;
    l.intensity = Math.max(0, bound.intensity * k);

    if (l.isSpotLight) {
      l.angle = bound.angle;
      l.penumbra = bound.penumbra;
      l.target.position.copy(bound.position).addScaledVector(bound.direction, Math.max(1, bound.radius * 0.5));
      if (slot.cookied) {
        const c = cookie(bound.cookie);
        if (l.map !== c) l.map = c;
      }
    }
  }

  _assign(slots, type, camera, dt) {
    const order = this._order;
    order.length = 0;
    for (const h of this._active) {
      if (h.type !== type) continue;
      h._score = this._score(h, camera) * (h._slot ? 1.3 : 1);
      order.push(h);
    }
    // Insertion sort: the candidate list is tiny and this allocates nothing.
    for (let i = 1; i < order.length; i++) {
      const h = order[i];
      let j = i - 1;
      while (j >= 0 && order[j]._score < h._score) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = h;
    }

    for (const h of order) h._slot = null;

    let cursor = 0;
    // Shadow-capable slots first, and only to handles that asked for shadows.
    for (const slot of slots) {
      if (!slot.shadowed) continue;
      let picked = null;
      while (cursor < order.length) {
        const h = order[cursor];
        if (h._score <= 0.0002) break;
        cursor++;
        if (h.castShadow && !h._slot) {
          picked = h;
          break;
        }
      }
      if (picked) picked._slot = slot;
      this._bind(slot, picked, dt);
    }

    let k = 0;
    for (const slot of slots) {
      if (slot.shadowed) continue;
      let picked = null;
      while (k < order.length) {
        const h = order[k];
        k++;
        if (h._score <= 0.0002) continue;
        if (!h._slot) {
          picked = h;
          break;
        }
      }
      if (picked) picked._slot = slot;
      this._bind(slot, picked, dt);
    }
  }

  update(dt, camera) {
    this.time += dt;

    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_camFwd);
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);

    this._assign(this.pointSlots, 'point', camera, dt);
    this._assign(this.spotSlots, 'spot', camera, dt);

    for (const s of this.pulseSlots) {
      if (s.dur <= 0) continue;
      s.t += dt;
      if (s.t >= s.dur + s.hold) {
        s.dur = 0;
        s.light.intensity = 0;
        s.light.position.copy(PARK);
        continue;
      }
      const decay = Math.max(0, 1 - Math.max(0, s.t - s.hold) / s.dur);
      s.light.intensity = s.peak * decay * decay;
    }
  }

  dispose() {
    for (const s of this.pointSlots) s.light.dispose();
    for (const s of this.spotSlots) s.light.dispose();
    for (const s of this.pulseSlots) s.light.dispose();
    this.root.removeFromParent();
  }
}
