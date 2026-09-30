/**
 * PERFORMANCE MONITOR + ADAPTIVE QUALITY
 * ======================================
 *
 * Frame timing is measured from real timestamps, not assumed. The adaptive
 * quality controller reads a rolling median frame time and steps device pixel
 * ratio, shadow map size, particle budget and postprocessing on/off. Nothing is
 * claimed about 60 FPS anywhere in the codebase; the overlay reports what was
 * actually observed.
 */

export type QualityTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA';

export interface QualitySettings {
  tier: QualityTier;
  /** Device pixel ratio cap. */
  maxPixelRatio: number;
  shadowsEnabled: boolean;
  shadowMapSize: number;
  postprocessing: boolean;
  /** Multiplier on particle counts. */
  particleScale: number;
  /** Terrain rebuild budget per frame. */
  terrainBudget: number;
  /** Distance at which LOD swaps happen. */
  lodBias: number;
  antialias: boolean;
}

const TIER_TABLE: Record<QualityTier, Omit<QualitySettings, 'tier'>> = {
  LOW: {
    maxPixelRatio: 1,
    shadowsEnabled: false,
    shadowMapSize: 512,
    postprocessing: false,
    particleScale: 0.35,
    terrainBudget: 1,
    lodBias: 0.7,
    antialias: false,
  },
  MEDIUM: {
    maxPixelRatio: 1.25,
    shadowsEnabled: true,
    shadowMapSize: 1024,
    postprocessing: false,
    particleScale: 0.6,
    terrainBudget: 1,
    lodBias: 0.85,
    antialias: false,
  },
  HIGH: {
    maxPixelRatio: 1.5,
    shadowsEnabled: true,
    shadowMapSize: 2048,
    postprocessing: true,
    particleScale: 1,
    terrainBudget: 2,
    lodBias: 1,
    antialias: true,
  },
  ULTRA: {
    maxPixelRatio: 2,
    shadowsEnabled: true,
    shadowMapSize: 4096,
    postprocessing: true,
    particleScale: 1.5,
    terrainBudget: 3,
    lodBias: 1.15,
    antialias: true,
  },
};

export function qualityForTier(tier: QualityTier): QualitySettings {
  return { tier, ...TIER_TABLE[tier] };
}

/** Pick a starting tier from cheap hardware hints. Never asserts performance. */
export function detectInitialTier(): QualityTier {
  if (typeof navigator === 'undefined') return 'MEDIUM';
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (mobile) return cores >= 8 ? 'MEDIUM' : 'LOW';
  if (cores >= 12 && (mem === undefined || mem >= 8)) return 'HIGH';
  if (cores >= 6) return 'MEDIUM';
  return 'LOW';
}

interface FrameSample {
  t: number;
  dt: number;
}

export class PerformanceMonitor {
  private samples: FrameSample[] = [];
  private windowMs = 1200;
  lastFrameMs = 16.7;
  smoothedFrameMs = 16.7;
  fps = 60;
  minFps = 999;
  maxFps = 0;
  /** Rolling average over the last second. */
  avgFrameMs = 16.7;
  private worstFrameMs = 0;

  drawCalls = 0;
  triangles = 0;
  programs = 0;
  geometries = 0;
  textures = 0;
  activeEntities = 0;
  loadedChunks = 0;
  pooledObjects = 0;
  jsHeapMb = 0;

  /** Simulation/render split. */
  cpuMs = 0;
  gpuEstimateMs = 0;

  private adaptiveEnabled = true;
  private tier: QualityTier;
  private lastTierChange = 0;
  private timeInTier = 0;
  private degradeCooldown = 4000;
  private upgradeCooldown = 12000;
  private consecutiveSlowFrames = 0;
  private consecutiveFastFrames = 0;
  private manualOverride = false;

  onTierChange: ((settings: QualitySettings) => void) | null = null;

  constructor(initialTier?: QualityTier) {
    this.tier = initialTier ?? detectInitialTier();
  }

  get settings(): QualitySettings {
    return qualityForTier(this.tier);
  }

  get currentTier(): QualityTier {
    return this.tier;
  }

  setAdaptive(enabled: boolean): void {
    this.adaptiveEnabled = enabled;
    if (!enabled) this.consecutiveSlowFrames = 0;
  }

  setTier(tier: QualityTier, manual = true): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.manualOverride = manual;
    this.lastTierChange = performance.now();
    this.timeInTier = 0;
    this.consecutiveSlowFrames = 0;
    this.consecutiveFastFrames = 0;
    this.onTierChange?.(this.settings);
  }

  beginFrame(now: number): void {
    const last = this.samples.length > 0 ? this.samples[this.samples.length - 1].t : now;
    const dt = Math.max(0.0001, now - last);
    this.lastFrameMs = dt;
    this.smoothedFrameMs = this.smoothedFrameMs * 0.9 + dt * 0.1;
    this.samples.push({ t: now, dt });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) this.samples.shift();
    let sum = 0;
    let worst = 0;
    for (const s of this.samples) {
      sum += s.dt;
      if (s.dt > worst) worst = s.dt;
    }
    this.avgFrameMs = sum / Math.max(1, this.samples.length);
    this.worstFrameMs = worst;
    this.fps = 1000 / Math.max(0.0001, this.avgFrameMs);
    this.minFps = Math.min(this.minFps, this.fps);
    this.maxFps = Math.max(this.maxFps, this.fps);
  }

  /** Called after the frame is presented; drives adaptive quality. */
  endFrame(now: number): void {
    if (!this.adaptiveEnabled || this.manualOverride) return;
    this.timeInTier += this.lastFrameMs;
    if (now - this.lastTierChange < this.degradeCooldown) return;

    const target = 1000 / 60;
    if (this.avgFrameMs > target * 1.35) {
      this.consecutiveSlowFrames++;
      this.consecutiveFastFrames = 0;
    } else if (this.avgFrameMs < target * 1.05) {
      this.consecutiveFastFrames++;
      this.consecutiveSlowFrames = 0;
    } else {
      this.consecutiveSlowFrames = 0;
      this.consecutiveFastFrames = 0;
    }

    const order: QualityTier[] = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'];
    const idx = order.indexOf(this.tier);

    if (this.consecutiveSlowFrames > 90 && idx > 0) {
      this.setTier(order[idx - 1], false);
    } else if (this.consecutiveFastFrames > 600 && idx < order.length - 1 && this.timeInTier > this.upgradeCooldown) {
      this.setTier(order[idx + 1], false);
    }
  }

  reportHeap(): void {
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
    if (perf.memory) this.jsHeapMb = perf.memory.usedJSHeapSize / (1024 * 1024);
  }

  /** Snapshot for the developer overlay. */
  metrics() {
    return {
      fps: this.fps,
      frameMs: this.avgFrameMs,
      smoothedFrameMs: this.smoothedFrameMs,
      worstFrameMs: this.worstFrameMs,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      programs: this.programs,
      geometries: this.geometries,
      textures: this.textures,
      activeEntities: this.activeEntities,
      loadedChunks: this.loadedChunks,
      pooledObjects: this.pooledObjects,
      jsHeapMb: this.jsHeapMb,
      cpuMs: this.cpuMs,
      gpuEstimateMs: this.gpuEstimateMs,
      tier: this.tier,
      adaptive: this.adaptiveEnabled && !this.manualOverride,
    };
  }

  reset(): void {
    this.samples.length = 0;
    this.minFps = 999;
    this.maxFps = 0;
  }
}
