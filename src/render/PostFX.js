import * as THREE from 'three';
import { makeRT, attachDepth, makeBlueNoise, GpuTimer } from './passes/Common.js';
import { TAAPass } from './passes/TAAPass.js';
import { GTAOPass } from './passes/GTAOPass.js';
import { VolumetricPass } from './passes/VolumetricPass.js';
import { SSRPass } from './passes/SSRPass.js';
import { CompositePass } from './passes/CompositePass.js';
import { MotionBlurPass } from './passes/MotionBlurPass.js';
import { DOFPass } from './passes/DOFPass.js';
import { BloomPass } from './passes/BloomPass.js';
import { ExposurePass } from './passes/ExposurePass.js';
import { GradePass } from './passes/GradePass.js';
import { SharpenPass } from './passes/SharpenPass.js';
import { ViewmodelPass } from './passes/ViewmodelPass.js';
import { buildLensDirt } from './passes/LensTextures.js';
import { buildLookTextures, LOOK_NAMES, LUT_SIZE } from './passes/LUT.js';

/**
 * The full deferred-lighting-free post pipeline.
 *
 * The world is rendered once into an HDR target with a float depth attachment.
 * There is deliberately no MRT G-buffer: every other agent owns their own
 * materials, and forcing a second output on all of them would mean rewriting
 * shaders this system does not own. Normals are reconstructed from depth with a
 * four-tap closest-neighbour derivative (clean enough for GTAO, SSR and the AO
 * sun mask), and velocity is reconstructed from depth plus the previous
 * view-projection — camera-only, which is the dominant term in a shooter and is
 * exactly what TAA and motion blur are specified against here.
 *
 *   scene -> HDR + depth
 *     -> TAA resolve (8x Halton, YCoCg variance clip, Catmull-Rom history)
 *     -> GTAO / volumetrics / SSR at half res, joint-bilateral upsampled
 *     -> motion blur (tile-max dilated reconstruction)
 *     -> depth of field (ADS / cinematic only)
 *     -> viewmodel composite in HDR, so muzzle flash blooms and the weapon
 *        shares the world's exposure
 *     -> bloom (Kawase dual filter, 6 mips, energy conserving)
 *     -> auto exposure + ACES + 3D LUT + dirt / CA / vignette / grain
 *     -> CAS -> FXAA -> canvas
 *
 * Every stage is individually toggleable and auto-gated by `ctx.quality`; a
 * stage whose input is missing is skipped rather than allowed to throw.
 */

const TIERS = {
  low: { ao: [0, 0], vol: 0, bloom: 5, dof: 16, ssr: 0, taa: false, motion: false },
  medium: { ao: [3, 5], vol: 20, bloom: 5, dof: 24, ssr: 0, taa: true, motion: true },
  high: { ao: [4, 6], vol: 26, bloom: 6, dof: 32, ssr: 20, taa: true, motion: true },
  ultra: { ao: [4, 8], vol: 32, bloom: 6, dof: 40, ssr: 24, taa: true, motion: true },
};

const BLACK = new THREE.Color(0, 0, 0);
const _size = new THREE.Vector2();
const _jitter = new THREE.Vector2();
const _jitterUV = new THREE.Vector2();

export class PostFX {
  constructor() {
    this.enabled = true;
    this.frame = 0;
    this.width = 0;
    this.height = 0;
    this.look = 'auto';
    this.cinematic = false;
    this._lutFade = 1;
    this._lutFrom = 'warm_desert';
    this._lutTo = 'warm_desert';
    this._cpuMs = 0;
    this._warned = new Set();
  }

  async init(ctx) {
    this.ctx = ctx;
    const renderer = ctx.renderer;
    if (!renderer) {
      console.warn('PostFX: no renderer, post processing disabled');
      this.enabled = false;
      return;
    }

    const tier = TIERS[ctx.quality?.tier] ? ctx.quality.tier : 'high';
    this.tier = TIERS[tier];

    this.taa = new TAAPass();
    this.gtao = this.tier.ao[0] ? new GTAOPass(this.tier.ao[0], this.tier.ao[1]) : null;
    this.volumetrics = this.tier.vol ? new VolumetricPass() : null;
    if (this.volumetrics) this.volumetrics.steps = this.tier.vol;
    this.ssr = this.tier.ssr ? new SSRPass(this.tier.ssr) : null;
    this.composite = new CompositePass();
    this.motion = this.tier.motion ? new MotionBlurPass(8) : null;
    this.dof = new DOFPass(this.tier.dof);
    this.bloom = new BloomPass(this.tier.bloom);
    this.exposure = new ExposurePass();
    this.grade = new GradePass(LUT_SIZE);
    this.sharpen = new SharpenPass();
    this.viewmodel = new ViewmodelPass();

    this.luts = buildLookTextures();
    this.noise = makeBlueNoise(32);
    this.dirt = buildLensDirt(renderer, 512);
    this.fallback = makeFallbackTexture();
    this.timer = new GpuTimer(renderer);

    this.grade.uniforms.uDirt.value = this.dirt.texture;
    this.grade.uniforms.uLutA.value = this.luts.warm_desert;
    this.grade.uniforms.uLutB.value = this.luts.warm_desert;

    // Half-float depth on a reversed buffer would flip every comparison in the
    // volumetric cascade lookup; ask the renderer rather than assume.
    if (this.volumetrics) {
      this.volumetrics.reversedDepth = !!renderer.state?.buffers?.depth?.getReversed?.();
    }

    this.rtScene = null;
    this.rtView = null;
    this.workA = null;
    this.workB = null;
    this.ldrA = null;
    this.ldrB = null;

    this._viewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._curVP = new THREE.Matrix4();
    this._prevVP = new THREE.Matrix4();
    this._projNoJitter = new THREE.Matrix4();
    this._cameraStill = true;

    this.passes = {
      taa: this.tier.taa && ctx.quality?.taa !== false,
      gtao: !!this.gtao && ctx.quality?.ssao !== false,
      volumetrics: !!this.volumetrics && ctx.quality?.volumetrics !== false,
      ssr: false,
      motionBlur: !!this.motion,
      dof: true,
      viewmodel: true,
      bloom: true,
      exposure: true,
      lut: true,
      dirt: true,
      chromatic: true,
      vignette: true,
      grain: true,
      cas: true,
      fxaa: true,
    };

    this.tunables = {
      aoStrength: 1.0,
      aoRadius: 0.9,
      aoIndirectScale: 0.85,
      aoPower: 1.4,
      volumetricStrength: 0.6,
      volumetricDensity: 0.004,
      volumetricAnisotropy: 0.5,
      bloomStrength: 0.05,
      bloomThreshold: 1.15,
      anamorphic: 1.12,
      exposureBase: renderer.toneMappingExposure ?? 1,
      exposureKey: 0.19,
      minExposure: 0.22,
      maxExposure: 7.5,
      chromatic: 0.0009,
      // 0.34 took the bottom corners down 31%, which on a street frame is
      // exactly where the shadowed half of the road sits — it read as a black
      // wedge rather than as a graded surface. The vignette is applied after
      // metering, so this is pure image, not exposure.
      vignette: 0.20,
      grain: 0.026,
      dirt: 0.45,
      sharpness: 0.62,
      shutter: 0.3,
      lutStrength: 1.0,
      dofFocus: 8,
      dofRange: 0.55,
      dofRadius: 11,
      ssrStrength: 0.55,
      taaFeedback: 0.055,
    };

    const self = this;
    ctx.postfx = {
      get passes() { return self.passes; },
      get tunables() { return self.tunables; },
      looks: [...LOOK_NAMES, 'auto'],
      get look() { return self.look; },
      set: (name, value) => self.set(name, value),
      get: (name) => (name in self.passes ? self.passes[name] : self.tunables[name]),
      setLook: (name, fade = 1.0) => self.setLook(name, fade),
      setCinematic: (v) => { self.cinematic = !!v; },
      setEnabled: (v) => { self.enabled = !!v; self.resetHistory(); },
      get enabled() { return self.enabled; },
      setFocus: (d) => { self.tunables.dofFocus = d; },
      setExposure: (v) => { self.tunables.exposureBase = v; },
      reset: () => self.resetHistory(),
      cost: { gpuMs: -1, cpuMs: 0, drawCalls: 0 },
    };
    this.api = ctx.postfx;

    ctx.bus?.on('sky:timeOfDay', () => this.resetHistory());
    ctx.bus?.on('camera:override', () => this.resetHistory());

    this._ensureSize(true);
  }

  set(name, value) {
    if (name in this.passes) {
      this.passes[name] = !!value;
      if (name === 'taa') this.resetHistory();
      return true;
    }
    if (name in this.tunables && typeof value === 'number') {
      this.tunables[name] = value;
      return true;
    }
    return false;
  }

  setLook(name, fade = 1.0) {
    if (name !== 'auto' && !this.luts?.[name]) return false;
    this.look = name;
    if (name !== 'auto') this._crossfadeTo(name, fade);
    return true;
  }

  _crossfadeTo(name, fade) {
    if (this._lutTo === name) return;
    this._lutFrom = this._lutFade >= 1 ? this._lutTo : this._lutFrom;
    this._lutTo = name;
    this._lutFade = fade > 0 ? 0 : 1;
    this._lutFadeRate = fade > 0 ? 1 / fade : 1;
  }

  resetHistory() {
    this.taa && (this.taa.needsReset = true);
    this.gtao && (this.gtao.needsReset = true);
    this.volumetrics && (this.volumetrics.needsReset = true);
    this.exposure && (this.exposure.needsReset = true);
  }

  /** Reallocation is driven off the drawing-buffer size in `_ensureSize`, so a
   *  resize that arrives before or after the renderer's own is handled either way. */
  resize() {}

  _ensureSize(force) {
    const r = this.ctx?.renderer;
    if (!r) return false;
    r.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.floor(_size.x));
    const h = Math.max(2, Math.floor(_size.y));
    if (!force && w === this.width && h === this.height) return true;
    this.width = w;
    this.height = h;

    this.rtScene?.depthTexture?.dispose();
    this.rtScene?.dispose();
    this.rtScene = attachDepth(makeRT(w, h, { name: 'sceneHDR', depthBuffer: true }), w, h);
    if (this.rtView) {
      this.rtView.depthTexture?.dispose();
      this.rtView.dispose();
      this.rtView = attachDepth(makeRT(w, h, { name: 'viewHDR', depthBuffer: true }), w, h);
    }
    for (const key of ['workA', 'workB']) {
      this[key]?.dispose();
      this[key] = makeRT(w, h, { name: key });
    }
    for (const key of ['ldrA', 'ldrB']) {
      this[key]?.dispose();
      this[key] = makeRT(w, h, { type: THREE.UnsignedByteType, name: key });
    }

    this.taa.setSize(w, h);
    this.gtao?.setSize(w, h);
    this.volumetrics?.setSize(w, h);
    this.ssr?.setSize(w, h);
    this.composite.setSize(w, h);
    this.motion?.setSize(w, h);
    this.dof.setSize(w, h);
    this.bloom.setSize(w, h);
    this.exposure.setSize(w, h);
    this.grade.setSize(w, h);
    this.sharpen.setSize(w, h);
    this.viewmodel.setSize(w, h);
    this.resetHistory();
    return true;
  }

  _ensureViewTarget() {
    if (this.rtView) return this.rtView;
    const w = this.width;
    const h = this.height;
    this.rtView = attachDepth(makeRT(w, h, { name: 'viewHDR', depthBuffer: true }), w, h);
    return this.rtView;
  }

  _once(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(`PostFX: ${msg}`);
  }

  lateUpdate(dt, ctx) {
    const r = ctx.renderer;
    if (!r) return;
    if (!this.enabled || !this.rtScene) {
      r.setRenderTarget(null);
      r.render(ctx.scene, ctx.camera);
      return;
    }
    this._ensureSize(false);

    const t0 = performance.now();
    const cam = ctx.camera;
    const w = this.width;
    const h = this.height;
    this.frame++;

    const prevAutoClear = r.autoClear;
    const prevTarget = r.getRenderTarget();
    r.getClearColor(_clearColor);
    const prevClearAlpha = r.getClearAlpha();

    // --- jitter -------------------------------------------------------------
    const e = cam.projectionMatrix.elements;
    const base8 = e[8];
    const base9 = e[9];
    this._projNoJitter.copy(cam.projectionMatrix);
    this._curVP.multiplyMatrices(this._projNoJitter, cam.matrixWorldInverse);

    const useTaa = this.passes.taa;
    if (useTaa) {
      this.taa.jitterNDC(this.frame, w, h, _jitter);
      e[8] = base8 - _jitter.x;
      e[9] = base9 - _jitter.y;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    } else {
      _jitter.set(0, 0);
    }
    _jitterUV.set(_jitter.x * 0.5, _jitter.y * 0.5);

    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._invViewProj.copy(this._viewProj).invert();
    this._cameraStill = matricesEqual(this._curVP, this._prevVP);

    // --- world --------------------------------------------------------------
    r.autoClear = true;
    r.setClearColor(BLACK, 1);
    r.setRenderTarget(this.rtScene);
    r.render(ctx.scene, cam);
    r.autoClear = false;

    this.timer.begin();

    const depth = this.rtScene.depthTexture;
    let color = this.rtScene.texture;

    // --- temporal resolve ---------------------------------------------------
    if (useTaa) {
      const u = this.taa.pass.uniforms;
      u.uNear.value = cam.near;
      u.uFar.value = cam.far;
      u.uFeedbackStill.value = this.tunables.taaFeedback;
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uPrevViewProj.value.copy(this._prevVP);
      color = this.taa.render(r, color, depth, _jitter);
    }

    // --- half resolution effects -------------------------------------------
    let aoTex = null;
    if (this.passes.gtao && this.gtao) {
      this.gtao.ao.uniforms.uNoise.value = this.noise;
      this.gtao.ao.uniforms.uRadius.value = this.tunables.aoRadius;
      this.gtao.ao.uniforms.uPower.value = this.tunables.aoPower;
      aoTex = this.gtao.render(r, depth, cam, this.frame, this._invViewProj, this._prevVP);
    }

    let volTex = null;
    if (this.passes.volumetrics && this.volumetrics) {
      this.volumetrics.density = this.tunables.volumetricDensity;
      this.volumetrics.strength = 1;
      this.volumetrics.anisotropy = this.tunables.volumetricAnisotropy;
      volTex = this.volumetrics.render(
        r, ctx, depth, this.noise, this._invViewProj, this._prevVP, this.frame
      );
      if (!volTex) this._once('vol', 'no usable sun shadow cascade, volumetrics skipped');
    }

    let ssrTex = null;
    if (this.passes.ssr && this.ssr) {
      ssrTex = this.ssr.render(r, color, depth, cam);
    }

    // --- composite half-res buffers back in ---------------------------------
    let src = this.workA;
    let dst = this.workB;
    this.composite.pass.uniforms.uIndirectScale.value = this.tunables.aoIndirectScale;
    _compositeInputs.color = color;
    _compositeInputs.depth = depth;
    _compositeInputs.ao = aoTex;
    _compositeInputs.vol = volTex;
    _compositeInputs.ssr = ssrTex;
    _compositeInputs.avgLum = this.exposure.texture;
    _compositeInputs.fallback = this.fallback;
    _compositeInputs.aoStrength = this.tunables.aoStrength;
    _compositeInputs.volStrength = this.tunables.volumetricStrength;
    _compositeInputs.ssrStrength = this.tunables.ssrStrength;
    this.composite.render(r, src, ctx, _compositeInputs);

    // --- motion blur --------------------------------------------------------
    if (this.passes.motionBlur && this.motion && !this._cameraStill) {
      this.motion.shutter = this.tunables.shutter;
      this.motion.render(r, dst, src.texture, depth, cam, this._invViewProj, this._prevVP, _jitterUV);
      const swap = src; src = dst; dst = swap;
    }

    // --- depth of field -----------------------------------------------------
    const ads = !!(ctx.player?.isADS || ctx.weapons?.isADS);
    if (this.passes.dof && (ads || this.cinematic)) {
      this.dof.focus = this.tunables.dofFocus;
      this.dof.range = this.tunables.dofRange;
      this.dof.radius = this.tunables.dofRadius * (ads ? 1 : 0.7);
      this.dof.render(r, dst, src.texture, depth, cam);
      const swap = src; src = dst; dst = swap;
    }

    // --- viewmodel ----------------------------------------------------------
    const viewScene = ctx.viewScene;
    const showView =
      this.passes.viewmodel && viewScene && viewScene.visible !== false && viewScene.children.length > 0;
    if (showView) {
      const rtView = this._ensureViewTarget();
      r.autoClear = true;
      r.setClearColor(BLACK, 0);
      r.setRenderTarget(rtView);
      r.render(viewScene, ctx.viewCamera);
      r.autoClear = false;
      this.viewmodel.render(
        r, dst, src.texture, rtView.texture, rtView.depthTexture, ctx.viewCamera,
        ads ? 0.32 : 0.55, ads ? 1.4 : 0.35
      );
      const swap = src; src = dst; dst = swap;
    }

    // --- bloom + exposure ---------------------------------------------------
    let bloomTex = this.fallback;
    if (this.passes.bloom) {
      this.bloom.threshold = this.tunables.bloomThreshold;
      this.bloom.anamorphic = this.tunables.anamorphic;
      _exposureArgs.base = this.tunables.exposureBase;
      _exposureArgs.key = this.tunables.exposureKey;
      _exposureArgs.min = this.tunables.minExposure;
      _exposureArgs.max = this.tunables.maxExposure;
      bloomTex = this.bloom.render(r, src.texture, this.exposure.texture, _exposureArgs) || this.fallback;
    }
    if (this.passes.exposure) this.exposure.render(r, src.texture, depth, dt);

    // --- grade --------------------------------------------------------------
    this._updateLook(dt, ctx);
    const g = this.grade.uniforms;
    g.uScene.value = src.texture;
    g.uBloom.value = bloomTex;
    g.uAvgLum.value = this.exposure.texture;
    g.uBloomStrength.value = this.passes.bloom ? this.tunables.bloomStrength : 0;
    g.uDirtStrength.value = this.passes.dirt && this.passes.bloom ? this.tunables.dirt : 0;
    g.uCA.value = this.passes.chromatic ? this.tunables.chromatic : 0;
    g.uVignette.value = this.passes.vignette ? this.tunables.vignette : 0;
    g.uGrain.value = this.passes.grain ? this.tunables.grain : 0;
    g.uLutStrength.value = this.passes.lut ? this.tunables.lutStrength : 0;
    g.uExposureBase.value = this.tunables.exposureBase;
    g.uKey.value = this.tunables.exposureKey;
    g.uMinExposure.value = this.tunables.minExposure;
    g.uMaxExposure.value = this.tunables.maxExposure;
    g.uTime.value = ctx.time || 0;

    const useCas = this.passes.cas;
    const useFxaa = this.passes.fxaa;
    this.grade.render(r, useCas || useFxaa ? this.ldrA : null);

    if (useCas) {
      this.sharpen.cas.uniforms.uSrc.value = this.ldrA.texture;
      this.sharpen.cas.uniforms.uSharpness.value = this.tunables.sharpness;
      this.sharpen.cas.render(r, useFxaa ? this.ldrB : null);
    }
    if (useFxaa) {
      this.sharpen.fxaa.uniforms.uSrc.value = useCas ? this.ldrB.texture : this.ldrA.texture;
      this.sharpen.fxaa.render(r, null);
    }

    this.timer.end();

    // --- restore ------------------------------------------------------------
    e[8] = base8;
    e[9] = base9;
    if (useTaa) cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    this._prevVP.copy(this._curVP);
    r.setRenderTarget(prevTarget);
    r.setClearColor(_clearColor, prevClearAlpha);
    r.autoClear = prevAutoClear;

    this._cpuMs = this._cpuMs * 0.9 + (performance.now() - t0) * 0.1;
    const cost = this.api?.cost;
    if (cost) {
      cost.gpuMs = this.timer.ms;
      cost.cpuMs = this._cpuMs;
      cost.drawCalls = countPasses(this);
    }

    if (!this._hooked && window.__COD__) {
      this._hooked = true;
      window.__COD__.postfx = this.api;
    }
  }

  /** Time-of-day driven look selection, unless a look was pinned explicitly. */
  _updateLook(dt, ctx) {
    if (this.look === 'auto') {
      const y = ctx.sky?.sunDirection?.y ?? 0.4;
      this._crossfadeTo(y < -0.02 ? 'night_teal' : 'warm_desert', 1.2);
    }
    if (this._lutFade < 1) {
      this._lutFade = Math.min(1, this._lutFade + (dt || 0.016) * (this._lutFadeRate || 1));
    }
    const g = this.grade.uniforms;
    g.uLutA.value = this.luts[this._lutFrom] || this.luts.neutral;
    g.uLutB.value = this.luts[this._lutTo] || this.luts.neutral;
    g.uLutMix.value = this._lutFade;
  }

  dispose() {
    this.taa?.dispose();
    this.gtao?.dispose();
    this.volumetrics?.dispose();
    this.ssr?.dispose();
    this.composite?.dispose();
    this.motion?.dispose();
    this.dof?.dispose();
    this.bloom?.dispose();
    this.exposure?.dispose();
    this.grade?.dispose();
    this.sharpen?.dispose();
    this.viewmodel?.dispose();
    this.timer?.dispose();
    for (const rt of [this.rtScene, this.rtView, this.workA, this.workB, this.ldrA, this.ldrB, this.dirt]) {
      rt?.depthTexture?.dispose();
      rt?.dispose();
    }
    this.noise?.dispose();
    this.fallback?.dispose();
    for (const k in this.luts) this.luts[k].dispose();
  }
}

const _clearColor = new THREE.Color();
const _exposureArgs = { base: 1, key: 0.19, min: 0.22, max: 7.5 };
const _compositeInputs = {
  color: null, depth: null, ao: null, vol: null, ssr: null, avgLum: null, fallback: null,
  aoStrength: 1, volStrength: 1, ssrStrength: 0,
};

function matricesEqual(a, b) {
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(x[i] - y[i]) > 1e-7) return false;
  return true;
}

function countPasses(fx) {
  let n = 3; // composite + grade + scene
  if (fx.passes.taa) n++;
  if (fx.passes.gtao && fx.gtao) n += 3;
  if (fx.passes.volumetrics && fx.volumetrics) n++;
  if (fx.passes.ssr && fx.ssr) n++;
  if (fx.passes.motionBlur && fx.motion && !fx._cameraStill) n += 5;
  if (fx.passes.bloom) n += fx.bloom.mips.length * 2 - 1;
  if (fx.passes.exposure) n += 5;
  if (fx.passes.cas) n++;
  if (fx.passes.fxaa) n++;
  return n;
}

function makeFallbackTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'postfx:fallback';
  return tex;
}
