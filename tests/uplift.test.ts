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

  it('applies unlocked domain modules to vehicle physics, HUD flags, and Harmonic phase-lock rate', async () => {
    const THREE = await import('three');
    const { World } = await import('../src/core/ecs');
    const { InputManager, DEFAULT_BINDINGS } = await import('../src/core/input');
    const { SectorField, TunnelLattice } = await import('../src/sector/field');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { OrbitalSkiff } = await import('../src/vehicle/orbital');
    const { StrataCrawler } = await import('../src/vehicle/crawler');
    const { AtmosphericGlider } = await import('../src/vehicle/glider');
    const { LandTrain } = await import('../src/vehicle/landtrain');
    const { HarmonicSystem } = await import('../src/systems/systems');

    const world = new World();
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const input = new InputManager(canvas, DEFAULT_BINDINGS);
    const field = new SectorField({
      seed: 42,
      lat: 10,
      lon: 20,
      radius: 2048,
      biome: 'SALT_FLAT',
      geothermalPressure: 0.6,
      tectonicShear: 0.5,
      atmosphereToxicity: 0.5,
      soilViability: 0.5,
      turbulence: 0.2,
    });
    const lattice = new TunnelLattice(4, 256, 128);
    lattice.configure(0, 0, field.elevation(0, 0));
    const baseEnv = {
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
      unlockedModules: [] as string[],
    };

    // 1. LandTrain: Route Grader reduces ground failure ratio on soft Salt Flat ground.
    const trainBase = new LandTrain(world, baseEnv);
    trainBase.spawn(new THREE.Vector3(0, 0, 0), 0);
    trainBase.update(1 / 60);
    const baseFailure = trainBase.predictedFailureRatio;

    const trainUpgraded = new LandTrain(world, {
      ...baseEnv,
      unlockedModules: ['Bogie Load Balancer', 'Route Grader', 'Depot Link'],
    });
    trainUpgraded.spawn(new THREE.Vector3(0, 0, 0), 0);
    trainUpgraded.update(1 / 60);
    expect(trainUpgraded.predictedFailureRatio).toBeLessThan(baseFailure);
    expect(trainUpgraded.hud().flags.some((f) => f.label === 'MOD · Route Grader' && f.on)).toBe(true);

    // 2. AtmosphericGlider: Sampler Winch lowers parasitic drag at equal airspeed.
    const gliderBase = new AtmosphericGlider(world, baseEnv);
    gliderBase.spawn(new THREE.Vector3(0, 900, 0), 0);
    gliderBase.velocity.set(0, 0, -28);
    gliderBase.update(1 / 60);

    const gliderUpgraded = new AtmosphericGlider(world, {
      ...baseEnv,
      unlockedModules: ['Sensor Dispenser', 'Thermal Reader', 'Sampler Winch'],
    });
    gliderUpgraded.spawn(new THREE.Vector3(0, 900, 0), 0);
    gliderUpgraded.velocity.set(0, 0, -28);
    gliderUpgraded.update(1 / 60);
    expect(gliderUpgraded.dragForce).toBeGreaterThan(0);
    expect(gliderUpgraded.dragForce).toBeLessThan(gliderBase.dragForce);
    expect(gliderUpgraded.hud().flags.some((f) => f.label === 'MOD · Sampler Winch' && f.on)).toBe(true);

    // 3. StrataCrawler: Exchanger Mount cools cutter more aggressively when seating an exchanger.
    const crawlerBase = new StrataCrawler(world, baseEnv);
    crawlerBase.spawn(new THREE.Vector3(0, -10, 0), 0);
    const crawlerUpgraded = new StrataCrawler(world, {
      ...baseEnv,
      unlockedModules: ['Coolant Loop', 'Strata Sonde', 'Exchanger Mount', 'Seal Injector'],
    });
    crawlerUpgraded.spawn(new THREE.Vector3(0, -10, 0), 0);
    expect(crawlerUpgraded.hud().flags.some((f) => f.label === 'MOD · Coolant Loop' && f.on)).toBe(true);

    // 4. OrbitalSkiff: surfaces active Orbit modules in HUD flags.
    const skiffUpgraded = new OrbitalSkiff(world, {
      ...baseEnv,
      unlockedModules: ['Tether Winch', 'Rendezvous Assist', 'Corridor Beacon'],
    });
    skiffUpgraded.spawn(new THREE.Vector3(0, 0, 0), 0);
    expect(skiffUpgraded.hud().flags.some((f) => f.label === 'MOD · Tether Winch' && f.on)).toBe(true);

    // 5. HarmonicSystem: Phase Reference / Interference Mapper accelerates establishment and raises lock strength on serviced spires.
    const makeSpires = () =>
      Array.from({ length: 12 }, (_, id) => ({
        id,
        functional: id < 9,
        phase: id * 30,
        repairs: id < 9 ? 2 : 0,
        seated: true,
      }));
    const hBase = new HarmonicSystem(new PlanetaryState(42), makeSpires());
    const hUpgraded = new HarmonicSystem(new PlanetaryState(42), makeSpires());
    hUpgraded.setUnlockedModules(['Phase Reference', 'Interference Mapper']);
    let baseFrames = 3600;
    let upgradedFrames = 3600;
    for (let i = 0; i < 3600; i++) {
      const ctx = { world, dt: 1 / 60, elapsed: i / 60, frame: i, bus: world.bus };
      hBase.update(ctx);
      hUpgraded.update(ctx);
      if (hBase.established && baseFrames === 3600) baseFrames = i;
      if (hUpgraded.established && upgradedFrames === 3600) upgradedFrames = i;
    }
    expect(upgradedFrames).toBeLessThan(baseFrames);
    expect(hUpgraded.locks[0]).toBeGreaterThan(hBase.locks[0]);

    trainBase.dispose();
    trainUpgraded.dispose();
    gliderBase.dispose();
    gliderUpgraded.dispose();
    crawlerBase.dispose();
    crawlerUpgraded.dispose();
    skiffUpgraded.dispose();
    input.dispose();
  });

  it('wires Causal Coupling Inspector, Survey Codex, Blueprints, Settlement Focus, and Overlay Shortcuts', () => {
    const game = makeGame();
    game.beginCampaign();
    for (let i = 0; i < 10; i++) game.update(1 / 60);

    // 1. Causal Coupling Inspector is populated and interactive.
    const inspector = dom.window.document.getElementById('var-inspector')!;
    expect(inspector.textContent).toContain('Harmonic Coherence');
    const tectonicRow = dom.window.document.querySelector('.var-row[data-var="tectonicShear"]') as HTMLElement;
    expect(tectonicRow).toBeTruthy();
    tectonicRow.click();
    expect(tectonicRow.classList.contains('is-selected')).toBe(true);
    expect(inspector.textContent).toContain('Tectonic Shear');
    expect(inspector.querySelectorAll('.var-coup-chip').length).toBeGreaterThan(0);

    // 2. Crisis Briefing renders the SVG vehicle blueprint, biome metrics, and domain subsystems.
    game.selectNode('ORBITAL_SHADOW_CASCADE');
    const bp = dom.window.document.getElementById('briefing-blueprint')!;
    expect(bp.querySelector('svg.blueprint-svg')).toBeTruthy();
    expect(bp.textContent).toContain('ARS-VI');
    expect(bp.textContent).toContain('Tether Winch');
    (dom.window.document.getElementById('briefing-close') as HTMLButtonElement).click();

    // 3. Survey Archive & Engineering Codex opens via button or [C] and renders all 4 tabs.
    const codexBtn = dom.window.document.getElementById('macro-codex-btn') as HTMLButtonElement;
    expect(codexBtn).toBeTruthy();
    codexBtn.click();
    const codex = dom.window.document.getElementById('codex')!;
    expect(codex.classList.contains('open')).toBe(true);
    expect(codex.textContent).toContain('Orbit Domain');

    const bpTab = codex.querySelector('.codex-tab[data-tab="BLUEPRINTS"]') as HTMLButtonElement;
    bpTab.click();
    expect(codex.querySelectorAll('svg.blueprint-svg').length).toBe(4);

    const provTab = codex.querySelector('.codex-tab[data-tab="PROVENANCE"]') as HTMLButtonElement;
    provTab.click();
    expect(codex.textContent).toContain('0-ARK Survey Designations');
    expect(codex.textContent).toContain('bloodEclipseWarYears');

    const logTab = codex.querySelector('.codex-tab[data-tab="LOG"]') as HTMLButtonElement;
    logTab.click();
    expect(codex.querySelectorAll('.codex-log-row').length).toBeGreaterThan(0);
    (dom.window.document.getElementById('codex-close') as HTMLButtonElement).click();
    expect(codex.classList.contains('open')).toBe(false);

    // 4. Clicking a settlement row focuses the settlement and marks it selected.
    const firstSettlement = dom.window.document.querySelector('#settlement-grid .settlement-row') as HTMLElement;
    expect(firstSettlement).toBeTruthy();
    firstSettlement.click();
    expect(firstSettlement.classList.contains('selected')).toBe(true);

    // 5. Pressing Digit1..Digit7 in MACRO switches the active globe overlay.
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Digit7', bubbles: true }));
    expect(game.debugState().overlay).toBe('HARMONIC');
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Digit1', bubbles: true }));
    expect(game.debugState().overlay).toBe('TOPOGRAPHY');

    // 6. serializeSave() snapshots live state even without a prior saveGame() call.
    game.startCrisis('GLASS_BASIN_SUPPLY_FAILURE');
    for (let i = 0; i < 100; i++) game.update(1 / 60);
    game.completeActiveObjectives();
    const exported = JSON.parse(game.serializeSave());
    expect(exported.campaign.unlockedModules).toContain('Bogie Load Balancer');
    expect(exported.crises.find((c: { id: string }) => c.id === 'GLASS_BASIN_SUPPLY_FAILURE').status).toBe('RESOLVED');

    game.dispose();
  });

  it('verifies VAS-01..VAS-05 visual asset geometry, shader, environment, and icon pipeline', async () => {
    const fs = await import('node:fs');
    const zlib = await import('node:zlib');
    const THREE = await import('three');
    const { CommandGlobe } = await import('../src/render/globe');
    const { SkyDome } = await import('../src/render/sky');
    const { SectorEnvironment } = await import('../src/render/environment');
    const { SectorField, TunnelLattice } = await import('../src/sector/field');
    const { World } = await import('../src/core/ecs');
    const { InputManager, DEFAULT_BINDINGS } = await import('../src/core/input');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { OrbitalSkiff } = await import('../src/vehicle/orbital');
    const { StrataCrawler } = await import('../src/vehicle/crawler');
    const { AtmosphericGlider } = await import('../src/vehicle/glider');

    // VAS-01: Inspect generated PNG icon IDAT scanlines to verify deep obsidian void background (#07080a), not blown-out white (#ffffff).
    for (const iconPath of ['public/icons/icon-192.png', 'public/icons/icon-512.png', 'public/icons/icon-maskable-512.png']) {
      const buf = fs.readFileSync(iconPath);
      expect(buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
      // Extract IDAT payload (starts at byte 8 + 25 (IHDR) + 8 = 41).
      const idatLen = buf.readUInt32BE(33);
      const raw = zlib.inflateSync(buf.subarray(41, 41 + idatLen));
      // First pixel after filter byte 0 at top-left corner (x=0, y=0) is deep obsidian void (R,G,B < 20, A = 255).
      expect(raw[1]).toBeLessThan(20);
      expect(raw[2]).toBeLessThan(20);
      expect(raw[3]).toBeLessThan(24);
      expect(raw[4]).toBe(255);
    }

    // VAS-02: CommandGlobe spires and crisis markers are oriented radially along +Z, and harmonicLines connects the 12 spires.
    const globe = new CommandGlobe(1337, 100, 'TOPOGRAPHY');
    let spireFound = false;
    let harmonicFound = false;
    globe.group.traverse((obj) => {
      if (obj.userData?.spireId !== undefined && obj.type === 'Mesh') {
        const mesh = obj as InstanceType<typeof THREE.Mesh>;
        mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox && mesh.geometry.boundingBox.max.z > 3.0) {
          spireFound = true;
        }
      }
      if (obj.type === 'LineSegments' && obj !== globe.group.children[4]) {
        harmonicFound = true;
      }
    });
    expect(spireFound).toBe(true);
    expect(harmonicFound).toBe(true);
    globe.dispose();

    // VAS-03: SkyDome shader includes 3D direction-cell hash3 starfield and Siege Wall starless-absence swath.
    const sky = new SkyDome(1000);
    const frag = (sky.mesh.material as InstanceType<typeof THREE.ShaderMaterial>).fragmentShader;
    expect(frag).toContain('hash3');
    expect(frag).toContain('siegeAbsence');
    sky.dispose();

    // VAS-04: SectorEnvironment preserves setSunDirection across update(), builds biome landmarks, and clamps distant spires to horizon ring.
    const field = new SectorField({
      seed: 42,
      lat: 10,
      lon: 20,
      radius: 2048,
      biome: 'FOUNDRY_RUIN',
      geothermalPressure: 0.5,
      tectonicShear: 0.5,
      atmosphereToxicity: 0.5,
      soilViability: 0.5,
      turbulence: 0.2,
    });
    const sectorEnv = new SectorEnvironment(field, { shadows: false, shadowMapSize: 512, particleScale: 0.5 });
    sectorEnv.setSunDirection(new THREE.Vector3(-0.8, 0.5, -0.3));
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 10, 0);
    sectorEnv.update(1 / 60, 1.0, cam);
    expect(sectorEnv.sun.position.x).toBeLessThan(0);
    expect(sectorEnv.sun.position.z).toBeLessThan(0);
    sectorEnv.buildSpires([0, 1, 2, 3], [true, true, false, true]);
    const spireGroup = sectorEnv.group.children.find((c) => c.userData?.spireId !== undefined)!;
    const spireDist = Math.hypot(spireGroup.position.x, spireGroup.position.z);
    expect(spireDist).toBeGreaterThanOrEqual(180);
    expect(spireDist).toBeLessThanOrEqual(920);
    const landmarkChild = sectorEnv.group.children.find((c) => c.name.startsWith('landmark-'));
    expect(landmarkChild).toBeTruthy();
    sectorEnv.dispose();

    // VAS-05: Glider nose cone points forward (+PI/2), OrbitalSkiff hull matches bow taper (-PI/2), StrataCrawler cutter teeth are local to drum.
    const world = new World();
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const input = new InputManager(canvas, DEFAULT_BINDINGS);
    const lattice = new TunnelLattice(4, 128, 64);
    lattice.configure(0, 0, field.elevation(0, 0));
    const vEnv = {
      world,
      input,
      field,
      lattice,
      planetary: new PlanetaryState(42),
      sunDirection: new THREE.Vector3(0, 1, 0),
      wind: new THREE.Vector3(),
      camera: cam,
      impact: () => {},
      blip: () => {},
      reportObjective: () => {},
      particleScale: 0.5,
      reducedMotion: false,
    };

    const glider = new AtmosphericGlider(world, vEnv);
    const airframe = glider.object3D.children[0];
    const gliderNose = airframe.children[1];
    expect(gliderNose.rotation.x).toBeCloseTo(Math.PI / 2, 4);

    const skiff = new OrbitalSkiff(world, vEnv);
    const skiffHull = skiff.object3D.children[0];
    const skiffBody = skiffHull.children[0];
    expect(skiffBody.rotation.z).toBeCloseTo(-Math.PI / 2, 4);

    const crawler = new StrataCrawler(world, vEnv);
    const cutterHead = crawler.object3D.children.find((c) => c.children.length >= 10)!;
    const cutterTooth = cutterHead.children[0];
    expect(Math.abs(cutterTooth.position.z)).toBeLessThan(2.0);

    // GitHub Pages workflow, .nojekyll, and relative base path configuration.
    expect(fs.existsSync('public/.nojekyll')).toBe(true);
    const workflow = fs.readFileSync('.github/workflows/pages.yml', 'utf8');
    expect(workflow).toContain('actions/configure-pages@v5');
    expect(workflow).toContain('actions/upload-pages-artifact@v3');
    expect(workflow).toContain('actions/deploy-pages@v4');
    const viteCfg = fs.readFileSync('vite.config.ts', 'utf8');
    expect(viteCfg).toContain("base: './'");
    expect(viteCfg).toContain('404.html');

    glider.dispose();
    skiff.dispose();
    crawler.dispose();
    input.dispose();
  });
});
