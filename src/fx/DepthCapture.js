import * as THREE from 'three';

/**
 * Quarter-resolution linear scene depth, for soft particle edges.
 *
 * The main render already has a depth buffer, but particles are drawn *into*
 * that same pass — you cannot sample the attachment you are writing. So this
 * takes its own depth-only snapshot just before the world render, with three
 * things keeping it cheap:
 *
 *  1. **It only runs while soft particles are actually alive.** No smoke on
 *     screen, no cost at all — the common case.
 *  2. **Quarter resolution and a short far plane.** Soft fading is a
 *     centimetres-scale effect on things within a few tens of metres; geometry
 *     past `FAR` is frustum-culled out of the pass entirely, which on a street
 *     with a 70 m sightline removes most of the draw calls.
 *  3. **Shadow maps are pinned off for the pass**, otherwise `renderer.render`
 *     would re-render every cascade a second time per frame.
 *
 * A single override `ShaderMaterial` means one program and no material sorting;
 * it routes through three's own vertex chunks so instanced and skinned geometry
 * (props, vegetation, bots) land in the right place.
 */

const FAR = 45;
const SCALE = 0.25;
/**
 * Meshes smaller than this are skipped in the depth pass. A 20 cm rubble chunk
 * occludes a handful of quarter-resolution texels; paying a draw call for it
 * doubles the cost of the pass for no visible change in a particle's edge fade.
 * InstancedMesh is never skipped — it is one call for the whole scatter.
 */
const MIN_OCCLUDER_RADIUS = 0.55;
const _sphere = new THREE.Vector3();
const CLEAR = new THREE.Color(1e4, 0, 0);

const DEPTH_VERT = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying float vDepth;
void main(){
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vDepth = -mvPosition.z;
}
`;

const DEPTH_FRAG = /* glsl */ `
precision highp float;
varying float vDepth;
void main(){ gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0); }
`;

export class DepthCapture {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = ctx.quality?.tier !== 'low';
    this.width = 0;
    this.height = 0;
    this.frame = 0;
    this.lastDrawCalls = 0;

    this.material = new THREE.ShaderMaterial({
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, FAR);
    this.rt = null;
    this._prevCam = new THREE.Vector3(1e9, 1e9, 1e9);
    this._prevQuat = new THREE.Quaternion();
    this._hidden = [];
    this._cull = (o) => {
      if (!o.visible || !o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) return;
      const g = o.geometry;
      if (!g) return;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const bs = g.boundingSphere;
      if (!bs) return;
      _sphere.setFromMatrixScale(o.matrixWorld);
      const r = bs.radius * Math.max(_sphere.x, _sphere.y, _sphere.z);
      if (r < MIN_OCCLUDER_RADIUS) { o.visible = false; this._hidden.push(o); }
    };
  }

  get texture() { return this.rt ? this.rt.texture : null; }

  _ensure(renderer) {
    const size = renderer.getDrawingBufferSize(_sizeScratch);
    const w = Math.max(64, Math.round(size.x * SCALE));
    const h = Math.max(64, Math.round(size.y * SCALE));
    if (this.rt && this.width === w && this.height === h) return;
    this.rt?.dispose();
    this.width = w;
    this.height = h;
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      // Full float, not half: the comparison is `sceneDepth - particleDepth`
      // over centimetres at tens of metres, and half float has ~8 mm of
      // mantissa at 20 m — enough to erase every impact puff on a wall.
      type: THREE.FloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
  }

  /**
   * @param {THREE.Object3D} hide FX root, excluded so particles never occlude
   *   each other's soft fade.
   * @returns {THREE.Texture|null}
   */
  capture(hide) {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    const cam = ctx.camera;
    if (!this.enabled || !renderer || !cam) return null;
    this._ensure(renderer);
    if (!this.rt) return null;

    this.frame++;
    // A frame-late depth buffer at quarter resolution is invisible while the
    // camera is still, which is most of the time and every screenshot.
    const still =
      this._prevCam.distanceToSquared(cam.position) < 1e-6 &&
      Math.abs(this._prevQuat.dot(cam.quaternion)) > 0.999995;
    // Still camera: reuse forever — which covers every screenshot and most of
    // a firefight. Moving camera: amortise over N frames, chosen from what the
    // pass actually cost last time, so a scene that has grown heavy degrades to
    // a slightly stale depth buffer rather than to a draw-call blowout. At
    // quarter resolution a frame or two of lag is a sub-pixel error on the
    // *fade* of a particle edge; nothing about the image moves.
    const interval = this.lastDrawCalls > 90 ? 6 : this.lastDrawCalls > 55 ? 4 : this.lastDrawCalls > 30 ? 2 : 1;
    if (this.frame > 1 && (still || (interval > 1 && this.frame % interval))) return this.rt.texture;
    this._prevCam.copy(cam.position);
    this._prevQuat.copy(cam.quaternion);

    const scene = ctx.scene;
    const prevOverride = scene.overrideMaterial;
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevBackground = scene.background;
    const prevVisible = hide ? hide.visible : false;
    const calls0 = renderer.info.render.calls;
    renderer.getClearColor(_clearScratch);
    const prevAlpha = renderer.getClearAlpha();

    this.camera.fov = cam.fov;
    this.camera.aspect = cam.aspect;
    this.camera.near = cam.near;
    this.camera.far = FAR;
    this.camera.position.copy(cam.position);
    this.camera.quaternion.copy(cam.quaternion);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    if (hide) hide.visible = false;
    // Transient, restored before this function returns — nothing outside can
    // observe it, and it is the difference between a 110-call pass and a 40.
    this._hidden.length = 0;
    scene.traverse(this._cull);
    scene.overrideMaterial = this.material;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.setClearColor(CLEAR, 1);
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, true, false);
    renderer.render(scene, this.camera);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(_clearScratch, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    if (hide) hide.visible = prevVisible;
    for (let i = 0; i < this._hidden.length; i++) this._hidden[i].visible = true;
    this._hidden.length = 0;
    this.lastDrawCalls = renderer.info.render.calls - calls0;

    return this.rt.texture;
  }

  dispose() {
    this.rt?.dispose();
    this.material.dispose();
  }
}

const _sizeScratch = new THREE.Vector2();
const _clearScratch = new THREE.Color();
