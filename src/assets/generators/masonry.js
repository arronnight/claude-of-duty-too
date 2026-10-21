/**
 * Masonry family: poured concrete, fired brick, interior plaster, exterior
 * stucco render and clay pantiles. All modelled from how the material is
 * actually made — form-board seams and tie holes in poured concrete, running
 * bond with recessed struck mortar in brick, trowel undulation in plaster.
 */
export const MASONRY = {
  concrete_wall: {
    world: 3.0,
    bump: 1.55,
    cavity: 0.7,
    glsl: /* glsl */ `
Surf gen_concrete_wall(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed;

  // --- cement paste: sandy micro grain over a broad pour mottle
  float grain  = fbm01(uv * 300.0 + sd, vec2(300.0), 3, 2.0, 0.55);
  float fine   = fbm01(uv * 74.0 + sd * 3.1, vec2(74.0), 4, 2.0, 0.5);
  float mottle = fbm01(warp1(uv * 9.0, vec2(9.0), 0.6, 3) + sd * 2.0, vec2(9.0), 5, 2.0, 0.55);

  vec3 base = vec3(0.560, 0.548, 0.522);
  base *= mix(0.74, 1.22, mottle);
  base *= mix(0.90, 1.10, fine);
  base += (grain - 0.5) * 0.075;

  s.h     = 0.58 + (mottle - 0.5) * 0.08 + (fine - 0.5) * 0.05 + (grain - 0.5) * 0.035;
  s.rough = 0.87 + (grain - 0.5) * 0.10 - (mottle - 0.5) * 0.06;

  // --- aggregate ghosting just under the skin
  Cell ag = cells2(uv * 160.0 + 11.0, vec2(160.0), 1.0);
  float stone = 1.0 - smoothstep(0.12, 0.34, ag.f1);
  base = mix(base, mix(vec3(0.40, 0.385, 0.365), vec3(0.72, 0.68, 0.62), fract(ag.id * 53.7)), stone * 0.30);
  s.h += stone * 0.015;

  // --- pinholes and bug holes from trapped air against the shutter
  Cell bh = cells2(uv * 40.0 + 31.0, vec2(40.0), 1.0);
  float hole = (1.0 - smoothstep(0.04, 0.12, bh.f1)) * step(0.85, fract(bh.id * 23.1));
  Cell ph = cells2(uv * 130.0 + 71.0, vec2(130.0), 1.0);
  float pin = (1.0 - smoothstep(0.03, 0.09, ph.f1)) * step(0.72, fract(ph.id * 41.9));
  float voids = sat(hole + pin * 0.6);
  s.h -= voids * 0.16;
  s.ao *= 1.0 - voids * 0.55;
  base *= 1.0 - voids * 0.22;
  s.rough += voids * 0.07;

  // --- form-board seams: horizontal shutter joints with a proud lip of grout
  float bw = fract(uv.y * 5.0 + fbm(uv * vec2(3.0, 1.0), vec2(3.0, 1.0), 3, 2.0, 0.5) * 0.012);
  float dSeam = min(bw, 1.0 - bw);
  float seam = 1.0 - smoothstep(0.0, 0.010, dSeam);
  float lip  = (1.0 - smoothstep(0.008, 0.026, dSeam)) * step(0.5, bw);
  s.h += lip * 0.10 - seam * 0.09;
  base *= 1.0 - seam * 0.22 + lip * 0.06;
  s.ao *= 1.0 - seam * 0.35;

  // vertical panel joint between shutter panels
  float pw = fract(uv.x * 2.0 + 0.25);
  float dPan = min(pw, 1.0 - pw);
  float pan = 1.0 - smoothstep(0.0, 0.006, dPan);
  s.h -= pan * 0.10;
  base *= 1.0 - pan * 0.26;
  s.ao *= 1.0 - pan * 0.4;

  // --- form-tie cone holes on a regular grid, most of them plugged
  vec2 tp = uv * vec2(4.0, 5.0);
  vec2 ti = floor(tp);
  vec2 tf = fract(tp) - vec2(0.5, 0.5) + (hash22(ti + 4.4) - 0.5) * 0.10;
  float td = length(tf * vec2(1.0, 1.0));
  float present = step(0.18, hash12(ti + 9.1));
  float tie  = (1.0 - smoothstep(0.020, 0.030, td)) * present;
  float ring = (1.0 - smoothstep(0.030, 0.046, td)) * smoothstep(0.020, 0.032, td) * present;
  s.h -= tie * 0.30;
  s.h += ring * 0.05;
  s.ao *= 1.0 - tie * 0.7;
  base *= 1.0 - tie * 0.35 + ring * 0.10;
  base = mix(base, vec3(0.50, 0.47, 0.44), ring * 0.5);

  // --- hairline shrinkage cracks, gated so they cluster rather than blanket
  float crackGate = smoothstep(0.56, 0.86, fbm01(uv * 2.5 + 55.0, vec2(2.5), 4, 2.0, 0.6));
  float ck = crackNet(uv, vec2(9.0), 0.020, 0.95, 0.34) * crackGate;
  ck = max(ck, crackNet(uv, vec2(28.0), 0.030, 0.9, 0.28) * crackGate * 0.55);
  s.h -= ck * 0.22;
  s.ao *= 1.0 - ck * 0.6;
  base *= 1.0 - ck * 0.40;

  // --- spalling: the skin has broken away, exposing coarse aggregate
  float spall = blobs(uv, vec2(6.0), 0.10, 0.30, 0.55, sd + 3.0);
  spall = sat(spall * 1.4 - fbm01(uv * 30.0, vec2(30.0), 3, 2.0, 0.5) * 0.5);
  Cell coarse = cells2(uv * 70.0 + 5.0, vec2(70.0), 1.0);
  vec3 aggCol = mix(vec3(0.36, 0.34, 0.32), vec3(0.66, 0.61, 0.55), fract(coarse.id * 31.3));
  base = mix(base, aggCol, spall * 0.8);
  s.h -= spall * 0.20;
  s.h += spall * (1.0 - smoothstep(0.1, 0.4, coarse.f1)) * 0.12;
  s.ao *= 1.0 - spall * 0.35;
  s.rough += spall * 0.06;

  // --- rain streaking and efflorescence
  float rain = sat(runoff(uv, 38.0, sd + 1.0) * 1.4 - 0.28) * (0.55 + 0.45 * uAge);
  rain *= smoothstep(0.25, 0.7, fbm01(uv * 4.0 + 21.0, vec2(4.0), 3, 2.0, 0.55));
  base = mix(base, base * vec3(0.62, 0.60, 0.58), rain * 0.85);
  s.rough = mix(s.rough, 0.70, rain * 0.6);

  float eff = blobs(uv, vec2(9.0), 0.16, 0.34, 0.85, sd + 8.0);
  eff *= smoothstep(0.3, 0.8, fbm01(uv * vec2(14.0, 5.0) + 3.0, vec2(14.0, 5.0), 4, 2.0, 0.5));
  base = mix(base, vec3(0.80, 0.79, 0.76), eff * 0.35);
  s.rough += eff * 0.05;

  // soot / traffic film gathering low in the crevices
  float soot = sat((1.0 - s.ao) * 0.8 + turb(uv * 6.0 + 61.0, vec2(6.0), 4, 0.55) * 0.5 - 0.25);
  s.alb = base;
  applyDirt(s, soot * 0.35 * uAge, vec3(0.24, 0.23, 0.22), 0.05);
  applyMacro(s, uv, 0.26, 0.09, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  concrete_floor: {
    world: 4.0,
    bump: 0.95,
    cavity: 0.55,
    glsl: /* glsl */ `
Surf gen_concrete_floor(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 17.0;

  // power-float trowel swirls: long low-amplitude arcs from the machine
  vec2 sw = warp2(uv * 5.0, vec2(5.0), 1.1, 4);
  float swirl = fbm01(sw, vec2(5.0), 5, 2.0, 0.55);
  float fine  = fbm01(uv * 90.0 + sd, vec2(90.0), 4, 2.0, 0.5);
  float grain = fbm01(uv * 340.0 + sd * 2.0, vec2(340.0), 3, 2.0, 0.5);

  vec3 base = vec3(0.545, 0.538, 0.520);
  base *= mix(0.78, 1.18, swirl);
  base *= mix(0.93, 1.07, fine);
  base += (grain - 0.5) * 0.055;

  s.h     = 0.62 + (swirl - 0.5) * 0.05 + (fine - 0.5) * 0.03 + (grain - 0.5) * 0.02;
  s.rough = 0.82 + (grain - 0.5) * 0.08 + (swirl - 0.5) * 0.10;

  // --- saw-cut control joints on a 2.5 m grid (half the tile)
  vec2 jp = abs(fract(uv * 2.0 + 0.5) - 0.5);
  float jd = min(jp.x, jp.y);
  float joint = 1.0 - smoothstep(0.004, 0.010, jd);
  s.h -= joint * 0.40;
  s.ao *= 1.0 - joint * 0.75;
  base *= 1.0 - joint * 0.45;
  s.rough += joint * 0.12;
  // grit packed into the joint
  base = mix(base, vec3(0.28, 0.26, 0.24), joint * speckle(uv, 900.0, 0.5) * 0.6);

  // --- surface wear: traffic has polished lanes and worn through to aggregate
  float lanes = smoothstep(0.35, 0.85, fbm01(warp1(uv * vec2(2.0, 6.0), vec2(2.0, 6.0), 0.5, 3) + 9.0, vec2(2.0, 6.0), 4, 2.0, 0.55));
  s.rough = mix(s.rough, 0.56, lanes * 0.70);
  base *= mix(1.0, 1.06, lanes);

  float wear = sat(blobs(uv, vec2(7.0), 0.22, 0.36, 0.8, sd + 4.0) * 1.2 * (0.4 + 0.6 * lanes));
  Cell ag = cells2(uv * 120.0 + 3.0, vec2(120.0), 1.0);
  float stone = 1.0 - smoothstep(0.14, 0.32, ag.f1);
  vec3 aggCol = mix(vec3(0.38, 0.36, 0.34), vec3(0.70, 0.65, 0.58), fract(ag.id * 47.1));
  base = mix(base, aggCol, wear * stone * 0.7);
  s.h += wear * stone * 0.03 - wear * 0.02;
  s.rough += wear * 0.10;

  // --- pitting and chips
  Cell pit = cells2(uv * 65.0 + 41.0, vec2(65.0), 1.0);
  float pm = (1.0 - smoothstep(0.05, 0.14, pit.f1)) * step(0.89, fract(pit.id * 19.7));
  s.h -= pm * 0.22; s.ao *= 1.0 - pm * 0.5; base *= 1.0 - pm * 0.22;

  // --- staining: oil drips, water marks, rubber scuffs
  float oil = blobs(uv, vec2(8.0), 0.10, 0.26, 0.55, sd + 12.0);
  oil = sat(oil * 1.3 - fbm01(uv * 24.0, vec2(24.0), 3, 2.0, 0.5) * 0.35);
  base = mix(base, vec3(0.085, 0.078, 0.072), oil * 0.85);
  s.rough = mix(s.rough, 0.30, oil * 0.8);

  float water = blobs(uv, vec2(5.0), 0.30, 0.42, 0.95, sd + 22.0) * 0.5;
  base = mix(base, base * vec3(0.86, 0.87, 0.90), water);
  s.rough = mix(s.rough, s.rough - 0.10, water);

  float scuff = gouges(uv, 1.0, 40.0, 0.16, sd + 30.0) + gouges(uv, -2.0, 34.0, 0.12, sd + 60.0);
  base = mix(base, vec3(0.16, 0.155, 0.15), sat(scuff) * 0.45);
  s.rough += sat(scuff) * 0.10;

  // dust settled in the low spots
  float dust = sat(1.0 - s.h * 1.4 + turb(uv * 12.0 + 77.0, vec2(12.0), 4, 0.55) * 0.4);
  s.alb = base;
  applyDirt(s, dust * 0.28 * uAge, vec3(0.52, 0.49, 0.45), 0.10);
  applyMacro(s, uv, 0.14, 0.07, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  brick: {
    world: 2.6,
    bump: 1.55,
    cavity: 0.4,
    glsl: /* glsl */ `
Surf gen_brick(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 5.0;

  // 12 stretchers across, 30 courses up over a 2.6 m tile ≈ 215 x 65 mm brick
  vec2 count = vec2(12.0, 30.0);
  Unit u = bondLayout(uv, count, vec2(0.055, 0.16), 0.5, 0.012);
  vec3 r = hash32(u.id + sd);

  // --- brick body: fired clay, colour varies wildly kiln position to kiln position
  vec3 clayA = vec3(0.470, 0.230, 0.170);
  vec3 clayB = vec3(0.620, 0.360, 0.265);
  vec3 clayC = vec3(0.300, 0.170, 0.145);   // over-fired header
  vec3 brickCol = mix(clayA, clayB, r.x);
  brickCol = mix(brickCol, clayC, smoothstep(0.82, 1.0, r.y));
  brickCol = jitterHSV(brickCol, hash32(u.id + 31.0), 0.03, 0.35, 0.28);

  // face texture: sanded mould finish plus iron-spot speckle
  vec2 fp = uv * vec2(count.x, count.y) * vec2(14.0, 6.0);
  float face  = fbm01(fp + r.x * 30.0, vec2(count.x * 14.0, count.y * 6.0), 4, 2.0, 0.5);
  float sandy = fbm01(uv * 420.0 + sd, vec2(420.0), 3, 2.0, 0.5);
  brickCol *= mix(0.84, 1.14, face);
  brickCol += (sandy - 0.5) * 0.05;
  float iron = step(0.985, hash12(floor(uv * 700.0)));
  brickCol = mix(brickCol, vec3(0.16, 0.13, 0.12), iron * 0.7);

  float bh = 0.72 + (face - 0.5) * 0.06 + (sandy - 0.5) * 0.03;
  float bRough = 0.82 + (sandy - 0.5) * 0.10 - r.z * 0.10;

  // --- frogged/spalled corners: bricks lose their arrises first
  vec2 e = min(u.local, 1.0 - u.local);
  float cornerD = min(e.x * 1.6, e.y);
  float chipNoise = fbm01(u.local * 9.0 + u.id * 7.3, vec2(9.0), 4, 2.0, 0.55);
  float chip = smoothstep(0.10, 0.0, cornerD - (chipNoise - 0.5) * 0.16) * step(0.45, r.z);
  bh -= chip * 0.22;
  brickCol = mix(brickCol, brickCol * vec3(1.15, 1.05, 0.98) + 0.04, chip * 0.6);
  bRough += chip * 0.08;

  // --- mortar: struck back from the face, coarse sand + cement
  float mSand  = fbm01(uv * 500.0 + 71.0, vec2(500.0), 3, 2.0, 0.5);
  float mLump  = fbm01(uv * 60.0 + 13.0, vec2(60.0), 4, 2.0, 0.55);
  vec3 mortarCol = vec3(0.560, 0.545, 0.512) * mix(0.80, 1.12, mLump);
  mortarCol += (mSand - 0.5) * 0.07;
  Cell mg = cells2(uv * 260.0, vec2(260.0), 1.0);
  mortarCol = mix(mortarCol, vec3(0.68, 0.66, 0.62), (1.0 - smoothstep(0.10, 0.30, mg.f1)) * 0.25);
  float mh = 0.34 + (mLump - 0.5) * 0.10 + (mSand - 0.5) * 0.04;
  float mRough = 0.93 + (mSand - 0.5) * 0.06;

  // occasional blown / missing mortar
  float lost = smoothstep(0.62, 0.85, fbm01(uv * 8.0 + 91.0, vec2(8.0), 4, 2.0, 0.55));
  mh -= lost * 0.14;

  float jm = u.joint;
  vec3 base = mix(brickCol, mortarCol, jm);
  s.h     = mix(bh, mh, jm);
  s.rough = mix(bRough, mRough, jm);
  s.ao    = mix(1.0, 0.45, jm) * (1.0 - chip * 0.25);

  // --- efflorescence blooms out of the joints
  float eff = smoothstep(0.35, 0.85, fbm01(uv * vec2(10.0, 7.0) + 44.0, vec2(10.0, 7.0), 4, 2.0, 0.55));
  eff *= mix(0.35, 1.0, jm) * 0.5;
  base = mix(base, vec3(0.84, 0.83, 0.80), eff * 0.45);

  // --- rain runoff and soot on the weather face
  float rain = sat(runoff(uv, 34.0, sd) * 1.5 - 0.35) * (0.5 + 0.5 * uAge);
  base = mix(base, base * vec3(0.54, 0.51, 0.49), rain * 0.85);
  s.rough = mix(s.rough, 0.72, rain * 0.5);

  float soot = turb(uv * 5.0 + 101.0, vec2(5.0), 5, 0.55);
  s.alb = base;
  applyDirt(s, sat(soot * 1.2 - 0.35) * 0.4 * uAge, vec3(0.20, 0.19, 0.18), 0.04);
  base = s.alb;

  // moss in the north-facing joints
  float moss = smoothstep(0.55, 0.9, fbm01(uv * 6.0 + 155.0, vec2(6.0), 4, 2.0, 0.55)) * jm;
  base = mix(base, vec3(0.20, 0.24, 0.14), moss * 0.55);
  s.rough += moss * 0.05;

  s.alb = base;
  applyMacro(s, uv, 0.13, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  plaster: {
    world: 3.5,
    bump: 0.80,
    cavity: 0.5,
    glsl: /* glsl */ `
Surf gen_plaster(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 29.0;

  // skimmed finish: broad trowel undulation, almost no high-frequency relief
  vec2 tw = warp2(uv * 4.0, vec2(4.0), 0.9, 3);
  float trowel = fbm01(tw, vec2(4.0), 5, 2.0, 0.6);
  float sweep  = fbm01(vec2(uv.x * 3.0, uv.y * 22.0) + sd, vec2(3.0, 22.0), 4, 2.0, 0.5);
  float micro  = fbm01(uv * 260.0 + sd * 2.0, vec2(260.0), 3, 2.0, 0.5);

  vec3 base = vec3(0.760, 0.744, 0.712);
  base *= mix(0.93, 1.05, trowel);
  base *= mix(0.975, 1.025, sweep);
  base += (micro - 0.5) * 0.020;

  s.h     = 0.60 + (trowel - 0.5) * 0.10 + (sweep - 0.5) * 0.05 + (micro - 0.5) * 0.015;
  s.rough = 0.80 + (micro - 0.5) * 0.06 - (trowel - 0.5) * 0.08;

  // trowel ridge lines left where the blade lifted
  float ridge = smoothstep(0.72, 0.95, fbm01(vec2(uv.x * 8.0, uv.y * 40.0) + 3.0, vec2(8.0, 40.0), 3, 2.0, 0.5));
  s.h += ridge * 0.05;
  s.rough -= ridge * 0.05;

  // --- crazing: fine random-orientation hairlines over the whole skim
  float craze = crackNet(uv, vec2(46.0), 0.040, 0.95, 0.35);
  craze *= smoothstep(0.30, 0.75, fbm01(uv * 3.5 + 61.0, vec2(3.5), 4, 2.0, 0.55));
  float structural = crackNet(uv, vec2(7.0), 0.024, 0.85, 0.55);
  structural *= smoothstep(0.55, 0.85, fbm01(uv * 2.0 + 12.0, vec2(2.0), 3, 2.0, 0.6));
  float ck = sat(craze * 0.55 + structural);
  s.h -= ck * 0.16;
  s.ao *= 1.0 - ck * 0.55;
  base *= 1.0 - ck * 0.30;

  // --- blown patches where the plaster has come away from the backing
  float blow = blobs(uv, vec2(5.0), 0.12, 0.30, 0.4, sd + 6.0);
  blow = sat(blow * 1.6 - fbm01(uv * 20.0, vec2(20.0), 3, 2.0, 0.5) * 0.55);
  base = mix(base, vec3(0.470, 0.430, 0.395), blow * 0.85);   // brown scratch coat below
  s.h -= blow * 0.30;
  s.ao *= 1.0 - blow * 0.45;
  s.rough += blow * 0.10;

  // --- filled repairs: slightly brighter, flatter rectangles
  vec2 rp = uv * 6.0;
  vec2 ri = floor(rp);
  vec2 rf = fract(rp);
  vec3 rr = hash32(ri + 3.7);
  float rect = step(0.86, rr.x) *
               smoothstep(0.03, 0.09, min(rf.x, 1.0 - rf.x) - (rr.y - 0.5) * 0.05) *
               smoothstep(0.03, 0.09, min(rf.y, 1.0 - rf.y) - (rr.z - 0.5) * 0.05);
  base = mix(base, vec3(0.82, 0.81, 0.79), rect * 0.7);
  s.rough = mix(s.rough, 0.86, rect * 0.6);
  s.h += rect * 0.03;

  // --- damp rising from the bottom / around cracks, plus nicotine yellowing
  float damp = smoothstep(0.4, 0.85, fbm01(uv * vec2(3.0, 4.0) + 88.0, vec2(3.0, 4.0), 4, 2.0, 0.6));
  base = mix(base, vec3(0.52, 0.48, 0.42), damp * 0.35 * uAge);
  float nic = fbm01(uv * 2.0 + 200.0, vec2(2.0), 3, 2.0, 0.6);
  base = mix(base, base * vec3(1.03, 0.98, 0.86), nic * 0.5 * uAge);

  float scuff = gouges(uv, 2.0, 30.0, 0.10, sd + 44.0);
  base *= 1.0 - sat(scuff) * 0.25;
  s.h -= sat(scuff) * 0.04;

  s.alb = base;
  applyMacro(s, uv, 0.10, 0.04, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  stucco: {
    world: 3.0,
    bump: 1.1,
    cavity: 0.8,
    glsl: /* glsl */ `
Surf gen_stucco(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 47.0;

  // knock-down render: sprayed blobs flattened by a trowel
  Cell blob = cells2(uv * 110.0 + sd, vec2(110.0), 1.0);
  float lump = 1.0 - smoothstep(0.05, 0.42, blob.f1);
  lump = pow(lump, 0.65);
  Cell blob2 = cells2(uv * 240.0 + 13.0, vec2(240.0), 1.0);
  float lump2 = (1.0 - smoothstep(0.05, 0.34, blob2.f1)) * 0.5;

  float sand  = fbm01(uv * 480.0 + sd * 2.0, vec2(480.0), 3, 2.0, 0.5);
  float broad = fbm01(warp1(uv * 6.0, vec2(6.0), 0.7, 3), vec2(6.0), 5, 2.0, 0.55);

  float h = 0.42 + lump * 0.42 + lump2 * 0.18 + (sand - 0.5) * 0.05 + (broad - 0.5) * 0.10;
  // knock-down flattens the peaks
  h = mix(h, min(h, 0.80), 0.7);

  vec3 base = vec3(0.742, 0.672, 0.548);
  base *= mix(0.82, 1.14, broad);
  base *= mix(0.94, 1.06, sand);
  base = jitterHSV(base, vec3(fract(blob.id * 7.3), 0.5, 0.5), 0.010, 0.10, 0.06);

  s.h = h;
  s.rough = 0.90 + (sand - 0.5) * 0.07 - lump * 0.05;
  s.ao = mix(0.55, 1.0, smoothstep(0.25, 0.75, h));

  // dirt washes into the valleys between the lumps
  float valley = sat(1.0 - smoothstep(0.30, 0.62, h));
  float grime = valley * smoothstep(0.25, 0.8, fbm01(uv * 5.0 + 33.0, vec2(5.0), 4, 2.0, 0.55));
  s.alb = base;
  applyDirt(s, grime * 0.55 * uAge, vec3(0.33, 0.30, 0.26), 0.04);
  base = s.alb;
  base = mix(base, base * vec3(0.72, 0.70, 0.66), grime * 0.55);

  // sun bleaching on the exposed peaks
  float bleach = smoothstep(0.6, 0.95, h) * smoothstep(0.3, 0.8, broad);
  base = mix(base, vec3(0.86, 0.83, 0.76), bleach * 0.30);

  // cracks and blown render
  float ck = crackNet(uv, vec2(10.0), 0.026, 0.9, 0.45) *
             smoothstep(0.45, 0.8, fbm01(uv * 2.5 + 5.0, vec2(2.5), 4, 2.0, 0.6));
  s.h -= ck * 0.30; s.ao *= 1.0 - ck * 0.6; base *= 1.0 - ck * 0.35;

  float blown = blobs(uv, vec2(4.0), 0.10, 0.28, 0.35, sd + 9.0);
  blown = sat(blown * 1.7 - fbm01(uv * 18.0, vec2(18.0), 3, 2.0, 0.5) * 0.6);
  base = mix(base, vec3(0.50, 0.47, 0.43), blown * 0.8);
  s.h -= blown * 0.30;
  s.rough += blown * 0.05;

  float rain = sat(runoff(uv, 30.0, sd + 2.0) * 1.45 - 0.32) * uAge;
  base = mix(base, base * vec3(0.60, 0.575, 0.535), rain * 0.8);

  s.alb = base;
  applyMacro(s, uv, 0.15, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  /**
   * Granite setts. The feature set (map + normal + ORM + height + POM + detail
   * + macro) is byte-identical to concrete_floor, so this key costs zero extra
   * shader programs: SurfaceShader keys its cache on the feature signature, not
   * on the material name.
   */
  paver: {
    world: 2.4,
    bump: 1.5,
    cavity: 0.7,
    glsl: /* glsl */ `
Surf gen_paver(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 83.0;

  // --- running bond: 0.30 x 0.20 m setts, 8 across x 12 courses per 2.4 m tile
  vec2 count = vec2(8.0, 12.0);
  vec2 p = uv * count;
  float row = floor(p.y);
  float rw = mod(row, count.y);
  // half-sett stagger plus a per-course drift, because a hand-laid road is
  // never machine perfect and a perfect bond reads instantly as a texture
  p.x += 0.5 * mod(row, 2.0) + (hash11(rw + sd * 3.1) - 0.5) * 0.06;
  vec2 ci = floor(p);
  vec2 f = p - ci;
  vec2 cid = vec2(mod(ci.x, count.x), rw);
  vec3 r = hash32(cid + sd);

  vec2 dc = min(f, 1.0 - f);
  float dTile = min(dc.x / count.x, dc.y / count.y);   // in tile units: 0.005 = 12 mm
  float joint = 1.0 - smoothstep(0.0018, 0.0050, dTile);
  float dmin = min(dc.x, dc.y);                        // in sett units, 0.5 at the centre

  // --- the stone: three quarry greys plus the odd warm replacement sett
  vec3 stone = mix(vec3(0.541, 0.502, 0.451), vec3(0.431, 0.416, 0.388), r.x);
  stone = mix(stone, vec3(0.580, 0.537, 0.478), smoothstep(0.35, 0.95, r.y));
  float replaced = step(0.93, fract(r.z * 7.31 + r.x * 3.7));
  stone = mix(stone, vec3(0.541, 0.435, 0.361), replaced * 0.85);
  stone *= mix(0.72, 1.18, fract(r.z * 41.3));
  stone = jitterHSV(stone, hash32(cid + 19.0), 0.018, 0.22, 0.10);

  // split-face granite: pointed tool marks, fine grain, glinting feldspar
  float pick  = fbm01(uv * 260.0 + sd, vec2(260.0), 4, 2.0, 0.55);
  float grain = fbm01(uv * 620.0 + sd * 2.0, vec2(620.0), 3, 2.0, 0.5);
  Cell xtal = cells2(uv * 420.0 + 7.0, vec2(420.0), 1.0);
  stone *= mix(0.86, 1.14, pick);
  stone += (grain - 0.5) * 0.045;
  stone = mix(stone, stone * 1.35, (1.0 - smoothstep(0.06, 0.26, xtal.f1)) * 0.25 * fract(xtal.id * 53.1));

  float sh = 0.55 + (pick - 0.5) * 0.10 + (grain - 0.5) * 0.04;
  float srough = 0.84 + (grain - 0.5) * 0.10 - (pick - 0.5) * 0.06;

  // --- THE CROWN. Every sett is domed by a tenth of its depth. This is the one
  // line that lets raking light describe individual stones rather than a grid.
  sh += (1.0 - sq(2.0 * f.x - 1.0)) * (1.0 - sq(2.0 * f.y - 1.0)) * 0.10;

  // rounded arris: the outer tenth of the face is worn off, the fresh stone
  // under it is paler, and the last sliver holds the dirt line of the chamfer
  float arris = 1.0 - smoothstep(0.0, 0.10, dmin);
  sh -= arris * 0.18;
  stone *= 1.0 + arris * 0.08;
  stone *= 1.0 - (1.0 - smoothstep(0.0, 0.02, dmin)) * 0.28;

  // wheel tracks polish the crowns and leave the joints alone
  float lanes = smoothstep(0.40, 0.88, fbm01(warp1(uv * vec2(2.0, 5.0), vec2(2.0, 5.0), 0.5, 3) + 13.0, vec2(2.0, 5.0), 4, 2.0, 0.55));
  float polish = lanes * smoothstep(0.25, 0.48, dmin);
  srough = mix(srough, 0.44, polish * 0.8);
  stone *= mix(1.0, 1.07, polish);

  // corners knocked out by ploughs and kerbing
  float chip = smoothstep(0.09, 0.0, dmin - (fbm01(f * 7.0 + cid * 5.3, vec2(7.0), 3, 2.0, 0.55) - 0.5) * 0.10)
             * step(0.62, fract(r.y * 13.7));
  sh -= chip * 0.10;
  stone = mix(stone, stone * 1.18 + 0.02, chip * 0.5);
  srough += chip * 0.07;

  // --- joint: rammed grit and cement, moss along one run rather than everywhere
  vec3 jointCol = mix(vec3(0.200, 0.188, 0.169), vec3(0.34, 0.32, 0.28), speckle(uv, 900.0, 0.5) * 0.7);
  float jh = 0.30 - fbm01(uv * 140.0 + 31.0, vec2(140.0), 3, 2.0, 0.5) * 0.06;
  float moss = smoothstep(0.52, 0.80, fbm01(uv * 2.5 + 61.0, vec2(2.5), 4, 2.0, 0.6)) * step(0.80, hash12(cid + 71.0));
  jointCol = mix(jointCol, vec3(0.169, 0.227, 0.118), moss * 0.12);
  jh += moss * 0.05;

  s.alb   = mix(stone, jointCol, joint);
  s.h     = mix(sh, jh, joint);
  s.rough = mix(srough, 0.95, joint);
  s.ao    = mix(0.35, 1.0, smoothstep(0.0, 0.25, dmin));
  s.metal = 0.0;

  // --- damp: rain lingers in the bedding sand under the low-lying setts
  float damp = blobs(uv, vec2(2.5), 0.20, 0.38, 0.7, sd + 9.0);
  s.alb *= mix(1.0, 0.74, damp);
  s.rough = mix(s.rough, 0.55, damp);

  // traffic film settling into the crevices
  float film = sat((1.0 - s.ao) * 0.75 + turb(uv * 7.0 + 41.0, vec2(7.0), 4, 0.55) * 0.5 - 0.30);
  applyDirt(s, film * 0.30 * uAge, vec3(0.26, 0.245, 0.225), 0.05);

  applyMacro(s, uv, 0.16, 0.06, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  tile_roof: {
    world: 2.4,
    bump: 1.6,
    cavity: 0.5,
    glsl: /* glsl */ `
Surf gen_tile_roof(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 63.0;

  // clay pantiles: 6 across, 8 courses, each a rolled S-curve with a head lap
  vec2 count = vec2(6.0, 8.0);
  vec2 p = uv * count;
  float row = floor(p.y);
  p.x += mod(row, 2.0) * 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec3 r = hash32(mod(i, count) + sd);

  // profile: a raised roll on one side falling to a flat pan
  float roll = sin(f.x * PI);
  float prof = pow(sat(roll), 1.6) * 0.55 + 0.25;
  // course overlap: the head of each tile sits under the one above
  float lap = smoothstep(0.0, 0.16, f.y);
  float h = prof * lap + 0.10;
  h += (1.0 - lap) * 0.02;

  // per-tile clay colour, terracotta through to burnt brown
  vec3 tileCol = mix(vec3(0.640, 0.300, 0.172), vec3(0.470, 0.255, 0.178), r.x);
  tileCol = mix(tileCol, vec3(0.362, 0.225, 0.176), smoothstep(0.7, 1.0, r.y));
  tileCol = jitterHSV(tileCol, hash32(i + 11.0), 0.02, 0.25, 0.20);

  float clay = fbm01(uv * 240.0 + sd, vec2(240.0), 3, 2.0, 0.5);
  float ripple = fbm01(vec2(f.x * 3.0 + i.x, uv.y * 90.0), vec2(3.0, 90.0), 3, 2.0, 0.5);
  tileCol *= mix(0.90, 1.08, clay);
  tileCol *= mix(0.96, 1.04, ripple);
  h += (clay - 0.5) * 0.02;

  // chipped and cracked tiles
  vec2 e = min(f, 1.0 - f);
  float chip = smoothstep(0.07, 0.0, min(e.x, e.y) - (fbm01(f * 8.0 + i, vec2(8.0), 3, 2.0, 0.5) - 0.5) * 0.10) * step(0.6, r.z);
  h -= chip * 0.16;
  tileCol = mix(tileCol, vec3(0.62, 0.42, 0.32), chip * 0.5);

  float crack = crackNet(uv, vec2(20.0), 0.020, 0.9, 0.3) * step(0.88, hash12(i + 7.7));
  h -= crack * 0.14;
  tileCol *= 1.0 - crack * 0.4;

  // joint shadow between tiles
  float joint = 1.0 - smoothstep(0.0, 0.035, e.x);
  float head  = 1.0 - smoothstep(0.0, 0.05, f.y);
  s.ao = mix(1.0, 0.35, sat(joint * 0.8 + head));
  h -= sat(joint * 0.7 + head * 0.5) * 0.10;

  s.h = h;
  s.rough = 0.72 + (clay - 0.5) * 0.10;

  // lichen and moss favour the shaded pan and the head lap
  float shade = sat(1.0 - prof) * 0.6 + head * 0.5 + joint * 0.4;
  float moss = smoothstep(0.42, 0.85, fbm01(warp1(uv * 9.0, vec2(9.0), 0.6, 3) + 21.0, vec2(9.0), 5, 2.0, 0.55));
  moss *= sat(shade + 0.25) * (0.4 + 0.6 * uAge);
  vec3 mossCol = mix(vec3(0.26, 0.29, 0.17), vec3(0.55, 0.58, 0.46), fbm01(uv * 60.0, vec2(60.0), 3, 2.0, 0.5));
  tileCol = mix(tileCol, mossCol, moss * 0.75);
  s.rough += moss * 0.16;
  s.h += moss * 0.03;

  float grime = turb(uv * 7.0 + 71.0, vec2(7.0), 4, 0.55);
  s.alb = tileCol;
  applyDirt(s, sat(grime * 1.1 - 0.3) * 0.3 * uAge, vec3(0.26, 0.25, 0.23), 0.05);
  applyMacro(s, uv, 0.14, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },
};
