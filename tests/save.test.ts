import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  SaveStore,
  computeChecksum,
  defaultSettings,
  migrate,
  newSave,
  validateSave,
  type SaveData,
} from '../src/state/save';
import { PlanetaryState } from '../src/state/planetary';
import { WORLD_SEED } from '../src/state/world';

function makeSave(): SaveData {
  const p = new PlanetaryState(WORLD_SEED);
  const s = newSave(WORLD_SEED, p.snapshot());
  s.spires = [
    { id: 0, functional: true, phase: 12, repairs: 2, seated: true },
    { id: 1, functional: false, phase: 200, repairs: 0, seated: true },
  ];
  s.crises = [
    { id: 'ORBITAL_SHADOW_CASCADE', status: 'RESOLVED', progress: { capture: 6 }, tunnels: '1,2+4', startedAt: 1, resolvedAt: 2 },
    { id: 'HARMONIC_FAULT', status: 'ACTIVE', progress: {}, tunnels: '', startedAt: 3, resolvedAt: null },
  ];
  s.campaign.domainPoints = { ORBIT: 3, SKY: 0, SURFACE: 0, SUBSURFACE: 0, HARMONIC: 0 };
  s.campaign.unlockedModules = ['Tether Winch'];
  const { checksum: _c, ...rest } = s;
  s.checksum = computeChecksum(rest);
  return s;
}

describe('save architecture', () => {
  it('declares a schema version', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('validates a well-formed save', () => {
    expect(validateSave(makeSave())).toEqual([]);
  });

  it('rejects structurally broken saves with specific problems', () => {
    expect(validateSave(null)).toContain('save is not an object');
    expect(validateSave({ version: 1 })).toContain('bad worldSeed');
    const bad = makeSave();
    (bad.planetary.vars as Record<string, number>).powerAvailability = Number.NaN;
    expect(validateSave(bad).join()).toContain('powerAvailability');
  });

  it('migrates a v1 payload forward to the current schema', () => {
    const v1 = {
      version: 1,
      worldSeed: 123,
      planetary: new PlanetaryState(WORLD_SEED).snapshot(),
      crises: [{ id: 'X', status: 'AVAILABLE', progress: {} }],
      spires: [{ id: 0, functional: true, phase: 0, repairs: 0 }],
      settlements: [],
      vehicles: {},
      campaign: { domainPoints: {}, unlockedModules: [], activeCrisis: null },
      log: [],
      checksum: 'x',
    };
    const out = migrate(v1);
    expect(out.version).toBe(SCHEMA_VERSION);
    expect(out.spires[0].seated).toBe(true);
    expect(out.crises[0].tunnels).toBe('');
    expect(out.crises[0].startedAt).toBeNull();
    expect(out.playSeconds).toBe(0);
    expect(out.campaign.harmonicUnlocked).toBe(false);
    expect(out.settings).toBeTruthy();
  });

  it('migrates a v2 payload forward', () => {
    const base = makeSave();
    const v2 = { ...base, version: 2, playSeconds: undefined, campaign: { ...base.campaign, harmonicUnlocked: undefined } };
    delete (v2 as Record<string, unknown>).playSeconds;
    const out = migrate(v2);
    expect(out.version).toBe(SCHEMA_VERSION);
    expect(out.playSeconds).toBe(0);
    expect(out.campaign.harmonicUnlocked).toBe(false);
  });

  it('refuses a save from a newer schema', () => {
    const newer = { ...makeSave(), version: SCHEMA_VERSION + 5 };
    expect(() => migrate(newer)).toThrow(/newer than supported/);
  });

  it('round-trips through JSON export/import', () => {
    const s = makeSave();
    const json = SaveStore.exportJson(s);
    const back = SaveStore.importJson(json);
    expect(back.version).toBe(s.version);
    expect(back.worldSeed).toBe(s.worldSeed);
    expect(back.spires).toEqual(s.spires);
    expect(back.crises).toEqual(s.crises);
    expect(back.planetary.vars).toEqual(s.planetary.vars);
  });

  it('rejects malformed JSON import', () => {
    expect(() => SaveStore.importJson('not json')).toThrow(/not valid JSON/);
  });

  it('rejects a JSON payload that is not a save object', () => {
    expect(() => SaveStore.importJson('42')).toThrow();
    expect(() => SaveStore.importJson('"hello"')).toThrow();
  });

  it('re-checksums after mutation so tampering is detectable', () => {
    const s = makeSave();
    const { checksum: _c, ...rest } = s;
    expect(computeChecksum(rest)).toBe(s.checksum);
    rest.worldSeed = 999;
    expect(computeChecksum(rest)).not.toBe(s.checksum);
  });

  it('provides safe default settings', () => {
    const d = defaultSettings();
    expect(d.masterVolume).toBeGreaterThan(0);
    expect(d.masterVolume).toBeLessThanOrEqual(1);
    expect(typeof d.reducedMotion).toBe('boolean');
    expect(typeof d.qualityTier).toBe('string');
  });
});
