/**
 * Utility lookup textures for other systems: dithering blue noise for postfx,
 * curl noise for smoke advection, tiled worley for volumetrics, and a grain
 * plate. Kept separate from the PBR generators because these are linear data
 * textures with no mipmaps, not surface descriptions.
 */
export const FXNOISE_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uSize;
uniform float uSeed;
in vec2 vUv;
layout(location = 0) out vec4 gOut;

float wn(vec2 p, float sz, float sd){ return hash12(mod(p, vec2(sz)) + sd); }

/** White noise pushed toward a blue spectrum by subtracting its own low-pass. */
float blueNoise(vec2 ip, float sz, float sd){
  float c = wn(ip, sz, sd);
  float sum = 0.0, wsum = 0.0;
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      if (i == 0 && j == 0) continue;
      float w = exp(-float(i * i + j * j) / 4.5);
      sum += wn(ip + vec2(float(i), float(j)), sz, sd) * w;
      wsum += w;
    }
  }
  return sat((c - sum / wsum) * 1.75 + 0.5);
}

float fbm3(vec3 p, vec3 period, int oct){
  float a = 0.5, s = 0.0, norm = 0.0;
  vec3 pp = p, per = period;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * vnoise3(pp, per);
    norm += a;
    a *= 0.5; pp *= 2.0; per *= 2.0;
  }
  return s / max(norm, 1e-4);
}

void main(){
  vec2 uv = vUv;
  vec2 ip = floor(uv * uSize);

#if KIND == 0            // blue noise: 4 decorrelated dither channels
  gOut = vec4(
    blueNoise(ip, uSize, uSeed),
    blueNoise(ip, uSize, uSeed + 37.0),
    blueNoise(ip, uSize, uSeed + 91.0),
    fract(52.9829189 * fract(0.06711056 * ip.x + 0.00583715 * ip.y))
  );

#elif KIND == 1          // curl noise for smoke advection + a density plate
  float eps = 1.0 / uSize * 2.0;
  float p0 = fbm(uv * 6.0, vec2(6.0), 5, 2.0, 0.55);
  float px = fbm(uv * 6.0 + vec2(eps * 6.0, 0.0), vec2(6.0), 5, 2.0, 0.55);
  float py = fbm(uv * 6.0 + vec2(0.0, eps * 6.0), vec2(6.0), 5, 2.0, 0.55);
  vec2 curl = vec2((py - p0), -(px - p0)) / eps;
  curl = normalize(curl + 1e-5) * sat(length(curl) * 0.35);
  float dens = fbm01(warp2(uv * 5.0, vec2(5.0), 1.2, 4), vec2(5.0), 6, 2.0, 0.55);
  float wisp = 1.0 - fbmCell(uv * 14.0, vec2(14.0), 3, 0.55, 1.0);
  gOut = vec4(curl * 0.5 + 0.5, dens, sat(dens * 0.6 + wisp * 0.6));

#elif KIND == 2          // tiled worley stack for volumetrics / detail erosion
  float w1 = 1.0 - cells2(uv * 4.0, vec2(4.0), 1.0).f1;
  float w2 = 1.0 - cells2(uv * 8.0, vec2(8.0), 1.0).f1;
  float w3 = 1.0 - cells2(uv * 16.0, vec2(16.0), 1.0).f1;
  float w4 = 1.0 - cells2(uv * 32.0, vec2(32.0), 1.0).f1;
  gOut = vec4(sat(w1), sat(w2), sat(w3), sat(w4));

#elif KIND == 3          // 3D-sliced worley/perlin mix for volumetric smoke
  float z = uSeed;
  vec2 wc = cells3(vec3(uv * 6.0, z * 6.0), vec3(6.0), 1.0);
  float perlin = fbm3(vec3(uv * 5.0, z * 5.0), vec3(5.0), 5) * 0.5 + 0.5;
  float worl = 1.0 - wc.x;
  gOut = vec4(sat(perlin), sat(worl), sat(remap(perlin, worl - 1.0, 1.0, 0.0, 1.0)),
              sat(1.0 - cells3(vec3(uv * 14.0, z * 14.0), vec3(14.0), 1.0).x));

#else                    // film grain / dust motes
  float g = hash12(ip + uSeed);
  float m = fbm01(uv * 90.0 + uSeed, vec2(90.0), 4, 2.0, 0.5);
  float mote = speckle(uv, uSize * 0.5, 0.02);
  gOut = vec4(g, m, mote, blueNoise(ip, uSize, uSeed));
#endif
}
`;

export const FXNOISE_KINDS = { blue: 0, curl: 1, worley: 2, smoke: 3, grain: 4 };
