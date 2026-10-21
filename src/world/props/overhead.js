import * as THREE from 'three';
import {
  chamferBox, pipeGeo, corrugatedGeo, clothGeo, cableGeo, lumpGeo, projectUV, jitterColor,
  layFlat, shellGeo, SHELL_T,
} from './lib.js';

/**
 * Vertical interest — `ART_DIRECTION.md` rule 6: "the upper third of the frame
 * must not be empty sky".
 *
 * Two frames drive this module. The eye-level street shots have nothing above
 * the parapet line, and the establishing camera looks down on rooftops that are
 * bare grey slabs. Both are fixed with the same kind of content, placed against
 * the survey's facade segments and roof rectangles.
 *
 * The single cheapest thing in the game is the cable run. A catenary tube is a
 * few dozen triangles, it reads at any distance because it is pure silhouette
 * against sky, and a street with wires strung across it is instantly a *place*
 * rather than a corridor of boxes. Everything else here — awnings, laundry,
 * roof plant, water tanks, vent stacks — is doing the same job with more
 * geometry.
 *
 * Rooftops also get a parapet. The blockout caps each block with a solid slab
 * and no upstand, which from above reads as a table rather than a roof; a
 * 0.55 m ring round the edge changes that for four boxes.
 */

const _c = new THREE.Color();
const _hsl = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();

let G = null;
function geo() {
  if (G) return G;
  G = {
    // Along local X so the placement helpers only have to yaw.
    barAlong: pipeGeo(0.03, 1, 6, false).rotateZ(Math.PI / 2),
    barOut: pipeGeo(0.028, 1, 6, false).rotateX(Math.PI / 2),
    post: pipeGeo(0.04, 1, 6, false),
    // Folded steel has a real 2-3 mm bend radius at its cut edge, never zero.
    // `shellGeo` is `twoSided` plus that edge, for four extra triangles a rim
    // segment, and it is the difference between a sheet and a cut-out.
    sheet: shellGeo(layFlat(corrugatedGeo(1, 1, 12, 0.016)), 0.006),
    canvas: null,        // built per-instance: the sag has to match the span
    tank: pipeGeo(0.62, 1.35, 12, true, 0.05),
    tankLid: pipeGeo(0.3, 0.1, 10, true, 0.02),
    stack: pipeGeo(0.12, 1, 8, true, 0.02),
    cowl: pipeGeo(0.2, 0.18, 8, true, 0.04),
    acBig: chamferBox(1.35, 0.85, 1.05, 0.05),
    acFan: pipeGeo(0.4, 0.09, 12, true, 0.02),
    acLouvre: chamferBox(1.2, 0.06, 0.9, 0.012),
    plinth: chamferBox(1.7, 0.16, 1.4, 0.03),
    parapet: chamferBox(1, 0.55, 0.26, 0.035),
    coping: chamferBox(1, 0.07, 0.34, 0.02),
    crate: chamferBox(0.62, 0.5, 0.44, 0.022),
    shackWall: shellGeo(corrugatedGeo(1, 1, 10, 0.02), 0.006),
    step: chamferBox(1.05, 0.05, 0.28, 0.008),
    rail: pipeGeo(0.022, 1, 5, false).rotateZ(Math.PI / 2),
    railPost: pipeGeo(0.02, 1, 5, false),
    grate: chamferBox(1, 0.05, 1, 0.008),
    dish: (() => {
      const pts = [];
      for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(new THREE.Vector2(t * 0.5, t * t * 0.2)); }
      const g = new THREE.LatheGeometry(pts, 14);
      g.rotateX(Math.PI / 2 - 0.3);
      projectUV(g);
      return g;
    })(),
    lump: lumpGeo(0.5, 0.4, [1, 0.5, 1], 1, 3),
  };
  return G;
}

// ------------------------------------------------------------------- colour

/**
 * Turns a wanted *absolute* colour into the vertex tint that produces it on a
 * given material.
 *
 * A merged batch has one material per bucket, so the only per-piece colour
 * channel is the vertex attribute, and that attribute is a multiplier over the
 * material's own albedo. Every existing caller works around this by nudging a
 * jitter up or down, which is fine for beige-on-beige but cannot reach a red
 * shirt through a warm-grey canvas: the multiplier needed is 0.86 red against
 * 0.19 green, and `jitterColor` only walks a warm/cool axis by design.
 *
 * So: author the colour you actually want, divide out the base, clamp.
 *
 * On the clamp: `SurfaceShader` folds vertex colour into its AO term as
 * `clamp(mean(vColor), 0, 1)`, so a multiplier above 1 costs nothing there —
 * it saturates at "no occlusion" rather than compounding. The default 1.25 is
 * therefore a taste limit for cloth and clutter, not a correctness one, and
 * car paint raises it: `metal_painted`'s albedo map averages about 0.10 linear
 * and a sand-coloured car is 0.26, which is simply a multiplier of 2.6.
 */
export function tintFor(out, wanted, base, maxK = 1.25) {
  const cl = (v) => (v < 0.02 ? 0.02 : v > maxK ? maxK : v);
  out.setRGB(cl(wanted.r / base.r), cl(wanted.g / base.g), cl(wanted.b / base.b));
  return out;
}

/** Material base albedos, mirrored from `MaterialDefs` so `tintFor` can divide. */
const BASE_LIGHT = new THREE.Color(0xbfb6a4);   // fabric_light
const BASE_CANVAS = new THREE.Color(0x7a7054);  // fabric_canvas

/**
 * Washing-line palette.
 *
 * A street of beige props with one red shirt on a line is a photograph; a
 * street of beige props with a beige sheet on a line is a render. The hues are
 * the ones that actually turn up on a domestic line — whites and creams
 * dominate, then a handful of dyed garments — and saturated pieces are capped
 * per run so the line does not turn into bunting.
 */
const LAUNDRY_HUES = [0.02, 0.09, 0.13, 0.33, 0.55, 0.60];

function laundryTint(out, rand, saturatedLeft) {
  const dyed = saturatedLeft > 0 && rand() < 0.55;
  if (dyed) {
    const h = LAUNDRY_HUES[(rand() * LAUNDRY_HUES.length) | 0];
    _hsl.setHSL(h, 0.15 + rand() * 0.40, 0.45 + rand() * 0.35);
  } else {
    // Not pure white: unbleached cotton dried in a dusty street.
    _hsl.setHSL(0.09, 0.03 + rand() * 0.05, 0.62 + rand() * 0.24);
  }
  tintFor(out, _hsl, BASE_LIGHT);
  return dyed;
}

/** Awning cloth: cream dominant, then the two faded shop colours. */
function awningTint(out, rand) {
  const r = rand();
  const hex = r < 0.45 ? 0xc9bda4 : r < 0.70 ? 0x8a3f34 : r < 0.90 ? 0x4d5f53 : 0xc9bda4;
  _hsl.set(hex);
  tintFor(out, _hsl, BASE_CANVAS);
  return r >= 0.90;   // the last band is the striped one
}

/** First hit looking straight across from a point, or null. */
function acrossFrom(ctx, x, y, z, nx, nz, maxDist) {
  const phys = ctx.physics;
  if (!phys?.raycast) return null;
  _o.set(x, y, z);
  _d.set(nx, 0, nz);
  const hit = phys.raycast(_o, _d, maxDist);
  if (!hit) return null;
  return { x: hit.point.x, y: hit.point.y, z: hit.point.z, d: hit.distance };
}

// ------------------------------------------------------------------- cables

/**
 * Power and telephone runs strung across the street, plus laundry lines lower
 * down. Anchors come from opposing facade pairs found by raycasting straight
 * out from one wall until it hits another.
 */
export function overheadLines(ctx, site, bs, rand, density = 1) {
  const g = geo();
  let parts = 0;
  const done = [];

  for (const f of site.facades) {
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    if (len < 5) continue;
    const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;
    const h = f.top - f.base;
    if (h < 4) continue;

    const spans = Math.max(1, Math.round(len / 11 * density));
    for (let i = 0; i < spans; i++) {
      const t = (i + 0.5) / spans;
      const ax = f.ax + ux * len * t, az = f.az + uz * len * t;
      // Two runs per span: a high power pair and a lower service line.
      for (let pass = 0; pass < 2; pass++) {
        const y = f.base + h * (pass ? 0.42 : 0.66) + (rand() - 0.5) * 0.6;
        if (y > f.top - 0.6) continue;
        const far = acrossFrom(ctx, ax + f.nx * 0.4, y, az + f.nz * 0.4, f.nx, f.nz, 34);
        if (!far || far.d < 5) continue;
        // Only the near half of a facade pair should draw the span.
        const key = `${Math.round((ax + far.x) * 2)}|${Math.round((az + far.z) * 2)}|${Math.round(y * 2)}`;
        if (done.includes(key)) continue;
        done.push(key);

        const lines = pass ? 1 : 2 + ((rand() * 2) | 0);
        for (let k = 0; k < lines; k++) {
          const off = (k - (lines - 1) / 2) * 0.28;
          _a.set(ax + f.nx * 0.25 + ux * off, y + (rand() - 0.5) * 0.12, az + f.nz * 0.25 + uz * off);
          _b.set(far.x - f.nx * 0.25 + ux * off, y + (rand() - 0.5) * 0.3, far.z - f.nz * 0.25 + uz * off);
          const sag = 0.6 + far.d * (0.035 + rand() * 0.03);
          const cable = cableGeo(_a, _b, sag, 0.024 + rand() * 0.012, 12, 4);
          _c.setRGB(0.5, 0.5, 0.52);
          bs.addMatrix('rubber', cable, IDENTITY, _c, false);
          parts++;
        }

        // Washing pegged to the lower line.
        //
        // Three things changed here and all three are visible in street.png.
        // (1) `fabric_light` instead of `fabric_canvas`: cotton, and it carries
        // a translucency of 0.78 against canvas's 0.55, so a backlit sheet has
        // a chance of glowing instead of going to pure silhouette. (2)
        // `shellGeo` instead of `twoSided`: a 4 mm shell with a stitched rim,
        // so the edge of the sheet catches a lit line instead of terminating
        // in a mathematically sharp cut-out — that razor edge against bright
        // sky is what made these read as black trapezoids. (3) a real garment
        // palette through `tintFor` rather than a warm/cool jitter.
        if (pass === 1 && rand() < 0.88) {
          const nCloth = 4 + ((rand() * 5) | 0);
          let saturatedLeft = 3;
          for (let k = 0; k < nCloth; k++) {
            const s = 0.14 + (k + rand() * 0.5) / (nCloth + 0.3) * 0.72;
            const cx = ax + (far.x - ax) * s + f.nx * 0.25 * (1 - 2 * s);
            const cz = az + (far.z - az) * s + f.nz * 0.25 * (1 - 2 * s);
            const drop = Math.sin(Math.PI * s) * (0.6 + far.d * 0.05);
            // Real sizes: a double sheet is 2 m across and a towel 0.7 m, and
            // the first pass authored everything at towel scale, which is why
            // a line of washing read as a row of postage stamps at 20 m.
            const big = rand() < 0.4;
            const cw = big ? 1.1 + rand() * 0.9 : 0.45 + rand() * 0.55;
            const ch = big ? 0.9 + rand() * 0.8 : 0.55 + rand() * 0.6;
            // Sag scales with the span it is pegged across, per the reference
            // measurement: a sheet on a line bellies about a tenth of its width.
            const cloth = shellGeo(clothGeo(cw, ch, 0.10 * cw, rand, 0.10), SHELL_T.laundry);
            if (laundryTint(_c, rand, saturatedLeft)) saturatedLeft--;
            // Shadows off, and this is a budget decision rather than an art
            // one. `fabric_light` is a new material key, so it opens a bucket
            // per zone; casting would make that three draws per zone instead
            // of one, measured, and this item is funded for four in total.
            // The awnings and canopies still cast, which is where cloth
            // shadow actually lands on something a camera is looking at.
            bs.add('fabric_light', cloth, cx, y - drop - ch * 0.5, cz,
              0, Math.atan2(ux, uz) + (rand() - 0.5) * 0.5, 0, 1, 1, 1, _c, false);
            parts++;
          }
        }
        void g;
      }
    }
  }
  return { parts };
}

// ------------------------------------------------------------------ awnings

/**
 * Shopfront awnings over the pavement. Alternating corrugated-steel lean-tos on
 * angle brackets and torn canvas on bent tube frames, which is the single most
 * recognisable silhouette in the reference frames.
 */
/**
 * One awning, in real shopfront dimensions.
 *
 * Front rail at base + 3.05, wall fixing at base + 3.40, 1.65 m of projection:
 * that is a 12 degree fall, which is what a real retractable awning is set to
 * so rain runs off and a person can stand under the front edge. The number
 * that actually earns its place is the VALANCE — the 0.30 m scalloped skirt
 * hanging off the front rail. At 20 m an awning without one is a grey wedge;
 * with one it is unmistakably a shop.
 */
function oneAwning(bs, rand, g, cx, cz, nx, nz, base, w) {
  const yaw = Math.atan2(nx, nz);
  const ux = nz, uz = -nx;                    // along the facade
  const proj = 1.65;
  const yFront = base + 3.05, yBack = base + 3.40;
  const pitch = Math.atan2(yBack - yFront, proj);
  const yMid = (yFront + yBack) * 0.5;
  let parts = 0;

  // Frame: two rakers and a front rail.
  jitterColor(_c, rand, 0.3, 0.08, 0.05);
  for (const s of [-1, 1]) {
    const ox = cx + ux * s * w * 0.46, oz = cz + uz * s * w * 0.46;
    bs.addPitched('metal_rusted', g.barOut, ox + nx * proj * 0.5, yMid,
      oz + nz * proj * 0.5, yaw, pitch, 0, 1, 1, proj * 1.1, _c, true);
    parts++;
  }
  bs.add('metal_rusted', g.barAlong, cx + nx * proj, yFront, cz + nz * proj,
    0, yaw, 0, w * 1.06, 1, 1, _c, true);
  parts++;

  if (rand() < 0.15) {
    // One in seven is a corrugated lean-to rather than cloth.
    jitterColor(_c, rand, 0.2, 0.05, 0.05);
    _c.multiplyScalar(0.82);
    bs.addPitched('metal_corrugated', g.sheet, cx + nx * proj * 0.5, yMid,
      cz + nz * proj * 0.5, yaw, pitch, 0, w, 1, proj * 1.04, _c, true);
    return parts + 1;
  }

  // The pitch has to be applied about the awning's own long axis, which is why
  // these go through addPitched rather than add: the default XYZ Euler rotates
  // about world X and stands the sheet on its edge on any wall that does not
  // face along Z.
  const striped = awningTint(_c, rand);
  const tint = _c.clone();
  const cloth = shellGeo(layFlat(clothGeo(w, proj * 1.02, 0.18, rand, 0.10)), SHELL_T.canvas);
  bs.addPitched('fabric_canvas', cloth, cx + nx * proj * 0.5, yMid + 0.02,
    cz + nz * proj * 0.5, yaw, pitch, 0, 1, 1, 1, tint, true);
  parts++;

  // Valance. Torn hem, hung 2 cm proud of the rail so it does not z-fight it.
  const vh = 0.30;
  const val = shellGeo(clothGeo(w, vh, 0.02, rand, 0.16), SHELL_T.canvas);
  bs.add('fabric_canvas', val, cx + nx * (proj + 0.02), yFront - vh * 0.5,
    cz + nz * (proj + 0.02), 0, yaw, 0, 1, 1, 1, tint, true);
  parts++;

  // A striped awning gets a second, narrower valance in the off colour laid
  // over the first — two draws' worth of geometry in the same bucket, zero
  // extra draws, and it is the cheapest way to say "stripes" without a texture.
  if (striped) {
    _c.copy(tint).multiplyScalar(0.55);
    const band = shellGeo(clothGeo(w * 0.5, vh * 0.9, 0.02, rand, 0.16), SHELL_T.canvas);
    bs.add('fabric_canvas', band, cx + nx * (proj + 0.035), yFront - vh * 0.5,
      cz + nz * (proj + 0.035), 0, yaw, 0, 1, 1, 1, _c, false);
    parts++;
  }
  return parts;
}

/**
 * Shopfront awnings over the pavement, bound to the facade's own window bays.
 *
 * This used to place at a random `t` every 9 m, which is why goldenhour's
 * canopy floats over blank wall with no opening under it. `facadeDetail`
 * publishes the bay centres it actually cut, props-core forwards them as
 * `env.bays`, and an awning belongs over a shopfront or nowhere. The old
 * random walk is kept as the degradation path for a wave where the bay list
 * has not landed.
 */
export function awnings(ctx, site, bs, rand, density = 1, env = null) {
  const g = geo();
  let parts = 0;

  // --- Preferred path: real bays.
  const bays = Array.isArray(env?.bays) ? env.bays : [];
  let placed = 0;
  for (const b of bays) {
    if (!b || typeof b.x !== 'number' || typeof b.z !== 'number') continue;
    const f = b.f || b.facade || null;
    const nx = b.nx ?? f?.nx, nz = b.nz ?? f?.nz;
    if (typeof nx !== 'number' || typeof nz !== 'number') continue;
    // Ground-floor bays only: an awning over a third-storey window is a canopy
    // over nothing. Anything that does not declare a storey is assumed usable.
    if (b.shop === false || (b.storey !== undefined && b.storey > 0)) continue;
    if (rand() > 0.35 * density) continue;
    const base = b.base ?? f?.base ?? site.groundAt(b.x, b.z);
    if (base === null || base === undefined) continue;
    if (site.groundAt(b.x + nx * 1.4, b.z + nz * 1.4) === null) continue;
    parts += oneAwning(bs, rand, g, b.x, b.z, nx, nz, base, (b.w || b.width || 2.4) * 0.9);
    placed++;
  }
  if (placed) return { parts };

  // --- Degradation: no bay list this wave, so fall back to spacing along the
  // facade. Same awning, worse placement.
  for (const f of site.facades) {
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    if (len < 5) continue;
    const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;
    const n = Math.round(len / 9 * density);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.35 + rand() * 0.3) / Math.max(1, n);
      const cx = f.ax + ux * len * t, cz = f.az + uz * len * t;
      // Only where there is pavement to stand under.
      if (site.groundAt(cx + f.nx * 1.4, cz + f.nz * 1.4) === null) continue;
      parts += oneAwning(bs, rand, g, cx, cz, f.nx, f.nz, f.base, 2.2 + rand() * 2.0);
    }
  }
  return { parts };
}

// ----------------------------------------------------------------- rooftops

/**
 * Roof plant. The establishing camera looks straight down at these, so this is
 * where that shot is won or lost: parapet, then AC plant on plinths, water
 * tanks, vent stacks, dishes, stacked crates, a corrugated shack and debris.
 */
export function rooftops(ctx, site, bs, rand, density = 1) {
  const g = geo();
  let parts = 0;

  for (const r of site.roofs) {
    const hw = r.w / 2, hd = r.d / 2;
    const y = r.y;

    // --- Parapet ring. Four upstands with a coping, inset off the edge.
    jitterColor(_c, rand, 0.14, 0.03, 0.04);
    const inset = 0.13;
    for (let side = 0; side < 4; side++) {
      const alongX = side < 2;
      const s = side % 2 ? 1 : -1;
      const L = (alongX ? r.w : r.d) - inset * 2;
      const px = alongX ? r.x : r.x + s * (hw - inset);
      const pz = alongX ? r.z + s * (hd - inset) : r.z;
      const yaw = alongX ? 0 : Math.PI / 2;
      bs.add('concrete_wall', g.parapet, px, y + 0.275, pz, 0, yaw, 0, L, 1, 1, _c, true);
      bs.add('concrete_floor', g.coping, px, y + 0.575, pz, 0, yaw, 0, L, 1, 1, _c, true);
      parts += 2;
    }

    // Everything else lands inside a margin so it never floats off the edge.
    const mx = Math.max(0.5, hw - 1.6), mz = Math.max(0.5, hd - 1.6);
    const at = () => [r.x + (rand() * 2 - 1) * mx, r.z + (rand() * 2 - 1) * mz];

    // --- Condenser units on concrete plinths.
    const units = Math.max(1, Math.round((r.w * r.d) / 55 * density));
    for (let i = 0; i < units; i++) {
      const [x, z] = at();
      const yaw = (rand() * 4 | 0) * Math.PI / 2 + (rand() - 0.5) * 0.2;
      const sc = 0.8 + rand() * 0.55;
      _c.setRGB(1.0, 1.0, 1.02);
      bs.add('concrete_floor', g.plinth, x, y + 0.08, z, 0, yaw, 0, sc, 1, sc, _c, true);
      jitterColor(_c, rand, 0.16, 0.04, 0.02);
      _c.multiplyScalar(1.08);
      bs.add('metal_painted', g.acBig, x, y + 0.16 + 0.425 * sc, z, 0, yaw, 0, sc, sc, sc, _c, true);
      bs.add('metal_painted', g.acLouvre, x, y + 0.16 + 0.86 * sc, z, 0, yaw, 0, sc, 1, sc, _c, false);
      bs.add('metal_rusted', g.acFan, x, y + 0.16 + 0.9 * sc, z, 0, yaw, 0, sc, 1, sc, _c, false);
      parts += 4;
    }

    // --- Water tanks on a short stand.
    const tanks = rand() < 0.75 ? 1 + ((rand() * 2) | 0) : 0;
    for (let i = 0; i < tanks; i++) {
      const [x, z] = at();
      const sc = 0.8 + rand() * 0.4;
      jitterColor(_c, rand, 0.18, 0.06, 0.05);
      for (const [dx, dz] of [[-0.4, -0.35], [0.4, -0.35], [-0.4, 0.35], [0.4, 0.35]]) {
        bs.add('metal_rusted', g.post, x + dx * sc, y + 0.3, z + dz * sc, 0, 0, 0,
          1, 0.6, 1, _c, false);
      }
      _c.multiplyScalar(1.06);
      bs.add('metal_corrugated', g.tank, x, y + 0.6 + 0.675 * sc, z, 0, rand() * 3, 0, sc, sc, sc, _c, true);
      bs.add('metal_rusted', g.tankLid, x + 0.16 * sc, y + 0.6 + 1.4 * sc, z, 0, 0, 0, sc, sc, sc, _c, false);
      parts += 6;
    }

    // --- Vent stacks and cowls.
    const stacks = Math.round(2 + rand() * 4 * density);
    for (let i = 0; i < stacks; i++) {
      const [x, z] = at();
      const hgt = 0.7 + rand() * 1.5;
      jitterColor(_c, rand, 0.3, 0.09, 0.07);
      bs.add('metal_rusted', g.stack, x, y + hgt / 2, z, 0, 0, 0, 1, hgt, 1, _c, true);
      bs.add('metal_rusted', g.cowl, x, y + hgt + 0.06, z, 0, rand() * 3, 0, 1, 1, 1, _c, false);
      parts += 2;
    }

    // --- Dishes and aerials pointed roughly the same way, as they would be.
    const bearing = rand() * 6.2832;
    const dishes = Math.round(1 + rand() * 3 * density);
    for (let i = 0; i < dishes; i++) {
      const [x, z] = at();
      const hgt = 0.5 + rand() * 0.9;
      _c.setRGB(1.14, 1.12, 1.06);
      bs.add('metal_rusted', g.post, x, y + hgt / 2, z, 0, 0, 0, 0.7, hgt, 0.7, _c, false);
      bs.add('metal_painted', g.dish, x, y + hgt + 0.1, z, 0, bearing + (rand() - 0.5) * 0.4, 0,
        0.85, 0.85, 0.85, _c, true);
      parts += 2;
    }

    // --- A stair head / plant shack in corrugated steel.
    if (r.w > 8 && r.d > 8 && rand() < 0.8) {
      const [x, z] = at();
      const w = 1.8 + rand() * 1.4, d = 1.5 + rand() * 1.2, hh = 2.0 + rand() * 0.5;
      const yaw = (rand() - 0.5) * 0.6;
      jitterColor(_c, rand, 0.24, 0.07, 0.05);
      for (let s = 0; s < 4; s++) {
        const alongX = s < 2;
        const sg = s % 2 ? 1 : -1;
        const px = x + (alongX ? 0 : sg * w / 2) * Math.cos(yaw) - (alongX ? sg * d / 2 : 0) * Math.sin(yaw);
        const pz = z + (alongX ? sg * d / 2 : 0) * Math.cos(yaw) + (alongX ? 0 : sg * w / 2) * Math.sin(yaw);
        bs.add('metal_corrugated', g.shackWall, px, y + hh / 2, pz,
          0, yaw + (alongX ? 0 : Math.PI / 2), 0, alongX ? w : d, hh, 1, _c, true);
      }
      _c.multiplyScalar(0.95);
      bs.add('concrete_floor', g.plinth, x, y + hh + 0.06, z, 0, yaw, 0, w / 1.7 * 1.1, 1, d / 1.4 * 1.1, _c, true);
      parts += 5;
    }

    // --- Crates, sandbags and rubbish so it is not a showroom.
    const junk = Math.round((r.w * r.d) / 32 * density);
    for (let i = 0; i < junk; i++) {
      const [x, z] = at();
      const roll = rand();
      if (roll < 0.35) {
        jitterColor(_c, rand, 0.3, 0.08, 0.06);
        const stack = 1 + ((rand() * 3) | 0);
        for (let k = 0; k < stack; k++) {
          bs.add('wood_plank', g.crate, x + (rand() - 0.5) * 0.12, y + 0.25 + k * 0.5,
            z + (rand() - 0.5) * 0.12, 0, rand() * 3, 0, 1, 1, 1, _c, true);
        }
        parts += stack;
      } else if (roll < 0.6) {
        jitterColor(_c, rand, 0.22, 0.05, 0.1);
        bs.add('sandbag', g.lump, x, y + 0.11, z, 0, rand() * 3, 0,
          0.7 + rand() * 0.4, 0.45, 0.5, _c, true);
        parts++;
      } else {
        jitterColor(_c, rand, 0.3, 0.05, 0.05);
        bs.add('rubble', g.lump, x, y + 0.07, z, (rand() - 0.5), rand() * 3, (rand() - 0.5),
          0.3 + rand() * 0.5, 0.3, 0.4, _c, false);
        parts++;
      }
    }

    // --- Conduit snaking between the plant.
    const runs = Math.round(1 + rand() * 2 * density);
    for (let i = 0; i < runs; i++) {
      const [x, z] = at();
      const L = 2 + rand() * Math.min(r.w, r.d) * 0.5;
      const yaw = (rand() * 2 | 0) * Math.PI / 2;
      jitterColor(_c, rand, 0.2, 0.05, 0.03);
      bs.add('metal_painted', g.barAlong, x, y + 0.13, z, 0, yaw, 0, L, 1, 1, _c, false);
      parts++;
    }
  }
  return { parts };
}

/**
 * A fire escape bolted to the tallest facade that has room for one: three
 * landings, stringers and a handrail. Pure silhouette against the sky, and the
 * one piece of geometry that reads unmistakably as "city block".
 */
export function fireEscape(ctx, site, bs, rand) {
  const g = geo();
  const candidates = site.facades.filter((f) => f.top - f.base > 8 && Math.hypot(f.bx - f.ax, f.bz - f.az) > 8);
  if (!candidates.length) return { parts: 0 };
  let parts = 0;
  const count = Math.min(2, candidates.length);
  for (let c = 0; c < count; c++) {
    const f = candidates[(c * 7 + 1) % candidates.length];
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;
    const yaw = Math.atan2(f.nx, f.nz);
    const t = 0.25 + rand() * 0.5;
    const cx = f.ax + ux * len * t, cz = f.az + uz * len * t;
    const levels = Math.min(4, Math.floor((f.top - f.base - 2) / 3.3));
    const depth = 1.25;
    jitterColor(_c, rand, 0.22, 0.06, 0.05);

    for (let l = 1; l <= levels; l++) {
      const y = f.base + l * 3.3;
      const px = cx + f.nx * depth * 0.5, pz = cz + f.nz * depth * 0.5;
      bs.add('metal_rusted', g.grate, px, y, pz, 0, yaw, 0, 2.6, 1, depth, _c, true);
      // Handrail: top rail plus four stanchions on the outer edge.
      const ox = cx + f.nx * depth, oz = cz + f.nz * depth;
      bs.add('metal_rusted', g.rail, ox, y + 0.95, oz, 0, yaw, 0, 2.6, 1, 1, _c, false);
      for (let k = 0; k < 4; k++) {
        const s = (k / 3 - 0.5) * 2.4;
        bs.add('metal_rusted', g.railPost, ox + ux * s, y + 0.48, oz + uz * s, 0, 0, 0, 1, 0.95, 1, _c, false);
      }
      // Stair flight down to the level below, as a run of treads.
      if (l > 1) {
        for (let k = 0; k < 9; k++) {
          const s = (k / 8 - 0.5) * 2.2;
          bs.add('metal_rusted', g.step, cx + ux * s + f.nx * (depth * 0.75),
            y - 3.3 + (k / 8) * 3.0, cz + uz * s + f.nz * (depth * 0.75),
            0, yaw, 0, 0.85, 1, 1, _c, false);
        }
        parts += 9;
      }
      parts += 6;
    }
  }
  return { parts };
}
