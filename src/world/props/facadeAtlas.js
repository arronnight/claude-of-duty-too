import * as THREE from 'three';

/**
 * The facade opening atlas — everything that lives *inside* a hole in a wall.
 *
 * Why an atlas at all. A window is not a surface, it is a view of an interior,
 * and there is no material in the library that can express "dark room with a
 * curtain and a strip light" from a noise field. It has to be painted. Once it
 * is painted, sixteen paintings in one 2048² texture on one material key means
 * every opening on the map — glazing, shutters, boarded panels, shopfronts,
 * doors, signs, louvres and the distant-LOD balustrade — is a single draw call
 * regardless of how many there are.
 *
 * Why 2048 and not 1024. The opening is 1.30 m wide and a 512 px cell across
 * 1.30 m is 394 px/m, which still holds together when the player stands 5 m
 * from a shopfront. At 1024 the cells are 256 px, 197 px/m, and the glazing
 * bars turn to mush at exactly the distance the street camera sits.
 *
 * Modelled deliberately on `DecalKit` in decals.js: same OffscreenCanvas
 * pattern, same padded-cell UV arithmetic, same `overrides()` shape, so the two
 * behave identically under the BatchSet build path.
 *
 * Two decisions that differ from the decal atlas and are load-bearing:
 *
 * - **Cells are drawn over their whole 512 px, not clipped to the content
 *   rect.** The UVs then address the inner 496. A decal wants a transparent
 *   gutter because its edge must fade out; a window pane is opaque to its own
 *   border and a transparent gutter would eat into the frame under an
 *   `alphaTest` of 0.5 as soon as the mip chain blurred the two together.
 *
 * - **The sky in the glass is not painted.** Only `paneSky` has a hint of it.
 *   Everything else is dark, and the reflection comes from clearcoat Fresnel
 *   against the PMREM environment map, which means it tracks time of day and
 *   grazing angle for free instead of being a lie baked at noon.
 */

const SIZE = 2048;
const CELLS = 4;
const CELL = SIZE / CELLS;      // 512
const PAD = 16;

/** Grid order is the cell index; index 0 is top-left of the canvas. */
export const PANE_KEYS = [
  'paneDark', 'paneCurtain', 'paneSky', 'paneBroken',
  'paneBoarded', 'paneShutter', 'paneGrille', 'paneBlocked',
  'shopGlass', 'shopShutter', 'doorTimber', 'doorMetal',
  'signBoard', 'signHanging', 'ventLouvre', 'railingLace',
];

/** Cells with real alpha holes. Everything else is opaque to its border. */
const CUTOUT = new Set(['railingLace']);

// ------------------------------------------------------------------ painting

function rgba(r, g, b, a) { return `rgba(${r | 0},${g | 0},${b | 0},${a})`; }

function fill(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }

function vgrad(g, x, y, w, h, top, bot) {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, top);
  gr.addColorStop(1, bot);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}

/** Fine vertical grain, the cheapest way to stop a flat fill reading as vector art. */
function grain(g, x, y, w, h, n, alpha, rnd, dark = true) {
  g.save();
  for (let i = 0; i < n; i++) {
    const gx = x + rnd() * w;
    const gw = 1 + rnd() * 3;
    g.fillStyle = dark ? rgba(0, 0, 0, alpha * rnd()) : rgba(255, 250, 240, alpha * rnd());
    g.fillRect(gx, y + rnd() * h * 0.3, gw, h * (0.5 + rnd() * 0.5));
  }
  g.restore();
}

/** Inner shadow along the top and left of a rect — reads as depth for 4 fills. */
function innerShade(g, x, y, w, h, d, a = 0.55) {
  const t = g.createLinearGradient(0, y, 0, y + d);
  t.addColorStop(0, rgba(0, 0, 0, a));
  t.addColorStop(1, rgba(0, 0, 0, 0));
  g.fillStyle = t; g.fillRect(x, y, w, d);
  const l = g.createLinearGradient(x, 0, x + d, 0);
  l.addColorStop(0, rgba(0, 0, 0, a * 0.8));
  l.addColorStop(1, rgba(0, 0, 0, 0));
  g.fillStyle = l; g.fillRect(x, y, d, h);
  // A thin lit lip along the bottom, which is what actually says "recessed".
  const b = g.createLinearGradient(0, y + h - d * 0.6, 0, y + h);
  b.addColorStop(0, rgba(255, 248, 236, 0));
  b.addColorStop(1, rgba(255, 248, 236, a * 0.30));
  g.fillStyle = b; g.fillRect(x, y + h - d * 0.6, w, d * 0.6);
}

/**
 * Glazing bars. Baked at 9 px minimum at mip 0 on purpose: a 4 px bar averages
 * to nothing by mip 2 and then crawls, where a 9 px bar averages to a legible
 * mid-tone and holds the grid all the way out to the far end of the street.
 */
function bars(g, x, y, w, h, cols, rows, bw, col) {
  for (let i = 1; i < cols; i++) {
    const bx = x + (w * i) / cols - bw / 2;
    fill(g, bx + 3, y, bw, h, rgba(0, 0, 0, 0.5));
    fill(g, bx, y, bw, h, col);
  }
  for (let j = 1; j < rows; j++) {
    const by = y + (h * j) / rows - bw / 2;
    fill(g, x, by + 3, w, bw, rgba(0, 0, 0, 0.5));
    fill(g, x, by, w, bw, col);
  }
}

/**
 * The sash: an opaque frame filling the whole cell with the glass area inset.
 * Returns the glass rect. Every glazed cell starts here so the joinery is
 * consistent from pane to pane — variation belongs in the glass, not the frame.
 */
function sash(g, rnd, frameCol = '#6f685b', fw = 26) {
  fill(g, 0, 0, CELL, CELL, frameCol);
  grain(g, 0, 0, CELL, CELL, 90, 0.20, rnd);
  // Outer arris catches the sun, inner edge falls into shade.
  fill(g, 0, 0, CELL, 5, rgba(255, 250, 238, 0.28));
  fill(g, 0, CELL - 6, CELL, 6, rgba(0, 0, 0, 0.35));
  const r = [fw, fw, CELL - fw * 2, CELL - fw * 2];
  fill(g, r[0] - 4, r[1] - 4, r[2] + 8, r[3] + 8, rgba(0, 0, 0, 0.65));
  return r;
}

/** Random-walk polyline used for cracks, rust runs and graffiti. */
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
}

/**
 * Abstract calligraphic strokes for signage.
 *
 * Deliberately NOT glyphs, in any script. A sign with real letters on it is
 * either a brand we may not use or a language error a critic will spot
 * instantly; a scribbled arabesque reads as "shop sign in a script I cannot
 * read" at 8 m, which is exactly what the frame needs and cannot be wrong.
 */
function calligraphy(g, x, y, w, h, col, rnd, n = 6) {
  g.save();
  g.strokeStyle = col;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  let cx = x + w * 0.05;
  for (let i = 0; i < n; i++) {
    const sw = w * (0.06 + rnd() * 0.09);
    // Stroke weight is the whole difference between script and a blob. A pen
    // nib at this size is 3-5% of the cap height, not 8%.
    g.lineWidth = h * (0.030 + rnd() * 0.022);
    g.beginPath();
    g.moveTo(cx, y + h * (0.34 + rnd() * 0.20));
    g.bezierCurveTo(
      cx + sw * 0.3, y + h * (0.10 + rnd() * 0.24),
      cx + sw * 0.7, y + h * (0.58 + rnd() * 0.26),
      cx + sw, y + h * (0.34 + rnd() * 0.22),
    );
    g.stroke();
    // Ascenders and dots, which is what makes a scribble read as a script.
    if (rnd() < 0.45) {
      g.lineWidth = h * 0.026;
      g.beginPath();
      g.moveTo(cx + sw * 0.5, y + h * 0.38);
      g.lineTo(cx + sw * (0.4 + rnd() * 0.3), y + h * (0.06 + rnd() * 0.12));
      g.stroke();
    }
    cx += sw * (0.9 + rnd() * 0.35);
    if (cx > x + w * 0.93) break;
  }
  // The baseline stroke that ties a cursive script together.
  g.lineWidth = h * 0.028;
  g.beginPath();
  g.moveTo(x + w * 0.05, y + h * 0.72);
  g.bezierCurveTo(x + w * 0.35, y + h * 0.78, x + w * 0.65, y + h * 0.66, x + w * 0.95, y + h * 0.74);
  g.stroke();
  g.restore();
}

// --------------------------------------------------------------------- cells

function drawCell(g, name, rnd) {
  switch (name) {

    // ---- 0. The default: an unlit room seen through dirty glass.
    case 'paneDark': {
      const [x, y, w, h] = sash(g, rnd);
      fill(g, x, y, w, h, '#16181d');
      vgrad(g, x, y, w, h, '#23262b', '#101216');
      // A sliver of warm interior in the lower left — a doorway to a lit room.
      const wg = g.createRadialGradient(x + w * 0.22, y + h * 0.82, 0, x + w * 0.22, y + h * 0.82, w * 0.4);
      wg.addColorStop(0, rgba(58, 47, 34, 0.85));
      wg.addColorStop(1, rgba(58, 47, 34, 0));
      g.fillStyle = wg; g.fillRect(x, y, w, h);
      bars(g, x, y, w, h, 3, 2, 9, '#8d8677');
      innerShade(g, x, y, w, h, 34);
      grain(g, x, y, w, h, 40, 0.18, rnd);
      break;
    }

    // ---- 1. A curtain drawn across part of the opening. The single most
    // useful cell: it is the only one that is bright, so it breaks the grid.
    case 'paneCurtain': {
      const [x, y, w, h] = sash(g, rnd);
      vgrad(g, x, y, w, h, '#23262b', '#0f1115');
      const cw = w * 0.45;
      const folds = 6 + ((rnd() * 3) | 0);
      for (let i = 0; i < folds; i++) {
        const fx = x + (cw * i) / folds;
        const fw = cw / folds + 1;
        const grd = g.createLinearGradient(fx, 0, fx + fw, 0);
        grd.addColorStop(0, i % 2 ? '#a2977f' : '#cbbfa6');
        grd.addColorStop(0.5, i % 2 ? '#b4a891' : '#d6cbb4');
        grd.addColorStop(1, i % 2 ? '#cbbfa6' : '#a2977f');
        g.fillStyle = grd;
        g.fillRect(fx, y, fw, h);
      }
      // 12 px feather down the free edge so it does not read as a cut card.
      const fe = g.createLinearGradient(x + cw - 12, 0, x + cw + 12, 0);
      fe.addColorStop(0, rgba(162, 151, 127, 0.9));
      fe.addColorStop(1, rgba(162, 151, 127, 0));
      g.fillStyle = fe; g.fillRect(x + cw - 12, y, 24, h);
      bars(g, x, y, w, h, 3, 2, 9, '#8d8677');
      innerShade(g, x, y, w, h, 34);
      break;
    }

    // ---- 2. Glass that is actually reflecting something. Kept restrained:
    // the real reflection is clearcoat Fresnel, this is only the seed.
    case 'paneSky': {
      const [x, y, w, h] = sash(g, rnd);
      fill(g, x, y, w, h, '#1b1e22');
      vgrad(g, x, y, w, h * 0.34, '#93a9bd', '#3a4650');
      g.save();
      g.beginPath(); g.rect(x, y, w, h); g.clip();
      g.strokeStyle = rgba(182, 198, 212, 0.35);
      g.lineWidth = h * 0.10;
      g.beginPath();
      g.moveTo(x - w * 0.2, y + h * 0.95);
      g.lineTo(x + w * 1.2, y + h * 0.95 - w * 1.4 * Math.tan(0.436));
      g.stroke();
      g.restore();
      bars(g, x, y, w, h, 3, 2, 9, '#8d8677');
      innerShade(g, x, y, w, h, 34);
      break;
    }

    // ---- 3. Blown out. Reads as damage from 40 m, which is the point.
    case 'paneBroken': {
      const [x, y, w, h] = sash(g, rnd);
      fill(g, x, y, w, h, '#101216');
      // Shards still gripped by the rebate, always at the corners.
      g.fillStyle = '#7f8a8c';
      const shards = 4 + ((rnd() * 3) | 0);
      for (let i = 0; i < shards; i++) {
        const corner = i % 4;
        const ax = corner & 1 ? x + w : x;
        const ay = corner & 2 ? y + h : y;
        const sx = corner & 1 ? -1 : 1;
        const sy = corner & 2 ? -1 : 1;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(ax + sx * w * (0.16 + rnd() * 0.28), ay);
        g.lineTo(ax + sx * w * (0.05 + rnd() * 0.12), ay + sy * h * (0.20 + rnd() * 0.30));
        g.closePath();
        g.globalAlpha = 0.55 + rnd() * 0.4;
        g.fill();
      }
      g.globalAlpha = 1;
      // Hairline cracks in what is left.
      g.strokeStyle = '#6f7a7c';
      g.lineWidth = 3;
      for (let i = 0; i < 3; i++) {
        scrawl(g, x + rnd() * w, y + rnd() * h, w * 0.6, rnd() * 6.2832, 0.9, 6, rnd);
      }
      bars(g, x, y, w, h, 3, 2, 9, '#6e6960');
      innerShade(g, x, y, w, h, 40, 0.75);
      break;
    }

    // ---- 4. Boarded up. Timber, not plywood: the plank joints are the read.
    case 'paneBoarded': {
      const [x, y, w, h] = sash(g, rnd, '#5f584c');
      fill(g, x, y, w, h, '#0b0c0e');
      const n = 4 + ((rnd() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const bh = h / n;
        const by = y + i * bh;
        const gap = 10 + rnd() * 8;
        g.save();
        g.translate(x + w / 2, by + bh / 2);
        g.rotate((rnd() - 0.5) * 0.105);           // +/- 3 degrees
        const grd = g.createLinearGradient(0, -bh / 2, 0, bh / 2);
        grd.addColorStop(0, '#7c6449');
        grd.addColorStop(0.5, '#6b563d');
        grd.addColorStop(1, '#53422e');
        g.fillStyle = grd;
        g.fillRect(-w * 0.58, -bh / 2 + gap / 2, w * 1.16, bh - gap);
        g.strokeStyle = rgba(40, 28, 16, 0.5);
        g.lineWidth = 2;
        for (let k = 0; k < 5; k++) {
          const gy = -bh / 2 + gap / 2 + rnd() * (bh - gap);
          g.beginPath(); g.moveTo(-w * 0.58, gy); g.lineTo(w * 0.58, gy + (rnd() - 0.5) * 6); g.stroke();
        }
        g.restore();
        // Two nails per board, off-centre.
        g.fillStyle = '#3a3128';
        for (const s of [-1, 1]) {
          g.beginPath();
          g.arc(x + w * (0.5 + s * (0.30 + rnd() * 0.10)), by + bh * 0.5, 6, 0, 6.2832);
          g.fill();
        }
      }
      innerShade(g, x, y, w, h, 30, 0.65);
      break;
    }

    // ---- 5. Roller shutter, down. Corrugation is a shading cue we get for
    // free from the painted ribs — the geometry stays a single flat quad.
    case 'paneShutter': {
      const [x, y, w, h] = sash(g, rnd, '#6f6a62');
      for (let ry = 0; ry < h; ry += 14) {
        fill(g, x, y + ry, w, 7, '#8a8f93');
        fill(g, x, y + ry + 7, w, 7, '#6b7075');
      }
      // Rust bleeding up from the bottom rail, where the water sits.
      const rg = g.createLinearGradient(0, y + h, 0, y + h * 0.75);
      rg.addColorStop(0, rgba(107, 75, 56, 0.92));
      rg.addColorStop(1, rgba(107, 75, 56, 0));
      g.fillStyle = rg; g.fillRect(x, y + h * 0.75, w, h * 0.25);
      g.strokeStyle = rgba(90, 62, 44, 0.5);
      g.lineWidth = 5;
      for (let i = 0; i < 6; i++) scrawl(g, x + rnd() * w, y + h, h * 0.3, -1.57, 0.25, 4, rnd);
      // One tag. Abstract, same reasoning as the signage — and thin, because a
      // fat marker stroke at 512 px is a 4 cm line in world space and reads as
      // a paint roller rather than a spray can.
      g.strokeStyle = rgba(150, 58, 48, 0.55);
      g.lineWidth = 6;
      g.lineCap = 'round';
      for (let i = 0; i < 3; i++) scrawl(g, x + w * 0.18, y + h * (0.36 + i * 0.09), w * 0.55, 0.1, 1.5, 5, rnd);
      innerShade(g, x, y, w, h, 26, 0.5);
      break;
    }

    // ---- 6. Security grille. Painted over a dark field rather than cut out:
    // behind an opening quad is the sunlit shell face, and a true cutout would
    // show lit concrete between the bars instead of a room.
    case 'paneGrille': {
      const [x, y, w, h] = sash(g, rnd, '#6d6862');
      fill(g, x, y, w, h, '#14161a');
      vgrad(g, x, y, w, h, '#1c1f24', '#0d0f12');
      g.fillStyle = '#2f3134';
      for (let bx = x + 8; bx < x + w; bx += 34) {
        fill(g, bx + 3, y, 9, h, rgba(0, 0, 0, 0.6));
        fill(g, bx, y, 9, h, '#2f3134');
        fill(g, bx, y, 3, h, '#4a4d51');
      }
      for (const fy of [0.28, 0.72]) {
        fill(g, x, y + h * fy + 3, w, 11, rgba(0, 0, 0, 0.6));
        fill(g, x, y + h * fy, w, 11, '#3a3d41');
      }
      innerShade(g, x, y, w, h, 30, 0.6);
      break;
    }

    // ---- 7. Bricked up. Four courses, recessed behind the reveal.
    case 'paneBlocked': {
      const [x, y, w, h] = sash(g, rnd, '#7a7263');
      fill(g, x, y, w, h, '#6f675b');
      const inset = 20;
      const bx = x + inset, by = y + inset, bw = w - inset * 2, bh = h - inset * 2;
      fill(g, bx - 6, by - 6, bw + 12, bh + 12, '#3a352e');
      const rows = 4;
      for (let r = 0; r < rows; r++) {
        const rh = bh / rows;
        const cols = 2 + (r % 2);
        const off = (r % 2) * 0.5;
        for (let c = -1; c <= cols; c++) {
          const cw = bw / cols;
          const px = bx + (c + off) * cw;
          const v = 0.86 + rnd() * 0.28;
          g.fillStyle = rgba(154 * v, 143 * v, 126 * v, 1);
          g.fillRect(px + 5, by + r * rh + 5, cw - 10, rh - 10);
        }
      }
      grain(g, bx, by, bw, bh, 60, 0.22, rnd);
      innerShade(g, x, y, w, h, 36, 0.7);
      break;
    }

    // ---- 8. Shopfront glass. The street camera sits at 1.68 m and this is
    // what it looks straight into, so it gets the most content.
    case 'shopGlass': {
      const [x, y, w, h] = sash(g, rnd, '#6a625a', 20);
      fill(g, x, y, w, h, '#14171b');
      // Strip light, 22 px, 18% down — the shape that will glow at night.
      const ly = y + h * 0.18;
      const lg = g.createLinearGradient(0, ly - 26, 0, ly + 48);
      lg.addColorStop(0, rgba(223, 230, 220, 0));
      lg.addColorStop(0.35, rgba(223, 230, 220, 1));
      lg.addColorStop(0.5, rgba(223, 230, 220, 1));
      lg.addColorStop(1, rgba(140, 150, 145, 0));
      g.fillStyle = lg;
      g.fillRect(x + w * 0.10, ly - 26, w * 0.80, 74);
      fill(g, x + w * 0.10, ly, w * 0.80, 22, '#dfe6dc');
      // Counter silhouette across the lower third and a shelf behind it.
      fill(g, x, y + h * 0.66, w, h * 0.34, '#0d0f12');
      fill(g, x + w * 0.06, y + h * 0.40, w * 0.5, 10, rgba(90, 84, 72, 0.6));
      for (let i = 0; i < 7; i++) {
        const sx = x + w * (0.08 + rnd() * 0.44);
        const sh = 16 + rnd() * 26;
        g.fillStyle = rgba(120 + rnd() * 60, 108 + rnd() * 50, 88, 0.5);
        g.fillRect(sx, y + h * 0.40 - sh, 10 + rnd() * 12, sh);
      }
      // Stall bars, the vertical divisions of a shop window.
      for (const t of [0.34, 0.67]) fill(g, x + w * t - 6, y, 12, h, '#8e8577');
      // Hazy reflection of the street, upper left.
      const hz = g.createLinearGradient(x, y, x + w * 0.8, y + h * 0.7);
      hz.addColorStop(0, rgba(109, 124, 133, 0.30));
      hz.addColorStop(1, rgba(109, 124, 133, 0));
      g.fillStyle = hz; g.fillRect(x, y, w, h);
      // Dirt in the bottom 10%, because nobody washes the bottom of a window.
      const dg = g.createLinearGradient(0, y + h, 0, y + h * 0.9);
      dg.addColorStop(0, rgba(58, 52, 44, 0.85));
      dg.addColorStop(1, rgba(58, 52, 44, 0));
      g.fillStyle = dg; g.fillRect(x, y + h * 0.9, w, h * 0.1);
      innerShade(g, x, y, w, h, 30, 0.6);
      break;
    }

    // ---- 9. Shopfront shutter, down and locked.
    case 'shopShutter': {
      const [x, y, w, h] = sash(g, rnd, '#5f5a53', 20);
      for (let ry = 0; ry < h; ry += 20) {
        fill(g, x, y + ry, w, 10, '#7d838a');
        fill(g, x, y + ry + 10, w, 10, '#5c6167');
      }
      // Bottom rail and a padlock hasp, the two details that say "closed".
      fill(g, x, y + h - 44, w, 44, '#4a4f54');
      fill(g, x, y + h - 44, w, 5, rgba(255, 250, 240, 0.2));
      fill(g, x + w * 0.46, y + h - 34, w * 0.08, 24, '#2b2e31');
      const rg = g.createLinearGradient(0, y + h, 0, y + h * 0.62);
      rg.addColorStop(0, rgba(112, 72, 48, 0.95));
      rg.addColorStop(1, rgba(112, 72, 48, 0));
      g.fillStyle = rg; g.fillRect(x, y + h * 0.62, w, h * 0.38);
      g.lineCap = 'round';
      g.strokeStyle = rgba(48, 78, 120, 0.42); g.lineWidth = 8;
      for (let i = 0; i < 4; i++) scrawl(g, x + w * 0.14, y + h * (0.32 + i * 0.08), w * 0.62, 0.05, 1.7, 5, rnd);
      g.strokeStyle = rgba(190, 172, 70, 0.32); g.lineWidth = 5;
      for (let i = 0; i < 2; i++) scrawl(g, x + w * 0.24, y + h * (0.44 + i * 0.10), w * 0.45, -0.1, 1.9, 5, rnd);
      innerShade(g, x, y, w, h, 24, 0.5);
      break;
    }

    // ---- 10. Timber door, four panels.
    case 'doorTimber': {
      const [x, y, w, h] = sash(g, rnd, '#6d6558', 18);
      vgrad(g, x, y, w, h, '#6e5942', '#4c3c2c');
      grain(g, x, y, w, h, 140, 0.30, rnd);
      g.strokeStyle = rgba(38, 26, 15, 0.85);
      g.lineWidth = 9;
      const px = [0.14, 0.86], py = [0.10, 0.44, 0.52, 0.90];
      for (let r = 0; r < 2; r++) {
        const a = y + h * py[r * 2], b = y + h * py[r * 2 + 1];
        g.strokeRect(x + w * px[0], a, w * (px[1] - px[0]), b - a);
        g.fillStyle = rgba(0, 0, 0, 0.22);
        g.fillRect(x + w * px[0], a, w * (px[1] - px[0]), b - a);
        g.fillStyle = rgba(255, 245, 225, 0.10);
        g.fillRect(x + w * px[0], b - 8, w * (px[1] - px[0]), 8);
      }
      // Handle and a lock plate.
      g.fillStyle = '#4b4740';
      g.fillRect(x + w * 0.80, y + h * 0.46, 14, 46);
      g.beginPath(); g.arc(x + w * 0.80 + 7, y + h * 0.46, 13, 0, 6.2832); g.fill();
      innerShade(g, x, y, w, h, 26, 0.6);
      break;
    }

    // ---- 11. Steel door, riveted, kick plate.
    case 'doorMetal': {
      const [x, y, w, h] = sash(g, rnd, '#6b6862', 18);
      vgrad(g, x, y, w, h, '#5c6266', '#3d4245');
      grain(g, x, y, w, h, 60, 0.16, rnd);
      // Rivets only round the perimeter, which is where a fabricator puts them.
      for (let ry = y + 22; ry < y + h - 10; ry += 54) {
        for (const rx of [x + 20, x + w - 20]) {
          g.fillStyle = rgba(30, 32, 34, 0.7);
          g.beginPath(); g.arc(rx + 2, ry + 2, 5, 0, 6.2832); g.fill();
          g.fillStyle = rgba(150, 156, 160, 0.7);
          g.beginPath(); g.arc(rx, ry, 4, 0, 6.2832); g.fill();
        }
      }
      const rg = g.createLinearGradient(0, y + h, 0, y + h * 0.55);
      rg.addColorStop(0, rgba(112, 72, 46, 0.55));
      rg.addColorStop(1, rgba(112, 72, 46, 0));
      g.fillStyle = rg; g.fillRect(x, y + h * 0.55, w, h * 0.45);
      // Kick plate goes on last: it is the newest thing on the door.
      fill(g, x, y + h * 0.80, w, h * 0.20, '#6a6f72');
      fill(g, x, y + h * 0.80, w, 5, rgba(255, 250, 240, 0.25));
      grain(g, x, y + h * 0.80, w, h * 0.20, 30, 0.22, rnd);
      g.fillStyle = '#2c2f31';
      g.fillRect(x + w * 0.82, y + h * 0.48, 13, 52);
      innerShade(g, x, y, w, h, 24, 0.55);
      break;
    }

    // ---- 12. Fascia sign board.
    case 'signBoard': {
      fill(g, 0, 0, CELL, CELL, '#b28a4a');
      vgrad(g, 0, 0, CELL, CELL, 'rgba(255,240,205,0.22)', 'rgba(40,26,8,0.30)');
      grain(g, 0, 0, CELL, CELL, 70, 0.16, rnd);
      g.lineWidth = 18;
      g.strokeStyle = '#4d3c20';
      g.strokeRect(9, 9, CELL - 18, CELL - 18);
      calligraphy(g, 52, CELL * 0.18, CELL - 104, CELL * 0.64, '#241d12', rnd, 7);
      // Sun bleach on the upper half, weather run on the lower.
      const bl = g.createLinearGradient(0, 0, 0, CELL);
      bl.addColorStop(0, rgba(255, 248, 228, 0.18));
      bl.addColorStop(0.6, rgba(255, 248, 228, 0));
      bl.addColorStop(1, rgba(46, 34, 18, 0.28));
      g.fillStyle = bl; g.fillRect(0, 0, CELL, CELL);
      break;
    }

    // ---- 13. Hanging sign, seen from both sides so it stays legible edge-on.
    case 'signHanging': {
      fill(g, 0, 0, CELL, CELL, '#2f4b52');
      vgrad(g, 0, 0, CELL, CELL, 'rgba(190,225,230,0.16)', 'rgba(8,18,20,0.40)');
      g.lineWidth = 14;
      g.strokeStyle = '#c6b184';
      g.strokeRect(16, 16, CELL - 32, CELL - 32);
      calligraphy(g, 60, CELL * 0.22, CELL - 120, CELL * 0.56, '#e2d6b4', rnd, 5);
      g.fillStyle = rgba(198, 177, 132, 0.9);
      for (const t of [0.24, 0.76]) { g.beginPath(); g.arc(CELL * t, 34, 12, 0, 6.2832); g.fill(); }
      grain(g, 0, 0, CELL, CELL, 50, 0.20, rnd);
      break;
    }

    // ---- 14. Louvred vent.
    case 'ventLouvre': {
      const [x, y, w, h] = sash(g, rnd, '#6e6a63', 22);
      fill(g, x, y, w, h, '#101214');
      const n = 11;
      for (let i = 0; i < n; i++) {
        const sy = y + (h * i) / n;
        const sh = h / n;
        fill(g, x, sy, w, sh * 0.62, '#8b8f92');
        fill(g, x, sy + sh * 0.62, w, sh * 0.38, '#1a1d20');
        fill(g, x, sy, w, 3, rgba(255, 250, 240, 0.30));
      }
      const rg = g.createLinearGradient(0, y + h, 0, y + h * 0.5);
      rg.addColorStop(0, rgba(104, 70, 48, 0.75));
      rg.addColorStop(1, rgba(104, 70, 48, 0));
      g.fillStyle = rg; g.fillRect(x, y + h * 0.5, w, h * 0.5);
      innerShade(g, x, y, w, h, 24, 0.6);
      break;
    }

    // ---- 15. The only true cutout: a balustrade against the sky, used as the
    // >34 m substitute for real balcony railings.
    case 'railingLace': {
      g.clearRect(0, 0, CELL, CELL);
      g.fillStyle = '#26282a';
      // Top and bottom rails.
      g.fillRect(0, 26, CELL, 26);
      g.fillRect(0, CELL - 46, CELL, 30);
      g.fillRect(0, CELL - 16, CELL, 16);
      for (let bx = 12; bx < CELL; bx += 46) {
        g.fillRect(bx, 44, 22, CELL - 88);
        // A slight swell at mid-height so it is not a picket fence.
        g.fillRect(bx - 5, CELL * 0.46, 32, 26);
      }
      // Newel posts at both ends.
      g.fillRect(0, 8, 30, CELL - 16);
      g.fillRect(CELL - 30, 8, 30, CELL - 16);
      break;
    }

    default:
      fill(g, 0, 0, CELL, CELL, '#4a4a4a');
  }
}

// -------------------------------------------------------------------- atlas

export function buildFacadeAtlas(seed = 1) {
  let a = (seed | 0) || 11;
  const rnd = () => {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = Math.imul(a ^ (a >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(SIZE, SIZE)
    : (typeof document !== 'undefined'
      ? Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE })
      : null);
  const g = canvas && canvas.getContext('2d');
  if (!g) return null;
  g.clearRect(0, 0, SIZE, SIZE);

  const uv = {};
  for (let i = 0; i < PANE_KEYS.length; i++) {
    const name = PANE_KEYS[i];
    const col = i % CELLS, row = (i / CELLS) | 0;
    g.save();
    g.translate(col * CELL, row * CELL);
    g.beginPath();
    g.rect(0, 0, CELL, CELL);
    g.clip();
    drawCell(g, name, rnd);
    g.restore();
    // The content rect is the whole cell inset by half the pad: the paint runs
    // out under the gutter so the mip chain has opaque colour to average with,
    // and the UVs never reach the neighbouring cell.
    const u0 = (col * CELL + PAD * 0.5) / SIZE;
    const v0 = (row * CELL + PAD * 0.5) / SIZE;
    const u1 = (col * CELL + CELL - PAD * 0.5) / SIZE;
    const v1 = (row * CELL + CELL - PAD * 0.5) / SIZE;
    uv[name] = [u0, 1 - v1, u1, 1 - v0];    // canvas Y runs down, texture V up
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'facadeAtlas';
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

/** Unit quad in the XY plane facing +Z, UV-mapped to one atlas cell. */
function quadFor(uv, flipU) {
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  const at = geo.attributes.uv;
  const [u0, v0, u1, v1] = uv;
  for (let i = 0; i < at.count; i++) {
    const u = flipU ? 1 - at.getX(i) : at.getX(i);
    at.setXY(i, u0 + (u1 - u0) * u, v0 + (v1 - v0) * at.getY(i));
  }
  at.needsUpdate = true;
  return geo;
}

/**
 * The pane pool, mirroring `DecalKit`.
 *
 * `overrides(emissive)` is the whole contract with props-core: the caller
 * writes it into `env.envOverrides.win` / `.winLit` and the two BatchSets build
 * one bucket each, so every opening on the map costs two draws in total.
 */
export class FacadeAtlas {
  constructor(seed = 0xfacade) {
    const atlas = buildFacadeAtlas(seed);
    this.texture = atlas ? atlas.texture : null;
    this.uv = atlas ? atlas.uv : {};
    /** @type {Record<string, THREE.BufferGeometry[]>} */
    this.quads = {};
    for (const k of PANE_KEYS) {
      if (!this.uv[k]) continue;
      this.quads[k] = [quadFor(this.uv[k], false), quadFor(this.uv[k], true)];
    }
  }

  /** A quad for `kind`, mirrored at random so a wall of panes is not wallpaper. */
  geo(kind, rand) {
    const list = this.quads[kind];
    if (!list) return null;
    return list[rand && rand() < 0.5 ? 1 : 0];
  }

  has(kind) { return !!this.quads[kind]; }

  /**
   * Material overrides for the glazing bucket.
   *
   * `gun_polymer` rather than `metal_painted` for the same two reasons
   * decals.js picked it: it is the only non-metal key with `pom: 0`, so a
   * parallax march cannot walk the sample point out of one atlas cell and into
   * the next, and it has `grime: 0` / `macro: 0`, so the shader does not smear
   * concrete weathering over a painted interior. It is already a
   * `MeshPhysicalMaterial`, so the clearcoat below is real.
   *
   * Opaque and depth-writing on purpose: a hundred alpha-blended panes stacked
   * down a street is the single most expensive thing this renderer could be
   * asked to draw, and none of these cells needs a soft edge.
   *
   * MEASURED, and the two numbers here are not taste:
   *
   * - `clearcoat: 0`. The brief asked for 0.55 so the sky reflection would come
   *   from coat Fresnel. It does look better — and it costs TWO shader programs
   *   against a 59-of-60 budget, because `USE_CLEARCOAT` forks the permutation
   *   away from the one `decalHard` already compiled for this exact key. At
   *   zero, both glazing buckets land on that existing program and the whole
   *   atlas costs no programs at all. The sky is still there, off the base
   *   specular lobe against the same PMREM env map, and still tracks time of
   *   day; it is broader and softer, which is the price.
   *
   * - `roughness: 0.68`, `specularIntensity: 0.20`, `envMapIntensity: 0.26`.
   *   The brief asked for 0.30 / default / 1.15 and that combination failed its
   *   own acceptance test, which is why these were tuned against a measurement
   *   rather than by eye. Two separate faults, both only visible at 4x:
   *
   *   `gun_polymer` carries `detail: [6, 0.4]`, a procedural detail normal
   *   sampled at `codUv * 6`. `codUv` here is the atlas UV, so six tiles of
   *   weapon-grip diamond checkering land across the atlas, about one and a
   *   half per cell — and `normalScale: 0` does NOT touch it, because the
   *   detail path multiplies by `codSurface.y`, not by the normal scale. At
   *   0.30 roughness that checkering was legible across every pane on the
   *   sunlit wall.
   *
   *   And a pane at 0.30 roughness with a full-strength dielectric F90, seen
   *   down the street at a grazing angle, throws a sheet of grazing sheen. On
   *   the sunlit facade in `street` it measured luminance 192 against 218 for
   *   the plaster beside it — the two were the same surface. The isolating
   *   experiment: forcing the pane to `color 0x000000` with no env and no
   *   specular renders it at 100 in that same spot, which is the aerial
   *   perspective floor and means the brief's "pane <= 0.18x wall" can never
   *   be met there by any material. The number to move is the material's
   *   contribution ABOVE that floor, and these three values take it from 92 of
   *   the available 118 down to 59. Pushing further starts turning the shaded
   *   facades — where the panes were already correct — into flat black holes.
   */
  overrides(emissive = false) {
    const o = {
      map: this.texture,
      alphaTest: 0.5,
      transparent: false,
      depthWrite: true,
      normalScale: 0,
      metalness: 0,
      roughness: 0.68,
      clearcoat: 0,
      specularIntensity: 0.20,
      envMapIntensity: 0.26,
      vertexColors: true,
      side: THREE.FrontSide,
    };
    if (emissive) {
      // Albedo doubles as the emissive map, which is exactly right: the pane
      // field is near-black so it barely emits, while the curtain and the
      // shopfront strip light glow. The spill is correctly shaped for free.
      o.emissiveMap = this.texture;
      o.emissive = new THREE.Color(0xffd2a0);
      o.emissiveIntensity = 0;
    }
    return o;
  }
}

export const FACADE_ATLAS_KEY = 'gun_polymer';
