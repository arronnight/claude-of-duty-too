/**
 * Physical constants for the atmosphere model, shared by the JS ephemeris and
 * every GLSL pass so the CPU-side sun colour and the GPU-side sky can never
 * disagree. Lengths are kilometres, coefficients are per kilometre; using km
 * keeps the raymarch integrands within float precision on mobile GPUs too.
 *
 * Scattering coefficients are Bruneton's fit (680/550/440 nm), which is what
 * gives a deep blue zenith, a correct 4-degree Mie aureole and sunset reds that
 * fall out of optical depth rather than an authored gradient.
 */
export const RG = 6360.0;
export const RT = 6420.0;
export const H_RAYLEIGH = 8.0;
export const H_MIE = 1.2;

export const BETA_R = [5.802e-3, 13.558e-3, 33.1e-3];
/** Slightly cleaner than Bruneton's default aerosol load; a hazier value flattens the sky toward the sun. */
export const BETA_M_SCATTER = 3.10e-3;
export const BETA_M_EXTINCT = 3.55e-3;
export const BETA_OZONE = [0.650e-3, 1.881e-3, 0.085e-3];
export const OZONE_CENTER = 25.0;
export const OZONE_WIDTH = 15.0;
export const MIE_G = 0.76;

/**
 * Extraterrestrial spectrum, normalised so that after zenith optical depth the
 * ground-level sun lands near 6500 K; the same vector reddens to ~2000 K at
 * the horizon purely from the 38x airmass. No colour ramp anywhere.
 */
export const SOLAR_SPECTRUM = [1.0, 1.062, 1.28];

export const SUN_ANGULAR_RADIUS = 0.004654; // rad, 0.533 deg full angle
export const MOON_ANGULAR_RADIUS = 0.004520;

/** Mid-latitude site. Declination puts sunrise/sunset within 0.03 of the 0.25/0.75 contract anchors. */
export const LATITUDE = 41.9 * Math.PI / 180;
export const SUN_DECLINATION = 14.0 * Math.PI / 180;
export const MOON_DECLINATION = 22.0 * Math.PI / 180;
/** Moon hour-angle lead over the sun: ~150 deg elongation, a waxing gibbous that clears the skyline at dusk. */
export const MOON_HOUR_LEAD = 150.0 * Math.PI / 180;
/**
 * World bearing of true north. This is the map's compass orientation and it is an
 * ART DIRECTION decision, not a physics one — it alone decides where the sun sits
 * relative to the market street, and therefore the composition of every
 * ground-level frame in the game.
 *
 * The street runs along Z (camera looks down -Z). At -90 deg the mid-morning sun
 * came up almost exactly along -Z, so `street`, `ads`, `weapon`, `materials` and
 * `skyline` all shot straight into the disk and clipped the far end of the
 * corridor to flat white, with no shadow structure on the road at all.
 *
 * -25 deg puts the sun bearing at +66 deg from the street axis at tod 0.30 (the
 * "MORNING RAID" primary look) and +71 deg at 0.32, elevation 23-28 deg. That is
 * the rake ART_DIRECTION.md asks for:
 *   - the disk sits well outside a 70 deg-fov frame looking down the street, so
 *     nothing shoots into it;
 *   - the sun is on the +X (east) side, so the west facades — including the room's
 *     street-facing wall — are in hard sun while the east facades fall away into
 *     sky-fill shadow, giving the warm-key / cool-fill separation;
 *   - the east blocks cast across the 22.8 m facade-to-facade corridor, and their
 *     staggered heights (10.5 / 15.5 / 8.0 / 19.0 m) put the road half in shadow
 *     with a sunlit pool opening up mid-corridor behind the short 8 m block. That
 *     lit/shadow split down the street floor is the money shot;
 *   - light rakes into the west room's east-facing doorway, so `interior` gets a
 *     real shaft against a dark interior instead of flat ambient.
 * At golden hour (0.76) the same offset swings the low sun round to -X, giving
 * the establishing camera a cross-frame raking key instead of a back-light.
 */
export const NORTH_OFFSET = -25.0 * Math.PI / 180;

/** Scene radiance scale: turns unit solar irradiance into pre-tonemap linear units. */
export const SKY_EXPOSURE = 24.0;
/** Night lift. A real moonlit sky is 2.5e-6 of daylight; film nights are printed ~10 stops up. */
export const MOON_SCATTER_LIFT = 0.50;
/**
 * Cloud illumination gain. A Lambertian cloud would return E/pi, ~30x the blue
 * zenith, which clips to a white blob; real cumulus seen from the side sit
 * nearer 4x, and that is the ratio that keeps shape readable after ACES.
 */
export const CLOUD_SUN_GAIN = 0.50;
/** Half float tops out at 65504; keep the disk well clear so bloom never sees Inf. */
export const MAX_DISK_RADIANCE = 6000;

export const GROUND_ALBEDO = [0.085, 0.077, 0.062];
