// ─────────────────────────────────────────────────────────────
// Phase 35.5 — the attendance CSV import really imports, and a
// row that cannot be imported says WHY.
//
// Two defects behind the report ("Confirm — import 4 rows" then
// "0 imported, 0 skipped, rejected", five blank outcome pills, no
// reason anywhere):
//
//  1. recordEvent refuses an explicit `date` when no session exists
//     for it — correct for a self-service punch, fatal for a CSV of
//     device exports whose whole job is days with no session yet:
//     even the CLOCK_IN row died with "No attendance session for
//     that date", so a confirmed import imported nothing. A trusted
//     IMPORT ingest may now OPEN that session (WEB still cannot).
//
//  2. The AttendanceImport outcome sub-schema declared
//     outcome/reason/occurredAt while the service writes
//     status/message/at, and the model had no `rejectedCount` at
//     all — so Mongoose's strict mode silently dropped every
//     outcome and the reason with it.
//
// Hermetic: the real recordEvent + the real confirmImport run
// against in-memory model fakes; the clock is injected. The schema
// pin compares what the service WRITES with what the model ACCEPTS,
// so this class of drift cannot come back silently.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [eventService, importService, sched, AttendanceImportReal] = await Promise.all([
  import('../src/services/attendance/attendanceEventService.js'),
  import('../src/services/attendance/attendanceImportService.js'),
  import('../src/utils/scheduleEngine.js'),
  import('../src/models/AttendanceImport.js'),
]);

const { recordEvent } = eventService;
const { confirmImport } = importService;
const AttendanceImport = AttendanceImportReal.default;

const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(join(HERE, '..', '..', rel), 'utf8');

const COMPANY = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER_A = '100000000000000000000001';
const BATCH_ID = '600000000000000000000001';
const TZ = 'Asia/Kolkata';
const DAY = '2026-09-16';
const IN_AT = Date.parse('2026-09-16T09:00:00+05:30');

// ── shared in-memory model fakes ─────────────────────────────

const makeAttendanceModel = () => {
  const sessions = [];
  let seq = 1;
  const matches = (row, filter = {}) =>
    Object.entries(filter).every(([key, value]) => {
      if (key === '$or') return value.some((clause) => matches(row, clause));
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        if (value.$in) {
          const actual = row[key] === undefined ? 'null' : String(row[key]);
          return value.$in.map(String).includes(actual);
        }
        if (value.$ne !== undefined) return String(row[key] ?? '') !== String(value.$ne ?? '');
        if (value.$exists !== undefined) return value.$exists ? row[key] !== undefined : row[key] === undefined;
        return true;
      }
      return String(row[key] ?? '') === String(value ?? '');
    });
  // Thenable so both call shapes work: a plain `await findOne(...)` and the
  // engine's `findOne(...).sort({ date: -1 })` open-session lookup.
  const chainable = (value) => ({
    sort: () => chainable(value),
    lean: async () => value,
    then: (onOk, onErr) => Promise.resolve(value).then(onOk, onErr),
  });
  return {
    sessions,
    findOne: (filter) => chainable(sessions.find((row) => matches(row, filter)) || null),
    findOneAndUpdate: async (filter, update, opts = {}) => {
      const row = sessions.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, update.$set || {});
      return opts.new ? row : { ...row };
    },
    create: async (doc) => {
      const dup = sessions.find(
        (row) => String(row.user) === String(doc.user) && String(row.date) === String(doc.date),
      );
      if (dup) {
        const error = new Error('duplicate key');
        error.code = 11000;
        error.keyValue = { companyId: doc.companyId, user: doc.user, date: doc.date };
        throw error;
      }
      const row = { ...doc, _id: `att${seq}`, id: `att${seq}` };
      seq += 1;
      sessions.push(row);
      return row;
    },
  };
};

const makeEventModel = () => {
  const rows = [];
  let seq = 1;
  const chain = (resolve) => {
    const self = {
      sort: () => self,
      select: () => self,
      lean: () => self,
      then: (onOk, onErr) => Promise.resolve().then(resolve).then(onOk, onErr),
    };
    return self;
  };
  return {
    rows,
    findOne: (filter) =>
      chain(() =>
        rows.find((row) =>
          Object.entries(filter).every(([key, value]) => String(row[key] ?? '') === String(value ?? '')),
        ) || null,
      ),
    find: () => chain(() => rows.map((row) => ({ ...row }))),
    create: async (doc) => {
      const row = { ...doc, _id: `evt${seq}`, id: `evt${seq}` };
      seq += 1;
      rows.push(row);
      return row;
    },
  };
};

const policy = (overrides = {}) => ({
  ...overrides,
  version: 3,
  timezone: TZ,
  thresholds: { fullDayMinutes: 480, halfDayMinutes: 240 },
  grace: { lateInMinutes: 15, earlyOutMinutes: 15 },
  breaks: { enabled: true, includeInWorkedTime: false, dailyLimitMinutes: null },
  missingPunch: { keepUnresolved: true, allowRegularization: true, regularizationWindowDays: 7 },
  overtime: {
    trackingEnabled: true,
    minimumExtraMinutes: 30,
    approvalRequired: true,
    weekendEligible: true,
    holidayEligible: false,
  },
  weekendHoliday: { allowWorkOnWeeklyOff: true, allowWorkOnHoliday: true },
  workModes: { office: true, wfh: true, field: true, clientSite: true, businessTravel: true },
});

const engine = () => ({
  resolveShiftForUser: async () => ({ shift: null, schedule: null, source: 'DEFAULT' }),
  resolveScheduleForUser: async () => null,
  getWorkingDaysForUser: async () => ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  getHolidaysForUser: async () => [],
  holidayOnDate: async () => null,
  evaluatePunch: sched.evaluatePunch,
  dayKey: sched.dayKey,
});

const makePunchCtx = ({ nowMs, policy: policyOverride = null }) => {
  const AttendanceModel = makeAttendanceModel();
  const AttendanceEventModel = makeEventModel();
  const deps = {
    AttendanceModel,
    AttendanceEventModel,
    AttendanceLocationModel: { findOne: async () => null },
    // No approved work-mode request exists in this world.
    WorkModeRequestModel: {
      findOne: () => ({
        lean: async () => null,
        then: (onOk, onErr) => Promise.resolve(null).then(onOk, onErr),
      }),
    },
    CompanyModel: { findById: () => ({ select: () => ({ lean: async () => ({ timezone: TZ }) }) }) },
    policyReader: async () => ({
      policy: policyOverride || policy(),
      configured: true,
      hasActive: true,
    }),
    engine: engine(),
    // Payroll-grade schedule resolution is out of scope here; the day is
    // deliberately unresolved so the punch math stays the engine's own.
    resolveScheduleRule: async () => ({ rule: null, scheduleCtx: { status: 'UNRESOLVED' }, shift: null, schedule: null, source: 'DEFAULT' }),
    now: () => new Date(nowMs),
    sleep: async () => {},
  };
  return { deps, AttendanceModel, AttendanceEventModel };
};

// ── 1. the engine may open a backdated session for a trusted IMPORT ──

test('35.5 · an IMPORT clock-in opens the session for the day the row names', async () => {
  const { deps, AttendanceModel, AttendanceEventModel } = makePunchCtx({ nowMs: IN_AT });

  const result = await recordEvent({
    companyId: COMPANY,
    userId: USER_A,
    action: 'CLOCK_IN',
    workMode: 'OFFICE',
    date: DAY,
    idempotencyKey: 'import:batch:2',
    ingest: { source: 'IMPORT', provenance: { importBatchId: BATCH_ID, sourceReference: 'dev-1' } },
    deps,
  });

  assert.equal(AttendanceModel.sessions.length, 1, 'the session is created');
  assert.equal(AttendanceModel.sessions[0].date, DAY, 'on the day the row named — not the wall-clock day');
  assert.equal(AttendanceModel.sessions[0].punchIn.getTime(), IN_AT);

  assert.equal(AttendanceEventModel.rows.length, 1);
  const fact = AttendanceEventModel.rows[0];
  assert.equal(fact.type, 'CLOCK_IN');
  assert.equal(fact.date, DAY, 'the fact is stamped with the imported day');
  assert.equal(fact.at.getTime(), IN_AT, 'the fact carries the row instant, not "now"');
  assert.equal(fact.source, 'IMPORT');
  assert.equal(String(fact.provenance.importBatchId), BATCH_ID);
  assert.equal(fact.provenance.sourceReference, 'dev-1');
  assert.equal(fact.requestId, 'import:batch:2');
  assert.ok(result && typeof result === 'object', 'a snapshot comes back like any other punch');
});

test('35.5 · a self-service punch still cannot fabricate a backdated day', async () => {
  const { deps, AttendanceModel, AttendanceEventModel } = makePunchCtx({ nowMs: IN_AT });

  await assert.rejects(
    recordEvent({
      companyId: COMPANY,
      userId: USER_A,
      action: 'CLOCK_IN',
      workMode: 'OFFICE',
      date: DAY, // no ingest context → behaves exactly as before
      deps,
    }),
    /No attendance session for that date/,
  );

  assert.equal(AttendanceModel.sessions.length, 0, 'nothing was written');
  assert.equal(AttendanceEventModel.rows.length, 0);
});

test('35.5 · only a CLOCK_IN may open a session, even for IMPORT', async () => {
  const { deps, AttendanceModel } = makePunchCtx({ nowMs: IN_AT });

  await assert.rejects(
    recordEvent({
      companyId: COMPANY,
      userId: USER_A,
      action: 'CLOCK_OUT',
      date: DAY,
      ingest: { source: 'IMPORT', provenance: { importBatchId: BATCH_ID } },
      deps,
    }),
    /No attendance session for that date/,
  );

  assert.equal(AttendanceModel.sessions.length, 0, 'a clock-out never invents the day it closes');
});

// ── 1b. live-punch gates must not apply to an imported row ──

// A company with geofencing ON and WFH needing approval: the exact policy the
// reporter has (their 156 rows were all refused with the geofence message).
const strictPolicy = () =>
  policy({
    locationEnforcement: 'REQUIRED',
    workModes: { office: true, wfh: true, field: false, clientSite: false, businessTravel: false },
    workModeApproval: { wfh: true, field: true, clientSite: true, businessTravel: true },
  });

test('35.8 · an imported OFFICE clock-in is not stopped by a REQUIRED geofence', async () => {
  const { deps, AttendanceModel, AttendanceEventModel } = makePunchCtx({
    nowMs: IN_AT,
    policy: strictPolicy(),
  });

  await recordEvent({
    companyId: COMPANY,
    userId: USER_A,
    action: 'CLOCK_IN',
    workMode: 'OFFICE',
    date: DAY,
    idempotencyKey: 'import:batch:2',
    ingest: { source: 'IMPORT', provenance: { importBatchId: BATCH_ID } },
    deps,
  });

  assert.equal(AttendanceModel.sessions.length, 1, 'the row is imported, not refused');
  const fact = AttendanceEventModel.rows[0];
  assert.equal(fact.source, 'IMPORT');
  assert.ok(
    !('locationVerification' in fact),
    'and the fact claims NO verification — a file has no position',
  );
  assert.ok(!('authorization' in fact), 'nor a work-mode approval it never had');
});

test('35.8 · an imported WFH clock-in is not stopped by the approval gate', async () => {
  const { deps, AttendanceModel, AttendanceEventModel } = makePunchCtx({
    nowMs: IN_AT,
    policy: strictPolicy(),
  });

  await recordEvent({
    companyId: COMPANY,
    userId: USER_A,
    action: 'CLOCK_IN',
    workMode: 'WFH',
    date: DAY,
    idempotencyKey: 'import:batch:3',
    ingest: { source: 'IMPORT', provenance: { importBatchId: BATCH_ID } },
    deps,
  });

  assert.equal(AttendanceModel.sessions.length, 1);
  assert.equal(AttendanceEventModel.rows[0].workMode, 'WFH');
  assert.ok(!('authorization' in AttendanceEventModel.rows[0]));
});

test('35.8 · the live gates are UNTOUCHED for every self-service punch', async () => {
  // OFFICE without a position, geofence REQUIRED.
  const office = makePunchCtx({ nowMs: IN_AT, policy: strictPolicy() });
  await assert.rejects(
    recordEvent({
      companyId: COMPANY,
      userId: USER_A,
      action: 'CLOCK_IN',
      workMode: 'OFFICE',
      deps: office.deps,
    }),
    /Attendance location verification is required by company policy/,
  );
  assert.equal(office.AttendanceModel.sessions.length, 0, 'nothing was written');
  assert.equal(office.AttendanceEventModel.rows.length, 0);

  // WFH with the same policy, no approved request.
  const wfh = makePunchCtx({ nowMs: IN_AT, policy: strictPolicy() });
  await assert.rejects(
    recordEvent({
      companyId: COMPANY,
      userId: USER_A,
      action: 'CLOCK_IN',
      workMode: 'WFH',
      deps: wfh.deps,
    }),
    /request required for/,
  );
  assert.equal(wfh.AttendanceModel.sessions.length, 0);
});

test('35.8 · a punch that only CLAIMS to be an import is not exempt', async () => {
  // The ingest context is server-assembled; a WEB punch cannot smuggle it in
  // through the body, and any other source is still governed by the gates.
  const { deps, AttendanceModel } = makePunchCtx({ nowMs: IN_AT, policy: strictPolicy() });

  await assert.rejects(
    recordEvent({
      companyId: COMPANY,
      userId: USER_A,
      action: 'CLOCK_IN',
      workMode: 'OFFICE',
      ingest: { source: 'WEB' },
      deps,
    }),
    /Invalid ingest context|required by company policy/,
  );
  assert.equal(AttendanceModel.sessions.length, 0);
});

// ── 2. what the service writes must be what the model stores ──

const GOOD_CSV = [
  'employeeCode,timestamp,eventType,workMode,sourceReference',
  `EMP001,2026-09-16T09:00:00+05:30,CLOCK_IN,OFFICE,dev-1`,
  `EMP001,2026-09-16T18:00:00+05:30,CLOCK_OUT,,dev-2`,
].join('\n');

const buildImportWorld = ({ failLines = new Set() } = {}) => {
  const batches = new Map();
  const written = { created: [], sets: [], outcomes: [] };
  const chain = (result) => {
    const self = {
      select: () => self,
      collation: () => self,
      sort: () => self,
      limit: () => self,
      lean: () => Promise.resolve(result),
    };
    return self;
  };
  let seq = 0;

  const BatchModel = {
    create: async (doc) => {
      written.created.push(doc);
      seq += 1;
      const batch = {
        _id: `60000000000000000000000${seq}`.slice(0, 24),
        ...doc,
        importedCount: 0,
        skippedCount: 0,
        rejectedCount: 0,
        outcomes: [],
      };
      batches.set(String(batch._id), batch);
      return { ...batch, toObject: () => ({ ...batch }) };
    },
    findOne: (filter = {}) => {
      const found = [...batches.values()].find((batch) => {
        if (filter.companyId && String(batch.companyId) !== String(filter.companyId)) return false;
        if (filter.fingerprint && batch.fingerprint !== filter.fingerprint) return false;
        if (filter._id && String(batch._id) !== String(filter._id)) return false;
        if (filter.status && batch.status !== filter.status) return false;
        return true;
      });
      return chain(found ? { ...found } : null);
    },
    findOneAndUpdate: (filter, update) => {
      const found = [...batches.values()].find((batch) => {
        if (filter._id && String(batch._id) !== String(filter._id)) return false;
        if (filter.status && batch.status !== filter.status) return false;
        return true;
      });
      if (!found) return chain(null);
      written.sets.push(update.$set || {});
      Object.assign(found, update.$set || {});
      (update.$set?.outcomes || []).forEach((outcome) => written.outcomes.push(outcome));
      return chain({ ...found });
    },
  };

  const deps = {
    BatchModel,
    UserModel: {
      find: () =>
        chain([
          { _id: USER_A, companyId: COMPANY, name: 'Asha Verma', employeeCode: 'EMP001' },
        ]),
    },
    EventModel: { find: () => chain([]), findOne: () => chain(null) },
    AttendanceModel: { find: () => chain([]), countDocuments: async () => 0 },
    PeriodModel: { find: () => chain([]), findOne: () => chain(null) },
    getCurrentPolicy: async () => ({ policy: policy() }),
    recordEvent: async (args) => {
      const line = Number(String(args.idempotencyKey || '').split(':').pop());
      if (failLines.has(line)) {
        const error = new Error('state changed since preview');
        error.statusCode = 409;
        throw error;
      }
      return { event: { id: `evt${line}` }, replayed: false };
    },
    now: () => Date.parse('2026-09-17T12:00:00+05:30'),
    audit: async () => null,
  };

  return { deps, written };
};

test('35.5 · every field the import service writes exists in the model (no silent drops)', async () => {
  const { deps, written } = buildImportWorld({ failLines: new Set([2]) });

  await confirmImport({ companyId: COMPANY, content: GOOD_CSV, actor: { _id: USER_A }, deps });

  const batchPaths = new Set(Object.keys(AttendanceImport.schema.paths));
  const outcomePaths = new Set(Object.keys(AttendanceImport.schema.path('outcomes').schema.paths));

  // Fields the service sets on the batch document.
  const batchWrites = new Set(written.sets.flatMap((set) => Object.keys(set)));
  written.created.forEach((doc) => Object.keys(doc).forEach((key) => batchWrites.add(key)));
  batchWrites.delete('outcomes');

  const droppedBatch = [...batchWrites].filter((key) => !batchPaths.has(key));
  assert.deepEqual(droppedBatch, [], `the model would silently drop: ${droppedBatch.join(', ')}`);

  // Fields the service writes per row — the ONLY record of why a row failed.
  const outcomeWrites = new Set(written.outcomes.flatMap((outcome) => Object.keys(outcome)));
  const droppedOutcomes = [...outcomeWrites].filter((key) => !outcomePaths.has(key));
  assert.deepEqual(droppedOutcomes, [], `the schema would silently drop: ${droppedOutcomes.join(', ')}`);

  assert.ok(outcomePaths.has('status'), 'the page renders outcome.status');
  assert.ok(outcomePaths.has('message'), 'the page renders outcome.message');
  assert.ok(batchPaths.has('rejectedCount'), 'the page renders batch.rejectedCount');
});

test('35.5 · a rejected row reaches the page with its reason, and the counts add up', async () => {
  const { deps } = buildImportWorld({ failLines: new Set([2]) });

  const result = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps });

  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.importedCount, 1);
  assert.equal(result.rejectedCount, 1, 'the number the page shows must exist');

  const rejected = result.outcomes.find((outcome) => outcome.status === 'REJECTED');
  assert.ok(rejected, 'the failed row keeps a status');
  assert.equal(rejected.line, 2);
  assert.match(rejected.message, /state changed since preview/, 'and the reason the person can act on');

  const imported = result.outcomes.find((outcome) => outcome.status === 'IMPORTED');
  assert.equal(imported.line, 3, 'the row that did import is the clock-out');
  assert.equal(imported.eventType, 'CLOCK_OUT');
  assert.ok(imported.at, 'an imported outcome carries the event instant');
});

// ── 3. a batch that recorded nothing must not lock its file forever ──

test('35.6 · a confirm that imported nothing can be retried with the SAME file', async () => {
  const { deps } = buildImportWorld({ failLines: new Set([2, 3]) });

  const first = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps });
  assert.equal(first.importedCount, 0, 'the world refuses both rows');
  assert.equal(first.rejectedCount, 2);
  assert.equal(first.duplicate, false);

  // Same file (same fingerprint), now that the world accepts the rows.
  deps.recordEvent = async () => ({ replayed: false });
  const retry = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps });

  assert.equal(retry.duplicate, false, 'nothing had landed, so this is not a replay');
  assert.equal(retry.id, first.id, 'the retry happens IN PLACE — one history row, no duplicate batch');
  assert.equal(retry.status, 'CONFIRMED');
  assert.equal(retry.importedCount, 2, 'the data finally lands');
  assert.equal(retry.rejectedCount, 0, 'and the stale rejection counts are replaced');
  assert.equal(retry.outcomes.length, 2, 'outcomes are rewritten, not appended');
  assert.ok(retry.outcomes.every((outcome) => outcome.status === 'IMPORTED'));
});

test('35.6 · an import that DID land stays final and replays its stored result', async () => {
  const { deps } = buildImportWorld();
  const first = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps });
  assert.equal(first.importedCount, 2);

  const callsBefore = [];
  const spy = {
    ...deps,
    recordEvent: async (args) => {
      callsBefore.push(args);
      return { replayed: false };
    },
  };
  const second = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps: spy });

  assert.equal(second.duplicate, true, 'a real replay keeps answering "already imported"');
  assert.equal(second.id, first.id);
  assert.equal(second.importedCount, 2);
  assert.equal(callsBefore.length, 0, 'and it never re-runs the ingest');
});

test('35.6 · a batch that only found already-recorded rows is final too', async () => {
  const { deps } = buildImportWorld();
  // The backstop reads with .select('_id').lean() — answer it in that shape.
  deps.EventModel.findOne = () => ({ select: () => ({ lean: async () => ({ _id: 'evt-existing' }) }) });

  const first = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps });
  assert.equal(first.importedCount, 0);
  assert.equal(first.skippedCount, 2, 'every row was already in the ledger');

  const second = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps });
  assert.equal(second.duplicate, true, 'skippable rows are a completed import, not a failure');
});

test('35.6 · the retry edge is narrow and must be given evidence', async () => {
  const { canTransitionImport } = await import('../src/services/attendance/attendanceImportRules.js');

  // The documented state machine is unchanged when the counts are not known.
  assert.equal(canTransitionImport('DRAFT', 'CONFIRMING'), true);
  assert.equal(canTransitionImport('CONFIRMED', 'CONFIRMING'), false);
  assert.equal(canTransitionImport('CONFIRMED', 'DRAFT'), false);
  assert.equal(canTransitionImport('FAILED', 'CONFIRMING'), false);

  // Nothing landed → the file stays importable.
  assert.equal(
    canTransitionImport('CONFIRMED', 'CONFIRMING', { importedCount: 0, skippedCount: 0 }),
    true,
  );
  // Anything recorded → final.
  assert.equal(
    canTransitionImport('CONFIRMED', 'CONFIRMING', { importedCount: 1, skippedCount: 0 }),
    false,
  );
  assert.equal(
    canTransitionImport('CONFIRMED', 'CONFIRMING', { importedCount: 0, skippedCount: 1 }),
    false,
  );
  // Half-answered evidence is refused: no accidental retries.
  assert.equal(canTransitionImport('CONFIRMED', 'CONFIRMING', { importedCount: 0 }), false);
  assert.equal(canTransitionImport('CONFIRMED', 'CONFIRMING', {}), false);
});

// ── 3b. a large import runs in chunks and can never wedge ──

// A file whose rows are all valid, with no existing history: the import has
// to CREATE every session, which is the expensive shape the reporter hit.
const BULK_CSV = [
  'employeeCode,timestamp,eventType,workMode,sourceReference',
  ...[2, 3, 4].flatMap((day) => {
    const date = `2026-08-0${day}`;
    return [
      `EMP001,${date}T09:00:00+05:30,CLOCK_IN,OFFICE,d${day}a`,
      `EMP001,${date}T18:00:00+05:30,CLOCK_OUT,,d${day}b`,
    ];
  }),
].join('\n');

test('35.7 · a chunk returns inside its budget and says how far it got', async () => {
  const { deps } = buildImportWorld();
  // 0ms budget → exactly one valid row per call (deterministic chunking).
  const first = await confirmImport({ companyId: COMPANY, content: BULK_CSV, deps, budgetMs: 0 });

  assert.equal(first.done, false, 'a chunked import is NOT finished after one call');
  assert.equal(first.status, 'CONFIRMING', 'and it says so, instead of pretending to be complete');
  assert.equal(first.processedCount, 1);
  assert.equal(first.totalCount, 6);
  assert.equal(first.remainingCount, 5);
  assert.equal(first.importedCount, 1, 'progress is persisted, not held in the request');
});

test('35.7 · continuing finishes the import, and no row is ever written twice', async () => {
  const { deps } = buildImportWorld();
  const seen = [];
  const spy = {
    ...deps,
    recordEvent: async (args) => {
      seen.push(args.idempotencyKey);
      return deps.recordEvent(args);
    },
  };

  let data = await confirmImport({ companyId: COMPANY, content: BULK_CSV, deps: spy, budgetMs: 0 });
  let calls = 1;
  while (!data.done && calls < 20) {
    data = await confirmImport({ companyId: COMPANY, content: BULK_CSV, deps: spy, budgetMs: 0 });
    calls += 1;
  }

  assert.ok(calls > 1, 'a 6-row file at one row per call needs several chunks');
  assert.ok(calls <= 7, `and not more than the rows: ${calls}`);
  assert.equal(data.done, true);
  assert.equal(data.status, 'CONFIRMED');
  assert.equal(data.importedCount, 6);
  assert.equal(data.rejectedCount, 0);
  assert.equal(data.processedCount, 6);
  assert.equal(data.outcomes.length, 6);
  assert.deepEqual(
    [...new Set(seen)].length,
    seen.length,
    'every row keeps ONE idempotency key — a re-processed row is a replay, never a duplicate',
  );
});

test('35.7 · an interrupted batch (CONFIRMING) is CONTINUED, never refused', async () => {
  const { deps } = buildImportWorld();
  const first = await confirmImport({ companyId: COMPANY, content: BULK_CSV, deps, budgetMs: 0 });
  assert.equal(first.status, 'CONFIRMING');

  // The request that started it is gone (timeout / closed tab). The next
  // confirm must pick the SAME batch up — this was the reported dead end.
  const second = await confirmImport({ companyId: COMPANY, content: BULK_CSV, deps, budgetMs: 0 });
  assert.equal(second.id, first.id, 'the same history row is continued in place');
  assert.equal(second.processedCount, 2, 'and it resumes where the stored outcomes ended');
  assert.equal(second.importedCount, 2);
  assert.equal(second.duplicate, false);
});

test('35.7 · the continuation edge needs explicit evidence', async () => {
  const { canTransitionImport } = await import('../src/services/attendance/attendanceImportRules.js');

  assert.equal(canTransitionImport('CONFIRMING', 'CONFIRMING'), false, 'no evidence → refused');
  assert.equal(canTransitionImport('CONFIRMING', 'CONFIRMING', {}), false);
  assert.equal(canTransitionImport('CONFIRMING', 'CONFIRMING', { continuation: true }), true);
  // The rest of the machine is untouched.
  assert.equal(canTransitionImport('CONFIRMING', 'CONFIRMED'), true);
  assert.equal(canTransitionImport('DRAFT', 'CONFIRMED'), false);
  assert.equal(canTransitionImport('FAILED', 'CONFIRMING'), false);
});

test('35.7 · a run that finished having recorded nothing is retried from scratch', async () => {
  const { deps } = buildImportWorld();
  // Every row is refused by the world, so the batch FINISHES with nothing
  // recorded — the 35.6 retry case, reached through chunking.
  const refused = { ...deps, recordEvent: async () => { throw new Error('engine refused'); } };
  const first = await confirmImport({ companyId: COMPANY, content: BULK_CSV, deps: refused, budgetMs: 60000 });
  assert.equal(first.done, true, 'all six rows were answered (as refusals)');
  assert.equal(first.status, 'CONFIRMED');
  assert.equal(first.importedCount, 0);
  assert.equal(first.rejectedCount, 6);

  // Now the world accepts the rows: the finished-but-empty batch must be
  // retried from scratch — stale refusals are NOT progress.
  const retry = await confirmImport({ companyId: COMPANY, content: BULK_CSV, deps, budgetMs: 60000 });
  assert.equal(retry.done, true);
  assert.equal(retry.duplicate, false);
  assert.equal(retry.importedCount, 6, 'the stale refusals are replaced by real imports');
  assert.equal(retry.rejectedCount, 0);
  assert.equal(retry.outcomes.length, 6, 'outcomes are rewritten, not appended');
});

test('35.7 · a run that recorded SOMETHING replays instead of re-importing', async () => {
  const { deps } = buildImportWorld();
  // The 5th row is refused by the engine; the rest land.
  const refused = {
    ...deps,
    recordEvent: async (args) => {
      if (String(args.idempotencyKey).endsWith(':5')) throw new Error('engine refused');
      return deps.recordEvent(args);
    },
  };

  const first = await confirmImport({ companyId: COMPANY, content: BULK_CSV, deps: refused, budgetMs: 60000 });
  assert.equal(first.importedCount, 5);
  assert.equal(first.rejectedCount, 1);

  const again = await confirmImport({ companyId: COMPANY, content: BULK_CSV, deps, budgetMs: 60000 });
  assert.equal(again.duplicate, true, 'a completed import is final — replay, never re-import');
  assert.equal(again.importedCount, 5);
});

// ── 3. the page must not lie about a successful import ──

test('35.5 · the page reports success as success (and old rows honestly)', () => {
  const page = readSource('Frontend/src/pages/attendance/AttendanceImportPage.jsx');

  assert.match(page, /notify\.info\('Preview ready/, 'a ready preview is not an error');
  assert.match(page, /notify\.success\(/, 'a successful import reports success');
  assert.doesNotMatch(
    page,
    /notify\.error\(\s*\n?\s*res\.data\?\.duplicate/,
    'the import result must not be reported through the error channel',
  );
  assert.match(page, /const outcomeLabel = \(status\) => status \|\| 'UNKNOWN'/);
  assert.match(page, /\{outcomeLabel\(outcome\.status\)\}/, 'no blank outcome pill, ever');
  // 35.6 — a count that was never stored must still print as a number.
  assert.match(page, /\?\? 0\} skipped,\{' '\}/);
  assert.match(page, /\{batch\.rejectedCount \|\| 0\} rejected/);

  // 35.7 — the page must drive the chunks to completion and show progress.
  assert.match(page, /const runConfirmChunks = async \(\) => \{/);
  assert.match(page, /if \(data\?\.done \|\| data\?\.status !== 'CONFIRMING'\) return data;/);
  assert.match(page, /setProgress\(\{/);
  assert.match(page, /Importing… \$\{progress\.processed\}\/\$\{progress\.total\}/);
});

// ── 4. the import service keeps passing the planned session day ──

test('35.5 · the adapter still names the session day per row', async () => {
  const { deps } = buildImportWorld();
  const calls = [];
  const capturing = {
    ...deps,
    recordEvent: async (args) => {
      calls.push(args);
      return { replayed: false };
    },
  };

  await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps: capturing });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].action, 'CLOCK_IN');
  assert.equal(calls[0].date, '2026-09-16', 'the engine opens THIS day for a backdated clock-in');
  assert.equal(calls[0].ingest.source, 'IMPORT');
  assert.equal(calls[1].action, 'CLOCK_OUT');
  assert.equal(calls[1].date, '2026-09-16');
});
