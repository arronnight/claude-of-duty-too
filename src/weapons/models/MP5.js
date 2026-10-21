import * as THREE from 'three';
import {
  Part, chamferBox, chamferProfile, polyShape, lathe, cyl, tube, ring, sphere,
  picatinny, screw, knurled, curvedStack, countTris,
} from '../GunKit.js';

/**
 * MP5A5 — roller-delayed 9 mm SMG.
 *
 * Same conventions and same part vocabulary as the M4 so the rig can drive
 * either without special cases. What makes it read as an MP5 rather than a
 * short M4: the stamped receiver with its swaged flutes, the cocking-handle
 * tube riding above the barrel on the left, the deep curved magazine ahead of
 * the trigger group, the slim tri-lug handguard and the drum rear sight.
 */

const RAIL_Y = 0.0212;
const RAIL_TOP = RAIL_Y + 0.0090;
const OPTIC_Y = 0.0640;
const OPTIC_Z = -0.0060;
const OPTIC_R = 0.0205;
const MUZZLE_Z = -0.2620;
const MAG_TOP_Y = -0.0215;

export function buildMP5(resolve) {
  const root = new THREE.Group();
  root.name = 'mp5';
  const parts = {};
  const nodes = {};
  const P = (n) => { const p = new Part(n, resolve); parts[n] = p; return p; };

  // ---------------------------------------------------------------- receiver
  {
    const p = P('receiver');
    const CORE_W = 0.0300, UP_W = 0.0360, UP_H = 0.0420, UP_Y = -0.0015;
    const LEN = 0.1900, ZC = 0.0050;
    const WALL = (UP_W - CORE_W) / 2;
    const PZ0 = -0.0480, PZ1 = -0.0100;
    p.add('black', chamferBox(CORE_W, UP_H, LEN, { r: 0.0115, bevel: 0.0015, curveSegments: 3 }), { y: UP_Y, z: ZC });
    p.add('black', chamferBox(WALL * 2, UP_H - 0.003, LEN - 0.004, { r: 0.0105, bevel: 0.0010 }), { x: -(CORE_W / 2 + WALL / 2) + 0.0003, y: UP_Y, z: ZC });
    // Right wall framing the ejection port.
    const rx = CORE_W / 2 + WALL / 2 - 0.0003;
    const fl = PZ0 - (ZC - LEN / 2), rl = ZC + LEN / 2 - PZ1;
    p.add('black', chamferBox(WALL * 2, UP_H - 0.003, fl - 0.002, { r: 0.0105, bevel: 0.0010 }), { x: rx, y: UP_Y, z: PZ0 - fl / 2 });
    p.add('black', chamferBox(WALL * 2, UP_H - 0.003, rl - 0.002, { r: 0.0105, bevel: 0.0010 }), { x: rx, y: UP_Y, z: PZ1 + rl / 2 });
    p.add('black', chamferBox(WALL * 2, 0.0135, PZ1 - PZ0, { r: 0.001, bevel: 0.0007 }), { x: rx, y: 0.0125, z: (PZ0 + PZ1) / 2 });
    p.add('black', chamferBox(WALL * 2, 0.0125, PZ1 - PZ0, { r: 0.001, bevel: 0.0007 }), { x: rx, y: -0.0145, z: (PZ0 + PZ1) / 2 });
    // Swaged reinforcement flutes down each flank — the MP5's signature.
    for (let i = 0; i < 4; i++) {
      p.addMirrored('black', chamferBox(0.0040, 0.0075, 0.0190, { r: 0.0012, bevel: 0.0008 }), { x: UP_W / 2 - 0.0010, y: -0.0100, z: 0.0500 + i * 0.0245 });
    }
    // Cocking-handle tube above the barrel, on the left.
    p.add('black', cyl(0.0118, 0.0118, 0.1500, 14), { x: -0.0128, y: 0.0175, z: -0.1650 });
    p.add('black', chamferBox(0.0160, 0.0180, 0.0300, { r: 0.0035, bevel: 0.0011 }), { x: -0.0090, y: 0.0130, z: -0.0980 });
    // Top rail and the drum rear sight behind it.
    p.add('black', picatinny(0.1650), { y: RAIL_Y, z: -0.0100 });
    p.add('park', knurled(0.0130, 0.0110, 16), { y: RAIL_Y + 0.0110, z: 0.0870, rx: Math.PI / 2 });
    // Front sight hood.
    p.add('park', ring(0.0135, 0.0022, 14, 5), { y: 0.0170, z: -0.2320 });
    p.add('park', chamferBox(0.0022, 0.0110, 0.0035, { r: 0.0006, bevel: 0.0005 }), { y: 0.0135, z: -0.2320 });
    p.add('black', chamferBox(0.0250, 0.0090, 0.0130, { r: 0.0025, bevel: 0.0010 }), { y: 0.0230, z: -0.2320 });
    p.group.name = 'receiver';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------- lower
  {
    const p = P('lower');
    // Polymer trigger group / grip in one moulding, as on the real weapon.
    p.add('polymer', chamferBox(0.0360, 0.0430, 0.0920, { r: 0.0070, bevel: 0.0016, curveSegments: 3 }), { y: -0.0410, z: 0.0560 });
    p.add('polymer', chamferBox(0.0310, 0.0920, 0.0390, { r: 0.0105, bevel: 0.0018, curveSegments: 3 }), { y: -0.0900, z: 0.0800, rx: 0.30 });
    p.add('polymer', chamferBox(0.0335, 0.0080, 0.0410, { r: 0.0050, bevel: 0.0014 }), { y: -0.1330, z: 0.0932, rx: 0.30 });
    p.add('polymer', chamferBox(0.0110, 0.0060, 0.0430, { r: 0.0022, bevel: 0.0010 }), { y: -0.0700, z: 0.0350 });
    p.add('polymer', chamferBox(0.0110, 0.0290, 0.0060, { r: 0.0022, bevel: 0.0010 }), { y: -0.0570, z: 0.0155 });
    // Magazine housing ahead of the trigger group.
    p.add('black', chamferBox(0.0330, 0.0330, 0.0430, { r: 0.0050, bevel: 0.0013 }), { y: -0.0330, z: -0.0480 });
    p.add('black', chamferBox(0.0375, 0.0080, 0.0470, { r: 0.0040, bevel: 0.0014 }), { y: -0.0490, z: -0.0480 });
    // Paddle magazine release behind the housing.
    p.add('black', chamferBox(0.0055, 0.0210, 0.0100, { r: 0.0018, bevel: 0.0008 }), { x: -0.0180, y: -0.0330, z: -0.0230, rz: 0.16 });
    p.add('steel', cyl(0.0044, 0.0044, 0.0110, 10), { x: 0.0190, y: -0.0300, z: -0.0230, ry: Math.PI / 2 });
    // Push pins holding the stock and trigger group.
    for (const z of [0.0170, 0.1030]) p.addMirrored('steel', cyl(0.0038, 0.0038, 0.0030, 10), { x: 0.0182, y: -0.0250, z, ry: Math.PI / 2 });
    p.group.name = 'lower';
    p.build();
    root.add(p.group);
  }

  // --------------------------------------------------------------- handguard
  {
    const p = P('handguard');
    p.add('polymer', chamferProfile(polyShape([
      -0.0195, 0.0060, -0.0135, 0.0175, 0.0135, 0.0175, 0.0195, 0.0060,
      0.0165, -0.0175, -0.0165, -0.0175,
    ]), 0.1330, { bevel: 0.0018, curveSegments: 2 }), { y: -0.0020, z: -0.1650 });
    // Cooling slots along the flanks — real recesses between raised ribs.
    for (let i = 0; i < 5; i++) {
      p.addMirrored('polymer', chamferBox(0.0045, 0.0130, 0.0150, { r: 0.0014, bevel: 0.0009 }), { x: 0.0185, y: -0.0030, z: -0.1150 - i * 0.0215 });
    }
    p.add('polymer', ring(0.0180, 0.0035, 14, 5), { z: -0.2300 });
    p.add('polymer', ring(0.0195, 0.0035, 14, 5), { z: -0.1030 });
    p.group.name = 'handguard';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------ barrel
  {
    const p = P('barrel');
    p.add('park', lathe([
      [0.0135, -0.0850], [0.0135, -0.1000], [0.0092, -0.1030], [0.0092, -0.2330],
      [0.0112, -0.2360], [0.0112, -0.2560], [0.0086, -0.2580], [0.0086, -0.2620],
    ], 16), {});
    // Three-lug muzzle collar.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      p.add('park', chamferBox(0.0055, 0.0038, 0.0140, { r: 0.0010, bevel: 0.0007 }), { x: 0.0122 * Math.sin(a), y: 0.0122 * Math.cos(a), z: -0.2470, rz: -a });
    }
    p.group.name = 'barrel';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------- stock
  {
    const p = P('stock');
    // A5 retractable: two steel rails and a folding butt plate.
    p.addMirrored('park', cyl(0.0062, 0.0062, 0.1450, 10), { x: 0.0178, y: -0.0060, z: 0.1750 });
    p.add('black', chamferBox(0.0450, 0.0180, 0.0140, { r: 0.0035, bevel: 0.0012 }), { y: -0.0060, z: 0.1130 });
    p.add('black', chamferBox(0.0460, 0.0620, 0.0130, { r: 0.0055, bevel: 0.0018 }), { y: -0.0050, z: 0.2450, rx: -0.06 });
    p.add('rubber', chamferBox(0.0430, 0.0570, 0.0075, { r: 0.0045, bevel: 0.0015 }), { y: -0.0050, z: 0.2530, rx: -0.06 });
    p.add('black', chamferBox(0.0300, 0.0130, 0.0250, { r: 0.0030, bevel: 0.0011 }), { y: -0.0230, z: 0.2320 });
    p.group.name = 'stock';
    p.build();
    root.add(p.group);
  }

  // ---------------------------------------------------------------- magazine
  {
    const p = P('magazine');
    p.add('black', curvedStack(0.0270, 0.0255, 0.1900, 0.30, 9, { taper: 0.04, r: 0.0055, gap: 0.0007 }), { y: MAG_TOP_Y, z: -0.0480 });
    p.add('black', chamferBox(0.0310, 0.0100, 0.0300, { r: 0.0035, bevel: 0.0013 }), { y: MAG_TOP_Y - 0.1930, z: -0.0200, rx: 0.30 });
    p.add('black', chamferBox(0.0295, 0.0120, 0.0280, { r: 0.0035, bevel: 0.0012 }), { y: MAG_TOP_Y - 0.0070, z: -0.0480 });
    p.add('brass', cyl(0.0046, 0.0046, 0.0250, 10), { y: MAG_TOP_Y + 0.0050, z: -0.0480 });
    p.group.name = 'magazine';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------- optic
  {
    const p = P('optic');
    p.add('black', chamferBox(0.0270, 0.0075, 0.0480, { r: 0.0028, bevel: 0.0012 }), { y: RAIL_TOP + 0.0030, z: OPTIC_Z });
    p.addMirrored('black', chamferBox(0.0058, 0.0210, 0.0400, { r: 0.0024, bevel: 0.0011 }), { x: 0.0104, y: RAIL_TOP + 0.0170, z: OPTIC_Z });
    p.add('black', chamferBox(0.0240, 0.0125, 0.0310, { r: 0.0040, bevel: 0.0013 }), { y: OPTIC_Y - OPTIC_R - 0.0035, z: OPTIC_Z });
    p.addMirrored('steel', knurled(0.0070, 0.0052, 14), { x: 0.0160, y: RAIL_TOP + 0.0058, z: OPTIC_Z - 0.0110, rz: Math.PI / 2 });
    p.add('black', tube(OPTIC_R, 0.0158, 0.0580, 26), { y: OPTIC_Y, z: OPTIC_Z });
    p.add('black', ring(OPTIC_R - 0.0010, 0.0024, 22, 6), { y: OPTIC_Y, z: OPTIC_Z - 0.0272 });
    p.add('black', ring(OPTIC_R - 0.0010, 0.0024, 22, 6), { y: OPTIC_Y, z: OPTIC_Z + 0.0272 });
    p.add('lens', new THREE.RingGeometry(0.0130, 0.0157, 26, 1), { y: OPTIC_Y, z: OPTIC_Z - 0.0255, ry: Math.PI });
    p.add('lens', new THREE.RingGeometry(0.0130, 0.0157, 26, 1), { y: OPTIC_Y, z: OPTIC_Z + 0.0255 });
    p.add('black', cyl(0.0088, 0.0096, 0.0070, 12), { y: OPTIC_Y + OPTIC_R + 0.0020, z: OPTIC_Z + 0.0030, rx: Math.PI / 2 });
    p.add('steel', knurled(0.0074, 0.0080, 16), { y: OPTIC_Y + OPTIC_R + 0.0095, z: OPTIC_Z + 0.0030, rx: Math.PI / 2 });
    p.add('black', knurled(0.0112, 0.0085, 20), { x: -(OPTIC_R + 0.0028), y: OPTIC_Y, z: OPTIC_Z - 0.0040, rz: Math.PI / 2 });

    const dot = new THREE.Mesh(sphere(0.00125, 10), resolve('dot'));
    dot.name = 'reddot';
    dot.position.set(0, OPTIC_Y, OPTIC_Z - 0.0170);
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
    p.add('park', cyl(0.0090, 0.0090, 0.0180, 12), { x: -0.0128, y: 0.0175, z: -0.2250 });
    p.add('park', chamferBox(0.0230, 0.0110, 0.0130, { r: 0.0030, bevel: 0.0011 }), { x: -0.0230, y: 0.0175, z: -0.2250 });
    p.add('park', chamferBox(0.0060, 0.0110, 0.0110, { r: 0.0022, bevel: 0.0010 }), { x: -0.0330, y: 0.0175, z: -0.2250, rz: -0.25 });
    p.group.name = 'chargingHandle';
    p.build();
    root.add(p.group);
  }

  // -------------------------------------------------------------------- bolt
  {
    const p = P('bolt');
    p.add('steel', chamferBox(0.0060, 0.0150, 0.0360, { r: 0.0020, bevel: 0.0009 }), { x: 0.0132, y: -0.0010, z: -0.0280 });
    p.group.name = 'bolt';
    p.build();
    root.add(p.group);
  }

  // ----------------------------------------------------------------- trigger
  {
    const p = P('trigger');
    p.add('steel', chamferProfile(polyShape([-0.003, 0.004, 0.004, 0.002, 0.005, -0.013, -0.001, -0.019, -0.006, -0.015, -0.006, 0.000]), 0.0072, { bevel: 0.0008, curveSegments: 2 }), { ry: Math.PI / 2 });
    p.group.name = 'trigger';
    p.build();
    p.group.position.set(0, -0.0440, 0.0300);
    root.add(p.group);
  }

  // ---------------------------------------------------------------- selector
  {
    const p = P('selector');
    p.add('steel', cyl(0.0055, 0.0055, 0.0400, 12), { ry: Math.PI / 2 });
    p.add('polymer', chamferProfile(polyShape([-0.004, -0.0035, 0.022, -0.006, 0.026, 0.000, 0.022, 0.006, -0.004, 0.0035]), 0.0055, { bevel: 0.0008 }), { x: -0.0195, ry: Math.PI / 2, rz: -Math.PI / 2 });
    p.group.name = 'selector';
    p.build();
    p.group.position.set(0, -0.0265, 0.0475);
    root.add(p.group);
  }

  // -------------------------------------------------------------- sling mount
  {
    const p = P('slingMount');
    p.add('steel', ring(0.0095, 0.0018, 12, 5), { x: -0.0210, y: 0.0000, z: 0.1120, ry: Math.PI / 2 });
    p.add('steel', ring(0.0085, 0.0016, 12, 5), { x: -0.0195, y: -0.0060, z: -0.2260, ry: Math.PI / 2 });
    p.add('sleeve', chamferBox(0.0220, 0.0030, 0.0450, { r: 0.0010, bevel: 0.0006 }), { x: -0.0300, y: -0.0200, z: 0.0300, rz: 0.28, ry: 0.10 });
    p.group.name = 'slingMount';
    p.build();
    root.add(p.group);
  }

  nodes.sight = new THREE.Object3D();
  nodes.sight.position.set(0, OPTIC_Y, OPTIC_Z);
  root.add(nodes.sight);
  nodes.muzzle = new THREE.Object3D();
  nodes.muzzle.position.set(0, 0, MUZZLE_Z);
  root.add(nodes.muzzle);
  nodes.eject = new THREE.Object3D();
  nodes.eject.position.set(0.0200, 0.0000, -0.0250);
  nodes.eject.rotation.set(0, 0, -0.34);
  root.add(nodes.eject);
  nodes.magSocket = new THREE.Object3D();
  nodes.magSocket.position.set(0, MAG_TOP_Y - 0.095, -0.048);
  root.add(nodes.magSocket);
  nodes.gripRear = new THREE.Object3D();
  nodes.gripRear.position.set(0, -0.0820, 0.0760);
  nodes.gripRear.rotation.set(0.30, 0, 0);
  root.add(nodes.gripRear);
  nodes.gripFront = new THREE.Object3D();
  nodes.gripFront.position.set(0, -0.0060, -0.1720);
  root.add(nodes.gripFront);

  return { root, parts, nodes, tris: countTris(root), gripRadius: 0.0195 };
}
