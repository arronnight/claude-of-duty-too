import * as THREE from 'three';
import {
  RG, RT, H_RAYLEIGH, H_MIE, BETA_R, BETA_M_EXTINCT, BETA_M_SCATTER, BETA_OZONE,
  OZONE_CENTER, OZONE_WIDTH, SOLAR_SPECTRUM, LATITUDE, SUN_DECLINATION,
  MOON_DECLINATION, MOON_HOUR_LEAD, NORTH_OFFSET,
} from './constants.js';

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * CPU side of the atmosphere: spherical-astronomy sun/moon positions for a
 * mid-latitude site plus the transmittance integral along the sun ray. The
 * same integral that reddens the GPU sky is what produces `sunColor`, so the
 * directional light and the sky can never drift apart — and the 2000 K horizon
 * to 6500 K noon ramp is an output of optical depth, not a authored curve.
 */
export class Ephemeris {
  constructor() {
    this.t01 = 0.32;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.moonDirection = new THREE.Vector3(0, -1, 0);
    this.sunTransmittance = new THREE.Color(1, 1, 1);
    this.moonTransmittance = new THREE.Color(1, 1, 1);
    /** Irradiance reaching the ground, before the renderer's exposure scale. */
    this.sunIrradiance = new THREE.Color(1, 1, 1);
    this.moonIrradiance = new THREE.Color(0, 0, 0);
    this.sunColor = new THREE.Color(1, 1, 1);
    this.moonColor = new THREE.Color(0.72, 0.80, 1.0);
    this.sunIntensity = 1;
    this.moonIntensity = 0;
    this.intensity = 1;
    this.moonPhase = 0.5;
    this.starRotation = new THREE.Matrix3();
    this._m4 = new THREE.Matrix4();
    this._tilt = new THREE.Matrix4().makeRotationX(LATITUDE - Math.PI / 2);
  }

  setTimeOfDay(t01) {
    const t = ((t01 % 1) + 1) % 1;
    this.t01 = t;
    const H = (t - 0.5) * Math.PI * 2;
    horizonDir(H, SUN_DECLINATION, this.sunDirection);
    horizonDir(H + MOON_HOUR_LEAD, MOON_DECLINATION, this.moonDirection);

    transmittanceAlong(this.sunDirection, this.sunTransmittance);
    transmittanceAlong(this.moonDirection, this.moonTransmittance);

    // Sun: extraterrestrial spectrum attenuated by the slant optical depth.
    const st = this.sunTransmittance;
    this.sunIrradiance.setRGB(
      SOLAR_SPECTRUM[0] * st.r,
      SOLAR_SPECTRUM[1] * st.g,
      SOLAR_SPECTRUM[2] * st.b,
    );
    const peak = Math.max(this.sunIrradiance.r, this.sunIrradiance.g, this.sunIrradiance.b, 1e-6);
    this.sunColor.setRGB(this.sunIrradiance.r / peak, this.sunIrradiance.g / peak, this.sunIrradiance.b / peak);
    this.sunIntensity = lum(this.sunIrradiance);

    // Moon phase from the true 3-D elongation, so the terminator is consistent
    // with wherever the sun actually is.
    const elong = Math.acos(THREE.MathUtils.clamp(this.sunDirection.dot(this.moonDirection), -1, 1));
    this.moonPhase = (1 - Math.cos(elong)) * 0.5;
    // Full-moon illuminance is 2.5e-6 of the sun's; the opposition surge makes
    // the falloff toward crescent much steeper than the lit fraction alone.
    const phaseGain = Math.pow(this.moonPhase, 1.6) * (0.35 + 0.65 * this.moonPhase);
    const mt = this.moonTransmittance;
    const mAlb = 0.136;
    this.moonIrradiance.setRGB(
      SOLAR_SPECTRUM[0] * mt.r * mAlb * phaseGain,
      SOLAR_SPECTRUM[1] * mt.g * mAlb * phaseGain * 0.99,
      SOLAR_SPECTRUM[2] * mt.b * mAlb * phaseGain * 1.06,
    );
    const mpeak = Math.max(this.moonIrradiance.r, this.moonIrradiance.g, this.moonIrradiance.b, 1e-6);
    this.moonColor.setRGB(this.moonIrradiance.r / mpeak, this.moonIrradiance.g / mpeak, this.moonIrradiance.b / mpeak);
    this.moonIntensity = lum(this.moonIrradiance);

    // Daylight factor: civil twilight is the knee, matching how a camera meters.
    const e = this.sunDirection.y;
    this.intensity = THREE.MathUtils.clamp(smoothstep(-0.12, 0.16, e), 0, 1);

    // Celestial sphere rotation: hour angle about the polar axis, tilted by latitude.
    this._m4.makeRotationY(-(H + NORTH_OFFSET));
    this._m4.premultiply(this._tilt);
    this.starRotation.setFromMatrix4(this._m4);
    return this;
  }

  /**
   * Sky radiance toward `dir`, mirroring the GPU raymarch term for term (same
   * phase, same multiple-scattering albedo, same units) so cloud ambient, fog
   * colour and the visible dome cannot disagree. Called a handful of times per
   * time-of-day change, never per frame.
   */
  sampleSky(dir, target, lightDir = this.sunDirection) {
    const ro = _p.set(0, RG + 0.02, 0);
    const rd = _q.copy(dir).normalize();
    let dR = 0, dM = 0, dO = 0;
    const acc = [0, 0, 0];
    const iso = [0, 0, 0];
    const tGround = sphereNear(ro, rd, RG);
    const tMax = tGround > 0 ? tGround : rayTopDistance(ro, rd);
    const N = 12;
    const K = 5.2;
    const norm = Math.exp(K) - 1;
    for (let i = 0; i < N; i++) {
      const t0 = tMax * (Math.exp(K * (i / N)) - 1) / norm;
      const t1 = tMax * (Math.exp(K * ((i + 1) / N)) - 1) / norm;
      const ds = t1 - t0;
      if (ds <= 0) continue;
      _tmp.copy(rd).multiplyScalar(t0 + ds * 0.5).add(ro);
      const h = _tmp.length() - RG;
      const dr = Math.exp(-Math.max(h, 0) / H_RAYLEIGH) * ds;
      const dm = Math.exp(-Math.max(h, 0) / H_MIE) * ds;
      const dz = Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_WIDTH) * ds;
      dR += dr; dM += dm; dO += dz;
      _lightT.copy(_tmp);
      const blocked = sphereNear(_lightT, lightDir, RG) > 0;
      for (let c = 0; c < 3; c++) {
        const tv = Math.exp(-(BETA_R[c] * dR + BETA_M_EXTINCT * dM + BETA_OZONE[c] * dO));
        const tl = blocked ? 0 : pointTransmittance(_tmp, lightDir, c);
        acc[c] += tv * tl * dr * BETA_R[c];
        iso[c] += tv * tl * (dr * BETA_R[c] + dm * BETA_M_SCATTER);
      }
    }
    const cs = THREE.MathUtils.clamp(rd.dot(lightDir), -1, 1);
    const ph = 0.0596831 * (1 + cs * cs);
    const lightUp = THREE.MathUtils.clamp(lightDir.y * 3 + 0.30, 0, 1);
    const ms = [0.34, 0.40, 0.50];
    target.setRGB(
      (acc[0] * ph + iso[0] * ms[0] * 0.0796 * lightUp) * SOLAR_SPECTRUM[0],
      (acc[1] * ph + iso[1] * ms[1] * 0.0796 * lightUp) * SOLAR_SPECTRUM[1],
      (acc[2] * ph + iso[2] * ms[2] * 0.0796 * lightUp) * SOLAR_SPECTRUM[2],
    );
    return target;
  }
}

const _lightT = new THREE.Vector3();
const _step = new THREE.Vector3();

function sphereNear(ro, rd, r) {
  const b = ro.dot(rd);
  const c = ro.lengthSq() - r * r;
  const d = b * b - c;
  if (d < 0) return -1;
  const t = -b - Math.sqrt(d);
  return t < 0 ? -1 : t;
}

/** Single-channel transmittance from p to space; 4 steps is plenty for ambient. */
function pointTransmittance(p, dir, channel) {
  const b = p.dot(dir);
  const c = p.lengthSq() - RT * RT;
  const disc = b * b - c;
  if (disc < 0) return 1;
  const tMax = -b + Math.sqrt(disc);
  let dR = 0, dM = 0, dO = 0;
  const N = 4;
  let prev = 0;
  for (let i = 0; i < N; i++) {
    const t = tMax * ((i + 1) / N) ** 2;
    const ds = t - prev;
    _step.copy(dir).multiplyScalar(prev + ds * 0.5).add(p);
    const h = _step.length() - RG;
    dR += Math.exp(-Math.max(h, 0) / H_RAYLEIGH) * ds;
    dM += Math.exp(-Math.max(h, 0) / H_MIE) * ds;
    dO += Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_WIDTH) * ds;
    prev = t;
  }
  return Math.exp(-(BETA_R[channel] * dR + BETA_M_EXTINCT * dM + BETA_OZONE[channel] * dO));
}

function lum(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Local horizontal coordinates from hour angle + declination, then rotated into world space. */
function horizonDir(H, dec, out) {
  const sinLat = Math.sin(LATITUDE), cosLat = Math.cos(LATITUDE);
  const sinD = Math.sin(dec), cosD = Math.cos(dec);
  const sinAlt = THREE.MathUtils.clamp(sinLat * sinD + cosLat * cosD * Math.cos(H), -1, 1);
  const alt = Math.asin(sinAlt);
  const cosAlt = Math.max(Math.cos(alt), 1e-6);
  const az = Math.atan2(
    -cosD * Math.sin(H) / cosAlt,
    (sinD - sinLat * sinAlt) / (cosLat * cosAlt),
  );
  const bearing = az + NORTH_OFFSET;
  out.set(Math.sin(bearing) * cosAlt, sinAlt, -Math.cos(bearing) * cosAlt).normalize();
  return out;
}

function rayTopDistance(ro, rd) {
  const b = ro.dot(rd);
  const c = ro.lengthSq() - RT * RT;
  const d = b * b - c;
  return d < 0 ? 0 : -b + Math.sqrt(d);
}

/**
 * Transmittance from the observer to space along `dir`. Below the horizon the
 * geometric path is refracted in reality; clamping to a grazing ray keeps the
 * colour continuous through sunset instead of snapping to black.
 */
function transmittanceAlong(dir, target) {
  const ro = _p.set(0, RG + 0.02, 0);
  const rd = _q.copy(dir);
  if (rd.y < 0.0035) {
    rd.y = 0.0035;
    rd.normalize();
  }
  const tMax = rayTopDistance(ro, rd);
  const N = 24;
  let dR = 0, dM = 0, dO = 0;
  for (let i = 0; i < N; i++) {
    const x0 = i / N, x1 = (i + 1) / N;
    const t0 = tMax * x0 * x0;
    const t1 = tMax * x1 * x1;
    const ds = t1 - t0;
    _tmp.copy(rd).multiplyScalar(t0 + ds * 0.5).add(ro);
    const h = _tmp.length() - RG;
    dR += Math.exp(-Math.max(h, 0) / H_RAYLEIGH) * ds;
    dM += Math.exp(-Math.max(h, 0) / H_MIE) * ds;
    dO += Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_WIDTH) * ds;
  }
  // Below the true horizon the disk is extinguished by the limb; fade smoothly.
  const below = THREE.MathUtils.clamp((dir.y + 0.018) / 0.036, 0, 1);
  target.setRGB(
    Math.exp(-(BETA_R[0] * dR + BETA_M_EXTINCT * dM + BETA_OZONE[0] * dO)) * below,
    Math.exp(-(BETA_R[1] * dR + BETA_M_EXTINCT * dM + BETA_OZONE[1] * dO)) * below,
    Math.exp(-(BETA_R[2] * dR + BETA_M_EXTINCT * dM + BETA_OZONE[2] * dO)) * below,
  );
  return target;
}
