/**
 * INTEGRATION SMOKE TEST
 * ======================
 *
 * Drives the real `Game` orchestrator end to end inside a jsdom document: boot,
 * campaign start, node selection, descent, sector construction, a possessed
 * machine, simulated frames, ascent, save, reload, export/import and teardown.
 *
 * `THREE.WebGLRenderer` is replaced with a recording stub — jsdom has no GL
 * context, and the point of this test is the *integration*, not the rasteriser.
 * Everything else (the ECS, the planetary simulation, the sector field, the
 * vehicles, the crisis controller, the save layer and the UI controller, DOM and
 * all) is the real code.
 */

import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Records every render call so the test can prove frames actually happened. */
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
  getSize(): { width: number; height: number } { return { width: 1280, height: 720 }; }
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

/** Which OS preferences the stub matchMedia should report. */
let osPrefs = { reducedMotion: false, highContrast: false };

function installEnv(): void {
  dom = new JSDOM(
    `<!doctype html><html><body><div id="app"><canvas id="scene"></canvas></div></body></html>`,
    { pretendToBeVisual: true, url: 'http://localhost/' },
  );
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.CustomEvent = dom.window.CustomEvent;
  g.MouseEvent = dom.window.MouseEvent;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  // jsdom's own performance.now() recurses when installed as a global; use Node's.
  g.performance = globalThis.performance;
  g.requestAnimationFrame = ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16) as unknown as number);
  g.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as (h: number) => void;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  // jsdom has no matchMedia; the game reads the OS accessibility preferences
  // through it, so the stub has to answer for both of them.
  (g.window as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
    matches:
      q.includes('prefers-reduced-motion') ? osPrefs.reducedMotion : q.includes('prefers-contrast') ? osPrefs.highContrast : false,
    addEventListener(): void {},
    removeEventListener(): void {},
  });
  // jsdom has no canvas 2D/WebGL backend; the game's UI never draws to one.
  (dom.window.HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;
}

let Game: typeof import('../src/game/Game').Game;

beforeEach(async () => {
  osPrefs = { reducedMotion: false, highContrast: false };
  installEnv();
  renderLog.length = 0;
  if (!Game) Game = (await import('../src/game/Game')).Game;
});

function makeGame(): InstanceType<typeof Game> {
  const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
  return new Game(canvas);
}

/** Advance the game's loop by `seconds` of wall time. */
function tick(game: InstanceType<typeof Game>, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) game.update(dt);
}

describe('Game integration', () => {
  it('constructs inside a real DOM and reports a boot state', () => {
    const game = makeGame();
    const s = game.debugState();
    expect(s.scale).toBe('BOOT');
    expect(s.crisisCount).toBeGreaterThan(0);
    expect(s.spireCount).toBe(12);
    expect(s.vehicles).toBe(0);
    expect(Number.isFinite(s.globalHealth)).toBe(true);
    expect(dom.window.document.getElementById('app')).toBeTruthy();
    game.dispose();
  });

  it('renders the macro globe every frame', () => {
    const game = makeGame();
    tick(game, 1);
    expect(renderLog.length).toBeGreaterThan(30);
    expect(renderLog.some((r) => r.scene === 'MACRO')).toBe(true);
    game.dispose();
  });

  it('starts the campaign, selects a node and descends into a sector', () => {
    const game = makeGame();
    game.beginCampaign();
    tick(game, 0.5);
    expect(game.debugState().scale).toBe('MACRO');

    const open = game.debugState().crises.find((n) => n.status !== 'RESOLVED')!;
    expect(open).toBeTruthy();
    game.selectNode(open.id);
    tick(game, 0.2);

    game.startCrisis(open.id);
    tick(game, 4);
    const st = game.debugState();
    expect(['SECTOR', 'ORBIT']).toContain(st.scale);
    expect(st.activeVehicle).toBeTruthy();
    expect(st.vehicles).toBe(1);
    expect(renderLog.some((r) => r.scene === 'SECTOR' || r.scene === 'ORBIT')).toBe(true);
    game.dispose();
  });

  it('possesses a distinct machine for each vehicle domain', () => {
    const game = makeGame();
    game.beginCampaign();
    const kinds = new Set<string>();
    for (const c of game.debugState().crises) {
      if (c.status === 'RESOLVED') continue;
      game.startCrisis(c.id);
      tick(game, 4);
      const v = game.debugState().activeVehicle;
      if (v) kinds.add(v as string);
      game.ascend();
      tick(game, 4);
      if (kinds.size >= 4) break;
    }
    expect(kinds.size).toBe(4);
    game.dispose();
  });

  it('propagates local work into the planetary state', () => {
    const game = makeGame();
    game.beginCampaign();
    const open = game.debugState().crises.find((n) => n.status !== 'RESOLVED')!;
    const before = game.debugState().globalHealth;
    game.startCrisis(open.id);
    tick(game, 4);
    tick(game, 6);
    const during = game.debugState();
    expect(Number.isFinite(during.globalHealth)).toBe(true);
    expect(during.globalHealth).toBeGreaterThanOrEqual(0);
    expect(during.globalHealth).toBeLessThanOrEqual(1);

    game.completeActiveObjectives();
    tick(game, 1);
    const after = game.debugState();
    expect(after.globalHealth).toBeGreaterThan(before);
    expect(after.resolvedCount).toBeGreaterThan(0);
    game.dispose();
  });

  it('ascends back to the macro globe and tears the sector down', () => {
    const game = makeGame();
    game.beginCampaign();
    const open = game.debugState().crises.find((n) => n.status !== 'RESOLVED')!;
    game.startCrisis(open.id);
    tick(game, 4);
    expect(game.debugState().vehicles).toBe(1);
    game.ascend();
    tick(game, 4);
    const st = game.debugState();
    expect(st.scale).toBe('MACRO');
    // The machine is pooled and reused, but the sector it lived in is gone.
    expect(st.activeVehicle).toBeNull();
    expect(st.sector).toBeNull();
    expect(st.carved).toBe(0);
    expect(st.vehicles).toBeLessThanOrEqual(1);
    game.dispose();
  });

  it('round-trips a save through the store and restores it into a fresh game', async () => {
    const game = makeGame();
    game.beginCampaign();
    const open = game.debugState().crises.find((n) => n.status !== 'RESOLVED')!;
    game.startCrisis(open.id);
    tick(game, 4);
    tick(game, 5);

    // Save mid-descent, before anything is resolved.
    const saved = await game.saveGame(false);
    expect(saved).toBeTruthy();
    expect(saved.campaign.domainPoints).toBeTruthy();

    const json = game.serializeSave();
    expect(typeof json).toBe('string');
    expect(JSON.parse(json).worldSeed).toBe(saved.worldSeed);

    const game2 = makeGame();
    game2.importSave(json);
    // Compared before either game is advanced again: `a` is the state at the
    // instant of the save, and `b` is what the restore produced.
    const a = game.debugState();
    const b = game2.debugState();
    // Reloading resumes the descent rather than dumping the player at the globe.
    expect(b.scale).toBe(a.scale);
    expect(b.activeVehicle).toBe(a.activeVehicle);
    expect(b.carved).toBe(a.carved);
    expect(b.globalHealth).toBeCloseTo(a.globalHealth, 6);
    expect(b.resolvedCount).toBe(a.resolvedCount);
    // The restored sector is live, not a frozen snapshot.
    tick(game2, 0.5);
    expect(Number.isFinite(game2.debugState().globalHealth)).toBe(true);

    // ...and a save taken after resolution restores to a finished crisis.
    game.completeActiveObjectives();
    tick(game, 2);
    const after = await game.saveGame(false);
    const game3 = makeGame();
    game3.importSave(game.serializeSave());
    tick(game3, 0.5);
    expect(game3.debugState().resolvedCount).toBe(1);
    expect(game3.debugState().scale).toBe('MACRO');
    expect(after.campaign.domainPoints).toBeTruthy();
    game.dispose();
    game2.dispose();
    game3.dispose();
  });

  it('survives a long unattended run without NaNs or unbounded growth', () => {
    const game = makeGame();
    game.beginCampaign();
    tick(game, 30);
    const before = game.debugState().entityCount;
    const open = game.debugState().crises.find((n) => n.status !== 'RESOLVED')!;
    game.startCrisis(open.id);
    tick(game, 60);
    game.ascend();
    tick(game, 30);
    const st = game.debugState();
    expect(Number.isFinite(st.globalHealth)).toBe(true);
    expect(Number.isFinite(st.entityCount)).toBe(true);
    // Vehicles are pooled and reused across descents.
    expect(st.entityCount).toBeLessThan(before + 64);
    expect(st.vehicles).toBeLessThanOrEqual(4);
    game.dispose();
  });

  it('applies settings and quality changes without restarting', () => {
    const game = makeGame();
    game.applySettings({ masterVolume: 0.4, reducedMotion: true, qualityTier: 'LOW' });
    tick(game, 2);
    const st = game.debugState();
    expect(st.settings.masterVolume).toBeCloseTo(0.4, 6);
    expect(st.settings.reducedMotion).toBe(true);
    expect(st.qualityTier).toBe('LOW');
    game.dispose();
  });

  it('cycles every globe overlay', () => {
    const game = makeGame();
    game.beginCampaign();
    tick(game, 0.5);
    const overlays = ['ATMOSPHERE', 'GEOLOGY', 'BIOSPHERE', 'ORBIT', 'LOGISTICS', 'HARMONIC'] as const;
    for (const o of overlays) {
      game.setOverlay(o);
      tick(game, 0.1);
    }
    expect(renderLog.some((r) => r.scene === 'MACRO')).toBe(true);
    game.dispose();
  });

  it('re-enters a second crisis after resolving the first', () => {
    const game = makeGame();
    game.beginCampaign();
    const open = game.debugState().crises.find((n) => n.status !== 'RESOLVED')!;
    game.startCrisis(open.id);
    tick(game, 4);
    const firstKind = game.debugState().activeVehicle;
    game.completeActiveObjectives();
    tick(game, 2);
    expect(game.debugState().resolvedCount).toBe(1);
    game.ascend();
    tick(game, 4);
    const next = game.debugState().crises.find((n) => n.status !== 'RESOLVED');
    expect(next).toBeTruthy();
    game.startCrisis(next!.id);
    tick(game, 4);
    const st = game.debugState();
    // A different machine, built from the pool rather than from scratch.
    expect(st.activeVehicle).toBeTruthy();
    expect(st.activeVehicle).not.toBe(firstKind);
    expect(st.vehicles).toBe(2);
    game.dispose();
  });

  it('establishes the Terminus Harmonic once the network is broad and locked', () => {
    const game = makeGame();
    game.beginCampaign();
    const before = game.debugState();
    expect(before.harmonicUnlocked).toBe(false);
    expect(before.functionalSpires).toBeLessThan(8);

    // Resolving crises is the only thing that brings spires online, so the
    // Harmonic cannot be reached without doing the work.
    let guard = 0;
    while (!game.debugState().harmonicUnlocked && guard++ < 10) {
      const open = game.debugState().crises.find(
        (n) => n.status === 'AVAILABLE' || n.status === 'ACTIVE',
      );
      if (!open) break;
      game.startCrisis(open.id);
      tick(game, 4);
      game.completeActiveObjectives();
      tick(game, 1);
      game.ascend();
      tick(game, 3);
    }

    const st = game.debugState();
    expect(st.harmonicUnlocked).toBe(true);
    expect(st.functionalSpires).toBeGreaterThanOrEqual(8);
    expect(st.spireCoverage).toBeGreaterThanOrEqual(8 / 12);
    expect(st.phaseOrder).toBeGreaterThan(0.9);
    // The reward is a permanent baseline shift, so it must outlive the session.
    expect(st.globalHealth).toBeGreaterThan(before.globalHealth);

    // Pacing invariant: the Harmonic is the payoff, not the ending. Six of the
    // seven crises bring the network to its floor, which leaves a final act
    // after the network establishes itself.
    expect(st.resolvedCount).toBeGreaterThanOrEqual(6);
    expect(st.crisisCount - st.resolvedCount).toBeGreaterThanOrEqual(1);
    game.dispose();
  });

  it('adopts the OS motion and contrast preferences instead of ignoring them', () => {
    // The user has asked their system to reduce motion. The game must start
    // that way without them hunting for the toggle.
    osPrefs = { reducedMotion: true, highContrast: true };
    const game = makeGame();
    const st = game.debugState();
    expect(st.settings.reducedMotion).toBe(true);
    expect(st.settings.screenShake).toBe(false);
    expect(st.settings.highContrast).toBe(true);
    expect(dom.window.document.body.classList.contains('reduced-motion')).toBe(true);
    expect(dom.window.document.body.classList.contains('high-contrast')).toBe(true);
    game.dispose();
  });

  it('leaves motion on when the OS has no preference', () => {
    const game = makeGame();
    const st = game.debugState();
    expect(st.settings.reducedMotion).toBe(false);
    expect(st.settings.screenShake).toBe(true);
    expect(dom.window.document.body.classList.contains('reduced-motion')).toBe(false);
    game.dispose();
  });

  it('lets an explicit setting override the OS preference', () => {
    osPrefs = { reducedMotion: true, highContrast: false };
    const game = makeGame();
    expect(game.debugState().settings.reducedMotion).toBe(true);
    game.applySettings({ reducedMotion: false, screenShake: true });
    const st = game.debugState();
    expect(st.settings.reducedMotion).toBe(false);
    expect(st.settings.screenShake).toBe(true);
    expect(dom.window.document.body.classList.contains('reduced-motion')).toBe(false);
    game.dispose();
  });

  it('disposes cleanly and stops rendering', () => {
    const game = makeGame();
    game.beginCampaign();
    tick(game, 2);
    const count = renderLog.length;
    game.dispose();
    renderLog.length = 0;
    expect(() => tick(game, 0.2)).not.toThrow();
    expect(renderLog.length).toBe(0);
    expect(count).toBeGreaterThan(0);
  });
});
