import * as THREE from 'three';

/**
 * Replaces three's flat `mix(color, fogColor, f)` with real aerial perspective:
 * an analytically integrated exponential *height* fog whose inscattered colour
 * is the sky in the view direction, brightening toward the sun through a
 * Henyey-Greenstein lobe. That single change is most of what separates a
 * "three.js demo" look from a shipped shooter — distant geometry has to lose
 * contrast and pick up the sky, and the haze has to glow where the sun is.
 *
 * Getting per-frame data into materials this system does not own is the awkward
 * part. `UniformsUtils.clone` copies a Float32Array uniform *by reference*, so
 * seeding one shared array into every `ShaderLib` entry gives every stock
 * material a live view of the same 16 floats, with no `onBeforeCompile` hook to
 * collide with the materials agent. Custom `ShaderMaterial`s that do not carry
 * the uniform read zeroes and fall back to stock fog automatically.
 */

const AP_SIZE = 20;
const params = new Float32Array(AP_SIZE);

export const AP = {
  /** 0:enabled 1:density 2:heightFalloff 3:maxOpacity */
  set enabled(v) { params[0] = v ? 1 : 0; },
  get enabled() { return params[0] > 0.5; },
  set density(v) { params[1] = v; },
  set heightFalloff(v) { params[2] = v; },
  set maxOpacity(v) { params[3] = v; },
  setSunDir(v) { params[4] = v.x; params[5] = v.y; params[6] = v.z; },
  set anisotropy(v) { params[7] = v; },
  setSunColor(c) { params[8] = c.r; params[9] = c.g; params[10] = c.b; },
  set startDistance(v) { params[11] = v; },
  /** Inscatter colour looking at the horizon. */
  setAmbientColor(c) { params[12] = c.r; params[13] = c.g; params[14] = c.b; },
  set referenceHeight(v) { params[15] = v; },
  /** Inscatter colour looking at the zenith; the shader blends by view elevation. */
  setZenithColor(c) { params[16] = c.r; params[17] = c.g; params[18] = c.b; },
  /** How far the inscatter darkens looking down into the ground-bounce hemisphere. */
  set groundFalloff(v) { params[19] = v; },
  array: params,
};

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogViewPos;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogViewPos = mvPosition.xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogViewPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif

  uniform vec4 apParams[5];

  float apHG(float c, float g){
    float g2 = g * g;
    float d = 1.0 + g2 - 2.0 * g * c;
    return 0.07957747 * (1.0 - g2) / (d * sqrt(max(d, 1e-4)));
  }

  /** Horizontal component of a direction, normalised, zero-safe. */
  vec2 apFlatDir(vec3 d){
    vec2 h = vec2(d.x, d.z);
    return h / max(length(h), 1e-4);
  }

  /** Analytic integral of rho0 * exp(-k * (y - yref)) along the view segment. */
  float apOpticalDepth(float y0, float y1, float dist, float rho0, float k, float yref){
    float dy = y1 - y0;
    float e0 = exp(-k * (y0 - yref));
    if (abs(k * dy) < 1e-4) return rho0 * dist * e0;
    float e1 = exp(-k * (y1 - yref));
    return rho0 * dist * (e0 - e1) / (k * dy);
  }
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  if (apParams[0].x > 0.5) {
    float apDist = max(length(vFogViewPos) - apParams[2].w, 0.0);
    vec3 apDirW = normalize(vFogViewPos) * mat3(viewMatrix);
    float apY0 = cameraPosition.y;
    float apY1 = apY0 + apDirW.y * apDist;
    float apTau = apOpticalDepth(apY0, apY1, apDist, apParams[0].y, apParams[0].z, apParams[3].w);
    float apF = (1.0 - exp(-apTau)) * apParams[0].w;
    float apPhase = 12.566371 * apHG(dot(apDirW, apParams[1].xyz), apParams[1].w);
    // Inscatter is the sky *in the view direction*, not one flat grey: horizon
    // colour along the ground, zenith colour looking up, and a darker
    // ground-bounce term looking down. A constant makes every distance read as
    // the same sheet of white and kills the depth cue the haze exists to give.
    vec3 apSky = mix( apParams[3].xyz, apParams[4].xyz, smoothstep( 0.0, 0.62, apDirW.y ) );
    apSky *= mix( apParams[4].w, 1.0, smoothstep( -0.30, 0.015, apDirW.y ) );
    // Azimuthal warm/cool swing. Real haze is warm cream toward the sun and
    // cool mauve away from it across the entire width of the frame; a narrow
    // Henyey-Greenstein lobe is a few degrees wide and cannot produce that, so
    // without this term the haze is one flat colour everywhere the lobe is not.
    // +/-8% over a 120 degree arc, no new uniforms — apParams[1].xyz is the sun.
    // normalize() of a zero vector is NaN, and both of these go to zero on the
    // vertical (a fragment straight underfoot, a sun at the zenith), so the
    // epsilon is load-bearing rather than defensive.
    float apAz = dot( apFlatDir( apDirW ), apFlatDir( apParams[1].xyz ) );
    apSky *= mix( vec3( 0.94, 0.96, 1.03 ), vec3( 1.10, 1.03, 0.92 ),
                  smoothstep( -0.25, 0.85, apAz ) );
    // The inscatter term was unbounded. The normalised HG peak at g = 0.62 is
    // 11.3x, so within ~20 degrees of a low sun the haze rendered brighter than
    // the sky it is supposed to be dissolving into — that is the "far end of
    // the street blows to white" defect that survived two previous passes.
    // Real air only exceeds sky radiance inside the ~5 degree solar aureole,
    // so cap the additive term at 1.25x the local sky: 2.25x total, which is
    // about the true aureole ratio. One min() on a vec3.
    vec3 apIn = apSky + min( apParams[2].xyz * apPhase, apSky * 1.25 );
    gl_FragColor.rgb = gl_FragColor.rgb * (1.0 - apF) + apIn * apF;
  } else {
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  }
#endif
`;

let installed = false;

/**
 * Patches the fog chunks and seeds the shared uniform. Idempotent, and safe to
 * call before any material exists — which is why the sky system calls it at
 * module scope rather than in init().
 */
export function installAerialPerspective() {
  if (installed) return AP;
  installed = true;
  try {
    THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
    THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
    THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
    THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;

    const seed = () => ({ value: params });
    THREE.UniformsLib.fog.apParams = seed();
    for (const key of Object.keys(THREE.ShaderLib)) {
      const u = THREE.ShaderLib[key].uniforms;
      if (u && u.fogColor !== undefined) u.apParams = seed();
    }
  } catch (e) {
    installed = false;
    console.warn('Sky: aerial perspective install failed, falling back to stock fog', e);
  }
  return AP;
}
