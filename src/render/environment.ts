/**
 * SECTOR ENVIRONMENT — lighting, hazard fluids, instanced props, landmarks, spires
 * ================================================================================
 *
 * Everything here is bounded and pooled:
 *   - one directional stellar light with an adaptive shadow frustum aligned to
 *     the orbital/sky sun vector
 *   - a hemisphere fill for the polluted ambient
 *   - hazard fluids (toxic mud, magma, industrial runoff) drawn with an
 *     animated shader rather than a fluid simulation
 *   - biome-specific instanced scatter (boulders, structural blocks, shards,
 *     columns) — one draw call per scatter class, count driven by quality tier
 *   - monumental biome-specific geological/industrial landmarks (calcified
 *     Drakken strata arches, collapsed foundry gantries, fumarole chimneys,
 *     sheared monoliths)
 *   - acoustic spires as colossal horizon geometry along true planetary bearing
 */

import * as THREE from 'three';
import { clamp01, mixSeed } from '../core/math';
import { ACOUSTIC_SPIRES, type BiomeId } from '../state/world';
import type { SectorField } from '../sector/field';

interface BiomeScatterProfile {
  colors: [number, number, number, number];
  roughness: [number, number, number, number];
  metalness: [number, number, number, number];
  landmarkKind: 'FOSSIL_ARCH' | 'FOUNDRY_GANTRY' | 'VENT_CHIMNEY' | 'MONOLITH_CLUSTER';
  landmarkColor: number;
  accentColor: number;
}

const BIOME_SCATTER_PALETTE: Record<BiomeId, BiomeScatterProfile> = {
  VITRIFIED_BASIN: {
    colors: [0x242930, 0x323b44, 0x4f7282, 0x3c4c59],
    roughness: [0.28, 0.42, 0.22, 0.48],
    metalness: [0.35, 0.45, 0.62, 0.52],
    landmarkKind: 'FOSSIL_ARCH',
    landmarkColor: 0x34404d,
    accentColor: 0x5ea2b8,
  },
  SHATTERED_BASALT: {
    colors: [0x2e2b29, 0x3b3632, 0x57483d, 0x6a3c24],
    roughness: [0.88, 0.82, 0.74, 0.68],
    metalness: [0.12, 0.2, 0.22, 0.3],
    landmarkKind: 'MONOLITH_CLUSTER',
    landmarkColor: 0x3a3532,
    accentColor: 0x805538,
  },
  SALT_FLAT: {
    colors: [0x948d7e, 0x827b6d, 0xb5ae9e, 0x736b5e],
    roughness: [0.76, 0.82, 0.64, 0.78],
    metalness: [0.06, 0.08, 0.14, 0.1],
    landmarkKind: 'MONOLITH_CLUSTER',
    landmarkColor: 0x9e9585,
    accentColor: 0xc8c2b4,
  },
  TOXIC_VEIL: {
    colors: [0x3c4028, 0x313622, 0x687832, 0x4f5430],
    roughness: [0.84, 0.88, 0.58, 0.76],
    metalness: [0.1, 0.16, 0.28, 0.22],
    landmarkKind: 'VENT_CHIMNEY',
    landmarkColor: 0x4a502f,
    accentColor: 0x8ea446,
  },
  REMNANT_SOIL: {
    colors: [0x4c3d2f, 0x3d3227, 0x66523e, 0x735338],
    roughness: [0.9, 0.86, 0.78, 0.72],
    metalness: [0.08, 0.14, 0.18, 0.24],
    landmarkKind: 'MONOLITH_CLUSTER',
    landmarkColor: 0x594635,
    accentColor: 0x8a6d4b,
  },
  PETRIFIED_MEGAFLORA: {
    colors: [0x463a31, 0x382f28, 0x6b5341, 0x7d5e44],
    roughness: [0.85, 0.88, 0.72, 0.66],
    metalness: [0.1, 0.14, 0.22, 0.26],
    landmarkKind: 'FOSSIL_ARCH',
    landmarkColor: 0x5e493a,
    accentColor: 0x9c7a54,
  },
  GLASS_LATTICE: {
    colors: [0x2c3842, 0x384854, 0x6aa8bf, 0x496170],
    roughness: [0.22, 0.3, 0.18, 0.36],
    metalness: [0.48, 0.55, 0.68, 0.58],
    landmarkKind: 'MONOLITH_CLUSTER',
    landmarkColor: 0x465d6b,
    accentColor: 0x7bc2d8,
  },
  FOUNDRY_RUIN: {
    colors: [0x3d342f, 0x2e2926, 0x6e4f3a, 0x824628],
    roughness: [0.76, 0.64, 0.58, 0.52],
    metalness: [0.38, 0.62, 0.55, 0.68],
    landmarkKind: 'FOUNDRY_GANTRY',
    landmarkColor: 0x543d2e,
    accentColor: 0xb86b38,
  },
  FOSSIL_STRATA: {
    colors: [0x52463a, 0x42382e, 0x7a6955, 0x8c765c],
    roughness: [0.84, 0.86, 0.7, 0.68],
    metalness: [0.12, 0.16, 0.24, 0.22],
    landmarkKind: 'FOSSIL_ARCH',
    landmarkColor: 0x6e5d4b,
    accentColor: 0xa68f72,
  },
  CRUSTAL_VENT: {
    colors: [0x332420, 0x291d1a, 0x6e3622, 0x943d1e],
    roughness: [0.82, 0.86, 0.62, 0.58],
    metalness: [0.16, 0.22, 0.34, 0.38],
    landmarkKind: 'VENT_CHIMNEY',
    landmarkColor: 0x4d2b20,
    accentColor: 0xd9622b,
  },
};

const HAZARD_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const HAZARD_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
uniform float uFlow;
uniform float uToxicity;
varying vec2 vUv;
varying vec3 vWorld;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 p = vWorld.xz * 0.012;
  float t = uTime * uFlow;
  // Slow churn plus a directional drift.
  float n = fbm(p + vec2(t * 0.35, t * 0.18));
  float n2 = fbm(p * 2.1 - vec2(t * 0.22, t * 0.4));
  float veins = smoothstep(0.42, 0.78, n * 0.65 + n2 * 0.35);
  vec3 col = mix(uColorA, uColorB, veins);
  col += uColorB * 0.12 * veins;
  float alpha = uOpacity * (0.35 + veins * 0.65);
  gl_FragColor = vec4(col, alpha);
}
`;

export class SectorEnvironment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fill: THREE.DirectionalLight;

  private field: SectorField;
  private sunDir = new THREE.Vector3(600, 900, 400).normalize();
  private hazardMaterial: THREE.ShaderMaterial;
  private hazardMeshes: THREE.Mesh[] = [];
  private scatter: THREE.InstancedMesh[] = [];
  private scatterCount = 0;
  private landmarks: THREE.Group[] = [];
  private spires: THREE.Group[] = [];
  private dustParticles: THREE.Points | null = null;
  private disposed = false;

  constructor(field: SectorField, quality: { shadows: boolean; shadowMapSize: number; particleScale: number }) {
    this.field = field;

    // Stellar directional light — the sun is the only real light source.
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sun.position.set(600, 900, 400);
    this.sun.castShadow = quality.shadows;
    this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const s = 260;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 2600;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.6;
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    // Polluted ambient: warm from suspended particulate, cool from shadowed ground.
    this.hemi = new THREE.HemisphereLight(0x6a6250, 0x1a1714, 0.85);
    this.group.add(this.hemi);

    // Bounce fill so shadowed industrial geometry is readable, not black.
    this.fill = new THREE.DirectionalLight(0x8fa0b0, 0.35);
    this.fill.position.set(-400, 300, -600);
    this.group.add(this.fill);

    this.hazardMaterial = new THREE.ShaderMaterial({
      vertexShader: HAZARD_VERT,
      fragmentShader: HAZARD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color(0x2a1a10) },
        uColorB: { value: new THREE.Color(0xd06a20) },
        uOpacity: { value: 0.9 },
        uFlow: { value: 0.5 },
        uToxicity: { value: 0.3 },
      },
    });

    this.buildScatter(quality.particleScale);
    this.buildBiomeLandmarks();
    this.buildDust(quality.particleScale);
  }

  // -- hazard fluids --------------------------------------------------------

  /** Add a hazard fluid pool at a world position. */
  addHazardFluid(
    x: number,
    z: number,
    radius: number,
    kind: 'MAGMA' | 'TOXIC_MUD' | 'RUNOFF',
  ): void {
    const geo = new THREE.CircleGeometry(radius, 28);
    geo.rotateX(-Math.PI / 2);
    const y = this.field.elevation(x, z) - 0.6;
    const mesh = new THREE.Mesh(geo, this.hazardMaterial);
    mesh.position.set(x, y, z);
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.hazardMeshes.push(mesh);
    // Colour is driven per-pool via a small set of shared materials.
    const mat = this.hazardMaterial;
    switch (kind) {
      case 'MAGMA':
        (mat.uniforms.uColorA.value as THREE.Color).setHex(0x3a0e04);
        (mat.uniforms.uColorB.value as THREE.Color).setHex(0xe0641c);
        mat.uniforms.uFlow.value = 0.28;
        break;
      case 'TOXIC_MUD':
        (mat.uniforms.uColorA.value as THREE.Color).setHex(0x1a2010);
        (mat.uniforms.uColorB.value as THREE.Color).setHex(0x6a7a2a);
        mat.uniforms.uFlow.value = 0.16;
        break;
      default:
        (mat.uniforms.uColorA.value as THREE.Color).setHex(0x101418);
        (mat.uniforms.uColorB.value as THREE.Color).setHex(0x3a4a52);
        mat.uniforms.uFlow.value = 0.42;
    }
  }

  // -- instanced scatter ----------------------------------------------------

  private buildScatter(particleScale: number): void {
    const profile = BIOME_SCATTER_PALETTE[this.field.params.biome] ?? BIOME_SCATTER_PALETTE.VITRIFIED_BASIN;
    const classes: {
      geo: THREE.BufferGeometry;
      count: number;
      color: number;
      roughness: number;
      metalness: number;
      scale: [number, number];
    }[] = [
      {
        geo: new THREE.IcosahedronGeometry(1, 0),
        count: 420,
        color: profile.colors[0],
        roughness: profile.roughness[0],
        metalness: profile.metalness[0],
        scale: [1.5, 7],
      },
      {
        geo: new THREE.BoxGeometry(1, 1, 1),
        count: 260,
        color: profile.colors[1],
        roughness: profile.roughness[1],
        metalness: profile.metalness[1],
        scale: [2, 9],
      },
      {
        geo: new THREE.ConeGeometry(1, 2.4, 5),
        count: 180,
        color: profile.colors[2],
        roughness: profile.roughness[2],
        metalness: profile.metalness[2],
        scale: [2, 8],
      },
      {
        geo: new THREE.CylinderGeometry(0.35, 0.5, 6, 6),
        count: 150,
        color: profile.colors[3],
        roughness: profile.roughness[3],
        metalness: profile.metalness[3],
        scale: [3, 12],
      },
    ];
    const seed = mixSeed(this.field.params.seed, this.field.params.lat * 1000 + this.field.params.lon);
    let s = seed >>> 0;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    let total = 0;
    for (const cls of classes) {
      const count = Math.max(8, Math.round(cls.count * clamp01(particleScale)));
      const mat = new THREE.MeshStandardMaterial({
        color: cls.color,
        roughness: cls.roughness,
        metalness: cls.metalness,
        flatShading: true,
      });
      const inst = new THREE.InstancedMesh(cls.geo, mat, count);
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.name = 'scatter';
      const matArr = inst.instanceMatrix.array as Float32Array;
      for (let i = 0; i < count; i++) {
        // Bias toward the playable centre; thin out toward the horizon.
        const r = Math.sqrt(rnd()) * 900;
        const a = rnd() * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const x = ca * r;
        const z = sa * r;
        const y = this.field.elevation(x, z);
        const yaw = rnd() * 6.2831853;
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const _rx = rnd();
        const _rz = rnd();
        void _rx;
        void _rz;
        const sc = cls.scale[0] + rnd() * (cls.scale[1] - cls.scale[0]);
        const sx = sc;
        const sY = sc * (0.6 + rnd() * 0.9);
        const sz = sc * (0.6 + rnd() * 0.9);
        const o = i * 16;
        matArr[o] = cy * sx;
        matArr[o + 1] = 0;
        matArr[o + 2] = sy * sx;
        matArr[o + 3] = 0;
        matArr[o + 4] = 0;
        matArr[o + 5] = sY;
        matArr[o + 6] = 0;
        matArr[o + 7] = 0;
        matArr[o + 8] = -sy * sz;
        matArr[o + 9] = 0;
        matArr[o + 10] = cy * sz;
        matArr[o + 11] = 0;
        matArr[o + 12] = x;
        matArr[o + 13] = y + cls.scale[0] * 0.35;
        matArr[o + 14] = z;
        matArr[o + 15] = 1;
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      this.scatter.push(inst);
      this.group.add(inst);
      total += count;
    }
    this.scatterCount = total;
  }

  /**
   * Build monumental biome-specific geological or industrial remnant landmarks
   * around the sector perimeter (Drakken remnants appear strictly as
   * non-humanoid calcified/vitrified geological dorsal arches).
   */
  private buildBiomeLandmarks(): void {
    const profile = BIOME_SCATTER_PALETTE[this.field.params.biome] ?? BIOME_SCATTER_PALETTE.VITRIFIED_BASIN;
    const mat = new THREE.MeshStandardMaterial({
      color: profile.landmarkColor,
      roughness: profile.roughness[1],
      metalness: profile.metalness[1],
      flatShading: true,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: profile.accentColor,
      roughness: profile.roughness[2],
      metalness: profile.metalness[2],
      flatShading: true,
    });

    const seed = mixSeed(this.field.params.seed ^ 0x5f3759df, this.field.params.lat * 701 + this.field.params.lon);
    let s = seed >>> 0;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };

    const landmarkCount = 6;
    const ribGeo = profile.landmarkKind === 'FOSSIL_ARCH' ? new THREE.BoxGeometry(2.2, 16, 3.4) : null;
    const legGeo = profile.landmarkKind === 'FOUNDRY_GANTRY' ? new THREE.BoxGeometry(1.8, 22, 1.8) : null;
    const beamGeo = profile.landmarkKind === 'FOUNDRY_GANTRY' ? new THREE.BoxGeometry(18, 2.2, 2.4) : null;
    const coneGeo = profile.landmarkKind === 'VENT_CHIMNEY' ? new THREE.CylinderGeometry(2.4, 5.8, 15, 7) : null;
    const throatGeo = profile.landmarkKind === 'VENT_CHIMNEY' ? new THREE.TorusGeometry(2.3, 0.45, 6, 14) : null;
    const colAGeo = profile.landmarkKind === 'MONOLITH_CLUSTER' ? new THREE.CylinderGeometry(1.6, 2.1, 18, 6) : null;
    const colBGeo = profile.landmarkKind === 'MONOLITH_CLUSTER' ? new THREE.CylinderGeometry(1.2, 1.6, 12, 6) : null;
    const colCGeo = profile.landmarkKind === 'MONOLITH_CLUSTER' ? new THREE.CylinderGeometry(1.1, 1.4, 9, 6) : null;

    for (let i = 0; i < landmarkCount; i++) {
      const angle = (i / landmarkCount) * Math.PI * 2 + (rnd() - 0.5) * 0.45;
      const dist = 140 + rnd() * 240;
      const lx = Math.cos(angle) * dist;
      const lz = Math.sin(angle) * dist;
      const ground = this.field.elevation(lx, lz);

      const node = new THREE.Group();
      node.name = `landmark-${profile.landmarkKind.toLowerCase()}-${i}`;
      node.position.set(lx, ground, lz);
      node.rotation.y = angle + (rnd() - 0.5) * 0.8;

      if (profile.landmarkKind === 'FOSSIL_ARCH' && ribGeo) {
        for (let r = -2; r <= 2; r++) {
          const rib = new THREE.Mesh(ribGeo, r === 0 ? accentMat : mat);
          rib.position.set(r * 4.5, 6.5 - Math.abs(r) * 1.1, 0);
          rib.rotation.z = r * 0.22;
          rib.rotation.x = 0.28;
          node.add(rib);
        }
      } else if (profile.landmarkKind === 'FOUNDRY_GANTRY' && legGeo && beamGeo) {
        const legL = new THREE.Mesh(legGeo, mat);
        legL.position.set(-7, 10, 0);
        legL.rotation.z = -0.08;
        const legR = new THREE.Mesh(legGeo, mat);
        legR.position.set(7, 10, 0);
        legR.rotation.z = 0.08;
        const beam = new THREE.Mesh(beamGeo, accentMat);
        beam.position.set(0, 20.2, 0);
        node.add(legL, legR, beam);
      } else if (profile.landmarkKind === 'VENT_CHIMNEY' && coneGeo && throatGeo) {
        const cone = new THREE.Mesh(coneGeo, mat);
        cone.position.y = 7.2;
        const throat = new THREE.Mesh(throatGeo, accentMat);
        throat.rotation.x = Math.PI / 2;
        throat.position.y = 14.8;
        node.add(cone, throat);
      } else if (colAGeo && colBGeo && colCGeo) {
        const colA = new THREE.Mesh(colAGeo, mat);
        colA.position.set(0, 8.5, 0);
        const colB = new THREE.Mesh(colBGeo, accentMat);
        colB.position.set(3.4, 5.5, 1.8);
        colB.rotation.z = -0.14;
        const colC = new THREE.Mesh(colCGeo, mat);
        colC.position.set(-3.1, 4.2, -1.5);
        colC.rotation.z = 0.18;
        node.add(colA, colB, colC);
      }

      this.landmarks.push(node);
      this.group.add(node);
    }
  }

  private buildDust(particleScale: number): void {
    const count = Math.max(200, Math.round(1400 * clamp01(particleScale)));
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    let s = 0xabcdef01;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rnd() - 0.5) * 1400;
      positions[i * 3 + 1] = rnd() * 180 + 4;
      positions[i * 3 + 2] = (rnd() - 0.5) * 1400;
      sizes[i] = 0.6 + rnd() * 2.4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0.35 } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        uniform float uTime;
        varying float vFade;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.3 + p.z * 0.01) * 6.0;
          p.y += sin(uTime * 0.21 + p.x * 0.013) * 3.0;
          vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vFade = smoothstep(900.0, 120.0, d);
          gl_PointSize = aSize * (320.0 / max(1.0, d));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform float uOpacity;
        varying float vFade;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.1, length(c));
          gl_FragColor = vec4(0.55, 0.5, 0.44, a * vFade * uOpacity);
        }
      `,
    });
    this.dustParticles = new THREE.Points(geo, mat);
    this.dustParticles.frustumCulled = false;
    this.dustParticles.name = 'dust';
    this.group.add(this.dustParticles);
  }

  // -- acoustic spires ------------------------------------------------------

  /**
   * Build the colossal acoustic spires for this sector. These are conventional
   * engineering structures: tuned mass dampers, waveguides, phased arrays. The
   * azure trim is sealed instrumentation, not a power source.
   */
  buildSpires(spireIds: number[], functional: boolean[]): void {
    this.clearSpires();
    const concrete = new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.95, metalness: 0.05 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x3c4045, roughness: 0.7, metalness: 0.55 });
    const azure = new THREE.MeshBasicMaterial({ color: 0x2f9fd0, toneMapped: false });

    for (let idx = 0; idx < spireIds.length; idx++) {
      const id = spireIds[idx];
      const def = ACOUSTIC_SPIRES[id];
      if (!def) continue;
      const g = new THREE.Group();
      const height = def.height;
      // Tapered shaft.
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(height * 0.012, height * 0.055, height, 12, 4), concrete);
      shaft.position.y = height * 0.5;
      g.add(shaft);
      // Three vertical waveguide ribs.
      const finGeo = new THREE.BoxGeometry(height * 0.012, height * 0.68, height * 0.075);
      for (let f = 0; f < 3; f++) {
        const ang = (f * Math.PI * 2) / 3;
        const fin = new THREE.Mesh(finGeo, steel);
        fin.position.set(Math.cos(ang) * height * 0.048, height * 0.38, Math.sin(ang) * height * 0.048);
        fin.rotation.y = -ang + Math.PI / 2;
        g.add(fin);
      }
      // External bracing rings.
      for (let i = 1; i <= 6; i++) {
        const t = i / 7;
        const r = height * (0.055 - t * 0.043) * 1.5;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, height * 0.006, 6, 16), steel);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = height * t;
        g.add(ring);
      }
      // Waveguide array at the crown.
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(height * 0.09, height * 0.05, height * 0.06, 16), steel);
      crown.position.y = height * 0.97;
      g.add(crown);
      // Phased emitter ring.
      const emitters = new THREE.Mesh(new THREE.TorusGeometry(height * 0.085, height * 0.008, 6, 24), azure);
      emitters.rotation.x = Math.PI / 2;
      emitters.position.y = height * 1.0;
      g.add(emitters);
      // Foundation plinth.
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(height * 0.12, height * 0.16, height * 0.05, 10), concrete);
      plinth.position.y = height * 0.02;
      g.add(plinth);

      const isFunctional = functional[id] ?? false;
      if (!isFunctional) {
        // Damaged spires are visibly truncated and dark.
        shaft.scale.y = 0.55;
        shaft.position.y = height * 0.275;
        emitters.visible = false;
      }
      const rawX = (def.lon - this.field.params.lon) * 900 * Math.cos((def.lat * Math.PI) / 180);
      const rawZ = -(def.lat - this.field.params.lat) * 900;
      const rawDist = Math.hypot(rawX, rawZ);
      // Clamp distant spires onto a visible sector horizon ring (460..860 m) along their true planetary bearing.
      const bearing = rawDist > 1e-3 ? Math.atan2(rawZ, rawX) : (idx * Math.PI * 2) / Math.max(1, spireIds.length);
      const dist = rawDist >= 180 && rawDist <= 920 ? rawDist : 460 + (id % 4) * 115;
      const x = Math.cos(bearing) * dist;
      const z = Math.sin(bearing) * dist;
      g.position.set(x, this.field.elevation(x, z) - 2, z);
      g.userData.spireId = id;
      g.userData.functional = isFunctional;
      this.spires.push(g);
      this.group.add(g);
    }
  }

  private clearSpires(): void {
    for (const g of this.spires) {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      });
      this.group.remove(g);
    }
    this.spires.length = 0;
  }

  private clearLandmarks(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const g of this.landmarks) {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) geometries.add(m.geometry);
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => materials.add(x));
        else if (mat) materials.add(mat as THREE.Material);
      });
      this.group.remove(g);
    }
    for (const geo of geometries) geo.dispose();
    for (const mat of materials) mat.dispose();
    this.landmarks.length = 0;
  }

  // -- per-frame ------------------------------------------------------------

  update(dt: number, elapsed: number, camera: THREE.Camera): void {
    if (this.disposed) return;
    this.hazardMaterial.uniforms.uTime.value = elapsed;
    if (this.dustParticles) {
      (this.dustParticles.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
      this.dustParticles.position.set(camera.position.x, 0, camera.position.z);
    }
    // Keep the shadow frustum tight around the camera while preserving the sun direction from setSunDirection().
    this.sun.position.set(
      camera.position.x + this.sunDir.x * 840,
      camera.position.y + Math.max(0.22, this.sunDir.y) * 840,
      camera.position.z + this.sunDir.z * 840,
    );
    this.sun.target.position.set(camera.position.x, camera.position.y - 40, camera.position.z);
    this.sun.target.updateMatrixWorld();
    void dt;
  }

  setQuality(q: { shadows: boolean; shadowMapSize: number }): void {
    this.sun.castShadow = q.shadows;
    if (this.sun.shadow.mapSize.width !== q.shadowMapSize) {
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  setSunDirection(dir: THREE.Vector3): void {
    if (dir.lengthSq() > 1e-6) {
      this.sunDir.copy(dir).normalize();
    }
    this.sun.position.copy(this.sunDir).multiplyScalar(1200);
  }

  setToxicity(t: number): void {
    this.hemi.intensity = 0.85 - t * 0.25;
    (this.hazardMaterial.uniforms.uToxicity.value as number) = t;
  }

  get drawCalls(): number {
    return (
      this.scatter.length +
      this.landmarks.length +
      this.hazardMeshes.length +
      this.spires.length +
      (this.dustParticles ? 1 : 0)
    );
  }

  get instancedCount(): number {
    return this.scatterCount;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of this.hazardMeshes) m.geometry.dispose();
    this.hazardMaterial.dispose();
    for (const inst of this.scatter) {
      inst.geometry.dispose();
      (inst.material as THREE.Material).dispose();
      inst.dispose();
    }
    this.dustParticles?.geometry.dispose();
    (this.dustParticles?.material as THREE.Material)?.dispose();
    this.clearLandmarks();
    this.clearSpires();
    this.group.clear();
  }
}

/** Which biome gets which hazard fluid. */
export function hazardForBiome(biome: BiomeId): 'MAGMA' | 'TOXIC_MUD' | 'RUNOFF' | null {
  switch (biome) {
    case 'CRUSTAL_VENT':
      return 'MAGMA';
    case 'TOXIC_VEIL':
      return 'TOXIC_MUD';
    case 'FOUNDRY_RUIN':
      return 'RUNOFF';
    default:
      return null;
  }
}

/** Local atmospheric density estimate used by the sky dome. */
export function localAtmosphereDensity(biome: BiomeId, toxicity: number): number {
  const base: Record<BiomeId, number> = {
    VITRIFIED_BASIN: 0.55,
    SHATTERED_BASALT: 0.7,
    SALT_FLAT: 0.8,
    TOXIC_VEIL: 0.95,
    REMNANT_SOIL: 0.75,
    PETRIFIED_MEGAFLORA: 0.7,
    GLASS_LATTICE: 0.6,
    FOUNDRY_RUIN: 0.9,
    FOSSIL_STRATA: 0.75,
    CRUSTAL_VENT: 0.85,
  };
  return clamp01(base[biome] * (0.8 + toxicity * 0.4));
}
