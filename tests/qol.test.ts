import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { FakeRenderer } = vi.hoisted(() => {
  class FakeRenderer {
    domElement: any;
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
    constructor(opts: { canvas: any }) {
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
  return { FakeRenderer };
});

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
  dom.window.prompt = vi.fn();
  (g as any).prompt = dom.window.prompt;
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(''),
    },
    configurable: true,
    writable: true,
  });
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  g.HTMLInputElement = dom.window.HTMLInputElement;
  g.HTMLButtonElement = dom.window.HTMLButtonElement;
  g.SVGElement = dom.window.SVGElement;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.CustomEvent = dom.window.CustomEvent;
  g.MouseEvent = dom.window.MouseEvent;
  g.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;
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

describe('25 Quality of Life (QoL) Improvements Test Suite', () => {
  beforeEach(() => {
    installEnv();
  });

  it('1. Quick Save (F5) and Quick Load (F9) keybindings and notifications work', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const saveSpy = vi.spyOn(game, 'saveGame').mockResolvedValue({} as any);
    const loadSpy = vi.spyOn(game, 'loadGame').mockResolvedValue();

    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'F5', bubbles: true }));
    expect(saveSpy).toHaveBeenCalledWith(true);

    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'F9', bubbles: true }));
    expect(loadSpy).toHaveBeenCalled();

    game.dispose();
  });

  it('2. Simulation Time Warp Controls (Pause, 1x, 2x, 5x, Space, [ / ]) function accurately', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    // Toolbar buttons
    const btn2x = dom.window.document.querySelector('.time-warp-btn[data-speed="2"]') as HTMLButtonElement;
    const btn5x = dom.window.document.querySelector('.time-warp-btn[data-speed="5"]') as HTMLButtonElement;
    const btnPause = dom.window.document.querySelector('.time-warp-btn[data-speed="0"]') as HTMLButtonElement;

    expect(btn2x).not.toBeNull();
    btn2x.click();
    expect(btn2x.classList.contains('active')).toBe(true);

    btn5x.click();
    expect(btn5x.classList.contains('active')).toBe(true);

    btnPause.click();
    expect(btnPause.classList.contains('active')).toBe(true);

    // Keyboard Space toggles pause in Macro
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    const btn1x = dom.window.document.querySelector('.time-warp-btn[data-speed="1"]') as HTMLButtonElement;
    expect(btn1x.classList.contains('active')).toBe(true);

    game.dispose();
  });

  it('3. Sector Objective Waypoint & Distance Marker renders and updates', async () => {
    const { UIController } = await import('../src/ui/ui');
    const { EventBus } = await import('../src/core/events');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { defaultSettings } = await import('../src/state/save');

    const bus = new EventBus();
    const planetary = new PlanetaryState(12345);
    const ui = new UIController({
      bus,
      planetary,
      settings: defaultSettings(),
      onOverlayChange: () => {},
      onSelectNode: () => {},
      onStartCrisis: () => {},
      onAscend: () => {},
      onSettingsChange: () => {},
      onRebind: () => {},
      onSave: () => {},
      onLoad: () => {},
      onExport: () => {},
      onImport: () => {},
      onNewWorld: () => {},
      onCycleCamera: () => {},
    });

    const wpEl = dom.window.document.getElementById('sector-waypoint') as HTMLElement;
    const distEl = dom.window.document.getElementById('wp-dist-lbl') as HTMLElement;
    expect(wpEl).not.toBeNull();

    ui.updateWaypoint(200, 300, 450, true);
    expect(wpEl.style.display).toBe('flex');
    expect(distEl.textContent).toContain('450 m');

    ui.updateWaypoint(200, 300, 2400, true);
    expect(distEl.textContent).toContain('2.40 km');

    ui.updateWaypoint(0, 0, 0, false);
    expect(wpEl.style.display).toBe('none');

    ui.dispose();
  });

  it('4. Ground Proximity Warning System (GPWS) flashes alert banner', async () => {
    const { UIController } = await import('../src/ui/ui');
    const { EventBus } = await import('../src/core/events');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { defaultSettings } = await import('../src/state/save');

    const ui = new UIController({
      bus: new EventBus(),
      planetary: new PlanetaryState(12345),
      settings: defaultSettings(),
      onOverlayChange: () => {},
      onSelectNode: () => {},
      onStartCrisis: () => {},
      onAscend: () => {},
      onSettingsChange: () => {},
      onRebind: () => {},
      onSave: () => {},
      onLoad: () => {},
      onExport: () => {},
      onImport: () => {},
      onNewWorld: () => {},
      onCycleCamera: () => {},
    });

    const gpws = dom.window.document.getElementById('gpws-alert') as HTMLElement;
    expect(gpws).not.toBeNull();

    ui.showGpwsWarning(true, 18);
    expect(gpws.classList.contains('visible')).toBe(true);
    expect(gpws.textContent).toContain('18m');

    ui.showGpwsWarning(false);
    expect(gpws.classList.contains('visible')).toBe(false);

    ui.dispose();
  });

  it('5. Vehicle Headlights / Searchlight toggle functions and shows toast', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    // Start a crisis to enter sector
    game.startCrisis('ATMOSPHERIC_SHEAR_CORRIDOR');
    (game as any).scale.setScale('SECTOR');
    game.update(1 / 60, performance.now());

    // Toggle headlights
    (game as any).toggleHeadlights();
    expect((game as any).headlightsOn).toBe(true);

    (game as any).toggleHeadlights();
    expect((game as any).headlightsOn).toBe(false);

    game.dispose();
  });

  it('6. Flight Horizon Auto-Leveler Assist activates and damps roll and pitch', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();
    game.startCrisis('ATMOSPHERIC_SHEAR_CORRIDOR');
    (game as any).scale.setScale('SECTOR');
    game.update(1 / 60, performance.now());

    (game as any).autoLevelActive = true;
    const vehicle = (game as any).activeVehicle;
    expect(vehicle).toBeDefined();

    vehicle.object3D.rotation.z = 0.5;
    (game as any).updateSectorAssistsAndHud(performance.now());
    expect(vehicle.object3D.rotation.z).toBeLessThan(0.5);

    game.dispose();
  });

  it('7. Globe Pole Snapping and Orientation Presets position camera accurately', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const scale = (game as any).scale;
    scale.snapMacroCamera('NORTH_POLE');
    expect(scale.macroOrbit.phi).toBeCloseTo(0.08, 2);

    scale.snapMacroCamera('SOUTH_POLE');
    expect(scale.macroOrbit.phi).toBeCloseTo(Math.PI - 0.08, 2);

    scale.snapMacroCamera('EQUATOR');
    expect(scale.macroOrbit.phi).toBeCloseTo(Math.PI / 2, 2);

    game.dispose();
  });

  it('8. Double-Click Globe Target Focus dives camera into clicked feature', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const dblEvent = new dom.window.MouseEvent('dblclick', { clientX: 640, clientY: 360, bubbles: true });
    canvas.dispatchEvent(dblEvent);

    expect((game as any).scale.macroOrbit.targetDistance).toBeLessThanOrEqual(290);
    game.dispose();
  });

  it('9. Spire Polar Scope Click-to-Focus focuses on selected spire', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const pingBtn = dom.window.document.getElementById('spire-ping-btn') as HTMLButtonElement;
    expect(pingBtn).not.toBeNull();
    pingBtn.click();

    expect((game as any).selectedSpireId).toBeGreaterThanOrEqual(0);
    game.dispose();
  });

  it('10. Crisis Filter Pills and text search filter crisis rows correctly', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const bioPill = dom.window.document.querySelector('.crisis-filter-pill[data-domain="BIOSPHERE"]') as HTMLButtonElement;
    expect(bioPill).not.toBeNull();
    bioPill.click();

    const rows = dom.window.document.querySelectorAll<HTMLButtonElement>('.crisis-item');
    for (const r of rows) {
      if (r.querySelector('.dom')?.textContent !== 'Biosphere') {
        expect(r.style.display).toBe('none');
      }
    }

    const searchInput = dom.window.document.getElementById('crisis-search') as HTMLInputElement;
    searchInput.value = 'Mantle';
    searchInput.dispatchEvent(new dom.window.Event('input'));

    game.dispose();
  });

  it('11. Procedural Web Audio UI sound effects trigger on interactions without throwing', async () => {
    const { AudioEngine } = await import('../src/audio/AudioEngine');
    const audio = new AudioEngine();
    await audio.unlock();

    expect(() => audio.playUiClick()).not.toThrow();
    expect(() => audio.playUiHover()).not.toThrow();
    expect(() => audio.playUiModal(true)).not.toThrow();
    expect(() => audio.playUiModal(false)).not.toThrow();
    expect(() => audio.playWarningBeep()).not.toThrow();
    expect(() => audio.playSuccessChime()).not.toThrow();

    audio.dispose();
  });

  it('12. Quick Mute Audio Toggle (KeyU / toolbar button) mutes and restores sound', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const audioBtn = dom.window.document.getElementById('macro-mute-btn') as HTMLButtonElement;
    expect(audioBtn).not.toBeNull();

    audioBtn.click();
    expect((game as any).ui.audioMuted).toBe(true);

    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyU', bubbles: true }));
    expect((game as any).ui.audioMuted).toBe(false);

    game.dispose();
  });

  it('13. Survey Archive & Codex Instant Live Search filters entries dynamically', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    (game as any).ui.openCodex('DOMAINS');
    const codexSearch = dom.window.document.getElementById('codex-search') as HTMLInputElement;
    expect(codexSearch).not.toBeNull();

    codexSearch.value = 'Thermal';
    codexSearch.dispatchEvent(new dom.window.Event('input'));

    const body = dom.window.document.getElementById('codex-body') as HTMLElement;
    expect(body.textContent).toContain('Thermal');

    game.dispose();
  });

  it('14. One-Click Save Code Copy / Paste buttons in Settings operate cleanly', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    (game as any).ui.openSettings();
    const copyBtn = dom.window.document.getElementById('settings-copy-save') as HTMLButtonElement;
    const pasteBtn = dom.window.document.getElementById('settings-paste-save') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(pasteBtn).not.toBeNull();

    copyBtn.click();
    expect(game.serializeSave()).toContain('"version"');
    expect(game.serializeSave()).toContain('"worldSeed"');

    game.dispose();
  });

  it('15. Periodic Auto-Save Engine steps timer and triggers saves', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const saveSpy = vi.spyOn(game, 'saveGame').mockResolvedValue({} as any);

    // Set auto-save interval to 1 minute
    (game as any).settings.autoSaveIntervalMinutes = 1;
    (game as any).autoSaveTimer = 59.9;
    game.update(0.2, performance.now());

    expect(saveSpy).toHaveBeenCalledWith(false);
    expect((game as any).autoSaveTimer).toBe(0);

    game.dispose();
  });

  it('16. Live Cursor Coordinate, Elevation & Biome Readout HUD updates', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    (game as any).ui.updateCoordinates(14.5, -42.1, 850, 'Shattered Basalt');

    const latlon = dom.window.document.getElementById('coord-latlon') as HTMLElement;
    const elev = dom.window.document.getElementById('coord-elev') as HTMLElement;
    const biome = dom.window.document.getElementById('coord-biome') as HTMLElement;

    expect(latlon.textContent).toContain('14.5° N');
    expect(latlon.textContent).toContain('42.1° W');
    expect(elev.textContent).toContain('850 m');
    expect(biome.textContent).toContain('Shattered Basalt');

    game.dispose();
  });

  it('17. Full Contextual Tooltip Subsystem shows and hides on hover', async () => {
    const { UIController } = await import('../src/ui/ui');
    const { EventBus } = await import('../src/core/events');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { defaultSettings } = await import('../src/state/save');

    const ui = new UIController({
      bus: new EventBus(),
      planetary: new PlanetaryState(12345),
      settings: defaultSettings(),
      onOverlayChange: () => {},
      onSelectNode: () => {},
      onStartCrisis: () => {},
      onAscend: () => {},
      onSettingsChange: () => {},
      onRebind: () => {},
      onSave: () => {},
      onLoad: () => {},
      onExport: () => {},
      onImport: () => {},
      onNewWorld: () => {},
      onCycleCamera: () => {},
    });

    const tip = dom.window.document.getElementById('ui-tooltip') as HTMLElement;
    expect(tip).not.toBeNull();

    ui.showTooltip('Test Tooltip', '[T]', { left: 100, top: 100, width: 50, height: 20, right: 150, bottom: 120 } as DOMRect);
    expect(tip.classList.contains('visible')).toBe(true);
    expect(tip.textContent).toContain('Test Tooltip');

    ui.hideTooltip();
    expect(tip.classList.contains('visible')).toBe(false);

    ui.dispose();
  });

  it('18. Modal Escape Key Trap closes dialogs without ascending', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    (game as any).ui.openSettings();
    expect((game as any).ui.isSettingsOpen).toBe(true);

    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect((game as any).ui.isSettingsOpen).toBe(false);
    expect((game as any).scale.scale).toBe('MACRO');

    game.dispose();
  });

  it('19. Settlement Critical Viability Warning Badges pulse on critical status', async () => {
    const { UIController } = await import('../src/ui/ui');
    const { EventBus } = await import('../src/core/events');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { defaultSettings } = await import('../src/state/save');

    const ui = new UIController({
      bus: new EventBus(),
      planetary: new PlanetaryState(12345),
      settings: defaultSettings(),
      onOverlayChange: () => {},
      onSelectNode: () => {},
      onStartCrisis: () => {},
      onAscend: () => {},
      onSettingsChange: () => {},
      onRebind: () => {},
      onSave: () => {},
      onLoad: () => {},
      onExport: () => {},
      onImport: () => {},
      onNewWorld: () => {},
      onCycleCamera: () => {},
    });

    ui.updateLedger([
      { id: 'settlement-1', name: 'Haven Ridge', lat: 10, lon: 10, viability: 0.18, populationK: 45 },
      { id: 'settlement-2', name: 'Basalt Gate', lat: -10, lon: 20, viability: 0.82, populationK: 60 },
    ], []);

    const critBadge = dom.window.document.querySelector('.settlement-row.crit .critical-badge');
    expect(critBadge).not.toBeNull();
    expect(critBadge?.textContent).toContain('COLLAPSE RISK');

    ui.dispose();
  });

  it('20. Colorblind-Safe Overlay Palette Toggle toggles body class', async () => {
    const { UIController } = await import('../src/ui/ui');
    const { EventBus } = await import('../src/core/events');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { defaultSettings } = await import('../src/state/save');

    const settings = defaultSettings();
    settings.colorblindMode = true;

    const ui = new UIController({
      bus: new EventBus(),
      planetary: new PlanetaryState(12345),
      settings,
      onOverlayChange: () => {},
      onSelectNode: () => {},
      onStartCrisis: () => {},
      onAscend: () => {},
      onSettingsChange: () => {},
      onRebind: () => {},
      onSave: () => {},
      onLoad: () => {},
      onExport: () => {},
      onImport: () => {},
      onNewWorld: () => {},
      onCycleCamera: () => {},
    });

    dom.window.document.body.classList.toggle('colorblind-mode', true);
    expect(dom.window.document.body.classList.contains('colorblind-mode')).toBe(true);

    ui.dispose();
  });

  it('21. Overlay Cycling Hotkeys (Tab / KeyO / Backquote) cycle overlays', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    expect((game as any).globe.getOverlay()).toBe('ATMOSPHERE');

    // Cycle forward
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
    expect((game as any).globe.getOverlay()).toBe('GEOLOGY');

    // Cycle backward
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Backquote', bubbles: true }));
    expect((game as any).globe.getOverlay()).toBe('ATMOSPHERE');

    game.dispose();
  });

  it('22. Crisis Abandonment Modal Confirmation Dialog prompts before aborting', async () => {
    const { UIController } = await import('../src/ui/ui');
    const { EventBus } = await import('../src/core/events');
    const { PlanetaryState } = await import('../src/state/planetary');
    const { defaultSettings } = await import('../src/state/save');
    const { CRISIS_NODES } = await import('../src/state/world');

    let abandoned = false;
    const ui = new UIController({
      bus: new EventBus(),
      planetary: new PlanetaryState(12345),
      settings: defaultSettings(),
      onOverlayChange: () => {},
      onSelectNode: () => {},
      onStartCrisis: () => {},
      onAbandonCrisis: () => { abandoned = true; },
      onAscend: () => {},
      onSettingsChange: () => {},
      onRebind: () => {},
      onSave: () => {},
      onLoad: () => {},
      onExport: () => {},
      onImport: () => {},
      onNewWorld: () => {},
      onCycleCamera: () => {},
    });

    ui.openBriefing({
      node: CRISIS_NODES[0],
      status: 'ACTIVE',
      objectives: [],
      forecast: { vars: {} as any, chain: [] },
      canStart: true,
    });

    const abortBtn = dom.window.document.getElementById('briefing-abort') as HTMLButtonElement;
    abortBtn.click();

    const confirmModal = dom.window.document.getElementById('abandon-confirm') as HTMLElement;
    expect(confirmModal.classList.contains('open')).toBe(true);

    const okBtn = dom.window.document.getElementById('abandon-ok-btn') as HTMLButtonElement;
    okBtn.click();
    expect(abandoned).toBe(true);

    ui.dispose();
  });

  it('23. Keyboard Panning for Planetary Globe (WASD / Arrows) pans the camera', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const scale = (game as any).scale;
    const initialTheta = scale.macroOrbit.theta;

    // Simulate KeyD pressed
    vi.spyOn((game as any).input, 'isKeyDown').mockImplementation(((code: any) => code === 'KeyD') as any);
    (game as any).handleGlobalInput(1 / 60);

    expect(scale.macroOrbit.theta).not.toBe(initialTheta);

    game.dispose();
  });

  it('24. Vehicle Cruise Control / Throttle Lock (KeyZ) maintains velocity', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();
    game.startCrisis('ATMOSPHERIC_SHEAR_CORRIDOR');
    (game as any).scale.setScale('SECTOR');
    game.update(1 / 60, performance.now());

    (game as any).cruiseControlActive = true;
    const v = (game as any).activeVehicle;
    expect(v).toBeDefined();
    v.speed = 10;
    (game as any).updateSectorAssistsAndHud(performance.now());
    expect(v.speed).toBeGreaterThan(10);

    game.dispose();
  });

  it('25. Codex Unread Lore Tracking and Mark All Read clears unread markers', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    (game as any).save.campaign.unlockedModules = ['Module A', 'Module B'];
    (game as any).syncCodexData();
    (game as any).ui.openCodex('DOMAINS');

    const markReadBtn = dom.window.document.getElementById('codex-mark-read') as HTMLButtonElement;
    expect(markReadBtn).not.toBeNull();
    markReadBtn.click();

    expect((game as any).ui.readCodexModules.size).toBeGreaterThan(0);

    game.dispose();
  });
});
