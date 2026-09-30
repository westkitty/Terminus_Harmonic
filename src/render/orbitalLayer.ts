/**
 * ORBITAL LAYER — the planet seen from the debris belt
 * ====================================================
 *
 * The orbital layer is a separate scene with its own coordinate system (metres,
 * planet radius 6.371e6). Keeping it out of the planetary scene's 100-unit space
 * and out of the sector's 2 km space is the whole point of the multi-scale
 * architecture: no single coordinate system has to span nineteen orders of
 * magnitude.
 */

import * as THREE from 'three';
import { fbm3, mixSeed } from '../core/math';

const PLANET_R = 6_371_000;

const PLANET_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec2 vUv;
void main() {
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const PLANET_FRAG = /* glsl */ `
precision highp float;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec2 vUv;
uniform vec3 uSunDirection;
uniform float uToxicity;
uniform float uCloud;
uniform float uTime;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; }
  return v;
}

void main() {
  vec3 n = normalize(vNormalW);
  vec3 sun = normalize(uSunDirection);
  float ndl = dot(n, sun);

  // Continent / basin mask.
  float land = fbm(vUv * vec2(9.0, 5.0));
  float vit = smoothstep(0.58, 0.86, fbm(vUv * vec2(15.0, 8.0) + 3.1));
  float scar = smoothstep(0.62, 0.95, fbm(vUv * vec2(26.0, 13.0) + 7.7));

  // Scorched, oxidised, industrial. Never a colourful fantasy world.
  vec3 rock = mix(vec3(0.085, 0.078, 0.072), vec3(0.16, 0.135, 0.115), land);
  vec3 basin = vec3(0.045, 0.05, 0.058);
  vec3 albedo = mix(basin, rock, smoothstep(0.42, 0.52, land));
  albedo = mix(albedo, vec3(0.06, 0.058, 0.066), vit * 0.7);
  albedo += scar * vec3(0.05, 0.028, 0.012);

  // Cloud deck: broken, toxic, slow.
  float c = fbm(vUv * vec2(7.0, 4.0) + vec2(uTime * 0.004, 0.0));
  float clouds = smoothstep(0.52, 0.78, c) * uCloud;
  vec3 cloudCol = mix(vec3(0.62, 0.58, 0.5), vec3(0.42, 0.4, 0.3), uToxicity);

  vec3 lit = albedo * (0.06 + max(ndl, 0.0) * 1.35);
  // Terminator softening.
  lit *= smoothstep(-0.12, 0.22, ndl);
  lit = mix(lit, cloudCol * (0.08 + max(ndl, 0.0) * 1.1), clouds * 0.85);

  // Rim light on the limb so the curvature reads.
  vec3 viewDir = normalize(cameraPosition - vPosW);
  float rim = 1.0 - max(dot(viewDir, n), 0.0);
  lit += vec3(0.36, 0.46, 0.62) * pow(rim, 4.0) * (0.25 + uToxicity * 0.3) * 0.7;

  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class OrbitalLayer {
  readonly group = new THREE.Group();
  private planetMaterial: THREE.ShaderMaterial;
  private planetGeometry: THREE.SphereGeometry;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private disposed = false;

  constructor(seed: number) {
    this.planetGeometry = new THREE.SphereGeometry(PLANET_R, 96, 64);
    this.planetMaterial = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(1, 0.3, 0.2).normalize() },
        uToxicity: { value: 0.6 },
        uCloud: { value: 0.55 },
        uTime: { value: 0 },
      },
    });
    void seed;
    void mixSeed;
    void fbm3;
    const planet = new THREE.Mesh(this.planetGeometry, this.planetMaterial);
    planet.name = 'planet-from-orbit';
    planet.position.set(0, -PLANET_R - 420_000, 0);
    this.group.add(planet);

    // Orbital shell hint: a faint ring of wreckage-density, not a Blood Ring.
    // (Blood Rings are atrocity artifacts around *destroyed* worlds. This is a
    // navigation-density visualisation for the surviving remnant world.)
    const beltGeo = new THREE.RingGeometry(PLANET_R * 1.06, PLANET_R * 1.14, 128, 1);
    const beltMat = new THREE.MeshBasicMaterial({
      color: 0x6a6258,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const belt = new THREE.Mesh(beltGeo, beltMat);
    belt.rotation.x = Math.PI / 2 + 0.22;
    belt.position.set(0, -PLANET_R - 420_000, 0);
    belt.name = 'wreckage-density-belt';
    this.group.add(belt);

    // Stellar directional light + planetshine fill so standard materials on the
    // Orbital Skiff and derelict hulls read cleanly in low orbit.
    this.sun = new THREE.DirectionalLight(0xffddb0, 2.2);
    this.sun.position.set(3200, 1400, 1200);
    this.group.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x52657a, 0x261d16, 0.72);
    this.group.add(this.hemi);
  }

  setSunDirection(dir: THREE.Vector3): void {
    (this.planetMaterial.uniforms.uSunDirection.value as THREE.Vector3).copy(dir).normalize();
    this.sun.position.copy(dir).normalize().multiplyScalar(3600);
  }

  setToxicity(t: number): void {
    this.planetMaterial.uniforms.uToxicity.value = t;
  }

  update(elapsed: number): void {
    this.planetMaterial.uniforms.uTime.value = elapsed;
  }

  get planetRadius(): number {
    return PLANET_R;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.planetGeometry.dispose();
    this.planetMaterial.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && m !== this.group.children[0]) m.geometry.dispose();
    });
    this.group.clear();
  }
}

export { PLANET_R };
