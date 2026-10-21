import * as THREE from 'three';
import { KIT, tileRect, pingpong } from './BotKitAtlas.js';

/**
 * Procedural soldier: skeleton, skinned geometry, hitbox volumes.
 *
 * Deliberate scope call (see `docs/ART_DIRECTION.md`): we do not attempt
 * photoreal humans. What a bot has to do is read as a *soldier silhouette* at
 * 10-40 m against a bright street and move correctly. So the effort goes into
 * proportion, gear read and the skeleton that drives it — not into skin, faces
 * or cloth. The face is a void behind an eye-pro band: no skin shader, no
 * features, and that is what the reference frames actually show at this range.
 *
 * ONE geometry, not two. Everything — cloth, plate carrier, helmet, boots and
 * the carbine — samples one packed `bot_kit` atlas, so a bot is a single
 * SkinnedMesh: one colour draw and one draw per shadow cascade it touches,
 * instead of two of each. That halving is the whole reason the material merge
 * was worth doing, and it is why every `b.add()` below names an atlas tile.
 * The geometry is built ONCE at startup and shared by every bot — each bot only
 * owns its own `THREE.Skeleton` and its own tinted material instance.
 *
 * Everything is authored in metres at a 1.80 m eye-to-heel scale, with joint
 * heights taken from standard anthropometry (hip 0.94, knee 0.50, shoulder
 * 1.46, eye 1.66) because getting the *joint* heights right is most of what
 * makes a walk cycle look human.
 */

// [name, parent, rest world x, y, z]. Rest orientation is identity for every
// bone, so an animator's local quaternion is just "rotation about this joint"
// with no bind-pose basis to fight.
export const BONE_DEFS = [
  ['hips', null, 0, 0.940, 0],
  ['spine', 'hips', 0, 1.090, 0.005],
  ['chest', 'spine', 0, 1.290, 0.005],
  ['neck', 'chest', 0, 1.500, -0.008],
  ['head', 'neck', 0, 1.585, 0],
  ['shoulderL', 'chest', -0.062, 1.462, 0],
  ['armL', 'shoulderL', -0.186, 1.452, 0],
  ['forearmL', 'armL', -0.204, 1.172, 0.012],
  ['handL', 'forearmL', -0.216, 0.922, 0.020],
  ['shoulderR', 'chest', 0.062, 1.462, 0],
  ['armR', 'shoulderR', 0.186, 1.452, 0],
  ['forearmR', 'armR', 0.204, 1.172, 0.012],
  ['handR', 'forearmR', 0.216, 0.922, 0.020],
  ['thighL', 'hips', -0.096, 0.925, 0],
  ['shinL', 'thighL', -0.100, 0.495, 0.006],
  ['footL', 'shinL', -0.100, 0.085, -0.014],
  ['toeL', 'footL', -0.100, 0.030, 0.120],
  ['thighR', 'hips', 0.096, 0.925, 0],
  ['shinR', 'thighR', 0.100, 0.495, 0.006],
  ['footR', 'shinR', 0.100, 0.085, -0.014],
  ['toeR', 'footR', 0.100, 0.030, 0.120],
  // Driven directly by the animator rather than parented to a hand: the aim
  // pose decides where the weapon is and the arms IK onto it, which is both how
  // it works in life and the only way to get the sight line to agree with the head.
  ['weapon', 'chest', 0.150, 1.180, 0.230],
];

export const BONE_INDEX = new Map(BONE_DEFS.map((b, i) => [b[0], i]));

/** Rest world position of a bone, for offset maths at build time. */
export function restPos(name) {
  const b = BONE_DEFS[BONE_INDEX.get(name)];
  return new THREE.Vector3(b[2], b[3], b[4]);
}

// Limb lengths the IK solver needs; derived once so they cannot drift from the
// skeleton above.
export const LIMB = (() => {
  const d = (a, b) => restPos(a).distanceTo(restPos(b));
  return {
    thigh: d('thighL', 'shinL'),
    shin: d('shinL', 'footL'),
    upperArm: d('armL', 'forearmL'),
    forearm: d('forearmL', 'handL'),
    hipY: restPos('hips').y,
    ankleY: restPos('footL').y,
    hipHalf: Math.abs(restPos('thighL').x),
    shoulderY: restPos('armL').y,
  };
})();

/**
 * Hitboxes in bone space. `mult` is the damage multiplier from
 * `docs/GAMEPLAY.md`. Limbs are two boxes each so a bent knee or a shouldered
 * elbow still has a volume where the geometry actually is.
 */
export const HITBOX_DEFS = [
  { part: 'head', bone: 'head', off: [0, 0.098, 0.004], half: [0.098, 0.115, 0.110], mult: 1.9 },
  { part: 'chest', bone: 'chest', off: [0, 0.098, 0], half: [0.175, 0.135, 0.135], mult: 1.0 },
  { part: 'stomach', bone: 'spine', off: [0, 0.020, 0], half: [0.150, 0.115, 0.120], mult: 1.05 },
  { part: 'armL', bone: 'armL', off: [-0.006, -0.140, 0], half: [0.072, 0.160, 0.072], mult: 0.85 },
  { part: 'armL', bone: 'forearmL', off: [-0.006, -0.125, 0], half: [0.062, 0.145, 0.062], mult: 0.85 },
  { part: 'armR', bone: 'armR', off: [0.006, -0.140, 0], half: [0.072, 0.160, 0.072], mult: 0.85 },
  { part: 'armR', bone: 'forearmR', off: [0.006, -0.125, 0], half: [0.062, 0.145, 0.062], mult: 0.85 },
  { part: 'legL', bone: 'thighL', off: [0, -0.215, 0], half: [0.096, 0.230, 0.100], mult: 0.85 },
  { part: 'legL', bone: 'shinL', off: [0, -0.205, 0], half: [0.078, 0.220, 0.086], mult: 0.85 },
  { part: 'legR', bone: 'thighR', off: [0, -0.215, 0], half: [0.096, 0.230, 0.100], mult: 0.85 },
  { part: 'legR', bone: 'shinR', off: [0, -0.205, 0], half: [0.078, 0.220, 0.086], mult: 0.85 },
];

/** Where the hands grip the weapon, in weapon-bone local space. */
export const GRIP_R = new THREE.Vector3(0.004, -0.052, -0.012);
export const GRIP_L = new THREE.Vector3(-0.004, -0.040, 0.255);
/** Bore origin and the eye/sight line, weapon local. */
export const MUZZLE = new THREE.Vector3(0, 0.052, 0.530);
export const SIGHT = new THREE.Vector3(0, 0.128, 0.090);

// --------------------------------------------------------------------- build

// Dust, in linear space, normalised to unit luminance so mixing toward it is a
// hue shift and not a second darkening on top of the gravity ramp.
const WARM = new THREE.Color(1.22, 0.95, 0.61);

/**
 * Dirt gravity. Kit is clean at the shoulder and filthy at the boot, and the
 * ramp between the two does more for "this is a person who has been outside"
 * than any texture at this range. Values are the measured reference profile.
 */
function gravity(y) {
  if (y >= 1.46) return 1.00;
  if (y >= 0.94) return 0.86 + 0.14 * ((y - 0.94) / 0.52);
  if (y >= 0.50) return 0.74 + 0.12 * ((y - 0.50) / 0.44);
  if (y >= 0.20) return 0.68 + 0.06 * ((y - 0.20) / 0.30);
  return 0.68;
}

/**
 * Baked contact occlusion, in bot-local rest space.
 *
 * This is what stops the kit reading as one flat cutout at 28 m: it is free, it
 * survives any lighting, and it is the only occlusion a skinned mesh gets —
 * SSAO cannot see into an armpit that is 4 px wide.
 */
function bakedAO(x, y, z) {
  let ao = 1;
  const ax = Math.abs(x);
  // Under the boot: the sole is never lit.
  if (y < 0.075) ao = Math.min(ao, 0.72 + 0.28 * (y / 0.075));
  // The lower edge of the plate carrier, front and back.
  if (y > 1.02 && y < 1.14 && Math.abs(z) > 0.06) {
    ao = Math.min(ao, 0.80 + 0.20 * Math.abs(y - 1.08) / 0.06);
  }
  // Armpit.
  if (ax > 0.11 && ax < 0.25 && y > 1.30 && y < 1.47) ao = Math.min(ao, 0.78);
  // Inside the helmet line and under the brim: the whole reason the face reads
  // as a void rather than as a pale disc.
  if (y > 1.560 && y < 1.672 && z > -0.05) ao = Math.min(ao, 0.78);
  // Under the mag shingle.
  if (y > 1.00 && y < 1.09 && z > 0.10) ao = Math.min(ao, 0.85);
  return ao;
}

/**
 * Accumulates transformed primitives into one interleaved skinned geometry.
 * Build-time only, so it is allowed to allocate.
 */
class SkinBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.si = [];
    this.sw = [];
    this.idx = [];
    this._c = new THREE.Color();
    this._v = new THREE.Vector3();
  }

  /**
   * @param {THREE.BufferGeometry} geo  disposed after use
   * @param {THREE.Matrix4} m           placement into bot-local space
   * @param {string} part               a key of KIT: atlas tile + relative tint
   * @param {(x,y,z)=>Array} skin       bot-local position -> [[boneName, w], ...]
   * @param {number} uvScale            how many times the tile repeats over the piece
   * @param {boolean} shade             apply the dirt/AO bake (off for the weapon)
   */
  add(geo, m, part, skin, uvScale = 1, shade = true) {
    geo.applyMatrix4(m);
    const p = geo.attributes.position;
    const n = geo.attributes.normal;
    const u = geo.attributes.uv;
    const base = this.pos.length / 3;
    const kit = KIT[part] || KIT.carrier;
    const [u0, v0, du, dv] = tileRect(kit.tile);
    const t = kit.tint;

    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      this.pos.push(x, y, z);
      this.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      // Fold into the tile's inner rect. Mirrored rather than wrapped: a tile
      // has no neighbours it may legally sample.
      this.uv.push(
        u0 + pingpong((u ? u.getX(i) : 0) * uvScale) * du,
        v0 + pingpong((u ? u.getY(i) : 0) * uvScale) * dv,
      );

      if (shade) {
        const g = gravity(y);
        // Dust on the outside of the calf, where a boot throws it.
        const calf = (y < 0.56 && y > 0.12 && Math.abs(x) > 0.115) ? 0.90 : 1;
        const k = g * calf * bakedAO(x, y, z);
        const warm = 0.25 * Math.min(1, (1 - g) / 0.32);
        this._c.copy(t).lerp(WARM, warm).multiplyScalar(k);
      } else {
        this._c.copy(t);
      }
      this.col.push(this._c.r, this._c.g, this._c.b);

      const w = skin(x, y, z);
      let i0 = 0, w0 = 0, i1 = 0, w1 = 0, i2 = 0, w2 = 0, i3 = 0, w3 = 0;
      let total = 0;
      for (let k = 0; k < w.length && k < 4; k++) total += w[k][1];
      if (total <= 0) total = 1;
      if (w[0]) { i0 = BONE_INDEX.get(w[0][0]); w0 = w[0][1] / total; }
      if (w[1]) { i1 = BONE_INDEX.get(w[1][0]); w1 = w[1][1] / total; }
      if (w[2]) { i2 = BONE_INDEX.get(w[2][0]); w2 = w[2][1] / total; }
      if (w[3]) { i3 = BONE_INDEX.get(w[3][0]); w3 = w[3][1] / total; }
      this.si.push(i0, i1, i2, i3);
      this.sw.push(w0, w1, w2, w3);
    }
    const gi = geo.index;
    if (gi) for (let i = 0; i < gi.count; i++) this.idx.push(base + gi.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geo.dispose();
    return this;
  }

  finish() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    // A bind-pose bounding sphere is far too tight once a bot lies down as a
    // ragdoll or throws an arm out; a generous manual one keeps culling honest
    // without a per-frame recompute.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.6);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1.1, -0.4, -1.1), new THREE.Vector3(1.1, 2.1, 1.1),
    );
    return g;
  }
}

const rigid = (name) => () => [[name, 1]];

/**
 * Linear blend between two bones along a world axis. `soft` is the half-width
 * of the transition in metres; outside it the vertex is rigid to one bone.
 */
function blendY(a, b, yA, yB) {
  return (x, y) => {
    const t = THREE.MathUtils.clamp((y - yA) / (yB - yA || 1), 0, 1);
    const s = t * t * (3 - 2 * t);
    return [[a, 1 - s], [b, s]];
  };
}

/** Three-way spine blend so the torso deforms instead of shearing at one seam. */
function blendSpine(y) {
  const hips = 1 - THREE.MathUtils.smoothstep(y, 0.98, 1.12);
  const chest = THREE.MathUtils.smoothstep(y, 1.14, 1.30);
  const spine = Math.max(0, 1 - hips - chest);
  return [['hips', hips], ['spine', spine], ['chest', chest]];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

/** Placement matrix: position, XYZ euler, scale. */
function at(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _p.set(x, y, z);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return _m.compose(_p, _q, _s).clone();
}

const _rv = new THREE.Vector3();
const _rc = new THREE.Vector3();

/**
 * Rounded box. A hard 90° edge reads as an untextured box at any distance, and
 * on a body it reads as LEGO; every hard edge on a bot gets a radius.
 *
 * The naive "clamp the corners inwards" version this replaces did nothing at
 * all — with one segment per axis *every* vertex is a corner, so clamping them
 * all just produced a slightly smaller box. Real rounding needs interior
 * vertices to hold the flat of the face, hence the forced minimum of two
 * segments: each vertex is projected onto the surface of the box's Minkowski
 * sum with a sphere of radius `r`, which is exactly a rounded box.
 */
function rbox(w, h, d, r = 0.02, seg = 1) {
  const s = Math.max(2, seg + 1);
  const g = new THREE.BoxGeometry(w, h, d, s, s, s);
  const rr = Math.min(r, w * 0.42, h * 0.42, d * 0.42);
  const hx = w / 2 - rr, hy = h / 2 - rr, hz = d / 2 - rr;
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    _rv.fromBufferAttribute(p, i);
    _rc.set(
      THREE.MathUtils.clamp(_rv.x, -hx, hx),
      THREE.MathUtils.clamp(_rv.y, -hy, hy),
      THREE.MathUtils.clamp(_rv.z, -hz, hz),
    );
    _rv.sub(_rc);
    const l = _rv.length();
    if (l > 1e-6) _rv.multiplyScalar(rr / l).add(_rc); else _rv.copy(_rc);
    p.setXYZ(i, _rv.x, _rv.y, _rv.z);
  }
  // BoxGeometry keeps one vertex per face corner, so this averages within a
  // face and not across the rounded edge: the flat stays flat, the radius
  // catches a highlight, and adjacent faces still meet exactly.
  g.computeVertexNormals();
  return g;
}

/**
 * Unrounded box, 12 triangles. For anything under ~3 cm — bungee cords, chin
 * straps, a mag flap — where the rounding radius would be a quarter of a pixel
 * at 25 m and the 36 extra triangles buy literally nothing.
 */
function box(w, h, d) {
  return new THREE.BoxGeometry(w, h, d);
}

/** Tapered limb segment, origin at its top, running down -Y for `len`. */
function limb(rTop, rBot, len, radial = 6) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, radial, 1, false);
  g.translate(0, -len / 2, 0);
  return g;
}

function sphere(r, wSeg = 8, hSeg = 6) {
  return new THREE.SphereGeometry(r, wSeg, hSeg);
}

// ------------------------------------------------------------------ the body

/**
 * The whole operator, soft and hard, in one builder.
 *
 * Ordered head-down so that the piece with the most silhouette value sits at
 * the top of the file where it gets read.
 */
function buildKit() {
  const b = new SkinBuilder();
  buildHead(b);
  buildTorso(b);
  buildArms(b);
  buildLegs(b);
  buildWeapon(b);
  return b.finish();
}

/**
 * The head: 100% silhouette, 0% face.
 *
 * The old head was a bare ball — the dome stood 1.1 cm proud of the skull,
 * which at 26 m is 0.3 px, so it read as a skull with nothing on it, and the
 * goggle block caught a broad specular and rendered as a white face plate. This
 * version puts 5.1 cm of helmet over the skull, stows the NVGs UP off the
 * mount (both bo6_03 operators have them there, and it is the single most
 * recognisable 40 triangles in the frame), and widens the head from 19 to 24 cm
 * with comms cups. The face itself is one flat quad in shadow with no features
 * at all, which is exactly what mw3_05 shows at 28 m.
 */
function buildHead(b) {
  const H = rigid('head');

  // Skull under the helmet: a balaclava, deliberately small so the shell reads.
  b.add(sphere(0.092, 10, 7), at(0, 1.664, 0, 0, 0, 0, 0.94, 1.05, 1.02), 'gaiter', H, 1);
  // Jaw/chin mass, so the profile is not a sphere on a stick.
  b.add(rbox(0.138, 0.082, 0.150, 0.040), at(0, 1.606, 0.014), 'gaiter', H, 1);

  // Helmet shell: crown at 1.812, 23.6 cm across the widest point.
  const shell = new THREE.SphereGeometry(0.118, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.62);
  b.add(shell, at(0, 1.682, 0, 0, 0, 0, 1.00, 1.10, 1.06), 'helmetCover', H, 1);
  // Brim. A hard shadow line above the eye band is most of what says "helmet".
  b.add(rbox(0.232, 0.030, 0.252, 0.014), at(0, 1.688, 0.012), 'helmet', H, 1);
  // Rear counterweight pouch: breaks the back of the profile, which otherwise
  // is a perfect circle and reads as a motorcycle helmet.
  b.add(rbox(0.112, 0.082, 0.052, 0.016), at(0, 1.726, -0.138), 'pouch', H, 1);
  // Side rails. Deliberately NOT on the polymer tile: at roughness 0.36 a
  // 13 mm rail catches a hard specular from a low sun and reads as chrome.
  for (const s of [-1, 1]) {
    b.add(rbox(0.013, 0.026, 0.128, 0.006), at(s * 0.118, 1.700, 0.012), 'shockCord', H, 1);
  }

  // NVG mount and the stowed-up bino. This mass stands 6.2 cm above the crown
  // and 10 cm forward of the brow: 3 x 2 px of unmistakable profile at 26 m,
  // and both bo6_03 operators wear theirs exactly here.
  //
  // Twice rebuilt against the render, both times for the same reason. At the
  // briefed heights the arm and bridge stood 9 cm proud and read in profile as
  // a claw hammer rather than as a bino; and on the polymer tile (roughness
  // 0.36) the flat top of the arm blew out brighter than SUNLIT BRICK, which is
  // the "broad specular blowout on the head" the brief forbids outright. Small
  // hard parts on a head go on a matte tile. The objective lenses are the one
  // authorised glint and they are 2 cm across.
  b.add(rbox(0.058, 0.048, 0.036, 0.010), at(0, 1.752, 0.116), 'shockCord', H, 1);
  b.add(rbox(0.026, 0.070, 0.024, 0.008), at(0, 1.796, 0.110, -0.30), 'shockCord', H, 1);
  b.add(rbox(0.086, 0.030, 0.040, 0.008), at(0, 1.836, 0.094), 'shockCord', H, 1);
  for (const s of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(0.023, 0.026, 0.070, 8),
      at(s * 0.031, 1.840, 0.098, 1.35), 'shockCord', H, 1);
    // Objective lens. Points along the bell axis, which rotating x by 1.35
    // leaves at (0, cos, sin); a circle's normal is +Z, hence 1.35 - PI/2.
    b.add(new THREE.CircleGeometry(0.021, 8),
      at(s * 0.031, 1.840 + 0.0077, 0.098 + 0.0342, 1.35 - Math.PI / 2), 'optic', H, 1);
  }

  // Comms: ear cups take the head from 19 to 24 cm wide, which is a real
  // silhouette change, plus a headband arc and a boom mic. The mic is 15
  // triangles and reads as a black hairline against a bright wall.
  // Every one of these is on a matte tile. A comms cup is an 8.6 cm disc that
  // points straight at the sun for half of every turn, and on the rubber tile
  // it rendered brighter than the sunlit stone behind it.
  for (const s of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(0.041, 0.041, 0.034, 10),
      at(s * 0.104, 1.652, -0.004, 0, 0, Math.PI / 2), 'velcro', H, 1);
  }
  for (let i = 0; i < 6; i++) {
    const t = (i + 0.5) / 6;
    const a = Math.PI * t;
    b.add(box(0.022, 0.030, 0.024),
      at(-0.104 * Math.cos(a), 1.652 + 0.140 * Math.sin(a), -0.006, 0, 0, a - Math.PI / 2),
      'shockCord', H, 1);
  }
  b.add(new THREE.CylinderGeometry(0.0038, 0.0032, 0.074, 5),
    at(-0.092, 1.632, 0.046, 1.30, 0.34, 0), 'velcro', H, 1);

  // Chin Y-yoke, two members down to the jaw.
  for (const s of [-1, 1]) {
    b.add(box(0.014, 0.078, 0.014), at(s * 0.072, 1.598, 0.030, -0.34, 0, s * 0.42), 'webbing', H, 1);
  }

  // Eye-pro. A matte frame carrying a NARROW lens strip, and the split is the
  // whole point: the first version put the full 16.8 x 4.2 cm panel on the
  // optic tile at roughness 0.12, and a flat near-mirror that size facing a low
  // sun lit up end to end — the white face plate, reborn with a different
  // material. The lens is now 1.6 cm tall and almost entirely fillet, so there
  // is barely any planar area to catch the sun and what does catch it is one
  // thin horizontal line, which is what eye-pro actually looks like.
  b.add(rbox(0.172, 0.046, 0.026, 0.010), at(0, 1.664, 0.096), 'rubber', H, 1);
  b.add(rbox(0.150, 0.016, 0.020, 0.008), at(0, 1.668, 0.104), 'eyePro', H, 1);
  // The face. One flat quad, recessed behind both the band and the brim so it
  // lives permanently in the brim's own shadow. No eyes, no slit, no nose, no
  // mouth, no normal detail — mw3_05's operator is a featureless void at 28 m.
  b.add(new THREE.PlaneGeometry(0.132, 0.096), at(0, 1.632, 0.086), 'faceVoid', H, 1);
}

/**
 * Torso, plate carrier and load. Two authorised accents and no more: one coyote
 * element and one arm patch, which is the mw3_05 formula.
 */
function buildTorso(b) {
  const spineSkin = (x, y) => blendSpine(y);
  const CH = rigid('chest');

  // Pelvis, belt, torso, trapezius.
  b.add(rbox(0.284, 0.230, 0.208, 0.05), at(0, 0.985, 0.005), 'trouser', spineSkin, 1.4);
  b.add(rbox(0.312, 0.062, 0.228, 0.02), at(0, 0.905, 0.005), 'webbing', rigid('hips'), 2.2);
  b.add(rbox(0.310, 0.290, 0.210, 0.055, 2), at(0, 1.190, 0.004), 'shirt', spineSkin, 1.6);
  b.add(rbox(0.335, 0.230, 0.225, 0.055, 2), at(0, 1.355, 0.004), 'shirt', spineSkin, 1.6);
  b.add(rbox(0.290, 0.090, 0.185, 0.05), at(0, 1.452, 0.002), 'shirtWorn', CH, 1.4);
  // Neck gaiter. No exposed skin anywhere on a bot, ever.
  b.add(limb(0.058, 0.062, 0.10, 6), at(0, 1.552, -0.006), 'gaiter', rigid('neck'), 1);

  // Plate carrier. Medium SAPI is 24.5 x 31.7 cm and the bag around it is
  // 28 x 36 x 6; the old 33 x 33 x 7.5 slab read as a sandwich board.
  b.add(rbox(0.290, 0.360, 0.062, 0.026), at(0, 1.240, 0.126), 'carrier', CH, 1.2);
  b.add(rbox(0.290, 0.380, 0.058, 0.026), at(0, 1.245, -0.118), 'carrierBack', CH, 1.2);
  // Cummerbund on the MOLLE ladder: the most legible tile in the atlas at
  // range, so it goes where the eye lands.
  b.add(rbox(0.318, 0.170, 0.240, 0.030), at(0, 1.176, 0.004), 'molle', rigid('spine'), 1.6);

  // Shoulder yoke. The top of a kitted shoulder is FLAT, not a ball: this
  // squares the top 9 cm, takes bideltoid breadth from 52.4 to 55.6 cm, and is
  // where the sky sheen lands.
  for (const s of [-1, 1]) {
    b.add(rbox(0.092, 0.036, 0.210, 0.014), at(s * 0.130, 1.470, 0.008), 'molle', CH, 1.2);
    b.add(rbox(0.078, 0.062, 0.250, 0.020), at(s * 0.108, 1.432, 0.010), 'webbing', CH, 1.8);
  }

  // Mag shingle, BELOW the plate where it actually lives, each pouch with a
  // flap standing proud. Three horizontal shadow lines across the chest is the
  // read that says "soldier" at 28 m; mw3_05 shows four.
  for (let i = -1; i <= 1; i++) {
    b.add(rbox(0.088, 0.150, 0.062, 0.018), at(i * 0.094, 1.108, 0.172), 'accentTan', CH, 1.4);
    b.add(rbox(0.094, 0.040, 0.070, 0.012), at(i * 0.094, 1.166, 0.176), 'accentTanWeb', CH, 1.4);
  }
  // Admin pouch.
  b.add(rbox(0.130, 0.095, 0.055, 0.016), at(-0.070, 1.330, 0.162), 'pouch', CH, 1.4);

  // Radio on the LEFT REAR cummerbund with a two-segment whip raking back 22
  // degrees. 34 cm of antenna, up from 17: a thin dark diagonal above the
  // shoulder line is a strong, cheap, unmistakably military read.
  b.add(rbox(0.062, 0.115, 0.048, 0.014), at(-0.132, 1.262, -0.140), 'polymer', CH, 1.2);
  b.add(new THREE.CylinderGeometry(0.006, 0.005, 0.170, 5), at(-0.132, 1.400, -0.160, -0.30), 'polymer', CH, 1);
  b.add(new THREE.CylinderGeometry(0.005, 0.004, 0.185, 5), at(-0.132, 1.560, -0.208, -0.42), 'polymer', CH, 1);

  // Low-profile back panel. The old 30 x 36 x 15 assault pack was a suitcase.
  b.add(rbox(0.258, 0.340, 0.092, 0.030), at(0, 1.290, -0.186), 'carrierBack', CH, 1.2);
  b.add(rbox(0.230, 0.100, 0.070, 0.022), at(0, 1.130, -0.196), 'pouch', CH, 1.4);

  // Hip / dump pouches.
  for (const s of [-1, 1]) {
    b.add(rbox(0.090, 0.130, 0.080, 0.020), at(s * 0.168, 0.918, -0.030), 'pouch', rigid('hips'), 1.4);
  }

  // Thigh holster: 48 triangles and a strong 20-40 m silhouette breaker,
  // because it puts a hard rectangle where the leg is otherwise a smooth tube.
  b.add(rbox(0.116, 0.208, 0.062, 0.020), at(0.118, 0.716, 0.026), 'polymer', rigid('thighR'), 1.2);
  b.add(box(0.120, 0.024, 0.070), at(0.118, 0.826, 0.026), 'webbing', rigid('thighR'), 1);

  // Sling: flat 25 mm webbing, never metallic. The rbox this replaces was on
  // the half-metal gear material and rendered as a gold bandolier.
  b.add(rbox(0.026, 0.400, 0.016, 0.006), at(-0.052, 1.300, 0.152, 0, 0, -0.52), 'webbing', CH, 2.2);
  b.add(rbox(0.026, 0.230, 0.014, 0.006), at(-0.150, 1.400, -0.030, 0, 0.9, -0.30), 'webbing', CH, 2.2);

  // Accent two of two: a 5.0 x 3.5 cm arm patch, flat, 2 mm proud of the right
  // deltoid. Nothing else on the bot is allowed a third colour.
  b.add(new THREE.PlaneGeometry(0.050, 0.035), at(0.264, 1.432, 0.014, 0, Math.PI / 2, 0),
    'patch', rigid('armR'), 1);
}

function buildArms(b) {
  for (const s of [-1, 1]) {
    const S = s < 0 ? 'L' : 'R';
    // Deltoid caps are rigid to the upper arm so the shoulder does not pinch
    // when the arm comes up to a firing position.
    b.add(sphere(0.076, 8, 6), at(s * 0.186, 1.452, 0, 0, 0, 0, 1.0, 1.05, 1.0),
      'shirtWorn', rigid('arm' + S), 1);
    b.add(limb(0.062, 0.050, 0.272, 6), at(s * 0.190, 1.446, 0.004), 'shirt',
      blendY('arm' + S, 'forearm' + S, 1.245, 1.172), 1.4);
    b.add(sphere(0.052, 6, 5), at(s * 0.204, 1.172, 0.010), 'shirt', rigid('forearm' + S), 1);
    // Rolled sleeve cuff — a hard line on the forearm is a strong read.
    b.add(limb(0.052, 0.041, 0.240, 6), at(s * 0.206, 1.170, 0.012), 'shirtWorn',
      blendY('forearm' + S, 'hand' + S, 0.985, 0.935), 1.4);

    // GLOVES. The rifle used to be held by two tapered tubes with nothing on
    // the end of them, which is visible at 15 m and unforgivable at 11. Palm,
    // knuckle wedge and a mitten thumb: no individual fingers, ever — they
    // alias into a smear and cost 200 triangles for the privilege.
    const H = rigid('hand' + S);
    b.add(rbox(0.052, 0.096, 0.090, 0.020), at(s * 0.218, 0.892, 0.026), 'glove', H, 1);
    b.add(box(0.054, 0.032, 0.040), at(s * 0.218, 0.850, 0.052), 'glove', H, 1);
    b.add(box(0.026, 0.048, 0.032), at(s * 0.188, 0.902, 0.050), 'glove', H, 1);
  }
}

function buildLegs(b) {
  for (const s of [-1, 1]) {
    const S = s < 0 ? 'L' : 'R';
    // Combat trousers, not tights: the legs were reading as two poles with a
    // stripe of bright street between them.
    b.add(limb(0.122, 0.094, 0.435, 6), at(s * 0.096, 0.932, 0.004), 'trouser',
      blendY('thigh' + S, 'shin' + S, 0.585, 0.495), 1.4);
    b.add(sphere(0.086, 6, 5), at(s * 0.100, 0.495, 0.008), 'trouser', rigid('shin' + S), 1);
    b.add(limb(0.094, 0.070, 0.330, 6), at(s * 0.100, 0.492, 0.006), 'trouser',
      blendY('shin' + S, 'foot' + S, 0.260, 0.190), 1.4);
    // Blousing over the boot: a distinct step in the silhouette at the ankle.
    b.add(limb(0.088, 0.079, 0.078, 6), at(s * 0.100, 0.182, 0.002), 'shirtWorn',
      rigid('shin' + S), 1);

    // Knee pads.
    b.add(rbox(0.110, 0.150, 0.060, 0.028), at(s * 0.100, 0.520, 0.062), 'polymer',
      rigid('shin' + S), 1.2);

    // Boots. Authored so the sole sits exactly on y = 0 in the rest pose — the
    // foot IK plants the ankle at ground + 0.085, and a sole modelled below the
    // origin would bury itself in the road.
    b.add(rbox(0.120, 0.106, 0.286, 0.026), at(s * 0.100, 0.066, 0.030), 'rubber',
      rigid('foot' + S), 1.2);
    b.add(rbox(0.128, 0.034, 0.300, 0.014), at(s * 0.100, 0.017, 0.032), 'sole',
      rigid('foot' + S), 1.6);
    // Toe box, so the boot is not one slab from heel to tip.
    b.add(rbox(0.108, 0.070, 0.090, 0.030), at(s * 0.100, 0.050, 0.145), 'rubber',
      rigid('toe' + S), 1.2);
  }
}

/**
 * Carbine, authored in weapon-bone local space: bore along +Z at y = 0.052,
 * origin at the web of the firing hand. ~0.86 m overall.
 *
 * `shade` is off for every piece: the dirt-gravity ramp is a function of height
 * in the REST pose, and the weapon does not stay there.
 */
function buildWeapon(b) {
  const w = restPos('weapon');
  const put = (geo, x, y, z, rx = 0, ry = 0, rz = 0, part = 'gunMetal', uv = 1.6) =>
    b.add(geo, at(w.x + x, w.y + y, w.z + z, rx, ry, rz), part, rigid('weapon'), uv, false);

  // Lower + upper receiver.
  put(rbox(0.044, 0.082, 0.230, 0.010), 0, 0.020, 0.062, 0, 0, 0, 'gunPoly');
  put(rbox(0.046, 0.062, 0.300, 0.010), 0, 0.078, 0.070);
  // Charging handle / dust cover ridge.
  put(box(0.050, 0.016, 0.120), 0, 0.112, -0.040);
  // Pistol grip.
  put(rbox(0.038, 0.115, 0.052, 0.014), 0, -0.048, -0.028, 0.32, 0, 0, 'gunPoly');
  // Trigger guard.
  put(box(0.030, 0.012, 0.070), 0, -0.016, 0.032);
  // Magazine, raked forward like a STANAG curve.
  put(rbox(0.032, 0.185, 0.072, 0.010), 0, -0.075, 0.088, 0.20, 0, 0, 'gunPoly');
  // Handguard with a rail top.
  put(rbox(0.048, 0.060, 0.270, 0.010), 0, 0.070, 0.300, 0, 0, 0, 'gunPoly');
  put(box(0.036, 0.012, 0.270), 0, 0.104, 0.300);
  // Barrel + muzzle device.
  put(new THREE.CylinderGeometry(0.011, 0.011, 0.110, 6), 0, 0.052, 0.480, Math.PI / 2);
  put(new THREE.CylinderGeometry(0.017, 0.015, 0.058, 8), 0, 0.052, 0.552, Math.PI / 2);
  // Collapsible stock: buffer tube, cheek riser, butt pad.
  put(new THREE.CylinderGeometry(0.019, 0.019, 0.190, 6), 0, 0.072, -0.130, Math.PI / 2);
  put(rbox(0.042, 0.070, 0.150, 0.014), 0, 0.062, -0.185, 0, 0, 0, 'gunPoly');
  put(rbox(0.048, 0.104, 0.028, 0.010), 0, 0.054, -0.268, 0, 0, 0, 'gunPoly');
  // Optic: mount, tube, glass face.
  put(rbox(0.034, 0.032, 0.070, 0.008), 0, 0.120, 0.090, 0, 0, 0, 'polymer');
  put(new THREE.CylinderGeometry(0.024, 0.024, 0.098, 8), 0, 0.148, 0.092, Math.PI / 2, 0, 0, 'polymer');
  put(new THREE.CylinderGeometry(0.021, 0.021, 0.006, 8), 0, 0.148, 0.044, Math.PI / 2, 0, 0, 'optic');
  // Vertical foregrip and a sling loop: two things that break the tube.
  put(rbox(0.026, 0.078, 0.030, 0.010), 0, 0.020, 0.330, -0.12, 0, 0, 'gunPoly');
  put(box(0.030, 0.026, 0.014), 0, 0.040, -0.052);
}

let _shared = null;

/** The single bot geometry, built once and shared by every bot in the pool. */
export function getRigGeometry() {
  if (!_shared) _shared = { kit: buildKit() };
  return _shared;
}

/**
 * A fresh bone hierarchy in the rest pose plus the Skeleton bound to it.
 * Bones are `THREE.Bone` so three's own skinning path drives them.
 */
export function createSkeleton() {
  const bones = [];
  const byName = new Map();
  for (const [name, parent, x, y, z] of BONE_DEFS) {
    const bone = new THREE.Bone();
    bone.name = name;
    const p = parent ? byName.get(parent) : null;
    if (p) {
      const pd = BONE_DEFS[BONE_INDEX.get(parent)];
      bone.position.set(x - pd[2], y - pd[3], z - pd[4]);
      p.add(bone);
    } else {
      bone.position.set(x, y, z);
    }
    bone.userData.rest = new THREE.Vector3(x, y, z);
    bones.push(bone);
    byName.set(name, bone);
  }
  const root = bones[0];
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  return { bones, byName, root, skeleton };
}

export function disposeRigGeometry() {
  if (!_shared) return;
  _shared.kit.dispose();
  _shared = null;
}
