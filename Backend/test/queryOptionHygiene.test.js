// Query-option hygiene — the registry-wide guard behind the boot deprecation
// "the `new` option for `findOneAndUpdate()` and `findOneAndReplace()` is
// deprecated. Use `returnDocument: 'after'` instead."
//
// Installed Mongoose (9.9.1) warns on every findOneAndUpdate-family query that
// carries `new` (lib/query.js:3993) — and findByIdAndUpdate funnels through
// the same path. Mongoose 10 REMOVES the option, so this is not noise to
// silence but a deadline: every `new: true` had to become
// `returnDocument: 'after'` (identical semantics), including the one site
// that carried both spellings (the leftover `new: true` still warns).
//
// Hermetic, no database: this sweeps the source corpus itself. Comments are
// scanned too on purpose — docs that teach a dying option breed it back.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const walkJs = (root) => {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.name.endsWith('.js')) out.push(p);
    }
  };
  visit(join(backendRoot, root));
  return out.sort();
};

const corpus = [...walkJs('src'), ...walkJs('scripts')];

test('the source corpus is large enough for this sweep to mean something', () => {
  assert.ok(
    corpus.length >= 200,
    `expected the real backend corpus (>= 200 files), got ${corpus.length} — the sweep below is only as real as its coverage`,
  );
});

test('no source file (code or comment) uses the removed `new` query option', () => {
  const offenders = [];
  for (const file of corpus) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\bnew:\s*(true|false)\b/.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'deprecated `new:` query option found — Mongoose 10 removes it; use returnDocument: \'after\' (\'before\' where new was false)',
  );
});

test('the modern returnDocument spelling is actually in use (the migration happened)', () => {
  let count = 0;
  for (const file of corpus) {
    count += (readFileSync(file, 'utf8').match(/returnDocument:\s*'(after|before)'/g) || []).length;
  }
  assert.ok(
    count >= 80,
    `expected >= 80 returnDocument occurrences after the migration, found ${count}`,
  );
});
