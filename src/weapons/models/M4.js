import * as THREE from 'three';
import {
  Part, chamferBox, chamferProfile, polyShape, lathe, cyl, tube, ring, sphere,
  picatinny, screw, knurled, curvedStack, countTris,
} from '../GunKit.js';

/**
 * M4A1 carbine viewmodel — the hero asset.
 *
 * Model space: -Z down the bore, +Y up, +X to the shooter's right, y = 0 on the
 * bore axis, z = 0 in the middle of the receiver.
 *
 * Every group returned in `parts` is animated independently by the rig, which
 * is why the weapon is *not* one fused mesh: the magazine leaves the magwell,
 * the bolt reciprocates in the ejection port, the trigger breaks, the selector
 * rotates, the charging handle is yanked on a bolt-catch reload.
 *
 * Real proportions throughout (14.5" barrel, 21.2 mm MIL-STD-1913 rail,
 * 66 mm optical axis over bore) because the sight-line solve in the rig reads
 * the model rather than an authored offset — get the geometry right and ADS
 * alignment is correct by construction.
 */

// Layout constants. Anything referenced twice lives here so the parts stay
// registered with each other when a dimension is tuned.
const UP_LEN = 0.184;        // upper receiver length
const UP_Z = -0.014;         // upper receiver centre
const UP_W = 0.0385;
const UP_H = 0.0405;
const UP_Y = 0.0015;
const CORE_W = 0.0330;       // inner core; the side walls stand proud of this
const WALL = (UP_W - CORE_W) / 2;
const RAIL_Y = UP_Y + UP_H / 2;              // 0.02175 — rail base sits here
const RAIL_TOP = RAIL_Y + 0.0042 + 0.0048;   // 0.0308
const OPTIC_Y = 0.0660;      // optical axis over bore, an Aimpoint on a riser
const OPTIC_Z = 0.0055;
const OPTIC_R = 0.0215;
const HG_Z0 = -0.108, HG_Z1 = -0.300;
const HG_R = 0.0218;
const MUZZLE_Z = -0.4555;
const PORT_Z0 = -0.052, PORT_Z1 = -0.006;
const MAG_TOP_Y = -0.0215;
const MAG_DEPTH = 0.0620;    // fore/aft: a 5.56 round is 57 mm long and lies in the mag
const MAG_Z = -0.0300;

export function buildM4(resolve) {
  const root = new THREE.Group();
  root.name = 'm4';
  const parts = {};
  const nodes = {};
  const P = (name) => {
    const p = new Part(name, resolve);
    parts[name] = p;
    return p;
  };

  // ---------------------------------------------------------------- receiver
  {
    const p = P('receiver');
    // Core body — narrower than the finished receiver so the side walls, and
    // therefore the ejection port cut, are genuine geometry rather than a decal.
    p.add('black', chamferBox(CORE_W, UP_H, UP_LEN, { r: 0.0125, bevel: 0.0016, curveSegments: 3 }), { y: UP_Y, z: UP_Z });

    // Left wall: solid full length.
    p.add('black', chamferBox(WALL * 2, UP_H - 0.003, UP_LEN - 0.004, { r: 0.0115, bevel: 0.0011 }), { x: -(CORE_W / 2 + WALL / 2) + 0.0004, y: UP_Y, z: UP_Z });
    // Right wall: four strips framing the ejection port.
    const rx = CORE_W / 2 + WALL / 2 - 0.0004;
    const frontLen = PORT_Z0 - (UP_Z - UP_LEN / 2);
    const rearLen = UP_Z + UP_LEN / 2 - PORT_Z1;
    p.add('black', chamferBox(WALL * 2, UP_H - 0.003, frontLen - 0.002, { r: 0.0115, bevel: 0.0011 }), { x: rx, y: UP_Y, z: PORT_Z0 - frontLen / 2 });
    p.add('black', chamferBox(WALL * 2, UP_H - 0.003, rearLen - 0.002, { r: 0.0115, bevel: 0.0011 }), { x: rx, y: UP_Y, z: PORT_Z1 + rearLen / 2 });
    p.add('black', chamferBox(WALL * 2, 0.0125, PORT_Z1 - PORT_Z0, { r: 0.001, bevel: 0.0008 }), { x: rx, y: 0.0142, z: (PORT_Z0 + PORT_Z1) / 2 });
    p.add('black', chamferBox(WALL * 2, 0.0110, PORT_Z1 - PORT_Z0, { r: 0.001, bevel: 0.0008 }), { x: rx, y: -0.0140, z: (PORT_Z0 + PORT_Z1) / 2 });

    // Flat-top rail.
    p.add('black', picatinny(UP_LEN - 0.010), { y: RAIL_Y, z: UP_Z });

    // Brass deflector, forward assist, port-cover detent, rear takedown lug.
    p.add('black', chamferProfile(polyShape([0, -0.008, 0.0085, -0.0015, 0.0085, 0.0055, 0, 0.010]), 0.017, { bevel: 0.0009 }), { x: 0.0185, y: 0.0035, z: 0.0055 });
    p.add('park', cyl(0.0058, 0.0062, 0.016, 12), { x: 0.0208, y: 0.0118, z: 0.0300, ry: Math.PI / 2 });
    p.add('park', cyl(0.0042, 0.0042, 0.005, 10), { x: 0.0290, y: 0.0118, z: 0.0300, ry: Math.PI / 2 });
    p.add('black', chamferBox(0.0072, 0.0072, 0.010, { r: 0.002, bevel: 0.0008 }), { x: 0.0175, y: -0.0165, z: -0.0035 });
    // Charging-handle housing at the rear.
    p.add('black', chamferBox(0.030, 0.0125, 0.014, { r: 0.003, bevel: 0.0010 }), { y: 0.0155, z: 0.0770 });
    // Barrel nut / delta ring at the front.
    p.add('park', knurled(0.0268, 0.0155, 22), { z: -0.1140, rx: Math.PI / 2 });
    p.add('black', cyl(0.0230, 0.0230, 0.008, 18), { z: -0.1040 });
    // Rear receiver-extension boss.
    p.add('black', cyl(0.0182, 0.0182, 0.012, 16), { z: 0.0810 });
    // Dust cover, hinged along the bottom of the port and hanging open, as it
    // is on any weapon that has been fired. Part of the receiver mesh: it does
    // not animate, and one 4 mm plate is not worth its own draw call.
    p.add('black', chamferBox(0.0038, 0.0215, 0.0470, { r: 0.0015, bevel: 0.0008 }), { x: 0.0235, y: -0.0230, z: -0.0290, rz: -0.62 });
    p.group.name = 'receiver';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------- lower
  {
    const p = P('lower');
    // Magwell. The depth is the number people get wrong: a STANAG magazine is a
    // *blade* — 26 mm across but 62 mm fore-and-aft, because a 5.56 cartridge is
    // 57 mm long and lies pointing down the bore. Modelled as a rod it reads as
    // a bottle hanging off the gun, which is exactly how the first pass looked.
    p.add('black', chamferBox(0.0335, 0.0570, MAG_DEPTH + 0.014, { r: 0.0055, bevel: 0.0013, curveSegments: 3 }), { y: -0.0480, z: MAG_Z });
    p.add('black', chamferBox(0.0385, 0.0105, MAG_DEPTH + 0.020, { r: 0.0048, bevel: 0.0016 }), { y: -0.0745, z: MAG_Z });
    // Rear body carrying the fire-control group, and the buffer tower.
    p.add('black', chamferBox(0.0365, 0.0300, 0.0760, { r: 0.0055, bevel: 0.0013 }), { y: -0.0330, z: 0.0450 });
    p.add('black', chamferProfile(polyShape([-0.020, -0.006, 0.014, -0.020, 0.026, 0.004, 0.026, 0.020, -0.020, 0.020]), 0.0345, { bevel: 0.0012 }), { y: -0.0100, z: 0.0680, ry: Math.PI / 2 });
    // Front lug / pivot pin boss.
    p.add('black', chamferBox(0.0300, 0.0250, 0.0200, { r: 0.0045, bevel: 0.0012 }), { y: -0.0270, z: -0.0850 });
    // Trigger guard: bottom bar plus front post, both with real chamfers.
    p.add('black', chamferBox(0.0105, 0.0062, 0.0500, { r: 0.0022, bevel: 0.0010 }), { y: -0.0800, z: 0.0330 });
    p.add('black', chamferBox(0.0105, 0.0320, 0.0062, { r: 0.0022, bevel: 0.0010 }), { y: -0.0650, z: 0.0100 });
    // Pistol grip, raked back 23 degrees, with three recessed finger grooves.
    p.add('polymer', chamferBox(0.0300, 0.1010, 0.0365, { r: 0.0062, bevel: 0.0018, curveSegments: 3 }), { y: -0.0975, z: 0.0680, rx: 0.40 });
    p.add('polymer', chamferBox(0.0330, 0.0085, 0.0395, { r: 0.0045, bevel: 0.0014 }), { y: -0.1450, z: 0.0880, rx: 0.40 });
    for (let i = 0; i < 3; i++) {
      p.add('void', cyl(0.0038, 0.0038, 0.0272, 8), { x: 0, y: -0.0700 - i * 0.0230, z: 0.0525 + i * 0.0100, ry: Math.PI / 2 });
    }
    // Stippled texture panel on the backstrap.
    p.add('void', chamferBox(0.0245, 0.0620, 0.0035, { r: 0.0012, bevel: 0.0008 }), { y: -0.0940, z: 0.0855, rx: 0.40 });
    // Beavertail behind the grip.
    p.add('polymer', chamferBox(0.0300, 0.0180, 0.0140, { r: 0.0055, bevel: 0.0012 }), { y: -0.0450, z: 0.0830, rx: 0.5 });
    // Magazine release with its fence, bolt catch, takedown pins.
    p.add('black', cyl(0.0072, 0.0072, 0.0075, 10), { x: 0.0196, y: -0.0300, z: MAG_Z + 0.026, ry: Math.PI / 2 });
    p.add('polymer', cyl(0.0046, 0.0046, 0.0125, 10), { x: 0.0215, y: -0.0300, z: MAG_Z + 0.026, ry: Math.PI / 2 });
    p.add('black', chamferBox(0.0060, 0.0155, 0.0300, { r: 0.0022, bevel: 0.0009 }), { x: -0.0202, y: -0.0290, z: MAG_Z + 0.030 });
    p.add('black', chamferBox(0.0048, 0.0100, 0.0105, { r: 0.0018, bevel: 0.0008 }), { x: -0.0218, y: -0.0330, z: MAG_Z + 0.020 });
    for (const z of [-0.0850, 0.0620]) {
      p.addMirrored('polymer', cyl(0.0040, 0.0040, 0.0032, 10), { x: 0.0192, y: z < 0 ? -0.0250 : -0.0245, z, ry: Math.PI / 2 });
    }
    p.group.name = 'lower';
    p.build();
    root.add(p.group);
  }

  // --------------------------------------------------------------- handguard
  {
    const p = P('handguard');
    const len = HG_Z1 - HG_Z0;
    const zc = (HG_Z0 + HG_Z1) / 2;
    // Eight panels around an octagon with real slots between them, rather than
    // one tube with painted-on M-LOK. In raking light the gaps read.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const w = i === 0 ? 0.0132 : 0.0142;
      p.add('black', chamferBox(w, 0.0052, Math.abs(len) - 0.004, { r: 0.0014, bevel: 0.0010 }), {
        x: HG_R * Math.sin(a), y: HG_R * Math.cos(a), z: zc, rz: -a,
      });
    }
    // Cross ribs tie the panels together and break the long silhouette.
    for (const z of [HG_Z0 - 0.012, zc, HG_Z1 + 0.014]) {
      p.add('black', ring(HG_R - 0.0012, 0.0030, 18, 5), { z });
    }
    // Continuous top rail, co-planar with the receiver's.
    p.add('black', picatinny(Math.abs(len) - 0.012), { y: RAIL_Y, z: zc });
    // M-LOK slots: recessed dark plates, so the flanks read as cut rather than
    // printed. Three faces get them; the fourth carries the rail.
    for (let i = 0; i < 4; i++) {
      const z = HG_Z0 - 0.030 - i * 0.044;
      p.addMirrored('void', chamferBox(0.0032, 0.0090, 0.0300, { r: 0.0012, bevel: 0.0008 }), { x: HG_R - 0.0024, y: 0, z });
      p.add('void', chamferBox(0.0090, 0.0032, 0.0300, { r: 0.0012, bevel: 0.0008 }), { y: -(HG_R - 0.0024), z });
    }
    // End cap and a short 3-o'clock accessory rail section.
    p.add('black', ring(HG_R - 0.0008, 0.0038, 18, 6), { z: HG_Z1 - 0.002 });
    p.add('black', picatinny(0.052, { pitch: 0.0102 }), { x: HG_R - 0.0016, y: 0, z: HG_Z1 + 0.048, rz: -Math.PI / 2 });
    // Anti-rotation screws along the top edge.
    for (let i = 0; i < 4; i++) p.addMirrored('black', screw(0.0019, 0.0010), { x: 0.0128, y: 0.0170, z: HG_Z0 - 0.028 - i * 0.048, rz: 0.5 });
    p.group.name = 'handguard';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------ barrel
  {
    const p = P('barrel');
    p.add('park', lathe([
      [0.0148, -0.0980], [0.0148, -0.1180], [0.0118, -0.1210], [0.0118, -0.2560],
      [0.0094, -0.2600], [0.0094, -0.3480], [0.0088, -0.3520], [0.0088, -0.4020],
      [0.0108, -0.4040], [0.0108, -0.4055],
    ], 18), {});
    // Low-profile gas block plus the gas tube running back under the handguard.
    p.add('park', chamferBox(0.0205, 0.0240, 0.0330, { r: 0.0035, bevel: 0.0011 }), { y: 0.0038, z: -0.3160 });
    p.add('park', cyl(0.0026, 0.0026, 0.2000, 8), { y: 0.0136, z: -0.2180 });
    p.addMirrored('park', screw(0.0018, 0.0010), { x: 0.0102, y: 0.0038, z: -0.3080, rz: Math.PI / 2 });
    // A2-pattern birdcage: rear collar, six tines with real gaps, muzzle ring.
    p.add('park', cyl(0.0114, 0.0114, 0.0105, 14), { z: -0.4105 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const wide = Math.abs(Math.cos(a) + 1) < 0.001;
      p.add('park', chamferBox(wide ? 0.0090 : 0.0050, 0.0036, 0.0330, { r: 0.0011, bevel: 0.0008 }), {
        x: 0.0094 * Math.sin(a), y: 0.0094 * Math.cos(a), z: -0.4325, rz: -a,
      });
    }
    p.add('park', tube(0.0112, 0.0060, 0.0060, 16), { z: -0.4520 });
    p.group.name = 'barrel';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------- stock
  {
    const p = P('stock');
    p.add('park', cyl(0.0158, 0.0158, 0.1800, 16), { z: 0.1680 });
    p.add('park', knurled(0.0184, 0.0100, 20), { z: 0.0855, rx: Math.PI / 2 });
    // Six position detents along the underside of the buffer tube.
    for (let i = 0; i < 6; i++) p.add('park', chamferBox(0.0075, 0.0035, 0.0075, { r: 0.0010, bevel: 0.0007 }), { y: -0.0165, z: 0.1050 + i * 0.0230 });
    // Polymer stock body: main block, cheek comb, sloping toe.
    p.add('polymer', chamferBox(0.0440, 0.0520, 0.1160, { r: 0.0090, bevel: 0.0018, curveSegments: 3 }), { y: -0.0055, z: 0.2110 });
    p.add('polymer', chamferBox(0.0300, 0.0175, 0.1040, { r: 0.0065, bevel: 0.0015 }), { y: 0.0240, z: 0.2050 });
    p.add('polymer', chamferProfile(polyShape([-0.052, -0.030, 0.044, -0.052, 0.044, -0.016, -0.052, -0.010]), 0.0380, { bevel: 0.0014 }), { y: 0, z: 0.2320, ry: Math.PI / 2 });
    p.add('polymer', chamferBox(0.0225, 0.0130, 0.0320, { r: 0.0035, bevel: 0.0011 }), { y: -0.0375, z: 0.2470 });
    p.add('rubber', chamferBox(0.0465, 0.0800, 0.0150, { r: 0.0070, bevel: 0.0022 }), { y: -0.0040, z: 0.2810, rx: -0.10 });
    p.group.name = 'stock';
    p.build();
    root.add(p.group);
  }

  // ---------------------------------------------------------------- magazine
  {
    const p = P('magazine');
    // Polymer 30-round box, 12 degrees of curl, ribbed. Built downward from the
    // magwell mouth so the rig can slide it straight out along its own axis.
    p.add('polymer', curvedStack(0.0262, MAG_DEPTH, 0.1820, 0.20, 10, { taper: 0.035, r: 0.0032, gap: 0.0009 }), { y: MAG_TOP_Y, z: MAG_Z });
    // Floorplate.
    p.add('polymer', chamferBox(0.0300, 0.0115, MAG_DEPTH + 0.006, { r: 0.0030, bevel: 0.0013 }), { y: MAG_TOP_Y - 0.1862, z: MAG_Z + 0.0180, rx: 0.20 });
    p.add('polymer', chamferBox(0.0270, 0.0120, MAG_DEPTH - 0.002, { r: 0.0028, bevel: 0.0012 }), { y: MAG_TOP_Y - 0.0075, z: MAG_Z });
    // Witness holes and the moulded grip ribs down each flank.
    for (let i = 0; i < 4; i++) p.addMirrored('void', cyl(0.0024, 0.0024, 0.0035, 8), { x: 0.0130, y: MAG_TOP_Y - 0.052 - i * 0.032, z: MAG_Z - 0.020 + i * 0.0030, ry: Math.PI / 2 });
    for (let i = 0; i < 3; i++) p.addMirrored('void', chamferBox(0.0035, 0.0300, 0.0090, { r: 0.0012, bevel: 0.0008 }), { x: 0.0128, y: MAG_TOP_Y - 0.100, z: MAG_Z + 0.006 + i * 0.0135 });
    // A round visible at the feed lips.
    p.add('brass', cyl(0.0029, 0.0029, 0.0500, 10), { y: MAG_TOP_Y + 0.0055, z: MAG_Z - 0.004 });
    p.group.name = 'magazine';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------- optic
  {
    const p = P('optic');
    // Riser mount: base plate clamped to the rail, two side walls, cross bolt
    // with knurled thumb nuts.
    p.add('black', chamferBox(0.0270, 0.0075, 0.0510, { r: 0.0028, bevel: 0.0012 }), { y: RAIL_TOP + 0.0030, z: OPTIC_Z });
    p.addMirrored('black', chamferBox(0.0058, 0.0230, 0.0430, { r: 0.0024, bevel: 0.0011 }), { x: 0.0104, y: RAIL_TOP + 0.0180, z: OPTIC_Z });
    p.add('black', chamferBox(0.0250, 0.0130, 0.0330, { r: 0.0040, bevel: 0.0013 }), { y: OPTIC_Y - OPTIC_R - 0.0035, z: OPTIC_Z });
    p.addMirrored('steel', knurled(0.0072, 0.0055, 14), { x: 0.0165, y: RAIL_TOP + 0.0060, z: OPTIC_Z - 0.0120, rz: Math.PI / 2 });
    p.addMirrored('steel', knurled(0.0072, 0.0055, 14), { x: 0.0165, y: RAIL_TOP + 0.0060, z: OPTIC_Z + 0.0150, rz: Math.PI / 2 });

    // Tube: genuinely hollow, so the aperture shows the world through it rather
    // than a fake glass disc. The inner wall is real geometry and catches the
    // shading falloff a real tube has.
    p.add('black', tube(OPTIC_R, 0.0166, 0.0620, 26), { y: OPTIC_Y, z: OPTIC_Z });
    p.add('black', ring(OPTIC_R - 0.0010, 0.0026, 22, 6), { y: OPTIC_Y, z: OPTIC_Z - 0.0290 });
    p.add('black', ring(OPTIC_R - 0.0010, 0.0026, 22, 6), { y: OPTIC_Y, z: OPTIC_Z + 0.0290 });
    // Coated lens rims: a narrow annulus at each end, left open in the middle.
    p.add('lens', new THREE.RingGeometry(0.0136, 0.0165, 26, 1), { y: OPTIC_Y, z: OPTIC_Z - 0.0272, ry: Math.PI });
    p.add('lens', new THREE.RingGeometry(0.0136, 0.0165, 26, 1), { y: OPTIC_Y, z: OPTIC_Z + 0.0272 });
    // Turrets: elevation on top, windage right, battery cap left.
    p.add('black', cyl(0.0092, 0.0100, 0.0075, 12), { y: OPTIC_Y + OPTIC_R + 0.0020, z: OPTIC_Z + 0.0030, rx: Math.PI / 2 });
    p.add('steel', knurled(0.0078, 0.0085, 16), { y: OPTIC_Y + OPTIC_R + 0.0100, z: OPTIC_Z + 0.0030, rx: Math.PI / 2 });
    p.add('black', cyl(0.0092, 0.0100, 0.0075, 12), { x: OPTIC_R + 0.0020, y: OPTIC_Y, z: OPTIC_Z + 0.0030, rz: Math.PI / 2 });
    p.add('steel', knurled(0.0078, 0.0085, 16), { x: OPTIC_R + 0.0100, y: OPTIC_Y, z: OPTIC_Z + 0.0030, rz: Math.PI / 2 });
    p.add('black', knurled(0.0118, 0.0090, 22), { x: -(OPTIC_R + 0.0030), y: OPTIC_Y, z: OPTIC_Z - 0.0040, rz: Math.PI / 2 });
    // Brightness detents around the battery cap.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      p.add('steel', chamferBox(0.0022, 0.0016, 0.0026, { r: 0.0005, bevel: 0.0004 }), {
        x: -(OPTIC_R + 0.0082), y: OPTIC_Y + 0.0090 * Math.cos(a), z: OPTIC_Z - 0.0040 + 0.0090 * Math.sin(a), rz: Math.PI / 2,
      });
    }

    // The reticle. A sphere so it stays round from every angle; emissive lands
    // in the HDR viewmodel buffer, so bloom gives it the halo a real dot has.
    const dot = new THREE.Mesh(sphere(0.00125, 10), resolve('dot'));
    dot.name = 'reddot';
    dot.position.set(0, OPTIC_Y, OPTIC_Z - 0.0180);
    dot.frustumCulled = false;
    p.group.add(dot);
    nodes.reticle = dot;

    p.group.name = 'optic';
    p.build();
    root.add(p.group);
  }

  // -------------------------------------------------------- charging handle
  {
    const p = P('chargingHandle');
    p.add('black', chamferBox(0.0300, 0.0075, 0.0560, { r: 0.0022, bevel: 0.0010 }), { y: 0.0158, z: 0.0900 });
    p.add('black', chamferBox(0.0420, 0.0098, 0.0105, { r: 0.0026, bevel: 0.0011 }), { y: 0.0158, z: 0.1155 });
    p.add('black', chamferProfile(polyShape([0, -0.005, 0.020, -0.001, 0.020, 0.005, 0, 0.005]), 0.0110, { bevel: 0.0009 }), { x: -0.0245, y: 0.0158, z: 0.1120 });
    p.group.name = 'chargingHandle';
    p.build();
    p.group.position.set(0, 0, 0);
    root.add(p.group);
  }

  // ---------------------------------------------------------------- bolt
  {
    const p = P('bolt');
    // Only the right face is ever visible, through the port, but it has to
    // travel when the weapon cycles or the port reads as a sticker.
    p.add('steel', chamferBox(0.0070, 0.0165, 0.0480, { r: 0.0022, bevel: 0.0009 }), { x: 0.0142, y: 0.0005, z: -0.0290 });
    p.add('steel', cyl(0.0062, 0.0062, 0.0070, 10), { x: 0.0140, y: 0.0010, z: -0.0430, ry: Math.PI / 2 });
    p.group.name = 'bolt';
    p.build();
    root.add(p.group);
  }

  // ----------------------------------------------------------------- trigger
  {
    const p = P('trigger');
    p.add('steel', chamferProfile(polyShape([-0.003, 0.004, 0.004, 0.002, 0.005, -0.014, -0.001, -0.021, -0.006, -0.016, -0.006, 0.000]), 0.0075, { bevel: 0.0008, curveSegments: 2 }), { ry: Math.PI / 2 });
    p.group.name = 'trigger';
    p.build();
    p.group.position.set(0, -0.0505, 0.0135);
    root.add(p.group);
  }

  // ---------------------------------------------------------------- selector
  {
    const p = P('selector');
    p.add('black', cyl(0.0056, 0.0056, 0.0110, 12), { ry: Math.PI / 2 });
    p.add('black', chamferProfile(polyShape([-0.004, -0.0035, 0.020, -0.006, 0.024, 0.000, 0.020, 0.006, -0.004, 0.0035]), 0.0050, { bevel: 0.0008 }), { x: -0.0080, ry: Math.PI / 2, rz: -Math.PI / 2 });
    p.group.name = 'selector';
    p.build();
    p.group.position.set(-0.0180, -0.0250, 0.0345);
    root.add(p.group);
  }

  // -------------------------------------------------------------- sling mount
  {
    const p = P('slingMount');
    // QD socket on the stock, a loop on the handguard, and the sling webbing
    // stub — the detail that stops the weapon reading as a floating prop.
    p.add('steel', cyl(0.0062, 0.0062, 0.0070, 10), { x: -0.0225, y: 0.0000, z: 0.1960, ry: Math.PI / 2 });
    p.add('steel', ring(0.0090, 0.0018, 12, 5), { x: -0.0290, y: 0.0000, z: 0.1960, ry: Math.PI / 2 });
    p.add('steel', cyl(0.0052, 0.0052, 0.0060, 10), { x: -(HG_R + 0.0010), y: -0.0060, z: -0.2620, ry: Math.PI / 2 });
    p.add('steel', ring(0.0082, 0.0016, 12, 5), { x: -(HG_R + 0.0060), y: -0.0060, z: -0.2620, ry: Math.PI / 2 });
    p.add('sleeve', chamferBox(0.0230, 0.0032, 0.0500, { r: 0.0010, bevel: 0.0006 }), { x: -0.0330, y: -0.0180, z: 0.0400, rz: 0.30, ry: 0.10 });
    p.group.name = 'slingMount';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------- nodes
  nodes.sight = new THREE.Object3D();
  nodes.sight.position.set(0, OPTIC_Y, OPTIC_Z);
  root.add(nodes.sight);

  nodes.muzzle = new THREE.Object3D();
  nodes.muzzle.position.set(0, 0, MUZZLE_Z);
  root.add(nodes.muzzle);

  nodes.eject = new THREE.Object3D();
  nodes.eject.position.set(0.0215, 0.0020, -0.0250);
  nodes.eject.rotation.set(0, 0, -0.30);
  root.add(nodes.eject);

  nodes.magSocket = new THREE.Object3D();
  nodes.magSocket.position.set(0, MAG_TOP_Y - 0.095, MAG_Z);
  root.add(nodes.magSocket);

  // Where the hands grip: trigger hand on the pistol grip, support hand well
  // forward on the handguard, which is how a carbine is actually held.
  nodes.gripRear = new THREE.Object3D();
  nodes.gripRear.position.set(0, -0.0850, 0.0660);
  nodes.gripRear.rotation.set(0.40, 0, 0);
  root.add(nodes.gripRear);

  nodes.gripFront = new THREE.Object3D();
  nodes.gripFront.position.set(0, -0.0055, -0.2320);
  root.add(nodes.gripFront);

  return { root, parts, nodes, tris: countTris(root), magAxis: new THREE.Vector3(0, -1, 0.19).normalize() };
}
