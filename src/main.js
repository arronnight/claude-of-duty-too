import { Engine } from './core/Engine.js';
import { RenderSystem } from './render/Renderer.js';
import { PostFX } from './render/PostFX.js';
import { SkySystem } from './render/Sky.js';
import { LightingSystem } from './render/Lighting.js';
import { MaterialLibrary } from './render/Materials.js';
import { TextureFactory } from './assets/TextureFactory.js';
import { LevelSystem } from './world/Level.js';
import { PropSystem } from './world/Props.js';
import { VegetationSystem } from './world/Vegetation.js';
import { PhysicsSystem } from './physics/Physics.js';
import { PlayerSystem } from './player/Player.js';
import { WeaponSystem } from './weapons/WeaponSystem.js';
import { FXSystem } from './fx/FXSystem.js';
import { AISystem } from './ai/AISystem.js';
import { AudioSystem } from './audio/Audio.js';
import { HUDSystem } from './ui/HUD.js';
import { DebugSystem } from './core/Debug.js';

const canvas = document.getElementById('viewport');
const engine = new Engine(canvas);

// Order matters: earlier systems publish APIs on ctx that later ones consume.
engine.add('textures', new TextureFactory());
engine.add('materials', new MaterialLibrary());
engine.add('render', new RenderSystem());
engine.add('sky', new SkySystem());
engine.add('lighting', new LightingSystem());
engine.add('physics', new PhysicsSystem());
engine.add('level', new LevelSystem());
engine.add('props', new PropSystem());
engine.add('vegetation', new VegetationSystem());
engine.add('fx', new FXSystem());
engine.add('player', new PlayerSystem());
engine.add('weapons', new WeaponSystem());
engine.add('ai', new AISystem());
engine.add('audio', new AudioSystem());
engine.add('postfx', new PostFX());
engine.add('hud', new HUDSystem());
engine.add('debug', new DebugSystem());

await engine.init();
engine.start();

// Debug/automation surface used by tools/shoot.mjs and the visual critic loop.
//
// Assigned into whatever is already there rather than over it: systems attach
// their own hooks during init() (showTextureSheet, setWetness, lighting,
// postfx, ...), and replacing the object wholesale silently dropped every one
// of them. Each of those systems had independently grown a re-attach-on-update
// workaround for exactly this; merging removes the need for all of them.
const api = (window.__COD__ = window.__COD__ || {});
Object.assign(api, {
  engine,
  ctx: engine.ctx,
  THREE_READY: true,
  setCamera(pos, look, fov) {
    const cam = engine.ctx.camera;
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(look[0], look[1], look[2]);
    if (fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    engine.bus.emit('camera:override', true);
  },
  releaseCamera() { engine.bus.emit('camera:override', false); },
  setTimeOfDay(t) { engine.bus.emit('sky:timeOfDay', t); },
  pause(v = true) { engine.paused = v; },
});
Object.defineProperty(api, 'stats', {
  configurable: true,
  get() { return engine.stats; },
});
window.__READY__ = true;
