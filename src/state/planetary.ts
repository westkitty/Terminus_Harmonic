/**
 * AUTHORITATIVE PLANETARY STATE
 * =============================
 *
 * This module is the single source of truth for the macro-scale world. It is a
 * deterministic, seedable dynamical system: every value is normalized to
 * [0,1] and evolves according to
 *
 *     dv_i/dt = relaxation_i * (baseline_i - v_i)
 *             + Σ_j gain_ji * (v_j - baseline_j)
 *             + Σ_effects effect.delta/dt
 *
 * Local interventions (debris captured, spire section seated, heat exchanger
 * installed) push the system through {@link PlanetaryState.applyEffect}. Because
 * the coupling table is explicit, an intervention that helps one system visibly
 * destabilizes another — that tension is the intended design, not a bug.
 *
 * The whole thing is pure math with no rendering dependency, so planetary state
 * advances identically whether or not a local sector is loaded.
 */

import { clamp01, lerp } from '../core/math';

/** The fourteen authoritative global variables, in canonical display order. */
export const PLANETARY_VARS = [
  'orbitalSafety',
  'orbitalOcclusion',
  'stellarIrradiance',
  'atmosphereStability',
  'atmosphereToxicity',
  'hydrologyStability',
  'tectonicShear',
  'geothermalPressure',
  'soilViability',
  'biosphereViability',
  'logisticsIntegrity',
  'powerAvailability',
  'settlementSafety',
  'harmonicCoherence',
] as const;

export type PlanetaryVar = (typeof PLANETARY_VARS)[number];

/** Semantics: is a high value good or bad for the world? */
const VAR_SENSE: Record<PlanetaryVar, 'good' | 'bad'> = {
  orbitalSafety: 'good',
  orbitalOcclusion: 'bad',
  stellarIrradiance: 'good',
  atmosphereStability: 'good',
  atmosphereToxicity: 'bad',
  hydrologyStability: 'good',
  tectonicShear: 'bad',
  geothermalPressure: 'bad',
  soilViability: 'good',
  biosphereViability: 'good',
  logisticsIntegrity: 'good',
  powerAvailability: 'good',
  settlementSafety: 'good',
  harmonicCoherence: 'good',
};

const VAR_LABEL: Record<PlanetaryVar, string> = {
  orbitalSafety: 'Orbital Safety',
  orbitalOcclusion: 'Orbital Occlusion',
  stellarIrradiance: 'Stellar Irradiance',
  atmosphereStability: 'Atmosphere Stability',
  atmosphereToxicity: 'Atmosphere Toxicity',
  hydrologyStability: 'Hydrology Stability',
  tectonicShear: 'Tectonic Shear',
  geothermalPressure: 'Geothermal Pressure',
  soilViability: 'Soil Viability',
  biosphereViability: 'Biosphere Viability',
  logisticsIntegrity: 'Logistics Integrity',
  powerAvailability: 'Power Availability',
  settlementSafety: 'Settlement Safety',
  harmonicCoherence: 'Harmonic Coherence',
};

const VAR_UNIT: Record<PlanetaryVar, string> = {
  orbitalSafety: 'idx',
  orbitalOcclusion: 'frac',
  stellarIrradiance: 'W/m²×10²',
  atmosphereStability: 'idx',
  atmosphereToxicity: 'ppm·10⁻³',
  hydrologyStability: 'idx',
  tectonicShear: 'MPa·10⁻²',
  geothermalPressure: 'MPa',
  soilViability: 'idx',
  biosphereViability: 'idx',
  logisticsIntegrity: 'idx',
  powerAvailability: 'TW',
  settlementSafety: 'idx',
  harmonicCoherence: 'φ',
};

export function varLabel(v: PlanetaryVar): string {
  return VAR_LABEL[v];
}
export function varUnit(v: PlanetaryVar): string {
  return VAR_UNIT[v];
}
export function varSense(v: PlanetaryVar): 'good' | 'bad' {
  return VAR_SENSE[v];
}

/**
 * Explicit coupling table. Each rule says: "when `from` sits `gain` units above
 * its own baseline, `to` drifts at `gain` per second toward being pushed."
 *
 * Positive gain on a 'bad' variable means the coupling is itself a destabilizer.
 */
interface CouplingRule {
  from: PlanetaryVar;
  to: PlanetaryVar;
  gain: number;
  /** Human-readable justification surfaced in the forecast UI. */
  why: string;
}

const COUPLINGS: readonly CouplingRule[] = [
  // --- Orbit <-> climate -------------------------------------------------
  { from: 'orbitalOcclusion', to: 'stellarIrradiance', gain: -0.55, why: 'debris shade reduces received stellar flux' },
  { from: 'orbitalOcclusion', to: 'atmosphereStability', gain: -0.22, why: 'shade asymmetry destabilises circulation cells' },
  { from: 'orbitalOcclusion', to: 'orbitalSafety', gain: -0.30, why: 'dense belts raise collision-cascade risk' },
  { from: 'stellarIrradiance', to: 'atmosphereStability', gain: 0.18, why: 'flux restores thermal gradient structure' },
  { from: 'stellarIrradiance', to: 'soilViability', gain: 0.24, why: 'insolation drives surface energy budget' },
  { from: 'stellarIrradiance', to: 'geothermalPressure', gain: 0.18, why: 'diurnal thermal loading on the crust' },
  { from: 'orbitalSafety', to: 'logisticsIntegrity', gain: 0.20, why: 'safe corridors enable orbital freight' },

  // --- Atmosphere --------------------------------------------------------
  { from: 'atmosphereStability', to: 'atmosphereToxicity', gain: -0.35, why: 'stable mixing dilutes and vents toxins' },
  { from: 'atmosphereToxicity', to: 'soilViability', gain: -0.40, why: 'toxic deposition poisons regolith' },
  { from: 'atmosphereToxicity', to: 'biosphereViability', gain: -0.45, why: 'toxins suppress surviving ecology' },
  { from: 'atmosphereToxicity', to: 'settlementSafety', gain: -0.30, why: 'filtration load and exposure risk' },
  { from: 'atmosphereStability', to: 'hydrologyStability', gain: 0.30, why: 'coherent circulation sustains the rain regime' },
  { from: 'atmosphereStability', to: 'settlementSafety', gain: 0.25, why: 'fewer storm-shear events over settlements' },

  // --- Hydro / soil / biosphere -----------------------------------------
  { from: 'hydrologyStability', to: 'soilViability', gain: 0.35, why: 'water regime governs leaching and salinity' },
  { from: 'hydrologyStability', to: 'biosphereViability', gain: 0.38, why: 'water is the limiting factor for recovery' },
  { from: 'hydrologyStability', to: 'atmosphereStability', gain: 0.14, why: 'evapotranspiration feeds the water cycle' },
  { from: 'soilViability', to: 'biosphereViability', gain: 0.34, why: 'workable soil lets cover crops establish' },
  { from: 'biosphereViability', to: 'soilViability', gain: 0.16, why: 'root systems rebuild soil structure' },
  { from: 'biosphereViability', to: 'atmosphereStability', gain: 0.12, why: 'vegetation damps turbulence and scrubs air' },
  { from: 'biosphereViability', to: 'settlementSafety', gain: 0.14, why: 'food and material security' },

  // --- Geology -----------------------------------------------------------
  { from: 'geothermalPressure', to: 'tectonicShear', gain: 0.50, why: 'overpressured heat channels load the faults' },
  { from: 'geothermalPressure', to: 'atmosphereStability', gain: -0.14, why: 'vented gas and ash burden the air' },
  { from: 'tectonicShear', to: 'settlementSafety', gain: -0.45, why: 'shear release threatens surface assets' },
  { from: 'tectonicShear', to: 'hydrologyStability', gain: -0.26, why: 'faulting diverts and contaminates aquifers' },
  { from: 'tectonicShear', to: 'logisticsIntegrity', gain: -0.24, why: 'ground failure severs routes' },
  { from: 'tectonicShear', to: 'powerAvailability', gain: -0.18, why: 'surface plant and line damage' },
  { from: 'tectonicShear', to: 'geothermalPressure', gain: -0.10, why: 'fracturing vents pressure' },

  // --- Infrastructure ----------------------------------------------------
  { from: 'powerAvailability', to: 'logisticsIntegrity', gain: 0.30, why: 'rails, depots and pumps need power' },
  { from: 'powerAvailability', to: 'settlementSafety', gain: 0.32, why: 'shelters, filtration and heat need power' },
  { from: 'powerAvailability', to: 'atmosphereStability', gain: 0.10, why: 'processors can run at capacity' },
  { from: 'logisticsIntegrity', to: 'settlementSafety', gain: 0.28, why: 'resupply is survival' },
  { from: 'logisticsIntegrity', to: 'powerAvailability', gain: 0.12, why: 'fuel and spares reach the plants' },
  { from: 'logisticsIntegrity', to: 'soilViability', gain: 0.08, why: 'amendment and seed delivery' },

  // --- Harmonic network --------------------------------------------------
  { from: 'harmonicCoherence', to: 'tectonicShear', gain: -0.34, why: 'phase-locked spires damp destructive resonance' },
  { from: 'harmonicCoherence', to: 'logisticsIntegrity', gain: 0.22, why: 'synchronised machinery schedules across continents' },
  { from: 'harmonicCoherence', to: 'powerAvailability', gain: 0.18, why: 'coherent phase reduces structural fatigue losses' },
  { from: 'harmonicCoherence', to: 'settlementSafety', gain: 0.16, why: 'early-warning resonance detection' },
  { from: 'harmonicCoherence', to: 'orbitalSafety', gain: 0.10, why: 'seismic tracking improves conjunction warnings' },
  { from: 'harmonicCoherence', to: 'atmosphereStability', gain: 0.08, why: 'resonance modelling sharpens forecasting' },

  // --- Feedback that must not be free ------------------------------------
  { from: 'settlementSafety', to: 'atmosphereToxicity', gain: -0.05, why: 'shelters vent scrubbed effluent' },
];

/** Largest integration sub-step, in simulation seconds. Keeps the coupling
 *  table inside its stability region regardless of the caller's frame time. */
const MAX_SUBSTEP = 0.5;

/** Per-variable relaxation rate toward its baseline (1/s). */
const RELAXATION: Record<PlanetaryVar, number> = {
  orbitalSafety: 0.02,
  orbitalOcclusion: 0.015,
  stellarIrradiance: 0.03,
  atmosphereStability: 0.025,
  atmosphereToxicity: 0.018,
  hydrologyStability: 0.012,
  tectonicShear: 0.008,
  geothermalPressure: 0.010,
  soilViability: 0.006,
  biosphereViability: 0.005,
  logisticsIntegrity: 0.014,
  powerAvailability: 0.016,
  settlementSafety: 0.013,
  harmonicCoherence: 0.020,
};

export type VarDelta = Partial<Record<PlanetaryVar, number>>;

export interface PlanetaryEffect {
  id: string;
  /** Human readable, shown in the briefing and the toast. */
  label: string;
  /** Immediate one-shot shocks applied on creation. */
  immediate: VarDelta;
  /** Sustained per-second drift applied while `remaining > 0`. */
  sustained?: VarDelta;
  /** Seconds the sustained component lasts. */
  duration?: number;
  remaining?: number;
  /** Where it came from, for the log. */
  origin: string;
}

export interface PlanetarySnapshot {
  vars: Record<PlanetaryVar, number>;
  /** Baseline the system is relaxing toward — the "wounded world" attractor. */
  baselines: Record<PlanetaryVar, number>;
  tick: number;
  simTime: number;
}

/**
 * Authoritative planetary simulation. Rendering code reads snapshots from this;
 * it never writes to it directly.
 */
export class PlanetaryState {
  readonly vars: Record<PlanetaryVar, number>;
  readonly baselines: Record<PlanetaryVar, number>;
  private activeEffects: PlanetaryEffect[] = [];
  private effectCounter = 0;
  private scratch: Record<PlanetaryVar, number>;
  private next: Record<PlanetaryVar, number>;

  /** Monotonic simulation seconds. */
  simTime = 0;
  /** Monotonic simulation steps. */
  tick = 0;
  /** Set to true whenever any variable moved by more than EPSILON. */
  dirty = true;

  constructor(seed: number) {
    this.vars = {} as Record<PlanetaryVar, number>;
    this.baselines = {} as Record<PlanetaryVar, number>;
    this.scratch = {} as Record<PlanetaryVar, number>;
    this.next = {} as Record<PlanetaryVar, number>;
    for (const v of PLANETARY_VARS) {
      this.vars[v] = 0;
      this.baselines[v] = 0;
      this.scratch[v] = 0;
      this.next[v] = 0;
    }
    this.seedBaselines(seed);
  }

  /**
   * Derive the post-war baseline attractor from the world seed.
   *
   * This is the "permanent damage" term: the planet relaxes toward a wounded
   * equilibrium, never toward a pristine one. Engineering work raises the
   * baseline itself (via {@link raiseBaseline}), it does not just nudge the value.
   */
  private seedBaselines(seed: number): void {
    // Deterministic pseudo-random derivation; a real campaign seeds this from
    // authored data, but the fallback must be stable for a given world seed.
    let h = (seed ^ 0x5bf03635) >>> 0;
    const rnd = (): number => {
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
      h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
      h = (h ^ (h >>> 15)) >>> 0;
      return h / 4294967296;
    };
    // Post-war remnant world: damaged but not apocalyptic.
    const base: Record<PlanetaryVar, number> = {
      orbitalSafety: 0.18 + rnd() * 0.10,
      orbitalOcclusion: 0.72 - rnd() * 0.08,
      stellarIrradiance: 0.30 + rnd() * 0.08,
      atmosphereStability: 0.26 + rnd() * 0.08,
      atmosphereToxicity: 0.78 - rnd() * 0.08,
      hydrologyStability: 0.22 + rnd() * 0.08,
      tectonicShear: 0.74 - rnd() * 0.08,
      geothermalPressure: 0.70 - rnd() * 0.08,
      soilViability: 0.16 + rnd() * 0.08,
      biosphereViability: 0.13 + rnd() * 0.07,
      logisticsIntegrity: 0.20 + rnd() * 0.08,
      powerAvailability: 0.24 + rnd() * 0.08,
      settlementSafety: 0.21 + rnd() * 0.08,
      harmonicCoherence: 0.05 + rnd() * 0.04,
    };
    for (const v of PLANETARY_VARS) {
      this.baselines[v] = clamp01(base[v]);
      this.vars[v] = clamp01(base[v]);
    }
    this.dirty = true;
  }

  /**
   * Permanently move the attractor. Used when infrastructure is completed.
   *
   * The value moves with the baseline: raising only the attractor would leave a
   * large negative deviation that the coupling table would read as "the world
   * just got dramatically worse", which is the opposite of what completing a
   * repair means.
   */
  raiseBaseline(delta: VarDelta, scale = 1): void {
    for (const k of Object.keys(delta) as PlanetaryVar[]) {
      const d = (delta[k] ?? 0) * scale;
      this.baselines[k] = clamp01(this.baselines[k] + d);
      this.vars[k] = clamp01(this.vars[k] + d);
    }
    this.dirty = true;
  }

  applyEffect(effect: Omit<PlanetaryEffect, 'id' | 'remaining'>): PlanetaryEffect {
    const full: PlanetaryEffect = {
      ...effect,
      id: `fx-${++this.effectCounter}`,
      remaining: effect.duration ?? 0,
    };
    if (full.immediate) {
      for (const k of Object.keys(full.immediate) as PlanetaryVar[]) {
        this.vars[k] = clamp01(this.vars[k] + (full.immediate[k] ?? 0));
      }
    }
    if (full.sustained && (full.duration ?? 0) > 0) this.activeEffects.push(full);
    this.dirty = true;
    return full;
  }

  cancelEffectsFrom(origin: string): void {
    this.activeEffects = this.activeEffects.filter((e) => e.origin !== origin);
  }

  get activeEffectCount(): number {
    return this.activeEffects.length;
  }

  /**
   * Advance the system. `dt` is in simulation seconds.
   *
   * The step is internally sub-divided so the integration is stable and
   * identical regardless of the caller's frame time — a 40 ms frame and a
   * 200 ms frame produce the same trajectory.
   */
  step(dt: number): void {
    if (!(dt > 0)) return;
    let remaining = Math.min(dt, 8);
    while (remaining > 1e-9) {
      const h = Math.min(MAX_SUBSTEP, remaining);
      this.substep(h);
      remaining -= h;
    }
    this.dirty = true;
  }

  /** One bounded explicit-Euler sub-step (Jacobi, so rule order cannot matter). */
  private substep(dtc: number): void {
    // Accumulate sustained effects into a delta vector.
    const acc = this.scratch;
    for (const v of PLANETARY_VARS) acc[v] = 0;
    for (let i = this.activeEffects.length - 1; i >= 0; i--) {
      const e = this.activeEffects[i];
      e.remaining = (e.remaining ?? 0) - dtc;
      if (e.remaining <= 0) {
        this.activeEffects.splice(i, 1);
        continue;
      }
      const s = e.sustained;
      if (!s) continue;
      for (const k of Object.keys(s) as PlanetaryVar[]) acc[k] += (s[k] ?? 0);
    }

    const from = this.vars;
    const to = this.next;
    for (const v of PLANETARY_VARS) {
      const drift = (this.baselines[v] - from[v]) * RELAXATION[v] + acc[v];
      to[v] = clamp01(from[v] + drift * dtc);
    }

    // Coupling pass reads the *previous* sub-step only, so a rule can never
    // consume its own output within the same frame.
    for (const rule of COUPLINGS) {
      const deviation = from[rule.from] - this.baselines[rule.from];
      if (Math.abs(deviation) < 1e-5) continue;
      to[rule.to] = clamp01(to[rule.to] + rule.gain * deviation * dtc);
    }

    for (const v of PLANETARY_VARS) from[v] = to[v];
    this.simTime += dtc;
    this.tick++;
  }

  /**
   * Forecast: run a scratch copy forward `horizonSeconds` and return the
   * resulting values, plus the chain of coupling rules that fired. Used by the
   * briefing screen so the player can inspect consequences before committing.
   */
  forecast(delta: VarDelta, horizonSeconds = 120): { vars: Record<PlanetaryVar, number>; chain: string[] } {
    // Two things happen when a repair lands, and the horizon must show both:
    //   1. an immediate shock to the value (this is what drives the coupling
    //      table — a deviation from baseline is the only signal it reads), and
    //   2. a permanent move of the attractor, so the change does not relax away.
    const target = { ...this.baselines };
    const v: Record<PlanetaryVar, number> = { ...this.vars };
    for (const k of Object.keys(delta) as PlanetaryVar[]) {
      const d = delta[k] ?? 0;
      target[k] = clamp01(target[k] + d);
      v[k] = clamp01(v[k] + d);
    }

    const total = Math.max(1, Math.min(horizonSeconds, 600));
    const steps = Math.max(1, Math.round(total / MAX_SUBSTEP));
    const dtc = total / steps;
    const from = { ...v };
    const to = { ...v };
    for (let s = 0; s < steps; s++) {
      for (const key of PLANETARY_VARS) {
        to[key] = clamp01(from[key] + (target[key] - from[key]) * RELAXATION[key] * dtc);
      }
      for (const rule of COUPLINGS) {
        // Deviations are measured against the *original* baseline: that is what
        // makes a shock propagate instead of being absorbed into the attractor.
        const dev = from[rule.from] - this.baselines[rule.from];
        if (Math.abs(dev) < 1e-5) continue;
        to[rule.to] = clamp01(to[rule.to] + rule.gain * dev * dtc);
      }
      for (const key of PLANETARY_VARS) from[key] = to[key];
    }
    for (const key of PLANETARY_VARS) v[key] = from[key];

    // Describe only the couplings that actually moved something, and only when
    // the source itself moved — otherwise the chain would be noise.
    const entries: { text: string; mag: number }[] = [];
    for (const rule of COUPLINGS) {
      const srcMoved = v[rule.from] - this.vars[rule.from];
      const tgtMoved = v[rule.to] - this.vars[rule.to];
      if (Math.abs(srcMoved) < 0.01 || Math.abs(tgtMoved) < 0.004) continue;
      entries.push({
        mag: Math.abs(tgtMoved),
        text:
          `${varLabel(rule.from)} ${srcMoved > 0 ? '+' : ''}${srcMoved.toFixed(2)} ` +
          `${tgtMoved > 0 ? 'raises' : 'lowers'} ${varLabel(rule.to)} by ` +
          `${Math.abs(tgtMoved).toFixed(2)} — ${rule.why}`,
      });
    }
    entries.sort((a, b) => b.mag - a.mag);
    return { vars: v, chain: entries.map((e) => e.text) };
  }

  /** Weighted 0..1 "how well is the world doing" score. Bad-sense vars invert. */
  globalHealth(): number {
    let sum = 0;
    for (const v of PLANETARY_VARS) {
      const x = this.vars[v];
      sum += VAR_SENSE[v] === 'good' ? x : 1 - x;
    }
    return sum / PLANETARY_VARS.length;
  }

  snapshot(): PlanetarySnapshot {
    return {
      vars: { ...this.vars },
      baselines: { ...this.baselines },
      tick: this.tick,
      simTime: this.simTime,
    };
  }

  /** Restore from a snapshot, tolerating missing/extra keys from old saves. */
  restore(snap: Partial<PlanetarySnapshot>): void {
    if (!snap || typeof snap !== 'object') return;
    for (const v of PLANETARY_VARS) {
      const val = snap.vars?.[v];
      if (typeof val === 'number' && Number.isFinite(val)) this.vars[v] = clamp01(val);
      const b = snap.baselines?.[v];
      if (typeof b === 'number' && Number.isFinite(b)) this.baselines[v] = clamp01(b);
    }
    this.tick = snap.tick ?? 0;
    this.simTime = snap.simTime ?? 0;
    this.activeEffects.length = 0;
    this.dirty = true;
  }

  serialize(): PlanetarySnapshot {
    return this.snapshot();
  }

  /** Total absolute deviation from baseline — drives macro UI alarm colouring. */
  instability(): number {
    let sum = 0;
    for (const v of PLANETARY_VARS) {
      const dev = this.vars[v] - this.baselines[v];
      sum += dev * dev;
    }
    return Math.sqrt(sum / PLANETARY_VARS.length);
  }

  /** Interpolate a rendered readout value for a variable (for HUD formatting). */
  static readout(v: PlanetaryVar, value: number): string {
    switch (v) {
      case 'stellarIrradiance':
        return `${(value * 1360).toFixed(0)} W/m²`;
      case 'powerAvailability':
        return `${(value * 42).toFixed(1)} TW`;
      case 'geothermalPressure':
        return `${(value * 900).toFixed(0)} MPa`;
      case 'tectonicShear':
        return `${(value * 480).toFixed(0)} MPa`;
      case 'atmosphereToxicity':
        return `${(value * 3200).toFixed(0)} ppm`;
      case 'harmonicCoherence':
        return `${(value * 360).toFixed(0)}° φ`;
      default:
        return `${(value * 100).toFixed(0)}%`;
    }
  }
}

/** Exposed for tests and the forecast inspector. */
export function couplingRules(): readonly CouplingRule[] {
  return COUPLINGS;
}

/** Convenience: how much a candidate intervention moves each variable. */
export function previewDelta(delta: VarDelta, state: PlanetaryState): Record<PlanetaryVar, number> {
  const { vars } = state.forecast(delta, 0);
  const out = {} as Record<PlanetaryVar, number>;
  for (const v of PLANETARY_VARS) out[v] = vars[v] - state.vars[v];
  return out;
}

export function blendSnapshot(a: PlanetarySnapshot, b: PlanetarySnapshot, t: number): PlanetarySnapshot {
  const vars = {} as Record<PlanetaryVar, number>;
  const baselines = {} as Record<PlanetaryVar, number>;
  for (const v of PLANETARY_VARS) {
    vars[v] = lerp(a.vars[v], b.vars[v], t);
    baselines[v] = lerp(a.baselines[v], b.baselines[v], t);
  }
  return { vars, baselines, tick: a.tick, simTime: lerp(a.simTime, b.simTime, t) };
}
