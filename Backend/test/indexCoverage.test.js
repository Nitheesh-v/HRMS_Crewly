// ============================================================
//  PHASE 32.5 — INDEX COVERAGE + QUERY SHAPE GUARDS (HERMETIC).
//
//  The campaign verdict stays true FOREVER: hot query paths remain
//  index-served, tenant-first, TTL-bounded — and the queries the
//  catalog describes cannot silently drift in code. Imports the ONE
//  catalog from scripts/index-check.js so tool and tests never
//  diverge. No Mongo connection: schema declarations are ground truth.
// ============================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_index_guard';
process.env.REDIS_ENABLED ||= 'false';

const indexCheck = await import('../scripts/index-check.js');

import mongoose from 'mongoose';

const { HOT_QUERY_CATALOG, evaluateCatalogEntry, loadAllModels, inventoryIndexes } =
  indexCheck;

const indexesOf = (modelName) => mongoose.model(modelName).schema.indexes();

const keySequences = (modelName) =>
  indexesOf(modelName).map(([keys]) => Object.keys(keys));

const hasIndex = (modelName, expectedKeys) =>
  keySequences(modelName).some(
    (keys) =>
      keys.length === expectedKeys.length &&
      expectedKeys.every((key, position) => keys[position] === key),
  );

const optionsFor = (modelName, expectedKeys) =>
  indexesOf(modelName).find(([keys]) => {
    const names = Object.keys(keys);

    return (
      names.length === expectedKeys.length &&
      expectedKeys.every((key, position) => names[position] === key)
    );
  })?.[1];

test.before(async () => {
  const { failures } = await loadAllModels();

  assert.deepEqual(failures, [], 'every model module must load hermetically');
});

// ─────────────────────────────────────────────────────────────
//  1. THE CAMPAIGN VERDICT
// ─────────────────────────────────────────────────────────────

test('campaign verdict: zero GAPs across the hot-query catalog', () => {
  assert.ok(HOT_QUERY_CATALOG.length >= 16, 'catalog must stay populated');

  for (const entry of HOT_QUERY_CATALOG) {
    const result = evaluateCatalogEntry(entry, indexesOf(entry.model));

    assert.notEqual(
      result.verdict,
      'GAP',
      `${entry.id} (${entry.evidence}) lost index coverage: ${result.note}`,
    );

    assert.ok(
      entry.evidence.includes(':'),
      `entry ${entry.id} must cite its query evidence (file:line)`,
    );
  }
});

test('inventory: every collection carries explicit indexes; structure sane', () => {
  const stats = inventoryIndexes();

  assert.equal(stats.zeroIndexModels.length, 0, 'no index-free collections');

  assert.ok(stats.declared >= 500, 'declared index count should stay in campaign range');

  assert.ok(stats.unique >= 90, 'unique constraint count should stay in campaign range');

  assert.ok(stats.ttl >= 10, 'TTL housekeeping indexes present');
});

// ─────────────────────────────────────────────────────────────
//  2. CROWN-JEWEL EXACT PINS (E-class: correctness-critical)
// ─────────────────────────────────────────────────────────────

test('attendance: day-sequence unique + sparse idempotency replay preserved', () => {
  const seqOptions = optionsFor('AttendanceEvent', [
    'companyId',
    'user',
    'date',
    'seq',
  ]);

  assert.ok(seqOptions?.unique, '{companyId,user,date,seq} must stay unique');

  const replayOptions = optionsFor('AttendanceEvent', [
    'companyId',
    'user',
    'requestId',
  ]);

  assert.ok(replayOptions?.unique, 'requestId replay index must stay unique');
  assert.ok(replayOptions?.sparse, 'requestId replay index must stay sparse');

  assert.ok(hasIndex('Attendance', ['companyId', 'user', 'date']));
  assert.ok(hasIndex('Attendance', ['companyId', 'date']));
});

test('payroll: tenant uniques + result version/current semantics preserved', () => {
  assert.ok(optionsFor('PayrollRun', ['companyId', 'month'])?.unique);

  const result = optionsFor('PayrollResult', [
    'companyId',
    'month',
    'employeeId',
    'version',
  ]);

  assert.ok(result?.unique, 'PayrollResult version uniqueness is financial truth');

  assert.ok(hasIndex('PayrollResult', ['companyId', 'month', 'isCurrent']));
  assert.ok(hasIndex('PayrollResult', ['companyId', 'employeeId', 'month']));

  assert.ok(hasIndex('Payslip', ['companyId', 'month', 'status']));
});

test('users/org: login + employee-code + role compounds preserved', () => {
  assert.ok(optionsFor('User', ['email', 'companyId'])?.unique);

  const codeOptions = optionsFor('User', ['companyId', 'employeeCode']);

  assert.ok(codeOptions?.unique);
  assert.ok(codeOptions?.partialFilterExpression, 'employeeCode uniqueness stays partial');

  assert.ok(hasIndex('User', ['companyId', 'status', 'lastLogin']));
});

test('BGV: assignment authorization keys preserved (assignment IS authorization)', () => {
  const assignment = optionsFor('BgvCheckAssignment', [
    'bgvOrder',
    'checkType',
    'activeKey',
  ]);

  assert.ok(assignment?.unique);
  assert.deepEqual(assignment?.partialFilterExpression, { activeKey: 'CURRENT' });

  assert.ok(
    keySequences('BgvCheckAssignment').some(
      (keys) => keys[0] === 'verifier',
    ),
    'verifier-led index must exist — the 32.5 scoped queue read depends on it',
  );
});

test('sessions: unique sessionId + TTL housekeeping preserved', () => {
  assert.ok(optionsFor('SecuritySession', ['sessionId'])?.unique);
  assert.ok(optionsFor('AdminSession', ['sessionId'])?.unique);

  for (const model of ['SecuritySession', 'AdminSession', 'RefreshToken', 'AuditLog']) {
    const ttl = indexesOf(model).some(
      ([keys, options]) =>
        options?.expireAfterSeconds !== undefined &&
        Object.keys(keys).length === 1,
    );

    assert.ok(ttl, `${model} must keep a single-field TTL index`);
  }
});

test('notification reminder dedupe stays unique + partial', () => {
  const options = optionsFor('Notification', ['companyId', 'eventKey']);

  assert.ok(options?.unique);
  assert.deepEqual(options?.partialFilterExpression, {
    eventKey: { $ne: null },
  });
});

// ─────────────────────────────────────────────────────────────
//  3. TENANT-FIRST LAW
// ─────────────────────────────────────────────────────────────

test('tenant-first law: high-volume collections keep companyId-led compounds', () => {
  const highVolume = [
    'AttendanceEvent',
    'AttendanceRegularization',
    'AttendancePayrollSnapshot',
    'Payslip',
    'PayrollRun',
    'PayrollResult',
    'Candidate',
    'BackgroundVerificationCase',
    'BackgroundVerificationCheck',
    'Notification',
    'JobPosting',
  ];

  for (const model of highVolume) {
    const led = keySequences(model).some(
      (keys) => keys.length > 1 && keys[0] === 'companyId',
    );

    assert.ok(led, `${model} must keep a companyId-led compound index`);
  }
});

// ─────────────────────────────────────────────────────────────
//  4. SOURCE-SHAPE PINS — queries cannot drift from the catalog
// ─────────────────────────────────────────────────────────────

test('source pins: cataloged query shapes still exist in code (drift guard)', async () => {
  const read = (relative) =>
    readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

  const auth = await read('src/middlewares/authMiddleware.js');

  assert.match(
    auth,
    /SecuritySession\.findOne\(\{\s*sessionId:/s,
    'protect keeps leading sessionId equality (point-lookup contract)',
  );

  const kiosk = await read('src/middlewares/kioskAuth.js');

  assert.match(kiosk, /AttendanceKiosk\.findOne\(\{\s*_id:/s);

  const eventService = await read('src/services/attendance/attendanceEventService.js');

  assert.match(
    eventService,
    /companyId,\s*user: userId,\s*date:/s,
    'day-event reads stay {companyId,user,date} + seq sort',
  );
  assert.match(
    eventService,
    /requestId: idempotencyKey/,
    'idempotency replay lookup unchanged',
  );

  const analytics = await read('src/services/attendance/attendanceAnalyticsService.js');

  assert.match(
    analytics,
    /isCurrent: true/,
    'analytics snapshot reads keep CURRENT semantics',
  );

  const login = await read('src/controllers/authController.js');

  assert.match(login, /email: normalizedEmail,\s*companyId: company\._id,/s);
});

// ─────────────────────────────────────────────────────────────
//  5. THE 32.5 QUERY CHANGE — scoped + batched verifier queue
// ─────────────────────────────────────────────────────────────

test('32.5 verifier queue: authorization moved INTO the query; batched reads; no table-wide scan', async () => {
  const source = await readFile(
    new URL('../src/services/bgv/bgvAssignmentService.js', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /BgvCheckAssignment\.find\(\{\s*verifier: verifierId,\s*activeKey: 'CURRENT'/s,
    'the queue must query assignments BY verifier (scoped read, index-served)',
  );

  assert.match(source, /defaultLoadOrdersByIds/, 'orders batched via $in');
  assert.match(source, /defaultLoadCompaniesByIds/, 'companies batched via $in');
  assert.match(source, /defaultLoadCasesForOrders/, 'cases batched via $in');
  assert.match(
    source,
    /companyId: \{ \$in: companyIds \}/,
    'batched case read keeps the companyId dimension (tenant law)',
  );

  // The old unbounded shape must be gone from the queue.
  assert.doesNotMatch(
    source,
    /const all = await listAssignments\(\{ orderIds: null \}\);\s*const mine = \(all \|\| \[\]\)\.filter/,
    'table-wide read + in-memory verifier filter must not return',
  );
});

// ─────────────────────────────────────────────────────────────
//  6. TOOL CONTRACT
// ─────────────────────────────────────────────────────────────

test('index-check tool stays hermetic (no connections, no destructive ops)', async () => {
  const source = await readFile(
    new URL('../scripts/index-check.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    source,
    /mongoose\.connect|createConnection|new MongoClient|syncIndexes|dropIndex|dropIndexes/,
    'the auditor is read-only over schema declarations',
  );
});

// ─────────────────────────────────────────────────────────────
//  7. WINDOWS ESM DYNAMIC-IMPORT LAW (32.5 acceptance-defect regression)
//
//  dynamic import() takes a URL — NEVER a bare filesystem path. A
//  Windows absolute path ("C:\...\models\User.js") fails with
//  "Received protocol 'c:'", which used to cascade into
//  models loaded 0/124 + MissingSchemaError on the developer machine.
//  The loader contract is pathToFileURL (node:url): correct on
//  Windows, Linux and macOS. These pins are hermetic and
//  cross-platform — a future refactor cannot reintroduce
//  import(<absolute path>) without failing here.
// ─────────────────────────────────────────────────────────────

test('index-check model loader always produces file: URLs (Windows-safe)', async () => {
  const { toModuleUrl } = indexCheck;

  const { fileURLToPath } = await import('node:url');
  const nodePath = await import('node:path');

  // A path WITH spaces and a hash fragment: naive string concatenation
  // would break here; pathToFileURL percent-encodes correctly.
  const tricky = nodePath.resolve('src/models/some Dir/user model.js');

  const url = new URL(toModuleUrl(tricky));

  assert.equal(url.protocol, 'file:', 'dynamic import target must be a file: URL');

  // Round-trip: the URL must decode back to the EXACT filesystem path.
  assert.equal(fileURLToPath(url), tricky);
});

test('loadAllModels completes the FULL model set with zero failures', async () => {
  const { loaded, failures, total } = await loadAllModels();

  assert.deepEqual(failures, [], 'every model module must import cleanly');
  assert.equal(loaded, total, 'partial model sets must be impossible here');
  assert.ok(total >= 100, 'the intended model catalogue must be present');
});

test('index-check source never passes a bare filesystem path to import()', async () => {
  const source = await readFile(
    new URL('../scripts/index-check.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    source,
    /import\(\s*path\.join\(/,
    'dynamic import() must never receive a bare path — route through toModuleUrl/pathToFileURL',
  );

  assert.match(
    source,
    /pathToFileURL/,
    'the Windows-safe URL builder must remain in use',
  );
});
