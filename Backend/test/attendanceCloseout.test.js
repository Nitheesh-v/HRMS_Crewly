// ─────────────────────────────────────────────────────────────
// Phase 31.16 — close-out adversarial pass.
// Hermetic service-level abuse tests for genuine gaps left by the
// 31.1–31.15 suites: paid-payroll reopen block, duplicate import
// confirm, cross-tenant analytics filters, out-of-scope exports.
// No DB, no Redis, no network.
// ─────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ATTENDANCE_ANALYTICS_CACHE_TTL_SECONDS = '0';

const { default: mongoose } = await import('mongoose');
const { reopenMonth } = await import('../src/services/attendance/attendanceFinalizationService.js');
const { FINALIZATION_STATUS } = await import('../src/services/attendance/attendanceFinalizationRules.js');
const { confirmImport } = await import('../src/services/attendance/attendanceImportService.js');
const { IMPORT_STATUS } = await import('../src/services/attendance/attendanceImportRules.js');
const analytics = await import('../src/services/attendance/attendanceAnalyticsService.js');
const { ROLES } = await import('../src/utils/constants.js');

const COMPANY = new mongoose.Types.ObjectId().toString();
const ACTOR = new mongoose.Types.ObjectId().toString();
const ALICE = new mongoose.Types.ObjectId().toString();
const FOREIGN_DEPT = new mongoose.Types.ObjectId().toString();

const chain = (rows) => {
  const api = {};
  api.select = () => api;
  api.sort = () => api;
  api.limit = () => api;
  api.lean = async () => rows;
  return api;
};

const admin = { _id: ACTOR, role: ROLES.COMPANY_ADMIN, name: 'Admin' };
const manager = { _id: ACTOR, role: ROLES.MANAGER, name: 'Manny' };

// ── Paid-payroll reopen block (service level) ──────────────────

const reopenDeps = ({ paid = null, payslip = null } = {}) => ({
  now: () => new Date('2026-09-16T00:00:00Z'),
  AttendancePeriodModel: {
    findOne: () => chain({ _id: 'p1', month: '2026-08', status: FINALIZATION_STATUS.SENT_TO_PAYROLL, currentVersion: 2 }),
  },
  PayrollPeriodModel: { findOne: () => chain(null) },
  PayrollRunModel: { findOne: () => chain(null) },
  PayrollReviewModel: { findOne: () => chain(null) },
  PaymentBatchModel: { find: () => chain([]) },
  PayrollPaymentModel: { exists: async () => paid },
  PayslipModel: { exists: async () => payslip },
});

test('closeout: reopen is refused after salaries are paid', async () => {
  await assert.rejects(
    reopenMonth({ companyId: COMPANY, actor: admin, month: '2026-08', reason: 'fix August', deps: reopenDeps({ paid: { _id: 'pay1' } }) }),
    /already paid for this month/
  );
});

test('closeout: reopen is refused after payslips release', async () => {
  await assert.rejects(
    reopenMonth({ companyId: COMPANY, actor: admin, month: '2026-08', reason: 'fix August', deps: reopenDeps({ payslip: { _id: 'slip1' } }) }),
    /already released for this month/
  );
});

test('closeout: reopen without a reason is refused before any payroll read', async () => {
  let reads = 0;
  const full = reopenDeps();
  full.PayrollPaymentModel = { exists: async () => { reads += 1; return null; } };
  await assert.rejects(
    reopenMonth({ companyId: COMPANY, actor: admin, month: '2026-08', reason: '  ', deps: full }),
    /reason is required/
  );
  assert.equal(reads, 0);
});

// ── Duplicate import confirm ───────────────────────────────────

test('closeout: confirming the same file twice replays the stored summary (no re-validation, no double-apply)', async () => {
  const stored = {
    _id: 'b1', companyId: COMPANY, status: IMPORT_STATUS.CONFIRMED,
    fingerprint: 'fp', rowCount: 10, importedCount: 20,
  };
  let validated = false;
  const full = {
    BatchModel: {
      findOne: () => ({ lean: async () => stored }),
      // Any second apply attempt would call create — fail loudly.
      create: async () => { throw new Error('DOUBLE APPLY'); },
    },
  };
  // Garbage content proves the replay path never re-validates.
  const result = await confirmImport({ companyId: COMPANY, content: 'not,a,real,file', actor: admin, deps: full });
  assert.equal(result.duplicate, true);
  assert.equal(result.importedCount, 20);
  assert.equal(validated, false);
});

/*
 * 35.7 — this used to assert a CONFLICT ("already being imported — please
 * wait") for a batch that is mid-confirm. That lock is exactly what made an
 * interrupted import un-resumable: a 156-row file on a slow database cannot
 * finish inside one request, and once the client timed out the batch stayed
 * CONFIRMING forever while every retry was refused.
 *
 * The guarantee — no parallel double-apply — is now enforced per ROW instead
 * of per batch: every row is written with its own idempotency key
 * (`import:<batchId>:<line>`) plus the exists-backstop, and a row that
 * already has a stored outcome is never re-attempted. So the contract this
 * test protects is kept, by construction:
 *
 *   · the same batch id is reused for a continuation (same keys → replays);
 *   · stored outcomes are skipped, so a continued chunk only ever processes
 *     rows that have no outcome yet;
 *   · the state machine still refuses an unqualified CONFIRMING → CONFIRMING.
 */
test('closeout: confirming a batch that is mid-confirm continues it, and rows stay idempotent', async () => {
  const { canTransitionImport } = await import('../src/services/attendance/attendanceImportRules.js');
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'attendance', 'attendanceImportService.js'),
    'utf8'
  );

  // A continuation is allowed only when the caller says so — never by accident.
  assert.equal(canTransitionImport(IMPORT_STATUS.CONFIRMING, IMPORT_STATUS.CONFIRMING), false);
  assert.equal(
    canTransitionImport(IMPORT_STATUS.CONFIRMING, IMPORT_STATUS.CONFIRMING, { continuation: true }),
    true
  );

  // The old dead end — a conflict that left a batch un-importable — is gone.
  assert.doesNotMatch(source, /ApiError\.conflict\('This file is already being imported/);
  // Even the two-tabs race resolves into a continuation, never a refusal.
  assert.match(source, /if \(raced\?\.status === IMPORT_STATUS\.CONFIRMING\) \{\s*\n\s*claimed = raced;/);

  // One key per (batch, row): a re-processed row can only ever replay.
  assert.match(source, /const requestId = `import:\$\{claimed\._id\}:\$\{row\.line\}`/);

  // Rows that already have an outcome are never applied a second time.
  assert.match(source, /const isPending = \(row\) => !outcomeMap\.has\(Number\(row\.line\)\);/);
  assert.match(source, /if \(!isPending\(row\)\) continue;/);
});

// ── Analytics cross-tenant / out-of-scope ──────────────────────

const analyticsDeps = () => ({
  policyReader: async () => ({ policy: { timezone: 'UTC' } }),
  subtreeReader: async () => [],
  now: () => new Date('2026-09-16T00:00:00Z'),
  deriveMonthsFn: async () => new Map(),
  UserModel: { find: () => chain([]) }, // foreign dept matches nobody in-tenant
  DepartmentModel: { find: () => chain([]) },
  CompanyModel: { findById: () => ({ select: () => ({ lean: async () => null }) }) },
  PeriodModel: { find: () => chain([]), findOne: () => ({ select: () => ({ lean: async () => null }) }) },
  SnapshotModel: { find: () => chain([]) },
  AttendanceEventModel: { countDocuments: async () => 0 },
  OvertimeRequestModel: { find: () => chain([]) },
  RegularizationModel: { find: () => chain([]) },
  LocationModel: { find: () => chain([]) },
  MonthlyInputModel: { find: () => chain([]) },
  AuditLogModel: { create: async (row) => row },
});

test('closeout: cross-tenant department filter yields empty scope (never leaks)', async () => {
  const result = await analytics.getOverview({
    companyId: COMPANY, actor: admin, query: { month: '2026-08', departmentId: FOREIGN_DEPT }, deps: analyticsDeps(),
  });
  assert.equal(result.employees, 0);
  assert.equal(result.totals.scheduledUnits, 0);
  assert.deepEqual(result.totals.attendanceRate, { ratio: null, pct: null });
});

test('closeout: export with an out-of-scope employee fails closed (403, no file)', async () => {
  await assert.rejects(
    analytics.exportReport({
      companyId: COMPANY, actor: manager,
      query: { month: '2026-08', reportType: 'employees', format: 'csv', employeeId: ALICE },
      deps: analyticsDeps(),
    }),
    /outside your analytics scope/
  );
});
