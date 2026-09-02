/**
 * PHASE 29.13 §2 — SUPER ADMIN PLATFORM METRICS
 *
 * Hermetic: fake models, a fake aggregation evaluator, no Redis, no Mongo.
 *
 * The test that matters here is the privacy one. The brief asks for
 * "aggregated metrics only" and forbids "any customer payroll data or
 * employee names". A comment promising that is worth nothing, so the test
 * builds a platform with salaries and named people in it, asks for the
 * metrics, and asserts that neither a figure nor a name survives the
 * round trip.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { makePlatformAnalyticsService } from '../src/services/payroll/platformAnalyticsService.js';
import { runPipeline } from './helpers/fakeAggregate.js';

// ── a tiny fake model ──────────────────────────────────────────────────────

const fakeModel = (rows = []) => ({ rows, aggregate: async (pipeline) => runPipeline(rows, pipeline) });

const NOW = new Date('2026-08-15T00:00:00Z');

// ── a platform ─────────────────────────────────────────────────────────────
//
// Three companies. Two run payroll. The snapshots carry real-looking salaries
// and real-looking names, so the privacy test has something to catch.

const C1 = '64b7f9c2e4b0a1b2c3d4e001';
const C2 = '64b7f9c2e4b0a1b2c3d4e002';
const C3 = '64b7f9c2e4b0a1b2c3d4e003';

const platform = () => makePlatformAnalyticsService({
  CompanyModel: fakeModel([{ companyId: C1 }, { companyId: C2 }, { companyId: C3 }]),
  PayrollSetupModel: fakeModel([{ companyId: C1 }, { companyId: C2 }]),
  PayrollResultModel: fakeModel([
    { companyId: C1, month: '2026-08', employeeId: 'e1', employeeName: 'Meera Iyer', totals: { gross: 62000, netPay: 54000 }, isCurrent: true, status: 'CALCULATED' },
    { companyId: C1, month: '2026-08', employeeId: 'e2', employeeName: 'Vikram Shetty', totals: { gross: 40000, netPay: 35000 }, isCurrent: true, status: 'CALCULATED' },
    { companyId: C1, month: '2026-07', employeeId: 'e1', employeeName: 'Meera Iyer', totals: { gross: 62000, netPay: 54000 }, isCurrent: true, status: 'CALCULATED' },
    { companyId: C2, month: '2026-08', employeeId: 'e3', employeeName: 'Arjun Rao', totals: { gross: 120000, netPay: 98000 }, isCurrent: true, status: 'CALCULATED' },
    // A superseded snapshot and a failed run: neither is payroll that happened.
    { companyId: C2, month: '2026-08', employeeId: 'e3', employeeName: 'Arjun Rao', totals: { gross: 120000 }, isCurrent: false, status: 'CALCULATED' },
    { companyId: C1, month: '2026-06', employeeId: 'e1', employeeName: 'Meera Iyer', totals: { gross: 62000 }, isCurrent: true, status: 'DRAFT' },
  ]),
  PayrollRunModel: fakeModel([
    { companyId: C1, status: 'COMPLETED' },
    { companyId: C1, status: 'COMPLETED' },
    { companyId: C2, status: 'FAILED' },
    { companyId: C2, status: 'RUNNING' },
  ]),
  AnalyticsReportFileModel: fakeModel([
    { companyId: C1, status: 'READY' },
    { companyId: C1, status: 'EXPIRED' },
    { companyId: C2, status: 'FAILED' },
  ]),
  ScheduledReportModel: fakeModel([
    { companyId: C1, active: true },
    { companyId: C2, active: false },
  ]),
  CandidateModel: fakeModel([{ companyId: C1 }, { companyId: C2 }, { companyId: C3 }]),
  AttendanceModel: fakeModel([{ companyId: C1 }]),
  LeaveModel: fakeModel([{ companyId: C1 }, { companyId: C2 }]),
  queueStats: async () => ({ waiting: 3, active: 1, failed: 0 }),
});

// ── §2 — adoption ──────────────────────────────────────────────────────────

test('§2 the platform can see how much of it uses payroll', async () => {
  const metrics = await platform().getPlatformMetrics({ now: NOW });

  assert.equal(metrics.adoption.totalCompanies, 3);
  assert.equal(metrics.adoption.companiesWithPayrollSetup, 2);
  assert.equal(metrics.adoption.companiesOnPayroll, 2, 'two of the three have run payroll');
  assert.equal(metrics.adoption.payrollPenetrationPercent, 66.7);

  // Adoption means nothing alone — it is shown next to the other modules.
  const modules = new Map(metrics.adoption.modules.map((row) => [row.key, row.companies]));
  assert.equal(modules.get('PAYROLL'), 2);
  assert.equal(modules.get('RECRUITMENT'), 3);
  assert.equal(modules.get('ATTENDANCE'), 1);
  assert.equal(modules.get('LEAVE'), 2);
});

// ── §2 — processing usage ──────────────────────────────────────────────────

test('§2 processing usage counts work done, not money', async () => {
  const metrics = await platform().getPlatformMetrics({ now: NOW });

  assert.equal(metrics.processing.companiesThisMonth, 2, 'both ran August');
  // Only the CALCULATED, current snapshots count: a superseded revision and a
  // failed run are not payroll that happened.
  assert.equal(metrics.processing.employeeMonthsInWindow, 4);

  const august = metrics.processing.byMonth.find((row) => row.month === '2026-08');
  assert.equal(august.companies, 2);
  assert.equal(august.snapshots, 3);
  const july = metrics.processing.byMonth.find((row) => row.month === '2026-07');
  assert.equal(july.companies, 1);
  assert.equal(july.snapshots, 1);

  assert.equal(metrics.window.from, '2025-09');
  assert.equal(metrics.window.to, '2026-08');
});

// ── §2 — job stats ─────────────────────────────────────────────────────────

test('§2 job stats come from what the jobs produced', async () => {
  const metrics = await platform().getPlatformMetrics({ now: NOW });

  assert.equal(metrics.jobs.payrollRuns.total, 4);
  assert.equal(metrics.jobs.payrollRuns.completed, 2);
  assert.equal(metrics.jobs.payrollRuns.failed, 1);
  assert.equal(metrics.jobs.payrollRuns.running, 1);

  assert.equal(metrics.jobs.reportFiles.total, 3);
  assert.equal(metrics.jobs.reportFiles.ready, 1);
  assert.equal(metrics.jobs.reportFiles.expired, 1, '§38 — expiry shows up in the platform numbers too');
  assert.equal(metrics.jobs.reportFiles.failed, 1);

  assert.equal(metrics.jobs.scheduledReports.total, 2);
  assert.equal(metrics.jobs.scheduledReports.active, 1);

  // Live queue depth, when the platform has Redis to offer.
  assert.equal(metrics.jobs.queue.waiting, 3);
});

test('§2 the metrics stand up without a queue to ask', async () => {
  const withoutQueue = makePlatformAnalyticsService({
    CompanyModel: fakeModel([{ companyId: C1 }]),
    PayrollResultModel: fakeModel([{ companyId: C1, month: '2026-08', employeeId: 'e1', isCurrent: true, status: 'CALCULATED' }]),
  });

  const metrics = await withoutQueue.getPlatformMetrics({ now: NOW });
  assert.equal(metrics.jobs.queue, null, 'absent, not zero — a missing queue is not an empty one');
  assert.equal(metrics.adoption.companiesOnPayroll, 1);
});

// ── §2 — the privacy rule, asserted rather than promised ───────────────────

test('§2 no customer payroll figure and no employee name survives the round trip', async () => {
  const metrics = await platform().getPlatformMetrics({ now: NOW });
  const serialised = JSON.stringify(metrics);

  // Every rupee the fixture holds.
  ['62000', '40000', '120000', '54000', '35000', '98000'].forEach((figure) => {
    assert.ok(!serialised.includes(figure), `no payroll figure in the payload — found ${figure}`);
  });
  // Every person the fixture names.
  ['Meera Iyer', 'Vikram Shetty', 'Arjun Rao'].forEach((name) => {
    assert.ok(!serialised.includes(name), `no employee name in the payload — found ${name}`);
  });
  // And no field that could carry one.
  ['gross', 'netPay', 'netSalary', 'ctc', 'employeeName', 'salary'].forEach((field) => {
    assert.ok(!serialised.includes(`"${field}"`), `no amount field in the payload — found ${field}`);
  });

  assert.equal(metrics.privacy.includesPayrollAmounts, false);
  assert.equal(metrics.privacy.includesEmployeeIdentities, false);
});

test('§2 an empty platform reports zeroes, not errors', async () => {
  const metrics = await makePlatformAnalyticsService({}).getPlatformMetrics({ now: NOW });

  assert.equal(metrics.adoption.totalCompanies, 0);
  assert.equal(metrics.adoption.companiesOnPayroll, 0);
  assert.equal(metrics.adoption.payrollPenetrationPercent, 0, 'no division by zero');
  assert.equal(metrics.processing.employeeMonthsInWindow, 0);
  assert.deepEqual(metrics.processing.byMonth, []);
  assert.equal(metrics.jobs.payrollRuns.total, 0);
});
