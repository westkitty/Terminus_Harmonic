import { describe, expect, it } from 'vitest';
import {
  PLANETARY_VARS,
  PlanetaryState,
  couplingRules,
  type PlanetaryVar,
} from '../src/state/planetary';

const SEED = 0x7e2a91c3;

function mk(): PlanetaryState {
  return new PlanetaryState(SEED);
}

describe('PlanetaryState', () => {
  it('exposes exactly the fourteen authoritative variables', () => {
    expect(PLANETARY_VARS).toHaveLength(14);
    expect(new Set(PLANETARY_VARS).size).toBe(14);
  });

  it('is deterministic for a given world seed', () => {
    const a = mk();
    const b = mk();
    for (const v of PLANETARY_VARS) expect(a.vars[v]).toBeCloseTo(b.vars[v], 12);
  });

  it('produces a wounded, non-pristine baseline', () => {
    const p = mk();
    // The remnant world must not start healthy.
    expect(p.globalHealth()).toBeLessThan(0.45);
    expect(p.vars.orbitalOcclusion).toBeGreaterThan(0.6);
    expect(p.vars.atmosphereToxicity).toBeGreaterThan(0.6);
    expect(p.vars.harmonicCoherence).toBeLessThan(0.2);
  });

  it('keeps every value normalised after arbitrary effects and steps', () => {
    const p = mk();
    for (let i = 0; i < 500; i++) {
      const delta: Partial<Record<PlanetaryVar, number>> = {};
      for (const v of PLANETARY_VARS) delta[v] = (Math.sin(i * 0.37 + v.length) * 0.6);
      p.applyEffect({ label: 'fuzz', immediate: delta, origin: 'test' });
      p.step(0.1);
    }
    for (const v of PLANETARY_VARS) {
      expect(p.vars[v]).toBeGreaterThanOrEqual(0);
      expect(p.vars[v]).toBeLessThanOrEqual(1);
    }
  });

  it('propagates a debris-clearing intervention into climate and crops', () => {
    const p = mk();
    const before = { ...p.vars };
    p.applyEffect({
      label: 'debris belt thinned',
      immediate: { orbitalOcclusion: -0.3, stellarIrradiance: 0.2 },
      origin: 'test',
    });
    for (let i = 0; i < 400; i++) p.step(0.25);

    // Direct effects.
    expect(p.vars.orbitalOcclusion).toBeLessThan(before.orbitalOcclusion);
    expect(p.vars.stellarIrradiance).toBeGreaterThan(before.stellarIrradiance);
    // Coupled effects — these are the ones that make the world feel connected.
    expect(p.vars.soilViability).toBeGreaterThan(before.soilViability);
    expect(p.vars.biosphereViability).toBeGreaterThan(before.biosphereViability);
    // And the tension: more flux loads the crust.
    expect(p.vars.geothermalPressure).toBeGreaterThan(before.geothermalPressure);
  });

  it('makes an intervention that helps one system destabilise another', () => {
    const p = mk();
    const before = { ...p.vars };
    // Damping tectonic shear via the harmonic network also reduces geothermal
    // venting pressure relief... and increases power availability.
    p.applyEffect({
      label: 'spires phase-locked',
      immediate: { harmonicCoherence: 0.35 },
      origin: 'test',
    });
    for (let i = 0; i < 600; i++) p.step(0.25);
    expect(p.vars.tectonicShear).toBeLessThan(before.tectonicShear);
    expect(p.vars.powerAvailability).toBeGreaterThan(before.powerAvailability);
    expect(p.vars.settlementSafety).toBeGreaterThan(before.settlementSafety);
  });

  it('applies a permanent baseline shift that survives relaxation', () => {
    const p = mk();
    const startBaseline = p.baselines.soilViability;
    p.raiseBaseline({ soilViability: 0.15 });
    expect(p.baselines.soilViability).toBeCloseTo(startBaseline + 0.15, 6);
    for (let i = 0; i < 2000; i++) p.step(0.5);
    // The system relaxes toward the raised baseline, not the old one.
    expect(p.vars.soilViability).toBeGreaterThan(startBaseline);
  });

  it('forecasts a candidate intervention without mutating state', () => {
    const p = mk();
    const snapshot = { ...p.vars };
    const f = p.forecast({ orbitalOcclusion: -0.3 }, 240);
    expect(f.vars.orbitalOcclusion).toBeLessThan(snapshot.orbitalOcclusion);
    expect(f.vars.stellarIrradiance).toBeGreaterThan(snapshot.stellarIrradiance);
    for (const v of PLANETARY_VARS) expect(p.vars[v]).toBeCloseTo(snapshot[v], 12);
    expect(f.chain.length).toBeGreaterThan(0);
  });

  it('reports a chain of coupling rules for a large deviation', () => {
    const p = mk();
    p.vars.orbitalOcclusion = 0.95;
    const f = p.forecast({ orbitalOcclusion: -0.5 }, 300);
    const text = f.chain.join(' ');
    expect(text).toContain('Orbital Occlusion');
    expect(text.toLowerCase()).toContain('stellar');
  });

  it('survives a save/load round trip exactly', () => {
    const p = mk();
    p.applyEffect({ label: 'x', immediate: { powerAvailability: 0.2 }, origin: 'test' });
    for (let i = 0; i < 50; i++) p.step(0.2);
    const snap = p.snapshot();
    const q = mk();
    q.restore(snap);
    for (const v of PLANETARY_VARS) expect(q.vars[v]).toBeCloseTo(p.vars[v], 12);
    expect(q.baselines).toEqual(p.baselines);
  });

  it('tolerates a partial/corrupt snapshot', () => {
    const p = mk();
    expect(() => p.restore({ vars: { powerAvailability: Number.NaN } } as never)).not.toThrow();
    expect(() => p.restore({} as never)).not.toThrow();
    expect(() => p.restore(null as never)).not.toThrow();
    for (const v of PLANETARY_VARS) {
      expect(Number.isFinite(p.vars[v])).toBe(true);
      expect(p.vars[v]).toBeGreaterThanOrEqual(0);
      expect(p.vars[v]).toBeLessThanOrEqual(1);
    }
  });

  it('has a coupling table where every rule references real variables', () => {
    for (const r of couplingRules()) {
      expect(PLANETARY_VARS).toContain(r.from);
      expect(PLANETARY_VARS).toContain(r.to);
      expect(r.why.length).toBeGreaterThan(8);
      expect(Number.isFinite(r.gain)).toBe(true);
    }
  });

  it('formats physical readouts', () => {
    expect(PlanetaryState.readout('stellarIrradiance', 1)).toContain('W/m');
    expect(PlanetaryState.readout('geothermalPressure', 1)).toContain('MPa');
    expect(PlanetaryState.readout('harmonicCoherence', 1)).toContain('φ');
  });
});
