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
  info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] as unknown[] };
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
function installEnv(): void {
  dom = new JSDOM(`<!doctype html><html><body><div id="app"><canvas id="scene"></canvas></div></body></html>`, { pretendToBeVisual: true, url: 'http://localhost/' });
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
  g.performance = globalThis.performance;
  g.requestAnimationFrame = ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16) as unknown as number);
  g.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as (h: number) => void;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  (g.window as { matchMedia: (q: string) => unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  (dom.window.HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;
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

/** Play until the Harmonic is established, so the campaign is well advanced. */
function advanceCampaign(game: InstanceType<typeof Game>): void {
  game.beginCampaign();
  for (let i = 0; i < 12 && !game.debugState().harmonicUnlocked; i++) {
    const open = game.debugState().crises.find((n) => n.status === 'AVAILABLE' || n.status === 'ACTIVE');
    if (!open) break;
    game.startCrisis(open.id);
    for (let f = 0; f < 200; f++) game.update(1 / 60);
    game.completeActiveObjectives();
    for (let f = 0; f < 100; f++) game.update(1 / 60);
    game.ascend();
    for (let f = 0; f < 150; f++) game.update(1 / 60);
  }
}

describe('New World', () => {
  it('actually produces a new world rather than a chimera of the old one', () => {
    const game = makeGame();
    advanceCampaign(game);
    const before = game.debugState();
    expect(before.harmonicUnlocked).toBe(true);
    expect(before.resolvedCount).toBeGreaterThanOrEqual(6);
    const oldSeed = game.serializeSave();

    game.newWorld();
    for (let f = 0; f < 120; f++) game.update(1 / 60);
    const after = game.debugState();

    // A different world must not inherit the previous campaign's repairs,
    // progress, unlocks or network state.
    expect(after.resolvedCount).toBe(0);
    expect(after.functionalSpires).toBeLessThan(before.functionalSpires);
    expect(after.harmonicUnlocked).toBe(false);
    // Pristine world: exactly the two spires that worked before anyone arrived.
    expect(after.functionalSpires).toBe(2);
    expect(after.spireCoverage).toBeCloseTo(2 / 12, 6);
    expect(after.coherence).toBeLessThan(before.coherence / 2);

    const saved = JSON.parse(game.serializeSave());
    expect(saved.worldSeed).not.toBe(JSON.parse(oldSeed).worldSeed);
    // Domain points are seeded at zero for every domain, and nothing is unlocked.
    expect(Object.values(saved.campaign.domainPoints).every((v) => v === 0)).toBe(true);
    expect(saved.campaign.unlockedModules).toEqual([]);
    expect(saved.campaign.harmonicUnlocked).toBe(false);
    expect(saved.spires.filter((x: { functional: boolean }) => x.functional).length).toBe(2);
    game.dispose();
  });
});
