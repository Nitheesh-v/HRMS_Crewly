// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY COMPLIANCE SERVICE
//
//  Orchestration only: every decision lives in statutoryRules.js, every byte
//  of PDF in utils/statutoryPdf.js, and every figure comes from the immutable
//  29.6 PayrollResult snapshot. Everything external is injected (models,
//  cache, audit, notify, dispatch, pdf, writers) so the whole phase is
//  testable without MongoDB, Redis, BullMQ or SMTP.
//
//  THE LAW OF THIS FILE (§2 / §6 / §24 / §26):
//    · Statutory figures are READ from the 29.6 snapshot, never recomputed.
//    · Reports are prepared only for employees whose salary is PAID.
//    · What is stored is the WORKFLOW (status, filing, attestation), not the
//      numbers — so a payroll recalculation can never leave a stale figure.
//    · Crewly prepares the return. Crewly never files it.
// ═══════════════════════════════════════════════════════════════════════════
import ApiError from '../../utils/ApiError.js';

import {
  ANNUAL_REPORT_KEYS,
  ANNUAL_REPORT_LABELS,
  ANNUAL_TABLES,
  EXPORT_TABLES,
  FILABLE_TYPES,
  FILING_STATUS_LABELS,
  INITIAL_FILING_STATUS,
  NOTIFICATION_TYPES,
  STATUTORY_AUDIT_ACTIONS,
  STATUTORY_TYPE_LABELS,
  annualDepartmentRows,
  annualMonthRows,
  annualiseEmployeeRows,
  applicableTypes,
  buildCalendar,
  buildStatutoryRow,
  canTransitionFiling,
  complianceKpis,
  contentTypes,
  exportFilename,
  financialYearLabel,
  financialYearOf,
  isPaidForStatutory,
  isReportKey,
  isStatutoryType,
  monthLabel,
  monthsOfFinancialYear,
  money,
  normaliseFormat,
  notificationCopy,
  registerFilename,
  registerRows,
  REGISTER_HEADERS,
  reminderCandidates,
  shortMonthLabel,
  statutoryDueDate,
  statutoryGateError,
  summariseStatutoryRows,
  toEmployeeStatutoryView,
} from './statutoryRules.js';
// The dependency-free CSV / XLSX writers 29.8 wrote for the bank file —
// reused here instead of adding a spreadsheet package.
import { buildXlsx, toCsv } from './payrollPaymentRules.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const FY_PATTERN = /^\d{4}-\d{2}$/;

export const getStatutoryCacheTtlSeconds = (source = process.env) => {
  const parsed = Number(source?.PAYROLL_CACHE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 300;
};

export const makeStatutoryService = ({
  StatutoryReportModel,
  StatutoryExportModel = null,
  ComplianceCalendarTaskModel = null,
  PayrollResultModel,
  PayrollPaymentModel,
  PayrollPaymentBatchModel = null,
  PayrollSetupModel,
  EmployeePayrollProfileModel,
  UserModel,
  CompanyModel,
  DepartmentModel = null,
  cache = {},
  audit = async () => null,
  notify = async () => null,
  notifyRoles = async () => 0,
  dispatchGenerate = async () => ({ queued: false }),
  dispatchExport = async () => ({ queued: false }),
  dispatchReminder = async () => ({ queued: false }),
  renderPdf = async () => Buffer.alloc(0),
  buildCsv = toCsv,
  buildWorkbook = buildXlsx,
  hash = () => '',
  ttlSeconds = getStatutoryCacheTtlSeconds(),
} = {}) => {
  // ── cache seam (§20) ─────────────────────────────────────────────────────
  const buildKey = ({ companyId, month = '', suffix = 'dashboard', period = '' } = {}) => {
    if (typeof cache.buildKey !== 'function') return null;
    return cache.buildKey({ companyId, month, suffix, period });
  };

  const readThrough = async (key, loader) => {
    if (!key || typeof cache.getOrSet !== 'function') {
      return { value: await loader(), cache: 'BYPASS' };
    }
    return cache.getOrSet(key, { ttlSeconds, loader });
  };

  const invalidate = async (companyId, month = '') => {
    if (typeof cache.invalidate === 'function') return cache.invalidate(companyId, month);
    return 0;
  };

  // ── audit / notify seams (§22 / §23) ─────────────────────────────────────
  const writeAudit = async ({
    req = null,
    action,
    companyId,
    month = '',
    type = '',
    previousValue = null,
    newValue = null,
    payload = {},
  } = {}) => {
    try {
      return await audit({
        req,
        action,
        companyId,
        resource: 'StatutoryReport',
        resourceId: payload?.reportId || null,
        targetUserId: payload?.employeeId || null,
        previousValue,
        newValue,
        metadata: { month, complianceType: type, ...(payload?.metadata || {}) },
      });
    } catch {
      // §23 — an audit failure must never roll back a compliance action.
      return null;
    }
  };

  const notifyUser = async ({ userId, type, payload = {} }) => {
    if (!userId) return;
    try {
      await notify({ userId, type, payload });
    } catch {
      /* never block on a notification */
    }
  };

  // ── month / FY guards ────────────────────────────────────────────────────
  const assertMonth = (month) => {
    if (!MONTH_PATTERN.test(String(month || ''))) {
      throw ApiError.badRequest('month must look like 2026-08');
    }
    return String(month);
  };

  const assertFinancialYear = (fy) => {
    if (!FY_PATTERN.test(String(fy || ''))) {
      throw ApiError.badRequest('financialYear must look like 2026-27');
    }
    return String(fy);
  };

  // ── §6 — load the month from the 29.6 snapshots ──────────────────────────

  const loadSetup = async (companyId) => {
    const [company, setup] = await Promise.all([
      CompanyModel ? CompanyModel.findById(companyId).lean() : Promise.resolve(null),
      PayrollSetupModel
        ? PayrollSetupModel.findOne({ companyId, isCurrent: true }).lean()
        : Promise.resolve(null),
    ]);
    return { company: company || {}, setup: setup || {} };
  };

  const fyStartOf = (setup = {}) =>
    Number(setup?.payrollPolicy?.financialYearStartMonth) || 4;

  /**
   * The one read every report, KPI card and export is built from.
   *
   * §2 / §6 — the payment gate lives on the 29.8 payment rows: statutory
   * reports are prepared only for employees whose salary was actually paid.
   * A partially paid month still reports everyone who was paid.
   */
  const loadRows = async ({ companyId, month }) => {
    assertMonth(month);
    const { company, setup } = await loadSetup(companyId);

    const batches = PayrollPaymentBatchModel
      ? await PayrollPaymentBatchModel.find({ companyId, month }).lean()
      : [];
    const payments = await PayrollPaymentModel.find({ companyId, month }).lean();
    const paid = (payments || []).filter((payment) => isPaidForStatutory(payment));

    const gateError = statutoryGateError({
      hasBatch: Boolean((batches || []).length) || Boolean((payments || []).length),
      paidCount: paid.length,
      batchStatus: (batches || [])[0]?.status || '',
    });
    if (gateError) throw ApiError.badRequest(gateError);

    const employeeIds = paid.map((payment) => payment.employeeId);

    const [results, profiles, employees] = await Promise.all([
      PayrollResultModel.find({
        companyId,
        month,
        isCurrent: true,
        employeeId: { $in: employeeIds },
      }).lean(),
      EmployeePayrollProfileModel.find({
        companyId,
        employeeId: { $in: employeeIds },
        isCurrent: true,
      }).lean(),
      UserModel.find({ _id: { $in: employeeIds } })
        .select('name employeeCode department designation')
        .lean(),
    ]);

    const departmentIds = [
      ...new Set((employees || []).map((employee) => employee.department).filter(Boolean)),
    ];
    const departments = departmentIds.length && DepartmentModel
      ? await DepartmentModel.find({ _id: { $in: departmentIds } }).select('name').lean()
      : [];
    const departmentNames = new Map(
      (departments || []).map((department) => [String(department._id), department.name || '']),
    );

    const resultByEmployee = new Map((results || []).map((row) => [String(row.employeeId), row]));
    const profileByEmployee = new Map(
      (profiles || []).map((row) => [String(row.employeeId), row]),
    );
    const employeeById = new Map((employees || []).map((row) => [String(row._id), row]));

    const rows = paid
      .map((payment) => {
        const key = String(payment.employeeId);
        const employee = employeeById.get(key) || null;
        const result = resultByEmployee.get(key);
        if (!result) return null;
        return buildStatutoryRow({
          result,
          profile: profileByEmployee.get(key) || {},
          employee: employee || {},
          departmentName:
            (employee && departmentNames.get(String(employee.department))) ||
            payment.departmentName ||
            '',
        });
      })
      .filter(Boolean);

    return {
      company,
      setup,
      rows,
      summary: summariseStatutoryRows({ rows }),
      financialYear: financialYearOf(month, fyStartOf(setup)),
      fyStartMonth: fyStartOf(setup),
      paidCount: paid.length,
      cycle: setup?.payrollPolicy?.frequency || 'MONTHLY',
    };
  };

  const loadStatuses = async ({ companyId, month }) => {
    const rows = await StatutoryReportModel.find({ companyId, month }).lean();
    return (rows || []).map((row) => ({
      type: row.type,
      status: row.status,
      filedAt: row.filedAt || null,
      filingReference: row.filingReference || '',
    }));
  };

  /** §20 — the dashboard read is cached: KPI cards + filing status. */
  const getDashboard = async ({ companyId, month = '' } = {}) => {
    const resolvedMonth = month ? assertMonth(month) : await latestMonth(companyId);
    const key = buildKey({ companyId, month: resolvedMonth, suffix: 'dashboard' });

    const { value } = await readThrough(key, async () => {
      const { summary, financialYear, setup, cycle, paidCount } = await loadRows({
        companyId,
        month: resolvedMonth,
      });
      const statuses = await loadStatuses({ companyId, month: resolvedMonth });
      return {
        month: resolvedMonth,
        monthLabel: monthLabel(resolvedMonth),
        financialYear,
        financialYearLabel: financialYearLabel(financialYear),
        cycle,
        paidCount,
        kpis: complianceKpis({ summary, statuses }),
        summary,
        statuses,
        applicability: applicabilityView(setup),
      };
    });

    return value;
  };

  const latestMonth = async (companyId) => {
    const payments = await PayrollPaymentModel.find({ companyId, status: 'PAID' })
      .select('month')
      .sort({ month: -1 })
      .limit(1)
      .lean();
    const paidMonth = payments?.[0]?.month;
    if (paidMonth && MONTH_PATTERN.test(paidMonth)) return paidMonth;

    const results = await PayrollResultModel.find({ companyId, isCurrent: true })
      .select('month')
      .sort({ month: -1 })
      .limit(1)
      .lean();
    if (results?.[0]?.month && MONTH_PATTERN.test(results[0].month)) return results[0].month;

    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const applicabilityView = (setup = {}) => {
    const statutory = setup?.statutory || {};
    return {
      pf: Boolean(statutory.pf?.applicable),
      esi: Boolean(statutory.esi?.applicable),
      pt: Boolean(statutory.professionalTax?.applicable),
      ptState: statutory.professionalTax?.state || '',
      tds: Boolean(statutory.tds?.applicable),
      lwf: Boolean(statutory.labourWelfareFund?.applicable),
      gratuity: Boolean(statutory.gratuity?.applicable),
    };
  };

  // ── §7–§16 — one report ──────────────────────────────────────────────────

  const getReport = async ({ companyId, month, type } = {}) => {
    const key = String(type || '').toUpperCase();
    if (!isStatutoryType(key)) throw ApiError.badRequest('Unknown statutory report type');

    const resolvedMonth = assertMonth(month);
    const cacheKey = buildKey({ companyId, month: resolvedMonth, suffix: 'report', period: key });

    const { value } = await readThrough(cacheKey, async () => {
      const { summary, rows, financialYear, setup, cycle } = await loadRows({
        companyId,
        month: resolvedMonth,
      });
      const reportRow = await StatutoryReportModel.findOne({
        companyId,
        month: resolvedMonth,
        type: key,
      }).lean();

      const table = EXPORT_TABLES[key];
      const tableRows = table ? table.rows({ rows, summary }) : [];
      const totals = table?.totals ? table.totals({ rows, summary }) : [];

      return {
        type: key,
        typeLabel: STATUTORY_TYPE_LABELS[key] || key,
        month: resolvedMonth,
        monthLabel: monthLabel(resolvedMonth),
        financialYear,
        financialYearLabel: financialYearLabel(financialYear),
        cycle,
        // §11 — a report the company does not have switched on stays hidden
        // rather than rendering an empty table.
        applicable: applicableTypes(setup).includes(key) || key === 'COMPLIANCE_SUMMARY',
        filable: FILABLE_TYPES.includes(key),
        status: reportRow?.status || 'NOT_GENERATED',
        statusLabel:
          FILING_STATUS_LABELS[reportRow?.status] || FILING_STATUS_LABELS.NOT_GENERATED,
        filing: reportRow
          ? {
              filedAt: reportRow.filedAt || null,
              filedByName: reportRow.filedByName || '',
              filingReference: reportRow.filingReference || '',
              filingRemarks: reportRow.filingRemarks || '',
              generatedAt: reportRow.generatedAt || null,
              generatedByName: reportRow.generatedByName || '',
              reviewedAt: reportRow.reviewedAt || null,
              downloadCount: reportRow.downloadCount || 0,
            }
          : null,
        dueDate: statutoryDueDate(key, resolvedMonth, fyStartOf(setup)),
        summary,
        // §10 — the TDS report carries its monthly, FY and department views.
        extras:
          key === 'TDS'
            ? { byDepartment: summary.tds?.byDepartment || [] }
            : key === 'PT'
              ? { byState: summary.pt?.byState || [] }
              : {},
        table: { headers: table?.headers || [], rows: tableRows, totals },
        employeeCount: rows.length,
      };
    });

    return value;
  };

  // ── §6 — generate every applicable report for a month ────────────────────

  // A fingerprint of the figures. If payroll is recalculated AFTER a return
  // was filed, the filed return no longer matches the numbers — so it is
  // reopened rather than silently staying "Filed" (§14 / §20).
  const summaryKey = (summary = {}) =>
    [
      money(summary.employees),
      money(summary.grossPayroll),
      money(summary.netPayroll),
      money(summary.pf?.employees),
      money(summary.pf?.wage),
      money(summary.pf?.employee),
      money(summary.pf?.employer),
      money(summary.pf?.total),
      money(summary.esi?.employees),
      money(summary.esi?.wage),
      money(summary.esi?.employee),
      money(summary.esi?.employer),
      money(summary.esi?.total),
      money(summary.pt?.employees),
      money(summary.pt?.total),
      money(summary.tds?.employees),
      money(summary.tds?.total),
      money(summary.lwf?.employees),
      money(summary.lwf?.employee),
      money(summary.lwf?.employer),
      money(summary.lwf?.total),
      money(summary.gratuity?.employees),
      money(summary.gratuity?.base),
      money(summary.gratuity?.monthly),
    ].join('~');

  const runGeneration = async ({
    companyId,
    month,
    actor = null,
    req = null,
    onProgress = null,
  } = {}) => {
    const resolvedMonth = assertMonth(month);
    const { summary, financialYear, setup, cycle } = await loadRows({
      companyId,
      month: resolvedMonth,
    });

    // The compliance summary is always produced; the rest follow 29.1.
    const types = [...applicableTypes(setup), 'COMPLIANCE_SUMMARY'];
    const fingerprint = summaryKey(summary);
    const generatedAt = new Date();
    const created = [];
    let reopened = 0;

    for (let index = 0; index < types.length; index += 1) {
      const type = types[index];
      if (onProgress) {
        await onProgress({ processed: index, total: types.length, percent: Math.round((index / types.length) * 100) });
      }

      const existing = await StatutoryReportModel.findOne({
        companyId,
        month: resolvedMonth,
        type,
      }).lean();

      // A filed return whose numbers have moved is reopened, not overwritten.
      let status = existing?.status || INITIAL_FILING_STATUS;
      if (existing?.status === 'FILED' && existing.summary && summaryKey(existing.summary) !== fingerprint) {
        status = 'REOPENED';
        reopened += 1;
      }
      const update = {
        $set: {
          financialYear,
          status,
          summary,
          employeeCount: Number(summary.employees || 0),
          generatedAt,
          generatedBy: actor?._id || null,
          generatedByName: actor?.name || '',
          'source.cycle': cycle,
          ...(status === 'REOPENED' ? { reopenedAt: generatedAt } : {}),
        },
        $setOnInsert: {
          companyId,
          month: resolvedMonth,
          type,
        },
      };

      const row = await StatutoryReportModel.findOneAndUpdate(
        { companyId, month: resolvedMonth, type },
        update,
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );

      created.push({ type, status });

      await writeAudit({
        req,
        action: STATUTORY_AUDIT_ACTIONS.GENERATED,
        companyId,
        month: resolvedMonth,
        type,
        previousValue: existing ? { status: existing.status } : null,
        newValue: { status, employees: summary.employees || 0 },
        payload: { reportId: row?._id || null },
      });
    }

    if (onProgress) {
      await onProgress({ processed: types.length, total: types.length, percent: 100 });
    }

    await invalidate(companyId, resolvedMonth);

    return {
      month: resolvedMonth,
      financialYear,
      generated: created.length,
      reopened,
      types: created,
      summary,
    };
  };

  /** §6 / §21 — queued when the worker is up, inline otherwise. */
  const generateForMonth = async ({ companyId, month, actor = null, req = null, queue = true } = {}) => {
    const resolvedMonth = assertMonth(month);

    if (queue) {
      try {
        const { queued, jobId } = await dispatchGenerate({
          companyId,
          month: resolvedMonth,
          actorId: actor?._id || null,
        });
        if (queued) {
          await writeAudit({
            req,
            action: STATUTORY_AUDIT_ACTIONS.GENERATED,
            companyId,
            month: resolvedMonth,
            type: 'ALL',
            newValue: { queued: true, jobId },
          });
          return { queued: true, jobId, month: resolvedMonth };
        }
      } catch {
        // Queue unavailable → fall through to the inline path.
      }
    }

    const result = await runGeneration({ companyId, month: resolvedMonth, actor, req });

    // §22 — "PF Report Generated → Payroll Admin".
    if (actor?._id) {
      await notifyUser({
        userId: actor._id,
        type: NOTIFICATION_TYPES.REPORTS_GENERATED,
        payload: { month: resolvedMonth, count: result.generated },
      });
    }

    return { queued: false, jobId: null, ...result };
  };

  // ── §14 — filing status ──────────────────────────────────────────────────

  const updateFilingStatus = async ({
    companyId,
    month,
    type,
    status,
    filingReference = '',
    filingRemarks = '',
    actor = null,
    req = null,
  } = {}) => {
    const key = String(type || '').toUpperCase();
    const resolvedMonth = assertMonth(month);

    if (!FILABLE_TYPES.includes(key)) {
      throw ApiError.badRequest(
        `${STATUTORY_TYPE_LABELS[key] || key} is a report, not a return — there is nothing to file.`,
      );
    }
    const next = String(status || '').toUpperCase();

    const existing = await StatutoryReportModel.findOne({
      companyId,
      month: resolvedMonth,
      type: key,
    }).lean();

    if (!existing) {
      throw ApiError.badRequest(
        `Generate the ${STATUTORY_TYPE_LABELS[key] || key} report for ${monthLabel(resolvedMonth)} before recording a filing status.`,
      );
    }

    if (!canTransitionFiling(existing.status, next)) {
      throw ApiError.badRequest(
        `A ${FILING_STATUS_LABELS[existing.status] || existing.status} report cannot move to ${FILING_STATUS_LABELS[next] || next}.`,
      );
    }

    const now = new Date();
    const update = {
      $set: {
        status: next,
        ...(filingReference !== undefined && FILABLE_TYPES.includes(key)
          ? { filingReference: String(filingReference || '') }
          : {}),
        ...(filingRemarks !== undefined
          ? { filingRemarks: String(filingRemarks || '').slice(0, 500) }
          : {}),
      },
    };

    if (next === 'FILED') {
      update.$set.filedAt = now;
      update.$set.filedBy = actor?._id || null;
      update.$set.filedByName = actor?.name || '';
    }
    if (next === 'REVIEWED') update.$set.reviewedAt = now;
    if (next === 'REOPENED') {
      update.$set.reopenedAt = now;
      update.$set.filedAt = null;
    }

    const row = await StatutoryReportModel.findOneAndUpdate(
      { companyId, month: resolvedMonth, type: key },
      update,
      { new: true },
    );

    await writeAudit({
      req,
      action:
        next === 'REOPENED'
          ? STATUTORY_AUDIT_ACTIONS.REOPENED
          : STATUTORY_AUDIT_ACTIONS.FILING_UPDATED,
      companyId,
      month: resolvedMonth,
      type: key,
      previousValue: { status: existing.status, filingReference: existing.filingReference || '' },
      newValue: { status: next, filingReference: row?.filingReference || '' },
      payload: { reportId: row?._id || null },
    });

    // §19 — marking a return filed ticks the calendar task off with it.
    if (ComplianceCalendarTaskModel && (next === 'FILED' || next === 'REOPENED')) {
      await ComplianceCalendarTaskModel.updateOne(
        { companyId, month: resolvedMonth, type: key },
        {
          $set: {
            dueDate: statutoryDueDate(key, resolvedMonth, fyStartOf(await setupOf(companyId))),
            ...(next === 'FILED'
              ? {
                  status: 'DONE',
                  completedAt: now,
                  completedBy: actor?._id || null,
                  completedByName: actor?.name || '',
                }
              : { status: 'PENDING', completedAt: null, completedBy: null, completedByName: '' }),
          },
        },
        { upsert: true },
      ).catch(() => null);
    }

    await invalidate(companyId, resolvedMonth);

    // §22 — "Compliance Filed → Company Admin".
    if (next === 'FILED' && typeof notifyRoles === 'function') {
      await notifyRoles({
        companyId,
        permission: 'PAYROLL_STATUTORY_READ',
        type: NOTIFICATION_TYPES.COMPLIANCE_FILED,
        payload: { month: resolvedMonth, type: key },
        excludeUserId: actor?._id || null,
      }).catch(() => 0);
    }

    return {
      type: key,
      month: resolvedMonth,
      status: row?.status || next,
      statusLabel: FILING_STATUS_LABELS[row?.status || next] || next,
      filedAt: row?.filedAt || null,
      filingReference: row?.filingReference || '',
      previousStatus: existing.status,
    };
  };

  const setupOf = async (companyId) => {
    const { setup } = await loadSetup(companyId);
    return setup;
  };

  // ── §13 — the monthly compliance register ────────────────────────────────

  const getRegister = async ({ companyId, financialYear = '' } = {}) => {
    const { setup } = await loadSetup(companyId);
    const fyStart = fyStartOf(setup);
    const fy = financialYear ? assertFinancialYear(financialYear) : '';
    const months = fy ? monthsOfFinancialYear(fy, fyStart) : await reportedMonths(companyId);

    const byMonth = {};
    const statusesByMonth = {};

    for (const month of months) {
      try {
        const { summary } = await loadRows({ companyId, month });
        byMonth[month] = summary;
      } catch {
        // A month nobody was paid in has no statutory data — that is not an
        // error, it is simply an empty row on the register.
        byMonth[month] = {};
      }
      statusesByMonth[month] = await loadStatuses({ companyId, month });
    }

    return {
      financialYear: fy,
      financialYearLabel: financialYearLabel(fy),
      filename: registerFilename({ financialYear: fy }),
      content: buildCsv(
        REGISTER_HEADERS,
        registerRows({ months, byMonth, statusesByMonth, fyStartMonth: fyStart }),
      ),
      count: months.length,
    };
  };

  const reportedMonths = async (companyId) => {
    const months = await PayrollResultModel.distinct('month', { companyId, isCurrent: true });
    return (months || []).filter((month) => MONTH_PATTERN.test(String(month))).sort();
  };

  /** §13 — the JSON view behind the compliance history table. */
  const getHistory = async ({ companyId, financialYear = '' } = {}) => {
    const { setup } = await loadSetup(companyId);
    const fyStart = fyStartOf(setup);
    const fy = financialYear ? assertFinancialYear(financialYear) : '';
    const months = fy ? monthsOfFinancialYear(fy, fyStart) : await reportedMonths(companyId);

    const rows = [];
    for (const month of months) {
      let summary = {};
      try {
        ({ summary } = await loadRows({ companyId, month }));
      } catch {
        summary = {};
      }
      const statuses = await loadStatuses({ companyId, month });
      rows.push({
        month,
        monthLabel: monthLabel(month),
        shortLabel: shortMonthLabel(month),
        financialYear: financialYearOf(month, fyStart),
        employees: Number(summary.employees || 0),
        pf: money(summary.pf?.total),
        esi: money(summary.esi?.total),
        pt: money(summary.pt?.total),
        tds: money(summary.tds?.total),
        lwf: money(summary.lwf?.total),
        gratuity: money(summary.gratuity?.monthly),
        statuses,
        // The register's "Actions" column: what may still be done.
        filable: FILABLE_TYPES.filter((type) => applicableTypes(setup).includes(type)),
      });
    }
    return { financialYear: fy, financialYearLabel: financialYearLabel(fy), rows };
  };

  // ── §15 / §16 — exports ──────────────────────────────────────────────────

  const monthlyExportTables = async ({ companyId, month, reportKey }) => {
    const { summary, rows, setup, financialYear } = await loadRows({ companyId, month });
    const table = EXPORT_TABLES[reportKey];
    if (!table) return null;

    const body = table.rows({ rows, summary }).map((row) => row.map((cell) => cell));
    const totals = table.totals ? table.totals({ rows, summary }) : [];
    return {
      headers: table.headers,
      rows: totals.length ? [...body, totals] : body,
      rowCount: body.length,
      summary,
      setup,
      financialYear,
      periodLabel: monthLabel(month),
    };
  };

  const annualExportTables = async ({ companyId, financialYear, reportKey }) => {
    const { months, summaries, employeeRows, monthRows, setup } = await getAnnualData({
      companyId,
      financialYear,
    });
    const table = ANNUAL_TABLES[reportKey];
    if (!table) return null;

    const body =
      reportKey === 'ANNUAL_PAYROLL_REGISTER' || reportKey === 'ANNUAL_EMPLOYER_CONTRIBUTION'
        ? table.rows({ months: monthRows })
        : reportKey === 'ANNUAL_DEPARTMENT'
          ? table.rows({ rows: annualDepartmentRows({ employeeRows }) })
          : table.rows({ rows: employeeRows });

    return {
      headers: table.headers,
      rows: body,
      rowCount: body.length,
      summary: annualSummary({ summaries }),
      setup,
      financialYear,
      periodLabel: financialYearLabel(financialYear),
      months,
    };
  };

  const annualSummary = ({ summaries = {} } = {}) => {
    const list = Object.values(summaries || {});
    const add = (pick) => money(list.reduce((total, entry) => total + Number(pick(entry) || 0), 0));
    return {
      employees: Math.max(...list.map((entry) => Number(entry?.employees || 0)), 0),
      grossPayroll: add((entry) => entry?.grossPayroll),
      netPayroll: add((entry) => entry?.netPayroll),
      pf: { total: add((entry) => entry?.pf?.total) },
      esi: { total: add((entry) => entry?.esi?.total) },
      pt: { total: add((entry) => entry?.pt?.total) },
      tds: { total: add((entry) => entry?.tds?.total) },
      lwf: { total: add((entry) => entry?.lwf?.total) },
      gratuity: { monthly: add((entry) => entry?.gratuity?.monthly) },
    };
  };

  const buildExport = async ({
    companyId,
    reportKey,
    month = '',
    financialYear = '',
    format = 'CSV',
    actor = null,
    req = null,
  } = {}) => {
    const key = String(reportKey || '').toUpperCase();
    if (!isReportKey(key)) throw ApiError.badRequest('Unknown statutory report');

    const fy = financialYear ? assertFinancialYear(financialYear) : '';
    const resolvedMonth = month ? assertMonth(month) : '';
    const fmt = normaliseFormat(format);
    const isAnnual = ANNUAL_REPORT_KEYS.includes(key);

    if (isAnnual && !fy) {
      throw ApiError.badRequest('An annual report needs a financialYear (for example 2026-27)');
    }
    if (!isAnnual && !resolvedMonth) {
      throw ApiError.badRequest('This report needs a payroll month (for example 2026-08)');
    }

    const built = isAnnual
      ? await annualExportTables({ companyId, financialYear: fy, reportKey: key })
      : await monthlyExportTables({ companyId, month: resolvedMonth, reportKey: key });

    if (!built) throw ApiError.badRequest('Unknown statutory report');
    const { headers, rows, rowCount } = built;

    const title = isAnnual
      ? ANNUAL_REPORT_LABELS[key] || key
      : STATUTORY_TYPE_LABELS[key] || key;

    const filename = exportFilename({
      reportKey: key,
      month: resolvedMonth,
      financialYear: fy,
      format: fmt,
    });

    let content = null;
    if (fmt === 'CSV') {
      content = Buffer.from(buildCsv(headers, rows), 'utf8');
    } else if (fmt === 'XLSX') {
      content = buildWorkbook(headers, rows);
    } else {
      const { company } = await loadSetup(companyId);
      content = await renderPdf({
        company,
        setup: built.setup || {},
        title,
        periodLabel: built.periodLabel,
        headers,
        // The PDF draws its own total row, so it is passed separately.
        rows: rows.slice(0, rowCount),
        totals: rows.length > rowCount ? rows[rows.length - 1] : [],
        kpis: pdfKpis({ key, summary: built.summary }),
        note: isAnnual
          ? `${ANNUAL_REPORT_LABELS[key] || key} · ${financialYearLabel(fy)}`
          : `Payroll month ${monthLabel(resolvedMonth)} · ${built.summary?.employees || 0} employees`,
        meta: {
          status: 'Prepared by Crewly',
          generatedAt: new Date(),
        },
      });
    }

    return {
      filename,
      contentType: contentTypes[fmt] || contentTypes.CSV,
      content,
      rowCount,
      format: fmt,
      reportKey: key,
      month: resolvedMonth,
      financialYear: fy,
    };
  };

  const pdfKpis = ({ key, summary = {} } = {}) => {
    const s = summary || {};
    const rupee = (value) => `Rs ${money(value).toLocaleString('en-IN')}`;
    if (key === 'PF') {
      return [
        { label: 'Employees covered', value: String(s.pf?.employees || 0) },
        { label: 'PF wages', value: rupee(s.pf?.wage) },
        { label: 'Employee PF', value: rupee(s.pf?.employee) },
        { label: 'Employer PF', value: rupee(s.pf?.employer) },
      ];
    }
    if (key === 'ESI') {
      return [
        { label: 'Employees covered', value: String(s.esi?.employees || 0) },
        { label: 'ESI wages', value: rupee(s.esi?.wage) },
        { label: 'Employee ESI', value: rupee(s.esi?.employee) },
        { label: 'Employer ESI', value: rupee(s.esi?.employer) },
      ];
    }
    if (key === 'TDS') {
      return [
        { label: 'Employees', value: String(s.tds?.employees || 0) },
        { label: 'TDS deducted', value: rupee(s.tds?.total) },
        { label: 'Gross payroll', value: rupee(s.grossPayroll) },
        { label: 'Net payroll', value: rupee(s.netPayroll) },
      ];
    }
    if (key === 'LWF') {
      return [
        { label: 'Employees covered', value: String(s.lwf?.employees || 0) },
        { label: 'Employee LWF', value: rupee(s.lwf?.employee) },
        { label: 'Employer LWF', value: rupee(s.lwf?.employer) },
        { label: 'Total LWF', value: rupee(s.lwf?.total) },
      ];
    }
    if (key === 'GRATUITY') {
      return [
        { label: 'Eligible employees', value: String(s.gratuity?.employees || 0) },
        { label: 'Gratuity base', value: rupee(s.gratuity?.base) },
        { label: 'Monthly provision', value: rupee(s.gratuity?.monthly) },
        { label: 'Annualised liability', value: rupee(s.gratuity?.annualised) },
      ];
    }
    if (key === 'PT') {
      return [
        { label: 'Employees', value: String(s.pt?.employees || 0) },
        { label: 'PT collected', value: rupee(s.pt?.total) },
        { label: 'Gross payroll', value: rupee(s.grossPayroll) },
        { label: 'Net payroll', value: rupee(s.netPayroll) },
      ];
    }
    return [
      { label: 'Employees', value: String(s.employees || 0) },
      { label: 'Gross payroll', value: rupee(s.grossPayroll) },
      { label: 'Net payroll', value: rupee(s.netPayroll) },
      { label: 'PF + ESI + PT + TDS', value: rupee(
        Number(s.pf?.total || 0) + Number(s.esi?.total || 0) +
          Number(s.pt?.total || 0) + Number(s.tds?.total || 0),
      ) },
    ];
  };

  /** §23 — every download is an audited action. */
  const downloadExport = async ({ companyId, exportId, actor = null, req = null } = {}) => {
    if (!StatutoryExportModel) throw ApiError.badRequest('Exports are not available');
    const row = await StatutoryExportModel.findOne({ _id: exportId, companyId }).lean();
    if (!row) throw ApiError.notFound('Export not found');
    if (row.status !== 'READY') {
      throw ApiError.badRequest('The export is still being prepared — try again in a moment');
    }

    const withBinary = await StatutoryExportModel.findOne({ _id: exportId, companyId })
      .select('+binary')
      .lean();

    await StatutoryExportModel.updateOne(
      { _id: exportId, companyId },
      { $set: { lastDownloadedAt: new Date() }, $inc: { downloadCount: 1 } },
    );

    await writeAudit({
      req,
      action: STATUTORY_AUDIT_ACTIONS.DOWNLOADED,
      companyId,
      month: row.month || '',
      type: row.reportKey,
      payload: {
        reportId: row._id,
        metadata: { format: row.format, rows: row.rowCount || 0, filename: row.filename },
      },
    });

    return {
      filename: row.filename || 'statutory-report.csv',
      contentType: contentTypes[row.format] || contentTypes.CSV,
      content: withBinary?.binary || Buffer.alloc(0),
      rowCount: row.rowCount || 0,
    };
  };

  /** §15 — the direct, synchronous download used by every report page. */
  const exportNow = async (args) => {
    const built = await buildExport(args);
    await writeAudit({
      req: args?.req || null,
      action: STATUTORY_AUDIT_ACTIONS.DOWNLOADED,
      companyId: args?.companyId,
      month: built.month,
      type: built.reportKey,
      payload: {
        metadata: { format: built.format, rows: built.rowCount, filename: built.filename },
      },
    });
    return built;
  };

  // ── §18 / §21 — the queued path for the genuinely large reports ──────────

  const requestExport = async ({
    companyId,
    month = '',
    financialYear = '',
    reportKey,
    format = 'XLSX',
    actor = null,
    req = null,
    queue = true,
  } = {}) => {
    if (!StatutoryExportModel) throw ApiError.badRequest('Exports are not available');

    const key = String(reportKey || '').toUpperCase();
    if (!isReportKey(key)) throw ApiError.badRequest('Unknown statutory report');
    const fmt = normaliseFormat(format);
    const resolvedMonth = month ? assertMonth(month) : '';
    const fy = financialYear ? assertFinancialYear(financialYear) : '';

    const filename = exportFilename({
      reportKey: key,
      month: resolvedMonth,
      financialYear: fy,
      format: fmt,
    });

    const fileRow = await StatutoryExportModel.create({
      companyId,
      month: resolvedMonth,
      financialYear: fy,
      reportKey: key,
      format: fmt,
      filename,
      status: 'QUEUED',
      requestedBy: actor?._id || null,
      requestedByName: actor?.name || '',
    });

    if (queue) {
      try {
        const { queued, jobId } = await dispatchExport({
          companyId,
          month: resolvedMonth,
          financialYear: fy,
          exportId: String(fileRow._id),
          reportKey: key,
          format: fmt,
          actorId: actor?._id || null,
        });
        if (queued) {
          await StatutoryExportModel.updateOne(
            { _id: fileRow._id, companyId },
            { $set: { jobId, queued: true } },
          );
          return { queued: true, jobId, exportId: String(fileRow._id), filename };
        }
      } catch {
        /* fall through to inline */
      }
    }

    await runExport({ companyId, exportId: String(fileRow._id) });
    return { queued: false, jobId: null, exportId: String(fileRow._id), filename };
  };

  const runExport = async ({ companyId, exportId, onProgress = null } = {}) => {
    if (!StatutoryExportModel) throw ApiError.badRequest('Exports are not available');
    const row = await StatutoryExportModel.findOne({ _id: exportId, companyId }).lean();
    if (!row) throw ApiError.notFound('Export not found');

    await StatutoryExportModel.updateOne(
      { _id: exportId, companyId },
      { $set: { status: 'PROCESSING', progress: 10 } },
    );

    try {
      if (onProgress) await onProgress({ processed: 0, total: 1, percent: 10 });
      const built = await buildExport({
        companyId,
        reportKey: row.reportKey,
        month: row.month || '',
        financialYear: row.financialYear || '',
        format: row.format,
      });
      if (onProgress) await onProgress({ processed: 1, total: 1, percent: 90 });

      const buffer = Buffer.isBuffer(built.content)
        ? built.content
        : Buffer.from(built.content || '');

      await StatutoryExportModel.updateOne(
        { _id: exportId, companyId },
        {
          $set: {
            binary: buffer,
            sizeBytes: buffer.length,
            checksum: hash(buffer),
            rowCount: built.rowCount || 0,
            status: 'READY',
            progress: 100,
            completedAt: new Date(),
            error: '',
          },
        },
      );

      return { exportId: String(exportId), rows: built.rowCount || 0, sizeBytes: buffer.length, status: 'READY' };
    } catch (error) {
      await StatutoryExportModel.updateOne(
        { _id: exportId, companyId },
        { $set: { status: 'FAILED', error: String(error?.message || 'Export failed').slice(0, 300) } },
      );
      throw error;
    }
  };

  const listExports = async ({ companyId, month = '', financialYear = '' } = {}) => {
    if (!StatutoryExportModel) return [];
    const filter = { companyId };
    if (month) filter.month = month;
    if (financialYear) filter.financialYear = financialYear;
    const rows = await StatutoryExportModel.find(filter).sort({ createdAt: -1 }).limit(20).lean();
    return (rows || []).map((row) => ({
      _id: row._id,
      month: row.month || '',
      financialYear: row.financialYear || '',
      reportKey: row.reportKey,
      reportLabel:
        ANNUAL_REPORT_LABELS[row.reportKey] || STATUTORY_TYPE_LABELS[row.reportKey] || row.reportKey,
      format: row.format,
      filename: row.filename,
      status: row.status,
      progress: row.progress || 0,
      rowCount: row.rowCount || 0,
      sizeBytes: row.sizeBytes || 0,
      requestedByName: row.requestedByName || '',
      downloadCount: row.downloadCount || 0,
      createdAt: row.createdAt,
      completedAt: row.completedAt || null,
      error: row.error || '',
      queued: Boolean(row.queued),
    }));
  };

  // ── §18 — annual reports ─────────────────────────────────────────────────

  const getAnnualData = async ({ companyId, financialYear }) => {
    const fy = assertFinancialYear(financialYear);
    const { setup } = await loadSetup(companyId);
    const months = monthsOfFinancialYear(fy, fyStartOf(setup));

    const summaries = {};
    const monthEmployeeRows = [];

    for (const month of months) {
      try {
        const { summary, rows } = await loadRows({ companyId, month });
        summaries[month] = summary;
        monthEmployeeRows.push(...rows);
      } catch {
        // No paid payroll in this month — it simply contributes nothing.
        summaries[month] = {};
      }
    }

    return {
      financialYear: fy,
      months,
      summaries,
      monthRows: annualMonthRows({ months, summaries }),
      employeeRows: annualiseEmployeeRows({ monthRows: monthEmployeeRows }),
      setup,
    };
  };

  const getAnnual = async ({ companyId, financialYear } = {}) => {
    const fy = assertFinancialYear(financialYear);
    const cacheKey = buildKey({ companyId, suffix: 'annual', period: fy });
    const { value } = await readThrough(cacheKey, async () => {
      const { months, summaries, monthRows, employeeRows, setup } = await getAnnualData({
        companyId,
        financialYear: fy,
      });
      return {
        financialYear: fy,
        financialYearLabel: financialYearLabel(fy),
        months: months.map((month) => ({ month, monthLabel: monthLabel(month) })),
        summary: annualSummary({ summaries }),
        registers: monthRows,
        employees: employeeRows,
        departments: annualDepartmentRows({ employeeRows }),
        applicability: applicabilityView(setup),
      };
    });
    return value;
  };

  // ── §19 — the compliance calendar ────────────────────────────────────────

  const getCalendar = async ({ companyId, months = [] } = {}) => {
    const { setup } = await loadSetup(companyId);
    const fyStart = fyStartOf(setup);
    const list = (months || []).filter((month) => MONTH_PATTERN.test(String(month)));

    const cacheKey = buildKey({
      companyId,
      suffix: 'calendar',
      period: `${list[0] || 'all'}-${list[list.length - 1] || 'all'}`,
    });

    const { value } = await readThrough(cacheKey, async () => {
      const statusesByMonth = {};
      const tasksByMonth = {};

      for (const month of list) {
        statusesByMonth[month] = await loadStatuses({ companyId, month });
        tasksByMonth[month] = ComplianceCalendarTaskModel
          ? await ComplianceCalendarTaskModel.find({ companyId, month }).lean()
          : [];
      }

      const today = new Date().toISOString().slice(0, 10);
      const rows = buildCalendar({
        months: list,
        setup,
        statusesByMonth,
        tasksByMonth,
        fyStartMonth: fyStart,
        today,
      });

      return {
        months: list,
        today,
        applicability: applicabilityView(setup),
        rows,
        pending: rows.filter((row) => !row.taskDone && row.status !== 'FILED').length,
        overdue: rows.filter((row) => row.overdue).length,
      };
    });

    return value;
  };

  const updateCalendarTask = async ({
    companyId,
    month,
    type,
    done = true,
    note = '',
    actor = null,
    req = null,
  } = {}) => {
    if (!ComplianceCalendarTaskModel) throw ApiError.badRequest('The calendar is not available');
    const key = String(type || '').toUpperCase();
    if (!isStatutoryType(key)) throw ApiError.badRequest('Unknown statutory report type');
    const resolvedMonth = assertMonth(month);
    const { setup } = await loadSetup(companyId);
    const now = new Date();

    const existing = await ComplianceCalendarTaskModel.findOne({
      companyId,
      month: resolvedMonth,
      type: key,
    }).lean();

    const row = await ComplianceCalendarTaskModel.findOneAndUpdate(
      { companyId, month: resolvedMonth, type: key },
      {
        $set: {
          dueDate: statutoryDueDate(key, resolvedMonth, fyStartOf(setup)),
          status: done ? 'DONE' : 'PENDING',
          completedAt: done ? now : null,
          completedBy: done ? actor?._id || null : null,
          completedByName: done ? actor?.name || '' : '',
          note: String(note || '').slice(0, 300),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    await writeAudit({
      req,
      action: STATUTORY_AUDIT_ACTIONS.CALENDAR_TASK_UPDATED,
      companyId,
      month: resolvedMonth,
      type: key,
      previousValue: { status: existing?.status || 'PENDING' },
      newValue: { status: row?.status || 'PENDING' },
      payload: { reportId: row?._id || null },
    });

    await invalidate(companyId, resolvedMonth);

    return {
      month: resolvedMonth,
      type: key,
      typeLabel: STATUTORY_TYPE_LABELS[key] || key,
      status: row?.status || 'PENDING',
      completedAt: row?.completedAt || null,
      dueDate: row?.dueDate || '',
    };
  };

  /** §22 — "Filing Due Tomorrow → Finance". */
  const sendReminders = async ({ companyId, month = '', actor = null, req = null } = {}) => {
    const { setup } = await loadSetup(companyId);
    const fyStart = fyStartOf(setup);
    const months = month
      ? [assertMonth(month)]
      : (await reportedMonths(companyId)).slice(-3);

    if (!months.length) return { sent: 0, candidates: 0 };

    const today = new Date().toISOString().slice(0, 10);
    const rows = reminderCandidates({
      rows: (
        await getCalendar({ companyId, months })
      ).rows,
    });

    for (const row of rows) {
      await notifyRoles({
        companyId,
        permission: 'PAYROLL_STATUTORY_FILING',
        type: NOTIFICATION_TYPES.FILING_DUE,
        payload: {
          month: row.month,
          type: row.type,
          dueDate: row.dueDate,
          overdue: row.overdue,
        },
        excludeUserId: actor?._id || null,
      }).catch(() => 0);
    }

    if (rows.length) {
      await writeAudit({
        req,
        action: STATUTORY_AUDIT_ACTIONS.REMINDER_SENT,
        companyId,
        month: month || '',
        type: 'ALL',
        newValue: { reminded: rows.length, today },
      });
    }

    return { sent: rows.length, candidates: rows.length, today, fyStartMonth: fyStart };
  };

  /** §21 / §22 — reminders are a background sweep when the worker is up. */
  const requestReminders = async ({
    companyId,
    month = '',
    actor = null,
    req = null,
    queue = true,
  } = {}) => {
    const resolvedMonth = month ? assertMonth(month) : '';

    if (queue) {
      try {
        const { queued, jobId } = await dispatchReminder({
          companyId,
          month: resolvedMonth,
          actorId: actor?._id || null,
        });
        if (queued) {
          await writeAudit({
            req,
            action: STATUTORY_AUDIT_ACTIONS.REMINDER_SENT,
            companyId,
            month: resolvedMonth,
            type: 'ALL',
            newValue: { queued: true, jobId },
          });
          return { queued: true, jobId, sent: 0 };
        }
      } catch {
        // Queue unavailable → run the sweep inline.
      }
    }

    const result = await sendReminders({ companyId, month: resolvedMonth, actor, req });
    return { queued: false, jobId: null, ...result };
  };

  // ── §17 — the employee statutory view ────────────────────────────────────

  const getEmployeeStatutory = async ({ companyId, employeeId, month = '' } = {}) => {
    const { setup } = await loadSetup(companyId);
    const [profile, employee] = await Promise.all([
      EmployeePayrollProfileModel.findOne({ companyId, employeeId, isCurrent: true }).lean(),
      UserModel.findOne({ _id: employeeId, companyId })
        .select('name employeeCode department designation')
        .lean(),
    ]);
    if (!employee) throw ApiError.notFound('Employee not found');

    let currentRow = null;
    const resolvedMonth = month && MONTH_PATTERN.test(month) ? month : await latestMonth(companyId);
    if (resolvedMonth) {
      try {
        const { rows } = await loadRows({ companyId, month: resolvedMonth });
        currentRow = (rows || []).find((row) => String(row.employeeId) === String(employeeId)) || null;
        if (currentRow) currentRow = { ...currentRow, month: resolvedMonth };
      } catch {
        currentRow = null; // no paid payroll yet — the IDs still render
      }
    }

    return toEmployeeStatutoryView({
      profile: profile || {},
      setup,
      employee,
      row: currentRow,
    });
  };

  return {
    // reads
    getDashboard,
    getReport,
    getHistory,
    getRegister,
    getAnnual,
    getCalendar,
    getEmployeeStatutory,
    listExports,
    downloadExport,
    // workflow
    generateForMonth,
    runGeneration,
    updateFilingStatus,
    updateCalendarTask,
    sendReminders,
    requestReminders,
    // exports
    exportNow,
    buildExport,
    requestExport,
    runExport,
    // cache
    invalidate,
    // exposed for the worker / tests
    _internals: { loadRows, loadSetup, summaryKey, fyStartOf, annualSummary },
  };
};


// ─────────────────────────────────────────────────────────────────────────────
//  Default wiring (imports last, matching 29.6–29.9: the factory above stays
//  side-effect free so tests can build their own instance).
// ─────────────────────────────────────────────────────────────────────────────

import StatutoryReport from '../../models/StatutoryReport.js';
import StatutoryExport from '../../models/StatutoryExport.js';
import ComplianceCalendarTask from '../../models/ComplianceCalendarTask.js';
import PayrollResult from '../../models/PayrollResult.js';
import PayrollPayment from '../../models/PayrollPayment.js';
import PayrollPaymentBatch from '../../models/PayrollPaymentBatch.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import EmployeePayrollProfile from '../../models/EmployeePayrollProfile.js';
import User from '../../models/User.js';
import Company from '../../models/Company.js';
import Department from '../../models/Department.js';

import { recordAudit } from '../../utils/securityauditService.js';
import { hasPermission } from '../../utils/permissionService.js';
import notifySmart from '../../utils/notifyPref.js';
import { buildStatutoryPdf } from '../../utils/statutoryPdf.js';
import { resolveCompanyLogo } from '../../utils/companyLogo.js';
import { createHash } from 'node:crypto';

import { invalidateStatutoryCache, statutoryCacheKey } from './statutoryCache.js';
import {
  dispatchStatutoryGenerate,
  dispatchStatutoryExport,
  dispatchComplianceReminder,
} from './statutoryDispatcher.js';
import { getOrSetCache } from '../redisCacheService.js';

// §22 — a compliance notification reaches everyone who can act on it, not a
// hardcoded role list: the company decides who holds the permission.
const notifyPermissionHolders = async ({
  companyId,
  permission,
  type,
  payload = {},
  excludeUserId = null,
}) => {
  const recipients = await User.find({ companyId, status: 'ACTIVE' })
    .select('_id role roleRef department')
    .lean();

  let sent = 0;
  for (const user of recipients || []) {
    if (excludeUserId && String(user._id) === String(excludeUserId)) continue;
    const allowed = await hasPermission({ ...user, companyId }, permission).catch(() => false);
    if (!allowed) continue;
    await notifySmart(user._id, {
      title: 'Statutory Compliance',
      message: notificationCopy(type, payload),
      link: '/app/payroll/statutory',
      category: 'PAYROLL',
      metadata: { type, ...payload },
    }).catch(() => null);
    sent += 1;
  }
  return sent;
};

const defaultService = makeStatutoryService({
  StatutoryReportModel: StatutoryReport,
  StatutoryExportModel: StatutoryExport,
  ComplianceCalendarTaskModel: ComplianceCalendarTask,
  PayrollResultModel: PayrollResult,
  PayrollPaymentModel: PayrollPayment,
  PayrollPaymentBatchModel: PayrollPaymentBatch,
  PayrollSetupModel: PayrollSetup,
  EmployeePayrollProfileModel: EmployeePayrollProfile,
  UserModel: User,
  CompanyModel: Company,
  DepartmentModel: Department,

  cache: {
    buildKey: statutoryCacheKey,
    getOrSet: getOrSetCache,
    invalidate: invalidateStatutoryCache,
  },

  audit: recordAudit,
  notify: ({ userId, type, payload = {} }) =>
    notifySmart(userId, {
      title: 'Statutory Compliance',
      message: notificationCopy(type, payload),
      link: '/app/payroll/statutory',
      category: 'PAYROLL',
      metadata: { type, ...payload },
    }),
  notifyRoles: notifyPermissionHolders,

  dispatchGenerate: dispatchStatutoryGenerate,
  dispatchExport: dispatchStatutoryExport,
  dispatchReminder: dispatchComplianceReminder,

  renderPdf: async (options) =>
    buildStatutoryPdf({ ...options, logo: await resolveCompanyLogo(options?.company?.logoUrl) }),

  hash: (value) =>
    createHash('sha256')
      .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8'))
      .digest('hex'),
});

export const statutoryService = defaultService;
export default defaultService;
