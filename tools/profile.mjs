#!/usr/bin/env node
/**
 * Frame-budget profiler. Answers "where does the frame actually go", which the
 * screenshot harness cannot: `shoot.mjs` reports fps/draws/tris per preset, but
 * a draw-call count says nothing about whether the frame is fill bound.
 *
 *   node tools/profile.mjs --phase res     --presets ads,combat
 *   node tools/profile.mjs --phase post    --presets ads
 *   node tools/profile.mjs --phase shadow  --presets ads,combat
 *   node tools/profile.mjs --phase subtree --presets ads,combat
 *   node tools/profile.mjs --phase programs
 *
 * Phases are separate invocations on purpose. Two of the tests (forcing
 * `shadowMap.enabled = false`, which requires recompiling every material) are
 * destructive to the program cache, so anything that reads `renderer.info.programs`
 * has to run in a process that never touched them.
 *
 * MEASUREMENT RULES ENCODED HERE, because previous perf passes on this project
 * reported noise as signal:
 *
 *  - fps is never read from `engine.stats.fps` (a single 0.5 s bucket whose phase
 *    we do not control). It is computed from `engine.frame` deltas over N wall-clock
 *    buckets, and the MEDIAN of the kept buckets is the number.
 *  - The first `--drop` buckets after every state change are discarded. TAA history,
 *    GTAO/volumetric history and the auto-exposure adaptation all need to reconverge,
 *    and `PostFX.timer` (GpuTimer) is a 0.9/0.1 EMA that needs ~30 frames.
 *  - A FRESH BASELINE IS MEASURED IMMEDIATELY BEFORE EVERY TEST, not once at the
 *    start. Each result therefore carries its own paired baseline, and the report
 *    carries the spread of those baselines. If baseline drift is larger than an
 *    effect, that effect is not real and the report says so.
 *  - `postfx.cost.gpuMs` is a real EXT_disjoint_timer_query_webgl2 result and is
 *    preferred over fps where it applies — but note it brackets only the POST chain
 *    (`timer.begin()` is called after the scene render in PostFX.lateUpdate), so it
 *    excludes the main scene pass and all shadow-map rendering.
 *  - fps in headless Chromium is rAF-driven and clamps at ~60. Any result at or near
 *    60 fps is a floor on the real number, not the real number. Flagged in output.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
// Distinct from shoot.mjs (5173) and probe.mjs so a profiling run can share a box
// with a screenshot run without either stealing the other's server.
const PORT = parseInt(arg('port', '5401'), 10);
const URL = `http://localhost:${PORT}/`;
const OUT = path.resolve(ROOT, arg('out', 'profile'));
const WARMUP_MS = parseInt(arg('warmup', '7000'), 10);
const SETTLE_MS = parseInt(arg('settle', '1300'), 10);
const BUCKETS = parseInt(arg('buckets', '6'), 10);
const BUCKET_MS = parseInt(arg('bucket', '500'), 10);
const DROP = parseInt(arg('drop', '2'), 10);
const PHASE = arg('phase', 'res');
const PRESETS = arg('presets', 'ads,combat').split(',').filter(Boolean);

/**
 * Camera presets, copied from tools/shoot.mjs rather than imported: shoot.mjs
 * calls main() at module scope, so importing it launches a full screenshot run.
 * Keep in sync by hand; only pos/look/fov/tod/viewmodel/ads/action matter here.
 */
const SHOTS = {
  establishing: { pos: [4, 17, 33], look: [-1, 1.5, -20], fov: 60, tod: 0.32 },
  street: { pos: [2.2, 1.68, 22], look: [1, 1.5, -10], fov: 70, tod: 0.32 },
  interior: { pos: [-11, 1.7, -6], look: [4, 1.4, -3], fov: 70, tod: 0.32 },
  weapon: { pos: [2.2, 1.68, 14], look: [2.2, 1.6, 0], fov: 70, tod: 0.32, viewmodel: true },
  ads: { pos: [2.2, 1.68, 14], look: [2.2, 1.6, 0], fov: 45, tod: 0.32, viewmodel: true, ads: true },
  materials: { pos: [-4, 1.5, -18], look: [-4, 1.4, -26], fov: 60, tod: 0.32 },
  goldenhour: { pos: [4.5, 1.75, 18], look: [-2, 2.2, -16], fov: 65, tod: 0.76 },
  night: { pos: [2.2, 1.68, 22], look: [1, 1.5, -10], fov: 70, tod: 0.85 },
  skyline: { pos: [8, 2.0, 30], look: [-6, 14, -30], fov: 65, tod: 0.32 },
  combat: { pos: [6, 1.7, 6], look: [-8, 1.6, -12], fov: 70, tod: 0.32, viewmodel: true, action: true },
};

const POST_PASSES = [
  'taa', 'gtao', 'volumetrics', 'ssr', 'motionBlur', 'dof', 'viewmodel', 'bloom',
  'exposure', 'dirt', 'chromatic', 'vignette', 'grain', 'lut', 'cas', 'fxaa',
];

async function waitForServer(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// --------------------------------------------------------------- page harness

/** Installed once into the page; every mutation the profiler makes goes through it. */
function installProbe() {
  const api = window.__COD__;
  const P = (window.__PROF__ = { saved: {} });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  const med = (a) => {
    const s = [...a].sort((x, y) => x - y);
    if (!s.length) return NaN;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const fx = () => api.engine.get('postfx');
  const csm = () => api.engine.get('lighting')?.csm;
  const bufSize = () => {
    const gl = api.ctx.renderer.getContext();
    return [gl.drawingBufferWidth, gl.drawingBufferHeight];
  };

  /**
   * fps from engine.frame deltas rather than engine.stats.fps: stats.fps is
   * republished on the engine's own 0.5 s boundary, so sampling it on our
   * boundary re-reads stale buckets and manufactures fake stability.
   */
  P.sample = async ({ buckets = 6, bucketMs = 500, drop = 2 } = {}) => {
    const eng = api.engine;
    const fps = [];
    const gpu = [];
    const cpu = [];
    const draws = [];
    const marks = [];
    for (let i = 0; i < buckets; i++) {
      const f0 = eng.frame;
      const t0 = performance.now();
      marks.push([f0, t0]);
      await sleep(bucketMs);
      const dt = performance.now() - t0;
      fps.push(((eng.frame - f0) * 1000) / dt);
      const c = api.postfx?.cost;
      gpu.push(c && c.gpuMs > 0 ? c.gpuMs : NaN);
      cpu.push(c ? c.cpuMs : NaN);
      draws.push(api.stats.drawCalls);
    }
    const endF = eng.frame;
    const endT = performance.now();
    const keep = (a) => a.slice(drop);
    const kf = keep(fps);
    const kg = keep(gpu).filter(Number.isFinite);
    const kc = keep(cpu).filter(Number.isFinite);
    const st = api.stats;
    const [bw, bh] = bufSize();
    // A single 500 ms bucket at ~36 fps counts ~18 frames, so one frame of
    // scheduling slop is 2 fps — enough to swallow a whole post pass. The primary
    // number is therefore the frame count across the ENTIRE kept window; the
    // per-bucket medians are kept only as a stationarity check.
    const [wf, wt] = marks[Math.min(drop, marks.length - 1)];
    const winFps = ((endF - wf) * 1000) / (endT - wt);
    const winMs = (endT - wt) / 1000;
    return {
      fps: r2(winFps),
      fpsWindowSec: r2(winMs),
      // Resolution of this reading: +/-1 frame over the window.
      fpsQuantum: r2(1 / winMs),
      fpsBucketMedian: r2(med(kf)),
      fpsAll: fps.map(r2),
      fpsSpread: r2(Math.max(...kf) - Math.min(...kf)),
      frameMs: r2(1000 / winFps),
      postGpuMs: kg.length ? r3(med(kg)) : null,
      postCpuMs: kc.length ? r3(med(kc)) : null,
      drawCalls: st.drawCalls,
      drawCallsSpread: Math.max(...keep(draws)) - Math.min(...keep(draws)),
      triangles: st.triangles,
      programs: st.programs,
      buffer: `${bw}x${bh}`,
    };
  };

  /** Force every material in both scenes to relink. Forks the program cache —
   *  any phase that uses this must not also be reading renderer.info.programs. */
  P.recompile = () => {
    let n = 0;
    for (const sc of [api.ctx.scene, api.ctx.viewScene]) {
      sc?.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) { mm.needsUpdate = true; n++; }
      });
    }
    return { recompiled: n };
  };

  P.ops = {
    preset: ({ shot }) => {
      api.setTimeOfDay?.(shot.tod);
      api.setViewmodelVisible?.(!!shot.viewmodel);
      api.setADS?.(!!shot.ads);
      if (shot.action) api.stageCombat?.();
      api.setCamera(shot.pos, shot.look, shot.fov);
      api.postfx?.reset?.();
      return true;
    },
    // Re-stage before each pair so decaying smoke/tracers do not drift the
    // combat baseline across a long phase.
    restage: ({ shot }) => (shot.action ? (api.stageCombat?.(), true) : false),

    /** Render scale via pixel ratio: the drawing buffer changes, framing does not. */
    scale: ({ s }) => {
      const r = api.ctx.renderer;
      r.setPixelRatio(s);
      r.setSize(window.innerWidth, window.innerHeight, false);
      api.postfx?.reset?.();
      const [w, h] = bufSize();
      return { scale: s, buffer: `${w}x${h}`, pixels: w * h };
    },
    postAll: ({ on }) => (api.postfx.setEnabled(on), true),
    pass: ({ name, on }) => api.postfx.set(name, on),

    /** Skips shadow-map RENDERING only; maps keep their last contents, so the
     *  fragment-side shadow lookups are still paid. Isolates the depth passes. */
    shadowRender: ({ on }) => {
      const sm = api.ctx.renderer.shadowMap;
      sm.autoUpdate = on;
      sm.needsUpdate = on;
      return true;
    },
    /** Removes shadows entirely, including the sampling cost — needs a full
     *  material recompile, which forks the program cache. Destructive; last. */
    shadowEnabled: ({ on }) => {
      api.ctx.renderer.shadowMap.enabled = on;
      return P.recompile();
    },
    shadowMapSize: ({ factor }) => {
      const c = csm();
      if (!c) return { found: false };
      if (!P.saved.mapSize) P.saved.mapSize = c.mapSize;
      const size = Math.max(256, Math.round(P.saved.mapSize * factor));
      c.mapSize = size;
      for (const l of c.lights) {
        l.shadow.mapSize.set(size, size);
        l.shadow.map?.dispose();
        l.shadow.map = null;
        l.shadow.mapPass?.dispose();
        l.shadow.mapPass = null;
        l.shadow.needsUpdate = true;
      }
      return { found: true, size, cascades: c.lights.length, from: P.saved.mapSize };
    },
    /** Per-cascade skip without a recompile: LightShadow.autoUpdate is honoured
     *  by WebGLShadowMap, so the cascade keeps its uniforms and its sampling. */
    cascadeRender: ({ keep }) => {
      const c = csm();
      if (!c) return { found: false };
      c.lights.forEach((l, i) => {
        l.shadow.autoUpdate = i < keep;
        if (i >= keep) l.shadow.needsUpdate = false;
      });
      return { found: true, cascades: c.lights.length, rendering: keep };
    },
    /**
     * Parallax occlusion marching, killed by uniform rather than by recompile:
     * SurfaceShader's loop is `for (i < COD_POM_MAX) { if (i >= steps) break; }`
     * with `steps` derived from the `codPomSteps` uniform, so zeroing it takes
     * the single-fetch early-out and costs no shader variant.
     */
    pomSteps: ({ value }) => {
      let n = 0;
      const seen = new Set();
      api.ctx.scene.traverse((o) => {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m || seen.has(m.uuid)) continue;
          seen.add(m.uuid);
          const u = m.codUniforms?.codPomSteps;
          if (!u) continue;
          if (P.saved.pom?.[m.uuid] === undefined) (P.saved.pom ||= {})[m.uuid] = u.value;
          u.value = value === null ? P.saved.pom[m.uuid] : value;
          n++;
        }
      });
      return { materials: n, value };
    },

    /** True cascade-count reduction: removes the shadow map AND its per-fragment
     *  PCSS taps. Costs a full recompile, so it forks the program cache. */
    cascadeCount: ({ keep }) => {
      const c = csm();
      if (!c) return { found: false };
      c.lights.forEach((l, i) => { l.castShadow = i < keep; });
      return { ...P.recompile(), keep, of: c.lights.length };
    },

    /** Environment/PMREM sampling: every material is envMap'd. Recompiles. */
    envMap: ({ on }) => {
      const scene = api.ctx.scene;
      if (P.saved.env === undefined) P.saved.env = scene.environment;
      scene.environment = on ? P.saved.env : null;
      const seen = new Set();
      P.saved.envMaps ||= {};
      scene.traverse((o) => {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m || seen.has(m.uuid)) continue;
          seen.add(m.uuid);
          if (P.saved.envMaps[m.uuid] === undefined) P.saved.envMaps[m.uuid] = m.envMap || null;
          m.envMap = on ? P.saved.envMaps[m.uuid] : null;
        }
      });
      return P.recompile();
    },

    /** Bare forward pass: no post, no shadows. What is left is the cost of the
     *  scene's own material shaders plus geometry submission. */
    bare: ({ on }) => {
      api.postfx.setEnabled(!on);
      api.ctx.renderer.shadowMap.enabled = !on;
      return P.recompile();
    },

    subtree: ({ name, visible }) => {
      const o = name === 'viewmodel' ? api.ctx.viewScene : api.ctx.scene.getObjectByName(name);
      if (!o) return { found: false, name };
      o.visible = visible;
      return { found: true, name };
    },

    /** What is actually executing, read off the live PostFX instance. */
    probe: () => {
      const f = fx();
      const ctx = api.ctx;
      const vs = ctx.viewScene;
      const ads = !!(ctx.player?.isADS || ctx.weapons?.isADS);
      const p = f.passes;
      const [bw, bh] = bufSize();
      return {
        tier: ctx.quality.tier,
        renderer: ctx.quality.renderer,
        maxDpr: ctx.quality.maxDpr,
        buffer: `${bw}x${bh}`,
        quality: {
          shadowMapSize: ctx.quality.shadowMapSize,
          cascades: ctx.quality.cascades,
          ssao: ctx.quality.ssao, ssr: ctx.quality.ssr,
          volumetrics: ctx.quality.volumetrics, taa: ctx.quality.taa,
        },
        gpuTimer: !!f.timer?.ext,
        cameraStill: !!f._cameraStill,
        ads,
        cinematic: !!f.cinematic,
        viewChildren: vs?.children?.length ?? 0,
        viewVisible: vs?.visible !== false,
        volSkipped: !!f._warned?.has?.('vol'),
        csm: (() => {
          const c = csm();
          return c ? { cascades: c.lights.length, mapSize: c.mapSize, shadowDistance: c.shadowDistance } : null;
        })(),
        shadowCasters: (() => {
          let n = 0;
          ctx.scene.traverse((o) => { if (o.isLight && o.castShadow) n++; });
          return n;
        })(),
        flags: p,
        executing: {
          taa: !!p.taa,
          gtao: !!(p.gtao && f.gtao),
          volumetrics: !!(p.volumetrics && f.volumetrics),
          ssr: !!(p.ssr && f.ssr),
          motionBlur: !!(p.motionBlur && f.motion && !f._cameraStill),
          dof: !!(p.dof && (ads || f.cinematic)),
          viewmodel: !!(p.viewmodel && vs && vs.visible !== false && vs.children.length > 0),
          bloom: !!p.bloom,
          exposure: !!p.exposure,
          // These five are uniform-gated inside the single GradePass shader, not
          // separate passes. dirt additionally requires bloom.
          dirt: !!(p.dirt && p.bloom),
          chromatic: !!p.chromatic,
          vignette: !!p.vignette,
          grain: !!p.grain,
          lut: !!p.lut,
          cas: !!p.cas,
          fxaa: !!p.fxaa,
        },
        postDrawCalls: api.postfx.cost.drawCalls,
      };
    },

    /** Scene inventory: what is under each named root and what it costs to draw. */
    sceneTree: () => {
      const walk = (root) => {
        let meshes = 0, instanced = 0, instances = 0, tris = 0, skinned = 0, visibleMeshes = 0;
        const mats = new Set();
        root.traverse((o) => {
          if (o.isInstancedMesh) { instanced++; instances += o.count; }
          if (o.isSkinnedMesh) skinned++;
          if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
            meshes++;
            if (o.visible) visibleMeshes++;
            const g = o.geometry;
            if (g) {
              const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
              tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
            }
            for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) mats.add(m.uuid);
          }
        });
        return { meshes, visibleMeshes, instanced, instances, skinned, materials: mats.size, tris: Math.round(tris) };
      };
      // Two levels deep, because the architecture has props/vegetation add their
      // roots *under* ctx.level.root — 'Props' is a child of 'Level', not of the
      // scene, and a one-level census makes it look like it does not exist.
      const node = (c, depth) => {
        const r = { name: c.name || `(${c.type})`, type: c.type, visible: c.visible, ...walk(c) };
        if (depth > 0 && c.children?.length) {
          const kids = c.children.filter((k) => k.name && (k.isGroup || k.children.length));
          if (kids.length) r.children = kids.map((k) => node(k, depth - 1));
        }
        return r;
      };
      return {
        children: api.ctx.scene.children.map((c) => node(c, 2)),
        viewScene: walk(api.ctx.viewScene),
      };
    },

    /**
     * Program census. `renderer.info.programs` gives cacheKey/usedTimes but not
     * an owner, so materials are walked back to their compiled program through
     * renderer.properties. Post-pass ShaderMaterials are found by recursing the
     * live system objects, which is how the fullscreen quads get attributed
     * without this file knowing any pass's internals.
     */
    programs: () => {
      const r = api.ctx.renderer;
      const progs = r.info.programs || [];
      const byId = new Map();
      for (const p of progs) {
        byId.set(p.id, {
          id: p.id, name: p.name, usedTimes: p.usedTimes,
          cacheKeyLen: (p.cacheKey || '').length, owners: [],
        });
      }
      const unattached = [];
      const seenMat = new Set();
      const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
      const visit = (mat, owner) => {
        if (!mat || seenMat.has(mat.uuid)) return;
        seenMat.add(mat.uuid);
        const prog = r.properties.get(mat)?.currentProgram;
        const rec = prog && byId.get(prog.id);
        const info = {
          owner,
          type: mat.type,
          name: mat.name || null,
          defines: mat.defines ? Object.keys(mat.defines) : [],
          // Material.prototype defines a no-op onBeforeCompile, so identity on the
          // prototype is always truthy; only an own property is a real hook.
          onBeforeCompile: own(mat, 'onBeforeCompile'),
          customCacheKey: own(mat, 'customProgramCacheKey')
            ? String(mat.customProgramCacheKey()).slice(0, 80) : null,
          maps: ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap',
            'emissiveMap', 'displacementMap', 'lightMap', 'envMap'].filter((k) => mat[k]),
          flags: ['transparent', 'vertexColors', 'flatShading', 'fog', 'side', 'alphaTest',
            'dithering', 'toneMapped'].map((k) => `${k}=${mat[k]}`).join(' '),
        };
        if (rec) rec.owners.push(info);
        else unattached.push({ ...info, note: 'no compiled program (never rendered?)' });
      };
      for (const [label, sc] of [['scene', api.ctx.scene], ['viewScene', api.ctx.viewScene]]) {
        sc?.traverse((o) => {
          const m = o.material;
          if (!m) return;
          for (const mm of Array.isArray(m) ? m : [m]) visit(mm, `${label}:${pathOf(o)}`);
        });
      }
      // Post/lighting/sky pass materials: recurse the live system objects so the
      // fullscreen-quad ShaderMaterials get attributed without this file needing
      // to know any pass's internals. Bounded, and blind to the keys that lead
      // back into the scene graph or the renderer.
      const SKIP = new Set(['ctx', 'engine', 'renderer', 'scene', 'parent', 'children',
        'gl', 'canvas', 'camera', 'bus', 'input', 'properties', 'info', 'domElement']);
      const seenObj = new Set();
      let budget = 20000;
      const dig = (o, label, depth) => {
        if (!o || depth > 6 || typeof o !== 'object' || seenObj.has(o) || budget-- < 0) return;
        seenObj.add(o);
        if (o.isMaterial) { visit(o, label); return; }
        if (o.isTexture || o.isBufferGeometry || o.isColor || o.isVector2 || o.isVector3 ||
            o.isMatrix4 || o.isMatrix3 || ArrayBuffer.isView(o)) return;
        for (const k of Object.keys(o)) {
          if (SKIP.has(k)) continue;
          const v = o[k];
          if (v && typeof v === 'object') dig(v, `${label}.${k}`, depth + 1);
        }
      };
      for (const sys of ['postfx', 'lighting', 'sky', 'fx', 'weapons', 'hud', 'level', 'props']) {
        try { dig(api.engine.get(sys), sys, 0); } catch {}
      }
      const list = [...byId.values()];
      return {
        total: progs.length,
        attributed: list.filter((p) => p.owners.length).length,
        orphans: list.filter((p) => !p.owners.length).map((p) => ({ id: p.id, name: p.name, usedTimes: p.usedTimes })),
        programs: list.sort((a, b) => b.usedTimes - a.usedTimes),
        unattachedMaterials: unattached.length,
      };

      function pathOf(o) {
        const parts = [];
        let n = o;
        for (let i = 0; i < 4 && n; i++) { parts.unshift(n.name || n.type); n = n.parent; }
        return parts.join('/');
      }
    },
  };

  P.run = async (op, a) => P.ops[op](a || {});
  return true;
}

// ------------------------------------------------------------------- driver

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

async function main() {
  await mkdir(OUT, { recursive: true });

  let server = null;
  if (!(await waitForServer(URL, 1200))) {
    server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT, stdio: 'ignore', detached: false,
    });
    if (!(await waitForServer(URL, 45000))) {
      console.error(JSON.stringify({ ok: false, error: 'dev server failed to start' }));
      server?.kill();
      process.exit(1);
    }
  }

  const browser = await chromium.launch({
    headless: !flag('headed'),
    args: [
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-driver-bug-workarounds',
      '--enable-webgl-draft-extensions',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const result = { ok: true, phase: PHASE, viewport: `${W}x${H}`, presets: PRESETS, errors, runs: [] };
  result.config = { buckets: BUCKETS, bucketMs: BUCKET_MS, drop: DROP, settleMs: SETTLE_MS, warmupMs: WARMUP_MS };

  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForFunction('window.__READY__ === true', { timeout: 45000 });
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: `boot failed: ${e.message}` }));
    await browser.close(); server?.kill(); process.exit(1);
  }

  await page.waitForTimeout(WARMUP_MS);
  await page.evaluate(() => window.__COD__?.debug?.setVisible?.(false));
  await page.evaluate(() => document.getElementById('debug-overlay')?.style.setProperty('display', 'none'));
  await page.evaluate(installProbe);

  const prof = (op, a) => page.evaluate(([o, x]) => window.__PROF__.run(o, x), [op, a]);
  const sample = () => page.evaluate((c) => window.__PROF__.sample(c), { buckets: BUCKETS, bucketMs: BUCKET_MS, drop: DROP });
  const settle = (ms = SETTLE_MS) => page.waitForTimeout(ms);

  /**
   * One test = fresh paired baseline, apply, sample, restore. Deltas are always
   * against the baseline taken seconds earlier, never against a run-start value.
   */
  async function test(run, label, applyOp, applyArg, restoreOp, restoreArg, opts = {}) {
    const shot = run.shot;
    await prof('restage', { shot });
    await settle(opts.preSettle ?? SETTLE_MS);
    const base = await sample();
    const applied = await prof(applyOp, applyArg);
    await settle(opts.settle ?? SETTLE_MS);
    const t = await sample();
    if (restoreOp) await prof(restoreOp, restoreArg);
    await settle(opts.settle ?? SETTLE_MS);
    const row = {
      label,
      applied,
      base: { fps: base.fps, frameMs: base.frameMs, postGpuMs: base.postGpuMs, drawCalls: base.drawCalls, triangles: base.triangles, bucketMedian: base.fpsBucketMedian, spread: base.fpsSpread },
      test: { fps: t.fps, frameMs: t.frameMs, postGpuMs: t.postGpuMs, drawCalls: t.drawCalls, triangles: t.triangles, bucketMedian: t.fpsBucketMedian, spread: t.fpsSpread, buffer: t.buffer },
      deltaFps: r2(t.fps - base.fps),
      deltaMs: r2(base.frameMs - t.frameMs),
      deltaPostGpuMs: base.postGpuMs != null && t.postGpuMs != null ? r2(base.postGpuMs - t.postGpuMs) : null,
      deltaDraws: base.drawCalls - t.drawCalls,
      deltaTris: base.triangles - t.triangles,
      // Quantisation floor of this deltaMs: +/-1 rendered frame in each window.
      // A deltaMs at or below this is not a measurement, it is a rounding artefact.
      quantMs: r2(Math.max((1000 / base.fps ** 2) * base.fpsQuantum, (1000 / t.fps ** 2) * t.fpsQuantum)),
      vsyncClamped: t.fps >= 58.5 || base.fps >= 58.5,
    };
    run.tests.push(row);
    console.error(`  ${label.padEnd(34)} fps ${String(base.fps).padStart(6)} -> ${String(t.fps).padStart(6)}   dMs ${String(row.deltaMs).padStart(7)} (+-${row.quantMs})  dDraw ${String(row.deltaDraws).padStart(5)}`);
    return row;
  }

  for (const name of PRESETS) {
    const shot = SHOTS[name];
    if (!shot) continue;
    console.error(`\n=== ${PHASE} / ${name} ===`);
    const run = { preset: name, shot, tests: [] };
    result.runs.push(run);
    await prof('preset', { shot });
    // Optional global render scale for the whole phase. The point is not the
    // absolute number: at 1x the frame is ~36-41 fps, so anything that recovers
    // more than ~11 ms hits the 60 fps rAF clamp and its cost is reported as a
    // FLOOR. Re-running a phase at 1.41 (2x pixels) moves the ceiling out of the
    // way, and comparing the two scales separates a subtree's fill cost (halves
    // when pixels halve) from its CPU/submission cost (does not move).
    const scale = parseFloat(arg('scale', '1'));
    if (scale !== 1) run.scale = await prof('scale', { s: scale });
    await settle(2500);
    run.probe = await prof('probe');
    run.sceneTree = await prof('sceneTree');
    run.reference = await sample();
    console.error(`  reference fps=${run.reference.fps} draws=${run.reference.drawCalls} tris=${run.reference.triangles} post=${run.reference.postGpuMs}ms buf=${run.reference.buffer}`);

    if (PHASE === 'res') {
      // 1.41 is included deliberately: headless Chromium clamps rAF at 60 fps, so
      // any scale that lands at 60 is a floor, not a reading. A 2x-pixels point is
      // never clamped and pins the slope of the fit from the other side.
      const scales = arg('scales', '1.41,0.71,0.5,1.0').split(',').map(Number);
      for (const s of scales) {
        await test(run, `render scale ${s}`, 'scale', { s }, 'scale', { s: 1.0 }, { settle: 1800 });
      }
    }

    if (PHASE === 'post') {
      await test(run, 'ALL post off', 'postAll', { on: false }, 'postAll', { on: true }, { settle: 1800 });
      for (const p of POST_PASSES) {
        await test(run, `pass off: ${p}`, 'pass', { name: p, on: false }, 'pass', { name: p, on: true });
      }
    }

    if (PHASE === 'shadow') {
      await test(run, 'shadow map RENDER off', 'shadowRender', { on: false }, 'shadowRender', { on: true });
      const cc = run.probe?.csm?.cascades ?? 3;
      for (let k = cc - 1; k >= 1; k--) {
        await test(run, `cascades rendering: ${k}/${cc}`, 'cascadeRender', { keep: k }, 'cascadeRender', { keep: cc });
      }
      await test(run, 'shadow map size x0.5', 'shadowMapSize', { factor: 0.5 }, 'shadowMapSize', { factor: 1 }, { settle: 2000 });
      await test(run, 'shadow map size x0.25', 'shadowMapSize', { factor: 0.25 }, 'shadowMapSize', { factor: 1 }, { settle: 2000 });
      // Destructive: recompiles every material and forks the program cache.
      await test(run, 'shadows fully disabled (recompile)', 'shadowEnabled', { on: false }, 'shadowEnabled', { on: true }, { settle: 4000, preSettle: 4000 });
    }

    if (PHASE === 'subtree') {
      // 'Props' and 'Vegetation' are searched for by name anywhere in the graph:
      // per the architecture contract they attach under ctx.level.root, not the scene.
      // A name that is not present is reported as found:false, never as "0 ms".
      const names = ['Level', 'Props', 'Vegetation', 'FX', 'AI', 'viewmodel', 'SkyDome',
        ...(arg('extra', '') ? arg('extra', '').split(',') : [])];
      for (const n of names) {
        await test(run, `hide ${n}`, 'subtree', { name: n, visible: false }, 'subtree', { name: n, visible: true }, { settle: 1600 });
      }
    }

    // Everything the earlier phases pointed at: what is inside the forward pass.
    // Ordered cheap-first; the recompiling tests are last because they fork the
    // program cache and add compile hitches to anything measured after them.
    if (PHASE === 'chase') {
      await test(run, 'POM off (codPomSteps=0)', 'pomSteps', { value: 0 }, 'pomSteps', { value: null }, { settle: 1600 });
      const cc = run.probe?.csm?.cascades ?? 3;
      for (let k = cc - 1; k >= 1; k--) {
        await test(run, `cascade COUNT ${k}/${cc} (recompile)`, 'cascadeCount', { keep: k }, 'cascadeCount', { keep: cc }, { settle: 3500, preSettle: 3000 });
      }
      await test(run, 'envMap off (recompile)', 'envMap', { on: false }, 'envMap', { on: true }, { settle: 3500, preSettle: 3000 });
      await test(run, 'bare forward (no post, no shadows)', 'bare', { on: true }, 'bare', { on: false }, { settle: 3500, preSettle: 3000 });
    }

    if (PHASE === 'programs') {
      run.programs = await prof('programs');
      console.error(`  programs total=${run.programs.total} attributed=${run.programs.attributed} orphans=${run.programs.orphans.length}`);
    }

    // Closing baseline: the honest measure of how far the run drifted.
    run.closing = await sample();
    const bases = run.tests.map((t) => t.base.frameMs).filter(Number.isFinite);
    if (bases.length) {
      run.baselineDrift = {
        frameMsMin: Math.min(...bases), frameMsMax: Math.max(...bases),
        frameMsMedian: r2(median(bases)),
        spreadMs: r2(Math.max(...bases) - Math.min(...bases)),
        note: 'any deltaMs smaller than spreadMs is inside the run-to-run noise of the untouched baseline',
      };
      console.error(`  baseline drift: ${run.baselineDrift.frameMsMin}..${run.baselineDrift.frameMsMax} ms (spread ${run.baselineDrift.spreadMs})`);
    }
  }

  result.errors = errors.slice(0, 40);
  await browser.close();
  server?.kill();

  const scaleTag = arg('scale', '1') === '1' ? '' : `-x${arg('scale', '1')}`;
  const file = path.join(OUT, `${PHASE}${scaleTag}-${PRESETS.join('_')}.json`);
  await writeFile(file, JSON.stringify(result, null, 2));
  console.error(`\nwrote ${file}`);
  console.log(JSON.stringify({ ok: true, file, errors: result.errors.length }));
}

main().catch(async (e) => {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack }));
  process.exit(1);
});
