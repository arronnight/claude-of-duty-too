import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Shared plumbing for the post stack: one fullscreen triangle reused by every
 * pass, a thin RawShaderMaterial wrapper, render-target helpers, and the GLSL
 * prelude that all passes are compiled against.
 *
 * Everything is GLSL3 / RawShaderMaterial rather than three's ShaderMaterial so
 * the generated source is exactly what is written here — no injected chunks, no
 * accidental tone mapping or colour-space conversion sneaking into a pass that
 * is deliberately operating on raw HDR values.
 */

const VERTEX = /* glsl */ `precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

/** Prepended to every fragment shader in the stack. */
export const PRELUDE = /* glsl */ `precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;

#define PI 3.141592653589793
#define HALF_PI 1.5707963267948966
#define TAU 6.283185307179586

in vec2 vUv;
layout( location = 0 ) out vec4 fragColor;

float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
float maxc( vec3 c ) { return max( c.r, max( c.g, c.b ) ); }

vec3 rgbToYCoCg( vec3 c ) {
  return vec3( 0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
               0.5 * c.r - 0.5 * c.b,
              -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );
}
vec3 ycoCgToRgb( vec3 c ) {
  float t = c.x - c.z;
  return vec3( t + c.y, c.x + c.z, t - c.y );
}

/** Window depth (0..1) to view-space z. Result is negative, in metres. */
float viewZFromDepth( float d, float n, float f ) {
  return ( n * f ) / ( ( f - n ) * d - f );
}
/** View-space z (negative) back to window depth. */
float depthFromViewZ( float z, float n, float f ) {
  return ( ( n + z ) * f ) / ( ( f - n ) * z );
}
vec3 viewPosFromDepth( vec2 uv, float d, mat4 invProj ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 v = invProj * clip;
  return v.xyz / v.w;
}

float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
/** Interleaved gradient noise — the cheap fallback when no blue-noise tile is bound. */
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

/**
 * View-space position from a depth sample without a matrix multiply. The
 * projection offset carries the TAA jitter, so this stays exact while the
 * projection matrix is being wobbled sub-pixel every frame.
 */
export const VIEW_RAY_GLSL = /* glsl */ `
uniform vec2 uUvToView;
uniform vec2 uProjOffset;
uniform float uNear;
uniform float uFar;

vec3 viewPosAt( vec2 uv, float d ) {
  float vz = viewZFromDepth( d, uNear, uFar );
  return vec3( ( uv * 2.0 - 1.0 + uProjOffset ) * uUvToView, -1.0 ) * -vz;
}
`;

/** Uniform block matching VIEW_RAY_GLSL; PostFX refreshes it once per frame. */
export function viewRayUniforms() {
  return {
    uUvToView: { value: new THREE.Vector2(1, 1) },
    uProjOffset: { value: new THREE.Vector2() },
    uNear: { value: 0.1 },
    uFar: { value: 1000 },
  };
}

export function updateViewRay(uniforms, camera) {
  const e = camera.projectionMatrix.elements;
  uniforms.uUvToView?.value.set(1 / e[0], 1 / e[5]);
  uniforms.uProjOffset?.value.set(e[8], e[9]);
  if (uniforms.uNear) uniforms.uNear.value = camera.near;
  if (uniforms.uFar) uniforms.uFar.value = camera.far;
}

let _quad = null;

function quad() {
  if (!_quad) _quad = new FullScreenQuad(null);
  return _quad;
}

/** Draw `material` over `target` (null = canvas). Caller owns autoClear state. */
export function blit(renderer, material, target) {
  const q = quad();
  q.material = material;
  renderer.setRenderTarget(target || null);
  q.render(renderer);
}

export class ShaderPass {
  constructor(name, fragment, uniforms = {}, defines = null) {
    this.uniforms = uniforms;
    this.material = new THREE.RawShaderMaterial({
      name,
      glslVersion: THREE.GLSL3,
      uniforms,
      defines: defines || {},
      vertexShader: VERTEX,
      fragmentShader: PRELUDE + fragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }

  set(key, value) {
    const u = this.uniforms[key];
    if (u) u.value = value;
    return this;
  }

  additive() {
    this.material.blending = THREE.CustomBlending;
    this.material.blendEquation = THREE.AddEquation;
    this.material.blendSrc = THREE.OneFactor;
    this.material.blendDst = THREE.OneFactor;
    return this;
  }

  render(renderer, target) {
    blit(renderer, this.material, target);
  }

  dispose() {
    this.material.dispose();
  }
}

const RT_DEFAULTS = {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
};

export function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    ...RT_DEFAULTS,
    ...opts,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.name = opts.name || 'postfx';
  return rt;
}

/** Depth attachment good enough to reconstruct normals at 200 m. */
export function attachDepth(rt, w, h) {
  const d = new THREE.DepthTexture(Math.max(1, w | 0), Math.max(1, h | 0), THREE.FloatType);
  d.format = THREE.DepthFormat;
  d.minFilter = THREE.NearestFilter;
  d.magFilter = THREE.NearestFilter;
  d.compareFunction = null;
  d.generateMipmaps = false;
  rt.depthTexture = d;
  rt.depthBuffer = true;
  return rt;
}

/**
 * 32x32 two-channel blue noise, void-and-cluster. Small enough that the
 * generator runs in a couple of milliseconds at init and large enough that,
 * combined with a golden-ratio temporal offset, the raymarch dither reads as
 * grain rather than a repeating pattern.
 */
export function makeBlueNoise(size = 32) {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  for (let ch = 0; ch < 2; ch++) {
    const rank = voidAndCluster(size, 0.4681 + ch * 0.2749);
    for (let i = 0; i < n; i++) data[i * 4 + ch] = Math.min(255, (rank[i] / n) * 256) | 0;
  }
  for (let i = 0; i < n; i++) {
    data[i * 4 + 2] = 255 - data[i * 4];
    data[i * 4 + 3] = 255 - data[i * 4 + 1];
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'postfx:blueNoise';
  return tex;
}

function voidAndCluster(size, seed) {
  const n = size * size;
  const bin = new Uint8Array(n);
  const energy = new Float32Array(n);
  const rank = new Int32Array(n).fill(-1);

  // Deterministic LCG so the tile is identical on every run.
  let s = Math.floor(seed * 2147483647) | 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const R = 5;
  const sigma2 = 2 * 1.9 * 1.9;
  const kernel = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      kernel.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / sigma2)]);
    }
  }

  const splat = (idx, sign) => {
    const x = idx % size;
    const y = (idx / size) | 0;
    for (let k = 0; k < kernel.length; k++) {
      const [dx, dy, w] = kernel[k];
      const sx = (x + dx + size) % size;
      const sy = (y + dy + size) % size;
      energy[sy * size + sx] += sign * w;
    }
  };

  let ones = 0;
  const target = Math.max(1, Math.round(n * 0.1));
  while (ones < target) {
    const i = Math.min(n - 1, (rnd() * n) | 0);
    if (bin[i]) continue;
    bin[i] = 1;
    splat(i, 1);
    ones++;
  }

  const tightest = () => {
    let best = -1;
    let bv = -1e30;
    for (let i = 0; i < n; i++) if (bin[i] && energy[i] > bv) { bv = energy[i]; best = i; }
    return best;
  };
  const largestVoid = () => {
    let best = -1;
    let bv = 1e30;
    for (let i = 0; i < n; i++) if (!bin[i] && energy[i] < bv) { bv = energy[i]; best = i; }
    return best;
  };

  // Phase 0: relax the random seed pattern into a proper blue-noise set.
  for (let it = 0; it < n; it++) {
    const c = tightest();
    bin[c] = 0; splat(c, -1);
    const v = largestVoid();
    if (v === c) { bin[c] = 1; splat(c, 1); break; }
    bin[v] = 1; splat(v, 1);
  }

  const initial = bin.slice();
  // Phase 1: strip the seed set, lowest ranks first.
  let r = ones - 1;
  while (r >= 0) {
    const c = tightest();
    bin[c] = 0; splat(c, -1);
    rank[c] = r--;
  }
  // Phase 2 + 3: fill the remainder, largest void first.
  bin.set(initial);
  energy.fill(0);
  for (let i = 0; i < n; i++) if (bin[i]) splat(i, 1);
  for (let k = ones; k < n; k++) {
    const v = largestVoid();
    if (v < 0) break;
    bin[v] = 1; splat(v, 1);
    rank[v] = k;
  }
  for (let i = 0; i < n; i++) if (rank[i] < 0) rank[i] = 0;
  return rank;
}

/**
 * Rolling GPU timer. Queries are one frame behind so nothing ever blocks; if
 * the extension is missing the reported cost stays at -1 and callers fall back
 * to the CPU-side measurement.
 */
export class GpuTimer {
  constructor(renderer) {
    const gl = renderer.getContext();
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') || null;
    this.pending = [];
    this.ms = -1;
    this._active = null;
  }

  begin() {
    if (!this.ext || this._active) return;
    const gl = this.gl;
    const q = gl.createQuery();
    try {
      gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
      this._active = q;
    } catch {
      gl.deleteQuery(q);
      this.ext = null;
    }
  }

  end() {
    if (!this.ext || !this._active) return;
    const gl = this.gl;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this._active);
    this._active = null;
    if (this.pending.length > 6) gl.deleteQuery(this.pending.shift());
    this._poll();
  }

  _poll() {
    const gl = this.gl;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return;
      this.pending.shift();
      if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        // ANGLE over Metal charges queue wait to TIME_ELAPSED, which produces
        // frame times an order of magnitude too high. Anything past a third of
        // a second of GPU work in one pass block is that, not real cost.
        if (ms > 0 && ms < 33) this.ms = this.ms < 0 ? ms : this.ms * 0.9 + ms * 0.1;
      }
      gl.deleteQuery(q);
    }
  }

  dispose() {
    const gl = this.gl;
    for (const q of this.pending) gl.deleteQuery(q);
    this.pending.length = 0;
  }
}
