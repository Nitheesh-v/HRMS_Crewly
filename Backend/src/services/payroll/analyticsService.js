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

import {
  ANALYTICS_AUDIT_ACTIONS,
  FINANCE_ONLY_REPORTS,
  REPORT_KEYS,
  REPORT_LABELS,
  REGISTER_HEADERS,
  SALARY_BANDS,
  SCHEDULE_FREQUENCIES,
  TREND_PERIODS,
  analyticsKpis,
  applyFilters,
  bonusRows,
  buildAnalyticsRow,
  ctcRows,
  departmentRows,
  designationRows,
  financialYearMonths,
  headcountMetrics,
  isReportKey,
  isScheduleFrequency,
  isTrendPeriod,
  leaveImpactRows,
  nextRunAt,
  overtimeByDepartment,
  overtimeRows,
  recentMonths,
  registerRows,
  reportFilename,
  reportTable,
  salaryBandRows,
  statutoryLiability,
  summariseRows,
  trendSeries,
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
  CompanyModel = null,

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

  // ── §5 / §6 — the executive dashboard ────────────────────────────────────

  const getDashboard = async ({ companyId, month = '', filters = {}, allowedEmployeeIds = null } = {}) => {
    const key = buildKey({ companyId, month, suffix: 'dashboard', filters });
    const { value } = await readThrough(key, async () => {
      const currentMonth = MONTH_PATTERN.test(String(month || ''))
        ? month
        : await latestMonth({ companyId });

      const months = currentMonth ? [currentMonth] : [];
      const rows = applyFilters({ rows: await loadRows({ companyId, months, allowedEmployeeIds }), ...filters });

      const previousMonth = currentMonth ? previousMonthOf(currentMonth) : '';
      const previousRows = previousMonth
        ? applyFilters({ rows: await loadRows({ companyId, months: [previousMonth], allowedEmployeeIds }), ...filters })
        : [];

      const settlements = await loadSettlements({ companyId, month: currentMonth });

      return {
        month: currentMonth,
        monthLabel: currentMonth || '',
        previousMonth,
        kpis: analyticsKpis({
          rows,
          settlements,
          previous: summariseRows({ rows: previousRows }),
        }),
        summary: summariseRows({ rows }),
        previousSummary: summariseRows({ rows: previousRows }),
        departments: departmentRows({ rows }).slice(0, 8),
        topDepartment: departmentRows({ rows })[0] || null,
        statutory: statutoryLiability({ rows }),
        headcount: await buildHeadcount({ companyId, month: currentMonth, rows, previousRows }),
        settlements: settlements.length,
        // §6 — "Payroll Accuracy": the share of snapshots that calculated
        // cleanly. Warnings do not make a payroll wrong; errors do.
        accuracy: await payrollAccuracy({ companyId, month: currentMonth }),
        availableMonths: recentMonths(currentMonth || currentMonthFallback(), 12),
        generatedAt: new Date(),
      };
    });

    return value;
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

  const previousMonthOf = (month = '') => {
    if (!MONTH_PATTERN.test(String(month || ''))) return '';
    const [year, part] = String(month).split('-').map(Number);
    const index = year * 12 + (part - 1) - 1;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  };

  const loadSettlements = async ({ companyId, month = '' }) => {
    if (!FinalSettlementModel) return [];
    const filter = { companyId };
    if (MONTH_PATTERN.test(String(month || ''))) filter.month = month;
    return FinalSettlementModel.find(filter)
      .select('settlementNumber month status totals')
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

  const buildHeadcount = async ({ companyId, month = '', rows = [], previousRows = [], filters = null }) => {
    const [active, joined, exited] = await Promise.all([
      countActive({ companyId }),
      countJoined({ companyId, month }),
      countExited({ companyId, month }),
    ]);

    const key = buildKey({ companyId, month, suffix: 'headcount', filters });
    const { value } = await readThrough(key, async () =>
      headcountMetrics({ rows, activeEmployees: active, joined, exited, previousRows }),
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
    period = 'MONTHLY',
    financialYear = '',
    departmentId = '',
    designation = '',
    employeeId = '',
    status = '',
    canSeeFinancial = true,
    allowedEmployeeIds = null,
  } = {}) => {
    const key = String(reportKey || 'OVERVIEW').toUpperCase();
    if (!isReportKey(key)) throw ApiError.badRequest(`Unknown report: ${reportKey}`);

    // §16 / §25 — the CTC report is Finance-only. The gate is server-side;
    // hiding the tab is a courtesy, not a control.
    if (FINANCE_ONLY_REPORTS.includes(key) && !canSeeFinancial) {
      throw ApiError.forbidden('This report is restricted to users with financial analytics access');
    }

    const scopeMonths = await resolveMonths({ month, months, financialYear, reportKey: key, companyId });
    const allRows = await loadRows({ companyId, months: scopeMonths, allowedEmployeeIds });
    const rows = applyFilters({ rows: allRows, month, months: scopeMonths, departmentId, designation, employeeId, status });

    // §9 — only the headcount report needs the HR counts, and it is the one
    // report that must not skip them: the active/joined/exited figures live in
    // the employee and resignation collections, not in the payroll snapshot.
    const targetMonth = month || scopeMonths[scopeMonths.length - 1] || '';
    const reportFilters = { month: targetMonth, departmentId, designation, employeeId, status };
    const previousTarget = targetMonth ? previousMonthOf(targetMonth) : '';

    const headcountContext =
      key === 'HEADCOUNT' && targetMonth
        ? await buildHeadcount({
            companyId,
            month: targetMonth,
            rows,
            filters: reportFilters,
            previousRows: previousTarget
              ? applyFilters({
                  rows: await loadRows({ companyId, months: [previousTarget], allowedEmployeeIds }),
                  months: [previousTarget],
                  departmentId,
                  designation,
                  employeeId,
                  status,
                })
              : [],
          })
        : null;

    const payload = buildReportPayload({ reportKey: key, rows, period, months: scopeMonths, headcountContext });

    return {
      reportKey: key,
      label: REPORT_LABELS[key] || key,
      month: month || scopeMonths[scopeMonths.length - 1] || '',
      months: scopeMonths,
      period: isTrendPeriod(period) ? String(period).toUpperCase() : 'MONTHLY',
      financialYear: financialYear || '',
      filters: { departmentId, designation, employeeId, status },
      rowCount: rows.length,
      summary: summariseRows({ rows }),
      ...payload,
    };
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
    reportKey = '',
    companyId,
  }) => {
    if (Array.isArray(months) && months.length) {
      return months.map(String).filter((value) => MONTH_PATTERN.test(value));
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

  const buildReportPayload = ({ reportKey = '', rows = [], period = 'MONTHLY', months = [], headcountContext = null } = {}) => {
    switch (reportKey) {
      case 'DEPARTMENT':
        return { rows: departmentRows({ rows }) };
      case 'DESIGNATION':
        return { rows: designationRows({ rows }) };
      case 'SALARY_BANDS':
        return { rows: salaryBandRows({ rows }), bands: SALARY_BANDS.map((band) => band.label) };
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
    listFiles,
    listSchedules,
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
    _internals: { loadRows, buildExport, summariseRows, reportTable, previousMonthOf },
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
