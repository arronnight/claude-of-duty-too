import * as THREE from 'three';
import { GENERATORS, MATERIAL_KEYS, fragmentShader, vertexShader } from './generators/index.js';
import { FXNOISE_FRAGMENT, FXNOISE_KINDS } from './shaders/fxnoise.glsl.js';
import { NOISE_GLSL } from './shaders/noise.glsl.js';
import { SURFACE_GLSL } from './shaders/surface.glsl.js';

/**
 * GPU-procedural PBR texture factory.
 *
 * Every material is one fullscreen-quad pass into a 3-attachment MRT: albedo
 * (sRGB, alpha = cutout), ORM (AO/roughness/metalness, alpha = height) and a
 * tangent-space normal derived from extra float-precision evaluations of the
 * generator at sub-texel offsets. Packing AO+roughness+metalness into one map
 * saves two texture units per material versus three greyscale maps.
 *
 * Generation is lazy, cached by name+options, and time-sliced: the first burst
 * is capped so boot never stalls, and anything left over is drained a few
 * milliseconds per frame. Nothing here ever throws — an unknown key returns a
 * neutral fallback set so a half-written sibling system cannot take the app down.
 */

const HERO_KEYS = new Set([
  'concrete_wall', 'concrete_floor', 'brick', 'plaster', 'asphalt', 'asphalt_worn',
  'metal_rusted', 'wood_plank', 'gravel', 'rubble',
]);

const BOOT_BUDGET_MS = 340;
const FRAME_BUDGET_MS = 9;

/**
 * Materials whose metalness is identically zero. three.js allocates one texture
 * unit per sampler uniform even when two samplers point at the same texture, so
 * a caller under MAX_TEXTURE_IMAGE_UNITS pressure can pass `compact: true` and
 * drop the redundant metalness sampler on these without changing the result.
 */
const DIELECTRIC = new Set([
  'concrete_wall', 'concrete_floor', 'brick', 'plaster', 'stucco', 'tile_roof',
  'asphalt', 'asphalt_worn', 'tarmac_line', 'dirt', 'gravel', 'sand',
  'wood_painted', 'gun_wood', 'bark', 'glass', 'glass_broken', 'fabric_canvas',
  'sandbag', 'rubber', 'gun_polymer', 'foliage',
]);

export class TextureFactory {
  async init(ctx) {
    this.ctx = ctx;
    this.cache = new Map();
    this.noiseCache = new Map();
    this.keys = MATERIAL_KEYS;

    this._pending = [];
    this._budget = BOOT_BUDGET_MS;
    this._sheet = null;
    this._hooked = false;
    this._warned = new Set();

    const q = ctx.quality || {};
    this._baseSize = Math.max(64, Math.min(q.textureSize || 1024, 1024));
    this._heroSize = Math.max(this._baseSize, Math.min(q.textureSize || 1024, 2048));
    this._anisotropy = q.anisotropy || 8;

    this._quadGeo = new THREE.PlaneGeometry(2, 2);
    this._quadScene = new THREE.Scene();
    this._quadCam = new THREE.Camera();
    this._quadMesh = new THREE.Mesh(this._quadGeo, new THREE.MeshBasicMaterial());
    this._quadMesh.frustumCulled = false;
    this._quadScene.add(this._quadMesh);

    ctx.textures = this;
    this._attachHooks();
  }

  /**
   * The sky system may either publish `ctx.sky.envMap` or push straight into
   * `ctx.textures.envMap`; accept both so neither ordering throws.
   */
  get envMap() {
    return this._envMap ?? this.ctx?.sky?.envMap ?? this.ctx?.scene?.environment ?? null;
  }

  set envMap(v) {
    this._envMap = v || null;
  }

  /** Metres covered by one tile of a given material — lets callers pick a sane repeat. */
  worldSize(name) {
    return GENERATORS[name]?.world ?? 2.0;
  }

  /**
   * @param {string} name one of the contract's material keys
   * @param {{size?:number, repeat?:number[], anisotropy?:number, seed?:number,
   *          age?:number, tint?:number[], roughness?:number, displacement?:boolean,
   *          compact?:boolean}} [opts]
   */
  pbr(name, opts = {}) {
    const gen = GENERATORS[name];
    if (!gen) {
      if (!this._warned.has(name)) {
        this._warned.add(name);
        console.warn(`[textures] unknown material key "${name}" — using fallback`);
      }
      return this._fallback();
    }

    const size = pot(opts.size ?? (HERO_KEYS.has(name) ? this._heroSize : this._baseSize));
    const seed = opts.seed ?? 0;
    const aniso = opts.anisotropy ?? this._anisotropy;
    const rep = opts.repeat || [1, 1];
    const age = opts.age ?? 1;
    const tint = opts.tint || [1, 1, 1];
    const roughBias = opts.roughness ?? 0;
    const disp = !!opts.displacement;
    const compact = !!opts.compact;

    const key = `${name}|${size}|${seed}|${aniso}|${rep[0]},${rep[1]}|${age}|${tint.join(',')}|${roughBias}|${disp ? 1 : 0}|${compact ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const bundle = this._build(name, { size, seed, aniso, rep, age, tint, roughBias, disp, compact });
    this.cache.set(key, bundle);
    return bundle;
  }

  /**
   * Utility lookup textures for postfx/fx: `blue` (4 dither channels), `curl`
   * (RG = divergence-free flow, B = density), `worley` (4 tiled octaves),
   * `smoke` (3D-sliced perlin-worley) and `grain`.
   */
  noiseTexture(kind = 'blue', size = 256) {
    const k = FXNOISE_KINDS[kind] ?? FXNOISE_KINDS.blue;
    const s = pot(size);
    const cacheKey = `${kind}|${s}`;
    const hit = this.noiseCache.get(cacheKey);
    if (hit) return hit;

    const mip = k === FXNOISE_KINDS.blue || k === FXNOISE_KINDS.grain ? false : true;
    const rt = new THREE.WebGLRenderTarget(s, s, {
      count: 1,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: mip,
      minFilter: mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
    });
    const tex = rt.textures[0];
    tex.name = `noise:${kind}`;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = mip;
    tex.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;

    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines: { KIND: k },
      uniforms: { uSize: { value: s }, uSeed: { value: 0.371 } },
      vertexShader: vertexShader(),
      fragmentShader: `precision highp float;\n${NOISE_GLSL}\n${SURFACE_GLSL}\n${FXNOISE_FRAGMENT}`,
      depthTest: false,
      depthWrite: false,
    });

    this._pending.push({ rt, material, size: s, label: `noise:${kind}` });
    this._pump();
    this.noiseCache.set(cacheKey, tex);
    return tex;
  }

  /** Generate a set of materials ahead of time, still time-sliced across frames. */
  prewarm(keys) {
    const list = Array.isArray(keys) && keys.length ? keys : MATERIAL_KEYS;
    for (const k of list) this.pbr(k);
    return list.length;
  }

  /**
   * Contact sheet of every material for visual review. Returns a detached DOM
   * overlay; mounting is the caller's job (see `window.__COD__.showTextureSheet`).
   */
  debugGrid(size = 256) {
    if (this._sheet) return this._sheet;
    const renderer = this.ctx?.renderer;
    if (!renderer) return null;

    const root = document.createElement('div');
    root.id = 'texture-sheet';
    root.setAttribute(
      'style',
      'position:fixed;inset:0;z-index:99999;overflow:auto;background:#101012;' +
        'font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d8d8dc;padding:14px;'
    );
    const grid = document.createElement('div');
    grid.setAttribute(
      'style',
      'display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;align-items:start;'
    );
    root.appendChild(grid);

    const s = pot(size);
    const buf = new Uint8Array(s * s * 4);
    for (const name of MATERIAL_KEYS) {
      const bundle = this.pbr(name, { size: s, anisotropy: 1 });
      const job = bundle.__job;
      if (job) this._runJob(job);
      const rt = bundle.__rt;

      const cell = document.createElement('div');
      cell.setAttribute('style', 'background:#18181c;border:1px solid #2a2a30;border-radius:6px;padding:8px;');
      const title = document.createElement('div');
      title.textContent = `${name}   ·   ${this.worldSize(name)} m tile`;
      title.setAttribute('style', 'margin-bottom:6px;color:#9ad;letter-spacing:.02em;');
      cell.appendChild(title);

      const row = document.createElement('div');
      row.setAttribute('style', 'display:flex;gap:6px;');
      const labels = ['albedo', 'ORM', 'normal'];
      for (let i = 0; i < 3; i++) {
        const wrap = document.createElement('div');
        const cv = document.createElement('canvas');
        cv.width = cv.height = s;
        cv.setAttribute('style', 'width:100px;height:100px;image-rendering:auto;border-radius:3px;display:block;');
        const g = cv.getContext('2d');
        try {
          renderer.readRenderTargetPixels(rt, 0, 0, s, s, buf, undefined, i);
          const img = g.createImageData(s, s);
          for (let y = 0; y < s; y++) {
            const src = (s - 1 - y) * s * 4;
            img.data.set(buf.subarray(src, src + s * 4), y * s * 4);
          }
          if (i !== 0) for (let p = 3; p < img.data.length; p += 4) img.data[p] = 255;
          g.putImageData(img, 0, 0);
        } catch (e) {
          g.fillStyle = '#500';
          g.fillRect(0, 0, s, s);
        }
        const cap = document.createElement('div');
        cap.textContent = labels[i];
        cap.setAttribute('style', 'text-align:center;color:#666;font-size:10px;margin-top:2px;');
        wrap.appendChild(cv);
        wrap.appendChild(cap);
        row.appendChild(wrap);
      }
      cell.appendChild(row);
      grid.appendChild(cell);
    }

    this._sheet = root;
    return root;
  }

  update() {
    this._budget = FRAME_BUDGET_MS;
    if (this._pending.length) this._pump();
    if (!this._hooked) this._attachHooks();
  }

  dispose() {
    for (const b of this.cache.values()) b.__rt?.dispose();
    for (const t of this.noiseCache.values()) t.renderTarget?.dispose?.();
    this.cache.clear();
    this.noiseCache.clear();
    this._quadGeo.dispose();
    this._sheet?.remove();
  }

  // --- internals ------------------------------------------------------------

  _build(name, o) {
    const count = o.disp ? 4 : 3;
    const rt = new THREE.WebGLRenderTarget(o.size, o.size, {
      count,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      anisotropy: o.aniso,
    });

    const names = ['albedo', 'orm', 'normal', 'height'];
    for (let i = 0; i < count; i++) {
      const t = rt.textures[i];
      t.name = `${name}:${names[i]}`;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(o.rep[0], o.rep[1]);
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = o.aniso;
      t.colorSpace = i === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.needsUpdate = true;
    }

    const gen = GENERATORS[name];
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uSeed: { value: o.seed * 0.6180339887 + 0.137 },
        uSize: { value: o.size },
        uBump: { value: gen.bump ?? 1.0 },
        uCavity: { value: gen.cavity ?? 0.0 },
        uAge: { value: o.age },
        uRoughBias: { value: o.roughBias },
        uTint: { value: new THREE.Vector3(o.tint[0], o.tint[1], o.tint[2]) },
      },
      vertexShader: vertexShader(),
      fragmentShader: fragmentShader(name, { height: o.disp }),
      depthTest: false,
      depthWrite: false,
    });

    const job = { rt, material, size: o.size, label: name };
    const bundle = {
      map: rt.textures[0],
      normalMap: rt.textures[2],
      roughnessMap: rt.textures[1],
      metalnessMap: o.compact && DIELECTRIC.has(name) ? null : rt.textures[1],
      aoMap: rt.textures[1],
      displacementMap: o.disp ? rt.textures[3] : null,
      // height also lives in ORM.a for anyone doing parallax without a 4th map
      ormMap: rt.textures[1],
      worldSize: gen.world ?? 2.0,
      alphaTest: !!gen.alphaTest,
      __rt: rt,
      __job: job,
    };
    job.bundle = bundle;

    this._pending.push(job);
    this._pump();
    return bundle;
  }

  _pump() {
    const renderer = this.ctx?.renderer;
    if (!renderer) return;
    while (this._pending.length && this._budget > 0) {
      const t0 = performance.now();
      this._runJob(this._pending.shift());
      this._budget -= performance.now() - t0;
    }
  }

  _runJob(job) {
    if (job.done) return;
    const renderer = this.ctx?.renderer;
    if (!renderer) return;
    const queued = this._pending.indexOf(job);
    if (queued >= 0) this._pending.splice(queued, 1);

    const maxA = renderer.capabilities?.getMaxAnisotropy?.() ?? 16;
    for (const t of job.rt.textures) t.anisotropy = Math.min(t.anisotropy, maxA);

    const info = renderer.info.render;
    const calls = info.calls;
    const tris = info.triangles;
    const prev = renderer.getRenderTarget();
    const prevMesh = this._quadMesh.material;

    try {
      this._quadMesh.material = job.material;
      renderer.setRenderTarget(job.rt);
      renderer.render(this._quadScene, this._quadCam);
    } catch (e) {
      console.warn(`[textures] generation failed for ${job.label}:`, e);
    } finally {
      renderer.setRenderTarget(prev);
      this._quadMesh.material = prevMesh;
      info.calls = calls;
      info.triangles = tris;
    }

    // The generation program is single-use; release it so it never counts
    // against the 60-program budget.
    job.material.dispose();
    job.material = null;
    job.done = true;
    if (job.bundle) job.bundle.__job = null;
  }

  _fallback() {
    if (this._fb) return this._fb;
    const flat = new THREE.DataTexture(new Uint8Array([158, 152, 145, 255]), 1, 1);
    flat.colorSpace = THREE.SRGBColorSpace;
    flat.needsUpdate = true;
    const orm = new THREE.DataTexture(new Uint8Array([255, 220, 0, 128]), 1, 1);
    orm.needsUpdate = true;
    const nrm = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    nrm.needsUpdate = true;
    for (const t of [flat, orm, nrm]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    this._fb = {
      map: flat, normalMap: nrm, roughnessMap: orm, metalnessMap: orm, aoMap: orm,
      displacementMap: null, ormMap: orm, worldSize: 2.0, alphaTest: false,
    };
    return this._fb;
  }

  /**
   * main.js replaces window.__COD__ wholesale after init, so the hook is
   * attached opportunistically instead of once.
   */
  _attachHooks() {
    const api = (window.__COD__ = window.__COD__ || {});
    if (api.showTextureSheet) return;
    api.showTextureSheet = (v = true) => {
      if (v) {
        const el = this.debugGrid();
        if (el && !el.isConnected) document.body.appendChild(el);
        return !!el;
      }
      this._sheet?.remove();
      return false;
    };
    api.textureKeys = () => MATERIAL_KEYS.slice();
    if (window.__COD__.engine) this._hooked = true;
  }
}

function pot(n) {
  const v = Math.max(32, Math.min(4096, Math.round(n)));
  return 1 << Math.round(Math.log2(v));
}
