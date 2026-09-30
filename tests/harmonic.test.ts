import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { World } from '../src/core/ecs';
import { HarmonicSystem, type SystemContext } from '../src/systems/systems';
import { PlanetaryState } from '../src/state/planetary';
import { WORLD_SEED } from '../src/state/world';
import type { SpireRecord } from '../src/state/save';

const bus = new EventBus();
const world = new World();
const ctx: SystemContext = { dt: 1 / 60, elapsed: 0, frame: 0, world, bus };

function spires(functional: number, total = 12, repairs = 1): SpireRecord[] {
  return Array.from({ length: total }, (_, i) => ({
    id: i,
    functional: i < functional,
    phase: i * 30,
    repairs: i < functional ? repairs : 0,
    seated: true,
  }));
}

describe('HarmonicSystem (Terminus Harmonic)', () => {
  it('has zero coherence with no functional spires', () => {
    const h = new HarmonicSystem(new PlanetaryState(WORLD_SEED), spires(0));
    expect(h.coherence).toBe(0);
  });

  it('grows coherence as spires come online', () => {
    const p = new PlanetaryState(WORLD_SEED);
    const values: number[] = [];
    for (const n of [1, 4, 8, 12]) {
      const h = new HarmonicSystem(p, spires(n));
      for (let i = 0; i < 240; i++) h.update(ctx);
      values.push(h.coherence);
    }
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values[values.length - 1]).toBeLessThanOrEqual(1);
  });

  it('rewards phase agreement: aligned spires beat scattered ones', () => {
    const p = new PlanetaryState(WORLD_SEED);
    const scattered = spires(6).map((s) => ({ ...s, phase: (s.id * 67) % 360 }));
    const aligned = spires(6).map((s) => ({ ...s, phase: 0 }));
    const a = new HarmonicSystem(p, scattered);
    const b = new HarmonicSystem(p, aligned);
    for (let i = 0; i < 240; i++) { a.update(ctx); b.update(ctx); }
    expect(b.coherence).toBeGreaterThan(a.coherence);
  });

  it('feeds coherence back into the authoritative planetary state', () => {
    const p = new PlanetaryState(WORLD_SEED);
    const before = p.vars.harmonicCoherence;
    const h = new HarmonicSystem(p, spires(12));
    for (let i = 0; i < 240; i++) h.update(ctx);
    expect(p.vars.harmonicCoherence).toBeGreaterThan(before);
  });

  it('emits an audible pulse whose energy rises with coherence', () => {
    const p = new PlanetaryState(WORLD_SEED);
    let early = 0;
    let late = 0;
    bus.on('harmonic:phase', (e) => {
      const energy = (e as { energy: number }).energy;
      if (early === 0) early = energy;
      late = energy;
    });
    const h = new HarmonicSystem(p, spires(12));
    for (let i = 0; i < 600; i++) h.update({ ...ctx, elapsed: i / 60 });
    expect(late).toBeGreaterThan(early);
  });

  it('locks a restored spire onto the network reference', () => {
    const p = new PlanetaryState(WORLD_SEED);
    const list = spires(2);
    const h = new HarmonicSystem(p, list);
    const before = h.coherence;
    list[5].functional = true;
    list[5].repairs = 2;
    h.lockSpire(5, 2);
    expect(list[5].repairs).toBe(4);
    for (let i = 0; i < 240; i++) h.update(ctx);
    expect(h.coherence).toBeGreaterThan(before);
  });

  it('keeps coherence bounded and stable over a long run', () => {
    const p = new PlanetaryState(WORLD_SEED);
    const h = new HarmonicSystem(p, spires(12));
    for (let i = 0; i < 3000; i++) h.update({ ...ctx, elapsed: i / 60 });
    expect(h.coherence).toBeGreaterThan(0.5);
    expect(h.coherence).toBeLessThanOrEqual(1);
    expect(p.vars.harmonicCoherence).toBeLessThanOrEqual(1);
  });

  it('does nothing at all when dt is zero', () => {
    const p = new PlanetaryState(WORLD_SEED);
    const h = new HarmonicSystem(p, spires(6));
    const before = h.coherence;
    const phases = [...h.phases];
    h.update({ ...ctx, dt: 0 });
    expect(h.coherence).toBeCloseTo(before, 12);
    for (let i = 0; i < phases.length; i++) expect(h.phases[i]).toBe(phases[i]);
  });

  it('gates the Terminus Harmonic on network coverage, not just phase lock', () => {
    // Below the coverage floor the Harmonic cannot establish no matter how
    // perfectly the live spires agree — a small network is not the Harmonic.
    const small = new HarmonicSystem(new PlanetaryState(WORLD_SEED), spires(6));
    for (let i = 0; i < 3600; i++) small.update({ ...ctx, elapsed: i / 60 });
    expect(small.coverage).toBeCloseTo(0.5, 6);
    expect(small.phaseOrder).toBeGreaterThan(0.9);
    expect(small.established).toBe(false);

    // Past the floor it establishes, and servicing the spires gets it there
    // sooner than leaving them to drift.
    const framesToEstablish = (repairs: number): number => {
      const h = new HarmonicSystem(new PlanetaryState(WORLD_SEED), spires(9, 12, repairs));
      for (let i = 0; i < 3600; i++) {
        h.update({ ...ctx, elapsed: i / 60 });
        if (h.established) return i;
      }
      return -1;
    };
    const serviced = framesToEstablish(2);
    const drifting = framesToEstablish(0);
    expect(serviced).toBeGreaterThan(0);
    expect(drifting).toBeGreaterThan(serviced);
  });

  it('does not synchronise spires that have never been serviced', () => {
    // A freshly functional but unserviced spire wanders: the player has to go
    // and repair it before the network can hold a phase.
    const p = new PlanetaryState(WORLD_SEED);
    const list = spires(4, 12, 0);
    const h = new HarmonicSystem(p, list);
    for (let i = 0; i < 240; i++) h.update(ctx);
    expect(h.coherence).toBeLessThan(0.2);
  });
});
