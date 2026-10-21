# Gameplay Spec

Numbers here are the contract. They are tuned to Call of Duty's actual feel, not
invented. Where a value looks oddly specific, it is deliberate — copy it.

## Weapons

All viewmodels are built from code (extruded profiles, lathed barrels, boolean-free
CSG-ish assembly) into `ctx.viewScene`. They must have: separate receiver, barrel,
handguard, stock, magazine, optic, charging handle, trigger, selector and sling
mount as distinct meshes, because the reload animation moves them independently and
because a single fused mesh reads as fake instantly.

| id | class | dmg (chest) | RPM | mag | ADS time | recoil V/H | notes |
|---|---|---|---|---|---|---|---|
| `m4` | assault | 26 | 800 | 30 | 220 ms | 1.4 / 0.6 | baseline, 4-shot kill |
| `ak74` | assault | 31 | 660 | 30 | 250 ms | 2.1 / 1.1 | harder kick, 4-shot |
| `mp5` | SMG | 22 | 900 | 30 | 180 ms | 1.0 / 0.7 | fastest ADS, 5-shot |
| `m870` | shotgun | 22 × 8 pellets | 70 | 6 | 300 ms | 6.0 / 2.0 | one-shot inside 6 m |
| `dmr` | marksman | 55 | 300 | 20 | 320 ms | 3.2 / 0.8 | 2-shot, semi-auto |
| `deagle` | pistol | 45 | 260 | 8 | 190 ms | 4.0 / 1.5 | sidearm |

Damage falloff: full damage to 25 m, lerp to 60 % at 55 m, flat beyond.
Multipliers: head ×1.9, chest ×1.0, stomach ×1.05, limb ×0.85.

### Firing model

- **Not hitscan-only.** Bullets are simulated projectiles: 780–930 m/s muzzle
  velocity, gravity −9.81, drag coefficient applied per step, integrated in
  `fixedUpdate`. At 20 m the difference is invisible; at 70 m the drop is the
  difference between a real shooter and a toy. Ray-march each step against the
  BVH via `ctx.physics.raycast` so no bullet tunnels.
- **Penetration.** Each material key has a penetration depth and a damage
  retention factor. Plywood and sheet metal pass through and keep 55–70 % damage;
  concrete stops everything but the DMR, which retains 25 % through ≤ 12 cm.
  Spawn an exit impact on the far side. This is a CoD signature — implement it.
- **Spread.** A per-weapon minimum cone that grows with sustained fire, movement
  and stance, and shrinks with a per-weapon recovery rate. ADS + crouch + stationary
  must reach the weapon's floor spread within ~400 ms.
- **Recoil is deterministic, not random.** Each weapon has an authored recoil
  *pattern* — an array of (pitch, yaw) kicks indexed by shot number, with a small
  random jitter (±8 %) layered on. A skilled player must be able to learn and
  counter it. Feed it to `ctx.player.applyRecoil`.
- First-shot recoil multiplier ×1.35. Recovery: 82 % of accumulated kick returns
  over ~350 ms with a critically-damped spring; the remaining 18 % is permanent
  until the player corrects it.

### Animation (all procedural, spring-driven — no keyframe data files)

- **Idle sway** — weapon lags camera rotation with a damped spring, magnitude
  scaled by weapon weight. Plus a slow breathing bob.
- **ADS transition** — the weapon translates and rotates to align the sight with
  the camera axis over the weapon's ADS time, on an ease-out curve, with a slight
  overshoot (~4 %). The optic must land *exactly* centred; a misaligned sight is
  the most noticeable possible bug.
- **Fire** — receiver kicks back along the bore axis and rotates up, returns on a
  spring. Bolt/slide cycles. Muzzle flash + shell eject at the correct frames.
- **Reload** — a real multi-stage sequence: lower, mag release, mag out (drop it as
  a physics body), new mag in, seat it, raise; plus the bolt-catch variant when the
  mag was empty. Stage timings per weapon, driven by a small keyframe table in code
  interpolated with smoothstep. Emit `weapon:reload` with the stage name.
- **Sprint** — weapon cants down-right ~35°, held low, with a heavier bob.
- **Inspect** — a flourish that rotates the weapon to show both sides. This is
  purely to prove the model holds up under scrutiny; the critic will use it.

## AI

Bots are not the visual focus — they must read correctly in silhouette and
motion, and they must behave plausibly. Budget them accordingly.

- Navigation on the navmesh published as `ctx.level.navPolys`, A* with string
  pulling, plus local steering avoidance.
- A behaviour tree with: patrol → investigate (heard a shot) → engage → suppress →
  reposition → flank → retreat-when-hurt. Use `ctx.level.coverPoints`; a bot must
  actually take cover, break line of sight, and peek — not stand in the open.
- Perception: a real vision cone (110° FOV, range by stance and lighting, blocked
  by a physics raycast), plus hearing with a radius scaled by the event's loudness.
- Reaction time 180–420 ms scaled by `setDifficulty`. Aim error as a decaying cone,
  never perfect. Bots must miss believably — first burst wide, walking onto target.
- Hitboxes: head, chest, stomach, 4 limbs, published in `userData.hitboxes`.
- Death: switch to `ctx.physics.spawnRagdoll` with the killing impulse. No canned
  death animation.

## HUD

Minimal and diegetic-leaning, matching modern CoD. Everything in `#ui-root`,
Canvas2D or DOM, never in the 3D scene.

- Dynamic crosshair: 4 lines + centre dot, gap driven by *actual current spread*
  so it is honest. Hidden while ADS.
- Hitmarker: white on hit, red on kill, with a 90 ms scale-punch.
- Lower-right ammo: `mag / reserve`, weapon name, fire mode. Reserve dims at ≤ 2 mags.
- Lower-left: health bar only when damaged, plus stance and stamina pips.
- Directional damage indicators: arcs at the screen edge pointing at the source,
  fading over 1.2 s.
- Killfeed top-right, 5 entries, fading.
- Compass strip along the top with cardinal marks and objective bearings.
- Full-screen effects on damage: a vignette pulse that reddens with lower health,
  plus a slight desaturation under 30 HP.
- Hit-flash on the screen edge, not a full red overlay.

**HUD must be hidden by `ctx.hud.setVisible(false)` for screenshots**, and the
harness calls it — a HUD in the frame invalidates the blind comparison.

## Audio

All synthesised with WebAudio — no sample files.

- Gunshots: a layered synth — a short noise burst shaped by a fast-decay envelope
  for the crack, a filtered low sine thump for the body, a mechanical click for the
  action, and a convolution tail for the environment. Each weapon gets its own
  spectral signature. A single noise burst is not acceptable.
- Distance: low-pass filtering plus delay with distance, and a separate "distant
  report" layer beyond 40 m — the crack-then-boom separation is what sells scale.
- Reverb: a procedurally generated impulse response per space (street, interior,
  underpass), crossfaded as the listener moves.
- Footsteps per surface material key, with stance and speed variants.
- Bullet whizz-by for near misses, impact sounds per surface, shell casings hitting
  the ground as a small pitch-randomised metallic tick.
- Mix: a compressor on the master bus, plus ducking of ambience under gunfire and a
  brief muffling filter sweep after an explosion.
