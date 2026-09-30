import { describe, expect, it } from 'vitest';
import {
  ACOUSTIC_SPIRES,
  ARCHIVAL_REFERENCES,
  CANON_FACTS,
  CRISIS_NODES,
  DOMAINS,
  GAME_LOCAL_INVENTIONS,
  MATERIALS,
  SETTLEMENTS,
  WORLD_SEED,
} from '../src/state/world';
import { SectorField, TunnelLattice } from '../src/sector/field';
import { couplingRules, PlanetaryState } from '../src/state/planetary';

describe('world content', () => {
  it('is deterministic from the world seed', () => {
    const params = {
      seed: WORLD_SEED, lat: 12, lon: 34, radius: 1000, biome: 'SHATTERED_BASALT' as const,
      geothermalPressure: 0.5, tectonicShear: 0.4, atmosphereToxicity: 0.7, soilViability: 0.2,
      turbulence: 0.3,
    };
    const a = new SectorField(params);
    const b = new SectorField(params);
    for (let i = 0; i < 200; i++) {
      const x = (i * 37) % 900 - 450;
      const z = (i * 53) % 900 - 450;
      expect(a.elevation(x, z)).toBe(b.elevation(x, z));
      expect(a.color(x, z, [0, 0, 0])).toEqual(b.color(x, z, [0, 0, 0]));
    }
  });

  it('gives every biome a materially different material profile', () => {
    const ids = Object.keys(MATERIALS);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const id of ids) {
      const m = MATERIALS[id as keyof typeof MATERIALS];
      expect(m.hardness).toBeGreaterThan(0);
      expect(m.friction).toBeGreaterThan(0);
      expect(m.bearingCapacity).toBeGreaterThan(0);
    }
    expect(MATERIALS.VITRIFIED_BASIN.bearingCapacity).toBeLessThan(MATERIALS.FOUNDRY_RUIN.bearingCapacity);
    expect(MATERIALS.SALT_FLAT.friction).toBeLessThan(MATERIALS.SHATTERED_BASALT.friction);
  });

  it('covers all four vehicle types and all five domains in the campaign', () => {
    expect(new Set(CRISIS_NODES.map((c) => c.vehicle)).size).toBe(4);
    const domains = new Set(CRISIS_NODES.map((c) => c.domain));
    for (const d of ['ORBIT', 'SKY', 'SURFACE', 'SUBSURFACE', 'HARMONIC'] as const) {
      expect(domains.has(d)).toBe(true);
    }
    expect(DOMAINS).toHaveLength(5);
  });

  it('gives every crisis a systemic, physically justified consequence table', () => {
    for (const c of CRISIS_NODES) {
      expect(c.objectives.length).toBeGreaterThan(0);
      expect(Object.keys(c.resolution).length).toBeGreaterThan(0);
      expect(c.brief.length).toBeGreaterThan(80);
      expect(c.severity).toBeGreaterThan(0);
      expect(c.severity).toBeLessThanOrEqual(1);
      expect(c.archive.length).toBeGreaterThan(0);
    }
  });

  it('encodes genuine cross-system tension', () => {
    const shadow = CRISIS_NODES.find((c) => c.id === 'ORBITAL_SHADOW_CASCADE')!;
    const rules = couplingRules();
    const loading = rules.find((r) => r.from === 'stellarIrradiance' && r.to === 'geothermalPressure');
    expect(loading).toBeTruthy();
    expect(loading!.gain).toBeGreaterThan(0);
    // Clearing the belt improves irradiance but must therefore load the crust.
    const p = new PlanetaryState(WORLD_SEED);
    const before = p.vars.geothermalPressure;
    p.applyEffect({ label: 't', immediate: { stellarIrradiance: 0.3 }, origin: 'test' });
    for (let i = 0; i < 300; i++) p.step(0.25);
    expect(p.vars.geothermalPressure).toBeGreaterThan(before);
    expect(shadow.resolution.orbitalSafety).toBeGreaterThan(0);
  });

  it('places twelve acoustic spires with distinct base frequencies', () => {
    expect(ACOUSTIC_SPIRES).toHaveLength(12);
    expect(new Set(ACOUSTIC_SPIRES.map((s) => s.baseFreq)).size).toBe(12);
    for (const s of ACOUSTIC_SPIRES) {
      expect(s.height).toBeGreaterThan(500);
      expect(Math.abs(s.lat)).toBeLessThanOrEqual(90);
      expect(s.baseFreq).toBeGreaterThan(20);
      expect(s.baseFreq).toBeLessThan(200);
    }
  });

  it('places settlements that are surviving, not thriving', () => {
    expect(SETTLEMENTS.length).toBeGreaterThanOrEqual(6);
    for (const s of SETTLEMENTS) {
      expect(s.viability).toBeGreaterThan(0);
      expect(s.viability).toBeLessThan(0.6);
    }
  });

  it('restates canon constants', () => {
    expect(CANON_FACTS.bloodEclipseWarYears).toBe(170);
    expect(CANON_FACTS.deathIsFinal).toBe(true);
    expect(CANON_FACTS.noActiveDrakken).toBe(true);
    expect(CANON_FACTS.noNamedCharacters).toBe(true);
  });

  it('provides archival-only framing for atrocity artifacts', () => {
    expect(ARCHIVAL_REFERENCES.bloodRings.join(' ')).toMatch(/not present|hazard|memorial/i);
    expect(ARCHIVAL_REFERENCES.siegeWall.join(' ')).toMatch(/absence|exclusion|not a physical wall/i);
    expect(ARCHIVAL_REFERENCES.starsilk.join(' ')).toMatch(/not a fuel/i);
  });

  it('records game-local inventions so canon review is trivial', () => {
    expect(GAME_LOCAL_INVENTIONS.settlements.length).toBe(SETTLEMENTS.length);
    expect(GAME_LOCAL_INVENTIONS.spires.length).toBe(ACOUSTIC_SPIRES.length);
    expect(GAME_LOCAL_INVENTIONS.crises.length).toBe(CRISIS_NODES.length);
    expect(GAME_LOCAL_INVENTIONS.note).toMatch(/No named canon character/);
  });
});

describe('TunnelLattice (bounded deformation)', () => {
  it('carves, reports, serialises and restores', () => {
    const l = new TunnelLattice(4, 256, 120);
    l.configure(0, 0, 50);
    expect(l.carvedCount).toBe(0);
    expect(l.excavate(0, 40, 0, 3)).toBeGreaterThan(0);
    expect(l.isVoid(0, 40, 0)).toBe(true);
    expect(l.isVoid(0, 40, 500)).toBe(false);
    const data = l.serialize();
    expect(data.length).toBeGreaterThan(0);
    const l2 = new TunnelLattice(4, 256, 120);
    l2.configure(0, 0, 50);
    l2.restore(data);
    expect(l2.carvedCount).toBe(l.carvedCount);
    expect(l2.isVoid(0, 40, 0)).toBe(true);
  });

  it('reports instability rising with nearby voids and depth', () => {
    const l = new TunnelLattice(4, 256, 120);
    l.configure(0, 0, 50);
    const shallowStable = l.instability(0, 45, 0);
    for (let i = 0; i < 40; i++) l.excavate(i * 3, 40, 0, 3);
    expect(l.instability(0, 40, 0)).toBeGreaterThan(shallowStable);
    expect(l.instability(0, 5, 0)).toBeGreaterThan(shallowStable);
  });

  it('scales rock temperature with depth and geothermal pressure', () => {
    const l = new TunnelLattice(4, 256, 200);
    l.configure(0, 0, 100);
    expect(l.rockTemperature(100, 0)).toBeLessThan(l.rockTemperature(0, 0));
    expect(l.rockTemperature(0, 0.9)).toBeGreaterThan(l.rockTemperature(0, 0.1));
  });

  it('backfills cells when a bypass is sealed', () => {
    const l = new TunnelLattice(4, 256, 120);
    l.configure(0, 0, 50);
    l.excavate(0, 40, 0, 4);
    const before = l.carvedCount;
    expect(l.backfill(0, 40, 0, 4)).toBeGreaterThan(0);
    expect(l.carvedCount).toBeLessThan(before);
    expect(l.isVoid(0, 40, 0)).toBe(false);
  });

  it('round-trips an empty lattice', () => {
    const l = new TunnelLattice();
    expect(l.serialize()).toBe('');
    l.restore('');
    expect(l.carvedCount).toBe(0);
  });
});

describe('sector field', () => {
  const field = new SectorField({
    seed: 1, lat: 0, lon: 0, radius: 1000, biome: 'VITRIFIED_BASIN',
    geothermalPressure: 0.8, tectonicShear: 0.5, atmosphereToxicity: 0.9, soilViability: 0.1,
    turbulence: 0.2,
  });

  it('produces continuous terrain', () => {
    let maxJump = 0;
    for (let i = 0; i < 500; i++) {
      const x = i * 1.7;
      maxJump = Math.max(maxJump, Math.abs(field.elevation(x + 0.05, 0) - field.elevation(x, 0)));
    }
    expect(maxJump).toBeLessThan(2);
  });

  it('flattens vitrified basins relative to basalt', () => {
    const basalt = new SectorField({
      seed: 1, lat: 0, lon: 0, radius: 1000, biome: 'SHATTERED_BASALT',
      geothermalPressure: 0.5, tectonicShear: 0.5, atmosphereToxicity: 0.5, soilViability: 0.2,
      turbulence: 0.2,
    });
    let a = 0, b = 0;
    for (let i = 0; i < 300; i++) {
      const x = (i * 61) % 900 - 450;
      const z = (i * 97) % 900 - 450;
      a += Math.abs(field.elevation(x, z));
      b += Math.abs(basalt.elevation(x, z));
    }
    expect(a).toBeLessThan(b);
  });

  it('reports bearing capacity that penalises steep ground', () => {
    let sum = 0, count = 0;
    for (let i = 0; i < 400; i++) {
      const x = (i * 71) % 800 - 400;
      const z = (i * 113) % 800 - 400;
      if (field.slope(x, z) > 0.3) { sum += field.bearing(x, z); count++; }
    }
    expect(count).toBeGreaterThan(0);
    expect(sum / count).toBeLessThan(0.5);
  });

  it('exposes a biome label for HUD readouts', () => {
    expect(field.materialLabel).toBe('Vitrified Basin');
  });
});
