import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CHECK = join(ROOT, 'scripts/canon-check.mjs');

function runCanon(): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [CHECK], { cwd: ROOT, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/**
 * Run a *copy* of the checker rooted at `root`, so violations can be planted.
 * The checker writes violations to stderr, so both streams are captured.
 */
function runCanonAt(root: string): { status: number; out: string } {
  try {
    return {
      status: 0,
      out: execFileSync('node', [join(root, 'scripts/canon-check.mjs')], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/**
 * A throwaway copy of the checker, its invariants, and every file a required
 * lock lives in. Copying the lock files matters: without them the scratch tree
 * fails for an unrelated reason, which would prove nothing about the plant.
 */
function scratchTree(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'canon-gate-'));
  mkdirSync(join(tmp, 'scripts'), { recursive: true });
  mkdirSync(join(tmp, 'src'), { recursive: true });
  cpSync(CHECK, join(tmp, 'scripts', 'canon-check.mjs'));
  cpSync(join(ROOT, 'src/canon'), join(tmp, 'src', 'canon'), { recursive: true });
  for (const req of invariants.required as { file: string }[]) {
    const dest = join(tmp, req.file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(ROOT, req.file), dest);
  }
  return tmp;
}

const scratchTrees: string[] = [];
afterAll(() => {
  for (const t of scratchTrees) rmSync(t, { recursive: true, force: true });
});

const invariants = JSON.parse(readFileSync(join(ROOT, 'src/canon/invariants.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(join(ROOT, 'src/canon/fixtures.json'), 'utf8'));
const CASES: Record<string, { bad: string; good: string }> = fixtures.cases;

describe('canon QA', () => {
  it('declares every rule with a worked example', () => {
    const ids: string[] = invariants.prohibited.map((r: { id: string }) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    for (const id of ids) {
      expect(CASES[id], `no positive/negative case for rule ${id}`).toBeTruthy();
    }
  });

  it('every rule matches its prohibited phrase and ignores the benign one', () => {
    for (const rule of invariants.prohibited) {
      const re = new RegExp(rule.pattern, 'i');
      const c = CASES[rule.id];
      expect(re.test(c.bad), `rule ${rule.id} must match: ${c.bad}`).toBe(true);
      expect(re.test(c.good), `rule ${rule.id} must NOT match: ${c.good}`).toBe(false);
    }
  });

  it('every required lock is present in the source tree', () => {
    for (const req of invariants.required) {
      const text = readFileSync(join(ROOT, req.file), 'utf8');
      expect(new RegExp(req.pattern, 'i').test(text), `missing required lock ${req.id}`).toBe(true);
    }
  });

  it('the checker passes on the real source tree', () => {
    const r = runCanon();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('scans README.md, the project front door, for canon violations', () => {
    const scanDirs = readFileSync(CHECK, 'utf8');
    expect(scanDirs).toContain('README.md');
  });

  it('the gate has teeth: a planted violation in a real file fails the build', () => {
    // A checker that always exits zero would satisfy every test above. This one
    // plants actual violations in actual scannable files and demands failure.
    // The planted lines live in fixtures.json (which the checker skips) so this
    // test file does not itself violate the locks it is testing.
    const plants: { rule: string; file: string; line: string }[] = fixtures.plants;
    expect(plants.length).toBeGreaterThanOrEqual(8);
    for (const plant of plants) {
      const tmp = scratchTree();
      scratchTrees.push(tmp);
      writeFileSync(join(tmp, plant.file), `# probe\n${plant.line}\n`);
      const r = runCanonAt(tmp);
      expect(r.status, `rule ${plant.rule} did not fail the gate`).not.toBe(0);
      expect(r.out, `rule ${plant.rule} not named in the report`).toContain(plant.rule);
      expect(r.out, `rule ${plant.rule} did not report its own file`).toContain(plant.file);
    }
  });

  it('the gate passes a clean scratch tree, so failures come from the plant', () => {
    const tmp = scratchTree();
    scratchTrees.push(tmp);
    writeFileSync(join(tmp, 'README.md'), '# clean\nNothing prohibited here.\n');
    const r = runCanonAt(tmp);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('PASS');
  });

  it('the checker reports a violation instead of passing silently', () => {
    // Exactly one rule fires on the prohibited phrase, and none on the benign
    // one, so the gate cannot be satisfied by matching everything vaguely.
    const bad = CASES['no-drakken-taxon-as-active-entity'].bad;
    const good = CASES['no-drakken-taxon-as-active-entity'].good;
    const hits = invariants.prohibited.filter((r: { id: string; pattern: string }) =>
      new RegExp(r.pattern, 'i').test(bad),
    );
    const falsePos = invariants.prohibited.filter((r: { id: string; pattern: string }) =>
      new RegExp(r.pattern, 'i').test(good),
    );
    expect(hits.map((h: { id: string }) => h.id)).toEqual(['no-drakken-taxon-as-active-entity']);
    expect(falsePos).toEqual([]);
  });
});
