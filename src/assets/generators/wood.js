/**
 * Timber family. Growth rings are built as a warped ring parameter that knots
 * pull on (the way real grain swirls around a branch scar) rather than as a
 * stripe pattern; everything else — weathered boarding, chipped paint, rotary
 * cut plywood, oiled walnut and furrowed bark — layers on top of that.
 */
const WOOD_COMMON = /* glsl */ `
/** Ring parameter for boards running along U. Knots drag the rings around them. */
float ringParam(vec2 uv, vec2 stretch, float freq, float warpAmt, float knotFreq, float sd, out float knot, out float knotCore){
  vec2 per = stretch;
  vec2 p = vec2(uv.x * stretch.x, uv.y * stretch.y) + sd;
  float w = fbm(p, per, 5, 2.0, 0.55);
  float w2 = fbm(p * 2.0 + 13.0, per * 2.0, 4, 2.0, 0.5);

  knot = 0.0; knotCore = 0.0;
  float pull = 0.0;
  if (knotFreq > 0.0) {
    vec2 kp = uv * knotFreq;
    Cell kc = cells2(kp, vec2(knotFreq), 1.0);
    float present = step(0.62, fract(kc.id * 17.7));
    vec2 rr = kc.r * vec2(1.0, 2.2);   // knots read as ellipses across the board
    float d = length(rr);
    float kr = mix(0.10, 0.24, fract(kc.id * 53.3)) * present;
    knot = present * (1.0 - smoothstep(kr * 0.6, kr * 2.2, d));
    knotCore = present * (1.0 - smoothstep(kr * 0.45, kr * 0.85, d));
    pull = present * kr * 2.6 / (d + kr * 0.55);
  }
  return uv.y * freq + (w * warpAmt + w2 * warpAmt * 0.35) * freq + pull * freq * 0.30;
}

/** Latewood/earlywood banding from a ring parameter. */
float ringBand(float t){
  float g = fract(t);
  float band = smoothstep(0.55, 0.80, g) * (1.0 - smoothstep(0.86, 1.0, g));
  return band + smoothstep(0.0, 0.10, g) * 0.15;
}
`;

export const WOOD = {
  wood_plank: {
    world: 3.0,
    bump: 1.15,
    cavity: 0.7,
    glsl:
      WOOD_COMMON +
      /* glsl */ `
Surf gen_wood_plank(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 201.0;

  // 7 boards across a 3 m tile ≈ 140 mm face, random butt joints along the run
  Unit u = plankLayout(uv, 7.0, 3.0, 0.05);
  vec3 pr = hash32(u.id + sd);

  float knot, knotCore;
  vec2 luv = vec2(uv.x, u.local.y);
  float t = ringParam(luv + pr.xy * 4.0, vec2(3.0, 24.0), 9.0, 0.55, 6.0, pr.z * 20.0, knot, knotCore);
  float band = ringBand(t);

  // long fibre streaks running the length of the board
  float fibre = fbm01(vec2(uv.x * 4.0, u.local.y * 210.0) + pr.x * 9.0, vec2(4.0, 210.0), 4, 2.0, 0.5);
  float fibre2 = fbm01(vec2(uv.x * 30.0, u.local.y * 90.0) + 3.0, vec2(30.0, 90.0), 3, 2.0, 0.5);

  // weathered softwood: silvered grey over the original warm tone
  vec3 warm = vec3(0.535, 0.378, 0.226);
  vec3 silver = vec3(0.512, 0.487, 0.446);
  float weather = sat(0.30 + 0.50 * uAge + (pr.y - 0.5) * 0.62);
  vec3 base = mix(warm, silver, weather);
  base = jitterHSV(base, pr, 0.026, 0.42, 0.30);

  base *= mix(1.14, 0.66, band);              // latewood is darker and harder
  base *= mix(0.90, 1.08, fibre);
  base *= mix(0.96, 1.04, fibre2);

  float h = 0.62 - band * 0.16 + (fibre - 0.5) * 0.10 + (fibre2 - 0.5) * 0.04;
  float rough = 0.80 + band * 0.06 + (fibre - 0.5) * 0.10 + weather * 0.08;

  // knots: dense, dark, resinous, sometimes checked through the middle
  base = mix(base, vec3(0.180, 0.105, 0.062), knot * 0.75);
  base = mix(base, vec3(0.095, 0.055, 0.035), knotCore * 0.85);
  h -= knotCore * 0.10;
  h += knot * 0.03;
  rough = mix(rough, 0.55, knotCore * 0.6);

  // surface checking: fine splits opening along the grain
  float check = smoothstep(0.80, 0.95, fbm01(vec2(uv.x * 3.0, u.local.y * 300.0) + 71.0, vec2(3.0, 300.0), 3, 2.0, 0.5));
  check *= smoothstep(0.25, 0.7, weather);
  h -= check * 0.24;
  base *= 1.0 - check * 0.45;
  s.ao *= 1.0 - check * 0.5;

  // board gaps and butt joints
  h -= u.joint * 0.55;
  base *= 1.0 - u.joint * 0.55;
  s.ao *= mix(1.0, 0.30, u.joint);
  rough += u.joint * 0.08;

  // slight cupping across each board
  float cup = 1.0 - sq((u.local.y - 0.5) * 2.0);
  h += cup * 0.06 * (0.5 + pr.z * 0.5);

  // nails: two per board end, rusted, sitting a fraction proud
  vec2 np = vec2(fract(uv.x * 3.0 + hash12(u.id + 5.0) * 0.13), u.local.y);
  float nd = min(length((np - vec2(0.5, 0.26)) * vec2(3.0, 1.0)),
                 length((np - vec2(0.5, 0.74)) * vec2(3.0, 1.0)));
  float nail = 1.0 - smoothstep(0.020, 0.028, nd);
  float nailRing = (1.0 - smoothstep(0.028, 0.045, nd)) * smoothstep(0.018, 0.030, nd);
  base = mix(base, vec3(0.230, 0.135, 0.078), nail * 0.9);
  base = mix(base, vec3(0.330, 0.190, 0.110), nailRing * 0.55);
  h -= nail * 0.10;
  s.ao *= 1.0 - nail * 0.35;
  rough = mix(rough, 0.72, nail);
  s.metal = mix(s.metal, 0.25, nail * 0.6);

  // green algae on the damp lower boards
  float algae = smoothstep(0.62, 0.92, fbm01(uv * 7.0 + 133.0, vec2(7.0), 5, 2.0, 0.55)) * uAge;
  base = mix(base, vec3(0.180, 0.205, 0.125), algae * 0.45);
  rough += algae * 0.05;

  s.h = h; s.rough = rough; s.alb = base;
  applyMacro(s, uv, 0.14, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  wood_painted: {
    world: 3.0,
    bump: 1.0,
    cavity: 0.6,
    glsl:
      WOOD_COMMON +
      /* glsl */ `
Surf gen_wood_painted(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 233.0;

  Unit u = plankLayout(uv, 6.0, 2.0, 0.045);
  vec3 pr = hash32(u.id + sd);

  // --- substrate showing wherever the paint has failed
  float knot, knotCore;
  float t = ringParam(vec2(uv.x, u.local.y) + pr.xy * 3.0, vec2(3.0, 20.0), 8.0, 0.5, 5.0, pr.z * 17.0, knot, knotCore);
  float band = ringBand(t);
  float fibre = fbm01(vec2(uv.x * 8.0, u.local.y * 220.0) + pr.x * 7.0, vec2(8.0, 220.0), 4, 2.0, 0.5);
  vec3 bare = vec3(0.400, 0.290, 0.185) * mix(1.10, 0.76, band) * mix(0.90, 1.08, fibre);
  bare = mix(bare, vec3(0.150, 0.090, 0.055), knotCore * 0.7);
  float bareRough = 0.86 + band * 0.05;

  // --- paint: institutional eggshell, brushed on in the direction of the grain
  vec3 paintCol = vec3(0.215, 0.330, 0.290);                       // faded sage green
  paintCol = mix(paintCol, vec3(0.560, 0.520, 0.430), step(0.55, hash12(vec2(sd)))); // or bone white
  paintCol = jitterHSV(paintCol, pr, 0.015, 0.15, 0.12);
  float brush = fbm01(vec2(uv.x * 12.0, u.local.y * 130.0) + 5.0, vec2(12.0, 130.0), 4, 2.0, 0.5);
  paintCol *= mix(0.90, 1.10, brush);
  float orange = fbm01(uv * 190.0 + 31.0, vec2(190.0), 3, 2.0, 0.5);   // orange-peel from the roller
  paintCol *= mix(0.97, 1.03, orange);

  // sun bleaching and chalking on the exposed faces
  float chalk = smoothstep(0.35, 0.85, fbm01(uv * 3.0 + 61.0, vec2(3.0), 4, 2.0, 0.6)) * uAge;
  paintCol = mix(paintCol, paintCol * 0.75 + 0.22, chalk * 0.5);

  float paintRough = 0.42 + (orange - 0.5) * 0.10 + chalk * 0.28;

  // --- failure: alligatored film, then flakes lifting from the edges outward
  float alligator = crackNet(uv, vec2(70.0), 0.055, 0.95, 0.35);
  float flakeGate = smoothstep(0.34, 0.72, fbm01(warp1(uv * 5.0, vec2(5.0), 0.7, 3) + 88.0, vec2(5.0), 5, 2.0, 0.55));
  float flake = crackNet(uv, vec2(14.0), 0.10, 0.9, 0.55);
  float lost = sat(smoothstep(0.45, 0.62, flakeGate * 0.75 + flake * 0.45 + alligator * 0.15) +
                   u.joint * 0.7 + knotCore * 0.5);
  lost = sat(lost * mix(0.55, 1.25, uAge));

  // primer band around each flake edge
  float rim = sat(smoothstep(0.30, 0.50, lost) - smoothstep(0.50, 0.66, lost));

  vec3 base = mix(paintCol, bare, lost);
  base = mix(base, vec3(0.430, 0.215, 0.145), rim * 0.55);          // red-oxide primer
  float rough = mix(paintRough, bareRough, lost);

  float h = 0.62 - lost * 0.12 + (orange - 0.5) * 0.03 - band * 0.05 * lost;
  h -= alligator * 0.05 * (1.0 - lost);
  s.ao = mix(1.0, 0.72, lost) * (1.0 - alligator * 0.20);

  // board gaps
  h -= u.joint * 0.5;
  base *= 1.0 - u.joint * 0.5;
  s.ao *= mix(1.0, 0.35, u.joint);

  // dirt lodges in the chips and along the bottom edge of every board
  float grime = sat(lost * 0.5 + u.joint * 0.6 + smoothstep(0.6, 1.0, 1.0 - u.local.y) * 0.35);
  grime *= smoothstep(0.2, 0.8, fbm01(uv * 6.0 + 21.0, vec2(6.0), 4, 2.0, 0.55));
  s.alb = base; s.rough = rough; s.h = h;
  applyDirt(s, grime * 0.42 * uAge, vec3(0.26, 0.24, 0.21), 0.10);

  float scuff = gouges(uv, 4.0, 28.0, 0.14, sd + 9.0);
  s.alb *= 1.0 - sat(scuff) * 0.20;
  s.rough += sat(scuff) * 0.10;

  applyMacro(s, uv, 0.12, 0.06, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  plywood: {
    world: 2.44,
    bump: 1.0,
    cavity: 0.5,
    glsl:
      WOOD_COMMON +
      /* glsl */ `
Surf gen_plywood(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 271.0;

  // rotary-cut face veneer: broad cathedral figure, low contrast, few knots
  float knot, knotCore;
  float t = ringParam(uv * vec2(1.0, 1.0) + sd, vec2(2.0, 9.0), 5.0, 1.25, 4.0, sd, knot, knotCore);
  float band = ringBand(t);
  float fibre = fbm01(vec2(uv.x * 5.0, uv.y * 300.0) + sd, vec2(5.0, 300.0), 4, 2.0, 0.5);
  float blotch = fbm01(uv * 7.0 + 11.0, vec2(7.0), 5, 2.0, 0.55);

  vec3 base = vec3(0.610, 0.470, 0.300);
  base *= mix(1.06, 0.80, band);
  base *= mix(0.90, 1.10, blotch);
  base *= mix(0.95, 1.05, fibre);

  float h = 0.66 - band * 0.06 + (fibre - 0.5) * 0.05;
  float rough = 0.74 + (fibre - 0.5) * 0.10 + band * 0.04;

  base = mix(base, vec3(0.230, 0.150, 0.085), knot * 0.55);
  base = mix(base, vec3(0.120, 0.075, 0.045), knotCore * 0.8);
  h -= knotCore * 0.06;

  // --- oval veneer patches ("footballs") glued in where a defect was cut out
  vec2 pp = uv * vec2(3.0, 4.0);
  vec2 pi = floor(pp), pf = fract(pp) - 0.5;
  vec3 prr = hash32(pi + 3.3);
  pf += (prr.xy - 0.5) * 0.4;
  float pd = length(pf * vec2(1.0, 2.6));
  float repairArea = step(0.72, prr.z) * (1.0 - smoothstep(0.20, 0.24, pd));
  float repairEdge = step(0.72, prr.z) * (1.0 - smoothstep(0.24, 0.27, pd)) * smoothstep(0.185, 0.235, pd);
  base = mix(base, vec3(0.560, 0.410, 0.255) * mix(0.9, 1.1, prr.x), repairArea * 0.9);
  base *= 1.0 - repairEdge * 0.45;
  h -= repairEdge * 0.05;
  s.ao *= 1.0 - repairEdge * 0.35;

  // --- sheet edges: the 2.44 m board joint with its exposed core plies
  float ex = min(fract(uv.x), 1.0 - fract(uv.x));
  float ey = min(fract(uv.y), 1.0 - fract(uv.y));
  float edge = 1.0 - smoothstep(0.0, 0.006, min(ex, ey));
  h -= edge * 0.35;
  base *= 1.0 - edge * 0.45;
  s.ao *= 1.0 - edge * 0.6;

  // --- screw fixings around the perimeter
  vec2 sp = uv * vec2(8.0, 8.0);
  vec2 si = floor(sp), sf = fract(sp) - 0.5;
  float onEdge = step(0.86, max(abs(fract(uv.x) - 0.5), abs(fract(uv.y) - 0.5)) * 2.0);
  float sdst = length(sf);
  float screw = onEdge * (1.0 - smoothstep(0.10, 0.14, sdst)) * step(0.35, hash12(si + 7.1));
  float cross = onEdge * step(0.35, hash12(si + 7.1)) *
                (1.0 - smoothstep(0.02, 0.035, min(abs(sf.x), abs(sf.y)))) * (1.0 - smoothstep(0.09, 0.12, sdst));
  h -= screw * 0.10 + cross * 0.18;
  base = mix(base, vec3(0.300, 0.290, 0.275), screw * 0.7);
  s.metal = mix(s.metal, 0.9, screw * 0.8);
  rough = mix(rough, 0.48, screw * 0.8);
  s.ao *= 1.0 - (screw * 0.2 + cross * 0.5);

  // --- water staining: dark tide lines and swollen, fuzzy fibre
  float water = smoothstep(0.42, 0.80, fbm01(warp1(uv * 4.0, vec2(4.0), 0.9, 3) + 55.0, vec2(4.0), 5, 2.0, 0.55));
  float tide = sat(1.0 - abs(water - 0.55) * 9.0);
  base = mix(base, vec3(0.330, 0.250, 0.150), water * 0.45 * uAge);
  base = mix(base, vec3(0.220, 0.160, 0.095), tide * 0.45 * uAge);
  rough += water * 0.12 * uAge;
  h += water * 0.03;

  // stencilled grade stamp, deliberately faint
  float stamp = (1.0 - smoothstep(0.10, 0.13, length((fract(uv * vec2(2.0, 3.0)) - 0.5) * vec2(1.0, 3.0))));
  stamp *= step(0.75, hash12(floor(uv * vec2(2.0, 3.0)) + 13.0));
  stamp *= smoothstep(0.4, 0.7, fbm01(uv * 90.0, vec2(90.0), 3, 2.0, 0.5));
  base = mix(base, vec3(0.28, 0.26, 0.30), stamp * 0.35);

  s.h = h; s.rough = rough; s.alb = base;
  float grime = sat(edge * 0.5 + turb(uv * 8.0 + 99.0, vec2(8.0), 4, 0.55) * 0.8 - 0.25);
  applyDirt(s, grime * 0.25 * uAge, vec3(0.30, 0.27, 0.23), 0.08);
  applyMacro(s, uv, 0.13, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  gun_wood: {
    world: 0.6,
    bump: 0.75,
    cavity: 0.4,
    glsl:
      WOOD_COMMON +
      /* glsl */ `
Surf gen_gun_wood(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 307.0;

  // oiled walnut: tight figure, strong chatoyance, open pores
  float knot, knotCore;
  float t = ringParam(uv, vec2(3.0, 16.0), 14.0, 0.85, 0.0, sd, knot, knotCore);
  float band = ringBand(t);
  float fiddle = sin((uv.x * 9.0 + fbm(uv * vec2(3.0, 8.0), vec2(3.0, 8.0), 4, 2.0, 0.5) * 2.2) * TAU) * 0.5 + 0.5;
  float fibre = fbm01(vec2(uv.x * 6.0, uv.y * 320.0) + sd, vec2(6.0, 320.0), 4, 2.0, 0.5);
  float broad = fbm01(uv * 4.0 + 9.0, vec2(4.0), 5, 2.0, 0.6);

  vec3 dark = vec3(0.196, 0.105, 0.058);
  vec3 light = vec3(0.432, 0.238, 0.130);
  vec3 base = mix(light, dark, sat(band * 1.35 + broad * 0.55 - 0.12));
  base *= mix(0.78, 1.26, fibre);
  base *= mix(0.80, 1.24, fiddle);           // ribbon figure catches the light

  // open grain pores: tiny dark elongated pits, the giveaway of real walnut
  float pore = smoothstep(0.72, 0.90, fbm01(vec2(uv.x * 40.0, uv.y * 520.0) + 21.0, vec2(40.0, 520.0), 3, 2.0, 0.5));
  base *= 1.0 - pore * 0.35;
  float h = 0.68 - pore * 0.22 - band * 0.05 + (fibre - 0.5) * 0.04;
  s.ao = 1.0 - pore * 0.35;

  // hand-rubbed oil finish: satin, with the roughness varying with the figure
  float rough = 0.34 - fiddle * 0.10 + (fibre - 0.5) * 0.06 + pore * 0.26;

  // handling wear: the finish is polished through on the high spots
  float wear = smoothstep(0.55, 0.9, fbm01(uv * 5.0 + 77.0, vec2(5.0), 5, 2.0, 0.55));
  rough = mix(rough, 0.52, wear * 0.5);
  base = mix(base, base * 1.25, wear * 0.30);

  // dings and handling marks
  float ding = blobs(uv, vec2(14.0), 0.10, 0.16, 0.4, sd + 3.0);
  h -= ding * 0.10;
  base *= 1.0 - ding * 0.15;
  rough += ding * 0.10;
  float scr = gouges(uv, 3.0, 46.0, 0.10, sd + 41.0);
  base *= 1.0 - sat(scr) * 0.18;
  rough += sat(scr) * 0.12;
  h -= sat(scr) * 0.03;

  s.h = h; s.rough = rough; s.alb = base;
  applyMacro(s, uv, 0.09, 0.04, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  bark: {
    world: 1.2,
    bump: 2.0,
    cavity: 1.0,
    glsl: /* glsl */ `
Surf gen_bark(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 349.0;

  // --- deep vertical furrows: ridged noise stretched hard along V
  vec2 p = vec2(uv.x * 10.0, uv.y * 2.0);
  vec2 per = vec2(10.0, 2.0);
  vec2 wp = p + vec2(fbm(p * 1.7, per * 1.7, 4, 2.0, 0.5), fbm(p * 1.3 + 7.0, per * 1.3, 4, 2.0, 0.5)) * 0.9;
  float furrow = ridged(wp, per, 5, 0.55);
  furrow = pow(sat(furrow), 0.8);

  // --- plates: the ridges break into horizontal segments
  Cell plate = cellsAngular(vec2(uv.x * 11.0, uv.y * 5.0) + 3.0, vec2(11.0, 5.0), 0.95);
  float plateEdge = 1.0 - smoothstep(0.0, 0.16, plate.f2 - plate.f1);
  float plateLift = (hash12(plate.c + 1.3) - 0.5) * 0.18;

  float fine = fbm01(vec2(uv.x * 60.0, uv.y * 22.0) + sd, vec2(60.0, 22.0), 4, 2.0, 0.5);
  float micro = fbm01(uv * 380.0 + sd * 2.0, vec2(380.0), 3, 2.0, 0.5);

  float h = furrow * 0.72 + 0.10 + plateLift * furrow;
  h -= plateEdge * 0.20;
  h += (fine - 0.5) * 0.10 + (micro - 0.5) * 0.04;

  // colour: grey-brown outer bark, warm cambium deep in the fissures
  vec3 outer = vec3(0.320, 0.282, 0.238);
  vec3 inner = vec3(0.168, 0.122, 0.088);
  vec3 pale  = vec3(0.492, 0.462, 0.415);
  vec3 base = mix(inner, outer, smoothstep(0.10, 0.60, h));
  base = mix(base, pale, smoothstep(0.60, 0.95, h) * 0.55);
  base *= mix(0.85, 1.15, fine);
  base += (micro - 0.5) * 0.03;
  base = jitterHSV(base, vec3(fract(plate.id * 27.7), 0.5, fract(plate.id * 91.1)), 0.012, 0.20, 0.18);

  s.h = h;
  s.ao = mix(0.22, 1.0, smoothstep(0.05, 0.70, h)) * (1.0 - plateEdge * 0.35);
  s.rough = 0.92 + (micro - 0.5) * 0.06 - smoothstep(0.6, 1.0, h) * 0.05;

  // --- lichen and moss: pale crusts on the ridges, green in the damp fissures
  float lichen = smoothstep(0.52, 0.88, fbm01(warp1(uv * 7.0, vec2(7.0), 0.8, 3) + 41.0, vec2(7.0), 5, 2.0, 0.55));
  lichen *= smoothstep(0.45, 0.85, h);
  base = mix(base, vec3(0.560, 0.575, 0.500), lichen * 0.55);
  s.rough += lichen * 0.05;
  s.h += lichen * 0.03;

  float moss = smoothstep(0.60, 0.92, fbm01(uv * 12.0 + 133.0, vec2(12.0), 5, 2.0, 0.55));
  moss *= sat(1.0 - smoothstep(0.15, 0.55, h)) * (0.4 + 0.6 * uAge);
  base = mix(base, vec3(0.130, 0.185, 0.085), moss * 0.7);
  s.rough += moss * 0.06;

  // sap runs and beetle galleries
  float sap = runoff(uv, 14.0, sd) * smoothstep(0.5, 0.9, fbm01(uv * 3.0 + 61.0, vec2(3.0), 3, 2.0, 0.6));
  base = mix(base, vec3(0.230, 0.150, 0.075), sap * 0.4);
  s.rough = mix(s.rough, 0.55, sap * 0.4);

  s.alb = base;
  applyMacro(s, uv, 0.18, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },
};
