/**
 * Everything else: glazing (clean and shattered), woven textiles, moulded
 * polymer, rubber and leaf mass. Glass carries its detail almost entirely in
 * roughness — an albedo map on glass is nearly useless — and the broken variant
 * builds true radial-plus-circumferential fracture from hashed impact points.
 */
export const MISC = {
  glass: {
    world: 2.0,
    bump: 0.12,
    cavity: 0.0,
    glsl: /* glsl */ `
Surf gen_glass(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 601.0;

  // float glass is optically flat; all the character is in the contamination
  float smear = smoothstep(0.48, 0.85, fbm01(warp2(uv * 6.0, vec2(6.0), 1.3, 3) + sd, vec2(6.0), 5, 2.0, 0.55));
  float wipe  = smoothstep(0.55, 0.85, fbm01(vec2(uv.x * 26.0, uv.y * 3.0) + 11.0, vec2(26.0, 3.0), 4, 2.0, 0.5));
  float dust  = fbm01(uv * 200.0 + sd * 2.0, vec2(200.0), 4, 2.0, 0.5);

  // rain spots and dried mineral rings
  Cell dropc = cells2(uv * 55.0 + 21.0, vec2(55.0), 1.0);
  float dropR = mix(0.10, 0.26, fract(dropc.id * 41.3));
  float dropPresent = step(0.55, fract(dropc.id * 13.7));
  float drop = (1.0 - smoothstep(dropR * 0.85, dropR, dropc.f1)) * dropPresent;
  float dropRing = (1.0 - smoothstep(dropR, dropR * 1.15, dropc.f1)) * smoothstep(dropR * 0.8, dropR, dropc.f1) * dropPresent;

  // fine wiper scratches
  float scr = sat(scratches(uv, 1.0, 700.0, 4.0, 0.70, sd) * 0.5 + gouges(uv, -3.0, 30.0, 0.06, sd + 3.0));

  float grime = sat(smear * 0.55 + wipe * 0.35 + dust * 0.25 + drop * 0.5 + dropRing * 0.7) * (0.35 + 0.65 * uAge);

  vec3 base = mix(vec3(0.960, 0.972, 0.968), vec3(0.640, 0.630, 0.600), grime * 0.55);
  base = mix(base, vec3(0.86, 0.87, 0.85), dropRing * 0.4);

  s.alb = base;
  s.rough = 0.035 + grime * 0.30 + scr * 0.18 + dropRing * 0.12;
  s.metal = 0.0;
  s.h = 0.72 + (dust - 0.5) * 0.02 - drop * 0.02 + dropRing * 0.02 - scr * 0.02;
  s.ao = 1.0;
  s.op = sat(0.06 + grime * 0.60 + dropRing * 0.25 + scr * 0.15);

  applyMacro(s, uv, 0.04, 0.03, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  glass_broken: {
    world: 2.0,
    bump: 0.9,
    cavity: 0.4,
    glsl: /* glsl */ `
/** Radial + circumferential fracture around one impact. d is a torus-wrapped offset. */
float fracture(vec2 d, float sd, out float shard){
  float r = length(d);
  float a = atan(d.y, d.x) / TAU + 0.5;

  // radial rays, jittered in angle and thinning with distance
  float rays = 13.0;
  float k = a * rays;
  float ri = floor(k);
  float jit = (hash11(ri + sd * 3.1) - 0.5) * 0.55;
  float bend = fbm(vec2(r * 8.0, ri), vec2(8.0, rays), 3, 2.0, 0.5) * 0.20;
  float da = abs(fract(k + jit + bend) - 0.5);
  float radial = 1.0 - smoothstep(0.0, 0.02 + r * 0.06, da * (0.35 + r * 2.2));
  radial *= smoothstep(0.62, 0.10, r);
  radial *= step(0.18, fract(hash11(ri + sd * 7.7)));

  // circumferential cracks linking the rays
  float rings = 5.0;
  float rr = r * rings + fbm(vec2(a * 10.0, 2.0), vec2(10.0, 2.0), 3, 2.0, 0.5) * 0.55;
  float dr = abs(fract(rr) - 0.5);
  float circ = 1.0 - smoothstep(0.0, 0.045, dr);
  circ *= smoothstep(0.55, 0.06, r) * smoothstep(0.03, 0.10, r);
  circ *= step(0.35, fract(hash11(floor(rr) + sd * 5.3)));

  shard = 1.0 - smoothstep(0.03, 0.075, r);   // the hole punched at the centre
  return sat(radial + circ * 0.85);
}

Surf gen_glass_broken(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 631.0;

  float ck = 0.0;
  float hole = 0.0;
  for (int i = 0; i < 3; i++) {
    vec2 c = hash21(float(i) * 7.3 + sd);
    vec2 d = fract(uv - c + 0.5) - 0.5;
    float sh;
    ck = max(ck, fracture(d, sd + float(i) * 11.0, sh));
    hole = max(hole, sh);
  }

  // secondary stress craze filling the shards
  float craze = crackNet(uv, vec2(9.0), 0.016, 0.9, 0.45);
  craze *= smoothstep(0.35, 0.75, fbm01(uv * 3.0 + 41.0, vec2(3.0), 4, 2.0, 0.6));
  ck = sat(ck + craze * 0.55);

  // base pane, dirtier than the clean variant
  float smear = smoothstep(0.42, 0.85, fbm01(warp2(uv * 6.0, vec2(6.0), 1.2, 3) + sd, vec2(6.0), 5, 2.0, 0.55));
  float dust = fbm01(uv * 210.0 + sd * 2.0, vec2(210.0), 4, 2.0, 0.5);
  float grime = sat(smear * 0.7 + dust * 0.3) * (0.5 + 0.5 * uAge);

  // fracture surfaces scatter light: bright, rough, slightly milky
  vec3 base = mix(vec3(0.930, 0.945, 0.945), vec3(0.560, 0.550, 0.520), grime * 0.55);
  base = mix(base, vec3(0.880, 0.905, 0.915), ck * 0.85);

  s.alb = base;
  s.rough = 0.045 + grime * 0.28 + ck * 0.42;
  s.metal = 0.0;
  s.h = 0.70 - ck * 0.22 + (dust - 0.5) * 0.02;
  s.ao = 1.0 - ck * 0.30;
  s.op = sat(0.08 + grime * 0.5 + ck * 0.75);

  // missing shards punch right through
  float gone = sat(hole * 1.2 - fbm01(uv * 40.0, vec2(40.0), 3, 2.0, 0.5) * 0.35);
  s.op *= 1.0 - smoothstep(0.35, 0.7, gone);
  s.alb = mix(s.alb, vec3(0.98), smoothstep(0.15, 0.5, gone) * 0.4);
  s.rough = mix(s.rough, 0.55, smoothstep(0.15, 0.5, gone));

  applyMacro(s, uv, 0.05, 0.03, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  fabric_canvas: {
    world: 1.0,
    bump: 0.85,
    cavity: 0.7,
    glsl: /* glsl */ `
Surf gen_fabric_canvas(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 661.0;

  // --- plain weave: warp and weft alternate over and under on a checker
  float N = 96.0;
  vec2 tp = uv * N;
  vec2 ti = floor(tp), tf = fract(tp);
  float chk = mod(ti.x + ti.y, 2.0);

  float warpH = pow(sin(sat(tf.x) * PI), 0.55);
  float weftH = pow(sin(sat(tf.y) * PI), 0.55);
  float top = mix(weftH, warpH, chk);
  float bot = mix(warpH, weftH, chk) * 0.35;
  float h = max(top * 0.85, bot) * 0.75 + 0.12;

  // yarn twist and slub: real thread is not a smooth tube
  float twist = fbm01(vec2(mix(tf.y, tf.x, chk) * 6.0 + ti.x * 3.1 + ti.y * 1.7, 0.5) * vec2(1.0, 1.0), vec2(6.0, 1.0), 3, 2.0, 0.5);
  float slub = fbm01(uv * vec2(N * 0.5, 4.0) + sd, vec2(N * 0.5, 4.0), 3, 2.0, 0.5);
  h += (twist - 0.5) * 0.10 + (slub - 0.5) * 0.06;

  // fibre fuzz breaks the silhouette of every thread
  float fuzz = fbm01(uv * 900.0 + sd * 2.0, vec2(900.0), 3, 2.0, 0.5);
  h += (fuzz - 0.5) * 0.06;

  // --- colour: olive drab duck canvas, per-thread dye variation
  vec3 dye = vec3(0.288, 0.288, 0.198);
  float threadId = mix(ti.y, ti.x, chk);
  dye = jitterHSV(dye, hash32(vec2(threadId, chk) + sd), 0.020, 0.25, 0.28);
  dye *= mix(0.78, 1.18, twist);
  dye *= mix(0.92, 1.08, slub);
  dye = mix(dye, dye * 1.35, sat(top - 0.55) * 0.5);      // thread crowns catch light

  // --- weathering: sun fade on the crowns, dirt in the interstices
  float fade = smoothstep(0.35, 0.85, fbm01(uv * 4.0 + 31.0, vec2(4.0), 4, 2.0, 0.6));
  dye = mix(dye, dye * 0.72 + 0.20, fade * 0.45 * uAge);

  float gap = sat(1.0 - h * 2.2);
  s.alb = dye;
  s.rough = 0.86 + (fuzz - 0.5) * 0.10 - sat(top - 0.6) * 0.08;
  s.h = h;
  s.ao = mix(0.35, 1.0, smoothstep(0.05, 0.6, h));
  applyDirt(s, sat(gap * 0.8) * 0.4 * uAge, vec3(0.20, 0.185, 0.155), 0.06);

  // --- stains, patches and a stitched seam
  float stain = blobs(uv, vec2(5.0), 0.22, 0.34, 0.8, sd + 7.0);
  s.alb = mix(s.alb, s.alb * vec3(0.55, 0.52, 0.46), stain * 0.6);
  s.rough += stain * 0.04;

  float seamD = abs(fract(uv.y * 3.0 + 0.27) - 0.5);
  float seam = 1.0 - smoothstep(0.010, 0.020, seamD);
  float stitch = seam * step(0.5, fract(uv.x * N * 0.25));
  s.h += seam * 0.10 + stitch * 0.10;
  s.alb = mix(s.alb, s.alb * 0.8, seam * 0.4);
  s.alb = mix(s.alb, vec3(0.32, 0.30, 0.24), stitch * 0.5);
  s.ao *= 1.0 - seam * 0.20;

  // frayed edge fibres pulling away
  float fray = smoothstep(0.86, 0.98, fbm01(shear(uv, 2.0) * vec2(400.0, 9.0) + 91.0, vec2(400.0, 9.0), 3, 2.0, 0.5));
  s.alb = mix(s.alb, s.alb * 1.25, fray * 0.4);
  s.h += fray * 0.05;
  s.op = 1.0;

  applyMacro(s, uv, 0.13, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  /**
   * Cotton laundry, sheets and light shirting. Finer and far paler than duck
   * canvas, and carried almost entirely by the crease network — a pegged sheet
   * without wrinkles is a card, and a card is the single most obvious tell in a
   * street scene.
   */
  fabric_light: {
    world: 0.9,
    bump: 0.9,
    cavity: 0.6,
    glsl: /* glsl */ `
Surf gen_fabric_light(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 673.0;

  // --- fine cotton plain weave, sized to still read at 3-8 m rather than to
  // be physically correct at 40 threads/cm (which mips to grey by 2 m)
  float N = 150.0;
  vec2 tp = uv * N;
  vec2 ti = floor(tp), tf = fract(tp);
  float chk = mod(ti.x + ti.y, 2.0);
  float warpH = pow(sin(sat(tf.x) * PI), 0.70);
  float weftH = pow(sin(sat(tf.y) * PI), 0.70);
  float top = mix(weftH, warpH, chk);
  float fuzz = fbm01(uv * 1100.0 + sd, vec2(1100.0), 3, 2.0, 0.5);
  float slub = fbm01(uv * vec2(N * 0.4, 5.0) + sd * 2.0, vec2(N * 0.4, 5.0), 3, 2.0, 0.5);

  float h = 0.26 + top * 0.42 + (fuzz - 0.5) * 0.05 + (slub - 0.5) * 0.04;

  // --- laundered white gone slightly warm and uneven, a faint dye lot per thread
  vec3 base = vec3(0.800, 0.782, 0.741);
  base = jitterHSV(base, hash32(vec2(mix(ti.y, ti.x, chk), chk) + sd), 0.008, 0.10, 0.07);
  base *= mix(0.90, 1.06, top);
  base *= mix(0.95, 1.05, slub);

  // --- creases. Folded, pegged and never ironed: a warped ridge network plus a
  // few long gravity folds running down from the line.
  float creases = ridged(warp1(uv * 7.0, vec2(7.0), 0.8, 3) + 19.0, vec2(7.0), 4, 0.55);
  float folds = ridged(vec2(uv.x * 5.0, uv.y * 1.4) + 51.0, vec2(5.0, 1.4), 3, 0.5);
  float crease = sat(creases * 0.65 + folds * 0.55);
  h += (crease - 0.35) * 0.22;
  // light bends round a crease: bright on the ridge, shaded in the valley
  base *= mix(0.86, 1.10, crease);
  s.ao = mix(0.55, 1.0, smoothstep(0.10, 0.55, crease)) * mix(0.45, 1.0, smoothstep(0.05, 0.55, top));

  // --- hemmed edge along one side with a double row of stitching
  float hemD = abs(fract(uv.y * 2.0 + 0.25) - 0.5);
  float hem = 1.0 - smoothstep(0.030, 0.048, hemD);
  float stitch = (1.0 - smoothstep(0.004, 0.008, abs(hemD - 0.036))) * step(0.45, fract(uv.x * N * 0.18));
  h += hem * 0.10 + stitch * 0.09;
  base = mix(base, base * 0.94, hem * 0.5);
  base = mix(base, vec3(0.62, 0.60, 0.56), stitch * 0.55);
  s.ao *= 1.0 - hem * 0.15;

  // --- age: sun bleach on the exposed face, grey water marks, the odd stain
  float sun = smoothstep(0.35, 0.85, fbm01(uv * 3.0 + 77.0, vec2(3.0), 4, 2.0, 0.6));
  base = mix(base, base * 0.92 + 0.09, sun * 0.5);
  float stain = blobs(uv, vec2(4.0), 0.16, 0.30, 0.85, sd + 11.0);
  base = mix(base, base * vec3(0.78, 0.75, 0.68), stain * 0.55 * uAge);

  s.alb = base;
  s.h = h;
  s.rough = 0.94 + (fuzz - 0.5) * 0.08 - sat(top - 0.7) * 0.05;
  s.metal = 0.0;
  s.op = 1.0;

  float grey = sat(1.0 - h * 1.9);
  applyDirt(s, grey * 0.18 * uAge, vec3(0.44, 0.43, 0.40), 0.03);

  applyMacro(s, uv, 0.09, 0.04, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  /**
   * Operator kit atlas. One 4x4 grid of tactical surfaces so a whole bot — plate
   * carrier, helmet, webbing, boots, optic — draws from a single material and a
   * single set of maps. Tile (r,c) is the UV rect [c/4, r/4]..[(c+1)/4,(r+1)/4]
   * with r counted up from v = 0:
   *
   *   (0,0) 1000D cordura      (0,1) ripstop          (0,2) helmet mesh cover  (0,3) helmet shell
   *   (1,0) rubber / leather   (1,1) hard polymer     (1,2) gun metal          (1,3) MOLLE webbing
   *   (2,0) velcro loop        (2,1) ribbed shock cord (2,2) optic glass       (2,3) boot sole
   *   (3,0) coyote cordura     (3,1) coyote webbing   (3,2) patch field        (3,3) grime overlay
   *
   * Every tile fades to its own flat mean over the outer 9.4% (12 px of a 128 px
   * tile), so whatever bleeds across a tile edge at mip 3-4 is one flat mean
   * meeting another and the seam never appears. Value-adjacent surfaces are
   * neighbours for the same reason: bleed between two L*11 blacks is unmeasurable.
   */
  bot_kit: {
    world: 1.0,
    bump: 1.15,
    cavity: 0.55,
    glsl: /* glsl */ `
Surf gen_bot_kit(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 941.0;

  vec2 g = uv * 4.0;
  vec2 gi = floor(g);
  vec2 p = g - gi;
  float id = gi.y * 4.0 + gi.x;

  vec3  alb   = vec3(0.10);
  float rough = 0.90, metal = 0.0, h = 0.5, ao = 1.0;
  vec3  mAlb  = vec3(0.10);
  float mRough = 0.90, mMetal = 0.0, mH = 0.5, mAO = 0.95;

  if (id < 0.5) {
    // (0,0) 1000D cordura, 2x2 basketweave — the bulk of the plate carrier
    float N = 56.0;
    vec2 tp = p * N; vec2 ti = floor(tp), tf = tp - ti;
    float chk = mod(floor(ti.x * 0.5) + floor(ti.y * 0.5), 2.0);
    float top = mix(pow(sin(sat(tf.y) * PI), 0.5), pow(sin(sat(tf.x) * PI), 0.5), chk);
    float fuzz = fbm01(p * 620.0 + sd, vec2(620.0), 3, 2.0, 0.5);
    h = 0.44 + top * 0.35 + (fuzz - 0.5) * 0.05;
    alb = vec3(0.101, 0.108, 0.098) * mix(0.68, 1.32, top) * mix(0.92, 1.08, fuzz);
    rough = 0.90 + (fuzz - 0.5) * 0.05;
    ao = mix(0.40, 1.0, smoothstep(0.05, 0.60, top));
    mAlb = vec3(0.118, 0.127, 0.115); mRough = 0.90; mH = 0.710; mAO = 0.93;
  } else if (id < 1.5) {
    // (0,1) ripstop: a plain weave with a heavier thread every 8th, plus a
    // dark seam stitch across it
    float N = 44.0;
    vec2 tp = p * N; vec2 ti = floor(tp), tf = tp - ti;
    float chk = mod(ti.x + ti.y, 2.0);
    float top = mix(pow(sin(sat(tf.y) * PI), 0.65), pow(sin(sat(tf.x) * PI), 0.65), chk);
    float rip = max(step(7.5, mod(ti.x, 8.0)), step(7.5, mod(ti.y, 8.0)));
    float fuzz = fbm01(p * 700.0 + sd * 2.0, vec2(700.0), 3, 2.0, 0.5);
    h = 0.46 + top * 0.22 + rip * 0.14 + (fuzz - 0.5) * 0.04;
    alb = vec3(0.088, 0.094, 0.090) * mix(0.72, 1.26, top) * mix(1.0, 1.12, rip);
    rough = 0.90 + (fuzz - 0.5) * 0.05;
    ao = mix(0.48, 1.0, smoothstep(0.05, 0.55, top));
    // 6 mm bar stitch every 40 mm
    float st = (1.0 - smoothstep(0.006, 0.012, abs(fract(p.y * 6.0) - 0.5) / 6.0)) * step(0.4, fract(p.x * 44.0));
    h += st * 0.10; alb = mix(alb, vec3(0.055, 0.058, 0.056), st * 0.6);
    mAlb = vec3(0.099, 0.106, 0.101); mRough = 0.90; mH = 0.637; mAO = 0.95;
  } else if (id < 2.5) {
    // (0,2) helmet mesh cover: a hex net lying over a smooth shell
    float N = 32.0;
    vec2 hp = vec2(p.x * N, p.y * N * 1.1547);
    hp.x += mod(floor(hp.y), 2.0) * 0.5;
    vec2 hf = fract(hp) - 0.5;
    float hex = max(abs(hf.x) * 0.866 + abs(hf.y) * 0.5, abs(hf.y));
    float cord = 1.0 - smoothstep(0.30, 0.46, hex);
    float fuzz = fbm01(p * 540.0 + sd, vec2(540.0), 3, 2.0, 0.5);
    h = 0.52 + cord * 0.28 + (fuzz - 0.5) * 0.03;
    alb = mix(vec3(0.058, 0.062, 0.058), vec3(0.112, 0.118, 0.104), cord) * mix(0.94, 1.08, fuzz);
    rough = mix(0.46, 0.92, cord);
    ao = mix(0.55, 1.0, cord);
    mAlb = vec3(0.077, 0.082, 0.074); mRough = 0.62; mH = 0.618; mAO = 0.71;
  } else if (id < 3.5) {
    // (0,3) bare helmet shell: aramid laminate, worley scuffs down to matte
    float weave = fbm01(p * 190.0 + sd, vec2(190.0), 3, 2.0, 0.5);
    Cell sc = cells2(p * 13.0 + 3.0, vec2(13.0), 1.0);
    float scuff = (1.0 - smoothstep(0.10, 0.34, sc.f1)) * step(0.92, fract(sc.id * 27.7));
    h = 0.62 + (weave - 0.5) * 0.04 - scuff * 0.03;
    alb = vec3(0.072, 0.076, 0.070) * mix(0.94, 1.08, weave);
    alb = mix(alb, alb * 1.35, scuff * 0.6);
    rough = mix(0.44, 0.60, scuff);
    ao = 1.0 - scuff * 0.10;
    mAlb = vec3(0.074, 0.078, 0.072); mRough = 0.45; mH = 0.620; mAO = 0.99;
  } else if (id < 4.5) {
    // (1,0) rubber / leather: worley pebble grain
    Cell pb = cells2(p * 90.0 + sd, vec2(90.0), 1.0);
    float peb = 1.0 - smoothstep(0.06, 0.36, pb.f1);
    float micro = fbm01(p * 480.0 + 7.0, vec2(480.0), 3, 2.0, 0.5);
    h = 0.50 + peb * 0.32 + (micro - 0.5) * 0.05;
    alb = vec3(0.052, 0.050, 0.050) * mix(0.72, 1.40, sat(peb * 0.7 + micro * 0.5));
    rough = 0.50 + (micro - 0.5) * 0.10 - peb * 0.05;
    ao = mix(0.62, 1.0, smoothstep(0.0, 0.5, peb));
    mAlb = vec3(0.055, 0.053, 0.053); mRough = 0.48; mH = 0.612; mAO = 0.85;
  } else if (id < 5.5) {
    // (1,1) hard polymer: buckles, clips, mag bodies
    float stip = fbm01(p * 620.0 + sd, vec2(620.0), 3, 2.0, 0.5);
    float flow = fbm01(warp1(p * 7.0, vec2(7.0), 0.6, 3) + 23.0, vec2(7.0), 4, 2.0, 0.55);
    h = 0.60 + (stip - 0.5) * 0.15 + (flow - 0.5) * 0.04;
    alb = vec3(0.046, 0.047, 0.050) * mix(0.80, 1.30, sat(stip * 0.6 + flow * 0.5));
    rough = 0.36 + (stip - 0.5) * 0.08;
    ao = 1.0;
    mAlb = vec3(0.050, 0.051, 0.054); mRough = 0.36; mH = 0.600; mAO = 1.00;
  } else if (id < 6.5) {
    // (1,2) gun metal: parkerised, machining lines running along +U. The only
    // metallic surface in the atlas.
    float lines = fbm01(vec2(p.x * 8.0, p.y * 900.0) + sd, vec2(8.0, 900.0), 3, 2.0, 0.5);
    float broad = fbm01(p * 40.0 + 11.0, vec2(40.0), 3, 2.0, 0.5);
    h = 0.58 + (lines - 0.5) * 0.06 + (broad - 0.5) * 0.03;
    alb = vec3(0.170, 0.176, 0.186) * mix(0.82, 1.20, lines) * mix(0.94, 1.06, broad);
    rough = 0.24 + (lines - 0.5) * 0.10;
    metal = 1.0;
    ao = 1.0;
    mAlb = vec3(0.172, 0.178, 0.188); mRough = 0.24; mMetal = 1.0; mH = 0.580; mAO = 1.00;
  } else if (id < 7.5) {
    // (1,3) MOLLE webbing. A HORIZONTAL ladder: a 25 mm band every 38 mm with a
    // bar-tack every 38 mm across it. At 20-30 m this is the single texture that
    // says 'soldier' rather than 'dark mannequin', so it is authored to survive
    // mipping rather than to be physically fine.
    float rows = 9.0;
    float ry = p.y * rows;
    float band = smoothstep(0.02, 0.09, fract(ry)) * smoothstep(0.68, 0.60, fract(ry));
    float tape = fbm01(vec2(p.x * 260.0, ry * 26.0) + sd, vec2(260.0, 26.0), 3, 2.0, 0.5);
    float tack = band * step(0.72, fract(p.x * 9.0)) * smoothstep(0.10, 0.20, fract(ry));
    h = 0.40 + band * 0.34 + tack * 0.12 + (tape - 0.5) * 0.05;
    alb = vec3(0.092, 0.098, 0.090) * mix(0.66, 1.28, band) * mix(0.92, 1.10, tape);
    alb = mix(alb, vec3(0.048, 0.052, 0.048), tack * 0.55);
    rough = 0.92 + (tape - 0.5) * 0.04;
    ao = mix(0.34, 1.0, smoothstep(0.0, 0.35, band));
    mAlb = vec3(0.091, 0.097, 0.089); mRough = 0.92; mH = 0.594; mAO = 0.74;
  } else if (id < 8.5) {
    // (2,0) velcro loop field: matted fuzz, no structure, very rough
    float f1 = fbm01(p * 340.0 + sd, vec2(340.0), 4, 2.0, 0.5);
    float f2 = fbm01(p * 900.0 + 31.0, vec2(900.0), 3, 2.0, 0.5);
    h = 0.54 + (f1 - 0.5) * 0.16 + (f2 - 0.5) * 0.08;
    alb = vec3(0.064, 0.067, 0.063) * mix(0.80, 1.24, sat(f1 * 0.6 + f2 * 0.5));
    rough = 0.95;
    ao = mix(0.62, 1.0, f1);
    mAlb = vec3(0.067, 0.070, 0.066); mRough = 0.95; mH = 0.540; mAO = 0.81;
  } else if (id < 9.5) {
    // (2,1) ribbed shock cord and elastic keepers
    float ribs = sin(p.y * 3.0 * 26.0 * TAU) * 0.5 + 0.5;
    ribs = pow(ribs, 1.4);
    float braid = fbm01(vec2(p.x * 90.0, p.y * 300.0) + sd, vec2(90.0, 300.0), 3, 2.0, 0.5);
    h = 0.46 + ribs * 0.30 + (braid - 0.5) * 0.06;
    alb = vec3(0.058, 0.060, 0.058) * mix(0.72, 1.30, ribs) * mix(0.94, 1.08, braid);
    rough = 0.86 - ribs * 0.08;
    ao = mix(0.50, 1.0, ribs);
    mAlb = vec3(0.056, 0.058, 0.056); mRough = 0.83; mH = 0.589; mAO = 0.72;
  } else if (id < 10.5) {
    // (2,2) optic glass: flat, near-mirror, 15% AR coat tint toward #2a3a30
    float dustf = fbm01(p * 260.0 + sd, vec2(260.0), 3, 2.0, 0.5);
    h = 0.70 + (dustf - 0.5) * 0.01;
    alb = mix(vec3(0.028, 0.030, 0.030), vec3(0.165, 0.227, 0.188), 0.15);
    alb *= mix(0.96, 1.06, dustf);
    rough = 0.10 + dustf * 0.04;
    ao = 1.0;
    mAlb = alb; mRough = 0.12; mH = 0.700; mAO = 1.00;
  } else if (id < 11.5) {
    // (2,3) boot sole: 20 mm lugs
    float N = 12.0;
    vec2 lp = p * vec2(N, N);
    lp.y += mod(floor(lp.x), 2.0) * 0.5;
    vec2 lf = fract(lp) - 0.5;
    float lug = sat(1.0 - (abs(lf.x) + abs(lf.y)) * 2.3);
    lug = smoothstep(0.05, 0.35, lug);
    float grit = fbm01(p * 420.0 + sd, vec2(420.0), 3, 2.0, 0.5);
    h = 0.34 + lug * 0.60 + (grit - 0.5) * 0.05;
    alb = vec3(0.040, 0.039, 0.038) * mix(0.70, 1.35, lug) * mix(0.92, 1.10, grit);
    rough = 0.62 - lug * 0.10;
    ao = mix(0.28, 1.0, lug);
    mAlb = vec3(0.036, 0.035, 0.034); mRough = 0.59; mH = 0.520; mAO = 0.50;
  } else if (id < 12.5) {
    // (3,0) coyote cordura #6b5a3c — pouches and slings against the black kit
    float N = 56.0;
    vec2 tp = p * N; vec2 ti = floor(tp), tf = tp - ti;
    float chk = mod(floor(ti.x * 0.5) + floor(ti.y * 0.5), 2.0);
    float top = mix(pow(sin(sat(tf.y) * PI), 0.5), pow(sin(sat(tf.x) * PI), 0.5), chk);
    float fuzz = fbm01(p * 620.0 + sd * 3.0, vec2(620.0), 3, 2.0, 0.5);
    h = 0.44 + top * 0.33 + (fuzz - 0.5) * 0.05;
    alb = vec3(0.420, 0.353, 0.235) * mix(0.70, 1.24, top) * mix(0.93, 1.07, fuzz);
    rough = 0.90 + (fuzz - 0.5) * 0.05;
    ao = mix(0.42, 1.0, smoothstep(0.05, 0.60, top));
    mAlb = vec3(0.469, 0.394, 0.262); mRough = 0.90; mH = 0.694; mAO = 0.93;
  } else if (id < 13.5) {
    // (3,1) coyote webbing #5e4f35, same ladder pitch as the black MOLLE
    float rows = 9.0;
    float ry = p.y * rows;
    float band = smoothstep(0.02, 0.09, fract(ry)) * smoothstep(0.68, 0.60, fract(ry));
    float tape = fbm01(vec2(p.x * 260.0, ry * 26.0) + sd, vec2(260.0, 26.0), 3, 2.0, 0.5);
    float tack = band * step(0.72, fract(p.x * 9.0)) * smoothstep(0.10, 0.20, fract(ry));
    h = 0.40 + band * 0.34 + tack * 0.12 + (tape - 0.5) * 0.05;
    alb = vec3(0.369, 0.310, 0.208) * mix(0.66, 1.26, band) * mix(0.93, 1.09, tape);
    alb = mix(alb, alb * 0.62, tack * 0.55);
    rough = 0.92 + (tape - 0.5) * 0.04;
    ao = mix(0.34, 1.0, smoothstep(0.0, 0.35, band));
    mAlb = vec3(0.351, 0.295, 0.198); mRough = 0.92; mH = 0.594; mAO = 0.74;
  } else if (id < 14.5) {
    // (3,2) patch field: a subdued flag, a name tape and a 12 mm IR glint square
    float stripe = floor(p.y * 6.0);
    vec3 flagA = vec3(0.130, 0.132, 0.140);
    vec3 flagB = vec3(0.072, 0.074, 0.080);
    vec3 col = mix(flagA, flagB, mod(stripe, 2.0));
    // canton
    float canton = step(p.x, 0.42) * step(0.62, p.y);
    col = mix(col, vec3(0.052, 0.056, 0.068), canton);
    // IR glint square, 12 mm on a 250 mm tile
    float ir = step(0.70, p.x) * step(p.x, 0.748) * step(0.10, p.y) * step(p.y, 0.148);
    col = mix(col, vec3(0.215, 0.222, 0.212), ir);
    float twill = fbm01(p * 420.0 + sd, vec2(420.0), 3, 2.0, 0.5);
    float border = (1.0 - smoothstep(0.02, 0.05, min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y))));
    col = mix(col, vec3(0.058, 0.060, 0.058), border * 0.8);
    alb = col * mix(0.90, 1.10, twill);
    h = 0.56 + border * 0.10 + ir * 0.03 + (twill - 0.5) * 0.05;
    rough = mix(0.88, 0.34, ir);
    ao = 1.0 - border * 0.15;
    mAlb = vec3(0.095, 0.097, 0.103); mRough = 0.86; mH = 0.580; mAO = 0.94;
  } else {
    // (3,3) grime overlay: dust, salt bloom and blood-brown, for the bot shader
    // to multiply over anything that needs to look used
    float dust = fbm01(warp1(p * 6.0, vec2(6.0), 0.8, 3) + sd, vec2(6.0), 5, 2.0, 0.55);
    float fine = fbm01(p * 220.0 + 13.0, vec2(220.0), 3, 2.0, 0.5);
    float spat = blobs(p, vec2(7.0), 0.14, 0.26, 0.7, sd + 5.0);
    alb = mix(vec3(0.148, 0.140, 0.124), vec3(0.300, 0.284, 0.250), dust);
    alb = mix(alb, vec3(0.118, 0.058, 0.046), spat * 0.65);
    alb *= mix(0.92, 1.08, fine);
    h = 0.50 + (dust - 0.5) * 0.10 + (fine - 0.5) * 0.05;
    rough = 0.94 - spat * 0.20;
    ao = mix(0.80, 1.0, dust);
    mAlb = vec3(0.224, 0.212, 0.187); mRough = 0.93; mH = 0.500; mAO = 0.90;
  }

  // --- 12 px of a 128 px tile ramped to the tile mean, on every side
  const float B = 0.09375;
  vec2 de = min(p, 1.0 - p);
  float edge = 1.0 - smoothstep(0.0, B, min(de.x, de.y));
  edge = edge * edge * (3.0 - 2.0 * edge);

  s.alb   = mix(alb, mAlb, edge);
  s.rough = mix(rough, mRough, edge);
  s.metal = mix(metal, mMetal, edge);
  s.h     = mix(h, mH, edge);
  s.ao    = mix(ao, mAO, edge);
  s.op    = 1.0;

  // No applyMacro: a metres-scale drift would smear straight across tile
  // boundaries and undo the whole point of the padding.
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  sandbag: {
    world: 0.7,
    bump: 1.4,
    cavity: 0.9,
    glsl: /* glsl */ `
Surf gen_sandbag(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 691.0;

  // --- coarse polypropylene sacking: fewer, fatter, flatter tapes than canvas
  float N = 34.0;
  vec2 tp = uv * N;
  vec2 ti = floor(tp), tf = fract(tp);
  float chk = mod(ti.x + ti.y, 2.0);
  float warpH = pow(sin(sat(tf.x) * PI), 0.35);
  float weftH = pow(sin(sat(tf.y) * PI), 0.35);
  float top = mix(weftH, warpH, chk);
  float h = top * 0.42 + 0.18;

  // --- the bag is full: broad lumps of sand pushing the weave out
  vec2 wp = warp1(uv * 3.0, vec2(3.0), 0.7, 3);
  float bulge = fbm01(wp + sd, vec2(3.0), 5, 2.0, 0.6);
  float grainLump = fbm01(uv * 18.0 + 11.0, vec2(18.0), 4, 2.0, 0.5);
  h += (bulge - 0.5) * 0.42 + (grainLump - 0.5) * 0.14;

  // --- colour: sun-bleached hessian tan with UV-degraded pale crowns
  vec3 base = vec3(0.470, 0.400, 0.275);
  base = jitterHSV(base, hash32(vec2(mix(ti.y, ti.x, chk), chk) + sd), 0.020, 0.22, 0.22);
  base *= mix(0.80, 1.16, top);
  base *= mix(0.86, 1.12, bulge);

  float bleach = smoothstep(0.4, 0.9, bulge) * smoothstep(0.5, 0.95, top);
  base = mix(base, vec3(0.700, 0.660, 0.560), bleach * 0.45 * (0.4 + 0.6 * uAge));

  // sand dust worked into the weave, and darker damp at the base
  float dust = sat(1.0 - top * 1.4) * 0.6 + fbm01(uv * 60.0 + 3.0, vec2(60.0), 3, 2.0, 0.5) * 0.4;
  base = mix(base, vec3(0.560, 0.500, 0.395), sat(dust) * 0.35);

  float damp = smoothstep(0.55, 0.95, fbm01(uv * 4.0 + 61.0, vec2(4.0), 4, 2.0, 0.6));
  base = mix(base, base * 0.62, damp * 0.5 * uAge);

  s.alb = base;
  s.h = h;
  s.rough = 0.90 + (grainLump - 0.5) * 0.06 - bleach * 0.04;
  s.ao = mix(0.32, 1.0, smoothstep(0.05, 0.62, h)) * mix(0.75, 1.0, smoothstep(0.2, 0.7, bulge));

  // --- degraded tapes: UV has made the polypropylene split and fibrillate
  float split = smoothstep(0.82, 0.97, fbm01(shear(uv, 3.0) * vec2(N * 5.0, 7.0) + 121.0, vec2(N * 5.0, 7.0), 3, 2.0, 0.5));
  split *= uAge;
  s.alb = mix(s.alb, s.alb * 1.3, split * 0.5);
  s.h += split * 0.06;
  s.rough += split * 0.04;

  // --- stitched closure across the top of the bag
  float seamD = abs(fract(uv.y + 0.5) - 0.5);
  float seam = 1.0 - smoothstep(0.020, 0.035, seamD);
  float stitch = seam * smoothstep(0.4, 0.6, fract(uv.x * 22.0));
  s.h -= seam * 0.12;
  s.h += stitch * 0.16;
  s.alb = mix(s.alb, vec3(0.28, 0.25, 0.19), stitch * 0.6);
  s.ao *= 1.0 - seam * 0.35;

  float grit = speckle(uv, 900.0, 0.10);
  s.alb = mix(s.alb, vec3(0.72, 0.66, 0.52), grit * 0.35);
  s.rough += grit * 0.04;

  applyMacro(s, uv, 0.15, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  rubber: {
    world: 0.8,
    bump: 1.05,
    cavity: 0.5,
    glsl: /* glsl */ `
Surf gen_rubber(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 727.0;

  // --- moulded carbon-black rubber: fine pebbled skin from the mould texture
  Cell peb = cells2(uv * 300.0 + sd, vec2(300.0), 1.0);
  float pebble = 1.0 - smoothstep(0.08, 0.40, peb.f1);
  float micro = fbm01(uv * 620.0 + sd * 2.0, vec2(620.0), 3, 2.0, 0.5);
  float broad = fbm01(uv * 8.0 + 5.0, vec2(8.0), 5, 2.0, 0.55);

  float h = 0.58 + pebble * 0.16 + (micro - 0.5) * 0.06 + (broad - 0.5) * 0.08;

  vec3 base = vec3(0.118, 0.115, 0.121);
  base *= mix(0.70, 1.42, sat(pebble * 0.7 + micro * 0.55));
  base *= mix(0.90, 1.12, broad);

  float rough = 0.82 + (micro - 0.5) * 0.10 - pebble * 0.06;

  // --- circumferential sidewall ribs
  float rib = sin(uv.y * 14.0 * TAU) * 0.5 + 0.5;
  rib = pow(rib, 2.0) * smoothstep(0.3, 0.6, broad);
  h += rib * 0.10;
  base *= 1.0 + rib * 0.15;

  // --- mould parting line
  float pl = 1.0 - smoothstep(0.004, 0.010, abs(fract(uv.y + 0.5) - 0.5));
  h += pl * 0.09;
  base *= 1.0 + pl * 0.25;
  rough -= pl * 0.10;

  // --- ozone cracking: a fine crazed network in the flex zones
  float ck = crackNet(uv, vec2(38.0), 0.05, 0.95, 0.4);
  ck *= smoothstep(0.40, 0.80, fbm01(uv * 4.0 + 61.0, vec2(4.0), 4, 2.0, 0.6)) * (0.4 + 0.6 * uAge);
  h -= ck * 0.22;
  base *= 1.0 - ck * 0.35;
  s.ao = 1.0 - ck * 0.5 - pebble * 0.05;
  rough += ck * 0.08;

  // --- blooming: antiozonant migrates out and greys the surface
  float bloom = smoothstep(0.45, 0.9, fbm01(uv * 6.0 + 131.0, vec2(6.0), 5, 2.0, 0.55)) * uAge;
  base = mix(base, vec3(0.235, 0.228, 0.220), bloom * 0.55);
  rough += bloom * 0.08;

  // --- scuffs where it has been dragged over concrete
  float scuff = sat(gouges(uv, 2.0, 26.0, 0.16, sd + 3.0) + scratches(uv, -1.0, 300.0, 5.0, 0.70, sd) * 0.4);
  base = mix(base, vec3(0.185, 0.176, 0.168), scuff * 0.5);
  rough += scuff * 0.08;
  h -= scuff * 0.03;

  // dust clinging to a slightly tacky surface
  float dust = sat(1.0 - h * 1.6 + turb(uv * 12.0 + 91.0, vec2(12.0), 4, 0.55) * 0.5);
  s.alb = base; s.rough = rough; s.h = h;
  applyDirt(s, dust * 0.22 * uAge, vec3(0.30, 0.28, 0.25), 0.04);

  applyMacro(s, uv, 0.10, 0.04, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  gun_polymer: {
    world: 0.35,
    bump: 1.0,
    cavity: 0.5,
    glsl: /* glsl */ `
Surf gen_gun_polymer(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 761.0;

  // --- moulded grip stipple: staggered rows of truncated pyramids
  float N = 26.0;
  vec2 gp = uv * vec2(N, N);
  float row = floor(gp.y);
  gp.x += mod(row, 2.0) * 0.5;
  vec2 gi = floor(gp);
  vec2 gf = fract(gp) - 0.5;
  float dman = abs(gf.x) + abs(gf.y);
  float pyr = sat(1.0 - dman * 2.15);
  pyr = min(pyr, 0.72) / 0.72;                     // truncated tips
  pyr *= step(0.06, hash12(gi + sd));              // a few cells miss

  // --- polymer skin: fine mould grain plus a faint flow pattern
  float grain = fbm01(uv * 520.0 + sd * 2.0, vec2(520.0), 3, 2.0, 0.5);
  float flow  = fbm01(warp1(uv * 9.0, vec2(9.0), 0.7, 3) + 13.0, vec2(9.0), 5, 2.0, 0.55);
  float speck = speckle(uv, 700.0, 0.06);          // glass-fill flecks

  float h = 0.34 + pyr * 0.46 + (grain - 0.5) * 0.06 + (flow - 0.5) * 0.05;

  vec3 base = vec3(0.128, 0.128, 0.136);
  base *= mix(0.72, 1.38, sat(grain * 0.65 + flow * 0.55));
  base = mix(base, vec3(0.245, 0.238, 0.225), speck * 0.5);

  float rough = 0.66 + (grain - 0.5) * 0.10 - (flow - 0.5) * 0.06;

  // handling polishes the pyramid tips to a low sheen
  float wearField = smoothstep(0.40, 0.85, fbm01(uv * 5.0 + 71.0, vec2(5.0), 5, 2.0, 0.55));
  float polish = smoothstep(0.55, 0.95, pyr) * wearField * mix(0.5, 1.2, uAge);
  rough = mix(rough, 0.34, polish * 0.8);
  base = mix(base, base * 1.5 + 0.010, polish * 0.5);

  // --- mould parting line and an ejector-pin witness mark
  float pl = 1.0 - smoothstep(0.003, 0.008, abs(fract(uv.x + 0.5) - 0.5));
  h += pl * 0.07;
  base *= 1.0 + pl * 0.30;
  rough -= pl * 0.12;

  vec2 ep = fract(uv * vec2(2.0, 3.0)) - 0.5;
  float pin = 1.0 - smoothstep(0.16, 0.19, length(ep));
  pin *= step(0.72, hash12(floor(uv * vec2(2.0, 3.0)) + 3.3));
  h -= pin * 0.05;
  rough += pin * 0.06;
  base *= 1.0 - pin * 0.08;

  s.ao = mix(0.55, 1.0, smoothstep(0.20, 0.75, h));

  // dust and carbon settle between the pyramids
  float valley = sat(1.0 - pyr * 1.6);
  s.alb = base; s.rough = rough; s.h = h;
  applyDirt(s, valley * 0.22 * uAge, vec3(0.13, 0.125, 0.115), 0.05);

  float scuff = sat(gouges(uv, 3.0, 40.0, 0.10, sd + 5.0));
  s.alb = mix(s.alb, vec3(0.18, 0.175, 0.17), scuff * 0.4);
  s.rough += scuff * 0.10;
  s.h -= scuff * 0.03;

  applyMacro(s, uv, 0.08, 0.04, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  foliage: {
    world: 1.0,
    bump: 0.9,
    cavity: 0.7,
    alphaTest: true,
    glsl: /* glsl */ `
/** One layer of overlapping leaves. Returns coverage; writes colour/height/local coords. */
float leafLayer(vec2 uv, float period, float sdo, out vec3 col, out float hh, out float vein){
  Cell c = cells2(uv * period + sdo, vec2(period), 1.0);
  float ang = fract(c.id * 61.7) * TAU;
  vec2 p = rot2(ang) * c.r;
  float ay = mix(0.46, 0.68, fract(c.id * 13.3));
  float ax = mix(0.19, 0.30, fract(c.id * 29.1));
  float ty = sat(abs(p.y) / ay);
  float w = ax * (1.0 - ty * ty) * (1.0 + 0.25 * (1.0 - ty));
  float m = smoothstep(0.0, 0.016, w - abs(p.x)) * smoothstep(0.0, 0.020, ay - abs(p.y));

  // serrated margin
  float serr = sin(p.y / ay * 22.0) * 0.010;
  m *= smoothstep(0.0, 0.012, w + serr - abs(p.x));

  // midrib and side veins
  float midrib = 1.0 - smoothstep(0.0, 0.012, abs(p.x));
  float side = 1.0 - smoothstep(0.0, 0.006, abs(fract((p.y / ay) * 7.0 + p.x / max(w, 1e-3) * 0.8) - 0.5) * 0.06);
  vein = sat(midrib * 0.9 + side * 0.55) * m;

  vec3 young = vec3(0.205, 0.365, 0.125);
  vec3 mature = vec3(0.118, 0.238, 0.088);
  vec3 autumnal = vec3(0.435, 0.348, 0.098);
  float t = fract(c.id * 91.7);
  col = mix(young, mature, t);
  col = mix(col, autumnal, smoothstep(0.80, 1.0, fract(c.id * 37.1)));
  col *= mix(0.80, 1.20, fbm01(uv * 180.0 + c.id * 30.0, vec2(180.0), 3, 2.0, 0.5));
  // lamina between the veins is slightly paler and puckered
  float pucker = fbm01(uv * 90.0 + c.id * 11.0, vec2(90.0), 3, 2.0, 0.5);
  col *= mix(0.92, 1.10, pucker);
  col = mix(col, col * 0.55, vein * 0.5);

  hh = m * (0.55 + 0.35 * (1.0 - ty)) + pucker * 0.10 * m - vein * 0.06;
  return m;
}

Surf gen_foliage(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 797.0;

  vec3 col = vec3(0.0), c1, c2, c3;
  float h1, h2, h3, v1, v2, v3;
  float m1 = leafLayer(uv, 5.0, sd, c1, h1, v1);
  float m2 = leafLayer(uv + vec2(0.31, 0.17), 6.0, sd + 40.0, c2, h2, v2);
  float m3 = leafLayer(uv + vec2(0.63, 0.44), 8.0, sd + 80.0, c3, h3, v3);

  // composite back to front; deeper layers are shadowed by the ones above
  vec3 base = c3 * 0.55;
  float h = h3 * 0.45;
  float vein = v3;
  float shade = m3 * 0.55;
  base = mix(base, c2 * 0.78, m2);
  h = mix(h, 0.25 + h2 * 0.55, m2);
  vein = mix(vein, v2, m2);
  shade = mix(shade, m2 * 0.78, m2);
  base = mix(base, c1, m1);
  h = mix(h, 0.40 + h1 * 0.60, m1);
  vein = mix(vein, v1, m1);
  shade = mix(shade, 1.0, m1);

  float cover = sat(m1 + m2 * 0.9 + m3 * 0.8);

  s.alb = base;
  s.h = h;
  s.rough = 0.52 + vein * 0.18 + (1.0 - shade) * 0.12;
  s.metal = 0.0;
  s.ao = mix(0.42, 1.0, sat(shade)) * (1.0 - vein * 0.15);
  s.op = smoothstep(0.35, 0.55, cover);

  // dust and insect damage
  float dust = fbm01(uv * 40.0 + 21.0, vec2(40.0), 4, 2.0, 0.5);
  applyDirt(s, sat(dust * 0.7 - 0.25) * 0.25 * uAge, vec3(0.30, 0.29, 0.22), 0.06);
  float bite = blobs(uv, vec2(24.0), 0.10, 0.12, 0.4, sd + 3.0);
  s.op *= 1.0 - smoothstep(0.4, 0.8, bite);
  s.alb = mix(s.alb, vec3(0.28, 0.22, 0.09), smoothstep(0.1, 0.4, bite) * 0.5);

  applyMacro(s, uv, 0.12, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },
};
