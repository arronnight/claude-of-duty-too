# HANDOFF — Claude of Duty

**Paused:** 2026-07-26. Wave 3 (facades / horizon / bots / clutter / road / dressing)
landed in full. Budgets are blown and the blind critic has still never run.
**Repo:** `/Users/jacksmith/Documents/github/jack/claude-of-duty` (git, no remote)
**Tree:** clean, `npx vite build` passes, all 10 presets render with `errors: []`.
**Last good commit:** `git log -1`. Wave 3 is the 40 commits after `b394676`.

> **READ `## WHERE TO PICK UP` AT THE BOTTOM FIRST.** Everything above it is
> evidence for why the plan is what it is.

---

## The one thing to know before touching performance

The previous handoff's resume plan said: performance first, and get there by
cutting draw calls — `setDensity`, instancing, LODs, distance culling. **That plan
was wrong and following it would have cost visual quality for almost no frame
rate.** It was disproved by measurement, not opinion. `tools/profile.mjs` now
exists to keep it disproved.

Measured on the M2 (ads preset, draw calls held constant at 332, render buffer
scaled over 0.73 / 1.44 / 2.86 Mpx):

```
frameMs = 8.80 + 12.92 * megapixels
```

Everything the CPU does — draw submission, culling, geometry, animation, physics,
**and shadow-map rendering** — is the 8.80 ms constant. Everything else is
per-pixel. Consequences:

- **Driving draw calls to literally zero would still leave ~54 fps.** Draw count is
  not what is costing the frame rate. It is worth keeping under budget for its own
  sake, but it is not the lever.
- The whole post chain costs **6.2 ms**. Deleting every bit of it — TAA, GTAO,
  volumetrics, bloom, DOF — buys 47.9 fps. Still not 60.
- Shadow **map rendering** costs ~1 ms. Shadow **sampling** — PCSS filtering in the
  fragment shader of every lit surface — costs **~5 ms**. This is why lowering
  cascade count (0.65 ms) and shadow map size (0.70-0.95 ms) has never moved the
  number: both only touch the ~1 ms half.
- Hiding `Level` saves 27.7 ms because the walls fill the frame and every wall
  pixel runs the full `SurfaceShader` (POM + triplanar + detail normals + macro
  variation + wetness). `AI`, `FX` and `Vegetation` together are under 1 ms —
  cutting bots or effects buys nothing.

**Measurement caveat, and it bounds what the per-pass table can support:**
`EXT_disjoint_timer_query_webgl2` is not available in this environment (the probe
reports `gpuTimer:false`), so every figure is derived from an fps counter that
quantises to roughly 1 fps. Individual post passes separated by ~1.4 ms are AT
that resolution limit and must not be ranked against each other. The large deltas
— 6.2 ms whole chain, 5.98 vs 0.95 ms sample-vs-render — are many times the
quantisation and are safe to act on.

Raw measurement JSON is in `profile/` (gitignored). Re-run with
`node tools/profile.mjs`.

---

## Measured state

Wave 3, 1920x1080, ANGLE Metal / Apple M2, `errors: []`, all 10 presets render:

| preset | fps | draws | tris | programs |
|---|---|---|---|---|
| establishing | 25 | 326 | 1.85 M | 53 |
| street | 22 | 342 | 1.87 M | 53 |
| interior | 28 | 318 | 1.86 M | 53 |
| weapon | 24 | 369 | 1.90 M | 53 |
| ads | 22 | 356 | 1.90 M | 56 |
| materials | 27 | 303 | 1.87 M | 56 |
| goldenhour | 23 | 333 | 1.87 M | 56 |
| night | 21 | 352 | 1.87 M | 56 |
| skyline | 25 | 336 | 1.87 M | 56 |
| **combat** | **23** | **372** | **1.94 M** | **63** |

**Every budget is blown**: 372 draws vs 350, **63 programs vs a 60 ceiling**,
1.94 M triangles vs 1.35 M, 21-28 fps vs 60.

Note the resolution change: judged shots now render at **1920x1080** to match the
references' native size (see "blind test" below), so the table above is NOT
comparable with the previous handoff's 1600x900 numbers. Measured at 1600x900 on
the same build, against the Wave 2 baseline:

| preset | Wave 2 fps | Wave 3 fps | delta |
|---|---|---|---|
| establishing | 41 | 31 | -10 |
| street | 40 | 28 | -12 |
| interior | 41 | 36 | -5 |
| weapon | 38 | 30 | -8 |
| ads | 36 | 28 | -8 |
| materials | 49 | 34 | -15 |
| goldenhour | 39 | 29 | -10 |
| night | 38 | 27 | -11 |
| skyline | 40 | 32 | -8 |
| combat | 41 | 30 | -11 |

**Wave 3 cost 8-12 fps.** Triangles went 1.03 M -> 1.87 M (+81%) and the frame is
fill-bound, so more geometry covering more pixels with the expensive
`SurfaceShader` is exactly what the cost model predicts. This was a deliberate
trade — the frames went from "blockout with blank slabs" to something that can
plausibly be shown to a critic — but it is a real debt and it is why the fix list
below puts budget work ahead of any further content.

---

## What Wave 3 actually fixed, with the root cause in each case

Every one of these was diagnosed in source or in pixels before any code changed.
That is why the wave landed in one pass.

1. **Facades were not missing — the windows were entombed in solid concrete.**
   `facade.js` was already placing ~100 windows, but `window_()` put the reveal
   back at `out = -0.30`, the jambs and returns at `-0.15` and the frame members at
   `-0.05`, i.e. all behind the wall plane, while `Level.js::_buildBlocks` emitted a
   solid `BoxGeometry` with no opening cut. Everything except the cill (`+0.055`)
   and lintel (`+0.03`) was sealed inside the wall and never rasterised. The "few
   thin horizontal lines" visible on the blank walls were the cills and lintels of
   windows that did not exist. **Fixed** by building a pier-and-spandrel skin
   standing 0.28 m proud of the shell, so the openings are voids and the shell face
   behind each becomes the reveal back for free — no CSG on `Level.js`, no
   cross-file coupling. Plus a 2048² painted window atlas, deep cornices, quoins,
   shopfronts, balconies.
2. **A building was floating.** `Level.js:234` placed a 15x12 m mass at
   `x[-26.4,-11.4] z[-9,3]` over a room supporting only `x[-14.4,-8.4]
   z[-11.4,-0.6]` — 86% unsupported including a 12.00 m clear span, plainly visible
   with sky beneath it in `combat`. **Fixed.**
3. **The world visibly ended.** Ground plane was `PlaneGeometry(400,400)` (stops at
   200 m) against a 4000 m camera far plane, while aerial perspective
   (`density 0.0052`, cap 0.85) does not saturate until 365 m — so the rim was still
   35% visible as a hard dark band. **Fixed**: the world now ends at ~3 km behind a
   multi-ring city backdrop. Cranking haze density to hide it would have taken 40 m
   haze from 19% to 32% and washed out the mid-ground; that was the wrong fix and
   was explicitly rejected.
4. **"The far end blows to white"** — on the defect list across two previous work
   passes with no cause. It is `AerialPerspective.js`: `apIn = apSky + apParams[2].xyz
   * apPhase` was **unbounded**, and at anisotropy 0.62 the normalised HG peak is
   ~11.3x, so within ~20° of a low sun the haze rendered *brighter than the sky
   itself*. Real air only does that inside the ~5° aureole. **Clamped.**
5. **Clutter read as sprinkled confetti** — not a missing system. `layout.js` already
   had a full distance-transform + corner + step + wall-normal field sampler, and
   `fine`/`mid`/`litter` used it correctly. But the ROAD field at `clutter.js:291`,
   carrying ~3,140 of the pieces, was
   `(d < 2.4 || d > 12 ? 0 : 1) * (asphalt ? 1 : 0.25)` — and `d` is distance from
   the nearest obstacle. That is exactly inverted from reality: zero debris within
   2.4 m of any wall or kerb (where debris actually drifts) and flat uniform
   probability across the open road (where traffic sweeps it clear). **Fixed**, plus
   a prevailing-wind lee field so drifts are directional.
6. **The far ground plate had a mirror sheen.** Not Fresnel — specular aliasing. At
   200 m the normal map has mipped to a flat average and roughness to its mean, so
   the GGX lobe becomes a coherent mirror of the sky dome. **Fixed** with a distance
   roughness floor.
7. **Bots.** Correcting a misread that is easy to make from a thumbnail: they were
   never untextured grey mannequins — the kit palette and `vertexColors` were
   working. The real faults were a featureless ovoid head rendering pale white, tube
   limbs with no articulation, **no hands**, and no gear breakup. Rebuilt, merged to
   one material / one mesh, T-pose made structurally unreachable.
8. **Laundry read as flat black trapezoids.** It was `fabric_canvas` with no edge
   and no chroma. Now real cloth with folds, catenary sag, scalloped hem.

---

## Known defects, located, ranked — this is the fix list

Every one of these was found and reported by an agent that could not fix it because
it was outside their file ownership. They are all specific.

**Budget regressions (block everything):**
1. **63-64 shader programs against a 60 ceiling.** The wave overspent. `combat` is
   worst. Several agents already dropped features to buy programs back (clearcoat on
   glass was cut, costing visible glass quality; smoke columns were cut entirely).
   Needs a proper program audit — `signature()` in `SurfaceShader.js` is what forks.
2. **372 draw calls vs 350.** The `vehicles` BatchSet is the main overrun: built with
   the default 45 m `ZONE_LEN` and shadows on, an 8-entry variant table costs
   **16 draws, not the 4 it was funded for** (zones x shadow-flags x variants).
3. **1.94 M triangles vs a 1.35 M budget.**

**Visible defects:**
4. **A four-pane window quad is lying flat on the carriageway**, rendering as a 2x2
   grid of pale parallelograms with a mullion cross. Reproducible in `street` around
   x=990,y=650 and x=700,y=455. Unambiguous at 6x zoom.
5. **Aerial perspective is too strong at 60-90 m.** Measured: the corridor end is
   0.959 of a clear-sky patch against an acceptance target of 0.42-0.80 — the
   vanishing point is a white plug. This is the *remaining half* of defect 4 above:
   the additive term is clamped, but the density is now too high for the new
   backdrop distance.
6. **`Backdrop.js` north terminator renders as a blank, untextured, near-blown-out
   card** filling the corridor vanishing point (the 36x15.5x11 box at ~line 240).
   Directly related to 5.
7. **Bots miss their contrast target.** Measured ΔL* between each bot and its
   background annulus: 23.9, 16.6, 11.6, 15.8 against a required 22. Two of four are
   *lighter* than the shaded street behind them.
8. **Every vehicle leaves a large near-white ground patch** the size of its collider
   box (`groundingDust`). Clearly visible under each car.
9. **Awnings are not bound to shopfront bays.** `facadeDetail()` returns
   `{parts, sills}` and never a `bays` array, so `Props.js`'s `env.bays = fac.bays || []`
   is always empty and the consuming path in `overhead.js` is dead code. One-line fix
   in `facade.js` plus one in `Props.js`.
10. **Rust streaks are not anchored** to AC units and drainpipes for the same reason
    (`sills` is not forwarded).
11. Hanging cloth in `overhead.js:140/209/217` and `furniture.js:247/254` still uses
    `twoSided()`, so it has a razor silhouette with no lit rim. `shellGeo()` exists
    and is unit-tested for exactly this; it just has no callers.

---

## Process lessons that cost real work this session

- **Two agents reverted 1,333 lines of another agent's committed work** by sweeping
  stale working-tree copies of files they did not own into their own commits
  (`d7235fc`, `5f7d2c8`; undone by `dfb5dea`). The wave prompt told agents to
  `git add <specific files>` and never `git add -A`; that instruction was not
  followed by everyone. **Next wave: make it a hard, repeated instruction, and
  verify each agent's commit touched only its owned paths.**
- **Vite HMR reloads the page mid-capture** when several agents are saving files, so
  `tools/shoot.mjs` fails with "Execution context was destroyed". Three of one
  agent's seven capture attempts died this way. Build to a static `dist/` and serve
  that when measuring during a wave.
- **`tools/shoot.mjs` reuses an already-listening dev server on `--port`.** If an
  earlier run left vite on your port from a *different working directory*, every
  subsequent measurement silently profiles the wrong tree. Cost two agents a bad
  measurement each.
- **The first shoot of a session reports garbage fps** (street at 12 fps with
  identical draws/tris; subsequent runs 50-53). Discard run 1 or extend warmup.
- **Run-to-run noise on an identical build is meanAbsDiff 2.53/255** because animated
  cloud and dust are not frozen by the settle. Anything whose visual delta is under
  ~3 cannot be A/B'd numerically with this harness.
- Parallel agents on genuinely disjoint files still works — this wave was 9 agents,
  40 commits, and the only merge damage was the `git add -A` incident above.

---

## The blind test — still never run, and now finally trustworthy

`tools/blind.mjs` had **two methodology leaks that would have invalidated its own
verdicts**, both fixed this session:

- The references are JPEG press images and our frames were PNG, so only one panel
  carried ringing and 8x8 blocking. A critic noticing compression artefacts had
  identified the panels without judging a single pixel of render quality. Both
  panels are now round-tripped through JPEG at matched quality (`--jpegq`, 0.92).
- The two sources are authored at different resolutions and were being scaled by
  different ratios, leaving one visibly crisper. Panels now resolve to a common
  native width; `tools/shoot.mjs` defaults to 1920x1080 so neither is resampled.
- Panel order is now `--seed`-based: reproducible for audit, but re-randomisable so a
  critic scoring ten sheets cannot learn "ours is always LEFT on street".

**Any blind-confidence number produced before this session is meaningless.** No
verdict has ever been produced at all.

---

# WHERE TO PICK UP

Do these in order. The first two are cheap and unblock honest judgement.

### 1. RUN THE BLIND CRITIC. It has never executed once.
This is the entire point of the project and every wave so far has deferred it. The
frames are now good enough that the answer will be informative rather than merely
humiliating, and the harness is finally clean.
```
node tools/shoot.mjs --out shots/judge            # defaults to 1920x1080
node tools/blind.mjs --a shots/judge/street.png --b refs/bo6_05.jpg \
     --out blind/street --label "ground-level street" --seed run1
```
Pairs from `refs/catalog.json`: `street`→`bo6_05`, `establishing`→`mw3_04`,
`goldenhour`→`mw3_07`, `night`→`bo6_06`. `interior` and `materials` have no clean
full-frame reference — use `--bcrop` to pull an environment-only region out of
`bo6_03` or `mw3_08`.
Then have a critic agent read `blind/street.png` **only** — never
`blind/street.key.json` until it has committed to a verdict — and score against
`docs/CRITIC_RUBRIC.md`. Pass: TOTAL ≥ 78, zero automatic failures, blind
confidence ≤ 65.

### 2. Fix the four cheap visible defects
Items 4, 5, 6 and 8 in the defect list: the window quad on the road, the
over-dense haze plugging the corridor, the blank backdrop terminator, and the
white dust patches under vehicles. All are small, all are clearly visible in a
judged frame, and 5 and 6 are the same defect from two directions.

### 3. Programs and draw calls back inside budget
63 programs against a hard 60 ceiling is the real blocker — it has already cost
visible quality (glass clearcoat, smoke columns) in features agents dropped to
stay under it. Start with the `vehicles` BatchSet's 16-draw overrun and a
`signature()` audit in `SurfaceShader.js`.

### 4. THEN performance, and only against the measured model
Target the ~5 ms of **shadow sampling**, not cascade count or map size. Options:
a half-resolution shadow mask with bilateral upsample; fewer PCSS taps with
blue-noise offsets accumulated through TAA; an early-out for fully-lit and
fully-shadowed regions. Contact-hardening must survive — it is rubric dimension 3.
Second target is `SurfaceShader` fragment cost on the wall pixels that fill the
frame. **Do not spend a wave cutting props or draw calls; the measurement says it
will not work.**

### 5. Then loop: critic → fix → re-render, per preset, until pass.

## Tools added this session
- `tools/profile.mjs` — frame-budget attribution. Toggles one thing at a time
  against a re-measured baseline, medians six 500 ms buckets after discarding two,
  reports baseline drift so an effect smaller than the noise is called noise.
- `tools/crop.py` — GPU-free PNG crop and magnify (pure zlib, no dependencies), so
  frame detail can be inspected while a measurement is in flight. Everything else
  here drives Chromium and contends for the GPU.
  `python3 tools/crop.py in.png out.png --rect x,y,w,h --zoom 4`
  (Known limit: `--zoom` is int-only, so it can magnify but not reduce.)
- `tools/shoot.mjs --checks` — computes the numeric acceptance criteria instead of
  asking a reviewer to eyeball them. Three read-distance presets (`read5`,
  `read30`, `read80`) were added for surface-detail judgement.
