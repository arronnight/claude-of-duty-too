#!/usr/bin/env node
/**
 * Boot the game headless on the real GPU and run arbitrary JS inside it.
 *
 *   node tools/probe.mjs --port 5350 --file scratch/audit.js
 *   node tools/probe.mjs --eval "return Object.keys(window.__COD__)"
 *
 * The screenshot harness answers "what does it look like"; this answers
 * "what is actually in the ctx / how many draw calls / did that hook survive",
 * which otherwise degenerates into guessing. The evaluated source is wrapped in
 * an async function body, so `return` works and `await` is available.
 *
 * Options:
 *   --port      dev server port (default 5173; started if not already up)
 *   --eval      JS source to evaluate (async function body)
 *   --file      path to a file containing that source instead
 *   --warmup    ms to wait after __READY__ before evaluating (default 6000)
 *   --shot      write a PNG here after evaluating (implies a settle wait)
 *   --settle    ms between the eval and the screenshot (default 1600)
 *   --w/--h     viewport (default 1600x900)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const PORT = parseInt(arg('port', '5173'), 10);
const URL = `http://localhost:${PORT}/`;
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const WARMUP_MS = parseInt(arg('warmup', '6000'), 10);
const SETTLE_MS = parseInt(arg('settle', '1600'), 10);

async function waitForServer(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const src = arg('file') ? await readFile(path.resolve(ROOT, arg('file')), 'utf8') : arg('eval', 'return null');

let server = null;
if (!(await waitForServer(URL, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  if (!(await waitForServer(URL, 45000))) {
    console.error(JSON.stringify({ ok: false, error: 'dev server failed to start' }));
    process.exit(1);
  }
}

const browser = await chromium.launch({
  headless: !flag('headed'),
  args: [
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--disable-gpu-driver-bug-workarounds',
    '--enable-webgl-draft-extensions', '--force-device-scale-factor=1',
    '--hide-scrollbars', '--mute-audio',
    // Lets a probe exercise the audio graph without faking a gesture. The
    // screenshot harness deliberately does NOT set this: "must not throw
    // before a user gesture" is part of the audio contract and is only
    // actually tested if the harness runs without one.
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const out = { ok: true, errors };
try {
  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForFunction('window.__READY__ === true', { timeout: 60000 });
  await page.waitForTimeout(WARMUP_MS);
  await page.evaluate(() => document.getElementById('debug-overlay')?.style.setProperty('display', 'none'));
  out.result = await page.evaluate(`(async () => { ${src} })()`);
  if (arg('shot')) {
    const p = path.resolve(ROOT, arg('shot'));
    await mkdir(path.dirname(p), { recursive: true });
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: p, type: 'png' });
    out.shot = p;
  }
} catch (e) {
  out.ok = false;
  out.error = `${e.message}`;
}
out.errors = errors.slice(0, 40);
await browser.close();
if (server) server.kill();
console.log(JSON.stringify(out, null, 2));
