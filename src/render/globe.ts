/**
 * COMMAND LATTICE — the interactive planetary globe
 * =================================================
 *
 * One icosphere, displaced by a deterministic scar field so the planet is not a
 * smooth ball, plus a 1024x512 equirectangular data texture that is repainted
 * whenever the overlay mode or the authoritative planetary state changes.
 *
 * Overlays are not decoration: each one is a real spatial field derived from
 * (worldSeed, lat, lon, planetary state), so an intervention that raises
 * atmospheric stability visibly changes the atmosphere overlay everywhere.
 *
 * Every overlay also encodes severity as banding (stripe density) so the
 * information is never colour-only — see the accessibility brief.
 */

import * as THREE from 'three';
import { clamp01, fbm3, mixSeed, smoothstep, valueNoise3, DEG2RAD } from '../core/math';
import {
  ACOUSTIC_SPIRES,
  CRISIS_NODES,
  SETTLEMENTS,
  type BiomeId,
  type Domain,
} from '../state/world';
import type { PlanetarySnapshot } from '../state/planetary';

export type OverlayMode = 'TOPOGRAPHY' | 'ATMOSPHERE' | 'GEOLOGY' | 'BIOSPHERE' | 'ORBIT' | 'LOGISTICS' | 'HARMONIC';

export const OVERLAY_MODES: readonly OverlayMode[] = [
  'TOPOGRAPHY',
  'ATMOSPHERE',
  'GEOLOGY',
  'BIOSPHERE',
  'ORBIT',
  'LOGISTICS',
  'HARMONIC',
];

export const OVERLAY_LABEL: Record<OverlayMode, string> = {
  TOPOGRAPHY: 'Topography',
  ATMOSPHERE: 'Atmosphere',
  GEOLOGY: 'Geology',
  BIOSPHERE: 'Biosphere',
  ORBIT: 'Orbit',
  LOGISTICS: 'Logistics',
  HARMONIC: 'Harmonic Network',
};

export const OVERLAY_LEGEND: Record<OverlayMode, { label: string; low: string; high: string }[]> = {
  TOPOGRAPHY: [
    { label: 'Elevation', low: 'Basin / glass', high: 'Ridge / scarp' },
    { label: 'Scar density', low: 'Intact', high: 'Vitrified' },
  ],
  ATMOSPHERE: [
    { label: 'Surface pressure', low: 'Collapsed', high: 'Nominal' },
    { label: 'Toxicity', low: 'Breathable', high: 'Lethal' },
    { label: 'Storm shear', low: 'Calm', high: 'Severe' },
  ],
  GEOLOGY: [
    { label: 'Fault activity', low: 'Dormant', high: 'Slipping' },
    { label: 'Crust temperature', low: 'Cold', high: 'Incandescent' },
    { label: 'Geothermal pressure', low: 'Vented', high: 'Sealed' },
    { label: 'Stability', low: 'Failing', high: 'Stable' },
  ],
  BIOSPHERE: [
    { label: 'Soil viability', low: 'Sterile', high: 'Workable' },
    { label: 'Water', low: 'Dry', high: 'Saturated' },
    { label: 'Crop viability', low: 'None', high: 'Establishing' },
    { label: 'Habitat stability', low: 'Failing', high: 'Holding' },
  ],
  ORBIT: [
    { label: 'Debris density', low: 'Clear', high: 'Impassable' },
    { label: 'Occlusion', low: 'Open sky', high: 'Full shadow' },
    { label: 'Safe corridors', low: 'None', high: 'Established' },
  ],
  LOGISTICS: [
    { label: 'Route integrity', low: 'Severed', high: 'Open' },
    { label: 'Material throughput', low: 'Stalled', high: 'Flowing' },
    { label: 'Depot coverage', low: 'Isolated', high: 'Linked' },
  ],
  HARMONIC: [
    { label: 'Coverage', low: 'Silent', high: 'Saturated' },
    { label: 'Phase coherence', low: 'Chaotic', high: 'Phase-locked' },
    { label: 'Seismic resonance', low: 'Damped', high: 'Destructive' },
  ],
};

/** Deterministic spatial field helpers, keyed off the world seed. */
class PlanetFields {
  private sA: number;
  private sB: number;
  private sB31: number;
  private fieldSeeds = new Map<number, number>();
  constructor(seed: number) {
    this.sA = mixSeed(seed, 0x1a2b3c4d);
    this.sB = mixSeed(seed, 0x5e6f7a8b);
    this.sB31 = mixSeed(this.sB, 31);
  }
  /** Scalar field on the unit sphere. */
  field(x: number, y: number, z: number, which: number, freq = 2.2): number {
    let s = this.fieldSeeds.get(which);
    if (s === undefined) {
      s = mixSeed(this.sA, which * 7919);
      this.fieldSeeds.set(which, s);
    }
    return fbm3(x * freq, y * freq, z * freq, s, 3);
  }
  /** Ridged fault network. */
  faults(x: number, y: number, z: number): number {
    const a = Math.abs(valueNoise3(x * 3.1, y * 3.1 + 4.2, z * 3.1, this.sB) - 0.5);
    const b = Math.abs(valueNoise3(x * 2.3 + 9.1, y * 2.3, z * 2.3, this.sB31) - 0.5);
    return a < b ? a : b;
  }
  /** Broad continent/landmass mask. */
  continents(x: number, y: number, z: number): number {
    return fbm3(x * 1.1, y * 1.1, z * 1.1, this.sA, 3);
  }
}

const TEXTURE_W = 1024;
const TEXTURE_H = 512;

/**
 * Resolution of the seed-only noise grid. The overlay is 1024x512, but the
 * noise driving it is low-frequency (frequencies 1.4-3.8 on the unit sphere),
 * so it is evaluated at a quarter of the linear resolution and bilinearly
 * upsampled. That is a 16x reduction in the only expensive part of the paint,
 * which is what keeps an overlay switch from stalling the frame.
 */
const STATIC_W = 256;
const STATIC_H = 128;

interface MarkerStyle {
  color: number;
  domain: Domain;
  severity: number;
  lat: number;
  lon: number;
  id: string;
  name: string;
}

export class CommandGlobe {
  readonly group = new THREE.Group();
  readonly planetRadius: number;

  private planetMaterial: THREE.MeshStandardMaterial;
  private planetGeometry: THREE.IcosahedronGeometry;
  private planetMesh: THREE.Mesh;
  private atmosphereMaterial: THREE.ShaderMaterial;
  private atmosphereMesh: THREE.Mesh;
  private overlayTexture: THREE.DataTexture;
  private overlayCanvas: Uint8Array;
  private overlayWords: Uint32Array;
  private fields: PlanetFields;
  /**
   * The overlay texture is 1024x512 equirectangular pixels, and each pixel used
   * to cost several fbm noise evaluations.
   *
   * The seed-only noise is evaluated once per mode on the 256x128 coarse grid
   * and cached in `coarseByMode`. On each repaint, the state-dependent colour
   * and severity equations run on the 32,768 coarse cells (16x fewer than the
   * 524,288 texture pixels), and the resulting (r, g, b, banding) field is
   * bilinearly upsampled into the 1024x512 texture while applying the
   * high-resolution accessibility stripe graticule.
   */
  private coarseByMode = new Map<OverlayMode, Float32Array>();
  private coarseColorBanding: Float32Array;
  private readonly coarseNx: Float32Array;
  private readonly coarseNy: Float32Array;
  private readonly coarseNz: Float32Array;
  /** Upsample index/weight tables, built once. */
  private readonly upX0: Int32Array;
  private readonly upX1: Int32Array;
  private readonly upFx: Float32Array;
  private readonly upY0: Int32Array;
  private readonly upY1: Int32Array;
  private readonly upFy: Float32Array;
  private readonly rowCos: Float32Array;
  private readonly rowSin: Float32Array;
  private readonly colCos: Float32Array;
  private readonly colSin: Float32Array;
  private readonly rowPhaseSin: Float32Array;
  private readonly rowPhaseCos: Float32Array;
  private lastPaintedVars: Record<string, number> | null = null;
  private readonly _camDir = new THREE.Vector3();
  private readonly _surfDir = new THREE.Vector3();

  private markerGroup = new THREE.Group();
  private spireGroup = new THREE.Group();
  private routeGroup = new THREE.Group();
  private debrisGroup = new THREE.Group();
  private settlementGroup = new THREE.Group();

  private markerMeshes: THREE.Mesh[] = [];
  private markerById = new Map<string, THREE.Mesh>();
  private markerRings: THREE.Mesh[] = [];
  private spireMeshes: THREE.Mesh[] = [];
  private spireById = new Map<number, THREE.Mesh>();
  private pickTargets: THREE.Mesh[] = [];
  private settlementMeshes: THREE.Mesh[] = [];
  private settlementById = new Map<string, THREE.Mesh>();
  private debrisMesh: THREE.InstancedMesh | null = null;
  private routeLines: THREE.LineSegments | null = null;

  /** Currently displayed overlay. */
  overlay: OverlayMode = 'TOPOGRAPHY';
  private overlayDirty = true;
  private lastPaintTime = 0;
  private disposed = false;

  /** Currently highlighted node, or null. */
  selectedNode: string | null = null;
  hoveredNode: string | null = null;

  onNodeClick: ((id: string) => void) | null = null;
  onNodeHover: ((id: string | null) => void) | null = null;

  constructor(seed: number, radius = 100, initialOverlay: OverlayMode = 'TOPOGRAPHY') {
    this.planetRadius = radius;
    this.overlay = initialOverlay;
    this.fields = new PlanetFields(seed);

    // --- planet body -----------------------------------------------------
    const detail = 6;
    this.planetGeometry = new THREE.IcosahedronGeometry(radius, detail);
    this.displacePlanet();
    this.planetMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.02,
      flatShading: false,
    });
    this.planetMesh = new THREE.Mesh(this.planetGeometry, this.planetMaterial);
    this.planetMesh.name = 'planet';
    this.group.add(this.planetMesh);

    // --- overlay texture --------------------------------------------------
    this.rowCos = new Float32Array(TEXTURE_H);
    this.rowSin = new Float32Array(TEXTURE_H);
    this.colCos = new Float32Array(TEXTURE_W);
    this.colSin = new Float32Array(TEXTURE_W);
    this.rowPhaseSin = new Float32Array(TEXTURE_H);
    this.rowPhaseCos = new Float32Array(TEXTURE_H);
    for (let y = 0; y < TEXTURE_H; y++) {
      const phi = (90 - (y / (TEXTURE_H - 1)) * 180) * DEG2RAD;
      this.rowCos[y] = Math.cos(phi);
      this.rowSin[y] = Math.sin(phi);
      this.rowPhaseSin[y] = Math.sin(y * 0.9);
      this.rowPhaseCos[y] = Math.cos(y * 0.9);
    }
    for (let x = 0; x < TEXTURE_W; x++) {
      const theta = ((x / TEXTURE_W) * 360 - 180) * DEG2RAD;
      this.colCos[x] = Math.cos(theta);
      this.colSin[x] = Math.sin(theta);
    }

    this.coarseColorBanding = new Float32Array(STATIC_W * STATIC_H * 4);
    this.coarseNx = new Float32Array(STATIC_W * STATIC_H);
    this.coarseNy = new Float32Array(STATIC_W * STATIC_H);
    this.coarseNz = new Float32Array(STATIC_W * STATIC_H);
    for (let y = 0; y < STATIC_H; y++) {
      const phi = (90 - (y / (STATIC_H - 1)) * 180) * DEG2RAD;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const row = y * STATIC_W;
      for (let x = 0; x < STATIC_W; x++) {
        const theta = ((x / STATIC_W) * 360 - 180) * DEG2RAD;
        const idx = row + x;
        this.coarseNx[idx] = cp * Math.cos(theta);
        this.coarseNy[idx] = sp;
        this.coarseNz[idx] = cp * Math.sin(theta);
      }
    }

    this.upX0 = new Int32Array(TEXTURE_W);
    this.upX1 = new Int32Array(TEXTURE_W);
    this.upFx = new Float32Array(TEXTURE_W);
    this.upY0 = new Int32Array(TEXTURE_H);
    this.upY1 = new Int32Array(TEXTURE_H);
    this.upFy = new Float32Array(TEXTURE_H);
    for (let x = 0; x < TEXTURE_W; x++) {
      const gx = (x * STATIC_W) / TEXTURE_W;
      const x0 = Math.min(STATIC_W - 1, Math.floor(gx));
      this.upX0[x] = x0;
      // Longitude wraps: column STATIC_W-1 and column 0 are the same meridian.
      this.upX1[x] = (x0 + 1) % STATIC_W;
      this.upFx[x] = gx - x0;
    }
    for (let y = 0; y < TEXTURE_H; y++) {
      const gy = (y * STATIC_H) / TEXTURE_H;
      const y0 = Math.min(STATIC_H - 1, Math.floor(gy));
      this.upY0[y] = y0;
      this.upY1[y] = Math.min(STATIC_H - 1, y0 + 1);
      this.upFy[y] = gy - y0;
    }

    this.overlayCanvas = new Uint8Array(TEXTURE_W * TEXTURE_H * 4);
    this.overlayWords = new Uint32Array(this.overlayCanvas.buffer);
    this.overlayTexture = new THREE.DataTexture(
      this.overlayCanvas as unknown as Uint8Array<ArrayBuffer>,
      TEXTURE_W,
      TEXTURE_H,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.overlayTexture.wrapS = THREE.RepeatWrapping;
    this.overlayTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.overlayTexture.minFilter = THREE.LinearFilter;
    this.overlayTexture.magFilter = THREE.LinearFilter;
    this.overlayTexture.generateMipmaps = false;
    this.overlayTexture.colorSpace = THREE.SRGBColorSpace;
    this.overlayTexture.needsUpdate = true;

    // --- atmosphere shell --------------------------------------------------
    this.atmosphereMaterial = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(1, 0.25, 0.4).normalize() },
        uColor: { value: new THREE.Color(0.42, 0.58, 0.78) },
        uIntensity: { value: 0.85 },
        uToxicity: { value: 0.5 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vPosW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDirection;
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uToxicity;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          vec3 viewDir = normalize(cameraPosition - vPosW);
          vec3 n = normalize(vNormalW);
          float rim = 1.0 - abs(dot(viewDir, n));
          float fres = pow(clamp(rim, 0.0, 1.0), 2.6);
          float sun = max(dot(normalize(vPosW), normalize(uSunDirection)), 0.0);
          // Polluted air scatters warmer and thicker.
          vec3 tint = mix(uColor, vec3(0.55, 0.46, 0.30), uToxicity * 0.65);
          float a = fres * uIntensity * (0.18 + sun * 1.15);
          gl_FragColor = vec4(tint * a, a);
        }
      `,
    });
    this.atmosphereMesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.045, 64, 48),
      this.atmosphereMaterial,
    );
    this.atmosphereMesh.name = 'atmosphere-shell';
    this.group.add(this.atmosphereMesh);

    // --- markers -----------------------------------------------------------
    this.group.add(this.markerGroup);
    this.group.add(this.spireGroup);
    this.group.add(this.settlementGroup);
    this.group.add(this.routeGroup);
    this.group.add(this.debrisGroup);

    this.buildMarkers();
    this.buildSpires();
    this.buildSettlements();
    this.pickTargets = [...this.markerMeshes, ...this.spireMeshes, ...this.settlementMeshes];
    this.buildDebris();
    this.buildRoutes();
    this.overlayDirty = true;
  }

  /** Push terrain scars into the icosphere so the silhouette is wounded. */
  private displacePlanet(): void {
    const geo = this.planetGeometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    const c: [number, number, number] = [0, 0, 0];
    const R = this.planetRadius;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const inv = 1 / v.length();
      const nx = v.x * inv, ny = v.y * inv, nz = v.z * inv;

      const continents = this.fields.continents(nx, ny, nz);
      const relief = (this.fields.field(nx, ny, nz, 1, 3.4) - 0.5) * 2;
      const faults = this.fields.faults(nx, ny, nz);
      const gouge = smoothstep(0.035, 0.0, faults);
      const vitrified = smoothstep(0.55, 0.9, this.fields.field(nx, ny, nz, 7, 1.7));

      const h = R * (1 + relief * 0.012 - gouge * 0.02 - vitrified * 0.006);
      v.set(nx * h, ny * h, nz * h);
      pos.setXYZ(i, v.x, v.y, v.z);

      // Base palette: scorched rock, oxidised metal, vitrified glass, salt.
      let r = 0.1, g = 0.093, b = 0.086;
      if (continents < 0.45) {
        r = 0.055; g = 0.058; b = 0.066; // low basin / glass sea
      }
      r += vitrified * 0.02;
      g -= vitrified * 0.012;
      b += vitrified * 0.03;
      r += gouge * 0.06;
      g += gouge * 0.03;
      b += gouge * 0.02;
      const ox = this.fields.field(nx, ny, nz, 3, 6.0);
      r += ox * 0.1; g += ox * 0.035; b += ox * 0.01;
      c[0] = clamp01(r); c[1] = clamp01(g); c[2] = clamp01(b);
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  // -- overlay painting -----------------------------------------------------

  setOverlay(mode: OverlayMode): void {
    if (this.overlay === mode) return;
    this.overlay = mode;
    this.overlayDirty = true;
  }

  getOverlay(): OverlayMode {
    return this.overlay;
  }

  /**
   * Evaluate the seed-only part of the field on the coarse grid. Done once per
   * overlay mode and cached; the result is pure geometry + noise, so it never
   * depends on the planetary state.
   */
  private getCoarseField(mode: OverlayMode): Float32Array {
    let out = this.coarseByMode.get(mode);
    if (out) return out;
    const total = STATIC_W * STATIC_H;
    out = new Float32Array(total * 2);
    const f = this.fields;
    const cNx = this.coarseNx;
    const cNy = this.coarseNy;
    const cNz = this.coarseNz;
    for (let i = 0; i < total; i++) {
      const nx = cNx[i];
      const ny = cNy[i];
      const nz = cNz[i];
      const k = i * 2;
      switch (mode) {
        case 'TOPOGRAPHY':
          out[k] = f.continents(nx, ny, nz);
          out[k + 1] = smoothstep(0.55, 0.9, f.field(nx, ny, nz, 7, 1.7));
          break;
        case 'ATMOSPHERE':
          out[k] = f.field(nx, ny, nz, 11, 2.6);
          out[k + 1] = smoothstep(0.5, 0.95, f.field(nx, ny, nz, 13, 3.8));
          break;
        case 'GEOLOGY':
          out[k] = smoothstep(0.02, 0.14, f.faults(nx, ny, nz));
          out[k + 1] = f.field(nx, ny, nz, 17, 2.2);
          break;
        case 'BIOSPHERE':
          out[k] = smoothstep(0.45, 0.85, f.field(nx, ny, nz, 19, 2.0));
          out[k + 1] = f.field(nx, ny, nz, 23, 2.8);
          break;
        case 'ORBIT':
          out[k] = smoothstep(0.45, 0.95, f.field(nx, ny, nz, 29, 1.6));
          break;
        case 'LOGISTICS':
          out[k] = smoothstep(0.3, 0.75, f.field(nx, ny, nz, 31, 1.4));
          out[k + 1] = smoothstep(0.55, 0.9, f.field(nx, ny, nz, 37, 2.4));
          break;
        case 'HARMONIC':
          out[k] = smoothstep(0.35, 0.8, f.field(nx, ny, nz, 41, 1.9));
          break;
        default:
          break;
      }
    }
    this.coarseByMode.set(mode, out);
    return out;
  }

  /** Repaint the overlay texture. Throttled internally. */
  private paintOverlay(): void {
    const mode = this.overlay;
    const coarse = this.getCoarseField(mode);
    const cb = this.coarseColorBanding;
    const totalCoarse = STATIC_W * STATIC_H;

    const vars = this.currentSnapshot ? this.currentSnapshot.vars : null;
    const atmosphereStability = vars ? vars.atmosphereStability : 0.5;
    const atmosphereToxicity = vars ? vars.atmosphereToxicity : 0.5;
    const geothermalPressure = vars ? vars.geothermalPressure : 0.5;
    const tectonicShear = vars ? vars.tectonicShear : 0.5;
    const hydrologyStability = vars ? vars.hydrologyStability : 0.5;
    const soilViability = vars ? vars.soilViability : 0.5;
    const biosphereViability = vars ? vars.biosphereViability : 0.5;
    const orbitalOcclusion = vars ? vars.orbitalOcclusion : 0.5;
    const orbitalSafety = vars ? vars.orbitalSafety : 0.5;
    const logisticsIntegrity = vars ? vars.logisticsIntegrity : 0.5;
    const harmonicCoherence = vars ? vars.harmonicCoherence : 0.5;

    this.lastPaintedVars = {
      atmosphereStability,
      atmosphereToxicity,
      geothermalPressure,
      tectonicShear,
      hydrologyStability,
      soilViability,
      biosphereViability,
      orbitalOcclusion,
      orbitalSafety,
      logisticsIntegrity,
      harmonicCoherence,
    };

    // Pass 1: evaluate state-dependent (r, g, b, banding) on the 256x128 coarse grid.
    switch (mode) {
      case 'TOPOGRAPHY':
        for (let i = 0; i < totalCoarse; i++) {
          const s0 = coarse[i * 2];
          const vit = coarse[i * 2 + 1];
          const c4 = i * 4;
          cb[c4] = 0.09 + s0 * 0.12;
          cb[c4 + 1] = 0.085 + s0 * 0.1;
          cb[c4 + 2] = 0.08 + s0 * 0.08 + vit * 0.06;
          cb[c4 + 3] = vit;
        }
        break;
      case 'ATMOSPHERE':
        for (let i = 0; i < totalCoarse; i++) {
          const turb = coarse[i * 2];
          const shear = coarse[i * 2 + 1];
          const press = atmosphereStability * (0.7 + turb * 0.5);
          const toxRaw = atmosphereToxicity * (0.75 + turb * 0.6);
          const tox = toxRaw < 0 ? 0 : toxRaw > 1 ? 1 : toxRaw;
          const c4 = i * 4;
          cb[c4] = tox * 0.85 + shear * 0.35;
          cb[c4 + 1] = press * 0.42 + (1 - tox) * 0.12;
          cb[c4 + 2] = press * 0.85 + (1 - tox) * 0.2;
          cb[c4 + 3] = tox > shear ? tox : shear;
        }
        break;
      case 'GEOLOGY':
        for (let i = 0; i < totalCoarse; i++) {
          const fault = coarse[i * 2];
          const s1 = coarse[i * 2 + 1];
          const heatRaw = geothermalPressure * (0.6 + s1 * 0.8);
          const heat = heatRaw < 0 ? 0 : heatRaw > 1 ? 1 : heatRaw;
          const shRaw = tectonicShear * (0.7 + fault * 0.9);
          const stab = 1 - (shRaw < 0 ? 0 : shRaw > 1 ? 1 : shRaw);
          const c4 = i * 4;
          cb[c4] = fault * 0.9 + heat * 0.9;
          cb[c4 + 1] = (1 - heat) * 0.3 + stab * 0.2;
          cb[c4 + 2] = stab * 0.55 + (1 - fault) * 0.15;
          cb[c4 + 3] = fault > heat ? fault : heat;
        }
        break;
      case 'BIOSPHERE':
        for (let i = 0; i < totalCoarse; i++) {
          const water = coarse[i * 2] * hydrologyStability;
          const s1 = coarse[i * 2 + 1];
          const soilRaw = soilViability * (0.6 + s1 * 0.8);
          const soil = soilRaw < 0 ? 0 : soilRaw > 1 ? 1 : soilRaw;
          const cropRaw = soil * water * biosphereViability;
          const crop = cropRaw < 0 ? 0 : cropRaw > 1 ? 1 : cropRaw;
          const c4 = i * 4;
          cb[c4] = (1 - crop) * 0.3;
          cb[c4 + 1] = crop * 0.75 + soil * 0.12 + water * 0.1;
          cb[c4 + 2] = water * 0.55 + (1 - soil) * 0.12;
          cb[c4 + 3] = 1 - crop;
        }
        break;
      case 'ORBIT':
        for (let i = 0; i < totalCoarse; i++) {
          const belt = coarse[i * 2];
          const debRaw = orbitalOcclusion * (0.5 + belt * 1.1);
          const debris = debRaw < 0 ? 0 : debRaw > 1 ? 1 : debRaw;
          const c4 = i * 4;
          cb[c4] = debris * 0.9;
          cb[c4 + 1] = orbitalSafety * 0.5;
          cb[c4 + 2] = 0.1 + debris * 0.25;
          cb[c4 + 3] = debris;
        }
        break;
      case 'LOGISTICS':
        for (let i = 0; i < totalCoarse; i++) {
          const route = coarse[i * 2];
          const depot = coarse[i * 2 + 1];
          const intRaw = logisticsIntegrity * (0.4 + route * 1.2);
          const integrity = intRaw < 0 ? 0 : intRaw > 1 ? 1 : intRaw;
          const c4 = i * 4;
          cb[c4] = (1 - integrity) * 0.75;
          cb[c4 + 1] = integrity * 0.7 + depot * 0.15;
          cb[c4 + 2] = integrity * 0.35 + depot * 0.35;
          cb[c4 + 3] = 1 - integrity;
        }
        break;
      case 'HARMONIC':
        for (let i = 0; i < totalCoarse; i++) {
          const cov = coarse[i * 2];
          const cohRaw = harmonicCoherence * (0.4 + cov * 1.3);
          const coherence = cohRaw < 0 ? 0 : cohRaw > 1 ? 1 : cohRaw;
          const resRaw = (1 - coherence) * (0.4 + cov * 0.9);
          const resonance = resRaw < 0 ? 0 : resRaw > 1 ? 1 : resRaw;
          const c4 = i * 4;
          cb[c4] = resonance * 0.75;
          cb[c4 + 1] = coherence * 0.35;
          // Azure ONLY here — this is the Starsilk-derived diagnostic language.
          cb[c4 + 2] = 0.15 + coherence * 0.8;
          cb[c4 + 3] = 1 - coherence;
        }
        break;
      default:
        break;
    }

    // Pass 2: bilinearly upsample (r, g, b, banding) to 1024x512 and apply severity stripes.
    const words = this.overlayWords;
    const upX0 = this.upX0;
    const upX1 = this.upX1;
    const upFx = this.upFx;
    const upY0 = this.upY0;
    const upY1 = this.upY1;
    const upFy = this.upFy;
    const colCos = this.colCos;
    const colSin = this.colSin;
    const rowPhaseSin = this.rowPhaseSin;
    const rowPhaseCos = this.rowPhaseCos;
    const W = TEXTURE_W;
    const H = TEXTURE_H;

    for (let y = 0; y < H; y++) {
      const r0 = upY0[y] * STATIC_W;
      const r1 = upY1[y] * STATIC_W;
      const ty = upFy[y];
      const sy = 1 - ty;
      const pa = rowPhaseSin[y];
      const pb = rowPhaseCos[y];
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const x0 = upX0[x];
        const x1 = upX1[x];
        const tx = upFx[x];
        const sx = 1 - tx;
        const w00 = sx * sy;
        const w10 = tx * sy;
        const w01 = sx * ty;
        const w11 = tx * ty;
        const a = (r0 + x0) * 4;
        const b = (r0 + x1) * 4;
        const c = (r1 + x0) * 4;
        const d = (r1 + x1) * 4;

        let cr = cb[a] * w00 + cb[b] * w10 + cb[c] * w01 + cb[d] * w11;
        let cg = cb[a + 1] * w00 + cb[b + 1] * w10 + cb[c + 1] * w01 + cb[d + 1] * w11;
        let cbl = cb[a + 2] * w00 + cb[b + 2] * w10 + cb[c + 2] * w01 + cb[d + 2] * w11;
        const banding = cb[a + 3] * w00 + cb[b + 3] * w10 + cb[c + 3] * w01 + cb[d + 3] * w11;

        if (banding > 0.02) {
          const phase = pa * colCos[x] + pb * colSin[x];
          if (phase > 1 - banding * 0.9) {
            cr = cr * 0.55 + 0.35;
            cg = cg * 0.55 + 0.35;
            cbl = cbl * 0.55 + 0.35;
          }
        }

        const rByte = cr <= 0 ? 0 : cr >= 1 ? 255 : (cr * 255 + 0.5) | 0;
        const gByte = cg <= 0 ? 0 : cg >= 1 ? 255 : (cg * 255 + 0.5) | 0;
        const bByte = cbl <= 0 ? 0 : cbl >= 1 ? 255 : (cbl * 255 + 0.5) | 0;
        words[row + x] = 0xff000000 | (bByte << 16) | (gByte << 8) | rByte;
      }
    }
    this.overlayTexture.needsUpdate = true;
    this.overlayDirty = false;
  }

  private currentSnapshot: PlanetarySnapshot | null = null;

  /** Feed the authoritative state in; repaints only when state materially shifts. */
  setPlanetaryState(snapshot: PlanetarySnapshot, now: number, force = false): void {
    this.currentSnapshot = snapshot;
    if (force) {
      this.lastPaintTime = now;
      this.overlayDirty = true;
      return;
    }
    if (now - this.lastPaintTime < 350) return;
    this.lastPaintTime = now;
    const prev = this.lastPaintedVars;
    if (prev && !this.overlayDirty) {
      const v = snapshot.vars;
      let changed = false;
      for (const k of Object.keys(prev)) {
        if (Math.abs((v as Record<string, number>)[k] - prev[k]) >= 0.002) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
    }
    this.overlayDirty = true;
  }

  // -- markers --------------------------------------------------------------

  private static readonly DOMAIN_COLOR: Record<Domain, number> = {
    ORBIT: 0x6fa8c8,
    SKY: 0x9fb8c4,
    SURFACE: 0xc08a4a,
    SUBSURFACE: 0xb0563a,
    HARMONIC: 0x3fa9d8,
  };

  private markerData: MarkerStyle[] = [];

  private buildMarkers(): void {
    const geoCone = new THREE.ConeGeometry(1.6, 4.4, 6);
    geoCone.rotateX(Math.PI);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    for (const node of CRISIS_NODES) {
      const color = CommandGlobe.DOMAIN_COLOR[node.domain];
      const m = new THREE.Mesh(geoCone, new THREE.MeshBasicMaterial({ color, toneMapped: false }));
      const dir = latLonDir(node.lat, node.lon);
      m.position.copy(dir).multiplyScalar(this.planetRadius * 1.005);
      m.lookAt(dir.clone().multiplyScalar(this.planetRadius * 2));
      m.userData.nodeId = node.id;
      m.name = `node-${node.id}`;
      this.markerGroup.add(m);
      this.markerMeshes.push(m);

      const ringGeo = new THREE.RingGeometry(3.4, 5.2, 24);
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, toneMapped: false }),
      );
      ring.position.copy(dir).multiplyScalar(this.planetRadius * 1.004);
      ring.lookAt(dir.clone().multiplyScalar(this.planetRadius * 2));
      ring.userData.nodeId = node.id;
      this.markerGroup.add(ring);
      this.markerRings.push(ring);

      this.markerData.push({
        color,
        domain: node.domain,
        severity: node.severity,
        lat: node.lat,
        lon: node.lon,
        id: node.id,
        name: node.name,
      });
    }
    void mat;
  }

  private buildSpires(): void {
    const geo = new THREE.CylinderGeometry(0.22, 0.5, 3.4, 5);
    geo.translate(0, 1.7, 0);
    for (const s of ACOUSTIC_SPIRES) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x1d4c63, toneMapped: false }));
      const dir = latLonDir(s.lat, s.lon);
      m.position.copy(dir).multiplyScalar(this.planetRadius * 1.002);
      m.lookAt(dir.clone().multiplyScalar(this.planetRadius * 2));
      m.userData.spireId = s.id;
      this.spireGroup.add(m);
      this.spireMeshes.push(m);
    }
  }

  private buildSettlements(): void {
    const geo = new THREE.BoxGeometry(1.1, 1.1, 1.1);
    for (const s of SETTLEMENTS) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xd8b478, toneMapped: false }));
      const dir = latLonDir(s.lat, s.lon);
      m.position.copy(dir).multiplyScalar(this.planetRadius * 1.002);
      m.userData.settlementId = s.id;
      this.settlementGroup.add(m);
      this.settlementMeshes.push(m);
    }
  }

  private buildDebris(): void {
    const count = 900;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0x8a8378, toneMapped: false });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.name = 'orbital-debris';
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const matArr = inst.instanceMatrix.array as Float32Array;
    for (let i = 0; i < count; i++) {
      // Deterministic belt distribution.
      const t = i / count;
      const h = (t * 2654435761) >>> 0;
      const rr = (x: number): number => {
        let v = (h ^ Math.imul(x, 0x9e3779b9)) >>> 0;
        v = Math.imul(v ^ (v >>> 15), 0x85ebca6b) >>> 0;
        v = (v ^ (v >>> 13)) >>> 0;
        return v / 4294967296;
      };
      const incl = (rr(1) - 0.5) * 0.5;
      const radius = this.planetRadius * (1.09 + rr(2) * 0.16);
      const ang = rr(3) * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const x = ca * radius;
      const z = sa * radius;
      const y = Math.sin(incl) * radius;
      const sc = 0.35 + rr(7) * 1.5;
      const sx = sc;
      const sy = sc * (0.4 + rr(8) * 0.8);
      const sz = sc * (0.5 + rr(9) * 0.9);
      const o = i * 16;
      matArr[o] = ca * sx;
      matArr[o + 1] = 0;
      matArr[o + 2] = sa * sx;
      matArr[o + 3] = 0;
      matArr[o + 4] = 0;
      matArr[o + 5] = sy;
      matArr[o + 6] = 0;
      matArr[o + 7] = 0;
      matArr[o + 8] = -sa * sz;
      matArr[o + 9] = 0;
      matArr[o + 10] = ca * sz;
      matArr[o + 11] = 0;
      matArr[o + 12] = x;
      matArr[o + 13] = y;
      matArr[o + 14] = z;
      matArr[o + 15] = 1;
    }
    inst.instanceMatrix.needsUpdate = true;
    this.debrisMesh = inst;
    this.debrisGroup.add(inst);
  }

  private buildRoutes(): void {
    // Logistics arcs between settlements and the spires that serve them.
    const pts: number[] = [];
    const tmp = new THREE.Vector3();
    for (let i = 0; i < SETTLEMENTS.length; i++) {
      const a = SETTLEMENTS[i];
      const b = SETTLEMENTS[(i + 1) % SETTLEMENTS.length];
      const da = latLonDir(a.lat, a.lon).multiplyScalar(this.planetRadius * 1.01);
      const db = latLonDir(b.lat, b.lon).multiplyScalar(this.planetRadius * 1.01);
      // Great-circle-ish arc with a lift so it reads as a route, not a chord.
      for (let s = 0; s < 12; s++) {
        const t0 = s / 12;
        const t1 = (s + 1) / 12;
        tmp.copy(da).lerp(db, t0);
        tmp.normalize().multiplyScalar(this.planetRadius * (1.01 + Math.sin(t0 * Math.PI) * 0.03));
        pts.push(tmp.x, tmp.y, tmp.z);
        tmp.copy(da).lerp(db, t1);
        tmp.normalize().multiplyScalar(this.planetRadius * (1.01 + Math.sin(t1 * Math.PI) * 0.03));
        pts.push(tmp.x, tmp.y, tmp.z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.routeLines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0x4a6b74, transparent: true, opacity: 0.55, toneMapped: false }),
    );
    this.routeGroup.add(this.routeLines);
  }

  // -- per-frame ------------------------------------------------------------

  setSunDirection(dir: THREE.Vector3): void {
    (this.atmosphereMaterial.uniforms.uSunDirection.value as THREE.Vector3).copy(dir).normalize();
  }

  setAtmosphereToxicity(t: number): void {
    this.atmosphereMaterial.uniforms.uToxicity.value = t;
  }

  setOverlayVisible(visible: boolean): void {
    this.planetMaterial.map = visible ? this.overlayTexture : null;
    this.planetMaterial.needsUpdate = true;
  }

  /** Update marker visuals for selection/hover/progress. */
  updateMarkers(
    now: number,
    dt: number,
    nodeStatus: Record<string, 'LOCKED' | 'AVAILABLE' | 'ACTIVE' | 'RESOLVED'>,
    nodeProgress: Record<string, number>,
    spireFunctional: boolean[],
    spirePhase: number[],
  ): void {
    for (const m of this.markerMeshes) {
      const id = m.userData.nodeId as string;
      const status = nodeStatus[id] ?? 'AVAILABLE';
      const mat = m.material as THREE.MeshBasicMaterial;
      const sel = this.selectedNode === id;
      const hov = this.hoveredNode === id;
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.0022 + m.id);
      let scale = 1;
      let opacity = 1;
      let color = 0xffffff;
      switch (status) {
        case 'RESOLVED':
          color = 0x4f7a52;
          scale = 0.75;
          opacity = 0.55;
          break;
        case 'ACTIVE':
          color = sel ? 0xffe6a8 : 0xd8c48a;
          scale = 1.25 + pulse * 0.2;
          break;
        case 'LOCKED':
          color = 0x3a3a38;
          scale = 0.7;
          opacity = 0.45;
          break;
        default:
          color = sel ? 0xffd88a : hov ? 0xe8d0a0 : 0xb0a48c;
          scale = (sel ? 1.2 : hov ? 1.1 : 1) + pulse * 0.08;
      }
      mat.color.setHex(color);
      mat.opacity = opacity;
      mat.transparent = opacity < 1;
      m.scale.setScalar(scale);
      m.visible = status !== 'RESOLVED' || true;
    }
    for (const ring of this.markerRings) {
      const id = ring.userData.nodeId as string;
      const status = nodeStatus[id] ?? 'AVAILABLE';
      const prog = nodeProgress[id] ?? 0;
      const mat = ring.material as THREE.MeshBasicMaterial;
      ring.visible = status === 'ACTIVE' || this.selectedNode === id;
      if (ring.visible) {
        const s = 1 + prog * 2.4;
        ring.scale.setScalar(s);
        mat.opacity = 0.55 * (1 - prog * 0.7);
        ring.rotation.z += dt * 0.6;
      }
    }
    for (const m of this.spireMeshes) {
      const id = m.userData.spireId as number;
      const functional = spireFunctional[id] ?? false;
      const mat = m.material as THREE.MeshBasicMaterial;
      // Azure for a functioning spire — the only sanctioned Starsilk-adjacent
      // colour usage on the globe. Dim slate when dead.
      if (functional) {
        const phase = spirePhase[id] ?? 0;
        const beat = 0.55 + 0.45 * Math.sin(now * 0.003 + phase);
        mat.color.setRGB(0.16 + beat * 0.2, 0.62 + beat * 0.22, 0.85 + beat * 0.12);
        m.scale.setScalar(1.35);
      } else {
        mat.color.setHex(0x24404d);
        m.scale.setScalar(0.8);
      }
    }
    for (const m of this.settlementMeshes) {
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.setHex(0xc9a468);
    }
    if (this.routeLines) {
      (this.routeLines.material as THREE.LineBasicMaterial).opacity = 0.35 + 0.25 * Math.sin(now * 0.0008);
    }
  }

  /** Rotate debris slightly to convey orbital motion without real simulation. */
  update(dt: number): void {
    this.debrisGroup.rotation.y += dt * 0.012;
    if (this.overlayDirty) this.paintOverlay();
  }

  /** Raycast helper for picking nodes on the globe. */
  pick(raycaster: THREE.Raycaster): {
    nodeId: string | null;
    spireId: number | null;
    settlementId: string | null;
  } {
    const hits = raycaster.intersectObjects(this.pickTargets, false);
    if (hits.length === 0) return { nodeId: null, spireId: null, settlementId: null };
    const o = hits[0].object;
    return {
      nodeId: (o.userData.nodeId as string) ?? null,
      spireId: (o.userData.spireId as number) ?? null,
      settlementId: (o.userData.settlementId as string) ?? null,
    };
  }

  /** Node screen position for HTML label anchoring (true when on visible front hemisphere). */
  projectNode(id: string, camera: THREE.Camera, out: THREE.Vector3): boolean {
    const m = this.markerById.get(id) ?? this.markerMeshes.find((x) => x.userData.nodeId === id);
    if (!m) return false;
    this.markerById.set(id, m);
    out.copy(m.position);
    this.planetMesh.localToWorld(out);
    this._camDir.copy(camera.position).normalize();
    this._surfDir.copy(out).normalize();
    if (this._surfDir.dot(this._camDir) < 0.08) return false;
    out.project(camera);
    return out.z > -1 && out.z < 1;
  }

  /** Spire screen position for HTML label anchoring (true when on visible front hemisphere). */
  projectSpire(id: number, camera: THREE.Camera, out: THREE.Vector3): boolean {
    const m = this.spireById.get(id) ?? this.spireMeshes.find((x) => x.userData.spireId === id);
    if (!m) return false;
    this.spireById.set(id, m);
    out.copy(m.position);
    this.planetMesh.localToWorld(out);
    this._camDir.copy(camera.position).normalize();
    this._surfDir.copy(out).normalize();
    if (this._surfDir.dot(this._camDir) < 0.08) return false;
    out.project(camera);
    return out.z > -1 && out.z < 1;
  }

  /** Settlement screen position for HTML label anchoring (true when on visible front hemisphere). */
  projectSettlement(id: string, camera: THREE.Camera, out: THREE.Vector3): boolean {
    const m = this.settlementById.get(id) ?? this.settlementMeshes.find((x) => x.userData.settlementId === id);
    if (!m) return false;
    this.settlementById.set(id, m);
    out.copy(m.position);
    this.planetMesh.localToWorld(out);
    this._camDir.copy(camera.position).normalize();
    this._surfDir.copy(out).normalize();
    if (this._surfDir.dot(this._camDir) < 0.08) return false;
    out.project(camera);
    return out.z > -1 && out.z < 1;
  }

  get markerCount(): number {
    return this.markerMeshes.length;
  }

  /**
   * QA hook: the raw RGBA overlay pixels. Used by the canon check to prove the
   * Starsilk diagnostic language really is azure, and by the render tests to
   * prove every overlay paints a real field rather than a flat fill.
   */
  get overlayPixels(): Uint8Array {
    if (this.overlayDirty) this.paintOverlay();
    return this.overlayCanvas;
  }

  get triangleCount(): number {
    const idx = this.planetGeometry.getIndex();
    return idx ? idx.count / 3 : this.planetGeometry.attributes.position.count / 3;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.planetGeometry.dispose();
    this.planetMaterial.dispose();
    this.atmosphereMesh.geometry.dispose();
    this.atmosphereMaterial.dispose();
    this.overlayTexture.dispose();
    this.debrisMesh?.geometry.dispose();
    (this.debrisMesh?.material as THREE.Material | undefined)?.dispose();
    this.routeLines?.geometry.dispose();
    (this.routeLines?.material as THREE.Material | undefined)?.dispose();
    for (const m of [...this.markerMeshes, ...this.markerRings, ...this.spireMeshes, ...this.settlementMeshes]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.coarseByMode.clear();
    this.markerById.clear();
    this.spireById.clear();
    this.group.clear();
  }
}

function latLonDir(lat: number, lon: number): THREE.Vector3 {
  const phi = lat * DEG2RAD;
  const theta = lon * DEG2RAD;
  return new THREE.Vector3(
    Math.cos(phi) * Math.cos(theta),
    Math.sin(phi),
    Math.cos(phi) * Math.sin(theta),
  );
}

export { latLonDir };
export const PLANET_BIOME_HINT: Record<string, BiomeId> = {};
