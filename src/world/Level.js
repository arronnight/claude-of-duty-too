import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Greybox map — a street corridor with flanking blocks and one enterable room.
 *
 * Still a blockout, and the level agent replaces it wholesale, but it is a
 * *contract-complete* blockout: it publishes every field `docs/ARCHITECTURE.md`
 * promises (`bounds`, `spawns`, `lightSpecs`, `coverPoints`, `navPolys`) and it
 * registers its own colliders through `ctx.physics.addStatic`. Those fields are
 * what the lighting system's fixture pass, the cascade fit and the player spawn
 * actually run on — without them three integration paths are dead code that has
 * never once executed against real data.
 *
 * The layout is aligned to the screenshot presets in `tools/shoot.mjs`: the
 * street runs down -Z so `street`/`night` look along it, the room at x -14..-8
 * is where the `interior` camera stands, and the block heights are staggered so
 * `skyline` has something to frame.
 *
 * Box geometry carries 0..1 UVs per face, which cannot honour the material
 * library's "1 UV unit = 1 metre" convention — the alternative the library
 * offers is `{ triplanar: true }`, and that is what this file used to do. It
 * was costing three texture fetches per map per pixel on every surface in the
 * frame (measured: 14 ms of a 21 ms budget). `worldUV` rewrites each face's UVs
 * to metres instead, so the boxes satisfy the convention directly and the
 * cheaper single-projection path compiles.
 */

const STREET_HALF = 7;      // metres from centreline to kerb
const KERB_HEIGHT = 0.16;
const LAMP_SPACING = 15;

const _box = new THREE.Vector3();

/**
 * Rewrites a box's UVs from 0..1-per-face to metres, so 1 UV unit = 1 metre and
 * the material library's per-key `repeat` lands the tile at its authored
 * physical size. Faces are identified by their normal, which BoxGeometry
 * provides per-vertex and axis-aligned, so each face picks the two world axes it
 * actually spans.
 * @param {THREE.BufferGeometry} geo
 */
function worldUV(geo) {
  geo.computeBoundingBox();
  geo.boundingBox.getSize(_box);
  const uv = geo.attributes.uv;
  const nrm = geo.attributes.normal;
  if (!uv || !nrm) return geo;
  const size = [_box.x, _box.y, _box.z];
  for (let i = 0; i < uv.count; i++) {
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    // Dominant axis -> the two axes the face spans. Y-facing quads take X/Z.
    let su, sv;
    if (ax > ay && ax > az) { su = size[2]; sv = size[1]; }
    else if (ay > az) { su = size[0]; sv = size[2]; }
    else { su = size[0]; sv = size[1]; }
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
  return geo;
}

/** BoxGeometry with metre-scaled UVs. */
function box(w, h, d) {
  return worldUV(new THREE.BoxGeometry(w, h, d));
}

export class LevelSystem {
  async init(ctx) {
    const root = new THREE.Group();
    root.name = 'Level';
    this.root = root;
    this.ctx = ctx;

    /** @type {THREE.Mesh[]} meshes handed to physics once the tree is built. */
    this._solid = [];
    this.lightSpecs = [];
    this.coverPoints = [];

    this._buildGround(ctx);
    this._buildBlocks(ctx);
    this._buildRoom(ctx);
    this._buildStreetFurniture(ctx);

    ctx.scene.add(root);

    // The ground plane is 150 m of mostly nothing, so the bounds are the
    // playable shell rather than `setFromObject` — the cascade fit reads this,
    // and a 150 m sphere would spend every shadow texel on empty tarmac.
    const bounds = new THREE.Box3(
      new THREE.Vector3(-46, 0, -52),
      new THREE.Vector3(46, 22, 46)
    );

    ctx.level = {
      root,
      bounds,
      spawns: [
        { position: new THREE.Vector3(2.2, 0, 22), yaw: Math.PI, team: 'a' },
        { position: new THREE.Vector3(-2.4, 0, -34), yaw: 0, team: 'b' },
        { position: new THREE.Vector3(-11, 0, -6), yaw: Math.PI * 0.5, team: 'a' },
        { position: new THREE.Vector3(9, 0, -20), yaw: Math.PI * 1.25, team: 'b' },
      ],
      lightSpecs: this.lightSpecs,
      coverPoints: this.coverPoints,
      // One convex quad per open area, CCW, `y` = floor height. The AI agent
      // replaces this with a real navmesh; it exists so `ctx.level.navPolys` is
      // never undefined at the point the AI system first reads it.
      navPolys: [
        { y: 0, points: [[-STREET_HALF, 30], [STREET_HALF, 30], [STREET_HALF, -44], [-STREET_HALF, -44]] },
        { y: 0, points: [[-14, -1], [-8.4, -1], [-8.4, -11], [-14, -11]] },
      ],
      // Legacy field the scaffold exposed; kept so anything already reading it
      // does not start seeing undefined mid-wave.
      colliders: this._solid,
    };

    this._registerColliders(ctx);
  }

  // --------------------------------------------------------------- geometry

  /** @returns {THREE.Mesh} */
  _add(geo, key, pos, opts = {}) {
    // No `triplanar` override: `worldUV` already put the UVs in metres, so the
    // library's own per-key projection choice is the right one.
    const mat = this.ctx.materials.get(key, opts.overrides);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (opts.rotY) mesh.rotation.y = opts.rotY;
    mesh.castShadow = opts.castShadow !== false;
    mesh.receiveShadow = true;
    // Read by physics at BVH build time so a bullet impact knows what it hit.
    mesh.userData.surface = opts.surface || key;
    if (opts.noCollide) mesh.userData.noCollide = true;
    else this._solid.push(mesh);
    this.root.add(mesh);
    return mesh;
  }

  _buildGround(ctx) {
    // This used to be 400 x 400. Its rim landed at 200 m, where the aerial
    // perspective has only reached 55% opacity, so 45% of the plate's own dark
    // value survived and it drew a hard horizontal band with clean sky above
    // it — the "world ends here" line across establishing.png. It also spent
    // 93% of its rasterised pixels outside anything the player can reach, and
    // at grazing angles the far half of it read as a sheet of wet mirror.
    //
    // 150 x 150 instead, and the ground beyond it is sky/Backdrop.js's shell at
    // y = -0.08. The plate stays at y = -0.02 so the two are never coincident;
    // its edge midpoints sit at 75 m and its corners at 106 m, both outside the
    // shell's r = 74 inner rim, so the plate always overhangs and hides the
    // seam. Do NOT restore the 400 m plane alongside the shell: two materials
    // at one height draw a visible 200 m square outline.
    const planeGeo = new THREE.PlaneGeometry(150, 150);
    planeGeo.attributes.uv.array.forEach((_, i, a) => { a[i] *= 150; });
    planeGeo.attributes.uv.needsUpdate = true;
    const plane = new THREE.Mesh(planeGeo, ctx.materials.get('asphalt_worn'));
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.02;
    plane.receiveShadow = true;
    plane.castShadow = false;
    plane.userData.surface = 'asphalt_worn';
    this.root.add(plane);
    this._solid.push(plane);

    this._add(box(STREET_HALF * 2, 0.1, 110), 'asphalt', [0, 0.03, -8], {
      castShadow: false, surface: 'asphalt',
    });

    // Granite setts, not poured concrete. `concrete_floor`'s generator cuts
    // control joints on a half-tile rectangular grid, and that grid is the
    // repeating panel pattern visible on the pavements in establishing.png —
    // the single most machine-made surface in the frame. Gated so a half-landed
    // wave (or a materials rollback) still boots on the old key.
    const kerbKey = ctx.materials.keys?.includes('paver') ? 'paver' : 'concrete_floor';
    for (const sx of [-1, 1]) {
      this._add(box(4.4, KERB_HEIGHT, 110), kerbKey,
        [sx * (STREET_HALF + 2.2), KERB_HEIGHT / 2, -8], { castShadow: false, surface: kerbKey });
    }
  }

  /** Flanking blocks. Heights are staggered so the skyline reads as a street. */
  _buildBlocks() {
    // [ z-depth, height, z-centre, material key ]
    const WEST = [
      [16, 13.5, 12, 'concrete_wall'],
      [12, 9.0, -3, 'brick'],
      [14, 17.0, -19, 'concrete_wall'],
      [11, 7.5, -33, 'plaster'],
    ];
    const EAST = [
      [13, 10.5, 16, 'brick'],
      [15, 15.5, 1, 'concrete_wall'],
      [12, 8.0, -14, 'plaster'],
      [16, 19.0, -30, 'concrete_wall'],
    ];
    const WIDTH = 15;

    for (const [side, list] of [[-1, WEST], [1, EAST]]) {
      for (const [depth, height, z, key] of list) {
        // The room occupies the west block at z = -3; leave that footprint open.
        if (side === -1 && z === -3) continue;
        const x = side * (STREET_HALF + 4.4 + WIDTH / 2);
        this._add(box(WIDTH, height, depth), key, [x, height / 2, z], { surface: key });

        // A parapet reads as a roofline instead of a cut-off box.
        this._add(box(WIDTH + 0.5, 0.9, depth + 0.5), 'concrete_wall',
          [x, height + 0.45, z], { surface: 'concrete_wall' });

        this.coverPoints.push({
          position: new THREE.Vector3(x - side * (WIDTH / 2 + 0.6), 0.9, z + depth / 2 - 1),
          normal: new THREE.Vector3(-side, 0, 0),
          height: 'high',
        });
      }
    }
  }

  /**
   * The one interiorable volume: a 6 x 10.8 m room on the west side with a
   * street-facing doorway. The `interior` screenshot preset stands at its centre.
   */
  _buildRoom() {
    const X0 = -14.4, X1 = -8.4;      // west wall .. street-facing wall
    const Z0 = -11.4, Z1 = -0.6;
    const H = 3.4;
    const cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
    const w = X1 - X0, d = Z1 - Z0;
    const T = 0.35;

    this._add(box(w, 0.12, d), 'concrete_floor', [cx, 0.06, cz],
      { castShadow: false, surface: 'concrete_floor' });
    this._add(box(w + T * 2, 0.3, d + T * 2), 'plaster', [cx, H + 0.15, cz],
      { surface: 'plaster' });
    this._add(box(T, H, d), 'plaster', [X0 - T / 2, H / 2, cz], { surface: 'plaster' });
    for (const z of [Z0 - T / 2, Z1 + T / 2]) {
      this._add(box(w + T * 2, H, T), 'plaster', [cx, H / 2, z], { surface: 'plaster' });
    }

    // Street-facing wall, split around a 2.6 m doorway so daylight, the sky
    // probe and the player can all get in.
    const doorW = 2.6, pier = (d - doorW) / 2;
    for (const s of [-1, 1]) {
      this._add(box(T, H, pier), 'brick',
        [X1 + T / 2, H / 2, cz + s * (doorW / 2 + pier / 2)], { surface: 'brick' });
    }
    this._add(box(T, H - 2.35, doorW), 'brick', [X1 + T / 2, H - (H - 2.35) / 2, cz],
      { surface: 'brick' });

    // Mass above the room, so it reads as a floor of a building and not a shed.
    //
    // This used to be a 15 x 12 m slab centred at z = -3, i.e. spanning
    // x[-26.4,-11.4] z[-9,3] with its underside at y = 3.70 — over a room that
    // only reaches x[-14.4,-8.4] z[-11.4,-0.6]. About 86% of it, including a
    // 12 m clear span westward, stood on nothing, and in combat.png you could
    // see the horizon straight through the gap underneath it. A building whose
    // upper storey hovers is the single most disqualifying thing in the frame:
    // it says "untextured blockout" before the critic has looked at anything.
    //
    // The fix is structural rather than cosmetic. The slab's depth now matches
    // the room's z extent exactly (10.8 m at z = -6.0), and the ground floor
    // *behind* the room — x[-26.4,-14.4], the building interior that was never
    // modelled because the street never sees into it — is filled solid up to
    // the slab's underside. Every square metre of the upper storey now lands on
    // either that mass or the room's own roof slab.
    //
    // Both parts are merged into ONE BufferGeometry and one mesh, so closing a
    // 12 m hole in the world costs zero extra draw calls. `box()` has already
    // put metre-scaled UVs on each part, and translating a geometry does not
    // disturb them, so the merged L still tiles at its authored size.
    const upperY = H + 0.3 + 2.8;              // 6.50 -> underside at 3.70
    const massX = -(STREET_HALF + 4.4 + 7.5);  // -18.90, the block footprint
    const upper = box(15, 5.6, 10.8).translate(massX, upperY, -6.0);
    // Ground floor behind the room: x -26.40 .. -14.40, up to the slab soffit.
    const infill = box(12, 3.7, 10.8).translate(massX - 1.5, 1.85, -6.0);
    this._add(mergeGeometries([upper, infill], false), 'concrete_wall', [0, 0, 0],
      { surface: 'concrete_wall' });
    upper.dispose(); infill.dispose();

    // A crate and a low wall: something for contact shadows and bounce to land on.
    this._add(box(1.1, 1.1, 1.1), 'wood_plank', [X0 + 1.5, 0.67, Z0 + 2.2],
      { rotY: 0.34, surface: 'wood_plank' });
    this._add(box(2.4, 0.95, 0.5), 'concrete_wall', [cx + 1.2, 0.6, Z1 - 2.4],
      { surface: 'concrete_wall' });

    this.coverPoints.push({
      position: new THREE.Vector3(cx + 1.2, 0.95, Z1 - 2.4),
      normal: new THREE.Vector3(0, 0, 1), height: 'low',
    });

    this.lightSpecs.push(
      { type: 'point', position: new THREE.Vector3(cx, H - 0.45, cz + 2.4), color: 0xffd9a8, intensity: 3.2, radius: 7 },
      { type: 'point', position: new THREE.Vector3(cx, H - 0.45, cz - 3.0), color: 0xffd0a0, intensity: 2.2, radius: 6 }
    );
  }

  /** Street lamps, barriers, and the light specs the lighting system consumes. */
  _buildStreetFurniture() {
    const lampGeo = new THREE.CylinderGeometry(0.09, 0.13, 6.4, 8);
    const armGeo = box(1.5, 0.14, 0.14);
    const headGeo = box(0.7, 0.22, 0.34);

    for (let i = 0; i < 6; i++) {
      const z = 24 - i * LAMP_SPACING;
      const side = i % 2 === 0 ? -1 : 1;
      const x = side * (STREET_HALF + 0.9);
      // Cylinder UVs are 0..1 around the barrel, so this one keeps triplanar.
      this._add(lampGeo, 'metal_painted', [x, 3.2, z], {
        surface: 'metal_painted', overrides: { triplanar: true },
      });
      this._add(armGeo, 'metal_painted', [x - side * 0.75, 6.3, z], { surface: 'metal_painted', noCollide: true });
      this._add(headGeo, 'metal_painted', [x - side * 1.45, 6.16, z], { surface: 'metal_painted', noCollide: true });

      // Sodium street lighting: the warm cast is most of what sells a night map.
      this.lightSpecs.push({
        type: 'lamp',
        position: new THREE.Vector3(x - side * 1.45, 6.0, z),
        color: 0xffb15e,
        intensity: 5.5,
        radius: 16,
      });
    }

    // Jersey barriers: low cover, and something for contact shadows on the road.
    const barrier = box(0.62, 0.9, 2.4);
    for (const [x, z] of [[-3.4, 4], [3.6, -6], [-4.2, -22], [4.4, -28], [1.2, 12]]) {
      this._add(barrier, 'concrete_wall', [x, 0.51, z], { rotY: (x + z) * 0.07, surface: 'concrete_wall' });
      this.coverPoints.push({
        position: new THREE.Vector3(x, 0.9, z), normal: new THREE.Vector3(0, 0, 1), height: 'low',
      });
    }
  }

  // --------------------------------------------------------------- physics

  /**
   * The contract puts collider registration on the level, not on physics. Doing
   * it here also cancels the physics fallback that would otherwise adopt the
   * entire scene graph, lamp arms and parapets included.
   */
  _registerColliders(ctx) {
    const phys = ctx.physics;
    if (!phys?.addStatic) return;
    this.staticIds = [];
    for (const mesh of this._solid) {
      const id = phys.addStatic(mesh, undefined, { material: mesh.userData.surface });
      if (id > 0) this.staticIds.push(id);
    }
    phys.buildStaticBVH?.();
  }

  dispose() {
    this.root?.removeFromParent();
  }
}
