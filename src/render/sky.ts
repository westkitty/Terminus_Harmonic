/**
 * SKY — approximate Rayleigh/Mie atmospheric scattering
 * =====================================================
 *
 * A single inward-facing sphere with an analytic scattering shader. This is the
 * efficient approximation: no ray marching, no render targets, one draw call.
 * It is used both for the orbital sky (thin atmosphere, strong stars) and the
 * surface sky (thick, polluted, dust-laden).
 *
 * The polluted remnant world is modelled with elevated Mie extinction,
 * warm-scatter particulate striation near the horizon, a distortion-free 3D
 * starfield, and the canonical Siege Wall starless-absence swath overhead.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPosition = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec3 vWorldPosition;
varying vec3 vNormal;

uniform vec3 uSunDirection;     // normalised, pointing from surface toward the sun
uniform float uRayleigh;        // Rayleigh scattering coefficient scale
uniform float uMie;             // Mie scattering coefficient scale
uniform float uMieG;            // Mie preferred scattering direction (anisotropy)
uniform vec3 uRayleighColor;    // wavelength-dependent tint
uniform vec3 uMieColor;         // particulate tint
uniform float uExposure;
uniform float uStarIntensity;
uniform float uTurbidity;       // particulate density (pollution)
uniform float uHorizonPower;

const float PI = 3.141592653589793;

// Rayleigh phase
float rayleighPhase(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

// Henyey-Greenstein phase
float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * pow(max(denom, 1e-4), 1.5));
}

// Distortion-free 3D cell hash for celestial coordinates.
float hash3(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 dir = normalize(vWorldPosition - cameraPosition);
  vec3 sun = normalize(uSunDirection);

  float cosTheta = dot(dir, sun);
  float elevation = clamp(dir.y, -1.0, 1.0);

  // Air mass grows toward the horizon; this is what produces the bright band.
  float zenith = max(elevation, 0.0);
  float airMass = 1.0 / (zenith + 0.12);

  float rPhase = rayleighPhase(cosTheta);
  float mPhase = hgPhase(cosTheta, uMieG);

  // Extinction toward the sun and away from it.
  float sunAmount = max(cosTheta, 0.0);
  vec3 extinction = exp(-(uRayleighColor * uRayleigh * 1.0 + uMieColor * uMie * uTurbidity) * airMass);

  vec3 scattering =
      uRayleighColor * uRayleigh * rPhase * (1.0 + sunAmount * 2.4) +
      uMieColor * uMie * mPhase * (0.6 + sunAmount * 5.0) * uTurbidity;

  vec3 color = scattering * extinction * airMass * 0.055;

  // Horizon compression and suspended industrial particulate striation.
  float horizon = pow(1.0 - clamp(elevation, 0.0, 1.0), uHorizonPower);
  float dustBand = 0.5 + 0.5 * sin(elevation * 34.0 + dir.x * 4.2 - dir.z * 3.1);
  color = mix(color, color * (1.75 + 0.25 * dustBand) + uMieColor * (0.04 + 0.025 * dustBand) * uTurbidity, horizon);

  // Ground-side falloff: below the horizon the sky is occluded by terrain, so
  // darken rather than sampling air.
  color *= smoothstep(-0.16, 0.02, elevation);

  // Sun disc + bloom-ish halo.
  float disc = smoothstep(0.9975, 0.9995, cosTheta);
  float halo = pow(sunAmount, 220.0) * 0.6 + pow(sunAmount, 12.0) * 0.05;
  color += vec3(1.0, 0.94, 0.82) * (disc * 14.0 + halo) * (1.0 - uTurbidity * 0.45);

  // Siege Wall: vast irregular swath of starless blackness (cosmological absence, zero glowing outline).
  float swathCoord = dir.x * 0.78 - dir.z * 0.62;
  float swathWarp = sin(dir.z * 5.3 + dir.y * 3.7) * 0.09 + cos(dir.x * 9.1 - dir.y * 4.2) * 0.05;
  float siegeAbsence = smoothstep(0.24, 0.06, abs(swathCoord + swathWarp - 0.22)) * smoothstep(0.05, 0.32, elevation);
  color *= (1.0 - siegeAbsence * 0.45 * clamp(uStarIntensity, 0.0, 1.0));

  // Stars: 3D direction-cell field where the atmosphere is thin, extinguished inside the Siege Wall absence.
  if (uStarIntensity > 0.001 && elevation > 0.01) {
    vec3 cellA = floor(dir * 320.0);
    float hA = hash3(cellA);
    float starA = step(0.9965, hA) * (0.6 + 0.4 * sin(hA * 90.0));

    vec3 cellB = floor(dir * 145.0 + 17.3);
    float hB = hash3(cellB);
    float starB = step(0.9985, hB) * 1.45;

    float tint = hash3(cellA + 7.1);
    vec3 starCol = mix(vec3(0.96, 0.87, 0.74), vec3(0.78, 0.89, 1.0), tint);
    float fade = smoothstep(0.02, 0.4, elevation) * (1.0 - uTurbidity * 0.85) * (1.0 - siegeAbsence);
    color += starCol * (starA + starB) * uStarIntensity * fade * 2.2;
  }

  color *= uExposure;
  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface SkyParams {
  sunDirection: THREE.Vector3;
  /** 0 = vacuum (stars), 1 = dense polluted atmosphere. */
  density: number;
  /** Industrial particulate density. */
  turbidity: number;
  /** Time-of-day / weather darkening. */
  exposure: number;
}

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.SphereGeometry;
  private disposed = false;

  constructor(radius = 60000) {
    this.geometry = new THREE.SphereGeometry(radius, 48, 32);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0.4, 0.5, 0.7).normalize() },
        uRayleigh: { value: 1.0 },
        uMie: { value: 1.0 },
        uMieG: { value: 0.76 },
        uRayleighColor: { value: new THREE.Color(0.22, 0.42, 0.85) },
        uMieColor: { value: new THREE.Color(0.72, 0.62, 0.48) },
        uExposure: { value: 1.0 },
        uStarIntensity: { value: 0.0 },
        uTurbidity: { value: 0.35 },
        uHorizonPower: { value: 3.0 },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'sky-dome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
  }

  setSun(dir: THREE.Vector3): void {
    (this.material.uniforms.uSunDirection.value as THREE.Vector3).copy(dir).normalize();
  }

  /** `density` 0..1 drives star visibility; `turbidity` drives pollution haze. */
  setEnvironment(density: number, turbidity: number, exposure: number): void {
    const u = this.material.uniforms;
    u.uStarIntensity.value = Math.max(0, 1 - density * 1.6) * 0.9;
    u.uTurbidity.value = 0.05 + turbidity * 0.95;
    u.uExposure.value = exposure;
    u.uRayleigh.value = 0.35 + density * 1.5;
    u.uMie.value = 0.25 + turbidity * 1.9;
    u.uHorizonPower.value = 2.0 + (1 - density) * 2.5;
    // Polluted air is warmer and duller.
    const c = u.uMieColor.value as THREE.Color;
    c.setRGB(0.72 - turbidity * 0.1, 0.62 - turbidity * 0.16, 0.48 - turbidity * 0.24);
  }

  /** Keeps the dome centred on the camera. Call before render. */
  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
    this.mesh.updateMatrix();
    this.mesh.matrixWorld.copy(this.mesh.matrix);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
  }
}
