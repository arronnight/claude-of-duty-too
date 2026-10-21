/**
 * Two-layer volumetric cloud raymarch, rendered into a directional cache one
 * horizontal band per frame instead of full-screen every frame.
 *
 * Density comes from the baked Perlin-Worley volume plus a weather map, so a
 * sample is two texture fetches rather than seventy hashes — that is what pays
 * for a cache resolution high enough to keep cumulus edges crisp.
 *
 * Lighting is Beer + powder + a three-octave multiple-scattering approximation
 * (Wrenninge / Hillaire): each octave halves extinction and narrows the phase,
 * so thick cores stay bright while translucent edges keep their dark rim.
 */
export const CLOUDS_GLSL = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uNoiseVol;
uniform sampler2D uWeather;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCirrusAmount;
uniform vec3 uCloudWind;
uniform float uCloudTime;

const float CLD_BOT = 1.35;
const float CLD_TOP = 4.90;
const float CIRRUS_ALT = 8.30;
const float WEATHER_SCALE = 0.0068;   // 1 / 147 km domain
const float SHAPE_SCALE = 0.098;      // volume tiles every ~10 km

vec3 weatherAt(vec2 xz){
  vec2 uv = (xz + uCloudWind.xz * uCloudTime * 2.5) * WEATHER_SCALE;
  return texture(uWeather, uv).rgb;
}

/** Flat base, cauliflower crown; typ slides between fair-weather and towering. */
float heightProfile(float hf, float typ){
  float base = smoothstep(0.0, mix(0.07, 0.17, typ), hf);
  float top = 1.0 - smoothstep(mix(0.34, 0.82, typ), 1.0, hf);
  return base * top;
}

/** lod 1 skips the erosion fetch and is what the light march uses. */
float cloudDensity(vec3 p, float hf, int lod){
  vec3 w = weatherAt(p.xz);
  float cov = saturate1(w.r * mix(0.45, 1.75, uCloudCoverage) - 0.04);
  if (cov <= 0.015) return 0.0;

  vec3 q = (p + uCloudWind * uCloudTime) * SHAPE_SCALE;
  vec4 n = texture(uNoiseVol, q);

  float d = remap(n.r, 1.0 - cov, 1.0, 0.0, 1.0);
  d = d * d * (3.0 - 2.0 * d);
  d *= heightProfile(hf, w.g);
  if (d <= 0.0) return 0.0;
  d *= mix(0.55, 1.25, hf) * mix(0.75, 1.15, w.b);

  if (lod == 0){
    vec4 hi = texture(uNoiseVol, q * 6.7 + vec3(0.0, uCloudTime * 0.004, 0.0));
    float e = hi.g * 0.58 + hi.b * 0.28 + hi.a * 0.14;
    d = remap(d, e * mix(0.72, 0.24, hf), 1.0, 0.0, 1.0);
  }
  return saturate1(d) * uCloudDensity;
}

/**
 * Cirrus: the shape volume sampled on a sheared plane. Anisotropic scaling of
 * a tiling volume stays continuous, and the higher detail octaves give the
 * fibrous streaks that separate ice cloud from a smeared cumulus.
 */
float cirrusDensity(vec3 p){
  vec2 xz = p.xz + uCloudWind.xz * uCloudTime * 5.0;
  vec3 c = vec3(xz.x * 0.20 + xz.y * 0.07, 0.37, xz.y * 1.15) * WEATHER_SCALE * 3.4;
  vec4 n = texture(uNoiseVol, c);
  vec4 n2 = texture(uNoiseVol, c * 5.3 + 0.31);
  float fib = n.r * 0.5 + (n2.g * 0.62 + n2.b * 0.38) * 0.5;
  float cover = texture(uWeather, xz * WEATHER_SCALE * 0.62 + 0.23).r;
  float d = remap(fib, 0.50, 0.86, 0.0, 1.0) * remap(cover, 0.46, 0.86, 0.0, 1.0);
  return saturate1(d) * uCirrusAmount;
}

float cloudLightMarch(vec3 p, vec3 L, float sigma){
  float tau = 0.0;
  float t = 0.0;
  for (int i = 0; i < 5; i++){
    float st = 0.13 * exp2(float(i) * 1.02);
    vec3 q = p + L * (t + st * 0.5);
    float hf = (q.y + 0.02 - CLD_BOT) / (CLD_TOP - CLD_BOT);
    if (hf > 0.0 && hf < 1.0) tau += cloudDensity(q, hf, 1) * st;
    t += st;
  }
  // One long cone tap catches the shadow cast by a neighbouring tower.
  vec3 far = p + L * 5.0;
  float hff = (far.y + 0.02 - CLD_BOT) / (CLD_TOP - CLD_BOT);
  if (hff > 0.0 && hff < 1.0) tau += cloudDensity(far, hff, 1) * 2.6;
  return tau * sigma;
}

/**
 * Premultiplied scattered radiance in rgb, 1 - transmittance in a. Distances
 * are kilometres from an observer standing 20 m above a spherical earth.
 */
vec4 marchClouds(vec3 rd, vec3 sunDir, vec3 sunLight, vec3 skyTop, vec3 skyBottom,
                 vec3 moonDir, vec3 moonLight, float jitter, vec3 hazeColor){
  vec3 rel = vec3(0.0, ATM_RG + 0.02, 0.0);
  vec3 scatter = vec3(0.0);
  float transmit = 1.0;
  float depthSum = 0.0;
  float depthW = 0.0;

  const float sigma = 1.35;
  float cosSun = dot(rd, sunDir);
  float cosMoon = dot(rd, moonDir);
  bool sunOn = (sunLight.r + sunLight.g + sunLight.b) > 0.002;
  bool moonOn = (moonLight.r + moonLight.g + moonLight.b) > 0.002;

  float tIn = raySphereFar(rel, rd, ATM_RG + CLD_BOT);
  float tOut = raySphereFar(rel, rd, ATM_RG + CLD_TOP);

  if (rd.y > -0.012 && tOut > 0.0){
    float t0 = max(tIn, 0.0);
    float t1 = min(tOut, t0 + 105.0);
    const int STEPS = 48;
    float dt = (t1 - t0) / float(STEPS);
    float t = t0 + dt * jitter;
    for (int i = 0; i < STEPS; i++){
      if (transmit < 0.010) break;
      vec3 p = rd * t;
      // Curvature matters over 100 km: a flat-earth height test floats the deck.
      float hf = (length(p + rel) - ATM_RG - CLD_BOT) / (CLD_TOP - CLD_BOT);
      if (hf < 0.0 || hf > 1.0){ t += dt; continue; }

      float d = cloudDensity(p, hf, 0);
      if (d <= 0.003){ t += dt; continue; }

      float ext = d * sigma;
      float tauSun = sunOn ? cloudLightMarch(p, sunDir, sigma) : 0.0;
      float tauMoon = moonOn ? cloudLightMarch(p, moonDir, sigma) : 0.0;

      vec3 lum = vec3(0.0);
      vec3 lumM = vec3(0.0);
      float a = 1.0, b = 1.0, c = 1.0;
      for (int o = 0; o < 3; o++){
        if (sunOn){
          float phS = mix(hgPhase(cosSun, 0.82 * c), hgPhase(cosSun, -0.36 * c), 0.24);
          lum += a * exp(-tauSun * b) * phS;
        }
        if (moonOn){
          float phM = mix(hgPhase(cosMoon, 0.82 * c), hgPhase(cosMoon, -0.36 * c), 0.24);
          lumM += a * exp(-tauMoon * b) * phM;
        }
        a *= 0.52; b *= 0.38; c *= 0.60;
      }
      // The g=0.82 forward lobe peaks ~60x isotropic. Real clouds wash that out
      // through internal multiple scattering; unclamped it turns any cloud near
      // the sun or moon into a white flare.
      lum = min(lum, vec3(0.32));
      lumM = min(lumM, vec3(0.32));

      // Powder: near-surface self-shadowing, strongest on the shaded side,
      // which is where the dark edges that sell a cloud as a volume live.
      float powder = 1.0 - exp(-ext * 7.0);
      float pw = mix(1.0, powder * 2.0, 0.6 * saturate1(0.62 - 0.62 * cosSun));
      lum *= pw;
      lumM *= pw;

      vec3 amb = mix(skyBottom, skyTop, saturate1(hf * 0.8 + 0.2)) * (0.30 + 0.62 * hf);
      vec3 src = sunLight * lum * 4.2 + moonLight * lumM * 4.2 + amb;

      float tr = exp(-ext * dt);
      float w = (1.0 - tr) * transmit;
      scatter += transmit * (src - src * tr);
      depthSum += t * w;
      depthW += w;
      transmit *= tr;
      t += dt;
    }
  }

  if (rd.y > 0.004 && uCirrusAmount > 0.001){
    float tc = raySphereFar(rel, rd, ATM_RG + CIRRUS_ALT);
    if (tc > 0.0 && tc < 460.0){
      vec3 p = rd * tc;
      float d = cirrusDensity(p);
      if (d > 0.001){
        float od = d * 0.85 * min(1.0 / max(rd.y, 0.09), 4.0);
        float alpha = 1.0 - exp(-od);
        vec3 col = skyTop * 0.55;
        if (sunOn) col += sunLight * min(0.55 + 6.0 * mix(hgPhase(cosSun, 0.88), hgPhase(cosSun, 0.24), 0.45), 3.2) * exp(-od * 0.5);
        if (moonOn) col += moonLight * min(0.55 + 5.2 * hgPhase(cosMoon, 0.84), 3.2) * exp(-od * 0.5);
        float w = alpha * transmit;
        scatter += transmit * col * alpha;
        depthSum += tc * w;
        depthW += w;
        transmit *= (1.0 - alpha);
      }
    }
  }

  float alpha = 1.0 - transmit;
  if (alpha > 0.001){
    float dist = depthW > 1e-4 ? depthSum / depthW : 20.0;
    float haze = (1.0 - exp(-dist * 0.0125)) * (1.0 - saturate1(rd.y * 2.6));
    scatter = mix(scatter, hazeColor * alpha, saturate1(haze) * 0.93);
  }
  return vec4(scatter, alpha);
}
`;
