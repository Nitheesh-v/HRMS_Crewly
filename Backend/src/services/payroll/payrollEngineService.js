// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.6 — PAYROLL ENGINE SERVICE (tenant-safe orchestration)
//
//  Write order: validate → authorize (route) → tenant → dependencies → save
//  → invalidate cache → audit.
//
//  REDIS (§25): reuses the Phase 28.7 redisCacheService with the project's
//  tenant key convention; the month is a key segment. MongoDB is the source
//  of truth.
//
//  BULLMQ (§26): the run is dispatched to the reserved `payroll` queue and
//  executed by the dedicated worker process, reporting progress as it goes.
//  When Redis is not configured the API — which by 28.1 policy runs without
//  Redis — executes the same loop inline so payroll is never blocked by
//  infrastructure.
//
//  IMMUTABILITY (§19): results are versioned. A recalculation writes v(n+1)
//  and marks it current; v(n) is never touched.
//
//  Dependency injection keeps the hermetic suite free of MongoDB and Redis.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import {
  calculateEmployeePayroll,
  precheckCompany,
  precheckEmployee,
  summarizeRun,
} from './payrollEngineRules.js';
import { computeStructurePreview } from './salaryStructureRules.js';
import { financialYearOf, isValidMonth, monthBounds } from './monthlyInputRules.js';

export const CACHE_NAMESPACE = 'payroll-run';
export const CACHE_VERSION = 1;

const MIN_CACHE_TTL_SECONDS = 10;
const MAX_CACHE_TTL_SECONDS = 3600;
const DEFAULT_CACHE_TTL_SECONDS = 300;

export const getPayrollRunCacheTtlSeconds = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.PAYROLL_RUN_CACHE_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, parsed));
};

// How many financial-year months remain, TDS spreading (§15).
const monthsRemainingInYear = (month, financialYearStartMonth = 4) => {
  const [, monthNumber] = String(month).split('-').map(Number);
  const start = Number(financialYearStartMonth) || 4;
  const position = ((monthNumber - start + 12) % 12) + 1; // 1..12
  return Math.max(1, 13 - position);
};

export const makePayrollEngineService = ({
  PayrollRunModel,
  PayrollResultModel,
  PayrollPeriodModel,
  EmployeeMonthlyInputModel,
  EmployeePayrollProfileModel,
  SalaryStructureModel,
  SalaryComponentModel,
  PayrollSetupModel,
  UserModel,
  cache = {},
  audit = async () => null,
  notify = async () => null,
  dispatch = async () => ({ queued: false }),
  ttlSeconds = getPayrollRunCacheTtlSeconds(),
} = {}) => {
  const buildCacheKey = (companyId, month, suffix = 'summary') => {
    const builder = cache.buildKey;
    if (typeof builder !== 'function') return null;
    return builder({
      companyId,
      namespace: CACHE_NAMESPACE,
      version: CACHE_VERSION,
      segments: [String(month || 'current'), suffix],
    });
  };

  const invalidate = async (companyId, month) => {
    if (typeof cache.del !== 'function') return false;
    const keys = ['summary', 'results', 'errors']
      .map((suffix) => buildCacheKey(companyId, month, suffix))
      .filter(Boolean);
    if (!keys.length) return false;
    try {
      await Promise.all(keys.map((key) => cache.del(key)));
      return true;
    } catch {
      return false;
    }
  };

  const writeAudit = async (payload) => {
    try {
      await audit(payload);
    } catch {
      // Auditing must never break a payroll run.
    }
  };

  const notifySmart = async (payload) => {
    try {
      await notify(payload);
    } catch {
      // Notifications are best-effort.
    }
  };

  // ── reads ────────────────────────────────────────────────────────────────

  const loadSetup = async (companyId) =>
    PayrollSetupModel
      ? PayrollSetupModel.findOne({ companyId }).lean()
      : null;

  const loadComponents = async (companyId) => {
    if (!SalaryComponentModel) return [];
    return SalaryComponentModel.find({ companyId, status: 'ACTIVE', isCurrent: true }).lean();
  };

  const getRun = async ({ companyId, month }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');
    return PayrollRunModel.findOne({ companyId, month }).lean();
  };

  const listRuns = async ({ companyId, limit = 12 }) =>
    PayrollRunModel.find({ companyId }).sort({ month: -1 }).limit(limit).lean();

  const listResults = async ({ companyId, month, status = 'ALL', search = '', allowedEmployeeIds = null }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');

    const filter = { companyId, month, isCurrent: true };
    if (Array.isArray(allowedEmployeeIds)) filter.employeeId = { $in: allowedEmployeeIds };
    if (status !== 'ALL') filter.status = status;

    const rows = await PayrollResultModel.find(filter).lean();
    const needle = String(search || '').trim().toLowerCase();

    return needle
      ? rows.filter((row) =>
          [row.employeeName, row.employeeCode].join(' ').toLowerCase().includes(needle),
        )
      : rows;
  };

  const getResult = async ({ companyId, month, employeeId }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');
    return PayrollResultModel.findOne({ companyId, month, employeeId, isCurrent: true }).lean();
  };

  // §23 — the dashboard reads through the cache, the run writes it.
  // §23 — read-through cache with the house contract:
  // getOrSet(key, { ttlSeconds, version, loader }) → { value, cache }.
  const readThrough = async (key, loader) => {
    if (!key || typeof cache.getOrSet !== 'function') {
      return { value: await loader(), cache: 'BYPASS' };
    }
    try {
      return await cache.getOrSet(key, { ttlSeconds, version: CACHE_VERSION, loader });
    } catch {
      return { value: await loader(), cache: 'BYPASS' };
    }
  };

  const getRunSummary = async ({ companyId, month }) => {
    const key = buildCacheKey(companyId, month, 'summary');
    const { value, cache: outcome } = await readThrough(key, async () => {
      const run = await PayrollRunModel.findOne({ companyId, month }).lean();
      const results = await PayrollResultModel.find({ companyId, month, isCurrent: true }).lean();
      return { run, summary: run?.summary || summarizeRun(results) };
    });

    return { ...(value || {}), cached: outcome !== 'BYPASS' };
  };

  // ── the calculation itself ───────────────────────────────────────────────

  const calculateOne = async ({ companyId, month, employeeId, setup, components, periods, actor, version, runId }) => {
    const [employee, profile, input] = await Promise.all([
      UserModel.findOne({ _id: employeeId, companyId })
        .select('name email employeeCode department designation status')
        .lean(),
      EmployeePayrollProfileModel.findOne({ companyId, employeeId, isCurrent: true }).lean(),
      EmployeeMonthlyInputModel.findOne({ companyId, month, employeeId }).lean(),
    ]);

    const structure = profile?.structureId
      ? await SalaryStructureModel.findOne({ companyId, _id: profile.structureId }).lean()
      : null;

    // §22 — a broken employee is an ERROR row, never a thrown exception that
    // would abort the whole run.
    const issues = precheckEmployee({
      employee,
      profile,
      structure,
      monthlyGross: profile?.monthlyGross || 0,
    });

    if (issues.length) {
      // §22 — the failed employee is PERSISTED, so the error report is a
      // query and not a reconstruction of the last run.
      await PayrollResultModel.updateMany(
        { companyId, month, employeeId, isCurrent: true },
        { $set: { isCurrent: false } },
      );

      const failed = await PayrollResultModel.create({
        companyId,
        employeeId,
        runId: runId || null,
        month,
        version,
        isCurrent: true,
        status: 'ERROR',
        issues,
        warnings: [],
        employeeName: employee?.name || '',
        employeeCode: employee?.employeeCode || '',
        designation: employee?.designation || '',
        departmentId: employee?.department || null,
        structureId: profile?.structureId || null,
        structureName: profile?.structureName || '',
        earnings: [],
        variableEarnings: [],
        reimbursements: [],
        deductions: [],
        employerContributions: [],
        calculatedAt: new Date(),
        calculatedBy: actor?._id || null,
      });

      return {
        status: 'ERROR',
        _id: failed?._id || null,
        employeeId: String(employeeId),
        employeeName: employee?.name || '',
        employeeCode: employee?.employeeCode || '',
        issues,
      };
    }

    const componentMap = Object.fromEntries(
      (components || []).map((component) => [String(component.code || '').toUpperCase(), component]),
    );

    const preview = computeStructurePreview({
      items: structure?.items || [],
      components: componentMap,
      gross: profile.monthlyGross || 0,
    });

    // §15 — TDS spreads the remaining annual tax over the months left, so the
    // engine needs what has already been deducted this financial year.
    const financialYear = financialYearOf(month);
    const priorResults = await PayrollResultModel.find({
      companyId,
      employeeId,
      isCurrent: true,
      month: { $ne: month },
    })
      .select('month statutory')
      .lean();

    const tdsPaidThisYear = priorResults
      .filter((row) => String(row.month) < String(month) && financialYearOf(row.month) === financialYear)
      .reduce((sum, row) => sum + Number(row.statutory?.tds?.monthly || 0), 0);

    const snapshot = calculateEmployeePayroll({
      month,
      employee,
      profile,
      structurePreview: preview,
      structureComponents: componentMap,
      auto: input?.auto || {},
      entries: input?.entries || [],
      setup,
      monthsRemaining: monthsRemainingInYear(
        month,
        setup?.payrollPolicy?.financialYearStartMonth || 4,
      ),
      tdsPaidThisYear,
      declarations: 0,
    });

    const payload = {
      companyId,
      employeeId,
      runId: runId || null,
      month,
      version,
      isCurrent: true,
      status: 'CALCULATED',
      issues: [],
      warnings: snapshot.warnings || [],
      employeeName: snapshot.employeeName,
      employeeCode: snapshot.employeeCode,
      designation: snapshot.designation,
      departmentId: snapshot.departmentId || null,
      structureId: profile.structureId || null,
      structureName: snapshot.structureName,
      earnings: snapshot.earnings,
      variableEarnings: snapshot.variableEarnings,
      overtime: snapshot.overtime,
      reimbursements: snapshot.reimbursements,
      deductions: snapshot.deductions,
      employerContributions: snapshot.employerContributions,
      attendance: snapshot.attendance,
      statutory: snapshot.statutory,
      lop: snapshot.lop,
      payable: snapshot.payable,
      totals: snapshot.totals,
      calculatedAt: new Date(),
      calculatedBy: actor?._id || null,
    };

    // §19 — the previous version stops being current, but is never deleted.
    await PayrollResultModel.updateMany(
      { companyId, month, employeeId, isCurrent: true },
      { $set: { isCurrent: false } },
    );

    try {
      const created = await PayrollResultModel.create(payload);
      return { status: 'CALCULATED', ...payload, _id: created?._id || null };
    } catch (error) {
      // A duplicate version means this employee was already calculated for
      // this run — the existing snapshot wins (idempotent re-run, §26).
      const existing = await PayrollResultModel.findOne({
        companyId,
        month,
        employeeId,
        version,
      }).lean();
      if (existing) return { status: 'CALCULATED', ...existing };
      throw error;
    }
  };

  // The loop shared by the worker and the inline (no-Redis) path.
  const processRun = async ({
    companyId,
    month,
    actor,
    employeeIds = null,
    trigger = 'FULL',
    onProgress = async () => null,
  }) => {
    const run = await PayrollRunModel.findOne({ companyId, month });
    if (!run) throw ApiError.notFound('Payroll run not found');

    const setup = await loadSetup(companyId);
    const period = PayrollPeriodModel
      ? await PayrollPeriodModel.findOne({ companyId, month }).lean()
      : null;

    const companyIssues = precheckCompany({ setup, period });
    if (companyIssues.length) {
      run.status = 'ERROR';
      run.lastError = companyIssues[0];
      run.finishedAt = new Date();
      await run.save();
      await writeAudit({
        action: 'PAYROLL_RUN_FAILED',
        companyId,
        resource: 'PayrollRun',
        resourceId: run._id,
        previousValue: { month },
        newValue: { errors: companyIssues },
      });
      return { status: 'ERROR', errors: companyIssues };
    }

    // Who goes into the run: active employees, narrowed by the caller's
    // payroll scope (§3 / §30 — never another company, never a wider set).
    const employeeFilter = { companyId, status: 'ACTIVE' };
    if (Array.isArray(employeeIds)) employeeFilter._id = { $in: employeeIds };

    const employees = await UserModel.find(employeeFilter).select('_id name').lean();
    const components = await loadComponents(companyId);

    const version = Number(run.version || 0) + 1;
    run.status = 'CALCULATING';
    run.version = version;
    run.startedAt = new Date();
    run.finishedAt = null;
    run.lastError = '';
    run.progress = {
      total: employees.length,
      processed: 0,
      calculated: 0,
      errors: 0,
      currentEmployeeName: '',
      percent: 0,
    };
    await run.save();

    const results = [];

    for (const employee of employees) {
      const outcome = await calculateOne({
        companyId,
        month,
        employeeId: employee._id,
        setup,
        components,
        periods: period,
        actor,
        version,
        runId: run._id,
      });

      results.push(outcome);

      const processed = results.length;
      const errors = results.filter((row) => row.status === 'ERROR').length;
      run.progress = {
        total: employees.length,
        processed,
        calculated: processed - errors,
        errors,
        // §27 — the tracker names the employee currently being calculated.
        currentEmployeeName: employee.name || '',
        percent: employees.length ? Math.round((processed / employees.length) * 100) : 0,
      };
      await run.save();
      await onProgress(run.progress);
    }

    const summary = summarizeRun(results);
    run.summary = summary;
    run.status = results.some((row) => row.status === 'ERROR') && !results.some((row) => row.status === 'CALCULATED')
      ? 'ERROR'
      : Number(run.runCount || 0) > 0
        ? 'RECALCULATED'
        : 'CALCULATED';
    run.runCount = Number(run.runCount || 0) + 1;
    run.finishedAt = new Date();
    run.finishedBy = actor?._id || null;
    run.progress = { ...run.progress, currentEmployeeName: '' };
    await run.save();

    await invalidate(companyId, month);

    await writeAudit({
      action: 'PAYROLL_RUN_COMPLETED',
      companyId,
      resource: 'PayrollRun',
      resourceId: run._id,
      previousValue: { month, trigger },
      newValue: { ...summary, version },
    });

    await notifySmart({
      companyId,
      type: 'PAYROLL_RUN_COMPLETED',
      payload: { month, ...summary },
    });

    return { status: run.status, summary, version };
  };

  // ── starting a run (§5 / §26) ────────────────────────────────────────────

  const startRun = async ({ companyId, month, actor, req, employeeIds = null, trigger = 'FULL' }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');

    const setup = await loadSetup(companyId);
    const period = PayrollPeriodModel
      ? await PayrollPeriodModel.findOne({ companyId, month }).lean()
      : null;

    // §29 — company-level rules stop the run BEFORE any employee is touched.
    const companyIssues = precheckCompany({ setup, period });
    if (companyIssues.length) throw ApiError.badRequest(companyIssues[0], { issues: companyIssues });

    const existing = await PayrollRunModel.findOne({ companyId, month });
    if (existing && existing.status === 'CALCULATING') {
      throw ApiError.badRequest('A payroll run is already in progress for this month');
    }

    const cycle = setup?.payrollPolicy || {};
    const run = existing || (await PayrollRunModel.create({
      companyId,
      month,
      status: 'DRAFT',
      runCount: 0,
      version: 0,
      trigger,
    }));

    run.status = 'DRAFT';
    run.trigger = trigger;
    run.startedBy = actor?._id || null;
    run.cancelledAt = null;
    run.lastError = '';
    run.cycle = {
      financialYear: financialYearOf(month),
      cycleStart: String(cycle.cycleStartDay || ''),
      cycleEnd: String(cycle.cycleEndDay || ''),
      workingDays: Number(period?.workingDays || 0),
      currency: cycle.currency || 'INR',
    };
    await run.save();

    await writeAudit({
      req,
      action: 'PAYROLL_RUN_STARTED',
      companyId,
      resource: 'PayrollRun',
      resourceId: run._id,
      previousValue: null,
      newValue: { month, trigger, employeeCount: Array.isArray(employeeIds) ? employeeIds.length : 'ALL' },
    });

    // §26 — transport. Redis configured → BullMQ job; otherwise the same loop
    // runs inline (the API runs without Redis by 28.1 policy).
    let queued = false;
    let jobId = '';
    try {
      const outcome = await dispatch({
        companyId,
        month,
        runId: String(run._id),
        actorId: actor?._id ? String(actor._id) : null,
        trigger,
        employeeIds: Array.isArray(employeeIds) ? employeeIds.map(String) : null,
      });
      queued = Boolean(outcome?.queued);
      jobId = outcome?.jobId || '';
    } catch (error) {
      queued = false;
    }

    run.queued = queued;
    run.jobId = jobId;
    await run.save();

    if (!queued) {
      await processRun({ companyId, month, actor, employeeIds, trigger });
    }

    await invalidate(companyId, month);

    const fresh = await PayrollRunModel.findOne({ companyId, month }).lean();
    return { run: fresh, queued };
  };

  // §21 — recalculate one employee (or the whole month) as a NEW version.
  const recalculate = async ({ companyId, month, actor, req, employeeIds = null }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');

    const run = await PayrollRunModel.findOne({ companyId, month });
    if (!run) throw ApiError.notFound('No payroll run exists for this month yet');

    const setup = await loadSetup(companyId);
    const period = PayrollPeriodModel
      ? await PayrollPeriodModel.findOne({ companyId, month }).lean()
      : null;
    const companyIssues = precheckCompany({ setup, period });
    if (companyIssues.length) throw ApiError.badRequest(companyIssues[0], { issues: companyIssues });

    const outcome = await processRun({
      companyId,
      month,
      actor,
      employeeIds,
      trigger: Array.isArray(employeeIds) ? 'RECALCULATE_EMPLOYEE' : 'RECALCULATE',
    });

    await invalidate(companyId, month);

    await writeAudit({
      req,
      action: Array.isArray(employeeIds) ? 'PAYROLL_EMPLOYEE_RECALCULATED' : 'PAYROLL_RECALCULATED',
      companyId,
      resource: 'PayrollRun',
      resourceId: run._id,
      previousValue: { month },
      newValue: {
        month,
        employeeIds: Array.isArray(employeeIds) ? employeeIds.map(String) : 'ALL',
        version: outcome.version,
        summary: outcome.summary,
      },
    });

    return outcome;
  };

  // §28 — cancelling stops a queued run before the worker picks it up.
  const cancelRun = async ({ companyId, month, actor, req }) => {
    const run = await PayrollRunModel.findOne({ companyId, month });
    if (!run) throw ApiError.notFound('No payroll run exists for this month');

    run.cancelledAt = new Date();
    run.status = 'DRAFT';
    run.progress = { ...(run.progress || {}), currentEmployeeName: '' };
    await run.save();

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: 'PAYROLL_RUN_CANCELLED',
      companyId,
      resource: 'PayrollRun',
      resourceId: run._id,
      previousValue: { month },
      newValue: { cancelledBy: actor?._id || null },
    });

    return run;
  };

  return {
    startRun,
    processRun,
    recalculate,
    cancelRun,
    getRun,
    listRuns,
    listResults,
    getResult,
    getRunSummary,
    invalidate,
  };
};

import EmployeeMonthlyInput from '../../models/EmployeeMonthlyInput.js';
import EmployeePayrollProfile from '../../models/EmployeePayrollProfile.js';
import PayrollPeriod from '../../models/PayrollPeriod.js';
import PayrollResult from '../../models/PayrollResult.js';
import PayrollRun from '../../models/PayrollRun.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import SalaryComponent from '../../models/SalaryComponent.js';
import SalaryStructureTemplate from '../../models/SalaryStructureTemplate.js';
import User from '../../models/User.js';
import {
  buildTenantCacheKey,
  deleteCache,
  getOrSetCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';
import { recordAudit } from '../../utils/securityauditService.js';
import notifySmart from '../../utils/notifyPref.js';
import { dispatchPayrollRun } from './payrollRunDispatcher.js';

// The notification seam is the same one every payroll phase uses.
const notifyRunComplete = ({ companyId, type, payload }) =>
  notifySmart(companyId, {
    title: 'Payroll run finished',
    message: `${payload?.month || ''}: ${payload?.calculated || 0} calculated, ${
      payload?.errors || 0
    } with errors`,
    category: 'PAYROLL',
    metadata: { type, ...(payload || {}) },
  });

const defaultService = makePayrollEngineService({
  PayrollRunModel: PayrollRun,
  PayrollResultModel: PayrollResult,
  PayrollPeriodModel: PayrollPeriod,
  EmployeeMonthlyInputModel: EmployeeMonthlyInput,
  EmployeePayrollProfileModel: EmployeePayrollProfile,
  SalaryStructureModel: SalaryStructureTemplate,
  SalaryComponentModel: SalaryComponent,
  PayrollSetupModel: PayrollSetup,
  UserModel: User,
  cache: {
    buildKey: buildTenantCacheKey,
    getOrSet: getOrSetCache,
    del: async (key) => {
      const removed = await deleteCache(key);
      if (removed) noteCacheInvalidation();
      return removed;
    },
  },
  audit: recordAudit,
  notify: notifyRunComplete,
  dispatch: dispatchPayrollRun,
});

export default defaultService;
