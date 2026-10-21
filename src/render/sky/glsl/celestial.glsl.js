import { SUN_ANGULAR_RADIUS, MOON_ANGULAR_RADIUS } from '../constants.js';

/**
 * Sun disk, moon, star field and milky way. Everything is sized in screen
 * derivatives (fwidth) rather than fixed angles so nothing aliases or crawls
 * when the camera turns — the usual failure mode of procedural star fields.
 */
export const CELESTIAL_GLSL = /* glsl */ `
const float SUN_ANG_R = ${SUN_ANGULAR_RADIUS};
const float MOON_ANG_R = ${MOON_ANGULAR_RADIUS};

/** Planck fit, good from ~1500 K to ~15000 K, used for star colours. */
vec3 blackbodyRGB(float k){
  float t = k / 100.0;
  vec3 c;
  if (t <= 66.0) {
    c.r = 1.0;
    c.g = saturate1(0.3900816 * log(max(t, 1.0)) - 0.6318414);
  } else {
    c.r = saturate1(1.2929362 * pow(max(t - 60.0, 1.0), -0.1332047));
    c.g = saturate1(1.1298909 * pow(max(t - 60.0, 1.0), -0.0755148));
  }
  if (t >= 66.0) c.b = 1.0;
  else if (t <= 19.0) c.b = 0.0;
  else c.b = saturate1(0.5432068 * log(t - 10.0) - 1.1962541);
  return c;
}

/**
 * Sun disk. Radiance is irradiance divided by the 6.8e-5 sr solid angle, so the
 * core sits four orders of magnitude above the sky and drives bloom naturally.
 * Limb darkening is per-channel (blue darkens most) so the rim reads warm.
 */
vec3 sunDisk(vec3 dir, vec3 sunDir, vec3 sunRadiance){
  float c = clamp(dot(dir, sunDir), -1.0, 1.0);
  float ang = acos(c);
  float r = ang / SUN_ANG_R;
  float aa = max(fwidth(r), 1e-4);
  float disk = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  if (disk <= 0.0) return vec3(0.0);
  float mu = sqrt(max(0.0, 1.0 - min(r, 1.0) * min(r, 1.0)));
  vec3 u = vec3(0.42, 0.56, 0.72);
  vec3 limb = 1.0 - u * (1.0 - pow(vec3(max(mu, 1e-3)), vec3(0.52)));
  return sunRadiance * limb * disk;
}

/**
 * Ocular / lens glare around the disk. Without it the sun is a 6 px dot that
 * only reads as the sun once postfx bloom happens to be on; this makes the
 * dome self-sufficient and gives bloom something shaped to work with.
 */
vec3 sunGlare(vec3 dir, vec3 sunDir, vec3 irradiance){
  float c = clamp(dot(dir, sunDir), -1.0, 1.0);
  float ang = acos(c);
  float g = exp(-ang * 58.0) * 0.62 + exp(-ang * 13.0) * 0.085 + exp(-ang * 3.4) * 0.012;
  return irradiance * g;
}

/** Lommel-Seeliger flattens the lunar limb the way Lambert never does. */
vec3 moonDisk(vec3 dir, vec3 moonDir, vec3 sunDir, vec3 moonLight, vec3 earthshine, float sizeScale){
  float R = MOON_ANG_R * sizeScale;
  float c = clamp(dot(dir, moonDir), -1.0, 1.0);
  if (c < cos(R * 1.6)) return vec3(0.0);

  vec3 ex = normalize(cross(vec3(0.0, 1.0, 0.0), moonDir) + vec3(1e-4, 0.0, 0.0));
  vec3 ey = cross(moonDir, ex);
  vec2 q = vec2(dot(dir, ex), dot(dir, ey)) / R;
  float r2 = dot(q, q);
  float aa = max(fwidth(r2), 1e-5);
  float mask = 1.0 - smoothstep(1.0 - aa * 2.0, 1.0 + aa * 2.0, r2);
  if (mask <= 0.0) return vec3(0.0);

  // Outward normal points back at the observer, hence the minus: getting this
  // sign wrong inverts the phase and turns a gibbous moon into a crescent.
  vec3 n = normalize(ex * q.x + ey * q.y - moonDir * sqrt(max(0.0, 1.0 - min(r2, 1.0))));
  // Fixed libration frame so maria stay put as the moon tracks across the sky.
  vec3 nf = normalize(vec3(n.x, n.y * 0.86 + n.z * 0.51, n.z * 0.86 - n.y * 0.51));

  float maria = smoothstep(0.42, 0.62, fbm3(nf * 2.1 + 4.0, 3));
  float craters = puffFbm(nf * 14.0, 3);
  float fine = fbm3(nf * 46.0, 2);
  float albedo = mix(0.128, 0.062, maria);
  albedo *= 0.80 + 0.34 * craters;
  albedo *= 0.90 + 0.20 * fine;
  // Bright ejecta rays from a Tycho-like impact.
  float rays = pow(saturate1(1.0 - length(nf - normalize(vec3(-0.22, -0.62, 0.75))) * 1.05), 3.0);
  albedo += rays * 0.055 * smoothstep(0.35, 0.75, fine);

  float mu0 = dot(n, sunDir);
  float mu = max(dot(n, -dir), 1e-3);
  float lit = max(mu0, 0.0);
  float ls = lit / (lit + mu);
  // Opposition surge: the moon is nearly uniformly bright at full phase.
  float surge = 1.0 + 0.9 * exp(-acos(clamp(dot(sunDir, -dir), -1.0, 1.0)) * 12.0);

  vec3 col = moonLight * albedo * ls * surge * 2.4;
  float dark = saturate1(-mu0 * 2.5 + 0.35);
  col += earthshine * albedo * dark * mu;
  return col * mask;
}

/**
 * One star layer. Cube-face tiling gives a near-uniform cell size and the
 * point spread is sized in *pixels* via fwidth, so stars stay the same size at
 * any FOV and never crawl. The profile has compact support — a Gaussian tail
 * spilling past the cell boundary is what turns a star field into visible
 * square tiles.
 */
vec3 starLayer(vec3 cdir, float density, float cull, float magPow, float gain,
               float t, float scintAmt, float seed){
  vec3 a = abs(cdir);
  float m = max(a.x, max(a.y, a.z));
  vec2 uv;
  float face;
  if (a.x >= m) { uv = cdir.zy / cdir.x; face = cdir.x > 0.0 ? 0.0 : 1.0; }
  else if (a.y >= m) { uv = cdir.xz / cdir.y; face = cdir.y > 0.0 ? 2.0 : 3.0; }
  else { uv = cdir.xy / cdir.z; face = cdir.z > 0.0 ? 4.0 : 5.0; }
  uv = uv * 0.5 + 0.5;

  vec2 g = uv * density;
  vec2 cell = floor(g);
  vec2 fr = fract(g);
  vec3 h = hash33(vec3(cell, face * 13.0 + seed));
  if (h.z > cull) return vec3(0.0);

  vec2 sp = 0.5 + (h.xy - 0.5) * 0.52;
  // Footprint from the *direction* derivative, not from fwidth(uv): the cube
  // face parametrisation is discontinuous at the seams and fwidth there blows
  // up, which paints a bright line down every seam.
  float px = max(density * 0.6366 * length(fwidth(cdir)), 1e-5);
  float d = length(fr - sp) / px;

  // Magnitudes: N(m) grows steeply with m, so a high power makes bright stars
  // properly rare instead of giving a uniform speckle.
  float u = hash13(vec3(cell + 0.5, face * 7.0 + seed + 3.0));
  float mag = pow(u, magPow);
  // Support is capped at a fraction of a cell so a star can never bleed across
  // a tile boundary, whatever the field of view.
  float support = min(mix(0.55, 1.25, mag) * 1.9, 0.30 / px);
  float f = saturate1(1.0 - d / max(support, 1e-4));
  if (f <= 0.0) return vec3(0.0);
  f = f * f * (3.0 - 2.0 * f);
  f = mix(f, f * f, 0.6);

  float tw = hash13(vec3(cell - 2.0, face + seed)) * 40.0;
  float scint = 1.0 + scintAmt * (0.34 * sin(t * (2.6 + h.x * 5.0) + tw)
                                + 0.22 * sin(t * (4.9 + h.y * 3.0) + tw * 1.7));

  float kelvin = mix(3100.0, 11000.0, pow(hash13(vec3(cell + 9.0, face + seed * 2.0)), 1.6));
  vec3 col = mix(vec3(1.0), blackbodyRGB(kelvin), 0.78);

  return col * (gain * (0.006 + 1.45 * mag * mag)) * scint * f;
}

/** Galactic band with dust lanes; the core direction is warm, the arms cool. */
vec3 milkyWay(vec3 cdir, vec3 pole, vec3 core){
  float b = dot(cdir, pole);
  float band = exp(-b * b * 90.0) + 0.35 * exp(-b * b * 22.0);
  if (band < 0.004) return vec3(0.0);

  // Structure lives at high frequency — it is unresolved stars, not cloud. Low
  // frequency fbm here reads as grey smoke blobs and immediately breaks the shot.
  float clump = fbm3(cdir * 26.0 + 11.0, 3);
  float fine = fbm3(cdir * 130.0, 3);
  float dust = smoothstep(0.28, 0.72, fbm3(cdir * 17.0 - 7.0, 3));
  float lane = smoothstep(0.60, 0.36, fbm3(cdir * vec3(9.0, 46.0, 9.0) + 3.0, 3));
  float toCore = saturate1(dot(cdir, core));

  float d = band * (0.30 + 0.85 * clump) * (0.45 + 0.80 * fine);
  d *= mix(0.12, 1.0, dust);
  d *= mix(1.0, 0.32, lane);
  d *= 0.30 + 1.45 * pow(toCore, 2.4);

  vec3 cool = vec3(0.66, 0.75, 1.0);
  vec3 warm = vec3(1.0, 0.87, 0.70);
  vec3 col = mix(cool, warm, pow(toCore, 1.4) * 0.9);
  return col * d * 0.0075;
}
`;
