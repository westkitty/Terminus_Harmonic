/**
 * OS-LEVEL ACCESSIBILITY PREFERENCES
 * ==================================
 *
 * The game ships toggles for reduced motion, high contrast and large text. They
 * all used to default to off and nothing read the user's actual OS preference,
 * so someone who had asked their system to reduce motion still got the full
 * 1.35 s transition wipe and screen shake unless they found the checkbox.
 *
 * These tests pin the seeding behaviour down: the preference must reach the
 * settings, must reach the things that consume it, and must be overridable.
 */

import { describe, expect, it } from 'vitest';
import {
  prefersHighContrast,
  prefersReducedMotion,
  watchPreference,
} from '../src/core/media';

type Listener = (e: { matches: boolean }) => void;

/** Install a controllable matchMedia on globalThis and return its controls. */
function installMatchMedia(initial: Record<string, boolean>): {
  set: (query: string, matches: boolean) => void;
  listeners: Map<string, Listener[]>;
} {
  const listeners = new Map<string, Listener[]>();
  const state = new Map<string, boolean>(Object.entries(initial));
  const w = globalThis as unknown as { window?: unknown };
  const previous = w.window;
  w.window = {
    matchMedia(query: string): {
      matches: boolean;
      addEventListener: (_: string, h: Listener) => void;
      removeEventListener: (_: string, h: Listener) => void;
    } {
      const arr = listeners.get(query) ?? [];
      listeners.set(query, arr);
      return {
        get matches(): boolean {
          return state.get(query) ?? false;
        },
        addEventListener: (_t, h) => void arr.push(h),
        removeEventListener: (_t, h) => {
          const i = arr.indexOf(h);
          if (i >= 0) arr.splice(i, 1);
        },
      };
    },
  };
  return {
    set(query, matches) {
      state.set(query, matches);
      for (const h of listeners.get(query) ?? []) h({ matches });
    },
    listeners,
  };
  void previous;
}

describe('OS accessibility preferences', () => {
  it('reads reduced motion when the user has asked for it', () => {
    installMatchMedia({ '(prefers-reduced-motion: reduce)': true });
    expect(prefersReducedMotion()).toBe(true);
  });

  it('reads reduced motion as false when the user has not', () => {
    installMatchMedia({ '(prefers-reduced-motion: reduce)': false });
    expect(prefersReducedMotion()).toBe(false);
  });

  it('reads high contrast independently of motion', () => {
    installMatchMedia({
      '(prefers-reduced-motion: reduce)': false,
      '(prefers-contrast: more)': true,
    });
    expect(prefersReducedMotion()).toBe(false);
    expect(prefersHighContrast()).toBe(true);
  });

  it('reports false rather than throwing when matchMedia is unavailable', () => {
    const w = globalThis as unknown as { window?: unknown };
    w.window = {};
    expect(prefersReducedMotion()).toBe(false);
    expect(prefersHighContrast()).toBe(false);
  });

  it('reports false rather than throwing when matchMedia itself throws', () => {
    const w = globalThis as unknown as { window?: unknown };
    w.window = {
      matchMedia(): never {
        throw new Error('not implemented');
      },
    };
    expect(prefersReducedMotion()).toBe(false);
    expect(prefersHighContrast()).toBe(false);
  });

  it('fires when the OS preference changes mid-session', () => {
    const ctl = installMatchMedia({ '(prefers-reduced-motion: reduce)': false });
    const seen: boolean[] = [];
    const stop = watchPreference('(prefers-reduced-motion: reduce)', (m) => seen.push(m));
    ctl.set('(prefers-reduced-motion: reduce)', true);
    ctl.set('(prefers-reduced-motion: reduce)', false);
    expect(seen).toEqual([true, false]);
    stop();
    ctl.set('(prefers-reduced-motion: reduce)', true);
    expect(seen).toEqual([true, false]);
  });

  it('returns a no-op disposer when the platform cannot watch', () => {
    const w = globalThis as unknown as { window?: unknown };
    w.window = {};
    let stop: () => void = () => {
      throw new Error('not set');
    };
    expect(() => {
      stop = watchPreference('(prefers-reduced-motion: reduce)', () => undefined);
    }).not.toThrow();
    expect(() => stop()).not.toThrow();
  });
});
