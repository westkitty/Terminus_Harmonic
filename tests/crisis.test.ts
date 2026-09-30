import { describe, expect, it } from 'vitest';
import { CrisisController } from '../src/game/crisis';
import { PlanetaryState } from '../src/state/planetary';
import { CRISIS_NODES, WORLD_SEED } from '../src/state/world';

const NODE = CRISIS_NODES[0];

interface Applied {
  applied: Record<string, number>;
  baseline: Record<string, number>;
  points: number;
}

function setup() {
  const planetary = new PlanetaryState(WORLD_SEED);
  const crises = new CrisisController();
  const applied: Applied[] = [];
  // Mirrors Game.onCrisisResolved: partial slices arrive through the handler
  // (the controller has no state reference for them); the full effect and the
  // baseline shift are applied by resolve() itself.
  crises.setCompletionHandler((r) => {
    if (r.completion < 1 && Object.keys(r.applied).length) {
      planetary.applyEffect({ label: r.name, immediate: r.applied, origin: 'test' });
    }
    applied.push({ applied: r.applied, baseline: r.baseline, points: r.rewards.points });
  });
  return { planetary, crises, applied };
}

function completeAll(crises: CrisisController): void {
  const rt = crises.activeCrisis!;
  for (const o of rt.def.objectives) {
    for (let i = 0; i < o.target; i++) crises.report(o.id, 1);
  }
}

describe('CrisisController', () => {
  it('refuses progress on unknown or inactive objectives', () => {
    const { crises } = setup();
    expect(crises.report('nope')).toBe(false);
    expect(crises.activeCrisis).toBeNull();
  });

  it('gates crises behind a functional-spire prerequisite', () => {
    const { crises } = setup();
    const needs = Math.max(...CRISIS_NODES.map((c) => c.requiresSpires));
    crises.refreshAvailability(0);
    expect(crises.all().filter((r) => r.status === 'LOCKED').length).toBeGreaterThan(0);
    crises.refreshAvailability(needs);
    expect(crises.all().filter((r) => r.status === 'LOCKED')).toHaveLength(0);
  });

  it('applies a proportional slice of the effect as objectives complete', () => {
    const { planetary, crises, applied } = setup();
    const before = { ...planetary.vars };
    crises.begin(NODE.id);
    const objs = crises.activeCrisis!.def.objectives;
    for (let i = 0; i < objs[0].target; i++) {
      expect(crises.report(objs[0].id, 1)).toBe(i === objs[0].target - 1);
    }
    const frac = crises.completionFraction();
    expect(frac).toBeGreaterThan(0);
    expect(frac).toBeLessThan(1);
    const last = applied[applied.length - 1].applied;
    for (const k of Object.keys(NODE.resolution) as (keyof typeof NODE.resolution)[]) {
      expect(last[k] ?? 0).toBeCloseTo((NODE.resolution[k] ?? 0) * frac, 6);
    }
    const moved = Object.keys(NODE.resolution).some(
      (k) => Math.abs(planetary.vars[k as keyof typeof planetary.vars] - before[k as keyof typeof before]) > 1e-6,
    );
    expect(moved).toBe(true);
  });

  it('never applies more than the authored effect', () => {
    const { crises, applied } = setup();
    crises.begin(NODE.id);
    const first = crises.activeCrisis!.def.objectives[0];
    for (let i = 0; i < first.target + 10; i++) crises.report(first.id, 1);
    const last = applied[applied.length - 1].applied;
    for (const k of Object.keys(last)) {
      expect(Math.abs(last[k as keyof typeof last] ?? 0)).toBeLessThanOrEqual(
        Math.abs(NODE.resolution[k as keyof typeof NODE.resolution] ?? 0) + 1e-9,
      );
    }
    expect(crises.completionFraction()).toBeLessThan(1);
  });

  it('moves the baseline permanently on resolution and pays the reward', () => {
    const { planetary, crises, applied } = setup();
    const baseBefore = { ...planetary.baselines };
    crises.begin(NODE.id);
    expect(crises.isComplete()).toBe(false);
    expect(crises.resolve(planetary)).toBeNull();
    completeAll(crises);
    expect(crises.isComplete()).toBe(true);

    const report = crises.resolve(planetary)!;
    expect(report.completion).toBe(1);
    expect(report.rewards.points).toBeGreaterThan(0);
    for (const k of Object.keys(NODE.baseline) as (keyof typeof NODE.baseline)[]) {
      expect(planetary.baselines[k]).toBeCloseTo((baseBefore[k] ?? 0) + (NODE.baseline[k] ?? 0), 6);
    }
    const final = applied[applied.length - 1];
    expect(final.points).toBe(NODE.reward.points);
    expect(Object.keys(final.baseline).length).toBeGreaterThan(0);
    expect(crises.resolvedCount).toBe(1);
    expect(crises.activeCrisis).toBeNull();
  });

  it('cannot resolve twice', () => {
    const { planetary, crises } = setup();
    crises.begin(NODE.id);
    completeAll(crises);
    expect(crises.resolve(planetary)).toBeTruthy();
    expect(crises.resolve(planetary)).toBeNull();
    expect(() => crises.begin(NODE.id)).toThrow();
  });

  it('re-applies earned progress after a restore, so a reload is not a rollback', () => {
    const { planetary, crises } = setup();
    crises.begin(NODE.id);
    const objs = crises.activeCrisis!.def.objectives;
    for (let i = 0; i < objs[0].target; i++) crises.report(objs[0].id, 1);
    const afterWork = { ...planetary.vars };
    const snap = crises.serialize();

    const p2 = new PlanetaryState(WORLD_SEED);
    const c2 = new CrisisController();
    let replayed = 0;
    c2.setCompletionHandler((r) => {
      if (Object.keys(r.applied).length) {
        p2.applyEffect({ label: 'restore', immediate: r.applied, origin: 'test' });
        replayed++;
      }
    });
    c2.restore(snap);
    expect(replayed).toBe(1);
    for (const k of Object.keys(NODE.resolution)) {
      expect(p2.vars[k as keyof typeof p2.vars]).toBeCloseTo(afterWork[k as keyof typeof afterWork], 6);
    }
  });

  it('round-trips status, progress and tunnel data through serialize/restore', () => {
    const { crises } = setup();
    crises.begin(NODE.id);
    crises.report(crises.activeCrisis!.def.objectives[0].id, 1);
    crises.tunnelData.set(NODE.id, '1,2+3');
    const snap = crises.serialize();
    const c2 = new CrisisController();
    c2.restore(snap);
    const a = crises.get(NODE.id)!;
    const b = c2.get(NODE.id)!;
    expect(b.status).toBe(a.status);
    expect(b.progress).toEqual(a.progress);
    expect(c2.tunnelData.get(NODE.id)).toBe('1,2+3');
  });

  it('describes objectives for the HUD', () => {
    const { crises } = setup();
    crises.begin(NODE.id);
    const lines = crises.objectiveLines();
    expect(lines.length).toBe(crises.activeCrisis!.def.objectives.length);
    expect(lines.every((l) => l.progress === 0 && !l.done)).toBe(true);
  });
});
