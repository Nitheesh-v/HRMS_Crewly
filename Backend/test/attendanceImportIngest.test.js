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
  return {
    sessions,
    findOne: async (filter) => sessions.find((row) => matches(row, filter)) || null,
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

const policy = () => ({
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

const makePunchCtx = ({ nowMs }) => {
  const AttendanceModel = makeAttendanceModel();
  const AttendanceEventModel = makeEventModel();
  const deps = {
    AttendanceModel,
    AttendanceEventModel,
    AttendanceLocationModel: { findOne: async () => null },
    WorkModeRequestModel: { findOne: async () => null },
    CompanyModel: { findById: () => ({ select: () => ({ lean: async () => ({ timezone: TZ }) }) }) },
    policyReader: async () => ({ policy: policy(), configured: true, hasActive: true }),
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
