#!/usr/bin/env node
/**
 * Deterministic screenshot harness for the visual-critic loop.
 *
 *   node tools/shoot.mjs [--out dir] [--shots a,b,c] [--w 1920] [--h 1080] [--headed]
 *                        [--static] [--checks] [--port N]
 *
 * Boots the dev server if it is not already up, drives the game to a fixed set
 * of camera presets via window.__COD__, and writes one PNG per preset. Every
 * shot is taken from the same seed/time-of-day so successive runs are
 * pixel-comparable and a critic can judge changes rather than noise.
 *
 *   --shots judged   the ten presets the blind A/B is fought with (the default)
 *   --shots read     the 5 / 30 / 80 m facade instruments
 *   --shots all      everything, including `sunset`
 *   --static         serve the BUILT dist via `vite preview` instead of the dev
 *                    server, so a concurrent edit cannot HMR-reload mid-capture
 *   --checks         also compute the numeric acceptance criteria from the PNGs
 *
 * JUDGE AT 1920x1080. Every frame in refs/ is 1920x1080; anything else has to be
 * resampled to sit beside one, and the panel that gets resampled is identifiable
 * as the one that got resampled. The defaults here are already 1920x1080 and the
 * report carries `judgeNative` so a smaller iteration pass cannot be mistaken
 * for a scoreable one.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const OUT = path.resolve(ROOT, arg('out', 'shots'));
const W = parseInt(arg('w', '1920'), 10);
const H = parseInt(arg('h', '1080'), 10);
const PORT = parseInt(arg('port', '5173'), 10);
const URL = `http://localhost:${PORT}/`;
const WARMUP_MS = parseInt(arg('warmup', '6000'), 10);
const SETTLE_MS = parseInt(arg('settle', '1600'), 10);
const CHECK = flag('checks');

/**
 * Camera presets. Each exercises a different part of the renderer so a critic
 * can catch a regression in one area without re-reviewing everything.
 *   pos/look are world-space; tod is 0..1 time of day.
 */
export const SHOTS = {
  // Elevated three-quarter view down the street. The old [26, 9.5, 34] sat behind
  // the east block row and framed a brick wall — it was authored against the
  // scaffold's scattered-boxes placeholder, not the street layout that replaced it.
  establishing:  { pos: [4, 17, 33],    look: [-1, 1.5, -20], fov: 60, tod: 0.32, desc: 'Wide establishing shot of the whole map' },
  street:        { pos: [2.2, 1.68, 22], look: [1, 1.5, -10], fov: 70, tod: 0.32, desc: 'Eye-level down the main street, player POV' },
  interior:      { pos: [-11, 1.7, -6],  look: [4, 1.4, -3],  fov: 70, tod: 0.32, desc: 'Interior lighting, bounce and contact shadows' },
  weapon:        { pos: [2.2, 1.68, 14], look: [2.2, 1.6, 0], fov: 70, tod: 0.32, desc: 'Viewmodel hip-fire framing', viewmodel: true },
  ads:           { pos: [2.2, 1.68, 14], look: [2.2, 1.6, 0], fov: 45, tod: 0.32, desc: 'Aim-down-sights framing', viewmodel: true, ads: true },
  // The old [-4,1.5,-18] -> [-4,1.4,-26] looked straight down the corridor and
  // put the north terminator backdrop — a flat, untextured, blown-out card at
  // 56 m — across the middle third of a frame whose entire job is close surface
  // read. A shot named 'materials' containing no material is exactly the
  // brick-wall failure this preset list keeps repeating. Now: the west facade
  // base at 6 m, three-quarter on, so the frame carries paver setts, the kerb
  // step, the plinth and the damp band at the wall foot in one read.
  materials:     { pos: [-5.4, 1.35, 9.5], look: [-11.4, 0.75, 3.5], fov: 55, tod: 0.32, desc: 'Close-up on wall/ground material detail' },
  // tod 0.76 is ~30 min before the ephemeris sunset at 0.781, i.e. the sun a few
  // degrees up. The preset used to say 0.09, which under the contract's anchors
  // (0 = midnight, 0.5 = noon) is 02:10 — full night, and it was rendering as a
  // moonlit pre-dawn while being reviewed as a golden-hour shot.
  // Ground level rather than sharing the establishing camera: the point of this
  // shot is shadows raking the length of the street, which only reads from down in it.
  // The old aim ([4.5,1.75,18] -> [-2,2.2,-16]) put a hanging laundry sheet 3 m
  // from the lens across the top third and pointed the eye line at the kerb, so
  // the frame was a bedsheet over a black road. Raised to 2.6 and pulled back to
  // z=26 so the corridor vanishing point sits on the upper third line and the
  // raking light on the east facade carries the frame.
  // The sun is NOT in this frame and cannot be: see `sunset` below for why.
  goldenhour:    { pos: [4.5, 2.6, 26],  look: [-1.5, 6.0, -60], fov: 62, tod: 0.76, desc: 'Low-sun golden hour, long shadows, volumetrics' },
  night:         { pos: [2.2, 1.68, 22], look: [1, 1.5, -10], fov: 70, tod: 0.85, desc: 'Night lighting, artificial lights, bloom' },
  // look.y was 14 against a camera at 2.0: that is 21 degrees of pitch, which
  // with a 65 vfov left the cloud deck clipped off the top and filled the frame
  // with street. A shot named 'skyline' has to be mostly sky.
  skyline:       { pos: [8, 2.0, 30],    look: [-6, 20, -34], fov: 70, tod: 0.32, desc: 'Sky, clouds, aerial perspective' },
  combat:        { pos: [6, 1.7, 6],     look: [-8, 1.6, -12], fov: 70, tod: 0.32, desc: 'Combat framing with AI and FX', viewmodel: true, action: true },

  // ------------------------------------------------------------------ read distance
  // Three measurement cameras on ONE facade — the dressed west block front at
  // x = -11.4, z = 4..20 — at 5, 30 and 80 m. They are instruments, not
  // compositions: the facade spec is written in terms of what survives at each
  // of those ranges, and until you can put the same wall at all three you are
  // reviewing detail you cannot see and missing silhouette you can.
  //
  // WHY fov 36 AND NOT 60. `fov` is three.js's VERTICAL fov. At 16:9 a vertical
  // 36 gives a horizontal 60.0 degrees, which is the framing the spec's px/m
  // arithmetic assumes. Rendered 1920 wide that is
  //     px per metre = 1920 / (2 d tan 30) = 1662.8 / d
  // i.e. 332 px/m at 5 m, 57 px/m at 30 m, 21 px/m at 80 m; one pixel is
  // 3.0 mm, 1.75 cm and 4.8 cm respectively. Anything authored thinner than
  // 4.8 cm is sub-pixel in READ80 and is TAA's problem, not the mesh's.
  // These three do NOT go in the judged set — the A/B is fought at the game's
  // own fov — so they are excluded from `--shots judged`.
  // 4.8 m PERPENDICULAR to the wall plane at x = -11.4 (6.4 m slant to the aim
  // point) and deliberately 38 degrees off the wall normal, because the test the
  // spec actually states — "the far jamb partly hiding the pane" — is an
  // obliquity test and is unfalsifiable head-on.
  // HONEST LIMIT: at 5 m and hfov 60 the frame is 5.8 x 3.2 m, so a first-floor
  // reveal and the damp band at the wall foot CANNOT both be in it. This camera
  // takes the reveal, cill undercut, glazing bars and balcony soffit; the wall
  // base, plinth cap, rustication and damp band are what the re-aimed
  // `materials` preset is now pointed at, from 6 m. Read the pair, not one.
  read5:  { pos: [-6.6, 2.20, 15.6], look: [-11.4, 5.20, 11.6], fov: 36, tod: 0.32,
            desc: 'READ 5 m: reveal depth, far-jamb occlusion, cill undercut, glazing bars' },
  read30: { pos: [9.6, 2.10, 33],    look: [-11.4, 6.40, 14],   fov: 36, tod: 0.32,
            desc: 'READ 30 m: floor lines, opening grid, glazing bars, balcony break, cornice shade' },
  // 77 m slant, and ELEVATED to 9 m on purpose. The obvious street-level aim
  // puts the target building against the north terminator backdrop, which is a
  // blank untextured card — you end up grading our silhouette against our own
  // matte instead of against sky, which is not the mw3_04 test. From 9 m the
  // far east block row breaks the horizon and the silhouette is readable.
  read80: { pos: [-1.0, 9.00, 46],   look: [11.4, 12.0, -30],   fov: 36, tod: 0.32,
            desc: 'READ 80 m: silhouette and the low-frequency dark-dot rhythm (the mw3_04 test)' },

  // The mw3_07 composition, kept OUT of the judged ten and kept on file.
  // MEASURED, and it contradicts the brief: at tod 0.76 the sun sits at azimuth
  // -77.8 deg, elevation 6.7 deg (probed off ctx.sky.sunDirection). The street
  // runs along Z and is walled to +-11.4 m in X, so the sun's whole arc is
  // BROADSIDE to the corridor — it is never above the north terminator at
  // z = -74 and it cannot be composed into any street-level frame on this map.
  // A 6.7 deg sun only clears a 14.4 m parapet from above it, so: east block
  // roof, looking WSW down the sun line. This is the strongest single frame the
  // project can currently produce and the reason it is not in JUDGED is that it
  // shows no street; promoting it is a composition call for the next wave.
  sunset: { pos: [17.5, 17.8, 6],    look: [-40, 21.5, 17],     fov: 62, tod: 0.76,
            desc: 'Sun disc above the roofline, silhouette across it, hazed planes behind (mw3_07)' },
};

/**
 * The ten presets a critic is shown. The read-distance cameras and any future
 * instrument are deliberately not in here: they use a non-game fov, so putting
 * one in a blind sheet next to a real CoD frame would lose on framing alone.
 */
export const JUDGED = [
  'establishing', 'street', 'interior', 'weapon', 'ads',
  'materials', 'goldenhour', 'night', 'skyline', 'combat',
];

/**
 * The acceptance criteria that are numbers, computed from the PNGs instead of
 * eyeballed. Every one of these is something a hostile critic applies by eye in
 * under a second — a pane that is not dark enough against its wall, a soldier
 * that is not darker than what is behind him, a specular hit on far ground, a
 * corridor end that is a flat card, a horizon seam. Eyeballing them has already
 * produced three reviews of a brick wall on this project.
 *
 * Regions are NORMALISED (0..1 of frame), so they survive a resolution change.
 * They are tied to specific presets and will need moving if those presets move —
 * which is exactly why they live next to the presets.
 */
const CHECK_REGIONS = {
  // Sunlit facade slab in READ30. p08 is the panes, p85 the lit wall.
  read30:       { facade: [0.34, 0.05, 0.36, 0.60] },
  // Street corridor end (the haze plug at the vanishing point) and clear sky.
  street:       { corridorEnd: [0.500, 0.445], skyOffsetPx: -100 },
  // Establishing: ground band beyond the mid-street, and the seam scan.
  establishing: { farGround: [0.420, 0.446, 0.160, 0.020], seamFrom: 0.34 },
};

const relLum = (r, g, b) => {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const lstar = (Y) => (Y <= 0.008856 ? 903.3 * Y : 116 * Math.pow(Y, 1 / 3) - 16);

/**
 * Runs the pixel checks in a throwaway Chromium page (canvas is the only PNG
 * decoder available without adding a dependency, and adding one is forbidden).
 */
async function runChecks(browser, shots, probes) {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  const out = [];
  for (const s of shots) {
    const regions = CHECK_REGIONS[s.name];
    const botRects = probes[s.name]?.bots || [];
    if (!regions && !botRects.length) continue;
    const buf = await readFile(s.file);
    const url = `data:image/png;base64,${buf.toString('base64')}`;
    const r = await page.evaluate(
      async ({ url, name, regions, botRects, relLumSrc, lstarSrc }) => {
        const relLum = eval(`(${relLumSrc})`);
        const lstar = eval(`(${lstarSrc})`);
        const im = await new Promise((res, rej) => {
          const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
        });
        const W = im.width, H = im.height;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(im, 0, 0);
        const px = g.getImageData(0, 0, W, H).data;
        const Y = new Float32Array(W * H);
        for (let i = 0, j = 0; i < px.length; i += 4, j++) Y[j] = relLum(px[i], px[i + 1], px[i + 2]);
        const findings = [];
        const pct = (arr, p) => { const a = Float32Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

        // ---- pane luminance vs adjacent lit wall (<= 0.18x)
        if (regions?.facade) {
          const [fx, fy, fw, fh] = regions.facade;
          const x0 = (fx * W) | 0, y0 = (fy * H) | 0, x1 = ((fx + fw) * W) | 0, y1 = ((fy + fh) * H) | 0;
          const v = [];
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(Y[y * W + x]);
          const pane = pct(v, 0.08), wall = pct(v, 0.85);
          findings.push({
            check: 'paneVsLitWall', target: '<= 0.18',
            value: +(pane / Math.max(wall, 1e-6)).toFixed(3),
            pass: pane / Math.max(wall, 1e-6) <= 0.18,
            detail: { paneP08: +pane.toFixed(4), wallP85: +wall.toFixed(4), region: regions.facade },
            approximation: 'panes are the 8th luminance percentile of the facade slab, lit wall the 85th; it is a distribution proxy, not a segmentation',
          });
        }

        // ---- corridor end vs clear sky, and does it contain structure
        if (regions?.corridorEnd) {
          const [cx, cy] = regions.corridorEnd;
          const patch = (px0, py0, n) => {
            const v = [];
            for (let y = py0; y < py0 + n; y++) for (let x = px0; x < px0 + n; x++) {
              if (x >= 0 && y >= 0 && x < W && y < H) v.push(Y[y * W + x]);
            }
            const m = v.reduce((a, b) => a + b, 0) / v.length;
            const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
            return { mean: m, sd };
          };
          const ex = ((cx * W) | 0) - 16, ey = ((cy * H) | 0) - 16;
          const end = patch(ex, ey, 32);
          const sky = patch(ex, ey + Math.round(regions.skyOffsetPx * (H / 1080)), 32);
          const ratio = end.mean / Math.max(sky.mean, 1e-6);
          findings.push({
            check: 'corridorEndVsSky', target: '0.42 - 0.80',
            value: +ratio.toFixed(3), pass: ratio >= 0.42 && ratio <= 0.80,
            detail: { endMean: +end.mean.toFixed(4), skyMean: +sky.mean.toFixed(4) },
          });
          findings.push({
            check: 'corridorEndStructure', target: 'sd >= 0.020',
            value: +end.sd.toFixed(4), pass: end.sd >= 0.020,
            detail: 'a flat card and a real hazed depth plane have the same mean; only the variance separates them',
          });
        }

        // ---- far-ground specular hotspot
        if (regions?.farGround) {
          const [gx, gy, gw, gh] = regions.farGround;
          const x0 = (gx * W) | 0, y0 = (gy * H) | 0, x1 = ((gx + gw) * W) | 0, y1 = ((gy + gh) * H) | 0;
          const v = [];
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(Y[y * W + x]);
          const med = pct(v, 0.5), hi = pct(v, 0.95);
          findings.push({
            check: 'farGroundHotspot', target: '<= 1.15', advisory: true,
            value: +(hi / Math.max(med, 1e-6)).toFixed(3), pass: hi / Math.max(med, 1e-6) <= 1.15,
            detail: { p95: +hi.toFixed(4), median: +med.toFixed(4) },
            approximation: 'ADVISORY, do not gate on it. The >100 m condition is a SCREEN REGION and not a depth test — the harness cannot read the depth buffer back — so any prop, kerb or vehicle standing in the band counts as ground and inflates it. Treat a high number as "go and look", not as a defect.',
          });
        }

        // ---- horizontal seam scan
        if (regions?.seamFrom !== undefined) {
          const yStart = (regions.seamFrom * H) | 0;
          let worstFrac = 0, worstRow = -1;
          const rows = [];
          for (let y = yStart; y < H - 1; y++) {
            let up = 0, dn = 0, sa = 0, sb = 0;
            for (let x = 0; x < W; x++) {
              const a = Y[y * W + x], b = Y[(y + 1) * W + x];
              sa += a; sb += b;
              const d = (b - a) / Math.max(a, 1e-4);
              if (d > 0.12) up++; else if (d < -0.12) dn++;
            }
            // SIGNED and coherent. The first version of this counted absolute
            // steps and fired on every roofline in the frame, because a row of
            // windows steps just as hard as a seam does — it just steps both
            // ways. A seam is one direction across the width AND it moves the
            // row mean; a facade detail does neither.
            const frac = Math.max(up, dn) / W;
            const meanShift = Math.abs(sb - sa) / Math.max(sa, 1e-4);
            if (frac > worstFrac) { worstFrac = frac; worstRow = y; }
            if (frac > 0.30 && meanShift > 0.06) {
              rows.push({ y, frac: +frac.toFixed(3), meanShift: +meanShift.toFixed(3) });
            }
          }
          findings.push({
            check: 'horizonSeam', advisory: true,
            target: 'no row with >30% of width stepping >12% in ONE direction and shifting the row mean >6%',
            value: +worstFrac.toFixed(3), pass: rows.length === 0,
            detail: { worstRow, offendingRows: rows.slice(0, 8), scannedFrom: yStart },
          });
        }

        // ---- bots: darker than background, and not red-shifted
        if (botRects.length) {
          let worstDelta = 1e9, worstRB = -1e9;
          const per = [];
          for (const [bx, by, bw, bh] of botRects) {
            const ix0 = Math.max(0, Math.round(bx + bw * 0.25)), ix1 = Math.min(W, Math.round(bx + bw * 0.75));
            const iy0 = Math.max(0, Math.round(by + bh * 0.20)), iy1 = Math.min(H, Math.round(by + bh * 0.70));
            if (ix1 <= ix0 || iy1 <= iy0) continue;
            let sy = 0, n = 0;
            const rbs = [];
            for (let y = iy0; y < iy1; y++) for (let x = ix0; x < ix1; x++) {
              const i = (y * W + x) * 4;
              sy += Y[y * W + x]; n++;
              rbs.push(px[i] - px[i + 2]);
            }
            // p98 rather than max. A bot standing next to a burning vehicle has
            // fire pixels inside its projected box; one of them took the max to
            // 159 and the check reported the fire as a warm-tinted soldier.
            const maxRB = rbs.length ? pct(rbs, 0.98) : 0;
            // 20 px annulus outside the projected box
            let sa = 0, na = 0;
            const A = 20;
            for (let y = by - A; y < by + bh + A; y++) for (let x = bx - A; x < bx + bw + A; x++) {
              if (x < 0 || y < 0 || x >= W || y >= H) continue;
              if (x >= bx && x < bx + bw && y >= by && y < by + bh) continue;
              sa += Y[y * W + x]; na++;
            }
            if (!n || !na) continue;
            const dL = lstar(sa / na) - lstar(sy / n);
            per.push({ rect: [bx, by, bw, bh], deltaLstar: +dL.toFixed(1), maxRminusB: maxRB });
            worstDelta = Math.min(worstDelta, dL);
            worstRB = Math.max(worstRB, maxRB);
          }
          if (per.length) {
            findings.push({
              check: 'botVsBackgroundLstar', target: '>= 22 points darker',
              value: +worstDelta.toFixed(1), pass: worstDelta >= 22,
              detail: { bots: per.length, per },
            });
            findings.push({
              check: 'botMaxRminusB_p98', target: '<= 18',
              value: worstRB, pass: worstRB <= 18,
            });
          }
        }
        return { shot: name, findings };
      },
      { url, name: s.name, regions: regions || null, botRects, relLumSrc: relLum.toString(), lstarSrc: lstar.toString() }
    );
    out.push(r);
  }
  await page.close();
  return out;
}

async function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let server = null;
  if (!(await waitForServer(URL, 1200))) {
    // --static serves the built dist through `vite preview` instead of the dev
    // server. With several agents editing src/ at once, a dev-server HMR full
    // reload lands in the middle of a capture and kills the run with
    // "Execution context was destroyed"; worse, when it does not kill the run
    // it silently measures a half-applied edit. A measurement pass should read
    // a snapshot, so build first and shoot the build.
    const cmd = flag('static')
      ? ['vite', 'preview', '--port', String(PORT), '--strictPort']
      : ['vite', '--port', String(PORT), '--strictPort'];
    server = spawn('npx', cmd, {
      cwd: ROOT, stdio: 'ignore', detached: false,
    });
    if (!(await waitForServer(URL, 45000))) {
      console.error(JSON.stringify({ ok: false, error: 'dev server failed to start' }));
      server?.kill();
      process.exit(1);
    }
  }

  const browser = await chromium.launch({
    headless: !flag('headed'),
    args: [
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-driver-bug-workarounds',
      '--enable-webgl-draft-extensions',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}\n${e.stack || ''}`));

  const result = {
    ok: true, shots: [], errors: consoleErrors, stats: null, renderer: null,
    resolution: `${W}x${H}`,
    // Every reference frame in refs/ is 1920x1080. A judged frame rendered at
    // any other size has to be resampled to sit beside one, and whichever panel
    // gets resampled loses or gains detail for a reason that is nothing to do
    // with render quality — the comparator can match the two panels but it
    // cannot un-resample. So: judge at native, and say so in the report when
    // you have not.
    judgeNative: W === 1920 && H === 1080,
    notes: [],
  };
  if (!result.judgeNative) {
    result.notes.push(
      `rendered ${W}x${H}, references are 1920x1080 — fine for an iteration pass, NOT valid for a blind A/B`
    );
  }

  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForFunction('window.__READY__ === true', { timeout: 45000 });
  } catch (e) {
    result.ok = false;
    result.error = `boot failed: ${e.message}`;
    await page.screenshot({ path: path.join(OUT, '_boot-failure.png') }).catch(() => {});
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    server?.kill();
    process.exit(1);
  }

  result.renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const d = gl?.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });

  // Let streaming/compilation/TAA settle before the first capture.
  await page.waitForTimeout(WARMUP_MS);
  await page.evaluate(() => window.__COD__?.debug?.setVisible?.(false));
  await page.evaluate(() => document.getElementById('debug-overlay')?.style.setProperty('display', 'none'));

  // `--shots judged` is the set the A/B is fought with; `--shots read` is the
  // three instruments; `--shots all` is everything. A bare list still works.
  const GROUPS = {
    judged: JUDGED,
    read: ['read5', 'read30', 'read80'],
    all: Object.keys(SHOTS),
  };
  const spec = arg('shots', '');
  const probes = {};
  const requested = spec
    ? spec.split(',').flatMap((n) => GROUPS[n] ?? [n])
    : JUDGED;

  for (const name of requested) {
    const s = SHOTS[name];
    if (!s) continue;
    await page.evaluate((shot) => {
      const api = window.__COD__;
      if (!api) return;
      api.setTimeOfDay?.(shot.tod);
      api.setViewmodelVisible?.(!!shot.viewmodel);
      if (shot.ads) api.setADS?.(true); else api.setADS?.(false);
      if (shot.action) api.stageCombat?.();
      api.setCamera(shot.pos, shot.look, shot.fov);
    }, s);
    await page.waitForTimeout(SETTLE_MS);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, type: 'png' });
    // Screen-space rectangles for anything a pixel check needs to find but
    // cannot segment from the image — today that is the bots. Projected here,
    // while the camera that took the frame is still the live camera.
    // ONLY where combat was staged. Bots persist in the scene after
    // stageCombat(), so projecting them into read5 — a 5 m wall close-up —
    // produced boxes sitting on a sunlit facade with no bot behind them and a
    // bot-vs-background delta of MINUS 5.8. A check that reports on a soldier
    // who is not in the frame is worse than no check.
    if (CHECK && s.action) {
      probes[name] = await page.evaluate(() => {
        const api = window.__COD__;
        const cam = api?.ctx?.camera;
        const bots = api?.ctx?.ai?.bots || [];
        if (!cam || !bots.length) return { bots: [] };
        const THREE = api.ctx.THREE || null;
        const out = [];
        const w = window.innerWidth, h = window.innerHeight;
        for (const b of bots) {
          if (!b?.position || b.alive === false) continue;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
          for (const dx of [-0.32, 0.32]) for (const dz of [-0.24, 0.24]) for (const dy of [0.15, 1.72]) {
            const v = { x: b.position.x + dx, y: b.position.y + dy, z: b.position.z + dz };
            // project by hand so this does not depend on THREE being exposed
            const m = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
            const ex = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12];
            const ey = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13];
            const ez = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14];
            const cw = p[3] * ex + p[7] * ey + p[11] * ez + p[15];
            if (cw <= 0.001) continue;
            const cx = (p[0] * ex + p[4] * ey + p[8] * ez + p[12]) / cw;
            const cy = (p[1] * ex + p[5] * ey + p[9] * ez + p[13]) / cw;
            const sx = (cx * 0.5 + 0.5) * w, sy = (1 - (cy * 0.5 + 0.5)) * h;
            x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
            y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
            any = true;
          }
          if (any && x1 > 0 && y1 > 0 && x0 < w && y0 < h && (x1 - x0) >= 6 && (y1 - y0) >= 12) {
            out.push([Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)]);
          }
        }
        return { bots: out };
      });
    }
    // Per-shot cost, not one reading at the end of the run. Presets differ by
    // 2x in draw calls and the aggregate hid that completely — every previous
    // report quoted whatever the last preset happened to cost. fps is the
    // median of three 0.5 s engine buckets: a single bucket on a box running
    // other work swings 11-60 and is not a measurement.
    const st = await page.evaluate(async () => {
      const s = window.__COD__?.stats;
      const f = [];
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 520));
        f.push(s.fps);
      }
      f.sort((a, b) => a - b);
      return { fps: Math.round(f[1]), fpsMin: Math.round(f[0]), fpsMax: Math.round(f[2]),
               drawCalls: s.drawCalls, triangles: s.triangles, programs: s.programs };
    });
    result.shots.push({ name, file, desc: s.desc, ...st });
  }

  // Worst case across the set, which is the number the 350/60 budget is
  // actually about — plus the last-frame reading the old report used, kept so
  // historical numbers stay comparable.
  if (result.shots.length) {
    const worst = (k) => Math.max(...result.shots.map((s) => s[k] ?? 0));
    result.budget = {
      maxDrawCalls: worst('drawCalls'),
      maxTriangles: worst('triangles'),
      maxPrograms: worst('programs'),
      minFps: Math.min(...result.shots.map((s) => s.fps ?? 0)),
      drawCallBudget: 350,
      fpsTarget: 60,
      withinBudget: worst('drawCalls') <= 350 && Math.min(...result.shots.map((s) => s.fps ?? 0)) >= 60,
    };
  }
  result.stats = await page.evaluate(() => {
    const s = window.__COD__?.stats;
    return s ? { fps: Math.round(s.fps), drawCalls: s.drawCalls, triangles: s.triangles, programs: s.programs } : null;
  });
  if (CHECK) {
    try {
      result.checks = await runChecks(browser, result.shots, probes);
      const all = result.checks.flatMap((c) => c.findings);
      result.checkSummary = {
        run: all.length,
        // Advisories are separated because two of these checks are heuristics
        // standing in for a depth test we cannot do; treating them as gates
        // would train the next agent to ignore the whole block.
        failed: all.filter((f) => !f.pass && !f.advisory).map((f) => `${f.check}=${f.value} (want ${f.target})`),
        advisory: all.filter((f) => !f.pass && f.advisory).map((f) => `${f.check}=${f.value} (want ${f.target})`),
      };
    } catch (e) {
      result.checks = { error: e.message };
    }
  }
  result.errors = consoleErrors.slice(0, 40);

  await browser.close();
  if (server) { server.kill(); }

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (consoleErrors.length) process.exitCode = 0; // errors reported, not fatal
}

main().catch(async (e) => {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack }));
  process.exit(1);
});
