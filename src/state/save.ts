/**
 * PERSISTENCE — IndexedDB save architecture
 * =========================================
 *
 * Design:
 *  - One object store, one row per slot. The row is a versioned envelope.
 *  - `SCHEMA_VERSION` is bumped on any breaking shape change; `migrate()` walks
 *    old payloads forward one step at a time.
 *  - `validate()` rejects anything structurally wrong so a corrupted save fails
 *    gracefully (fresh start + a toast) instead of crashing the app.
 *  - JSON export/import is offered as a secondary safety net.
 *
 * The save is intentionally small: sectors are reconstructable from the world
 * seed, so only *player-caused* deviations (excavation, repairs, progress) are
 * stored.
 */

import { PLANETARY_VARS, type PlanetarySnapshot } from './planetary';

export const SCHEMA_VERSION = 3;

export interface CrisisProgressRecord {
  id: string;
  status: 'LOCKED' | 'AVAILABLE' | 'ACTIVE' | 'RESOLVED';
  progress: Record<string, number>;
  /** Player-caused tunnel excavation, RLE-encoded (see TunnelLattice). */
  tunnels: string;
  startedAt: number | null;
  resolvedAt: number | null;
}

export interface SpireRecord {
  id: number;
  functional: boolean;
  /** Current phase offset in degrees. */
  phase: number;
  /** Repair contributions applied. */
  repairs: number;
  seated: boolean;
}

export interface SettingsRecord {
  qualityTier: 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA';
  adaptiveQuality: boolean;
  masterVolume: number;
  sfxVolume: number;
  ambientVolume: number;
  musicVolume: number;
  reducedMotion: boolean;
  highContrast: boolean;
  largeText: boolean;
  screenShake: boolean;
  showPerf: boolean;
  invertY: boolean;
  touchControls: boolean;
  bindings: Record<string, string[]>;
}

export interface SaveData {
  version: number;
  worldSeed: number;
  createdAt: number;
  updatedAt: number;
  playSeconds: number;
  planetary: PlanetarySnapshot;
  campaign: {
    domainPoints: Record<string, number>;
    unlockedModules: string[];
    activeCrisis: string | null;
    harmonicUnlocked: boolean;
  };
  crises: CrisisProgressRecord[];
  spires: SpireRecord[];
  settlements: { id: string; viability: number }[];
  vehicles: Record<string, { upgradeLevel: number; modules: string[] }>;
  settings: SettingsRecord;
  /** Free-form event log, newest last, capped. */
  log: { t: number; text: string }[];
  checksum: string;
}

const DB_NAME = 'terminus-harmonic';
const DB_VERSION = 1;
const STORE = 'saves';
const SLOT_AUTOSAVE = 'autosave';
const SLOT_MANUAL = 'manual';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
        t.oncomplete = () => db.close();
        t.onabort = () => {
          db.close();
          reject(new Error('indexedDB transaction aborted'));
        };
      }),
  );
}

/** Cheap structural checksum so truncated writes are detected. */
function checksum(obj: unknown): string {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function computeChecksum(data: Omit<SaveData, 'checksum'>): string {
  return checksum(data);
}

/** Structural validation. Returns a list of problems; empty means valid. */
export function validateSave(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null) return ['save is not an object'];
  const d = raw as Partial<SaveData>;
  if (typeof d.version !== 'number') problems.push('missing version');
  if (typeof d.worldSeed !== 'number' || !Number.isFinite(d.worldSeed)) problems.push('bad worldSeed');
  if (typeof d.planetary !== 'object' || d.planetary === null) {
    problems.push('missing planetary');
  } else {
    const vars = (d.planetary as PlanetarySnapshot).vars;
    if (typeof vars !== 'object' || vars === null) {
      problems.push('planetary.vars missing');
    } else {
      for (const v of PLANETARY_VARS) {
        const x = (vars as Record<string, unknown>)[v];
        if (typeof x !== 'number' || !Number.isFinite(x)) problems.push(`planetary.vars.${v} invalid`);
      }
    }
  }
  if (!Array.isArray(d.crises)) problems.push('crises not an array');
  if (!Array.isArray(d.spires)) problems.push('spires not an array');
  if (typeof d.settings !== 'object' || d.settings === null) problems.push('settings missing');
  if (typeof d.checksum !== 'string') problems.push('checksum missing');
  return problems;
}

/**
 * Migrations. Each entry upgrades version N -> N+1. Keep them additive and
 * defensive; a failed migration throws and the caller falls back to a new game.
 */
const MIGRATIONS: Record<number, (d: Record<string, unknown>) => void> = {
  1: (d) => {
    // v1 -> v2: settings moved into the envelope; spires gained `seated`.
    if (typeof d.settings !== 'object' || d.settings === null) d.settings = {};
    const spires = d.spires as Record<string, unknown>[] | undefined;
    if (Array.isArray(spires)) {
      for (const s of spires) if (typeof s.seated !== 'boolean') s.seated = true;
    }
    if (!Array.isArray(d.log)) d.log = [];
  },
  2: (d) => {
    // v2 -> v3: crisis records gained `tunnels` and `startedAt`.
    const crises = d.crises as Record<string, unknown>[] | undefined;
    if (Array.isArray(crises)) {
      for (const c of crises) {
        if (typeof c.tunnels !== 'string') c.tunnels = '';
        if (!('startedAt' in c)) c.startedAt = null;
      }
    }
    if (typeof d.playSeconds !== 'number') d.playSeconds = 0;
    const campaign = d.campaign as Record<string, unknown> | undefined;
    if (campaign && typeof campaign.harmonicUnlocked !== 'boolean') campaign.harmonicUnlocked = false;
  },
};

export function migrate(raw: unknown): SaveData {
  if (typeof raw !== 'object' || raw === null) throw new Error('save is not an object');
  const d = { ...(raw as Record<string, unknown>) } as Record<string, unknown>;
  let v = typeof d.version === 'number' ? d.version : 1;
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no migration from schema ${v}`);
    step(d);
    v++;
    d.version = v;
  }
  if (v > SCHEMA_VERSION) throw new Error(`save schema ${v} is newer than supported ${SCHEMA_VERSION}`);
  const problems = validateSave(d);
  if (problems.length > 0) throw new Error(`save failed validation: ${problems.join(', ')}`);
  return d as unknown as SaveData;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  bytes?: number;
}

async function write(slot: string, data: SaveData): Promise<SaveResult> {
  const { checksum: _drop, ...rest } = data;
  const withChecksum: SaveData = { ...rest, checksum: computeChecksum(rest) };
  try {
    await tx('readwrite', (store) => store.put(withChecksum as unknown as never, slot));
    return { ok: true, bytes: JSON.stringify(withChecksum).length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function read(slot: string): Promise<SaveData | null> {
  try {
    const raw = await tx<unknown>('readonly', (store) => store.get(slot));
    if (raw === undefined || raw === null) return null;
    return migrate(raw);
  } catch (err) {
    console.warn('[Save] read/migrate failed', err);
    return null;
  }
}

export const SaveStore = {
  async writeAutosave(data: SaveData): Promise<SaveResult> {
    return write(SLOT_AUTOSAVE, data);
  },
  async writeManual(data: SaveData): Promise<SaveResult> {
    return write(SLOT_MANUAL, data);
  },
  async readAutosave(): Promise<SaveData | null> {
    return read(SLOT_AUTOSAVE);
  },
  async readManual(): Promise<SaveData | null> {
    return read(SLOT_MANUAL);
  },
  async readAny(): Promise<SaveData | null> {
    return (await read(SLOT_MANUAL)) ?? (await read(SLOT_AUTOSAVE));
  },
  async clear(): Promise<void> {
    try {
      await tx('readwrite', (store) => store.clear());
    } catch (err) {
      console.warn('[Save] clear failed', err);
    }
  },
  async hasSave(): Promise<boolean> {
    return (await SaveStore.readAny()) !== null;
  },
  /** Secondary safety net. */
  exportJson(data: SaveData): string {
    const { checksum: _drop, ...rest } = data;
    return JSON.stringify({ ...rest, checksum: computeChecksum(rest) }, null, 2);
  },
  importJson(text: string): SaveData {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('not valid JSON');
    }
    return migrate(parsed);
  },
};

/** Default settings, used for new games and to fill gaps in old saves. */
export function defaultSettings(): SettingsRecord {
  return {
    qualityTier: 'HIGH',
    adaptiveQuality: true,
    masterVolume: 0.8,
    sfxVolume: 0.9,
    ambientVolume: 0.7,
    musicVolume: 0.55,
    reducedMotion: false,
    highContrast: false,
    largeText: false,
    screenShake: true,
    showPerf: false,
    invertY: false,
    touchControls: true,
    bindings: {},
  };
}

/** Fresh save envelope for a new campaign on the given seed. */
export function newSave(worldSeed: number, planetary: PlanetarySnapshot): SaveData {
  const now = Date.now();
  return {
    version: SCHEMA_VERSION,
    worldSeed,
    createdAt: now,
    updatedAt: now,
    playSeconds: 0,
    planetary,
    campaign: {
      domainPoints: { ORBIT: 0, SKY: 0, SURFACE: 0, SUBSURFACE: 0, HARMONIC: 0 },
      unlockedModules: [],
      activeCrisis: null,
      harmonicUnlocked: false,
    },
    crises: [],
    spires: [],
    settlements: [],
    vehicles: {},
    settings: defaultSettings(),
    log: [{ t: now, text: 'Survey commenced.' }],
    checksum: '',
  };
}
