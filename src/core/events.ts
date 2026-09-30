/**
 * A tiny typed publish/subscribe event bus.
 *
 * Systems communicate through this rather than reaching into each other. It is
 * deliberately synchronous and untyped at the boundary so that gameplay code can
 * subscribe to string keys without a generated union.
 */

export type EventPayload = Record<string, unknown> | undefined;

type Handler = (payload: EventPayload) => void;

interface Listener {
  fn: Handler;
  once: boolean;
}

export class EventBus {
  private listeners = new Map<string, Listener[]>();

  on(event: string, fn: Handler): () => void {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    const entry: Listener = { fn, once: false };
    arr.push(entry);
    return () => this.off(event, fn);
  }

  once(event: string, fn: Handler): () => void {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    arr.push({ fn, once: true });
    return () => this.off(event, fn);
  }

  off(event: string, fn: Handler): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const i = arr.findIndex((l) => l.fn === fn);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.listeners.delete(event);
  }

  emit(event: string, payload?: EventPayload): void {
    const arr = this.listeners.get(event);
    if (!arr || arr.length === 0) return;
    // Copy: handlers may subscribe/unsubscribe during dispatch.
    const snapshot = arr.slice();
    for (const l of snapshot) {
      if (l.once) this.off(event, l.fn);
      try {
        l.fn(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${event}" threw`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

/** Well-known event names used across the game. */
export const Events = {
  // Scale transitions
  DescendRequested: 'scale:descend-requested',
  DescendStarted: 'scale:descend-started',
  DescendComplete: 'scale:descend-complete',
  AscendRequested: 'scale:ascend-requested',
  AscendComplete: 'scale:ascend-complete',

  // Planetary state
  PlanetaryTick: 'planetary:tick',
  PlanetaryChanged: 'planetary:changed',
  CrisisResolved: 'crisis:resolved',
  CrisisProgress: 'crisis:progress',

  // Vehicles
  VehiclePossessed: 'vehicle:possessed',
  VehicleReleased: 'vehicle:released',
  VehicleImpact: 'vehicle:impact',
  TetherAttached: 'tether:attached',
  TetherDetached: 'tether:detached',

  // Harmonic network
  SpireRepaired: 'spire:repaired',
  HarmonicPhase: 'harmonic:phase',
  HarmonicEstablished: 'harmonic:established',

  // Persistence
  SaveWritten: 'save:written',
  SaveLoaded: 'save:loaded',

  // UI
  Toast: 'ui:toast',
  BriefingOpen: 'ui:briefing-open',
} as const;
