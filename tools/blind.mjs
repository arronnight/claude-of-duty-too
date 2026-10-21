#!/usr/bin/env node
/**
 * Blind side-by-side comparison sheet builder.
 *
 *   node tools/blind.mjs --a shots/integrated/street.png --b refs/cod_street.jpg \
 *                        --out blind/street --label "eye-level street"
 *
 * Composites the two frames into a single sheet with the panels randomly ordered
 * and labelled only "LEFT" / "RIGHT", writes the sheet to <out>.png, and writes
 * the answer key to <out>.key.json. A critic agent is shown ONLY the sheet, so
 * its verdict cannot be biased by knowing which frame is ours.
 *
 * Ordering is derived from a hash of the output name, not a RNG, so re-running
 * the same comparison is reproducible while different shots shuffle differently.
 * Pass --salt to reshuffle.
 *
 * Compositing runs inside Chromium (canvas), so this needs no image library.
 */
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const mime = (p) => (/\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.webp$/i.test(p) ? 'image/webp' : 'image/png');

async function dataUrl(p) {
  const buf = await readFile(p);
  return `data:${mime(p)};base64,${buf.toString('base64')}`;
}

async function main() {
  const aPath = path.resolve(ROOT, arg('a', ''));
  const bPath = path.resolve(ROOT, arg('b', ''));
  const outBase = path.resolve(ROOT, arg('out', 'blind/sheet'));
  const label = arg('label', '');
  const salt = arg('salt', '');
  const layout = arg('layout', 'side'); // side | stack
  // 'native' (the default) resolves to the SMALLER of the two source widths, so
  // whichever panel is already at that width is not resampled at all and the
  // other is only ever downsampled. The references are 1920x1080 press frames;
  // render the judged shots at 1920x1080 (`tools/shoot.mjs` defaults to it) and
  // this comes out at 1920 and neither panel is touched. The old fixed 1100
  // downsampled BOTH panels by 1.75x before a critic ever saw them, which threw
  // away exactly the fine surface read the comparison is supposed to be about —
  // methodologically clean, but it made the test insensitive.
  const panelWArg = arg('panelw', 'native');
  // Both panels are resampled to the same width and then round-tripped through
  // JPEG at the same quality before compositing. Without this the blind test
  // leaks: the references are JPEG press images and our frames are PNG, so the
  // reference panel carries ringing and 8x8 blocking that our panel does not,
  // and a critic that notices compression artefacts has identified the panels
  // without judging a single pixel of render quality. Matching the codec on
  // both sides removes the tell. --jpegq 0 disables the round-trip.
  const jpegQ = parseFloat(arg('jpegq', '0.92'));

  for (const [name, p] of [['a', aPath], ['b', bPath]]) {
    if (!p || !existsSync(p)) {
      console.error(JSON.stringify({ ok: false, error: `--${name} not found: ${p}` }));
      process.exit(1);
    }
  }

  await mkdir(path.dirname(outBase), { recursive: true });

  // Optional source crops, "x,y,w,h" in source pixels. Used to pull an
  // environment-only region out of a reference frame whose foreground is a
  // character, so the comparison stays environment-vs-environment.
  const parseCrop = (s) => {
    if (!s) return null;
    const p = s.split(',').map((n) => parseFloat(n));
    return p.length === 4 && p.every(Number.isFinite) ? { x: p[0], y: p[1], w: p[2], h: p[3] } : null;
  };
  const aCrop = parseCrop(arg('acrop', ''));
  const bCrop = parseCrop(arg('bcrop', ''));

  // Panel order. It has to be reproducible (so a scored result can be audited)
  // AND it has to move between runs (so a critic scoring ten sheets cannot
  // learn "ours is the left one on street" and carry that across the set).
  // Those pull against each other, so: one --seed per RUN, mixed with the sheet
  // name, and the resolved seed written into the key. Same seed -> same sheet,
  // byte for byte; new seed -> a fresh permutation of all ten.
  const seed = arg('seed', '') || salt || 'default';
  const shuffleKey = `${path.basename(outBase)}|${seed}`;
  const shuffleHash = hash32(shuffleKey);
  const swap = (shuffleHash & 1) === 1;
  const leftPath = swap ? bPath : aPath;
  const rightPath = swap ? aPath : bPath;
  const leftCrop = swap ? bCrop : aCrop;
  const rightCrop = swap ? aCrop : bCrop;

  const [leftUrl, rightUrl] = await Promise.all([dataUrl(leftPath), dataUrl(rightPath)]);

  const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
  const page = await browser.newPage({ viewport: { width: 100, height: 100 } });

  const size = await page.evaluate(
    async ({ leftUrl, rightUrl, label, layout, panelWArg, leftCrop, rightCrop, jpegQ }) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = src;
        });
      const [Lsrc, Rsrc] = await Promise.all([load(leftUrl), load(rightUrl)]);
      const srcDims = {
        left: [Lsrc.width, Lsrc.height],
        right: [Rsrc.width, Rsrc.height],
      };

      // Bake any crop into an offscreen canvas so the rest of the layout code
      // only ever deals with whole images.
      const applyCrop = (img, crop) => {
        if (!crop) return img;
        const x = Math.max(0, Math.min(img.width, crop.x));
        const y = Math.max(0, Math.min(img.height, crop.y));
        const w = Math.max(1, Math.min(img.width - x, crop.w));
        const h = Math.max(1, Math.min(img.height - y, crop.h));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
        return c;
      };
      // Resample to the final panel width and round-trip through JPEG, both
      // panels identically. Doing the resample here rather than at draw time
      // matters too: our frames and the references are authored at different
      // resolutions, so letting drawImage scale them by different ratios left
      // one panel visibly crisper than the other for reasons that had nothing
      // to do with render quality.
      const normalise = async (img, q) => {
        const w = panelW;
        const h = Math.max(1, Math.round((img.height / img.width) * panelW));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cg = c.getContext('2d');
        cg.imageSmoothingEnabled = true;
        cg.imageSmoothingQuality = 'high';
        cg.drawImage(img, 0, 0, w, h);
        if (!(q > 0)) return c;
        return await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = c.toDataURL('image/jpeg', q);
        });
      };

      const Lc = applyCrop(Lsrc, leftCrop);
      const Rc = applyCrop(Rsrc, rightCrop);
      // Resolve 'native' AFTER cropping, against what is actually going to be
      // drawn: the smaller of the two, so nothing is ever upsampled.
      const panelW = panelWArg === 'native'
        ? Math.min(Lc.width, Rc.width)
        : parseInt(panelWArg, 10);
      const resampled = {
        left: +(panelW / Lc.width).toFixed(4),
        right: +(panelW / Rc.width).toFixed(4),
      };
      const aspect = {
        left: +(Lc.width / Lc.height).toFixed(4),
        right: +(Rc.width / Rc.height).toFixed(4),
      };

      const [L, R] = await Promise.all([
        normalise(Lc, jpegQ),
        normalise(Rc, jpegQ),
      ]);

      const lh = Math.round((L.height / L.width) * panelW);
      const rh = Math.round((R.height / R.width) * panelW);
      const pad = 18;
      const bar = 46;
      const titleH = label ? 54 : 0;

      let W, H;
      if (layout === 'stack') {
        W = panelW + pad * 2;
        H = titleH + pad + bar + lh + pad + bar + rh + pad;
      } else {
        W = panelW * 2 + pad * 3;
        H = titleH + pad + bar + Math.max(lh, rh) + pad;
      }

      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#101012';
      g.fillRect(0, 0, W, H);

      g.textBaseline = 'middle';
      if (label) {
        g.fillStyle = '#e8e8ea';
        g.font = '600 26px system-ui, -apple-system, sans-serif';
        g.textAlign = 'center';
        g.fillText(label, W / 2, titleH / 2 + 6);
      }

      const drawPanel = (img, x, y, w, h, tag) => {
        g.fillStyle = '#e8e8ea';
        g.font = '700 22px system-ui, -apple-system, sans-serif';
        g.textAlign = 'left';
        g.fillText(tag, x + 2, y + 22);
        g.drawImage(img, x, y + 34, w, h);
        g.strokeStyle = '#3a3a40';
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 34.5, w - 1, h - 1);
      };

      if (layout === 'stack') {
        drawPanel(L, pad, titleH + pad, panelW, lh, 'LEFT');
        drawPanel(R, pad, titleH + pad + bar + lh + pad, panelW, rh, 'RIGHT');
      } else {
        drawPanel(L, pad, titleH + pad, panelW, lh, 'LEFT');
        drawPanel(R, pad * 2 + panelW, titleH + pad, panelW, rh, 'RIGHT');
      }

      document.body.style.margin = '0';
      document.body.appendChild(c);
      return { W, H, panelW, srcDims, resampled, aspect };
    },
    { leftUrl, rightUrl, label, layout, panelWArg, leftCrop, rightCrop, jpegQ }
  );

  await page.setViewportSize({ width: size.W, height: size.H });
  const sheet = `${outBase}.png`;
  await page.locator('canvas').screenshot({ path: sheet });
  await browser.close();

  const key = {
    sheet,
    label,
    LEFT: path.relative(ROOT, leftPath),
    RIGHT: path.relative(ROOT, rightPath),
    ours: swap ? 'RIGHT' : 'LEFT',
    reference: swap ? 'LEFT' : 'RIGHT',
    a: path.relative(ROOT, aPath),
    b: path.relative(ROOT, bPath),
    aCrop,
    bCrop,
    // Everything needed to reproduce this exact sheet, and everything a later
    // reader needs to decide whether the trial was clean. A score collected off
    // a sheet whose `resampled` are not 1 and 1 is a score with a known tell in
    // it; record it rather than discovering it after the fact.
    seed,
    shuffleKey,
    shuffleHash,
    swap,
    panelW: size.panelW,
    sourceDims: size.srcDims,
    resampleFactor: size.resampled,
    sourceAspect: size.aspect,
    jpegQ,
    clean:
      size.resampled.left === 1 && size.resampled.right === 1 &&
      Math.abs(size.aspect.left - size.aspect.right) < 0.002 &&
      jpegQ > 0,
  };
  await writeFile(`${outBase}.key.json`, JSON.stringify(key, null, 2));

  // Print the sheet path and the sheet's own size ONLY. Everything per-panel —
  // source dimensions, resample factor, aspect — stays in the key file, because
  // any of them differing between LEFT and RIGHT would tell a critic reading
  // this stdout which panel came from our renderer.
  console.log(JSON.stringify({
    ok: true, sheet, size: { W: size.W, H: size.H }, panelW: size.panelW, clean: key.clean,
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
