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
  constructor(seed: number) {
    this.sA = mixSeed(seed, 0x1a2b3c4d);
    this.sB = mixSeed(seed, 0x5e6f7a8b);
  }
  /** Scalar field on the unit sphere. */
  field(x: number, y: number, z: number, which: number, freq = 2.2): number {
    return fbm3(x * freq, y * freq, z * freq, mixSeed(this.sA, which * 7919), 4);
  }
  /** Ridged fault network. */
  faults(x: number, y: number, z: number): number {
    const a = Math.abs(valueNoise3(x * 3.1, y * 3.1 + 4.2, z * 3.1, this.sB) - 0.5);
    const b = Math.abs(valueNoise3(x * 2.3 + 9.1, y * 2.3, z * 2.3, mixSeed(this.sB, 31)) - 0.5);
    return Math.min(a, b);
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
  private fields: PlanetFields;
  /**
   * The overlay texture is 1024x512 equirectangular pixels, and each pixel used
   * to cost several fbm noise evaluations. Painting it on the main thread
   * blocked for ~0.6 s, which is most of a frame budget at 60 Hz.
   *
   * The expensive part of the field is *static* — the noise depends only on the
   * world seed and the overlay mode, never on the planetary state. So the noise
   * is evaluated once per mode into `staticField`, and every repaint only does
   * the cheap state-dependent arithmetic on top of it. Trigonometry for the
   * pixel grid is likewise precomputed once.
   */
  private staticField: Float32Array | null = null;
  private coarseField: Float32Array;
  private staticMode: OverlayMode | null = null;
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

  private markerGroup = new THREE.Group();
  private spireGroup = new THREE.Group();
  private routeGroup = new THREE.Group();
  private debrisGroup = new THREE.Group();
  private settlementGroup = new THREE.Group();

  private markerMeshes: THREE.Mesh[] = [];
  private markerRings: THREE.Mesh[] = [];
  private spireMeshes: THREE.Mesh[] = [];
  private settlementMeshes: THREE.Mesh[] = [];
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

  constructor(seed: number, radius = 100) {
    this.planetRadius = radius;
    this.fields = new PlanetFields(seed);

    // --- planet body -----------------------------------------------------
    const detail = 6; // 40962 vertices
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

    this.coarseField = new Float32Array(STATIC_W * STATIC_H * 3);
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
    this.buildDebris();
    this.buildRoutes();
    this.paintOverlay();
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
   * overlay change; the result is pure geometry + noise, so it never depends on
   * the planetary state.
   */
  private buildCoarseField(mode: OverlayMode): void {
    const out = this.coarseField;
    const f = this.fields;
    for (let y = 0; y < STATIC_H; y++) {
      const phi = (90 - (y / (STATIC_H - 1)) * 180) * DEG2RAD;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const row = y * STATIC_W;
      for (let x = 0; x < STATIC_W; x++) {
        // STATIC_W columns span 360 degrees with the seam wrapped, so the last
        // column and the first are the same meridian and the field is periodic.
        const theta = ((x / STATIC_W) * 360 - 180) * DEG2RAD;
        const nx = cp * Math.cos(theta);
        const ny = sp;
        const nz = cp * Math.sin(theta);
        const k = (row + x) * 3;
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
        out[k + 2] = 0;
      }
    }
    this.staticMode = mode;
  }

  /** Bilinearly expand the coarse noise grid to the texture resolution. */
  private upsampleStatic(): void {
    if (!this.staticField) this.staticField = new Float32Array(TEXTURE_W * TEXTURE_H * 3);
    const src = this.coarseField;
    const dst = this.staticField;
    const upX0 = this.upX0;
    const upX1 = this.upX1;
    const upFx = this.upFx;
    const upY0 = this.upY0;
    const upY1 = this.upY1;
    const upFy = this.upFy;
    const W = TEXTURE_W;
    for (let y = 0; y < TEXTURE_H; y++) {
      const r0 = upY0[y] * STATIC_W;
      const r1 = upY1[y] * STATIC_W;
      const ty = upFy[y];
      const sy = 1 - ty;
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const x0 = upX0[x];
        const x1 = upX1[x];
        const tx = upFx[x];
        const sx = 1 - tx;
        const a = (r0 + x0) * 3;
        const b = (r0 + x1) * 3;
        const c = (r1 + x0) * 3;
        const d = (r1 + x1) * 3;
        const k = (row + x) * 3;
        dst[k] = (src[a] * sx + src[b] * tx) * sy + (src[c] * sx + src[d] * tx) * ty;
        dst[k + 1] = (src[a + 1] * sx + src[b + 1] * tx) * sy + (src[c + 1] * sx + src[d + 1] * tx) * ty;
        dst[k + 2] = (src[a + 2] * sx + src[b + 2] * tx) * sy + (src[c + 2] * sx + src[d + 2] * tx) * ty;
      }
    }
  }

  /** Repaint the overlay texture. Throttled internally. */
  private paintOverlay(): void {
    const data = this.overlayCanvas;
    const mode = this.overlay;
    if (this.staticMode !== mode || !this.staticField) {
      this.buildCoarseField(mode);
      this.upsampleStatic();
    }
    const sf = this.staticField as Float32Array;
    // Planetary state is supplied per-paint; use the last supplied snapshot.
    // Hoisted out of the pixel loop: these eleven values are constant for the
    // whole repaint, and calling through a closure 524k times was measurable.
    const vars = this.currentSnapshot ? this.currentSnapshot.vars : null;
    const S = {
      atmosphereStability: vars ? vars.atmosphereStability : 0.5,
      atmosphereToxicity: vars ? vars.atmosphereToxicity : 0.5,
      geothermalPressure: vars ? vars.geothermalPressure : 0.5,
      tectonicShear: vars ? vars.tectonicShear : 0.5,
      hydrologyStability: vars ? vars.hydrologyStability : 0.5,
      soilViability: vars ? vars.soilViability : 0.5,
      biosphereViability: vars ? vars.biosphereViability : 0.5,
      orbitalOcclusion: vars ? vars.orbitalOcclusion : 0.5,
      orbitalSafety: vars ? vars.orbitalSafety : 0.5,
      logisticsIntegrity: vars ? vars.logisticsIntegrity : 0.5,
      harmonicCoherence: vars ? vars.harmonicCoherence : 0.5,
    };

    const colCos = this.colCos;
    const colSin = this.colSin;
    const rowPhaseSin = this.rowPhaseSin;
    const rowPhaseCos = this.rowPhaseCos;
    const W = TEXTURE_W;
    const H = TEXTURE_H;

    for (let y = 0; y < H; y++) {
      // sin(y*0.9 + x*0.12) expanded so the inner loop needs no trigonometry.
      const pa = rowPhaseSin[y];
      const pb = rowPhaseCos[y];
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const k = (row + x) * 3;
        const s0 = sf[k];
        const s1 = sf[k + 1];

        let r = 0, g = 0, b = 0;
        let banding = 0; // 0..1 stripe intensity for accessibility

        switch (mode) {
          case 'TOPOGRAPHY': {
            const vit = s1;
            r = 0.09 + s0 * 0.12;
            g = 0.085 + s0 * 0.1;
            b = 0.08 + s0 * 0.08 + vit * 0.06;
            banding = vit;
            break;
          }
          case 'ATMOSPHERE': {
            const turb = s0;
            const shear = s1;
            const press = S.atmosphereStability * (0.7 + turb * 0.5);
            const tox = clamp01(S.atmosphereToxicity * (0.75 + turb * 0.6));
            // Blue = pressure, magenta-ish = toxicity, white streaks = shear.
            r = tox * 0.85 + shear * 0.35;
            g = press * 0.42 + (1 - tox) * 0.12;
            b = press * 0.85 + (1 - tox) * 0.2;
            banding = Math.max(tox, shear);
            break;
          }
          case 'GEOLOGY': {
            const fault = s0;
            const heat = clamp01(S.geothermalPressure * (0.6 + s1 * 0.8));
            const stab = 1 - clamp01(S.tectonicShear * (0.7 + fault * 0.9));
            r = fault * 0.9 + heat * 0.9;
            g = (1 - heat) * 0.3 + stab * 0.2;
            b = stab * 0.55 + (1 - fault) * 0.15;
            banding = Math.max(fault, heat);
            break;
          }
          case 'BIOSPHERE': {
            const water = s0 * S.hydrologyStability;
            const soil = clamp01(S.soilViability * (0.6 + s1 * 0.8));
            const crop = clamp01(soil * water * S.biosphereViability);
            r = (1 - crop) * 0.3;
            g = crop * 0.75 + soil * 0.12 + water * 0.1;
            b = water * 0.55 + (1 - soil) * 0.12;
            banding = 1 - crop;
            break;
          }
          case 'ORBIT': {
            const belt = s0;
            const debris = clamp01(S.orbitalOcclusion * (0.5 + belt * 1.1));
            const corridor = S.orbitalSafety;
            r = debris * 0.9;
            g = corridor * 0.5;
            b = 0.1 + debris * 0.25;
            banding = debris;
            break;
          }
          case 'LOGISTICS': {
            const route = s0;
            const integrity = clamp01(S.logisticsIntegrity * (0.4 + route * 1.2));
            const depot = s1;
            r = (1 - integrity) * 0.75;
            g = integrity * 0.7 + depot * 0.15;
            b = integrity * 0.35 + depot * 0.35;
            banding = 1 - integrity;
            break;
          }
          case 'HARMONIC': {
            const cov = s0;
            const coherence = clamp01(S.harmonicCoherence * (0.4 + cov * 1.3));
            const resonance = clamp01((1 - coherence) * (0.4 + cov * 0.9));
            r = resonance * 0.75;
            g = coherence * 0.35;
            // Azure ONLY here — this is the Starsilk-derived diagnostic language.
            b = 0.15 + coherence * 0.8;
            banding = 1 - coherence;
            break;
          }
          default:
            break;
        }

        // Severity banding: horizontal stripe density rises with the value so
        // the overlay is legible without colour perception.
        const phase = pa * colCos[x] + pb * colSin[x];
        const stripe = banding > 0.02 && phase > 1 - banding * 0.9 ? 1 : 0;
        r = clamp01(r * (1 - stripe * 0.45) + stripe * 0.35);
        g = clamp01(g * (1 - stripe * 0.45) + stripe * 0.35);
        b = clamp01(b * (1 - stripe * 0.45) + stripe * 0.35);

        const i = (row + x) * 4;
        // (v * 255 + 0.5) | 0 is Math.round(v * 255) without the call overhead.
        data[i] = (clamp01(r) * 255 + 0.5) | 0;
        data[i + 1] = (clamp01(g) * 255 + 0.5) | 0;
        data[i + 2] = (clamp01(b) * 255 + 0.5) | 0;
        data[i + 3] = 255;
      }
    }
    this.overlayTexture.needsUpdate = true;
    this.overlayDirty = false;
  }

  private currentSnapshot: PlanetarySnapshot | null = null;

  /** Feed the authoritative state in; repaints at most a few times a second. */
  setPlanetaryState(snapshot: PlanetarySnapshot, now: number, force = false): void {
    this.currentSnapshot = snapshot;
    if (!force && now - this.lastPaintTime < 350) return;
    this.lastPaintTime = now;
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
    const dummy = new THREE.Object3D();
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
      const x = Math.cos(ang) * radius;
      const z = Math.sin(ang) * radius;
      const y = Math.sin(incl) * radius;
      dummy.position.set(x, y, z);
      dummy.rotation.set(rr(4) * 3, rr(5) * 3, rr(6) * 3);
      const sc = 0.35 + rr(7) * 1.5;
      dummy.scale.set(sc, sc * (0.4 + rr(8) * 0.8), sc * (0.5 + rr(9) * 0.9));
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
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
    this.spireGroup.rotation.y = this.debrisGroup.rotation.y * 0.6;
    if (this.overlayDirty) this.paintOverlay();
  }

  /** Raycast helper for picking nodes on the globe. */
  pick(raycaster: THREE.Raycaster): { nodeId: string | null; spireId: number | null } {
    const hits = raycaster.intersectObjects([...this.markerMeshes, ...this.spireMeshes], false);
    if (hits.length === 0) return { nodeId: null, spireId: null };
    const o = hits[0].object;
    return {
      nodeId: (o.userData.nodeId as string) ?? null,
      spireId: (o.userData.spireId as number) ?? null,
    };
  }

  /** Node screen position for HTML label anchoring. */
  projectNode(id: string, camera: THREE.Camera, out: THREE.Vector3): boolean {
    const m = this.markerMeshes.find((x) => x.userData.nodeId === id);
    if (!m) return false;
    out.copy(m.position);
    this.planetMesh.localToWorld(out);
    out.project(camera);
    return out.z < 1;
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
