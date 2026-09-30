import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type * as THREE from 'three';

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

describe('StarField with Motion Parallax', () => {
  beforeEach(() => {
    installEnv();
  });

  it('generates multi-tiered parallax stars on a celestial sphere with spectral classifications', async () => {
    const { StarField } = await import('../src/render/starfield');
    const starField = new StarField({ count: 1000, radius: 8000, parallaxScale: 1.4 });
    const geo = starField.points.geometry;

    const positions = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors = geo.getAttribute('aColor') as THREE.BufferAttribute;
    const sizes = geo.getAttribute('aSize') as THREE.BufferAttribute;
    const brightnesses = geo.getAttribute('aBrightness') as THREE.BufferAttribute;
    const parallaxes = geo.getAttribute('aParallax') as THREE.BufferAttribute;
    const twinkles = geo.getAttribute('aTwinkle') as THREE.BufferAttribute;

    expect(positions).toBeDefined();
    expect(colors).toBeDefined();
    expect(sizes).toBeDefined();
    expect(brightnesses).toBeDefined();
    expect(parallaxes).toBeDefined();
    expect(twinkles).toBeDefined();

    const count = positions.count;
    expect(count).toBeGreaterThan(500);

    let deepCount = 0;
    let midCount = 0;
    let foreCount = 0;

    for (let i = 0; i < count; i++) {
      const p = parallaxes.getX(i);
      if (p === 0) deepCount++;
      else if (p < 0.6) midCount++;
      else foreCount++;

      // Verify normalized positions on unit sphere
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);
      const len = Math.hypot(x, y, z);
      expect(len).toBeCloseTo(1.0, 3);

      // Verify positive sizes and brightnesses
      expect(sizes.getX(i)).toBeGreaterThan(0);
      expect(brightnesses.getX(i)).toBeGreaterThan(0);
    }

    // Must have all three tiers: deep background, midground, and foreground parallax stars
    expect(deepCount).toBeGreaterThan(0);
    expect(midCount).toBeGreaterThan(0);
    expect(foreCount).toBeGreaterThan(0);

    starField.dispose();
  });

  it('respects the canonical Siege Wall starless absence swath', async () => {
    const { StarField } = await import('../src/render/starfield');
    const starField = new StarField({ count: 2000, radius: 8000 });
    const positions = starField.points.geometry.getAttribute('position') as THREE.BufferAttribute;

    // Check that no stars fall inside the core absence corridor
    for (let i = 0; i < positions.count; i++) {
      const uX = positions.getX(i);
      const uY = positions.getY(i);
      const uZ = positions.getZ(i);

      const swathCoord = uX * 0.78 - uZ * 0.62;
      const swathWarp = Math.sin(uZ * 5.3 + uY * 3.7) * 0.09 + Math.cos(uX * 9.1 - uY * 4.2) * 0.05;
      const distFromWall = Math.abs(swathCoord + swathWarp - 0.22);

      // Core absence threshold is 0.14
      expect(distFromWall).toBeGreaterThanOrEqual(0.14);
    }

    starField.dispose();
  });

  it('updates camera position, time, and star intensity for motion parallax', async () => {
    const { StarField } = await import('../src/render/starfield');
    const THREE = await import('three');
    const starField = new StarField({ count: 500, radius: 8000, parallaxScale: 1.5 });
    const cam = new THREE.PerspectiveCamera(46, 1, 0.5, 20000);
    cam.position.set(180, 140, 220);

    starField.update(12.5, cam, 0.85);

    const mat = starField.points.material as THREE.ShaderMaterial;
    const uCam = mat.uniforms.uCameraPos.value as THREE.Vector3;
    expect(uCam.x).toBe(180);
    expect(uCam.y).toBe(140);
    expect(uCam.z).toBe(220);
    expect(mat.uniforms.uTime.value).toBe(12.5);
    expect(mat.uniforms.uStarIntensity.value).toBe(0.85);

    starField.setParallaxScale(2.0);
    expect(mat.uniforms.uParallaxScale.value).toBe(2.0);

    starField.dispose();
  });

  it('integrates seamlessly with the Game orchestrator across MACRO, ORBIT, and SECTOR scenes', async () => {
    const { Game } = await import('../src/game/Game');
    const canvas = dom.window.document.getElementById('scene') as HTMLCanvasElement;
    const game = new Game(canvas);
    game.beginCampaign();

    // Verify StarField is in MACRO scene
    const macroScene = (game as unknown as { scale: { scenes: { MACRO: THREE.Scene; ORBIT: THREE.Scene; SECTOR: THREE.Scene } } }).scale.scenes.MACRO;
    const starPoints = macroScene.children.find((c) => c.name === 'celestial-starfield');
    expect(starPoints).toBeDefined();

    // Advance frame
    game.update(0.1);

    // Descend into sector
    const crisisItems = dom.window.document.getElementById('crisis-items') as HTMLElement;
    (crisisItems.querySelector('.crisis-item') as HTMLElement).click();
    (dom.window.document.getElementById('briefing-descend') as HTMLButtonElement).click();

    for (let i = 0; i < 240; i++) game.update(1 / 60);
    expect(['SECTOR', 'ORBIT']).toContain(game.debugState().scale);

    // Ascend back to MACRO
    const hudAscend = dom.window.document.getElementById('hud-ascend-btn') as HTMLButtonElement;
    hudAscend.click();
    for (let i = 0; i < 240; i++) game.update(1 / 60);
    expect(game.debugState().scale).toBe('MACRO');

    game.dispose();
  });
});
