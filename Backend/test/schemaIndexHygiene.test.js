// Schema index hygiene — the registry-wide guard behind the boot warning
// "Duplicate schema index on {...} for model X".
//
// Mongoose builds schema indexes one at a time, in declaration order
// (lib/model.js _ensureIndexes, gh-15056). When two unnamed declarations
// share a key pattern, the FIRST one wins, the second createIndex fails with
// IndexOptionsConflict, and the failure is swallowed as a model 'index' event
// nobody listens to. That is exactly how this repo silently lost the
// "one CURRENT row per tenant" indexes on PayrollSetup and AttendancePolicy:
// a field-level `index: true` on companyId raced the explicit
// partial-unique schema.index() and won, so MongoDB only ever received the
// plain index while the UNIQUE constraint never reached the database.
//
// These pins turn the whole class of bug into a test failure — hermetically,
// with no database: model registration alone is enough to inspect every
// schema's declared indexes.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

const testDir = dirname(fileURLToPath(import.meta.url));
const modelsDir = join(testDir, '..', 'src', 'models');

// Register every model exactly the way the API does at boot: by importing the
// module. A file that fails to load fails this suite loudly.
for (const file of readdirSync(modelsDir).sort()) {
  if (file.endsWith('.js')) {
    await import(pathToFileURL(join(modelsDir, file)).href);
  }
}

const unnamedIndexes = (modelName) =>
  mongoose
    .model(modelName)
    .schema.indexes()
    // Mongoose's own duplicate check only applies to indexes without an
    // explicit `name` option — named indexes may legitimately repeat a pattern.
    .filter(([, options]) => !options || options.name == null);

test('the full model registry loads hermetically (no database, no connection)', () => {
  assert.ok(
    mongoose.modelNames().length >= 130,
    `expected the whole model registry (>= 130 models), got ${mongoose.modelNames().length} — the sweep below is only as real as its coverage`,
  );
});

test('no model declares two unnamed indexes with the same key pattern', () => {
  const offenders = [];
  for (const name of mongoose.modelNames()) {
    const seen = new Set();
    for (const [spec] of unnamedIndexes(name)) {
      const key = JSON.stringify(spec);
      if (seen.has(key)) {
        offenders.push(`${name}: ${key}`);
      }
      seen.add(key);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'duplicate key patterns found — Mongoose keeps only the FIRST declaration, and the second one silently fails to build in MongoDB',
  );
});

const oneCurrentRowPerTenant = (modelName) => {
  const matches = unnamedIndexes(modelName).filter(
    ([spec]) => JSON.stringify(spec) === '{"companyId":1}',
  );
  assert.equal(matches.length, 1, `${modelName} must declare {companyId:1} exactly once`);
  const [, options] = matches[0];
  assert.equal(options.unique, true, `${modelName} {companyId:1} must be unique`);
  assert.deepEqual(
    options.partialFilterExpression,
    { isCurrent: true },
    `${modelName} {companyId:1} must be partial on the CURRENT row only`,
  );
};

test('one CURRENT PayrollSetup per tenant is enforced by exactly one partial-unique index', () => {
  oneCurrentRowPerTenant('PayrollSetup');
});

test('one CURRENT AttendancePolicy per tenant is enforced by exactly one partial-unique index', () => {
  oneCurrentRowPerTenant('AttendancePolicy');
});

test('the boot log reports the real permission-catalogue version, not a hardcoded one', async () => {
  const source = await readFile(join(testDir, '..', 'src', 'server.js'), 'utf8');
  assert.match(
    source,
    /getSystemPermissionVersion\(\)/,
    'the permission-catalogue log line must interpolate the live version constant',
  );
  assert.doesNotMatch(
    source,
    /permissions \(v\d+\)/,
    'a hardcoded (vNN) outlived version 36 once already — interpolate, never hardcode',
  );
});
