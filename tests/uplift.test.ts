import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const renderLog: { scene: string; camera: string }[] = [];

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
  render(scene: { name?: string }, camera: { name?: string }): void {
    this.info.render.calls++;
    this.info.render.triangles += 128;
    renderLog.push({ scene: scene.name ?? '?', camera: camera.name ?? '?' });
  }
  dispose(): void {}
}

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: FakeRenderer };
});

let dom: JSDOM;
function installEnv(): void {
  dom = new JSDOM(
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
}

let Game: typeof import('../src/game/Game').Game;

beforeEach(async () => {
  installEnv();
  renderLog.length = 0;
  if (!Game) Game = (await import('../src/game/Game')).Game;
});

function makeGame(): InstanceType<typeof Game> {
  const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
  return new Game(canvas);
}

describe('Quality uplift regressions', () => {
  it('steps the possessed vehicle during sector gameplay and populates HUD objectives & control chips', () => {
    const game = makeGame();
    game.beginCampaign();
    game.startCrisis('ATMOSPHERIC_SHEAR_CORRIDOR');
    for (let i = 0; i < 120; i++) game.update(1 / 60);

    expect(game.debugState().scale).toBe('SECTOR');
    expect(game.debugState().activeVehicle).toBe('GLIDER');

    // HUD objectives and control chips are populated from the active crisis and vehicle.
    const objItems = dom.window.document.querySelectorAll('#obj-body .obj');
    expect(objItems.length).toBeGreaterThan(0);
    const ctrlChips = dom.window.document.querySelectorAll('#hud-controls .hud-ctrl-chip');
    expect(ctrlChips.length).toBeGreaterThan(0);

    // Clicking the HUD camera button cycles the glider's camera mode.
    const camBadge = dom.window.document.getElementById('hud-cam-mode')!;
    const initialCam = camBadge.textContent;
    (dom.window.document.getElementById('hud-cam-btn') as HTMLButtonElement).click();
    game.update(1 / 60);
    expect(camBadge.textContent).not.toBe(initialCam);
    game.dispose();
  });

  it('Separates worldGroup from hull object3D across vehicles so deployed elements stay world-anchored', async () => {
    const THREE = await import('three');
    const { World } = await import('../src/core/ecs');
    const { InputManager, DEFAULT_BINDINGS } = await import('../src/core/input');
    const { SectorField, TunnelLattice } = await import('../src/sector/field');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { OrbitalSkiff } = await import('../src/vehicle/orbital');
    const { StrataCrawler } = await import('../src/vehicle/crawler');
    const { AtmosphericGlider } = await import('../src/vehicle/glider');
    const { LandTrain } = await import('../src/vehicle/landtrain');

    const world = new World();
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const input = new InputManager(canvas, DEFAULT_BINDINGS);
    const field = new SectorField({
      seed: 42,
      lat: 10,
      lon: 20,
      radius: 2048,
      biome: 'SHATTERED_BASALT',
      geothermalPressure: 0.5,
      tectonicShear: 0.5,
      atmosphereToxicity: 0.5,
      soilViability: 0.5,
      turbulence: 0.2,
    });
    const lattice = new TunnelLattice(4, 256, 128);
    lattice.configure(0, 0, field.elevation(0, 0));
    const env = {
      world,
      input,
      field,
      lattice,
      planetary: new PlanetaryState(42),
      sunDirection: new THREE.Vector3(0, 1, 0),
      wind: new THREE.Vector3(),
      camera: new THREE.PerspectiveCamera(),
      impact: () => {},
      blip: () => {},
      reportObjective: () => {},
      particleScale: 1,
      reducedMotion: false,
    };

    const skiff = new OrbitalSkiff(world, env);
    skiff.spawn(new THREE.Vector3(100, 50, -80), 0.7);
    skiff.populateDebris(99, 12, 1);
    expect(skiff.worldGroup.position.length()).toBe(0);
    expect(skiff.worldGroup.children.length).toBeGreaterThanOrEqual(3);

    const crawler = new StrataCrawler(world, env);
    crawler.spawn(new THREE.Vector3(20, -10, 30), 0.5);
    let surveyFired = false;
    crawler.onObjective('survey', () => {
      surveyFired = true;
    });
    crawler.interact();
    expect(crawler.installedExchangers).toBe(1);
    expect(surveyFired).toBe(true);
    expect(crawler.worldGroup.position.length()).toBe(0);

    const glider = new AtmosphericGlider(world, env);
    glider.seedThermals(77, 10, 4);
    glider.spawn(new THREE.Vector3(0, 900, 0), 0);
    expect(glider.worldGroup.children.length).toBeGreaterThanOrEqual(2);

    const train = new LandTrain(world, env);
    train.spawn(new THREE.Vector3(45, 0, -60), 0.25);
    expect(train.worldPosition.x).toBeCloseTo(45, 3);
    expect(train.worldPosition.z).toBeCloseTo(-60, 3);

    skiff.dispose();
    crawler.dispose();
    glider.dispose();
    train.dispose();
    input.dispose();
  });

  it('renders the Harmonic Phase-Lock Polar Scope, Settlement Ledger, and Briefing Lock/Forecast polarity', () => {
    const game = makeGame();
    game.beginCampaign();
    for (let i = 0; i < 10; i++) game.update(1 / 60);

    // 12 spire dots in the polar scope and 8 settlements in the ledger.
    const spireDots = dom.window.document.querySelectorAll('#harmonic-spire-dots circle');
    expect(spireDots.length).toBe(12);
    const settlements = dom.window.document.querySelectorAll('#settlement-grid .settlement-row');
    expect(settlements.length).toBe(8);

    // Pinging a functional spire aligns its phase and updates the spire inspector.
    game.pingSpire(0);
    expect(dom.window.document.getElementById('spire-name-lbl')?.textContent).toContain('Kestrel');

    // Selecting a locked crisis displays the lock reason banner in the briefing modal.
    game.selectNode('HARMONIC_FAULT');
    const lockBanner = dom.window.document.getElementById('briefing-lock-reason')!;
    expect(lockBanner.classList.contains('visible')).toBe(true);
    expect(lockBanner.textContent).toContain('LOCKED');

    // Forecast deltas that reduce a harmful variable (orbitalOcclusion) are marked beneficial (.up).
    game.selectNode('ORBITAL_SHADOW_CASCADE');
    const upDeltas = dom.window.document.querySelectorAll('#briefing-forecast .delta.up');
    expect(upDeltas.length).toBeGreaterThan(0);

    game.dispose();
  });

  it('wires touch controls, ORBIT scale rendering, and mid-crisis baseline effects', () => {
    const game = makeGame();
    game.beginCampaign();
    const initialLogistics = game.debugState().planetary.baselines.logisticsIntegrity;

    game.startCrisis('GLASS_BASIN_SUPPLY_FAILURE');
    for (let i = 0; i < 120; i++) game.update(1 / 60);
    expect(game.debugState().scale).toBe('SECTOR');

    // Completing all objectives resolves the crisis and shifts baselines.
    game.completeActiveObjectives();
    expect(game.debugState().resolvedCount).toBe(1);
    expect(game.debugState().planetary.baselines.logisticsIntegrity).not.toBe(initialLogistics);

    // HUD ascend button returns to the Command Lattice.
    const ascendBtn = dom.window.document.getElementById('hud-ascend-btn') as HTMLButtonElement;
    ascendBtn.click();
    for (let i = 0; i < 120; i++) game.update(1 / 60);
    expect(game.debugState().scale).toBe('MACRO');

    // Descending into ORBITAL_SHADOW_CASCADE enters the ORBIT scale with the OrbitalSkiff.
    game.startCrisis('ORBITAL_SHADOW_CASCADE');
    for (let i = 0; i < 120; i++) game.update(1 / 60);
    expect(game.debugState().scale).toBe('ORBIT');
    expect(game.debugState().activeVehicle).toBe('ORBITAL_SKIFF');

    game.dispose();
  });

  it('rebinds ECS systems and UI planetary reference on newWorld and projects the globe reticle', () => {
    const game = makeGame();
    game.beginCampaign();

    // Selecting a node focuses the camera on it and projects the 3D reticle callout once in view.
    game.selectNode('ORBITAL_SHADOW_CASCADE');
    for (let i = 0; i < 90; i++) game.update(1 / 60);
    const reticle = dom.window.document.getElementById('globe-reticle')!;
    expect(reticle.classList.contains('visible')).toBe(true);
    expect(dom.window.document.getElementById('reticle-title')?.textContent).toContain('Orbital Shadow');

    // Generating a new world rebinds GlobalStateSystem so simTime advances on the new PlanetaryState.
    game.newWorld();
    const t0 = game.debugState().planetary.simTime;
    for (let i = 0; i < 60; i++) game.update(1 / 60);
    const t1 = game.debugState().planetary.simTime;
    expect(t1).toBeGreaterThan(t0);

    game.dispose();
  });
});
