import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Input } from './Input.js';

/**
 * Fixed-step simulation with a variable-rate render. Systems are plain objects
 * with optional init/fixedUpdate/update/lateUpdate/resize/dispose hooks, so each
 * subsystem lives in its own file and can be developed in isolation.
 */
const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 8;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.bus = new EventBus();
    this.input = new Input(canvas, this.bus);
    this.systems = [];
    this.byName = new Map();
    this.clock = new THREE.Clock();
    this.accumulator = 0;
    this.elapsed = 0;
    this.frame = 0;
    this.paused = false;
    this.timeScale = 1;
    this.stats = { fps: 0, ms: 0, drawCalls: 0, triangles: 0, programs: 0 };
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    /**
     * Dynamic-resolution state. `renderScale` multiplies the tier's DPR cap;
     * the adaptive pass nudges it down when the measured frame rate is short of
     * the target and back up when there is headroom. It is deliberately slow
     * (2 s windows, 0.1 steps) so a transient compile or a menu does not make
     * the whole frame pulse. Screenshot tooling holds `camera:override`, which
     * freezes the scale so consecutive captures are pixel-comparable.
     */
    this.renderScale = 1;
    this._adaptTimer = 0;
    this._cameraOverride = false;
    this.bus.on('camera:override', (v) => {
      this._cameraOverride = !!v;
      // The harness takes the camera for a still. Restore the tier's full
      // resolution first, otherwise a machine that had already adapted down
      // during play would hand the critic a soft, half-size frame and the
      // review would be measuring the wrong thing.
      if (v && this.renderScale !== 1) {
        this.renderScale = 1;
        this.ctx.renderScale = 1;
        this.resize();
      }
    });

    /** Shared context handed to every system. Systems attach their public API here. */
    this.ctx = {
      engine: this,
      canvas,
      bus: this.bus,
      input: this.input,
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(70, 1, 0.02, 4000),
      time: 0,
      dt: 0,
      fixedDt: FIXED_DT,
      quality: detectQuality(),
    };
    this.ctx.scene.name = 'World';
    this.ctx.camera.name = 'PlayerCamera';

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clock.getDelta();
    });
  }

  add(name, system) {
    system.name = name;
    this.systems.push(system);
    this.byName.set(name, system);
    return system;
  }

  get(name) {
    return this.byName.get(name);
  }

  async init() {
    for (const s of this.systems) {
      if (s.init) await s.init(this.ctx);
    }
    this.resize();
    this.bus.emit('engine:ready', this.ctx);
  }

  resize() {
    const cap = Math.min(window.devicePixelRatio || 1, this.ctx.quality.maxDpr);
    const dpr = Math.max(0.35, cap * (this.renderScale || 1));
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.camera.aspect = w / h;
    this.ctx.camera.updateProjectionMatrix();
    for (const s of this.systems) s.resize?.(w, h, dpr, this.ctx);
    this.bus.emit('engine:resize', { w, h, dpr });
  }

  start() {
    this.clock.start();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.tick();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  tick() {
    const t0 = performance.now();
    let dt = Math.min(this.clock.getDelta(), 0.25) * this.timeScale;
    if (this.paused) dt = 0;
    this.elapsed += dt;
    this.ctx.dt = dt;
    this.ctx.time = this.elapsed;
    this.frame++;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (const s of this.systems) s.fixedUpdate?.(FIXED_DT, this.ctx);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    this.ctx.alpha = this.accumulator / FIXED_DT;

    for (const s of this.systems) s.update?.(dt, this.ctx);
    for (const s of this.systems) s.lateUpdate?.(dt, this.ctx);

    this.input.endFrame();

    const ms = performance.now() - t0;
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.stats.fps = this._fpsFrames / this._fpsAccum;
      this.stats.ms = ms;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    this._adaptResolution(dt);
  }

  /**
   * Resolution is the one performance lever that scales with the actual
   * bottleneck on every GPU: pixel cost. Quality tiers pick a fixed ceiling,
   * this trims below it when the machine cannot hold the target. A 1080p frame
   * at 0.7 scale still looks better than a 1080p frame at 28 fps, and a weak
   * software rasteriser can fall back to 0.5 without changing world detail.
   */
  _adaptResolution(dt) {
    if (this.paused || this._cameraOverride || !(dt > 0)) return;
    this._adaptTimer += dt;
    if (this._adaptTimer < 2.0) return;
    const fps = this.stats.fps;
    this._adaptTimer = 0;
    if (!(fps > 0)) return;

    const floor = 0.5;
    let next = this.renderScale;
    if (fps < 46 && next > floor) next = Math.max(floor, next - 0.1);
    else if (fps > 58 && next < 1) next = Math.min(1, next + 0.05);
    if (Math.abs(next - this.renderScale) < 1e-3) return;
    this.renderScale = next;
    this.ctx.renderScale = next;
    this.resize();
  }
}

/** Integrated GPUs: fast, but not "run every pass at maximum" fast. */
const INTEGRATED_GPU = /Apple M\d|Apple GPU|Intel|UHD Graphics|Iris|Radeon Vega|Mali|Adreno|PowerVR/i;
/** CPU rasterisers used by headless browsers and remote previews. */
const SOFTWARE_GPU = /SwiftShader|llvmpipe|Software Rasterizer|Microsoft Basic Render/i;

const PRESETS = {
  low: { maxDpr: 1, shadowMapSize: 1024, cascades: 2, ssao: false, ssr: false, volumetrics: false, taa: false, textureSize: 512, anisotropy: 4 },
  medium: { maxDpr: 1.25, shadowMapSize: 1536, cascades: 3, ssao: true, ssr: false, volumetrics: true, taa: true, textureSize: 1024, anisotropy: 8 },
  high: { maxDpr: 1.5, shadowMapSize: 2048, cascades: 3, ssao: true, ssr: true, volumetrics: true, taa: true, textureSize: 1024, anisotropy: 16 },
  ultra: { maxDpr: 2, shadowMapSize: 2048, cascades: 4, ssao: true, ssr: true, volumetrics: true, taa: true, textureSize: 2048, anisotropy: 16 },
};

/** `?quality=low`, or the value left in localStorage by the settings UI. */
function requestedTier() {
  try {
    const q = new URLSearchParams(location.search).get('quality');
    if (q && PRESETS[q]) return q;
    const stored = localStorage.getItem('cod:quality');
    if (stored && PRESETS[stored]) return stored;
  } catch {}
  return null;
}

function detectQuality() {
  const gl = document.createElement('canvas').getContext('webgl2');
  const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : '';
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 8;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  // deviceMemory/hardwareConcurrency alone put every modern laptop on `ultra`,
  // which is a discrete-GPU preset: 2048-square hero textures, 8-step GTAO,
  // 32-step volumetrics, 24-step POM. Measured on the M2 that is 26 ms/frame at
  // 1080p against a 16.6 ms budget. The renderer string is already being read
  // here, so use it: integrated parts top out at `high`.
  const software = SOFTWARE_GPU.test(renderer);
  const integrated = INTEGRATED_GPU.test(renderer);
  let tier = requestedTier();
  if (!tier) {
    tier = software
      ? 'low'
      : mobile
        ? 'low'
        : mem >= 8 && cores >= 8 && !integrated ? 'ultra'
          : mem >= 4 ? 'high' : 'medium';
  }
  const quality = { tier, renderer, software, ...PRESETS[tier] };

  // A software rasteriser is not a slow GPU, it is a CPU pretending to be one.
  // It needs the *content* budget cut too: half-size procedural maps, no
  // anisotropic filtering, one shadow cascade, and one fewer prop tier. Without
  // this the preview falls to single-digit fps before it has drawn a frame.
  if (software && tier !== 'low') {
    Object.assign(quality, PRESETS.low);
    quality.tier = 'low';
  }
  if (software) {
    quality.maxDpr = 0.75;
    quality.shadowMapSize = 512;
    quality.cascades = 1;
    quality.textureSize = 256;
    quality.anisotropy = 1;
    quality.props = 0.3;
  }
  return quality;
}
