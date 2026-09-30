/**
 * Compact typed Entity-Component-System.
 *
 * Design notes:
 *  - Entities are plain numeric ids recycled from a free list (stable ordering,
 *    no pointer churn, trivially serializable).
 *  - Components live in per-type stores. Hot, numeric, fixed-shape components use
 *    struct-of-arrays Float32Array backing (see `PackedStore`); everything else
 *    uses a Map.
 *  - Systems are plain objects with an `update(ctx)` method. There is no
 *    reflection, no dependency graph solver, no codegen. The ordering is explicit
 *    and readable, which is what a game of this size actually needs.
 */

import { EventBus } from './events';

export type Entity = number;

export interface SystemContext {
  dt: number;
  elapsed: number;
  frame: number;
  world: World;
  bus: EventBus;
}

export interface System {
  readonly name: string;
  /** Lower runs earlier. */
  readonly order: number;
  enabled: boolean;
  update(ctx: SystemContext): void;
  dispose?(): void;
}

/** Base class for Map-backed components. */
export abstract class ComponentStore<T> {
  protected data = new Map<Entity, T>();
  abstract readonly kind: string;

  set(entity: Entity, value: T): void {
    this.data.set(entity, value);
  }
  get(entity: Entity): T | undefined {
    return this.data.get(entity);
  }
  /** Returns a mutable reference; the caller must not retain it across frames. */
  ref(entity: Entity): T {
    let v = this.data.get(entity);
    if (v === undefined) {
      v = this.create();
      this.data.set(entity, v);
    }
    return v;
  }
  has(entity: Entity): boolean {
    return this.data.has(entity);
  }
  delete(entity: Entity): void {
    this.data.delete(entity);
  }
  get size(): number {
    return this.data.size;
  }
  entities(): IterableIterator<Entity> {
    return this.data.keys();
  }
  values(): IterableIterator<T> {
    return this.data.values();
  }
  entries(): IterableIterator<[Entity, T]> {
    return this.data.entries();
  }
  clear(): void {
    this.data.clear();
  }
  protected abstract create(): T;
}

/**
 * Struct-of-arrays store for a fixed-width numeric component.
 * `fields` declares the layout; component access is `store.x(e)` / `store.setX(e, v)`.
 */
export class PackedStore {
  readonly kind: string;
  readonly fields: readonly string[];
  readonly width: number;
  private buffer: Float32Array;
  private capacity: number;
  private index = new Map<Entity, number>();
  private freeSlots: number[] = [];

  constructor(kind: string, fields: readonly string[], capacity = 1024) {
    this.kind = kind;
    this.fields = fields;
    this.width = fields.length;
    this.capacity = Math.max(16, capacity);
    this.buffer = new Float32Array(this.capacity * this.width);
  }

  private grow(): void {
    const next = new Float32Array(this.capacity * 2 * this.width);
    next.set(this.buffer);
    this.buffer = next;
    this.capacity *= 2;
  }

  private slot(e: Entity): number {
    let s = this.index.get(e);
    if (s === undefined) {
      s = this.freeSlots.pop();
      if (s === undefined) {
        if (this.count >= this.capacity) this.grow();
        s = this.count;
      }
      this.index.set(e, s);
      this.count++;
      const base = s * this.width;
      for (let i = 0; i < this.width; i++) this.buffer[base + i] = 0;
    }
    return s;
  }

  count = 0;

  private off(field: string): number {
    const i = this.fields.indexOf(field);
    if (i < 0) throw new Error(`PackedStore(${this.kind}) has no field "${field}"`);
    return i;
  }

  get(e: Entity, field: string): number {
    const s = this.index.get(e);
    if (s === undefined) return 0;
    return this.buffer[s * this.width + this.off(field)];
  }

  set(e: Entity, field: string, v: number): void {
    this.buffer[this.slot(e) * this.width + this.off(field)] = v;
  }

  add(e: Entity, field: string, dv: number): void {
    this.set(e, field, this.get(e, field) + dv);
  }

  has(e: Entity): boolean {
    return this.index.has(e);
  }

  delete(e: Entity): void {
    const s = this.index.get(e);
    if (s === undefined) return;
    this.index.delete(e);
    this.freeSlots.push(s);
    this.count--;
    const base = s * this.width;
    for (let i = 0; i < this.width; i++) this.buffer[base + i] = 0;
  }

  clear(): void {
    this.index.clear();
    this.freeSlots.length = 0;
    this.count = 0;
    this.buffer.fill(0);
  }

  entities(): Entity[] {
    return [...this.index.keys()];
  }

  get size(): number {
    return this.count;
  }
}

export class World {
  readonly bus = new EventBus();
  private nextId = 1;
  private freeIds: Entity[] = [];
  private systems: System[] = [];
  private systemByName = new Map<string, System>();
  private destroyed = new Set<Entity>();
  /** Entities flagged for removal at the end of the frame. */
  private pendingDestroy: Entity[] = [];
  /** Tags: cheap boolean membership sets used for queries. */
  private tags = new Map<string, Set<Entity>>();
  /** Registry of component stores for save/serialization and debugging. */
  private stores = new Map<string, ComponentStore<unknown> | PackedStore>();
  frame = 0;
  elapsed = 0;

  create(): Entity {
    const id = this.freeIds.pop() ?? this.nextId++;
    this.destroyed.delete(id);
    return id;
  }

  destroy(e: Entity): void {
    if (this.destroyed.has(e)) return;
    this.pendingDestroy.push(e);
  }

  isAlive(e: Entity): boolean {
    return !this.destroyed.has(e);
  }

  /** Number of recycled ids waiting to be handed out again. */
  get freeCount(): number {
    return this.freeIds.length;
  }

  tag(e: Entity, name: string): void {
    let s = this.tags.get(name);
    if (!s) {
      s = new Set();
      this.tags.set(name, s);
    }
    s.add(e);
  }

  untag(e: Entity, name: string): void {
    this.tags.get(name)?.delete(e);
  }

  hasTag(e: Entity, name: string): boolean {
    return this.tags.get(name)?.has(e) ?? false;
  }

  tagged(name: string): ReadonlySet<Entity> {
    return this.tags.get(name) ?? EMPTY_SET;
  }

  registerStore(store: ComponentStore<unknown> | PackedStore): void {
    this.stores.set(store.kind, store);
  }

  store(kind: string): ComponentStore<unknown> | PackedStore | undefined {
    return this.stores.get(kind);
  }

  addSystem(system: System): this {
    if (this.systemByName.has(system.name)) {
      throw new Error(`Duplicate system "${system.name}"`);
    }
    this.systems.push(system);
    this.systemByName.set(system.name, system);
    this.systems.sort((a, b) => a.order - b.order);
    return this;
  }

  getSystem<T extends System>(name: string): T | undefined {
    return this.systemByName.get(name) as T | undefined;
  }

  systemNames(): string[] {
    return this.systems.map((s) => s.name);
  }

  /** Run one simulation step. `dt` is clamped by the caller. */
  update(dt: number): void {
    this.elapsed += dt;
    this.frame++;
    const ctx: SystemContext = { dt, elapsed: this.elapsed, frame: this.frame, world: this, bus: this.bus };
    for (const s of this.systems) {
      if (s.enabled) s.update(ctx);
    }
    if (this.pendingDestroy.length > 0) {
      for (const e of this.pendingDestroy) this.destroyEntity(e);
      this.pendingDestroy.length = 0;
    }
  }

  private destroyEntity(e: Entity): void {
    if (this.destroyed.has(e)) return;
    this.destroyed.add(e);
    for (const s of this.stores.values()) s.delete(e);
    for (const set of this.tags.values()) set.delete(e);
    this.freeIds.push(e);
  }

  dispose(): void {
    for (const s of this.systems) s.dispose?.();
    this.systems.length = 0;
    this.systemByName.clear();
    this.stores.clear();
    this.tags.clear();
    this.bus.clear();
  }
}

const EMPTY_SET: ReadonlySet<Entity> = new Set();
