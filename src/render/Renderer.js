import * as THREE from 'three';

/**
 * Owns the WebGLRenderer, colour pipeline and the render target that PostFX
 * reads from. Nothing else in the codebase should construct a renderer.
 */
export class RenderSystem {
  async init(ctx) {
    const renderer = new THREE.WebGLRenderer({
      canvas: ctx.canvas,
      antialias: false, // TAA/FXAA handled in PostFX
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, ctx.quality.maxDpr));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.info.autoReset = false;

    this.renderer = renderer;
    ctx.renderer = renderer;
    ctx.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    // Weapon viewmodel renders in a second pass with a narrow FOV so it never
    // clips into world geometry — standard FPS practice.
    ctx.viewScene = new THREE.Scene();
    ctx.viewCamera = new THREE.PerspectiveCamera(55, 1, 0.005, 10);
    ctx.viewScene.name = 'ViewModel';
  }

  resize(w, h, dpr, ctx) {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    ctx.viewCamera.aspect = w / h;
    ctx.viewCamera.updateProjectionMatrix();
  }

  lateUpdate(dt, ctx) {
    const info = this.renderer.info;
    ctx.engine.stats.drawCalls = info.render.calls;
    ctx.engine.stats.triangles = info.render.triangles;
    ctx.engine.stats.programs = info.programs?.length ?? 0;
    info.reset();
  }
}
