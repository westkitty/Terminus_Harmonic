/**
 * Entry point.
 *
 * Fails loudly but gracefully: if WebGL is unavailable the user gets a readable
 * message rather than a blank screen.
 */

import './ui/styles.css';
import { Game } from './game/Game';

function fail(message: string): void {
  const pre = document.getElementById('preboot');
  if (pre) {
    pre.textContent = message;
    pre.style.color = '#c8402a';
    pre.style.letterSpacing = '0.08em';
    pre.style.textTransform = 'none';
    pre.style.padding = '24px';
    pre.style.textAlign = 'center';
    pre.style.fontSize = '0.8rem';
  }
}

function main(): void {
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  if (!canvas) {
    fail('Canvas element missing.');
    return;
  }

  // WebGL capability probe.
  try {
    const test = document.createElement('canvas');
    const gl = test.getContext('webgl2') ?? test.getContext('webgl');
    if (!gl) {
      fail('WebGL is unavailable in this browser. The Terminus Harmonic requires WebGL.');
      return;
    }
  } catch {
    fail('WebGL initialisation failed. The Terminus Harmonic requires WebGL.');
    return;
  }

  const preboot = document.getElementById('preboot');
  if (preboot) preboot.remove();

  let game: Game;
  try {
    game = new Game(canvas);
  } catch (err) {
    console.error(err);
    fail(`Initialisation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  void game.start();

  // Expose for automated smoke tests and console inspection.
  (window as unknown as { __terminus?: unknown }).__terminus = {
    game,
    get state() {
      return () => game.debugState();
    },
    save: () => (game as unknown as { saveGame: (m: boolean) => Promise<void> }).saveGame(true),
  };

  window.addEventListener('beforeunload', () => {
    (game as unknown as { saveGame: (m: boolean) => Promise<void> }).saveGame(false);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
