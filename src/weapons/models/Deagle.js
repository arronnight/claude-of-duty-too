import * as THREE from 'three';
import {
  Part, chamferBox, chamferProfile, polyShape, lathe, cyl, tube, ring, sphere,
  screw, knurled, curvedStack, countTris,
} from '../GunKit.js';

/**
 * Desert Eagle Mark XIX in .50 AE.
 *
 * The reason this weapon is instantly recognisable is its silhouette: a huge
 * slab-sided slide with a *triangular* top profile, a polygonal barrel with a
 * full-length top rail, a gas tube slung under the barrel and a grip raked
 * much further forward than a service pistol. All of that is geometry, so all
 * of it is modelled rather than implied.
 *
 * There is no optic, so the ADS solve runs off the iron sight line: the rig
 * only needs a node somewhere on the line through the rear notch and the front
 * blade, which are parallel to the bore 26.5 mm above it.
 */

const SIGHT_Y = 0.0265;
const MUZZLE_Z = -0.1620;
const MAG_TOP_Y = -0.0330;

export function buildDeagle(resolve) {
  const root = new THREE.Group();
  root.name = 'deagle';
  const parts = {};
  const nodes = {};
  const P = (n) => { const p = new Part(n, resolve); parts[n] = p; return p; };

  // ------------------------------------------------- slide + integral barrel
  // The slide is the reciprocating part, so barrel and slide are one group.
  {
    const p = P('slide');
    // Triangular-topped slab: wide at the bottom, roof faceted to a ridge.
    const prof = polyShape([
      -0.0165, -0.0180, 0.0165, -0.0180, 0.0165, 0.0055,
      0.0092, 0.0180, -0.0092, 0.0180, -0.0165, 0.0055,
    ]);
    p.add('blued', chamferProfile(prof, 0.1750, { bevel: 0.0020, curveSegments: 2 }), { y: 0.0010, z: -0.0450 });
    // Full-length top rail with the slotted sight groove.
    p.add('blued', chamferBox(0.0175, 0.0055, 0.1700, { r: 0.0012, bevel: 0.0009 }), { y: 0.0200, z: -0.0450 });
    for (let i = 0; i < 9; i++) {
      p.add('blued', chamferBox(0.0175, 0.0032, 0.0055, { r: 0.0007, bevel: 0.0005 }), { y: 0.0232, z: -0.1150 + i * 0.0165 });
    }
    // Rear cocking serrations, both flanks.
    for (let i = 0; i < 7; i++) {
      p.addMirrored('blued', chamferBox(0.0032, 0.0250, 0.0042, { r: 0.0008, bevel: 0.0006 }), { x: 0.0160, y: 0.0000, z: 0.0180 + i * 0.0082 });
    }
    // Muzzle crown and polygonal bore.
    p.add('blued', tube(0.0148, 0.0075, 0.0080, 16), { y: 0.0010, z: -0.1580 });
    // Gas tube under the barrel.
    p.add('blued', cyl(0.0072, 0.0072, 0.1000, 12), { y: -0.0230, z: -0.1060 });
    p.add('blued', chamferBox(0.0180, 0.0090, 0.0160, { r: 0.0025, bevel: 0.0010 }), { y: -0.0215, z: -0.1500 });
    // Extractor and ejection port frame on the right flank.
    p.add('blued', chamferBox(0.0040, 0.0135, 0.0400, { r: 0.0012, bevel: 0.0008 }), { x: 0.0155, y: 0.0135, z: -0.0060 });
    p.add('blued', chamferBox(0.0040, 0.0120, 0.0400, { r: 0.0012, bevel: 0.0008 }), { x: 0.0155, y: -0.0130, z: -0.0060 });
    // Iron sights: dovetailed rear notch with two tritium lamps, front blade
    // with one. Both parallel to the bore, 26.5 mm up.
    p.add('blued', chamferBox(0.0225, 0.0105, 0.0075, { r: 0.0012, bevel: 0.0008 }), { y: SIGHT_Y - 0.0020, z: 0.0330 });
    p.addMirrored('blued', chamferBox(0.0072, 0.0105, 0.0075, { r: 0.0012, bevel: 0.0008 }), { x: 0.0077, y: SIGHT_Y - 0.0020, z: 0.0330 });
    p.addMirrored('tritium', cyl(0.0013, 0.0013, 0.0020, 8), { x: 0.0072, y: SIGHT_Y - 0.0010, z: 0.0295 });
    p.add('blued', chamferBox(0.0035, 0.0110, 0.0055, { r: 0.0009, bevel: 0.0006 }), { y: SIGHT_Y - 0.0025, z: -0.1420 });
    p.add('tritium', cyl(0.0012, 0.0012, 0.0018, 8), { y: SIGHT_Y - 0.0010, z: -0.1450 });
    p.group.name = 'slide';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------- frame
  {
    const p = P('lower');
    p.add('black', chamferBox(0.0300, 0.0180, 0.1380, { r: 0.0035, bevel: 0.0014 }), { y: -0.0250, z: -0.0230 });
    // Dust cover / accessory rail under the frame.
    p.add('black', chamferBox(0.0210, 0.0080, 0.0480, { r: 0.0020, bevel: 0.0010 }), { y: -0.0335, z: -0.0800 });
    // Grip frame, raked well forward, with a checkered polymer panel each side.
    p.add('black', chamferBox(0.0290, 0.1050, 0.0420, { r: 0.0075, bevel: 0.0018, curveSegments: 3 }), { y: -0.0850, z: 0.0400, rx: 0.28 });
    p.addMirrored('polymer', chamferBox(0.0035, 0.0800, 0.0320, { r: 0.0045, bevel: 0.0012 }), { x: 0.0150, y: -0.0830, z: 0.0390, rx: 0.28 });
    p.add('polymer', chamferBox(0.0300, 0.0090, 0.0440, { r: 0.0040, bevel: 0.0014 }), { y: -0.1360, z: 0.0545, rx: 0.28 });
    // Trigger guard: squared front, generous radius at the rear.
    p.add('black', chamferBox(0.0110, 0.0075, 0.0480, { r: 0.0025, bevel: 0.0011 }), { y: -0.0620, z: -0.0080 });
    p.add('black', chamferBox(0.0110, 0.0300, 0.0075, { r: 0.0025, bevel: 0.0011 }), { y: -0.0470, z: -0.0290 });
    // Slide stop, safety lever, magazine release, takedown pin, hammer.
    p.add('steel', chamferBox(0.0055, 0.0090, 0.0300, { r: 0.0015, bevel: 0.0008 }), { x: -0.0170, y: -0.0210, z: -0.0110 });
    p.add('steel', cyl(0.0050, 0.0050, 0.0090, 10), { x: 0.0168, y: -0.0155, z: 0.0270, ry: Math.PI / 2 });
    p.add('black', chamferBox(0.0060, 0.0110, 0.0230, { r: 0.0018, bevel: 0.0008 }), { x: 0.0182, y: -0.0155, z: 0.0330, rz: -0.05 });
    p.add('steel', cyl(0.0042, 0.0042, 0.0075, 10), { x: 0.0155, y: -0.0300, z: 0.0060, ry: Math.PI / 2 });
    p.group.name = 'lower';
    p.build();
    root.add(p.group);
  }

  // ------------------------------------------------------------------ hammer
  {
    const p = P('chargingHandle');
    // Spurred hammer at the rear — the pistol's equivalent moving furniture.
    p.add('steel', chamferProfile(polyShape([-0.004, -0.010, 0.006, -0.012, 0.010, 0.004, 0.002, 0.012, -0.006, 0.006]), 0.0070, { bevel: 0.0008 }), { ry: Math.PI / 2 });
    p.add('steel', cyl(0.0055, 0.0055, 0.0080, 10), { y: -0.0080, ry: Math.PI / 2 });
    p.group.name = 'chargingHandle';
    p.build();
    p.group.position.set(0, 0.0035, 0.0640);
    root.add(p.group);
  }

  // ---------------------------------------------------------------- magazine
  {
    const p = P('magazine');
    p.add('blued', curvedStack(0.0230, 0.0330, 0.1050, 0.05, 6, { taper: 0.02, r: 0.0045, gap: 0.0006 }), { y: MAG_TOP_Y, z: 0.0380, rx: 0.28 });
    p.add('blued', chamferBox(0.0265, 0.0075, 0.0400, { r: 0.0030, bevel: 0.0012 }), { y: MAG_TOP_Y - 0.1030, z: 0.0670, rx: 0.28 });
    p.add('brass', cyl(0.0062, 0.0062, 0.0300, 10), { y: MAG_TOP_Y + 0.0060, z: 0.0345 });
    p.group.name = 'magazine';
    p.build();
    root.add(p.group);
  }

  // ----------------------------------------------------------------- trigger
  {
    const p = P('trigger');
    p.add('steel', chamferProfile(polyShape([-0.003, 0.005, 0.004, 0.003, 0.005, -0.014, -0.001, -0.021, -0.006, -0.016, -0.006, 0.001]), 0.0078, { bevel: 0.0008, curveSegments: 2 }), { ry: Math.PI / 2 });
    p.group.name = 'trigger';
    p.build();
    p.group.position.set(0, -0.0350, -0.0150);
    root.add(p.group);
  }

  // ---------------------------------------------------------------- selector
  {
    const p = P('selector');
    // Slide-mounted safety.
    p.add('steel', cyl(0.0048, 0.0048, 0.0090, 10), { ry: Math.PI / 2 });
    p.add('blued', chamferProfile(polyShape([-0.003, -0.003, 0.018, -0.005, 0.021, 0.000, 0.018, 0.005, -0.003, 0.003]), 0.0048, { bevel: 0.0007 }), { x: -0.0060, ry: Math.PI / 2, rz: -Math.PI / 2 });
    p.group.name = 'selector';
    p.build();
    p.group.position.set(-0.0165, 0.0055, 0.0290);
    root.add(p.group);
  }

  // -------------------------------------------------------------- sling mount
  {
    const p = P('slingMount');
    // A pistol has a lanyard loop rather than a sling swivel.
    p.add('steel', ring(0.0055, 0.0013, 10, 5), { x: -0.0060, y: -0.1380, z: 0.0620, ry: Math.PI / 2, rx: 0.28 });
    p.group.name = 'slingMount';
    p.build();
    root.add(p.group);
  }

  nodes.sight = new THREE.Object3D();
  nodes.sight.position.set(0, SIGHT_Y + 0.0035, -0.0300);
  root.add(nodes.sight);
  nodes.muzzle = new THREE.Object3D();
  nodes.muzzle.position.set(0, 0.0010, MUZZLE_Z);
  root.add(nodes.muzzle);
  nodes.eject = new THREE.Object3D();
  nodes.eject.position.set(0.0175, 0.0060, -0.0060);
  nodes.eject.rotation.set(0, 0, -0.30);
  root.add(nodes.eject);
  nodes.magSocket = new THREE.Object3D();
  nodes.magSocket.position.set(0, MAG_TOP_Y - 0.055, 0.0540);
  root.add(nodes.magSocket);
  nodes.gripRear = new THREE.Object3D();
  nodes.gripRear.position.set(0, -0.0780, 0.0350);
  nodes.gripRear.rotation.set(0.28, 0, 0);
  root.add(nodes.gripRear);
  nodes.gripFront = new THREE.Object3D();
  nodes.gripFront.position.set(-0.0180, -0.0700, 0.0250);
  root.add(nodes.gripFront);

  return { root, parts, nodes, tris: countTris(root), gripRadius: 0.018, noSupportHand: true };
}
