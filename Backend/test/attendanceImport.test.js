// ─────────────────────────────────────────────────────────────
// Phase 31.14 — CSV attendance import (preview → confirm).
//
// Hermetic: validation + confirm run for REAL with every Mongo
// collaborator an in-memory fake; recordEvent is a capturing stub
// (its own suite owns engine semantics); the clock is fixed.
// The pure CSV parser, fingerprint, window, session planner and
// template builder are tested directly.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IMPORT_EVENT_TYPES,
  IMPORT_STATUS,
  IMPORT_TEMPLATE_FILENAME,
  IMPORT_TEMPLATE_HEADER,
  MAX_IMPORT_ROWS,
  buildImportTemplate,
  canTransitionImport,
  fingerprintImportContent,
  isWithinImportWindow,
  monthOfInstantInZone,
  parseAttendanceImportCsv,
  parseZonedTimestamp,
  planImportSessions,
} from '../src/services/attendance/attendanceImportRules.js';
import {
  confirmImport,
  getImport,
  listImports,
  previewImport,
} from '../src/services/attendance/attendanceImportService.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

const COMPANY = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const U_ASHA = '100000000000000000000001';
const U_RAVI = '100000000000000000000002';
const NOW = Date.parse('2026-09-16T12:00:00+05:30');
const TZ = 'Asia/Kolkata';

const chain = (result) => {
  const self = {
    select: () => self,
    populate: () => self,
    collation: () => self,
    sort: () => self,
    limit: () => self,
    lean: () => Promise.resolve(result),
  };
  return self;
};

const GOOD_CSV = [
  'employeeCode,timestamp,eventType,workMode,sourceReference',
  'EMP001,2026-09-14T09:00:00+05:30,CLOCK_IN,OFFICE,dev-1',
  'EMP001,2026-09-14T18:00:00+05:30,CLOCK_OUT,,dev-2',
  'EMP002,2026-09-14T09:30:00+05:30,CLOCK_IN,,dev-3',
  'EMP002,2026-09-14T18:30:00+05:30,CLOCK_OUT,,dev-4',
].join('\n');

const buildWorld = ({ existing = [], openSessions = [], periods = [], failLines = new Set() } = {}) => {
  const batches = new Map();
  const audits = [];
  const recorded = [];
  let seq = 0;

  const users = [
    { _id: U_ASHA, companyId: COMPANY, name: 'Asha Verma', employeeCode: 'EMP001' },
    { _id: U_RAVI, companyId: COMPANY, name: 'Ravi Kumar', employeeCode: 'EMP002' },
  ];

  const BatchModel = {
    create: async (doc) => {
      for (const existing of batches.values()) {
        if (String(existing.companyId) === String(doc.companyId) && existing.fingerprint === doc.fingerprint) {
          const error = new Error('duplicate');
          error.code = 11000;
          throw error;
        }
      }
      seq += 1;
      const batch = {
        _id: `6000000000000000000000${String(seq).padStart(2, '0')}`.slice(0, 24),
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
      const found = [...batches.values()].find((b) => {
        if (filter.companyId && String(b.companyId) !== String(filter.companyId)) return false;
        if (filter.fingerprint && b.fingerprint !== filter.fingerprint) return false;
        if (filter._id && String(b._id) !== String(filter._id)) return false;
        if (filter.status && b.status !== filter.status) return false;
        return true;
      });
      return chain(found ? { ...found } : null);
    },
    findOneAndUpdate: (filter, update) => {
      const found = [...batches.values()].find((b) => {
        if (filter._id && String(b._id) !== String(filter._id)) return false;
        if (filter.status && b.status !== filter.status) return false;
        return true;
      });
      if (!found) return chain(null);
      Object.assign(found, update.$set || {});
      return chain({ ...found });
    },
    find: (filter = {}) => chain(
      [...batches.values()]
        .filter((b) => !filter.companyId || String(b.companyId) === String(filter.companyId))
        .map((b) => ({ ...b }))
    ),
  };

  const deps = {
    BatchModel,
    UserModel: {
      find: (filter = {}) => {
        const wanted = (filter.employeeCode?.$in || []).map((c) => String(c).toUpperCase());
        return chain(users.filter((u) => wanted.includes(u.employeeCode.toUpperCase())));
      },
    },
    EventModel: {
      find: () => chain(existing.map((ev) => ({ ...ev }))),
      findOne: () => chain(null),
    },
    AttendanceModel: { find: () => chain(openSessions.map((s) => ({ ...s }))) },
    PeriodModel: {
      find: (filter = {}) => {
        const wanted = filter.month?.$in || [];
        return chain(periods.filter((p) => wanted.includes(p.month)).map((p) => ({ ...p })));
      },
      findOne: () => chain(null),
    },
    getCurrentPolicy: async () => ({ policy: { timezone: TZ, workModes: { office: true } } }),
    recordEvent: async (args) => {
      recorded.push(args);
      const line = Number(String(args.idempotencyKey || '').split(':').pop());
      if (failLines.has(line)) {
        const error = new Error('state changed since preview');
        error.statusCode = 409;
        throw error;
      }
      return { event: { id: `evt${line}` }, replayed: false };
    },
    now: () => NOW,
    audit: async (payload) => { audits.push(payload); return null; },
  };

  return { deps, audits, recorded, batches };
};

// ── Pure CSV + fingerprint + window ──────────────────────────

test('31.14 import rules: parser accepts the documented shape', () => {
  const parsed = parseAttendanceImportCsv(GOOD_CSV);
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.rejected.length, 0);
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.rows[0].employeeCode, 'EMP001');
  assert.equal(parsed.rows[0].eventType, 'CLOCK_IN');
  assert.equal(parsed.rows[0].workMode, 'OFFICE');
  assert.equal(parsed.rows[2].workMode, '');
  assert.deepEqual([...IMPORT_EVENT_TYPES], ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
});

test('31.14 import rules: parser rejects bad headers, zoneless times, dupes, quotes', () => {
  const badHeader = parseAttendanceImportCsv('code,when\nEMP001,2026-09-14T09:00:00+05:30');
  assert.equal(badHeader.rows.length, 0);
  assert.match(badHeader.rejected[0].message, /header must contain/);

  const zoneless = parseAttendanceImportCsv(
    'employeeCode,timestamp,eventType\nEMP001,2026-09-14 09:00:00,CLOCK_IN'
  );
  assert.equal(zoneless.rows.length, 0);
  assert.match(zoneless.rejected[0].message, /zone/);

  const dupes = parseAttendanceImportCsv(
    'employeeCode,timestamp,eventType\nEMP001,2026-09-14T09:00:00+05:30,CLOCK_IN\nEMP001,2026-09-14T09:00:00+05:30,CLOCK_IN'
  );
  assert.equal(dupes.rows.length, 1);
  assert.match(dupes.rejected[0].message, /Duplicate row/);

  const quotes = parseAttendanceImportCsv(
    'employeeCode,timestamp,eventType\n"EMP001,2026-09-14T09:00:00+05:30,CLOCK_IN'
  );
  assert.equal(quotes.rows.length, 0);
  assert.match(quotes.rejected[0].message, /unbalanced quotes/);
});

test('31.14 import rules: zoned timestamps parse to exact instants', () => {
  assert.equal(parseZonedTimestamp('2026-09-16T09:00:00+05:30'), Date.parse('2026-09-16T03:30:00Z'));
  assert.equal(parseZonedTimestamp('2026-09-16T09:00:00Z'), Date.parse('2026-09-16T09:00:00Z'));
  assert.equal(parseZonedTimestamp('2026-09-16'), null);
  assert.equal(parseZonedTimestamp('not-a-date'), null);
  assert.equal(parseZonedTimestamp(''), null);
});

test('31.14 import rules: fingerprint is CRLF/BOM stable', () => {
  const lf = fingerprintImportContent(GOOD_CSV);
  const crlf = fingerprintImportContent(GOOD_CSV.replace(/\n/g, '\r\n'));
  const bom = fingerprintImportContent(`\uFEFF${GOOD_CSV}\n`);
  assert.equal(lf, crlf);
  assert.equal(lf, bom);
  assert.equal(lf.length, 64);
});

test('31.14 import rules: 12-month window is past-only', () => {
  assert.equal(isWithinImportWindow(Date.parse('2026-09-14T03:30:00Z'), NOW), true);
  assert.equal(isWithinImportWindow(Date.parse('2025-09-16T12:00:00+05:30'), NOW), true);
  assert.equal(isWithinImportWindow(Date.parse('2025-09-15T12:00:00+05:30'), NOW), false);
  assert.equal(isWithinImportWindow(NOW + 1000, NOW), false);
  assert.equal(isWithinImportWindow(NaN, NOW), false);
});

test('31.14 import rules: month derivation follows the company zone', () => {
  // 2026-09-01 00:30 IST = 2026-08-31 UTC — the COMPANY month wins.
  assert.equal(monthOfInstantInZone(Date.parse('2026-08-31T19:00:00Z'), TZ), '2026-09');
  assert.equal(monthOfInstantInZone(Date.parse('2026-08-31T19:00:00Z'), 'UTC'), '2026-08');
});

test('31.14 import rules: status machine is a one-way ladder', () => {
  assert.deepEqual({ ...IMPORT_STATUS }, { DRAFT: 'DRAFT', CONFIRMING: 'CONFIRMING', CONFIRMED: 'CONFIRMED', FAILED: 'FAILED' });
  assert.equal(canTransitionImport('DRAFT', 'CONFIRMING'), true);
  assert.equal(canTransitionImport('CONFIRMING', 'CONFIRMED'), true);
  assert.equal(canTransitionImport('CONFIRMING', 'FAILED'), true);
  assert.equal(canTransitionImport('DRAFT', 'CONFIRMED'), false);
  assert.equal(canTransitionImport('CONFIRMED', 'DRAFT'), false);
  assert.equal(canTransitionImport('CONFIRMED', 'CONFIRMING'), false);
});

test('31.14 import rules: template round-trips through the parser', () => {
  assert.equal(IMPORT_TEMPLATE_FILENAME, 'attendance-import-template.csv');
  const template = buildImportTemplate();
  assert.ok(template.includes(IMPORT_TEMPLATE_HEADER.join(',')));
  const parsed = parseAttendanceImportCsv(template);
  assert.ok(parsed.rows.length >= 1);
  assert.equal(parsed.rejected.length, 0);
});

// ── Pure session planner ─────────────────────────────────────

test('31.14 planner: clean multi-day files plan, orphans reject', () => {
  const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const T = (s) => Date.parse(s);
  const plans = planImportSessions({
    rows: [
      { line: 2, userKey: U_ASHA, occurredMs: T('2026-09-14T03:30:00Z'), eventType: 'CLOCK_IN' },
      { line: 3, userKey: U_ASHA, occurredMs: T('2026-09-14T12:30:00Z'), eventType: 'CLOCK_OUT' },
      { line: 4, userKey: U_ASHA, occurredMs: T('2026-09-15T12:30:00Z'), eventType: 'CLOCK_OUT' },
    ],
    existing: [],
    openState: new Map(),
    dayKeyOf,
  });
  assert.equal(plans.find((p) => p.line === 2).valid, true);
  assert.equal(plans.find((p) => p.line === 2).sessionDay, '2026-09-14');
  assert.equal(plans.find((p) => p.line === 3).valid, true);
  assert.equal(plans.find((p) => p.line === 4).valid, false);
  assert.equal(plans.find((p) => p.line === 4).reasonCode, 'NO_OPEN_SESSION');
});

test('31.14 planner: recorded facts win — collisions skip, conflicts reject', () => {
  const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const T = (s) => Date.parse(s);
  const plans = planImportSessions({
    rows: [
      { line: 2, userKey: U_ASHA, occurredMs: T('2026-09-14T03:30:00Z'), eventType: 'CLOCK_IN' },
      { line: 3, userKey: U_ASHA, occurredMs: T('2026-09-14T03:30:00Z'), eventType: 'BREAK_START' },
      { line: 4, userKey: U_ASHA, occurredMs: T('2026-09-14T04:00:00Z'), eventType: 'CLOCK_IN' },
    ],
    existing: [{ userKey: U_ASHA, sessionDay: '2026-09-14', type: 'CLOCK_IN', atMs: T('2026-09-14T03:30:00Z') }],
    openState: new Map([[U_ASHA, { liveState: 'WORKING', sessionDay: '2026-09-14' }]]),
    dayKeyOf,
  });
  const byLine = new Map(plans.map((p) => [p.line, p]));
  assert.equal(byLine.get(2).reasonCode, 'ALREADY_RECORDED');
  assert.equal(byLine.get(3).valid, false);
  assert.equal(byLine.get(3).reasonCode, 'COLLISION');
  assert.equal(byLine.get(4).valid, false);
  assert.equal(byLine.get(4).reasonCode, 'DAY_CONFLICT');
});

test('31.14 planner: imports extend open sessions and honor overnight outs', () => {
  const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const T = (s) => Date.parse(s);
  // Asha clocked in live yesterday and never closed; the file brings the OUT.
  const plans = planImportSessions({
    rows: [
      { line: 2, userKey: U_ASHA, occurredMs: T('2026-09-15T12:30:00Z'), eventType: 'CLOCK_OUT' },
    ],
    existing: [{ userKey: U_ASHA, sessionDay: '2026-09-14', type: 'CLOCK_IN', atMs: T('2026-09-14T03:30:00Z') }],
    openState: new Map([[U_ASHA, { liveState: 'WORKING', sessionDay: '2026-09-14' }]]),
    dayKeyOf,
  });
  assert.equal(plans[0].valid, true);
  assert.equal(plans[0].sessionDay, '2026-09-14');
});

// ── Preview (zero writes) ────────────────────────────────────

test('31.14 import: preview validates without writing anything', async () => {
  const { deps, batches, recorded } = buildWorld();
  const preview = await previewImport({ companyId: COMPANY, content: GOOD_CSV, deps });
  assert.equal(preview.validCount, 4);
  assert.equal(preview.invalidCount, 0);
  assert.equal(preview.months.join(','), '2026-09');
  assert.equal(preview.valid[0].sessionDay, '2026-09-14');
  assert.equal(preview.valid[1].employeeCode, 'EMP002');
  assert.equal(preview.valid[1].workMode, 'OFFICE');
  assert.equal(batches.size, 0);
  assert.equal(recorded.length, 0);
});

test('31.14 import: preview flags unknown codes, bad modes, locked months', async () => {
  const { deps } = buildWorld({ periods: [{ month: '2026-09', status: 'FINALIZED' }] });
  const csv = [
    'employeeCode,timestamp,eventType,workMode,sourceReference',
    'GHOST,2026-09-14T09:00:00+05:30,CLOCK_IN,,x',
    'EMP001,2026-09-14T09:00:00+05:30,CLOCK_IN,MARS,y',
    'EMP001,2026-09-13T09:00:00+05:30,CLOCK_IN,,z',
    'EMP001,2026-09-13T18:00:00+05:30,CLOCK_OUT,,w',
  ].join('\n');
  const preview = await previewImport({ companyId: COMPANY, content: csv, deps });
  assert.equal(preview.validCount, 0);
  assert.equal(preview.invalidCount, 4);
  const messages = preview.invalid.map((row) => row.message).join(' | ');
  assert.match(messages, /Unknown employee code/);
  assert.match(messages, /not enabled in policy/);
  assert.match(messages, /finalized — reopen it/);
});

// ── Confirm (idempotent, VALID_ROWS_ONLY) ────────────────────

test('31.14 import: confirm ingests through recordEvent with IMPORT provenance', async () => {
  const { deps, recorded, audits, batches } = buildWorld();
  const result = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, actor: { _id: U_ASHA }, deps });
  assert.equal(result.duplicate, false);
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.importedCount, 4);
  assert.equal(result.rejectedCount, 0);
  assert.equal(recorded.length, 4);
  const first = recorded[0];
  assert.equal(first.action, 'CLOCK_IN');
  assert.equal(first.date, '2026-09-14');
  assert.equal(first.ingest.source, 'IMPORT');
  assert.equal(first.ingest.provenance.importBatchId, result.id);
  assert.equal(first.ingest.provenance.sourceReference, 'dev-1');
  assert.match(first.idempotencyKey, new RegExp(`^import:${result.id}:2$`));
  assert.equal(typeof first.deps.now, 'function');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'ATTENDANCE_IMPORT_CONFIRMED');
  assert.equal(batches.size, 1);
});

test('31.14 import: confirm is idempotent — re-uploads replay the stored batch', async () => {
  const { deps, recorded } = buildWorld();
  const first = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps });
  const crlf = GOOD_CSV.replace(/\n/g, '\r\n');
  const second = await confirmImport({ companyId: COMPANY, content: crlf, deps });
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal(second.importedCount, 4);
  assert.equal(recorded.length, 4);
});

test('31.14 import: VALID_ROWS_ONLY — one failing row never poisons the batch', async () => {
  const { deps } = buildWorld({ failLines: new Set([3]) });
  const result = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps });
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.importedCount, 3);
  assert.equal(result.rejectedCount, 1);
  const rejected = result.outcomes.find((o) => o.line === 3);
  assert.equal(rejected.status, 'REJECTED');
  assert.match(rejected.message, /state changed since preview/);
});

test('31.14 import: all-invalid files stop before recording a batch', async () => {
  const { deps, batches } = buildWorld();
  const csv = 'employeeCode,timestamp,eventType\nGHOST,2026-09-14T09:00:00+05:30,CLOCK_IN';
  await assert.rejects(confirmImport({ companyId: COMPANY, content: csv, deps }), /No valid rows/);
  assert.equal(batches.size, 0);
});

test('31.14 import: history reads stay tenant-scoped', async () => {
  const { deps } = buildWorld();
  const created = await confirmImport({ companyId: COMPANY, content: GOOD_CSV, deps });
  const rows = await listImports({ companyId: COMPANY, deps });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, created.id);
  assert.equal(await listImports({ companyId: 'cccccccccccccccccccccccc', deps }).then((r) => r.length), 0);
  const one = await getImport({ companyId: COMPANY, importId: created.id, deps });
  assert.equal(one.outcomes.length, 4);
  await assert.rejects(
    getImport({ companyId: COMPANY, importId: '600000000000000000000099', deps }),
    /not found/i
  );
});

// ── Static integrity ─────────────────────────────────────────

test('31.14 import: multipart routes, no raw CSV at rest', () => {
  const routes = readSource('src/routes/attendance/attendanceRoutes.js');
  assert.match(routes, /\/imports\/preview/);
  assert.match(routes, /\/imports\/confirm/);
  assert.match(routes, /csvUpload/);
  assert.match(routes, /ATTENDANCE_CAPTURE_MANAGE/);

  const model = readSource('src/models/AttendanceImport.js');
  assert.ok(!/rawCsv|fileBuffer|fileContent|csvContent/.test(model));
  assert.match(model, /fingerprint/);
  const service = readSource('src/services/attendance/attendanceImportService.js');
  assert.ok(!/req\.body\.rows/.test(service));
});
