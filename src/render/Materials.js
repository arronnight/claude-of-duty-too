import * as THREE from 'three';
import { MATERIAL_DEFS, MATERIAL_KEYS, KEY_ALIASES, QUALITY_TIERS } from './materials/MaterialDefs.js';
import { applySurfaceShader, inheritSurfaceShader } from './materials/SurfaceShader.js';

/**
 * The single source of truth for every surface in the game.
 *
 * Nothing else may construct a material: keeping them here is what lets one
 * compiled shader program serve thirty material keys, what keeps wetness,
 * time-of-day and quality tier consistent across the whole world, and what
 * guarantees the physical parameters actually match the surface being drawn.
 *
 * Maps come from `ctx.textures.pbr(key, opts)`. That system may not be ready
 * (or may fail) when a material is first requested, so every material is built
 * to look correct without maps — a procedural noise pass gives it structure —
 * and the library re-asks for its textures for the first few seconds of
 * runtime, hot-swapping them in when they arrive.
 */
const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'displacementMap'];
const RESERVED = new Set(['uvScale', 'triplanar']);
const RETRY_INTERVAL = 0.75;
const RETRY_LIMIT = 10;

export class MaterialLibrary {
  async init(ctx) {
    this.ctx = ctx;
    this.keys = MATERIAL_KEYS.slice();
    this.tier = QUALITY_TIERS[ctx.quality?.tier] ? ctx.quality.tier : 'high';
    this.wetness = 0;
    this.envScale = 1;
    this.envMap = null;

    this._base = new Map();
    this._variants = new Map();
    this._byKey = new Map();
    this._pending = new Set();
    this._retries = 0;
    this._nextRetry = 0;
    this._sceneEnv = null;

    // Shared by every material: one write updates the entire world.
    this._globals = {
      codWetness: { value: 0 },
      codTime: { value: 0 },
      codVertexAO: { value: 1 },
    };

    ctx.materials = this;
  }

  /**
   * Cached material for `key`. `overrides` are applied to a clone; anything
   * that only changes a uniform (colour, roughness, ...) reuses the compiled
   * program. `uvScale` and `triplanar` are structural and rebuild the shader.
   */
  get(key, overrides) {
    const alias = KEY_ALIASES[key];
    if (alias) return this.get(alias, { triplanar: true, ...overrides });

    const base = this._baseFor(key);
    if (!overrides) return base;
    const names = Object.keys(overrides);
    if (names.length === 0) return base;

    const id = key + '#' + stableKey(overrides, names);
    const cached = this._variants.get(id);
    if (cached) return cached;

    const uvScale = overrides.uvScale || 1;
    const structural = uvScale !== 1 || overrides.triplanar !== undefined;
    const variant = base.clone();
    variant.name = key;
    variant.userData.surfaceKey = key;
    variant.codKey = key;
    variant.codUvScale = uvScale;
    variant.codOverrides = overrides;
    if (structural) {
      variant.codUniforms = this._newUniforms();
      this._configure(variant, key, uvScale, overrides);
    } else {
      inheritSurfaceShader(variant, base);
    }
    applyProps(variant, overrides);
    variant.needsUpdate = true;

    this._variants.set(id, variant);
    this._track(key, variant);
    return variant;
  }

  /** 0 = bone dry, 1 = soaked with standing water in every low spot. */
  setWetness(v) {
    this.wetness = THREE.MathUtils.clamp(v, 0, 1);
    this._globals.codWetness.value = this.wetness;
  }

  /** Recompiles the surface shaders against a different technique budget. */
  setQuality(tier) {
    if (!QUALITY_TIERS[tier] || tier === this.tier) return;
    this.tier = tier;
    for (const [key, mat] of this._base) this._configure(mat, key, 1);
    for (const list of this._byKey.values()) {
      for (const mat of list) {
        const structural = mat.codUvScale !== 1 || mat.codOverrides?.triplanar !== undefined;
        if (structural) this._configure(mat, mat.codKey, mat.codUvScale, mat.codOverrides);
        else inheritSurfaceShader(mat, this._base.get(mat.codKey));
        applyProps(mat, mat.codOverrides);
        mat.needsUpdate = true;
      }
    }
  }

  /** Point every material at a new (PMREM filtered) environment map. */
  updateEnv(envMap) {
    this.envMap = envMap || null;
    this._forEach((mat) => {
      const def = MATERIAL_DEFS[mat.codKey] || MATERIAL_DEFS.concrete_wall;
      mat.envMapIntensity = (def.env ?? 1) * this.envScale;
      if (this.envMap && mat.envMap !== this.envMap) {
        const wasNull = mat.envMap === null;
        mat.envMap = this.envMap;
        if (wasNull) mat.needsUpdate = true;
      }
    });
  }

  update(dt, ctx) {
    this._globals.codTime.value = ctx.time;

    // The sky system owns the environment; mirror whatever it publishes so
    // reflections stay correct across a time-of-day change.
    const env = ctx.scene?.environment || ctx.sky?.envMap || ctx.textures?.envMap || null;
    if (env !== this._sceneEnv) {
      this._sceneEnv = env;
      // scene.environment already reaches every material; only adopt it
      // explicitly when the scene has none set.
      if (!ctx.scene?.environment && env) this.updateEnv(env);
      else this._refreshEnvIntensity();
    }

    if (this._pending.size && this._retries < RETRY_LIMIT && ctx.time >= this._nextRetry) {
      this._nextRetry = ctx.time + RETRY_INTERVAL;
      this._retries++;
      for (const key of Array.from(this._pending)) this._rebuildKey(key);
    }

    // main.js replaces window.__COD__ wholesale after init, so re-attach
    // opportunistically rather than once.
    const api = window.__COD__;
    if (api && !api.setWetness) {
      api.setWetness = (v) => this.setWetness(v);
      api.setMaterialQuality = (t) => this.setQuality(t);
    }
  }

  dispose() {
    this._forEach((m) => m.dispose());
    this._base.clear();
    this._variants.clear();
    this._byKey.clear();
  }

  // ---------------------------------------------------------------- internals

  _baseFor(key) {
    let mat = this._base.get(key);
    if (mat) return mat;
    const def = MATERIAL_DEFS[key] || MATERIAL_DEFS.concrete_wall;
    const props = def.props || {};
    const physical =
      def.transmissive ||
      'clearcoat' in props || 'sheen' in props || 'anisotropy' in props || 'specularIntensity' in props;
    mat = physical ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
    mat.name = key;
    mat.userData.surfaceKey = key;
    mat.codKey = key;
    mat.codUvScale = 1;
    mat.codUniforms = this._newUniforms();
    this._base.set(key, mat);
    this._track(key, mat);
    this._configure(mat, key, 1);
    return mat;
  }

  _newUniforms() {
    return {
      codWetness: this._globals.codWetness,
      codTime: this._globals.codTime,
      codVertexAO: this._globals.codVertexAO,
      codSurface: { value: new THREE.Vector4() },
      codSurface2: { value: new THREE.Vector4() },
      codRange: { value: new THREE.Vector4() },
      codTriScale: { value: 1 },
      codPomSteps: { value: 0 },
      codProc: { value: new THREE.Vector2(0.6, 0.5) },
      codHeightMap: { value: null },
      codTranslucency: { value: new THREE.Color(0, 0, 0) },
    };
  }

  /** (Re)applies physical parameters, maps and the surface shader in place. */
  _configure(mat, key, uvScale, overrides) {
    const def = MATERIAL_DEFS[key] || MATERIAL_DEFS.concrete_wall;
    const tier = QUALITY_TIERS[this.tier] || QUALITY_TIERS.high;
    const lowTier = this.tier === 'low';
    const forced = overrides?.triplanar;
    const triplanar = (forced === undefined ? !!def.tri : !!forced) && tier.triplanar;
    const wantPom = (def.pom || 0) > 0 && tier.pomMax > 0;

    // The texture factory knows the physical size of its own tiles; trust it
    // over the per-key guess so nothing ends up stretched.
    const worldSize = safeWorldSize(this.ctx?.textures, key);
    const perMetre = worldSize > 0 ? 1 / worldSize : def.tri || def.uv || 1;
    const repeat = triplanar ? 1 : perMetre * uvScale;
    const maps = this._maps(key, repeat, wantPom);

    // The factory packs occlusion/roughness/metalness into one texture; detect
    // it so the shader can do a single fetch.
    const orm = !!maps && !!maps.roughnessMap &&
      maps.roughnessMap === maps.metalnessMap && maps.roughnessMap === maps.aoMap;
    const has = {
      map: !!maps?.map && !def.noAlbedoMap,
      normal: !!maps?.normalMap,
      rough: orm || !!maps?.roughnessMap,
      metal: orm || !!maps?.metalnessMap,
      ao: orm || !!maps?.aoMap,
      height: !!maps?.displacementMap || (orm && wantPom),
    };
    const heightChannel = maps?.displacementMap ? 'r' : 'a';
    for (const slot of MAP_SLOTS) mat[slot] = null;
    if (maps) {
      mat.map = has.map ? maps.map : null;
      mat.normalMap = maps.normalMap || null;
      mat.roughnessMap = maps.roughnessMap || null;
      if (!orm) {
        mat.metalnessMap = maps.metalnessMap || null;
        mat.aoMap = maps.aoMap || null;
      }
    }

    mat.color.setHex(has.map ? (def.mapTint ?? 0xffffff) : def.color);
    mat.roughness = def.roughness;
    mat.metalness = has.metal ? (def.metalness ?? 0) : (def.metalnessNoMap ?? def.metalness ?? 0);
    mat.envMapIntensity = (def.env ?? 1) * this.envScale;
    mat.normalScale.set(def.normalScale ?? 1, def.normalScale ?? 1);
    mat.alphaTest = def.alphaTest || (maps?.alphaTest ? 0.5 : 0);
    mat.side = THREE.FrontSide;
    mat.transparent = false;
    mat.opacity = 1;
    mat.dithering = true;
    if (this.envMap) mat.envMap = this.envMap;
    if (def.props) applyProps(mat, def.props);

    // Transmission needs a full scene copy per frame; not worth it on low.
    if (def.transmissive && lowTier && mat.isMeshPhysicalMaterial) {
      mat.transmission = 0;
      mat.transparent = true;
      mat.opacity = 0.28;
    }

    const u = mat.codUniforms;
    const detail = def.detail || [0, 0];
    const macro = def.macro || [0, 0];
    const wet = def.wet || [0, 0];
    const projScale = triplanar ? perMetre : repeat;
    const pom = wantPom && has.height;
    const detailOn = tier.detail && has.normal;
    const procedural = !has.map && !has.normal && tier.procNormals;

    u.codSurface.value.set(detail[0] || 1, tier.detail ? detail[1] : 0, macro[0] || 0.05, tier.macro ? macro[1] : 0);
    u.codSurface2.value.set((def.pom || 0) * projScale, wet[0], wet[1], def.grime || 0);
    u.codRange.value.set(tier.detailFade[0], tier.detailFade[1], tier.pomFade[0], tier.pomFade[1]);
    u.codTriScale.value = perMetre;
    u.codPomSteps.value = tier.pomMax;
    u.codHeightMap.value = has.height ? (maps.displacementMap || maps.roughnessMap) : null;
    u.codProc.value.set(Math.max(macro[0] || 0.05, 0.05) * 6, 0.6);
    if (def.translucency) u.codTranslucency.value.setRGB(...def.translucency);

    applySurfaceShader(mat, {
      hasMap: has.map,
      hasNormal: has.normal,
      orm,
      hasRough: has.rough,
      hasMetal: has.metal,
      hasAO: has.ao,
      hasHeight: has.height,
      heightChannel,
      triplanar,
      detail: detailOn,
      pom,
      procedural,
      translucent: !!def.translucency,
      pomMax: pom ? tier.pomMax : 0,
      uvSource: uvSourceFor(mat),
    }, u);

    if (maps) this._pending.delete(key);
    else this._pending.add(key);
  }

  _maps(key, repeat, wantHeight) {
    const tex = this.ctx?.textures;
    if (!tex || typeof tex.pbr !== 'function') return null;
    let set = null;
    try {
      set = tex.pbr(key, { repeat: [repeat, repeat], displacement: wantHeight });
    } catch (e) {
      return null;
    }
    if (set && typeof set.then === 'function') {
      set.then(() => this._rebuildKey(key)).catch(() => {});
      return null;
    }
    if (!set) return null;

    // Never clone: these are render-target textures whose GPU handle lives on
    // the original object. The factory caches per repeat, so the set it hands
    // back is only ever used at the repeat it was asked for.
    const out = { alphaTest: !!set.alphaTest };
    let any = false;
    for (const slot of MAP_SLOTS) {
      const t = set[slot] || null;
      if (!t || !t.isTexture) { out[slot] = null; continue; }
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      if (t.repeat.x !== repeat || t.repeat.y !== repeat) t.repeat.set(repeat, repeat);
      out[slot] = t;
      any = true;
    }
    return any ? out : null;
  }

  _rebuildKey(key) {
    const base = this._base.get(key);
    if (!base) { this._pending.delete(key); return; }
    this._configure(base, key, 1);
    base.needsUpdate = true;
    const list = this._byKey.get(key);
    if (!list) return;
    for (const mat of list) {
      if (mat === base) continue;
      if (mat.codUvScale !== 1 || mat.codOverrides?.triplanar !== undefined) {
        this._configure(mat, key, mat.codUvScale, mat.codOverrides);
      } else {
        for (const slot of MAP_SLOTS) mat[slot] = base[slot];
        mat.color.copy(base.color);
        mat.metalness = base.metalness;
        inheritSurfaceShader(mat, base);
      }
      applyProps(mat, mat.codOverrides);
      mat.needsUpdate = true;
    }
  }

  _refreshEnvIntensity() {
    this._forEach((mat) => {
      const def = MATERIAL_DEFS[mat.codKey] || MATERIAL_DEFS.concrete_wall;
      mat.envMapIntensity = (def.env ?? 1) * this.envScale;
    });
  }

  _track(key, mat) {
    let list = this._byKey.get(key);
    if (!list) { list = []; this._byKey.set(key, list); }
    list.push(mat);
  }

  _forEach(fn) {
    for (const list of this._byKey.values()) for (const mat of list) fn(mat);
  }
}

/** Which of three's per-map UV varyings the surface pass should read. */
function uvSourceFor(mat) {
  if (mat.map) return 'map';
  if (mat.normalMap) return 'normalMap';
  if (mat.roughnessMap) return 'roughnessMap';
  return 'none';
}

/** Assigns plain values, hex colours and vectors onto an existing material. */
function applyProps(mat, props) {
  if (!props) return;
  for (const k in props) {
    if (RESERVED.has(k)) continue;
    const v = props[k];
    const cur = mat[k];
    if (cur && cur.isColor) cur.set(v);
    else if (cur && cur.isVector2) typeof v === 'number' ? cur.set(v, v) : cur.copy(v);
    else mat[k] = v;
  }
}

function stableKey(overrides, names) {
  let s = '';
  for (const k of names.slice().sort()) s += k + ':' + serialiseOverride(overrides[k], 0) + ';';
  return s;
}

/**
 * Identity of one override value for the variant cache.
 *
 * `String(texture)` is '[object Object]' for every texture in existence, so the
 * old version collapsed two variants that differed only in which atlas or
 * lightmap they were handed — the second caller silently got the first's
 * material. Textures are identified by uuid, colours by hex (two Color objects
 * holding the same colour must share a variant), vectors by components, and
 * anything else object-shaped is walked one level rather than stringified.
 */
function serialiseOverride(v, depth) {
  if (v === null || v === undefined || typeof v !== 'object') return String(v);
  if (v.isTexture) return 'tex@' + v.uuid;
  if (v.isColor) return '#' + v.getHexString();
  if (typeof v.toArray === 'function') return v.toArray().join(',');
  if (depth >= 2) return v.uuid || '[object]';
  if (Array.isArray(v)) return '[' + v.map((e) => serialiseOverride(e, depth + 1)).join(',') + ']';
  let s = '{';
  for (const k of Object.keys(v).sort()) s += k + ':' + serialiseOverride(v[k], depth + 1) + ',';
  return s + '}';
}

/** `ctx.textures.worldSize(key)` is optional; treat anything odd as unknown. */
function safeWorldSize(textures, key) {
  if (!textures || typeof textures.worldSize !== 'function') return 0;
  try {
    const v = textures.worldSize(key);
    return Number.isFinite(v) && v > 0.01 ? v : 0;
  } catch (e) {
    return 0;
  }
}

export { MATERIAL_KEYS, MATERIAL_DEFS };
