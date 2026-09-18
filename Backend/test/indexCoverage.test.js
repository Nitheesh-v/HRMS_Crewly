// ============================================================
//  PHASE 32.5 — INDEX COVERAGE GUARDS (HERMETIC).
//
//  The 32.5 campaign verdict: hot-query paths stay index-served
//  FOREVER. This suite imports the ONE catalog from
//  scripts/index-check.js (tool and test can never drift) and pins:
//
//   1. no catalog entry may become a GAP
//   2. exact key sequences for the crown-jewel indexes
//   3. tenant-first law: high-volume collections lead with companyId
//   4. TTL housekeeping indexes exist
//   5. source-shape pins: the queries the catalog describes still
//      exist in code (query ↔ index contract cannot rot silently)
//
//  No Mongo connection: schema declarations are the ground truth
//  (the same declarations MongoDB builds at startup).
// ============================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_index_guard';
process.env.REDIS_ENABLED ||= 'false';

const indexCheck = await import('../scripts/index-check.js');

import mongoose from 'mongoose';

const { HOT_QUERY_CATALOG, evaluateCatalogEntry, loadAllModels } = indexCheck;

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
//  1. THE CAMPAIGN VERDICT — no hot query may lose its index
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

    assert.ok(entry.evidence.includes(':') || entry.evidence.includes('('),
      `entry ${entry.id} must cite its query evidence`);
  }
});

test('catalog covers the per-request hot path (auth ×4, kiosk)', () => {
  const ids = HOT_QUERY_CATALOG.map((entry) => entry.id);

  for (const expected of [
    'protect session validation',
    'refresh-token rotation',
    'super admin session validation',
    'kiosk station authentication',
  ]) {
    assert.ok(ids.includes(expected), `catalog must pin "${expected}"`);
  }
});

// ─────────────────────────────────────────────────────────────
//  2. CROWN-JEWEL EXACT PINS
// ─────────────────────────────────────────────────────────────

test('SecuritySession: unique sessionId + user/company compound', () => {
  const sessionOptions = optionsFor('SecuritySession', ['sessionId']);

  assert.ok(sessionOptions?.unique, 'sessionId must be unique-indexed');

  assert.ok(
    hasIndex('SecuritySession', ['user', 'companyId', 'revokedAt', 'expiresAt']),
    'user/company/revoked/expires compound must exist',
  );
});

test('AdminSession: unique sessionId', () => {
  assert.ok(optionsFor('AdminSession', ['sessionId'])?.unique);
});

test('AttendanceEvent: day-sequence unique + idempotent replay + open-session', () => {
  const seqOptions = optionsFor('AttendanceEvent', [
    'companyId',
    'user',
    'date',
    'seq',
  ]);

  assert.ok(seqOptions?.unique, '{companyId,user,date,seq} must be unique');

  const replayOptions = optionsFor('AttendanceEvent', [
    'companyId',
    'user',
    'requestId',
  ]);

  assert.ok(replayOptions?.unique, 'replay index must be unique');
  assert.ok(replayOptions?.sparse, 'replay index must be sparse');

  assert.ok(hasIndex('AttendanceEvent', ['companyId', 'user', 'at']));
});

test('Payroll + payslip tenant compounds', () => {
  assert.ok(optionsFor('PayrollRun', ['companyId', 'month'])?.unique);

  assert.ok(hasIndex('Payslip', ['companyId', 'month', 'status']));

  assert.ok(
    optionsFor('Payslip', ['companyId', 'employeeId', 'month'])?.unique,
  );
});

test('User login: unique {email, companyId}', () => {
  assert.ok(optionsFor('User', ['email', 'companyId'])?.unique);
});

test('BGV case polling + checks + document requirements', () => {
  assert.ok(
    hasIndex('BackgroundVerificationCase', [
      'companyId',
      'polling.status',
      'polling.nextPollAt',
    ]),
  );

  assert.ok(
    optionsFor('BackgroundVerificationCheck', [
      'companyId',
      'case',
      'code',
    ])?.unique,
  );

  assert.ok(
    optionsFor('CandidateDocumentRequirement', [
      'companyId',
      'preOnboarding',
      'code',
    ])?.unique,
  );
});

test('Notification reminder dedupe stays unique + partial', () => {
  const options = optionsFor('Notification', ['companyId', 'eventKey']);

  assert.ok(options?.unique);
  assert.deepEqual(options?.partialFilterExpression, {
    eventKey: { $ne: null },
  });
});

// ─────────────────────────────────────────────────────────────
//  3. TENANT-FIRST LAW — high-volume collections lead with companyId
// ─────────────────────────────────────────────────────────────

test('tenant-first law: every high-volume collection has a companyId-led compound', () => {
  const highVolume = [
    'AttendanceEvent',
    'AttendanceRegularization',
    'Payslip',
    'PayrollRun',
    'Candidate',
    'BackgroundVerificationCase',
    'BackgroundVerificationCheck',
    'CandidateDocumentRequirement',
    'Notification',
  ];

  for (const model of highVolume) {
    const led = keySequences(model).some(
      (keys) => keys.length > 1 && keys[0] === 'companyId',
    );

    assert.ok(led, `${model} must keep a companyId-led compound index`);
  }
});

// ─────────────────────────────────────────────────────────────
//  4. TTL HOUSEKEEPING
// ─────────────────────────────────────────────────────────────

test('TTL housekeeping: session/token/audit expiry indexes exist', () => {
  for (const model of [
    'SecuritySession',
    'AdminSession',
    'RefreshToken',
    'PasswordResetToken',
    'PlatformToken',
    'AuditLog',
  ]) {
    const ttl = indexesOf(model).some(
      ([keys, options]) =>
        options?.expireAfterSeconds !== undefined &&
        Object.keys(keys).length === 1,
    );

    assert.ok(ttl, `${model} must keep a single-field TTL index`);
  }
});

// ─────────────────────────────────────────────────────────────
//  5. SOURCE-SHAPE PINS — queries cannot drift from the catalog
// ─────────────────────────────────────────────────────────────

test('source pins: cataloged queries still exist in code (drift guard)', async () => {
  const read = (relative) =>
    readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

  const auth = await read('src/middlewares/authMiddleware.js');

  assert.match(
    auth,
    /SecuritySession\.findOne\(\{\s*sessionId:/s,
    'protect must keep leading sessionId equality (point-lookup contract)',
  );

  const kiosk = await read('src/middlewares/kioskAuth.js');

  assert.match(kiosk, /AttendanceKiosk\.findOne\(\{\s*_id:/s);

  const tokenService = await read('src/utils/tokenService.js');

  assert.match(tokenService, /user: user\._id,\s*companyId: user\.companyId,\s*sessionId,/s);

  const lifecycle = await read('src/utils/subscriptionLifecycle.js');

  assert.match(
    lifecycle,
    /\$nin:/s,
    'subscription sweep $nin is the DOCUMENTED tiny-collection verdict — if this query changes, update catalog entry',
  );

  const login = await read('src/controllers/authController.js');

  assert.match(login, /email: normalizedEmail,\s*companyId: company\._id,/s);
});

// ─────────────────────────────────────────────────────────────
//  6. TOOL CONTRACT — the auditor stays hermetic
// ─────────────────────────────────────────────────────────────

test('index-check tool never opens a database connection', async () => {
  const source = await readFile(
    new URL('../scripts/index-check.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    source,
    /mongoose\.connect|createConnection|new MongoClient/,
    'the auditor must stay connection-free (schema ground truth only)',
  );
});
