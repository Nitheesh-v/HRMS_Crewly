// Reserved-schema-path hygiene — the guard behind the boot warning
// "`errors` is a reserved schema pathname and may break some functionality."
//
// Mongoose reserves `errors` because Document#errors surfaces validation
// problems (lib/schema.js: ~1310 — the check fires when a path's first piece
// is a reserved name and the schema lacks suppressReservedKeysWarning).
// Exactly one model in this repo legitimately uses `errors` as DATA:
// PayrollPaymentBatch's excluded rows carry machine-readable exclusion reason
// codes that the UI renders. That schema carries the documented opt-out flag,
// with the reasoning in a comment beside it.
//
// This suite pins three things, hermetically (no database — the warnings fire
// at schema compile, i.e. at model registration):
//   1. the registry is really loaded (a sweep over zero models proves nothing);
//   2. registering EVERY model emits NO reserved-path warning — a new model
//      with a reserved path fails here instead of whispering at every boot;
//   3. the suppression flag stays deliberate: exactly one model file carries
//      it. A second occurrence must extend this pin, not copy the flag.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

const testDir = dirname(fileURLToPath(import.meta.url));
const modelsDir = join(testDir, '..', 'src', 'models');

// Listener FIRST, imports after: warnings are emitted while the schemas
// compile, so the net must be up before the fish swim through.
const warnings = [];
process.on('warning', (w) => warnings.push(w));

const modelFiles = readdirSync(modelsDir).sort().filter((f) => f.endsWith('.js'));
for (const file of modelFiles) {
  await import(pathToFileURL(join(modelsDir, file)).href);
}
// Deliveries are asynchronous — give the queue time to drain.
await new Promise((resolve) => setTimeout(resolve, 500));

test('the model registry is really loaded', () => {
  assert.ok(
    mongoose.modelNames().length >= 130,
    `expected the whole registry (>= 130 models), got ${mongoose.modelNames().length} — the sweep below is only as real as its coverage`,
  );
  assert.equal(modelFiles.length >= 130, true, 'expected to scan the real model directory');
});

test('registering every model emits no reserved-schema-path warnings', () => {
  const offenders = warnings
    .map((w) => w.message || '')
    .filter((m) => m.includes('reserved schema pathname'))
    .map((m) => m.split('\n')[0]);
  assert.deepEqual(
    offenders,
    [],
    'a model uses a reserved schema path name. Mongoose reserves these because they collide with Document API surface — declare the data under a free name, or (only with the reasoning documented beside it) pass suppressReservedKeysWarning on that schema and extend the scoped pin below',
  );
});

test('suppressReservedKeysWarning stays a deliberate, scoped exception', async () => {
  const flagged = [];
  for (const file of modelFiles) {
    const source = readFileSync(join(modelsDir, file), 'utf8');
    if (source.includes('suppressReservedKeysWarning')) flagged.push(file);
  }
  assert.deepEqual(
    flagged,
    ['PayrollPaymentBatch.js'],
    'a second model now suppresses the reserved-path warning — extend this pin with its justification instead of letting the flag spread',
  );
});
