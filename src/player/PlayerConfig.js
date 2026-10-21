/**
 * Every tunable that shapes player feel, in one place. Values are in SI units
 * (metres, seconds, degrees for anything an animator would think of in degrees)
 * so they can be reasoned about physically instead of by trial and error.
 *
 * The acceleration model is the Quake/idTech one CoD inherited: `accel` and
 * `friction` are unitless rate coefficients multiplied by wish speed, which is
 * what gives the characteristic instant-on/short-skid ground movement.
 */
export const PlayerConfig = {
  eye: { stand: 1.62, crouch: 1.04, prone: 0.38, slide: 0.82 },
  capsule: { radius: 0.34, stand: 1.80, crouch: 1.22, prone: 0.60, slide: 1.00 },

  speed: {
    walk: 3.2,
    run: 4.8,
    sprint: 6.2,
    tacSprint: 7.5,
    strafeScale: 0.90,
    backScale: 0.78,
    crouchMul: 0.52,
    proneMul: 0.20,
    adsMul: 0.66,
    tacStrafeScale: 0.35,
  },

  accel: {
    ground: 10,
    airControl: 0.15,
    friction: 8,
    stopSpeed: 1.25,
    gravity: 18.5,
    jump: 6.05,
    crouchJumpMul: 0.86,
    groundStick: -2.4,
    slopeLimit: 0.62,      // cos of max walkable slope
    maxSpeed: 16,
  },

  stance: {
    toCrouch: 0.18,
    toStand: 0.20,
    toProne: 0.50,
    fromProne: 0.85,       // the characteristic slow get-up
    toSlide: 0.12,
    proneLockout: 0.35,    // cannot re-stand instantly after going prone
  },

  slide: {
    enterSpeed: 4.6,
    boostMul: 1.22,
    minSpeed: 8.2,
    maxSpeed: 9.8,
    decay: 1.35,           // exponential, per second — ~0.7 s of usable slide
    minDuration: 0.35,
    maxDuration: 1.10,
    exitSpeed: 3.4,
    cooldown: 0.95,
    steerRate: 55,         // degrees/second
    slopeGain: 0.55,
    jumpKeep: 0.90,
    jumpMul: 0.96,
    rollDeg: 6.5,
    pitchDeg: 2.0,
    fovAdd: 5,
  },

  mantle: {
    reach: 0.92,
    minHeight: 0.42,
    maxHeight: 2.05,
    vaultHeight: 1.05,     // below this it is a fast vault, above a pull-up
    clearance: 1.02,       // headroom needed above the ledge
    vaultTime: 0.37,
    mantleTime: 0.44,
    mantleTimePerMetre: 0.20,
    exitSpeedVault: 3.6,
    exitSpeedMantle: 1.1,
    autoVaultSpeed: 5.0,
    probeInterval: 0.09,
    landOffset: 0.52,
    rollDeg: 3.4,
    pitchDeg: 3.2,
    fovPunch: 6.0,
    cooldown: 0.25,
  },

  view: {
    stride: { walk: 0.78, run: 1.05, sprint: 1.32 },
    bob: { x: 0.021, y: 0.016, rollDeg: 0.34, pitchDeg: 0.20, freq: 13, zeta: 0.86 },
    sprintBob: { x: 0.046, y: 0.034, rollDeg: 1.15, yawDeg: 0.95, pitchDeg: 0.42 },
    stanceBobMul: { stand: 1, crouch: 0.58, prone: 0.30 },
    land: { perSpeed: 0.019, max: 0.17, pitchPerSpeed: 0.32, pitchMax: 2.9, freq: 4.6, zeta: 0.52 },
    breath: { amp: 0.0092, rotDeg: 0.115, rate: 0.30, staminaGain: 2.4 },
    ads: { amp: 0.0026, pitchDeg: 0.17, yawDeg: 0.235, rate: 0.95, holdBreathMul: 0.18, bobMul: 0.28 },
    strafeRollDeg: 1.2,
    turnRollDeg: 0.55,
    roll: { freq: 3.1, zeta: 0.85 },
    lag: { gain: 0.0022, max: 0.050, freq: 3.4, zeta: 0.92, lookGain: 0.0095, lookMax: 0.028 },
    lean: { offset: 0.36, rollDeg: 11, freq: 5.0, zeta: 0.95, speedMul: 0.72, probePad: 0.22 },
    recoil: { retain: 0.34, retainDecay: 0.9, maxRetainDeg: 4.5, freq: 1.9, zeta: 0.72, kickVel: 3.5 },
  },

  fov: {
    base: 80,
    sprint: 8,
    tacSprint: 11,
    ads: 52,               // fallback when the weapon has not published one
    ease: { freq: 3.0, zeta: 1.0 },
    adsEaseRate: 13,
    sensCoefficient: 0.0,  // 0 = "relative to FOV" (tan ratio), 1 = 100% monitor distance
  },

  stamina: {
    max: 100,
    sprintDrain: 8,
    tacDrain: 26,
    jumpCost: 6,
    slideCost: 9,
    regen: 15,
    regenDelay: 1.1,
    tacMinimum: 14,
    exhaustedRecovery: 30,
  },

  health: {
    max: 100,
    armour: 50,
    armourAbsorb: 0.62,
    regenDelay: 4.2,
    regenRate: 24,
    hitKickDeg: 2.6,
  },
};
