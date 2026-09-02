// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT (F&F) SERVICE
//
//  Orchestration only: every decision lives in fnfRules.js, every byte of PDF
//  in utils/fnfPdf.js, and every rupee is derived from data the earlier
//  phases own (29.4 profile, 29.5 period, 29.6 snapshot, Exit resignation,
//  Assets, Leave). Everything external is injected (models, cache, audit,
//  notify, dispatch, pdf, writers) so the whole phase is testable without
//  MongoDB, Redis, BullMQ or SMTP.
//
//  THE LAW OF THIS FILE (§3 / §6 / §14 / §24):
//    · companyId is never taken from the request body.
//    · An employee reaches their own settlement and nothing else.
//    · Exit information is COPIED from the Exit module, never edited here.
//    · CLOSED is immutable. Every other change appends to history.
//    · Crewly calculates and records. Crewly does not sign, file or pay.
// ═══════════════════════════════════════════════════════════════════════════
import ApiError from '../../utils/ApiError.js';

import {
  CHECKLIST_ITEMS,
  FNF_AUDIT_ACTIONS,
  FNF_RULES,
  NOTIFICATION_TYPES,
  SETTLEMENT_STATUS_LABELS,
  buildSettlementNumber,
  canTransitionSettlement,
  checklistComplete,
  checklistProgress,
  computeGratuity,
  computeLeaveEncashment,
  computeNoticeRecovery,
  computePayableDays,
  computePendingSalary,
  daysBetween,
  daysInMonth,
  emptyChecklist,
  filterSettlements,
  isNoticeDecision,
  isSettlementEditable,
  isSettlementLocked,
  monthLabel,
  isoDate,
  monthOfDate,
  money,
  normalisePayable,
  normaliseRecovery,
  registerFilename,
  registerRows,
  REGISTER_HEADERS,
  reportFilename,
  settlementKpis,
  settlementTotals,
  sortSettlements,
  statementFilename,
  toEmployeeSettlementView,
  toSettlementCardView,
  transitionError,
  validatePayableItem,
  validateRecoveryItem,
} from './fnfRules.js';
import { financialYearOf } from './statutoryRules.js';
// The dependency-free CSV / XLSX writers 29.8 wrote for the bank file —
// reused here instead of adding a spreadsheet package.
import { buildXlsx, toCsv } from './payrollPaymentRules.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const getFnfCacheTtlSeconds = (source = process.env) => {
  const parsed = Number(source?.PAYROLL_CACHE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 300;
};

const idOf = (value) => (value === null || value === undefined ? '' : String(value));

// §10 — basic pay for gratuity. The 29.6 snapshot is the first choice; the
// 29.4 profile's saved preview breakdown is the fallback when the engine has
// never run for this employee.
const basicFromProfile = (profile = null) => {
  const lines = profile?.breakdown?.earnings;
  if (!Array.isArray(lines)) return 0;
  const basic = lines.find((line) => /BASIC/i.test(String(line?.code || line?.name || '')));
  return money(basic?.amount || 0);
};

export const makeFnfService = ({
  FinalSettlementModel,
  FinalSettlementFileModel = null,
  ResignationModel = null,
  AssetModel = null,
  LeaveModel = null,
  PayrollResultModel = null,
  PayrollPeriodModel = null,
  PayrollSetupModel = null,
  EmployeePayrollProfileModel,
  UserModel,
  CompanyModel,
  DepartmentModel = null,
  cache = {},
  audit = async () => null,
  notify = async () => null,
  notifyRoles = async () => 0,
  dispatchStatement = async () => ({ queued: false }),
  dispatchRegister = async () => ({ queued: false }),
  renderPdf = async () => Buffer.alloc(0),
  buildCsv = toCsv,
  buildWorkbook = buildXlsx,
  hash = () => '',
  leaveQuota = {},
  ttlSeconds = getFnfCacheTtlSeconds(),
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

  const invalidate = async (companyId, month = '', employeeIds = []) => {
    if (typeof cache.invalidate === 'function') {
      return cache.invalidate(companyId, month, employeeIds);
    }
    return 0;
  };

  // ── audit / notify seams (§22 / §23) ─────────────────────────────────────
  const writeAudit = async ({
    req = null,
    action,
    companyId,
    employeeId = null,
    month = '',
    previousStatus = null,
    newStatus = null,
    remarks = '',
    payload = {},
  } = {}) => {
    try {
      return await audit({
        req,
        action,
        companyId,
        resource: 'FinalSettlement',
        resourceId: payload?.settlementId || null,
        targetUserId: employeeId || null,
        previousValue: previousStatus ? { status: previousStatus, ...(payload?.previousValue || {}) } : null,
        newValue: { status: newStatus, month, ...(payload?.newValue || {}) },
        metadata: {
          month,
          settlementNumber: payload?.settlementNumber || '',
          complianceType: 'FNF',
          remarks,
          ...(payload?.metadata || {}),
        },
      });
    } catch {
      // §23 — an audit failure must never roll back a settlement.
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

  const notifyPermission = async ({ permission, type, payload = {}, excludeUserId = null, companyId }) => {
    try {
      return await notifyRoles({ companyId, permission, type, payload, excludeUserId });
    } catch {
      return 0;
    }
  };

  // ── tenant-scoped reads (§3 / §24) ───────────────────────────────────────
  // §3 / §24 — companyId is part of EVERY filter, always. A settlement lookup
  // that omitted it would search every tenant in the collection.
  const withScope = (companyId, filter = {}, allowedEmployeeIds = null) => {
    const scoped = { ...filter, companyId };
    if (Array.isArray(allowedEmployeeIds)) scoped.employeeId = { $in: allowedEmployeeIds };
    return scoped;
  };

  const loadEmployeeRows = async ({ companyId, employeeIds }) => {
    const employees = await UserModel.find({ companyId, _id: { $in: employeeIds } })
      .select('name employeeCode designation department joiningDate email')
      .lean();
    const departmentIds = [...new Set((employees || []).map((row) => row.department).filter(Boolean))];
    const departments = departmentIds.length && DepartmentModel
      ? await DepartmentModel.find({ _id: { $in: departmentIds } }).select('name').lean()
      : [];
    const departmentNames = new Map(
      (departments || []).map((row) => [String(row._id), row.name || '']),
    );

    return new Map(
      (employees || []).map((row) => [
        String(row._id),
        {
          _id: row._id,
          name: row.name || '',
          employeeCode: row.employeeCode || '',
          designation: row.designation || '',
          email: row.email || '',
          departmentId: row.department ? String(row.department) : '',
          departmentName: departmentNames.get(String(row.department)) || '',
          joiningDate: isoDate(row.joiningDate),
        },
      ]),
    );
  };

  const decorate = (row = {}, employeeMap = new Map()) => ({
    ...row,
    employee: employeeMap.get(String(row.employeeId)) || null,
  });

  // ── §7 / §8 / §10 / §12 — recompute one settlement from source data ──────

  const loadSettlementInputs = async ({ companyId, employeeId, month }) => {
    const [employeeDoc, profile, period, resignation] = await Promise.all([
      UserModel.findOne({ _id: employeeId, companyId })
        .select('name employeeCode designation department joiningDate')
        .lean(),
      EmployeePayrollProfileModel
        ? EmployeePayrollProfileModel.findOne({ companyId, employeeId, isCurrent: true }).lean()
        : Promise.resolve(null),
      PayrollPeriodModel
        ? PayrollPeriodModel.findOne({ companyId, month }).lean()
        : Promise.resolve(null),
      ResignationModel
        ? ResignationModel.findOne({ companyId, user: employeeId, status: 'APPROVED' })
          .sort({ decidedAt: -1 })
          .lean()
        : Promise.resolve(null),
    ]);

    // 29.6 snapshot: this month's first, otherwise the most recent one.
    let result = null;
    if (PayrollResultModel) {
      result = await PayrollResultModel.findOne({ companyId, employeeId, month, isCurrent: true }).lean();
      if (!result) {
        result = await PayrollResultModel.findOne({ companyId, employeeId, isCurrent: true })
          .sort({ month: -1 })
          .lean();
      }
    }

    // §8 — unused EARNED leave (quota minus APPROVED days this year).
    let leaveBalance = { byType: {}, unusedEarnedDays: 0 };
    if (LeaveModel) {
      const yearStart = `${String(month).slice(0, 4)}-01-01`;
      const approved = await LeaveModel.find({
        companyId,
        user: employeeId,
        status: 'APPROVED',
        startDate: { $gte: yearStart },
      })
        .select('type days')
        .lean();

      const used = {};
      (approved || []).forEach((row) => {
        const key = String(row.type || '').toUpperCase();
        used[key] = (used[key] || 0) + (Number(row.days) || 0);
      });

      const byType = {};
      Object.keys(leaveQuota || {}).forEach((key) => {
        const quota = Number(leaveQuota[key]) || 0;
        byType[key] = { quota, used: used[key] || 0, balance: Math.max(0, quota - (used[key] || 0)) };
      });
      leaveBalance = { byType, unusedEarnedDays: byType.EARNED?.balance || 0 };
    }

    // §13 — what the employee still holds. Read-only: Crewly never manages
    // assets here, it reports what the Asset module says is outstanding.
    let assets = [];
    if (AssetModel) {
      const held = await AssetModel.find({ companyId, currentHolder: employeeId })
        .select('name category status')
        .lean();
      assets = (held || []).map((row) => ({
        assetId: String(row._id),
        name: row.name || '',
        category: row.category || '',
        // The Asset module tracks AVAILABLE/ASSIGNED only; an asset still in
        // the employee's hands at settlement time is PENDING return.
        status: 'PENDING',
      }));
    }

    return { employeeDoc, profile: profile || null, period: period || null, resignation: resignation || null, result, leaveBalance, assets };
  };

  const computeFigures = ({ inputs = {}, month, lastWorkingDate, noticeDecision = 'COMPLETED', noticePeriodDays = FNF_RULES.notice.defaultDays, previous = null } = {}) => {
    const { profile, period, result, leaveBalance, assets } = inputs;

    const workingDays = Number(period?.workingDays) > 0
      ? Number(period.workingDays)
      : daysInMonth(month);

    const monthlyGross = Number(result?.totals?.gross) > 0
      ? Number(result.totals.gross)
      : Number(profile?.monthlyGross) || 0;

    const monthlyBasic = Number(result?.totals?.basic) > 0
      ? Number(result.totals.basic)
      : basicFromProfile(profile);

    // §7 — LOP already taken in the settlement month reduces payable days.
    const lopDays = String(result?.month || '') === String(month)
      ? Number(result?.attendance?.lopDays) || 0
      : 0;

    const payableDays = computePayableDays({ month, workingDays, lastWorkingDate, lopDays });
    const pendingSalary = computePendingSalary({ monthlyGross, workingDays, payableDays, lopDays });
    const rate = pendingSalary.dailyRate;

    // §8 — leave encashment from the unused EARNED balance.
    const leaveEncashment = computeLeaveEncashment({
      unusedDays: leaveBalance?.unusedEarnedDays || 0,
      dailyRate: rate,
      leaveType: 'EARNED',
      maxDays: FNF_RULES.leaveEncashment.maxDays,
    });

    // §10 / §11 — gratuity on exit.
    const joiningDate = isoDate(inputs?.employeeDoc?.joiningDate) || isoDate(profile?.joiningDate);
    const gratuity = computeGratuity({
      monthlyBasic,
      joiningDate,
      lastWorkingDate,
      eligible: Boolean(profile?.statutory?.gratuityEligible),
    });

    // §12 — notice served vs notice required.
    const resignationDate = previous?.exit?.resignationDate || '';
    const servedDays = resignationDate ? daysBetween(resignationDate, lastWorkingDate) : 0;
    const notice = computeNoticeRecovery({
      decision: noticeDecision,
      noticePeriodDays,
      servedDays,
      dailyRate: rate,
    });

    // §10 — SYSTEM payables are rebuilt on every recalculation; the manual
    // ones HR/Payroll entered are preserved exactly as typed.
    const manualPayables = (previous?.earnings?.additional || []).filter((item) => item?.source !== 'SYSTEM');
    const systemPayables = [];
    if (leaveEncashment.amount > 0) {
      systemPayables.push(normalisePayable({
        type: 'LEAVE_ENCASHMENT',
        label: `Leave Encashment (${leaveEncashment.encashedDays} day(s))`,
        amount: leaveEncashment.amount,
        note: `${leaveEncashment.encashedDays} day(s) x Rs ${leaveEncashment.dailyRate}`,
        source: 'SYSTEM',
      }));
    }
    if (gratuity.amount > 0) {
      systemPayables.push(normalisePayable({
        type: 'GRATUITY',
        label: `Gratuity (${gratuity.creditedYears} year(s))`,
        amount: gratuity.amount,
        note: gratuity.reason,
        source: 'SYSTEM',
      }));
    }

    const recoveries = previous?.recoveries?.items || [];

    const totals = settlementTotals({
      pendingSalary: pendingSalary.amount,
      additionalPayables: [...systemPayables, ...manualPayables],
      leaveEncashment: leaveEncashment.amount,
      noticeRecovery: notice.amount,
      recoveries,
    });

    return {
      earnings: {
        pendingSalary: {
          monthlyGross: money(monthlyGross),
          workingDays,
          payableDays,
          // §5 — the attendance the calculation used travels with the figure
          // it produced, so the statement can explain 16 payable days out of
          // 31 instead of leaving HR to account for the missing two.
          lopDays: pendingSalary.lopDays,
          dailyRate: rate,
          amount: pendingSalary.amount,
        },
        leaveEncashment,
        gratuity,
        additional: [...systemPayables, ...manualPayables],
      },
      recoveries: { notice, items: recoveries },
      totals,
      leaveBalance,
      assets,
      // §15 — a completed notice decision is a checklist item, so the
      // calculation records whether one was actually made.
      noticeDecided: isNoticeDecision(noticeDecision) && noticeDecision !== '',
    };
  };

  // ── §19 — dashboard ──────────────────────────────────────────────────────

  const getDashboard = async ({ companyId, allowedEmployeeIds = null, month = '' } = {}) => {
    const key = buildKey({ companyId, month, suffix: 'dashboard' });
    const { value } = await readThrough(key, async () => {
      const filter = withScope(companyId, {}, allowedEmployeeIds);
      if (month) filter.month = month;
      const rows = await FinalSettlementModel.find(filter).lean();

      const employeeMap = await loadEmployeeRows({
        companyId,
        employeeIds: (rows || []).map((row) => row.employeeId),
      });

      const decorated = (rows || []).map((row) => decorate(row, employeeMap));
      return {
        kpis: settlementKpis({ rows: decorated }),
        statuses: SETTLEMENT_STATUS_LABELS,
        recent: sortSettlements(decorated).slice(0, 8).map(toSettlementCardView),
        // §19 — the filters the UI offers (search + department).
        departments: [
          ...new Map(
            [...employeeMap.values()]
              .filter((row) => row.departmentId)
              .map((row) => [row.departmentId, { _id: row.departmentId, name: row.departmentName }]),
          ).values(),
        ],
      };
    });

    return value;
  };

  // ── §19 — list / search ──────────────────────────────────────────────────

  const listSettlements = async ({
    companyId,
    search = '',
    status = '',
    departmentId = '',
    month = '',
    allowedEmployeeIds = null,
  } = {}) => {
    const filter = withScope(companyId, {}, allowedEmployeeIds);
    if (status) filter.status = String(status).toUpperCase();
    if (month) filter.month = month;

    const rows = await FinalSettlementModel.find(filter).sort({ updatedAt: -1 }).lean();
    const employeeMap = await loadEmployeeRows({
      companyId,
      employeeIds: (rows || []).map((row) => row.employeeId),
    });

    const decorated = (rows || []).map((row) => decorate(row, employeeMap));
    return sortSettlements(filterSettlements({ rows: decorated, search, status, departmentId })).map(
      toSettlementCardView,
    );
  };

  // ── §25 — one settlement in full ─────────────────────────────────────────

  const getSettlement = async ({ companyId, settlementId, allowedEmployeeIds = null } = {}) => {
    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds)).lean();
    if (!row) throw ApiError.notFound('Final settlement not found');

    const employeeMap = await loadEmployeeRows({ companyId, employeeIds: [row.employeeId] });
    const employee = employeeMap.get(String(row.employeeId)) || null;

    return {
      ...toSettlementCardView(decorate(row, employeeMap)),
      employee: employee || { name: row.exit?.employeeName || '', employeeCode: '' },
      exit: row.exit || {},
      earnings: row.earnings || {},
      recoveries: row.recoveries || {},
      totals: row.totals || settlementTotals({}),
      checklist: row.checklist || emptyChecklist(),
      checklistProgress: checklistProgress(row.checklist || {}),
      checklistItems: CHECKLIST_ITEMS,
      assets: row.assets || [],
      leaveBalance: row.leaveBalance || null,
      approval: row.approval || {},
      payment: row.payment || {},
      statement: row.statement || {},
      history: row.history || [],
      editable: isSettlementEditable(row.status),
      locked: isSettlementLocked(row.status),
      monthLabel: monthLabel(row.month),
    };
  };

  // ── §18 — the employee's own settlement ──────────────────────────────────

  const getMySettlement = async ({ companyId, employeeId } = {}) => {
    const key = buildKey({ companyId, suffix: 'employee', period: String(employeeId) });
    const { value } = await readThrough(key, async () => {
      const row = await FinalSettlementModel.findOne({ companyId, employeeId })
        .sort({ updatedAt: -1 })
        .lean();
      if (!row) return null;
      return toEmployeeSettlementView(row);
    });
    return value;
  };

  // ── §5 — create from the Exit module ─────────────────────────────────────

  const createSettlement = async ({
    companyId,
    employeeId,
    resignationId = null,
    month = '',
    lastWorkingDate = '',
    noticePeriodDays = FNF_RULES.notice.defaultDays,
    noticeDecision = 'COMPLETED',
    actor = null,
    req = null,
  } = {}) => {
    if (!employeeId) throw ApiError.badRequest('An employee is required');
    if (!isNoticeDecision(noticeDecision)) throw ApiError.badRequest('Unknown notice decision');

    const employee = await UserModel.findOne({ _id: employeeId, companyId })
      .select('name employeeCode designation department joiningDate')
      .lean();
    if (!employee) throw ApiError.notFound('Employee not found in this company');

    // §6 — the Exit module owns the resignation. A settlement may only be
    // opened for an APPROVED resignation, or for a manual exit where HR
    // supplies the last working day itself.
    let resignation = null;
    if (resignationId && ResignationModel) {
      resignation = await ResignationModel.findOne({ _id: resignationId, companyId, user: employeeId }).lean();
      if (!resignation) throw ApiError.notFound('Resignation not found in this company');
      if (String(resignation.status) !== 'APPROVED') {
        throw ApiError.badRequest('Only an approved resignation can be settled');
      }
    }

    const lwd = isoDate(resignation?.lastWorkingDate) || isoDate(lastWorkingDate);
    if (!DATE_PATTERN.test(lwd)) throw ApiError.badRequest('A last working date is required');

    const settledMonth = month && MONTH_PATTERN.test(month) ? month : monthOfDate(lwd);
    if (!MONTH_PATTERN.test(settledMonth)) throw ApiError.badRequest('Settlement month must look like 2026-08');

    // §5 — one settlement per exit.
    if (resignation) {
      const existing = await FinalSettlementModel.findOne({
        companyId,
        'exit.resignationId': resignation._id,
      }).lean();
      if (existing) {
        throw ApiError.conflict(`Settlement ${existing.settlementNumber} already exists for this exit`);
      }
    }

    const sequence = (await FinalSettlementModel.countDocuments({ companyId })) + 1;
    const settlementNumber = buildSettlementNumber({ month: settledMonth, sequence });

    const inputs = await loadSettlementInputs({ companyId, employeeId, month: settledMonth });
    const resignationDate = isoDate(resignation?.createdAt) || isoDate(resignation?.decidedAt);

    const exit = {
      resignationId: resignation?._id || null,
      employeeId,
      employeeName: employee.name || '',
      resignationDate,
      lastWorkingDate: lwd,
      reason: resignation?.reason || '',
      exitReason: resignation?.reason || '',
      noticePeriodDays: Number(noticePeriodDays) || FNF_RULES.notice.defaultDays,
      servedDays: resignationDate ? daysBetween(resignationDate, lwd) : 0,
      noticeDecision: String(noticeDecision).toUpperCase(),
      joiningDate: isoDate(employee.joiningDate),
    };

    const figures = computeFigures({
      inputs,
      month: settledMonth,
      lastWorkingDate: lwd,
      noticeDecision: exit.noticeDecision,
      noticePeriodDays: exit.noticePeriodDays,
      previous: { exit, earnings: { additional: [] }, recoveries: { items: [] } },
    });

    const created = await FinalSettlementModel.create({
      companyId,
      employeeId,
      settlementNumber,
      sequence,
      month: settledMonth,
      financialYear: financialYearOf(settledMonth),
      status: 'DRAFT',
      exit,
      earnings: figures.earnings,
      recoveries: figures.recoveries,
      totals: figures.totals,
      checklist: emptyChecklist(),
      assets: figures.assets,
      leaveBalance: figures.leaveBalance,
      history: [
        {
          status: 'DRAFT',
          previousStatus: '',
          remarks: 'Settlement created',
          by: actor?._id || null,
          byName: actor?.name || '',
          at: new Date(),
        },
      ],
    });

    await writeAudit({
      req,
      action: FNF_AUDIT_ACTIONS.SETTLEMENT_CREATED,
      companyId,
      employeeId,
      month: settledMonth,
      newStatus: 'DRAFT',
      payload: { settlementId: created._id, settlementNumber },
    });

    await invalidate(companyId, settledMonth, [employeeId]);

    return { ...toSettlementCardView(created), settlementId: String(created._id) };
  };

  // ── §7 — recalculate ─────────────────────────────────────────────────────

  const recalculate = async ({ companyId, settlementId, actor = null, req = null, allowedEmployeeIds = null } = {}) => {
    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds));
    if (!row) throw ApiError.notFound('Final settlement not found');
    if (isSettlementLocked(row.status)) {
      // §14 — closed is immutable; reopen first.
      throw ApiError.badRequest('A closed settlement cannot be recalculated — reopen it first');
    }
    if (!isSettlementEditable(row.status) && String(row.status) !== 'HR_REVIEWED') {
      throw ApiError.badRequest(
        'Only a settlement still in Draft, Calculation, HR Review or Reopened may be recalculated',
      );
    }

    const inputs = await loadSettlementInputs({ companyId, employeeId: row.employeeId, month: row.month });
    const figures = computeFigures({
      inputs,
      month: row.month,
      lastWorkingDate: row.exit?.lastWorkingDate || '',
      noticeDecision: row.exit?.noticeDecision || 'COMPLETED',
      noticePeriodDays: row.exit?.noticePeriodDays || FNF_RULES.notice.defaultDays,
      previous: row,
    });

    row.earnings = figures.earnings;
    row.recoveries = figures.recoveries;
    row.totals = figures.totals;
    row.assets = figures.assets;
    row.leaveBalance = figures.leaveBalance;
    row.exit.servedDays = figures.recoveries.notice.servedDays;
    row.calculatedAt = new Date();
    row.calculatedBy = actor?._id || null;
    row.calculatedByName = actor?.name || '';

    // §14 — the first calculation moves DRAFT → CALCULATED. A recalculation
    // of an already-calculated settlement keeps its status.
    const previousStatus = row.status;
    if (String(row.status) === 'DRAFT') {
      row.status = 'CALCULATED';
      row.history.push({
        status: 'CALCULATED',
        previousStatus,
        remarks: 'Final settlement calculated',
        by: actor?._id || null,
        byName: actor?.name || '',
        at: new Date(),
      });
    }

    await row.save();

    await writeAudit({
      req,
      action: previousStatus === 'DRAFT'
        ? FNF_AUDIT_ACTIONS.SETTLEMENT_CALCULATED
        : FNF_AUDIT_ACTIONS.SETTLEMENT_RECALCULATED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      previousStatus,
      newStatus: row.status,
      payload: {
        settlementId: row._id,
        settlementNumber: row.settlementNumber,
        newValue: { netSettlement: row.totals?.netSettlement || 0 },
      },
    });

    await invalidate(companyId, row.month, [row.employeeId]);

    return getSettlement({ companyId, settlementId: row._id });
  };

  // ── §9 / §10 — manual payables and recoveries ────────────────────────────

  const updateItems = async ({
    companyId,
    settlementId,
    payables = null,
    recoveries = null,
    actor = null,
    req = null,
    allowedEmployeeIds = null,
  } = {}) => {
    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds));
    if (!row) throw ApiError.notFound('Final settlement not found');
    if (isSettlementLocked(row.status)) throw ApiError.badRequest('A closed settlement cannot be edited');
    if (!isSettlementEditable(row.status)) {
      throw ApiError.badRequest('Only an editable settlement can have its items changed');
    }

    if (Array.isArray(payables)) {
      const manual = payables.filter((item) => String(item?.type || '').toUpperCase() !== 'LEAVE_ENCASHMENT' || item?.source === 'MANUAL');
      const errors = manual.flatMap((item) => validatePayableItem(item));
      if (errors.length) throw ApiError.badRequest(errors[0]);
      const system = (row.earnings?.additional || []).filter((item) => item?.source === 'SYSTEM');
      row.earnings = {
        ...(row.earnings || {}),
        additional: [...system, ...manual.filter((item) => item?.source !== 'SYSTEM').map((item) => normalisePayable(item))],
      };
    }

    if (Array.isArray(recoveries)) {
      const errors = recoveries.flatMap((item) => validateRecoveryItem(item));
      if (errors.length) throw ApiError.badRequest(errors[0]);
      row.recoveries = {
        ...(row.recoveries || {}),
        // §9 — amount, reason and approver are mandatory on every recovery.
        items: recoveries.map((item) => normaliseRecovery(item, actor)),
      };
    }

    row.totals = settlementTotals({
      pendingSalary: row.earnings?.pendingSalary?.amount || 0,
      additionalPayables: row.earnings?.additional || [],
      leaveEncashment: row.earnings?.leaveEncashment?.amount || 0,
      noticeRecovery: row.recoveries?.notice?.amount || 0,
      recoveries: row.recoveries?.items || [],
    });

    await row.save();
    await writeAudit({
      req,
      action: FNF_AUDIT_ACTIONS.SETTLEMENT_RECALCULATED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      previousStatus: row.status,
      newStatus: row.status,
      remarks: 'Payable / recovery items edited',
      payload: { settlementId: row._id, settlementNumber: row.settlementNumber },
    });
    await invalidate(companyId, row.month, [row.employeeId]);

    return getSettlement({ companyId, settlementId: row._id });
  };

  // ── §12 — notice decision ────────────────────────────────────────────────

  // ── §13 — Finance adds a recovery ─────────────────────────────────────────
  //
  // An unreturned laptop is a fact discovered at clearance time, which is
  // Finance's stage, not the Payroll Admin's. So Finance may ADD A RECOVERY
  // while the settlement is with them — and nothing else: no payable (that
  // would be the company paying money out on Finance's word alone), no
  // recalculation, no status change. Every other edit still belongs to
  // FINAL_SETTLEMENT_CALCULATE.
  //
  // The salary figures are deliberately NOT re-derived here. Adding a
  // recovery must not quietly move the pending salary under the employee.

  const addRecovery = async ({
    companyId,
    settlementId,
    item = null,
    actor = null,
    req = null,
    allowedEmployeeIds = null,
  } = {}) => {
    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds));
    if (!row) throw ApiError.notFound('Final settlement not found');
    if (isSettlementLocked(row.status)) throw ApiError.badRequest('A closed settlement cannot be edited');
    if (String(row.status) !== 'HR_REVIEWED') {
      throw ApiError.badRequest('Finance can only add a recovery while the settlement is with Finance');
    }

    // §9 — amount and reason are mandatory, and the approver is the person
    // adding it. The same validator the Payroll Admin's item editor uses.
    const errors = validateRecoveryItem(item);
    if (errors.length) throw ApiError.badRequest(errors[0]);

    const entry = normaliseRecovery(item, actor);
    row.recoveries = {
      ...(row.recoveries || {}),
      items: [...(row.recoveries?.items || []), entry],
    };
    row.totals = settlementTotals({
      pendingSalary: row.earnings?.pendingSalary?.amount || 0,
      additionalPayables: row.earnings?.additional || [],
      leaveEncashment: row.earnings?.leaveEncashment?.amount || 0,
      noticeRecovery: row.recoveries?.notice?.amount || 0,
      recoveries: row.recoveries?.items || [],
    });

    await row.save();
    await writeAudit({
      req,
      action: FNF_AUDIT_ACTIONS.SETTLEMENT_RECOVERY_ADDED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      previousStatus: row.status,
      newStatus: row.status,
      remarks: `Recovery added: ${entry.label} — ${entry.reason}`,
      payload: {
        settlementId: row._id,
        settlementNumber: row.settlementNumber,
        type: entry.type,
        amount: entry.amount,
      },
    });

    // The Payroll Admin owns the figures: they hear about it.
    await notifyPermission({
      companyId,
      permission: 'FINAL_SETTLEMENT_CALCULATE',
      type: NOTIFICATION_TYPES.RECOVERY_ADDED,
      excludeUserId: actor?._id || null,
      payload: {
        employeeName: row.exit?.employeeName || '',
        settlementNumber: row.settlementNumber,
        netSettlement: row.totals?.netSettlement || 0,
      },
    }).catch(() => null);

    await invalidate(companyId, row.month, [row.employeeId]);

    return getSettlement({ companyId, settlementId: row._id });
  };

  const setNoticeDecision = async ({
    companyId,
    settlementId,
    decision = '',
    noticePeriodDays = null,
    actor = null,
    req = null,
    allowedEmployeeIds = null,
  } = {}) => {
    if (!isNoticeDecision(decision)) throw ApiError.badRequest('Unknown notice decision');

    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds));
    if (!row) throw ApiError.notFound('Final settlement not found');
    if (isSettlementLocked(row.status)) throw ApiError.badRequest('A closed settlement cannot be changed');

    const periodDays = noticePeriodDays === null || noticePeriodDays === undefined
      ? row.exit?.noticePeriodDays || FNF_RULES.notice.defaultDays
      : Number(noticePeriodDays);

    const daily = row.earnings?.pendingSalary?.dailyRate || 0;
    const notice = computeNoticeRecovery({
      decision,
      noticePeriodDays: periodDays,
      servedDays: row.exit?.servedDays || 0,
      dailyRate: daily,
    });

    row.exit = {
      ...(row.exit || {}),
      noticeDecision: String(decision).toUpperCase(),
      noticePeriodDays: periodDays,
    };
    row.recoveries = { ...(row.recoveries || {}), notice };
    row.totals = settlementTotals({
      pendingSalary: row.earnings?.pendingSalary?.amount || 0,
      additionalPayables: row.earnings?.additional || [],
      leaveEncashment: row.earnings?.leaveEncashment?.amount || 0,
      noticeRecovery: notice.amount,
      recoveries: row.recoveries?.items || [],
    });

    await row.save();
    await writeAudit({
      req,
      action: FNF_AUDIT_ACTIONS.SETTLEMENT_RECALCULATED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      previousStatus: row.status,
      newStatus: row.status,
      remarks: `Notice decision set to ${decision}`,
      payload: { settlementId: row._id, settlementNumber: row.settlementNumber },
    });
    await invalidate(companyId, row.month, [row.employeeId]);

    return getSettlement({ companyId, settlementId: row._id });
  };

  // ── §15 — HR review ──────────────────────────────────────────────────────

  const hrReview = async ({
    companyId,
    settlementId,
    checklist = null,
    complete = false,
    remarks = '',
    actor = null,
    req = null,
    allowedEmployeeIds = null,
  } = {}) => {
    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds));
    if (!row) throw ApiError.notFound('Final settlement not found');
    if (isSettlementLocked(row.status)) throw ApiError.badRequest('A closed settlement cannot be reviewed');

    const previousStatus = row.status;

    if (checklist && typeof checklist === 'object') {
      row.checklist = {
        ...emptyChecklist(),
        ...(row.checklist || {}),
        ...CHECKLIST_ITEMS.reduce((acc, key) => {
          if (Object.prototype.hasOwnProperty.call(checklist, key)) acc[key] = Boolean(checklist[key]);
          return acc;
        }, {}),
      };
    }

    // §15 — "Only then enable Finance Approval." The server enforces what the
    // UI only disables.
    if (complete) {
      if (!checklistComplete(row.checklist)) {
        throw ApiError.badRequest('Complete every checklist item before sending the settlement to Finance');
      }
      if (!canTransitionSettlement(previousStatus, 'HR_REVIEWED')) {
        throw ApiError.badRequest(transitionError(previousStatus, 'HR_REVIEWED'));
      }
      row.status = 'HR_REVIEWED';
      row.approval = {
        ...(row.approval || {}),
        hrReviewedBy: actor?._id || null,
        hrReviewedByName: actor?.name || '',
        hrReviewedAt: new Date(),
      };
      row.history.push({
        status: 'HR_REVIEWED',
        previousStatus,
        remarks: remarks || 'HR review completed',
        by: actor?._id || null,
        byName: actor?.name || '',
        at: new Date(),
      });
    }

    await row.save();

    if (complete) {
      await writeAudit({
        req,
        action: FNF_AUDIT_ACTIONS.SETTLEMENT_HR_REVIEWED,
        companyId,
        employeeId: row.employeeId,
        month: row.month,
        previousStatus,
        newStatus: row.status,
        remarks,
        payload: { settlementId: row._id, settlementNumber: row.settlementNumber },
      });

      // §22 — HR completed the settlement → Finance.
      await notifyPermission({
        companyId,
        permission: 'FINAL_SETTLEMENT_APPROVE',
        type: NOTIFICATION_TYPES.HR_REVIEWED,
        excludeUserId: actor?._id || null,
        payload: {
          employeeName: row.exit?.employeeName || '',
          settlementNumber: row.settlementNumber,
          netSettlement: row.totals?.netSettlement || 0,
        },
      });
    }

    await invalidate(companyId, row.month, [row.employeeId]);
    return getSettlement({ companyId, settlementId: row._id });
  };

  // ── §16 — Finance approval ───────────────────────────────────────────────

  const financeDecision = async ({
    companyId,
    settlementId,
    action = 'APPROVE',
    remarks = '',
    actor = null,
    req = null,
    allowedEmployeeIds = null,
  } = {}) => {
    const key = String(action || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(key)) throw ApiError.badRequest('Action must be APPROVE or REJECT');

    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds));
    if (!row) throw ApiError.notFound('Final settlement not found');

    const previousStatus = row.status;
    if (key === 'REJECT' && !remarks.trim()) {
      throw ApiError.badRequest('A rejection needs remarks so HR knows what to fix');
    }

    const target = key === 'APPROVE' ? 'FINANCE_APPROVED' : 'CALCULATED';
    if (!canTransitionSettlement(previousStatus, target)) {
      throw ApiError.badRequest(transitionError(previousStatus, target));
    }

    row.status = target;
    row.approval = {
      ...(row.approval || {}),
      financeBy: actor?._id || null,
      financeByName: actor?.name || '',
      financeAt: new Date(),
      financeRemarks: remarks || '',
    };
    row.history.push({
      status: target,
      previousStatus,
      remarks: remarks || (key === 'APPROVE' ? 'Approved by Finance' : 'Rejected by Finance'),
      by: actor?._id || null,
      byName: actor?.name || '',
      at: new Date(),
    });

    await row.save();

    await writeAudit({
      req,
      action: key === 'APPROVE'
        ? FNF_AUDIT_ACTIONS.SETTLEMENT_FINANCE_APPROVED
        : FNF_AUDIT_ACTIONS.SETTLEMENT_FINANCE_REJECTED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      previousStatus,
      newStatus: target,
      remarks,
      payload: { settlementId: row._id, settlementNumber: row.settlementNumber },
    });

    // §22 — Finance approved → Payroll Admin; rejected → back to HR.
    await notifyPermission({
      companyId,
      permission: key === 'APPROVE' ? 'FINAL_SETTLEMENT_CALCULATE' : 'FINAL_SETTLEMENT_REVIEW',
      type: key === 'APPROVE' ? NOTIFICATION_TYPES.FINANCE_APPROVED : NOTIFICATION_TYPES.FINANCE_REJECTED,
      excludeUserId: actor?._id || null,
      payload: {
        employeeName: row.exit?.employeeName || '',
        settlementNumber: row.settlementNumber,
        netSettlement: row.totals?.netSettlement || 0,
        remarks,
      },
    });

    await invalidate(companyId, row.month, [row.employeeId]);
    return getSettlement({ companyId, settlementId: row._id });
  };

  // ── §5 — payment ─────────────────────────────────────────────────────────

  const markPaid = async ({
    companyId,
    settlementId,
    paidAt = '',
    reference = '',
    method = 'Bank Transfer',
    actor = null,
    req = null,
    allowedEmployeeIds = null,
  } = {}) => {
    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds));
    if (!row) throw ApiError.notFound('Final settlement not found');

    const previousStatus = row.status;
    if (!canTransitionSettlement(previousStatus, 'PAID')) {
      throw ApiError.badRequest(transitionError(previousStatus, 'PAID'));
    }

    const date = DATE_PATTERN.test(String(paidAt))
      ? String(paidAt)
      : new Date().toISOString().slice(0, 10);

    row.status = 'PAID';
    row.payment = {
      paidAt: date,
      reference: String(reference || '').trim(),
      method: String(method || 'Bank Transfer'),
      paidBy: actor?._id || null,
      paidByName: actor?.name || '',
    };
    row.history.push({
      status: 'PAID',
      previousStatus,
      remarks: `Paid on ${date}${reference ? ` (ref ${reference})` : ''}`,
      by: actor?._id || null,
      byName: actor?.name || '',
      at: new Date(),
    });

    await row.save();

    await writeAudit({
      req,
      action: FNF_AUDIT_ACTIONS.SETTLEMENT_PAID,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      previousStatus,
      newStatus: 'PAID',
      payload: {
        settlementId: row._id,
        settlementNumber: row.settlementNumber,
        newValue: { netSettlement: row.totals?.netSettlement || 0, paidAt: date },
      },
    });

    // §22 — Settlement Paid → Employee.
    await notifyUser({
      userId: row.employeeId,
      type: NOTIFICATION_TYPES.SETTLEMENT_PAID,
      payload: {
        settlementNumber: row.settlementNumber,
        netSettlement: row.totals?.netSettlement || 0,
      },
    });

    await invalidate(companyId, row.month, [row.employeeId]);
    return getSettlement({ companyId, settlementId: row._id });
  };

  // ── §14 — close / reopen ─────────────────────────────────────────────────

  const closeSettlement = async ({ companyId, settlementId, actor = null, req = null, allowedEmployeeIds = null } = {}) => {
    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds));
    if (!row) throw ApiError.notFound('Final settlement not found');

    const previousStatus = row.status;
    if (!canTransitionSettlement(previousStatus, 'CLOSED')) {
      throw ApiError.badRequest(transitionError(previousStatus, 'CLOSED'));
    }

    row.status = 'CLOSED';
    row.closedAt = new Date();
    row.closedBy = actor?._id || null;
    row.history.push({
      status: 'CLOSED',
      previousStatus,
      remarks: 'Settlement closed',
      by: actor?._id || null,
      byName: actor?.name || '',
      at: new Date(),
    });

    await row.save();

    await writeAudit({
      req,
      action: FNF_AUDIT_ACTIONS.SETTLEMENT_CLOSED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      previousStatus,
      newStatus: 'CLOSED',
      payload: { settlementId: row._id, settlementNumber: row.settlementNumber },
    });

    await notifyUser({
      userId: row.employeeId,
      type: NOTIFICATION_TYPES.SETTLEMENT_CLOSED,
      payload: {
        employeeName: row.exit?.employeeName || '',
        settlementNumber: row.settlementNumber,
        netSettlement: row.totals?.netSettlement || 0,
      },
    });

    await invalidate(companyId, row.month, [row.employeeId]);
    return getSettlement({ companyId, settlementId: row._id });
  };

  const reopenSettlement = async ({
    companyId,
    settlementId,
    remarks = '',
    actor = null,
    req = null,
    allowedEmployeeIds = null,
  } = {}) => {
    const row = await FinalSettlementModel.findOne(withScope(companyId, { _id: settlementId }, allowedEmployeeIds));
    if (!row) throw ApiError.notFound('Final settlement not found');
    if (!remarks.trim()) throw ApiError.badRequest('A reopened settlement needs a reason');

    const previousStatus = row.status;
    if (!canTransitionSettlement(previousStatus, 'REOPENED')) {
      throw ApiError.badRequest(transitionError(previousStatus, 'REOPENED'));
    }

    row.status = 'REOPENED';
    row.closedAt = null;
    row.closedBy = null;
    row.history.push({
      status: 'REOPENED',
      previousStatus,
      remarks,
      by: actor?._id || null,
      byName: actor?.name || '',
      at: new Date(),
    });

    await row.save();

    await writeAudit({
      req,
      action: FNF_AUDIT_ACTIONS.SETTLEMENT_REOPENED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      previousStatus,
      newStatus: 'REOPENED',
      remarks,
      payload: { settlementId: row._id, settlementNumber: row.settlementNumber },
    });

    await invalidate(companyId, row.month, [row.employeeId]);
    return getSettlement({ companyId, settlementId: row._id });
  };

  // ── §17 — the F&F statement ──────────────────────────────────────────────

  const buildStatement = async ({ companyId, settlement, company, employee, actor }) => {
    const content = await renderPdf({
      company: company || {},
      employee: employee || {},
      settlement,
      generatedBy: actor?.name || '',
    });
    return {
      filename: statementFilename({
        settlementNumber: settlement?.settlementNumber,
        employeeName: employee?.name,
      }),
      content,
    };
  };

  const runStatement = async ({ companyId, settlementId, actor = null, req = null, onProgress = null } = {}) => {
    if (!FinalSettlementFileModel) throw ApiError.badRequest('Statement generation is not available');

    const row = await FinalSettlementModel.findOne({ _id: settlementId, companyId }).lean();
    if (!row) throw ApiError.notFound('Final settlement not found');

    const file = await FinalSettlementFileModel.findOne({ _id: row.statement?.fileId, companyId });
    const target = file
      || (await FinalSettlementFileModel.create({
        companyId,
        month: row.month,
        kind: 'STATEMENT',
        settlementId: row._id,
        format: 'PDF',
        status: 'QUEUED',
        requestedBy: actor?._id || null,
        requestedByName: actor?.name || '',
      }));

    try {
      await FinalSettlementFileModel.updateOne(
        { _id: target._id, companyId },
        { $set: { status: 'PROCESSING', progress: 10 } },
      );
      if (onProgress) await onProgress({ processed: 0, total: 1, percent: 10 });

      const [company, employeeDoc] = await Promise.all([
        CompanyModel ? CompanyModel.findById(companyId).lean() : Promise.resolve(null),
        UserModel.findOne({ _id: row.employeeId, companyId })
          .select('name employeeCode designation department')
          .lean(),
      ]);

      const employeeMap = await loadEmployeeRows({ companyId, employeeIds: [row.employeeId] });
      const employee = employeeMap.get(String(row.employeeId)) || employeeDoc || {};

      const { content, filename } = await buildStatement({
        companyId,
        settlement: row,
        company: company || {},
        employee,
        actor,
      });

      await FinalSettlementFileModel.updateOne(
        { _id: target._id, companyId },
        {
          $set: {
            binary: content,
            sizeBytes: content?.length || 0,
            checksum: hash(content),
            filename,
            status: 'READY',
            progress: 100,
            processed: 1,
            total: 1,
            completedAt: new Date(),
            error: '',
          },
        },
      );

      await FinalSettlementModel.updateOne(
        { _id: row._id, companyId },
        { $set: { 'statement.fileId': target._id, 'statement.generatedAt': new Date() } },
      );

      if (onProgress) await onProgress({ processed: 1, total: 1, percent: 100 });

      return { fileId: String(target._id), filename, sizeBytes: content?.length || 0, status: 'READY' };
    } catch (error) {
      await FinalSettlementFileModel.updateOne(
        { _id: target._id, companyId },
        { $set: { status: 'FAILED', error: error?.message || 'F&F statement could not be generated' } },
      );
      throw error;
    }
  };

  const requestStatement = async ({ companyId, settlementId, actor = null, req = null } = {}) => {
    const row = await FinalSettlementModel.findOne({ _id: settlementId, companyId }).lean();
    if (!row) throw ApiError.notFound('Final settlement not found');
    if (String(row.status) === 'DRAFT') {
      throw ApiError.badRequest('Calculate the settlement before generating its statement');
    }

    // §21 — queued when the worker is up, inline otherwise. The document is
    // one PDF, so the inline path is not a compromise.
    try {
      const dispatched = await dispatchStatement({
        companyId,
        settlementId,
        fileId: row.statement?.fileId || null,
        actorId: actor?._id || null,
      });
      if (dispatched?.queued) return { queued: true, jobId: dispatched.jobId || '', mode: 'QUEUED' };
    } catch {
      /* fall through to the inline path */
    }

    const result = await runStatement({ companyId, settlementId, actor, req });
    return { queued: false, mode: 'INLINE', ...result };
  };

  const downloadStatement = async ({ companyId, settlementId, actor = null, req = null, self = false } = {}) => {
    const filter = { _id: settlementId, companyId };
    // §24 — an employee downloads their OWN statement and nothing else.
    if (self && actor?._id) filter.employeeId = actor._id;

    const row = await FinalSettlementModel.findOne(filter).lean();
    if (!row) throw ApiError.notFound('Final settlement not found');
    if (!['PAID', 'CLOSED'].includes(String(row.status))) {
      throw ApiError.badRequest('The F&F statement is available once the settlement has been paid');
    }

    const fileId = row.statement?.fileId;
    let file = fileId && FinalSettlementFileModel
      ? await FinalSettlementFileModel.findOne({ _id: fileId, companyId, status: 'READY' }).lean()
      : null;

    if (!file && FinalSettlementFileModel) {
      // Not generated yet (or the worker is down) — build it now.
      const built = await runStatement({ companyId, settlementId: row._id, actor, req });
      file = { _id: built.fileId, filename: built.filename };
    }

    if (!file) throw ApiError.badRequest('The F&F statement could not be generated');

    const withBinary = await FinalSettlementFileModel.findOne({ _id: file._id, companyId })
      .select('+binary')
      .lean();

    await FinalSettlementFileModel.updateOne(
      { _id: file._id, companyId },
      { $set: { lastDownloadedAt: new Date() }, $inc: { downloadCount: 1 } },
    );
    await FinalSettlementModel.updateOne(
      { _id: row._id, companyId },
      { $set: { 'statement.lastDownloadedAt': new Date() }, $inc: { 'statement.downloadCount': 1 } },
    );

    await writeAudit({
      req,
      action: FNF_AUDIT_ACTIONS.STATEMENT_DOWNLOADED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      newStatus: row.status,
      payload: { settlementId: row._id, settlementNumber: row.settlementNumber },
    });

    return {
      filename: file.filename || statementFilename({ settlementNumber: row.settlementNumber }),
      content: withBinary?.binary || Buffer.alloc(0),
    };
  };

  // ── §21 — the bulk settlement register ───────────────────────────────────

  const buildRegisterRows = async ({ companyId, month = '', allowedEmployeeIds = null }) => {
    const filter = withScope(companyId, {}, allowedEmployeeIds);
    if (month) filter.month = month;
    const rows = await FinalSettlementModel.find(filter).sort({ settlementNumber: 1 }).lean();
    const employeeMap = await loadEmployeeRows({
      companyId,
      employeeIds: (rows || []).map((row) => row.employeeId),
    });
    return (rows || []).map((row) => decorate(row, employeeMap));
  };

  const getRegister = async ({ companyId, month = '', format = 'CSV', allowedEmployeeIds = null } = {}) => {
    const rows = await buildRegisterRows({ companyId, month, allowedEmployeeIds });
    const table = registerRows({ rows });
    const key = String(format || '').toUpperCase();
    const content = key === 'XLSX' ? buildWorkbook(REGISTER_HEADERS, table) : buildCsv(REGISTER_HEADERS, table);
    return {
      filename: reportFilename({ month, format: key }),
      content: Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8'),
      rows: rows.length,
    };
  };

  const requestRegister = async ({ companyId, month = '', format = 'CSV', actor = null, allowedEmployeeIds = null } = {}) => {
    if (!FinalSettlementFileModel) throw ApiError.badRequest('Bulk export is not available');

    const file = await FinalSettlementFileModel.create({
      companyId,
      month: month || '',
      kind: 'REGISTER',
      format: String(format || 'CSV').toUpperCase(),
      status: 'QUEUED',
      requestedBy: actor?._id || null,
      requestedByName: actor?.name || '',
    });

    try {
      const dispatched = await dispatchRegister({
        companyId,
        fileId: file._id,
        month: month || '',
        format: String(format || 'CSV').toUpperCase(),
        actorId: actor?._id || null,
      });
      if (dispatched?.queued) {
        await FinalSettlementFileModel.updateOne(
          { _id: file._id, companyId },
          { $set: { jobId: dispatched.jobId || '', queued: true } },
        );
        return { queued: true, fileId: String(file._id), jobId: dispatched.jobId || '' };
      }
    } catch {
      /* fall through to the inline path */
    }

    const built = await runRegister({ companyId, fileId: file._id, month, format, actor });
    return { queued: false, fileId: String(file._id), ...built };
  };

  const runRegister = async ({ companyId, fileId, month = '', format = 'CSV', actor = null, allowedEmployeeIds = null, onProgress = null } = {}) => {
    if (!FinalSettlementFileModel) throw ApiError.badRequest('Bulk export is not available');

    const file = await FinalSettlementFileModel.findOne({ _id: fileId, companyId });
    if (!file) throw ApiError.notFound('Export not found');

    try {
      await FinalSettlementFileModel.updateOne(
        { _id: fileId, companyId },
        { $set: { status: 'PROCESSING', progress: 10 } },
      );
      if (onProgress) await onProgress({ processed: 0, total: 1, percent: 10 });

      const built = await getRegister({
        companyId,
        month: file.month || month,
        format: file.format || format,
        allowedEmployeeIds,
      });

      await FinalSettlementFileModel.updateOne(
        { _id: fileId, companyId },
        {
          $set: {
            binary: built.content,
            sizeBytes: built.content?.length || 0,
            checksum: hash(built.content),
            filename: built.filename,
            status: 'READY',
            progress: 100,
            processed: built.rows,
            total: built.rows,
            completedAt: new Date(),
            error: '',
          },
        },
      );

      if (onProgress) await onProgress({ processed: built.rows, total: built.rows, percent: 100 });
      return { filename: built.filename, sizeBytes: built.content?.length || 0, rows: built.rows, status: 'READY' };
    } catch (error) {
      await FinalSettlementFileModel.updateOne(
        { _id: fileId, companyId },
        { $set: { status: 'FAILED', error: error?.message || 'Settlement register could not be generated' } },
      );
      throw error;
    }
  };

  const listFiles = async ({ companyId, month = '' } = {}) => {
    if (!FinalSettlementFileModel) return [];
    const filter = { companyId };
    if (month) filter.month = month;
    const rows = await FinalSettlementFileModel.find(filter).sort({ createdAt: -1 }).limit(20).lean();
    return (rows || []).map((row) => ({
      _id: row._id,
      month: row.month,
      kind: row.kind,
      format: row.format,
      filename: row.filename,
      status: row.status,
      progress: row.progress || 0,
      processed: row.processed || 0,
      total: row.total || 0,
      sizeBytes: row.sizeBytes || 0,
      requestedByName: row.requestedByName || '',
      downloadCount: row.downloadCount || 0,
      createdAt: row.createdAt,
      completedAt: row.completedAt || null,
      error: row.error || '',
      queued: Boolean(row.queued),
    }));
  };

  const downloadFile = async ({ companyId, fileId, actor = null, req = null } = {}) => {
    if (!FinalSettlementFileModel) throw ApiError.badRequest('Bulk export is not available');
    const row = await FinalSettlementFileModel.findOne({ _id: fileId, companyId }).lean();
    if (!row) throw ApiError.notFound('Export not found');
    if (row.status !== 'READY') {
      throw ApiError.badRequest('The file is still being prepared — try again in a moment');
    }

    const withBinary = await FinalSettlementFileModel.findOne({ _id: fileId, companyId }).select('+binary').lean();
    await FinalSettlementFileModel.updateOne(
      { _id: fileId, companyId },
      { $set: { lastDownloadedAt: new Date() }, $inc: { downloadCount: 1 } },
    );

    await writeAudit({
      req,
      action: FNF_AUDIT_ACTIONS.STATEMENT_DOWNLOADED,
      companyId,
      month: row.month || '',
      newStatus: 'DOWNLOADED',
      payload: {
        settlementId: row.settlementId || null,
        newValue: { kind: row.kind, format: row.format, filename: row.filename },
      },
    });

    return {
      filename: row.filename || reportFilename({ month: row.month, format: row.format }),
      content: withBinary?.binary || Buffer.alloc(0),
      contentType: String(row.format || '').toUpperCase() === 'CSV'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  };

  // ── §18 — the employee's own statement ───────────────────────────────────

  const downloadMyStatement = async ({ companyId, employeeId, actor = null, req = null } = {}) => {
    const row = await FinalSettlementModel.findOne({ companyId, employeeId }).sort({ updatedAt: -1 }).lean();
    if (!row) throw ApiError.notFound('You have no final settlement');
    return downloadStatement({
      companyId,
      settlementId: row._id,
      actor: actor ? { ...actor, _id: employeeId } : { _id: employeeId },
      req,
      self: true,
    });
  };

  return {
    // reads
    getDashboard,
    listSettlements,
    getSettlement,
    getMySettlement,
    listFiles,
    getRegister,
    // lifecycle
    createSettlement,
    recalculate,
    updateItems,
    setNoticeDecision,
    hrReview,
    addRecovery,
    financeDecision,
    markPaid,
    closeSettlement,
    reopenSettlement,
    // documents
    requestStatement,
    runStatement,
    downloadStatement,
    downloadMyStatement,
    requestRegister,
    runRegister,
    downloadFile,
    // cache
    invalidate,
    // exposed for the worker / tests
    _internals: { computeFigures, loadSettlementInputs, buildRegisterRows, idOf },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Default wiring (imports last, matching 29.6–29.10: the factory above stays
//  side-effect free so tests can build their own instance).
// ─────────────────────────────────────────────────────────────────────────────

import FinalSettlement from '../../models/FinalSettlement.js';
import FinalSettlementFile from '../../models/FinalSettlementFile.js';
import Resignation from '../../models/Resignation.js';
import Asset from '../../models/Asset.js';
import Leave from '../../models/Leave.js';
import PayrollResult from '../../models/PayrollResult.js';
import PayrollPeriod from '../../models/PayrollPeriod.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import EmployeePayrollProfile from '../../models/EmployeePayrollProfile.js';
import User from '../../models/User.js';
import Company from '../../models/Company.js';
import Department from '../../models/Department.js';

import { recordAudit } from '../../utils/securityauditService.js';
import { hasPermission } from '../../utils/permissionService.js';
import notifySmart from '../../utils/notifyPref.js';
import { buildFnfStatementPdf } from '../../utils/fnfPdf.js';
import { resolveCompanyLogo } from '../../utils/companyLogo.js';
import { createHash } from 'node:crypto';
import { LEAVE_TYPES } from '../../utils/constants.js';

import { invalidateFnfCache, fnfCacheKey } from './fnfCache.js';
import { dispatchFnfStatement, dispatchFnfRegister } from './fnfDispatcher.js';
import { getOrSetCache } from '../redisCacheService.js';

// §22 — a settlement notification reaches everyone who can act on it, not a
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
      title: 'Final Settlement',
      message: notificationCopy(type, payload),
      link: '/app/payroll/final-settlement',
      category: 'PAYROLL',
      metadata: { type, ...payload },
    }).catch(() => null);
    sent += 1;
  }
  return sent;
};

const defaultService = makeFnfService({
  FinalSettlementModel: FinalSettlement,
  FinalSettlementFileModel: FinalSettlementFile,
  ResignationModel: Resignation,
  AssetModel: Asset,
  LeaveModel: Leave,
  PayrollResultModel: PayrollResult,
  PayrollPeriodModel: PayrollPeriod,
  PayrollSetupModel: PayrollSetup,
  EmployeePayrollProfileModel: EmployeePayrollProfile,
  UserModel: User,
  CompanyModel: Company,
  DepartmentModel: Department,

  cache: {
    buildKey: fnfCacheKey,
    getOrSet: getOrSetCache,
    invalidate: invalidateFnfCache,
  },

  audit: recordAudit,

  notify: ({ userId, type, payload = {} }) =>
    notifySmart(userId, {
      title: 'Final Settlement',
      message: notificationCopy(type, payload),
      link: '/app/payroll/my-final-settlement',
      category: 'PAYROLL',
      metadata: { type, ...payload },
    }),
  notifyRoles: notifyPermissionHolders,

  dispatchStatement: dispatchFnfStatement,
  dispatchRegister: dispatchFnfRegister,

  renderPdf: async (options) =>
    buildFnfStatementPdf({ ...options, logo: await resolveCompanyLogo(options?.company?.logoUrl) }),

  leaveQuota: Object.keys(LEAVE_TYPES).reduce((acc, key) => {
    acc[key] = LEAVE_TYPES[key]?.yearly ?? 12;
    return acc;
  }, {}),

  hash: (value) =>
    createHash('sha256')
      .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8'))
      .digest('hex'),
});

export const fnfService = defaultService;
export default defaultService;
