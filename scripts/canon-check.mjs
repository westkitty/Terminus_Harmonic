#!/usr/bin/env node
/**
 * CANON QA — machine-enforced Starsilk canon locks.
 * =================================================
 *
 * Run with:  node scripts/canon-check.mjs [--json]
 * Exits non-zero if any lock is violated.
 *
 * This is the automated half of the canon-QA requirement. The rules live in
 * `src/canon/invariants.json` so they can be read by the game at runtime and by
 * this script at build time from a single source of truth.
 *
 * Lock source: https://westkitty.github.io/Starsilk_Character_Dossier/canon/
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.html', '.css', '.md', '.webmanifest']);
/** Directories / files that hold the locks themselves and must not self-trip. */
const SKIP = new Set([
  join(ROOT, 'src/canon/invariants.json'),
  join(ROOT, 'src/canon/fixtures.json'),
  join(ROOT, 'scripts/canon-check.mjs'),
]);
// README.md is the project's front door and holds the most canon-sensitive prose.
const SCAN_DIRS = ['src', 'scripts', 'public', 'tests', 'index.html', 'README.md'];

const invariants = JSON.parse(readFileSync(join(ROOT, 'src/canon/invariants.json'), 'utf8'));
const PROHIBITED = invariants.prohibited.map((r) => ({ ...r, re: new RegExp(r.pattern, 'i') }));
const REQUIRED = invariants.required.map((r) => ({ ...r, re: new RegExp(r.pattern, 'i') }));

function walk(target) {
  const out = [];
  let st;
  try {
    st = statSync(target);
  } catch {
    return out;
  }
  if (st.isDirectory()) {
    if (/node_modules|\.git|dist|coverage/.test(target)) return out;
    for (const e of readdirSync(target)) out.push(...walk(join(target, e)));
  } else if (TEXT_EXT.has(extname(target)) && !SKIP.has(target)) {
    out.push(target);
  }
  return out;
}

const files = [];
for (const d of SCAN_DIRS) files.push(...walk(join(ROOT, d)));
files.sort();

const violations = [];
const missing = [];
let scannedLines = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  scannedLines += lines.length;
  lines.forEach((line, i) => {
    for (const rule of PROHIBITED) {
      if (rule.re.test(line)) {
        violations.push({
          file: rel,
          line: i + 1,
          rule: rule.id,
          why: rule.why,
          text: line.trim().slice(0, 160),
        });
      }
    }
  });
}

for (const req of REQUIRED) {
  let text = '';
  try {
    text = readFileSync(join(ROOT, req.file), 'utf8');
  } catch {
    missing.push({ id: req.id, file: req.file, why: 'file missing' });
    continue;
  }
  if (!req.re.test(text)) missing.push({ id: req.id, file: req.file, why: 'required lock statement not found' });
}

const report = {
  generatedBy: 'scripts/canon-check.mjs',
  lockSource: 'https://westkitty.github.io/Starsilk_Character_Dossier/canon/',
  filesScanned: files.length,
  linesScanned: scannedLines,
  prohibitedRules: PROHIBITED.length,
  requiredLocks: REQUIRED.length,
  violations,
  missingRequiredLocks: missing,
  ok: violations.length === 0 && missing.length === 0,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const v of violations) console.error(`VIOLATION ${v.file}:${v.line} [${v.rule}] ${v.why}\n    ${v.text}`);
  for (const m of missing) console.error(`MISSING LOCK ${m.file} [${m.id}] ${m.why}`);
  console.log(
    `canon: ${files.length} files, ${scannedLines} lines, ${PROHIBITED.length} prohibitions, ` +
      `${REQUIRED.length} required locks — ${report.ok ? 'PASS' : 'FAIL'}`,
  );
}

if (!report.ok) process.exit(1);
