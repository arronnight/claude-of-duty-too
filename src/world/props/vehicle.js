import * as THREE from 'three';
import { chamferBox, pipeGeo, projectUV, loftGeo, twoSided, Batch } from './lib.js';
import { tintFor } from './overhead.js';

/**
 * The car.
 *
 * Every reference frame in `refs/` that reads as Call of Duty rather than as a
 * tech demo is anchored by a vehicle, and until now ours was eight chamfered
 * boxes in `metal_rusted` at roughness 0.78. A stack of boxes cannot produce
 * the two things that identify a car at 20 m: a continuous shoulder line
 * running the whole length of the body, and a roof that flows into the
 * pillars. It also has no environment reflection, because rusted steel at 0.78
 * has none, and a car in daylight is mostly a mirror of the sky.
 *
 * So the body is a LOFT — `lib.loftGeo` through eleven cross-sections at real
 * saloon dimensions (4.55 x 1.76 x 1.44, wheelbase 2.68, track 1.50) — and the
 * three-box silhouette falls out of collapsing the four cabin points to the
 * beltline forward of z = +0.55 and aft of z = -1.30. That collapse, blended
 * over two stations, produces a 28 degree windscreen rake for free, which is
 * the number a saloon actually has.
 *
 * ## The two-bucket rule
 *
 * The wave funds exactly +4 draw calls for vehicles, and that buys precisely
 * two buckets in props-core's `vehicles` BatchSet:
 *
 *   `car_paint`  shadow-casting  -> 1 draw + 2 cascades
 *   `car_trim`   shadows off     -> 1 draw
 *
 * Everything on the car maps onto one of those two and the differences between
 * panels ride in the vertex colour, not in a third material. That is not a
 * compromise on the two cues that matter:
 *
 *  - Painted wing against unpainted bumper still reads, because `car_paint` is
 *    clearcoat 1.0 at roughness 0.34 and `car_trim` is roughness 0.48 at
 *    metalness 0.55. The break is in the specular response, which is where a
 *    viewer reads it, not in the albedo.
 *  - Glazing is `car_paint` at a vertex tint of 0.08. A clearcoated near-black
 *    surface IS a dark mirror, and from across a street that is exactly what a
 *    car window looks like. It also costs nothing, because it lands in the
 *    body's own bucket. The `glass` key was deliberately not used: it is a
 *    transmissive `MeshPhysicalMaterial` and this frame is fill-bound.
 *
 * Tyres and arch liners go to the caller's `rubber` bucket, which the tyre
 * stacks in `furniture.js` have already paid for.
 */

const _c = new THREE.Color();
const _t = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** `metal_painted`'s albedo, which every `car_*` variant is based on. */
const BASE_PAINT = new THREE.Color(0x59666b);
/** Paint is allowed well past 1.0; see `tintFor`'s note on the AO clamp. */
const PAINT_K = 3.2;

/** Factory paint. Sand and silver give the best sky gradient down the flank. */
export const PAINT = [0x1b2430, 0x6e7377, 0x8c8578, 0x2b2b2d, 0x7a2f28];

// ------------------------------------------------------------------- profile

/**
 * Station z, cabin presence and half-width scale, index-aligned.
 *
 * `CABIN` is the fraction of the greenhouse present at that station. The 0.5
 * entries at z = +0.90 and z = -1.34 are the blend that makes the screens
 * raked rather than vertical; drop them and the car becomes three literal
 * boxes with square glass.
 */
const ST_Z = [2.275, 2.05, 1.60, 1.34, 0.90, 0.55, 0, -0.75, -1.34, -1.90, -2.275];
const ST_CABIN = [0, 0, 0, 0, 0.5, 1, 1, 1, 0.5, 0, 0];
const ST_WSCALE = [0.90, 0.95, 1, 1, 1, 1, 1, 1, 1, 0.985, 0.90];

/**
 * Right half of the cross-section, bottom to top. Index 4 is the beltline: the
 * four points above it are the ones the cabin blend collapses.
 */
const PROFILE = [
  [0.80, 0.16], [0.86, 0.30], [0.875, 0.55], [0.88, 0.90], [0.855, 1.02],
  [0.79, 1.24], [0.70, 1.40], [0.40, 1.44], [0.0, 1.445],
];
const BELT_I = 4;
const BELT_Y = 1.02;
const AXLE_Z = 1.34;
const WHEEL_R = 0.3175;
const TRACK_HALF = 0.75;

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Builds the loft sections.
 *
 * `cutY` is what gives the car genuine wheel-arch openings in silhouette
 * rather than a painted-on arch: at the axle stations the bottom of the
 * section is clamped up to 0.44, which is 20 cm below the top of a 195/65R15,
 * so the tyre visibly fills a mouth in the body. Smoothstepped over +/-0.45 m
 * so the arch has a mouth rather than a step.
 */
function bodySections(lod) {
  const idx = lod ? [0, 3, 5, 8, 10] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const out = [];
  for (const i of idx) {
    const z = ST_Z[i];
    const cab = ST_CABIN[i];
    const near = Math.min(Math.abs(z - AXLE_Z), Math.abs(z + AXLE_Z));
    const arch = 1 - smoothstep(0, 0.45, near);
    const pts = [];
    for (let j = 0; j < PROFILE.length; j++) {
      const [px, py] = PROFILE[j];
      pts.push([px, j > BELT_I ? BELT_Y + (py - BELT_Y) * cab : py]);
    }
    out.push({ z, pts, wScale: ST_WSCALE[i], cutY: 0.16 + (0.44 - 0.16) * arch });
  }
  return out;
}

// -------------------------------------------------------------------- wheel

/**
 * A 195/65R15 as a lathe, not a torus.
 *
 * `TorusGeometry(0.33, 0.21)` is a doughnut: no flat tread band, no shoulder
 * radius, no sidewall. It reads as a black ring rather than as a tyre and it
 * is the most obvious single tell on the old vehicle. This is the real
 * section — flat across 12 cm of tread, a shoulder turning down over 2.8 cm,
 * then a straight sidewall in to the bead.
 */
function tyreGeo() {
  const half = [[0.190, 0.0975], [0.250, 0.0975], [0.300, 0.088], [0.3175, 0.060], [0.3175, 0]];
  const pts = [];
  for (let i = half.length - 1; i >= 0; i--) pts.push(new THREE.Vector2(half[i][0], -half[i][1]));
  for (let i = 1; i < half.length; i++) pts.push(new THREE.Vector2(half[i][0], half[i][1]));
  const g = new THREE.LatheGeometry(pts, 14);
  g.rotateZ(Math.PI / 2);
  projectUV(g);
  return g;
}

/**
 * Rim: a dish, five spokes and a hub cap, pre-merged so a wheel is one `add`.
 *
 * Built for the RIGHT side and mirrored with a half turn about Y for the left.
 * A negative X scale would be shorter but it reverses triangle winding, and a
 * back-facing rim is an invisible rim.
 */
function rimGeo(bare) {
  const b = new Batch('rim');
  b.add(pipeGeo(0.19, 0.055, 12, true, 0.012).rotateZ(Math.PI / 2), 0, 0, 0);
  if (!bare) {
    const spoke = chamferBox(0.048, 0.30, 0.036, 0.007);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      _e.set(a, 0, 0, 'XYZ');
      _q.setFromEuler(_e);
      _m.compose(_v.set(0.030, Math.cos(a) * 0.14, Math.sin(a) * 0.14), _q, _s.set(1, 1, 1));
      b.addMatrix(spoke, _m, null);
    }
    b.add(pipeGeo(0.055, 0.03, 10, true, 0.008).rotateZ(Math.PI / 2), 0.052, 0, 0);
  }
  const g = b.build();
  projectUV(g);
  return g;
}

/** Half-cylinder arch liner, seen from inside the arch as well as outside. */
function linerGeo() {
  const g = new THREE.CylinderGeometry(0.365, 0.365, 0.21, 12, 1, true, 0, Math.PI);
  g.rotateZ(Math.PI / 2);
  projectUV(g);
  return twoSided(g);
}

// ------------------------------------------------------------------- glazing

/**
 * All six windows as one flat-quad shell laid 1.5 cm proud of the body.
 *
 * The brief asked for an inner shell offset inward, which cannot work here:
 * the loft is a CLOSED solid, so anything placed inside it is invisible. Laid
 * on the outside instead, one quad per aperture, each corner authored
 * individually so the glass tapers with the body's tumblehome — a rectangular
 * panel would poke 7 cm out of the roof rail at the top of the door.
 */
function glazingGeo() {
  const tri = [];
  const nrm = [];
  const uv = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const quad = (p) => {
    A.set(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]);
    B.set(p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]);
    C.crossVectors(A, B).normalize();
    for (const j of [0, 1, 2, 0, 2, 3]) {
      tri.push(p[j][0], p[j][1], p[j][2]);
      nrm.push(C.x, C.y, C.z);
      uv.push(j === 1 || j === 2 ? 1 : 0, j >= 2 ? 1 : 0);
    }
  };
  // Windscreen and backlight, wound so the outward face is the visible one.
  quad([[-0.74, 1.035, 1.335], [0.74, 1.035, 1.335], [0.42, 1.432, 0.565], [-0.42, 1.432, 0.565]]);
  quad([[0.72, 1.035, -1.355], [-0.72, 1.035, -1.355], [-0.40, 1.432, -0.755], [0.40, 1.432, -0.755]]);
  // Door glass, both sides, tapered in with the roof.
  for (const s of [1, -1]) {
    const flip = s > 0 ? (p) => p : (p) => [p[3], p[2], p[1], p[0]];
    quad(flip([
      [s * 0.848, 1.055, 0.50], [s * 0.848, 1.055, -0.16],
      [s * 0.762, 1.325, -0.16], [s * 0.762, 1.315, 0.46],
    ]));
    quad(flip([
      [s * 0.848, 1.055, -0.30], [s * 0.848, 1.055, -0.93],
      [s * 0.755, 1.290, -0.90], [s * 0.762, 1.320, -0.30],
    ]));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tri), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  return g;
}

// ------------------------------------------------------------------ geometry

let V = null;
function vgeo() {
  if (V) return V;
  const cb = chamferBox;
  const rimR = rimGeo(false);
  const bareR = rimGeo(true);
  V = {
    body: loftGeo(bodySections(false), 40),
    bodyLod: loftGeo(bodySections(true), 40),
    tyre: tyreGeo(),
    rimR, rimL: rimR.clone().rotateY(Math.PI),
    bareR, bareL: bareR.clone().rotateY(Math.PI),
    liner: linerGeo(),
    drum: pipeGeo(0.30, 0.16, 8, true, 0.03).rotateZ(Math.PI / 2),
    glazing: glazingGeo(),

    grille: cb(0.92, 0.20, 0.06, 0.010),
    grilleSurround: cb(1.00, 0.27, 0.045, 0.010),
    slat: cb(0.88, 0.018, 0.05, 0.004),
    lamp: cb(0.36, 0.16, 0.10, 0.012),
    bowl: pipeGeo(0.075, 0.06, 10, true, 0.012).rotateX(Math.PI / 2),
    indicator: cb(0.16, 0.09, 0.05, 0.010),
    tail: cb(0.34, 0.13, 0.05, 0.010),
    plate: cb(0.52, 0.115, 0.02, 0.005),
    bumper: cb(1.72, 0.28, 0.18, 0.035),
    valance: cb(1.55, 0.14, 0.10, 0.02),
    sill: cb(0.055, 0.13, 2.30, 0.014),
    handle: cb(0.13, 0.03, 0.025, 0.006),
    mirrorPod: cb(0.15, 0.09, 0.10, 0.022),
    mirrorStalk: pipeGeo(0.018, 0.09, 6, false).rotateZ(Math.PI / 2),
    frit: cb(0.030, 0.05, 2.05, 0.006),
    exhaust: pipeGeo(0.028, 0.14, 6, true, 0.006).rotateX(Math.PI / 2),
    wiper: cb(0.44, 0.016, 0.020, 0.004),
  };
  return V;
}

// -------------------------------------------------------------------- colour

/** Absolute colour -> the vertex tint that produces it on a `car_*` variant. */
function paintTint(out, hex, mul = 1) {
  _t.set(hex);
  if (mul !== 1) _t.multiplyScalar(mul);
  return tintFor(out, _t, BASE_PAINT, PAINT_K);
}

/** Soot ramp for the burnt-out variant: t = 0 at the tail, 1 at the nose. */
function sootTint(out, t, rand) {
  const k = 0.17 + 0.17 * (1 - t) + rand() * 0.06;
  return out.setRGB(k * 1.06, k * 0.99, k * 0.94);
}

// --------------------------------------------------------------------- build

/**
 * Places one car.
 *
 * @param {{veh:object, rubber:object, colliders?:any[]}} sets destination
 *   BatchSets: the vehicles set and whichever set owns the shared `rubber`
 *   bucket (the core set, in practice).
 * @param {'A'|'B'|'C'} variant parked intact / burnt out / distant silhouette
 */
export function car(sets, rand, x, y, z, yaw, variant = 'A', colliders = null) {
  const g = vgeo();
  const veh = sets.veh;
  const rub = sets.rubber || sets.veh;
  const burnt = variant === 'B';
  const lod = variant === 'C';
  const ride = burnt ? -0.10 : 0;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  let parts = 0;

  /** Local (+Z nose, +X right, y = 0 at the wheel contact plane) -> world. */
  const put = (set, key, gm, ox, oy, oz, pitch, roll, sx, sy, sz, col, shadow) => {
    _e.set(pitch, yaw, roll, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(
      _v.set(x + ox * cs + oz * sn, y + oy + ride, z - ox * sn + oz * cs),
      _q, _s.set(sx, sy, sz),
    );
    set.addMatrix(key, gm, _m, col, shadow);
    parts++;
  };

  const paint = new THREE.Color();
  if (burnt) sootTint(paint, 0.5, rand);
  else paintTint(paint, PAINT[(rand() * PAINT.length) | 0]);

  put(veh, 'car_paint', lod ? g.bodyLod : g.body, 0, 0, 0, 0, 0, 1, 1, 1, paint, true);

  // --- Wheels.
  const bareCorner = burnt ? (rand() * 4) | 0 : -1;
  let corner = 0;
  for (const sx of [-1, 1]) {
    for (const oz of [AXLE_Z, -AXLE_Z]) {
      // Collapsed suspension puts a burnt car down on its rims, so the wheel
      // centre drops with the body but the rim does not shrink with it.
      const flat = burnt && corner !== bareCorner && rand() < 0.5;
      const wy = WHEEL_R - ride - (flat ? 0.06 : 0);
      _c.setRGB(0.30, 0.29, 0.29);
      put(rub, 'rubber', g.liner, sx * (TRACK_HALF - 0.02), WHEEL_R + 0.04, oz,
        0, 0, 1, 1, 1, _c, false);
      if (corner === bareCorner) {
        _c.setRGB(0.42, 0.38, 0.34);
        put(veh, 'car_trim', g.drum, sx * TRACK_HALF, 0.30 - ride, oz, 0, 0, 1, 1, 1, _c, false);
      } else {
        _c.setRGB(0.82, 0.80, 0.80);
        put(rub, 'rubber', g.tyre, sx * TRACK_HALF, wy, oz, 0, 0,
          1, flat ? 0.88 : 1, 1, _c, true);
        if (!lod) {
          const rim = burnt ? (sx > 0 ? g.bareR : g.bareL) : (sx > 0 ? g.rimR : g.rimL);
          const k = burnt ? 0.5 : 1.15;
          _c.setRGB(k, k * 0.99, k * 0.97);
          put(veh, 'car_trim', rim, sx * (TRACK_HALF + 0.018), wy, oz, 0, 0, 1, 1, 1, _c, false);
        }
      }
      corner++;
    }
  }
  if (lod) {
    if (colliders) {
      colliders.push({ w: 1.9, h: 1.45, d: 4.5, x, y: y + 0.72, z, yaw, surface: 'metal_painted' });
    }
    return { parts, hotspot: null };
  }

  // --- Glazing.
  if (!burnt) {
    _c.setRGB(0.075, 0.080, 0.092);
    put(veh, 'car_paint', g.glazing, 0, 0, 0, 0, 0, 1.012, 1, 1.004, _c, true);
    // Weather strip along the beltline: matte against the glass above it, which
    // is why it is in the trim bucket rather than in the paint bucket.
    _c.setRGB(0.22, 0.22, 0.23);
    for (const sx of [-1, 1]) {
      put(veh, 'car_trim', g.frit, sx * 0.856, 1.045, -0.20, 0, 0, 1, 1, 1, _c, false);
    }
    _c.setRGB(0.30, 0.30, 0.31);
    put(veh, 'car_trim', g.wiper, -0.18, 1.06, 1.30, 0.20, 0.06, 1, 1, 1, _c, false);
    put(veh, 'car_trim', g.wiper, 0.30, 1.07, 1.31, 0.20, -0.04, 1, 1, 1, _c, false);
  }

  // --- Front end.
  _c.setRGB(0.16, 0.16, 0.17);
  put(veh, 'car_trim', g.grille, 0, 0.70, 2.215, 0, 0, 1, 1, 1, _c, false);
  _c.setRGB(burnt ? 0.30 : 1.30, burnt ? 0.29 : 1.30, burnt ? 0.28 : 1.32);
  put(veh, 'car_trim', g.grilleSurround, 0, 0.70, 2.190, 0, 0, 1, 1, 1, _c, false);
  _c.setRGB(0.34, 0.34, 0.36);
  for (let k = 0; k < 5; k++) {
    put(veh, 'car_trim', g.slat, 0, 0.615 + k * 0.043, 2.243, 0, 0, 1, 1, 1, _c, false);
  }
  for (const sx of [-1, 1]) {
    // The lens is paint-bucket because it wants the clearcoat; the reflector
    // bowls behind it are trim and bright, and they are what stops a headlight
    // reading as a painted rectangle.
    if (burnt) _c.setRGB(0.20, 0.20, 0.20); else _c.setRGB(1.9, 1.95, 2.0);
    put(veh, 'car_paint', g.lamp, sx * 0.60, 0.79, 2.20, 0, 0, 1, 1, 1, _c, true);
    if (!burnt) {
      _c.setRGB(2.4, 2.4, 2.4);
      for (const ob of [-0.085, 0.085]) {
        put(veh, 'car_trim', g.bowl, sx * 0.60 + ob, 0.79, 2.218, 0, 0, 1, 1, 1, _c, false);
      }
    }
    paintTint(_c, 0xd08a2a, burnt ? 0.25 : 1.6);
    put(veh, 'car_paint', g.indicator, sx * 0.80, 0.79, 2.170, 0, 0, 1, 1, 1, _c, true);
    paintTint(_c, 0xb02418, burnt ? 0.25 : 1.5);
    put(veh, 'car_paint', g.tail, sx * 0.62, 0.98, -2.230, 0, 0, 1, 1, 1, _c, true);
  }

  // --- Bumpers. The material break between a painted wing and an unpainted
  // bumper is one of the strongest realism cues a car has, so these are
  // separate parts in the matte bucket rather than more body colour.
  _c.setRGB(burnt ? 0.20 : 0.52, burnt ? 0.20 : 0.52, burnt ? 0.20 : 0.54);
  put(veh, 'car_trim', g.bumper, 0, 0.46, 2.230, 0.05, 0, 1, 1, 1, _c, false);
  put(veh, 'car_trim', g.bumper, 0, 0.50, -2.250, -0.05, 0, 1, 1, 1, _c, false);
  _c.multiplyScalar(0.72);
  put(veh, 'car_trim', g.valance, 0, 0.28, 2.185, 0.22, 0, 1, 1, 1, _c, false);
  for (const sx of [-1, 1]) {
    put(veh, 'car_trim', g.sill, sx * 0.860, 0.28, -0.05, 0, 0, 1, 1, 1, _c, false);
  }
  if (!burnt) {
    _c.setRGB(1.6, 1.6, 1.55);
    put(veh, 'car_trim', g.plate, 0, 0.50, 2.272, 0, 0, 1, 1, 1, _c, false);
    put(veh, 'car_trim', g.plate, 0, 0.72, -2.286, 0, 0, 1, 1, 1, _c, false);
  }
  _c.setRGB(0.55, 0.53, 0.50);
  put(veh, 'car_trim', g.exhaust, -0.42, 0.30, -2.30, 0, 0, 1, 1, 1, _c, false);

  // --- Side detail.
  for (const sx of [-1, 1]) {
    put(veh, 'car_paint', g.mirrorPod, sx * 0.965, 1.06, 0.60, 0, 0, 1, 1, 1, paint, true);
    _c.setRGB(0.30, 0.30, 0.31);
    put(veh, 'car_trim', g.mirrorStalk, sx * 0.905, 1.05, 0.60, 0, 0, 1, 1, 1, _c, false);
    if (!burnt) {
      _c.setRGB(1.15, 1.15, 1.15);
      put(veh, 'car_trim', g.handle, sx * 0.884, 0.92, 0.30, 0, 0, 1, 1, 1, _c, false);
      put(veh, 'car_trim', g.handle, sx * 0.884, 0.92, -0.62, 0, 0, 1, 1, 1, _c, false);
    }
  }

  // --- Burnt extras: the bonnet sprung open on the same loft, so the wreck
  // keeps a car silhouette instead of turning into a different prop.
  if (burnt) {
    sootTint(_c, 0.95, rand);
    put(veh, 'car_paint', g.grilleSurround, 0, 1.16, 1.40, -0.35, 0.04, 1.7, 3.6, 1, _c, true);
    _c.setRGB(0.15, 0.14, 0.14);
    put(veh, 'car_trim', g.bumper, 0, 0.88, 1.58, 0, 0, 0.52, 1.5, 3.2, _c, false);
  }

  if (colliders) {
    colliders.push({
      w: 1.9, h: 1.45, d: 4.5, x, y: y + 0.72, z, yaw,
      surface: burnt ? 'metal_rusted' : 'metal_painted',
    });
  }
  return { parts, hotspot: { x, z, r: burnt ? 3.2 : 2.6 } };
}

// ----------------------------------------------------------------- placement

/**
 * The street centreline, derived from the survey and nothing else.
 *
 * `furniture.js` used to rejection-sample cars out of a `road` field, which is
 * why four of the ten presets — street, goldenhour, weapon and ads — had no
 * car in them at all: a rejection sampler puts cars where there is room, and
 * where there is room is not where the camera is pointing. A carriageway has a
 * centreline and cars park along it, so find the centreline.
 *
 * Layout-agnostic, per the architecture contract: take the longest facade,
 * raycast its own normal until something stops it, and the midline between the
 * two is the street. No map coordinate appears anywhere.
 */
export function streetAxis(ctx, site) {
  const f = site.facades && site.facades[0];
  if (!f) return null;
  const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
  if (len < 8) return null;
  const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;

  // Probe from three points along the facade and take the median width, so one
  // doorway or one alley mouth cannot define the street.
  const widths = [];
  const phys = ctx.physics;
  if (phys?.raycast) {
    _dir.set(f.nx, 0, f.nz);
    for (const t of [0.3, 0.5, 0.7]) {
      _v2.set(f.ax + ux * len * t + f.nx * 0.3, f.base + 1.5, f.az + uz * len * t + f.nz * 0.3);
      const hit = phys.raycast(_v2, _dir, 46);
      if (hit && hit.distance > 4) widths.push(hit.distance + 0.3);
    }
  }
  widths.sort((a, b) => a - b);
  const w = widths.length ? widths[widths.length >> 1] : 12;
  const halfW = Math.min(9, w * 0.5);
  let cx = f.ax + f.nx * halfW, cz = f.az + f.nz * halfW;

  /**
   * March the centreline out past the ends of the facade that defined it.
   *
   * A facade segment is a run of grid cells sharing one wall normal, so the
   * longest one on this map is 15 m — one building — while the carriageway it
   * faces is four times that. Placing cars over the facade's own span put
   * every one of them 45 m from the camera, in the fog, which is exactly the
   * failure this item was supposed to fix. So walk the centreline in both
   * directions while there is still road under it and road either side.
   */
  const drivable = (x, z) => {
    const y = site.groundAt(x, z);
    if (y === null) return false;
    const a = site.groundAt(x + f.nx * (halfW - 3), z + f.nz * (halfW - 3));
    const b = site.groundAt(x - f.nx * (halfW - 3), z - f.nz * (halfW - 3));
    return a !== null && b !== null;
  };
  const march = (sx, sz, dir) => {
    let d = 0, miss = 0;
    while (d < 80 && miss < 3) {
      d += 1;
      if (drivable(sx + ux * d * dir, sz + uz * d * dir)) miss = 0; else miss++;
    }
    return Math.max(0, d - miss);
  };
  const back = march(cx, cz, -1);
  const fwd = march(cx + ux * len, cz + uz * len, 1) + len;
  cx -= ux * back; cz -= uz * back;
  return {
    ax: cx, az: cz,
    ux, uz, nx: f.nx, nz: f.nz,
    yaw: Math.atan2(ux, uz), len: back + fwd, halfW,
  };
}

/**
 * Parks cars along that centreline.
 *
 * Positions are deterministic fractions of the street's length, not rejection
 * samples, which is the entire point: a preset that looks down the street now
 * has a car in it by construction.
 *
 * The far group exists to fix "the distant street fogs to featureless white
 * with no silhouette behind it". They are authored at full detail rather than
 * as the variant-C LOD, deliberately: nothing here can know which end of the
 * facade the camera is standing at, and a 130-triangle bar of soap seen from
 * 6 m would be a far worse failure than 4 000 triangles nobody can resolve at
 * 60 m. The frame is fill-bound and triangles are the cheap axis — 7 cars are
 * about 28 k against 2.4 M spare.
 */
export function placeVehicles(ctx, site, sets, rand, density = 1) {
  const ax = streetAxis(ctx, site);
  let parts = 0;
  const hotspots = [];
  const colliders = sets.colliders || null;
  if (!ax) return { parts, hotspots };

  /**
   * A kerbside slot. `side` is -1 / +1 across the street; the offset walks in
   * from the kerb until the four corners of the car are on one level, so a
   * car never ends up straddling a step with two wheels in the air.
   */
  const at = (t0, side) => {
    for (const dt of [0, 0.02, -0.02, 0.045, -0.045, 0.075, -0.075]) {
      const t = t0 + dt;
      if (t < 0.02 || t > 0.98) continue;
      // Height of the carriageway itself at this station. A car has to be on
      // it: the first pass walked in from the kerb and took the first flat
      // spot, which is the PAVEMENT, so the hero car ended up parked across a
      // shopfront with all four wheels up on the footway.
      const roadY = site.groundAt(ax.ax + ax.ux * ax.len * t, ax.az + ax.uz * ax.len * t);
      // Walk in from the kerb. The far insets matter: on this map the east
      // footway is nearly 5 m deep, and with only four steps every car on
      // that side failed the carriageway-height test and fell back to the
      // west kerb, which put all seven of them in one line.
      for (const inset of [2.6, 3.2, 3.9, 4.7, 5.6, 6.5]) {
        const off = (ax.halfW - inset) * side;
        const x = ax.ax + ax.ux * ax.len * t + ax.nx * off;
        const z = ax.az + ax.uz * ax.len * t + ax.nz * off;
        const y = site.groundAt(x, z);
        if (y === null) continue;
        if (roadY !== null && Math.abs(y - roadY) > 0.05) continue;
        // All four corners on one level, so a car never straddles a kerb with
        // two wheels in the air.
        const a = site.groundAt(x + ax.nx * 0.85, z + ax.nz * 0.85);
        const b = site.groundAt(x - ax.nx * 0.85, z - ax.nz * 0.85);
        if (a === null || b === null) continue;
        if (Math.abs(a - y) > 0.07 || Math.abs(b - y) > 0.07) continue;
        if (!site.free(x, z, 2.1)) continue;
        return { x, y, z };
      }
    }
    return null;
  };

  // Two parked at the kerb and one burnt out across the middle. That last one
  // is how Call of Duty blocks a lane, and it is why bo6_03 has a foreground.
  // Evenly spread down the whole street rather than clustered at three
  // fractions. Nothing here can know where the camera will stand, so the only
  // robust guarantee that a preset looking down the street has a car in it is
  // a car every twelve metres or so, on alternating kerbs.
  const slots = [
    [0.12, -1, 'A'], [0.24, 1, 'A'], [0.36, -1, 'A'], [0.48, 0.3, 'B'],
    [0.60, 1, 'A'], [0.72, -1, 'A'], [0.86, 1, 'B'],
  ];
  let placed = 0;
  const dbg = [];
  for (const [t, side, variant] of slots) {
    if (placed >= Math.max(3, Math.round(7 * density))) break;
    const p = at(t, side) || at(t, -side);
    dbg.push({ t, side, variant, p: p ? [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10] : null });
    if (!p) continue;
    site.occupy(p.x, p.z, 2.6);
    // Cars park nearly parallel to the kerb. The old placement used a +/-0.45
    // rad spread plus a 25% chance of a right angle, which reads as a pile-up.
    const yaw = ax.yaw + (rand() - 0.5) * 0.14
      + (variant === 'B' ? 0.42 + rand() * 0.3 : 0)
      + (rand() < 0.3 ? Math.PI : 0);
    const r = car(sets, rand, p.x, p.y, p.z, yaw, variant, colliders);
    parts += r.parts;
    if (r.hotspot) hotspots.push(r.hotspot);
    placed++;
  }
  if (globalThis.window) window.__VEHDBG__ = { ax, dbg, placed };
  return { parts, hotspots };
}
