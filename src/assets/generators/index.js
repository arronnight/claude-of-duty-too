import { NOISE_GLSL } from '../shaders/noise.glsl.js';
import { SURFACE_GLSL } from '../shaders/surface.glsl.js';
import { MASONRY } from './masonry.js';
import { GROUND } from './ground.js';
import { WOOD } from './wood.js';
import { METAL } from './metal.js';
import { MISC } from './misc.js';

/**
 * Registry of every material key in the architecture contract plus the shader
 * assembly that turns one into a compilable MRT generator program. Each entry
 * declares the world footprint of one tile (so the material library can pick a
 * physically sane `repeat`), a bump strength and a cavity-AO strength.
 */
export const GENERATORS = { ...MASONRY, ...GROUND, ...WOOD, ...METAL, ...MISC };

export const MATERIAL_KEYS = Object.keys(GENERATORS);

const VERTEX = /* glsl */ `
out vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const HEADER = /* glsl */ `
precision highp float;
precision highp int;

uniform float uSeed;
uniform float uSize;
uniform float uBump;
uniform float uCavity;
uniform float uAge;
uniform float uRoughBias;
uniform vec3  uTint;

in vec2 vUv;

layout(location = 0) out vec4 gAlbedo;
layout(location = 1) out vec4 gORM;
layout(location = 2) out vec4 gNormal;
#ifdef USE_HEIGHT
layout(location = 3) out vec4 gHeight;
#endif
`;

/**
 * Normals and cavity occlusion come from extra evaluations of the generator at
 * sub-texel offsets rather than a Sobel pass over an 8-bit height buffer, so the
 * derivative is taken at full float precision and never bands.
 */
const MAIN = /* glsl */ `
float ign(vec2 p){ return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y)); }

/**
 * Albedo is authored the way a texture artist picks colours — in sRGB — but the
 * attachment is allocated SRGB8_ALPHA8, and ES3 always encodes linear→sRGB on
 * write. Undo that here so the byte actually stored is the authored value.
 */
vec3 srgbToLinear(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

void main(){
  vec2 uv = vUv;
  Surf s = GEN_FN(uv);

  float e = 1.0 / uSize;
  float hx = GEN_FN(uv + vec2(e, 0.0)).h;
  float hy = GEN_FN(uv + vec2(0.0, e)).h;
  float k = uBump * uSize * 0.0175;
  vec3 n = normalize(vec3(-(hx - s.h) * k, -(hy - s.h) * k, 1.0));

  float ao = s.ao;
#ifdef USE_CAVITY
  float e2 = 6.0 / uSize;
  float c = 0.25 * (GEN_FN(uv + vec2(e2, 0.0)).h + GEN_FN(uv - vec2(e2, 0.0)).h
                  + GEN_FN(uv + vec2(0.0, e2)).h + GEN_FN(uv - vec2(0.0, e2)).h);
  ao *= sat(1.0 - max(0.0, c - s.h) * uCavity * 3.4);
#endif

  float d = (ign(gl_FragCoord.xy) - 0.5) / 255.0;

  gAlbedo = vec4(srgbToLinear(sat3(s.alb + d)), sat(s.op));
  gORM    = vec4(sat(ao + d), sat(s.rough + d), sat(s.metal), sat(s.h));
  gNormal = vec4(n * 0.5 + 0.5, 1.0);
#ifdef USE_HEIGHT
  gHeight = vec4(vec3(sat(s.h + d)), 1.0);
#endif
}
`;

export function vertexShader() {
  return VERTEX;
}

/** Assemble the full fragment program for one material key. */
export function fragmentShader(key, opts = {}) {
  const gen = GENERATORS[key];
  if (!gen) throw new Error(`TextureFactory: unknown material key "${key}"`);
  const seen = new Set();
  let deps = '';
  for (const d of gen.deps || []) {
    if (seen.has(d) || !GENERATORS[d]) continue;
    seen.add(d);
    deps += GENERATORS[d].glsl;
  }
  const defines =
    ((gen.cavity ?? 0) > 0 ? '#define USE_CAVITY\n' : '') +
    (opts.height ? '#define USE_HEIGHT\n' : '');
  return `${defines}${HEADER}\n#define GEN_FN gen_${key}\n${NOISE_GLSL}\n${SURFACE_GLSL}\n${deps}\n${gen.glsl}\n${MAIN}`;
}
