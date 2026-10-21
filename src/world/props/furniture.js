import * as THREE from 'three';
import {
  chamferBox, pipeGeo, corrugatedGeo, clothGeo, cableGeo, lumpGeo, projectUV, jitterColor,
  layFlat, shellGeo, SHELL_T, wearEdges, loftGeo,
} from './lib.js';
import { wallFalloff } from './layout.js';
import { placeVehicles } from './vehicle.js';
import { tintFor } from './overhead.js';

/**
 * Street furniture and hero props.
 *
 * Ground clutter fixes "the floor is bare"; this fixes "the street is a
 * corridor". What a reference frame actually has in it, in rough order of how
 * much each one carries a composition:
 *
 *   1. a burnt-out vehicle. This is the Call of Duty signature prop and it is
 *      built here with the details that make it read as *destroyed* rather than
 *      as a car model: collapsed suspension so the body sits on its rims, glass
 *      gone from every aperture, a door hanging open past its stop, the roof
 *      dished in, the bonnet sprung, and a soot gradient carried in the
 *      per-part vertex tint rather than in a texture.
 *   2. market stalls — bent tube frames under torn canvas, which is the
 *      silhouette that says "market district" faster than any amount of signage.
 *   3. the ordinary stuff that stops a pavement being a ramp: sandbag
 *      emplacements, oil drums, jersey barriers, a dumpster, pallets, crates,
 *      tyre stacks, gas bottles and jerry cans.
 *
 * Everything is placed against the site survey with an occupancy test, so
 * nothing lands inside a wall or on top of anything else, and everything
 * substantial hands back a low-poly collider box rather than putting its art
 * geometry into the BVH.
 */

const _c = new THREE.Color();
const _w = new THREE.Color();

/**
 * Exposed-substrate colours for `wearEdges`.
 *
 * A uniform chamfer still reads as CG. A chamfer whose bevel has RUBBED
 * THROUGH to whatever is underneath does not, because that is what every worn
 * object in a photograph looks like — the wear is on the edges, where a hand
 * or a boot or another crate touches it, and it is patchy rather than a
 * uniform outline.
 */
const WEAR = {
  paintedMetal: [0x7a5236, 0.55],
  galvanised: [0x8d9095, 0.35],
  paintedWood: [0x6a4d33, 0.60],
  concrete: [0xbdb6a8, 0.30],
};
function worn(geoIn, kind, rand) {
  const [col, amt] = WEAR[kind];
  return wearEdges(geoIn, col, amt, rand);
}

/**
 * A 205 litre drum: 0.572 dia x 0.851 tall, with the rolled chime that is the
 * one detail that says "oil drum" rather than "cylinder".
 *
 * 14 radial segments shows visible facets at 3 m — one flat is 128 mm across,
 * which at the brief's 4.4 mm per pixel is 29 px of dead-straight silhouette.
 * 20 brings it to 90 mm and it reads round.
 */
function drumGeo(open) {
  const g = new THREE.CylinderGeometry(0.286, 0.286, 0.851, 20, 5, open);
  scalePipeUV(g);
  return g;
}
function scalePipeUV(g) { projectUV(g); return g; }

/**
 * The EUR pallet, for real: 1200 x 800 x 144, three bottom deckboards, nine
 * blocks, five top deckboards with the two edge boards narrower than the three
 * inner ones. Seventeen parts against the old four, and the block-and-board
 * pattern is what makes a pallet instantly recognisable at a glance.
 */
const EUR = {
  botBoard: [1.200, 0.022, 0.100],
  block: [0.145, 0.100, 0.078],
  topEdge: [1.200, 0.022, 0.100],
  topInner: [1.200, 0.022, 0.145],
};

let G = null;
function geo() {
  if (G) return G;
  const cb = chamferBox;
  G = {
    // --- stall. 48.3 mm scaffold tube, which is what a market frame is
    // actually built from. The previous 100 mm OD was chosen to stop the frame
    // vanishing at 15 m, but the fix for a thin thing disappearing is more of
    // it, not a thicker one: six uprights, four top rails and a brace per side
    // read at range where one fat post does not.
    tube: pipeGeo(0.024, 1, 8, false),
    tubeAlong: pipeGeo(0.024, 1, 8, false).rotateZ(Math.PI / 2),
    counter: cb(1, 0.055, 1, 0.014),
    apron: cb(1, 0.52, 0.04, 0.014),
    leg: cb(0.07, 1, 0.07, 0.014),
    produce: new THREE.SphereGeometry(1, 8, 6),
    sackBody: (() => {
      // Hessian sack with the neck rolled down: r 0.22 at the base, in to 0.19
      // at the neck, 0.55 tall, with the roll as a widening at the lip.
      const pts = [];
      const prof = [[0.0, 0], [0.20, 0.0], [0.222, 0.10], [0.215, 0.30],
        [0.192, 0.46], [0.213, 0.52], [0.196, 0.56], [0.150, 0.545]];
      for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
      const g = new THREE.LatheGeometry(pts, 10);
      projectUV(g);
      return g;
    })(),
    grainCone: new THREE.ConeGeometry(0.15, 0.13, 9, 1, false),
    pan: pipeGeo(0.11, 0.022, 12, true, 0.006),
    chain: pipeGeo(0.005, 1, 4, false),
    board: cb(1, 0.14, 0.028, 0.010),
    signBoard: cb(0.42, 0.30, 0.022, 0.010),

    // --- generic
    drum: drumGeo(false),
    drumOpen: drumGeo(true),
    drumInner: pipeGeo(0.268, 0.80, 14, true, 0),
    chime: pipeGeo(0.300, 0.035, 20, true, 0.010),
    bung: pipeGeo(0.028, 0.014, 8, true, 0.004),
    bungSmall: pipeGeo(0.012, 0.014, 6, true, 0.003),
    bottle: pipeGeo(0.16, 0.62, 10, true, 0.07),
    jerry: cb(0.34, 0.46, 0.17, 0.035),
    bucket: pipeGeo(0.14, 0.28, 9, true, 0.03),

    // Crate: a solid box for the closed variety, plus the parts of the slatted
    // one. Daylight through the gaps between slats is the single strongest
    // "this is a real crate" cue there is, and you cannot fake it on a cuboid.
    crate: cb(0.66, 0.52, 0.48, 0.022),
    crateGroove: cb(0.68, 0.012, 0.50, 0.004),
    crateStile: cb(0.040, 0.52, 0.040, 0.008),
    crateSlatX: cb(0.62, 0.090, 0.018, 0.005),
    crateSlatZ: cb(0.018, 0.090, 0.44, 0.005),
    crateLid: cb(0.68, 0.024, 0.50, 0.008),
    rope: pipeGeo(0.010, 1, 4, false).rotateZ(Math.PI / 2),

    palletBoard: cb(EUR.botBoard[0], EUR.botBoard[1], EUR.botBoard[2], 0.005),
    palletInner: cb(EUR.topInner[0], EUR.topInner[1], EUR.topInner[2], 0.005),
    palletBlock: cb(EUR.block[0], EUR.block[1], EUR.block[2], 0.008),

    tyre: (() => {
      // The same lathe section the vehicle uses, scaled up to a truck tyre.
      const half = [[0.190, 0.115], [0.250, 0.115], [0.300, 0.104], [0.3175, 0.071], [0.3175, 0]];
      const pts = [];
      for (let i = half.length - 1; i >= 0; i--) pts.push(new THREE.Vector2(half[i][0], -half[i][1]));
      for (let i = 1; i < half.length; i++) pts.push(new THREE.Vector2(half[i][0], half[i][1]));
      const g = new THREE.LatheGeometry(pts, 16);
      projectUV(g);
      return g;
    })(),
    tread: cb(0.075, 0.20, 0.014, 0.004),

    sack: lumpGeo(0.5, 0.16, [1.0, 0.42, 0.62], 1, 5),
    barrier: (() => {
      // Jersey profile: wide splayed foot, waisted middle, narrow top.
      const shape = new THREE.Shape();
      const pts = [[-0.31, 0], [0.31, 0], [0.24, 0.09], [0.13, 0.34], [0.11, 0.82],
        [-0.11, 0.82], [-0.13, 0.34], [-0.24, 0.09]];
      shape.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
      shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: true, bevelSize: 0.016, bevelThickness: 0.016, bevelSegments: 1, steps: 1 });
      g.translate(0, 0, -0.5);
      projectUV(g);
      return g;
    })(),
    barrierSlot: cb(0.10, 0.06, 0.26, 0.012),
    barrierEnd: cb(0.34, 0.62, 0.05, 0.012),
    hazard: cb(0.13, 0.36, 0.012, 0.004),

    // --- skip. A 6-yard skip: 1.83 x 1.22 x 1.07 with the FRONT FACE RAKED
    // BACK 12 degrees, so the top opening is narrower than the base. That one
    // angle is the whole difference between a skip and a box.
    skipBody: (() => {
      // loftGeo mirrors each station about x = 0, so an asymmetric side
      // elevation cannot be authored as a profile. It can be authored as a
      // THIRD STATION instead: the body runs at full height to z = +0.383 and
      // then collapses to the base line by z = +0.61, and the span between
      // those two is the raked front face. 0.227 m of setback over 1.07 m of
      // height is 12 degrees, and it is the only reason this is a skip and not
      // a wheelie bin.
      const full = [[0.915, 0.0], [0.925, 0.36], [0.940, 0.74], [0.945, 1.07]];
      return loftGeo([
        { z: -0.610, pts: full },
        { z: 0.383, pts: full },
        { z: 0.610, pts: [[0.905, 0.0], [0.907, 0.03], [0.909, 0.055], [0.910, 0.08]] },
      ], 30);
    })(),
    skipLid: (() => {
      // A pressing, not a slab: a 3 cm bend across the middle.
      const g = new THREE.PlaneGeometry(0.92, 1.18, 4, 6);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = p.getX(i) / 0.92;
        p.setZ(i, -0.03 * (1 - 4 * u * u));
      }
      g.computeVertexNormals();
      return shellGeo(layFlat(g), 0.010);
    })(),
    skipSwage: cb(0.05, 1.00, 0.02, 0.006),
    skipAngle: cb(0.06, 1.07, 0.06, 0.008),
    skipHinge: pipeGeo(0.024, 1, 8, false).rotateZ(Math.PI / 2),
    forkPocket: cb(0.20, 0.14, 1.26, 0.010),
    castorPlate: cb(0.02, 0.13, 0.11, 0.004),
    castorWheel: pipeGeo(0.05, 0.045, 10, true, 0.010).rotateZ(Math.PI / 2),
    castorAxle: pipeGeo(0.010, 0.10, 5, false).rotateZ(Math.PI / 2),
    plug: pipeGeo(0.022, 0.02, 8, true, 0.004).rotateX(Math.PI / 2),

    sheet: shellGeo(layFlat(corrugatedGeo(1, 1, 10, 0.018)), 0.006),
    lump: lumpGeo(0.5, 0.45, [1, 0.6, 1], 1, 9),
    bag: lumpGeo(0.5, 0.28, [1, 0.85, 1], 1, 11),
    card: cb(0.62, 0.014, 0.46, 0.005),
  };
  // Edge wear, once, on the shared geometries. `wearEdges` reads the codEdge
  // attribute chamferBox writes and silently no-ops on anything else, so this
  // is safe to run over the whole table.
  for (const k of ['crate', 'crateStile', 'crateSlatX', 'crateSlatZ', 'crateLid',
    'palletBoard', 'palletInner', 'palletBlock', 'board', 'signBoard']) {
    worn(G[k], 'paintedWood', null);
  }
  for (const k of ['jerry', 'skipSwage', 'skipAngle', 'forkPocket', 'castorPlate']) {
    worn(G[k], 'paintedMetal', null);
  }
  worn(G.barrier, 'concrete', null);
  worn(G.barrierEnd, 'concrete', null);
  return G;
}

/** Records a coarse collider so the player is stopped by the art, not the BVH soup. */
function collide(out, w, h, d, x, y, z, yaw, surface) {
  out.push({ w, h, d, x, y, z, yaw, surface });
}

// -------------------------------------------------------------------- stall

/** Produce, and the one place in this street allowed a saturated accent. */
const PRODUCE = [0xd0651f, 0x9c2a20, 0x5d7a2a, 0xc9a227];
const BASE_SANDBAG = new THREE.Color(0x877a5c);
const BASE_METAL_PAINTED = new THREE.Color(0x59666b);

/**
 * Market stall: scaffold frame, ridged canopy, counter and goods.
 *
 * The old version was a table with one flat dark plane on four fat sticks.
 * Three things change that. The canopy gets a RIDGE, so it is two pitched
 * panels rather than one card lying on top of a frame. The frame goes from
 * four 100 mm posts to six 48 mm ones with rails all round and a brace per
 * side, which reads better at 20 m despite being a quarter of the mass,
 * because a viewer reads pattern before it can resolve thickness. And the
 * goods stop being two grey lumps: a produce pile, open sacks with a visible
 * cone of grain, things hanging at eye height off the top rail, and a brass
 * weighing pan, which is about forty triangles and one of the most instantly
 * readable objects it is possible to build.
 */
export function marketStall(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const w = 1.8 + rand() * 1.6;
  const d = 0.9 + rand() * 0.7;
  const h = 1.95 + rand() * 0.35;
  const counterY = 0.86 + rand() * 0.12;
  const lean = (rand() - 0.5) * 0.09;
  const tiltPost = (rand() * 6) | 0;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const put = (key, gm, ox, oy, oz, pitch, roll, sx, sy, sz, col, shadow = true) =>
    bs.addPitched(key, gm, x + ox * c + oz * s, y + oy, z - ox * s + oz * c,
      yaw, pitch, roll, sx, sy, sz, col, shadow);
  let n = 0;

  // --- Frame. Galvanised, so it separates from the ground instead of
  // disappearing into it the way a rusted frame does at this size.
  tintFor(_c, _w.set(0x9aa0a2), BASE_METAL_PAINTED, 2.6);
  const frame = _c.clone();
  let post = 0;
  for (const fx of [-0.5, 0, 0.5]) {
    for (const sz of [-1, 1]) {
      // 4 degrees on exactly one upright. A frame in which every member is
      // plumb is a CAD model; a frame in which every member is crooked is
      // noise. One is a stall someone has been knocking about for ten years.
      const bend = post === tiltPost ? 0.07 : lean * 0.25;
      put('metal_painted', g.tube, fx * w, h / 2, sz * d / 2, bend, bend * 0.6,
        1, h, 1, frame, true);
      post++; n++;
    }
  }
  for (const sz of [-1, 1]) {
    put('metal_painted', g.tubeAlong, 0, h, sz * d / 2, 0, 0, w * 1.03, 1, 1, frame, true);
    n++;
  }
  for (const sx of [-1, 1]) {
    put('metal_painted', g.tubeAlong, sx * w / 2, h, 0, Math.PI / 2, 0, d * 1.03, 1, 1, frame, true);
    n++;
    // One diagonal brace per side, which is what stops the frame reading as a
    // wireframe cube.
    const dl = Math.hypot(h * 0.55, d);
    put('metal_painted', g.tubeAlong, sx * w / 2, h * 0.72, 0,
      Math.PI / 2, Math.atan2(h * 0.55, d), dl, 1, 1, frame, false);
    n++;
  }
  const dw = Math.hypot(h * 0.5, w);
  put('metal_painted', g.tubeAlong, 0, h * 0.74, -d / 2, 0,
    Math.atan2(h * 0.5, w) * 0.0, Math.atan2(h * 0.5, w), dw, 1, 1, frame, false);
  n++;

  // --- Counter. The void under a stall must be dark or the whole thing
  // floats, so the apron and the underside carry a baked 0.35.
  jitterColor(_c, rand, 0.3, 0.09, 0.07);
  const wood = _c.clone();
  const dark = wood.clone().multiplyScalar(0.35);
  put('wood_plank', g.counter, 0, counterY, 0, 0, 0.01, w * 1.04, 1, d * 0.94, wood);
  put('wood_plank', g.apron, 0, counterY - 0.30, d * 0.44, 0, 0, w * 1.02, 1, 1, dark);
  put('wood_plank', g.counter, 0, counterY - 0.055, 0, 0, 0.01, w * 1.0, 1, d * 0.9, dark, false);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    put('wood_plank', g.leg, sx * w * 0.44, counterY / 2, sz * d * 0.38, 0, 0,
      1, counterY, 1, dark, false);
  }
  n += 7;

  // --- Goods on the counter: a produce pile in a shallow crate, plus sacks.
  const top = counterY + 0.028;
  const crateW = Math.min(0.62, w * 0.34);
  tintFor(_c, _w.set(0x8a7a5e), BASE_SANDBAG, 2.0);
  const boxTint = _c.clone();
  const px0 = (rand() - 0.5) * w * 0.34;
  put('wood_plank', g.crate, px0, top + 0.075, 0, 0, 0, crateW / 0.66, 0.30, 0.60, boxTint);
  n++;
  tintFor(_c, _w.set(PRODUCE[(rand() * PRODUCE.length) | 0]), BASE_SANDBAG, 3.0);
  const fruit = _c.clone();
  for (let i = 0; i < 14; i++) {
    const r = 0.045 + rand() * 0.025;
    const a = rand() * 6.2832, rr = rand();
    _c.copy(fruit).multiplyScalar(0.86 + rand() * 0.28);
    put('sandbag', g.produce,
      px0 + Math.cos(a) * rr * crateW * 0.36,
      top + 0.11 + (1 - rr) * 0.08 + rand() * 0.02,
      Math.sin(a) * rr * d * 0.16,
      0, 0, r, r * 0.88, r, _c, i < 5);
    n++;
  }
  for (let i = 0, k = 1 + ((rand() * 2) | 0); i < k; i++) {
    const ox = (rand() < 0.5 ? -1 : 1) * (0.28 + rand() * 0.3) * w * 0.5;
    jitterColor(_c, rand, 0.22, 0.10, 0.06);
    put('sandbag', g.sackBody, ox, top, (rand() - 0.5) * d * 0.2, 0, rand() * 3,
      1, 0.62 + rand() * 0.18, 1, _c, true);
    _c.multiplyScalar(1.18);
    put('sandbag', g.grainCone, ox, top + 0.36, 0, 0, rand() * 3, 0.9, 0.7, 0.9, _c, false);
    n += 2;
  }

  // --- Things hanging off the top rail at eye height. Vertical interest in
  // the exact band a first-person camera looks through.
  for (let i = 0, k = 3 + ((rand() * 4) | 0); i < k; i++) {
    const ox = (rand() - 0.5) * w * 0.9;
    const len = 0.15 + rand() * 0.15;
    _c.setRGB(0.55, 0.53, 0.5);
    put('rubber', g.chain, ox, h - len / 2, -d / 2, 0, 0, 1, len, 1, _c, false);
    tintFor(_c, _w.set(PRODUCE[(rand() * PRODUCE.length) | 0]), BASE_SANDBAG, 2.6);
    _c.multiplyScalar(0.8 + rand() * 0.3);
    const r = 0.055 + rand() * 0.045;
    put('sandbag', g.produce, ox, h - len - r * 0.9, -d / 2, 0, 0,
      r, r * 1.5, r, _c, false);
    n += 2;
  }

  // --- Brass weighing pan on three chains.
  if (rand() < 0.7) {
    const ox = (rand() - 0.5) * w * 0.5;
    tintFor(_c, _w.set(0xb08d3a), BASE_METAL_PAINTED, 3.0);
    const brass = _c.clone();
    put('metal_painted', g.pan, ox, h - 0.46, -d / 2 + 0.04, 0.06, 0, 1, 1, 1, brass, false);
    _c.setRGB(0.7, 0.68, 0.62);
    for (let k = 0; k < 3; k++) {
      const a = k * 2.094;
      put('rubber', g.chain, ox + Math.cos(a) * 0.09, h - 0.235, -d / 2 + 0.04 + Math.sin(a) * 0.09,
        0, 0, 1, 0.45, 1, _c, false);
    }
    n += 4;
  }

  // --- Price board leaning on a leg.
  if (rand() < 0.6) {
    jitterColor(_c, rand, 0.2, 0.05, 0.04);
    _c.multiplyScalar(0.55);
    put('wood_plank', g.signBoard, (rand() < 0.5 ? -1 : 1) * w * 0.44, 0.30, d * 0.5,
      -0.22, 0.06, 1, 1, 1, _c, false);
    n++;
  }

  // --- Canopy: a ridge pole and two pitched panels, plus a front valance.
  const pitch = 12 * Math.PI / 180 + (rand() - 0.5) * 0.1;
  const off = (rand() - 0.5) * 0.12;          // 3-9 degrees off square
  const ridgeY = h + 0.28;
  put('metal_painted', g.tubeAlong, 0, ridgeY, 0, 0, 0, w * 1.05, 1, 1, frame, false);
  n++;
  tintFor(_c, _w.set(rand() < 0.5 ? 0xc9bda4 : 0x8a6f52), new THREE.Color(0x7a7054), 1.8);
  const canvas = _c.clone();
  const panelD = Math.hypot(d / 2, ridgeY - h) * 1.06;
  for (const sz of [-1, 1]) {
    if (rand() < 0.25) continue;              // one stall in four has lost one
    const panel = shellGeo(layFlat(clothGeo(w * 1.06, panelD, 0.05, rand, 0.10)),
      SHELL_T.canvas);
    put('fabric_canvas', panel, 0, (ridgeY + h) / 2, sz * d * 0.26,
      sz * pitch, off, 1, 1, 1, canvas, true);
    n++;
  }
  // Valance across the front, torn along the bottom.
  const val = shellGeo(clothGeo(w * 1.05, 0.35, 0.03, rand, 0.24), SHELL_T.canvas);
  put('fabric_canvas', val, 0, h - 0.175, -d / 2 - 0.03, 0, off * 0.5, 1, 1, 1, canvas, true);
  n++;

  if (colliders) collide(colliders, w + 0.2, 1.0, d + 0.2, x, y + 0.5, z, yaw, 'wood_plank');
  return n;
}

/** A guy rope from a stall corner to a wall anchor, if there is a wall. */
function guyRope(bs, site, rand, x, y, z, h) {
  const d = site.distAt ? site.distAt(x, z) : 99;
  if (!(d > 0.5 && d < 4.2)) return 0;
  const i = site.cellAt ? site.cellAt(x, z) : -1;
  if (i < 0 || !site.wallN) return 0;
  const nx = site.wallN[i * 2], nz = site.wallN[i * 2 + 1];
  if (!nx && !nz) return 0;
  const a = { x, y: y + h, z };
  const b = { x: x - nx * d, y: y + h + 0.5 + rand() * 0.6, z: z - nz * d };
  _c.setRGB(0.85, 0.82, 0.74);
  bs.addMatrix('rubber', cableGeo(a, b, 0.05, 0.006, 8, 4), IDENTITY, _c, false);
  return 1;
}
const IDENTITY = new THREE.Matrix4();

// ------------------------------------------------------------------- others

function sandbagWall(bs, rand, x, y, z, yaw, len, rows, colliders) {
  const g = geo();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  let n = 0;
  const bagW = 0.52;
  const perRow = Math.max(2, Math.round(len / bagW));
  for (let r = 0; r < rows; r++) {
    const inset = r * 0.045;
    for (let i = 0; i < perRow - r; i++) {
      const ox = (i - (perRow - r - 1) / 2) * bagW + (r % 2 ? bagW * 0.5 : 0) * 0.4;
      const oy = 0.13 + r * 0.2;
      const oz = (rand() - 0.5) * 0.05;
      jitterColor(_c, rand, 0.24, 0.07, 0.09);
      bs.addPitched('sandbag', g.sack, x + ox * c + oz * s, y + oy, z - ox * s + oz * c,
        yaw + (rand() - 0.5) * 0.16, (rand() - 0.5) * 0.1, 0,
        1.02 + rand() * 0.14, 0.92 + rand() * 0.16, 0.9 - inset, _c, true);
      n++;
    }
  }
  if (colliders) collide(colliders, len, rows * 0.2 + 0.1, 0.55, x, y + (rows * 0.2) / 2, z, yaw, 'sandbag');
  return n;
}

/**
 * A 205 litre drum with the details that name it.
 *
 * The rolled top chime and two off-centre bungs are what a viewer actually
 * uses to identify an oil drum — take them away and it is a cylinder with
 * ribs. One in four is dented, one in six open-topped with a dark inner shell,
 * one in three tipped over.
 */
function oilDrum(bs, rand, x, y, z, tipped, colliders) {
  const g = geo();
  const key = rand() < 0.6 ? 'metal_rusted' : 'metal_painted';
  jitterColor(_c, rand, 0.3, 0.14, 0.05);
  const body = _c.clone();
  const open = rand() < 0.167;
  const dent = rand() < 0.25 ? 0.93 : 1;
  const yaw = rand() * 6.2832;
  let n = 0;
  const put = tipped
    ? (gm, oy, ox, oz, sx, sy, sz, col, sh) => bs.addPitched(key, gm,
      x + Math.cos(yaw) * oy + ox, y + 0.286 + oz, z + Math.sin(yaw) * oy,
      yaw, Math.PI / 2, 0, sx, sy, sz, col, sh)
    : (gm, oy, ox, oz, sx, sy, sz, col, sh) => bs.add(key, gm,
      x + ox, y + 0.4255 + oy, z + oz, 0, yaw, 0, sx, sy, sz, col, sh);

  put(open ? g.drumOpen : g.drum, 0, 0, 0, dent, 1, 1 / dent, body, true); n++;
  if (open) { _c.copy(body).multiplyScalar(0.25); put(g.drumInner, -0.02, 0, 0, dent, 1, 1 / dent, _c, false); n++; }
  _c.copy(body).multiplyScalar(1.06);
  for (const o of [0.408, -0.408, 0.16, -0.16]) {
    put(g.chime, o, 0, 0, dent, 1, 1 / dent, _c, false); n++;
  }
  if (!open) {
    _c.copy(body).multiplyScalar(0.8);
    put(g.bung, 0.428, 0.17, 0.06, 1, 1, 1, _c, false);
    put(g.bungSmall, 0.428, -0.13, -0.14, 1, 1, 1, _c, false);
    n += 2;
  }
  if (colliders) {
    if (tipped) collide(colliders, 0.62, 0.6, 0.92, x, y + 0.3, z, yaw, key);
    else collide(colliders, 0.62, 0.9, 0.62, x, y + 0.45, z, 0, key);
  }
  return n;
}

/**
 * The real EUR pattern: three bottom deckboards, nine blocks, five top
 * deckboards with the two edge boards at 100 mm and the three inner at 145.
 *
 * Seventeen chamfered boxes and about 750 triangles against the old
 * four-board version, all in the same bucket, so it costs nothing. The
 * block-and-board pattern is what a pallet IS — four parallel planks is a
 * duckboard.
 */
function palletStack(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const layers = 1 + ((rand() * 4) | 0);
  let n = 0;
  jitterColor(_c, rand, 0.3, 0.08, 0.06);
  const put = (gm, ox, oy, oz, ry, col, sh) => bs.addPitched('wood_plank', gm,
    x + ox * c + oz * s, y + oy, z - ox * s + oz * c, yaw + ry, 0, 0, 1, 1, 1, col, sh);
  for (let l = 0; l < layers; l++) {
    const y0 = 0.011 + l * 0.144;
    const j = (rand() - 0.5) * 0.16;
    const top = l === layers - 1;
    // 3 bottom deckboards across the 800 mm dimension.
    for (const oz of [-0.35, 0, 0.35]) put(g.palletBoard, 0, y0, oz, j, _c, false);
    // 9 blocks in a 3x3 grid.
    _c.multiplyScalar(0.9);
    for (const ox of [-0.5275, 0, 0.5275]) for (const oz of [-0.35, 0, 0.35]) {
      put(g.palletBlock, ox, y0 + 0.061, oz, j, _c, false);
    }
    _c.multiplyScalar(1.11);
    // 5 top deckboards: two narrow edges, three wide inners.
    put(g.palletBoard, 0, y0 + 0.122, -0.35, j, _c, top);
    put(g.palletBoard, 0, y0 + 0.122, 0.35, j, _c, top);
    for (const oz of [-0.183, 0, 0.183]) put(g.palletInner, 0, y0 + 0.122, oz, j, _c, top);
    n += 17;
  }
  if (colliders) collide(colliders, 1.25, layers * 0.144 + 0.05, 0.85, x, y + layers * 0.072, z, yaw, 'wood_plank');
  return n;
}

/**
 * Crates, the top 40% of them slatted.
 *
 * A solid cuboid is the problem: you cannot see through it, and daylight
 * between the slats is the strongest single "this is a real crate" cue there
 * is. Four corner stiles plus five slats a side is thirty parts and 700
 * triangles, in the bucket the solid crate was already using, so the whole
 * upgrade is free. The solid ones keep their box but get horizontal grooves.
 */
function crateStack(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const n0 = 1 + ((rand() * 3) | 0);
  let n = 0;
  for (let l = 0; l < n0; l++) {
    const ox = (rand() - 0.5) * 0.14, oz = (rand() - 0.5) * 0.14;
    const sc = 0.85 + rand() * 0.4;
    const spin = yaw + (rand() - 0.5) * 0.5;
    jitterColor(_c, rand, 0.3, 0.09, 0.07);
    const tint = _c.clone();
    const yy = y + 0.27 * sc + l * 0.53 * sc;
    const put = (gm, px, py, pz, col, sh) => bs.addPitched('wood_plank', gm,
      x + (ox + px) * c + (oz + pz) * s, yy + py, z - (ox + px) * s + (oz + pz) * c,
      spin, 0, 0, sc, sc, sc, col, sh);

    if (rand() < 0.4) {
      // Slatted.
      const missing = rand() < 0.33 ? (rand() * 5) | 0 : -1;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        put(g.crateStile, sx * 0.31 * sc, 0, sz * 0.22 * sc, tint, false);
        n++;
      }
      _c.copy(tint).multiplyScalar(1.05);
      for (let k = 0; k < 5; k++) {
        if (k === missing) continue;
        const py = (-0.2 + k * 0.102) * sc;
        for (const sz of [-1, 1]) { put(g.crateSlatX, 0, py, sz * 0.23 * sc, _c, k === 4); n++; }
        for (const sx of [-1, 1]) { put(g.crateSlatZ, sx * 0.32 * sc, py, 0, _c, false); n++; }
      }
      _c.copy(tint).multiplyScalar(0.86);
      put(g.crateLid, 0, 0.26 * sc, 0, _c, true);
      put(g.crateLid, 0, -0.26 * sc, 0, _c, false);
      n += 2;
    } else {
      put(g.crate, 0, 0, 0, tint, true);
      _c.copy(tint).multiplyScalar(0.72);
      for (let k = 0; k < 4; k++) { put(g.crateGroove, 0, (-0.18 + k * 0.12) * sc, 0, _c, false); n++; }
      n++;
    }
    // Two rope handles.
    _c.copy(tint).multiplyScalar(0.62);
    for (const sx of [-1, 1]) { put(g.rope, sx * 0.335 * sc, 0.05 * sc, 0, _c, false); n++; }
  }
  if (colliders) collide(colliders, 0.8, n0 * 0.53, 0.65, x, y + n0 * 0.27, z, yaw, 'wood_plank');
  return n;
}

/** Tyres on the vehicle's lathe section, with tread blocks. */
function tyreStack(bs, rand, x, y, z, colliders) {
  const g = geo();
  const n0 = 2 + ((rand() * 4) | 0);
  let n = 0;
  for (let l = 0; l < n0; l++) {
    const cx = x + (rand() - 0.5) * 0.07, cz = z + (rand() - 0.5) * 0.07;
    const cy = y + 0.118 + l * 0.225;
    const spin = rand() * 3;
    _c.setRGB(0.55 + rand() * 0.2, 0.54 + rand() * 0.2, 0.55 + rand() * 0.2);
    const tint = _c.clone();
    bs.add('rubber', g.tyre, cx, cy, cz, 0, spin, 0, 1, 1, 1, tint, true);
    n++;
    _c.copy(tint).multiplyScalar(1.08);
    for (let k = 0; k < 12; k++) {
      const a = spin + k * 0.5236;
      bs.add('rubber', g.tread, cx + Math.sin(a) * 0.317, cy, cz + Math.cos(a) * 0.317,
        0, a, 0, 1, 1, 1, _c, false);
      n++;
    }
  }
  if (colliders) collide(colliders, 0.66, n0 * 0.225 + 0.05, 0.66, x, y + n0 * 0.11, z, 0, 'rubber');
  return n;
}

/** Municipal skip colours — this is the one prop that is allowed to be loud. */
const SKIP_PAINT = [0x274a2c, 0x1f3d5c, 0x9a6b1d];

/**
 * A 6-yard skip.
 *
 * The old prop was a chamfered box with four ribs, and no amount of texture
 * makes a box into industrial equipment. What does: the raked front face (in
 * the loft, `geo().skipBody`), the two fork pockets running through the lower
 * body, the pressed swages instead of bolted-on bars, and the castors built as
 * a swivel yoke rather than a bare disc. Also colour — a real skip is a
 * saturated municipal green or blue with a metre of rust bleeding up from the
 * bottom, and every prop in this street is currently jittered around beige.
 */
function dumpster(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  tintFor(_c, _w.set(SKIP_PAINT[(rand() * SKIP_PAINT.length) | 0]), BASE_METAL_PAINTED, 2.4);
  const body = _c.clone();
  const dented = (rand() * 4) | 0;
  let n = 0;
  const put = (key, gm, ox, oy, oz, pitch, roll, sx, sy, sz, col, sh) =>
    bs.addPitched(key, gm, x + ox * c + oz * s, y + oy, z - ox * s + oz * c,
      yaw, pitch, roll, sx, sy, sz, col, sh);

  // Darkening up from the ground, baked into the vertex colour at merge time
  // so it costs nothing per frame. The brief called this rust bleed and the
  // mechanism is the contact ramp; on a saturated green skip the two read the
  // same way, which is that the bottom foot of it is filthy.
  bs.bed(y);
  put('metal_painted', g.skipBody, 0, 0, 0, 0, 0.006, 1, 1, 1, body, true); n++;
  bs.bed(null);

  // Corner angles and pressed swages.
  _c.copy(body).multiplyScalar(0.88);
  for (const sx of [-1, 1]) for (const oz of [-0.59, 0.42]) {
    put('metal_painted', g.skipAngle, sx * 0.90, 0.535, oz, 0, 0, 1, 1, 1, _c, false); n++;
  }
  _c.copy(body).multiplyScalar(1.08);
  for (let k = 0; k < 6; k++) {
    const oz = -0.5 + k * 0.19;
    for (const sx of [-1, 1]) {
      put('metal_painted', g.skipSwage, sx * 0.925, 0.52, oz, 0, 0, 1, 1, 1, _c, false); n++;
    }
  }
  // Fork pockets: the detail that reads instantly as plant, not furniture.
  _c.setRGB(0.20, 0.20, 0.21);
  for (const sx of [-1, 1]) {
    put('metal_painted', g.forkPocket, sx * 0.35, 0.34, 0, 0, 0, 1, 1, 1, _c, false); n++;
  }

  // Hinge tube along the rear top edge, and two lids: one thrown right back,
  // one nearly shut.
  _c.copy(body).multiplyScalar(0.8);
  put('metal_painted', g.skipHinge, 0, 1.09, -0.60, 0, 0, 1.84, 1, 1, _c, false); n++;
  const lidAngles = [rand() < 0.5 ? -1.745 : -0.05, -0.05];
  for (let i = 0; i < 2; i++) {
    const a = lidAngles[i];
    const sx = i ? 0.47 : -0.47;
    // Hinged on the rear edge, so the panel swings about z = -0.60.
    const oz = -0.60 + Math.cos(a) * 0.59;
    const oy = 1.09 + Math.sin(-a) * 0.59;
    put('metal_painted', g.skipLid, sx, oy, oz, a, 0.01, 1, 1, 1, body, true); n++;
  }
  _c.setRGB(0.45, 0.44, 0.43);
  put('metal_rusted', g.plug, 0.60, 0.13, 0.50, 0, 0, 1, 1, 1, _c, false); n++;

  // Castors as a swivel yoke.
  for (const sx of [-1, 1]) for (const oz of [-0.46, 0.40]) {
    _c.setRGB(0.38, 0.37, 0.38);
    for (const py of [-0.075, 0.075]) {
      put('metal_rusted', g.castorPlate, sx * 0.80 + py, 0.09, oz, 0, 0, 1, 1, 1, _c, false); n++;
    }
    put('metal_rusted', g.castorAxle, sx * 0.80, 0.055, oz, 0, 0, 1, 1, 1, _c, false); n++;
    _c.setRGB(0.28, 0.28, 0.29);
    put('rubber', g.castorWheel, sx * 0.80, 0.055, oz, 0, 0, 1, 1, 1, _c, false); n++;
  }
  void dented;

  // Overflow. A polythene bag is SHINY, and that specular is the entire reason
  // it reads as a bag rather than as a rock — so the bags go in metal_painted
  // (roughness 0.38, clearcoat 0.35) tinted almost black, not in wood_plank.
  for (let i = 0, k = 3 + ((rand() * 4) | 0); i < k; i++) {
    const ox = (rand() - 0.5) * 1.5, oz = (rand() - 0.5) * 0.8;
    _c.setRGB(0.14, 0.14, 0.15);
    put('metal_painted', g.bag, ox, 1.14 + rand() * 0.14, oz,
      (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5,
      0.34 + rand() * 0.24, 0.30, 0.34 + rand() * 0.2, _c, true);
    n++;
  }
  for (let i = 0, k = 2 + ((rand() * 2) | 0); i < k; i++) {
    jitterColor(_c, rand, 0.3, 0.10, 0.08);
    _c.multiplyScalar(0.85);
    put('wood_plank', g.card, (rand() - 0.5) * 1.4, 1.18 + rand() * 0.2, (rand() - 0.5) * 0.7,
      0.5 + rand() * 0.7, (rand() - 0.5) * 0.8, 1, 1, 1, _c, false);
    n++;
  }
  if (colliders) collide(colliders, 1.95, 1.25, 1.3, x, y + 0.62, z, yaw, 'metal_painted');
  return n;
}

/**
 * Jersey barrier. The waisted profile was already right; what was missing was
 * everything that says a run of them is a run — the joints between units and
 * the lifting slots in the top.
 */
function jersey(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const len = 1.6 + rand() * 1.2;
  jitterColor(_c, rand, 0.16, 0.03, 0.03);
  _c.multiplyScalar(1.06);
  const body = _c.clone();
  let n = 1;
  bs.addPitched('concrete_wall', g.barrier, x, y, z, yaw, 0, (rand() - 0.5) * 0.03,
    1, 1, len, body, true);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const put = (key, gm, ox, oy, oz, sx, sy, sz, col, sh) => bs.addPitched(key, gm,
    x + ox * c + oz * s, y + oy, z - ox * s + oz * c, yaw, 0, 0, sx, sy, sz, col, sh);
  // Two lifting slots recessed into the top.
  _c.copy(body).multiplyScalar(0.55);
  for (const oz of [-len * 0.26, len * 0.26]) {
    put('concrete_wall', g.barrierSlot, 0, 0.795, oz, 1, 1, 1, _c, false); n++;
  }
  // A recess on each end face, so a run shows a visible joint.
  for (const sz of [-1, 1]) {
    put('concrete_wall', g.barrierEnd, 0, 0.42, sz * (len / 2 - 0.025), 1, 1, 1, _c, false); n++;
  }
  // Hazard stripes on one in three.
  if (rand() < 0.34) {
    tintFor(_c, _w.set(0xd8a41c), new THREE.Color(0x9a958c), 1.9);
    for (let k = 0; k < 5; k++) {
      const oz = (k / 4 - 0.5) * len * 0.72;
      put('concrete_wall', g.hazard, 0.128, 0.50, oz, 1, 1, 1, _c, false); n++;
      put('concrete_wall', g.hazard, -0.128, 0.50, oz, 1, 1, 1, _c, false); n++;
    }
  }
  if (colliders) collide(colliders, 0.64, 0.86, len, x, y + 0.43, z, yaw, 'concrete_wall');
  return n;
}

function smallJunk(bs, rand, x, y, z, colliders) {
  const g = geo();
  const roll = rand();
  const yaw = rand() * 6.2832;
  if (roll < 0.3) {
    jitterColor(_c, rand, 0.3, 0.2, 0.02);
    bs.add('metal_painted', g.jerry, x, y + 0.23, z, 0, yaw, 0.04, 1, 1, 1, _c, true);
  } else if (roll < 0.55) {
    jitterColor(_c, rand, 0.26, 0.16, 0.02);
    bs.add('metal_painted', g.bottle, x, y + 0.31, z, 0, yaw, 0, 1, 1, 1, _c, true);
  } else if (roll < 0.8) {
    jitterColor(_c, rand, 0.34, 0.2, 0.02);
    bs.add('metal_painted', g.bucket, x, y + 0.14, z, (rand() - 0.5) * 2.4, yaw, 0, 1, 1, 1, _c, true);
  } else {
    jitterColor(_c, rand, 0.3, 0.08, 0.06);
    const w = 0.7 + rand() * 0.9;
    bs.addPitched('metal_corrugated', g.sheet, x, y + 0.03, z, yaw, 0.1, 0,
      w, 1, w * 0.7, _c, false);
  }
  void colliders;
  return 1;
}

// ------------------------------------------------------------------ placer

/**
 * Places the whole furniture set. Larger items are placed first so they get the
 * good spots, and each one claims its footprint so nothing grows out of it.
 *
 * @returns {{parts:number, colliders:any[], hotspots:{x:number,z:number,r:number}[]}}
 *   `hotspots` are the vehicles, for the decal pass to scorch the ground under.
 */
export function streetFurniture(ctx, site, bs, rand, density = 1, env = null) {
  geo();
  const colliders = [];
  const hotspots = [];
  let parts = 0;

  // Stalls and junk want the pavement edge.
  const edge = site.field((d, corner, surf, x, z, indoor) =>
    (d < 0.9 || d > 4.2 ? 0 : 1) * (wallFalloff(d, 2.4, 0.1) + (indoor ? 0.2 : 0)));
  const anywhere = site.field((d) => (d > 12 ? 0 : 1) * (wallFalloff(d, 3.0, 0.25)));

  /** Rejection-sampled placement with a footprint claim. */
  const spot = (field, r, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      const p = field.sample(rand);
      if (!p) return null;
      if (!site.free(p.x, p.z, r)) continue;
      site.occupy(p.x, p.z, r);
      return { x: p.x, y: p.y, z: p.z, nx: p.nx, nz: p.nz, dist: p.dist };
    }
    return null;
  };

  // --- 1. Vehicles, first, so they get the kerb before anything else claims
  // it. Deterministic placement along the street centreline rather than
  // rejection sampling: see `vehicle.placeVehicles` for why.
  const streetYaw = site.facades.length
    ? Math.atan2(site.facades[0].bx - site.facades[0].ax, site.facades[0].bz - site.facades[0].az)
    : 0;
  {
    const veh = env?.vehicles || bs;
    // props-core built the vehicles set with the default 45 m zone length.
    // Measured, that is 16 draws rather than the 4 this item is funded for:
    // two Z-zones times two shadow flags times two variants. Un-zoning it
    // costs nothing — there are seven cars in the map and they are spread over
    // 100 m of street, so a zone split culls almost nothing, while every split
    // multiplies bucket count directly. This is a field on the object
    // props-core handed us, not an edit to their file; flagged to them because
    // it contradicts the rationale in their comment.
    if (veh !== bs) veh.zoneLen = Infinity;
    const sets = { veh, rubber: bs, colliders };
    const v = placeVehicles(ctx, site, sets, rand, density);
    parts += v.parts;
    hotspots.push(...v.hotspots);
  }

  // --- 2. Market stalls along the pavement, facing the street.
  const stalls = Math.max(2, Math.round(6 * density));
  for (let i = 0; i < stalls; i++) {
    const p = spot(edge, 1.5, 50);
    if (!p) break;
    const yaw = (p.nx || p.nz) ? Math.atan2(p.nx, p.nz) : rand() * 6.2832;
    parts += marketStall(bs, rand, p.x, p.y, p.z, yaw + Math.PI / 2, colliders);
    if (rand() < 0.34) parts += guyRope(bs, site, rand, p.x, p.y, p.z, 2.1);
  }

  // --- 3. Sandbag emplacements at corners.
  const bags = Math.max(1, Math.round(4 * density));
  for (let i = 0; i < bags; i++) {
    const p = spot(edge, 1.6, 50);
    if (!p) break;
    const yaw = (p.nx || p.nz) ? Math.atan2(p.nx, p.nz) + Math.PI / 2 : rand() * 6.2832;
    parts += sandbagWall(bs, rand, p.x, p.y, p.z, yaw, 1.6 + rand() * 1.4, 3 + ((rand() * 2) | 0), colliders);
  }

  // --- 4. Jersey barriers, sometimes in a short run.
  const runs = Math.max(2, Math.round(5 * density));
  for (let i = 0; i < runs; i++) {
    const p = spot(anywhere, 1.4, 40);
    if (!p) break;
    const yaw = streetYaw + (rand() < 0.5 ? 0 : Math.PI / 2) + (rand() - 0.5) * 0.25;
    const n = 1 + ((rand() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 2.4;
      const bx = p.x + Math.sin(yaw) * off, bz = p.z + Math.cos(yaw) * off;
      if (site.groundAt(bx, bz) === null) continue;
      site.occupy(bx, bz, 1.1);
      parts += jersey(bs, rand, bx, p.y, bz, yaw + (rand() - 0.5) * 0.12, colliders);
    }
  }

  // --- 5. Dumpsters.
  for (let i = 0, k = Math.max(1, Math.round(2 * density)); i < k; i++) {
    const p = spot(edge, 1.5, 40);
    if (!p) break;
    parts += dumpster(bs, rand, p.x, p.y, p.z,
      (p.nx || p.nz) ? Math.atan2(p.nx, p.nz) + Math.PI / 2 : rand() * 6.2832, colliders);
  }

  // --- 6. The ordinary stuff.
  const drums = Math.round(14 * density);
  for (let i = 0; i < drums; i++) {
    const p = spot(edge, 0.55, 24);
    if (!p) continue;
    parts += oilDrum(bs, rand, p.x, p.y, p.z, rand() < 0.28, colliders);
  }
  for (let i = 0, k = Math.round(7 * density); i < k; i++) {
    const p = spot(edge, 0.85, 24);
    if (!p) continue;
    parts += palletStack(bs, rand, p.x, p.y, p.z, rand() * 6.2832, colliders);
  }
  for (let i = 0, k = Math.round(11 * density); i < k; i++) {
    const p = spot(edge, 0.7, 24);
    if (!p) continue;
    parts += crateStack(bs, rand, p.x, p.y, p.z, rand() * 6.2832, colliders);
  }
  for (let i = 0, k = Math.round(7 * density); i < k; i++) {
    const p = spot(edge, 0.6, 24);
    if (!p) continue;
    parts += tyreStack(bs, rand, p.x, p.y, p.z, colliders);
  }
  for (let i = 0, k = Math.round(24 * density); i < k; i++) {
    const p = spot(edge, 0.35, 16);
    if (!p) continue;
    parts += smallJunk(bs, rand, p.x, p.y, p.z, colliders);
  }

  return { parts, colliders, hotspots };
}

export { geo as furnitureGeo };
