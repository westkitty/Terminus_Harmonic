/**
 * OS-LEVEL PREFERENCES
 * ====================
 *
 * The game has settings for reduced motion, high contrast and large text, but
 * they all defaulted to off and nothing ever read the user's actual OS
 * preference. Someone who has asked their system to reduce motion was still
 * getting a 1.35 s transition wipe and screen shake unless they happened to
 * find the checkbox.
 *
 * These helpers read the preferences so the game can *start* in the
 * configuration the user already asked for. They are a default, not a lock:
 * an explicit choice in the settings panel (or in a restored save) still wins.
 *
 * Every read is guarded. `matchMedia` is absent in jsdom and in some embedded
 * webviews, and a missing preference must never be a crash.
 */

/** True when the user has asked the system to minimise animation. */
export function prefersReducedMotion(): boolean {
  return matches('(prefers-reduced-motion: reduce)');
}

/** True when the user has asked for stronger contrast than the default. */
export function prefersHighContrast(): boolean {
  return matches('(prefers-contrast: more)');
}

/**
 * Watch a media query and re-seed the settings when it changes. Returns a
 * disposer. Used so that flipping the OS setting mid-session takes effect.
 */
export function watchPreference(query: string, onChange: (matches: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(query);
  } catch {
    return () => undefined;
  }
  const handler = (e: MediaQueryListEvent): void => onChange(e.matches);
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }
  // Older Safari only has the deprecated addListener/removeListener pair.
  const legacy = mql as unknown as {
    addListener?: (h: (e: MediaQueryListEvent) => void) => void;
    removeListener?: (h: (e: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener?.(handler);
  return () => legacy.removeListener?.(handler);
}

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}
