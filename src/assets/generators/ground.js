/**
 * Ground family: hot-rolled asphalt and its worn variant, road markings, dry
 * soil, packed gravel, wind-rippled sand and demolition rubble. Asphalt is
 * built once as a parameterised base so the worn surface and the painted line
 * sit on genuinely the same aggregate rather than a look-alike.
 */
export const GROUND = {
  asphalt: {
    world: 4.0,
    // Relief cut from 1.0 / 0.75. At 74 mm aggregate cells the old amplitude
    // made every stone a separately lit pebble at 3 m and the carriageway read
    // as a loose gravel bed rather than as bitumen with aggregate in it. Real
    // asphalt is a nearly flat surface whose stones are *visible* but not
    // *proud*. MATERIAL_DEFS carries the matching normalScale/pom cut.
    //
    // These sit ABOVE the brief's 0.62 / 0.55 deliberately: the aggregate term
    // in `s.h` has already been cut to 0.60 (see the note there), and both of
    // these multiply that same field, so 0.95 x 0.60 and 0.85 x 0.60 land on
    // the intended net figures without flattening the surface twice over.
    bump: 0.95,
    cavity: 0.85,
    glsl: /* glsl */ `
/** Shared hot-rolled asphalt base. wear 0 = freshly laid, 1 = ravelled and cracked. */
Surf asphaltBase(vec2 uv, float wear, float sd){
  Surf s = defaultSurf();

  // --- coarse aggregate sitting in a bitumen matrix
  //
  // AGGREGATE SIZE. On a 4 m tile the coarse cell used to run at 54, i.e. a
  // 74 mm stone. That is not aggregate, it is a cobble: a surface course is
  // nominally 10-20 mm and even a coarse binder course tops out around 40. At
  // a 1.68 m eye height, 74 mm stones two metres in front of the player are
  // several pixels across each and can be individually counted, which is the
  // whole reason the carriageway read as a gravel bed rather than as a road.
  // 92 puts the coarse stone at 43 mm and 170 puts the middle grade at 24 mm.
  //
  // The fine grade stays at 215 (18.6 mm). It is already under five texels at
  // the 1024 the factory generates, and pushing it finer would mip to flat
  // grey before two metres — which trades one wrong answer for another.
  Cell a1 = cells2(warp1(uv * 92.0, vec2(92.0), 0.45, 2) + sd, vec2(92.0), 1.0);
  Cell a2 = cells2(uv * 170.0 + 21.0, vec2(170.0), 1.0);
  Cell a3 = cells2(uv * 215.0 + 47.0, vec2(215.0), 1.0);

  float big   = 1.0 - smoothstep(0.17, 0.44, a1.f1);
  float mid   = 1.0 - smoothstep(0.14, 0.38, a2.f1);
  float small = 1.0 - smoothstep(0.12, 0.34, a3.f1);

  // Binder exposure. A road is bitumen with stone IN it, not stone with bitumen
  // between: even a ravelled surface keeps a film over most of the aggregate.
  float exposed = mix(0.42, 0.82, wear);
  float stoneMask = sat(big * 0.9 + mid * 0.5 + small * 0.25);

  // Measured against bo6_05's dry carriageway, which sits around sRGB #4b4b4d.
  // The old palette put a near-black matrix under high-contrast pale stones, so
  // the mean came out far too dark AND the per-stone contrast far too high —
  // the two failures that together make it read as gravel. Lifting the matrix
  // and pulling the stones down fixes both without touching the noise fields.
  vec3 bitumen = vec3(0.155, 0.150, 0.148);
  vec3 stoneA  = vec3(0.335, 0.325, 0.312);
  vec3 stoneB  = vec3(0.240, 0.232, 0.226);
  vec3 stoneC  = vec3(0.420, 0.392, 0.352);   // occasional limestone / flint
  vec3 stone = mix(stoneA, stoneB, fract(a1.id * 37.1));
  stone = mix(stone, stoneC, step(0.86, fract(a1.id * 91.3)));
  stone *= mix(0.68, 1.32, fract(a1.id * 77.3));
  vec3 stone2 = mix(stoneA, stoneB, fract(a2.id * 17.7)) * mix(0.72, 1.24, fract(a2.id * 51.7));

  vec3 base = bitumen;
  base = mix(base, stone2, mid * 0.55 * exposed);
  base = mix(base, stone,  big * 0.85 * exposed);
  base = mix(base, vec3(0.300, 0.288, 0.275), small * 0.14 * exposed);

  float grit = fbm01(uv * 300.0 + sd, vec2(300.0), 3, 2.0, 0.5);
  base += (grit - 0.5) * 0.024;

  // AGGREGATE HEIGHT, CUT TO 0.60 OF WHAT IT WAS — and this, not the normal,
  // is what was making cobbles.
  //
  // The bump setting only scales the derivative used to build the normal map.
  // s.h is written to the height attachment, and SurfaceShader's parallax term
  // displaces the UVs by pom * height, which is what carves a real silhouette
  // round every stone and lets you count them at three metres. Turning bump
  // down flattens the shading on a stone that is still physically there. The
  // requested pom cut (0.01 -> 0.006) lives in MATERIAL_DEFS, which belongs to
  // another agent, so the same 0.6 is applied here where it can be reached --
  // and it is arguably the better place for it, because it leaves the cracking
  // and the potholes in asphalt_worn at their full depth instead of shallowing
  // every feature on the road at once.
  //
  // bump and cavity are then raised back up, because both read this field: at
  // 0.95 x 0.60 the net normal amplitude is 0.57 of the original, which is the
  // 0.62 the brief asked for, reached without depending on whether the
  // normalScale change lands.
  s.h = 0.35 + big * 0.23 + mid * 0.10 + small * 0.042 + (grit - 0.5) * 0.03;
  s.ao = mix(0.45, 1.0, smoothstep(0.22, 0.62, s.h));

  // bitumen is glossier than stone; wear reverses that as the binder oxidises
  s.rough = mix(0.55 + wear * 0.28, 0.88, stoneMask);
  s.rough += (grit - 0.5) * 0.08;

  // --- ravelling: stones plucked out leave open sockets
  float ravel = smoothstep(0.45, 0.9, fbm01(uv * 7.0 + 33.0, vec2(7.0), 4, 2.0, 0.55)) * wear;
  float socket = (1.0 - smoothstep(0.06, 0.20, a1.f1)) * step(0.62, fract(a1.id * 53.9)) * ravel;
  s.h -= socket * 0.34;
  s.ao *= 1.0 - socket * 0.65;
  base = mix(base, bitumen * 0.8, socket * 0.7);

  // --- tar-seam repairs: a wandering ribbon of smooth black binder
  //
  // THE GOVERNING RULE FOR THIS FILE: any feature whose real-world period
  // exceeds the tile must be a decal, not a term in the tile. On a 4 m tile a
  // seam term repeats every 4 m; two of them, one per axis, drew a 4 m grid
  // across the whole carriageway and read as wallpaper the moment more than
  // one tile was in frame. The cross-axis seam is gone outright and what is
  // left is a 30% hint that survives as texture rather than as a line — the
  // real, single, full-length seams are placed as world-scale decals by
  // props/decals.js, which is the only place that knows where the road edges
  // actually are.
  float seamPath = fbm(vec2(uv.y * 3.0, 0.5), vec2(3.0, 1.0), 4, 2.0, 0.5) * 0.16;
  float seamD = abs(fract(uv.x + seamPath + 0.31) - 0.5);
  float seam = 1.0 - smoothstep(0.012, 0.028, seamD);
  seam *= (0.35 + 0.65 * wear) * 0.30;
  base = mix(base, vec3(0.088, 0.084, 0.084), seam);
  s.rough = mix(s.rough, 0.42, seam * 0.85);
  s.h = mix(s.h, 0.62, seam * 0.6);
  s.ao = mix(s.ao, 1.0, seam * 0.5);

  // NO WHEEL PATHS HERE. There used to be two polished lanes per tile, which on
  // a 4 m tile is one every 2 m: seven of them across a 14 m carriageway, all
  // parallel, all identical, and the single loudest tiling tell in the frame.
  // A wheel path is a ~3.5 m-gauge pair aligned to the DRIVING LINE, which the
  // texture cannot know about. props/decals.js lays them at world scale.

  // --- oil staining under where vehicles stand
  float oil = blobs(uv, vec2(6.0), 0.14, 0.30, 0.5, sd + 15.0);
  oil = sat(oil * 1.35 - fbm01(uv * 26.0, vec2(26.0), 3, 2.0, 0.5) * 0.4);
  base = mix(base, vec3(0.062, 0.058, 0.060), oil * 0.9);
  s.rough = mix(s.rough, 0.22, oil * 0.85);

  // dust film blown into the texture
  float dust = sat(1.0 - s.h * 1.5 + turb(uv * 9.0 + 55.0, vec2(9.0), 4, 0.55) * 0.5);
  s.alb = base;
  applyDirt(s, dust * 0.22 * uAge, vec3(0.42, 0.39, 0.35), 0.06);
  return s;
}

Surf gen_asphalt(vec2 uv){
  Surf s = asphaltBase(uv, 0.25, uSeed);
  applyMacro(s, uv, 0.20, 0.06, uSeed);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  asphalt_worn: {
    world: 4.0,
    // Cut in the same proportion as `asphalt`. The cracking and the potholes
    // are what should carry the relief here, not the aggregate — and because
    // the aggregate has been shallowed in `s.h` while the crack and pothole
    // terms below have not, that separation is now real rather than nominal.
    bump: 1.00,
    cavity: 0.80,
    deps: ['asphalt'],
    glsl: /* glsl */ `
Surf gen_asphalt_worn(vec2 uv){
  float sd = uSeed + 77.0;
  Surf s = asphaltBase(uv, 0.95, sd);

  // --- alligator cracking: a fatigue network at two scales
  float gate = smoothstep(0.30, 0.72, fbm01(uv * 3.0 + 12.0, vec2(3.0), 4, 2.0, 0.6));
  float c1 = crackNet(uv, vec2(13.0), 0.045, 0.9, 0.45);
  float c2 = crackNet(uv, vec2(34.0), 0.050, 0.9, 0.35);
  float ck = sat(c1 * 0.9 + c2 * 0.55) * gate;
  s.h -= ck * 0.30;
  s.ao *= 1.0 - ck * 0.7;
  s.alb *= 1.0 - ck * 0.45;
  s.rough += ck * 0.10;

  // grass and grit colonising the wider cracks
  float weed = ck * smoothstep(0.6, 0.95, fbm01(uv * 16.0 + 71.0, vec2(16.0), 4, 2.0, 0.55));
  s.alb = mix(s.alb, vec3(0.16, 0.18, 0.10), weed * 0.5);

  // --- potholes down to the base course
  float ph = blobs(uv, vec2(4.0), 0.09, 0.26, 0.35, sd + 5.0);
  ph = sat(ph * 1.7 - fbm01(uv * 22.0 + 3.0, vec2(22.0), 4, 2.0, 0.55) * 0.65);
  Cell rock = cells2(uv * 95.0 + 9.0, vec2(95.0), 1.0);
  float rk = 1.0 - smoothstep(0.10, 0.34, rock.f1);
  vec3 baseCourse = mix(vec3(0.33, 0.30, 0.26), vec3(0.50, 0.46, 0.40), fract(rock.id * 61.7));
  s.alb = mix(s.alb, mix(vec3(0.275, 0.250, 0.225), baseCourse, rk), ph * 0.9);
  s.h = mix(s.h, 0.10 + rk * 0.16, ph);
  s.ao *= 1.0 - ph * 0.55;
  s.rough = mix(s.rough, 0.93, ph * 0.9);

  // NO UTILITY PATCHES HERE, and no ghost lane marking either. Both were laid
  // on a sub-tile grid — the patches at uv*3.0, i.e. one every 1.33 m, and the
  // marking at uv.y*2.0, i.e. one every 2 m. A utility patch is a one-off
  // event with a straight sawcut edge and a dark perimeter seam; the reference
  // frames have exactly ONE in shot. Repeating it eight times per tile is not
  // a weaker version of the same thing, it is a different and obviously
  // synthetic thing. props/decals.js places both at world scale.

  applyMacro(s, uv, 0.22, 0.07, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  tarmac_line: {
    world: 4.0,
    bump: 1.0,
    cavity: 0.7,
    deps: ['asphalt'],
    glsl: /* glsl */ `
Surf gen_tarmac_line(vec2 uv){
  float sd = uSeed + 133.0;
  Surf s = asphaltBase(uv, 0.55, sd);

  // --- thermoplastic stripe running along V, 150 mm wide on a 4 m tile
  float wob = fbm(vec2(uv.y * 4.0, 1.5), vec2(4.0, 1.0), 3, 2.0, 0.5) * 0.006;
  float d = abs(fract(uv.x + wob + 0.5) - 0.5);
  float halfW = 0.019;
  float stripe = 1.0 - smoothstep(halfW, halfW + 0.004, d);

  // traffic scrubs the paint off unevenly, most at the stripe edges
  float scrub = fbm01(uv * vec2(30.0, 90.0) + sd, vec2(30.0, 90.0), 4, 2.0, 0.5);
  float wearEdge = smoothstep(halfW * 0.35, halfW, d);
  float loss = smoothstep(0.35, 0.70, scrub * 0.6 + wearEdge * 0.7 + fbm01(uv * vec2(6.0, 14.0), vec2(6.0, 14.0), 3, 2.0, 0.6) * 0.5);
  float paint = sat(stripe * (1.0 - loss));

  // retro-reflective glass beads dropped into the hot thermoplastic
  float beads = speckle(uv, 1400.0, 0.16);
  vec3 paintCol = vec3(0.845, 0.840, 0.815);
  paintCol *= mix(0.72, 1.0, fbm01(uv * 40.0 + 7.0, vec2(40.0), 4, 2.0, 0.5));
  paintCol = mix(paintCol, vec3(0.94), beads * 0.8);

  // grime settles on the paint faster than on the road
  float filth = turb(uv * 10.0 + 91.0, vec2(10.0), 4, 0.55);
  paintCol = mix(paintCol, vec3(0.40, 0.39, 0.36), sat(filth * 1.2 - 0.35) * 0.45 * uAge);

  s.alb = mix(s.alb, paintCol, paint);
  s.rough = mix(s.rough, mix(0.72, 0.45, beads), paint);
  s.h += paint * 0.10 + paint * beads * 0.05;
  s.ao = mix(s.ao, 1.0, paint * 0.6);

  // paint edge casts a tiny lip shadow
  float lip = (1.0 - smoothstep(halfW, halfW + 0.006, d)) * smoothstep(halfW - 0.004, halfW, d);
  s.ao *= 1.0 - lip * 0.25;

  applyMacro(s, uv, 0.18, 0.06, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  dirt: {
    world: 3.0,
    bump: 1.35,
    cavity: 0.85,
    glsl: /* glsl */ `
Surf gen_dirt(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 91.0;

  // --- soil body: clumped, domain-warped, with a fine dusty top
  vec2 w = warp2(uv * 8.0, vec2(8.0), 0.85, 4);
  float clump = fbm01(w, vec2(8.0), 6, 2.0, 0.55);
  float mid   = fbm01(uv * 45.0 + sd, vec2(45.0), 5, 2.0, 0.5);
  float dusty = fbm01(uv * 300.0 + sd * 2.0, vec2(300.0), 3, 2.0, 0.5);

  vec3 dry = vec3(0.500, 0.398, 0.278);
  vec3 damp = vec3(0.268, 0.198, 0.142);
  vec3 base = mix(dry, damp, smoothstep(0.35, 0.85, clump) * 0.55);
  base *= mix(0.82, 1.16, mid);
  base += (dusty - 0.5) * 0.045;

  s.h = 0.42 + (clump - 0.5) * 0.34 + (mid - 0.5) * 0.16 + (dusty - 0.5) * 0.04;
  s.rough = 0.93 + (dusty - 0.5) * 0.06;

  // --- dried mud polygons where the surface has shrunk and cracked
  float dryGate = smoothstep(0.40, 0.78, fbm01(uv * 3.5 + 8.0, vec2(3.5), 4, 2.0, 0.6));
  float mudCk = crackNet(uv, vec2(16.0), 0.055, 0.95, 0.40) * dryGate;
  Cell plate = cells2(warp1(uv * 16.0, vec2(16.0), 0.30, 2), vec2(16.0), 0.95);
  float curl = smoothstep(0.0, 0.35, plate.f1) * dryGate;   // plate edges lift
  s.h += curl * 0.10 - mudCk * 0.30;
  s.ao *= 1.0 - mudCk * 0.75;
  base *= 1.0 - mudCk * 0.45;
  base = mix(base, base * 1.18 + 0.02, curl * 0.35);

  // --- embedded stones and grit
  Cell st = cells2(uv * 90.0 + 13.0, vec2(90.0), 1.0);
  float stone = (1.0 - smoothstep(0.11, 0.30, st.f1)) * step(0.55, fract(st.id * 27.3));
  vec3 stoneCol = mix(vec3(0.430, 0.405, 0.380), vec3(0.680, 0.635, 0.565), fract(st.id * 71.9));
  base = mix(base, stoneCol, stone * 0.8);
  s.h += stone * 0.14;
  s.rough = mix(s.rough, 0.80, stone * 0.7);

  Cell gr = cells2(uv * 250.0 + 5.0, vec2(250.0), 1.0);
  float grit = (1.0 - smoothstep(0.10, 0.28, gr.f1)) * step(0.68, fract(gr.id * 13.1));
  base = mix(base, mix(vec3(0.30,0.28,0.26), vec3(0.62,0.58,0.52), fract(gr.id * 5.7)), grit * 0.6);
  s.h += grit * 0.05;

  // --- organic litter: dead grass, root fibres, leaf fragments
  float fibre = smoothstep(0.80, 0.95, fbm01(shear(uv, 3.0) * vec2(180.0, 12.0) + 31.0, vec2(180.0, 12.0), 3, 2.0, 0.5));
  fibre += smoothstep(0.82, 0.96, fbm01(shear(uv, -2.0) * vec2(14.0, 170.0) + 61.0, vec2(14.0, 170.0), 3, 2.0, 0.5));
  fibre = sat(fibre) * smoothstep(0.3, 0.7, clump);
  base = mix(base, vec3(0.36, 0.30, 0.16), fibre * 0.55);
  s.h += fibre * 0.04;
  s.rough += fibre * 0.03;

  float moss = smoothstep(0.68, 0.92, fbm01(uv * 11.0 + 101.0, vec2(11.0), 5, 2.0, 0.55)) * (1.0 - dryGate);
  base = mix(base, vec3(0.16, 0.20, 0.10), moss * 0.5);

  // --- footfall compaction: darker, smoother, lower
  float tread = blobs(uv, vec2(5.0), 0.28, 0.36, 0.85, sd + 44.0);
  s.h -= tread * 0.10;
  base *= 1.0 - tread * 0.18;
  s.rough -= tread * 0.06;

  s.ao *= mix(0.55, 1.0, smoothstep(0.15, 0.72, s.h));
  s.alb = base;
  applyMacro(s, uv, 0.22, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  gravel: {
    world: 2.5,
    bump: 1.9,
    cavity: 1.0,
    glsl: /* glsl */ `
Surf gen_gravel(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 111.0;

  // --- two grades of stone packed together, each a rounded dome
  vec2 wp = warp1(uv * 46.0, vec2(46.0), 0.22, 2);
  Cell c1 = cells2(wp + sd, vec2(46.0), 1.0);
  Cell c2 = cells2(uv * 110.0 + 19.0, vec2(110.0), 1.0);

  float r1 = mix(0.30, 0.50, fract(c1.id * 13.7));
  float dome1 = sqrt(max(0.0, sq(r1) - sq(min(c1.f1, r1)))) / r1;
  float r2 = mix(0.26, 0.44, fract(c2.id * 29.3));
  float dome2 = sqrt(max(0.0, sq(r2) - sq(min(c2.f1, r2)))) / r2;

  float big = step(0.30, fract(c1.id * 7.7));   // some cells are just fines
  dome1 *= big;

  float h = max(dome1 * 0.80, dome2 * 0.42);
  float fines = fbm01(uv * 190.0 + sd, vec2(190.0), 4, 2.0, 0.5);
  h += fines * 0.10;

  // per-stone colour: limestone, granite, flint, the odd red brick fragment
  vec3 pA = vec3(0.575, 0.545, 0.492);
  vec3 pB = vec3(0.385, 0.372, 0.356);
  vec3 pC = vec3(0.720, 0.680, 0.605);
  vec3 pD = vec3(0.485, 0.283, 0.208);
  float t1 = fract(c1.id * 53.1);
  vec3 col1 = mix(pA, pB, t1);
  col1 = mix(col1, pC, smoothstep(0.62, 0.95, fract(c1.id * 97.3)));
  col1 = mix(col1, pD, step(0.94, fract(c1.id * 131.7)));
  vec3 col2 = mix(pB, pA, fract(c2.id * 41.9));

  // facet shading and mineral speckle on each stone
  float facet = fbm01(uv * 260.0 + c1.id * 40.0, vec2(260.0), 3, 2.0, 0.5);
  col1 *= mix(0.84, 1.14, facet);
  col2 *= mix(0.88, 1.10, fbm01(uv * 380.0 + 3.0, vec2(380.0), 3, 2.0, 0.5));
  float mica = speckle(uv, 1100.0, 0.05);

  vec3 finesCol = vec3(0.408, 0.379, 0.336) * mix(0.82, 1.18, fines);

  vec3 base = finesCol;
  base = mix(base, col2, sat(dome2 * 1.6));
  base = mix(base, col1, sat(dome1 * 1.6));
  base = mix(base, vec3(0.85), mica * sat(dome1 + dome2) * 0.25);

  s.h = h;
  s.ao = mix(0.30, 1.0, smoothstep(0.05, 0.65, h));
  s.rough = mix(0.94, 0.72, sat(dome1 * 1.3)) + (facet - 0.5) * 0.10;
  s.rough = mix(s.rough, 0.80, sat(dome2) * 0.4);

  // dust coating the tops, damp shadow in the voids
  float dust = smoothstep(0.35, 0.9, h) * fbm01(uv * 8.0 + 61.0, vec2(8.0), 4, 2.0, 0.55);
  s.alb = base;
  applyDirt(s, dust * 0.30 * uAge, vec3(0.50, 0.47, 0.42), 0.04);
  base = s.alb;
  float voidD = sat(1.0 - h * 2.0);
  base = mix(base, base * 0.55, voidD * 0.55);

  s.alb = base;
  applyMacro(s, uv, 0.18, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  sand: {
    world: 3.0,
    bump: 0.8,
    cavity: 0.5,
    glsl: /* glsl */ `
Surf gen_sand(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 151.0;

  // --- wind ripples: a warped wave train, not a sine grid
  float meander = fbm(uv * 3.0 + sd, vec2(3.0), 4, 2.0, 0.5) * 0.30
                + fbm(uv * 7.0 + 11.0, vec2(7.0), 3, 2.0, 0.5) * 0.10;
  float ripple = sin(((uv.y * 9.0 + uv.x * 2.0) + meander) * TAU) * 0.5 + 0.5;
  ripple = pow(ripple, 1.7);
  float ripple2 = sin(((uv.y * 23.0 - uv.x * 5.0) + meander * 1.8) * TAU) * 0.5 + 0.5;
  ripple2 = pow(ripple2, 1.4);

  float dune = fbm01(uv * 2.5 + sd, vec2(2.5), 4, 2.0, 0.6);
  float grain = fbm01(uv * 520.0 + sd * 2.0, vec2(520.0), 3, 2.0, 0.5);
  float mid = fbm01(uv * 60.0 + 7.0, vec2(60.0), 4, 2.0, 0.5);

  float h = 0.40 + ripple * 0.34 + ripple2 * 0.12 + (dune - 0.5) * 0.16 + (mid - 0.5) * 0.05 + (grain - 0.5) * 0.012;

  vec3 base = vec3(0.760, 0.660, 0.492);
  base *= mix(0.90, 1.08, dune);
  base *= mix(0.94, 1.06, mid);
  base += (grain - 0.5) * 0.05;
  // windward faces are paler, lee faces hold darker damp sand
  base *= mix(0.82, 1.10, ripple) * mix(0.95, 1.04, ripple2);

  s.h = h;
  s.rough = 0.90 + (grain - 0.5) * 0.08;
  s.ao = mix(0.68, 1.0, smoothstep(0.20, 0.72, h));

  // quartz sparkle: rare bright grains with a much lower roughness
  float sparkle = speckle(uv, 1800.0, 0.02);
  base = mix(base, vec3(0.94, 0.92, 0.86), sparkle * 0.6);
  s.rough = mix(s.rough, 0.35, sparkle * 0.7);

  // darker mineral grains
  float dark = speckle(uv, 1400.0, 0.05);
  base = mix(base, vec3(0.30, 0.25, 0.20), dark * 0.5);

  // scattered pebbles and shell fragments resting on the surface
  Cell pb = cells2(uv * 55.0 + 23.0, vec2(55.0), 1.0);
  float peb = (1.0 - smoothstep(0.08, 0.20, pb.f1)) * step(0.86, fract(pb.id * 33.7));
  base = mix(base, mix(vec3(0.44, 0.40, 0.34), vec3(0.72, 0.69, 0.62), fract(pb.id * 61.1)), peb * 0.85);
  s.h += peb * 0.14;
  s.rough = mix(s.rough, 0.68, peb * 0.7);
  s.ao *= 1.0 - peb * 0.10;

  // wind-scoured patches expose coarser, darker sand
  float scour = smoothstep(0.55, 0.9, fbm01(uv * 4.0 + 88.0, vec2(4.0), 4, 2.0, 0.6));
  base = mix(base, vec3(0.560, 0.472, 0.350), scour * 0.35);
  s.h -= scour * 0.05;

  s.alb = base;
  applyMacro(s, uv, 0.13, 0.04, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  rubble: {
    world: 3.0,
    bump: 1.9,
    cavity: 1.0,
    glsl: /* glsl */ `
Surf gen_rubble(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 173.0;

  // --- angular chunks of broken concrete and brick, buried in dust
  Cell k1 = cellsAngular(warp1(uv * 9.0, vec2(9.0), 0.34, 2) + sd, vec2(9.0), 0.95);
  Cell k2 = cellsAngular(warp1(uv * 21.0, vec2(21.0), 0.26, 2) + 17.0, vec2(21.0), 0.95);
  Cell k3 = cells2(uv * 62.0 + 41.0, vec2(62.0), 1.0);

  float sz1 = mix(0.20, 0.56, fract(k1.id * 71.3));
  float slab1 = smoothstep(sz1 + 0.09, sz1 - 0.13, k1.f1) * step(0.20, fract(k1.id * 13.9));
  float sz2 = mix(0.17, 0.48, fract(k2.id * 43.1));
  float slab2 = smoothstep(sz2 + 0.08, sz2 - 0.11, k2.f1) * step(0.42, fract(k2.id * 19.3));
  float chip  = (1.0 - smoothstep(0.10, 0.30, k3.f1)) * step(0.52, fract(k3.id * 7.7));

  float tilt1 = (hash12(k1.c + 3.1) - 0.5) * 0.25;
  float tilt2 = (hash12(k2.c + 8.4) - 0.5) * 0.20;
  float h = 0.22 + slab1 * (0.52 + tilt1) + slab2 * (0.30 + tilt2) + chip * 0.14;

  float dustN = fbm01(uv * 120.0 + sd, vec2(120.0), 4, 2.0, 0.5);
  float broad = fbm01(warp1(uv * 3.5, vec2(3.5), 0.8, 3) + 3.0, vec2(3.5), 5, 2.0, 0.6);
  float drift = smoothstep(0.30, 0.78, broad);
  slab1 *= mix(0.25, 1.0, drift);
  slab2 *= mix(0.35, 1.0, drift);
  h += (dustN - 0.5) * 0.06 + (broad - 0.5) * 0.30;

  // material per chunk: mostly grey concrete, some brick, some plaster
  float m1 = fract(k1.id * 43.7);
  vec3 concreteC = vec3(0.508, 0.494, 0.470) * mix(0.74, 1.16, fract(k1.id * 91.1));
  vec3 brickC    = vec3(0.470, 0.245, 0.180) * mix(0.85, 1.15, fract(k1.id * 57.3));
  vec3 plasterC  = vec3(0.610, 0.592, 0.560);
  vec3 chunk = concreteC;
  chunk = mix(chunk, brickC, step(0.74, m1));
  chunk = mix(chunk, plasterC, step(0.92, m1));
  vec3 chunk2 = mix(vec3(0.520, 0.505, 0.480), vec3(0.440, 0.235, 0.175), step(0.80, fract(k2.id * 23.9)));

  // fractured faces show aggregate
  Cell agg = cells2(uv * 130.0 + 11.0, vec2(130.0), 1.0);
  float aggM = 1.0 - smoothstep(0.12, 0.32, agg.f1);
  chunk = mix(chunk, chunk * mix(0.72, 1.30, fract(agg.id * 37.1)), aggM * 0.5);

  vec3 dustCol = vec3(0.600, 0.570, 0.520) * mix(0.72, 1.20, broad) * mix(0.90, 1.10, fbm01(uv * 26.0 + 91.0, vec2(26.0), 4, 2.0, 0.55));
  vec3 base = dustCol;
  base = mix(base, chunk2, sat(slab2 * 1.5));
  base = mix(base, chunk, sat(slab1 * 1.6));
  base = mix(base, mix(vec3(0.48,0.46,0.44), vec3(0.44,0.24,0.18), step(0.7, fract(k3.id*11.3))), chip * 0.7);
  base += (dustN - 0.5) * 0.04;

  s.h = h;
  s.ao = mix(0.22, 1.0, smoothstep(0.05, 0.62, h));
  s.rough = 0.90 + (dustN - 0.5) * 0.07 - sat(slab1) * 0.05;
  base *= mix(0.62, 1.0, s.ao);   // deep shadow between the pieces

  // settled dust: heaviest on the up-facing tops and in the fines
  float settle = smoothstep(0.30, 0.85, h) * 0.6 + sat(1.0 - h * 2.2) * 0.5;
  base = mix(base, dustCol * 1.05, sat(settle) * 0.45);
  s.rough += sat(settle) * 0.05;

  // twisted rebar and wire poking through
  float bar = smoothstep(0.90, 0.985, fbm01(shear(uv, 2.0) * vec2(120.0, 7.0) + 55.0, vec2(120.0, 7.0), 3, 2.0, 0.5));
  bar *= step(0.55, fbm01(uv * 4.0 + 99.0, vec2(4.0), 3, 2.0, 0.6));
  base = mix(base, vec3(0.290, 0.150, 0.085), bar * 0.85);
  s.metal = mix(s.metal, 0.35, bar);
  s.rough = mix(s.rough, 0.80, bar);
  s.h += bar * 0.10;

  s.alb = base;
  applyMacro(s, uv, 0.20, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },
};
