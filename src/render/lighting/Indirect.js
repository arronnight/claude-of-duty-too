import * as THREE from 'three';

/**
 * Cheap indirect lighting: a sky/ground hemisphere floor plus a bank of
 * analytic irradiance probes that are blended into a single scene LightProbe.
 *
 * A uniform ambient term is what makes procedural interiors read as grey boxes,
 * so each probe measures its own sky visibility with a handful of physics rays
 * and gathers irradiance from the level's light fixtures. Blending the nearest
 * probes into the one SH9 probe three supports gives spatially varying,
 * correctly coloured fill — interiors go dim and warm, streets stay bright and
 * blue — for the cost of nine vector lerps a frame.
 */

const SAMPLES = 96;
const MAX_PROBES = 128;
const BLEND = 4;
const SH_STRIDE = 27;
const DERING_FLOOR = 0.16;
const BOUNCE = 0.32;

const _c = new THREE.Color();
const _tmp = new THREE.Color();
const _ray = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _basis = new Float32Array(9);
const _sky = new Float32Array(SH_STRIDE);
const _acc = new Float32Array(SH_STRIDE);
const _probeSh = new Float32Array(SH_STRIDE);
const _box = new THREE.Box3();

// Fibonacci sphere: even coverage with no clustering at the poles.
const DIRS = (() => {
  const d = new Float32Array(SAMPLES * 3);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SAMPLES; i++) {
    const y = 1 - (2 * i + 1) / SAMPLES;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = ga * i;
    d[i * 3] = Math.cos(a) * r;
    d[i * 3 + 1] = y;
    d[i * 3 + 2] = Math.sin(a) * r;
  }
  return d;
})();

const SOLID_ANGLE = (4 * Math.PI) / SAMPLES;

function shBasis(x, y, z, out) {
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
}

/** Adds irradiance `E * color` arriving from direction (x,y,z) to an SH9 buffer. */
function shAddDirectional(sh, x, y, z, r, g, b) {
  shBasis(x, y, z, _basis);
  for (let j = 0; j < 9; j++) {
    const w = _basis[j];
    sh[j * 3] += r * w;
    sh[j * 3 + 1] += g * w;
    sh[j * 3 + 2] += b * w;
  }
}

export class IndirectLight {
  constructor(scene) {
    this.scene = scene;
    this.hemi = new THREE.HemisphereLight(0x9dbbe0, 0x4b4438, 0.0);
    this.hemi.name = 'SkyFill';
    this.probe = new THREE.LightProbe();
    this.probe.name = 'IrradianceProbe';
    this.probe.intensity = 1;
    scene.add(this.hemi, this.probe);

    this.ambientScale = 1;
    this.localScale = 1;
    this.groundAlbedo = new THREE.Color(0x6b6154);
    this.skyColor = new THREE.Color(0x8fb2d4);
    this.horizonColor = new THREE.Color(0xb9c8d4);
    this._skyMix = new THREE.Color(0x8fb2d4);
    this._horizonMix = new THREE.Color(0xb9c8d4);
    this.sunColor = new THREE.Color(0xfff2e0);
    this.sunDir = new THREE.Vector3(0.3, 0.8, 0.4);
    this.sunIntensity = 3;
    this.artificial = 1;

    this.probes = [];
    this.local = new Float32Array(MAX_PROBES * SH_STRIDE);
    this.count = 0;
    this._skyDirty = true;
    this._blendTimer = 0;
    this._lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
  }

  setSkyState(skyColor, horizonColor, sunColor, sunDir, sunIntensity, artificial) {
    if (
      !this.skyColor.equals(skyColor) ||
      !this.horizonColor.equals(horizonColor) ||
      !this.sunColor.equals(sunColor) ||
      this.sunDir.distanceToSquared(sunDir) > 1e-6 ||
      Math.abs(this.sunIntensity - sunIntensity) > 1e-3 ||
      Math.abs(this.artificial - artificial) > 1e-3
    ) {
      this.skyColor.copy(skyColor);
      this.horizonColor.copy(horizonColor);
      this.sunColor.copy(sunColor);
      this.sunDir.copy(sunDir);
      this.sunIntensity = sunIntensity;
      this.artificial = artificial;
      this._skyDirty = true;
    }
  }

  /** Radiance of the open sky dome + first-bounce ground in direction (x,y,z). */
  _radiance(x, y, z, out) {
    const sc = this._skyMix;
    const su = this.sunColor;
    const si = this.sunIntensity;
    const up = Math.max(0, this.sunDir.y);
    // The horizon only warms while the sun is actually contributing, otherwise
    // the fallback warm-sun colour would tint a moonlit night orange.
    const warm = 0.32 * THREE.MathUtils.clamp(si * 0.5, 0, 1);

    // Azimuthal alignment with the sun. The sky is not a ring of one colour:
    // the half of the horizon the sun is in is two to three times brighter and
    // much warmer than the half behind you, and the lower the sun the wider
    // that gap. Averaging the two — which is what a single horizon colour does
    // — is exactly what makes a facade turned away from a low sun read as an
    // unlit cardboard cutout with no bounce on it.
    const hl = Math.sqrt(this.sunDir.x * this.sunDir.x + this.sunDir.z * this.sunDir.z);
    let sunward = 0.5;
    if (hl > 1e-4) {
      sunward = 0.5 + 0.5 * ((x * this.sunDir.x + z * this.sunDir.z) / hl);
    }
    const lowSun = 1 - THREE.MathUtils.smoothstep(this.sunDir.y, 0.06, 0.55);

    if (y >= 0) {
      // The horizon band carries most of the fill at low sun, and it is far
      // warmer and brighter than the zenith — approximating it from the zenith
      // colour alone is what crushes golden-hour shadows to black.
      const hz = this._horizonMix;
      const t = THREE.MathUtils.smoothstep(y, 0, 0.45);
      // Ring gain averages to ~1.15 over azimuth, so this redistributes the
      // horizon energy far more than it adds any.
      const gain = 1.1 * THREE.MathUtils.lerp(1, THREE.MathUtils.lerp(0.60, 1.72, sunward), lowSun);
      const wmix = warm * (0.28 + 1.00 * sunward);
      const hr = THREE.MathUtils.lerp(hz.r, su.r, wmix) * gain;
      const hg = THREE.MathUtils.lerp(hz.g, su.g, wmix) * gain;
      const hb = THREE.MathUtils.lerp(hz.b, su.b, wmix) * gain;
      out.setRGB(
        THREE.MathUtils.lerp(hr, sc.r * 0.85, t),
        THREE.MathUtils.lerp(hg, sc.g * 0.85, t),
        THREE.MathUtils.lerp(hb, sc.b * 0.85, t)
      );
    } else {
      const k = 0.55 + 0.45 * (1 + y);
      const lit = si * up * 0.3;
      const g = this.groundAlbedo;
      // The lit half of the ground bounces back toward the sun's side too, and
      // that warm upward fill is most of what keeps a shaded facade from going
      // to a flat silhouette at golden hour.
      const b = 0.55 + 0.90 * sunward;
      out.setRGB(
        g.r * (su.r * lit * b + sc.r * 0.4) * k,
        g.g * (su.g * lit * b + sc.g * 0.4) * k,
        g.b * (su.b * lit * b + sc.b * 0.4) * k
      );
    }

    // Circumsolar glow: gives the ambient a direction so flat walls still shade.
    // Broadened from a pure d^3 lobe — SH9 cannot carry a tight one anyway, and
    // the wider aureole survives the projection instead of being deringed away.
    const d = x * this.sunDir.x + y * this.sunDir.y + z * this.sunDir.z;
    if (d > 0) {
      const g = d * d * (0.045 + 0.055 * d) * si;
      out.r += su.r * g;
      out.g += su.g * g;
      out.b += su.b * g;
    }
  }

  /**
   * SH9 windowing. A tight lobe (a fixture, or the circumsolar glow) rings badly
   * enough to drive irradiance negative on the opposite side, which shows up as
   * pure black faces. Scale the two directional bands until the darkest sampled
   * direction still keeps a fraction of the DC term.
   */
  _dering(sh) {
    let s = 1;
    for (let c = 0; c < 3; c++) {
      const dc = sh[c] * 0.886227;
      if (dc <= 1e-6) {
        for (let j = 3; j < SH_STRIDE; j += 3) sh[j + c] = 0;
        continue;
      }
      for (let i = 0; i < SAMPLES; i += 4) {
        const x = DIRS[i * 3];
        const y = DIRS[i * 3 + 1];
        const z = DIRS[i * 3 + 2];
        const rest =
          1.023328 * (sh[3 + c] * y + sh[6 + c] * z + sh[9 + c] * x) +
          0.858086 * (sh[12 + c] * x * y + sh[15 + c] * y * z + sh[21 + c] * x * z) +
          sh[18 + c] * (0.743125 * z * z - 0.247708) +
          sh[24 + c] * 0.429043 * (x * x - y * y);
        if (rest < -1e-6) s = Math.min(s, (dc * (DERING_FLOOR - 1)) / rest);
      }
    }
    if (s < 1) for (let j = 3; j < SH_STRIDE; j++) sh[j] *= s;
  }

  _projectSky() {
    // A clear zenith is ~6:1 blue:red in radiance. Left raw it makes every
    // shadow look like it was shot through a blue gel, so pull it part way back
    // toward its own luminance.
    const l = this.skyColor.r * 0.2126 + this.skyColor.g * 0.7152 + this.skyColor.b * 0.0722;
    this._skyMix.setRGB(
      THREE.MathUtils.lerp(this.skyColor.r, l, 0.34),
      THREE.MathUtils.lerp(this.skyColor.g, l, 0.34),
      THREE.MathUtils.lerp(this.skyColor.b, l, 0.34)
    );
    const lh = this.horizonColor.r * 0.2126 + this.horizonColor.g * 0.7152 + this.horizonColor.b * 0.0722;
    this._horizonMix.setRGB(
      THREE.MathUtils.lerp(this.horizonColor.r, lh, 0.2),
      THREE.MathUtils.lerp(this.horizonColor.g, lh, 0.2),
      THREE.MathUtils.lerp(this.horizonColor.b, lh, 0.2)
    );

    _sky.fill(0);
    for (let i = 0; i < SAMPLES; i++) {
      const x = DIRS[i * 3];
      const y = DIRS[i * 3 + 1];
      const z = DIRS[i * 3 + 2];
      this._radiance(x, y, z, _c);
      shBasis(x, y, z, _basis);
      for (let j = 0; j < 9; j++) {
        const w = _basis[j] * SOLID_ANGLE;
        _sky[j * 3] += _c.r * w;
        _sky[j * 3 + 1] += _c.g * w;
        _sky[j * 3 + 2] += _c.b * w;
      }
    }
    this._dering(_sky);
    this._skyDirty = false;
  }

  /**
   * Builds probes from the level's fixture list plus a coarse grid, measuring
   * sky visibility per probe against the physics BVH when one exists.
   */
  build(ctx, specs) {
    this.probes.length = 0;
    this.count = 0;
    this.local.fill(0);

    let bounds = ctx.level?.bounds;
    if (!(bounds?.isBox3 && isFinite(bounds.min.x)) && ctx.level?.root) {
      bounds = _box.setFromObject(ctx.level.root);
    }
    const sites = [];

    if (bounds && bounds.isBox3 && isFinite(bounds.min.x) && bounds.max.x > bounds.min.x) {
      // Playable area, not the ground plane: a 400 m skirt would spread the
      // probe grid so thin that no probe would ever land inside a room.
      const cx = (bounds.min.x + bounds.max.x) * 0.5;
      const cz = (bounds.min.z + bounds.max.z) * 0.5;
      const hx = Math.min((bounds.max.x - bounds.min.x) * 0.5, 90);
      const hz = Math.min((bounds.max.z - bounds.min.z) * 0.5, 90);
      const step = THREE.MathUtils.clamp(Math.sqrt((4 * hx * hz) / 70), 7, 18);
      const y = Math.min(bounds.min.y + 1.7, bounds.max.y - 0.4);
      for (let x = cx - hx + step * 0.5; x < cx + hx; x += step) {
        for (let z = cz - hz + step * 0.5; z < cz + hz; z += step) {
          sites.push(new THREE.Vector3(x, y, z));
        }
      }
    }
    for (const s of specs) {
      if (!s?.position) continue;
      sites.push(new THREE.Vector3(s.position.x, s.position.y - 2.2, s.position.z));
    }
    if (sites.length === 0) sites.push(new THREE.Vector3(0, 1.7, 0));

    const ray = ctx.physics?.raycast;
    const physics = ctx.physics;

    for (const p of sites) {
      if (this.count >= MAX_PROBES) break;
      const idx = this.count++;
      let vis = 1;
      if (ray) {
        let open = 0;
        let total = 0;
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          const tilt = k === 0 ? 0 : 0.55;
          _ray.set(Math.cos(a) * tilt, 1, Math.sin(a) * tilt).normalize();
          total++;
          let hit = null;
          try {
            hit = physics.raycast(p, _ray, 80, 1 | 2);
          } catch {
            hit = null;
          }
          if (!hit) open++;
        }
        vis = total ? open / total : 1;
      }

      // Fixture *bounce*, occlusion-tested so a lamp in the next room does not
      // brighten this one. The direct term is deliberately absent: the pooled
      // point light already delivers it, and adding it here would double-count
      // and blow out anything standing right under a bulb.
      _probeSh.fill(0);
      for (const s of specs) {
        if (!s?.position) continue;
        _pos.set(s.position.x, s.position.y, s.position.z);
        const d = _pos.distanceTo(p);
        if (d > (s.radius || 12) * 1.2 || d < 0.05) continue;
        if (ray) {
          _ray.copy(_pos).sub(p);
          const len = _ray.length();
          _ray.multiplyScalar(1 / len);
          let hit = null;
          try {
            hit = physics.raycast(p, _ray, len - 0.35, 1 | 2);
          } catch {
            hit = null;
          }
          if (hit) continue;
        }
        _tmp.set(s.color ?? 0xffffff);
        const direct = Math.min((s.candela ?? s.intensity ?? 10) / Math.max(d * d, 2.25), 14);
        const g = this.groundAlbedo;
        // Most of a room's bounce comes up off the floor; the rest is close
        // enough to isotropic that a wide upward-facing lobe reads correctly.
        const up = direct * BOUNCE * 0.62;
        shAddDirectional(_probeSh, 0, -1, 0, _tmp.r * g.r * up, _tmp.g * g.g * up, _tmp.b * g.b * up);
        const iso = direct * BOUNCE * 0.38 * 1.128; // irradiance -> SH DC
        _probeSh[0] += _tmp.r * g.r * iso;
        _probeSh[1] += _tmp.g * g.g * iso;
        _probeSh[2] += _tmp.b * g.b * iso;
      }
      this._dering(_probeSh);
      this.local.set(_probeSh, idx * SH_STRIDE);

      this.probes.push({ pos: p, skyVis: vis });
    }

    this._lastCam.set(1e9, 1e9, 1e9);
  }

  update(dt, camera) {
    if (this._skyDirty) this._projectSky();

    this._blendTimer -= dt;
    camera.getWorldPosition(_pos);
    const moved = _pos.distanceToSquared(this._lastCam) > 0.25;
    if (!moved && this._blendTimer > 0) return;
    this._blendTimer = 0.1;
    this._lastCam.copy(_pos);

    _acc.fill(0);
    let visAcc = 0;
    let wSum = 0;

    if (this.count > 0) {
      // Nearest-N inverse-square blend; N is small so a partial selection scan
      // beats sorting the whole probe list.
      const best = this._best || (this._best = new Int32Array(BLEND));
      const bestD = this._bestD || (this._bestD = new Float32Array(BLEND));
      for (let i = 0; i < BLEND; i++) {
        best[i] = -1;
        bestD[i] = Infinity;
      }
      for (let i = 0; i < this.count; i++) {
        const d = this.probes[i].pos.distanceToSquared(_pos);
        for (let k = 0; k < BLEND; k++) {
          if (d < bestD[k]) {
            for (let m = BLEND - 1; m > k; m--) {
              bestD[m] = bestD[m - 1];
              best[m] = best[m - 1];
            }
            bestD[k] = d;
            best[k] = i;
            break;
          }
        }
      }
      for (let k = 0; k < BLEND; k++) {
        const i = best[k];
        if (i < 0) continue;
        const w = 1 / (bestD[k] + 1.5);
        wSum += w;
        visAcc += this.probes[i].skyVis * w;
        const base = i * SH_STRIDE;
        for (let j = 0; j < SH_STRIDE; j++) _acc[j] += this.local[base + j] * w;
      }
    }

    const inv = wSum > 0 ? 1 / wSum : 0;
    const vis = wSum > 0 ? visAcc * inv : 1;
    // The sky term double-counts whatever `scene.environment` already delivers,
    // so it is scaled down when an env map exists. The fixture/bounce term never
    // is: no environment probe knows about the strip light in this room.
    const s = this.ambientScale;
    const a = this.localScale * this.artificial * inv;

    const coeffs = this.probe.sh.coefficients;
    for (let j = 0; j < 9; j++) {
      const b = j * 3;
      coeffs[j].set(
        _sky[b] * vis * s + _acc[b] * a,
        _sky[b + 1] * vis * s + _acc[b + 1] * a,
        _sky[b + 2] * vis * s + _acc[b + 2] * a
      );
    }

    // Never let an interior fall to pure black; the hemisphere is the floor.
    // It has to be a *fraction of the sky's own irradiance*, not an absolute
    // intensity: skyColor is HDR radiance in `sky.exposure` units, so the old
    // fixed 0.05 was under 2% of the real fill at noon and floored nothing at
    // all. Anchoring it to the DC term of the projected sky makes it hold at
    // every time of day, and it opens up as sky visibility closes down, which
    // is when a probe-only fill would otherwise reach zero.
    const dc = 0.886227;
    this.hemi.color.setRGB(_sky[0] * dc, _sky[1] * dc, _sky[2] * dc);
    this.hemi.groundColor
      .setRGB(_sky[0] * dc, _sky[1] * dc, _sky[2] * dc)
      .multiply(this.groundAlbedo)
      .lerp(_tmp.copy(this.sunColor).multiply(this.groundAlbedo)
        .multiplyScalar(this.sunIntensity * 0.05 * Math.max(0, this.sunDir.y)), 0.5);
    this.hemi.intensity =
      (0.10 + 0.20 * (1 - vis)) * s *
      (0.5 + 0.5 * Math.min(1, this.sunIntensity * 0.4 + this.artificial * 0.25));
  }

  dispose() {
    this.hemi.removeFromParent();
    this.probe.removeFromParent();
    this.probes.length = 0;
  }
}
