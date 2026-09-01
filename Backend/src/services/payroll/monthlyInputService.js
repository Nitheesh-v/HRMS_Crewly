// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.5 — MONTHLY PAYROLL INPUT SERVICE (tenant-safe persistence)
//
//  Write order: validate → authorize (route) → tenant → dependencies → save
//  → invalidate cache → audit.
//
//  REDIS (§21): reuses the Phase 28 redisCacheService with the project's
//  tenant key convention; the month is a key segment so each payroll month
//  caches independently. MongoDB remains the source of truth.
//
//  BULLMQ (§22): no new queue. The §11 import is parsed by a PURE function
//  with a row cap, and audit / notifications use the existing seams — the
//  same decision taken in 29.3 and 29.4.
//
//  Dependency injection keeps the hermetic suite free of MongoDB and Redis.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import {
  BULK_ACTION_TYPES,
  BULK_ACTIONS,
  CATEGORY_OF,
  ENTRY_TYPES,
  PERIOD_TRANSITIONS,
  computeAutomaticSummary,
  entryTotals,
  financialYearOf,
  isDateInMonth,
  isValidMonth,
  monthBounds,
  monthLabel,
  normalizeEntry,
  parseImportCsv,
  statusFor,
  summarizeMonth,
  validateEmployeeInput,
  validateEntry,
} from './monthlyInputRules.js';

export const CACHE_NAMESPACE = 'payroll-inputs';
export const CACHE_VERSION = 1;

const MIN_CACHE_TTL_SECONDS = 10;
const MAX_CACHE_TTL_SECONDS = 3600;
const DEFAULT_CACHE_TTL_SECONDS = 300;

export const getMonthlyInputCacheTtlSeconds = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.PAYROLL_INPUT_CACHE_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, parsed));
};

const auditSnapshot = (input = {}) => ({
  month: input.month || '',
  status: input.status || '',
  entries: (input.entries || []).map((entry) => ({
    type: entry.type,
    amount: entry.amount,
    reason: entry.reason,
    source: entry.source,
    claimStatus: entry.claimStatus,
  })),
  auto: input.auto || {},
});

export const makeMonthlyInputService = ({
  PayrollPeriodModel,
  EmployeeMonthlyInputModel,
  EmployeePayrollProfileModel,
  UserModel,
  AttendanceModel = null,
  LeaveModel = null,
  HolidayModel = null,
  ShiftModel = null,
  PayrollSetupModel = null,
  cache = {},
  audit = async () => null,
  notify = async () => null,
} = {}) => {
  const buildCacheKey = (companyId, month) => {
    const builder = cache.buildKey;
    if (typeof builder === 'function') {
      return builder({
        companyId,
        namespace: CACHE_NAMESPACE,
        version: CACHE_VERSION,
        segments: [String(month || 'current')],
      });
    }
    return null;
  };

  const invalidate = async (companyId, month) => {
    const key = buildCacheKey(companyId, month);
    if (!key || typeof cache.del !== 'function') return false;
    try {
      return Boolean(await cache.del(key));
    } catch {
      return false;
    }
  };

  const writeAudit = async (payload) => {
    try {
      await audit(payload);
    } catch {
      // Auditing must never break a payroll write.
    }
  };

  const notifySafe = async (payload) => {
    try {
      await notify(payload);
    } catch {
      // Notifications are best-effort.
    }
  };

  // ── period (§6) ──────────────────────────────────────────────────────────

  const loadSetup = async (companyId) => {
    if (!PayrollSetupModel) return null;
    try {
      return await PayrollSetupModel.findOne({ companyId, isCurrent: true })
        .select('payrollCycle weekendPolicy financialYear')
        .lean();
    } catch {
      return null;
    }
  };

  const ensurePeriod = async ({ companyId, month, actor, req }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');

    const existing = await PayrollPeriodModel.findOne({ companyId, month });
    if (existing) return existing;

    const setup = await loadSetup(companyId);
    const { startKey, endKey } = monthBounds(month);

    const period = await PayrollPeriodModel.create({
      companyId,
      month,
      financialYear: financialYearOf(month),
      cycleStart: setup?.payrollCycle?.cycleStart ? `${month}-01` : startKey,
      cycleEnd: setup?.payrollCycle?.cycleEnd ? endKey : endKey,
      workingDays: Number(setup?.payrollCycle?.workingDays || 0),
      status: 'COLLECTING_INPUTS',
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });

    await writeAudit({
      req,
      action: 'PAYROLL_PERIOD_CREATED',
      companyId,
      resource: 'PayrollPeriod',
      resourceId: period._id,
      previousValue: null,
      newValue: { month, financialYear: period.financialYear },
    });

    return period;
  };

  const listPeriods = async ({ companyId }) =>
    PayrollPeriodModel.find({ companyId }).sort({ month: -1 }).limit(24).lean();

  // ── automatic imports (§7 / §14 / §15) ───────────────────────────────────

  const buildAutoSummary = async ({ companyId, employeeId, month }) => {
    const { startKey, endKey } = monthBounds(month);
    const empty = computeAutomaticSummary({ month, workingDays: 0, attendance: [], leaves: [] });

    if (!AttendanceModel) return empty;

    const setup = await loadSetup(companyId);
    const weekendPolicy = setup?.weekendPolicy || {};

    const [attendanceRows, leaveRows, holidayRows] = await Promise.all([
      AttendanceModel.find({ companyId, user: employeeId, date: { $gte: startKey, $lte: endKey } })
        .select('date status lateMinutes overtimeMinutes shift')
        .lean(),
      LeaveModel
        ? LeaveModel.find({ companyId, user: employeeId, status: 'APPROVED' })
            .select('type days startDate endDate status')
            .lean()
        : [],
      HolidayModel ? HolidayModel.find({ companyId }).select('date').lean() : [],
    ]);

    // §7 — shift flags come from the Shift master of THIS company.
    const shiftIds = [...new Set(attendanceRows.map((row) => String(row.shift || '')).filter(Boolean))];
    const shiftDocs = ShiftModel
      ? await ShiftModel.find({ companyId, _id: { $in: shiftIds } })
          .select('type startTime endTime nightAllowance')
          .lean()
      : [];
    const nightShifts = new Set(
      shiftDocs
        .filter(
          (shift) =>
            String(shift.type || '').toUpperCase() === 'NIGHT' ||
            Number(shift.nightAllowance) > 0 ||
            String(shift.startTime || '') > String(shift.endTime || ''),
        )
        .map((shift) => String(shift._id)),
    );

    const shifts = attendanceRows.map((row) => ({
      ...row,
      shiftIsNight: Boolean(row.shift) && nightShifts.has(String(row.shift)),
      weekendPolicy,
    }));

    const leavesInMonth = (leaveRows || []).filter(
      (leave) => isDateInMonth(leave.startDate, month) || isDateInMonth(leave.endDate, month),
    );

    return computeAutomaticSummary({
      month,
      workingDays: Number(setup?.payrollCycle?.workingDays || 0),
      attendance: shifts,
      leaves: leavesInMonth,
      holidays: holidayRows || [],
    });
  };

  const importAutomatic = async ({ companyId, month, actor, req }) => {
    const period = await ensurePeriod({ companyId, month, actor, req });
    if (period.status === 'LOCKED' || period.status === 'SENT_TO_PAYROLL') {
      throw ApiError.badRequest('This payroll month is locked. Reopen it before importing.');
    }

    const employees = await UserModel.find({ companyId, status: 'ACTIVE' })
      .select('_id name employeeCode department')
      .lean();

    let imported = 0;

    await Promise.all(
      employees.map(async (employee) => {
        const auto = await buildAutoSummary({ companyId, employeeId: employee._id, month });
        const input = await EmployeeMonthlyInputModel.findOne({
          companyId,
          month,
          employeeId: employee._id,
        });

        if (input) {
          input.auto = auto;
          input.periodId = period._id;
          input.updatedBy = actor?._id || null;
          await input.save();
        } else {
          await EmployeeMonthlyInputModel.create({
            companyId,
            employeeId: employee._id,
            periodId: period._id,
            month,
            auto,
            entries: [],
            status: 'PENDING',
            createdBy: actor?._id || null,
            updatedBy: actor?._id || null,
          });
        }
        imported += 1;
      }),
    );

    period.attendanceImportedAt = new Date();
    period.leaveImportedAt = new Date();
    period.updatedBy = actor?._id || null;
    await period.save();

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: 'PAYROLL_INPUTS_IMPORTED',
      companyId,
      resource: 'PayrollPeriod',
      resourceId: period._id,
      previousValue: null,
      newValue: { month, employees: imported },
    });

    return { period, imported };
  };

  // ── reads (§9 / §25) ─────────────────────────────────────────────────────

  const listInputs = async ({ companyId, month, query = {}, allowedEmployeeIds = null }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');

    // §4 / §24 — the payroll scope narrows the rows, never widens them.
    const scopeFilter = { companyId, month };
    if (Array.isArray(allowedEmployeeIds)) {
      scopeFilter.employeeId = { $in: allowedEmployeeIds };
    }

    const period = await PayrollPeriodModel.findOne({ companyId, month }).lean();
    const rows = await EmployeeMonthlyInputModel.find(scopeFilter).lean();
    const employees = await UserModel.find({
      companyId,
      _id: { $in: rows.map((row) => row.employeeId) },
    })
      .select('name email employeeCode department designation status')
      .lean();
    const profiles = await EmployeePayrollProfileModel.find({
      companyId,
      employeeId: { $in: rows.map((row) => row.employeeId) },
      isCurrent: true,
    })
      .select('employeeId structureId annualCtc monthlyGross')
      .lean();

    const byEmployee = Object.fromEntries(employees.map((row) => [String(row._id), row]));
    const byProfile = Object.fromEntries(profiles.map((row) => [String(row.employeeId), row]));

    const enriched = rows
      .filter((row) => byEmployee[String(row.employeeId)])
      .map((row) => {
        const employee = byEmployee[String(row.employeeId)] || {};
        const profile = byProfile[String(row.employeeId)] || null;
        const locked = Boolean(row.lockedAt) || period?.status === 'LOCKED' || period?.status === 'SENT_TO_PAYROLL';

        const { issues } = validateEmployeeInput({
          month,
          hasProfile: Boolean(profile),
          hasStructure: Boolean(profile?.structureId),
          employeeActive: employee.status === 'ACTIVE',
          entries: row.entries,
        });

        const totals = entryTotals(row.entries);

        return {
          ...row,
          issues,
          locked,
          status: statusFor({ issues, locked }),
          employeeName: employee.name || '',
          employeeCode: employee.employeeCode || '',
          email: employee.email || '',
          departmentId: employee.department || null,
          designation: employee.designation || '',
          totals,
        };
      });

    const search = String(query.search || '').trim().toLowerCase();
    const filtered = search
      ? enriched.filter((row) =>
          [row.employeeName, row.employeeCode, row.email]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(search),
        )
      : enriched;

    const statusFilter = String(query.status || 'ALL').toUpperCase();
    const visible =
      statusFilter === 'ALL' ? filtered : filtered.filter((row) => row.status === statusFilter);

    return {
      inputs: visible,
      period: period || null,
      summary: summarizeMonth(enriched),
      monthLabel: monthLabel(month),
    };
  };

  const getInput = async ({ companyId, month, employeeId }) => {
    const row = await EmployeeMonthlyInputModel.findOne({ companyId, month, employeeId }).lean();
    const employee = await UserModel.findOne({ _id: employeeId, companyId })
      .select('name email employeeCode department designation status')
      .lean();
    if (!employee) return null;

    const profile = await EmployeePayrollProfileModel.findOne({
      companyId,
      employeeId,
      isCurrent: true,
    })
      .select('structureId structureName annualCtc monthlyGross payrollStatus')
      .lean();

    const period = await PayrollPeriodModel.findOne({ companyId, month }).lean();
    const locked = Boolean(row?.lockedAt) || period?.status === 'LOCKED' || period?.status === 'SENT_TO_PAYROLL';

    const { issues } = validateEmployeeInput({
      month,
      hasProfile: Boolean(profile),
      hasStructure: Boolean(profile?.structureId),
      employeeActive: employee.status === 'ACTIVE',
      entries: row?.entries,
    });

    return {
      ...(row || { auto: {}, entries: [], remarks: '' }),
      month,
      employeeName: employee.name,
      employeeCode: employee.employeeCode || '',
      designation: employee.designation || '',
      departmentId: employee.department || null,
      profile: profile || null,
      issues,
      locked,
      status: statusFor({ issues, locked }),
      totals: entryTotals(row?.entries),
    };
  };

  // ── manual entries (§8 / §16 / §17) ──────────────────────────────────────

  const loadForWrite = async ({ companyId, month, employeeId, actor, req }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');

    const period = await ensurePeriod({ companyId, month, actor, req });
    if (period.status === 'LOCKED' || period.status === 'SENT_TO_PAYROLL') {
      throw ApiError.badRequest('This payroll month is locked. Reopen it before editing inputs.');
    }

    const employee = await UserModel.findOne({ _id: employeeId, companyId }).select('_id status').lean();
    if (!employee) throw ApiError.notFound('Employee not found in your company');

    let input = await EmployeeMonthlyInputModel.findOne({ companyId, month, employeeId });
    if (!input) {
      const auto = await buildAutoSummary({ companyId, employeeId, month });
      input = await EmployeeMonthlyInputModel.create({
        companyId,
        employeeId,
        periodId: period._id,
        month,
        auto,
        entries: [],
        status: 'PENDING',
        createdBy: actor?._id || null,
        updatedBy: actor?._id || null,
      });
    }

    return { input, period };
  };

  const addEntry = async ({ companyId, month, employeeId, entry, actor, req }) => {
    const { input } = await loadForWrite({ companyId, month, employeeId, actor, req });
    const candidate = normalizeEntry({ ...entry, effectiveMonth: month }, input.entries.length);

    const errors = validateEntry(candidate, { month, existing: input.entries });
    if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

    const previous = auditSnapshot(input);
    input.entries.push(candidate);
    input.updatedBy = actor?._id || null;
    await input.save();

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: CATEGORY_OF(candidate.type) === 'REIMBURSEMENT'
        ? 'PAYROLL_REIMBURSEMENT_ADDED'
        : ['DEDUCTION', 'RECOVERY'].includes(CATEGORY_OF(candidate.type))
          ? 'PAYROLL_DEDUCTION_ADDED'
          : 'PAYROLL_BONUS_ADDED',
      companyId,
      resource: 'EmployeeMonthlyInput',
      resourceId: input._id,
      previousValue: previous,
      newValue: auditSnapshot(input),
    });

    return input;
  };

  const updateEntry = async ({ companyId, month, employeeId, entryId, patch, actor, req }) => {
    const { input } = await loadForWrite({ companyId, month, employeeId, actor, req });

    const index = input.entries.findIndex((row) => String(row.entryId) === String(entryId));
    if (index === -1) throw ApiError.notFound('Entry not found');

    const previous = auditSnapshot(input);
    const merged = normalizeEntry(
      { ...(input.entries[index].toObject?.() || input.entries[index]), ...patch },
      index,
    );
    merged.entryId = String(entryId);

    const errors = validateEntry(merged, {
      month,
      existing: input.entries.filter((_, position) => position !== index),
    });
    if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

    input.entries[index] = merged;
    input.updatedBy = actor?._id || null;
    await input.save();

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: 'PAYROLL_INPUT_EDITED',
      companyId,
      resource: 'EmployeeMonthlyInput',
      resourceId: input._id,
      previousValue: previous,
      newValue: auditSnapshot(input),
    });

    return input;
  };

  const removeEntry = async ({ companyId, month, employeeId, entryId, actor, req }) => {
    const { input } = await loadForWrite({ companyId, month, employeeId, actor, req });

    const before = input.entries.length;
    input.entries = input.entries.filter((row) => String(row.entryId) !== String(entryId));
    if (input.entries.length === before) throw ApiError.notFound('Entry not found');

    input.updatedBy = actor?._id || null;
    await input.save();

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: 'PAYROLL_INPUT_EDITED',
      companyId,
      resource: 'EmployeeMonthlyInput',
      resourceId: input._id,
      previousValue: { removed: entryId },
      newValue: auditSnapshot(input),
    });

    return input;
  };

  // ── bulk actions (§12) ───────────────────────────────────────────────────

  const bulkAction = async ({ companyId, month, action, employeeIds = [], payload = {}, actor, req }) => {
    if (!BULK_ACTIONS.includes(action)) throw ApiError.badRequest('Unknown bulk action');

    const period = await ensurePeriod({ companyId, month, actor, req });
    if (period.status === 'LOCKED' || period.status === 'SENT_TO_PAYROLL') {
      throw ApiError.badRequest('This payroll month is locked. Reopen it before running bulk actions.');
    }

    const filter = { companyId, month };
    if (employeeIds.length) filter.employeeId = { $in: employeeIds };

    const rows = await EmployeeMonthlyInputModel.find(filter);
    let touched = 0;

    for (const row of rows) {
      const previous = auditSnapshot(row);

      if (action === 'MARK_ZERO_BONUS') {
        row.entries = row.entries.filter((entry) => CATEGORY_OF(entry.type) !== 'BONUS');
        touched += 1;
      } else if (action === 'REMOVE_IMPORTED_ENTRIES') {
        row.entries = row.entries.filter((entry) => entry.source === 'MANUAL');
        touched += 1;
      } else {
        const type = BULK_ACTION_TYPES[action];
        const entry = normalizeEntry(
          {
            type,
            amount: Number(payload.amount) || 0,
            reason: payload.reason || BULK_ACTION_TYPES[action],
            remarks: payload.remarks || '',
            effectiveMonth: month,
            source: 'BULK_ACTION',
          },
          row.entries.length,
        );

        const errors = validateEntry(entry, { month, existing: row.entries });
        if (errors.length) continue;

        row.entries.push(entry);
        touched += 1;
      }

      row.updatedBy = actor?._id || null;
      await row.save();

      await writeAudit({
        req,
        action: 'PAYROLL_INPUT_BULK_ACTION',
        companyId,
        resource: 'EmployeeMonthlyInput',
        resourceId: row._id,
        previousValue: previous,
        newValue: { ...auditSnapshot(row), bulkAction: action },
      });
    }

    await invalidate(companyId, month);
    return { touched, action };
  };

  // ── import (§11) ─────────────────────────────────────────────────────────

  const previewImport = async ({ companyId, month, content }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');

    const { rows, rejected } = parseImportCsv(content);

    const employees = await UserModel.find({
      companyId,
      employeeCode: { $in: rows.map((row) => row.employeeCode) },
    })
      .select('_id employeeCode name')
      .lean();

    const byCode = Object.fromEntries(
      employees.map((employee) => [String(employee.employeeCode).toUpperCase(), employee]),
    );

    const accepted = [];
    const unknown = new Set();

    rows.forEach((row) => {
      const employee = byCode[row.employeeCode];
      if (!employee) {
        rejected.push({
          line: row.line,
          employeeCode: row.employeeCode,
          message: 'No active employee with this employee code',
        });
        unknown.add(row.employeeCode);
        return;
      }
      accepted.push({ ...row, employeeId: employee._id, employeeName: employee.name });
    });

    return {
      month,
      accepted,
      rejected,
      totals: {
        accepted: accepted.length,
        rejected: rejected.length,
        amount: Math.round(accepted.reduce((sum, row) => sum + row.entry.amount, 0) * 100) / 100,
      },
      unknownCodes: [...unknown],
    };
  };

  const confirmImport = async ({ companyId, month, rows = [], actor, req }) => {
    const period = await ensurePeriod({ companyId, month, actor, req });
    if (period.status === 'LOCKED' || period.status === 'SENT_TO_PAYROLL') {
      throw ApiError.badRequest('This payroll month is locked. Reopen it before importing.');
    }

    let created = 0;

    for (const row of rows) {
      if (!row?.employeeId || !ENTRY_TYPES.includes(row?.entry?.type)) continue;

      const { input } = await loadForWrite({
        companyId,
        month,
        employeeId: row.employeeId,
        actor,
        req,
      });

      const entry = normalizeEntry(
        { ...row.entry, effectiveMonth: month, source: 'BULK_IMPORT' },
        input.entries.length,
      );

      const errors = validateEntry(entry, { month, existing: input.entries });
      if (errors.length) continue;

      input.entries.push(entry);
      input.updatedBy = actor?._id || null;
      await input.save();
      created += 1;
    }

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: 'PAYROLL_INPUT_BULK_IMPORT',
      companyId,
      resource: 'PayrollPeriod',
      resourceId: period._id,
      previousValue: null,
      newValue: { month, created, requested: rows.length },
    });

    return { created, requested: rows.length };
  };

  // ── validate / lock (§19 / §20) ──────────────────────────────────────────

  const validateMonth = async ({ companyId, month, actor, req }) => {
    const { inputs } = await listInputs({ companyId, month });
    const errors = inputs.filter((row) => row.issues.length > 0);

    // ensurePeriod returns the DOCUMENT (listInputs returns a lean row), so
    // the status below is really persisted.
    const period = await ensurePeriod({ companyId, month, actor, req });

    if (period && period.status === 'COLLECTING_INPUTS') {
      period.status = errors.length ? 'COLLECTING_INPUTS' : 'VALIDATED';
      period.validatedAt = new Date();
      period.updatedBy = actor?._id || null;
      await period.save();
      await invalidate(companyId, month);
    }

    await writeAudit({
      req,
      action: 'PAYROLL_INPUTS_VALIDATED',
      companyId,
      resource: 'PayrollPeriod',
      resourceId: period?._id || null,
      previousValue: null,
      newValue: { month, employees: inputs.length, withErrors: errors.length },
    });

    return {
      month,
      total: inputs.length,
      withErrors: errors.length,
      status: period?.status || 'DRAFT',
      errors: errors.map((row) => ({
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        issues: row.issues,
      })),
    };
  };

  const setPeriodStatus = async ({ companyId, month, status, actor, req }) => {
    const wanted = String(status || '').toUpperCase();
    const period = await ensurePeriod({ companyId, month, actor, req });

    if (wanted === 'LOCKED') {
      const report = await validateMonth({ companyId, month, actor, req });
      if (report.withErrors > 0) {
        throw ApiError.badRequest(
          `${report.withErrors} employee(s) still have validation errors. Fix them before locking.`,
        );
      }
    }

    const allowed = (PERIOD_TRANSITIONS[period.status] || []).includes(wanted);
    // Unlocking is the one transition that needs the LOCK permission, and it
    // is only legal from LOCKED (§20).
    const reopening = period.status === 'LOCKED' && wanted === 'COLLECTING_INPUTS';
    if (!allowed && !reopening) {
      throw ApiError.badRequest(`A ${period.status} month cannot become ${wanted}`);
    }

    const previous = { status: period.status };
    period.status = wanted;
    period.updatedBy = actor?._id || null;

    if (wanted === 'LOCKED') {
      period.lockedAt = new Date();
      period.lockedBy = actor?._id || null;
    }
    if (reopening) {
      period.reopenedAt = new Date();
      period.lockedAt = null;
      period.lockedBy = null;
    }
    if (wanted === 'SENT_TO_PAYROLL') period.sentToPayrollAt = new Date();

    await period.save();

    // Locking freezes every employee row for this month.
    await EmployeeMonthlyInputModel.updateMany(
      { companyId, month },
      { $set: { lockedAt: wanted === 'LOCKED' ? new Date() : null } },
    );

    await invalidate(companyId, month);
    await writeAudit({
      req,
      action: reopening ? 'PAYROLL_INPUTS_REOPENED' : `PAYROLL_INPUTS_${wanted}`,
      companyId,
      resource: 'PayrollPeriod',
      resourceId: period._id,
      previousValue: previous,
      newValue: { status: period.status, month },
    });
    await notifySafe({
      companyId,
      type: reopening ? 'PAYROLL_INPUTS_REOPENED' : 'PAYROLL_INPUTS_LOCKED',
      title: reopening ? 'Monthly payroll inputs reopened' : 'Monthly payroll inputs locked',
      message: `${monthLabel(month)} payroll inputs are now ${wanted.toLowerCase().replace(/_/g, ' ')}.`,
    });

    return period;
  };

  return {
    ensurePeriod,
    listPeriods,
    importAutomatic,
    listInputs,
    getInput,
    addEntry,
    updateEntry,
    removeEntry,
    bulkAction,
    previewImport,
    confirmImport,
    validateMonth,
    setPeriodStatus,
    invalidate,
  };
};

import Attendance from '../../models/Attendance.js';
import EmployeeMonthlyInput from '../../models/EmployeeMonthlyInput.js';
import EmployeePayrollProfile from '../../models/EmployeePayrollProfile.js';
import Holiday from '../../models/Holiday.js';
import Leave from '../../models/Leave.js';
import PayrollPeriod from '../../models/PayrollPeriod.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import Shift from '../../models/Shift.js';
import User from '../../models/User.js';
import { recordAudit } from '../../utils/securityauditService.js';
import notifySmart from '../../utils/notifyPref.js';
import {
  buildTenantCacheKey,
  deleteCache,
  getOrSetCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';

// Default instance wired to the real infrastructure (tests build their own).
const monthlyInputService = makeMonthlyInputService({
  PayrollPeriodModel: PayrollPeriod,
  EmployeeMonthlyInputModel: EmployeeMonthlyInput,
  EmployeePayrollProfileModel: EmployeePayrollProfile,
  UserModel: User,
  AttendanceModel: Attendance,
  LeaveModel: Leave,
  HolidayModel: Holiday,
  ShiftModel: Shift,
  PayrollSetupModel: PayrollSetup,
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
  notify: ({ companyId, title, message, type }) =>
    notifySmart(companyId, {
      title,
      message,
      category: 'PAYROLL',
      metadata: { type },
    }),
});

export default monthlyInputService;
