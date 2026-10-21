import * as THREE from 'three';

/**
 * The operator kit atlas: the contract between `BotRig`'s geometry and the
 * `bot_kit` material published by the materials system.
 *
 * `bot_kit` is a packed 4x4 atlas of real kit surfaces — cordura, ripstop,
 * MOLLE webbing, helmet shell, polymer, rubber, optic glass, boot lug, coyote
 * accents. One material, one program, one draw call per bot, and sixteen
 * distinct surfaces. Everything in this file exists so that a single skinned
 * geometry can address all sixteen.
 *
 * WHY THE PALETTE IS A TINT AND NOT AN ALBEDO
 * -------------------------------------------
 * The obvious move — put the operator palette straight into the vertex colour —
 * is wrong here, twice over. First, the atlas tiles already carry the authored
 * albedo (cordura is 0.10 linear, boot sole 0.040, optic glass 0.03); a second
 * dark multiply on top lands the whole bot at 0.002 and it becomes a hole in
 * the frame. Second, `SurfaceShader` reads the *luminance of the vertex colour*
 * as an ambient-occlusion term on indirect light, so a 0.02 vertex colour also
 * switches off the sky fill that is the only thing keeping a near-black
 * operator legible against a near-black background.
 *
 * So the split is: the atlas owns value, the vertex colour owns the small
 * relative differences between parts that share a tile plus the dirt gradient
 * and the baked contact AO, and the per-bot material colour owns the overall
 * exposure of the kit. All three multiply, and all three stay in a range the
 * AO term is happy with.
 */

// Tile (r, c) with r counted UP from v = 0, per the material contract.
export const TILE = {
  cordura: [0, 0],
  ripstop: [0, 1],
  helmetMesh: [0, 2],
  helmetShell: [0, 3],
  rubber: [1, 0],
  polymer: [1, 1],
  gunMetal: [1, 2],
  molle: [1, 3],
  velcro: [2, 0],
  shockCord: [2, 1],
  optic: [2, 2],
  bootSole: [2, 3],
  coyoteCordura: [3, 0],
  coyoteWebbing: [3, 1],
  patch: [3, 2],
  grime: [3, 3],
};

// The outer 9.375% of every tile is mip-bleed padding held at that tile's flat
// mean. Mapping the full 0..1 of a tile puts a flat frame round the panel.
const PAD = 0.094;
const INNER = 0.906 - PAD;

/** UV sub-rect of one named tile: [u0, v0, du, dv]. */
export function tileRect(name) {
  const t = TILE[name] || TILE.cordura;
  return [(t[1] + PAD) / 4, (t[0] + PAD) / 4, INNER / 4, INNER / 4];
}

/**
 * Fold a 0..n UV coordinate into 0..1 by mirroring rather than wrapping.
 *
 * A tile cannot wrap — `fract` would sample the neighbouring tile across the
 * seam, and worse, the derivative discontinuity at the seam blows the mip
 * selection out to the coarsest level in a one-pixel band. Mirroring is
 * continuous everywhere, tiles a weave perfectly well, and is free.
 */
export function pingpong(x) {
  const m = x - 2 * Math.floor(x / 2);
  return m > 1 ? 2 - m : m;
}

// ------------------------------------------------------------------- palette

/**
 * A per-part tint in LINEAR space, centred on 1.0.
 *
 * `value` is the part's brightness relative to its own atlas tile; `cool` is
 * how far it leans toward the blue end. Every measured reference sample of real
 * kit has B >= G >= R by 2-5 units — kit is neutral-to-cool black, never warm —
 * and the atlas tiles are very slightly olive, so a cool bias here lands the
 * product where the references sit.
 */
function tint(value, cool = 0.6) {
  return new THREE.Color(
    value * (1 - 0.075 * cool),
    value * (1 - 0.015 * cool),
    value * (1 + 0.065 * cool),
  );
}

/**
 * Every surface a bot is made of: which atlas tile it samples and how it is
 * tinted. Parts sharing a tile are separated here rather than by burning a
 * second tile on a 4% value difference.
 */
export const KIT = {
  // Soft kit.
  shirt: { tile: 'ripstop', tint: tint(1.00) },
  shirtWorn: { tile: 'ripstop', tint: tint(0.86) },
  trouser: { tile: 'ripstop', tint: tint(0.94) },
  gaiter: { tile: 'velcro', tint: tint(0.82, 0.8) },
  glove: { tile: 'rubber', tint: tint(1.02, 0.5) },

  // Load bearing.
  carrier: { tile: 'cordura', tint: tint(0.94) },
  carrierBack: { tile: 'cordura', tint: tint(0.88) },
  pouch: { tile: 'cordura', tint: tint(0.86) },
  pouchFlap: { tile: 'cordura', tint: tint(1.06) },
  molle: { tile: 'molle', tint: tint(0.96) },
  webbing: { tile: 'molle', tint: tint(0.80, 0.8) },
  shockCord: { tile: 'shockCord', tint: tint(0.92, 0.8) },
  velcro: { tile: 'velcro', tint: tint(0.90, 0.7) },

  // Head.
  helmet: { tile: 'helmetShell', tint: tint(1.00, 0.7) },
  helmetCover: { tile: 'helmetMesh', tint: tint(0.98, 0.7) },
  helmetHard: { tile: 'polymer', tint: tint(1.00, 0.7) },
  faceVoid: { tile: 'velcro', tint: tint(0.42, 0.9) },
  eyePro: { tile: 'optic', tint: tint(1.00, 0.9) },

  // Hard kit.
  polymer: { tile: 'polymer', tint: tint(1.00, 0.7) },
  rubber: { tile: 'rubber', tint: tint(0.96, 0.5) },
  sole: { tile: 'bootSole', tint: tint(1.00, 0.4) },
  optic: { tile: 'optic', tint: tint(1.00, 0.9) },
  gunMetal: { tile: 'gunMetal', tint: tint(0.84, 0.8) },
  gunPoly: { tile: 'polymer', tint: tint(0.92, 0.7) },

  // The two authorised accents, and nothing else.
  accentTan: { tile: 'coyoteCordura', tint: tint(1.00, 0.0) },
  accentTanWeb: { tile: 'coyoteWebbing', tint: tint(1.00, 0.0) },
  patch: { tile: 'patch', tint: tint(1.00, 0.0) },
};

/**
 * Slots a bot may remap to coyote. Exactly ONE per bot, per the mw3_05 formula:
 * one coyote element plus one arm patch, and no third accent colour.
 */
export const ACCENT_SLOTS = ['helmetCover', 'pouch', 'carrierBack'];

/**
 * Per-bot material colour. Deterministic in the bot index so screenshots are
 * reproducible. Value jitter +/-9%, hue jitter +/-6 degrees about 215, and an
 * overall exposure scale that is the single knob for how dark the kit sits
 * against its background.
 */
export function botTint(index, exposure = 1, out = new THREE.Color()) {
  const s = Math.sin(index * 12.9898 + 4.1414) * 43758.5453;
  const r1 = s - Math.floor(s);
  const s2 = Math.sin(index * 78.233 + 1.7) * 24634.6345;
  const r2 = s2 - Math.floor(s2);
  const v = exposure * (0.91 + 0.18 * r1);
  const hue = (215 + (r2 * 12 - 6)) / 360;
  // Linear space deliberately: this multiplies an already-linear albedo, and
  // Color.setHSL would otherwise apply an sRGB decode and halve the value.
  out.setHSL(hue, 0.07, 0.5, THREE.LinearSRGBColorSpace);
  return out.multiplyScalar(2 * v);
}

// ----------------------------------------------------------- contact shadow

let _contactTex = null;

/**
 * 64x64 radial contact-occlusion stamp, generated in code.
 *
 * RGB is the OCCLUSION amount, not the shadow colour: the material multiplies
 * the framebuffer by (1 - src), so 0 is "leave the road alone" and 1 is "black".
 * The dither breaks the banding that a smooth 8-bit radial gradient shows the
 * moment it is stretched over 40 screen pixels.
 */
export function contactShadowTexture() {
  if (_contactTex) return _contactTex;
  const N = 64;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N - 0.5;
      const v = (y + 0.5) / N - 0.5;
      const r = Math.hypot(u, v) * 2;
      const t = THREE.MathUtils.smoothstep(r, 0.15, 0.50);
      let a = Math.pow(1 - t, 1.6);
      // 12% blue-ish noise: a hash decorrelated between neighbours, which is
      // what stops the dither reading as a texture of its own.
      const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      a *= 1 + ((h - Math.floor(h)) - 0.5) * 0.12;
      const b = Math.max(0, Math.min(255, Math.round(a * 255)));
      const i = (y * N + x) * 4;
      data[i] = b; data[i + 1] = b; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  // Linear data, not colour: this is an occlusion mask.
  tex.colorSpace = THREE.NoColorSpace;
  _contactTex = tex;
  return tex;
}

export function disposeKitAtlas() {
  _contactTex?.dispose();
  _contactTex = null;
}
