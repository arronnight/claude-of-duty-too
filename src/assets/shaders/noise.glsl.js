/**
 * Tileable GLSL noise library shared by every procedural material generator.
 *
 * Everything here is *periodic*: a wall texture that repeats every 4 m must have
 * no seam, so each primitive takes an explicit integer period and hashes cell
 * coordinates modulo that period. Non-periodic noise (plain simplex) is provided
 * only for cases that never tile, such as one-shot FX lookup textures.
 */
export const NOISE_GLSL = /* glsl */ `
#define PI  3.141592653589793
#define TAU 6.283185307179586

float sat(float x){ return clamp(x, 0.0, 1.0); }
vec2  sat2(vec2 x){ return clamp(x, 0.0, 1.0); }
vec3  sat3(vec3 x){ return clamp(x, 0.0, 1.0); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float remap(float x, float a, float b, float c, float d){ return c + (d - c) * sat((x - a) / (b - a)); }
mat2  rot2(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float sq(float x){ return x * x; }
float cub(float x){ return x * x * x; }

// --- hashes (Dave Hoskins, hash without sine) -------------------------------
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(p.xyx * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2  hash21(float p){ vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec2  hash22(vec2 p){ vec3 p3 = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3  hash32(vec2 p){ vec3 p3 = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
vec3  hash33(vec3 p3){ p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec4  hash42(vec2 p){ vec4 p4 = fract(p.xyxy * vec4(0.1031, 0.1030, 0.0973, 0.1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }

// --- periodic value noise ---------------------------------------------------
float vnoise(vec2 p, vec2 period){
  period = max(period, vec2(1.0));
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, period));
  float b = hash12(mod(i + vec2(1.0, 0.0), period));
  float c = hash12(mod(i + vec2(0.0, 1.0), period));
  float d = hash12(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float vnoise3(vec3 p, vec3 period){
  period = max(period, vec3(1.0));
  vec3 i = floor(p), f = p - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(mod(i + vec3(0,0,0), period));
  float n100 = hash13(mod(i + vec3(1,0,0), period));
  float n010 = hash13(mod(i + vec3(0,1,0), period));
  float n110 = hash13(mod(i + vec3(1,1,0), period));
  float n001 = hash13(mod(i + vec3(0,0,1), period));
  float n101 = hash13(mod(i + vec3(1,0,1), period));
  float n011 = hash13(mod(i + vec3(0,1,1), period));
  float n111 = hash13(mod(i + vec3(1,1,1), period));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

// --- periodic gradient (Perlin) noise, ~[-1,1] ------------------------------
vec2 grad2(vec2 i, vec2 period){
  float a = hash12(mod(i, period)) * TAU;
  return vec2(cos(a), sin(a));
}

float pnoise(vec2 p, vec2 period){
  period = max(period, vec2(1.0));
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad2(i,                 period), f);
  float b = dot(grad2(i + vec2(1.0,0.0), period), f - vec2(1.0, 0.0));
  float c = dot(grad2(i + vec2(0.0,1.0), period), f - vec2(0.0, 1.0));
  float d = dot(grad2(i + vec2(1.0,1.0), period), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4142136;
}

/** Value plus analytic gradient — used for flow-aligned streaking and slope masks. */
vec3 pnoised(vec2 p, vec2 period){
  period = max(period, vec2(1.0));
  vec2 i = floor(p), f = p - i;
  vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = grad2(i,                 period);
  vec2 gb = grad2(i + vec2(1.0,0.0), period);
  vec2 gc = grad2(i + vec2(0.0,1.0), period);
  vec2 gd = grad2(i + vec2(1.0,1.0), period);
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  vec2 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * (vec2(u.y, u.x) * (va - vb - vc + vd) + vec2(vb, vc) - va);
  return vec3(v, g) * 1.4142136;
}

// --- simplex (non-periodic, for FX lookups) ---------------------------------
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute289(vec3 x){ return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v){
  const vec4 C = vec4(0.211324865, 0.366025404, -0.577350269, 0.024390244);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute289(permute289(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291 - 0.85373472 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// --- periodic worley / voronoi ---------------------------------------------
struct Cell {
  float f1;   // nearest feature distance
  float f2;   // second nearest
  float id;   // stable per-cell random in [0,1)
  vec2  r;    // vector from sample point to nearest feature
  vec2  c;    // wrapped integer cell coordinate of the nearest feature
};

Cell cells2(vec2 p, vec2 period, float jitter){
  period = max(period, vec2(1.0));
  vec2 n = floor(p), f = p - n;
  Cell o;
  o.f1 = 9.0; o.f2 = 9.0; o.id = 0.0; o.r = vec2(0.0); o.c = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 cc = mod(n + g, period);
      vec2 off = hash22(cc + 0.13);
      vec2 r = g + 0.5 + (off - 0.5) * jitter - f;
      float d = dot(r, r);
      if (d < o.f1) { o.f2 = o.f1; o.f1 = d; o.id = hash12(cc + 7.31); o.r = r; o.c = cc; }
      else if (d < o.f2) { o.f2 = d; }
    }
  }
  o.f1 = sqrt(o.f1); o.f2 = sqrt(o.f2);
  return o;
}

/** Chebyshev-flavoured cells: angular, chipped-looking shards rather than blobs. */
Cell cellsAngular(vec2 p, vec2 period, float jitter){
  period = max(period, vec2(1.0));
  vec2 n = floor(p), f = p - n;
  Cell o;
  o.f1 = 9.0; o.f2 = 9.0; o.id = 0.0; o.r = vec2(0.0); o.c = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 cc = mod(n + g, period);
      vec2 off = hash22(cc + 0.13);
      vec2 r = g + 0.5 + (off - 0.5) * jitter - f;
      vec2 rr = rot2(hash12(cc + 2.7) * TAU) * r;
      float d = max(abs(rr.x), abs(rr.y)) * 1.35 + length(r) * 0.25;
      if (d < o.f1) { o.f2 = o.f1; o.f1 = d; o.id = hash12(cc + 7.31); o.r = r; o.c = cc; }
      else if (d < o.f2) { o.f2 = d; }
    }
  }
  return o;
}

vec2 cells3(vec3 p, vec3 period, float jitter){
  period = max(period, vec3(1.0));
  vec3 n = floor(p), f = p - n;
  float f1 = 9.0, f2 = 9.0;
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 g = vec3(float(i), float(j), float(k));
        vec3 cc = mod(n + g, period);
        vec3 off = hash33(cc + 0.19);
        vec3 r = g + 0.5 + (off - 0.5) * jitter - f;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
  }
  return sqrt(vec2(f1, f2));
}

/** Distance to the nearest voronoi *edge* — the backbone of every crack network. */
float cellEdge(vec2 p, vec2 period, float jitter){
  Cell c = cells2(p, period, jitter);
  return c.f2 - c.f1;
}

// --- fractal stacks ---------------------------------------------------------
float fbm(vec2 p, vec2 period, int oct, float lac, float gain){
  float a = 0.5, s = 0.0, norm = 0.0;
  vec2 pp = p, per = period;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    s += a * pnoise(pp, per);
    norm += a;
    a *= gain; pp *= lac; per *= lac;
  }
  return s / max(norm, 1e-4);
}

float fbm01(vec2 p, vec2 period, int oct, float lac, float gain){
  return fbm(p, period, oct, lac, gain) * 0.5 + 0.5;
}

/** Sharp-crested ridges: rock strata, bark furrows, cracked render. */
float ridged(vec2 p, vec2 period, int oct, float gain){
  float a = 0.5, s = 0.0, norm = 0.0, prev = 1.0;
  vec2 pp = p, per = period;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(pnoise(pp, per));
    n *= n * prev;
    prev = n;
    s += a * n;
    norm += a;
    a *= gain; pp *= 2.0; per *= 2.0;
  }
  return s / max(norm, 1e-4);
}

/** Billowy absolute-value fBm — dust, cloud, corrosion blooms. */
float turb(vec2 p, vec2 period, int oct, float gain){
  float a = 0.5, s = 0.0, norm = 0.0;
  vec2 pp = p, per = period;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    s += a * abs(pnoise(pp, per));
    norm += a;
    a *= gain; pp *= 2.0; per *= 2.0;
  }
  return s / max(norm, 1e-4);
}

float fbmCell(vec2 p, vec2 period, int oct, float gain, float jitter){
  float a = 0.5, s = 0.0, norm = 0.0;
  vec2 pp = p, per = period;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * cells2(pp, per, jitter).f1;
    norm += a;
    a *= gain; pp *= 2.0; per *= 2.0;
  }
  return s / max(norm, 1e-4);
}

/** Two-level domain warp. The single cheapest way to kill "computer noise" look. */
vec2 warp2(vec2 p, vec2 period, float amt, int oct){
  vec2 q = vec2(fbm(p, period, oct, 2.0, 0.5), fbm(p + vec2(5.2, 1.3), period, oct, 2.0, 0.5));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2), period, oct, 2.0, 0.5),
                fbm(p + 4.0 * q + vec2(8.3, 2.8), period, oct, 2.0, 0.5));
  return p + amt * r;
}

vec2 warp1(vec2 p, vec2 period, float amt, int oct){
  return p + amt * vec2(fbm(p, period, oct, 2.0, 0.5), fbm(p + vec2(31.7, 11.2), period, oct, 2.0, 0.5));
}
`;
