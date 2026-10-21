#!/usr/bin/env node
/**
 * Contact sheet builder — tiles every PNG in a directory into one labelled
 * image so a whole render pass can be reviewed in a single look instead of ten.
 *
 *   node tools/contact.mjs --dir shots/integrated --out shots/integrated_sheet.png --cols 3
 *
 * Reviewing ten 1920x1080 frames one at a time is expensive; a sheet catches
 * cross-shot problems (inconsistent exposure, a grade that only works at noon)
 * that per-shot review misses.
 */
import { chromium } from 'playwright';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const mime = (p) => (/\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png');

async function main() {
  const dir = path.resolve(ROOT, arg('dir', 'shots'));
  const out = path.resolve(ROOT, arg('out', path.join(dir, '_sheet.png')));
  const cols = parseInt(arg('cols', '3'), 10);
  const cellW = parseInt(arg('cellw', '760'), 10);

  const files = (await readdir(dir))
    .filter((f) => /\.(png|jpe?g)$/i.test(f) && !f.startsWith('_'))
    .sort();

  if (!files.length) {
    console.error(JSON.stringify({ ok: false, error: `no images in ${dir}` }));
    process.exit(1);
  }

  const items = [];
  for (const f of files) {
    const buf = await readFile(path.join(dir, f));
    items.push({ name: path.parse(f).name, url: `data:${mime(f)};base64,${buf.toString('base64')}` });
  }

  await mkdir(path.dirname(out), { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
  const page = await browser.newPage({ viewport: { width: 100, height: 100 } });

  const size = await page.evaluate(
    async ({ items, cols, cellW, title }) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = src;
        });
      const imgs = await Promise.all(items.map((i) => load(i.url)));

      const pad = 14;
      const bar = 28;
      const titleH = 44;
      const rows = Math.ceil(imgs.length / cols);
      // Uniform cell height from the tallest aspect keeps the grid aligned.
      const cellH = Math.round(Math.max(...imgs.map((im) => (im.height / im.width) * cellW)));

      const W = cols * cellW + (cols + 1) * pad;
      const H = titleH + rows * (cellH + bar) + (rows + 1) * pad;

      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#0d0d0f';
      g.fillRect(0, 0, W, H);
      g.textBaseline = 'middle';
      g.fillStyle = '#e8e8ea';
      g.font = '600 22px system-ui, -apple-system, sans-serif';
      g.fillText(title, pad, titleH / 2);

      imgs.forEach((im, i) => {
        const cx = i % cols;
        const cy = Math.floor(i / cols);
        const x = pad + cx * (cellW + pad);
        const y = titleH + pad + cy * (cellH + bar + pad);
        g.fillStyle = '#c8c8ce';
        g.font = '600 16px system-ui, -apple-system, sans-serif';
        g.fillText(items[i].name, x + 2, y + bar / 2);
        const h = Math.round((im.height / im.width) * cellW);
        g.drawImage(im, x, y + bar, cellW, h);
        g.strokeStyle = '#33333a';
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + bar + 0.5, cellW - 1, h - 1);
      });

      document.body.style.margin = '0';
      document.body.appendChild(c);
      return { W, H };
    },
    { items, cols, cellW, title: path.relative(ROOT, dir) }
  );

  await page.setViewportSize({ width: Math.min(size.W, 4000), height: Math.min(size.H, 8000) });
  await page.locator('canvas').screenshot({ path: out });
  await browser.close();
  console.log(JSON.stringify({ ok: true, out, count: items.length, size }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
