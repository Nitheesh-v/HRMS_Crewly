// ─────────────────────────────────────────────────────────────
// Phase 31.15 — attendance analytics service reads.
// Hermetic: every Mongo collaborator is an in-memory fake behind
// the service's deps seam; the 31.10 derivation, 31.11 snapshot
// mapping and pure rules it builds on are REAL. Cache forced to
// bypass (TTL 0); fixed clock; no network, no Redis, no writes.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ATTENDANCE_ANALYTICS_CACHE_TTL_SECONDS = '0';

const { default: mongoose } = await import('mongoose');
const service = await import('../src/services/attendance/attendanceAnalyticsService.js');
const { getOverview, getTrends, getEmployees, getMine, getPayrollReconciliation, exportReport } = service;
const { TIMESHEET_OUTCOME } = await import('../src/services/attendance/attendanceTimesheetRules.js');
const { FINALIZATION_STATUS, buildAutoFromSnapshot } = await import('../src/services/attendance/attendanceFinalizationRules.js');
const { RECON_STATUS } = await import('../src/services/attendance/attendanceAnalyticsRules.js');
const { ROLES } = await import('../src/utils/constants.js');

const COMPANY = new mongoose.Types.ObjectId().toString();
const ALICE = new mongoose.Types.ObjectId().toString();
const BOB = new mongoose.Types.ObjectId().toString();
const DEPT = new mongoose.Types.ObjectId().toString();
const NOW = new Date('2026-09-16T00:00:00Z');

// ── Fakes ────────────────────────────────────────────────────

const chain = (rows) => {
  const api = {};
  api.select = () => api;
  api.sort = () => api;
  api.limit = () => api;
  api.lean = async () => rows;
  return api;
};
const chainOne = (row) => ({ select: () => ({ lean: async () => row }) });

const users = [
  { _id: ALICE, name: 'Alice', employeeCode: 'E001', designation: 'Engineer', department: DEPT },
  { _id: BOB, name: 'Bob', employeeCode: 'E002', designation: 'Engineer', department: DEPT },
];

const day = (date, overrides = {}) => ({
  date,
  bucket: TIMESHEET_OUTCOME.PRESENT,
  scheduledWorkingDay: true,
  fractions: { worked: 1, leave: 0, absent: 0 },
  workMode: 'OFFICE',
  workedMinutes: 480,
  breakMinutes: 30,
  hasSession: true,
  lateMinutes: 0,
  earlyMinutes: 0,
  exceptions: [],
  ...overrides,
});

const augustDays = (who, absentDates = []) => {
  const out = [];
  for (let d = 3; d <= 7; d += 1) {
    const date = `2026-08-${String(d).padStart(2, '0')}`;
    out.push(absentDates.includes(date)
      ? day(date, { bucket: TIMESHEET_OUTCOME.ABSENT, fractions: { worked: 0, leave: 0, absent: 1 }, workedMinutes: 0, hasSession: false, workMode: null })
      : day(date));
  }
  return out;
};

// Frozen 31.11 snapshot-day shape: flat worked/leave/absent units,
// explicit scheduled flag, holiday/weeklyOff flags (no fractions).
const snapDay = (date, absent = false) => ({
  date,
  bucket: absent ? TIMESHEET_OUTCOME.ABSENT : TIMESHEET_OUTCOME.PRESENT,
  worked: absent ? 0 : 1,
  leave: 0,
  absent: absent ? 1 : 0,
  scheduledWorkingDay: true,
  holiday: false,
  weeklyOff: false,
  workMode: absent ? null : 'OFFICE',
  workedMinutes: absent ? 0 : 480,
  breakMinutes: absent ? 0 : 30,
  lateMinutes: 0,
  earlyMinutes: 0,
  exceptions: [],
  regularized: false,
  approvedOtMinutes: 0,
  compOffDays: 0,
});

const julySnapshotDays = (absentDates = []) => {
  const out = [];
  for (let d = 3; d <= 7; d += 1) {
    const date = `2026-07-${String(d).padStart(2, '0')}`;
    out.push(snapDay(date, absentDates.includes(date)));
  }
  return out;
};

const makeDeps = (overrides = {}) => {
  const state = { derivedMonths: [], audits: [] };
  const full = {
    policyReader: async () => ({ policy: { timezone: 'UTC' } }),
    subtreeReader: async () => [ALICE, BOB],
    now: () => new Date(NOW),
    deriveMonthsFn: async ({ dates, users: derivedUsers }) => {
      state.derivedMonths.push(dates[0].slice(0, 7));
      // The real deriveMonths derives only for the users it is
      // handed — the fake honors the same contract.
      const wanted = new Set((derivedUsers || []).map((row) => String(row._id)));
      const out = new Map();
      if (wanted.has(ALICE)) out.set(ALICE, { days: augustDays(ALICE) });
      if (wanted.has(BOB)) out.set(BOB, { days: augustDays(BOB, ['2026-08-05']) });
      return out;
    },
    UserModel: {
      find: (filter = {}) => {
        let rows = [...users];
        const ids = filter?._id?.$in;
        if (Array.isArray(ids)) rows = rows.filter((row) => ids.includes(String(row._id)));
        if (filter?.department) rows = rows.filter((row) => String(row.department) === String(filter.department));
        return chain(rows);
      },
    },
    DepartmentModel: { find: () => chain([{ _id: DEPT, name: 'Engineering' }]) },
    CompanyModel: { findById: () => chainOne(null) },
    PeriodModel: { find: () => chain([]), findOne: () => chainOne(null) },
    SnapshotModel: { find: () => chain([]) },
    AttendanceEventModel: { countDocuments: async () => 0 },
    OvertimeRequestModel: { find: () => chain([]) },
    RegularizationModel: { find: () => chain([]) },
    LocationModel: { find: () => chain([]) },
    MonthlyInputModel: { find: () => chain([]) },
    AuditLogModel: { create: async (row) => { state.audits.push(row); return row; } },
    ...overrides,
  };
  return { full, state };
};

const admin = { _id: ALICE, role: ROLES.COMPANY_ADMIN, name: 'Alice' };
const manager = { _id: ALICE, role: ROLES.MANAGER, name: 'Alice' };

// ── Overview ─────────────────────────────────────────────────

test('overview: open month derives live days (derivation runs)', async () => {
  const { full, state } = makeDeps();
  const result = await getOverview({ companyId: COMPANY, actor: admin, query: { month: '2026-08' }, deps: full });
  assert.equal(result.scope, 'COMPANY');
  assert.deepEqual(state.derivedMonths, ['2026-08']);
  assert.equal(result.finalized, false);
  assert.equal(result.provisional, true);
  assert.equal(result.employees, 2);
  // 5 scheduled days × 2 people, one absence.
  assert.equal(result.totals.scheduledUnits, 10);
  assert.equal(result.totals.workedUnits, 9);
  assert.equal(result.totals.absentUnits, 1);
  assert.deepEqual(result.totals.attendanceRate, { ratio: 0.9, pct: 90 });
});

test('overview: finalized month reads the CURRENT snapshot only (derivation never runs)', async () => {
  const snapshots = [
    { employeeId: ALICE, month: '2026-07', isCurrent: true, version: 3, days: julySnapshotDays() },
    // A stale version for the same employee+month must never leak in.
    { employeeId: ALICE, month: '2026-07', isCurrent: false, version: 1, days: julySnapshotDays(['2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07']) },
    { employeeId: BOB, month: '2026-07', isCurrent: true, version: 3, days: julySnapshotDays(['2026-07-05']) },
  ];
  const seen = [];
  const { full, state } = makeDeps({
    PeriodModel: {
      find: (filter) => {
        seen.push(filter);
        return chain([{ month: '2026-07', status: FINALIZATION_STATUS.FINALIZED, currentVersion: 3 }]);
      },
      findOne: () => chainOne(null),
    },
    SnapshotModel: {
      find: (filter) => {
        // The service must pin isCurrent — old versions never merge.
        assert.equal(filter.isCurrent, true);
        return chain(snapshots.filter((snap) => snap.isCurrent));
      },
    },
  });
  const result = await getOverview({ companyId: COMPANY, actor: admin, query: { month: '2026-07' }, deps: full });
  assert.deepEqual(state.derivedMonths, []);
  assert.equal(result.finalized, true);
  assert.equal(result.provisional, false);
  assert.deepEqual(result.provenance, [{ month: '2026-07', status: 'FINALIZED', finalized: true, version: 3 }]);
  assert.equal(result.totals.scheduledUnits, 10);
  assert.equal(result.totals.workedUnits, 9);
});

test('overview: manager scope narrows to the subtree', async () => {
  const { full } = makeDeps({ subtreeReader: async () => [BOB] });
  const result = await getOverview({ companyId: COMPANY, actor: manager, query: { month: '2026-08' }, deps: full });
  assert.equal(result.scope, 'TEAM');
  assert.equal(result.employees, 2); // subtree + self
});

test('overview: out-of-scope employee filter is forbidden', async () => {
  const { full } = makeDeps({ subtreeReader: async () => [] });
  await assert.rejects(
    getOverview({ companyId: COMPANY, actor: manager, query: { month: '2026-08', employeeId: BOB }, deps: full }),
    /outside your analytics scope/
  );
});

// ── Trends / employees / mine ────────────────────────────────

test('trends: monthly buckets carry per-month provenance', async () => {
  const { full } = makeDeps();
  const result = await getTrends({ companyId: COMPANY, actor: admin, query: { from: '2026-07-30', to: '2026-08-02' }, deps: full });
  assert.deepEqual(result.range.months, ['2026-07', '2026-08']);
  assert.equal(result.months.length, 2);
  assert.equal(result.months[0].finalized, false);
  assert.equal(result.months[0].status, 'OPEN');
});

test('employees: paginated, allowlisted sort, neutral default', async () => {
  const { full } = makeDeps();
  const first = await getEmployees({ companyId: COMPANY, actor: admin, query: { month: '2026-08', pageSize: 1, page: 1 }, deps: full });
  assert.equal(first.total, 2);
  assert.equal(first.totalPages, 2);
  assert.equal(first.rows[0].name, 'Alice'); // neutral name order
  const sorted = await getEmployees({ companyId: COMPANY, actor: admin, query: { month: '2026-08', sort: '-attendanceRate' }, deps: full });
  assert.equal(sorted.rows[0].name, 'Alice'); // 100% before Bob's 80%
  assert.equal(sorted.rows[1].attendanceRate.pct, 80);
});

test('mine: self-only even for admins', async () => {
  const { full } = makeDeps();
  const result = await getMine({ companyId: COMPANY, actor: admin, query: { month: '2026-08' }, deps: full });
  assert.equal(result.scope, 'SELF');
  assert.equal(result.totals.scheduledUnits, 5);
  assert.equal(result.totals.workedUnits, 5);
});

// ── Payroll reconciliation ───────────────────────────────────

const reconSnapshot = (employeeId) => ({
  employeeId,
  month: '2026-07',
  isCurrent: true,
  version: 3,
  scheduledWorkingDays: 22,
  equivalents: { worked: 20, absent: 1, leave: 1 },
  lateDays: 2,
  dayCounts: { halfDay: 0 },
  leaveUnitsByType: { CASUAL: 1, SICK: 0, EARNED: 0, OTHER: 0 },
  approvedOtMinutes: 60,
  overnightScheduledDays: 0,
  workedOnWeeklyOffDays: 1,
  workedOnHolidayDays: 0,
});

const reconDeps = ({ period, inputs }) => makeDeps({
  PeriodModel: { find: () => chain(period ? [period] : []), findOne: () => chainOne(period || null) },
  SnapshotModel: { find: () => chain([reconSnapshot(ALICE), reconSnapshot(BOB)]) },
  MonthlyInputModel: { find: () => chain(inputs) },
}).full;

test('reconciliation: MATCH, MISMATCH, NOT_SYNCED, NOT_FINALIZED', async () => {
  const snap = reconSnapshot(ALICE);
  const expected = buildAutoFromSnapshot({ snapshot: snap, otPolicy: null });
  const full = reconDeps({
    period: { month: '2026-07', status: FINALIZATION_STATUS.SENT_TO_PAYROLL, currentVersion: 3, syncedEmployees: [] },
    inputs: [
      // Alice matches exactly (extra HR-owned top-level fields ignored).
      { employeeId: ALICE, status: 'SYNCED', manual: { bonus: 5000 }, auto: { ...expected, attendanceSource: { version: 3, syncedAt: new Date('2026-08-02T00:00:00Z') } } },
      // Bob's stored block drifted after sync.
      { employeeId: BOB, status: 'SYNCED', auto: { ...expected, presentDays: 1, attendanceSource: { version: 3 } } },
    ],
  });
  const result = await getPayrollReconciliation({ companyId: COMPANY, actor: admin, query: { month: '2026-07' }, deps: full });
  assert.equal(result.finalized, true);
  assert.equal(result.currentVersion, 3);
  const byName = new Map(result.rows.map((row) => [row.name, row]));
  assert.equal(byName.get('Alice').status, RECON_STATUS.MATCH);
  assert.equal(byName.get('Bob').status, RECON_STATUS.MISMATCH);
  assert.equal(byName.get('Bob').diffs[0].field, 'presentDays');
  assert.deepEqual(result.summary, { MATCH: 1, MISMATCH: 1, NOT_SYNCED: 0, NOT_FINALIZED: 0 });
});

test('reconciliation: missing auto block is NOT_SYNCED, open month is NOT_FINALIZED', async () => {
  const synced = reconDeps({
    period: { month: '2026-07', status: FINALIZATION_STATUS.FINALIZED, currentVersion: 3, syncedEmployees: [] },
    inputs: [],
  });
  const noSync = await getPayrollReconciliation({ companyId: COMPANY, actor: admin, query: { month: '2026-07' }, deps: synced });
  assert.ok(noSync.rows.every((row) => row.status === RECON_STATUS.NOT_SYNCED));

  const open = reconDeps({ period: null, inputs: [] });
  const notFinalized = await getPayrollReconciliation({ companyId: COMPANY, actor: admin, query: { month: '2026-08' }, deps: open });
  assert.equal(notFinalized.finalized, false);
  assert.ok(notFinalized.rows.every((row) => row.status === RECON_STATUS.NOT_FINALIZED));
});

test('overview: bare call defaults to the current month', async () => {
  const { full, state } = makeDeps();
  const result = await getOverview({ companyId: COMPANY, actor: admin, query: {}, deps: full });
  assert.deepEqual(result.range.months, ['2026-09']);
  assert.deepEqual(state.derivedMonths, ['2026-09']);
});

// ── Exports ──────────────────────────────────────────────────

test('export: employees CSV is BOM-headed with metadata-only audit', async () => {
  const { full, state } = makeDeps();
  const result = await exportReport({ companyId: COMPANY, actor: admin, query: { month: '2026-08', reportType: 'employees', format: 'csv' }, deps: full });
  assert.equal(result.contentType, 'text/csv; charset=utf-8');
  assert.match(result.filename, /^crewly-attendance-employees-company-2026-08\.csv$/);
  assert.ok(result.content.startsWith('﻿'));
  assert.match(result.content.split('\r\n')[0], /"Employee","Employee code","Department"/);
  assert.equal(state.audits.length, 1);
  assert.deepEqual(Object.keys(state.audits[0].metadata).sort(), ['format', 'reportType', 'rows', 'scope']);
  assert.equal(state.audits[0].metadata.rows, 2);
});

test('export: reconciliation XLSX rides the dep-free writer', async () => {
  const snap = reconSnapshot(ALICE);
  const expected = buildAutoFromSnapshot({ snapshot: snap, otPolicy: null });
  const { full } = makeDeps({
    PeriodModel: {
      find: () => chain([{ month: '2026-07', status: FINALIZATION_STATUS.FINALIZED, currentVersion: 3 }]),
      findOne: () => chainOne({ month: '2026-07', status: FINALIZATION_STATUS.FINALIZED, currentVersion: 3, syncedEmployees: [] }),
    },
    SnapshotModel: { find: () => chain([reconSnapshot(ALICE), reconSnapshot(BOB)]) },
    MonthlyInputModel: {
      find: () => chain([
        { employeeId: ALICE, status: 'SYNCED', auto: { ...expected, attendanceSource: { version: 3 } } },
      ]),
    },
  });
  const result = await exportReport({ companyId: COMPANY, actor: admin, query: { month: '2026-07', reportType: 'reconciliation', format: 'xlsx' }, deps: full });
  assert.equal(result.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(result.filename, /^crewly-attendance-reconciliation-company-2026-07\.xlsx$/);
  assert.ok(Buffer.isBuffer(result.content));
  assert.ok(result.content.length > 0);
});

// ── 31.16 D-09: downloads declare byte length ────────────────
// A CSV string's char .length under-counts its UTF-8 bytes (BOM +
// multibyte data); the trailing bytes poison the keep-alive socket
// and kill the NEXT proxied response (vite proxy parse error).

test('31.16 D-09: every download helper declares byte length, never char length', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    'attendance/attendanceAnalyticsController.js',
    'attendance/attendanceTimesheetController.js',
    'payroll/fnfController.js',
    'payroll/payslipController.js',
    'payroll/statutoryController.js',
  ];
  for (const file of files) {
    const source = readFileSync(join(here, '..', 'src', 'controllers', file), 'utf8');
    assert.match(source, /Buffer\.byteLength\(content \?\? '', 'utf8'\)/, `${file} must compute byte length`);
    assert.ok(!/Content-Length', String\(content\?\.length/.test(source), `${file} must not declare char length`);
    assert.ok(!/Content-Length", String\(content\?\.length/.test(source), `${file} must not declare char length`);
  }
});

test('export: unknown report or format is rejected', async () => {
  const { full } = makeDeps();
  await assert.rejects(
    exportReport({ companyId: COMPANY, actor: admin, query: { month: '2026-08', reportType: 'payroll', format: 'csv' }, deps: full }),
    /reportType must be/
  );
  await assert.rejects(
    exportReport({ companyId: COMPANY, actor: admin, query: { month: '2026-08', reportType: 'employees', format: 'pdf' }, deps: full }),
    /format must be/
  );
});
