/**
 * Metal family. Corrosion is modelled the way it actually progresses: a paint
 * film fails at scratches and edges, moisture gets under it, iron oxide blooms
 * outward as a low-opacity stain halo well beyond the pitted core, and the core
 * itself stops being metallic — rust is a rough dielectric, bare steel is not.
 */
const RUST_COMMON = /* glsl */ `
/** Iron-oxide colour ramp, dark scale through orange to powdery ochre. */
vec3 rustRamp(float t, float grain){
  vec3 deep  = vec3(0.190, 0.082, 0.040);
  vec3 mid   = vec3(0.430, 0.180, 0.072);
  vec3 bright= vec3(0.620, 0.300, 0.115);
  vec3 ochre = vec3(0.520, 0.375, 0.215);
  vec3 c = mix(deep, mid, smoothstep(0.0, 0.45, t));
  c = mix(c, bright, smoothstep(0.40, 0.75, t));
  c = mix(c, ochre, smoothstep(0.72, 1.0, t));
  return c * mix(0.82, 1.18, grain);
}

/** Corrosion field: x = pitted core, y = stain halo, z = scale texture. */
vec3 rustField(vec2 uv, float amount, float sd){
  vec2 w = warp2(uv * 6.0, vec2(6.0), 1.1, 4);
  float bloom = fbm01(w + sd, vec2(6.0), 6, 2.0, 0.55);
  float mid   = fbm01(uv * 26.0 + sd * 2.0, vec2(26.0), 5, 2.0, 0.5);
  float scale = fbm01(uv * 130.0 + sd * 3.0, vec2(130.0), 4, 2.0, 0.5);
  Cell pit = cells2(uv * 200.0 + 7.0, vec2(200.0), 1.0);
  float pitting = 1.0 - smoothstep(0.05, 0.22, pit.f1);

  float f = bloom * 0.62 + mid * 0.28 + scale * 0.10;
  float core = smoothstep(0.62 - amount * 0.34, 0.80 - amount * 0.30, f);
  float halo = smoothstep(0.44 - amount * 0.34, 0.74 - amount * 0.30, f);
  return vec3(sat(core + pitting * core * 0.4), halo, scale * 0.6 + mid * 0.4);
}
`;

export const METAL = {
  metal_painted: {
    world: 1.6,
    bump: 0.85,
    cavity: 0.5,
    glsl:
      RUST_COMMON +
      /* glsl */ `
Surf gen_metal_painted(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 401.0;

  // --- rolled steel sheet: faint mill undulation, a couple of shallow dents
  float mill = fbm01(vec2(uv.x * 3.0, uv.y * 20.0) + sd, vec2(3.0, 20.0), 4, 2.0, 0.5);
  float dent = blobs(uv, vec2(5.0), 0.22, 0.30, 0.95, sd + 4.0);
  float h = 0.66 + (mill - 0.5) * 0.05 - dent * 0.16;

  // --- industrial enamel with roller orange-peel
  float peel = fbm01(uv * 170.0 + sd * 2.0, vec2(170.0), 4, 2.0, 0.5);
  float peel2 = fbm01(warp1(uv * 6.0, vec2(6.0), 0.7, 3) + 9.0, vec2(6.0), 5, 2.0, 0.55);
  vec3 paint = vec3(0.190, 0.318, 0.392);                     // works blue-grey
  paint = mix(paint, vec3(0.372, 0.330, 0.180), step(0.5, hash11(sd * 0.37)));  // or olive
  paint *= mix(0.84, 1.16, peel2);
  paint += (peel - 0.5) * 0.02;
  h += (peel - 0.5) * 0.02 + (peel2 - 0.5) * 0.015;

  float rough = 0.36 + (peel - 0.5) * 0.10 + (peel2 - 0.5) * 0.06;

  // chalking from UV exposure lightens and matts the film
  float chalk = smoothstep(0.35, 0.85, fbm01(uv * 3.5 + 33.0, vec2(3.5), 4, 2.0, 0.6)) * uAge;
  paint = mix(paint, paint * 0.72 + 0.20, chalk * 0.55);
  rough += chalk * 0.26;

  // --- damage: scratches through to primer, chips through to bare metal
  float scr = sat(gouges(uv, 2.0, 34.0, 0.20, sd + 11.0) + gouges(uv, -3.0, 26.0, 0.16, sd + 51.0) * 0.8);
  float brush = scratches(uv, 1.0, 240.0, 6.0, 0.62, sd + 5.0) * 0.35;

  float chipGate = smoothstep(0.44, 0.72, fbm01(warp1(uv * 9.0, vec2(9.0), 0.8, 3) + 71.0, vec2(9.0), 5, 2.0, 0.55));
  float chipGate2 = smoothstep(0.58, 0.86, fbm01(uv * 26.0 + 15.0, vec2(26.0), 4, 2.0, 0.5));
  float chip = sat(chipGate * mix(0.7, 1.35, uAge) + chipGate2 * 0.32 + scr * 0.6 - 0.26);
  chip = smoothstep(0.10, 0.46, chip);
  float rim = sat(smoothstep(0.05, 0.22, chip) - smoothstep(0.25, 0.5, chip));

  // --- rust creeping out of every chip and scratch
  vec3 rf = rustField(uv, 0.10 + 0.30 * uAge, sd);
  float rustCore = sat(rf.x * (0.12 + chip * 1.6 + scr * 0.9));
  float rustHalo = sat(rf.y * (0.10 + chip * 1.3 + scr * 0.7));
  vec3 rustCol = rustRamp(rf.z, fbm01(uv * 300.0, vec2(300.0), 3, 2.0, 0.5));

  vec3 bare = vec3(0.395, 0.388, 0.382);
  vec3 primer = vec3(0.400, 0.205, 0.140);

  vec3 base = paint;
  base = mix(base, bare, chip * 0.85);
  base = mix(base, primer, rim * 0.7);
  base = mix(base, rustCol * 1.06, rustHalo * 0.35);
  base = mix(base, rustCol, rustCore * 0.92);
  base = mix(base, base * 0.55, sat(scr) * 0.35);

  float metal = mix(0.0, 1.0, chip * 0.9);
  metal *= 1.0 - rustCore * 0.95;
  metal = max(metal, sat(scr) * 0.5 * (1.0 - rustCore));

  rough = mix(rough, 0.46, chip * 0.8);
  rough = mix(rough, 0.93, rustCore);
  rough = mix(rough, rough + 0.08, rustHalo * 0.4);
  rough += brush;

  h -= chip * 0.16 + rustCore * 0.10 - rustCore * rf.z * 0.14;
  h -= sat(scr) * 0.05;
  s.ao = 1.0 - rustCore * 0.20 - chip * 0.08;

  // runs of rust water down the panel
  float run = runoff(uv, 18.0, sd + 2.0) * sat(rustCore + rustHalo * 0.6);
  base = mix(base, rustCol * 0.85, run * 0.5);
  rough = mix(rough, 0.72, run * 0.4);

  s.alb = base; s.rough = rough; s.metal = metal; s.h = h;
  float grime = turb(uv * 8.0 + 121.0, vec2(8.0), 4, 0.55);
  applyDirt(s, sat(grime * 1.2 - 0.4) * 0.28 * uAge, vec3(0.24, 0.23, 0.21), 0.06);
  applyMacro(s, uv, 0.20, 0.07, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  metal_rusted: {
    world: 1.6,
    bump: 1.9,
    cavity: 0.9,
    deps: [],
    glsl:
      RUST_COMMON +
      /* glsl */ `
Surf gen_metal_rusted(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 433.0;

  vec3 rf = rustField(uv, 0.48, sd);
  float core = rf.x;
  float halo = rf.y;

  // --- what is left of the paint
  float paintMask = sat(1.0 - halo * 1.02);
  vec3 paintCol = vec3(0.225, 0.318, 0.292) * mix(0.82, 1.16, fbm01(uv * 30.0 + 5.0, vec2(30.0), 4, 2.0, 0.5));
  float alligator = crackNet(uv, vec2(80.0), 0.05, 0.95, 0.3);
  paintCol *= 1.0 - alligator * 0.25;

  // --- rust body: flaky lamellar scale with deep pitting through it
  float grain = fbm01(uv * 340.0 + sd, vec2(340.0), 3, 2.0, 0.5);
  float flake = fbmCell(uv * 44.0 + 3.0, vec2(44.0), 3, 0.55, 1.0);
  vec3 rustCol = rustRamp(sat(rf.z * 0.7 + flake * 0.5), grain);

  Cell pit = cells2(uv * 170.0 + 19.0, vec2(170.0), 1.0);
  float pitting = (1.0 - smoothstep(0.04, 0.17, pit.f1)) * step(0.42, fract(pit.id * 31.7));
  Cell deepPit = cells2(uv * 55.0 + 61.0, vec2(55.0), 1.0);
  float deep = (1.0 - smoothstep(0.05, 0.16, deepPit.f1)) * step(0.72, fract(deepPit.id * 17.1));

  // --- bare steel still showing where the corrosion has not reached
  vec3 steel = vec3(0.395, 0.390, 0.384) * mix(0.88, 1.14, fbm01(uv * 90.0 + 77.0, vec2(90.0), 4, 2.0, 0.5));

  vec3 base = steel;
  base = mix(base, paintCol, paintMask * 0.92);
  base = mix(base, mix(base, rustCol, 0.45) * 1.02, sat(halo - core) * 0.85);   // bleed stain
  base = mix(base, rustCol, core);
  base = mix(base, rustCol * 0.55, sat(pitting * core + deep) * 0.7);

  float metal = mix(1.0, 0.0, sat(paintMask * 0.95 + core * 1.1));
  metal = mix(metal, 0.0, sat(pitting * core));

  float rough = mix(0.30, 0.52, paintMask);
  rough = mix(rough, 0.95, core);
  rough = mix(rough, rough + 0.10, sat(halo - core));
  rough += alligator * paintMask * 0.10;

  float plate = fbmCell(uv * 18.0 + 29.0, vec2(18.0), 2, 0.5, 1.0);
  float h = 0.62;
  h += core * (flake - 0.35) * 0.55;                 // scale builds up
  h += core * (plate - 0.45) * 0.30;                 // and lifts in plates
  h -= pitting * core * 0.42 + deep * 0.48;
  h -= alligator * paintMask * 0.05;
  h += paintMask * 0.03;
  float mill = fbm01(vec2(uv.x * 3.0, uv.y * 16.0) + 41.0, vec2(3.0, 16.0), 4, 2.0, 0.5);
  h += (mill - 0.5) * 0.05;

  s.ao = 1.0 - sat(pitting * core * 0.6 + deep * 0.7 + core * 0.15);

  // --- rust-stained water running down and pooling at the bottom of the panel
  float run = runoff(uv, 16.0, sd + 3.0);
  run *= smoothstep(0.15, 0.6, halo);
  base = mix(base, rustRamp(0.55, grain) * 0.80, run * 0.55);
  rough = mix(rough, 0.78, run * 0.4);
  metal *= 1.0 - run * 0.5;

  // deep gouges that expose fresh bright metal
  float gash = gouges(uv, 3.0, 30.0, 0.10, sd + 7.0);
  base = mix(base, vec3(0.52, 0.51, 0.50), sat(gash) * 0.6);
  metal = mix(metal, 0.95, sat(gash) * 0.6);
  rough = mix(rough, 0.28, sat(gash) * 0.6);
  h -= sat(gash) * 0.05;

  s.alb = base; s.rough = rough; s.metal = metal; s.h = h;
  applyMacro(s, uv, 0.15, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  metal_corrugated: {
    world: 2.0,
    bump: 2.2,
    cavity: 0.6,
    glsl:
      RUST_COMMON +
      /* glsl */ `
Surf gen_metal_corrugated(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 467.0;

  // --- profile: 12 sinusoidal ribs across a 2 m sheet (76 mm pitch)
  float ribs = 12.0;
  float phase = fract(uv.x * ribs);
  float prof = sin(phase * TAU - PI * 0.5) * 0.5 + 0.5;
  float slope = abs(cos(phase * TAU - PI * 0.5));       // steepest at mid-flank
  float crest = smoothstep(0.72, 1.0, prof);
  float trough = smoothstep(0.28, 0.0, prof);

  // dents where something has hit the sheet
  float dent = blobs(uv, vec2(4.0), 0.25, 0.28, 0.95, sd + 5.0);
  float h = prof * 0.78 + 0.08 - dent * 0.22;

  // --- galvanised zinc spangle: large flat crystal facets
  Cell sp = cells2(uv * 52.0 + sd, vec2(52.0), 1.0);
  float facet = fract(sp.id * 43.7);
  float spangleEdge = 1.0 - smoothstep(0.0, 0.06, sp.f2 - sp.f1);
  vec3 zinc = vec3(0.552, 0.562, 0.572) * mix(0.78, 1.16, facet);
  zinc = mix(zinc, vec3(0.500, 0.520, 0.545), spangleEdge * 0.5);
  float zincRough = mix(0.22, 0.40, facet) + spangleEdge * 0.15;

  float mill = fbm01(vec2(uv.x * 40.0, uv.y * 6.0) + 3.0, vec2(40.0, 6.0), 4, 2.0, 0.5);
  zinc *= mix(0.94, 1.06, mill);
  h += (mill - 0.5) * 0.02;

  // --- corrosion starts in the troughs where water sits, and along the bottom
  vec3 rf = rustField(uv, 0.18 + 0.32 * uAge, sd + 2.0);
  float wetZone = sat(trough * 1.1 + pow(cos(uv.y * TAU) * 0.5 + 0.5, 3.0) * 0.8);
  float core = sat(rf.x * (0.12 + wetZone * 1.3));
  float halo = sat(rf.y * (0.10 + wetZone * 1.0));
  vec3 rustCol = rustRamp(rf.z, fbm01(uv * 300.0 + 7.0, vec2(300.0), 3, 2.0, 0.5));

  vec3 base = zinc;
  base = mix(base, mix(zinc, rustCol, 0.5) * 1.03, sat(halo - core) * 0.8);
  base = mix(base, rustCol, core * 0.95);

  float metal = 1.0 - core * 0.95 - sat(halo - core) * 0.25;
  float rough = mix(zincRough, 0.94, core);
  rough = mix(rough, rough + 0.12, sat(halo - core));

  Cell pit = cells2(uv * 190.0 + 23.0, vec2(190.0), 1.0);
  float pitting = (1.0 - smoothstep(0.05, 0.18, pit.f1)) * step(0.5, fract(pit.id * 29.3)) * core;
  h -= pitting * 0.14;
  s.ao = 1.0 - pitting * 0.5;

  // --- fixings: hex-head screws with neoprene washers along every third rib
  vec2 fp = vec2(uv.x * ribs, uv.y * 6.0);
  vec2 fi = floor(fp);
  vec2 ff = fract(fp) - 0.5;
  float onCrest = step(0.5, crest) * step(0.66, fract(fi.x / 3.0 + 0.34));
  float fd = length(ff * vec2(1.0, ribs / 6.0));
  float washer = onCrest * (1.0 - smoothstep(0.16, 0.20, fd));
  float head   = onCrest * (1.0 - smoothstep(0.09, 0.11, fd));
  base = mix(base, vec3(0.085, 0.085, 0.090), washer * 0.85);
  base = mix(base, mix(vec3(0.520, 0.525, 0.530), rustCol, core * 0.7 + 0.25), head);
  h += washer * 0.05 + head * 0.06;
  rough = mix(rough, 0.85, washer * 0.8);
  rough = mix(rough, 0.42, head * 0.8);
  metal = mix(metal, 0.0, washer * 0.8);
  metal = mix(metal, 0.95, head * 0.8);
  s.ao *= 1.0 - washer * 0.25;

  // sheet lap joint every half tile
  float lap = 1.0 - smoothstep(0.0, 0.008, abs(fract(uv.x + 0.5) - 0.5));
  h -= lap * 0.06;
  s.ao *= 1.0 - lap * 0.35;
  base *= 1.0 - lap * 0.20;

  // dirt streaks down the troughs
  float streak = runoff(uv, ribs * 2.0, sd + 1.0) * sat(trough + 0.25);
  base = mix(base, base * vec3(0.60, 0.58, 0.56), streak * 0.6);
  rough = mix(rough, 0.70, streak * 0.4);
  metal *= 1.0 - streak * 0.35;

  s.alb = base; s.rough = rough; s.metal = metal; s.h = h;
  applyMacro(s, uv, 0.10, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  steel_brushed: {
    world: 0.8,
    bump: 0.45,
    cavity: 0.25,
    glsl: /* glsl */ `
Surf gen_steel_brushed(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 503.0;

  // --- linear abrasion: three passes of stretched noise at different grits
  float g0 = fbm01(vec2(uv.x * 110.0, uv.y * 2.0) + sd * 3.0, vec2(110.0, 2.0), 3, 2.0, 0.5);
  float g1 = fbm01(vec2(uv.x * 420.0, uv.y * 3.0) + sd, vec2(420.0, 3.0), 3, 2.0, 0.5);
  float g2 = fbm01(vec2(uv.x * 240.0, uv.y * 2.0) + sd * 2.0, vec2(240.0, 2.0), 4, 2.0, 0.5);
  float g3 = fbm01(vec2(uv.x * 900.0, uv.y * 5.0) + 7.0, vec2(900.0, 5.0), 2, 2.0, 0.5);
  float brush = g0 * 0.32 + g1 * 0.28 + g2 * 0.26 + g3 * 0.14;

  // broad mill mottle so the panel is not perfectly even
  float mottle = fbm01(uv * 5.0 + 21.0, vec2(5.0), 5, 2.0, 0.55);

  vec3 base = vec3(0.548, 0.554, 0.566);
  base *= mix(0.80, 1.18, brush);
  base *= mix(0.90, 1.10, mottle);

  float rough = 0.24 + (brush - 0.5) * 0.32 + (mottle - 0.5) * 0.06;
  float h = 0.70 + (brush - 0.5) * 0.05 + (g3 - 0.5) * 0.02;

  // --- hero scratches crossing the grain
  float cross = sat(gouges(uv, -2.0, 40.0, 0.12, sd + 3.0) * 0.9 + gouges(uv, 5.0, 28.0, 0.08, sd + 31.0) * 0.7);
  base = mix(base, vec3(0.660, 0.665, 0.670), cross * 0.5);
  rough = mix(rough, 0.42, cross * 0.7);
  h -= cross * 0.05;

  // --- fingerprints and grease smears kill the specular locally
  float smear = smoothstep(0.55, 0.85, fbm01(warp2(uv * 7.0, vec2(7.0), 1.2, 3) + 55.0, vec2(7.0), 5, 2.0, 0.55));
  float ridged1 = smoothstep(0.6, 0.75, fbm01(uv * 130.0 + 3.0, vec2(130.0), 3, 2.0, 0.5));
  float print = smear * mix(0.6, 1.0, ridged1);
  rough = mix(rough, 0.44, print * 0.7);
  base = mix(base, base * 0.94, print * 0.5);
  s.ao = 1.0 - print * 0.04;

  // --- shallow dings and a light dust film
  float ding = blobs(uv, vec2(9.0), 0.14, 0.16, 0.85, sd + 9.0);
  h -= ding * 0.12;
  rough += ding * 0.06;

  float dust = turb(uv * 11.0 + 91.0, vec2(11.0), 4, 0.55);
  dust = sat(dust * 1.1 - 0.42) * 0.5 * uAge;
  base = mix(base, vec3(0.44, 0.43, 0.41), dust * 0.35);
  rough = mix(rough, 0.55, dust * 0.5);

  s.alb = base;
  s.rough = rough;
  s.metal = 1.0 - dust * 0.35 - print * 0.10;
  s.h = h;
  applyMacro(s, uv, 0.06, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  gun_metal: {
    world: 0.5,
    bump: 0.62,
    cavity: 0.35,
    glsl: /* glsl */ `
Surf gen_gun_metal(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 541.0;

  // --- manganese phosphate (parkerised) finish: fine crystalline matte grey
  Cell xtal = cells2(uv * 330.0 + sd, vec2(330.0), 1.0);
  float xt = fract(xtal.id * 37.3);
  float crystal = 1.0 - smoothstep(0.10, 0.45, xtal.f1);
  float grain = fbm01(uv * 420.0 + sd * 2.0, vec2(420.0), 3, 2.0, 0.5);
  float mottle = fbm01(uv * 12.0 + 9.0, vec2(12.0), 5, 2.0, 0.55);

  vec3 park = vec3(0.148, 0.148, 0.156);
  park *= mix(0.52, 1.62, sat(xt * crystal * 1.15 + grain * 0.6));
  park *= mix(0.88, 1.12, mottle);

  float rough = 0.62 + (grain - 0.5) * 0.10 - crystal * 0.06 + (mottle - 0.5) * 0.06;
  float h = 0.66 + crystal * 0.05 + (grain - 0.5) * 0.03;

  // --- machining marks: fine parallel tool passes under the finish
  float tool = fbm01(vec2(uv.x * 6.0, uv.y * 700.0) + 3.0, vec2(6.0, 700.0), 3, 2.0, 0.5);
  park *= mix(0.94, 1.06, tool);
  rough += (tool - 0.5) * 0.06;
  h += (tool - 0.5) * 0.015;

  // --- holster and edge wear: the phosphate polishes through to bright steel
  float wearField = fbm01(warp1(uv * 6.0, vec2(6.0), 0.8, 3) + 61.0, vec2(6.0), 5, 2.0, 0.55);
  float wear = smoothstep(0.50, 0.80, wearField) * mix(0.6, 1.4, uAge);
  float polish = smoothstep(0.72, 0.95, wearField) * mix(0.4, 1.2, uAge);
  vec3 steel = vec3(0.400, 0.400, 0.405);
  park = mix(park, steel * 0.72, sat(wear) * 0.7);
  park = mix(park, steel, sat(polish) * 0.85);
  rough = mix(rough, 0.30, sat(wear) * 0.6);
  rough = mix(rough, 0.16, sat(polish) * 0.8);

  // --- handling scratches and carry dings
  float scr = sat(gouges(uv, 2.0, 60.0, 0.14, sd + 11.0) * 0.8 + gouges(uv, -4.0, 44.0, 0.10, sd + 77.0) * 0.6);
  park = mix(park, vec3(0.470), scr * 0.55);
  rough = mix(rough, 0.22, scr * 0.6);
  h -= scr * 0.04;

  float ding = blobs(uv, vec2(16.0), 0.10, 0.13, 0.7, sd + 5.0);
  h -= ding * 0.12;
  park = mix(park, vec3(0.36), ding * 0.35);
  rough += ding * 0.06;

  // --- a film of gun oil sits in the tool marks and pools in the low spots
  float oil = smoothstep(0.45, 0.85, fbm01(uv * 9.0 + 133.0, vec2(9.0), 5, 2.0, 0.55));
  oil *= sat(1.0 - h * 1.1 + 0.35);
  park *= mix(1.0, 0.82, oil * 0.6);
  rough = mix(rough, 0.20, oil * 0.55);

  // carbon fouling near the muzzle end of the UV range
  float carbon = smoothstep(0.55, 0.95, fbm01(uv * 16.0 + 201.0, vec2(16.0), 4, 2.0, 0.55)) * uAge;
  park = mix(park, vec3(0.030, 0.028, 0.028), carbon * 0.5);
  rough += carbon * 0.12;

  s.alb = park;
  s.rough = rough;
  s.metal = sat(0.92 - carbon * 0.25);
  s.h = h;
  s.ao = 1.0 - ding * 0.15;
  applyMacro(s, uv, 0.08, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },
};
