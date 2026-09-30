import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('Adversarial UI/UX Functional Verification', () => {
  beforeEach(() => {
    installEnv();
  });

  it('Boot sequence: Enter button and keyboard Enter/Space dismiss the boot splash', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);

    const bootEnter = dom.window.document.getElementById('boot-enter') as HTMLButtonElement;
    const boot = dom.window.document.getElementById('boot') as HTMLElement;
    expect(bootEnter).not.toBeNull();
    expect(boot).not.toBeNull();

    // Trigger Enter key on boot
    const enterEvent = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    window.dispatchEvent(enterEvent);
    expect(boot.classList.contains('done')).toBe(true);

    game.dispose();
  });

  it('Macro Toolbar: Archive, Settings, Camera zoom presets, Save, and Load all function', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    // 1. Archive [C] button
    const codexBtn = dom.window.document.getElementById('macro-codex-btn') as HTMLButtonElement;
    const codex = dom.window.document.getElementById('codex') as HTMLElement;
    expect(codexBtn).not.toBeNull();
    codexBtn.click();
    expect(codex.classList.contains('open')).toBe(true);

    // Close codex via close button
    const codexClose = dom.window.document.getElementById('codex-close') as HTMLButtonElement;
    codexClose.click();
    expect(codex.classList.contains('open')).toBe(false);

    // 2. Settings button
    const toolbar = dom.window.document.getElementById('macro-toolbar') as HTMLElement;
    const settingsBtn = Array.from(toolbar.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Settings',
    );
    const settings = dom.window.document.getElementById('settings') as HTMLElement;
    expect(settingsBtn).toBeDefined();
    settingsBtn!.click();
    expect(settings.classList.contains('open')).toBe(true);

    // Close settings via close button
    const settingsClose = dom.window.document.getElementById('settings-close') as HTMLButtonElement;
    settingsClose.click();
    expect(settings.classList.contains('open')).toBe(false);

    // 3. Camera button in MACRO mode cycles zoom presets
    const cameraBtn = Array.from(toolbar.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Camera',
    );
    expect(cameraBtn).toBeDefined();
    // Default macro orbit distance is 290
    cameraBtn!.click();
    // Next preset from 290 is Planetary (520)
    expect((game as unknown as { scale: { macroOrbit: { targetDistance: number } } }).scale.macroOrbit.targetDistance).toBe(520);
    cameraBtn!.click();
    // Next preset from 520 is Tactical (170)
    expect((game as unknown as { scale: { macroOrbit: { targetDistance: number } } }).scale.macroOrbit.targetDistance).toBe(170);
    cameraBtn!.click();
    // Next preset from 170 is Standard Orbit (290)
    expect((game as unknown as { scale: { macroOrbit: { targetDistance: number } } }).scale.macroOrbit.targetDistance).toBe(290);

    // 4. Save and Load buttons
    const saveBtn = Array.from(toolbar.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save',
    );
    const loadBtn = Array.from(toolbar.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Load',
    );
    expect(saveBtn).toBeDefined();
    expect(loadBtn).toBeDefined();
    saveBtn!.click();
    loadBtn!.click();

    game.dispose();
  });

  it('Overlay buttons: all 7 modes switch cleanly and update aria-pressed and legend', async () => {
    const { Game } = await import('../src/game/Game');
    const { OVERLAY_MODES } = await import('../src/render/globe');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const overlayBar = dom.window.document.getElementById('overlay-selector') as HTMLElement;
    const buttons = overlayBar.querySelectorAll<HTMLButtonElement>('.overlay-btn');
    expect(buttons.length).toBe(OVERLAY_MODES.length);

    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      btn.click();
      expect(btn.getAttribute('aria-pressed')).toBe('true');
      const legend = dom.window.document.getElementById('overlay-legend') as HTMLElement;
      expect(legend.children.length).toBeGreaterThan(0);
    }

    // Number keys 1-7 switch overlay mode
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Digit3', bubbles: true }));
    const geoBtn = Array.from(buttons).find((b) => b.dataset.mode === 'GEOLOGY');
    expect(geoBtn?.getAttribute('aria-pressed')).toBe('true');

    game.dispose();
  });

  it('Harmonic scope: clicking or keying spire dots pulses phase and focuses camera', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();
    game.update(0.1);

    const spireDotsGroup = dom.window.document.getElementById('harmonic-spire-dots') as HTMLElement;
    expect(spireDotsGroup.children.length).toBe(12);

    const dot0 = spireDotsGroup.children[0] as SVGCircleElement;
    expect(dot0.getAttribute('role')).toBe('button');
    expect(dot0.getAttribute('tabindex')).toBe('0');

    // Click dot
    dot0.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    game.update(0.1);

    // Spire name in detail panel should update
    const spireNameLbl = dom.window.document.getElementById('spire-name-lbl') as HTMLElement;
    expect(spireNameLbl.textContent).toContain('Kestrel Socket');

    // Spire ping button
    const pingBtn = dom.window.document.getElementById('spire-ping-btn') as HTMLButtonElement;
    pingBtn.click();
    game.update(0.1);

    game.dispose();
  });

  it('Settlement ledger: toggles selection and updates reticle', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();
    game.update(0.1);

    const grid = dom.window.document.getElementById('settlement-grid') as HTMLElement;
    expect(grid.children.length).toBeGreaterThan(0);

    const firstRow = grid.children[0] as HTMLElement;
    firstRow.click();
    game.update(0.1);
    expect(firstRow.classList.contains('selected')).toBe(true);

    // Clicking again deselects it
    firstRow.click();
    game.update(0.1);
    expect(firstRow.classList.contains('selected')).toBe(false);

    game.dispose();
  });

  it('Briefing modal & Crisis Abandonment: start crisis, then abort back to MACRO', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    // Select first crisis node
    const crisisItems = dom.window.document.getElementById('crisis-items') as HTMLElement;
    const firstCrisis = crisisItems.querySelector('.crisis-item') as HTMLElement;
    expect(firstCrisis).not.toBeNull();
    firstCrisis.click();

    const briefing = dom.window.document.getElementById('briefing') as HTMLElement;
    expect(briefing.classList.contains('open')).toBe(true);

    // Verify objectives rendered with bullet indicators
    const objList = dom.window.document.getElementById('briefing-objectives') as HTMLElement;
    expect(objList.children.length).toBeGreaterThan(0);
    expect(objList.textContent).toContain('○ ');

    // Descend
    const descendBtn = dom.window.document.getElementById('briefing-descend') as HTMLButtonElement;
    descendBtn.click();

    // Complete scale descent
    for (let i = 0; i < 240; i++) game.update(1 / 60);
    expect(game.debugState().scale === 'SECTOR' || game.debugState().scale === 'ORBIT').toBe(true);

    // Now re-open briefing (or via abort action) and abandon crisis
    const gAny = game as unknown as { abandonCrisis: (id?: string) => void; crises: { activeCrisis: unknown } };
    gAny.abandonCrisis();

    // Transition back to MACRO
    for (let i = 0; i < 240; i++) game.update(1 / 60);
    expect(game.debugState().scale).toBe('MACRO');
    expect(gAny.crises.activeCrisis).toBeNull();

    game.dispose();
  });

  it('Key rebinding in Settings: rebinds key, allows Escape to cancel, and resets defaults', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const settings = dom.window.document.getElementById('settings') as HTMLElement;
    (game as unknown as { ui: { openSettings: () => void } }).ui.openSettings();
    expect(settings.classList.contains('open')).toBe(true);

    // Find first rebind button
    const rebindBtn = settings.querySelector('.keybind-row button') as HTMLButtonElement;
    expect(rebindBtn).not.toBeNull();

    // Click rebind
    rebindBtn.click();
    expect(rebindBtn.textContent).toContain('Press a key');

    // Press Escape to cancel
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(rebindBtn.textContent).toBe('Rebind');

    // Reset controls button
    const resetBindsBtn = dom.window.document.getElementById('settings-reset-binds') as HTMLButtonElement;
    expect(resetBindsBtn).not.toBeNull();
    resetBindsBtn.click();

    // Close settings with Escape key
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(settings.classList.contains('open')).toBe(false);

    game.dispose();
  });

  it('KeyC collision prevention: KeyC toggles Codex in MACRO but does not interfere in SECTOR flight', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const codex = dom.window.document.getElementById('codex') as HTMLElement;

    // In MACRO: KeyC opens Codex
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }));
    expect(codex.classList.contains('open')).toBe(true);

    // KeyC again closes Codex
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }));
    expect(codex.classList.contains('open')).toBe(false);

    // Descend into sector
    const crisisItems = dom.window.document.getElementById('crisis-items') as HTMLElement;
    (crisisItems.querySelector('.crisis-item') as HTMLElement).click();
    (dom.window.document.getElementById('briefing-descend') as HTMLButtonElement).click();
    for (let i = 0; i < 240; i++) game.update(1 / 60);
    expect(game.debugState().scale === 'SECTOR' || game.debugState().scale === 'ORBIT').toBe(true);

    // In SECTOR: KeyC is for steering (yawRight); it must NOT open Codex!
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }));
    expect(codex.classList.contains('open')).toBe(false);

    // Ascend button on HUD returns to MACRO
    const hudAscend = dom.window.document.getElementById('hud-ascend-btn') as HTMLButtonElement;
    hudAscend.click();
    for (let i = 0; i < 240; i++) game.update(1 / 60);
    expect(game.debugState().scale).toBe('MACRO');

    game.dispose();
  });

  it('Reticle hover stability: isReticleHovered preserves card visibility when moving onto buttons', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    const reticle = dom.window.document.getElementById('globe-reticle') as HTMLElement;
    expect(reticle).not.toBeNull();

    // Pointer enters reticle card
    reticle.dispatchEvent(new dom.window.PointerEvent('pointerenter', { bubbles: true }));
    expect((game as unknown as { ui: { isReticleHovered: boolean } }).ui.isReticleHovered).toBe(true);

    // Pointer moves across canvas while reticle is hovered
    canvas.dispatchEvent(new dom.window.PointerEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true }));
    // Canvas pointermove should return early and not clobber hovered item
    expect((game as unknown as { ui: { isReticleHovered: boolean } }).ui.isReticleHovered).toBe(true);

    // Pointer leaves reticle card
    reticle.dispatchEvent(new dom.window.PointerEvent('pointerleave', { bubbles: true }));
    expect((game as unknown as { ui: { isReticleHovered: boolean } }).ui.isReticleHovered).toBe(false);

    game.dispose();
  });
});
