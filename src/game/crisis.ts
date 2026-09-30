/**
 * CRISIS CONTROLLER — the bridge between local work and planetary state
 * =====================================================================
 *
 * Every crisis node owns a set of objectives. Each objective is satisfied by
 * *physical work performed in the local sector* — never by pressing a button on
 * a menu. When an objective completes, the controller applies a proportional
 * fraction of the crisis's planetary effect to the authoritative state, and
 * raises the corresponding baseline so the change is permanent.
 *
 * Consequences are not all positive: the effect table in `world.ts` deliberately
 * trades one system against another.
 */

import { Events } from '../core/events';
import { PlanetaryState, type PlanetaryVar, type VarDelta } from '../state/planetary';
import {
  CRISIS_NODES,
  type CrisisId,
  type CrisisNodeDef,
  type CrisisObjective,
} from '../state/world';

export interface CrisisRuntime {
  def: CrisisNodeDef;
  status: 'LOCKED' | 'AVAILABLE' | 'ACTIVE' | 'RESOLVED';
  progress: Record<string, number>;
  startedAt: number | null;
  resolvedAt: number | null;
}

export interface CompletionReport {
  crisisId: CrisisId;
  name: string;
  /** Fraction of the full effect actually applied (0..1). */
  completion: number;
  applied: VarDelta;
  baseline: VarDelta;
  rewards: { domain: string; points: number };
}

export class CrisisController {
  private runtimes = new Map<CrisisId, CrisisRuntime>();
  private active: CrisisRuntime | null = null;
  private onComplete: ((report: CompletionReport) => void) | null = null;
  private partialEffects = new Map<CrisisId, VarDelta>();

  constructor(nodes: readonly CrisisNodeDef[] = CRISIS_NODES) {
    for (const def of nodes) {
      this.runtimes.set(def.id, {
        def,
        status: 'AVAILABLE',
        progress: {},
        startedAt: null,
        resolvedAt: null,
      });
    }
  }

  setCompletionHandler(fn: (report: CompletionReport) => void): void {
    this.onComplete = fn;
  }

  /** Apply prerequisite gating: spires must be functional before some crises. */
  refreshAvailability(functionalSpires: number): void {
    for (const rt of this.runtimes.values()) {
      if (rt.status === 'RESOLVED' || rt.status === 'ACTIVE') continue;
      rt.status = functionalSpires >= rt.def.requiresSpires ? 'AVAILABLE' : 'LOCKED';
    }
  }

  get(id: CrisisId): CrisisRuntime | undefined {
    return this.runtimes.get(id);
  }

  all(): CrisisRuntime[] {
    return [...this.runtimes.values()];
  }

  get activeCrisis(): CrisisRuntime | null {
    return this.active;
  }

  /** Begin a crisis: resets progress and returns the runtime. */
  begin(id: CrisisId, restoredProgress?: Record<string, number>): CrisisRuntime {
    const rt = this.runtimes.get(id);
    if (!rt || rt.status === 'RESOLVED') throw new Error(`crisis ${id} not startable`);
    rt.status = 'ACTIVE';
    rt.progress = { ...(restoredProgress ?? {}) };
    rt.startedAt = Date.now();
    this.active = rt;
    return rt;
  }

  /** Abandon the current crisis without resolving it. */
  abandon(): void {
    if (!this.active) return;
    if (this.active.status === 'ACTIVE') this.active.status = 'AVAILABLE';
    this.active = null;
  }

  /**
   * Report progress on an objective. `amount` defaults to 1 unit.
   * Returns true when the objective just completed.
   */
  report(objectiveId: string, amount = 1): boolean {
    const rt = this.active;
    if (!rt) return false;
    const obj = rt.def.objectives.find((o) => o.id === objectiveId);
    if (!obj) return false;
    const before = rt.progress[objectiveId] ?? 0;
    if (before >= obj.target) return false;
    const after = Math.min(obj.target, before + amount);
    rt.progress[objectiveId] = after;
    if (before < obj.target && after >= obj.target) {
      this.applyPartialEffect(rt);
      return true;
    }
    return false;
  }

  /**
   * Apply a slice of the crisis effect as soon as any objective completes, so
   * the planet responds to real work rather than only at the very end.
   *
   * The slice is always `resolution * fraction`; the previously applied slice is
   * undone first so the total applied so far is exactly the fraction earned.
   */
  private applyPartialEffect(rt: CrisisRuntime): void {
    const fraction = this.completionFractionOf(rt);
    const prev = this.partialEffects.get(rt.def.id);
    if (prev) {
      const undo: VarDelta = {};
      for (const k of Object.keys(prev) as PlanetaryVar[]) undo[k] = -(prev[k] ?? 0);
      this.emit(rt.def.id, rt.def.name, rt.def.domain, 0, undo);
    }
    const slice: VarDelta = {};
    for (const k of Object.keys(rt.def.resolution) as PlanetaryVar[]) {
      slice[k] = (rt.def.resolution[k] ?? 0) * fraction;
    }
    this.partialEffects.set(rt.def.id, slice);
    this.emit(rt.def.id, rt.def.name, rt.def.domain, fraction, slice);
  }

  private completionFractionOf(rt: CrisisRuntime): number {
    const { objectives } = rt.def;
    if (objectives.length === 0) return 0;
    let sum = 0;
    for (const o of objectives) sum += Math.min(1, (rt.progress[o.id] ?? 0) / o.target);
    return sum / objectives.length;
  }

  private emit(
    id: CrisisId,
    name: string,
    domain: string,
    completion: number,
    applied: VarDelta,
    baseline: VarDelta = {},
    points = 0,
  ): void {
    this.onComplete?.({
      crisisId: id,
      name,
      completion,
      applied,
      baseline,
      rewards: { domain, points },
    });
  }

  /** True when every objective of the active crisis is complete. */
  isComplete(): boolean {
    if (!this.active) return false;
    return this.active.def.objectives.every((o) => (this.active?.progress[o.id] ?? 0) >= o.target);
  }

  /** Fraction of the active crisis completed, 0..1. */
  completionFraction(): number {
    return this.active ? this.completionFractionOf(this.active) : 0;
  }

  /**
   * Resolve the active crisis: apply the full effect and the permanent baseline
   * movement. Returns the report, or null if the crisis is not complete.
   */
  resolve(state: PlanetaryState): CompletionReport | null {
    const rt = this.active;
    if (!rt || !this.isComplete()) return null;
    const report: CompletionReport = {
      crisisId: rt.def.id,
      name: rt.def.name,
      completion: 1,
      applied: { ...rt.def.resolution },
      baseline: { ...rt.def.baseline },
      rewards: { domain: rt.def.domain, points: rt.def.reward.points },
    };
    state.applyEffect({
      label: `${rt.def.name} resolved`,
      immediate: rt.def.resolution,
      origin: `crisis:${rt.def.id}`,
    });
    state.raiseBaseline(rt.def.baseline);
    rt.status = 'RESOLVED';
    rt.resolvedAt = Date.now();
    // Drop the partial slice: the full effect has just been applied instead.
    this.partialEffects.delete(rt.def.id);
    this.active = null;
    this.emit(rt.def.id, rt.def.name, rt.def.domain, 1, { ...rt.def.resolution }, { ...rt.def.baseline }, rt.def.reward.points);
    return report;
  }

  /** Objective lines for the HUD. */
  objectiveLines(): { text: string; progress: number; done: boolean }[] {
    if (!this.active) return [];
    return this.active.def.objectives.map((o: CrisisObjective) => {
      const p = Math.min(1, (this.active?.progress[o.id] ?? 0) / o.target);
      return { text: o.text, progress: p, done: p >= 1 };
    });
  }

  /** Restore from a save payload. */
  restore(records: { id: string; status: CrisisRuntime['status']; progress: Record<string, number>; tunnels?: string }[]): void {
    this.partialEffects.clear();
    this.active = null;
    for (const r of records) {
      const rt = this.runtimes.get(r.id as CrisisId);
      if (!rt) continue;
      rt.status = r.status;
      rt.progress = { ...r.progress };
      rt.resolvedAt = r.status === 'RESOLVED' ? Date.now() : null;
      if (typeof r.tunnels === 'string' && r.tunnels.length > 0) {
        this.tunnelData.set(rt.def.id, r.tunnels);
      }
      // A crisis that was mid-flight when the game closed has already changed
      // the planet. Re-apply its earned slice so reloading does not silently
      // undo the player's work.
      if (r.status === 'ACTIVE') {
        this.active = rt;
        if (this.completionFractionOf(rt) > 0) this.applyPartialEffect(rt);
      }
    }
  }

  serialize(): { id: string; status: CrisisRuntime['status']; progress: Record<string, number>; tunnels: string; startedAt: number | null; resolvedAt: number | null }[] {
    return this.all().map((rt) => ({
      id: rt.def.id,
      status: rt.status,
      progress: { ...rt.progress },
      tunnels: this.tunnelData.get(rt.def.id) ?? '',
      startedAt: rt.startedAt,
      resolvedAt: rt.resolvedAt,
    }));
  }

  /** Player-caused excavation, keyed by crisis. */
  tunnelData = new Map<CrisisId, string>();

  get resolvedCount(): number {
    return this.all().filter((r) => r.status === 'RESOLVED').length;
  }
}

export const CRISIS_EVENTS = {
  Started: Events.CrisisProgress,
  Resolved: Events.CrisisResolved,
} as const;
