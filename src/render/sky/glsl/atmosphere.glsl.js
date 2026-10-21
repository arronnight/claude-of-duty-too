import {
  RG, RT, H_RAYLEIGH, H_MIE, BETA_R, BETA_M_SCATTER, BETA_M_EXTINCT,
  BETA_OZONE, OZONE_CENTER, OZONE_WIDTH,
} from '../constants.js';

const f = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const v3 = (a) => `vec3(${a.map((x) => x.toExponential(6)).join(', ')})`;

/**
 * Single-scattering Rayleigh + Mie + ozone raymarch. Ozone matters: without the
 * Chappuis band the zenith never gets deep enough and twilight loses its violet.
 * The earth-shadow test inside the light march is what produces the twilight
 * wedge and the belt of Venus rather than a symmetric glow.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
const float ATM_RG = ${f(RG)};
const float ATM_RT = ${f(RT)};
const float ATM_HR = ${f(H_RAYLEIGH)};
const float ATM_HM = ${f(H_MIE)};
const vec3  ATM_BR = ${v3(BETA_R)};
const float ATM_BMS = ${BETA_M_SCATTER.toExponential(6)};
const float ATM_BME = ${BETA_M_EXTINCT.toExponential(6)};
const vec3  ATM_BO = ${v3(BETA_OZONE)};

/** x = rayleigh, y = mie, z = ozone; altitude in km. */
vec3 atmDensity(float h){
  return vec3(
    exp(-max(h, 0.0) / ATM_HR),
    exp(-max(h, 0.0) / ATM_HM),
    max(0.0, 1.0 - abs(h - ${f(OZONE_CENTER)}) / ${f(OZONE_WIDTH)})
  );
}

vec3 atmExtinction(vec3 depth){
  return exp(-(ATM_BR * depth.x + ATM_BME * depth.y + ATM_BO * depth.z));
}

/** Transmittance from p to the top of the atmosphere along dir. Zero if the ground blocks it. */
vec3 atmTransmittance(vec3 p, vec3 dir, const int steps){
  if (raySphereNear(p, dir, ATM_RG) > 0.0) return vec3(0.0);
  float tTop = raySphereFar(p, dir, ATM_RT);
  if (tTop <= 0.0) return vec3(1.0);
  vec3 depth = vec3(0.0);
  float prev = 0.0;
  for (int i = 0; i < 16; i++){
    if (i >= steps) break;
    float x = (float(i) + 1.0) / float(steps);
    float t = tTop * x * x;
    float ds = t - prev;
    vec3 q = p + dir * (prev + ds * 0.5);
    depth += atmDensity(length(q) - ATM_RG) * ds;
    prev = t;
  }
  return atmExtinction(depth);
}

struct AtmResult {
  vec3 rayleigh;   // phase applied, ground bounce folded in
  float mie;       // phase applied at sample time so the aureole stays sharp
};

/**
 * March the view ray. lightDir is the sun OR the moon; the caller scales by
 * irradiance afterwards so changing exposure never forces a LUT rebuild.
 */
AtmResult atmScatter(vec3 ro, vec3 rd, vec3 lightDir, vec3 groundAlbedo, float jitter){
  // Terminate ground rays on a shell 350 m below the observer rather than at
  // their feet: rays just under the horizon then travel tens of kilometres and
  // pick up real haze, so the ground reads as receding terrain, not a void.
  float tGround = raySphereNear(ro, rd, ATM_RG - 0.35);
  float tTop = raySphereFar(ro, rd, ATM_RT);
  float tMax = tGround > 0.0 ? tGround : max(tTop, 0.0);

  const int N = 30;
  vec3 accR = vec3(0.0);
  vec3 accM = vec3(0.0);
  vec3 accIso = vec3(0.0);
  vec3 depth = vec3(0.0);

  // Exponential step distribution: Mie has a 1.2 km scale height, so the first
  // few kilometres carry most of the haze and need most of the samples.
  const float K = 5.2;
  float norm = exp(K) - 1.0;

  for (int i = 0; i < N; i++){
    float x0 = float(i) / float(N);
    float x1 = (float(i) + 1.0) / float(N);
    float t0 = tMax * (exp(K * x0) - 1.0) / norm;
    float t1 = tMax * (exp(K * x1) - 1.0) / norm;
    float ds = t1 - t0;
    if (ds <= 0.0) continue;
    vec3 p = ro + rd * (t0 + ds * (0.35 + 0.3 * jitter));
    float h = length(p) - ATM_RG;
    vec3 dens = atmDensity(h) * ds;
    depth += dens;
    vec3 tView = atmExtinction(depth);
    vec3 tLight = atmTransmittance(p, lightDir, 6);
    vec3 tw = tView * tLight;
    accR += tw * dens.x;
    accM += tw * dens.y;
    // Multiple scattering must carry the light-path transmittance too, or the
    // sky stays stubbornly blue through sunset instead of going orange.
    accIso += tw * (dens.x * ATM_BR + dens.y * ATM_BMS);
  }

  float cosL = dot(rd, lightDir);
  AtmResult r;
  r.rayleigh = accR * ATM_BR * rayleighPhase(cosL);
  r.mie = dot(accM * ATM_BMS, vec3(0.3333));

  // Cheap multiple-scattering estimate: the isotropic single-scatter integral
  // re-emitted through a 1/4pi lobe. Single scattering alone leaves the zenith
  // too dark and the anti-solar sky far too saturated.
  vec3 msAlbedo = vec3(0.34, 0.40, 0.50) * 0.0795775;
  float lightUp = saturate1(lightDir.y * 3.0 + 0.30);
  r.rayleigh += accIso * msAlbedo * lightUp;

  if (tGround > 0.0){
    vec3 gp = ro + rd * tGround;
    vec3 gn = normalize(gp);
    vec3 sunAtGround = atmTransmittance(gp, lightDir, 6) * max(dot(gn, lightDir), 0.0);
    vec3 skyAmb = vec3(0.06, 0.09, 0.16) * saturate1(lightDir.y * 2.0 + 0.15);
    r.rayleigh += groundAlbedo * INV_PI * (sunAtGround + skyAmb) * atmExtinction(depth) * 0.55;
  }
  return r;
}
`;
