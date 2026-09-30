/**
 * SYSTEMS — the explicit, ordered simulation
 * ==========================================
 *
 * Each system is small, named and ordered. There is no dependency solver; the
 * order below is the actual execution order and is readable top to bottom.
 *
 *  10 GlobalStateSystem      steps the authoritative planetary state (fixed step)
 *  20 WeatherSystem          evolves storm systems and wind from planetary state
 *  30 LogisticsSystem        settlement viability follows logistics + power
 *  40 HarmonicSystem         spire phase drift and coherence
 *  50 TerrainStreamingSystem drives chunk LOD rebuilds (budgeted)
 *  60 VehiclePossessionSystem routes input into the possessed machine
 *  70 CameraSystem           camera rig follow
 *  80 AudioSystem            audio frame state
 *  90 PerformanceSystem      renderer stats -> adaptive quality
 * 100 SaveSystem             autosave
 * 110 UISystem               HUD + macro UI
 */

import * as THREE from 'three';
import type { System, SystemContext } from '../core/ecs';

export type { SystemContext };
import { Events } from '../core/events';
import { clamp01, damp, mixSeed, smoothstep } from '../core/math';
import type { PlanetaryState, PlanetaryVar } from '../state/planetary';
import { PLANETARY_VARS } from '../state/planetary';
import type { SaveData } from '../state/save';
import type { PerformanceMonitor, QualitySettings } from '../core/perf';
import type { AudioEngine, AudioEnvironment } from '../audio/AudioEngine';
import type { SpireRecord } from '../state/save';
import type { VehicleBase } from '../vehicle/base';
import type { UIController } from '../ui/ui';
import type { CrisisRuntime } from '../game/crisis';
import type { Scale } from '../game/scale';

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

export interface StormSystem {
  id: number;
  lat: number;
  lon: number;
  radiusDeg: number;
  intensity: number;
  /** Rotation direction. */
  spin: number;
  age: number;
}

export class GlobalStateSystem implements System {
  readonly name = 'GlobalStateSystem';
  readonly order = 10;
  enabled = true;
  private accumulator = 0;
  private static readonly STEP = 1 / 10;

  constructor(
    private planetary: PlanetaryState,
    private onTick?: (state: PlanetaryState) => void,
  ) {}

  rebind(planetary: PlanetaryState): void {
    this.planetary = planetary;
    this.accumulator = 0;
  }

  update(ctx: SystemContext): void {
    // Fixed-step so planetary evolution is deterministic regardless of frame rate.
    this.accumulator += ctx.dt;
    let guard = 0;
    while (this.accumulator >= GlobalStateSystem.STEP && guard++ < 8) {
      this.planetary.step(GlobalStateSystem.STEP);
      this.accumulator -= GlobalStateSystem.STEP;
    }
    if (guard >= 8) this.accumulator = 0;
    this.onTick?.(this.planetary);
    ctx.bus.emit(Events.PlanetaryTick, { snapshot: this.planetary.snapshot() });
  }
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

export class WeatherSystem implements System {
  readonly name = 'WeatherSystem';
  readonly order = 20;
  enabled = true;
  readonly storms: StormSystem[] = [];
  /** Sector-local wind vector in m/s. */
  readonly wind = new THREE.Vector3(6, 0, -3);

  private nextId = 1;

  constructor(
    private planetary: PlanetaryState,
    private seed: number,
  ) {}

  rebind(planetary: PlanetaryState, seed: number): void {
    this.planetary = planetary;
    this.seed = seed;
    this.storms.length = 0;
    this.nextId = 1;
  }

  update(ctx: SystemContext): void {
    const p = this.planetary;
    const dt = ctx.dt;

    // Storms grow where atmospheric stability is low and shear is high.
    const instability = 1 - p.vars.atmosphereStability;
    if (this.storms.length < 9 && Math.random() < dt * (0.05 + instability * 0.5)) {
      let s = mixSeed(this.seed, this.nextId * 7919) >>> 0;
      const rnd = (): number => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
      };
      this.storms.push({
        id: this.nextId++,
        lat: (rnd() - 0.5) * 150,
        lon: rnd() * 360 - 180,
        radiusDeg: 4 + rnd() * 12,
        intensity: 0.2 + rnd() * 0.5 * instability,
        spin: rnd() > 0.5 ? 1 : -1,
        age: 0,
      });
    }

    for (let i = this.storms.length - 1; i >= 0; i--) {
      const st = this.storms[i];
      st.age += dt;
      st.intensity = clamp01(st.intensity + dt * (instability * 0.02 - 0.012));
      if (st.intensity <= 0.01 || st.age > 600) this.storms.splice(i, 1);
    }

    // Sector wind derived from the global circulation plus storm shear.
    const stormFactor = this.storms.reduce((m, s) => Math.max(m, s.intensity), 0);
    const targetWind = new THREE.Vector3(
      Math.sin(ctx.elapsed * 0.05) * (3 + stormFactor * 12),
      0,
      Math.cos(ctx.elapsed * 0.037) * (2 + stormFactor * 9),
    );
    this.wind.x = damp(this.wind.x, targetWind.x, 0.8, dt);
    this.wind.z = damp(this.wind.z, targetWind.z, 0.8, dt);
  }
}

// ---------------------------------------------------------------------------
// Logistics / settlements
// ---------------------------------------------------------------------------

export interface SettlementRuntime {
  id: string;
  name: string;
  lat: number;
  lon: number;
  viability: number;
  populationK: number;
}

export class LogisticsSystem implements System {
  readonly name = 'LogisticsSystem';
  readonly order = 30;
  enabled = true;

  constructor(
    private planetary: PlanetaryState,
    private settlements: SettlementRuntime[],
  ) {}

  rebind(planetary: PlanetaryState, settlements: SettlementRuntime[]): void {
    this.planetary = planetary;
    this.settlements = settlements;
  }

  update(ctx: SystemContext): void {
    const p = this.planetary;
    const dt = ctx.dt;
    const logistics = p.vars.logisticsIntegrity;
    const power = p.vars.powerAvailability;
    const safety = p.vars.settlementSafety;
    const toxicity = p.vars.atmosphereToxicity;
    const soil = p.vars.soilViability;

    for (const s of this.settlements) {
      // Viability tracks the systems that actually keep people alive.
      const target = clamp01(
        logistics * 0.34 + power * 0.24 + safety * 0.22 + (1 - toxicity) * 0.1 + soil * 0.1,
      );
      s.viability = damp(s.viability, target, 0.12, dt);
    }
    void ctx;
  }
}

// ---------------------------------------------------------------------------
// Terminus Harmonic
// ---------------------------------------------------------------------------

/** Fraction of the network that must be live before the Harmonic can establish. */
const HARMONIC_ESTABLISH_COVERAGE = 8 / 12;
/** Phase agreement the live network must reach before the Harmonic establishes. */
const HARMONIC_ESTABLISH_ORDER = 0.9;

/** Sweep rate of the network reference phase, degrees/second. */
const REFERENCE_RATE = 14;
/** How fast a spire's phase error decays, per second per unit of pull. */
const LOCK_RATE = 4.5;

/** Signed shortest angular difference in degrees. */
function shortestDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export class HarmonicSystem implements System {
  readonly name = 'HarmonicSystem';
  readonly order = 40;
  enabled = true;
  /** Per-spire phase offset in degrees. */
  readonly phases: number[] = [];
  /** Per-spire lock 0..1. */
  readonly locks: number[] = [];
  /** Network coherence 0..1 (phase agreement x coverage). */
  coherence = 0;
  /** Phase agreement alone, 0..1, ignoring how much of the network is live. */
  phaseOrder = 0;
  /** Fraction of the spire network that is functional. */
  coverage = 0;
  /** Seconds since the network last pulsed. */
  private pulseTimer = 0;
  private pulseEnergy = 0;
  /** Phase of the network reference, in degrees. */
  private referencePhase = 0;

  constructor(
    private planetary: PlanetaryState,
    private spires: SpireRecord[],
  ) {
    this.phases = spires.map((s) => s.phase);
    this.locks = spires.map((s) => (s.functional ? 0.85 : 0.1));
    this.recompute();
  }

  rebind(planetary: PlanetaryState, spires: SpireRecord[]): void {
    this.planetary = planetary;
    this.spires = spires;
    this.phases.length = 0;
    this.phases.push(...spires.map((s) => s.phase));
    this.locks.length = 0;
    this.locks.push(...spires.map((s) => (s.functional ? 0.85 : 0.1)));
    this.pulseTimer = 0;
    this.pulseEnergy = 0;
    this.referencePhase = 0;
    this.recompute();
  }

  get refPhase(): number {
    return this.referencePhase;
  }

  private recompute(): void {
    const functional = this.spires.filter((s) => s.functional);
    const n = this.spires.length;
    if (n === 0 || functional.length === 0) {
      this.coherence = 0;
      return;
    }
    // Coherence is coverage times phase agreement.
    let sumSin = 0;
    let sumCos = 0;
    let lockedCount = 0;
    for (let i = 0; i < n; i++) {
      const s = this.spires[i];
      if (!s.functional) continue;
      lockedCount++;
      const a = (this.phases[i] * Math.PI) / 180;
      sumSin += Math.sin(a);
      sumCos += Math.cos(a);
    }
    if (lockedCount === 0) {
      this.coherence = 0;
      this.phaseOrder = 0;
      this.coverage = 0;
      return;
    }
    const order = Math.hypot(sumSin, sumCos) / lockedCount; // 0..1 phase agreement
    const coverage = lockedCount / n;
    this.phaseOrder = order;
    this.coverage = coverage;
    this.coherence = clamp01(order * coverage);
  }

  update(ctx: SystemContext): void {
    const dt = Math.max(0, Math.min(ctx.dt, 0.25));
    const p = this.planetary;

    // The network reference sweeps at the audible signature rate. Every
    // functional spire is pulled toward it; the pull is weak until that spire
    // has actually been serviced, so the player cannot synchronise the network
    // by waiting — they have to go and do the work.
    this.referencePhase = (this.referencePhase + REFERENCE_RATE * dt) % 360;

    for (let i = 0; i < this.spires.length; i++) {
      const s = this.spires[i];
      if (!s.functional) {
        this.locks[i] = damp(this.locks[i], 0.06, 0.5, dt);
        continue;
      }
      const pull = clamp01(0.10 + s.repairs * 0.14 + p.vars.harmonicCoherence * 0.30);
      const err = shortestDeg(this.phases[i], this.referencePhase);
      const wander = Math.sin(ctx.elapsed * 1.7 + i * 2.1) * (1 - pull) * 30;
      const next = this.phases[i] + err * Math.min(1, pull * LOCK_RATE * dt) + wander * dt;
      this.phases[i] = ((next % 360) + 360) % 360;
      this.locks[i] = damp(this.locks[i], pull, 0.35, dt);
    }
    this.recompute();

    // Feed the result back into the authoritative state. The `max` means the
    // network never loses coherence on its own — but it can only ever *gain* it
    // from real phase agreement, so idling cannot farm it.
    p.vars.harmonicCoherence = clamp01(
      damp(p.vars.harmonicCoherence, Math.max(p.vars.harmonicCoherence, this.coherence), 0.15, dt),
    );

    // Audible planetary pulse: isolated early, synchronised late.
    this.pulseTimer += dt;
    const interval = 3.4 - this.coherence * 2.6;
    if (this.pulseTimer >= interval) {
      this.pulseTimer = 0;
      this.pulseEnergy = 0.35 + this.coherence * 0.65;
      ctx.bus.emit(Events.HarmonicPhase, {
        coherence: this.coherence,
        energy: this.pulseEnergy,
        functional: this.spires.filter((s) => s.functional).length,
      });
    }
  }

  /**
   * True once the Terminus Harmonic is actually established: enough of the
   * network is live, and what is live agrees on phase. Deliberately *not* a
   * function of coherence alone — coherence is capped by coverage, so a
   * half-built network could never read as established no matter how well
   * locked it was.
   */
  get established(): boolean {
    return (
      this.coverage >= HARMONIC_ESTABLISH_COVERAGE && this.phaseOrder >= HARMONIC_ESTABLISH_ORDER
    );
  }

  /** Nudge a spire toward the network reference (called by a repair action). */
  lockSpire(id: number, amount = 1): void {
    const i = this.spires.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.phases[i] = this.referencePhase;
    this.spires[i].repairs += amount;
    this.recompute();
  }

  get pulseStrength(): number {
    return this.pulseEnergy;
  }
}

// ---------------------------------------------------------------------------
// Terrain streaming
// ---------------------------------------------------------------------------

export interface TerrainStreamTarget {
  update(x: number, z: number, budget: number): void;
}

export class TerrainStreamingSystem implements System {
  readonly name = 'TerrainStreamingSystem';
  readonly order = 50;
  enabled = true;
  loadedChunks = 0;

  constructor(
    private target: TerrainStreamTarget | null | (() => TerrainStreamTarget | null),
    private getPlayerPosition: () => THREE.Vector3,
    private quality: () => QualitySettings,
  ) {}

  update(_ctx: SystemContext): void {
    const t = typeof this.target === 'function' ? this.target() : this.target;
    if (!t) return;
    const p = this.getPlayerPosition();
    t.update(p.x, p.z, this.quality().terrainBudget);
  }
}

// ---------------------------------------------------------------------------
// Vehicle possession
// ---------------------------------------------------------------------------

export class VehiclePossessionSystem implements System {
  readonly name = 'VehiclePossessionSystem';
  readonly order = 60;
  enabled = true;

  private current: VehicleBase | null = null;

  constructor(
    private bus: import('../core/events').EventBus,
    private input: import('../core/input').InputManager,
    private onCycleCamera: () => void,
    private getScale?: () => Scale,
    private onActiveTick?: (vehicle: VehicleBase, dt: number) => void,
  ) {}

  possess(vehicle: VehicleBase): void {
    this.release();
    this.current = vehicle;
    this.bus.emit(Events.VehiclePossessed, { kind: vehicle.kind });
  }

  release(): void {
    if (!this.current) return;
    this.bus.emit(Events.VehicleReleased, { kind: this.current.kind });
    this.current = null;
  }

  get vehicle(): VehicleBase | null {
    return this.current;
  }

  update(ctx: SystemContext): void {
    if (this.input.pressed('cameraCycle')) this.onCycleCamera();
    if (!this.current) return;
    const scale = this.getScale ? this.getScale() : 'SECTOR';
    if (scale === 'SECTOR' || scale === 'ORBIT') {
      this.current.update(ctx.dt);
      this.onActiveTick?.(this.current, ctx.dt);
    }
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface CameraRig {
  update(dt: number): void;
}

export class CameraSystem implements System {
  readonly name = 'CameraSystem';
  readonly order = 70;
  enabled = true;

  constructor(private rigs: CameraRig[]) {}

  update(ctx: SystemContext): void {
    for (const r of this.rigs) r.update(ctx.dt);
  }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export class AudioSystem implements System {
  readonly name = 'AudioSystem';
  readonly order = 80;
  enabled = true;
  private environment: AudioEnvironment = 'MACRO';

  /** Current audio environment (read by the game for diagnostics). */
  get currentEnvironment(): AudioEnvironment {
    return this.environment;
  }


  constructor(
    private audio: AudioEngine,
    private getVehicle: () => VehicleBase | null,
    private getScale: () => Scale,
    private getCoherence: () => number,
    private getSpireLocks: () => number[],
    private getSpireFreqs: () => number[],
    private getUiOpen: () => boolean,
    private onImpact: (i: number, b: number) => void,
    private onThunder: (i: number) => void,
  ) {}

  setEnvironment(env: AudioEnvironment): void {
    this.environment = env;
  }

  update(ctx: SystemContext): void {
    const v = this.getVehicle();
    const scale = this.getScale();
    let env: AudioEnvironment = 'MACRO';
    if (scale === 'MACRO') env = 'MACRO';
    else if (v) {
      switch (v.kind) {
        case 'ORBITAL_SKIFF':
          env = 'ORBIT';
          break;
        case 'LAND_TRAIN':
          env = 'SURFACE';
          break;
        case 'STRATA_CRAWLER':
          env = 'SUBSURFACE';
          break;
        case 'GLIDER':
          env = 'ATMOSPHERE';
          break;
      }
    }
    this.environment = env;

    const a = v?.audioState() ?? { drive: 0, secondary: 0, speed: 0, stress: 0, heat: 0, turbulence: 0 };
    this.audio.update(
      {
        environment: env,
        drive: a.drive,
        secondary: a.secondary,
        speed: a.speed,
        stress: a.stress,
        heat: a.heat,
        turbulence: a.turbulence,
        proximity: 1,
        coherence: this.getCoherence(),
        spireLocks: this.getSpireLocks(),
        spireFreqs: this.getSpireFreqs(),
        uiOpen: this.getUiOpen(),
      },
      ctx.dt,
    );
    void this.onImpact;
    void this.onThunder;
  }
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export class PerformanceSystem implements System {
  readonly name = 'PerformanceSystem';
  readonly order = 90;
  enabled = true;

  private lastHeap = 0;

  constructor(
    private perf: PerformanceMonitor,
    private renderer: THREE.WebGLRenderer,
    private getEntityCount: () => number,
    private getChunkCount: () => number,
    private getPooled: () => number,
    onQualityChange: (q: QualitySettings) => void,
  ) {
    this.perf.onTierChange = onQualityChange;
  }

  update(ctx: SystemContext): void {
    const info = this.renderer.info;
    this.perf.drawCalls = info.render.calls;
    this.perf.triangles = info.render.triangles;
    this.perf.programs = info.programs?.length ?? 0;
    this.perf.geometries = info.memory?.geometries ?? 0;
    this.perf.textures = info.memory?.textures ?? 0;
    this.perf.activeEntities = this.getEntityCount();
    this.perf.loadedChunks = this.getChunkCount();
    this.perf.pooledObjects = this.getPooled();
    this.perf.cpuMs = ctx.dt * 1000;
    this.perf.gpuEstimateMs = Math.max(0, this.perf.avgFrameMs - ctx.dt * 1000);
    this.lastHeap += ctx.dt;
    if (this.lastHeap > 1) {
      this.lastHeap = 0;
      this.perf.reportHeap();
    }
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export interface SaveRequest {
  data: SaveData;
  manual: boolean;
}

export class SaveSystem implements System {
  readonly name = 'SaveSystem';
  readonly order = 100;
  enabled = true;
  private timer = 0;
  private interval = 20;
  private onSave: ((manual: boolean) => void) | null = null;

  setSaveHandler(fn: (manual: boolean) => void): void {
    this.onSave = fn;
  }

  update(ctx: SystemContext): void {
    this.timer += ctx.dt;
    if (this.timer >= this.interval) {
      this.timer = 0;
      this.onSave?.(false);
    }
  }

  requestManualSave(): void {
    this.onSave?.(true);
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export class UISystem implements System {
  readonly name = 'UISystem';
  readonly order = 110;
  enabled = true;

  constructor(
    private ui: UIController,
    private planetary: PlanetaryState,
    private getScale: () => Scale,
    private getVehicle: () => VehicleBase | null,
    private getCrises: () => CrisisRuntime[],
    private getHarmonic: () => { coherence: number; functional: number; total: number; unlocked: boolean },
    private getObjectiveLines?: () => { text: string; progress: number; done: boolean }[],
    private getSelectedCrisisId?: () => string | null,
  ) {}

  rebind(planetary: PlanetaryState): void {
    this.planetary = planetary;
  }

  update(ctx: SystemContext): void {
    const scale = this.getScale();
    const vehicle = this.getVehicle();
    if (scale === 'SECTOR' || scale === 'ORBIT') {
      if (vehicle) {
        const model = vehicle.hud();
        if (this.getObjectiveLines) {
          model.objectives = this.getObjectiveLines();
        }
        this.ui.setHud(model);
      }
    } else {
      this.ui.setHud(null);
      this.ui.updateMacro(this.planetary, performance.now());
      this.ui.setCrises(this.getCrises(), this.getSelectedCrisisId?.() ?? null);
    }
    const h = this.getHarmonic();
    this.ui.setHarmonicState(h.coherence, h.functional, h.total, h.unlocked);
    void ctx;
  }
}

// ---------------------------------------------------------------------------
// Harmonic spire runtime
// ---------------------------------------------------------------------------

export class SpireRuntimeSystem implements System {
  readonly name = 'SpireRuntimeSystem';
  readonly order = 45;
  enabled = true;

  constructor(
    private spires: SpireRecord[],
    private harmonic: HarmonicSystem,
  ) {}

  rebind(spires: SpireRecord[], harmonic: HarmonicSystem): void {
    this.spires = spires;
    this.harmonic = harmonic;
  }

  update(ctx: SystemContext): void {
    for (const s of this.spires) {
      s.phase = this.harmonic.phases[s.id] ?? s.phase;
    }
    void ctx;
  }
}

export function settlementViabilityTarget(p: PlanetaryState): number {
  const vals: PlanetaryVar[] = ['logisticsIntegrity', 'powerAvailability', 'settlementSafety'];
  let sum = 0;
  for (const v of vals) sum += p.vars[v];
  return clamp01(sum / vals.length);
}

export { PLANETARY_VARS, smoothstep };
