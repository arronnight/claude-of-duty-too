import * as THREE from 'three';
import { installLightingShaders } from './lighting/ShadowShaders.js';
import { CascadedShadows } from './lighting/CascadedShadows.js';
import { DynamicLights } from './lighting/DynamicLights.js';
import { IndirectLight } from './lighting/Indirect.js';

/**
 * The lighting authority: key light (sun/moon) with cascaded PCSS shadows,
 * the pooled dynamic light budget, and the indirect/ambient approximation.
 *
 * Direction and colour come from `ctx.sky`, but intensity is derived here from
 * solar elevation so exposure stays physically ordered no matter what curve the
 * sky system uses for its own gradients — a sun 3° above the horizon must not
 * light the world like noon. Everything guards against `ctx.sky`, `ctx.level`
 * and `ctx.physics` being absent, because those systems initialise after (or
 * alongside) this one; the level's fixtures are picked up on `engine:ready`.
 */

// Fallback peak, used only when `ctx.sky` is missing or publishes no radiometry.
// With a live sky the key light is derived from its published irradiance instead
// (see `_updateKey`), because the two must agree: the dome, the PMREM probe and
// the aerial-perspective inscatter are all authored in `ctx.sky.exposure` units,
// and a directional light on a different scale means the sky and the ground it
// lights are exposed against each other. Measured before this was wired up: the
// sun delivered 2.84 while the dome assumed 21.1 — 2.9 stops apart, which is why
// auto-exposure keyed to the ground and clipped the sky to flat white.
const SUN_PEAK = 3.7;
// Moonlight is really ~1/400,000 of sunlight. Every shooter cheats it up to
// roughly a stop below "readable" so a night map is playable and silhouettes
// still read; 1/9 of the sun is the usual neighbourhood.
const MOON_PEAK = 0.78;
/** Luminance of a linear colour, for renormalising a peak-normalised light tint. */
function lum(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

const SUN_RAMP = [
  [-0.02, 0xff5f22],
  [0.035, 0xff8a3e],
  [0.09, 0xffb26c],
  [0.2, 0xffd6a6],
  [0.42, 0xfff0da],
  [0.8, 0xfffaf2],
];

const UP = new THREE.Vector3(0, 1, 0);
const _sunDir = new THREE.Vector3(0.32, 0.78, 0.42);
const _keyDir = new THREE.Vector3();
const _moonDir = new THREE.Vector3();
const _keyColor = new THREE.Color();
const _sunColor = new THREE.Color();
const _moonColor = new THREE.Color(0x9ab2dc);
const MOON_TINT = new THREE.Color(0x8ea9dc);
const _skyColor = new THREE.Color(0x8fb2d4);
const _horizonColor = new THREE.Color(0xb9c8d4);
const _pos = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _rampA = new THREE.Color();
const _rampB = new THREE.Color();

function sunRamp(y, out) {
  const r = SUN_RAMP;
  if (y <= r[0][0]) return out.setHex(r[0][1], THREE.SRGBColorSpace);
  for (let i = 1; i < r.length; i++) {
    if (y <= r[i][0]) {
      const t = (y - r[i - 1][0]) / (r[i][0] - r[i - 1][0]);
      _rampA.setHex(r[i - 1][1], THREE.SRGBColorSpace);
      _rampB.setHex(r[i][1], THREE.SRGBColorSpace);
      return out.copy(_rampA).lerp(_rampB, t);
    }
  }
  return out.setHex(r[r.length - 1][1], THREE.SRGBColorSpace);
}

const POOLS = {
  low: { points: 3, pointShadows: 0, spots: 1, spotShadows: 0, spotCookies: 0, pulses: 1, bounce: false },
  medium: { points: 4, pointShadows: 0, spots: 2, spotShadows: 1, spotCookies: 0, pulses: 2, bounce: false },
  high: { points: 5, pointShadows: 1, spots: 3, spotShadows: 2, spotCookies: 1, pulses: 2, bounce: true },
  ultra: { points: 6, pointShadows: 1, spots: 4, spotShadows: 3, spotCookies: 2, pulses: 2, bounce: true },
};

// Every shadow map and every cookie costs one fragment texture unit, and a
// MeshStandardMaterial with a full PBR set plus the environment probe and the
// sky's aerial-perspective LUT already needs about nine. Blowing
// MAX_TEXTURE_IMAGE_UNITS does not degrade — the program fails to link and the
// surface renders black — so the lighting side is budgeted explicitly.
const RESERVED_UNITS = 10;

function allocateShadowUnits(renderer, want) {
  const max = renderer?.capabilities?.maxTextures ?? 16;
  let left = THREE.MathUtils.clamp(max - RESERVED_UNITS, 2, 10);
  // A fourth cascade buys less than a shadowed spot light does, so the spot
  // allocation is protected first when units are scarce.
  const cascades = THREE.MathUtils.clamp(want.cascades, 1, Math.max(1, left - 3));
  left -= cascades;
  // One cookie earns more per texture unit than a third shadowed spot: a
  // window pattern on a floor sells an interior in a way a shadow cannot.
  const spotCookies = Math.min(want.spotCookies, Math.max(0, left - 1), 1);
  left -= spotCookies;
  const spotShadows = Math.min(want.spotShadows, left);
  left -= spotShadows;
  const pointShadows = Math.min(want.pointShadows, left);
  return { cascades, spotShadows, spotCookies, pointShadows };
}

export class LightingSystem {
  async init(ctx) {
    this.ctx = ctx;
    const q = ctx.quality || {};
    const tier = POOLS[q.tier] ? q.tier : 'high';
    this.tier = tier;
    this.tod = 0.32;
    this._hooked = false;
    this._angularOverride = null;

    const pool = POOLS[tier];
    const budget = allocateShadowUnits(ctx.renderer, {
      cascades: Math.max(1, Math.min(4, q.cascades || 3)),
      spotShadows: pool.spotShadows,
      spotCookies: pool.spotCookies,
      pointShadows: pool.pointShadows,
    });
    this.budget = budget;

    const cascades = budget.cascades;
    const shader = installLightingShaders({
      cascades,
      pcss: tier !== 'low',
      filterTaps: tier === 'low' ? 8 : tier === 'medium' ? 12 : 16,
      searchTaps: tier === 'ultra' ? 10 : 8,
    });

    // The PCSS chunk reads raw depth, so shadow maps must stay plain
    // (non-comparison) depth textures. Set before any program compiles.
    if (ctx.renderer) {
      ctx.renderer.shadowMap.enabled = true;
      ctx.renderer.shadowMap.type = THREE.BasicShadowMap;
      ctx.renderer.shadowMap.autoUpdate = true;
    }

    this.csm = new CascadedShadows(ctx.scene, {
      count: shader.ok ? cascades : 1,
      mapSize: q.shadowMapSize || 2048,
      shadowDistance: 130,
      lambda: 0.7,
    });

    this.dyn = new DynamicLights(ctx.scene, {
      ...pool,
      ...budget,
      spotShadowMapSize: tier === 'ultra' ? 1024 : 768,
      pointShadowMapSize: 512,
    });

    this.indirect = new IndirectLight(ctx.scene);

    this._levelHandles = [];
    this._flashPayload = { position: new THREE.Vector3(), intensity: 1, duration: 0 };
    this.sunIntensity = 0;
    this.moonFactor = 0;
    this.artificial = 0.5;
    this.exposureHint = 1;
    this.fixtureGain = 1;

    const self = this;
    ctx.lighting = {
      sun: this.csm.sun,
      cascades: this.csm.lights,
      hemisphere: this.indirect.hemi,
      probe: this.indirect.probe,
      maxShadowLights: Math.min(8, budget.pointShadows + budget.spotShadows),
      addPointLight: (pos, color, intensity, radius, opts) =>
        self.dyn.addPointLight(pos, color, intensity, radius, opts),
      addSpotLight: (pos, dir, opts) => self.dyn.addSpotLight(pos, dir, opts),
      remove: (h) => self.dyn.remove(h),
      pulse: (pos, color, intensity, duration, radius) =>
        self.dyn.pulse(pos, color, intensity, duration, radius),
      flashbang: (pos, intensity) => self.flashbang(pos, intensity),
      rescan: () => self._rescan(),
      setShadowDistance: (d) => {
        self.csm.shadowDistance = THREE.MathUtils.clamp(d, 40, 400);
      },
      setSunAngularRadius: (r) => {
        self._angularOverride = r;
      },
      setAmbientScale: (s) => {
        self._ambientScale = s;
      },
      setFixtureGain: (k) => {
        self.fixtureGain = Math.max(0.05, k);
        self._rescan();
      },
      setGroundAlbedo: (c) => {
        self.indirect.groundAlbedo.set(c);
        self.indirect._skyDirty = true;
      },
      get sunDirection() {
        return _keyDir;
      },
      get keyIntensity() {
        return self.csm.sun.intensity;
      },
      get exposureHint() {
        return self.exposureHint;
      },
      get isNight() {
        return self.moonFactor > 0.5;
      },
    };

    ctx.sunLight = this.csm.sun; // legacy handle the scaffold exposed

    ctx.bus.on('engine:ready', () => this._onReady());
    ctx.bus.on('sky:timeOfDay', (t) => {
      if (typeof t === 'number') this.tod = t;
    });
    ctx.bus.on('weapon:fired', (e) => this._muzzle(e));
    ctx.bus.on('fx:explosion', (e) => this._explosion(e));
  }

  _onReady() {
    const ctx = this.ctx;
    if (ctx.renderer && ctx.renderer.shadowMap.type !== THREE.BasicShadowMap) {
      ctx.renderer.shadowMap.type = THREE.BasicShadowMap;
      ctx.scene.traverse((o) => {
        const m = o.material;
        if (!m) return;
        if (Array.isArray(m)) for (const mm of m) mm.needsUpdate = true;
        else m.needsUpdate = true;
      });
    }
    this._rescan();
  }

  /** Reads `ctx.level.lightSpecs` and rebuilds fixtures + irradiance probes. */
  _rescan() {
    const ctx = this.ctx;
    for (const h of this._levelHandles) this.dyn.remove(h);
    this._levelHandles.length = 0;

    const bounds = ctx.level?.bounds;
    if (bounds?.isBox3 && isFinite(bounds.min.x) && bounds.max.x > bounds.min.x) {
      bounds.getBoundingSphere(_sphere);
      this.csm.shadowDistance = THREE.MathUtils.clamp(_sphere.radius * 1.8, 70, 190);
    }

    const raw = Array.isArray(ctx.level?.lightSpecs) ? ctx.level.lightSpecs : [];
    const specs = [];
    const bounce = POOLS[this.tier].bounce;

    for (const s of raw) {
      const p = s?.position;
      if (!p) continue;
      const type = s.type || 'point';
      const radius = Math.max(1.5, s.radius ?? 10);
      // Levels author "brightness", not candela; anything small is read as a
      // relative value so a spec of `2` is still a lit bulb. The gain is set so
      // a fixture of intensity 4 puts a well-exposed pool of light on a floor
      // 3 m below it under ACES at exposure 1.
      const raw01 = s.intensity ?? 1;
      const candela = (raw01 >= 25 ? raw01 : raw01 * 4.5) * this.fixtureGain;
      const color = s.color ?? 0xffe4bd;
      const outdoor = type === 'lamp' || type === 'street' || type === 'streetlamp';

      const spec = {
        position: new THREE.Vector3(p.x ?? p[0] ?? 0, p.y ?? p[1] ?? 0, p.z ?? p[2] ?? 0),
        color,
        candela,
        radius,
        outdoor,
        type,
      };
      specs.push(spec);

      const common = {
        castShadow: type === 'spot' || radius >= 6,
        flicker: type === 'fire' || type === 'torch' ? 0.34 : outdoor ? 0.015 : 0,
        weight: outdoor ? 0.9 : 1.1,
      };

      let handle;
      if (type === 'spot' || s.direction || s.target) {
        const d = s.direction;
        if (d) _aim.set(d.x ?? 0, d.y ?? -1, d.z ?? 0);
        else if (s.target) _aim.set(s.target.x, s.target.y, s.target.z).sub(spec.position);
        else _aim.set(0, -1, 0);
        handle = this.dyn.addSpotLight(spec.position, _aim, {
          color,
          intensity: candela,
          radius,
          angle: s.angle ?? 0.62,
          penumbra: s.penumbra ?? 0.55,
          cookie: s.cookie ?? (type === 'window' ? 'window' : 'fixture'),
          ...common,
        });
      } else {
        handle = this.dyn.addPointLight(spec.position, color, candela, radius, common);
      }
      if (handle) {
        handle.baseIntensity = candela;
        handle.outdoor = outdoor;
        this._levelHandles.push(handle);
      }

      // A dim, wide companion under each fixture stands in for the first
      // bounce off the floor — the difference between a lit room and a box
      // with a bright spot in it.
      if (bounce && radius >= 4 && type !== 'spot') {
        _pos.copy(spec.position).addScaledVector(UP, -radius * 0.35);
        const b = this.dyn.addPointLight(_pos, color, candela * 0.16, radius * 1.7, {
          decay: 1.5,
          weight: 0.35,
        });
        if (b) {
          b.baseIntensity = candela * 0.16;
          b.outdoor = outdoor;
          this._levelHandles.push(b);
        }
      }
    }

    this.indirect.build(ctx, specs);
  }

  _muzzle(e) {
    const m = e?.muzzle;
    if (!m) return;
    if (m.isVector3) _pos.copy(m);
    else if (m.elements) _pos.setFromMatrixPosition(m);
    else if (m.position) _pos.copy(m.position);
    else return;
    this.dyn.pulse(_pos, 0xffd6a0, 1400, 0.05, 18);
  }

  _explosion(e) {
    const p = e?.pos || e?.position;
    if (!p) return;
    _pos.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    this.dyn.pulse(_pos, 0xffab48, 4200, 0.4, Math.max(14, (e.radius || 6) * 3.5), 0.05);
  }

  flashbang(worldPos, intensity = 1) {
    const p = worldPos || this.ctx.camera.position;
    _pos.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    const i = THREE.MathUtils.clamp(intensity, 0.1, 4);
    this.dyn.pulse(_pos, 0xffffff, 9000 * i, 0.5, 70, 0.1);
    this._flashPayload.position.copy(_pos);
    this._flashPayload.intensity = i;
    this._flashPayload.duration = 0.6;
    this.ctx.bus.emit('lighting:flashbang', this._flashPayload);
  }

  /** Solar elevation drives everything; the moon takes over as key below it. */
  _updateKey() {
    const sky = this.ctx.sky;
    const dir = sky?.sunDirection;
    if (dir?.isVector3 && dir.lengthSq() > 1e-6) {
      _sunDir.copy(dir).normalize();
      // The contract is "direction to the sun"; if a system publishes travel
      // direction instead, broad daylight would arrive from underground.
      if (_sunDir.y < 0 && (sky?.intensity ?? 0) > 0.45) _sunDir.negate();
    } else {
      const a = (Math.PI * (this.tod - 0.05)) / 0.75;
      _sunDir.set(Math.cos(a) * 0.62, Math.sin(a), Math.cos(a) * 0.35 + 0.28).normalize();
    }

    const y = _sunDir.y;
    const day = THREE.MathUtils.smoothstep(y, -0.055, 0.075);

    if (sky?.sunColor?.isColor && day > 0.02) _sunColor.copy(sky.sunColor);
    else sunRamp(y, _sunColor);

    // Radiometric key. `sky.sunIntensity` is the luminance of the extraterrestrial
    // spectrum after the slant optical depth, in the same normalised units the
    // dome integrates; `sky.exposure` converts those to scene-linear. That product
    // is the irradiance on a surface facing the sun, which is exactly what
    // three's DirectionalLight.intensity means — so the two systems agree by
    // construction and the elevation ramp comes from real airmass rather than a
    // curve. `sunColor` is peak-normalised, so divide its luminance back out or a
    // reddened sun would also read as a dimmer one.
    const skyExposure = sky?.exposure;
    const skyIrradiance = sky?.sunIntensity;
    if (Number.isFinite(skyExposure) && Number.isFinite(skyIrradiance) && skyExposure > 0) {
      this.sunIntensity = (skyIrradiance * skyExposure * day) / Math.max(lum(_sunColor), 0.05);
    } else {
      this.sunIntensity = SUN_PEAK * Math.pow(THREE.MathUtils.clamp(y, 0, 1), 0.35) * day;
    }

    const night = 1 - THREE.MathUtils.smoothstep(y, -0.1, 0.06);
    this.moonFactor = night;

    // Shadows must be cast by the moon the player can actually see, so take the
    // sky's ephemeris when it has one; the anti-sun fallback only stands in
    // while the sky system is still a stub.
    const md = sky?.moonDirection;
    if (md?.isVector3 && md.lengthSq() > 1e-6 && md.y > 0.02) _moonDir.copy(md).normalize();
    else _moonDir.set(-_sunDir.x, Math.abs(y) * 0.7 + 0.3, -_sunDir.z).normalize();
    const mc = sky?.moonColor;
    // Real moonlight is near-white; the cool cast is a convention the whole
    // genre uses, and it is what makes a night frame read as night.
    if (mc?.isColor && mc.r + mc.g + mc.b > 0.02) {
      _moonColor.copy(mc).multiplyScalar(1 / Math.max(mc.r, mc.g, mc.b)).lerp(MOON_TINT, 0.5);
    }
    // Phase dims the moon, but never past the point where the map goes unlit.
    const phase = THREE.MathUtils.clamp(sky?.moonIntensity ?? 1, 0.4, 1);

    const w = THREE.MathUtils.smoothstep(y, -0.02, 0.06);
    _keyDir.copy(_moonDir).lerp(_sunDir, w).normalize();
    _keyColor.copy(_moonColor).lerp(_sunColor, w);
    const keyI = MOON_PEAK * phase * night * (1 - w) + this.sunIntensity * w;

    // A low sun reads through more atmosphere: visibly larger, softer disc.
    const angular =
      this._angularOverride ??
      THREE.MathUtils.lerp(0.08, 0.028, THREE.MathUtils.smoothstep(y, 0, 0.45));
    this.csm.angularRadius = w > 0.5 ? angular : 0.055;
    this.csm.setColor(_keyColor, keyI);

    if (sky?.skyColor?.isColor) _skyColor.copy(sky.skyColor);
    else _skyColor.setHex(0x7fa8d8, THREE.SRGBColorSpace).multiplyScalar(0.16 + 0.84 * day);

    if (sky?.horizonColor?.isColor) _horizonColor.copy(sky.horizonColor);
    else {
      _horizonColor
        .copy(_skyColor)
        .lerp(_sunColor, 0.32 * Math.min(1, this.sunIntensity * 0.5))
        .multiplyScalar(1.2);
    }

    // A physical night sky integrates to almost nothing, which crushes every
    // surface to pure black. Hold a moonlit floor under the sky ambient so
    // geometry keeps its form instead of becoming a silhouette soup.
    const glow = 0.1 * night;
    _skyColor.setRGB(
      Math.max(_skyColor.r, _moonColor.r * glow),
      Math.max(_skyColor.g, _moonColor.g * glow),
      Math.max(_skyColor.b, _moonColor.b * glow)
    );

    this.artificial = THREE.MathUtils.lerp(1, 0.42, THREE.MathUtils.smoothstep(y, 0.02, 0.32));
    this.exposureHint = 1 / Math.max(0.3, 0.22 + keyI * 0.26);
  }

  lateUpdate(dt, ctx) {
    this._updateKey();
    this.csm.update(ctx.camera, _keyDir);

    // Street fixtures burn out in daylight; interior ones only dim.
    const outdoorK = 1 - THREE.MathUtils.smoothstep(_sunDir.y, -0.01, 0.11);
    for (const h of this._levelHandles) {
      if (h.baseIntensity === undefined) continue;
      h.intensity = h.baseIntensity * (h.outdoor ? outdoorK : this.artificial);
    }

    this.dyn.update(dt, ctx.camera);
    this.indirect.setSkyState(
      _skyColor, _horizonColor, _sunColor, _sunDir, this.sunIntensity, this.artificial
    );
    this.indirect.ambientScale = this._ambientScale ?? (ctx.scene.environment ? 0.32 : 0.9);
    this.indirect.update(dt, ctx.camera);

    if (!this._hooked && window.__COD__) {
      this._hooked = true;
      window.__COD__.lighting = ctx.lighting;
      window.__COD__.flashbang = (i = 1) => this.flashbang(null, i);
    }
  }

  dispose() {
    this.csm.dispose();
    this.dyn.dispose();
    this.indirect.dispose();
  }
}
