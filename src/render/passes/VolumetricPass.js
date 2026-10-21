import * as THREE from 'three';
import { ShaderPass, makeRT } from './Common.js';

/**
 * Volumetric sun scattering by raymarching the cascaded shadow map in world
 * space. Not a radial screen blur: shafts only exist where the medium is
 * actually lit, so a window casts a real beam and a wall casts a real gap, and
 * the effect survives the sun being off screen.
 *
 * 32 steps, blue-noise dithered start offset, temporally accumulated against a
 * reprojected half-resolution history. The cascade is chosen by testing
 * containment from the tightest outward, which costs one matrix multiply for
 * the near samples that dominate and needs no split distances from the
 * lighting system.
 */

function buildFragment(cascades, steps) {
  let decls = '';
  let chain = '';
  for (let i = 0; i < cascades; i++) {
    decls += `uniform sampler2D uCsm${i};\nuniform mat4 uCsmMat${i};\n`;
    chain += `
  sc = ( uCsmMat${i} * vec4( wp, 1.0 ) ).xyz;
  if ( all( greaterThan( sc, vec3( 0.008 ) ) ) && all( lessThan( sc, vec3( 0.992 ) ) ) )
    return SHADOW_LIT( texture( uCsm${i}, sc.xy ).r, sc.z - uShadowBias );
`;
  }

  return /* glsl */ `
uniform sampler2D uDepth;
uniform sampler2D uNoise;
uniform sampler2D uHistory;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec2 uNoiseScale;
uniform float uNear;
uniform float uFar;
uniform float uDensity;
uniform float uHeightFalloff;
uniform float uHeightRef;
uniform float uAnisotropy;
uniform float uMaxDistance;
uniform float uStrength;
uniform float uShadowBias;
uniform float uFrame;
uniform float uTime;
uniform float uReset;

${decls}

#ifdef REVERSED_DEPTH
  #define SHADOW_LIT( d, z ) step( d, z )
#else
  #define SHADOW_LIT( d, z ) step( z, d )
#endif

float cascadeShadow( vec3 wp ) {
  vec3 sc;
${chain}
  return 1.0;
}

float henyeyGreenstein( float cosT, float g ) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * cosT;
  return ( 1.0 - g2 ) / ( 4.0 * PI * max( d * sqrt( max( d, 1e-4 ) ), 1e-4 ) );
}

/** Slow drifting dust so the medium is not a perfectly smooth wedge. */
float mediumNoise( vec3 p ) {
  vec3 q = p * 0.09 + vec3( uTime * 0.05, uTime * 0.013, -uTime * 0.032 );
  float n = sin( q.x ) * sin( q.y * 1.31 + 1.7 ) * sin( q.z * 0.87 + 3.1 );
  n += 0.5 * sin( q.x * 2.13 + 2.2 ) * sin( q.z * 1.97 );
  return 1.0 + 0.34 * n;
}

void main() {
  float d = min( texture( uDepth, vUv ).r, 0.999999 );
  vec4 wp = uInvViewProj * vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  wp /= wp.w;

  vec3 ray = wp.xyz - uCameraPos;
  float sceneDist = length( ray );
  vec3 dir = ray / max( sceneDist, 1e-4 );
  float march = min( sceneDist, uMaxDistance );
  float stepLen = march / float( STEPS );

  float dither = texture( uNoise, gl_FragCoord.xy * uNoiseScale ).b;
  dither = fract( dither + uFrame * 0.6180339887 );

  float phase = henyeyGreenstein( dot( dir, uSunDir ), uAnisotropy );
  vec3 inscatter = vec3( 0.0 );
  float transmittance = 1.0;

  for ( int i = 0; i < STEPS; i++ ) {
    float t = ( float( i ) + dither ) * stepLen;
    vec3 p = uCameraPos + dir * t;
    float dens = uDensity * exp( -max( 0.0, p.y - uHeightRef ) * uHeightFalloff ) * mediumNoise( p );
    if ( dens < 1e-6 ) continue;
    float shadow = cascadeShadow( p );
    vec3 s = ( uSunColor * phase * shadow + uAmbient ) * dens;
    inscatter += transmittance * s * stepLen;
    transmittance *= exp( -dens * stepLen * 1.6 );
  }

  inscatter *= uStrength;

  // Store *view* depth so the composite's bilateral upsample can compare it
  // against the same quantity it derives from the full-resolution buffer.
  float linDepth = clamp( -viewZFromDepth( d, uNear, uFar ) / uFar, 0.0, 1.0 );
  vec4 prev = uPrevViewProj * vec4( wp.xyz, 1.0 );
  vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
  vec4 h = texture( uHistory, prevUv );

  float alpha = 0.14;
  if ( any( lessThan( prevUv, vec2( 0.0 ) ) ) || any( greaterThan( prevUv, vec2( 1.0 ) ) ) ) alpha = 1.0;
  if ( abs( h.a - prev.w / uFar ) > 0.012 ) alpha = 1.0;
  alpha = max( alpha, uReset );

  fragColor = vec4( mix( max( h.rgb, vec3( 0.0 ) ), inscatter, alpha ), linDepth );
}
`;
}

const _dir = new THREE.Vector3();
const _usable = [];

export class VolumetricPass {
  constructor() {
    this.pass = null;
    this.cascades = 0;
    this.steps = 32;
    this.rt = [null, null];
    this.write = 0;
    this.needsReset = true;
    this.size = new THREE.Vector2(1, 1);
    this.density = 0.0055;
    this.strength = 0.055;
    this.anisotropy = 0.68;
    this.maxDistance = 90;
    this.heightFalloff = 0.055;
    this.reversedDepth = false;
  }

  setSize(w, h) {
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.size.set(hw, hh);
    for (let i = 0; i < 2; i++) {
      this.rt[i]?.dispose();
      this.rt[i] = makeRT(hw, hh, { name: `vol${i}` });
    }
    this.needsReset = true;
  }

  /** Built lazily: the cascade count is only known once lighting has published. */
  _ensure(cascades) {
    if (this.pass && this.cascades === cascades) return;
    this.pass?.dispose();
    this.cascades = cascades;
    const uniforms = {
      uDepth: { value: null },
      uNoise: { value: null },
      uHistory: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCameraPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uAmbient: { value: new THREE.Vector3() },
      uNoiseScale: { value: new THREE.Vector2(1 / 32, 1 / 32) },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uDensity: { value: this.density },
      uHeightFalloff: { value: this.heightFalloff },
      uHeightRef: { value: 0 },
      uAnisotropy: { value: this.anisotropy },
      uMaxDistance: { value: this.maxDistance },
      uStrength: { value: this.strength },
      uShadowBias: { value: 0.0012 },
      uFrame: { value: 0 },
      uTime: { value: 0 },
      uReset: { value: 1 },
    };
    for (let i = 0; i < cascades; i++) {
      uniforms[`uCsm${i}`] = { value: null };
      uniforms[`uCsmMat${i}`] = { value: new THREE.Matrix4() };
    }
    const defines = { STEPS: this.steps };
    if (this.reversedDepth) defines.REVERSED_DEPTH = '';
    this.pass = new ShaderPass('postfx/volumetrics', buildFragment(cascades, this.steps), uniforms, defines);
    this.needsReset = true;
  }

  /**
   * @returns {THREE.Texture|null} half-res inscatter, or null when the lighting
   * system has not produced usable shadow maps yet.
   */
  render(renderer, ctx, depthTex, noise, invViewProj, prevViewProj, frame) {
    const lights = ctx.lighting?.cascades;
    if (!Array.isArray(lights) || !lights.length) return null;
    const usable = _usable;
    usable.length = 0;
    for (let i = 0; i < lights.length && usable.length < 4; i++) {
      const map = lights[i]?.shadow?.map;
      if (map?.depthTexture || map?.texture) usable.push(lights[i]);
    }
    if (!usable.length) return null;

    this._ensure(usable.length);
    const u = this.pass.uniforms;

    for (let i = 0; i < this.cascades; i++) {
      const l = usable[i];
      u[`uCsm${i}`].value = l.shadow.map.depthTexture || l.shadow.map.texture;
      u[`uCsmMat${i}`].value.copy(l.shadow.matrix);
    }

    const cam = ctx.camera;
    u.uDepth.value = depthTex;
    u.uNoise.value = noise;
    u.uInvViewProj.value.copy(invViewProj);
    u.uPrevViewProj.value.copy(prevViewProj);
    u.uCameraPos.value.copy(cam.position);
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uNoiseScale.value.set(1 / 32, 1 / 32);
    u.uFrame.value = frame % 64;
    u.uTime.value = ctx.time || 0;
    u.uDensity.value = this.density;
    u.uStrength.value = this.strength;
    u.uAnisotropy.value = this.anisotropy;
    u.uMaxDistance.value = this.maxDistance;
    u.uHeightFalloff.value = this.heightFalloff;

    const key = usable[0];
    _dir.copy(ctx.lighting?.sunDirection || ctx.sky?.sunDirection || _dir.set(0, 1, 0)).normalize();
    u.uSunDir.value.copy(_dir);
    const inten = key.intensity ?? 1;
    u.uSunColor.value.set(key.color.r * inten, key.color.g * inten, key.color.b * inten);
    const sky = ctx.sky?.skyColor;
    if (sky) u.uAmbient.value.set(sky.r * 0.16, sky.g * 0.16, sky.b * 0.16);

    u.uHistory.value = this.rt[1 - this.write].texture;
    u.uReset.value = this.needsReset ? 1 : 0;

    const dst = this.rt[this.write];
    this.pass.render(renderer, dst);
    this.needsReset = false;
    this.write = 1 - this.write;
    return dst.texture;
  }

  dispose() {
    this.pass?.dispose();
    for (const rt of this.rt) rt?.dispose();
  }
}
