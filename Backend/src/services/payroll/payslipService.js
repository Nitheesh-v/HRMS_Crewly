// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP SERVICE
//
//  Orchestration only; every decision lives in payslipRules.js and every
//  byte of PDF lives in utils/payslipPdf.js. Everything external is injected
//  (models, cache, audit, notify, mail, dispatch, pdf) so the whole phase can
//  be tested without MongoDB, Redis, BullMQ or SMTP.
//
//  THE LAW OF THIS FILE (§5 / §22 / §26):
//    · A payslip is generated only for an employee whose salary is PAID (§1).
//    · The snapshot is written ONCE and never recomputed.
//    · Regeneration re-renders the STORED snapshot — never new payroll data.
//    · An employee reaches their own payslips and nothing else.
// ═══════════════════════════════════════════════════════════════════════════
import ApiError from '../../utils/ApiError.js';

import {
  PAYSLIP_STATUSES,
  PAYSLIP_AUDIT_ACTIONS,
  buildPayslipNumber,
  buildPayslipSnapshot,
  snapshotValuesKey,
  filterPayslips,
  sortPayslips,
  payslipSummary,
  payslipFilename,
  zipEntryName,
  bulkZipFilename,
  payslipEmailCopy,
  notificationCopy,
  NOTIFICATION_TYPES,
  toPayslipCardView,
  financialYearOf,
  monthLabel,
  money,
  isPaidForPayslip,
  generationGateError,
  canTransitionPayslip,
  registerRows,
  REGISTER_HEADERS,
  registerFilename,
} from './payslipRules.js';
// The dependency-free CSV writer 29.8 wrote for the bank file — reused for
// the payroll register instead of adding a package.
import { toCsv } from './payrollPaymentRules.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const getPayslipCacheTtlSeconds = (source = process.env) => {
  const parsed = Number(source?.PAYROLL_CACHE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 300;
};

export const makePayslipService = ({
  PayslipModel,
  PayslipFileModel = null,
  PayrollResultModel,
  PayrollPaymentModel,
  PayrollPaymentBatchModel = null,
  PayrollSetupModel = null,
  EmployeePayrollProfileModel,
  UserModel,
  CompanyModel,
  DepartmentModel = null,
  cache = {},
  audit = async () => null,
  notify = async () => null,
  mail = async () => ({ delivered: false, mode: 'MOCK' }),
  dispatchGenerate = async () => ({ queued: false }),
  dispatchZip = async () => ({ queued: false }),
  dispatchEmail = async () => ({ queued: false }),
  renderPdf = async () => Buffer.alloc(0),
  buildZip = null,
  hash = () => '',
  ttlSeconds = getPayslipCacheTtlSeconds(),
} = {}) => {
  // ── cache seam (§23) ─────────────────────────────────────────────────────
  const buildKey = ({ companyId, month = '', employeeId = '', suffix = 'dashboard' } = {}) => {
    if (typeof cache.buildKey !== 'function') return null;
    return cache.buildKey({ companyId, month, employeeId, suffix });
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

  // ── audit / notify seams (§25 / §20) ─────────────────────────────────────
  const writeAudit = async ({ req = null, action, companyId, employeeId = null, month = '', payload = {} } = {}) => {
    try {
      return await audit({
        req,
        action,
        companyId,
        resource: 'Payslip',
        resourceId: payload?.payslipId || null,
        targetUserId: employeeId || null,
        previousValue: payload?.previousValue ?? null,
        newValue: {
          month,
          payslipNumber: payload?.payslipNumber || '',
          ...(payload?.newValue || {}),
        },
        metadata: { month, ...(payload?.metadata || {}) },
      });
    } catch {
      // §20 / §25 — an audit failure must never roll back a payslip.
      return null;
    }
  };

  const notifyEmployee = async ({ employeeId, month }) => {
    if (!employeeId) return;
    try {
      await notify({
        userId: employeeId,
        type: NOTIFICATION_TYPES.PAYSLIP_AVAILABLE,
        payload: { month },
      });
    } catch {
      /* never block on a notification */
    }
  };

  // ── reads ───────────────────────────────────────────────────────────────

  const loadRows = async ({ companyId, month = '', employeeId = '', allowedEmployeeIds = null }) => {
    const filter = { companyId };
    if (month) filter.month = month;
    if (employeeId) filter.employeeId = employeeId;
    if (allowedEmployeeIds) filter.employeeId = { $in: allowedEmployeeIds };
    const rows = await PayslipModel.find(filter).sort({ month: -1, createdAt: -1 }).lean();
    return rows || [];
  };

  // Light shape for lists: the snapshot is big and the list only needs totals.
  const toListRow = (row = {}) => ({
    _id: row._id,
    employeeId: row.employeeId,
    employeeCode: row.snapshot?.employee?.employeeCode || '',
    employeeName: row.snapshot?.employee?.name || '',
    departmentName: row.snapshot?.employee?.department || '',
    month: row.month,
    monthLabel: monthLabel(row.month),
    payslipNumber: row.payslipNumber,
    status: row.status,
    grossSalary: money(row.snapshot?.salary?.grossSalary),
    netSalary: money(row.snapshot?.salary?.netSalary),
    paymentDate: row.snapshot?.payment?.paymentDate || row.snapshot?.payroll?.paymentDate || null,
    downloadCount: row.downloadCount || 0,
    emailedAt: row.emailedAt || null,
    hasPdf: Boolean(row.pdfBytes),
    updatedAt: row.updatedAt || null,
  });

  const listPayslips = async ({
    companyId,
    month = '',
    year = '',
    financialYear = '',
    search = '',
    fyStartMonth = 4,
    allowedEmployeeIds = null,
  } = {}) => {
    const rows = await loadRows({ companyId, month, allowedEmployeeIds });
    const filtered = filterPayslips({
      rows,
      month: '',
      year,
      financialYear,
      search,
      fyStartMonth,
    });
    return sortPayslips(filtered).map(toListRow);
  };

  // §23 — the admin dashboard is a cached read.
  const getDashboard = async ({ companyId, month = '', allowedEmployeeIds = null } = {}) => {
    const key = buildKey({ companyId, month, suffix: 'dashboard' });
    const { value } = await readThrough(key, async () => {
      const rows = await loadRows({ companyId, month, allowedEmployeeIds });
      return {
        month: month || '',
        summary: payslipSummary({ rows }),
        payslips: sortPayslips(rows).map(toListRow),
      };
    });
    return value;
  };

  // §14 / §23 — the employee's own history, cached per employee.
  const getMyPayslips = async ({ companyId, employeeId } = {}) => {
    const key = buildKey({ companyId, employeeId, suffix: 'employee' });
    const { value } = await readThrough(key, async () => {
      const rows = await loadRows({ companyId, employeeId });
      return sortPayslips(rows).map((row) => toPayslipCardView(row));
    });
    return value;
  };

  // §23 — "Recent Payslip": the portal's opening card. Cached separately
  // because it is read on every visit while the full history is only read
  // when the employee scrolls back.
  const getMyRecentPayslip = async ({ companyId, employeeId } = {}) => {
    const key = buildKey({ companyId, employeeId, suffix: 'recent' });
    const { value } = await readThrough(key, async () => {
      const rows = sortPayslips(await loadRows({ companyId, employeeId }));
      return rows.length ? toPayslipCardView(rows[0]) : null;
    });
    return value;
  };

  const getPayslip = async ({ companyId, payslipId, employeeId = null, allowedEmployeeIds = null } = {}) => {
    const filter = { _id: payslipId, companyId };
    // §3 / §26 — the self-service path can only ever address its own row.
    if (employeeId) filter.employeeId = employeeId;
    else if (allowedEmployeeIds) filter.employeeId = { $in: allowedEmployeeIds };

    const row = await PayslipModel.findOne(filter).lean();
    if (!row) throw ApiError.notFound('Payslip not found');
    return row;
  };

  const getPayslipView = async (args) => {
    const row = await getPayslip(args);
    return {
      ...toPayslipCardView(row),
      snapshot: row.snapshot,
      emailError: row.emailError || '',
      regeneratedCount: row.regeneratedCount || 0,
      pdfBytes: row.pdfBytes || 0,
    };
  };

  // §25 — "Employee Viewed Payslip" is an audited action.
  const markViewed = async ({ companyId, payslipId, employeeId = null, actor = null, req = null }) => {
    const row = await getPayslip({ companyId, payslipId, employeeId });
    await writeAudit({
      req,
      action: PAYSLIP_AUDIT_ACTIONS.VIEWED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      payload: {
        payslipId: row._id,
        payslipNumber: row.payslipNumber,
        actorId: actor?._id || null,
      },
    });
    return getPayslipView({ companyId, payslipId, employeeId });
  };

  // ── generation (§5 / §6 / §17) ───────────────────────────────────────────

  const assertMonth = (month) => {
    if (!MONTH_PATTERN.test(String(month || ''))) {
      throw ApiError.badRequest('month must look like 2026-08');
    }
    return String(month);
  };

  const loadGenerationContext = async ({ companyId, month }) => {
    const [company, setup] = await Promise.all([
      CompanyModel ? CompanyModel.findById(companyId).lean() : Promise.resolve(null),
      PayrollSetupModel
        ? PayrollSetupModel.findOne({ companyId, isCurrent: true }).lean()
        : Promise.resolve(null),
    ]);

    // §1 — the payment gate lives on the 29.8 batch, not on a new flag.
    const batches = PayrollPaymentBatchModel
      ? await PayrollPaymentBatchModel.find({ companyId, month }).lean()
      : [];
    const payments = await PayrollPaymentModel.find({ companyId, month }).lean();
    const paid = (payments || []).filter((payment) => isPaidForPayslip(payment));

    const gateError = generationGateError({
      hasBatch: Boolean((batches || []).length) || Boolean((payments || []).length),
      paidCount: paid.length,
      batchStatus: (batches || [])[0]?.status || '',
    });
    if (gateError) throw ApiError.badRequest(gateError);

    const employeeIds = paid.map((payment) => payment.employeeId);

    const [results, profiles, employees] = await Promise.all([
      PayrollResultModel.find({ companyId, month, isCurrent: true, employeeId: { $in: employeeIds } }).lean(),
      EmployeePayrollProfileModel.find({ companyId, userId: { $in: employeeIds } })
        // §9 / §23 — the full account number is encrypted and never selected
        // into a payslip; only the masked copy is read.
        .select('+bank.accountNumberMasked')
        .lean(),
      UserModel.find({ _id: { $in: employeeIds } }).lean(),
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
    const profileByEmployee = new Map((profiles || []).map((row) => [String(row.userId), row]));
    const employeeById = new Map((employees || []).map((row) => [String(row._id), row]));

    return {
      company: company || {},
      setup: setup || {},
      batches: batches || [],
      payments: paid,
      resultByEmployee,
      profileByEmployee,
      employeeById,
      departmentNames,
    };
  };

  // §7 — company-wide running sequence; the unique index is the real guard,
  // the retry only smooths a concurrent job.
  const nextSequence = async (companyId, offset = 0) => {
    const count = await PayslipModel.countDocuments({ companyId });
    return count + offset + 1;
  };

  const upsertPayslip = async ({
    companyId,
    payment,
    employee,
    result,
    profile,
    context,
    month,
    actor,
    generatedAt,
    sequenceOffset,
  }) => {
    const existing = await PayslipModel.findOne({ companyId, employeeId: payment.employeeId, month }).lean();

    // §22 — a payslip that already exists keeps its snapshot and number; only
    // the PDF is refreshed. Regeneration is therefore value-preserving.
    if (existing) {
      return { row: existing, created: false };
    }

    const sequence = await nextSequence(companyId, sequenceOffset);
    const payslipNumber = buildPayslipNumber({ month, sequence });

    const snapshot = buildPayslipSnapshot({
      company: context.company,
      setup: context.setup,
      employee: {
        ...(employee || {}),
        departmentName:
          (employee && context.departmentNames.get(String(employee.department))) ||
          payment.departmentName ||
          '',
      },
      profile: profile || {},
      result: result || {},
      payment,
      month,
      payslipNumber,
      generatedAt,
    });

    let row = null;
    for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
      const number = attempt === 0 ? payslipNumber : buildPayslipNumber({ month, sequence: sequence + attempt });
      try {
        row = await PayslipModel.create({
          companyId,
          employeeId: payment.employeeId,
          month,
          payslipNumber: number,
          sequence: sequence + attempt,
          status: 'PENDING',
          snapshot,
          source: {
            payrollResultId: result?._id || null,
            runVersion: result?.version || 1,
            paymentBatchId: payment.batchId || null,
            paymentId: payment._id || null,
          },
          createdBy: actor?._id || null,
          updatedBy: actor?._id || null,
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        // Duplicate number (a concurrent job): bump and try again.
      }
    }
    if (!row) throw ApiError.conflict('Could not allocate a unique payslip number');

    return { row, created: true };
  };

  const renderInto = async ({ row, generatedAt }) => {
    const snapshot = { ...(row.snapshot || {}), generatedAt: generatedAt || row.snapshot?.generatedAt || null };
    const pdf = await renderPdf(snapshot);
    const buffer = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf || '');
    await PayslipModel.updateOne(
      { _id: row._id, companyId: row.companyId },
      {
        $set: {
          pdf: buffer,
          pdfBytes: buffer.length,
          pdfGeneratedAt: generatedAt || new Date(),
          status: 'GENERATED',
          lastError: '',
          updatedBy: row.updatedBy || null,
        },
      },
    );
    return buffer;
  };

  /**
   * §17 — generate every payslip for a month. Runs inline when Redis/the
   * worker is unavailable, and is called by the worker with `onProgress`
   * when it is queued.
   */
  const runGeneration = async ({
    companyId,
    month,
    actor = null,
    req = null,
    onProgress = null,
    notifyEmployees = true,
  } = {}) => {
    assertMonth(month);
    const context = await loadGenerationContext({ companyId, month });
    const generatedAt = new Date();

    let created = 0;
    let updated = 0;
    let failed = 0;
    const issues = [];
    const touchedEmployees = [];

    for (let index = 0; index < context.payments.length; index += 1) {
      const payment = context.payments[index];
      const employee = context.employeeById.get(String(payment.employeeId)) || null;
      const result = context.resultByEmployee.get(String(payment.employeeId)) || null;
      const profile = context.profileByEmployee.get(String(payment.employeeId)) || null;

      if (onProgress) {
        await onProgress({
          processed: index,
          total: context.payments.length,
          percent: Math.round((index / Math.max(1, context.payments.length)) * 100),
        });
      }

      try {
        if (!result) {
          issues.push({
            employeeId: String(payment.employeeId),
            message: 'No payroll snapshot found for this month',
          });
          failed += 1;
          continue;
        }

        const { row, created: isNew } = await upsertPayslip({
          companyId,
          payment,
          employee,
          result,
          profile,
          context,
          month,
          actor,
          generatedAt,
          sequenceOffset: index,
        });

        await renderInto({ row, generatedAt });

        if (isNew) created += 1;
        else updated += 1;
        touchedEmployees.push(payment.employeeId);

        await writeAudit({
          req,
          action: PAYSLIP_AUDIT_ACTIONS.GENERATED,
          companyId,
          employeeId: payment.employeeId,
          month,
          payload: {
            payslipId: row._id,
            payslipNumber: row.payslipNumber,
          },
        });

        // §20 — the employee hears about it; this is the notification 29.8
        // deliberately did not send.
        if (notifyEmployees) await notifyEmployee({ employeeId: payment.employeeId, month });
      } catch (error) {
        failed += 1;
        issues.push({
          employeeId: String(payment.employeeId),
          message: error?.message || 'Payslip generation failed',
        });
      }
    }

    if (onProgress) {
      await onProgress({ processed: context.payments.length, total: context.payments.length, percent: 100 });
    }

    await invalidate(companyId, month, touchedEmployees);

    // §17 — the person who pressed the button hears how it went. Only the
    // inline path knows the answer; a queued run reports through the worker.
    if (actor?._id) {
      try {
        await notify({
          userId: actor._id,
          type: NOTIFICATION_TYPES.PAYSLIPS_GENERATED,
          payload: { month, count: created + updated, failed },
        });
      } catch {
        /* never block on a notification */
      }
    }

    return {
      month,
      total: context.payments.length,
      created,
      updated,
      failed,
      issues,
      notified: notifyEmployees ? created + updated : 0,
    };
  };

  /**
   * §17 — the API path. Large companies are queued; without Redis the same
   * loop runs inline so the request still completes (29.6–29.8 precedent).
   */
  const generateForMonth = async ({ companyId, month, actor = null, req = null, queue = true } = {}) => {
    assertMonth(month);

    if (queue) {
      try {
        const { queued, jobId } = await dispatchGenerate({
          companyId,
          month,
          actorId: actor?._id || null,
        });
        if (queued) {
          await writeAudit({
            req,
            action: PAYSLIP_AUDIT_ACTIONS.GENERATED,
            companyId,
            month,
            payload: { metadata: { queued: true, jobId } },
          });
          return { queued: true, jobId, month };
        }
      } catch {
        // Queue unavailable → fall through to the inline path.
      }
    }

    const result = await runGeneration({ companyId, month, actor, req });
    return { queued: false, jobId: null, ...result };
  };

  // §4 — "Download payroll register": one CSV row per payslip of the month.
  const getRegister = async ({ companyId, month = '', allowedEmployeeIds = null } = {}) => {
    const rows = await loadRows({ companyId, month, allowedEmployeeIds });
    const ordered = sortPayslips(rows);
    return {
      month: month || '',
      filename: registerFilename({ month }),
      content: toCsv(REGISTER_HEADERS, registerRows({ rows: ordered })),
      count: ordered.length,
    };
  };

  // ── §22 — regenerate ─────────────────────────────────────────────────────

  const regeneratePayslip = async ({ companyId, payslipId, actor = null, req = null } = {}) => {
    const row = await getPayslip({ companyId, payslipId });
    const before = snapshotValuesKey(row.snapshot);

    // §22 — the snapshot is the input, never the payroll tables again.
    const generatedAt = new Date();
    const buffer = await renderInto({ row, generatedAt });

    await PayslipModel.updateOne(
      { _id: row._id, companyId },
      {
        $inc: { regeneratedCount: 1 },
        $set: { lastRegeneratedAt: generatedAt, updatedBy: actor?._id || null },
      },
    );

    const after = await PayslipModel.findOne({ _id: row._id, companyId }).lean();
    // A regeneration that changed a figure is a bug, not a feature: catch it.
    const unchanged = snapshotValuesKey(after?.snapshot) === before;

    await writeAudit({
      req,
      action: PAYSLIP_AUDIT_ACTIONS.REGENERATED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      payload: {
        payslipId: row._id,
        payslipNumber: row.payslipNumber,
        previousValue: { status: row.status },
        newValue: { status: after?.status, valuesUnchanged: unchanged, bytes: buffer.length },
      },
    });

    await invalidate(companyId, row.month, [row.employeeId]);

    return {
      payslipId: String(row._id),
      payslipNumber: row.payslipNumber,
      bytes: buffer.length,
      valuesUnchanged: unchanged,
    };
  };

  // ── download (§16 / §25) ─────────────────────────────────────────────────

  const downloadPayslip = async ({
    companyId,
    payslipId,
    employeeId = null,
    allowedEmployeeIds = null,
    actor = null,
    req = null,
  } = {}) => {
    const row = await getPayslip({ companyId, payslipId, employeeId, allowedEmployeeIds });

    // The PDF is `select: false`; this is the only read that asks for it.
    const withPdf = await PayslipModel.findOne({ _id: row._id, companyId }).select('+pdf').lean();
    let buffer = withPdf?.pdf;

    if (!buffer || !buffer.length) {
      buffer = await renderInto({ row, generatedAt: new Date() });
    }

    const nextStatus = canTransitionPayslip(row.status, 'DOWNLOADED') ? 'DOWNLOADED' : row.status;
    await PayslipModel.updateOne(
      { _id: row._id, companyId },
      {
        $set: { status: nextStatus, lastDownloadedAt: new Date() },
        $inc: { downloadCount: 1 },
      },
    );

    await writeAudit({
      req,
      action: PAYSLIP_AUDIT_ACTIONS.DOWNLOADED,
      companyId,
      employeeId: row.employeeId,
      month: row.month,
      payload: {
        payslipId: row._id,
        payslipNumber: row.payslipNumber,
        previousValue: { status: row.status },
        newValue: { status: nextStatus, actorId: actor?._id || null },
      },
    });

    await invalidate(companyId, row.month, [row.employeeId]);

    return {
      filename: payslipFilename({
        month: row.month,
        employeeCode: row.snapshot?.employee?.employeeCode,
        name: row.snapshot?.employee?.name,
      }),
      content: buffer,
      payslip: toPayslipCardView(row),
    };
  };

  // ── email (§19) ──────────────────────────────────────────────────────────

  const emailOne = async ({ companyId, row, req = null }) => {
    const employee = await UserModel.findOne({ _id: row.employeeId, companyId }).select('email name').lean();
    if (!employee?.email) {
      await PayslipModel.updateOne(
        { _id: row._id, companyId },
        { $set: { emailError: 'Employee has no email address on file' } },
      );
      return { delivered: false, error: 'Employee has no email address on file' };
    }

    const withPdf = await PayslipModel.findOne({ _id: row._id, companyId }).select('+pdf').lean();
    let buffer = withPdf?.pdf;
    if (!buffer || !buffer.length) buffer = await renderInto({ row, generatedAt: new Date() });

    const copy = payslipEmailCopy({
      month: row.month,
      employeeName: row.snapshot?.employee?.name || employee.name,
      companyName: row.snapshot?.company?.name,
    });

    try {
      const result = await mail({
        to: employee.email,
        subject: copy.subject,
        text: copy.text,
        html: copy.html,
        attachments: [
          {
            filename: payslipFilename({
              month: row.month,
              employeeCode: row.snapshot?.employee?.employeeCode,
              name: row.snapshot?.employee?.name,
            }),
            content: buffer,
            contentType: 'application/pdf',
          },
        ],
      });

      const delivered = result?.delivered !== false;
      await PayslipModel.updateOne(
        { _id: row._id, companyId },
        {
          $set: delivered
            ? {
                status: canTransitionPayslip(row.status, 'EMAILED') ? 'EMAILED' : row.status,
                emailedAt: new Date(),
                emailedTo: employee.email,
                emailError: '',
              }
            : { emailError: result?.error || 'Email delivery failed' },
        },
      );

      await writeAudit({
        req,
        action: PAYSLIP_AUDIT_ACTIONS.EMAILED,
        companyId,
        employeeId: row.employeeId,
        month: row.month,
        payload: {
          payslipId: row._id,
          payslipNumber: row.payslipNumber,
          newValue: { delivered, mode: result?.mode || 'MOCK' },
        },
      });

      return { delivered, ...(delivered ? {} : { error: result?.error || 'Email delivery failed' }) };
    } catch (error) {
      await PayslipModel.updateOne(
        { _id: row._id, companyId },
        { $set: { emailError: error?.message || 'Email delivery failed' } },
      );
      return { delivered: false, error: error?.message || 'Email delivery failed' };
    }
  };

  const emailPayslip = async ({ companyId, payslipId, actor = null, req = null } = {}) => {
    const row = await getPayslip({ companyId, payslipId });
    const result = await emailOne({ companyId, row, req });
    await invalidate(companyId, row.month, [row.employeeId]);
    return { payslipId: String(row._id), ...result };
  };

  const runEmailMonth = async ({ companyId, month, employeeIds = null, req = null, onProgress = null } = {}) => {
    assertMonth(month);
    const filter = { companyId, month, status: { $in: ['GENERATED', 'EMAILED', 'DOWNLOADED'] } };
    if (employeeIds?.length) filter.employeeId = { $in: employeeIds };
    const rows = await PayslipModel.find(filter).lean();

    let sent = 0;
    let failed = 0;
    const issues = [];

    for (let index = 0; index < (rows || []).length; index += 1) {
      const row = rows[index];
      if (onProgress) {
        await onProgress({
          processed: index,
          total: rows.length,
          percent: Math.round((index / Math.max(1, rows.length)) * 100),
        });
      }
      const result = await emailOne({ companyId, row, req });
      if (result.delivered) sent += 1;
      else {
        failed += 1;
        issues.push({ employeeId: String(row.employeeId), message: result.error || 'Email failed' });
      }
    }

    await invalidate(companyId, month, (rows || []).map((row) => row.employeeId));
    return { month, total: (rows || []).length, sent, failed, issues };
  };

  const emailMonth = async ({ companyId, month, employeeIds = null, actor = null, req = null, queue = true } = {}) => {
    assertMonth(month);
    if (queue) {
      try {
        const { queued, jobId } = await dispatchEmail({ companyId, month, employeeIds, actorId: actor?._id || null });
        if (queued) return { queued: true, jobId, month };
      } catch {
        /* fall through to inline */
      }
    }
    const result = await runEmailMonth({ companyId, month, employeeIds, req });
    return { queued: false, jobId: null, ...result };
  };

  // ── §18 — bulk ZIP download ──────────────────────────────────────────────

  const requestBulkDownload = async ({
    companyId,
    month,
    scope = 'COMPANY',
    departmentId = null,
    actor = null,
    req = null,
    queue = true,
  } = {}) => {
    assertMonth(month);
    if (!PayslipFileModel) throw ApiError.badRequest('Bulk download is not available');

    const department = departmentId && DepartmentModel
      ? await DepartmentModel.findOne({ _id: departmentId, companyId }).select('name').lean()
      : null;

    const fileRow = await PayslipFileModel.create({
      companyId,
      month,
      scope: String(scope || 'COMPANY').toUpperCase(),
      departmentId: departmentId || null,
      departmentName: department?.name || '',
      filename: bulkZipFilename({
        month,
        scope,
        departmentName: department?.name || '',
      }),
      status: 'QUEUED',
      requestedBy: actor?._id || null,
      requestedByName: actor?.name || '',
    });

    if (queue) {
      try {
        const { queued, jobId } = await dispatchZip({
          companyId,
          month,
          fileId: fileRow._id,
          scope: fileRow.scope,
          departmentId,
          actorId: actor?._id || null,
        });
        if (queued) {
          await PayslipFileModel.updateOne(
            { _id: fileRow._id, companyId },
            { $set: { jobId, queued: true } },
          );
          return { queued: true, jobId, fileId: String(fileRow._id), filename: fileRow.filename };
        }
      } catch {
        /* fall through to inline */
      }
    }

    await runBulkZip({ companyId, fileId: fileRow._id });
    return { queued: false, jobId: null, fileId: String(fileRow._id), filename: fileRow.filename };
  };

  const runBulkZip = async ({ companyId, fileId, onProgress = null } = {}) => {
    if (!PayslipFileModel) throw ApiError.badRequest('Bulk download is not available');
    const fileRow = await PayslipFileModel.findOne({ _id: fileId, companyId }).lean();
    if (!fileRow) throw ApiError.notFound('Bulk download not found');

    await PayslipFileModel.updateOne({ _id: fileId, companyId }, { $set: { status: 'PROCESSING' } });

    try {
      const filter = { companyId, month: fileRow.month };
      const rows = await PayslipModel.find(filter).select('+pdf').lean();

      // §18 — a DEPARTMENT scope is resolved here, not trusted from the client.
      let scoped = rows || [];
      if (fileRow.scope === 'DEPARTMENT' && fileRow.departmentId) {
        const members = await UserModel.find({ companyId, department: fileRow.departmentId })
          .select('_id')
          .lean();
        const ids = new Set((members || []).map((member) => String(member._id)));
        scoped = scoped.filter((row) => ids.has(String(row.employeeId)));
      }

      const entries = [];
      for (let index = 0; index < scoped.length; index += 1) {
        const row = scoped[index];
        if (onProgress) {
          await onProgress({
            processed: index,
            total: scoped.length,
            percent: Math.round((index / Math.max(1, scoped.length)) * 100),
          });
        }
        let buffer = row.pdf;
        if (!buffer || !buffer.length) buffer = await renderInto({ row, generatedAt: new Date() });
        entries.push({
          name: zipEntryName({
            month: row.month,
            employeeCode: row.snapshot?.employee?.employeeCode,
            name: row.snapshot?.employee?.name,
          }),
          data: buffer,
        });
        await PayslipFileModel.updateOne(
          { _id: fileId, companyId },
          { $set: { processed: index + 1, total: scoped.length, progress: Math.round(((index + 1) / Math.max(1, scoped.length)) * 100) } },
        );
      }

      const archive = buildZip ? buildZip(entries) : null;
      if (!archive) throw new Error('No ZIP writer configured');

      await PayslipFileModel.updateOne(
        { _id: fileId, companyId },
        {
          $set: {
            binary: archive,
            sizeBytes: archive.length,
            checksum: hash(archive),
            status: 'READY',
            progress: 100,
            processed: scoped.length,
            total: scoped.length,
            completedAt: new Date(),
            error: '',
          },
        },
      );

      if (onProgress) await onProgress({ processed: scoped.length, total: scoped.length, percent: 100 });

      return { fileId: String(fileId), files: entries.length, sizeBytes: archive.length, status: 'READY' };
    } catch (error) {
      await PayslipFileModel.updateOne(
        { _id: fileId, companyId },
        { $set: { status: 'FAILED', error: error?.message || 'Bulk download failed' } },
      );
      throw error;
    }
  };

  const listBulkFiles = async ({ companyId, month = '' } = {}) => {
    if (!PayslipFileModel) return [];
    const filter = { companyId };
    if (month) filter.month = month;
    const rows = await PayslipFileModel.find(filter).sort({ createdAt: -1 }).limit(20).lean();
    return (rows || []).map((row) => ({
      _id: row._id,
      month: row.month,
      scope: row.scope,
      departmentName: row.departmentName,
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

  const downloadBulkFile = async ({ companyId, fileId, actor = null, req = null } = {}) => {
    if (!PayslipFileModel) throw ApiError.badRequest('Bulk download is not available');
    const row = await PayslipFileModel.findOne({ _id: fileId, companyId }).lean();
    if (!row) throw ApiError.notFound('Bulk download not found');
    if (row.status !== 'READY') {
      throw ApiError.badRequest('The archive is still being prepared — try again in a moment');
    }

    const withBinary = await PayslipFileModel.findOne({ _id: fileId, companyId }).select('+binary').lean();
    await PayslipFileModel.updateOne(
      { _id: fileId, companyId },
      { $set: { lastDownloadedAt: new Date() }, $inc: { downloadCount: 1 } },
    );

    await writeAudit({
      req,
      action: PAYSLIP_AUDIT_ACTIONS.DOWNLOADED,
      companyId,
      month: row.month,
      payload: {
        payslipId: row._id,
        newValue: { kind: 'BULK_ZIP', scope: row.scope, files: row.total || 0, actorId: actor?._id || null },
      },
    });

    return {
      filename: row.filename || bulkZipFilename({ month: row.month, scope: row.scope }),
      content: withBinary?.binary || Buffer.alloc(0),
    };
  };

  return {
    // reads
    getDashboard,
    listPayslips,
    getMyPayslips,
    getMyRecentPayslip,
    getPayslip,
    getPayslipView,
    markViewed,
    listBulkFiles,
    getRegister,
    // generation
    generateForMonth,
    runGeneration,
    regeneratePayslip,
    // delivery
    downloadPayslip,
    emailPayslip,
    emailMonth,
    runEmailMonth,
    requestBulkDownload,
    runBulkZip,
    downloadBulkFile,
    // cache
    invalidate,
    // exposed for the worker / tests
    _internals: { loadGenerationContext, renderInto, upsertPayslip, snapshotValuesKey, financialYearOf },
  };
};


// ─────────────────────────────────────────────────────────────────────────────
//  Default wiring (imports last, matching the 29.7/29.8 services: the factory
//  above stays side-effect free so tests can build their own instance).
// ─────────────────────────────────────────────────────────────────────────────

import Payslip from '../../models/Payslip.js';
import PayslipFile from '../../models/PayslipFile.js';
import PayrollResult from '../../models/PayrollResult.js';
import PayrollPayment from '../../models/PayrollPayment.js';
import PayrollPaymentBatch from '../../models/PayrollPaymentBatch.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import EmployeePayrollProfile from '../../models/EmployeePayrollProfile.js';
import User from '../../models/User.js';
import Company from '../../models/Company.js';
import Department from '../../models/Department.js';

import { recordAudit } from '../../utils/securityauditService.js';
import notifySmart from '../../utils/notifyPref.js';
import { sendMail } from '../../utils/mailer.js';
import { buildPayslipPdf } from '../../utils/payslipPdf.js';
import { resolveCompanyLogo } from '../../utils/companyLogo.js';
import { buildZip } from '../../utils/minimalZip.js';
import { createHash } from 'node:crypto';

import {
  invalidatePayslipCache,
  payslipCacheKey,
} from './payslipCache.js';
import {
  dispatchPayslipGenerate,
  dispatchPayslipZip,
  dispatchPayslipEmail,
} from './payslipDispatcher.js';
import { getOrSetCache, deleteCache, noteCacheInvalidation } from '../redisCacheService.js';

const defaultService = makePayslipService({
  PayslipModel: Payslip,
  PayslipFileModel: PayslipFile,
  PayrollResultModel: PayrollResult,
  PayrollPaymentModel: PayrollPayment,
  PayrollPaymentBatchModel: PayrollPaymentBatch,
  PayrollSetupModel: PayrollSetup,
  EmployeePayrollProfileModel: EmployeePayrollProfile,
  UserModel: User,
  CompanyModel: Company,
  DepartmentModel: Department,

  cache: {
    buildKey: payslipCacheKey,
    getOrSet: getOrSetCache,
    invalidate: invalidatePayslipCache,
  },

  audit: recordAudit,

  // §20 — in-app notification. This is the employee-facing message 29.8
  // deliberately did not send; it opens My Payroll → Payslips.
  notify: ({ userId, type, payload = {} }) =>
    notifySmart(userId, {
      title: 'Payslip',
      message: notificationCopy(type, payload),
      link: '/app/payroll/my-payslips',
      category: 'PAYROLL',
      metadata: { type, ...payload },
    }),

  // §19 — the existing SMTP seam (utils/mailer.js), now with attachments.
  mail: ({ to, subject, text = '', html = '', attachments = [] }) =>
    sendMail({ to, subject, text, html, attachments }),

  dispatchGenerate: dispatchPayslipGenerate,
  dispatchZip: dispatchPayslipZip,
  dispatchEmail: dispatchPayslipEmail,

  // §8 — the header shows the company logo. The bytes are resolved here (and
  // cached), never inside the PDF module, so a render stays a pure function
  // of its inputs and a bulk run fetches each logo once.
  renderPdf: async (snapshot) =>
    buildPayslipPdf(snapshot, { logo: await resolveCompanyLogo(snapshot?.company?.logoUrl) }),
  buildZip,
  hash: (value) =>
    createHash('sha256')
      .update(Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8'))
      .digest('hex'),
});

export const payslipService = defaultService;
export default defaultService;
