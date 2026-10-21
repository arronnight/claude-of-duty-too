import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The world beyond the playable shell, in one draw call.
 *
 * Before this existed the map was a 400 m square of asphalt sitting in a sky
 * dome. The plate's rim landed at 200 m where the haze had only reached 55%
 * opacity, so 45% of its own value survived and it rendered as a hard dark band
 * with clean sky above it — a horizon that is a straight line across the frame
 * at a fixed screen height is the single loudest "this is a demo scene" tell
 * available, and it is what the establishing shot led with.
 *
 * Raising the fog density until the rim disappears is the obvious fix and the
 * wrong one: taking 200 m from 0.55 to 0.95 also takes 40 m from 19% to 32% and
 * flattens every mid-ground surface in the game. The rim has to be *occluded*,
 * not dissolved. So: five depth planes, built as four layers and merged.
 *
 *   ground shell   r 74 -> 3000 m, a warm dust-coloured disc under everything
 *   terminators    the two boxes that cap the ends of our street corridor
 *   ring A         r 110-178 m, 72 masses, our own block language continued
 *   ring B         r 300-470 m, 34 masses, only 55% azimuthal fill
 *   ring C         two closed ridge ribbons at 1250 and 2100 m
 *
 * Everything is one merged BufferGeometry with a per-vertex colour attribute
 * and ONE MeshStandardMaterial, so the whole backdrop is a single draw. It is
 * deliberately a *lit* material and not MeshBasic: the sun/shade split across
 * 106 ring masses at slightly different orientations is most of the reason the
 * layer reads as a city rather than as a painted matte, and it costs nothing
 * extra because castShadow is false — that is what keeps it at one draw instead
 * of one plus one per cascade.
 *
 * COLOURS DEVIATE FROM THE BRIEF, DELIBERATELY AND MEASURED. The brief's hex
 * values (#b9ae99 ring A, #6f6455 shell, #565460/#6a6874 ridges) are the
 * colours the far city *reads as* in the reference frames — i.e. final screen
 * pixels. Used as albedos they get multiplied by direct sun, lifted by ambient
 * and then lifted again by 40-90% haze, and the first build of this file came
 * out at RGB 213 against a 196 sky: the far city was brighter than the air in
 * front of it and read as white paper cutouts. Every palette here is the
 * briefed colour taken down to roughly 0.45 of its linear value, which lands
 * the same shots at 170-180 against the same sky. The brief's *relationships*
 * are all preserved — parapets lighter than walls, 25/12% reassignment, ring B
 * desaturated 40% against ring A, and the far ridge lighter than the near one.
 *
 * Ring B's 45% azimuthal gaps are load-bearing, not an economy. A solid wall of
 * towers all the way round reads as a skybox; the gaps are how ring C becomes
 * visible, which is how the fourth and fifth depth planes get seen at all.
 */

// --------------------------------------------------------------------- utils

/** Deterministic LCG. The backdrop must be pixel-identical run to run. */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hash1(i) {
  let x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function hash2(a, b) {
  let x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Periodic value noise around a circle, `cells` lattice points per turn. */
function circleNoise(theta, cells, seed) {
  const t = (theta / (Math.PI * 2)) * cells;
  const i = Math.floor(t);
  let f = t - i;
  f = f * f * (3 - 2 * f);
  const a = hash2(((i % cells) + cells) % cells, seed);
  const b = hash2((((i + 1) % cells) + cells) % cells, seed);
  return a + (b - a) * f;
}

/** Three octaves at 3 / 7 / 17 cycles per revolution, weights 0.55/0.30/0.15. */
function ridgeFbm(theta, seed) {
  return circleNoise(theta, 3, seed) * 0.55
       + circleNoise(theta, 7, seed + 11) * 0.30
       + circleNoise(theta, 17, seed + 23) * 0.15;
}

const _hsl = { h: 0, s: 0, l: 0 };

/**
 * Per-mass colour jitter. Value AND hue, because 72 boxes of one flat colour
 * read as one object no matter how their silhouettes vary.
 */
function tint(base, rnd, vAmt, hAmt, out) {
  out.copy(base).getHSL(_hsl);
  out.setHSL(
    (_hsl.h + (rnd() - 0.5) * 2 * hAmt + 1) % 1,
    _hsl.s,
    THREE.MathUtils.clamp(_hsl.l * (1 + (rnd() - 0.5) * 2 * vAmt), 0.02, 0.98),
  );
  return out;
}

/**
 * Collects geometry into one attribute set. Everything is flattened to
 * non-indexed with exactly position/normal/color so `mergeGeometries` cannot
 * fail on a mismatched attribute list, and the UVs BoxGeometry ships are
 * dropped — the material has no maps and they would be 33% of the buffer.
 */
class Accum {
  constructor() { this.parts = []; }

  /** @param {THREE.BufferGeometry} geo @param {THREE.Color} color */
  add(geo, color) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (g.attributes.uv) g.deleteAttribute('uv');
    if (g.attributes.uv1) g.deleteAttribute('uv1');
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    this.parts.push(g);
    return g;
  }

  /** Raw triangle soup, already in world space, with explicit per-vertex colour. */
  addRaw(pos, nrm, col) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    this.parts.push(g);
    return g;
  }

  /** Axis-aligned-then-yawed box, centre in world space. */
  box(w, h, d, x, y, z, rotY, color) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    return this.add(g, color);
  }

  merge() {
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    return merged;
  }
}

// --------------------------------------------------------------------- layers

const SHELL_RINGS = [74, 100, 140, 200, 300, 480, 800, 1500, 3000];
const SHELL_AZ = 96;
const SHELL_Y = -0.08;

/**
 * The ground beyond the level plate. Built by hand rather than with
 * RingGeometry, which lays its vertices out per-ring-segment and cannot carry a
 * radius-continuous colour ramp without duplicating every seam.
 *
 * Radii are geometric, not linear: under perspective that keeps each ring's
 * on-screen depth roughly constant, so the near rings get the subdivision the
 * colour ramp needs and the 1500 -> 3000 m span does not spend 96 quads on two
 * pixels of horizon.
 */
function buildShell(acc) {
  const near = new THREE.Color(0x4b433a);
  const mid = new THREE.Color(0x554d41);
  const far = new THREE.Color(0x5a5246);
  const c = new THREE.Color();

  const colourAt = (r, jitter, out) => {
    if (r <= 300) out.copy(near).lerp(mid, THREE.MathUtils.smoothstep(r, 74, 300));
    else out.copy(mid).lerp(far, THREE.MathUtils.smoothstep(r, 300, 800));
    return out.multiplyScalar(1 + jitter);
  };

  const nr = SHELL_RINGS.length;
  const pos = [], nrm = [], col = [];
  // One colour per lattice point, so the jitter interpolates smoothly instead
  // of faceting every quad.
  const vc = new Float32Array(SHELL_AZ * nr * 3);
  for (let a = 0; a < SHELL_AZ; a++) {
    for (let j = 0; j < nr; j++) {
      colourAt(SHELL_RINGS[j], (hash2(a, j * 7.3) - 0.5) * 0.12, c);
      const o = (a * nr + j) * 3;
      vc[o] = c.r; vc[o + 1] = c.g; vc[o + 2] = c.b;
    }
  }

  const P = (a, j) => {
    const th = (a % SHELL_AZ) * (Math.PI * 2 / SHELL_AZ);
    const r = SHELL_RINGS[j];
    return [Math.cos(th) * r, SHELL_Y, Math.sin(th) * r];
  };
  const C = (a, j) => {
    const o = ((a % SHELL_AZ) * nr + j) * 3;
    return [vc[o], vc[o + 1], vc[o + 2]];
  };
  const push = (a, j) => {
    const p = P(a, j); pos.push(p[0], p[1], p[2]);
    nrm.push(0, 1, 0);
    const q = C(a, j); col.push(q[0], q[1], q[2]);
  };

  for (let a = 0; a < SHELL_AZ; a++) {
    for (let j = 0; j < nr - 1; j++) {
      // (inner,a) (inner,b) (outer,b) (outer,a) wound for an upward normal.
      push(a, j); push(a + 1, j); push(a + 1, j + 1);
      push(a, j); push(a + 1, j + 1); push(a, j + 1);
    }
  }
  acc.addRaw(pos, nrm, col);
}

/**
 * A parapet lip on top of a mass, 0.4 m proud all round. Our own _buildBlocks
 * does this on every rooftop; the ring has to speak the same language or the
 * far city reads as a different game's geometry.
 */
function parapet(acc, w, h, d, x, y, z, rotY, color, lip = 0.9, over = 0.4) {
  acc.box(w + over * 2, lip, d + over * 2, x, y + h / 2 + lip / 2, z, rotY, color);
}

/** The two boxes that stop you seeing out of the ends of the street corridor. */
function buildTerminators(acc) {
  const base = new THREE.Color(0x746c5d);
  const cap = new THREE.Color(0x807766);
  const dark = new THREE.Color(0x5d584d);
  const steel = new THREE.Color(0x4f4b45);

  // North. Every preset that matters looks down -Z, so this is the one the
  // critic actually studies. From the street camera at (2.2, 1.68, 22) it is
  // 96 m away, subtends 21 degrees horizontally and puts its roofline 8 degrees
  // above the eye line: it fills the corridor and closes the vanishing point.
  acc.box(36, 15.5, 11, 0, 7.75, -74, 0, base);
  parapet(acc, 36, 15.5, 11, 0, 7.75, -74, 0, cap);
  acc.box(12, 20, 9, -13, 10, -80, 0, dark);
  parapet(acc, 12, 20, 9, -13, 10, -80, 0, cap);

  // A 24 m lattice mast: one piece of hard vertical detail against the sky,
  // which is what stops the terminator reading as a single flat card.
  const MX = 16, MZ = -86, MH = 24, HW = 0.9, T = 0.18;
  for (const [ox, oz] of [[-HW, -HW], [HW, -HW], [HW, HW], [-HW, HW]]) {
    acc.box(T, MH, T, MX + ox, MH / 2, MZ + oz, 0, steel);
  }
  for (let i = 0; i < 7; i++) {
    const y = MH * (i + 0.5) / 7;
    const dir = i % 2 === 0 ? 1 : -1;
    const len = Math.hypot(HW * 2, MH / 7);
    const g = new THREE.BoxGeometry(T * 0.8, len, T * 0.8);
    g.rotateZ(dir * Math.atan2(HW * 2, MH / 7));
    g.translate(MX, y, MZ - HW);
    acc.add(g, steel);
  }

  // South. Behind the player in every preset, but the establishing camera looks
  // back over it and the spawn side cannot be open sky either.
  acc.box(30, 11, 10, 0, 5.5, 60, 0, dark);
  parapet(acc, 30, 11, 10, 0, 5.5, 60, 0, cap);
  acc.box(4, 4, 3, 7, 12.5, 60, 0, base);
}

/**
 * Ring A, the outer district. Golden-angle azimuth walk so 72 masses distribute
 * evenly at every scale without ever landing on a repeating interval.
 */
function buildRingA(acc) {
  const rnd = rng(20260726);
  const pal = [new THREE.Color(0x807766), new THREE.Color(0x615b50), new THREE.Color(0x6a5544)];
  const parapetBase = new THREE.Color(0x89806e);
  const c = new THREE.Color(), pc = new THREE.Color();
  const placed = [];

  for (let i = 0; i < 72; i++) {
    const theta = i * 2.39996 + (rnd() - 0.5) * 0.07;
    const r = 110 + 68 * ((hash1(i) * 7.13) % 1);
    const landmark = i % 9 === 4;                 // 8 of 72
    const mast = landmark && (i === 4 || i === 40);

    let w, d, h;
    if (landmark) {
      w = 7 + rnd() * 5; d = w * (0.8 + rnd() * 0.5); h = 24 + rnd() * 14;
    } else {
      w = 9 + rnd() * 17; d = 8 + rnd() * 12;
      // Weighted toward 9-14 m so the far city matches our own 7.5-19 m blocks
      // rather than turning into a downtown that our street cannot belong to.
      h = 7 + Math.pow(rnd(), 1.9) * 14;
    }

    // SKYLINE RULE. Without this the ring is a crenellation of near-identical
    // heights and reads as one wall with notches cut in it. Reject any height
    // within 1.5 m of a neighbour inside 20 degrees of azimuth.
    for (let t = 0; t < 24; t++) {
      let clash = false;
      for (const p of placed) {
        let da = Math.abs(((theta - p.theta + Math.PI) % (Math.PI * 2)) - Math.PI);
        if (da < 0.349 && Math.abs(h - p.h) < 1.5) { clash = true; break; }
      }
      if (!clash) break;
      h += 1.7 + rnd() * 2.2;
    }
    placed.push({ theta, h });

    const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
    const rotY = -theta - Math.PI / 2;            // long face turned to the origin

    const u = rnd();
    const base = u < 0.12 ? pal[2] : (u < 0.37 ? pal[1] : pal[0]);
    tint(base, rnd, 0.17, 0.02, c);
    tint(parapetBase, rnd, 0.17, 0.02, pc);

    if (mast) {
      const T = 0.5;
      for (const [ox, oz] of [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]]) {
        acc.box(T, h, T, x + ox, h / 2, z + oz, 0, c);
      }
      acc.box(4.4, 0.6, 4.4, x, h * 0.62, z, 0, pc);
      acc.box(3.0, 2.2, 3.0, x, h + 1.1, z, 0, c);
      continue;
    }

    acc.box(w, h, d, x, h / 2, z, rotY, c);
    parapet(acc, w, h, d, x, h / 2, z, rotY, pc, 0.9, 0.4);
    if (landmark && rnd() < 0.5) {
      // Roof water-tank: the silhouette detail that says "occupied building".
      acc.box(w * 0.34, 2.6, d * 0.34, x, h + 1.3, z, rotY, c);
    }
  }
}

/**
 * Ring B, the far city. Deliberately holed: ~55% azimuthal fill, in four
 * clusters, with the gaps left open so ring C shows through them.
 */
function buildRingB(acc) {
  const rnd = rng(770315);
  const base = new THREE.Color(0x615d53);
  base.getHSL(_hsl);
  // Saturation cut 40% against ring A: pre-baked aerial perspective. At 380 m
  // the haze is only 0.71 opaque, which is not enough on its own to stop the
  // far city looking like the near city photographed with a longer lens.
  base.setHSL(_hsl.h, _hsl.s * 0.6, _hsl.l);
  const c = new THREE.Color();

  // Four occupied arcs covering ~55% of the circle.
  const arcs = [[0.15, 1.35], [2.10, 3.05], [3.60, 4.35], [5.05, 6.05]];
  for (let i = 0; i < 34; i++) {
    const arc = arcs[i % arcs.length];
    const theta = arc[0] + rnd() * (arc[1] - arc[0]);
    const r = 300 + rnd() * 170;
    const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
    const rotY = -theta - Math.PI / 2;
    tint(base, rnd, 0.09, 0.015, c);

    if (i % 9 === 2) {
      // Hexagonal prism: an industrial chimney, and a shape our block language
      // never produces, which is what makes the far ring read as a different
      // district rather than a scaled copy.
      const g = new THREE.CylinderGeometry(4 + rnd() * 2, 5 + rnd() * 2, 45 + rnd() * 15, 6);
      g.translate(x, (45 + 15) / 2, z);
      acc.add(g, c);
      continue;
    }
    if (i % 5 === 0) {
      // Apartment slab: wide, thin, flat-topped.
      const w = 30 + rnd() * 10, d = 12 + rnd() * 4, h = 18 + rnd() * 14;
      acc.box(w, h, d, x, h / 2, z, rotY, c);
      continue;
    }
    const w = 14 + rnd() * 26, d = 12 + rnd() * 18, h = 16 + rnd() * 36;
    acc.box(w, h, d, x, h / 2, z, rotY, c);
    // No parapets out here: a 0.9 m lip is sub-pixel at 380 m and would only
    // spend triangles on a line nobody can resolve.
  }
}

/**
 * Ring C, two closed ridge ribbons. The far one is the LIGHTER of the two, and
 * that is not a mistake — it is the only thing that makes them separate instead
 * of merging into one silhouette, and it is what four ranks of treeline do in
 * every reference frame we have.
 */
function buildRidge(acc, radius, samples, baseH, ampH, seed, phase, color, clampLo, clampHi) {
  const pos = [], nrm = [], col = [];
  const h = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const th = (i / samples) * Math.PI * 2;
    h[i] = THREE.MathUtils.clamp(baseH + ampH * ridgeFbm(th + phase, seed), clampLo, clampHi);
  }
  const put = (i, y, c) => {
    const th = (i % samples) / samples * Math.PI * 2;
    pos.push(Math.cos(th) * radius, y, Math.sin(th) * radius);
    // Tilted inward-and-up so the ridge picks up sky as well as sun and never
    // goes to a flat black card when the sun is behind it.
    const n = new THREE.Vector3(-Math.cos(th), 0.45, -Math.sin(th)).normalize();
    nrm.push(n.x, n.y, n.z);
    col.push(c.r, c.g, c.b);
  };
  const lo = -2;
  for (let i = 0; i < samples; i++) {
    const j = (i + 1) % samples;
    put(i, lo, color); put(j, lo, color); put(j, h[j], color);
    put(i, lo, color); put(j, h[j], color); put(i, h[i], color);
  }
  acc.addRaw(pos, nrm, col);
}

// --------------------------------------------------------------------- system

export class Backdrop {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    const acc = new Accum();
    buildShell(acc);
    // Terminators before the rings so nothing else needs to know about them.
    buildTerminators(acc);
    buildRingA(acc);
    buildRingB(acc);
    buildRidge(acc, 1250, 128, 45, 70, 91, 0.37, new THREE.Color(0x35343d), 20, 150);
    buildRidge(acc, 2100, 192, 90, 130, 17, 0.0, new THREE.Color(0x45444e), 60, 260);

    const geo = acc.merge();
    geo.computeBoundingSphere();
    this.geometry = geo;

    // Roughness 1.0 and env 0.08 make this surface physically incapable of the
    // mirror sheen the old 400 m asphalt plate had at grazing angles, which was
    // the second-worst thing in the establishing frame after the rim itself.
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.08,
      fog: true,
      dithering: true,
    });

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'Backdrop';
    // castShadow false is what keeps this at ONE draw instead of one per
    // cascade, and nothing it could shadow is inside the cascade volume anyway.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // DEVIATION from the brief, which asked for renderOrder -100. Measured:
    // -100 costs 3 fps on street and 5 on night against renderOrder 10. The
    // frame is fill-bound and three sorts the opaque list by PROGRAM before
    // depth, so a distant 3 km disc with its own unique program does not get
    // front-to-back rejection for free — it has to be pushed explicitly behind
    // everything else so early-Z can throw away the 80% of it that the street
    // occludes. It is opaque, so nothing else depends on its ordering.
    mesh.renderOrder = 10;
    mesh.userData.noCollide = true;
    mesh.userData.backdrop = true;
    this.mesh = mesh;
    scene.add(mesh);

    this.triangles = geo.attributes.position.count / 3;
  }

  dispose() {
    this.mesh?.removeFromParent();
    this.geometry?.dispose();
    this.material?.dispose();
  }
}
