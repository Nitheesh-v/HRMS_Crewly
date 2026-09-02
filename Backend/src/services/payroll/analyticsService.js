// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — PAYROLL ANALYTICS SERVICE
//
//  The business-intelligence layer over the payroll the earlier phases
//  produced. It reads, aggregates and exports — it never calculates a salary,
//  never recomputes a statutory figure and never writes a payroll row (§2).
//
//  Models, cache, audit, notify, dispatch, PDF and the file writers are all
//  INJECTED (the pattern 29.6–29.11 established), so this phase is testable
//  with no MongoDB, Redis, BullMQ or SMTP.
//
//  The single rule everything else follows: one reader (`loadRows`) produces
//  the normalised rows, and every report is a pure function of those rows. The
//  dashboard, the department table, the trend chart and the spreadsheet
//  therefore cannot disagree — they are the same numbers.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import { roundMoney as money } from './analyticsRules.js';

const num = (value) => Number(value) || 0;

import {
  ANALYTICS_AUDIT_ACTIONS,
  FINANCE_ONLY_REPORTS,
  REPORT_KEYS,
  REPORT_LABELS,
  BONUS_ENTRY_PATTERN,
  PERIOD_PRESET_LABELS,
  REGISTER_HEADERS,
  SALARY_BANDS,
  SCHEDULE_FREQUENCIES,
  TREND_PERIODS,
  analyticsKpis,
  applyFilters,
  bonusRows,
  buildAnalyticsRow,
  costMovement,
  ctcRows,
  deductionRows,
  departmentRows,
  designationRows,
  earningsRows,
  employerContributionRows,
  financialYearMonths,
  fnfRows,
  headcountMetrics,
  isPeriodPreset,
  isReportKey,
  isScheduleFrequency,
  isTrendPeriod,
  leaveImpactRows,
  monthRange,
  nextRunAt,
  normaliseSalaryBands,
  overtimeByDepartment,
  overtimeRows,
  recentMonths,
  registerRows,
  reimbursementRows,
  reportFilename,
  reportTable,
  resolvePeriod,
  salaryBandIssues,
  salaryBandRows,
  searchRows,
  shiftMonthOf,
  statutoryLiability,
  summariseRows,
  trendSeries,
  varianceRows,
} from './analyticsRules.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const makeAnalyticsService = ({
  PayrollResultModel = null,
  PayrollPaymentModel = null,
  FinalSettlementModel = null,
  ResignationModel = null,
  UserModel = null,
  DepartmentModel = null,
  ScheduledReportModel = null,
  AnalyticsReportFileModel = null,
  AnalyticsSettingModel = null,
  EmployeePayrollProfileModel = null,
  CompanyModel = null,

  // §38 — how long a generated payroll file lives before the sweeper drops
  // its bytes. A salary spreadsheet is not an archive.
  fileTtlHours = 24,

  cache = {},
  audit = async () => null,
  notify = async () => null,
  notifyRoles = async () => 0,

  dispatchExport = async () => ({ queued: false }),
  dispatchSchedule = async () => ({ queued: false }),
  dispatchRefresh = async () => ({ queued: false }),

  renderPdf = async () => null,
  buildCsv = () => '',
  buildWorkbook = () => null,

  hash = () => '',
  ttlSeconds = 120,
  trendMonths = 12,
} = {}) => {
  // ── the cache read (§21) ─────────────────────────────────────────────────

  // `filters` is part of the key (§18): a department-filtered dashboard is a
  // different document from the whole-company one, and the local wrapper has
  // to forward it or the filtered read is served last month's unfiltered copy.
  const buildKey = ({ companyId, month = '', suffix = 'dashboard', period = '', filters = null } = {}) =>
    cache.buildKey ? cache.buildKey({ companyId, month, suffix, period, filters }) : null;

  const readThrough = async (key, loader) => {
    if (!key || !cache.getOrSet) return { value: await loader(), cache: 'BYPASS' };
    return cache.getOrSet(key, { loader, ttlSeconds });
  };

  const invalidate = async (companyId, month = '') => {
    if (!cache.invalidate) return 0;
    return cache.invalidate(companyId, month);
  };

  // ── the one reader ───────────────────────────────────────────────────────

  const loadDepartments = async ({ companyId }) => {
    if (!DepartmentModel) return new Map();
    const rows = await DepartmentModel.find({ companyId }).select('name').lean().catch(() => []);
    return new Map((rows || []).map((row) => [String(row._id), row.name || 'Unassigned']));
  };

  const loadEmployees = async ({ companyId, employeeIds = [] }) => {
    if (!UserModel) return new Map();
    const ids = [...new Set((employeeIds || []).map(String).filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await UserModel.find({ companyId, _id: { $in: ids } })
      .select('name employeeCode designation department status dateOfJoining')
      .lean()
      .catch(() => []);
    return new Map((rows || []).map((row) => [String(row._id), row]));
  };

  const loadPayments = async ({ companyId, months = [] }) => {
    if (!PayrollPaymentModel || !months.length) return new Map();
    const rows = await PayrollPaymentModel.find({ companyId, month: { $in: months } })
      .select('employeeId month status paidAt paymentReference')
      .lean()
      .catch(() => []);
    // One employee can appear more than once in a month (a failed payment
    // retried in a second batch). The PAID row is the one that counts.
    const map = new Map();
    (rows || []).forEach((row) => {
      const key = `${String(row.employeeId)}:${row.month}`;
      const existing = map.get(key);
      if (!existing || (row.status === 'PAID' && existing.status !== 'PAID')) map.set(key, row);
    });
    return map;
  };

  /**
   * Every report's input: the current, successfully calculated snapshots for
   * the months in scope, joined to the names and payment facts the snapshot
   * never stored.
   */
  const loadRows = async ({ companyId, months = [], allowedEmployeeIds = null }) => {
    if (!PayrollResultModel) return [];
    const filter = { companyId, isCurrent: true, status: 'CALCULATED' };
    if (months.length) filter.month = { $in: months };
    // §3 / §25 — a manager scoped to two departments must not have the whole
    // company's payroll cost summed up for them. The narrowing happens here,
    // in the only reader, so no report can forget it.
    if (Array.isArray(allowedEmployeeIds)) filter.employeeId = { $in: allowedEmployeeIds };

    const results = await PayrollResultModel.find(filter).lean().catch(() => []);
    if (!(results || []).length) return [];

    const [departments, employees, payments] = await Promise.all([
      loadDepartments({ companyId }),
      loadEmployees({ companyId, employeeIds: (results || []).map((row) => row.employeeId) }),
      loadPayments({ companyId, months: [...new Set((results || []).map((row) => row.month))] }),
    ]);

    return (results || []).map((result) => {
      const employee = employees.get(String(result.employeeId)) || null;
      const departmentName = departments.get(String(result.departmentId || employee?.department || '')) || '';
      return buildAnalyticsRow({
        result,
        employee,
        departmentName,
        payment: payments.get(`${String(result.employeeId)}:${result.month}`) || null,
      });
    });
  };

  // ── §29 / §44 — the aggregation fast path ────────────────────────────────

  /**
   * The filter every aggregation starts from.
   *
   * Snapshot-only filters (month, department, designation, employee) are
   * pushed into MongoDB; only a PAYMENT-status filter needs the payment join,
   * and a read that asks for one falls back to the row path.
   */
  const snapshotMatch = ({ companyId, months = [], allowedEmployeeIds = null, filters = {} } = {}) => {
    const match = { companyId, isCurrent: true, status: 'CALCULATED' };
    if (months.length) match.month = { $in: months };
    if (Array.isArray(allowedEmployeeIds)) match.employeeId = { $in: allowedEmployeeIds };
    if (filters.departmentId) match.departmentId = filters.departmentId;
    if (filters.designation) match.designation = filters.designation;
    if (filters.employeeId) match.employeeId = filters.employeeId;
    return match;
  };

  const runAggregate = async (pipeline = []) => {
    if (typeof PayrollResultModel?.aggregate !== 'function') return null;
    return PayrollResultModel.aggregate(pipeline).catch(() => null);
  };

  const hasRowFilters = (filters = {}) =>
    Boolean(String(filters.status || '').trim());

  /** One accumulator set, shared by every pipeline, so they cannot drift. */
  const snapshotGroup = (id = null) => ({
    _id: id,
    employees: { $addToSet: '$employeeId' },
    gross: { $sum: { $ifNull: ['$totals.totalEarnings', '$totals.gross'] } },
    net: { $sum: { $ifNull: ['$totals.netPay', 0] } },
    earningsTotal: { $sum: { $ifNull: ['$totals.totalEarnings', 0] } },
    deductions: { $sum: { $ifNull: ['$totals.totalDeductions', 0] } },
    employerCost: { $sum: { $ifNull: ['$totals.employerCost', 0] } },
    ctc: { $sum: { $ifNull: ['$totals.ctc', 0] } },
    overtime: { $sum: { $ifNull: ['$totals.overtime', 0] } },
    variableEarnings: { $sum: { $ifNull: ['$totals.variableEarnings', 0] } },
    reimbursements: { $sum: { $ifNull: ['$totals.reimbursements', 0] } },
    otHours: { $sum: { $ifNull: ['$attendance.otHours', 0] } },
    lopDays: { $sum: { $ifNull: ['$attendance.lopDays', 0] } },
    paidLeaveDays: { $sum: { $ifNull: ['$attendance.paidLeaveDays', 0] } },
    // §14 — the same daily-rate derivation the row path uses. It is written
    // twice (once here, once in leaveImpactRows) because MongoDB has to do
    // the arithmetic to keep a large window out of Node, and a test asserts
    // the two agree.
    lopDeduction: {
      $sum: {
        $cond: [
          { $gt: [{ $ifNull: ['$attendance.workingDays', 0] }, 0] },
          {
            $multiply: [
              { $divide: [{ $ifNull: ['$totals.gross', 0] }, '$attendance.workingDays'] },
              { $ifNull: ['$attendance.lopDays', 0] },
            ],
          },
          0,
        ],
      },
    },
    pfEmployee: { $sum: { $ifNull: ['$statutory.pf.employee', 0] } },
    pfEmployer: { $sum: { $ifNull: ['$statutory.pf.employer', 0] } },
    esiEmployee: { $sum: { $ifNull: ['$statutory.esi.employee', 0] } },
    esiEmployer: { $sum: { $ifNull: ['$statutory.esi.employer', 0] } },
    pt: { $sum: { $ifNull: ['$statutory.professionalTax.amount', 0] } },
    tds: { $sum: { $ifNull: ['$statutory.tds.monthly', 0] } },
    lwfEmployee: { $sum: { $ifNull: ['$statutory.lwf.employee', 0] } },
    lwfEmployer: { $sum: { $ifNull: ['$statutory.lwf.employer', 0] } },
    gratuity: { $sum: { $ifNull: ['$statutory.gratuity.amount', 0] } },
  });

  const employeeIdsOf = (row = {}) =>
    new Set((Array.isArray(row?.employees) ? row.employees : []).filter(Boolean).map(String));

  /** The roll-up, in exactly the shape `summariseRows` produces. */
  const summaryFromAggregate = (row = {}, bonus = 0) => {
    const paidEmployees = employeeIdsOf(row).size;
    const gross = money(row.gross);
    const employerCost = money(row.employerCost);
    const ctc = money(row.ctc);
    return {
      employeesPaid: paidEmployees,
      grossSalary: gross,
      netSalary: money(row.net),
      earningsTotal: money(row.earningsTotal),
      deductionsTotal: money(row.deductions),
      employerContribution: employerCost,
      ctc,
      totalPayrollCost: money(gross + employerCost),
      averageSalary: paidEmployees ? money(gross / paidEmployees) : 0,
      averageCtc: paidEmployees ? money(ctc / paidEmployees) : 0,
      bonusTotal: money(bonus),
      variableTotal: money(row.variableEarnings),
      overtimeTotal: money(row.overtime),
      overtimeHours: money(row.otHours),
      reimbursements: money(row.reimbursements),
      lopDays: money(row.lopDays),
      paidLeaveDays: money(row.paidLeaveDays),
      lopDeduction: money(row.lopDeduction),
    };
  };

  const statutoryFromAggregate = (row = {}) => {
    const buckets = [
      { key: 'PF', label: 'Provident Fund', employee: money(row.pfEmployee), employer: money(row.pfEmployer) },
      { key: 'ESI', label: 'ESI', employee: money(row.esiEmployee), employer: money(row.esiEmployer) },
      { key: 'PT', label: 'Professional Tax', employee: money(row.pt), employer: 0 },
      { key: 'TDS', label: 'TDS', employee: money(row.tds), employer: 0 },
      { key: 'LWF', label: 'Labour Welfare Fund', employee: money(row.lwfEmployee), employer: money(row.lwfEmployer) },
    ].map((bucket) => ({ ...bucket, total: money(num(bucket.employee) + num(bucket.employer)) }));

    const employer = money(buckets.reduce((total, bucket) => total + num(bucket.employer), 0));
    const employee = money(buckets.reduce((total, bucket) => total + num(bucket.employee), 0));
    const gratuity = money(row.gratuity);

    return {
      buckets,
      totals: {
        employee,
        employer,
        totalLiability: money(employee + employer),
        gratuityProvision: gratuity,
        gratuityAnnualised: money(gratuity * 12),
        // The per-state and per-department splits are built from row data;
        // an aggregation-only read does not carry them.
        byState: [],
        byDepartment: [],
      },
    };
  };

  /**
   * §12 — the bonus total, without loading the snapshots.
   *
   * The type pattern is imported from analyticsRules rather than restated, so
   * the pipeline and the row builder cannot disagree about what a bonus is.
   */
  const aggregateBonus = async (scope) => {
    const rows = await runAggregate([
      { $match: snapshotMatch(scope) },
      { $unwind: '$variableEarnings' },
      { $match: { 'variableEarnings.type': { $regex: BONUS_ENTRY_PATTERN.source } } },
      { $group: { _id: null, bonus: { $sum: { $ifNull: ['$variableEarnings.amount', 0] } } } },
    ]);
    return money(rows?.[0]?.bonus);
  };

  /** §7 — the department table, grouped in MongoDB and named afterwards. */
  const aggregateDepartments = async (scope) => {
    const rows = await runAggregate([
      { $match: snapshotMatch(scope) },
      {
        $group: {
          ...snapshotGroup({ $ifNull: ['$departmentId', ''] }),
          bonus: { $sum: { $ifNull: ['$totals.variableEarnings', 0] } },
        },
      },
    ]);
    if (!Array.isArray(rows)) return null;

    const names = await loadDepartments({ companyId: scope.companyId });
    return (rows || [])
      .map((row) => ({
        department: names.get(String(row._id)) || 'Unassigned',
        employees: employeeIdsOf(row).size,
        gross: money(row.gross),
        net: money(row.net),
        employerCost: money(row.employerCost),
        ctc: money(row.ctc),
        bonus: money(row.bonus),
        overtime: money(row.overtime),
        otHours: money(row.otHours),
        lopDays: money(row.lopDays),
        totalCost: money(money(row.gross) + money(row.employerCost)),
      }))
      .map((row) => ({ ...row, averageSalary: row.employees ? money(row.gross / row.employees) : 0 }))
      .sort((a, b) => num(b.totalCost) - num(a.totalCost));
  };

  /** §9 — one row per employee, for the cost-movement decomposition. */
  const aggregateByEmployee = async (scope) => {
    const rows = await runAggregate([
      { $match: snapshotMatch(scope) },
      {
        $group: {
          _id: '$employeeId',
          gross: { $sum: { $ifNull: ['$totals.totalEarnings', '$totals.gross'] } },
          variableEarnings: { $sum: { $ifNull: ['$totals.variableEarnings', 0] } },
          overtime: { $sum: { $ifNull: ['$totals.overtime', 0] } },
          reimbursements: { $sum: { $ifNull: ['$totals.reimbursements', 0] } },
        },
      },
    ]);
    return (rows || []).map((row) => ({
      employeeId: String(row._id || ''),
      gross: money(row.gross),
      variableEarnings: money(row.variableEarnings),
      overtime: money(row.overtime),
      reimbursements: money(row.reimbursements),
    }));
  };

  /**
   * The dashboard's numbers, by the cheapest honest route.
   *
   * A payment-status filter is the one thing MongoDB cannot answer from the
   * snapshot alone (status lives on PayrollPayment), so that read — and any
   * read where the model has no aggregation support — still loads rows. Both
   * paths are asserted to agree, in the tests, on the same data.
   */
  const dashboardNumbers = async ({ companyId, months = [], allowedEmployeeIds = null, filters = {} } = {}) => {
    const scope = { companyId, months, allowedEmployeeIds, filters };

    if (!hasRowFilters(filters)) {
      // `await` before indexing: `null` (no aggregation support, or a failed
      // pipeline) is not destructurable, and a dashboard must never fail
      // closed — it falls back to the row path instead.
      const grouped = await runAggregate([{ $match: snapshotMatch(scope) }, { $group: snapshotGroup(null) }]);
      const totals = Array.isArray(grouped) ? grouped[0] : null;
      if (totals) {
        const [bonus, departments] = await Promise.all([
          aggregateBonus(scope),
          aggregateDepartments(scope),
        ]);
        return {
          summary: summaryFromAggregate(totals, bonus),
          statutory: statutoryFromAggregate(totals),
          departments: departments || [],
          path: 'AGGREGATION',
        };
      }
    }

    const rows = applyFilters({ rows: await loadRows({ companyId, months, allowedEmployeeIds }), ...filters });
    return {
      summary: summariseRows({ rows }),
      statutory: statutoryLiability({ rows }),
      departments: departmentRows({ rows }),
      path: 'ROWS',
    };
  };

  // ── §5 / §6 — the executive dashboard ────────────────────────────────────

  const getDashboard = async ({ companyId, month = '', preset = '', fromMonth = '', toMonth = '', filters = {}, allowedEmployeeIds = null } = {}) => {
    const key = buildKey({
      companyId,
      month,
      suffix: 'dashboard',
      // §4 — a preset names a different window, so it is a different cache
      // entry: "last 12 months" must not be served from "current month".
      period: preset ? `${preset}:${fromMonth}:${toMonth}` : '',
      filters,
    });

    const { value } = await readThrough(key, async () => {
      const anchor = MONTH_PATTERN.test(String(month || '')) ? month : await latestMonth({ companyId });
      const window = preset && isPeriodPreset(preset)
        ? resolvePeriod({ preset, month: anchor, fromMonth, toMonth })
        : {
          preset: 'CURRENT_MONTH',
          label: PERIOD_PRESET_LABELS.CURRENT_MONTH,
          months: anchor ? [anchor] : [],
          fromMonth: anchor,
          toMonth: anchor,
        };

      const months = window.months;
      const previousMonths = previousWindow(months);
      const scope = { companyId, allowedEmployeeIds, filters };

      const numbers = await dashboardNumbers({ ...scope, months });
      const previousNumbers = previousMonths.length
        ? await dashboardNumbers({ ...scope, months: previousMonths })
        : { summary: summariseRows({ rows: [] }), statutory: null, departments: [], path: 'EMPTY' };

      const [settlements, currentByEmployee, previousByEmployee] = await Promise.all([
        loadSettlements({ companyId, months }),
        aggregateByEmployee({ ...scope, months }),
        previousMonths.length ? aggregateByEmployee({ ...scope, months: previousMonths }) : Promise.resolve([]),
      ]);

      const headcount = await buildHeadcount({
        companyId,
        month: months[months.length - 1] || '',
        summary: numbers.summary,
        previousSummary: previousNumbers.summary,
        filters: { ...filters, fromMonth: window.fromMonth, toMonth: window.toMonth },
      });

      return {
        month: months[months.length - 1] || '',
        monthLabel: months[months.length - 1] || '',
        months,
        // §4 — the window travels with the answer, so the page can say what
        // it is showing instead of leaving the reader to infer it.
        period: {
          preset: window.preset,
          label: window.label,
          fromMonth: window.fromMonth,
          toMonth: window.toMonth,
        },
        previousMonths,
        previousMonth: previousMonths[previousMonths.length - 1] || '',
        kpis: analyticsKpis({
          summary: numbers.summary,
          previous: previousNumbers.summary,
          statutory: numbers.statutory,
          departments: numbers.departments,
          settlements,
        }),
        summary: numbers.summary,
        previousSummary: previousNumbers.summary,
        departments: numbers.departments.slice(0, 8),
        topDepartment: numbers.departments[0] || null,
        statutory: numbers.statutory,
        headcount,
        // §9 — why the cost moved, not only that it did.
        movement: costMovement({ rows: currentByEmployee, previousRows: previousByEmployee }),
        settlements: settlements.length,
        // §6 — "Payroll Accuracy": the share of snapshots that calculated
        // cleanly. Warnings do not make a payroll wrong; errors do.
        accuracy: await payrollAccuracy({ companyId, month: months[months.length - 1] || '' }),
        availableMonths: recentMonths(months[months.length - 1] || currentMonthFallback(), 12),
        source: numbers.path,
        generatedAt: new Date(),
      };
    });

    return value;
  };

  /**
   * §4 / §21 — the window immediately before this one, of the same length.
   * "Previous month" for a month, "the year before" for a financial year:
   * comparing a quarter to the single month preceding it would be nonsense.
   */
  const previousWindow = (months = []) => {
    if (!months.length) return [];
    if (months.length === 1) return [shiftMonthOf(months[0], -1)];
    const end = shiftMonthOf(months[0], -1);
    const start = shiftMonthOf(end, -(months.length - 1));
    return monthRange(start, end);
  };

  const latestMonth = async ({ companyId }) => {
    if (!PayrollResultModel) return '';
    const rows = await PayrollResultModel.find({ companyId, isCurrent: true })
      .select('month')
      .sort({ month: -1 })
      .limit(1)
      .lean()
      .catch(() => []);
    return rows?.[0]?.month || '';
  };

  const currentMonthFallback = () => new Date().toISOString().slice(0, 7);

  // One implementation of month arithmetic, in the rules, so the dashboard
  // window, the cache key and the reports cannot disagree about it.
  const previousMonthOf = (month = '') => shiftMonthOf(month, -1);

  const loadSettlements = async ({ companyId, month = '', months = [] }) => {
    if (!FinalSettlementModel) return [];
    const filter = { companyId };
    const list = (months || []).filter((value) => MONTH_PATTERN.test(String(value || '')));
    if (list.length > 1) filter.month = { $in: list };
    else if (MONTH_PATTERN.test(String(month || ''))) filter.month = month;
    return FinalSettlementModel.find(filter)
      .select('settlementNumber month status totals exit recoveries earnings payment calculatedAt closedAt')
      .lean()
      .catch(() => []);
  };

  const payrollAccuracy = async ({ companyId, month = '' }) => {
    if (!PayrollResultModel || !month) return { calculated: 0, errors: 0, accuracyPercent: 100 };
    const [calculated, errors] = await Promise.all([
      PayrollResultModel.countDocuments({ companyId, month, isCurrent: true, status: 'CALCULATED' }).catch(() => 0),
      PayrollResultModel.countDocuments({ companyId, month, isCurrent: true, status: 'ERROR' }).catch(() => 0),
    ]);
    const total = Number(calculated) + Number(errors);
    return {
      calculated: Number(calculated),
      errors: Number(errors),
      accuracyPercent: total ? Math.round((Number(calculated) / total) * 10000) / 100 : 100,
    };
  };

  // ── §9 — headcount ───────────────────────────────────────────────────────

  const buildHeadcount = async ({
    companyId,
    month = '',
    rows = [],
    previousRows = [],
    summary = null,
    previousSummary = null,
    filters = null,
  }) => {
    const [active, joined, exited] = await Promise.all([
      countActive({ companyId }),
      countJoined({ companyId, month }),
      countExited({ companyId, month }),
    ]);

    const key = buildKey({ companyId, month, suffix: 'headcount', filters });
    const { value } = await readThrough(key, async () =>
      headcountMetrics({
        rows,
        summary,
        previousSummary,
        activeEmployees: active,
        joined,
        exited,
        previousRows,
      }),
    );
    return value;
  };

  const countActive = async ({ companyId }) => {
    if (!UserModel) return 0;
    return UserModel.countDocuments({ companyId, status: 'ACTIVE' }).catch(() => 0);
  };

  const monthStartEnd = (month = '') => {
    if (!MONTH_PATTERN.test(String(month || ''))) return null;
    const [year, part] = String(month).split('-').map(Number);
    return {
      start: new Date(Date.UTC(year, part - 1, 1)),
      end: new Date(Date.UTC(year, part, 0, 23, 59, 59, 999)),
    };
  };

  const countJoined = async ({ companyId, month = '' }) => {
    const range = monthStartEnd(month);
    if (!UserModel || !range) return 0;
    return UserModel.countDocuments({
      companyId,
      dateOfJoining: { $gte: range.start, $lte: range.end },
    }).catch(() => 0);
  };

  /**
   * §9 — exits come from the Exit module, which is the only thing that knows
   * when someone actually left. A resignation's approved last working day is
   * the date; the User record is deactivated by a lazy sweep, so it is not a
   * reliable source.
   */
  const countExited = async ({ companyId, month = '' }) => {
    const range = monthStartEnd(month);
    if (!ResignationModel || !range) return 0;
    return ResignationModel.countDocuments({
      companyId,
      status: 'APPROVED',
      lastWorkingDate: { $gte: range.start, $lte: range.end },
    }).catch(() => 0);
  };

  // ── §6 … §17 — one report ────────────────────────────────────────────────

  const getReport = async ({
    companyId,
    reportKey = 'OVERVIEW',
    month = '',
    months = [],
    preset = '',
    fromMonth = '',
    toMonth = '',
    period = 'MONTHLY',
    financialYear = '',
    departmentId = '',
    designation = '',
    employeeId = '',
    status = '',
    employmentStatus = '',
    structureId = '',
    page = 0,
    limit = 0,
    search = '',
    canSeeFinancial = true,
    allowedEmployeeIds = null,
    actor = null,
    req = null,
  } = {}) => {
    const key = String(reportKey || 'OVERVIEW').toUpperCase();
    if (!isReportKey(key)) throw ApiError.badRequest(`Unknown report: ${reportKey}`);

    // §16 / §25 — the CTC report is Finance-only. The gate is server-side;
    // hiding the tab is a courtesy, not a control.
    if (FINANCE_ONLY_REPORTS.includes(key) && !canSeeFinancial) {
      throw ApiError.forbidden('This report is restricted to users with financial analytics access');
    }

    const scopeMonths = await resolveMonths({
      month, months, financialYear, preset, fromMonth, toMonth, reportKey: key, companyId,
    });

    const filters = { month, months: scopeMonths, departmentId, designation, employeeId, status, employmentStatus, structureId };
    const allRows = await loadRows({ companyId, months: scopeMonths, allowedEmployeeIds });
    const rows = searchRows({ rows: applyFilters({ rows: allRows, ...filters }), search });

    const targetMonth = month || scopeMonths[scopeMonths.length - 1] || '';
    const previousMonths = previousWindow(scopeMonths);
    const previousRows = previousMonths.length
      ? applyFilters({
        rows: await loadRows({ companyId, months: previousMonths, allowedEmployeeIds }),
        months: previousMonths,
        departmentId, designation, employeeId, status, employmentStatus, structureId,
      })
      : [];

    // Only the reports that need them pay for the extra reads.
    const headcountContext = key === 'HEADCOUNT' && targetMonth
      ? await buildHeadcount({
        companyId,
        month: targetMonth,
        rows,
        previousRows,
        filters: { ...filters, fromMonth: scopeMonths[0], toMonth: targetMonth },
      })
      : null;
    const settlements = key === 'FNF' ? await loadSettlements({ companyId, months: scopeMonths }) : [];
    const bands = key === 'SALARY_BANDS' ? await loadBands({ companyId }) : null;

    const payload = buildReportPayload({
      reportKey: key, rows, period, months: scopeMonths, headcountContext, previousRows, settlements, bands,
    });

    // §22 — the register is the one report that pages: five thousand rows is
    // a spreadsheet, not a web page.
    const paged = paginate({ rows: payload.rows, page, limit });

    // §32 — reading a payroll report is an auditable act. The filters travel
    // with it; the figures do not, so the audit trail never becomes a second
    // copy of the payroll.
    await writeAudit({
      req,
      action: ANALYTICS_AUDIT_ACTIONS.REPORT_VIEWED,
      companyId,
      actor,
      reportKey: key,
      metadata: {
        month: targetMonth,
        preset: preset || '',
        departmentId: departmentId || '',
        designation: designation || '',
        employeeId: employeeId ? String(employeeId) : '',
        status: status || '',
        employmentStatus: employmentStatus || '',
        structureId: structureId || '',
        search: search || '',
        rows: rows.length,
      },
    });

    return {
      reportKey: key,
      label: REPORT_LABELS[key] || key,
      month: targetMonth,
      months: scopeMonths,
      previousMonths,
      period: isTrendPeriod(period) ? String(period).toUpperCase() : 'MONTHLY',
      financialYear: financialYear || '',
      preset: preset || '',
      filters: { departmentId, designation, employeeId, status, employmentStatus, structureId },
      rowCount: rows.length,
      pagination: paged.pagination,
      summary: summariseRows({ rows }),
      ...payload,
      ...(paged.rows ? { rows: paged.rows } : {}),
    };
  };

  /**
   * §22 — slicing a report for the browser.
   *
   * Every row is still computed (totals stay true for the whole period); the
   * page is only what gets sent. A report with no row list — the statutory
   * summary, say — is returned untouched.
   */
  const paginate = ({ rows = null, page = 0, limit = 0 } = {}) => {
    if (!Array.isArray(rows)) return { rows: null, pagination: null };
    const total = rows.length;
    const size = Math.max(0, Number(limit) || 0);
    if (!size) return { rows, pagination: { page: 1, limit: 0, total, pages: 1 } };
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(1, Number(page) || 1), pages);
    const start = (current - 1) * size;
    return {
      rows: rows.slice(start, start + size),
      pagination: { page: current, limit: size, total, pages },
    };
  };

  // ── §8 — the company's own salary bands ──────────────────────────────────

  const loadBands = async ({ companyId }) => {
    if (!AnalyticsSettingModel) return null;
    const row = await AnalyticsSettingModel.findOne({ companyId }).lean().catch(() => null);
    const bands = row?.salaryBands;
    return Array.isArray(bands) && bands.length ? normaliseSalaryBands(bands) : null;
  };

  const getAnalyticsSettings = async ({ companyId } = {}) => {
    const stored = AnalyticsSettingModel
      ? await AnalyticsSettingModel.findOne({ companyId }).lean().catch(() => null)
      : null;
    return {
      salaryBands: normaliseSalaryBands(stored?.salaryBands),
      usingDefaults: !(Array.isArray(stored?.salaryBands) && stored.salaryBands.length),
      updatedAt: stored?.updatedAt || null,
      updatedByName: stored?.updatedByName || '',
    };
  };

  const updateSalaryBands = async ({ companyId, salaryBands = [], actor = null, req = null } = {}) => {
    // The editor is strict where the reader is forgiving: repairing what a
    // user typed means they save one thing and get another.
    const issues = salaryBandIssues(salaryBands);
    if (issues.length) throw ApiError.badRequest(issues[0]);

    const bands = normaliseSalaryBands(salaryBands);
    if (!AnalyticsSettingModel) return { salaryBands: bands, usingDefaults: false };

    await AnalyticsSettingModel.updateOne(
      { companyId },
      {
        $set: {
          salaryBands: bands,
          updatedBy: actor?._id || null,
          updatedByName: actor?.name || '',
        },
      },
      { upsert: true },
    ).catch(() => null);

    await writeAudit({
      req,
      action: ANALYTICS_AUDIT_ACTIONS.SCHEDULE_UPDATED,
      companyId,
      actor,
      reportKey: 'SALARY_BANDS',
      metadata: { bands: bands.map((band) => band.label) },
    });

    await invalidate(companyId, '');
    return { salaryBands: bands, usingDefaults: false };
  };

  // ── §23 — one employee's salary history ──────────────────────────────────

  /**
   * §23 — an employee's salary history, from two sources that must not be
   * confused with each other: what they were actually PAID each month (the
   * 29.6 snapshots) and what their salary was CONTRACTED to be (the versioned
   * 29.4 profile). Neither is overwritten — history is read, never written.
   */
  const getEmployeeHistory = async ({
    companyId,
    employeeId = '',
    allowedEmployeeIds = null,
    actor = null,
    req = null,
  } = {}) => {
    if (!employeeId) throw ApiError.badRequest('employeeId is required');

    // §25 — the scope check happens again here. A manager scoped to two
    // departments must not read a third department's salary history by
    // guessing an employee id, however the route was reached.
    if (Array.isArray(allowedEmployeeIds) && !allowedEmployeeIds.map(String).includes(String(employeeId))) {
      throw ApiError.forbidden('This employee is outside your payroll scope');
    }

    const snapshotMonths = await employeeMonths({ companyId, employeeId });
    const rows = snapshotMonths.length
      ? applyFilters({
        rows: await loadRows({ companyId, months: snapshotMonths, allowedEmployeeIds: [String(employeeId)] }),
        months: snapshotMonths,
        employeeId: String(employeeId),
      })
      : [];

    const versions = EmployeePayrollProfileModel
      ? await EmployeePayrollProfileModel.find({ companyId, employeeId })
        .sort({ version: -1 })
        .lean()
        .catch(() => [])
      : [];

    const monthsOut = rows
      .map((row) => ({
        month: row.month,
        gross: row.gross,
        net: row.net,
        ctc: row.ctc,
        basic: row.basic,
        employerCost: row.employerCost,
        totalDeductions: row.totalDeductions,
        variableEarnings: row.variableEarnings,
        overtime: row.overtime,
        reimbursements: row.reimbursements,
        structureName: row.structureName,
        statutory: row.statutory,
      }))
      .sort((a, b) => String(a.month).localeCompare(String(b.month)));

    await writeAudit({
      req,
      action: ANALYTICS_AUDIT_ACTIONS.SALARY_HISTORY_VIEWED,
      companyId,
      actor,
      reportKey: 'SALARY_HISTORY',
      metadata: { employeeId: String(employeeId), months: monthsOut.length },
    });

    const first = monthsOut[0] || null;
    const latest = monthsOut[monthsOut.length - 1] || null;

    return {
      employeeId: String(employeeId),
      employee: {
        employeeCode: rows[0]?.employeeCode || '',
        employeeName: rows[0]?.employeeName || '',
        department: rows[0]?.department || '',
        designation: rows[0]?.designation || '',
      },
      months: monthsOut,
      // §23 — the contracted side: the version chain, newest first.
      versions: (versions || []).map((row) => ({
        version: Number(row.version) || 1,
        effectiveFrom: row.effectiveFrom || null,
        effectiveTo: row.effectiveTo || null,
        isCurrent: Boolean(row.isCurrent),
        structureId: row.structureId ? String(row.structureId) : '',
        structureName: row.structureName || '',
        annualCtc: Number(row.annualCtc) || 0,
        monthlyGross: Number(row.monthlyGross) || 0,
      })),
      summary: {
        firstMonth: first?.month || '',
        lastMonth: latest?.month || '',
        months: monthsOut.length,
        latestCtc: latest?.ctc || 0,
        firstCtc: first?.ctc || 0,
        ctcChange: money(num(latest?.ctc) - num(first?.ctc)),
        averageGross: monthsOut.length
          ? money(monthsOut.reduce((total, row) => total + num(row.gross), 0) / monthsOut.length)
          : 0,
      },
    };
  };

  const employeeMonths = async ({ companyId, employeeId }) => {
    if (!PayrollResultModel) return [];
    const rows = await PayrollResultModel.find({
      companyId,
      employeeId,
      isCurrent: true,
      status: 'CALCULATED',
    })
      .select('month')
      .lean()
      .catch(() => []);
    return [...new Set((rows || []).map((row) => row.month).filter(Boolean))].sort();
  };

  // ── §38 — generated files expire ─────────────────────────────────────────

  /**
   * §38 — "Do not keep temporary sensitive payroll files forever."
   *
   * Anything still READY past its expiry is marked EXPIRED and its bytes are
   * dropped. Called by the sweeper job; safe to call by hand.
   */
  const expireFiles = async ({ now = new Date(), limit = 200 } = {}) => {
    if (!AnalyticsReportFileModel) return 0;

    const due = await AnalyticsReportFileModel.find({ status: 'READY', expiresAt: { $lte: now } })
      .limit(limit)
      .lean()
      .catch(() => []);

    let expired = 0;
    for (const row of due || []) {
      const file = await AnalyticsReportFileModel.findOne({ _id: row._id, companyId: row.companyId });
      if (!file || file.status !== 'READY') continue;
      file.status = 'EXPIRED';
      file.expiredAt = now;
      file.binary = null;
      file.sizeBytes = 0;
      await file.save().catch(() => null);
      expired += 1;
    }
    return expired;
  };

  /**
   * §11 / §18 — which months a report reads. A trend is a window (twelve
   * months ending at `month`); everything else is the month itself. A
   * financial year is an explicit alternative to a single month.
   */
  const resolveMonths = async ({
    month = '',
    months = [],
    financialYear = '',
    preset = '',
    fromMonth = '',
    toMonth = '',
    reportKey = '',
    companyId,
  }) => {
    if (Array.isArray(months) && months.length) {
      return months.map(String).filter((value) => MONTH_PATTERN.test(value));
    }
    // §4 — a preset names the window, so it wins over a bare month.
    if (preset && isPeriodPreset(preset)) {
      const anchor = MONTH_PATTERN.test(String(month || ''))
        ? month
        : financialYear
          ? financialYearStart(financialYear)
          : await latestMonth({ companyId });
      const resolved = resolvePeriod({ preset, month: anchor, fromMonth, toMonth }).months;
      if (resolved.length) return resolved;
    }
    if (financialYear) return financialYearMonths(month || financialYearStart(financialYear), 4);
    if (MONTH_PATTERN.test(String(month || ''))) {
      return String(reportKey).toUpperCase() === 'TREND' ? recentMonths(month, trendMonths) : [month];
    }
    const latest = await latestMonth({ companyId });
    if (!latest) return [];
    return String(reportKey).toUpperCase() === 'TREND' ? recentMonths(latest, trendMonths) : [latest];
  };

  const financialYearStart = (financialYear = '') => {
    const start = String(financialYear || '').split('-')[0];
    return /^\d{4}$/.test(start) ? `${start}-04` : '';
  };

  const buildReportPayload = ({
    reportKey = '',
    rows = [],
    period = 'MONTHLY',
    months = [],
    headcountContext = null,
    // 29.13 — the new reports need facts the row list cannot supply: the
    // previous window (variance), the settlement register (F&F) and the
    // company's own salary bands (distribution).
    previousRows = [],
    settlements = [],
    bands = null,
  } = {}) => {
    switch (reportKey) {
      case 'DEPARTMENT':
        return { rows: departmentRows({ rows }) };
      case 'DESIGNATION':
        return { rows: designationRows({ rows }) };
      case 'SALARY_BANDS': {
        const list = bands || SALARY_BANDS;
        return { rows: salaryBandRows({ rows, bands: list }), bands: list };
      }
      // ── 29.13 ───────────────────────────────────────────────────────────
      case 'EARNINGS':
        return earningsRows({ rows });
      case 'DEDUCTIONS':
        return deductionRows({ rows });
      case 'EMPLOYER':
        return employerContributionRows({ rows });
      case 'REIMBURSEMENT':
        return reimbursementRows({ rows });
      case 'FNF':
        return fnfRows({ settlements });
      case 'VARIANCE':
        return varianceRows({ rows, previousRows });
      case 'TREND': {
        const series = trendSeries({ rows, period });
        return { rows: series.rows, series, periods: TREND_PERIODS };
      }
      case 'BONUS':
        return { rows: bonusRows({ rows }), total: summariseRows({ rows }).bonusTotal };
      case 'OVERTIME':
        return {
          rows: overtimeRows({ rows }),
          byDepartment: overtimeByDepartment({ rows }),
          totals: summariseRows({ rows }),
        };
      case 'LEAVE':
        return leaveImpactRows({ rows });
      case 'STATUTORY':
        return statutoryLiability({ rows });
      case 'CTC':
        return ctcRows({ rows });
      case 'REGISTER':
        return { rows: rows.slice().sort((a, b) => String(a.employeeCode).localeCompare(String(b.employeeCode))), headers: REGISTER_HEADERS };
      case 'HEADCOUNT':
        // The HR half of §9 — active, joined, exited — lives in the employee
        // and resignation collections, not in the payroll snapshot, so it is
        // resolved by the caller. Passing the finished metrics back through
        // headcountMetrics() would drop joined and exited on the way: its
        // inputs are called `joined`/`exited`, its outputs
        // `joinedThisMonth`/`exitedThisMonth`.
        return headcountContext || headcountMetrics({ rows });
      case 'OVERVIEW':
      default:
        return { rows: departmentRows({ rows }), months };
    }
  };

  // ── §19 — exports ────────────────────────────────────────────────────────

  const buildExport = async ({
    companyId,
    reportKey = 'OVERVIEW',
    format = 'CSV',
    filters = {},
    actor = null,
    canSeeFinancial = true,
    allowedEmployeeIds = null,
  } = {}) => {
    const report = await getReport({ companyId, reportKey, canSeeFinancial, allowedEmployeeIds, ...filters });
    const table = reportTable({ reportKey: report.reportKey, payload: report });
    const wanted = String(format || 'CSV').toUpperCase();

    if (wanted === 'CSV') {
      const content = Buffer.from(buildCsv(table.headers, table.rows), 'utf8');
      return { content, filename: reportFilename({ reportKey, month: report.month, period: report.period, format: 'CSV' }), rows: table.rows.length };
    }
    if (wanted === 'XLSX') {
      const content = buildWorkbook(table.headers, table.rows);
      return { content, filename: reportFilename({ reportKey, month: report.month, period: report.period, format: 'XLSX' }), rows: table.rows.length };
    }
    if (wanted === 'PDF') {
      const content = await renderPdf({
        company: (await loadCompany({ companyId })) || { name: '' },
        title: REPORT_LABELS[report.reportKey] || report.reportKey,
        subtitle: report.month || '',
        headers: table.headers,
        rows: table.rows,
        summary: report.summary,
        generatedBy: actor?.name || '',
      });
      return { content, filename: reportFilename({ reportKey, month: report.month, period: report.period, format: 'PDF' }), rows: table.rows.length };
    }
    throw ApiError.badRequest('format must be CSV, XLSX or PDF');
  };

  const loadCompany = async ({ companyId }) => {
    if (!CompanyModel) return null;
    return CompanyModel.findById(companyId).select('name address logoUrl').lean().catch(() => null);
  };

  const exportReport = async ({ companyId, reportKey, format = 'CSV', filters = {}, actor = null, req = null, canSeeFinancial = true, allowedEmployeeIds = null }) => {
    const built = await buildExport({ companyId, reportKey, format, filters, actor, canSeeFinancial, allowedEmployeeIds });

    await writeAudit({
      req,
      action: ANALYTICS_AUDIT_ACTIONS.REPORT_EXPORTED,
      companyId,
      actor,
      reportKey,
      metadata: { format, filename: built.filename, rows: built.rows, filters },
    });

    return { filename: built.filename, sizeBytes: built.content?.length || 0, rows: built.rows, content: built.content };
  };

  /** The inline path: small exports come back immediately (§19). */
  const downloadExport = async ({ companyId, reportKey, format = 'CSV', filters = {}, actor = null, req = null, canSeeFinancial = true, allowedEmployeeIds = null }) =>
    exportReport({ companyId, reportKey, format, filters, actor, req, canSeeFinancial, allowedEmployeeIds });

  /** The queued path: large exports are built in the background (§19 / §22). */
  const requestExport = async ({
    companyId,
    reportKey,
    format = 'XLSX',
    filters = {},
    actor = null,
    req = null,
    canSeeFinancial = true,
    allowedEmployeeIds = null,
  } = {}) => {
    const key = String(reportKey || '').toUpperCase();
    if (!isReportKey(key)) throw ApiError.badRequest(`Unknown report: ${reportKey}`);
    if (FINANCE_ONLY_REPORTS.includes(key) && !canSeeFinancial) {
      throw ApiError.forbidden('This report is restricted to users with financial analytics access');
    }

    const file = await AnalyticsReportFileModel.create({
      companyId,
      reportKey: key,
      format: String(format || 'XLSX').toUpperCase(),
      period: String(filters.period || 'MONTHLY').toUpperCase(),
      month: filters.month || '',
      financialYear: filters.financialYear || '',
      departmentId: filters.departmentId || null,
      designation: filters.designation || '',
      employeeId: filters.employeeId || null,
      paymentStatus: filters.status || '',
      scopeEmployeeIds: Array.isArray(allowedEmployeeIds) ? allowedEmployeeIds : null,
      filename: reportFilename({ reportKey: key, month: filters.month, period: filters.period, format }),
      status: 'QUEUED',
      requestedBy: actor?._id || null,
      requestedByName: actor?.name || '',
    });

    const dispatched = await dispatchExport({
      companyId: String(companyId),
      fileId: String(file._id),
      reportKey: key,
      format: String(format || 'XLSX').toUpperCase(),
      filters,
      actorId: actor?._id ? String(actor._id) : '',
    }).catch(() => ({ queued: false }));

    if (dispatched?.queued) {
      file.jobId = dispatched.jobId || '';
      file.queued = true;
      await file.save();
      await writeAudit({
        req,
        action: ANALYTICS_AUDIT_ACTIONS.REPORT_EXPORTED,
        companyId,
        actor,
        reportKey: key,
        metadata: { format, fileId: String(file._id), queued: true, filters },
      });
      return { queued: true, fileId: String(file._id), jobId: dispatched.jobId || '', status: 'QUEUED' };
    }

    return runExport({ companyId, fileId: String(file._id), actor, req, canSeeFinancial, allowedEmployeeIds });
  };

  /** What the worker calls: build the file and store the bytes. */
  const runExport = async ({ companyId, fileId, actor = null, req = null, canSeeFinancial = true, onProgress = null }) => {
    const file = await AnalyticsReportFileModel.findOne({ _id: fileId, companyId });
    if (!file) throw ApiError.notFound('Report file not found');

    file.status = 'PROCESSING';
    file.progress = 10;
    await file.save();
    if (onProgress) await onProgress(10);

    try {
      const built = await buildExport({
        companyId,
        reportKey: file.reportKey,
        format: file.format,
        actor: actor || (file.requestedBy ? { _id: file.requestedBy } : null),
        canSeeFinancial,
        allowedEmployeeIds: Array.isArray(file.scopeEmployeeIds) ? file.scopeEmployeeIds.map(String) : null,
        filters: {
          month: file.month || '',
          financialYear: file.financialYear || '',
          period: file.period || 'MONTHLY',
          departmentId: file.departmentId ? String(file.departmentId) : '',
          designation: file.designation || '',
          employeeId: file.employeeId ? String(file.employeeId) : '',
          status: file.paymentStatus || '',
        },
      });

      file.binary = built.content;
      file.sizeBytes = built.content?.length || 0;
      file.checksum = hash(built.content);
      file.filename = built.filename;
      file.rowCount = built.rows || 0;
      file.status = 'READY';
      file.progress = 100;
      file.completedAt = new Date();
      // §38 — the clock starts when the file exists. A payroll spreadsheet
      // is an answer to a question, not an archive.
      file.expiresAt = new Date(Date.now() + Math.max(1, Number(fileTtlHours) || 24) * 60 * 60 * 1000);
      await file.save();
      if (onProgress) await onProgress(100);

      await writeAudit({
        req,
        action: ANALYTICS_AUDIT_ACTIONS.REPORT_EXPORTED,
        companyId,
        actor,
        reportKey: file.reportKey,
        metadata: { format: file.format, fileId: String(file._id), filename: built.filename, rows: built.rows },
      });

      // §23 — a large export runs in the background, so the person who asked
      // for it has to be told when it lands instead of watching the page.
      if (file.requestedBy) {
        await notify({
          userId: String(file.requestedBy),
          payload: {
            message: `${REPORT_LABELS[file.reportKey] || file.reportKey} (${file.format}) is ready to download.`,
            filename: built.filename,
            fileId: String(file._id),
            reportKey: file.reportKey,
            format: file.format,
            month: file.month || '',
          },
        }).catch(() => null);
      }

      return { fileId: String(file._id), filename: built.filename, sizeBytes: file.sizeBytes, rows: built.rows, status: 'READY' };
    } catch (error) {
      file.status = 'FAILED';
      file.error = error?.message || 'Export failed';
      await file.save();
      throw error;
    }
  };

  const listFiles = async ({ companyId, reportKey = '' } = {}) => {
    const filter = { companyId };
    if (reportKey) filter.reportKey = String(reportKey).toUpperCase();
    const rows = await AnalyticsReportFileModel.find(filter).sort({ createdAt: -1 }).limit(50).lean().catch(() => []);
    return (rows || []).map(toFileView);
  };

  const toFileView = (row = {}) => ({
    _id: row._id,
    reportKey: row.reportKey || '',
    reportLabel: REPORT_LABELS[row.reportKey] || row.reportKey || '',
    format: row.format || '',
    filename: row.filename || '',
    month: row.month || '',
    status: row.status || 'QUEUED',
    // §38 — the page can only tell someone "this link dies at 6pm" if the
    // API hands the deadline over.
    expiresAt: row.expiresAt || null,
    expiredAt: row.expiredAt || null,
    progress: row.progress || 0,
    rowCount: row.rowCount || 0,
    sizeBytes: row.sizeBytes || 0,
    requestedByName: row.requestedByName || '',
    scheduled: Boolean(row.scheduledReportId),
    downloadCount: row.downloadCount || 0,
    error: row.error || '',
    createdAt: row.createdAt || null,
    completedAt: row.completedAt || null,
  });

  const downloadFile = async ({ companyId, fileId }) => {
    const file = await AnalyticsReportFileModel.findOne({ _id: fileId, companyId }).select('+binary');
    if (!file) throw ApiError.notFound('Report file not found');
    if (file.status === 'EXPIRED') throw ApiError.badRequest('This report has expired — generate it again');
    if (file.status !== 'READY') throw ApiError.badRequest('This report is not ready yet');

    // §19 — how often a report is actually picked up. The model carries the
    // counter, so it has to be incremented somewhere.
    file.downloadCount = Number(file.downloadCount || 0) + 1;
    file.lastDownloadedAt = new Date();
    await file.save().catch(() => null);

    return { filename: file.filename || 'report', content: file.binary, format: file.format };
  };

  // ── §20 — scheduled reports ──────────────────────────────────────────────

  const listSchedules = async ({ companyId } = {}) => {
    const rows = await ScheduledReportModel.find({ companyId }).sort({ createdAt: -1 }).lean().catch(() => []);
    // The department NAME, not just its id: the page shows which slice of the
    // company a schedule covers, and the frontend has no business resolving
    // ids against a collection it does not own.
    const names = await loadDepartments({ companyId });
    return (rows || []).map((row) => toScheduleView(row, names));
  };

  const toScheduleView = (row = {}, departmentNames = null) => ({
    _id: row._id,
    name: row.name || '',
    reportKey: row.reportKey || '',
    reportLabel: REPORT_LABELS[row.reportKey] || row.reportKey || '',
    format: row.format || 'XLSX',
    frequency: row.frequency || 'MONTHLY',
    dayOfMonth: row.dayOfMonth || 1,
    departmentId: row.departmentId ? String(row.departmentId) : '',
    department: row.departmentId ? departmentNames?.get(String(row.departmentId)) || '' : '',
    designation: row.designation || '',
    notifyPermission: row.notifyPermission || '',
    active: Boolean(row.active),
    nextRunAt: row.nextRunAt || null,
    lastRunAt: row.lastRunAt || null,
    lastRunStatus: row.lastRunStatus || '',
    lastFileId: row.lastFileId ? String(row.lastFileId) : '',
    lastFilename: row.lastFilename || '',
    lastError: row.lastError || '',
    runCount: row.runCount || 0,
    createdByName: row.createdByName || '',
    createdAt: row.createdAt || null,
  });

  const createSchedule = async ({
    companyId,
    name = '',
    reportKey = 'OVERVIEW',
    format = 'XLSX',
    frequency = 'MONTHLY',
    dayOfMonth = 1,
    departmentId = '',
    designation = '',
    notifyPermission = '',
    actor = null,
    req = null,
    canSeeFinancial = true,
  } = {}) => {
    const key = String(reportKey || '').toUpperCase();
    if (!isReportKey(key)) throw ApiError.badRequest(`Unknown report: ${reportKey}`);
    if (!isScheduleFrequency(frequency)) throw ApiError.badRequest('frequency must be MONTHLY, QUARTERLY or YEARLY');
    if (FINANCE_ONLY_REPORTS.includes(key) && !canSeeFinancial) {
      throw ApiError.forbidden('This report is restricted to users with financial analytics access');
    }
    if (!String(name || '').trim()) throw ApiError.badRequest('Give the schedule a name');

    const schedule = await ScheduledReportModel.create({
      companyId,
      name: String(name).trim(),
      reportKey: key,
      format: String(format || 'XLSX').toUpperCase(),
      frequency: String(frequency || 'MONTHLY').toUpperCase(),
      dayOfMonth: Math.min(31, Math.max(1, Number(dayOfMonth) || 1)),
      departmentId: departmentId || null,
      designation: designation || '',
      notifyPermission: notifyPermission || '',
      active: true,
      nextRunAt: nextRunAt({ from: new Date(), frequency, dayOfMonth }),
      createdBy: actor?._id || null,
      createdByName: actor?.name || '',
    });

    await enqueueSchedule({ schedule });

    await writeAudit({
      req,
      action: ANALYTICS_AUDIT_ACTIONS.SCHEDULE_CREATED,
      companyId,
      actor,
      reportKey: key,
      metadata: { scheduleId: String(schedule._id), name: schedule.name, frequency: schedule.frequency, format: schedule.format },
    });

    return toScheduleView(schedule);
  };

  const updateSchedule = async ({ companyId, scheduleId, actor = null, req = null, patch = {} } = {}) => {
    const schedule = await ScheduledReportModel.findOne({ _id: scheduleId, companyId });
    if (!schedule) throw ApiError.notFound('Scheduled report not found');

    const before = { active: schedule.active, frequency: schedule.frequency, dayOfMonth: schedule.dayOfMonth };

    if (patch.active !== undefined) schedule.active = Boolean(patch.active);
    if (patch.name) schedule.name = String(patch.name).trim();
    if (patch.format) schedule.format = String(patch.format).toUpperCase();
    if (patch.frequency && isScheduleFrequency(patch.frequency)) {
      schedule.frequency = String(patch.frequency).toUpperCase();
      schedule.nextRunAt = nextRunAt({ from: new Date(), frequency: schedule.frequency, dayOfMonth: schedule.dayOfMonth });
    }
    if (patch.dayOfMonth !== undefined) {
      schedule.dayOfMonth = Math.min(31, Math.max(1, Number(patch.dayOfMonth) || 1));
      schedule.nextRunAt = nextRunAt({ from: new Date(), frequency: schedule.frequency, dayOfMonth: schedule.dayOfMonth });
    }
    if (patch.notifyPermission !== undefined) schedule.notifyPermission = String(patch.notifyPermission || '');

    await schedule.save();

    // Re-arming a paused schedule must put a job back in the queue.
    if (schedule.active && !before.active) await enqueueSchedule({ schedule });

    await writeAudit({
      req,
      action: ANALYTICS_AUDIT_ACTIONS.SCHEDULE_UPDATED,
      companyId,
      actor,
      reportKey: schedule.reportKey,
      metadata: { scheduleId: String(schedule._id), previousValue: before, newValue: { active: schedule.active, frequency: schedule.frequency, dayOfMonth: schedule.dayOfMonth } },
    });

    return toScheduleView(schedule);
  };

  const deleteSchedule = async ({ companyId, scheduleId, actor = null, req = null } = {}) => {
    const schedule = await ScheduledReportModel.findOne({ _id: scheduleId, companyId });
    if (!schedule) throw ApiError.notFound('Scheduled report not found');

    await ScheduledReportModel.deleteOne({ _id: scheduleId, companyId }).catch(() => null);

    await writeAudit({
      req,
      action: ANALYTICS_AUDIT_ACTIONS.SCHEDULE_DELETED,
      companyId,
      actor,
      reportKey: schedule.reportKey,
      metadata: { scheduleId: String(scheduleId), name: schedule.name },
    });

    return { scheduleId: String(scheduleId), deleted: true };
  };

  const enqueueSchedule = async ({ schedule }) => {
    if (!schedule?.active || !schedule.nextRunAt) return { queued: false };
    const delay = Math.max(0, new Date(schedule.nextRunAt).getTime() - Date.now());
    return dispatchSchedule({
      companyId: String(schedule.companyId),
      scheduleId: String(schedule._id),
      delay,
    }).catch(() => ({ queued: false }));
  };

  /**
   * §20 — where the NEXT run is counted from.
   *
   * From the run we just performed, never from "now": a schedule executed by
   * hand on the 20th must still fire on the 3rd of next month, not on the 3rd
   * of this month all over again. Behind by more than a period (worker down),
   * it catches up from today instead of replaying every missed month in a
   * burst.
   */
  const armFrom = (schedule) => {
    const due = schedule?.nextRunAt ? new Date(schedule.nextRunAt).getTime() : 0;
    return new Date(Math.max(due, Date.now()));
  };

  /**
   * §20 — what the worker runs. It builds the file, tells the audience, and
   * arms the next occurrence — the schedule is stored in MongoDB, so a Redis
   * restart cannot silently stop a CFO's monthly report.
   */
  const runSchedule = async ({ companyId, scheduleId, actor = null, onProgress = null } = {}) => {
    const schedule = await ScheduledReportModel.findOne({ _id: scheduleId, companyId });
    if (!schedule) throw ApiError.notFound('Scheduled report not found');
    if (!schedule.active) return { skipped: true, reason: 'Schedule is paused' };

    // §20 — a monthly schedule that fires on the 3rd is reporting on the
    // month that just closed, not on the month that has barely started.
    const month = previousMonthOf(new Date().toISOString().slice(0, 7));

    const file = await AnalyticsReportFileModel.create({
      companyId,
      reportKey: schedule.reportKey,
      format: schedule.format,
      period: 'MONTHLY',
      month,
      departmentId: schedule.departmentId || null,
      designation: schedule.designation || '',
      scheduledReportId: schedule._id,
      filename: reportFilename({ reportKey: schedule.reportKey, month, format: schedule.format }),
      status: 'QUEUED',
      requestedBy: schedule.createdBy || null,
      requestedByName: schedule.createdByName || '',
    });

    try {
      const built = await runExport({
        companyId,
        fileId: String(file._id),
        actor: actor || null,
        canSeeFinancial: true,
        onProgress,
      });

      schedule.lastRunAt = new Date();
      schedule.lastRunStatus = 'SUCCESS';
      schedule.lastFileId = file._id;
      schedule.lastFilename = built.filename || '';
      schedule.lastError = '';
      schedule.runCount = Number(schedule.runCount || 0) + 1;
      schedule.nextRunAt = nextRunAt({ from: armFrom(schedule), frequency: schedule.frequency, dayOfMonth: schedule.dayOfMonth });
      await schedule.save();

      await writeAudit({
        action: ANALYTICS_AUDIT_ACTIONS.SCHEDULE_EXECUTED,
        companyId,
        actor,
        reportKey: schedule.reportKey,
        metadata: { scheduleId: String(schedule._id), fileId: String(file._id), filename: built.filename, rows: built.rows },
      });

      // §22 — "Scheduled Report Generated → HR": whoever holds the permission
      // at run time, not whoever happened to be listed when it was created.
      if (schedule.notifyPermission) {
        await notifyRoles({
          companyId,
          permission: schedule.notifyPermission,
          payload: {
            reportLabel: REPORT_LABELS[schedule.reportKey] || schedule.reportKey,
            filename: built.filename,
            fileId: String(file._id),
            scheduleName: schedule.name,
          },
        }).catch(() => 0);
      }

      await enqueueSchedule({ schedule });

      return {
        scheduleId: String(schedule._id),
        fileId: String(file._id),
        filename: built.filename,
        rows: built.rows,
        status: 'READY',
      };
    } catch (error) {
      schedule.lastRunAt = new Date();
      schedule.lastRunStatus = 'FAILED';
      schedule.lastError = error?.message || 'Scheduled report failed';
      // A failure must not stop the schedule forever: arm the next run.
      schedule.nextRunAt = nextRunAt({ from: armFrom(schedule), frequency: schedule.frequency, dayOfMonth: schedule.dayOfMonth });
      await schedule.save();
      await enqueueSchedule({ schedule });
      throw error;
    }
  };

  /** Called on startup / by ops: anything whose time has come. */
  const runDueSchedules = async ({ now = new Date() } = {}) => {
    const due = await ScheduledReportModel.find({
      active: true,
      nextRunAt: { $lte: now },
    })
      .select('_id companyId')
      .lean()
      .catch(() => []);

    const results = [];
    for (const row of due || []) {
      results.push(
        runSchedule({ companyId: row.companyId, scheduleId: String(row._id) })
          .then((value) => ({ scheduleId: String(row._id), ok: true, ...value }))
          .catch((error) => ({ scheduleId: String(row._id), ok: false, error: error?.message || 'failed' })),
      );
    }
    return Promise.all(results);
  };

  // ── §22 — executive dashboard refresh ────────────────────────────────────

  const requestRefresh = async ({ companyId, month = '', actor = null, req = null } = {}) => {
    await invalidate(companyId, month);

    const dispatched = await dispatchRefresh({
      companyId: String(companyId),
      month: month || '',
      actorId: actor?._id ? String(actor._id) : '',
    }).catch(() => ({ queued: false }));

    await writeAudit({
      req,
      action: ANALYTICS_AUDIT_ACTIONS.DASHBOARD_REFRESHED,
      companyId,
      actor,
      reportKey: 'OVERVIEW',
      metadata: { month: month || '', queued: Boolean(dispatched?.queued) },
    });

    if (dispatched?.queued) return { queued: true, jobId: dispatched.jobId || '' };

    const dashboard = await getDashboard({ companyId, month });
    return { queued: false, dashboard };
  };

  /** What the refresh worker runs: warm the cache and tell the admins. */
  const runRefresh = async ({ companyId, month = '', actor = null, onProgress = null } = {}) => {
    if (onProgress) await onProgress(10);
    const dashboard = await getDashboard({ companyId, month });
    if (onProgress) await onProgress(100);

    // §23 — "Executive Dashboard Updated → Company Admin". There is no
    // Company-Admin-only verb, so this goes to the management audience the
    // brief actually defines: Company Admin and Finance, the two roles that
    // hold PAYROLL_ANALYTICS_FINANCIAL.
    await notifyRoles({
      companyId,
      permission: 'PAYROLL_ANALYTICS_FINANCIAL',
      payload: {
        message: `The executive payroll dashboard for ${monthLabel(dashboard.month || month)} has been refreshed.`,
        month: dashboard.month || month || '',
      },
    }).catch(() => 0);

    return { month: dashboard.month || month || '', employeesPaid: dashboard.kpis?.employeesPaid || 0 };
  };

  // ── audit / notify seams ─────────────────────────────────────────────────

  const writeAudit = async ({ req = null, action, companyId, actor = null, reportKey = '', metadata = {} }) => {
    if (!audit) return null;
    return audit({
      req,
      action,
      companyId,
      actorId: actor?._id || null,
      actorName: actor?.name || '',
      resource: 'PayrollAnalytics',
      resourceId: reportKey || null,
      metadata,
    }).catch(() => null);
  };

  return {
    // reads
    getDashboard,
    getReport,
    getEmployeeHistory,
    listFiles,
    listSchedules,
    // configuration (§8)
    getAnalyticsSettings,
    updateSalaryBands,
    // housekeeping (§38)
    expireFiles,
    // exports
    exportReport,
    downloadExport,
    requestExport,
    runExport,
    downloadFile,
    // schedules
    createSchedule,
    updateSchedule,
    deleteSchedule,
    runSchedule,
    runDueSchedules,
    // refresh
    requestRefresh,
    runRefresh,
    // cache
    invalidate,
    // exposed for the worker / tests
    _internals: { loadRows, buildExport, summariseRows, reportTable, previousMonthOf, paginate, loadBands },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Default wiring (imports last, matching 29.6–29.11: the factory above stays
//  side-effect free so tests can build their own instance).
// ─────────────────────────────────────────────────────────────────────────────

import PayrollResult from '../../models/PayrollResult.js';
import PayrollPayment from '../../models/PayrollPayment.js';
import FinalSettlement from '../../models/FinalSettlement.js';
import Resignation from '../../models/Resignation.js';
import User from '../../models/User.js';
import Department from '../../models/Department.js';
import Company from '../../models/Company.js';
import ScheduledReport from '../../models/ScheduledReport.js';
import AnalyticsReportFile from '../../models/AnalyticsReportFile.js';

import { recordAudit } from '../../utils/securityauditService.js';
import { hasPermission } from '../../utils/permissionService.js';
import notifySmart from '../../utils/notifyPref.js';
import { buildAnalyticsReportPdf } from '../../utils/analyticsPdf.js';
import { resolveCompanyLogo } from '../../utils/companyLogo.js';
import { createHash } from 'node:crypto';

import { invalidateAnalyticsCache, analyticsCacheKey } from './analyticsCache.js';
import { monthLabel } from './statutoryRules.js';
import { dispatchAnalyticsExport, dispatchAnalyticsSchedule, dispatchAnalyticsRefresh } from './analyticsDispatcher.js';
import { buildXlsx, toCsv } from './payrollPaymentRules.js';
import { getOrSetCache } from '../redisCacheService.js';

// §22 / §23 — a scheduled report reaches everyone who currently holds the
// permission, not a frozen list of names: people join, leave and change role.
const notifyPermissionHolders = async ({ companyId, permission, payload = {} }) => {
  if (!companyId || !permission) return 0;
  const users = await User.find({ companyId, status: 'ACTIVE' }).select('_id').lean().catch(() => []);
  let sent = 0;
  for (const user of users || []) {
    const allowed = await hasPermission(user, permission).catch(() => false);
    if (!allowed) continue;
    await notifySmart(String(user._id), {
      // §23 — "Scheduled Report Generated → HR".
      title: 'Scheduled report generated',
      message: `${payload.reportLabel || payload.scheduleName || 'A scheduled payroll report'} is ready to download.`,
      link: '/app/payroll/analytics',
      category: 'PAYROLL',
      metadata: { type: 'ANALYTICS_SCHEDULE_GENERATED', ...payload },
    }).catch(() => null);
    sent += 1;
  }
  return sent;
};

const defaultService = makeAnalyticsService({
  PayrollResultModel: PayrollResult,
  PayrollPaymentModel: PayrollPayment,
  FinalSettlementModel: FinalSettlement,
  ResignationModel: Resignation,
  UserModel: User,
  DepartmentModel: Department,
  ScheduledReportModel: ScheduledReport,
  AnalyticsReportFileModel: AnalyticsReportFile,
  CompanyModel: Company,

  cache: {
    buildKey: analyticsCacheKey,
    getOrSet: getOrSetCache,
    invalidate: invalidateAnalyticsCache,
  },

  audit: recordAudit,
  notify: ({ userId, payload }) =>
    notifySmart(userId, {
      // §23 — "Monthly Payroll Report Ready → Finance".
      title: 'Payroll report ready',
      message: payload?.message || 'A payroll report is ready to download.',
      link: '/app/payroll/analytics',
      category: 'PAYROLL',
      metadata: { type: 'ANALYTICS_REPORT_READY', ...payload },
    }),
  notifyRoles: notifyPermissionHolders,

  dispatchExport: dispatchAnalyticsExport,
  dispatchSchedule: dispatchAnalyticsSchedule,
  dispatchRefresh: dispatchAnalyticsRefresh,

  renderPdf: async (options) =>
    buildAnalyticsReportPdf({ ...options, logo: await resolveCompanyLogo(options?.company?.logoUrl) }),

  buildCsv: toCsv,
  buildWorkbook: buildXlsx,

  hash: (value) =>
    createHash('sha256')
      .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8'))
      .digest('hex'),
});

export const analyticsService = defaultService;
export default defaultService;
