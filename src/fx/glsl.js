/**
 * Small self-contained noise/shape library for the FX shaders.
 *
 * Deliberately *not* imported from `src/assets/shaders/` — those chunks belong
 * to the texture agent and are authored for GLSL3 render targets with their own
 * uniform conventions. The FX materials are GLSL1 (so they can `#include` the
 * patched three.js fog chunks and pick up aerial perspective for free), so they
 * carry their own copy. It is ~60 lines and it decouples two subsystems.
 */

export const FX_NOISE = /* glsl */ `
float fxHash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

float fxHash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 fxHash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/** Value noise with a quintic fade — smooth enough that its gradient is usable. */
float fxNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = fxHash12(i);
  float b = fxHash12(i + vec2(1.0, 0.0));
  float c = fxHash12(i + vec2(0.0, 1.0));
  float d = fxHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fxFbm(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 7; i++){
    if (i >= oct) break;
    s += a * fxNoise(p);
    n += a;
    a *= 0.5;
    p = rot * p * 2.03 + 17.1;
  }
  return s / max(n, 1e-4);
}

/** Ridged fBm — the sharp filaments that make a fireball read as combustion. */
float fxRidge(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 7; i++){
    if (i >= oct) break;
    float v = 1.0 - abs(fxNoise(p) * 2.0 - 1.0);
    s += a * v * v;
    n += a;
    a *= 0.55;
    p = rot * p * 2.17 + 5.3;
  }
  return s / max(n, 1e-4);
}

/** Worley F1, used for the cellular clumping in smoke and the spall in decals. */
float fxWorley(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 o = fxHash22(i + g);
      d = min(d, length(g + o - f));
    }
  }
  return d;
}

float fxSat(float x){ return clamp(x, 0.0, 1.0); }
vec3 fxSat3(vec3 x){ return clamp(x, vec3(0.0), vec3(1.0)); }
`;
