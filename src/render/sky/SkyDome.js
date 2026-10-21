import * as THREE from 'three';
import { COMMON_GLSL } from './glsl/common.glsl.js';
import { CELESTIAL_GLSL } from './glsl/celestial.glsl.js';
import { MIE_G } from './constants.js';

const VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform sampler2D uSunLut;
uniform sampler2D uMoonLut;
uniform sampler2D uCloudMap;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunMieTint;
uniform vec3 uMoonMieTint;
uniform vec3 uSunScatter;
uniform vec3 uMoonScatter;
uniform vec3 uSunRadiance;
uniform vec3 uSunGlare;
uniform vec3 uMoonSurface;
uniform vec3 uEarthshine;
uniform vec3 uAirglow;
uniform vec3 uPollution;
uniform mat3 uStarRot;
uniform vec3 uGalacticPole;
uniform vec3 uGalacticCore;
uniform float uNight;
uniform float uStarBrightness;
uniform float uTime;
uniform float uMoonSize;
uniform float uCloudOpacity;

${COMMON_GLSL}
${CELESTIAL_GLSL}

void main(){
  vec3 dir = normalize(vDir);
  vec2 uv = dirToSkyUV(dir);

  vec4 s = texture2D(uSunLut, uv);
  vec4 m = texture2D(uMoonLut, uv);

  float cosSun = dot(dir, uSunDir);
  float cosMoon = dot(dir, uMoonDir);
  float mg = ${MIE_G.toFixed(3)};

  vec3 sky = (s.rgb + s.a * miePhase(cosSun, mg) * uSunMieTint) * uSunScatter;
  sky += (m.rgb + m.a * miePhase(cosMoon, mg) * uMoonMieTint) * uMoonScatter;

  // A clear-air single-scattering horizon saturates at ~4x the zenith and
  // clips to white in any shot framed low. Real horizons are cut short by
  // terrain and haze long before that, so roll the last few degrees off.
  sky *= mix(1.0, 0.58, pow(1.0 - saturate1(dir.y * 3.0), 2.5));

  // Below the horizon we are looking at land we do not model. Desaturating and
  // darkening the pure-Rayleigh short path stops it reading as a turquoise sea.
  float below = smoothstep(0.0, -0.05, dir.y);
  if (below > 0.0){
    float g = dot(sky, vec3(0.30, 0.52, 0.18));
    sky = mix(sky, mix(sky, vec3(g), 0.55) * 0.46, below);
  }

  float up = max(dir.y, 0.0);
  // Airglow brightens toward the limb (van Rhijn); sodium light pollution is
  // strictly a horizon phenomenon. Both are what keep a night sky off black.
  sky += uAirglow * (1.0 + 3.2 * pow(1.0 - up, 8.0));
  // Sodium light pollution. The extra exp() is what makes it read as a city
  // rather than as a global tint: a real sodium dome hugs the bottom 20 degrees
  // and is gone by 30, because the light is scattered out of a source that is
  // below you. Without it the glow reached halfway up the sky.
  sky += uPollution * pow(saturate1(1.0 - dir.y * 3.6), 5.0) * saturate1(1.0 + dir.y * 14.0)
       * exp(-max(dir.y, 0.0) * 4.5);

  if (uNight > 0.002){
    vec3 cdir = uStarRot * dir;
    float airmass = 1.0 / max(dir.y * 0.98 + 0.02, 0.02);
    float ext = exp(-0.19 * (airmass - 1.0));
    float scint = saturate1(1.0 - dir.y * 2.4);

    vec3 stars = starLayer(cdir, 96.0, 0.26, 5.0, 0.26, uTime, scint, 0.0);
    stars += starLayer(cdir, 22.0, 0.30, 2.0, 0.55, uTime, scint * 1.3, 21.0);
    stars += milkyWay(cdir, uGalacticPole, uGalacticCore);
    sky += stars * ext * uNight * uStarBrightness;
  }

  sky += sunGlare(dir, uSunDir, uSunGlare);
  sky += sunDisk(dir, uSunDir, uSunRadiance);
  sky += moonDisk(dir, uMoonDir, uSunDir, uMoonSurface, uEarthshine, uMoonSize);
  sky += uMoonSurface * 0.0022 * exp(-acos(clamp(dot(dir, uMoonDir), -1.0, 1.0)) * 26.0);

  vec4 cloud = texture2D(uCloudMap, dirToCloudUV(dir));
  float ca = saturate1(cloud.a) * uCloudOpacity;
  vec3 color = sky * (1.0 - ca) + cloud.rgb * uCloudOpacity;

  // Static ordered dither: the sky is the one place 8-bit banding always shows.
  color += (hash12(gl_FragCoord.xy) - 0.5) * 0.0016;

  gl_FragColor = vec4(max(color, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * The visible sky. A camera-locked box rather than a background cubemap so the
 * sun limb, the lunar terminator and the star field are all evaluated at native
 * resolution — a 256px cube background turns every one of those into mush.
 *
 * Two materials share one uniforms object: the world dome tone-maps, the copy
 * used for the environment capture must stay linear HDR.
 */
export class SkyDome {
  constructor() {
    this.uniforms = {
      uSunLut: { value: null },
      uMoonLut: { value: null },
      uCloudMap: { value: null },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunMieTint: { value: new THREE.Vector3(1, 1, 1) },
      uMoonMieTint: { value: new THREE.Vector3(0.7, 0.8, 1) },
      uSunScatter: { value: new THREE.Vector3(60, 60, 60) },
      uMoonScatter: { value: new THREE.Vector3(0, 0, 0) },
      uSunRadiance: { value: new THREE.Vector3(0, 0, 0) },
      uSunGlare: { value: new THREE.Vector3(0, 0, 0) },
      uMoonSurface: { value: new THREE.Vector3(0, 0, 0) },
      uEarthshine: { value: new THREE.Vector3(0, 0, 0) },
      uAirglow: { value: new THREE.Vector3(0, 0, 0) },
      uPollution: { value: new THREE.Vector3(0, 0, 0) },
      uStarRot: { value: new THREE.Matrix3() },
      uGalacticPole: { value: new THREE.Vector3(0.31, 0.83, -0.46).normalize() },
      uGalacticCore: { value: new THREE.Vector3(-0.72, -0.18, 0.67).normalize() },
      uNight: { value: 0 },
      uStarBrightness: { value: 1 },
      uTime: { value: 0 },
      uMoonSize: { value: 2.2 },
      uCloudOpacity: { value: 1 },
    };

    this.geometry = new THREE.BoxGeometry(2, 2, 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    });

    this.envMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.scale.setScalar(1800);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      this.mesh.position.copy(camera.position);
      this.mesh.updateMatrix();
      this.mesh.updateMatrixWorld(true);
    };

    this.envMesh = new THREE.Mesh(this.geometry, this.envMaterial);
    this.envMesh.name = 'SkyDomeEnv';
    this.envMesh.scale.setScalar(500);
    this.envMesh.frustumCulled = false;
    this.envMesh.updateMatrix();
    this.envMesh.updateMatrixWorld(true);

    this.envScene = new THREE.Scene();
    this.envScene.add(this.envMesh);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.envMaterial.dispose();
  }
}
