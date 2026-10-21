import * as THREE from 'three';
import { wallFalloff } from './layout.js';
import { projectUV } from './lib.js';

/**
 * Decals — `ART_DIRECTION.md` rule 7, "hundreds of them".
 *
 * Three decisions worth knowing about.
 *
 * **The atlas is painted, not sampled.** Sixteen 256 px cells drawn with
 * Canvas2D at init: impact spall, crack webs, scorch, oil, dust, standing
 * water, rain streaking, wall-base grime, mould, tyre tread, a torn poster and
 * two spray tags. Canvas2D gives real gradients, blurs and destination-out
 * punch-through for free, and it is the only way to get organic edges without
 * a million-pixel JS loop. Every cell keeps a 16 px transparent gutter so the
 * mip chain does not bleed one decal into its neighbour.
 *
 * **They are geometry, not a projection pass.** A real deferred decal volume
 * needs a depth prepass this pipeline does not expose, and a screen-space pass
 * would fight TAA. Instead each decal is a quad merged into the same `BatchSet`
 * as everything else: camera-independent, correctly lit by the same shader as
 * the surface underneath it, one draw call per material-zone bucket, and
 * `polygonOffset` plus a 12 mm normal push to stay off the surface.
 *
 * **The material is borrowed, not built.** `ARCHITECTURE.md` forbids
 * constructing materials outside the library, so decals ride on
 * `ctx.materials.get('gun_polymer', ...)` with the atlas swapped into the albedo
 * slot. That key is chosen deliberately: it is the only non-metal, non-
 * transmissive key with `pom: 0`, and a parallax march would walk the sample
 * point across an atlas cell boundary and smear one decal into the next.
 */

/**
 * 5x5 cells at 1536, not 4x4 at 1024 and not the 5x5 at 2048 this started as.
 *
 * The old atlas was full — all sixteen cells used — and the ground work needs
 * nine more marks that cannot be faked with the existing ones. Five columns
 * buys those nine and still renders the original sixteen larger than before,
 * which incidentally sharpens `grimeBand` and `tyre`; both were visibly soft at
 * the 2-3 m world sizes they are placed at. Zero extra draw calls and zero
 * extra programs: same texture, same material key, same two buckets.
 *
 * The size is 1536 rather than 2048 because this texture is sampled by the most
 * expensive pass in the frame. The soft decal set is blended with no depth
 * write, so every pixel it covers re-runs the full standard shader including a
 * three-cascade PCSS lookup — shedding that one tier alone takes the street
 * shot from the high teens to a locked 60. Quadrupling the working set that
 * pass streams through is not a free change however comfortable the memory
 * budget looks, and 1536 still gives every cell 289 px of content against the
 * 240 the original sixteen had.
 */
const ATLAS_SIZE = 1536;
const CELLS = 5;
const CELL = Math.floor(ATLAS_SIZE / CELLS);   // 307
const PAD = 18;

const _c = new THREE.Color();

export const DECAL_KEYS = [
  'impact', 'impactCluster', 'impactSpray', 'crackWeb', 'scorch',
  'oil', 'dust', 'wet', 'streak', 'grimeBand',
  'drip', 'mould', 'tyre', 'poster', 'tagA',
  'tagB', 'contact', 'damp', 'drain', 'wheelPath',
  'tarSeam', 'patch', 'paintLine', 'gritDrift', 'leafDrift',
];

// ------------------------------------------------------------------- atlas

function rgba(r, g, b, a) { return `rgba(${r | 0},${g | 0},${b | 0},${a})`; }

/** Soft radial blob. */
function blob(g, x, y, r, r0, g0, b0, a) {
  const grd = g.createRadialGradient(x, y, 0, x, y, r);
  grd.addColorStop(0, rgba(r0, g0, b0, a));
  grd.addColorStop(0.55, rgba(r0, g0, b0, a * 0.62));
  grd.addColorStop(1, rgba(r0, g0, b0, 0));
  g.fillStyle = grd;
  g.beginPath();
  g.arc(x, y, r, 0, 6.2832);
  g.fill();
}

/** Random-walk polyline, the basis of cracks, streaks and spray strokes. */
function scrawl(g, x, y, len, dir, wobble, steps, rnd) {
  g.beginPath();
  g.moveTo(x, y);
  let a = dir;
  for (let i = 0; i < steps; i++) {
    a += (rnd() - 0.5) * wobble;
    x += Math.cos(a) * (len / steps);
    y += Math.sin(a) * (len / steps);
    g.lineTo(x, y);
  }
  g.stroke();
  return [x, y];
}

/** Punches irregular holes so nothing has a machine-perfect edge. */
function erode(g, cx, cy, r, n, strength, rnd) {
  g.save();
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.2832;
    const d = r * (0.45 + rnd() * 0.75);
    const rr = r * (0.08 + rnd() * 0.3);
    blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, 0, 0, 0, strength);
  }
  g.restore();
}

/** One bullet strike: dark cone, bright spall ring, radial hairlines. */
function drawImpact(g, cx, cy, r, rnd) {
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  grd.addColorStop(0, rgba(24, 22, 20, 0.96));
  grd.addColorStop(0.24, rgba(40, 37, 34, 0.9));
  grd.addColorStop(0.36, rgba(196, 188, 172, 0.82));
  grd.addColorStop(0.62, rgba(168, 160, 146, 0.44));
  grd.addColorStop(1, rgba(150, 143, 130, 0));
  g.fillStyle = grd;
  g.beginPath();
  g.arc(cx, cy, r, 0, 6.2832);
  g.fill();

  g.strokeStyle = rgba(58, 54, 49, 0.6);
  g.lineWidth = Math.max(1, r * 0.045);
  const spokes = 4 + ((rnd() * 5) | 0);
  for (let i = 0; i < spokes; i++) {
    scrawl(g, cx, cy, r * (0.7 + rnd() * 1.1), rnd() * 6.2832, 0.55, 4, rnd);
  }
  // A dusty halo, off-centre, so the strike has a direction.
  const ha = rnd() * 6.2832;
  blob(g, cx + Math.cos(ha) * r * 0.4, cy + Math.sin(ha) * r * 0.4, r * 1.5, 178, 170, 154, 0.2);
}

function drawCell(g, name, rnd) {
  const s = CELL - PAD * 2;
  const cx = CELL / 2, cy = CELL / 2;

  switch (name) {
    case 'impact':
      drawImpact(g, cx, cy, s * 0.36, rnd);
      break;

    case 'impactCluster': {
      for (let i = 0; i < 7; i++) {
        const a = rnd() * 6.2832, d = rnd() * s * 0.3;
        drawImpact(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s * (0.09 + rnd() * 0.09), rnd);
      }
      break;
    }

    case 'impactSpray': {
      // A burst walked across the surface: dense at one end, trailing off.
      const a0 = rnd() * 6.2832;
      for (let i = 0; i < 18; i++) {
        const t = i / 17;
        const d = t * s * 0.44 + (rnd() - 0.5) * s * 0.1;
        const a = a0 + (rnd() - 0.5) * 0.5;
        if (rnd() > 0.25 + t * 0.6) continue;
        drawImpact(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s * (0.05 + rnd() * 0.07), rnd);
      }
      break;
    }

    case 'crackWeb': {
      g.strokeStyle = rgba(38, 35, 32, 0.78);
      g.lineCap = 'round';
      const n = 5 + ((rnd() * 4) | 0);
      for (let i = 0; i < n; i++) {
        g.lineWidth = 1 + rnd() * 2.6;
        const a = rnd() * 6.2832;
        const [ex, ey] = scrawl(g, cx + (rnd() - 0.5) * s * 0.2, cy + (rnd() - 0.5) * s * 0.2,
          s * (0.3 + rnd() * 0.45), a, 0.7, 7, rnd);
        // Branch.
        if (rnd() < 0.6) {
          g.lineWidth = 1 + rnd();
          scrawl(g, ex, ey, s * (0.1 + rnd() * 0.2), a + (rnd() - 0.5) * 1.6, 0.8, 4, rnd);
        }
      }
      break;
    }

    case 'scorch': {
      blob(g, cx, cy, s * 0.48, 16, 14, 13, 0.9);
      blob(g, cx, cy, s * 0.3, 8, 7, 7, 0.95);
      // Soot fingers licking outward.
      g.strokeStyle = rgba(20, 18, 16, 0.5);
      g.lineCap = 'round';
      for (let i = 0; i < 14; i++) {
        g.lineWidth = 2 + rnd() * 9;
        scrawl(g, cx, cy, s * (0.3 + rnd() * 0.25), rnd() * 6.2832, 0.35, 4, rnd);
      }
      erode(g, cx, cy, s * 0.5, 16, 0.55, rnd);
      break;
    }

    case 'oil': {
      g.fillStyle = rgba(14, 13, 12, 0.94);
      g.beginPath();
      const pts = 11;
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * 6.2832;
        const r = s * (0.2 + 0.2 * (0.4 + rnd() * 0.6));
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.78;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      // Drips and a thinner spread ring.
      for (let i = 0; i < 9; i++) {
        const a = rnd() * 6.2832, d = s * (0.22 + rnd() * 0.2);
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, s * (0.04 + rnd() * 0.07), 22, 20, 18, 0.7);
      }
      blob(g, cx, cy, s * 0.48, 34, 31, 28, 0.24);
      erode(g, cx, cy, s * 0.4, 10, 0.4, rnd);
      break;
    }

    case 'dust': {
      blob(g, cx, cy, s * 0.5, 156, 145, 124, 0.62);
      for (let i = 0; i < 12; i++) {
        const a = rnd() * 6.2832, d = s * rnd() * 0.34;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s * (0.1 + rnd() * 0.22), 168, 156, 132, 0.32);
      }
      erode(g, cx, cy, s * 0.5, 22, 0.42, rnd);
      break;
    }

    case 'wet': {
      blob(g, cx, cy, s * 0.48, 30, 30, 31, 0.7);
      for (let i = 0; i < 8; i++) {
        const a = rnd() * 6.2832, d = s * rnd() * 0.3;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s * (0.12 + rnd() * 0.2), 24, 25, 27, 0.5);
      }
      erode(g, cx, cy, s * 0.48, 18, 0.55, rnd);
      break;
    }

    case 'streak': {
      // Rain washing down off a sill: pale where it has cleaned, dark where the
      // dirt has been carried and re-deposited. Runs top (v=0) to bottom.
      for (let i = 0; i < 26; i++) {
        const x = PAD + rnd() * s;
        const w = 1.5 + rnd() * 9;
        const top = PAD + rnd() * s * 0.12;
        const len = s * (0.35 + rnd() * 0.62);
        const dark = rnd() < 0.72;
        const grd = g.createLinearGradient(0, top, 0, top + len);
        const col = dark ? [44, 40, 35] : [148, 141, 126];
        grd.addColorStop(0, rgba(col[0], col[1], col[2], 0.55 + rnd() * 0.3));
        grd.addColorStop(0.65, rgba(col[0], col[1], col[2], 0.25));
        grd.addColorStop(1, rgba(col[0], col[1], col[2], 0));
        g.fillStyle = grd;
        g.fillRect(x, top, w, len);
      }
      // A denser bead right under the lip.
      const grd = g.createLinearGradient(0, PAD, 0, PAD + s * 0.16);
      grd.addColorStop(0, rgba(38, 34, 30, 0.62));
      grd.addColorStop(1, rgba(38, 34, 30, 0));
      g.fillStyle = grd;
      g.fillRect(PAD, PAD, s, s * 0.16);
      erode(g, cx, cy, s * 0.6, 16, 0.35, rnd);
      break;
    }

    case 'grimeBand': {
      // Dirt gravity — rule 4. Dark at the bottom edge, gone by mid height.
      const grd = g.createLinearGradient(0, CELL - PAD, 0, PAD + s * 0.1);
      grd.addColorStop(0, rgba(30, 27, 24, 0.86));
      grd.addColorStop(0.35, rgba(42, 38, 33, 0.5));
      grd.addColorStop(1, rgba(52, 47, 41, 0));
      g.fillStyle = grd;
      g.fillRect(PAD, PAD, s, s);
      // Ragged upper limit.
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 26; i++) {
        const x = PAD + rnd() * s;
        blob(g, x, PAD + s * (0.28 + rnd() * 0.45), s * (0.08 + rnd() * 0.16), 0, 0, 0, 0.8);
      }
      g.restore();
      break;
    }

    case 'drip': {
      const grd = g.createLinearGradient(0, PAD, 0, CELL - PAD);
      grd.addColorStop(0, rgba(36, 32, 28, 0.8));
      grd.addColorStop(0.5, rgba(44, 39, 34, 0.45));
      grd.addColorStop(1, rgba(48, 43, 37, 0));
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(cx - s * 0.14, PAD);
      g.lineTo(cx + s * 0.14, PAD);
      g.lineTo(cx + s * 0.05, CELL - PAD);
      g.lineTo(cx - s * 0.06, CELL - PAD);
      g.closePath();
      g.fill();
      g.strokeStyle = rgba(30, 27, 23, 0.55);
      g.lineWidth = 2.5;
      for (let i = 0; i < 5; i++) {
        scrawl(g, cx + (rnd() - 0.5) * s * 0.2, PAD + s * 0.05, s * (0.4 + rnd() * 0.5), 1.5708, 0.16, 6, rnd);
      }
      break;
    }

    case 'mould': {
      for (let i = 0; i < 20; i++) {
        const a = rnd() * 6.2832, d = s * rnd() * 0.36;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 1.25,
          s * (0.06 + rnd() * 0.17), 42 + rnd() * 16, 44 + rnd() * 14, 34, 0.55);
      }
      erode(g, cx, cy, s * 0.45, 14, 0.45, rnd);
      break;
    }

    case 'tyre': {
      // Runs along the cell's U axis so a track can be stretched arbitrarily.
      const grd = g.createLinearGradient(0, PAD, 0, CELL - PAD);
      grd.addColorStop(0, rgba(28, 26, 24, 0));
      grd.addColorStop(0.2, rgba(26, 24, 22, 0.62));
      grd.addColorStop(0.8, rgba(26, 24, 22, 0.62));
      grd.addColorStop(1, rgba(28, 26, 24, 0));
      g.fillStyle = grd;
      g.fillRect(PAD, PAD + s * 0.22, s, s * 0.56);
      // Tread blocks.
      g.fillStyle = rgba(16, 15, 14, 0.5);
      const rows = 12;
      for (let i = 0; i < rows; i++) {
        const x = PAD + (i / rows) * s;
        const skew = (i % 2 ? 1 : -1) * s * 0.03;
        g.fillRect(x, PAD + s * 0.26 + skew, s / rows * 0.55, s * 0.2);
        g.fillRect(x + s / rows * 0.3, PAD + s * 0.52 - skew, s / rows * 0.55, s * 0.2);
      }
      erode(g, cx, cy, s * 0.5, 20, 0.5, rnd);
      break;
    }

    case 'poster': {
      const w = s * 0.62, h = s * 0.82;
      const x0 = cx - w / 2, y0 = cy - h / 2;
      g.fillStyle = rgba(196, 186, 166, 0.97);
      g.fillRect(x0, y0, w, h);
      // Printed blocks: a heading bar, a block of body text, a colour field.
      const hue = [[176, 52, 40], [40, 66, 112], [190, 150, 40]][(rnd() * 3) | 0];
      g.fillStyle = rgba(hue[0], hue[1], hue[2], 0.9);
      g.fillRect(x0 + w * 0.08, y0 + h * 0.07, w * 0.84, h * 0.16);
      g.fillStyle = rgba(48, 44, 40, 0.85);
      for (let i = 0; i < 7; i++) {
        g.fillRect(x0 + w * 0.1, y0 + h * (0.32 + i * 0.055), w * (0.35 + rnd() * 0.45), h * 0.028);
      }
      g.fillStyle = rgba(hue[0] * 0.7, hue[1] * 0.7, hue[2] * 0.7, 0.7);
      g.fillRect(x0 + w * 0.1, y0 + h * 0.76, w * 0.5, h * 0.14);
      // Torn away at the corners and along one edge.
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 16; i++) {
        const edge = (rnd() * 4) | 0;
        const t = rnd();
        const px = edge === 0 ? x0 : edge === 1 ? x0 + w : x0 + t * w;
        const py = edge === 2 ? y0 : edge === 3 ? y0 + h : y0 + t * h;
        blob(g, px, py, s * (0.04 + rnd() * 0.14), 0, 0, 0, 0.95);
      }
      g.restore();
      break;
    }

    case 'tagA':
    case 'tagB': {
      const pal = name === 'tagA'
        ? [[214, 62, 44], [22, 20, 20]]
        : [[52, 96, 178], [232, 226, 210]];
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        const col = pal[pass];
        g.strokeStyle = rgba(col[0], col[1], col[2], pass ? 0.85 : 0.92);
        for (let i = 0; i < 5; i++) {
          g.lineWidth = (pass ? 5 : 11) + rnd() * 7;
          const y = PAD + s * (0.28 + rnd() * 0.44);
          const x = PAD + s * (0.06 + i * 0.17);
          g.beginPath();
          g.moveTo(x, y);
          // Angular tag strokes rather than smooth curves.
          let px = x, py = y;
          for (let k = 0; k < 3; k++) {
            px += s * (0.04 + rnd() * 0.09);
            py += (rnd() - 0.5) * s * 0.34;
            g.lineTo(px, py);
          }
          g.stroke();
        }
      }
      // Overspray.
      for (let i = 0; i < 40; i++) {
        blob(g, PAD + rnd() * s, PAD + s * (0.2 + rnd() * 0.6), 2 + rnd() * 5,
          pal[0][0], pal[0][1], pal[0][2], 0.3);
      }
      erode(g, cx, cy, s * 0.55, 10, 0.3, rnd);
      break;
    }
    // ------------------------------------------------------------ ground work

    case 'contact': {
      // The single most valuable cell in the atlas: the occlusion patch that
      // goes under every prop and every readable piece of debris.
      //
      // It is NOT a shadow. A shadow moves with the sun and vanishes in shade,
      // and an object whose only grounding cue is its shadow reads as pasted on
      // the moment it stands in shadow itself — which, in a street with one
      // side in hard sun, is half the props in frame. This is ambient
      // occlusion: the sky the ground cannot see because the object is in the
      // way. So it is pure black, it is strongest dead centre, and it must live
      // in the SOFT blended set. Alpha-testing it at 0.45 would clip the
      // gradient into a hard-edged disc, which is worse than nothing.
      // The exponent is 1.5, not the 2.4 the analysis proposed, and the reason
      // is that 2.4 was measured on the atlas and the atlas was wrong: at 2.4
      // the patch is already down to a quarter of peak alpha by 0.4R, so almost
      // all of its area is a whisper and a prop standing on it showed no
      // grounding at all. 1.5 keeps a readable core out to about 0.55R, which
      // is what actually reads at the 3-15 m the props sit at.
      const R = CELL * 0.44;
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        grd.addColorStop(t, rgba(0, 0, 0, 0.88 * Math.pow(1 - t, 1.5)));
      }
      g.fillStyle = grd;
      g.beginPath();
      g.arc(cx, cy, R, 0, 6.2832);
      g.fill();
      // A disc is a disc. Twelve bites make the perimeter irregular so a
      // hundred of these on one street do not read as a hundred circles.
      erode(g, cx, cy, R * 0.95, 12, 0.5, rnd);
      break;
    }

    case 'damp': {
      // Multiply toward #4a4a4e. Damp is not dark *paint*, it is a roughness
      // change with a small albedo drop, so the colour here is deliberately
      // near-neutral and the work is done by the bucket's roughness override.
      blob(g, cx, cy, s * 0.5, 74, 74, 78, 0.72);
      for (let i = 0; i < 14; i++) {
        const a = rnd() * 6.2832, d = s * rnd() * 0.36;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d,
          s * (0.12 + rnd() * 0.26), 66, 67, 72, 0.42);
      }
      erode(g, cx, cy, s * 0.52, 22, 0.5, rnd);
      break;
    }

    case 'drain': {
      // Cast-iron gully grate. Reads at 6 m and it is one of the few objects a
      // viewer can size the whole street against, so the frame is deliberately
      // heavy and the slots are deliberately near-black.
      const w = s * 0.72, h = s * 0.52;
      const x0 = cx - w / 2, y0 = cy - h / 2;
      g.fillStyle = rgba(58, 55, 50, 0.98);
      g.fillRect(x0, y0, w, h);
      // Worn arris: the top edge of a grate is polished by tyres.
      g.fillStyle = rgba(126, 122, 114, 0.75);
      g.fillRect(x0, y0, w, h * 0.055);
      g.fillStyle = rgba(96, 92, 85, 0.6);
      g.fillRect(x0, y0 + h - h * 0.05, w, h * 0.05);
      const slots = 6;
      for (let i = 0; i < slots; i++) {
        const sw = w * 0.86 / slots * 0.58;
        const sx = x0 + w * 0.07 + (i + 0.21) * (w * 0.86 / slots);
        g.fillStyle = rgba(9, 9, 9, 0.97);
        g.fillRect(sx, y0 + h * 0.15, sw, h * 0.7);
        g.fillStyle = rgba(104, 99, 90, 0.5);
        g.fillRect(sx, y0 + h * 0.15, sw, h * 0.035);
      }
      // Silt and staining creeping out of it.
      blob(g, cx, cy, s * 0.46, 44, 42, 38, 0.3);
      erode(g, cx, cy, s * 0.5, 8, 0.22, rnd);
      break;
    }

    case 'wheelPath': {
      // Where the tyres run, the road is polished rather than dirtied: the
      // aggregate is worn smooth and the fines are gone, so the band is
      // *lighter* and smoother than the tarmac either side of it. This is the
      // cue that says a road is driven on, and it is completely absent today.
      // The plateau has to clear the hard set's alphaTest of 0.45 or the band
      // is discarded before it is ever shaded — which is what happened at the
      // 0.34 that looked correct in the atlas and did not exist in the frame.
      // The colour sits close to the tarmac's own so that an opaque band still
      // reads as polished aggregate rather than as paint.
      const bandY = PAD + s * 0.26, bandH = s * 0.48;
      const grd = g.createLinearGradient(0, bandY, 0, bandY + bandH);
      grd.addColorStop(0, rgba(96, 93, 88, 0));
      grd.addColorStop(0.3, rgba(96, 93, 88, 0.78));
      grd.addColorStop(0.7, rgba(96, 93, 88, 0.78));
      grd.addColorStop(1, rgba(96, 93, 88, 0));
      g.fillStyle = grd;
      g.fillRect(PAD, bandY, s, bandH);
      // Longitudinal streaking inside the band.
      for (let i = 0; i < 22; i++) {
        const y = bandY + rnd() * bandH;
        const hgt = 1 + rnd() * 5;
        const x0 = PAD + rnd() * s * 0.5;
        g.fillStyle = rgba(122, 118, 110, 0.35 + rnd() * 0.3);
        g.fillRect(x0, y, s * (0.15 + rnd() * 0.5), hgt);
      }
      // Ragged on both edges, so the alphaTest cut is not a straight line.
      erode(g, cx, PAD + s * 0.28, s * 0.5, 12, 0.45, rnd);
      erode(g, cx, PAD + s * 0.72, s * 0.5, 12, 0.45, rnd);
      // Abraded ends, so a run of these does not read as one long sticker.
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (const end of [PAD, PAD + s]) {
        const eg = g.createLinearGradient(end, 0, end + (end === PAD ? s * 0.22 : -s * 0.22), 0);
        eg.addColorStop(0, rgba(0, 0, 0, 1));
        eg.addColorStop(1, rgba(0, 0, 0, 0));
        g.fillStyle = eg;
        g.fillRect(end === PAD ? PAD : PAD + s * 0.78, PAD, s * 0.22, s);
      }
      g.restore();
      erode(g, cx, cy, s * 0.5, 14, 0.3, rnd);
      break;
    }

    case 'tarSeam': {
      // A crack-sealing bead. Bitumen poured into a routed crack: near-black,
      // markedly smoother than the road, and it bulges irregularly where it was
      // over-filled. Longitudinal seams down a carriageway are one of the most
      // reliable "this is a real road" signals in any reference frame.
      const midY = PAD + s * 0.5;
      g.fillStyle = rgba(17, 16, 16, 0.93);
      g.beginPath();
      const steps = 26;
      for (let i = 0; i <= steps; i++) {
        const x = PAD + (i / steps) * s;
        const t = i / steps;
        const bulge = s * (0.055 + 0.045 * Math.abs(Math.sin(t * 9.3 + 1.7)) + rnd() * 0.02);
        if (i === 0) g.moveTo(x, midY - bulge); else g.lineTo(x, midY - bulge);
      }
      for (let i = steps; i >= 0; i--) {
        const x = PAD + (i / steps) * s;
        const t = i / steps;
        const bulge = s * (0.055 + 0.045 * Math.abs(Math.sin(t * 7.1 + 4.2)) + rnd() * 0.02);
        g.lineTo(x, midY + bulge);
      }
      g.closePath();
      g.fill();
      // A dry, pale halo where the bitumen soaked into the surrounding stone.
      g.strokeStyle = rgba(96, 92, 86, 0.22);
      g.lineWidth = s * 0.03;
      g.stroke();
      erode(g, cx, cy, s * 0.5, 10, 0.25, rnd);
      break;
    }

    case 'patch': {
      // A utility trench reinstatement: sawcut rectangle, 30 mm dark perimeter
      // seam, fill about 0.68 of the surrounding albedo. The straight machine
      // edges are the whole point — everything else on a road surface is
      // organic, so one hard rectangle reads as human intervention.
      const w = s * 0.9, h = s * 0.78;
      const x0 = cx - w / 2, y0 = cy - h / 2;
      g.fillStyle = rgba(46, 45, 44, 0.86);
      g.fillRect(x0, y0, w, h);
      g.strokeStyle = rgba(15, 14, 14, 0.9);
      g.lineWidth = Math.max(2, s * 0.022);
      g.strokeRect(x0, y0, w, h);
      // Coarser aggregate inside the patch than outside it.
      for (let i = 0; i < 90; i++) {
        const px = x0 + rnd() * w, py = y0 + rnd() * h;
        g.fillStyle = rgba(72 + rnd() * 40, 70 + rnd() * 38, 66 + rnd() * 34, 0.16 + rnd() * 0.2);
        g.fillRect(px, py, 1 + rnd() * 4, 1 + rnd() * 3);
      }
      // Only the edges are eroded: a sawcut is straight, a slumped edge is not.
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 14; i++) {
        const edge = (rnd() * 4) | 0;
        const t = rnd();
        const px = edge === 0 ? x0 : edge === 1 ? x0 + w : x0 + t * w;
        const py = edge === 2 ? y0 : edge === 3 ? y0 + h : y0 + t * h;
        blob(g, px, py, s * (0.02 + rnd() * 0.05), 0, 0, 0, 0.8);
      }
      g.restore();
      break;
    }

    case 'paintLine': {
      // Abraded thermoplastic. Fresh paint is a giveaway: real road markings in
      // a war-damaged street are about half gone, and the road reads straight
      // through the gaps.
      // Dirty, not white. A road marking in this district has years of tyre
      // rubber and dust on it: #9a958a, not #b8b2a4, and certainly not the
      // near-white it renders as once the surface shader lights it against a
      // 0.12-linear road.
      const bandY = PAD + s * 0.34, bandH = s * 0.32;
      g.fillStyle = rgba(154, 149, 138, 0.94);
      g.fillRect(PAD, bandY, s, bandH);
      // Rolled edges, slightly proud and slightly brighter.
      g.fillStyle = rgba(178, 172, 158, 0.55);
      g.fillRect(PAD, bandY, s, bandH * 0.14);
      g.fillRect(PAD, bandY + bandH * 0.86, s, bandH * 0.14);
      // Worn, not destroyed. The first version took 34 large bites plus 10
      // full-height cuts out of a 361 px band and what came back was a lace of
      // disconnected white blobs — it read as spilt paint, not as a lane line.
      // Roughly a third of the coverage now goes, in shallow transverse scuffs
      // where a tyre would actually take it.
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 16; i++) {
        const px = PAD + rnd() * s;
        const py = bandY + rnd() * bandH;
        blob(g, px, py, s * (0.015 + rnd() * 0.05), 0, 0, 0, 0.35 + rnd() * 0.45);
      }
      for (let i = 0; i < 5; i++) {
        g.fillStyle = rgba(0, 0, 0, 0.3 + rnd() * 0.4);
        g.fillRect(PAD + rnd() * s, bandY, s * (0.008 + rnd() * 0.02), bandH);
      }
      g.restore();
      break;
    }

    case 'gritDrift': {
      // An elongated tapered wedge of fines, for the downwind face of a prop
      // and the seam where two ground materials meet. Painted rather than
      // scattered because a drift seen at 15 m is a tone, not a set of stones.
      const grd = g.createLinearGradient(PAD, 0, PAD + s, 0);
      grd.addColorStop(0, rgba(150, 138, 116, 0.0));
      grd.addColorStop(0.24, rgba(158, 146, 122, 0.62));
      grd.addColorStop(0.62, rgba(150, 138, 116, 0.4));
      grd.addColorStop(1, rgba(146, 134, 112, 0.0));
      g.fillStyle = grd;
      g.beginPath();
      const st = 22;
      for (let i = 0; i <= st; i++) {
        const t = i / st;
        const x = PAD + t * s;
        const y = cy - s * 0.3 * Math.sin(Math.PI * Math.pow(t, 0.75)) * (0.7 + rnd() * 0.3);
        if (i === 0) g.moveTo(x, cy); else g.lineTo(x, y);
      }
      for (let i = st; i >= 0; i--) {
        const t = i / st;
        const x = PAD + t * s;
        const y = cy + s * 0.3 * Math.sin(Math.PI * Math.pow(t, 0.75)) * (0.7 + rnd() * 0.3);
        g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      // Individual stones at the thick end, so it does not read as airbrush.
      for (let i = 0; i < 70; i++) {
        const t = Math.pow(rnd(), 1.6);
        const x = PAD + (0.15 + t * 0.7) * s;
        const y = cy + (rnd() - 0.5) * s * 0.42 * Math.sin(Math.PI * (0.15 + t * 0.7));
        g.fillStyle = rgba(170 + rnd() * 40, 158 + rnd() * 36, 132 + rnd() * 30, 0.3 + rnd() * 0.4);
        g.fillRect(x, y, 1 + rnd() * 3, 1 + rnd() * 2.5);
      }
      erode(g, cx, cy, s * 0.5, 12, 0.35, rnd);
      break;
    }

    case 'leafDrift': {
      // Twenty-five to forty leaves painted as one quad. A gutter run twelve
      // metres long needs a thousand leaves and a thousand leaves is a thousand
      // pieces of geometry the far half of the street cannot resolve anyway, so
      // the distant runs are this and the near ones are real.
      const n = 25 + ((rnd() * 16) | 0);
      for (let i = 0; i < n; i++) {
        const t = rnd();
        const x = PAD + t * s;
        const spread = Math.sin(Math.PI * t);
        const y = cy + (rnd() - 0.5) * s * 0.5 * spread;
        const r = s * (0.028 + rnd() * 0.036);
        const a = rnd() * 6.2832;
        // Brown-olive, the value bo6_03's leaves measure against pavers.
        const v = 0.72 + rnd() * 0.5;
        g.save();
        g.translate(x, y);
        g.rotate(a);
        g.fillStyle = rgba(122 * v, 108 * v, 66 * v, 0.72 + rnd() * 0.25);
        g.beginPath();
        g.ellipse(0, 0, r, r * (0.42 + rnd() * 0.22), 0, 0, 6.2832);
        g.fill();
        // Midrib.
        g.strokeStyle = rgba(70 * v, 62 * v, 40 * v, 0.5);
        g.lineWidth = Math.max(0.8, r * 0.08);
        g.beginPath();
        g.moveTo(-r, 0); g.lineTo(r, 0); g.stroke();
        g.restore();
      }
      break;
    }

    default: break;
  }
}

/**
 * Paints the atlas and returns `{ texture, uv }` where `uv[name]` is
 * `[u0, v0, u1, v1]` for that cell's padded content area.
 */
export function buildDecalAtlas(seed = 1) {
  let a = (seed | 0) || 7;
  const rnd = () => {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = Math.imul(a ^ (a >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE)
    : Object.assign(document.createElement('canvas'), { width: ATLAS_SIZE, height: ATLAS_SIZE });
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  const uv = {};
  for (let i = 0; i < DECAL_KEYS.length; i++) {
    const name = DECAL_KEYS[i];
    const col = i % CELLS, row = (i / CELLS) | 0;
    g.save();
    g.translate(col * CELL, row * CELL);
    g.beginPath();
    g.rect(PAD * 0.5, PAD * 0.5, CELL - PAD, CELL - PAD);
    g.clip();
    drawCell(g, name, rnd);
    g.restore();
    // Content area, inset half a texel so bilinear never reaches the gutter.
    const u0 = (col * CELL + PAD * 0.5) / ATLAS_SIZE;
    const v0 = (row * CELL + PAD * 0.5) / ATLAS_SIZE;
    const u1 = (col * CELL + CELL - PAD * 0.5) / ATLAS_SIZE;
    const v1 = (row * CELL + CELL - PAD * 0.5) / ATLAS_SIZE;
    // Canvas Y runs down, texture V runs up.
    uv[name] = [u0, 1 - v1, u1, 1 - v0];
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'decalAtlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return { texture, uv };
}

// ---------------------------------------------------------------- geometry

/** Unit quad in the XY plane facing +Z, UV-mapped to one atlas cell. */
function quadFor(uv, flipU = false) {
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  const a = geo.attributes.uv;
  const [u0, v0, u1, v1] = uv;
  for (let i = 0; i < a.count; i++) {
    const u = flipU ? 1 - a.getX(i) : a.getX(i);
    a.setXY(i, u0 + (u1 - u0) * u, v0 + (v1 - v0) * a.getY(i));
  }
  a.needsUpdate = true;
  return geo;
}

/**
 * The quad pool. Every decal kind gets four pre-made quads with mirrored and
 * rotated UVs so a wall covered in the same tag does not read as a wallpaper.
 */
export class DecalKit {
  constructor(seed = 1) {
    const atlas = buildDecalAtlas(seed);
    this.texture = atlas ? atlas.texture : null;
    this.uv = atlas ? atlas.uv : {};
    /** @type {Record<string, THREE.BufferGeometry[]>} */
    this.quads = {};
    for (const k of DECAL_KEYS) {
      if (!this.uv[k]) continue;
      this.quads[k] = [quadFor(this.uv[k], false), quadFor(this.uv[k], true)];
    }
  }

  geo(kind, rand) {
    const list = this.quads[kind];
    if (!list) return null;
    return list[(rand() * list.length) | 0];
  }

  /**
   * Material overrides that turn a library key into a decal surface.
   *
   * There are two of these and the split is a performance decision, not an art
   * one. A blended decal cannot write depth, so nothing behind it is ever
   * rejected early and every pixel it covers runs the full standard shader
   * again — including a three-cascade PCSS lookup at up to 24 taps. Measured on
   * the interior preset, an eight-deep stack of blended wall decals cost 15 ms
   * of a 16.6 ms budget on its own.
   *
   * So only the marks that genuinely need a soft edge stay blended (grime,
   * streaking, dust, oil, scorch, standing water, mould). Everything with a
   * hard edge — impacts, cracks, posters, tags, tyre tread — is alpha-tested
   * and opaque, which puts it back in the depth-writing pass where the
   * hardware rejects the overlap for free.
   */
  overrides(blend) {
    return {
      map: this.texture,
      transparent: !!blend,
      opacity: 1,
      depthWrite: !blend,
      // Even a blended decal wants a threshold: the padded gutter around every
      // atlas cell is pure alpha zero and discarding it early saves blending a
      // transparent quad over a large part of the road.
      alphaTest: blend ? 0.03 : 0.45,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: blend ? -8 : -12,
      normalScale: 0,
      roughness: 0.88,
      metalness: 0,
      clearcoat: 0,
      envMapIntensity: 0.45,
      side: THREE.FrontSide,
      vertexColors: true,
    };
  }
}

// --------------------------------------------------------------- placement

const LIFT = 0.012;   // metres off the surface, on top of polygonOffset
/**
 * Contact patches sit *below* everything else, including the sheet litter they
 * are grounding — 1.5 mm rather than 12 mm. Sharing the general lift would put
 * the occlusion patch on top of the scrap of paper it is supposed to be under,
 * and a blended quad drawn over a piece of litter reads as a stain on it.
 */
const LIFT_CONTACT = 0.0015;

/** Places a decal flat on the ground, spun randomly about its own normal. */
function onGround(bs, key, geo, x, y, z, w, h, yaw, color, lift = LIFT) {
  bs.add(key, geo, x, y + lift, z, -Math.PI / 2, 0, yaw, w, h, 1, color, false);
}

/**
 * The `yaw` argument `onGround` wants, for a decal whose LONG axis (`w`) should
 * point along the compass yaw `a`.
 *
 * Worth a named helper because the convention is genuinely counter-intuitive
 * and getting it wrong is invisible until you look at the pixels. `bs.add`
 * composes Euler XYZ, which three.js evaluates as Rx·Ry·Rz, so the `yaw`
 * argument is applied to the quad *first*, spinning it in its own plane, and
 * only then is the whole thing tipped flat by the -90 about X. The upshot is
 * that the quad's local +X ends up pointing along world (cos yaw, -sin yaw)
 * rather than the (sin yaw, cos yaw) every other yaw in this codebase means.
 *
 * Every road-history run in this file was laid at 90 degrees to the street
 * before this existed, which put the lane markings across the carriageway like
 * a ladder.
 */
const alongYaw = (a) => a - Math.PI / 2;

/**
 * How many contact patches the whole map is allowed, split so that the props
 * cannot be starved by the ten thousand pieces of clutter that run first.
 *
 * These are blended, depth-write-off quads, which is the one thing in this file
 * that can genuinely cost frames: every pixel one covers re-runs the standard
 * shader including a three-cascade PCSS lookup. 700 patches averaging 0.4 m
 * across is roughly 9 % of an eye-level frame at one layer. If the street shot
 * loses more than 2 fps this is the first number to halve.
 */
export const CONTACT_CAP = { clutter: 200, prop: 200 };

/**
 * One occlusion patch under one thing.
 *
 * Returns false and costs nothing when the piece is too small to need one or
 * the budget is spent, so callers can fire it unconditionally from inside a
 * scatter loop. The budget lives on the kit, which is constructed once per
 * build, so it resets correctly on a rebuild without a global.
 *
 * @param {number} size the piece's scaled longest horizontal axis, metres
 * @param {number} [mult] patch size as a multiple of that
 * @param {boolean} [force] skip the size gate (props, mounds, colliders)
 * @param {'clutter'|'prop'} [budget]
 */
export function contactDecal(bs, kit, rand, x, y, z, size, mult = 2.0, force = false, budget = 'clutter') {
  if (!bs || !kit?.texture) return false;
  if (!force && !(size >= 0.25)) return false;
  const used = kit._contact || (kit._contact = { clutter: 0, prop: 0 });
  if (used[budget] >= (CONTACT_CAP[budget] || 0)) return false;
  const geo = kit.geo('contact', rand);
  if (!geo) return false;
  const w = Math.max(0.12, size * mult);
  // Slightly elliptical and randomly spun: a hundred circles read as a hundred
  // circles however irregular each one's edge is.
  _c.setScalar(1);
  onGround(bs, 'gun_polymer', geo, x, y, z, w, w * (0.82 + rand() * 0.34),
    rand() * 6.2832, _c, LIFT_CONTACT);
  used[budget]++;
  return true;
}

/**
 * A dust seam along a run of kerb or material boundary. Sampled from a field
 * the caller already built, so this is a few dozen quads and no new search.
 */
export function gritSeam(bs, kit, site, field, rand, n) {
  if (!bs || !kit?.texture || !field || field.empty) return 0;
  let count = 0;
  const yaw = site.windYaw || 0;
  for (let i = 0; i < n; i++) {
    const p = field.sample(rand);
    if (!p) break;
    const geo = kit.geo('gritDrift', rand);
    if (!geo) break;
    const w = 1.1 + rand() * 1.8;
    // Aligned with the wind, not spun at random: the whole map agrees on one
    // direction and a seam drift is no exception.
    onGround(bs, 'gun_polymer', geo, p.x, p.y, p.z, w, w * (0.24 + rand() * 0.16),
      alongYaw(yaw + (rand() - 0.5) * 0.7), tint(rand, 0.16, 0.1));
    count++;
  }
  return count;
}

/** Places a decal on a vertical face whose outward normal is (nx, nz). */
function onWall(bs, key, geo, x, y, z, nx, nz, w, h, color) {
  const yaw = Math.atan2(nx, nz);
  bs.add(key, geo, x + nx * LIFT, y, z + nz * LIFT, 0, yaw, 0, w, h, 1, color, false);
}

/**
 * The carriageway as an axis and a signed perpendicular coordinate.
 *
 * Everything a road remembers about being driven on is organised about its
 * centreline, not about the buildings: wheel polish, crack seals, lane paint
 * and the swept crown between the ruts. The axis is the long axis of the
 * largest facade — the same one `Site.buildShelter` takes the wind from, so the
 * ruts and the drifts agree with each other — and the offset is the *median*
 * perpendicular coordinate of the asphalt cells. Median, not mean: a forecourt
 * or a side road hanging off one side drags a mean sideways by metres and puts
 * both wheel pairs on the same half of the street.
 *
 * Exported because `clutter.js` shapes its rut Gaussians on the same numbers,
 * and two definitions of where the road is would be two roads.
 */
export function carriagewayAxis(site) {
  const f = site.facades?.[0];
  if (!f) return null;
  const dx = f.bx - f.ax, dz = f.bz - f.az;
  const l = Math.hypot(dx, dz) || 1;
  const ux = dx / l, uz = dz / l;
  const px = -uz, pz = ux;
  const acc = [];
  for (let i = 0; i < site.open.length; i++) {
    if (!site.open[i]) continue;
    const s = site.surf[i];
    if (s !== 'asphalt' && s !== 'asphalt_worn') continue;
    const ix = i % site.nx, iz = (i / site.nx) | 0;
    acc.push(site.xOf(ix) * px + site.zOf(iz) * pz);
  }
  if (acc.length < 8) return null;
  acc.sort((a, b) => a - b);
  return { ux, uz, px, pz, c0: acc[acc.length >> 1], lo: acc[0], hi: acc[acc.length - 1] };
}

/** Wheel-path offsets from the crown: a 3.5 m gauge inside each half. */
const WHEEL_OFFSETS = [-4.55, -1.75, 1.75, 4.55];

function tint(rand, v = 0.14, warm = 0) {
  const k = 1 - v * 0.5 + rand() * v;
  _c.setRGB(k * (1 + warm), k * (1 + warm * 0.4), k * (1 - warm * 0.7));
  return _c;
}

/**
 * Ground decals. The road is the largest single area of flat colour in every
 * frame and it is what the rubric's "mostly one colour" failure keys on, so the
 * heaviest spend goes here: grime bands where the road meets a kerb or a wall,
 * oil where vehicles stood, tyre tracks along the driving line, dust patches,
 * cracking and impact spray.
 */
export function groundDecals(ctx, site, soft, hard, kit, rand, density = 1, env = null) {
  if (!kit.texture) return { count: 0 };
  let count = 0;
  const N = (n) => Math.max(0, Math.round(n * density));

  const gate = (d) => (d > 16 ? 0 : 1);
  const nearWall = site.field((d, corner, s, x, z, indoor, step) =>
    gate(d) * (wallFalloff(d, 1.3, 0.02) + step * 6 + corner * 0.5));
  const anywhere = site.field((d) => gate(d) * (0.45 + wallFalloff(d, 3.5, 0)));
  const midRoad = site.field((d, corner, s) =>
    (d > 12 || d < 2.2 ? 0 : 1) * (s === 'asphalt' || s === 'asphalt_worn' ? 1.6 : 0.4));
  if (nearWall.empty && anywhere.empty) return { count: 0 };

  const put = (field, n, kind, wMin, wMax, aspect, v, warm, bs, mul = 1) => {
    for (let i = 0; i < n; i++) {
      const p = field.sample(rand);
      if (!p) break;
      const geo = kit.geo(kind, rand);
      if (!geo) break;
      const w = wMin + rand() * (wMax - wMin);
      const h = w * (aspect[0] + rand() * (aspect[1] - aspect[0]));
      const c = tint(rand, v, warm);
      if (mul !== 1) c.multiplyScalar(mul);
      onGround(bs, 'gun_polymer', geo, p.x, p.y, p.z, w, h, rand() * 6.2832, c);
      count++;
    }
  };

  // Dirt gravity along every wall base and kerb line.
  put(nearWall, N(120), 'grimeBand', 1.0, 2.4, [0.5, 1.0], 0.16, 0.02, soft);
  put(nearWall, N(80), 'dust', 0.8, 2.1, [0.6, 1.1], 0.18, 0.1, soft);
  put(nearWall, N(40), 'wet', 0.6, 1.5, [0.5, 1.0], 0.12, -0.05, soft);

  // General surface history.
  put(anywhere, N(95), 'dust', 0.9, 2.5, [0.55, 1.1], 0.2, 0.12, soft);
  put(anywhere, N(130), 'crackWeb', 0.9, 2.6, [0.7, 1.2], 0.14, 0.0, hard);
  put(anywhere, N(34), 'mould', 0.5, 1.4, [0.6, 1.1], 0.16, -0.04, soft);

  // Where vehicles stood and stopped.
  put(midRoad, N(52), 'oil', 0.9, 2.6, [0.6, 1.0], 0.12, -0.02, soft);
  put(midRoad, N(40), 'scorch', 1.2, 3.0, [0.7, 1.1], 0.14, 0.02, soft);
  // Ground spall at 0.55 of full tint, and 45 of them rather than 80.
  // `drawImpact` paints its spall ring at #c4bcac, which is right on a plaster
  // wall and reads as a chain of pale worms crawling across a 0.12-linear road
  // — the same "bright thin mark hovering on dark tarmac" the paper litter had.
  // Real spall on asphalt is grey dust, and it is sparse.
  put(midRoad, N(45), 'impactSpray', 0.8, 2.0, [0.8, 1.2], 0.14, 0.03, hard, 0.55);

  count += roadHistory(site, hard, kit, rand, density);

  /**
   * The damp bucket's material, finished off from this side.
   *
   * `Props.js` creates the bucket and gives it the roughness 0.40 that is the
   * entire reason it exists, but it cannot give it a `map` — the atlas belongs
   * to this module and Props.js has no business knowing about it. Without one
   * the bucket resolves to plain `gun_polymer` and every damp quad renders as a
   * rectangle of grey polymer lying on the road, alpha-tested against a texture
   * that is opaque everywhere. It has to be set here.
   *
   * `normalScale`, `clearcoat` and `side` are set to match `overrides(true)`
   * exactly. They are structural — `clearcoat` in particular flips
   * USE_CLEARCOAT — so leaving them off does not merely differ in look, it
   * compiles a second shader program, and the program ledger is at 61 against a
   * 60 budget. Matching them collapses damp onto the blended decal permutation
   * that already exists and the bucket costs one draw call and nothing else.
   * Everything the damp look actually needs (roughness, envMapIntensity) is
   * non-structural and survives.
   */
  if (env?.envOverrides && kit.texture) {
    env.envOverrides.damp = {
      map: kit.texture,
      normalScale: 0,
      clearcoat: 0,
      opacity: 1,
      side: THREE.FrontSide,
    };
  }
  count += dampPass(site, env?.decalDamp, kit, rand, density);

  return { count };
}

/**
 * What a road remembers: crack seals, trench reinstatements and lane paint.
 *
 * All of it goes in the HARD alpha-tested depth-writing set, which matters more
 * than it sounds. About 300 quads of this size in a blended set would be 300
 * quads' worth of overdraw each re-running a three-cascade PCSS lookup; in the
 * depth-writing set the hardware rejects the overlap for free and the whole
 * pass is zero new draws on top of the bucket that already exists.
 *
 * This is also the half of the road that the *surface generator* no longer
 * paints. Lane markings, cross-axis seams and repair patches used to be baked
 * into the asphalt texture, where they tiled every 2-3 m — seven wheel paths
 * across a 14 m street. Laying them here instead is the only way to get them at
 * real world scale and in the right places, and it is why the two changes had
 * to land in the same window.
 */
function roadHistory(site, hard, kit, rand, density) {
  const ax = carriagewayAxis(site);
  if (!ax) return 0;
  const { ux, uz, px, pz, c0, lo, hi } = ax;
  const yaw = alongYaw(Math.atan2(ux, uz));
  let count = 0;

  /** Lays one quad at a perpendicular offset and a distance along the street. */
  const lay = (kind, perp, s, w, h, spin, v, warm) => {
    const x = ux * s + px * (c0 + perp);
    const z = uz * s + pz * (c0 + perp);
    const y = site.groundAt(x, z);
    if (y === null) return false;
    const surf = site.surf[site.cellAt(x, z)];
    if (surf !== 'asphalt' && surf !== 'asphalt_worn') return false;
    const geo = kit.geo(kind, rand);
    if (!geo) return false;
    onGround(hard, 'gun_polymer', geo, x, y, z, w, h, yaw + spin, tint(rand, v, warm));
    count++;
    return true;
  };

  // The street's extent along its own axis, measured off the open cells rather
  // than assumed, so this stays correct if the level is rewritten.
  let sLo = 1e9, sHi = -1e9;
  for (let i = 0; i < site.open.length; i++) {
    if (!site.open[i]) continue;
    const s = site.surf[i];
    if (s !== 'asphalt' && s !== 'asphalt_worn') continue;
    const ix = i % site.nx, iz = (i / site.nx) | 0;
    const t = site.xOf(ix) * ux + site.zOf(iz) * uz;
    if (t < sLo) sLo = t;
    if (t > sHi) sHi = t;
  }
  if (sHi <= sLo) return 0;
  const span = sHi - sLo;

  // TAR SEAMS. 8-10 runs of 6-14 quads, 80 % of them longitudinal, following a
  // wandering line: a sealed crack is a crack first and a straight line never.
  const seams = Math.round(9 * density);
  for (let r = 0; r < seams; r++) {
    const longitudinal = rand() < 0.8;
    const n = 6 + ((rand() * 9) | 0);
    let perp = (rand() - 0.5) * Math.max(2, (hi - lo) * 0.85);
    let s = sLo + rand() * span * 0.85;
    for (let i = 0; i < n; i++) {
      if (longitudinal) {
        lay('tarSeam', perp, s, 3.0, 0.14, (rand() - 0.5) * 0.12, 0.1, 0);
        s += 2.7 + rand() * 0.25;
        perp += (rand() - 0.5) * 0.45;
      } else {
        lay('tarSeam', perp, s, 3.0, 0.14, Math.PI / 2 + (rand() - 0.5) * 0.2, 0.1, 0);
        perp += 2.7 + rand() * 0.25;
        s += (rand() - 0.5) * 0.4;
      }
    }
  }

  // REINSTATEMENT PATCHES. Sited away from the crown, because a utility trench
  // follows the services under the footway edge, not the middle of the road.
  const patches = 5 + ((rand() * 4) | 0);
  for (let i = 0; i < Math.round(patches * density); i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const perp = side * (1.6 + rand() * Math.max(0.5, (hi - lo) * 0.4));
    const s = sLo + rand() * span;
    lay('patch', perp, s, 1.2 + rand() * 2.3, 0.9 + rand() * 1.5, (rand() - 0.5) * 0.14, 0.1, 0);
  }

  // LANE PAINT. One broken centreline down the crown and one transverse bar set
  // where the street opens out. Half the coverage is already gone in the atlas
  // cell — fresh paint in a bombed district is its own kind of tell.
  const marks = Math.floor(span / 4.5);
  for (let i = 0; i < marks; i++) {
    const s = sLo + 2 + i * 4.5;
    lay('paintLine', (rand() - 0.5) * 0.12, s, 2.4, 0.16, 0, 0.06, 0);
  }
  // NO crossing bar set. It was in and it came out: a 0.5 m bar seen at a
  // glancing angle from eye level drops to a low mip where the cell's wear
  // holes dominate what is left of the band, and the result reads as a ring of
  // pale blobs rather than as paint. The broken centreline is 2.4 m long in the
  // view direction and never hits that angle, so it stays.

  return count;
}

/**
 * Damp. The single most consistent ground feature in the reference frames and
 * the one thing neither of the existing decal buckets can express.
 *
 * Both `overrides(blend)` variants pin roughness at 0.88, which is dry dust. A
 * damp patch is not darker paint — it is a *roughness* change, a specular
 * response the dry surface next to it does not have, and that is why it reads
 * as wetness rather than as a stain. `env.decalDamp` runs the same atlas at
 * roughness 0.40, which costs exactly one draw call and is the best value in
 * this file.
 *
 * Deliberately NOT done by raising the global `codWetness`: that makes the
 * whole world wet and loses the dry dusty morning-raid grade the art direction
 * is built on.
 */
function dampPass(site, damp, kit, rand, density) {
  if (!damp || !kit.texture) return 0;
  let count = 0;
  const yaw = site.windYaw || 0;
  /**
   * A hard ceiling, and this one is measured rather than assumed. The damp
   * bucket is blended with no depth write, so every pixel it covers re-runs the
   * full standard shader including the three-cascade PCSS lookup — the exact
   * thing Props.js's own comment records as costing 15 ms for an eight-deep
   * stack. Uncapped, the facade-base band alone laid ~270 quads covering more
   * than 500 m2 of ground and the street shot fell off a cliff. 160 large quads
   * one layer deep is the budget the fill-rate analysis actually supports.
   */
  const CAP = Math.round(160 * density);

  const put = (x, z, w, h, spin, v) => {
    if (count >= CAP) return;
    const y = site.groundAt(x, z);
    if (y === null) return;
    const geo = kit.geo('damp', rand);
    if (!geo) return;
    onGround(damp, 'gun_polymer', geo, x, y, z, w, h, spin, tint(rand, v, -0.03));
    count++;
  };

  // 1. A continuous run down both gutters. Water stands where the crown drains
  // to, all day, every day, and it is the most repeatable feature in the
  // reference set. One quad every 1.8 m along the kerb line.
  const gutter = site.field((d, corner, surf, x, z, indoor, step, lee, g) =>
    (indoor ? 0 : 1) * (g > 0.25 ? 1 : 0));
  if (!gutter.empty) {
    for (let i = 0; i < Math.round(70 * density); i++) {
      const p = gutter.sample(rand);
      if (!p) break;
      put(p.x, p.z, 1.7 + rand() * 0.9, 0.4 + rand() * 0.5, alongYaw(yaw + (rand() - 0.5) * 0.3), 0.1);
    }
  }

  // NOT the gully halos. `groundworks.js` places the real gullies and lays a
  // damp ring at each one from this same atlas cell, so doing it here as well
  // would put two coincident blended quads on the same square metre — double
  // the fill for a darker patch nobody asked for.

  // 3. A band along every facade base. A wall base never dries: it is in shade
  // for most of the day and it is where the rain that ran down the wall went.
  for (const f of site.facades) {
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    if (len < 2) continue;
    const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;
    const n = Math.max(1, Math.round(len / 5.0 * density));
    const along = alongYaw(Math.atan2(ux, uz));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const off = 0.28 + rand() * 0.5;
      put(f.ax + ux * len * t + f.nx * off, f.az + uz * len * t + f.nz * off,
        len / n * 1.2, 0.4 + rand() * 0.4, along, 0.1);
    }
  }

  // 4. Four or five large irregular patches out on the carriageway, so the road
  // is not uniformly dry between the two gutter runs.
  const road = site.field((d, corner, surf, x, z, indoor) =>
    (indoor ? 0 : 1) * ((surf === 'asphalt' || surf === 'asphalt_worn') ? 1 : 0));
  if (!road.empty) {
    // Three, at 2.0-3.0 m. Five at up to 5 m across is 100 m2 of blended quad
    // lying in the middle of the carriageway the camera is pointed down.
    for (let i = 0; i < Math.round(3 * density); i++) {
      const p = road.sample(rand);
      if (!p) break;
      const w = 2.0 + rand() * 1.0;
      put(p.x, p.z, w, w * (0.55 + rand() * 0.5), rand() * 6.2832, 0.1);
    }
  }

  return count;
}

/**
 * Tyre tracks: paired ruts following the long axis of the street, laid as a run
 * of overlapping quads so they curve and fade instead of appearing as one
 * stretched sticker.
 */
export function tyreTracks(ctx, site, bs, kit, rand, density = 1, env = null) {  // hard set
  if (!kit.texture || !site.facades.length) return { count: 0 };
  // The street runs along whatever the longest facade runs along.
  const f = site.facades[0];
  const ax = f.bx - f.ax, az = f.bz - f.az;
  const len = Math.hypot(ax, az) || 1;
  const ux = ax / len, uz = az / len;
  const px = -uz, pz = ux;

  let count = 0;
  count += wheelPolish(site, bs, kit, rand, density);
  const lanes = Math.round(9 * density);
  const drive = site.field((d) => (d > 9 || d < 3 ? 0 : 1));
  if (drive.empty) return { count: 0 };
  for (let lane = 0; lane < lanes; lane++) {
    const p = drive.sample(rand);
    if (!p) break;
    const sx = p.x, sz = p.z;
    const runLen = 8 + rand() * 26;
    const gauge = 1.55 + rand() * 0.25;
    const dir = rand() < 0.5 ? 1 : -1;
    const segs = Math.ceil(runLen / 2.2);
    let drift = 0;
    for (let i = 0; i < segs; i++) {
      drift += (rand() - 0.5) * 0.22;
      const t = (i + 0.5) / segs;
      const cx = sx + ux * dir * runLen * (t - 0.5) + px * drift;
      const cz = sz + uz * dir * runLen * (t - 0.5) + pz * drift;
      const fade = Math.sin(Math.PI * t) * 0.6 + 0.4;
      for (const side of [-1, 1]) {
        const x = cx + px * side * gauge * 0.5;
        const z = cz + pz * side * gauge * 0.5;
        const y = site.groundAt(x, z);
        if (y === null) continue;
        const geo = kit.geo('tyre', rand);
        if (!geo) continue;
        const yaw = Math.atan2(ux, uz) + Math.PI / 2;
        _c.setScalar(0.72 + 0.3 * fade);
        onGround(bs, 'gun_polymer', geo, x, y, z, 2.4, 0.34 + rand() * 0.08, yaw, _c);
        count++;
      }
    }
  }
  return { count };
}

/**
 * The four polished bands a driven road wears into itself.
 *
 * Distinct from the tread tracks above and more important than them. A tyre
 * mark is a one-off event; a wheel path is the *steady state* — years of
 * traffic in the same two lines, wearing the aggregate smooth and sweeping the
 * fines out, so the band is lighter and smoother than the tarmac either side of
 * it. It is the single strongest cue that a carriageway is a carriageway rather
 * than a grey plane, and the clutter fields deliberately bank their debris in
 * the gaps between these four lines.
 *
 * Four runs at the same +/-1.75 and +/-4.55 m offsets the rut Gaussians use,
 * each an fbm-ish wandering line of overlapping quads.
 */
function wheelPolish(site, hard, kit, rand, density) {
  // HARD set, and this one was argued both ways before being measured. A wheel
  // path is a tone rather than a mark, so blended is its natural home — but
  // these are 3 m quads laid flat down the view axis directly in front of an
  // eye-level camera, which is the worst case a blended set has: one of them
  // can cover a third of the lower frame and there are 56 stacked along the
  // line of sight. Alpha-tested at 0.45 the edge falls where the ramp crosses
  // the threshold, which would be a straight line if the cell did not take
  // erode() bites out of both edges. Ragged and free beats soft and measurable.
  const ax = carriagewayAxis(site);
  if (!ax) return 0;
  const { ux, uz, px, pz, c0 } = ax;
  const yaw = alongYaw(Math.atan2(ux, uz));
  let count = 0;

  let sLo = 1e9, sHi = -1e9;
  for (let i = 0; i < site.open.length; i++) {
    if (!site.open[i]) continue;
    const s = site.surf[i];
    if (s !== 'asphalt' && s !== 'asphalt_worn') continue;
    const iz = (i / site.nx) | 0;
    const t = site.xOf(i % site.nx) * ux + site.zOf(iz) * uz;
    if (t < sLo) sLo = t;
    if (t > sHi) sHi = t;
  }
  if (sHi - sLo < 6) return 0;

  for (const base of WHEEL_OFFSETS) {
    const n = 10 + ((rand() * 9) | 0);
    // 2.7 m per quad against a 3.0 m cell, so consecutive quads overlap by 10 %
    // and the run has no seams. Dividing the whole street by n instead — which
    // is what this did first — gives 6 m quads that stretch a 3 m texture to
    // twice its authored scale and smear the streaking into stripes.
    const step = 2.7;
    const sLo2 = sLo + rand() * Math.max(0, (sHi - sLo) - n * step);
    let wander = 0, vel = 0;
    for (let i = 0; i < n; i++) {
      // Two-pole random walk: a vehicle's line drifts smoothly, it does not
      // jitter, and a plain per-segment random offset reads as a zigzag.
      vel = vel * 0.72 + (rand() - 0.5) * 0.09;
      wander = wander * 0.94 + vel;
      const s = sLo2 + (i + 0.5) * step;
      const perp = c0 + base + wander;
      const x = ux * s + px * perp, z = uz * s + pz * perp;
      const y = site.groundAt(x, z);
      if (y === null) continue;
      const surf = site.surf[site.cellAt(x, z)];
      if (surf !== 'asphalt' && surf !== 'asphalt_worn') continue;
      const geo = kit.geo('wheelPath', rand);
      if (!geo) continue;
      // Ends fade, middles are solid: a run that is uniformly strong end to end
      // reads as one long sticker.
      const fade = 0.55 + 0.45 * Math.sin(Math.PI * ((i + 0.5) / n));
      _c.setScalar(0.86 + 0.24 * fade);
      onGround(hard, 'gun_polymer', geo, x, y, z,
        step * 1.11, 0.5 + rand() * 0.12, yaw + (rand() - 0.5) * 0.05, _c);
      count++;
    }
  }
  return count;
}

/**
 * Wall decals. Walks every surveyed facade and lays a vertical history on it:
 * grime rising from the ground, rain streaking down from the parapet, impact
 * clusters at chest height, cracks, tags and torn bills.
 */
export function wallDecals(ctx, site, soft, hard, kit, rand, density = 1, env = null) {
  if (!kit.texture) return { count: 0 };
  let count = 0;

  const put = (bs, kind, x, y, z, nx, nz, w, h, v, warm) => {
    const geo = kit.geo(kind, rand);
    if (!geo) return;
    onWall(bs, 'gun_polymer', geo, x, y, z, nx, nz, w, h, tint(rand, v, warm));
    count++;
  };
  /** Same, with an explicit multiply tint rather than a jittered near-white. */
  const putTinted = (bs, kind, x, y, z, nx, nz, w, h, r, g, b) => {
    const geo = kit.geo(kind, rand);
    if (!geo) return;
    _c.setRGB(r, g, b);
    onWall(bs, 'gun_polymer', geo, x, y, z, nx, nz, w, h, _c);
    count++;
  };

  for (const f of site.facades) {
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    if (len < 1.2) continue;
    const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;
    const h = Math.min(f.top - f.base, 20);
    const at = (t, off) => [f.ax + ux * len * t + f.nx * off, f.az + uz * len * t + f.nz * off];

    // 1. DIRT GRAVITY at the wall base — rule 4, and the strongest single
    // anti-floating cue there is on a facade. A building meets the ground; the
    // ground is wet; the bottom of the masonry has been wicking that water for
    // decades and is a measurably different colour from the wall above it.
    //
    // This used to be ONE untinted band of random height 0.7-2.2 m, which is a
    // vague smear rather than a structure. Real wall bases have two distinct
    // tiers with two different causes and two different heights: rising damp to
    // about 0.75 m with a mottled upper limit, and a much dirtier splash band
    // to about 0.30 m thrown back up off the pavement by rain. Both are laid
    // here in place of the single band, not on top of it — the SOFT set is
    // already the most expensive thing in the frame (shedding it alone takes
    // this shot from 16 fps to 60) and adding a third layer over the two that
    // matter would have been the wrong trade.
    const dampN = Math.max(2, Math.round(len / 2.6 * density));
    for (let i = 0; i < dampN; i++) {
      const t = (i + 0.5) / dampN + (rand() - 0.5) * 0.3 / dampN;
      const [x, z] = at(THREE.MathUtils.clamp(t, 0, 1), 0);
      const bh = 0.62 + rand() * 0.3;
      putTinted(soft, 'grimeBand', x, f.base + bh * 0.5, z, f.nx, f.nz,
        len / dampN * 1.5, bh, 0.62, 0.62, 0.64);
    }
    const splashN = Math.max(2, Math.round(len / 3.4 * density));
    for (let i = 0; i < splashN; i++) {
      const t = (i + 0.5) / splashN;
      const [x, z] = at(t, 0);
      putTinted(soft, 'grimeBand', x, f.base + 0.15, z, f.nx, f.nz,
        len / splashN * 1.25, 0.30, 0.58, 0.52, 0.45);
    }

    // 1b. RUST RUNS from whatever is bolted to the wall down to the plinth.
    // `facade.js` returns a `sills` array with the exact anchor points these
    // want, but `Props.js` only forwards `bays`, so this walks the run and
    // sites them itself. Anchored would be better; that is a documented gap.
    for (let i = 0, n = Math.round(len * 0.06 * density); i < n; i++) {
      const [x, z] = at(rand(), 0);
      const y0 = f.base + 1.8 + rand() * Math.max(0.5, Math.min(h - 2.4, 5));
      const sh = Math.max(1.2, y0 - f.base);
      putTinted(soft, 'drip', x, y0 - sh * 0.5, z, f.nx, f.nz,
        0.22, sh, 0.42, 0.30, 0.22);
    }

    // 2. Rain running down off the top of the wall.
    const streakN = Math.round(len * 0.3 * density);
    for (let i = 0; i < streakN; i++) {
      const [x, z] = at(rand(), 0);
      const sh = Math.min(h * (0.3 + rand() * 0.55), 7);
      put(soft, 'streak', x, f.top - sh * 0.5 - rand() * 0.4, z, f.nx, f.nz,
        0.7 + rand() * 1.5, sh, 0.12, 0.0);
    }
    // and a second, shorter set starting part-way down, off ledges.
    for (let i = 0; i < Math.round(streakN * 0.5); i++) {
      const [x, z] = at(rand(), 0);
      const y0 = f.base + 1.5 + rand() * Math.max(0.5, h - 3);
      const sh = 0.8 + rand() * 2.4;
      put(soft, rand() < 0.5 ? 'drip' : 'streak', x, y0 - sh * 0.5, z, f.nx, f.nz,
        0.35 + rand() * 1.2, sh, 0.12, 0.0);
    }

    // 3. Battle damage, clustered rather than sprinkled.
    const bursts = Math.round(len * 0.16 * density);
    for (let i = 0; i < bursts; i++) {
      const t = rand();
      const y0 = f.base + 0.7 + rand() * Math.min(2.6, h - 1);
      for (let k = 0, n = 1 + ((rand() * 3) | 0); k < n; k++) {
        const [x, z] = at(THREE.MathUtils.clamp(t + (rand() - 0.5) * 0.08, 0, 1), 0);
        const kind = rand() < 0.45 ? 'impactCluster' : rand() < 0.6 ? 'impactSpray' : 'impact';
        const w = kind === 'impact' ? 0.16 + rand() * 0.14 : 0.7 + rand() * 1.5;
        put(hard, kind, x, y0 + (rand() - 0.5) * 0.9, z, f.nx, f.nz, w, w * (0.8 + rand() * 0.5), 0.1, 0.02);
      }
    }

    // 4. Structural cracking, denser low down where the load is.
    const cracks = Math.round(len * 0.3 * density);
    for (let i = 0; i < cracks; i++) {
      const [x, z] = at(rand(), 0);
      const y = f.base + Math.pow(rand(), 1.7) * (h - 0.6) + 0.3;
      const w = 0.7 + rand() * 2.2;
      put(hard, 'crackWeb', x, y, z, f.nx, f.nz, w, w * (0.7 + rand() * 0.8), 0.1, 0.0);
    }

    // 5. Human traces, only at reachable height.
    const tags = Math.round(len * 0.1 * density);
    for (let i = 0; i < tags; i++) {
      const [x, z] = at(rand(), 0);
      const w = 1.0 + rand() * 2.4;
      put(hard, rand() < 0.5 ? 'tagA' : 'tagB', x, f.base + 0.9 + rand() * 1.2, z, f.nx, f.nz,
        w, w * (0.42 + rand() * 0.24), 0.08, 0);
    }
    const bills = Math.round(len * 0.13 * density);
    for (let i = 0; i < bills; i++) {
      const [x, z] = at(rand(), 0);
      const bw = 0.35 + rand() * 0.5;
      put(hard, 'poster', x, f.base + 1.1 + rand() * 1.3, z, f.nx, f.nz, bw, bw * (1.2 + rand() * 0.5), 0.1, 0.02);
    }

    // 6. Mould and water damage low down and in shade.
    const damp = Math.round(len * 0.12 * density);
    for (let i = 0; i < damp; i++) {
      const [x, z] = at(rand(), 0);
      const w = 0.6 + rand() * 1.6;
      put(soft, rand() < 0.6 ? 'mould' : 'dust', x, f.base + 0.3 + rand() * 2.2, z, f.nx, f.nz,
        w, w * (0.7 + rand() * 0.9), 0.14, 0.04);
    }
  }
  return { count };
}

/**
 * A ring of settled dust and grime where a prop meets the ground.
 *
 * The cheapest possible fix for the "dropped in, not standing there" read: an
 * object with a clean hard edge against the floor looks composited, and a
 * contact shadow alone does not sell it because the shadow moves with the sun
 * and the dirt does not.
 */
/**
 * Scorch and spill under the hero props. A burnt-out vehicle with clean tarmac
 * beneath it is the single most obvious tell that a prop was dropped into a
 * scene rather than having happened in it.
 */
export function groundingDust(ctx, site, soft, kit, rand, colliders, env = null) {
  if (!kit.texture || !colliders?.length) return { count: 0 };
  let count = 0;
  const core = env?.core || null;
  const wx = site.windX, wz = site.windZ;
  // Whole-map ceiling on the sand fillets. They are opaque and therefore cheap
  // per pixel, but they are also 42 triangles each in a shadow-casting set.
  let wedgeBudget = 240;

  for (const c of colliders) {
    const hw = Math.max(0.15, c.w * 0.5), hd = Math.max(0.15, c.d * 0.5);
    const r = Math.max(hw, hd);
    const y0 = site.groundAt(c.x, c.z);
    if (y0 === null) continue;
    const yaw = c.yaw || 0;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // Local -> world for a box rotated about Y.
    const wpt = (lx, lz) => [c.x + lx * cy + lz * sy, c.z - lx * sy + lz * cy];

    // 1. THE CONTACT PATCH. Centred, at the prop's own footprint, at full
    // strength. This is the term the old code did not have at all: it emitted
    // one or two blobs at a random offset up to 0.7r from the centre and 1.6 to
    // 2.7 times the prop's size, which is a vague smudge *near* the prop rather
    // than occlusion *under* it — and that is exactly why the dumpster and the
    // crates read as pasted onto the road.
    if (contactDecal(soft, kit, rand, c.x, y0, c.z, Math.max(c.w, c.d), 1.15, true, 'prop')) count++;

    // 2. GRIT DRIFTS ON THE TWO DOWNWIND FACES. One wind for the whole map, so
    // every prop on the street banks its drift the same way — the asymmetry
    // agreeing everywhere is the point, and it is what an independently
    // randomised per-prop drift can never produce.
    let banded = false;
    const faces = [
      [0, hd, 0, 1, c.w], [0, -hd, 0, -1, c.w],
      [hw, 0, 1, 0, c.d], [-hw, 0, -1, 0, c.d],
    ];
    for (const [lx, lz, nlx, nlz, fw] of faces) {
      // Face normal in world space, then keep it only if it faces downwind.
      const nx = nlx * cy + nlz * sy, nz = -nlx * sy + nlz * cy;
      if (nx * wx + nz * wz < 0.2) continue;
      const [fx, fz] = wpt(lx + nlx * 0.16, lz + nlz * 0.16);
      const y = site.groundAt(fx, fz);
      if (y === null) continue;
      const geo = kit.geo('gritDrift', rand);
      if (!geo) continue;
      onGround(soft, 'gun_polymer', geo, fx, y, fz,
        Math.max(0.4, fw * 1.3), 0.35, alongYaw(Math.atan2(nx, nz) + Math.PI / 2), tint(rand, 0.14, 0.09));
      count++;

      // 3. Sand wedges tucked into the angle where the face meets the floor.
      // A projected quad physically cannot produce this: it has to bridge two
      // surfaces at right angles, so it is the one thing here that must be
      // geometry. Rides the existing `dirt` bucket in `core`, zero new draws.
      //
      // 6-10 per PROP, not per face. Per face it was up to 40 wedges on every
      // collider in the map — 250 k triangles of hemisphere for a detail that
      // is 0.15 m across, which is a bad trade at any budget.
      if (core && wedgeBudget > 0) {
        const wedges = Math.min(wedgeBudget, 3 + ((rand() * 3) | 0));
        wedgeBudget -= wedges;
        for (let i = 0; i < wedges; i++) {
          const t = (i + 0.2 + rand() * 0.6) / wedges - 0.5;
          const along = t * fw * 0.95;
          const [gx, gz] = wpt(lx + (-nlz) * along + nlx * 0.05, lz + nlx * along + nlz * 0.05);
          const gy = site.groundAt(gx, gz);
          if (gy === null) continue;
          const rr = 0.10 + rand() * 0.12;
          _c.setRGB(1.06, 0.99, 0.86);
          core.add('dirt', WEDGE_GEO || (WEDGE_GEO = makeWedge()), gx, gy, gz,
            0, Math.atan2(nx, nz), 0, rr * (1.1 + rand() * 0.8), rr * 0.5, rr * 0.7, _c, false);
        }
      }

      // 4. A grime band on this face's lowest 0.15 m — dirt gravity, rule 4.
      // Downwind faces only, and only the first one: this is the least
      // valuable blended quad in the file (0.15 m of a prop that already has a
      // contact patch and a drift under it) and the soft set is the frame's
      // single biggest cost.
      if (!banded) {
        const bg = kit.geo('grimeBand', rand);
        if (bg) {
          const [bx, bz] = wpt(lx, lz);
          onWall(soft, 'gun_polymer', bg, bx, y0 + 0.075, bz, nx, nz,
            Math.max(0.3, fw * 1.02), 0.15, tint(rand, 0.1, 0.04));
          count++;
          banded = true;
        }
      }
    }
  }
  return { count };
}

/** A low triangular fillet of sand, for the angle between a prop and the floor. */
let WEDGE_GEO = null;
function makeWedge() {
  const g = new THREE.SphereGeometry(0.5, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // Squash into a lens and pull the back edge up against the wall face.
    const z = pos.getZ(i);
    pos.setY(i, pos.getY(i) * (1 + Math.max(0, z) * 1.4));
  }
  g.computeVertexNormals();
  projectUV(g);
  return g;
}

export function hotspotDecals(ctx, site, soft, hard, kit, rand, hotspots) {
  if (!kit.texture || !hotspots?.length) return { count: 0 };
  let count = 0;
  for (const hs of hotspots) {
    for (let i = 0, n = 5 + ((rand() * 5) | 0); i < n; i++) {
      const a = rand() * 6.2832;
      const r = Math.sqrt(rand()) * hs.r;
      const x = hs.x + Math.cos(a) * r, z = hs.z + Math.sin(a) * r;
      const y = site.groundAt(x, z);
      if (y === null) continue;
      const kind = r < hs.r * 0.55 ? (rand() < 0.6 ? 'scorch' : 'oil') : 'scorch';
      const w = (kind === 'oil' ? 0.6 : 1.4) * (0.7 + rand() * 0.9);
      const geo = kit.geo(kind, rand);
      if (!geo) continue;
      onGround(soft, 'gun_polymer', geo, x, y, z, w, w * (0.7 + rand() * 0.6),
        rand() * 6.2832, tint(rand, 0.1, 0));
      count++;
    }
    // Fragments of blown glass read as a bright sparkle ring around a vehicle.
    for (let i = 0, n = 3 + ((rand() * 4) | 0); i < n; i++) {
      const a = rand() * 6.2832;
      const r = hs.r * (0.5 + rand() * 0.6);
      const x = hs.x + Math.cos(a) * r, z = hs.z + Math.sin(a) * r;
      const y = site.groundAt(x, z);
      if (y === null) continue;
      const geo = kit.geo('impactSpray', rand);
      if (!geo) continue;
      onGround(hard, 'gun_polymer', geo, x, y, z, 0.9 + rand() * 0.8, 0.9 + rand() * 0.8,
        rand() * 6.2832, tint(rand, 0.1, 0.05));
      count++;
    }
  }
  return { count };
}
