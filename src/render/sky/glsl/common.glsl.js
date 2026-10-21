/**
 * Hash / noise / projection helpers shared by every sky pass. Kept as one
 * string so the LUT, cloud and dome shaders provably agree on the equirect
 * parametrisation — a mismatch there shows up as a shimmering horizon seam.
 */
export const COMMON_GLSL = /* glsl */ `
#define PI 3.14159265359
#define INV_PI 0.31830988618
#define INV_2PI 0.15915494309

float saturate1(float x){ return clamp(x, 0.0, 1.0); }
vec3  saturate3(vec3 x){ return clamp(x, 0.0, 1.0); }
float remap(float v, float a, float b, float c, float d){
  return c + (clamp(v, a, b) - a) / max(b - a, 1e-5) * (d - c);
}

float hash11(float p){
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash23(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash33(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Trilinear value noise. Cheap enough to afford 3-4 octaves inside a light march. */
float vnoise(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm3(vec3 p, int octaves){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= octaves) break;
    s += a * vnoise(p);
    n += a;
    a *= 0.5;
    p = p * 2.03 + vec3(17.1, 9.7, 23.3);
  }
  return s / max(n, 1e-4);
}

/** Billow variant: rounded cauliflower lobes, the shape cumulus actually has. */
float puff(vec3 p){ return 1.0 - abs(2.0 * vnoise(p) - 1.0); }

float puffFbm(vec3 p, int octaves){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= octaves) break;
    s += a * puff(p);
    n += a;
    a *= 0.5;
    p = p * 2.17 + vec3(5.3, 11.9, 3.7);
  }
  return s / max(n, 1e-4);
}

float fbm2(vec2 p, int octaves){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= octaves) break;
    s += a * vnoise(vec3(p, 3.7));
    n += a;
    a *= 0.5;
    p = p * 2.11 + vec2(31.7, 13.1);
  }
  return s / max(n, 1e-4);
}

/**
 * Sky parametrisation: azimuth wraps in u, elevation uses a sqrt warp in v so
 * texel density piles up at the horizon where the gradient is sharpest.
 */
vec2 dirToSkyUV(vec3 d){
  float u = atan(d.z, d.x) * INV_2PI + 0.5;
  float sy = d.y < 0.0 ? -1.0 : 1.0;
  return vec2(u, 0.5 + 0.5 * sy * sqrt(abs(d.y)));
}
vec3 skyUVToDir(vec2 uv){
  float phi = (uv.x - 0.5) * 2.0 * PI;
  float t = uv.y * 2.0 - 1.0;
  float y = (t < 0.0 ? -1.0 : 1.0) * t * t;
  float r = sqrt(max(0.0, 1.0 - y * y));
  return vec3(cos(phi) * r, y, sin(phi) * r);
}

/**
 * Cloud cache parametrisation. Clouds never appear below -7 degrees, so the
 * map spends none of its rows underground and gets ~2x the vertical density of
 * the sky LUT for the same memory.
 */
vec2 dirToCloudUV(vec3 d){
  float u = atan(d.z, d.x) * INV_2PI + 0.5;
  return vec2(u, sqrt(saturate1((d.y + 0.12) / 1.12)));
}
vec3 cloudUVToDir(vec2 uv){
  float phi = (uv.x - 0.5) * 2.0 * PI;
  float y = uv.y * uv.y * 1.12 - 0.12;
  float r = sqrt(max(0.0, 1.0 - y * y));
  return vec3(cos(phi) * r, y, sin(phi) * r);
}

/** Distance to the far intersection with a sphere of radius r centred at the origin; -1 if missed. */
float raySphereFar(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  return -b + sqrt(d);
}
/** Distance to the near intersection; -1 if missed or behind. */
float raySphereNear(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  float t = -b - sqrt(d);
  return t < 0.0 ? -1.0 : t;
}

float rayleighPhase(float c){ return 0.05968310365 * (1.0 + c * c); }

/** Cornette-Shanks: closer to measured Mie than plain HG and the sharp forward lobe is what makes the aureole. */
float miePhase(float c, float g){
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * c;
  return (3.0 * (1.0 - g2) * (1.0 + c * c)) / (8.0 * PI * (2.0 + g2) * d * sqrt(max(d, 1e-4)));
}
float hgPhase(float c, float g){
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * c;
  return 0.07957747155 * (1.0 - g2) / (d * sqrt(max(d, 1e-4)));
}
`;
