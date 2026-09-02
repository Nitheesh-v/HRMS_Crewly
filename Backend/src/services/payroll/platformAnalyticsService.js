// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.13 — SUPER ADMIN PLATFORM METRICS (§2)
//
//  Crewly's own numbers: how much of the platform is using payroll, how much
//  payroll is being processed, and how the jobs behind it are doing.
//
//  THE ONE RULE HERE — and it is not a comment, it is the design:
//
//    Not one rupee of a customer's payroll, and not one employee name.
//
//  Every metric in this file is a COUNT. There is no sum of a salary, no
//  average CTC, no department cost, no statutory total. A platform
//  administrator needs to know that payroll is being used and that it is
//  working; they do not need — and must not be able to see — what anyone is
//  paid. The payload states this in a `privacy` block so a reviewer does not
//  have to take the file's word for it, and a test asserts no amount field
//  ever appears in the response.
//
//  Aggregations only: nothing is loaded into Node to be counted.
// ═══════════════════════════════════════════════════════════════════════════

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const currentMonthKey = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

const shiftMonth = (month = '', delta = 0) => {
  if (!MONTH_PATTERN.test(String(month || ''))) return '';
  const [year, part] = String(month).split('-').map(Number);
  const index = year * 12 + (part - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

const percent = (part = 0, whole = 0) => (Number(whole) ? Math.round((Number(part) / Number(whole)) * 1000) / 10 : 0);

const num = (value) => Number(value) || 0;

export const makePlatformAnalyticsService = ({
  CompanyModel = null,
  PayrollSetupModel = null,
  PayrollResultModel = null,
  PayrollRunModel = null,
  AnalyticsReportFileModel = null,
  ScheduledReportModel = null,
  // Adoption is only meaningful against the other modules, so those
  // collections are counted too — as company counts, never as content.
  CandidateModel = null,
  AttendanceModel = null,
  LeaveModel = null,
  // Live queue depth, when the platform has a Redis connection to offer.
  // Null by default: the metrics must be complete without it.
  queueStats = null,
  windowMonths = 12,
} = {}) => {
  const aggregate = async (Model, pipeline = []) => {
    if (!Model || typeof Model.aggregate !== 'function') return [];
    const rows = await Model.aggregate(pipeline).catch(() => []);
    return Array.isArray(rows) ? rows : [];
  };

  const scored = (Model, match = {}) =>
    aggregate(Model, [{ $match: match }, { $group: { _id: '$companyId' } }]).then((rows) => rows.length);

  const counted = (Model, match = {}) =>
    aggregate(Model, [{ $match: match }, { $group: { _id: null, count: { $sum: 1 } } }])
      .then((rows) => num(rows[0]?.count));

  const byStatus = async (Model, match = {}) => {
    const rows = await aggregate(Model, [
      { $match: match },
      { $group: { _id: { $ifNull: ['$status', 'UNKNOWN'] }, count: { $sum: 1 } } },
    ]);
    const out = { total: 0 };
    (rows || []).forEach((row) => {
      const key = String(row._id || 'UNKNOWN').toLowerCase();
      out[key] = num(row.count);
      out.total += num(row.count);
    });
    return out;
  };

  /**
   * §2 — how the platform is using payroll, month by month.
   *
   * One row per month: how many companies ran payroll, and how many
   * employee-months were calculated. A COUNT of snapshots, never their value.
   */
  const processingByMonth = async ({ from = '', to = '' }) => {
    const rows = await aggregate(PayrollResultModel, [
      { $match: { month: { $gte: from, $lte: to }, isCurrent: true, status: 'CALCULATED' } },
      {
        $group: {
          _id: '$month',
          snapshots: { $sum: 1 },
          companies: { $addToSet: '$companyId' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return (rows || []).map((row) => ({
      month: String(row._id || ''),
      companies: Array.isArray(row.companies) ? row.companies.length : 0,
      snapshots: num(row.snapshots),
    }));
  };

  const getPlatformMetrics = async ({ now = new Date() } = {}) => {
    const latest = currentMonthKey(now);
    const oldest = shiftMonth(latest, -(Math.max(1, Number(windowMonths) || 12) - 1));
    const last3 = shiftMonth(latest, -2);

    const [
      totalCompanies,
      companiesWithSetup,
      companiesOnPayroll,
      companiesThisMonth,
      companiesLast3Months,
      snapshotsInWindow,
      payrollRuns,
      reportFiles,
      scheduledReports,
      adoptionCounts,
      byMonth,
      queue,
    ] = await Promise.all([
      counted(CompanyModel),
      scored(PayrollSetupModel),
      scored(PayrollResultModel, { isCurrent: true, status: 'CALCULATED' }),
      scored(PayrollResultModel, { month: latest, isCurrent: true, status: 'CALCULATED' }),
      scored(PayrollResultModel, { month: { $gte: last3, $lte: latest }, isCurrent: true, status: 'CALCULATED' }),
      counted(PayrollResultModel, { month: { $gte: oldest, $lte: latest }, isCurrent: true, status: 'CALCULATED' }),
      byStatus(PayrollRunModel),
      byStatus(AnalyticsReportFileModel),
      // A schedule is either running or paused; both are adoption.
      Promise.all([
        counted(ScheduledReportModel),
        counted(ScheduledReportModel, { active: true }),
      ]).then(([total, active]) => ({ total, active })),
      Promise.all([
        scored(CandidateModel),
        scored(AttendanceModel),
        scored(LeaveModel),
      ]).then(([recruitment, attendance, leave]) => ({ recruitment, attendance, leave })),
      processingByMonth({ from: oldest, to: latest }),
      typeof queueStats === 'function' ? queueStats().catch(() => null) : null,
    ]);

    return {
      generatedAt: now,
      window: { from: oldest, to: latest, months: Math.max(1, Number(windowMonths) || 12) },

      // §2 — "how many companies are using payroll vs the whole platform".
      adoption: {
        totalCompanies,
        companiesWithPayrollSetup: companiesWithSetup,
        companiesOnPayroll,
        payrollPenetrationPercent: percent(companiesOnPayroll, totalCompanies),
        // Adoption is relative: payroll next to the modules a company could
        // have chosen instead. Company counts, nothing else.
        modules: [
          { key: 'PAYROLL', label: 'Payroll', companies: companiesOnPayroll },
          { key: 'RECRUITMENT', label: 'Recruitment', companies: adoptionCounts.recruitment },
          { key: 'ATTENDANCE', label: 'Attendance', companies: adoptionCounts.attendance },
          { key: 'LEAVE', label: 'Leave', companies: adoptionCounts.leave },
        ].sort((a, b) => num(b.companies) - num(a.companies)),
      },

      // §2 — "payroll processing usage": is the module actually being used,
      // and by how many customers, month by month.
      processing: {
        companiesThisMonth,
        companiesLast3Months,
        // An employee-month, not a rupee: one person's payroll for one month.
        employeeMonthsInWindow: snapshotsInWindow,
        averageMonthsPerCompany: companiesOnPayroll
          ? Math.round((num(snapshotsInWindow) / companiesOnPayroll) * 10) / 10
          : 0,
        byMonth,
      },

      // §2 — "job stats": what the background work is producing, read from
      // the durable artefacts rather than from a transient queue.
      jobs: {
        payrollRuns,
        reportFiles,
        scheduledReports,
        queue: queue || null,
      },

      // The promise, stated in the answer itself.
      privacy: {
        includesPayrollAmounts: false,
        includesEmployeeIdentities: false,
        note:
          'Counts only. No customer payroll figure, no salary total and no employee name is aggregated anywhere in this response.',
      },
    };
  };

  return { getPlatformMetrics };
};

// ── the real instance ───────────────────────────────────────────────────────
// Imported at the bottom, the way analyticsService.js does it, so the
// factory above stays hermetic and testable with fakes.
import Company from '../../models/Company.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import PayrollResult from '../../models/PayrollResult.js';
import PayrollRun from '../../models/PayrollRun.js';
import AnalyticsReportFile from '../../models/AnalyticsReportFile.js';
import ScheduledReport from '../../models/ScheduledReport.js';
import Candidate from '../../models/Candidate.js';
import Attendance from '../../models/Attendance.js';
import Leave from '../../models/Leave.js';

export const platformAnalyticsService = makePlatformAnalyticsService({
  CompanyModel: Company,
  PayrollSetupModel: PayrollSetup,
  PayrollResultModel: PayrollResult,
  PayrollRunModel: PayrollRun,
  AnalyticsReportFileModel: AnalyticsReportFile,
  ScheduledReportModel: ScheduledReport,
  CandidateModel: Candidate,
  AttendanceModel: Attendance,
  LeaveModel: Leave,
});

export default platformAnalyticsService;
