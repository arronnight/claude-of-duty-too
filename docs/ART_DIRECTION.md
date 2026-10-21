# Art Direction — "ASHFALL"

The single most important decision on this project: **we do not try to render
photoreal humans.** Procedural skin, cloth simulation and facial rigs are where a
browser build loses a blind comparison instantly. Instead we compete on the axis
where a well-engineered renderer can genuinely trade blows with a AAA engine:
**environment, light, atmosphere and surface**.

So the game is set in an environment that is (a) iconic to the genre, (b) built
from materials procedural generation is good at, and (c) lit in a way that
flatters a physically-based renderer.

## The place

A bombed-out Middle-Eastern/North-African market district. Two- and three-storey
concrete-frame buildings with plaster over blockwork, flat roofs, external
staircases, rebar stubs, corrugated-metal awnings and shopfront shutters. A
central market street running the long axis, a collapsed building forming a rubble
ramp mid-map, a walled courtyard, an underpass, and a raised roof route.

Why this works: concrete, plaster, brick, sand, rust, rubble and torn canvas are
exactly the materials fBm + worley noise reproduces convincingly. There is no
foliage-density problem, no character-crowd problem, and no organic-shape problem.

## The light

**Primary look — "MORNING RAID" (time of day 0.30)**
- Sun at ~28° elevation, azimuth raking down the market street so the street floor
  is half in hard sun and half in deep shadow. This split is the whole shot.
- Colour temp ~4800K sun, strongly blue-shifted sky fill (~12000K) — the warm/cool
  contrast is what makes CoD's daylight read as expensive.
- Heavy airborne dust: aerial perspective must visibly desaturate and lift the
  blacks at 40m+. Distant buildings should sit in a warm haze, not read crisp.
- Volumetric shafts through the underpass and between buildings. This is the money shot.

**"GOLDEN HOUR" (0.09)** — sun at 4°, long shadows the full length of the street,
sky in strong Mie forward-scatter, dust glowing orange. Silhouette-driven.

**"NIGHT" (0.85)** — moonlit blue key, sodium-vapour street lamps (2000K, hard
orange pools), a burning vehicle as a flickering warm source, and interiors
spilling cold fluorescent. Never crush to black — night is *graded* blue, with
readable shadow detail, exactly like MWIII's night maps.

## Grade

- ACES filmic. Do **not** ship a linear/Reinhard look.
- Slight teal lift in the shadows, warm highlights. Shadow toe should not clip
  before ~0.02 — CoD's blacks are lifted, dusty, never pure #000.
- Global desaturation of ~12% then a selective saturation boost on the orange/teal
  axis. This is the single most recognisable part of the CoD look.
- Highlight rolloff must be soft. Blown sky is fine and correct; blown concrete is not.

## Density rules — the thing that actually separates AAA from a demo

A photoreal render fails not on shader quality but on **emptiness**. Every one of
these is mandatory:

1. **No unbroken surface larger than ~3m.** Every wall gets a pipe, a cable run, a
   vent, a stain, a poster, a bullet-scar cluster, an AC unit or a crack.
2. **Ground clutter everywhere.** Rubble chunks, brick fragments, gravel scatter,
   shell casings, crushed cans, paper, cardboard, rebar, broken tile. Ground plane
   visible-but-bare = instant loss.
3. **Edge wear.** Every hard concrete edge must be chipped/rounded via a
   curvature-driven mask in the shader plus actual chamfered geometry on hero props.
   Perfectly sharp 90° edges read as untextured boxes.
4. **Dirt gravity.** Grime accumulates downward: rain streaks under windowsills,
   dark bases where walls meet the ground, dust on upward-facing surfaces only.
   Implement as a world-space-Y-driven mask in the material shader.
5. **Colour variation between instances.** No two plaster walls the same tone.
   Per-instance hue/value jitter through instance attributes.
6. **Vertical interest.** Hanging cables, satellite dishes, laundry lines, awnings,
   torn tarpaulins. The upper third of the frame must not be empty sky.
7. **Decals, hundreds of them.** Bullet impacts, scorch marks, oil stains, graffiti,
   posters, tyre tracks, water stains. Projected, atlased, instanced.
8. **Atmospheric layering.** There must be at least three depth planes readable by
   haze alone: foreground (crisp), mid (slightly hazed), far (strongly hazed).

## Layout (three-lane, ~110m × 80m)

```
        N (rooftops accessible along this edge)
   ┌────────────────────────────────────────────┐
   │  ROOF ROUTE ── walkways, AC units, cover   │
   ├───────┬────────────────────────┬───────────┤
   │ WEST  │   MARKET STREET        │   EAST    │
   │ ALLEY │   (long lane, stalls,  │  COURTYARD│
   │ tight │    burnt-out truck,    │  walled,  │
   │ CQB   │    awnings overhead)   │  fountain │
   ├───────┴────────────────────────┴───────────┤
   │  UNDERPASS ── dark, volumetric shafts      │
   └────────────────────────────────────────────┘
                 S (spawn A)          spawn B
```

- Sightlines: the market street is the long sightline (~70m) — this is the shot
  that shows off aerial perspective. Alley and courtyard are 15-25m.
- Cover cadence: something to break line-of-sight every 6-8m on every lane.
- The collapsed building at mid-map is the vertical connector between street and roof.
- Interiors: at least four enterable buildings, each with a window that produces a
  volumetric shaft and a dark interior that forces the exposure contrast.

## Reference frames

`refs/` holds official 1920×1080 Activision press screenshots (MWIII, BO6) used
locally and transiently as comparison targets for the visual critic. `refs/catalog.json`
maps each of our camera presets to the best-matched reference frame. They are
gitignored and are never redistributed or shipped with the build.

When comparing, we compare **environment against environment**. A reference frame
whose foreground is a hero character is not a valid target for our empty-street
shot, and the catalog scores each frame for character dominance to enforce that.
