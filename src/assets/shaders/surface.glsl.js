/**
 * Surface description struct plus the weathering vocabulary every generator
 * shares: rain runoff, crack networks, per-unit layout (brick/plank/tile), dirt
 * accumulation, chipped-paint masks and the mandatory low-frequency macro
 * variation that stops a 20 m wall reading as one repeated stamp.
 *
 * Albedo is authored directly in sRGB-encoded 0..1 (the way a texture artist
 * picks colours); the albedo target is tagged SRGBColorSpace so three decodes it.
 */
export const SURFACE_GLSL = /* glsl */ `
struct Surf {
  vec3  alb;    // sRGB-encoded base colour
  float rough;  // perceptual roughness
  float metal;
  float ao;     // authored cavity occlusion
  float h;      // height field, 0..1, drives the analytic normal
  float op;     // opacity / cutout mask
};

Surf defaultSurf(){
  Surf s;
  s.alb = vec3(0.5); s.rough = 0.85; s.metal = 0.0; s.ao = 1.0; s.h = 0.5; s.op = 1.0;
  return s;
}

// --- colour utilities -------------------------------------------------------
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}

vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, sat3(p - K.xxx), c.y);
}

/** Per-unit colour jitter (per brick, per plank, per tile) in HSV so hues stay plausible. */
vec3 jitterHSV(vec3 base, vec3 r, float hAmt, float sAmt, float vAmt){
  vec3 hsv = rgb2hsv(base);
  hsv.x = fract(hsv.x + (r.x - 0.5) * hAmt);
  hsv.y = sat(hsv.y * (1.0 + (r.y - 0.5) * sAmt));
  hsv.z = sat(hsv.z * (1.0 + (r.z - 0.5) * vAmt));
  return hsv2rgb(hsv);
}

// --- macro variation --------------------------------------------------------
/**
 * Large-scale albedo/roughness drift. Every generator calls this last so no
 * material is uniform across its own tile; combined with a 3-5 m world footprint
 * per tile this is what breaks the stamped-wallpaper read.
 */
void applyMacro(inout Surf s, vec2 uv, float albAmt, float roughAmt, float seed){
  float m1 = fbm(uv * 2.0 + seed * 3.7, vec2(2.0), 3, 2.0, 0.6);
  float m2 = fbm(uv * 5.0 + seed * 1.9 + 17.0, vec2(5.0), 4, 2.0, 0.55);
  float m3 = fbm(uv * 11.0 + seed * 5.1 + 41.0, vec2(11.0), 3, 2.0, 0.5);
  float m = m1 * 0.58 + m2 * 0.30 + m3 * 0.12;
  s.alb *= 1.0 + m * albAmt;
  s.rough = sat(s.rough + (m1 * 0.7 + m3 * 0.3) * roughAmt);
  s.alb = max(s.alb, vec3(0.0));
}

// --- integer shear: lets diagonal features tile on the torus ----------------
vec2 shear(vec2 uv, float k){ return vec2(uv.x + k * uv.y, uv.y); }

// --- weathering primitives --------------------------------------------------
/** Gravity-driven rain runoff: wobbly vertical streaks that start and stop. */
float runoff(vec2 uv, float cols, float seed){
  float wobble = fbm(vec2(uv.x * 8.0, uv.y * 3.0) + seed, vec2(8.0, 3.0), 4, 2.0, 0.5) * 0.02;
  float x = (uv.x + wobble) * cols;
  float col = floor(x);
  vec2 h = hash22(vec2(mod(col, cols), seed * 13.0 + 0.5));
  if (h.x > 0.62) return 0.0;
  float w = mix(0.08, 0.34, h.y);
  float m = smoothstep(w, 0.0, abs(fract(x) - 0.5));
  vec2 h2 = hash22(vec2(mod(col, cols) + 0.5, seed * 7.0 + 2.5));
  float len = mix(0.25, 0.95, h2.x);
  float y = fract(uv.y - h2.y);
  float v = smoothstep(0.0, 0.10, y) * smoothstep(len, len * 0.45, y);
  float grain = fbm01(vec2(uv.x * 60.0, uv.y * 12.0) + seed, vec2(60.0, 12.0), 4, 2.0, 0.5);
  return m * v * mix(0.55, 1.0, grain);
}

/** Multi-scale voronoi-edge crack network. width in cell units. */
float crackNet(vec2 uv, vec2 period, float width, float jitter, float warpAmt){
  vec2 p = uv * period;
  p += warpAmt * vec2(pnoise(uv * period * 0.5, period * 0.5),
                      pnoise(uv * period * 0.5 + 7.7, period * 0.5));
  float e = cellEdge(p, period, jitter);
  return 1.0 - smoothstep(0.0, width, e);
}

/** Scattered blobs (oil, stains, moss). density 0..1 picks how many cells fire. */
float blobs(vec2 uv, vec2 period, float density, float radius, float soft, float seed){
  vec2 p = warp1(uv * period + seed, period, 0.55, 3);
  Cell c = cells2(p, period, 1.0);
  if (c.id > density) return 0.0;
  float r = radius * mix(0.5, 1.4, fract(c.id * 91.7));
  return 1.0 - smoothstep(r * (1.0 - soft), r, c.f1);
}

/** Fine directional scratches. k is an integer shear so they stay tileable. */
float scratches(vec2 uv, float k, float across, float along, float density, float seed){
  vec2 q = shear(uv, k);
  vec2 p = vec2(q.x * across, q.y * along) + seed;
  float n = vnoise(p, vec2(across, along));
  float n2 = vnoise(p * vec2(1.0, 0.25) + 13.0, vec2(across, along * 0.25));
  float line = smoothstep(density, density + 0.06, n * 0.6 + n2 * 0.4);
  return line;
}

/** Sparse hero scratches — a few deep gouges rather than a uniform brush field. */
float gouges(vec2 uv, float k, float across, float density, float seed){
  vec2 q = shear(uv, k);
  float x = q.x * across;
  float col = floor(x);
  vec2 h = hash22(vec2(mod(col, across), seed));
  if (h.x > density) return 0.0;
  float w = mix(0.02, 0.09, h.y);
  float m = smoothstep(w, 0.0, abs(fract(x) - 0.5));
  float y = fract(q.y - h.y * 3.1);
  float len = mix(0.1, 0.6, fract(h.x * 37.0));
  return m * smoothstep(0.0, 0.03, y) * smoothstep(len, len * 0.6, y);
}

/** Micro speckle: sand grains, cement dust, glass beads. */
float speckle(vec2 uv, float period, float density){
  float n = hash12(floor(uv * period));
  return step(1.0 - density, n) * mix(0.6, 1.0, hash12(floor(uv * period) + 3.7));
}

// --- layout primitives ------------------------------------------------------
struct Unit {
  vec2  local;   // 0..1 inside the unit
  vec2  id;      // wrapped unit index, hashable
  float joint;   // 1 inside the mortar/gap, 0 on the face
  float edge;    // 0 at the unit border, 1 at its centre
};

/** Running-bond masonry. count = (units across, courses up), joint in unit fractions. */
Unit bondLayout(vec2 uv, vec2 count, vec2 joint, float stagger, float wobble){
  vec2 p = uv * count;
  float row = floor(p.y);
  float jx = (hash12(vec2(mod(row, count.y), 3.3)) - 0.5) * wobble;
  p.x += mod(row, 2.0) * stagger + jx;
  vec2 i = floor(p);
  vec2 f = p - i;
  Unit u;
  u.id = mod(i, count);
  u.local = f;
  vec2 d = min(f, 1.0 - f);
  float jm = 1.0 - smoothstep(joint.x * 0.45, joint.x, d.x) * smoothstep(joint.y * 0.45, joint.y, d.y);
  u.joint = jm;
  u.edge = min(smoothstep(0.0, joint.x * 2.6, d.x), smoothstep(0.0, joint.y * 2.6, d.y));
  return u;
}

/** Boards running along U with random butt joints, for planks and siding. */
Unit plankLayout(vec2 uv, float rows, float lengthScale, float gap){
  float p = uv.y * rows;
  float row = floor(p);
  float fy = p - row;
  float off = hash12(vec2(mod(row, rows), 1.7));
  float px = uv.x * lengthScale + off * 3.0;
  float seg = floor(px);
  float fx = px - seg;
  Unit u;
  u.id = vec2(mod(seg, lengthScale), mod(row, rows));
  u.local = vec2(fx, fy);
  float dy = min(fy, 1.0 - fy);
  float dx = min(fx, 1.0 - fx);
  u.joint = max(1.0 - smoothstep(gap * 0.3, gap, dy), 1.0 - smoothstep(0.004, 0.012, dx));
  u.edge = min(smoothstep(0.0, gap * 3.0, dy), smoothstep(0.0, 0.05, dx));
  return u;
}

// --- composite helpers ------------------------------------------------------
/** Dirt darkens, desaturates and roughens. One call keeps grime consistent. */
void applyDirt(inout Surf s, float amount, vec3 dirtColor, float roughUp){
  amount = sat(amount);
  s.alb = mix(s.alb, dirtColor * mix(0.85, 1.15, luma(s.alb)), amount);
  s.rough = sat(mix(s.rough, min(0.97, s.rough + roughUp), amount));
  s.metal *= 1.0 - amount * 0.9;
}

/** Water/oil darkens and smooths instead. */
void applyWet(inout Surf s, float amount, float darken){
  amount = sat(amount);
  s.alb *= mix(1.0, darken, amount);
  s.rough = mix(s.rough, 0.12, amount * 0.85);
}
`;
