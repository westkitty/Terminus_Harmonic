import { describe, expect, it } from 'vitest';
import { ComponentStore, PackedStore, World, type System, type SystemContext } from '../src/core/ecs';

class HullStore extends ComponentStore<{ hp: number }> {
  readonly kind = 'hull';
  protected create() { return { hp: 1 }; }
}
import { EventBus } from '../src/core/events';

describe('compact typed ECS', () => {
  it('creates entities and recycles ids after destruction', () => {
    const w = new World();
    const a = w.create();
    const b = w.create();
    expect(a).not.toBe(b);
    expect(w.isAlive(a)).toBe(true);
    w.destroy(a);
    w.update(0.016);
    expect(w.isAlive(a)).toBe(false);
    const c = w.create();
    expect(c).toBe(a);
  });

  it('defers destruction until the end of the frame', () => {
    const w = new World();
    const e = w.create();
    let seenAliveDuringFrame = false;
    w.addSystem({
      name: 'probe',
      order: 1,
      enabled: true,
      update() {
        seenAliveDuringFrame = w.isAlive(e);
      },
    } satisfies System);
    w.destroy(e);
    w.update(0.016);
    expect(seenAliveDuringFrame).toBe(true);
    expect(w.isAlive(e)).toBe(false);
  });

  it('never destroys the same entity twice', () => {
    const w = new World();
    const e = w.create();
    w.destroy(e);
    w.destroy(e);
    w.update(0.016);
    expect(w.freeCount).toBe(1);
  });

  it('runs systems in ascending order regardless of insertion order', () => {
    const w = new World();
    const order: string[] = [];
    const mk = (name: string, o: number): System => ({
      name,
      order: o,
      enabled: true,
      update: () => void order.push(name),
    });
    w.addSystem(mk('c', 30)).addSystem(mk('a', 10)).addSystem(mk('b', 20));
    w.update(0.016);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(w.systemNames()).toEqual(['a', 'b', 'c']);
  });

  it('rejects duplicate system names', () => {
    const w = new World();
    const s: System = { name: 'dup', order: 1, enabled: true, update: () => {} };
    w.addSystem(s);
    expect(() => w.addSystem(s)).toThrow(/Duplicate system/);
  });

  it('skips disabled systems', () => {
    const w = new World();
    let ran = 0;
    const s: System = { name: 'off', order: 1, enabled: false, update: () => void ran++ };
    w.addSystem(s);
    w.update(0.016);
    expect(ran).toBe(0);
    s.enabled = true;
    w.update(0.016);
    expect(ran).toBe(1);
  });

  it('passes a context with dt, elapsed, frame, world and bus', () => {
    const w = new World();
    let ctx: SystemContext | null = null;
    w.addSystem({ name: 'cap', order: 1, enabled: true, update: (c) => void (ctx = c) });
    w.update(0.5);
    w.update(0.25);
    expect(ctx!.dt).toBe(0.25);
    expect(ctx!.elapsed).toBeCloseTo(0.75, 10);
    expect(ctx!.frame).toBe(2);
    expect(ctx!.world).toBe(w);
    expect(ctx!.bus).toBe(w.bus);
  });

  it('supports tags for cheap boolean queries', () => {
    const w = new World();
    const a = w.create();
    const b = w.create();
    w.tag(a, 'vehicle');
    w.tag(b, 'vehicle');
    expect(w.hasTag(a, 'vehicle')).toBe(true);
    expect(w.tagged('vehicle').size).toBe(2);
    w.untag(a, 'vehicle');
    expect(w.hasTag(a, 'vehicle')).toBe(false);
    w.destroy(b);
    w.update(0.016);
    expect(w.tagged('vehicle').size).toBe(0);
    expect(w.tagged('nothing').size).toBe(0);
  });

  it('cleans component stores when an entity is destroyed', () => {
    const w = new World();
    const store = new HullStore();
    w.registerStore(store);
    const e = w.create();
    store.set(e, { hp: 3 });
    expect(store.get(e)).toEqual({ hp: 3 });
    w.destroy(e);
    w.update(0.016);
    expect(store.get(e)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('packs component data into a flat Float32Array', () => {
    const store = new PackedStore('transform', ['x', 'y', 'z', 'w']);
    const e = 7;
    expect(store.width).toBe(4);
    expect(store.has(e)).toBe(false);
    store.set(e, 'x', 1);
    store.set(e, 'y', 2);
    store.set(e, 'z', 3);
    store.set(e, 'w', 4);
    expect(store.get(e, 'x')).toBe(1);
    expect(store.get(e, 'w')).toBe(4);
    expect(store.size).toBe(1);
    store.add(e, 'x', 0.5);
    expect(store.get(e, 'x')).toBe(1.5);
    expect(() => store.get(e, 'nope')).toThrow(/no field/);
    store.delete(e);
    expect(store.has(e)).toBe(false);
    expect(store.size).toBe(0);
    expect(store.get(e, 'x')).toBe(0);
  });

  it('disposes systems and clears the bus', () => {
    const w = new World();
    let disposed = false;
    w.addSystem({ name: 'd', order: 1, enabled: true, update: () => {}, dispose: () => void (disposed = true) });
    const bus = w.bus;
    let called = 0;
    bus.on('x', () => void called++);
    w.dispose();
    expect(disposed).toBe(true);
    bus.emit('x');
    expect(called).toBe(0);
    expect(w.systemNames()).toEqual([]);
  });

  it('exposes a free-list size for diagnostics', () => {
    const w = new World();
    const ids = [w.create(), w.create(), w.create()];
    for (const id of ids) w.destroy(id);
    w.update(0.016);
    expect(w.freeCount).toBe(3);
  });
});

describe('EventBus', () => {
  it('delivers synchronously to every subscriber', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.on('tick', (p) => void seen.push((p as { n: number }).n));
    bus.emit('tick', { n: 1 });
    bus.emit('tick', { n: 2 });
    expect(seen).toEqual([1, 2]);
  });

  it('unsubscribes with the returned handle', () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.on('t', () => void n++);
    bus.emit('t');
    off();
    bus.emit('t');
    expect(n).toBe(1);
  });

  it('supports one-shot listeners', () => {
    const bus = new EventBus();
    let n = 0;
    bus.once('t', () => void n++);
    bus.emit('t');
    bus.emit('t');
    expect(n).toBe(1);
  });

  it('ignores events with no subscribers', () => {
    const bus = new EventBus();
    expect(() => bus.emit('nobody')).not.toThrow();
  });

  it('isolates a throwing listener from the others', () => {
    const bus = new EventBus();
    let after = 0;
    bus.on('t', () => {
      throw new Error('boom');
    });
    bus.on('t', () => void after++);
    // The bus logs and continues rather than taking the frame down with it.
    const err = console.error;
    const logged: unknown[] = [];
    console.error = (...a: unknown[]) => void logged.push(a[0]);
    try {
      expect(() => bus.emit('t')).not.toThrow();
    } finally {
      console.error = err;
    }
    expect(after).toBe(1);
    expect(logged.length).toBeGreaterThan(0);
  });
});
