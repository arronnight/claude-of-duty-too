import { deg } from './Springs.js';

/**
 * The weapon table. Numbers come straight from `docs/GAMEPLAY.md` — where a
 * value looks oddly specific it is deliberate, so do not round it.
 *
 * Everything a weapon needs lives here except its geometry: stats, ballistics,
 * the authored recoil pattern, spread behaviour, the reload stage table and the
 * viewmodel poses. `models/` turns `model` into meshes.
 */

// ---------------------------------------------------------------- materials

/**
 * Material palette. Every entry is a key into `ctx.materials` plus overrides,
 * because nothing outside `src/render/Materials.js` may construct a material.
 *
 * The albedo of `gun_metal` is already a correct parkerised grey (~0.148), so
 * tinting it downward is how you get *darker* finishes and a different key is
 * how you get brighter ones — multiplying by a colour can only darken.
 */
export const GUN_MATERIALS = {
  // Anodised aluminium receiver / rails. The defaults that ship with
  // `gun_metal` (roughness 0.25, F0 straight off a 0.15 albedo, env 1.3) turn
  // the weapon into a blurred mirror of the sky: measured against the street,
  // the top faces clipped to white while the flanks read pale blue. A real
  // hard-anodised or phosphated finish is *dark and broad* — the oxide layer
  // scatters — so F0 comes down by half and roughness goes up to 0.60, which
  // is what puts the highlight along the chamfers instead of across the slab.
  black: ['gun_metal', { uvScale: 5, roughness: 0.46, color: 0x4c5057, envMapIntensity: 0.42 }],
  // Phosphated steel: barrel, gas block, small parts. Warmer, rougher still.
  park: ['gun_metal', { uvScale: 5.5, roughness: 0.60, color: 0x585550, envMapIntensity: 0.40 }],
  // Bright machined steel: bolt carrier, charging handle, pins, screws.
  steel: ['steel_brushed', { uvScale: 4, roughness: 0.33, color: 0x7c8189, envMapIntensity: 0.60 }],
  // Blued/oiled steel: slides, hammers. Smoother than parkerising and darker.
  blued: ['gun_metal', { uvScale: 5, roughness: 0.26, color: 0x4a5058, envMapIntensity: 0.62 }],
  // Injection-moulded furniture.
  // Deep recesses: slots, grooves, holes. Reads as a cut rather than a decal.
  void: ['gun_polymer', { uvScale: 6, roughness: 0.94, color: 0x0d0e10, envMapIntensity: 0.06 }],
  polymer: ['gun_polymer', { uvScale: 12, roughness: 0.56, color: 0x5f6266, envMapIntensity: 0.40 }],
  polymer_fde: ['gun_polymer', { uvScale: 7, roughness: 0.68, color: 0xa88a63, envMapIntensity: 0.55 }],
  // Rubberised butt pad and grip inserts.
  rubber: ['rubber', { uvScale: 14, color: 0x8b8e92, envMapIntensity: 0.35 }],
  // Optic glass: not transmissive — the aperture is genuinely open geometry, so
  // this only ever covers the lens rim where the coating flares.
  lens: ['steel_brushed', { uvScale: 3, roughness: 0.06, metalness: 1, color: 0x35578a, envMapIntensity: 1.0 }],
  // The red dot itself. Emissive lands in the HDR viewmodel buffer before
  // bloom, so it flares the way a real illuminated reticle does. The scale is
  // set against a sunlit street metering at ~2 units, so it has to be an order
  // of magnitude over that to survive auto-exposure.
  // The reticle. Emissive lands in the HDR viewmodel buffer before bloom, so it
  // flares the way a real illuminated dot does. Intensity is a balance rather
  // than a maximum: past about 3 the red channel clips, ACES desaturates the
  // clipped value toward white and the grade's orange/teal boost finishes the
  // job, so a hotter dot is a *less* red one.
  dot: ['gun_polymer', { color: 0x000000, roughness: 1, envMapIntensity: 0, emissive: 0xff1204, emissiveIntensity: 2.9 }],
  tritium: ['gun_polymer', { color: 0x02120a, roughness: 0.9, envMapIntensity: 0, emissive: 0x39ff9a, emissiveIntensity: 6 }],
  wood: ['gun_wood', { uvScale: 5, envMapIntensity: 0.6 }],
  brass: ['gun_metal', { uvScale: 12, roughness: 0.34, color: 0xc79a4c, metalness: 1, envMapIntensity: 0.7 }],
  // Nomex glove — dark, matte, sheened fabric. Deliberately not skin.
  glove: ['fabric_canvas', { uvScale: 22, roughness: 0.92, color: 0x1d201c, envMapIntensity: 0.30, sheen: 0.10, sheenColor: 0x2e3129, sheenRoughness: 0.9 }],
  glove_pad: ['rubber', { uvScale: 12, color: 0x44473f, envMapIntensity: 0.35 }],
  sleeve: ['fabric_canvas', { uvScale: 20, roughness: 0.95, color: 0x33322a, envMapIntensity: 0.25, sheen: 0.10, sheenColor: 0x3b3a30, sheenRoughness: 0.92 }],
};

/** Cached `key -> THREE.Material` resolver bound to a material library. */
export function makeResolver(materials) {
  const cache = new Map();
  return (key) => {
    let m = cache.get(key);
    if (m) return m;
    const entry = GUN_MATERIALS[key] || GUN_MATERIALS.black;
    m = materials.get(entry[0], entry[1]);
    cache.set(key, m);
    return m;
  };
}

// ------------------------------------------------------------ recoil patterns

/**
 * Authored recoil patterns, indexed by shot number, as multipliers of the
 * weapon's base vertical/horizontal kick. These are *learnable*: the M4 climbs
 * hard for six, sweeps right, comes back left through the teens and settles
 * into a shallow figure-of-eight — pull down and trace it and the burst stays
 * on a head. Only ±8 % jitter is layered on top at fire time.
 */
const M4_PATTERN = [
  [1.35, 0.10], [1.00, -0.25], [1.05, 0.35], [0.98, 0.55], [0.92, 0.70], [0.88, 0.62],
  [0.84, 0.40], [0.80, 0.05], [0.78, -0.35], [0.76, -0.62], [0.74, -0.78], [0.72, -0.70],
  [0.70, -0.45], [0.68, -0.10], [0.66, 0.30], [0.64, 0.62], [0.62, 0.80], [0.60, 0.72],
  [0.58, 0.45], [0.57, 0.08], [0.56, -0.30], [0.55, -0.58], [0.54, -0.72], [0.53, -0.60],
  [0.52, -0.30], [0.51, 0.05], [0.50, 0.38], [0.50, 0.60], [0.49, 0.70], [0.49, 0.55],
];

const DEAGLE_PATTERN = [
  [1.00, 0.18], [0.96, -0.42], [0.98, 0.55], [0.94, -0.30],
  [0.97, 0.62], [0.93, -0.55], [0.95, 0.40], [0.92, -0.22],
];

const M870_PATTERN = [[1.0, 0.25], [0.95, -0.4], [1.0, 0.5], [0.92, -0.32], [0.98, 0.44], [0.94, -0.2]];

/**
 * Parametric pattern for the secondary weapons: a decaying climb plus a phase
 * drifting horizontal wave. Deterministic, so it is still learnable — it just
 * did not warrant hand authoring.
 */
function wavePattern(n, climb, decay, period, phase, hAmp) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = climb * (decay + (1 - decay) * Math.exp(-i / 5.5));
    const a = phase + (i / period) * Math.PI * 2 + (i * i) * 0.0032;
    out.push([v, Math.sin(a) * hAmp * (0.55 + 0.45 * Math.min(1, i / 6))]);
  }
  return out;
}

// ---------------------------------------------------------- material penetration

/**
 * Per-surface penetration. `thick` is the maximum thickness (metres) a full
 * power round can defeat, `retain` the damage kept on exit, `hard` the
 * penetration budget spent per metre. Concrete stops everything but the DMR,
 * which retains 25 % through 12 cm — exactly as the spec asks.
 */
export const PENETRATION = {
  plywood: { thick: 0.16, retain: 0.70, hard: 1.0 },
  wood_plank: { thick: 0.12, retain: 0.66, hard: 1.5 },
  wood_painted: { thick: 0.12, retain: 0.66, hard: 1.5 },
  metal_corrugated: { thick: 0.05, retain: 0.62, hard: 3.0 },
  metal_painted: { thick: 0.035, retain: 0.58, hard: 5.5 },
  metal_rusted: { thick: 0.04, retain: 0.58, hard: 4.8 },
  steel_brushed: { thick: 0.014, retain: 0.42, hard: 16 },
  glass: { thick: 0.05, retain: 0.92, hard: 0.4 },
  glass_broken: { thick: 0.05, retain: 0.92, hard: 0.4 },
  plaster: { thick: 0.10, retain: 0.72, hard: 2.2 },
  stucco: { thick: 0.09, retain: 0.70, hard: 2.6 },
  fabric_canvas: { thick: 0.30, retain: 0.95, hard: 0.2 },
  foliage: { thick: 0.60, retain: 0.98, hard: 0.1 },
  sandbag: { thick: 0.10, retain: 0.30, hard: 12 },
  brick: { thick: 0.09, retain: 0.35, hard: 13 },
  rubble: { thick: 0.08, retain: 0.34, hard: 14 },
  gravel: { thick: 0.05, retain: 0.30, hard: 16 },
  dirt: { thick: 0.10, retain: 0.32, hard: 11 },
  sand: { thick: 0.12, retain: 0.30, hard: 11 },
  concrete_wall: { thick: 0.12, retain: 0.25, hard: 22 },
  concrete_floor: { thick: 0.12, retain: 0.25, hard: 22 },
  asphalt: { thick: 0.08, retain: 0.25, hard: 20 },
  asphalt_worn: { thick: 0.08, retain: 0.25, hard: 20 },
  rubber: { thick: 0.06, retain: 0.70, hard: 3.0 },
  tile_roof: { thick: 0.05, retain: 0.55, hard: 6.0 },
  _default: { thick: 0.08, retain: 0.45, hard: 8.0 },
};

export function penetrationFor(key) {
  return PENETRATION[key] || PENETRATION._default;
}

/** Hitbox damage multipliers. */
export const HITBOX_MULT = { head: 1.9, chest: 1.0, stomach: 1.05, limb: 0.85, arm: 0.85, leg: 0.85 };

/** Falloff: full damage to 25 m, lerp to 60 % at 55 m, flat beyond. */
export function damageFalloff(dist) {
  if (dist <= 25) return 1;
  if (dist >= 55) return 0.6;
  return 1 - 0.4 * ((dist - 25) / 30);
}

// ------------------------------------------------------------------- weapons

const RELOAD_M4 = {
  tactical: { duration: 2.10, stages: [[0.00, 'lower'], [0.26, 'magrelease'], [0.34, 'magout'], [0.78, 'maginsert'], [1.16, 'magseat'], [1.52, 'raise']] },
  empty: { duration: 2.62, stages: [[0.00, 'lower'], [0.26, 'magrelease'], [0.34, 'magout'], [0.80, 'maginsert'], [1.20, 'magseat'], [1.68, 'boltrelease'], [1.98, 'raise']] },
};

const RELOAD_MP5 = {
  tactical: { duration: 1.92, stages: [[0.00, 'lower'], [0.22, 'magrelease'], [0.30, 'magout'], [0.70, 'maginsert'], [1.04, 'magseat'], [1.38, 'raise']] },
  empty: { duration: 2.66, stages: [[0.00, 'lower'], [0.22, 'magrelease'], [0.30, 'magout'], [0.72, 'maginsert'], [1.06, 'magseat'], [1.52, 'boltrelease'], [2.00, 'raise']] },
};

const RELOAD_PISTOL = {
  tactical: { duration: 1.72, stages: [[0.00, 'lower'], [0.20, 'magrelease'], [0.26, 'magout'], [0.68, 'maginsert'], [1.00, 'magseat'], [1.28, 'raise']] },
  empty: { duration: 2.18, stages: [[0.00, 'lower'], [0.20, 'magrelease'], [0.26, 'magout'], [0.70, 'maginsert'], [1.02, 'magseat'], [1.40, 'boltrelease'], [1.72, 'raise']] },
};

/**
 * Hip and ADS viewmodel poses.
 *
 * `hip` is authored by eye against a Call of Duty frame: the receiver sits
 * lower-right, yawed ~6 degrees inboard so the muzzle converges toward the
 * middle of the frame, with a couple of degrees of cant.
 *
 * `ads` is **not** authored — it is solved at build time from the weapon's
 * sight node so the optical axis lands exactly on the camera axis. Only the
 * eye-relief distance is a number here.
 */
const POSE_RIFLE = {
  hip: { pos: [0.140, -0.092, -0.272], rot: [1.2, 5.0, 2.6] },
  // 0.30 m is long for a red dot in real life, but it is deliberate: the
  // viewmodel composite focuses its little depth-of-field at 0.32 m, so
  // putting the sight there keeps the reticle razor sharp while the muzzle and
  // the rear of the receiver fall off — exactly the ADS look that pass exists
  // to produce.
  adsEyeRelief: 0.300,
  sprint: { pos: [0.092, -0.164, -0.265], rot: [-6.0, 26.0, -33.0] },
  lowReady: { pos: [0.122, -0.190, -0.300], rot: [-24.0, -8.0, 3.0] },
};

export const WEAPONS = {
  m4: {
    id: 'm4', name: 'M4A1', class: 'assault', model: 'm4',
    damage: 26, rpm: 800, mag: 30, reserve: 180, fireMode: 'auto', modes: ['auto', 'burst', 'semi'],
    adsTime: 0.220, muzzleVelocity: 884, mass: 3.4, penPower: 1.0, caliber: '5.56',
    recoil: { vert: 1.4, horiz: 0.6, pattern: M4_PATTERN, firstShot: 1.35, recover: 0.82, recoverTime: 0.35 },
    spread: { hipBase: 2.9, adsBase: 0.14, perShot: 0.34, max: 6.2, recovery: 7.4, moveMul: 1.9, airMul: 3.1, crouchMul: 0.72, proneMul: 0.55 },
    kick: { back: 0.0165, rise: 2.7, roll: 1.1, freq: 15.5, zeta: 0.42 },
    bolt: { travel: 0.030, time: 0.055 },
    shell: { size: 0.0056, len: 0.045, speed: 3.6 },
    reload: RELOAD_M4, pose: POSE_RIFLE, viewFov: [65, 44],
    sound: { fire: 'm4_fire', reload: 'rifle_reload' },
  },
  ak74: {
    id: 'ak74', name: 'AK-74', class: 'assault', model: 'ak74',
    damage: 31, rpm: 660, mag: 30, reserve: 180, fireMode: 'auto', modes: ['auto', 'semi'],
    adsTime: 0.250, muzzleVelocity: 900, mass: 3.6, penPower: 1.08, caliber: '5.45',
    recoil: { vert: 2.1, horiz: 1.1, pattern: wavePattern(30, 1.0, 0.52, 7.5, 0.4, 1.0), firstShot: 1.35, recover: 0.82, recoverTime: 0.35 },
    spread: { hipBase: 3.3, adsBase: 0.16, perShot: 0.42, max: 7.0, recovery: 6.6, moveMul: 2.0, airMul: 3.2, crouchMul: 0.74, proneMul: 0.56 },
    kick: { back: 0.0205, rise: 3.4, roll: 1.5, freq: 14.0, zeta: 0.40 },
    bolt: { travel: 0.034, time: 0.062 },
    shell: { size: 0.0056, len: 0.040, speed: 4.1 },
    reload: RELOAD_M4, pose: POSE_RIFLE, viewFov: [65, 44],
    sound: { fire: 'ak_fire', reload: 'rifle_reload' },
  },
  mp5: {
    id: 'mp5', name: 'MP5A5', class: 'smg', model: 'mp5',
    damage: 22, rpm: 900, mag: 30, reserve: 180, fireMode: 'auto', modes: ['auto', 'burst', 'semi'],
    adsTime: 0.180, muzzleVelocity: 780, mass: 2.9, penPower: 0.62, caliber: '9mm',
    recoil: { vert: 1.0, horiz: 0.7, pattern: wavePattern(30, 1.0, 0.58, 5.5, -0.7, 1.0), firstShot: 1.35, recover: 0.82, recoverTime: 0.32 },
    spread: { hipBase: 2.4, adsBase: 0.19, perShot: 0.30, max: 5.6, recovery: 8.6, moveMul: 1.55, airMul: 2.8, crouchMul: 0.75, proneMul: 0.58 },
    kick: { back: 0.0128, rise: 2.1, roll: 0.9, freq: 17.5, zeta: 0.45 },
    bolt: { travel: 0.026, time: 0.046 },
    shell: { size: 0.0048, len: 0.019, speed: 3.2 },
    reload: RELOAD_MP5, pose: POSE_RIFLE, viewFov: [65, 44],
    sound: { fire: 'mp5_fire', reload: 'smg_reload' },
  },
  m870: {
    id: 'm870', name: 'M870', class: 'shotgun', model: 'm870',
    damage: 22, pellets: 8, rpm: 70, mag: 6, reserve: 48, fireMode: 'pump', modes: ['pump'],
    adsTime: 0.300, muzzleVelocity: 410, mass: 3.6, penPower: 0.42, caliber: '12ga',
    recoil: { vert: 6.0, horiz: 2.0, pattern: M870_PATTERN, firstShot: 1.15, recover: 0.82, recoverTime: 0.42 },
    spread: { hipBase: 5.5, adsBase: 2.6, perShot: 0.0, max: 7.5, recovery: 5.0, moveMul: 1.35, airMul: 2.0, crouchMul: 0.85, proneMul: 0.72 },
    kick: { back: 0.040, rise: 6.4, roll: 2.4, freq: 10.0, zeta: 0.46 },
    bolt: { travel: 0.085, time: 0.22 },
    shell: { size: 0.0092, len: 0.060, speed: 2.4 },
    reload: RELOAD_M4, pose: POSE_RIFLE, viewFov: [65, 46],
    sound: { fire: 'shotgun_fire', reload: 'shell_insert' },
  },
  dmr: {
    id: 'dmr', name: 'MK14 EBR', class: 'marksman', model: 'dmr',
    damage: 55, rpm: 300, mag: 20, reserve: 100, fireMode: 'semi', modes: ['semi'],
    adsTime: 0.320, muzzleVelocity: 930, mass: 4.5, penPower: 1.9, caliber: '7.62',
    recoil: { vert: 3.2, horiz: 0.8, pattern: wavePattern(20, 1.0, 0.72, 4.5, 1.1, 1.0), firstShot: 1.35, recover: 0.82, recoverTime: 0.38 },
    spread: { hipBase: 4.2, adsBase: 0.06, perShot: 0.85, max: 7.0, recovery: 6.0, moveMul: 2.2, airMul: 3.4, crouchMul: 0.70, proneMul: 0.50 },
    kick: { back: 0.026, rise: 4.2, roll: 1.4, freq: 12.5, zeta: 0.44 },
    bolt: { travel: 0.030, time: 0.070 },
    shell: { size: 0.0078, len: 0.051, speed: 4.4 },
    reload: RELOAD_M4, pose: POSE_RIFLE, viewFov: [65, 38],
    sound: { fire: 'dmr_fire', reload: 'rifle_reload' },
  },
  deagle: {
    id: 'deagle', name: 'Deagle .50', class: 'pistol', model: 'deagle',
    damage: 45, rpm: 260, mag: 8, reserve: 48, fireMode: 'semi', modes: ['semi'],
    adsTime: 0.190, muzzleVelocity: 470, mass: 2.0, penPower: 0.95, caliber: '.50AE',
    recoil: { vert: 4.0, horiz: 1.5, pattern: DEAGLE_PATTERN, firstShot: 1.35, recover: 0.82, recoverTime: 0.40 },
    spread: { hipBase: 3.6, adsBase: 0.30, perShot: 1.2, max: 8.0, recovery: 5.4, moveMul: 1.8, airMul: 3.0, crouchMul: 0.78, proneMul: 0.62 },
    kick: { back: 0.030, rise: 6.8, roll: 2.0, freq: 13.0, zeta: 0.40 },
    bolt: { travel: 0.030, time: 0.085 },
    shell: { size: 0.0064, len: 0.033, speed: 3.0 },
    reload: RELOAD_PISTOL,
    pose: {
      hip: { pos: [0.126, -0.100, -0.248], rot: [2.2, 6.5, 3.0] },
      adsEyeRelief: 0.305,
      sprint: { pos: [0.088, -0.172, -0.245], rot: [-8.0, 30.0, -36.0] },
      lowReady: { pos: [0.112, -0.196, -0.270], rot: [-26.0, -9.0, 3.0] },
    },
    viewFov: [65, 48],
    sound: { fire: 'deagle_fire', reload: 'pistol_reload' },
  },
};

/** Default loadout order; `nextWeapon` cycles it. */
export const DEFAULT_LOADOUT = ['m4', 'mp5', 'deagle'];

/** Convert the authored degree poses into radians once, at import time. */
for (const w of Object.values(WEAPONS)) {
  for (const k of ['hip', 'sprint', 'lowReady']) {
    const p = w.pose[k];
    if (p && !p._rad) { p.rot = p.rot.map(deg); p._rad = true; }
  }
  w.fireInterval = 60 / w.rpm;
}
