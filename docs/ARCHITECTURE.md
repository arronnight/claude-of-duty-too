# Claude of Duty — Architecture Contract

**Read this before touching any file.** Every agent owns a disjoint set of files.
Do not edit files you do not own. If you need a behaviour from another
subsystem, call it through the `ctx` API defined here — do not import its module
directly and do not reach into its internals.

## Stack

- three.js **0.185.1** (ESM, `import * as THREE from 'three'`), Vite 8, no build step beyond Vite.
- WebGL2 only. Target: 60 fps at 1920x1080 on an Apple M2 / mid-range discrete GPU.
- **No external asset downloads.** Everything is procedurally generated at runtime
  (geometry, PBR textures, audio buffers) or authored as code. No CDN, no fetch to
  third-party hosts. This is a hard constraint — the game must run fully offline.
- Do not add npm dependencies. `three` and its `examples/jsm` modules are the whole toolbox.

## System lifecycle

A system is a class with any subset of these methods. `main.js` registers them in
dependency order; that order is fixed and you must not reorder it.

```js
export class MySystem {
  async init(ctx) {}                 // once, in registration order
  fixedUpdate(fixedDt, ctx) {}       // 120 Hz, for simulation
  update(dt, ctx) {}                 // once per frame
  lateUpdate(dt, ctx) {}             // after all update()s — rendering happens here
  resize(w, h, dpr, ctx) {}
  dispose() {}
}
```

## Registration order (fixed)

`textures → materials → render → sky → lighting → physics → level → props →
vegetation → fx → player → weapons → ai → audio → postfx → hud → debug`

## The `ctx` object

Provided by the engine before any `init`:

| key | type | notes |
|---|---|---|
| `ctx.engine` | `Engine` | `.stats`, `.paused`, `.timeScale`, `.get(name)` |
| `ctx.canvas` | `HTMLCanvasElement` | |
| `ctx.bus` | `EventBus` | `.on(type, fn)` / `.emit(type, payload)` |
| `ctx.input` | `Input` | `.action(name)`, `.actionPressed(name)`, `.mouse` |
| `ctx.scene` | `THREE.Scene` | the world |
| `ctx.camera` | `THREE.PerspectiveCamera` | player camera, driven by `player` |
| `ctx.quality` | object | `tier`, `maxDpr`, `shadowMapSize`, `cascades`, `ssao`, `ssr`, `volumetrics`, `taa`, `textureSize`, `anisotropy` |
| `ctx.dt` / `ctx.time` | number | seconds |

Published by systems during `init` (each row is a **contract you must honour**):

### `textures` → `ctx.textures` (owner: **texture agent**, `src/assets/**`)

```js
ctx.textures.pbr(name, opts) -> {
  map, normalMap, roughnessMap, metalnessMap, aoMap, displacementMap  // THREE.Texture | null
}
```
- `name` is one of the material keys listed in "Material keys" below.
- `opts`: `{ size?, repeat?: [u,v], anisotropy?, seed? }`.
- Textures are generated once and cached by `name+opts`. Generation must be GPU
  based (render-to-target with a fragment shader) or OffscreenCanvas — never a
  per-pixel JS loop over a 2048² buffer on the main thread during gameplay.
- Set `colorSpace = THREE.SRGBColorSpace` on albedo only; all others stay linear.
- Also exposes `ctx.textures.envMap` (a `THREE.Texture`, PMREM-filtered) once the
  sky system has published one; may be `null` before that.

### `materials` → `ctx.materials` (owner: **materials agent**, `src/render/Materials.js`)

```js
ctx.materials.get(key, overrides?) -> THREE.Material   // cached
ctx.materials.keys -> string[]
```
Materials must be physically plausible PBR (`MeshStandardMaterial` or
`MeshPhysicalMaterial`), pull their maps from `ctx.textures.pbr(key)`, and set
`envMapIntensity`. Never construct a material outside this file — call `get()`.

**Material keys** (the full set every other system may request):
`concrete_wall`, `concrete_floor`, `brick`, `plaster`, `stucco`, `asphalt`,
`asphalt_worn`, `dirt`, `gravel`, `sand`, `rubble`, `wood_plank`, `wood_painted`,
`plywood`, `metal_painted`, `metal_rusted`, `metal_corrugated`, `steel_brushed`,
`gun_metal`, `gun_polymer`, `gun_wood`, `glass`, `glass_broken`, `fabric_canvas`,
`sandbag`, `tile_roof`, `tarmac_line`, `rubber`, `foliage`, `bark`.

### `render` → `ctx.renderer`, `ctx.viewScene`, `ctx.viewCamera`

Already implemented. `viewScene`/`viewCamera` are the weapon viewmodel layer —
weapons render there, never in `ctx.scene`.

### `sky` → publishes (owner: **sky agent**, `src/render/Sky.js`)

```js
ctx.sky = {
  setTimeOfDay(t01),           // 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
  sunDirection: THREE.Vector3, // normalised, world space, kept current
  sunColor: THREE.Color,
  skyColor: THREE.Color,
  intensity: number,           // 0..1 daylight factor, drives lighting + HUD
  envMap: THREE.Texture,       // PMREM cubemap regenerated when TOD changes
}
```
Also sets `ctx.scene.environment` and `ctx.scene.background`. Must listen for the
`sky:timeOfDay` bus event. Aerial perspective / height fog belongs here.

### `lighting` → publishes (owner: **lighting agent**, `src/render/Lighting.js`)

```js
ctx.lighting = {
  sun: THREE.DirectionalLight,             // or CSM-managed set
  addPointLight(pos, color, intensity, radius) -> handle,
  addSpotLight(pos, dir, opts) -> handle,
  remove(handle),
  flashbang(worldPos, intensity),          // called by fx
}
```
Owns cascaded shadow maps (`ctx.quality.cascades`), light culling, and the
budget: **max 8 shadow-casting dynamic lights**. Reads `ctx.sky` for sun state.

### `physics` → publishes (owner: **physics agent**, `src/physics/**`)

```js
ctx.physics = {
  addStatic(mesh|geometry, transform) -> id,   // level geometry, called by level/props
  removeStatic(id),
  buildStaticBVH(),                            // called once after level+props init
  raycast(origin, dir, maxDist, mask?) -> { point, normal, distance, object, material } | null,
  sphereCast(origin, dir, radius, maxDist) -> hit | null,
  moveCharacter(capsule, velocity, dt) -> { position, grounded, normal, steppedUp, hitWall },
  addRigidBody(opts) -> body,                  // debris, casings, ragdolls
  step(dt),
}
```
`mask` is a bitfield: `1` world, `2` props, `4` characters, `8` debris.
Raycast must be BVH-accelerated — a naive `Raycaster` over the whole scene per
bullet is not acceptable.

### `level` → publishes (owner: **level agent**, `src/world/Level.js`)

```js
ctx.level = {
  root: THREE.Group,
  spawns: [{ position: Vector3, yaw: number, team: 'a'|'b' }],
  bounds: THREE.Box3,
  navPolys: [...],        // consumed by ai
  coverPoints: [{ position, normal, height: 'low'|'high' }],
  lightSpecs: [{ type, position, color, intensity, radius }],  // consumed by lighting
}
```

### `props`, `vegetation` — additive only

Add meshes under `ctx.level.root`, register colliders via `ctx.physics.addStatic`,
publish `ctx.props` / `ctx.vegetation` with a `root` group. Must use
`InstancedMesh` for anything appearing more than ~8 times.

### `fx` → publishes (owner: **fx agent**, `src/fx/**`)

```js
ctx.fx = {
  impact(point, normal, surfaceKey, energy),   // sparks/dust/debris + decal
  decal(point, normal, kind, size),
  tracer(from, to, speed),
  muzzleFlash(worldMatrix, scale),
  shellEject(worldMatrix, velocity, caliber),
  smoke(pos, opts), explosion(pos, radius), bloodHit(pos, normal, dir),
  screenShake(amount, duration), hitmarker(kind),
}
```
All particle systems must be pooled and instanced — zero per-frame allocation.

### `player` → publishes (owner: **player agent**, `src/player/**`)

```js
ctx.player = {
  position: Vector3, velocity: Vector3, yaw, pitch,
  stance: 'stand'|'crouch'|'prone'|'slide'|'mantle',
  sprinting, grounded, health, armour,
  eyeHeight, cameraRotation: Euler,
  applyRecoil(pitchKick, yawKick), damage(amount, fromDir),
  isADS: boolean,                 // written by weapons, read by player for FOV/sens
}
```
Owns `ctx.camera`. Must respect the `camera:override` bus event (used by the
screenshot harness) — when overridden, do not touch `ctx.camera` at all.

### `weapons` → publishes (owner: **weapons agent**, `src/weapons/**`)

```js
ctx.weapons = {
  current, loadout, switchTo(id), fire(), reload(), setADS(v), inspect(),
  getMuzzleWorldMatrix(), ammo: { mag, reserve },
}
```
Builds the viewmodel into `ctx.viewScene`. Calls `ctx.fx.*` and `ctx.physics.raycast`.

### `ai` → publishes (owner: **ai agent**, `src/ai/**`)

```js
ctx.ai = { bots: [], spawn(team, position), clear(), setDifficulty(0..1) }
```
Bot bodies are meshes in `ctx.scene` with `userData.hitboxes`.

### `audio` → publishes (owner: **audio agent**, `src/audio/**`)

```js
ctx.audio = { play(id, opts), playAt(id, worldPos, opts), setListener(camera), music(id), unlock() }
```
All sounds synthesised via WebAudio (no files). Must not throw before user gesture.

### `hud` → publishes (owner: **hud agent**, `src/ui/**`)

```js
ctx.hud = { setVisible(v), notify(text), killfeed(entry), damageIndicator(dir) }
```
Rendered as DOM/Canvas2D in `#ui-root`, never in the WebGL scene.

## Bus events

| event | payload | emitted by |
|---|---|---|
| `engine:ready` | ctx | engine |
| `engine:resize` | `{w,h,dpr}` | engine |
| `input:lock` | bool | input |
| `camera:override` | bool | harness → player |
| `sky:timeOfDay` | 0..1 | harness/ui → sky |
| `weapon:fired` | `{weapon, muzzle}` | weapons |
| `weapon:reload` | `{weapon, stage}` | weapons |
| `player:damaged` | `{amount, dir}` | player/ai |
| `bot:killed` | `{bot, by}` | ai |
| `fx:explosion` | `{pos, radius}` | fx |

## Automation surface (`window.__COD__`)

`main.js` exposes this for the screenshot harness. If your system needs to be
posed deterministically for a screenshot, add a method here — but keep it
side-effect-free when not called.

Required hooks (add these as you implement the owning system):
- `setCamera(pos, look, fov)` / `releaseCamera()` — done
- `setTimeOfDay(t)` — done
- `setViewmodelVisible(bool)` — **weapons agent adds**
- `setADS(bool)` — **weapons agent adds**
- `stageCombat()` — **ai agent adds**: spawn bots in view, trigger muzzle flashes/tracers, freeze for the shot

## Performance budget

| resource | budget |
|---|---|
| draw calls | ≤ 350 |
| triangles | ≤ 3.5 M |
| shader programs | ≤ 60 |
| frame time @1080p | ≤ 16.6 ms |
| texture memory | ≤ 700 MB |
| GC allocation in steady state | ~0 bytes/frame |

Pool everything. Reuse `Vector3`/`Quaternion` scratch objects at module scope.

## Verification

```bash
node tools/shoot.mjs --shots <name>,<name> --w 1920 --h 1080
```
Writes PNGs to `shots/` plus `shots/report.json` with fps, draw calls, and any
console errors. **A change is not done until this runs clean (`errors: []`) and
the screenshot looks right.**
