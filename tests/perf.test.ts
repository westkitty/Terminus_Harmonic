import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';

class FakeRenderer {
  domElement: HTMLCanvasElement;
  shadowMap = { enabled: false, type: 0 };
  toneMapping = 0;
  toneMappingExposure = 1;
  outputColorSpace = '';
  autoClear = true;
  info = {
    render: { calls: 0, triangles: 0 },
    memory: { geometries: 0, textures: 0 },
    programs: [] as unknown[],
  };
  capabilities = { isWebGL2: true, maxTextureSize: 4096 };
  constructor(opts: { canvas: HTMLCanvasElement }) {
    this.domElement = opts.canvas;
  }
  setClearColor(): void {}
  setPixelRatio(): void {}
  setSize(): void {}
  getSize(): { width: number; height: number } {
    return { width: 1280, height: 720 };
  }
  clearDepth(): void {}
  clear(): void {}
  render(): void {
    this.info.render.calls++;
    this.info.render.triangles += 128;
  }
  dispose(): void {}
}

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeRenderer };
});

function installEnv(): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="app"><canvas id="scene"></canvas></div></body></html>`,
    { pretendToBeVisual: true, url: 'http://localhost/' },
  );
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  Object.defineProperty(g, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  g.SVGElement = dom.window.SVGElement;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.CustomEvent = dom.window.CustomEvent;
  g.MouseEvent = dom.window.MouseEvent;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.performance = globalThis.performance;
  g.requestAnimationFrame = ((fn: FrameRequestCallback) =>
    setTimeout(() => fn(performance.now()), 16) as unknown as number);
  g.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as (h: number) => void;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  (g.window as { matchMedia: (q: string) => unknown }).matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  (dom.window.HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext =
    () => null;
  return dom;
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const max = sorted[sorted.length - 1];
  return { avg, p50, p95, p99, max, sum };
}

describe('Performance Baseline & Regression Suite', () => {
  it('measures startup, macro frame, overlay switch, transition, sector build, and sector frame costs', async () => {
    const dom = installEnv();
    const { Game } = await import('../src/game/Game');
    const { OVERLAY_MODES } = await import('../src/render/globe');

    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;

    // 1. Cold startup
    const tStart0 = performance.now();
    const game = new Game(canvas);
    game.beginCampaign();
    const coldStartupMs = performance.now() - tStart0;

    // 2. All 7 overlay switches (cold + warm cached pass)
    const tOverlay0 = performance.now();
    for (const mode of OVERLAY_MODES) {
      game.setOverlay(mode);
      game.update(1 / 60, performance.now());
    }
    const overlayCycleMs = performance.now() - tOverlay0;

    const tWarmOverlay0 = performance.now();
    for (const mode of OVERLAY_MODES) {
      game.setOverlay(mode);
      game.update(1 / 60, performance.now());
    }
    const warmOverlayCycleMs = performance.now() - tWarmOverlay0;

    // 3. 300 MACRO frames (advancing simulated `now` by 16.67ms per frame)
    const macroSamples: number[] = [];
    let simNow = performance.now();
    for (let i = 0; i < 300; i++) {
      simNow += 16.667;
      const t0 = performance.now();
      game.update(1 / 60, simNow);
      macroSamples.push(performance.now() - t0);
    }
    const macroStats = stats(macroSamples);

    // 4. Descent transition + ORBIT build (ORBITAL_SHADOW_CASCADE)
    const orbitTransSamples: number[] = [];
    game.startCrisis('ORBITAL_SHADOW_CASCADE');
    for (let i = 0; i < 120; i++) {
      simNow += 16.667;
      const t0 = performance.now();
      game.update(1 / 60, simNow);
      orbitTransSamples.push(performance.now() - t0);
    }
    const orbitTransStats = stats(orbitTransSamples);

    // Ascend back to MACRO
    game.ascend();
    for (let i = 0; i < 120; i++) {
      simNow += 16.667;
      game.update(1 / 60, simNow);
    }

    // 5. Descent transition + SECTOR build (GLASS_BASIN_SUPPLY_FAILURE - LAND_TRAIN)
    const sectorTransSamples: number[] = [];
    game.startCrisis('GLASS_BASIN_SUPPLY_FAILURE');
    for (let i = 0; i < 120; i++) {
      simNow += 16.667;
      const t0 = performance.now();
      game.update(1 / 60, simNow);
      sectorTransSamples.push(performance.now() - t0);
    }
    const sectorTransStats = stats(sectorTransSamples);

    // 6. 300 SECTOR active frames
    const sectorSamples: number[] = [];
    for (let i = 0; i < 300; i++) {
      simNow += 16.667;
      const t0 = performance.now();
      game.update(1 / 60, simNow);
      sectorSamples.push(performance.now() - t0);
    }
    const sectorStats = stats(sectorSamples);

    // 7. Save serialization & checksum
    const tSave0 = performance.now();
    for (let i = 0; i < 20; i++) {
      game.serializeSave();
    }
    const saveSerializeMs = (performance.now() - tSave0) / 20;

    console.log(
      JSON.stringify(
        {
          coldStartupMs: Number(coldStartupMs.toFixed(2)),
          overlayCycleMs: Number(overlayCycleMs.toFixed(2)),
          warmOverlayCycleMs: Number(warmOverlayCycleMs.toFixed(2)),
          macroFrame: {
            avg: Number(macroStats.avg.toFixed(3)),
            p95: Number(macroStats.p95.toFixed(3)),
            p99: Number(macroStats.p99.toFixed(3)),
            max: Number(macroStats.max.toFixed(3)),
            total300: Number(macroStats.sum.toFixed(1)),
          },
          orbitDescent120Frames: {
            totalMs: Number(orbitTransStats.sum.toFixed(1)),
            maxFrameMs: Number(orbitTransStats.max.toFixed(2)),
            p95Ms: Number(orbitTransStats.p95.toFixed(2)),
          },
          sectorDescent120Frames: {
            totalMs: Number(sectorTransStats.sum.toFixed(1)),
            maxFrameMs: Number(sectorTransStats.max.toFixed(2)),
            p95Ms: Number(sectorTransStats.p95.toFixed(2)),
          },
          sectorFrame: {
            avg: Number(sectorStats.avg.toFixed(3)),
            p95: Number(sectorStats.p95.toFixed(3)),
            p99: Number(sectorStats.p99.toFixed(3)),
            max: Number(sectorStats.max.toFixed(3)),
            total300: Number(sectorStats.sum.toFixed(1)),
          },
          saveSerializeMs: Number(saveSerializeMs.toFixed(3)),
        },
        null,
        2,
      ),
    );

    game.dispose();
    // Performance regression guardrails (with CI headroom vs BEFORE baseline):
    const ci = process.env.CI ? 1.75 : 1;
    expect(overlayCycleMs).toBeLessThan(400 * ci); // BEFORE: 564-683 ms
    expect(warmOverlayCycleMs).toBeLessThan(150 * ci); // Cached coarse field across 7 overlays
    expect(macroStats.avg).toBeLessThan(2.5 * ci); // BEFORE: 4.70-5.46 ms
    expect(macroStats.p95).toBeLessThan(5.0 * ci); // BEFORE: 11.81-46.86 ms
    expect(orbitTransStats.sum).toBeLessThan(130 * ci); // BEFORE: 257.6-276.5 ms
    expect(sectorTransStats.sum).toBeLessThan(185 * ci); // BEFORE: 242.9-250.8 ms
    expect(sectorStats.avg).toBeLessThan(1.0 * ci); // BEFORE: 1.90-2.06 ms
    expect(sectorStats.p95).toBeLessThan(1.5 * ci); // BEFORE: 3.04-4.03 ms
    expect(saveSerializeMs).toBeLessThan(1.5 * ci);
  });

  it('profiles sub-component breakdown for globe, terrain, sector build, and UI hot loops', async () => {
    const dom = installEnv();
    const { CommandGlobe } = await import('../src/render/globe');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { SectorField } = await import('../src/sector/field');
    const { TerrainRenderer } = await import('../src/sector/terrain');
    const { SectorEnvironment } = await import('../src/render/environment');

    const tGlobe0 = performance.now();
    const globe = new CommandGlobe(1337, 100);
    const globeConstructMs = performance.now() - tGlobe0;

    const p = new PlanetaryState(1337);
    const snap = p.snapshot();

    // Measure single overlay switch (cold mode -> getCoarseField + paintOverlay)
    const tModeSwitch0 = performance.now();
    globe.setOverlay('GEOLOGY');
    globe.update(1 / 60);
    const singleOverlaySwitchMs = performance.now() - tModeSwitch0;

    // Measure state-only repaint (same mode -> paintOverlay pixel loop only)
    const tStateRepaint0 = performance.now();
    globe.setPlanetaryState(snap, performance.now() + 1000, true);
    globe.update(1 / 60);
    const stateRepaintMs = performance.now() - tStateRepaint0;

    // Measure SectorField + TerrainRenderer construction (buildFar) + 6-ring build
    const tField0 = performance.now();
    const field = new SectorField({
      seed: 1337,
      lat: -14,
      lon: -138,
      radius: 2048,
      biome: 'VITRIFIED_BASIN',
      geothermalPressure: 0.5,
      tectonicShear: 0.5,
      atmosphereToxicity: 0.5,
      soilViability: 0.5,
      turbulence: 0.2,
    });
    const tTerrain0 = performance.now();
    const terrain = new TerrainRenderer(field);
    const terrainConstructFarMs = performance.now() - tTerrain0;

    const tRings0 = performance.now();
    terrain.update(0, 0, 8);
    const terrainBuildAllRingsMs = performance.now() - tRings0;

    // Measure crossing a chunk boundary with budget=2
    const tChunkStep0 = performance.now();
    terrain.update(165, 0, 2);
    const terrainChunkStepMs = performance.now() - tChunkStep0;

    // Measure SectorEnvironment construction
    const tEnv0 = performance.now();
    const env = new SectorEnvironment(field, { shadows: true, shadowMapSize: 1024, particleScale: 1 });
    env.buildSpires([0, 1], [true, false]);
    const sectorEnvMs = performance.now() - tEnv0;

    console.log(
      JSON.stringify(
        {
          globeConstructMs: Number(globeConstructMs.toFixed(2)),
          globeTriangles: globe.triangleCount,
          singleOverlaySwitchMs: Number(singleOverlaySwitchMs.toFixed(2)),
          stateRepaintMs: Number(stateRepaintMs.toFixed(2)),
          terrainConstructFarMs: Number(terrainConstructFarMs.toFixed(2)),
          terrainBuildAllRingsMs: Number(terrainBuildAllRingsMs.toFixed(2)),
          terrainChunkStepMs: Number(terrainChunkStepMs.toFixed(2)),
          terrainTriangles: terrain.triangles,
          sectorEnvMs: Number(sectorEnvMs.toFixed(2)),
        },
        null,
        2,
      ),
    );
    void tField0;
    void dom;
    globe.dispose();
    terrain.dispose();
    env.dispose();

    // Sub-component regression assertions vs BEFORE baseline:
    const ci = process.env.CI ? 1.75 : 1;
    expect(globeConstructMs).toBeLessThan(60 * ci); // BEFORE: 142.28 ms
    expect(singleOverlaySwitchMs).toBeLessThan(45 * ci); // BEFORE: 72.45 ms
    expect(stateRepaintMs).toBeLessThan(25 * ci); // BEFORE: 46.00 ms
    expect(terrainConstructFarMs).toBeLessThan(8 * ci); // BEFORE: 19.68 ms
    expect(terrainBuildAllRingsMs).toBeLessThan(32 * ci); // BEFORE: 60.03 ms
    expect(terrainChunkStepMs).toBeLessThan(8 * ci); // BEFORE: 15.60 ms
  });

  it('survives repeated descent/ascent stress cycles without entity leaks or frame blowups', async () => {
    const dom = installEnv();
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const { Game } = await import('../src/game/Game');
    const game = new Game(canvas);
    game.beginCampaign();

    const baseEntities = game.debugState().entityCount;
    let simNow = performance.now();
    const crises = ['ORBITAL_SHADOW_CASCADE', 'GLASS_BASIN_SUPPLY_FAILURE', 'ORBITAL_SHADOW_CASCADE'] as const;

    for (const cid of crises) {
      game.startCrisis(cid);
      for (let i = 0; i < 110; i++) {
        simNow += 16.667;
        game.update(1 / 60, simNow);
      }
      expect(game.debugState().scale).toMatch(/ORBIT|SECTOR/);
      game.ascend();
      for (let i = 0; i < 110; i++) {
        simNow += 16.667;
        game.update(1 / 60, simNow);
      }
      expect(game.debugState().scale).toBe('MACRO');
      expect(game.debugState().entityCount).toBe(baseEntities);
    }

    game.dispose();
  });
});
