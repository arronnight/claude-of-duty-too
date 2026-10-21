import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MaterialLibrary } from '../Materials.js';
import { MATERIAL_KEYS } from './MaterialDefs.js';

/**
 * Dev-only harness for the material library — not part of the game.
 *
 * Renders every key on a world-scaled slab plus a sphere under a physically
 * plausible sun + IBL setup so the library can be judged (tiling, parallax
 * depth, wetness, specular response) without waiting on the level, sky or
 * lighting systems. Open /src/render/materials/preview.html.
 */
const params = new URLSearchParams(location.search);
const WETNESS = parseFloat(params.get('wet') || '0');
const ONLY = params.get('key');
const CLOSE = params.has('close');

const canvas = document.getElementById('preview');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 200);

const pmrem = new THREE.PMREMGenerator(renderer);
const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = env;
scene.environmentIntensity = 0.55;
scene.background = new THREE.Color(0x1b222b);

const sun = new THREE.DirectionalLight(0xfff2df, 3.0);
sun.position.set(6, 9, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -14;
sun.shadow.camera.right = 14;
sun.shadow.camera.top = 14;
sun.shadow.camera.bottom = -14;
sun.shadow.bias = -0.0007;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x9fb6cf, 0x2b2620, 0.3));

const ctx = {
  quality: { tier: 'ultra', textureSize: 1024, anisotropy: 16 },
  scene,
  camera,
  renderer,
  time: 0,
  textures: null,
};

// The material library degrades to its procedural fallback if this fails, so a
// broken texture system still leaves something to look at.
try {
  const mod = await import('../../assets/TextureFactory.js');
  await new mod.TextureFactory().init?.(ctx);
} catch (e) {
  console.warn('preview: texture factory unavailable', e.message);
}

const materials = new MaterialLibrary();
await materials.init(ctx);
materials.setWetness(WETNESS);
materials.updateEnv(env);

/**
 * `?flat=<key>` — the raw generated maps at 1:1, unlit, side by side: albedo,
 * ORM and normal. Lit geometry is the wrong tool for judging an atlas, where
 * what matters is tile registration and the padding at the tile borders, and
 * both are invisible once a slab has tiled the texture 1.6 times and lit it.
 */
const FLAT = params.get('flat');
if (FLAT) {
  const set = ctx.textures?.pbr(FLAT, { repeat: [1, 1] });
  ctx.textures?.update?.(0, ctx);
  const maps = [set?.map, set?.roughnessMap, set?.normalMap].filter(Boolean);
  const flatScene = new THREE.Scene();
  const flatCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 10);
  flatCam.position.z = 1;
  const n = Math.max(maps.length, 1);
  maps.forEach((t, i) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1 / n, 1 / n),
      new THREE.MeshBasicMaterial({ map: t, toneMapped: false })
    );
    m.position.set((i + 0.5) / n - 0.5, 0, 0);
    flatScene.add(m);
  });
  const aspect = () => innerWidth / innerHeight;
  const fit = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    flatCam.left = -0.5 * aspect() / n * n;
    flatCam.right = 0.5 * aspect() / n * n;
    flatCam.top = 0.5;
    flatCam.bottom = -0.5;
    flatCam.updateProjectionMatrix();
  };
  fit();
  addEventListener('resize', fit);
  renderer.setAnimationLoop(() => {
    ctx.time += 1 / 60;
    ctx.textures?.update?.(1 / 60, ctx);
    renderer.render(flatScene, flatCam);
    window.__PREVIEW_STATS__ = { calls: renderer.info.render.calls, tris: 0, programs: renderer.info.programs.length, programKeys: [] };
  });
  window.__PREVIEW__ = { materials, ctx, THREE };
  window.__PREVIEW_READY__ = true;
}

const keys = FLAT ? [] : ONLY ? [ONLY] : MATERIAL_KEYS;
const COLS = Math.min(keys.length, CLOSE ? 3 : 6);
const STEP = 2.4;

/** Box UVs are per-face 0..1; rescale so 1 UV unit equals 1 world metre. */
function worldScaleBoxUv(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const sizes = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = sizes[f];
    for (let i = f * 4; i < f * 4 + 4; i++) {
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

const slabGeo = worldScaleBoxUv(new THREE.BoxGeometry(1.6, 1.6, 0.35), 1.6, 1.6, 0.35);
const sphereGeo = new THREE.SphereGeometry(0.42, 48, 32);
{
  const uv = sphereGeo.attributes.uv;
  const c = 2 * Math.PI * 0.42;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * c, uv.getY(i) * c * 0.5);
  uv.needsUpdate = true;
}

const groundGeo = new THREE.PlaneGeometry(80, 80);
{
  const uv = groundGeo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 80, uv.getY(i) * 80);
  uv.needsUpdate = true;
}
const ground = new THREE.Mesh(groundGeo, materials.get('asphalt'));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1.05;
ground.receiveShadow = true;
scene.add(ground);

function label(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0)';
  g.clearRect(0, 0, 512, 96);
  g.font = '600 54px ui-monospace, monospace';
  g.fillStyle = '#eaf0f6';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.6, 0.3, 1);
  return s;
}

keys.forEach((key, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = (col - (COLS - 1) / 2) * STEP;
  const z = row * STEP;
  const mat = materials.get(key);

  const slab = new THREE.Mesh(slabGeo, mat);
  slab.position.set(x, 0, z);
  slab.castShadow = true;
  slab.receiveShadow = true;
  scene.add(slab);

  const ball = new THREE.Mesh(sphereGeo, mat);
  ball.position.set(x + 0.62, -0.62, z + 0.85);
  ball.castShadow = true;
  ball.receiveShadow = true;
  scene.add(ball);

  const l = label(key);
  l.position.set(x, -0.98, z + 0.9);
  scene.add(l);
});

const rows = Math.ceil(keys.length / Math.max(COLS, 1));
if (CLOSE) {
  camera.position.set(0, 0.6, 3.2);
  camera.lookAt(0, 0, 0);
} else {
  camera.position.set(0, 6.4, rows * STEP + 5.2);
  camera.lookAt(0, -0.4, (rows - 1) * STEP * 0.5);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const clock = new THREE.Clock();
if (!FLAT) renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  ctx.time += dt;
  ctx.textures?.update?.(dt, ctx);
  materials.update(dt, ctx);
  renderer.render(scene, camera);
  window.__PREVIEW_STATS__ = {
    calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    programs: renderer.info.programs.length,
    programKeys: renderer.info.programs.map((p) => p.cacheKey),
  };
});

window.__PREVIEW__ = { materials, scene, camera, renderer, ctx, THREE };
window.__PREVIEW_READY__ = true;
