import * as THREE from 'three';
import { Part, chamferBox, cyl, sphere, prep } from '../GunKit.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Gloved hands.
 *
 * `ART_DIRECTION.md` rules out photoreal humans, and it is right to — but a
 * weapon floating in space with nothing holding it is the single loudest tell
 * a first-person shooter can have, and every Call of Duty frame has hands in
 * it. The resolution is to model what is actually visible in a real frame:
 * *gloves*. A nomex tactical glove is dark, matte, seamed fabric over simple
 * forms. No skin, no fingernails, no subsurface scattering, no rigged fingers
 * — just correctly proportioned shapes wrapped round the grip and handguard,
 * mostly in the shadow of the weapon.
 *
 * Both hands are built once, in the local space of the model's `gripRear` and
 * `gripFront` nodes, so every weapon gets hands for free as long as it
 * publishes those two nodes at the right place.
 */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/**
 * A curled finger: a chain of tapering capsules, each rotated a little further
 * round than the last, so the knuckles read as knuckles.
 *
 * @param dir     unit direction the finger sets off in
 * @param curl    total curl in radians across the whole finger
 * @param axis    curl axis
 */
function finger(base, dirX, dirY, dirZ, curl, axisX, axisY, axisZ, len = 0.056, r0 = 0.0085) {
  const segs = [0.42, 0.33, 0.25];
  const parts = [];
  const pos = new THREE.Vector3(base[0], base[1], base[2]);
  const dir = new THREE.Vector3(dirX, dirY, dirZ).normalize();
  const axis = new THREE.Vector3(axisX, axisY, axisZ).normalize();
  const rot = new THREE.Quaternion();
  let r = r0;
  for (let i = 0; i < segs.length; i++) {
    const L = len * segs[i];
    const rEnd = r * 0.86;
    // Capsule along Z, then aim it down `dir`.
    const g = new THREE.CapsuleGeometry((r + rEnd) * 0.5, Math.max(1e-4, L - r), 2, 7);
    g.rotateX(Math.PI / 2);
    rot.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    _v.copy(pos).addScaledVector(dir, L * 0.5);
    _m4.compose(_v, rot, _s);
    g.applyMatrix4(_m4);
    parts.push(prep(g));
    // Knuckle bead at each joint keeps the silhouette from reading as a tube.
    if (i < segs.length - 1) {
      const k = sphere(rEnd * 1.06, 7);
      k.translate(pos.x + dir.x * L, pos.y + dir.y * L, pos.z + dir.z * L);
      parts.push(prep(k));
    }
    pos.addScaledVector(dir, L);
    dir.applyAxisAngle(axis, curl * segs[i] / 0.42 * 0.5);
    r = rEnd;
  }
  return mergeGeometries(parts, false);
}

/**
 * Trigger hand: wraps the pistol grip, index finger on the trigger.
 *
 * Proportions are the whole game here. The first pass had a palm the size of
 * the grip and a forearm cone hanging 15 cm below it, which read as a bag of
 * shapes tied to the gun. A hand *in contact* is small, tight to the surface,
 * and stops at the cuff — anything past the wrist is off the bottom of the
 * frame in a real first-person shot anyway.
 */
function buildTriggerHand(p) {
  // Palm, clamped against the right flank of the grip.
  p.add('glove', chamferBox(0.0215, 0.0620, 0.0400, { r: 0.0085, bevel: 0.0022, curveSegments: 3 }), { x: 0.0195, y: -0.0080, z: 0.0030, rz: -0.05 });
  // Heel of the hand.
  p.add('glove', chamferBox(0.0205, 0.0230, 0.0330, { r: 0.0085, bevel: 0.0022 }), { x: 0.0200, y: -0.0330, z: 0.0135, rx: -0.16 });
  // Padded back-of-hand panel — the one part of a tactical glove that is not
  // fabric, and what makes it read as a glove rather than a mitten.
  p.add('glove_pad', chamferBox(0.0042, 0.0390, 0.0270, { r: 0.0050, bevel: 0.0012 }), { x: 0.0300, y: -0.0070, z: 0.0050, rz: -0.05 });

  // Three fingers curled hard round the front of the grip.
  // The curl axis is +Y, not +X: a finger closing round a grip sweeps through
  // the horizontal plane from pointing forward to pointing back at the palm.
  // Curling about X instead lifts the fingertips into the air, which is what
  // made the first pass read as a cluster of sausages behind the weapon.
  for (let i = 0; i < 3; i++) {
    const y = -0.0060 - i * 0.0170;
    p.add('glove', finger([0.0060, y, -0.0150], -0.20, -0.14, -0.97, 2.55, 0, 1, 0, 0.036 - i * 0.003, 0.0076 - i * 0.0005), {});
    // Knuckle over the root of each finger.
    p.add('glove', sphere(0.0079 - i * 0.0005, 8), { x: 0.0105, y: y + 0.0032, z: -0.0128 });
  }
  // Index finger, straighter, reaching the trigger.
  p.add('glove', finger([0.0060, 0.0175, -0.0145], -0.18, -0.10, -0.98, 1.10, 0, 1, 0, 0.040, 0.0080), {});
  p.add('glove', sphere(0.0083, 8), { x: 0.0105, y: 0.0208, z: -0.0120 });
  // Thumb laid across the back of the grip and down.
  p.add('glove', finger([0.0140, 0.0145, 0.0150], -0.44, -0.62, -0.65, 0.50, 0.3, -0.4, 0.7, 0.038, 0.0090), {});

  // Cuff. Short on purpose: the forearm is out of frame, and a long tapered
  // tube hanging into shot is worse than no forearm at all.
  p.add('glove', cyl(0.0200, 0.0225, 0.0300, 12), { x: 0.0225, y: -0.0480, z: 0.0215, rx: 1.18 });
  p.add('sleeve', cyl(0.0245, 0.0255, 0.0300, 12), { x: 0.0250, y: -0.0625, z: 0.0300, rx: 1.18 });
  p.add('glove_pad', ring(0.0233, 0.0030, 12, 5), { x: 0.0238, y: -0.0552, z: 0.0258, rx: 1.18 });
}

/** Support hand: C-clamp on the handguard, thumb forward along the top. */
function buildSupportHand(p, radius) {
  const R = radius;
  // Palm pressed against the left flank of the handguard, wrapped under it.
  p.add('glove', chamferBox(0.0185, 0.0420, 0.0600, { r: 0.0125, bevel: 0.0022, curveSegments: 3 }), { x: -(R + 0.0095), y: -0.0080, z: 0.0000, rz: 0.12 });
  p.add('glove', chamferBox(0.0300, 0.0170, 0.0560, { r: 0.0080, bevel: 0.0020 }), { x: -(R * 0.55), y: -(R + 0.0055), z: 0.0020, rz: 0.20 });
  p.add('glove_pad', chamferBox(0.0038, 0.0290, 0.0470, { r: 0.0075, bevel: 0.0012 }), { x: -(R + 0.0182), y: -0.0060, z: 0.0000, rz: 0.12 });
  // Knuckle row along the top edge — the read that separates a hand from a box.
  for (let i = 0; i < 4; i++) {
    p.add('glove', sphere(0.0082 - i * 0.0005, 8), { x: -(R + 0.0075), y: 0.0075, z: -0.0250 + i * 0.0168 });
  }
  // Four fingers reaching up over the top of the handguard.
  for (let i = 0; i < 4; i++) {
    const z = -0.0250 + i * 0.0168;
    p.add('glove', finger([-(R + 0.0045), -0.0165 + i * 0.0008, z], 0.40, 0.92, 0.0, 2.55, 0, 0, -1, 0.037 - i * 0.0025, 0.0074 - i * 0.0005), {});
  }
  // Thumb laid forward along the top-left rail — the modern C-clamp grip.
  p.add('glove', finger([-(R + 0.0045), 0.0105, 0.0165], 0.26, 0.20, -0.94, 0.30, 1, 0, 0, 0.050, 0.0088), {});
  // Short cuff dropping away below-left.
  p.add('glove', cyl(0.0195, 0.0220, 0.0280, 12), { x: -(R + 0.0175), y: -0.0350, z: 0.0195, rx: 1.02, rz: 0.32 });
  p.add('sleeve', cyl(0.0240, 0.0250, 0.0300, 12), { x: -(R + 0.0245), y: -0.0510, z: 0.0300, rx: 1.02, rz: 0.32 });
}

function ring(radius, thickness, seg, tubeSeg) {
  return new THREE.TorusGeometry(radius, thickness, tubeSeg, seg);
}

/**
 * @returns {{ rear: THREE.Group, front: THREE.Group }} parented to the model's
 *          grip nodes by the caller.
 */
export function buildHands(resolve, opts = {}) {
  const rearPart = new Part('handRear', resolve);
  buildTriggerHand(rearPart);
  const rear = rearPart.build();

  const frontPart = new Part('handFront', resolve);
  buildSupportHand(frontPart, opts.gripRadius ?? 0.0218);
  const front = frontPart.build();

  return { rear, front };
}
