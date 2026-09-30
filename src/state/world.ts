/**
 * WORLD CONTENT — GAME-LOCAL PROVISIONAL MATERIAL
 * ===============================================
 *
 * Everything in this file is game-local invention created for The Terminus
 * Harmonic. It is NOT an addition to Starsilk canon.
 *
 * Authority order used here:
 *   1. Canon locks supplied with the build brief.
 *   2. The Starsilk Compendium (Drakken field register, Blood Eclipse War
 *      chronology, Siege Wall visual law, Blood Ring definition).
 *   3. This file.
 *
 * The playable world is deliberately UNNAMED. It is a surviving remnant world
 * that existed outside the active sealed Drakken zone. No named canon character
 * appears, is recorded, voiced, or recreated anywhere in this project.
 */

import type { VarDelta } from './planetary';

export type Domain = 'ORBIT' | 'SKY' | 'SURFACE' | 'SUBSURFACE' | 'HARMONIC';

export type VehicleKind = 'ORBITAL_SKIFF' | 'LAND_TRAIN' | 'STRATA_CRAWLER' | 'GLIDER';

export type BiomeId =
  | 'VITRIFIED_BASIN'
  | 'SHATTERED_BASALT'
  | 'SALT_FLAT'
  | 'TOXIC_VEIL'
  | 'REMNANT_SOIL'
  | 'PETRIFIED_MEGAFLORA'
  | 'GLASS_LATTICE'
  | 'FOUNDRY_RUIN'
  | 'FOSSIL_STRATA'
  | 'CRUSTAL_VENT';

export interface MaterialProfile {
  /** Rock/machine cutting hardness, 0..1. */
  hardness: number;
  /** Thermal conductivity multiplier — high means heat leaves the cutter fast. */
  conductivity: number;
  /** Bulk density, drives geological pressure with depth. */
  density: number;
  /** Wheel/track rolling resistance. */
  rollingResistance: number;
  /** Ground bearing capacity (kPa) before failure. */
  bearingCapacity: number;
  /** Toxicity released into the atmosphere when disturbed. */
  toxicity: number;
  /** Friction coefficient for tracks and wheels. */
  friction: number;
}

/**
 * Ground profiles. `rollingResistance` is a dimensionless coefficient of
 * rolling resistance (Crr), i.e. the fraction of vehicle weight that must be
 * overcome just to keep the wheels turning. Real values run from ~0.001 for
 * steel-on-steel rail to ~0.15 for a tracked vehicle in soft ground; anything
 * near 1.0 would make the land-train immobile.
 */
export const MATERIALS: Record<BiomeId, MaterialProfile> = {
  VITRIFIED_BASIN: { hardness: 0.82, conductivity: 0.30, density: 2.4, rollingResistance: 0.045, bearingCapacity: 900, toxicity: 0.10, friction: 0.32 },
  SHATTERED_BASALT: { hardness: 0.95, conductivity: 0.55, density: 2.9, rollingResistance: 0.075, bearingCapacity: 1400, toxicity: 0.14, friction: 0.55 },
  SALT_FLAT: { hardness: 0.35, conductivity: 0.85, density: 2.1, rollingResistance: 0.030, bearingCapacity: 260, toxicity: 0.06, friction: 0.18 },
  TOXIC_VEIL: { hardness: 0.45, conductivity: 0.40, density: 1.7, rollingResistance: 0.085, bearingCapacity: 180, toxicity: 0.92, friction: 0.25 },
  REMNANT_SOIL: { hardness: 0.28, conductivity: 0.35, density: 1.4, rollingResistance: 0.060, bearingCapacity: 340, toxicity: 0.34, friction: 0.45 },
  PETRIFIED_MEGAFLORA: { hardness: 0.55, conductivity: 0.25, density: 1.2, rollingResistance: 0.070, bearingCapacity: 420, toxicity: 0.22, friction: 0.40 },
  GLASS_LATTICE: { hardness: 0.88, conductivity: 0.65, density: 2.6, rollingResistance: 0.050, bearingCapacity: 700, toxicity: 0.18, friction: 0.22 },
  FOUNDRY_RUIN: { hardness: 0.90, conductivity: 0.75, density: 3.2, rollingResistance: 0.080, bearingCapacity: 1800, toxicity: 0.40, friction: 0.60 },
  FOSSIL_STRATA: { hardness: 0.78, conductivity: 0.45, density: 2.5, rollingResistance: 0.065, bearingCapacity: 1100, toxicity: 0.28, friction: 0.50 },
  CRUSTAL_VENT: { hardness: 0.70, conductivity: 0.95, density: 2.7, rollingResistance: 0.090, bearingCapacity: 620, toxicity: 0.75, friction: 0.44 },
};

export const BIOME_LABEL: Record<BiomeId, string> = {
  VITRIFIED_BASIN: 'Vitrified Basin',
  SHATTERED_BASALT: 'Shattered Basalt',
  SALT_FLAT: 'Salt Flat',
  TOXIC_VEIL: 'Toxic Veil',
  REMNANT_SOIL: 'Remnant Soil',
  PETRIFIED_MEGAFLORA: 'Petrified Megaflora',
  GLASS_LATTICE: 'Glass Lattice Field',
  FOUNDRY_RUIN: 'Foundry Ruin',
  FOSSIL_STRATA: 'Fossil Strata',
  CRUSTAL_VENT: 'Crustal Vent',
};

/** Deterministic biome classification from geographic coordinates. */
export function latLonBiome(lat: number, lon: number): BiomeId {
  const absLat = Math.abs(lat);
  if (absLat > 65) return 'SHATTERED_BASALT';
  if (absLat > 45) return 'FOSSIL_STRATA';
  const h = Math.sin(lat * 0.12) * Math.cos(lon * 0.08);
  if (h > 0.45) return 'GLASS_LATTICE';
  if (h > 0.2) return 'VITRIFIED_BASIN';
  if (h > -0.1) return 'REMNANT_SOIL';
  if (h > -0.3) return 'SALT_FLAT';
  if (h > -0.5) return 'PETRIFIED_MEGAFLORA';
  return 'CRUSTAL_VENT';
}

/**
 * Deterministic world seed. Changing this regenerates every sector, every
 * terrain field and every debris belt; saved games pin the seed so a reload
 * reconstructs the identical world.
 */
export const WORLD_SEED = 0x7e2a91c3;

/** Survey designation of the unnamed remnant world (game-local). */
export const WORLD_DESIGNATION = 'REMNANT SURVEY 0-ARK';

export type CrisisId =
  | 'ORBITAL_SHADOW_CASCADE'
  | 'GLASS_BASIN_SUPPLY_FAILURE'
  | 'GEOTHERMAL_RUNAWAY'
  | 'ATMOSPHERIC_SHEAR_CORRIDOR'
  | 'HARMONIC_FAULT'
  | 'LYRIBORIS_EXCAVATION'
  | 'FOUNDRY_RESONANCE';

export interface CrisisObjective {
  id: string;
  text: string;
  /** Progress units required. */
  target: number;
}

export interface CrisisNodeDef {
  id: CrisisId;
  /** Short name used on the globe marker. */
  name: string;
  /** Briefing headline. */
  headline: string;
  /** Long-form briefing body. Kept terse; taught by interaction. */
  brief: string;
  lat: number;
  lon: number;
  domain: Domain;
  /** Which vehicle the player possesses on descent. */
  vehicle: VehicleKind;
  /** Local sector biome seed hint. */
  biomes: BiomeId[];
  /** Severity 0..1 — drives globe marker intensity and urgency. */
  severity: number;
  /** Planetary consequences of full resolution. */
  resolution: VarDelta;
  /** Permanent baseline movement from resolution (permanent damage stays). */
  baseline: VarDelta;
  objectives: CrisisObjective[];
  /** Which spires must be functional before this crisis can be attempted. */
  requiresSpires: number;
  /** Domain points awarded on resolution. */
  reward: { domain: Domain; points: number };
  /** Historical context lines — archival, no named characters. */
  archive: string[];
}

export const CRISIS_NODES: readonly CrisisNodeDef[] = [
  {
    id: 'ORBITAL_SHADOW_CASCADE',
    name: 'Orbital Shadow Cascade',
    headline: 'A derelict belt is shading the hemisphere.',
    brief:
      'War-era orbital wreckage has consolidated into a dense belt over the northern reach. It blocks incoming stellar flux, cools the basins, and every capture manoeuvre risks a collision cascade. The skiff must thin the belt and re-seat the surviving hulls into stable, non-intersecting corridors.',
    lat: 41,
    lon: 12,
    domain: 'ORBIT',
    vehicle: 'ORBITAL_SKIFF',
    biomes: ['SHATTERED_BASALT', 'VITRIFIED_BASIN'],
    severity: 0.88,
    resolution: {
      orbitalSafety: 0.26,
      orbitalOcclusion: -0.30,
      stellarIrradiance: 0.20,
      atmosphereStability: 0.05,
    },
    baseline: {
      orbitalSafety: 0.10,
      orbitalOcclusion: -0.14,
      stellarIrradiance: 0.08,
    },
    objectives: [
      { id: 'capture', text: 'Capture and tether derelict hulls into the stabilised corridor', target: 6 },
      { id: 'corridor', text: 'Establish a clear transit corridor below 12% local density', target: 1 },
    ],
    requiresSpires: 0,
    reward: { domain: 'ORBIT', points: 3 },
    archive: [
      'Conjunction cascade logged by the surviving Administration traffic desk.',
      'Wreckage fields dated to the last attritional decade of the war.',
    ],
  },
  {
    id: 'GLASS_BASIN_SUPPLY_FAILURE',
    name: 'Glass Basin Supply Failure',
    headline: 'The settlement beyond the glass cannot be reached.',
    brief:
      'A habitation cluster survives past a vitrified basin whose surface cannot carry ordinary heavy transport. Ground bearing pressure is the limiting constraint, not distance. The land-train must be configured and driven across the glass with the load distributed, or the route must be re-graded entirely.',
    lat: -18,
    lon: -142,
    domain: 'SURFACE',
    vehicle: 'LAND_TRAIN',
    biomes: ['VITRIFIED_BASIN', 'SALT_FLAT', 'REMNANT_SOIL'],
    severity: 0.79,
    resolution: {
      logisticsIntegrity: 0.28,
      settlementSafety: 0.24,
      soilViability: 0.08,
    },
    baseline: {
      logisticsIntegrity: 0.12,
      settlementSafety: 0.10,
    },
    objectives: [
      { id: 'deliver', text: 'Deliver habitat modules to the basin-edge depot', target: 3 },
      { id: 'route', text: 'Establish a graded route with predicted ground failure below threshold', target: 1 },
    ],
    requiresSpires: 1,
    reward: { domain: 'SURFACE', points: 3 },
    archive: [
      'Vitrified basin formation attributed to war-era terraforming countermeasures.',
      'Route surveys record repeated bogging events on unsupported glass.',
    ],
  },
  {
    id: 'GEOTHERMAL_RUNAWAY',
    name: 'Geothermal Runaway',
    headline: 'A buried intervention is building pressure.',
    brief:
      'A war-era subsurface channel has become an unstable heat conduit. Pressure is loading the surrounding faults. The strata-crawler must descend, install heat-exchange infrastructure to bleed the channel, and get out before the surrounding strata release. Do not fracture the sealed layers while doing it.',
    lat: 8,
    lon: 64,
    domain: 'SUBSURFACE',
    vehicle: 'STRATA_CRAWLER',
    biomes: ['CRUSTAL_VENT', 'FOSSIL_STRATA', 'SHATTERED_BASALT'],
    severity: 0.92,
    resolution: {
      geothermalPressure: -0.34,
      tectonicShear: -0.22,
      powerAvailability: 0.20,
    },
    baseline: {
      geothermalPressure: -0.16,
      powerAvailability: 0.10,
    },
    objectives: [
      { id: 'descend', text: 'Reach the sealed channel at depth', target: 1 },
      { id: 'exchanger', text: 'Install and commission heat-exchange infrastructure', target: 2 },
      { id: 'coolant', text: 'Keep cutter temperature inside limits during installation', target: 1 },
    ],
    requiresSpires: 1,
    reward: { domain: 'SUBSURFACE', points: 4 },
    archive: [
      'Buried intervention predates the local collapse of the terraforming programme.',
      'Seismic records show slow pressure accumulation rather than discrete events.',
    ],
  },
  {
    id: 'ATMOSPHERIC_SHEAR_CORRIDOR',
    name: 'Atmospheric Shear Corridor',
    headline: 'A damaged weather system is tearing the sky.',
    brief:
      'A fractured regional processor produces violent vertical flow across a corridor the settlement network depends on. The glider must fly the corridor, map the shear, and seed sensor packages inside the moving system. Holding forward will not work; the atmosphere has to be read.',
    lat: -34,
    lon: 27,
    domain: 'SKY',
    vehicle: 'GLIDER',
    biomes: ['TOXIC_VEIL', 'REMNANT_SOIL'],
    severity: 0.74,
    resolution: {
      atmosphereStability: 0.26,
      atmosphereToxicity: -0.18,
      settlementSafety: 0.14,
      logisticsIntegrity: 0.06,
    },
    baseline: {
      atmosphereStability: 0.12,
    },
    objectives: [
      { id: 'map', text: 'Map shear inside the corridor', target: 1 },
      { id: 'seed', text: 'Seed sensor packages into mapped cells', target: 5 },
      { id: 'thermal', text: 'Ride a thermal to calibration altitude without stalling out', target: 1 },
    ],
    requiresSpires: 1,
    reward: { domain: 'SKY', points: 3 },
    archive: [
      'Processor failure recorded during the final countermeasure exchanges.',
      'Forecast confidence degraded for two decades afterwards.',
    ],
  },
  {
    id: 'HARMONIC_FAULT',
    name: 'Harmonic Fault',
    headline: 'Restored spires have drifted out of phase.',
    brief:
      'Several functioning acoustic spires are no longer phase-coherent. The interference is loading machinery and confusing the seismic survey. This is a diagnosis problem: inspect the infrastructure at several scales, find the physical system causing the drift, and correct it. It is not a sequence puzzle.',
    lat: 22,
    lon: -48,
    domain: 'HARMONIC',
    vehicle: 'ORBITAL_SKIFF',
    biomes: ['SHATTERED_BASALT', 'FOUNDRY_RUIN'],
    severity: 0.68,
    resolution: {
      harmonicCoherence: 0.22,
      tectonicShear: -0.12,
    },
    baseline: {
      harmonicCoherence: 0.10,
    },
    objectives: [
      { id: 'diagnose', text: 'Identify the interfering physical system', target: 1 },
      { id: 'correct', text: 'Correct the phase reference at each drifting spire', target: 3 },
    ],
    requiresSpires: 3,
    reward: { domain: 'HARMONIC', points: 4 },
    archive: [
      'Spire phase references derive from repurposed resonance infrastructure.',
      'Drift was first detected by distant machinery responding asynchronously.',
    ],
  },
  {
    id: 'LYRIBORIS_EXCAVATION',
    name: 'Deep Song Excavation',
    headline: 'A petrified resonance carrier is blocking the deep bore.',
    brief:
      'The deep bore to the sealed channel passes through the mineralised remains of a resonance carrier. The strata-crawler must excavate around it without destroying the critical geology that keeps the surrounding strata sealed. What is removed cannot be put back.',
    lat: -52,
    lon: 118,
    domain: 'SUBSURFACE',
    vehicle: 'STRATA_CRAWLER',
    biomes: ['FOSSIL_STRATA', 'GLASS_LATTICE', 'CRUSTAL_VENT'],
    severity: 0.85,
    resolution: {
      powerAvailability: 0.16,
      geothermalPressure: -0.14,
      harmonicCoherence: 0.08,
    },
    baseline: {
      powerAvailability: 0.08,
    },
    objectives: [
      { id: 'survey', text: 'Survey the petrified structure and mark critical geology', target: 1 },
      { id: 'bore', text: 'Bore a clear tunnel past the structure', target: 1 },
      { id: 'seal', text: 'Seal the bypass so surrounding strata stay confined', target: 1 },
    ],
    requiresSpires: 2,
    reward: { domain: 'SUBSURFACE', points: 4 },
    archive: [
      'Mineralised remains embedded in the crust, dated to the terraforming era.',
      'Resonance infrastructure was repurposed by survivors after the war.',
    ],
  },
  {
    id: 'FOUNDRY_RESONANCE',
    name: 'Foundry Resonance',
    headline: 'A self-expanding foundry zone is still converting wreckage.',
    brief:
      'An abandoned foundry zone continues to convert wreckage into structure, and its output is phase-locked to nothing. The land-train must deliver reactor components to stabilise the zone; the orbital skiff must clear the wreckage feeding it. The two jobs are one job.',
    lat: 63,
    lon: -77,
    domain: 'SURFACE',
    vehicle: 'LAND_TRAIN',
    biomes: ['FOUNDRY_RUIN', 'SHATTERED_BASALT', 'SALT_FLAT'],
    severity: 0.81,
    resolution: {
      logisticsIntegrity: 0.18,
      powerAvailability: 0.18,
      harmonicCoherence: 0.10,
      tectonicShear: -0.06,
    },
    baseline: {
      powerAvailability: 0.10,
      logisticsIntegrity: 0.08,
    },
    objectives: [
      { id: 'deliver', text: 'Deliver reactor components to the foundry stabiliser', target: 4 },
      { id: 'clear', text: 'Clear the wreckage feed', target: 1 },
    ],
    requiresSpires: 2,
    reward: { domain: 'SURFACE', points: 4 },
    archive: [
      'Foundry zones expanded through rubble and wreckage conversion.',
      'Survivors repurposed several zones as heavy-fabrication plants.',
    ],
  },
];

// ---------------------------------------------------------------------------
// ACOUSTIC SPIRES — the Terminus Harmonic network
// ---------------------------------------------------------------------------

export interface SpireDef {
  id: number;
  name: string;
  lat: number;
  lon: number;
  /** Base frequency in Hz. Phase relationships define coherence. */
  baseFreq: number;
  /** Structural height in metres. */
  height: number;
  /** Local biome. */
  biome: BiomeId;
  /** Designation of the buried foundation the spire is seated on. */
  foundation: string;
}

export const ACOUSTIC_SPIRES: readonly SpireDef[] = [
  { id: 0, name: 'ARK-01 Kestrel Socket', lat: 41, lon: 12, baseFreq: 41.2, height: 1180, biome: 'SHATTERED_BASALT', foundation: 'Vitrified sill' },
  { id: 1, name: 'ARK-02 Halyard', lat: 8, lon: 64, baseFreq: 44.6, height: 1420, biome: 'CRUSTAL_VENT', foundation: 'Sealed heat channel' },
  { id: 2, name: 'ARK-03 Sallow', lat: -18, lon: -142, baseFreq: 38.9, height: 960, biome: 'VITRIFIED_BASIN', foundation: 'Glass sill' },
  { id: 3, name: 'ARK-04 Verge', lat: -34, lon: 27, baseFreq: 47.3, height: 1310, biome: 'TOXIC_VEIL', foundation: 'Fractured processor' },
  { id: 4, name: 'ARK-05 Long Rest', lat: 22, lon: -48, baseFreq: 42.1, height: 1540, biome: 'FOUNDRY_RUIN', foundation: 'Foundry slab' },
  { id: 5, name: 'ARK-06 Cinder Post', lat: -52, lon: 118, baseFreq: 51.8, height: 1680, biome: 'FOSSIL_STRATA', foundation: 'Petrified resonance carrier' },
  { id: 6, name: 'ARK-07 Salt Crown', lat: 63, lon: -77, baseFreq: 36.4, height: 1240, biome: 'SALT_FLAT', foundation: 'Compacted halite' },
  { id: 7, name: 'ARK-08 Thresh', lat: 4, lon: 168, baseFreq: 49.2, height: 1090, biome: 'SHATTERED_BASALT', foundation: 'Fault toe' },
  { id: 8, name: 'ARK-09 Mournline', lat: -8, lon: -64, baseFreq: 40.7, height: 1360, biome: 'GLASS_LATTICE', foundation: 'Optical lattice' },
  { id: 9, name: 'ARK-10 Quench', lat: 30, lon: 92, baseFreq: 45.5, height: 1210, biome: 'PETRIFIED_MEGAFLORA', foundation: 'Petrified root mass' },
  { id: 10, name: 'ARK-11 Far Ledger', lat: 55, lon: 32, baseFreq: 43.8, height: 1470, biome: 'REMNANT_SOIL', foundation: 'Buried archive husk' },
  { id: 11, name: 'ARK-12 Terminus', lat: -27, lon: 4, baseFreq: 55.0, height: 2100, biome: 'FOUNDRY_RUIN', foundation: 'Consolidated command sill' },
];

// ---------------------------------------------------------------------------
// SETTLEMENTS
// ---------------------------------------------------------------------------

export interface SettlementDef {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Population in thousands (survivors, not a resource pool). */
  populationK: number;
  /** Current viability 0..1. */
  viability: number;
  biome: BiomeId;
}

export const SETTLEMENTS: readonly SettlementDef[] = [
  { id: 'ST-01', name: 'Basin Edge', lat: -14, lon: -138, populationK: 41, viability: 0.31, biome: 'VITRIFIED_BASIN' },
  { id: 'ST-02', name: 'Kestrel Yard', lat: 44, lon: 16, populationK: 63, viability: 0.38, biome: 'SHATTERED_BASALT' },
  { id: 'ST-03', name: 'Channel Mouth', lat: 11, lon: 68, populationK: 28, viability: 0.26, biome: 'CRUSTAL_VENT' },
  { id: 'ST-04', name: 'Shear Line', lat: -31, lon: 24, populationK: 19, viability: 0.22, biome: 'TOXIC_VEIL' },
  { id: 'ST-05', name: 'Long Rest', lat: 24, lon: -45, populationK: 35, viability: 0.33, biome: 'FOUNDRY_RUIN' },
  { id: 'ST-06', name: 'Salt Crown', lat: 61, lon: -74, populationK: 12, viability: 0.18, biome: 'SALT_FLAT' },
  { id: 'ST-07', name: 'Deep Song Camp', lat: -49, lon: 115, populationK: 8, viability: 0.15, biome: 'FOSSIL_STRATA' },
  { id: 'ST-08', name: 'Terminus Landing', lat: -27, lon: 4, populationK: 22, viability: 0.29, biome: 'FOUNDRY_RUIN' },
];

// ---------------------------------------------------------------------------
// DOMAIN PROGRESSION
// ---------------------------------------------------------------------------

export interface DomainInfo {
  id: Domain;
  label: string;
  blurb: string;
  /** Vehicle modules unlocked at each domain level. */
  unlocks: { level: number; module: string; note: string }[];
}

export const DOMAINS: readonly DomainInfo[] = [
  {
    id: 'ORBIT',
    label: 'Orbit',
    blurb: 'Debris control, orbital construction, solar exposure, satellite infrastructure.',
    unlocks: [
      { level: 1, module: 'Tether Winch', note: 'Capture and tow derelict hulls.' },
      { level: 2, module: 'Rendezvous Assist', note: 'Automatic relative-velocity matching.' },
      { level: 3, module: 'Corridor Beacon', note: 'Deployable transit-corridor markers.' },
      { level: 4, module: 'Orbital Fabricator', note: 'Assemble structure from salvaged sections.' },
    ],
  },
  {
    id: 'SKY',
    label: 'Sky',
    blurb: 'Weather, atmospheric chemistry, high-altitude observation.',
    unlocks: [
      { level: 1, module: 'Sensor Dispenser', note: 'Release atmospheric sensor packages.' },
      { level: 2, module: 'Thermal Reader', note: 'Visualise lift and sink in the air mass.' },
      { level: 3, module: 'Sampler Winch', note: 'Recover high-altitude chemistry samples.' },
      { level: 4, module: 'Calibration Mast', note: 'Lock to high-altitude infrastructure.' },
    ],
  },
  {
    id: 'SURFACE',
    label: 'Surface',
    blurb: 'Logistics, settlements, agriculture, infrastructure.',
    unlocks: [
      { level: 1, module: 'Bogie Load Balancer', note: 'Distribute cargo across powered bogies.' },
      { level: 2, module: 'Route Grader', note: 'Prepare ground ahead of the consist.' },
      { level: 3, module: 'Depot Link', note: 'Automated resupply scheduling.' },
      { level: 4, module: 'Habitat Tender', note: 'Deploy and commission habitat modules.' },
    ],
  },
  {
    id: 'SUBSURFACE',
    label: 'Subsurface',
    blurb: 'Geothermal systems, geology, tunnelling, tectonic stabilisation.',
    unlocks: [
      { level: 1, module: 'Coolant Loop', note: 'Sustained cutter operation in hot rock.' },
      { level: 2, module: 'Strata Sonde', note: 'Read the layer stack ahead of the cutter.' },
      { level: 3, module: 'Exchanger Mount', note: 'Install heat-exchange infrastructure.' },
      { level: 4, module: 'Seal Injector', note: 'Confine disturbed strata behind the crawler.' },
    ],
  },
  {
    id: 'HARMONIC',
    label: 'Harmonic',
    blurb: 'Acoustic spires, phase coherence, planetary resonance engineering.',
    unlocks: [
      { level: 1, module: 'Phase Reference', note: 'Lock a spire to the network reference.' },
      { level: 2, module: 'Interference Mapper', note: 'Locate the physical cause of phase drift.' },
      { level: 3, module: 'Deep Survey', note: 'Map subsurface structure from the surface.' },
      { level: 4, module: 'Terminus Harmonic', note: 'Planet-spanning phase-coherent network.' },
    ],
  },
];

export const DOMAIN_LABEL: Record<Domain, string> = {
  ORBIT: 'Orbit',
  SKY: 'Sky',
  SURFACE: 'Surface',
  SUBSURFACE: 'Subsurface',
  HARMONIC: 'Harmonic',
};

// ---------------------------------------------------------------------------
// PROVISIONAL-LORE LEDGER (game-local, explicitly not canon)
// ---------------------------------------------------------------------------

/**
 * Every proper noun below is game-local. It is recorded here so a canon review
 * can trivially confirm that nothing was smuggled into Starsilk canon.
 */
export const GAME_LOCAL_INVENTIONS = {
  planet: 'unnamed remnant world (survey designation only)',
  settlements: SETTLEMENTS.map((s) => s.name),
  spires: ACOUSTIC_SPIRES.map((s) => s.name),
  crises: CRISIS_NODES.map((c) => c.name),
  terms: [
    'Command Lattice',
    'Terminus Harmonic',
    'Acoustic Spire',
    'Orbital Skiff',
    'Land-Train',
    'Strata-Crawler',
    'Atmospheric Glider',
    'Remnant Survey 0-ARK',
  ],
  note:
    'No named canon character appears, is recorded, voiced, or recreated. Blood Rings and the Siege Wall appear only as archival/navigation references, never as local planetary features.',
} as const;

/**
 * Canon-safe archival strings. These are the ONLY ways historical atrocity
 * artifacts are permitted to surface in the game.
 */
export const ARCHIVAL_REFERENCES = {
  bloodRings: [
    'Archival overlay: vitrified biospheric structures recorded in orbit around fallen worlds. Not present in this system.',
    'Navigation record: ring-trajectory data retained for hazard classification only.',
    'Memorial dataset: population and biomass counts, unrecoverable.',
  ],
  siegeWall: [
    'Navigation exclusion: heliocide containment lattice. Absence, not structure. Outside this survey volume.',
    'Archival sky plate: starless swath. No physical wall, no lattice rendered in local space.',
  ],
  starsilk: [
    'Starsilk is a programmable cosmological substrate. It is not a fuel, not a power source, and not mined.',
    'Pulling silk from a star collapses the star. It is not harvestable.',
    'Azure traces in this world are sealed containment diagnostics and legacy Macro residue, not raw material.',
  ],
} as const;

/**
 * Canon constants restated so the runtime can assert against them.
 *
 * Death is final. No consciousness survives in machinery, and no named canon
 * character is reproduced, recorded, voiced or recreated anywhere in this game.
 */
export const CANON_FACTS = {
  bloodEclipseWarYears: 170,
  deathIsFinal: true,
  noActiveDrakken: true,
  noNamedCharacters: true,
} as const;
