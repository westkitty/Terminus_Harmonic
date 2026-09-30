/**
 * SECTOR FIELD — deterministic local terrain synthesis
 * ===================================================
 *
 * A sector is fully described by (worldSeed, lat, lon, radius, planetaryState).
 * Nothing about it is stored: unloading and reloading a sector reconstructs a
 * byte-identical heightfield, which is what makes the save file small and the
 * offline story simple. Excavation is the one thing that must persist, so it is
 * tracked as a sparse map of carved cells rather than a dense volume.
 */

import { clamp01, fbm3, mixSeed, smoothstep, valueNoise3 } from '../core/math';
import { BIOME_LABEL, MATERIALS, type BiomeId, type MaterialProfile } from '../state/world';

export interface SectorFieldParams {
  seed: number;
  lat: number;
  lon: number;
  /** Sector radius in metres (square, centred on origin). */
  radius: number;
  biome: BiomeId;
  /** Planetary influences that shape local geology. */
  geothermalPressure: number;
  tectonicShear: number;
  atmosphereToxicity: number;
  soilViability: number;
  /** Atmospheric turbulence 0..1 — drives glider shear and vertical wind. */
  turbulence: number;
}

/** Vertical exaggeration of the terrain, in metres. */
const RELIEF: Record<BiomeId, number> = {
  VITRIFIED_BASIN: 26,
  SHATTERED_BASALT: 58,
  SALT_FLAT: 7,
  TOXIC_VEIL: 22,
  REMNANT_SOIL: 34,
  PETRIFIED_MEGAFLORA: 46,
  GLASS_LATTICE: 40,
  FOUNDRY_RUIN: 30,
  FOSSIL_STRATA: 52,
  CRUSTAL_VENT: 74,
};

/** Horizontal feature scale in metres. */
const SCALE: Record<BiomeId, number> = {
  VITRIFIED_BASIN: 620,
  SHATTERED_BASALT: 380,
  SALT_FLAT: 900,
  TOXIC_VEIL: 480,
  REMNANT_SOIL: 340,
  PETRIFIED_MEGAFLORA: 300,
  GLASS_LATTICE: 420,
  FOUNDRY_RUIN: 260,
  FOSSIL_STRATA: 360,
  CRUSTAL_VENT: 300,
};

export class SectorField {
  readonly params: SectorFieldParams;
  readonly material: MaterialProfile;
  /** Human-readable biome name for HUD readouts. */
  get materialLabel(): string {
    return BIOME_LABEL[this.params.biome];
  }
  /**
   * Elevation of the local datum the sector is built around (metres). Set when
   * the sector is created so subterranean depth can be measured against it.
   */
  surfaceY = 0;
  private seedA: number;
  private seedB: number;
  private relief: number;
  private scale: number;

  constructor(params: SectorFieldParams) {
    this.params = params;
    this.material = MATERIALS[params.biome];
    this.seedA = mixSeed(params.seed, (Math.round(params.lat * 1000) * 7919 + Math.round(params.lon * 1000)) | 0);
    this.seedB = mixSeed(this.seedA, 0x51ed270b);
    this.relief = RELIEF[params.biome];
    this.scale = SCALE[params.biome];
  }

  /**
   * Terrain elevation in metres at sector-local (x, z).
   * Continuous, deterministic, and cheap enough to call per-vertex.
   */
  elevation(x: number, z: number): number {
    const s = this.scale;
    const nx = x / s;
    const nz = z / s;

    // Base rolling relief.
    let h = (fbm3(nx, 0.37, nz, this.seedA, 4) - 0.5) * 2 * this.relief;

    // War ridges: war-era terraforming left directional scarring.
    const ridge = (1 - Math.abs(valueNoise3(nx * 1.7, 5.1, nz * 1.7, this.seedB) * 2 - 1)) ** 2;
    h += (ridge - 0.35) * this.relief * 1.4;

    // Impact / vitrification basins: broad concave dishes.
    const basin = fbm3(nx * 0.55, 11.3, nz * 0.55, this.seedB, 2);
    h -= smoothstep(0.55, 0.95, basin) * this.relief * 1.1;

    // Fault gouge: sharp linear discontinuities along two dominant strikes.
    const strikeA = Math.abs(valueNoise3(nx * 0.9, 3.3, nz * 0.9, mixSeed(this.seedA, 17)) - 0.5);
    const strikeB = Math.abs(valueNoise3(nx * 0.9, 7.7, nz * 0.9, mixSeed(this.seedA, 29)) - 0.5);
    const gouge = Math.min(strikeA, strikeB);
    h -= (gouge < 0.03 ? 1 : 0) * this.relief * 0.25 * (0.4 + this.params.tectonicShear);

    // Geothermal doming where pressure is high.
    const vent = fbm3(nx * 0.35, 21.1, nz * 0.35, this.seedB, 2);
    h += smoothstep(0.6, 1.0, vent) * this.relief * 0.9 * this.params.geothermalPressure;

    // Glass fields are flatter.
    if (this.params.biome === 'VITRIFIED_BASIN' || this.params.biome === 'GLASS_LATTICE') h *= 0.35;
    if (this.params.biome === 'SALT_FLAT') h *= 0.2;

    return h;
  }

  /** Slope in radians at a point. */
  slope(x: number, z: number, eps = 2.0): number {
    const hL = this.elevation(x - eps, z);
    const hR = this.elevation(x + eps, z);
    const hD = this.elevation(x, z - eps);
    const hU = this.elevation(x, z + eps);
    const dx = (hR - hL) / (2 * eps);
    const dz = (hU - hD) / (2 * eps);
    return Math.atan(Math.hypot(dx, dz));
  }

  /** 0..1 ground suitability for heavy vehicles at a point. */
  bearing(x: number, z: number): number {
    const s = this.slope(x, z);
    const slopePenalty = smoothstep(0.10, 0.42, s);
    const cap = this.material.bearingCapacity / 1800;
    return clamp01(cap * (1 - slopePenalty * 0.85));
  }

  /** Surface colour (linear-ish RGB) — scorched, oxidised, industrial. */
  color(x: number, z: number, out: [number, number, number]): [number, number, number] {
    const p = this.params;
    const v = fbm3(x / 220, 3.1, z / 220, this.seedB, 3);
    const wet = smoothstep(0.55, 0.9, fbm3(x / 400, 9.9, z / 400, this.seedA, 2));
    const tox = p.atmosphereToxicity;
    const soil = p.soilViability;

    let r = 0.115, g = 0.104, b = 0.098;
    switch (p.biome) {
      case 'VITRIFIED_BASIN': r = 0.055; g = 0.052; b = 0.058; break;
      case 'GLASS_LATTICE': r = 0.07; g = 0.075; b = 0.09; break;
      case 'SALT_FLAT': r = 0.42; g = 0.41; b = 0.38; break;
      case 'TOXIC_VEIL': r = 0.16; g = 0.15; b = 0.10; break;
      case 'REMNANT_SOIL': r = 0.13; g = 0.115; b = 0.095; break;
      case 'PETRIFIED_MEGAFLORA': r = 0.10; g = 0.095; b = 0.085; break;
      case 'FOUNDRY_RUIN': r = 0.125; g = 0.105; b = 0.095; break;
      case 'FOSSIL_STRATA': r = 0.135; g = 0.12; b = 0.105; break;
      case 'CRUSTAL_VENT': r = 0.15; g = 0.09; b = 0.075; break;
      case 'SHATTERED_BASALT': r = 0.085; g = 0.082; b = 0.085; break;
    }

    // Oxidation mottling.
    const ox = smoothstep(0.45, 0.8, v);
    r = r * (1 - ox * 0.4) + 0.24 * ox * 0.4;
    g = g * (1 - ox * 0.55) + 0.10 * ox * 0.55;
    b = b * (1 - ox * 0.3) + 0.06 * ox * 0.3;

    // Toxic staining.
    r = r * (1 - tox * 0.35) + 0.10 * tox * 0.35;
    g = g * (1 - tox * 0.5) + 0.13 * tox * 0.5;
    b = b * (1 - tox * 0.6) + 0.08 * tox * 0.6;

    // Where soil is recovering, a faint dust-green creeps in. Never lush.
    r *= 1 - soil * 0.06;
    g *= 1 + soil * 0.16;
    b *= 1 - soil * 0.10;

    // Wet darkening near vents.
    const w = wet * p.geothermalPressure;
    r *= 1 - w * 0.3; g *= 1 - w * 0.25; b *= 1 - w * 0.2;

    out[0] = clamp01(r);
    out[1] = clamp01(g);
    out[2] = clamp01(b);
    return out;
  }
}

/**
 * Bounded sparse voxel excavation lattice.
 *
 * The world does NOT use a destructible voxel planet. Each sector owns a sparse
 * map of carved cells over a bounded depth range; only cells the crawler has
 * actually cut are stored, which keeps the structure tiny and serialisable.
 */
export class TunnelLattice {
  readonly cell: number;
  readonly extent: number;
  readonly depth: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** cellIndex -> carved flag (1) */
  private carved = new Map<number, number>();
  /** cellIndex -> heat 0..1 */
  private heat = new Map<number, number>();
  private originX = 0;
  private originZ = 0;
  private topY = 0;
  version = 0;

  constructor(cell = 4, extent = 512, depth = 240) {
    this.cell = cell;
    this.extent = extent;
    this.depth = depth;
    this.sizeX = Math.ceil((extent * 2) / cell);
    this.sizeY = Math.ceil(depth / cell);
    this.sizeZ = Math.ceil((extent * 2) / cell);
  }

  configure(originX: number, originZ: number, topY: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.topY = topY;
    this.carved.clear();
    this.heat.clear();
  }

  index(x: number, y: number, z: number): number {
    return (y * this.sizeZ + z) * this.sizeX + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sizeX && y < this.sizeY && z < this.sizeZ;
  }

  /** World (sector-local) position -> lattice coordinate, or null if outside. */
  toLattice(wx: number, wy: number, wz: number): [number, number, number] | null {
    const x = Math.floor((wx - this.originX) / this.cell + this.sizeX / 2);
    const y = Math.floor((this.topY - wy) / this.cell);
    const z = Math.floor((wz - this.originZ) / this.cell + this.sizeZ / 2);
    if (!this.inBounds(x, y, z)) return null;
    return [x, y, z];
  }

  /** Excavate a sphere of cells. Returns the number of newly voided cells. */
  excavate(wx: number, wy: number, wz: number, radiusCells: number): number {
    const c = this.toLattice(wx, wy, wz);
    if (!c) return 0;
    const [cx, cy, cz] = c;
    const r2 = radiusCells * radiusCells;
    const r = Math.ceil(radiusCells);
    let carved = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const x = cx + dx, y = cy + dy, z = cz + dz;
          if (!this.inBounds(x, y, z)) continue;
          const i = this.index(x, y, z);
          if (!this.carved.has(i)) {
            this.carved.set(i, 1);
            carved++;
          }
        }
      }
    }
    if (carved > 0) this.version++;
    return carved;
  }

  /** Re-fill cells (used when sealing a bypass tunnel). */
  backfill(wx: number, wy: number, wz: number, radiusCells: number): number {
    const c = this.toLattice(wx, wy, wz);
    if (!c) return 0;
    const [cx, cy, cz] = c;
    const r2 = radiusCells * radiusCells;
    const r = Math.ceil(radiusCells);
    let filled = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const x = cx + dx, y = cy + dy, z = cz + dz;
          if (!this.inBounds(x, y, z)) continue;
          const i = this.index(x, y, z);
          if (this.carved.delete(i)) filled++;
          this.heat.delete(i);
        }
      }
    }
    if (filled > 0) this.version++;
    return filled;
  }

  isVoid(wx: number, wy: number, wz: number): boolean {
    const c = this.toLattice(wx, wy, wz);
    if (!c) return false;
    return this.carved.has(this.index(c[0], c[1], c[2]));
  }

  heatAt(wx: number, wy: number, wz: number): number {
    const c = this.toLattice(wx, wy, wz);
    if (!c) return 0;
    return this.heat.get(this.index(c[0], c[1], c[2])) ?? 0;
  }

  addHeat(wx: number, wy: number, wz: number, amount: number): void {
    const c = this.toLattice(wx, wy, wz);
    if (!c) return;
    const i = this.index(c[0], c[1], c[2]);
    this.heat.set(i, clamp01((this.heat.get(i) ?? 0) + amount));
  }

  /** Rock temperature rises with depth and with geothermal pressure. */
  rockTemperature(wy: number, geothermalPressure: number): number {
    const depth = Math.max(0, this.topY - wy);
    return clamp01(0.05 + (depth / this.depth) * 0.55 + geothermalPressure * 0.4);
  }

  /** Structural instability 0..1 near a point: nearby voids + overburden. */
  instability(wx: number, wy: number, wz: number): number {
    const c = this.toLattice(wx, wy, wz);
    if (!c) return 0;
    const [cx, cy, cz] = c;
    let voids = 0;
    let total = 0;
    const R = 2;
    for (let dz = -R; dz <= R; dz++) {
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const x = cx + dx, y = cy + dy, z = cz + dz;
          if (!this.inBounds(x, y, z)) continue;
          total++;
          if (this.carved.has(this.index(x, y, z))) voids++;
        }
      }
    }
    if (total === 0) return 0;
    const voidRatio = voids / total;
    const depthFactor = clamp01((this.topY - wy) / 140);
    return clamp01(voidRatio * 0.8 + depthFactor * 0.5);
  }

  get carvedCount(): number {
    return this.carved.size;
  }

  /** Carved cell indices, ascending. Allocates — call only when rebuilding. */
  carvedKeys(): number[] {
    return [...this.carved.keys()].sort((a, b) => a - b);
  }

  /** Lattice cell index -> world (sector-local) position at the cell centre. */
  keyToWorld(key: number): [number, number, number] {
    const x = key % this.sizeX;
    const y = Math.floor(key / this.sizeX / this.sizeZ) % this.sizeY;
    const z = Math.floor(key / this.sizeX) % this.sizeZ;
    return [
      (x - this.sizeX / 2 + 0.5) * this.cell + this.originX,
      this.topY - (y + 0.5) * this.cell,
      (z - this.sizeZ / 2 + 0.5) * this.cell + this.originZ,
    ];
  }

  /** Compact serialisation: RLE of the carved cell indices. */
  serialize(): string {
    if (this.carved.size === 0) return '';
    const keys = [...this.carved.keys()].sort((a, b) => a - b);
    const parts: string[] = [];
    let prev = keys[0];
    let run = 1;
    for (let i = 1; i < keys.length; i++) {
      if (keys[i] === prev + run) {
        run++;
      } else {
        parts.push(run === 1 ? `${prev}` : `${prev}+${run}`);
        prev = keys[i];
        run = 1;
      }
    }
    parts.push(run === 1 ? `${prev}` : `${prev}+${run}`);
    return parts.join(',');
  }

  restore(data: string): void {
    this.carved.clear();
    this.heat.clear();
    if (!data) return;
    for (const part of data.split(',')) {
      if (!part) continue;
      const plus = part.indexOf('+');
      if (plus < 0) {
        this.carved.set(Number(part), 1);
      } else {
        const start = Number(part.slice(0, plus));
        const len = Number(part.slice(plus + 1));
        for (let i = 0; i < len; i++) this.carved.set(start + i, 1);
      }
    }
    this.version++;
  }
}
