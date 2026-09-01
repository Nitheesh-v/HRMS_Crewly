// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.8 — SALARY PAYMENT SERVICE (tenant-safe orchestration)
//
//  Write order: validate → authorize (route) → tenant → dependencies → save
//  → invalidate cache → audit → notify.
//
//  CREWLY PREPARES, THE BANK PAYS (§1 / §25). This service builds batches
//  from an APPROVED payroll, validates bank details, renders a transfer file
//  and tracks what came back. There is no bank API, no UPI, no NEFT/RTGS
//  call and no payslip here.
//
//  SECURITY (§23): a full account number is decrypted in exactly one place —
//  buildFileContent — and is written straight into the file. Nothing else in
//  this module, and no JSON response, ever carries it.
//
//  REDIS (§19): namespace 'payroll-payment', invalidated on every write.
//  BULLMQ (§20): file generation is dispatched to the `payroll` queue and
//  rebuilt by the worker from Mongo. Without Redis it runs inline (28.1).
//
//  Dependency injection keeps the hermetic suite free of MongoDB and Redis.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';
import {
  BANK_FILE_FORMATS,
  FAILURE_REASONS,
  audiencePermissions,
  batchSummary,
  buildBankFile,
  buildBatchNumber,
  buildPaymentReference,
  canTransition,
  notificationCopy,
  paymentKpis,
  sanitisePrefix,
  statusAfterMarking,
  transitionError,
  validateEmployeeForPayment,
  validationMessages,
} from './payrollPaymentRules.js';
import { isValidMonth } from './monthlyInputRules.js';
import { PAYMENT_CACHE_NAMESPACE, PAYMENT_CACHE_VERSION } from './payrollPaymentCache.js';

export const CACHE_NAMESPACE = PAYMENT_CACHE_NAMESPACE;
export const CACHE_VERSION = PAYMENT_CACHE_VERSION;

const MIN_CACHE_TTL_SECONDS = 10;
const MAX_CACHE_TTL_SECONDS = 3600;
const DEFAULT_CACHE_TTL_SECONDS = 300;

// A bank file is capped so a queue payload, a Mongo document and a download
// all stay inside sane limits.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const getPayrollPaymentCacheTtlSeconds = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.PAYROLL_PAYMENT_CACHE_TTL_SECONDS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, parsed));
};

export const makePayrollPaymentService = ({
  PayrollPaymentBatchModel,
  PayrollPaymentModel,
  PayrollPaymentFileModel = null,
  PayrollResultModel,
  PayrollReviewModel = null,
  PayrollSetupModel = null,
  EmployeePayrollProfileModel,
  UserModel,
  DepartmentModel = null,
  cache = {},
  audit = async () => null,
  notify = async () => null,
  // §21 — who hears about a payment event, resolved by permission.
  audience = async () => [],
  dispatch = async () => ({ queued: false }),
  decrypt = () => '',
  hash = () => '',
  // §18 / §22 — READ side of the audit trail. Write goes through `audit`;
  // this one is a seam too, so the batch history can be tested without a
  // live AuditLog collection.
  readAudit = async () => [],
  ttlSeconds = getPayrollPaymentCacheTtlSeconds(),
} = {}) => {
  const buildCacheKey = (companyId, month, suffix = 'dashboard') => {
    if (typeof cache.buildKey !== 'function') return null;
    return cache.buildKey({
      companyId,
      namespace: CACHE_NAMESPACE,
      version: CACHE_VERSION,
      segments: [month || 'all', suffix],
    });
  };

  const invalidate = async (companyId, month) => {
    const keys = ['dashboard', 'batches']
      .map((suffix) => buildCacheKey(companyId, month, suffix))
      .filter(Boolean);
    if (!keys.length || typeof cache.del !== 'function') return false;
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
      // Auditing must never break a payment action.
    }
  };

  const notifyAudience = async ({ companyId, type, payload = {}, actorId = null }) => {
    const permissions = audiencePermissions(type);
    if (!permissions.length) return 0;

    let recipients = [];
    try {
      recipients = (await audience({ companyId, permissions })) || [];
    } catch {
      return 0;
    }

    const unique = [...new Set(recipients.map((id) => String(id)))].filter(
      (id) => id && String(actorId || '') !== id,
    );

    let sent = 0;
    for (const userId of unique) {
      try {
        await notify({ companyId, userId, type, payload });
        sent += 1;
      } catch {
        // One bad recipient must not stop the others.
      }
    }
    return sent;
  };

  // §19 — read-through cache with the house contract:
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

  // ── reads ────────────────────────────────────────────────────────────────

  const loadDepartmentNames = async (companyId) => {
    if (!DepartmentModel) return new Map();
    try {
      const rows = await DepartmentModel.find({ companyId }).select('name').lean();
      return new Map((rows || []).map((row) => [String(row._id), row.name]));
    } catch {
      return new Map();
    }
  };

  const getSetup = async (companyId) =>
    PayrollSetupModel ? PayrollSetupModel.findOne({ companyId }).lean() : null;

  const getReview = async ({ companyId, month }) => {
    if (!PayrollReviewModel) return null;
    return PayrollReviewModel.findOne({ companyId, month }).lean();
  };

  // §2 / §5 — nothing is prepared until finance approved the payroll.
  const assertApproved = async ({ companyId, month }) => {
    const review = await getReview({ companyId, month });
    if (!review) {
      throw ApiError.badRequest(
        `Payroll for ${month} has not been reviewed yet. Review and approve it first.`,
      );
    }
    if (review.status !== 'APPROVED') {
      throw ApiError.badRequest(
        `Payroll for ${month} is ${review.status.toLowerCase().replace(/_/g, ' ')}. Only an approved payroll can be paid.`,
      );
    }
    return review;
  };

  const listPayments = async ({ companyId, batchId, allowedEmployeeIds = null, withSecret = false }) => {
    const filter = { companyId, batchId };
    if (Array.isArray(allowedEmployeeIds)) filter.employeeId = { $in: allowedEmployeeIds };

    const query = PayrollPaymentModel.find(filter);
    const rows = withSecret ? await query.select('+bank.accountNumber').lean() : await query.lean();
    return rows || [];
  };

  // §23 — the public shape never carries the encrypted account number.
  const toPublicPayment = (row = {}) => {
    const bank = row.bank || {};
    return {
      ...row,
      bank: {
        bankName: bank.bankName || '',
        accountHolderName: bank.accountHolderName || '',
        ifsc: bank.ifsc || '',
        accountNumberMasked: bank.accountNumberMasked || '',
        accountNumberLast4: bank.accountNumberLast4 || '',
      },
    };
  };

  const getBatch = async ({ companyId, batchId, allowedEmployeeIds = null }) => {
    const batch = await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
    if (!batch) throw ApiError.notFound('Payment batch not found');

    const payments = await listPayments({ companyId, batchId: batch._id, allowedEmployeeIds });
    const files = PayrollPaymentFileModel
      ? await PayrollPaymentFileModel.find({ companyId, batchId: batch._id })
          .sort({ createdAt: -1 })
          .lean()
      : [];

    return {
      batch,
      payments: payments.map(toPublicPayment),
      excluded: batch.excluded || [],
      // §12 — download history, without the payloads (those are downloaded).
      files: (files || []).map((file) => ({
        _id: file._id,
        format: file.format,
        status: file.status,
        rowCount: file.rowCount,
        checksum: file.checksum,
        generatedAt: file.generatedAt || file.createdAt,
        generatedByName: file.generatedByName || '',
        downloadCount: file.downloadCount || 0,
        lastDownloadedAt: file.lastDownloadedAt || null,
        queued: Boolean(file.queued),
      })),
    };
  };

  // ── §18 / §22 — the batch's audit trail ──────────────────────────────────
  //
  // Everything that happened to THIS batch: its status changes, every employee
  // outcome and every file event. The audit log already stores company, actor
  // and previous/new value; this only has to collect the ids that belong to
  // the batch — the batch itself, its payment rows and its files — and read
  // them back newest first.

  const toAuditEntry = (row = {}) => {
    const previous = row.previousValue || null;
    const next = row.newValue || null;
    return {
      at: row.at || row.createdAt || null,
      action: row.action || '',
      actorName: row.actorName || '',
      actorRole: row.actorRole || '',
      resource: row.resource || row.targetType || '',
      from: row.from !== undefined ? row.from : previous ? previous.status || null : null,
      to: row.to !== undefined ? row.to : next ? next.status || null : null,
      reason:
        row.reason !== undefined
          ? row.reason
          : next && next.reason !== undefined
            ? next.reason || null
            : null,
    };
  };

  const getBatchAudit = async ({ companyId, batchId, limit = 200 } = {}) => {
    const batch = await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
    if (!batch) throw ApiError.notFound('Payment batch not found');

    const paymentRows = await PayrollPaymentModel.find({ companyId, batchId: batch._id })
      .select('_id')
      .lean();
    const fileRows = PayrollPaymentFileModel
      ? await PayrollPaymentFileModel.find({ companyId, batchId: batch._id }).select('_id').lean()
      : [];

    // §3 — the ids come from tenant-scoped reads, so another company's batch
    // can never pull its own history into ours.
    const targetIds = [
      batch._id,
      ...(paymentRows || []).map((row) => row._id),
      ...(fileRows || []).map((row) => row._id),
    ];

    const rows = await readAudit({ companyId, targetIds, limit });
    return (rows || []).map(toAuditEntry);
  };

  const listBatches = async ({ companyId, month = '', allowedEmployeeIds = null }) => {
    const filter = { companyId };
    if (month) filter.month = month;
    const batches = await PayrollPaymentBatchModel.find(filter).sort({ createdAt: -1 }).lean();
    return batches || [];
  };

  // §17 — the payment dashboard: batches + KPI cards, cached (§19).
  const getDashboard = async ({ companyId, month = '', allowedEmployeeIds = null }) => {
    const key = buildCacheKey(companyId, month, 'dashboard');
    const { value } = await readThrough(key, async () => {
      const batches = await listBatches({ companyId, month, allowedEmployeeIds });
      return {
        batches,
        kpis: paymentKpis({ batches }),
        month: month || '',
      };
    });

    return value;
  };

  // ── batch creation (§5 / §6 / §7 / §11) ──────────────────────────────────

  const loadPaymentInputs = async ({ companyId, month, allowedEmployeeIds = null }) => {
    const filter = { companyId, month, isCurrent: true };
    if (Array.isArray(allowedEmployeeIds)) filter.employeeId = { $in: allowedEmployeeIds };

    const [results, profiles, departments] = await Promise.all([
      PayrollResultModel.find(filter).lean(),
      EmployeePayrollProfileModel.find({ companyId, isCurrent: true })
        .select('+bank.accountNumber +bank.accountHolderName +bank.bankName +bank.ifsc +bank.accountNumberMasked +bank.accountNumberLast4 +payrollStatus')
        .lean(),
      loadDepartmentNames(companyId),
    ]);

    const calculated = (results || []).filter((row) => row.status === 'CALCULATED');
    const employeeIds = calculated.map((row) => String(row.employeeId));
    const employees = employeeIds.length
      ? await UserModel.find({ _id: { $in: employeeIds } })
          .select('name employeeCode department status')
          .lean()
      : [];

    const employeeById = new Map((employees || []).map((row) => [String(row._id), row]));
    const profileById = new Map((profiles || []).map((row) => [String(row.employeeId), row]));

    return calculated.map((result) => {
      const employeeId = String(result.employeeId);
      const employee = employeeById.get(employeeId) || null;
      const profile = profileById.get(employeeId) || null;
      return {
        result,
        employee,
        profile,
        departmentName: departments.get(String(employee?.department || '')) || '',
      };
    });
  };

  const createBatch = async ({ companyId, month, actor, req, paymentDate = null, allowedEmployeeIds = null }) => {
    if (!isValidMonth(month)) throw ApiError.badRequest('Payroll month must look like 2026-08');

    const review = await assertApproved({ companyId, month });

    // §6 — one original batch per month. Failures are handled by a retry
    // batch (§16), never by a second original that could pay twice.
    const existing = await PayrollPaymentBatchModel.find({
      companyId,
      month,
      sourceBatchId: null,
      status: { $nin: ['CANCELLED'] },
    }).lean();
    if ((existing || []).length) {
      throw ApiError.badRequest(
        `A payment batch already exists for ${month} (${existing[0].batchNumber}). Create a retry batch for the failed payments instead.`,
      );
    }

    const setup = await getSetup(companyId);
    const prefix = sanitisePrefix(setup?.bankAccount?.paymentReferencePrefix);
    const inputs = await loadPaymentInputs({ companyId, month, allowedEmployeeIds });

    if (!inputs.length) {
      throw ApiError.badRequest(`No calculated payroll results for ${month}. Run payroll first.`);
    }

    const rows = [];
    const excluded = [];

    inputs.forEach((input) => {
      const { result, employee, profile, departmentName } = input;
      const errors = validateEmployeeForPayment({ employee, profile, result });

      if (errors.length) {
        excluded.push({
          employeeId: result.employeeId,
          employeeCode: result.employeeCode || '',
          employeeName: result.employeeName || '',
          errors,
          messages: validationMessages(errors).map((row) => row.message),
        });
        return;
      }

      rows.push({
        employeeId: result.employeeId,
        employeeCode: result.employeeCode || '',
        employeeName: result.employeeName || employee?.name || '',
        departmentName,
        netSalary: Number(result.totals?.netPay || 0),
        resultVersion: Number(result.version || 1),
        bank: {
          bankName: profile.bank?.bankName || '',
          accountHolderName: profile.bank?.accountHolderName || '',
          ifsc: String(profile.bank?.ifsc || '').toUpperCase(),
          accountNumberMasked: profile.bank?.accountNumberMasked || '',
          accountNumberLast4: profile.bank?.accountNumberLast4 || '',
          // Encrypted blob copied from the profile — history stays reproducible
          // and the plaintext still lives in exactly one place.
          accountNumber: profile.bank?.accountNumber || '',
        },
      });
    });

    if (!rows.length) {
      throw ApiError.badRequest(
        'No employee passed bank validation. Fix the payroll profiles before creating a batch.',
      );
    }

    const sequence = (await countBatches({ companyId, month })) + 1;
    const batchNumber = buildBatchNumber({ month, sequence });

    const batch = await PayrollPaymentBatchModel.create({
      companyId,
      month,
      cycle: setup?.payrollPolicy?.frequency || '',
      currency: setup?.payrollPolicy?.currency || 'INR',
      batchNumber,
      status: 'READY',
      paymentDate: paymentDate ? new Date(paymentDate) : null,
      paymentReferencePrefix: prefix,
      sourceBatchId: null,
      attempt: 1,
      summary: {},
      excluded,
      approval: {
        reviewId: review._id,
        approvedAt: review.approvedAt || null,
        approvedBy: review.approvedBy || null,
        runVersion: review.runVersion || 1,
      },
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });

    await Promise.all(
      rows.map((row, index) =>
        PayrollPaymentModel.create({
          companyId,
          month,
          batchId: batch._id,
          employeeId: row.employeeId,
          employeeCode: row.employeeCode,
          employeeName: row.employeeName,
          departmentName: row.departmentName,
          netSalary: row.netSalary,
          paymentReference: buildPaymentReference({ prefix, month, sequence: index + 1 }),
          status: 'PENDING',
          resultVersion: row.resultVersion,
          bank: row.bank,
        }),
      ),
    );

    await refreshSummary({ companyId, batch });
    await invalidate(companyId, month);

    await writeAudit({
      req,
      action: 'PAYMENT_BATCH_CREATED',
      companyId,
      resource: 'PayrollPaymentBatch',
      resourceId: batch._id,
      previousValue: null,
      newValue: {
        batchNumber,
        month,
        employees: rows.length,
        excluded: excluded.length,
        total: rows.reduce((sum, row) => sum + row.netSalary, 0),
      },
    });

    await notifyAudience({
      companyId,
      type: 'PAYMENT_BATCH_CREATED',
      payload: { month, batchNumber, employees: rows.length },
      actorId: actor?._id || null,
    });

    return getBatch({ companyId, batchId: batch._id, allowedEmployeeIds });
  };

  const countBatches = async ({ companyId, month }) => {
    const rows = await PayrollPaymentBatchModel.find({ companyId, month }).lean();
    return (rows || []).length;
  };

  const refreshSummary = async ({ companyId, batch }) => {
    const payments = await listPayments({ companyId, batchId: batch._id });
    const summary = batchSummary({ payments, excluded: batch.excluded || [] });
    await PayrollPaymentBatchModel.updateOne(
      { _id: batch._id, companyId },
      { $set: { summary } },
    );
    return summary;
  };

  // §7 — re-check every employee in the batch before a file is produced.
  const validateBatch = async ({ companyId, batchId, allowedEmployeeIds = null }) => {
    const batch = await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
    if (!batch) throw ApiError.notFound('Payment batch not found');

    const payments = await listPayments({ companyId, batchId, allowedEmployeeIds, withSecret: true });
    const employeeIds = payments.map((row) => String(row.employeeId));

    const profiles = employeeIds.length
      ? await EmployeePayrollProfileModel.find({ companyId, employeeId: { $in: employeeIds }, isCurrent: true })
          .select('+bank.accountNumber +bank.accountHolderName +bank.bankName +bank.ifsc')
          .lean()
      : [];
    const employees = employeeIds.length
      ? await UserModel.find({ _id: { $in: employeeIds } }).select('status').lean()
      : [];

    const profileById = new Map((profiles || []).map((row) => [String(row.employeeId), row]));
    const employeeById = new Map((employees || []).map((row) => [String(row._id), row]));

    const rows = payments
      .map((payment) => {
        const bank = payment.bank || {};
        const errors = validateEmployeeForPayment({
          employee: employeeById.get(String(payment.employeeId)) || null,
          profile: profileById.get(String(payment.employeeId)) || null,
          // Net salary was validated at creation; a zero here is impossible.
          result: { totals: { netPay: payment.netSalary } },
        });
        return errors.length
          ? {
              employeeId: payment.employeeId,
              employeeCode: payment.employeeCode,
              employeeName: payment.employeeName,
              errors,
              messages: validationMessages(errors).map((row) => row.message),
              ifsc: bank.ifsc || '',
            }
          : null;
      })
      .filter(Boolean);

    return {
      batchNumber: batch.batchNumber,
      valid: rows.length === 0,
      errorRows: rows,
      checked: payments.length,
    };
  };

  // ── bank file (§10 / §12 / §20) ──────────────────────────────────────────

  // The ONLY place a full account number is decrypted (§23).
  const buildFileContent = async ({ companyId, batchId, format, allowedEmployeeIds = null }) => {
    const payments = await listPayments({ companyId, batchId, allowedEmployeeIds, withSecret: true });

    const rows = (payments || []).map((row) => {
      const bank = row.bank || {};
      const decrypted = decrypt(bank.accountNumber);
      if (!decrypted) {
        throw ApiError.badRequest(
          `${row.employeeName || row.employeeCode || 'An employee'} has an unreadable bank account. Fix the payroll profile and create a retry batch.`,
        );
      }
      return {
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        accountHolderName: bank.accountHolderName || row.employeeName || '',
        accountNumber: String(decrypted).replace(/\s+/g, ''),
        ifsc: String(bank.ifsc || '').toUpperCase(),
        bankName: bank.bankName || '',
        netSalary: Number(row.netSalary || 0),
        paymentReference: row.paymentReference,
      };
    });

    const file = buildBankFile({ format, payments: rows });
    const size = file.format === 'XLSX' ? file.content.length : Buffer.byteLength(file.content, 'utf8');
    if (size > MAX_FILE_BYTES) {
      throw ApiError.badRequest('This bank file is too large to generate in one go');
    }

    return { file, rowCount: rows.length };
  };

  const persistFile = async ({ companyId, month, batchId, fileId, format, actor, allowedEmployeeIds }) => {
    const { file, rowCount } = await buildFileContent({ companyId, batchId, format, allowedEmployeeIds });
    const checksum = file.format === 'XLSX' ? hash(file.content) : hash(file.content);

    const update = {
      status: 'READY',
      rowCount,
      checksum,
      generatedAt: new Date(),
      generatedBy: actor?._id || null,
      generatedByName: actor?.name || '',
      error: '',
    };

    if (file.format === 'XLSX') update.binary = file.content;
    else update.content = file.content;

    await PayrollPaymentFileModel.updateOne({ _id: fileId, companyId }, { $set: update });

    await PayrollPaymentBatchModel.updateOne(
      { _id: batchId, companyId },
      { $set: { status: 'FILE_GENERATED' } },
    );

    return { file, rowCount };
  };

  const generateFile = async ({
    companyId,
    month,
    batchId,
    format = 'CSV',
    actor,
    req,
    allowedEmployeeIds = null,
  }) => {
    const key = String(format || 'CSV').toUpperCase();
    if (!BANK_FILE_FORMATS.includes(key)) throw ApiError.badRequest('Unsupported file format');

    const batch = await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
    if (!batch) throw ApiError.notFound('Payment batch not found');
    if (['PAID', 'CANCELLED'].includes(batch.status)) {
      throw ApiError.badRequest(`This batch is ${batch.status.toLowerCase().replace(/_/g, ' ')} and cannot be regenerated.`);
    }

    // §7 — never generate an invalid payment record.
    const check = await validateBatch({ companyId, batchId, allowedEmployeeIds });
    if (!check.valid) {
      throw ApiError.badRequest(
        `${check.errorRows.length} employee(s) failed bank validation. Fix them or remove them before generating the file.`,
        { errorRows: check.errorRows },
      );
    }

    let fileRow = null;
    if (PayrollPaymentFileModel) {
      fileRow = await PayrollPaymentFileModel.create({
        companyId,
        month: batch.month,
        batchId: batch._id,
        format: key,
        status: 'QUEUED',
        generatedBy: actor?._id || null,
        generatedByName: actor?.name || '',
      });
    }

    let queued = false;
    let jobId = '';
    try {
      const outcome = await dispatch({
        companyId,
        month: batch.month,
        batchId: String(batch._id),
        fileId: String(fileRow?._id || ''),
        format: key,
        actorId: String(actor?._id || ''),
      });
      queued = Boolean(outcome?.queued);
      jobId = outcome?.jobId || '';
    } catch {
      // A dead queue must not stop finance: build it inline instead.
      queued = false;
    }

    if (fileRow) {
      await PayrollPaymentFileModel.updateOne(
        { _id: fileRow._id, companyId },
        { $set: { queued, jobId, status: queued ? 'QUEUED' : 'PROCESSING' } },
      );
    }

    let content = '';
    let binary = null;
    if (!queued) {
      const built = await persistFile({
        companyId,
        month: batch.month,
        batchId: batch._id,
        fileId: fileRow?._id,
        format: key,
        actor,
        allowedEmployeeIds,
      });
      content = built.file.format === 'CSV' ? built.file.content : '';
      binary = built.file.format === 'XLSX' ? built.file.content : null;
    }

    await invalidate(companyId, batch.month);

    await writeAudit({
      req,
      action: 'PAYMENT_FILE_GENERATED',
      companyId,
      resource: 'PayrollPaymentFile',
      resourceId: fileRow?._id || batch._id,
      previousValue: { status: batch.status },
      newValue: { format: key, queued, batchNumber: batch.batchNumber, month: batch.month },
    });

    await notifyAudience({
      companyId,
      type: 'PAYMENT_FILE_READY',
      payload: { month: batch.month, batchNumber: batch.batchNumber, format: key },
      actorId: actor?._id || null,
    });

    return {
      batch: (await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean()) || batch,
      file: fileRow
        ? await PayrollPaymentFileModel.findOne({ _id: fileRow._id, companyId }).lean()
        : null,
      format: key,
      queued,
      content,
      binary,
    };
  };

  // §20 — the worker path: rebuild from Mongo, never from the payload.
  const processFile = async ({ companyId, batchId, fileId, format = 'CSV', actor = null }) => {
    if (!PayrollPaymentFileModel) return null;
    const fileRow = await PayrollPaymentFileModel.findOne({ _id: fileId, companyId }).lean();
    if (!fileRow) throw ApiError.notFound('Payment file not found');

    await PayrollPaymentFileModel.updateOne(
      { _id: fileId, companyId },
      { $set: { status: 'PROCESSING' } },
    );

    try {
      await persistFile({
        companyId,
        month: fileRow.month,
        batchId,
        fileId,
        format: fileRow.format || format,
        actor,
      });
      await invalidate(companyId, fileRow.month);
      return PayrollPaymentFileModel.findOne({ _id: fileId, companyId }).lean();
    } catch (error) {
      await PayrollPaymentFileModel.updateOne(
        { _id: fileId, companyId },
        { $set: { status: 'FAILED', error: String(error?.message || 'File generation failed').slice(0, 500) } },
      );
      throw error;
    }
  };

  // §12 — every download is counted; the batch moves to DOWNLOADED.
  const downloadFile = async ({ companyId, fileId, actor, req }) => {
    if (!PayrollPaymentFileModel) throw ApiError.notFound('Payment file not found');
    const fileRow = await PayrollPaymentFileModel.findOne({ _id: fileId, companyId })
      .select('+content +binary')
      .lean();
    if (!fileRow) throw ApiError.notFound('Payment file not found');
    if (fileRow.status !== 'READY') {
      throw ApiError.badRequest(
        fileRow.status === 'QUEUED' || fileRow.status === 'PROCESSING'
          ? 'This file is still being generated. Try again in a moment.'
          : 'This file could not be generated. Generate a new one.',
      );
    }

    await PayrollPaymentFileModel.updateOne(
      { _id: fileId, companyId },
      {
        $inc: { downloadCount: 1 },
        $set: { lastDownloadedAt: new Date(), lastDownloadedBy: actor?._id || null },
      },
    );

    const batch = await PayrollPaymentBatchModel.findOne({ _id: fileRow.batchId, companyId }).lean();
    if (batch && batch.status === 'FILE_GENERATED') {
      await PayrollPaymentBatchModel.updateOne(
        { _id: batch._id, companyId },
        { $set: { status: 'DOWNLOADED' } },
      );
    }

    // Re-read so the response and the audit carry the NEW count, not the one
    // from before this download.
    const updated = await PayrollPaymentFileModel.findOne({ _id: fileId, companyId })
      .select('+content +binary')
      .lean();

    await invalidate(companyId, fileRow.month);

    await writeAudit({
      req,
      action: 'PAYMENT_FILE_DOWNLOADED',
      companyId,
      resource: 'PayrollPaymentFile',
      resourceId: fileRow._id,
      previousValue: { downloadCount: fileRow.downloadCount || 0 },
      newValue: {
        downloadCount: Number(fileRow.downloadCount || 0) + 1,
        format: fileRow.format,
        batchId: String(fileRow.batchId),
      },
    });

    return {
      file: updated || fileRow,
      content: (updated || fileRow).format === 'XLSX' ? '' : (updated || fileRow).content || '',
      binary: (updated || fileRow).format === 'XLSX' ? (updated || fileRow).binary : null,
    };
  };

  // ── payment confirmation (§13 / §14 / §15) ───────────────────────────────

  // §26 — the documented flow is: generate the file → finance uploads it →
  // finance confirms. Confirming before a file exists would record a payment
  // with nothing behind it, so it is refused server-side, not just in the UI.
  const assertFileGenerated = (batch) => {
    if (['DRAFT', 'READY'].includes(batch?.status)) {
      throw ApiError.badRequest(
        'Generate the bank transfer file before confirming payment — there is nothing to have been uploaded yet.',
      );
    }
  };

  const moveBatch = async ({ companyId, batch, to, actor, req, reason = '', auditAction, notification = null }) => {
    const from = batch.status;
    if (from !== to && !canTransition(from, to)) {
      throw ApiError.badRequest(transitionError(from, to));
    }
    await PayrollPaymentBatchModel.updateOne(
      { _id: batch._id, companyId },
      { $set: { status: to, updatedBy: actor?._id || null } },
    );
    await writeAudit({
      req,
      action: auditAction,
      companyId,
      resource: 'PayrollPaymentBatch',
      resourceId: batch._id,
      previousValue: { status: from },
      newValue: { status: to, batchNumber: batch.batchNumber, month: batch.month, reason: reason || null },
    });
    if (notification) {
      await notifyAudience({
        companyId,
        type: notification,
        payload: { month: batch.month, batchNumber: batch.batchNumber, reason: reason || '' },
        actorId: actor?._id || null,
      });
    }
    return to;
  };

  const markAllPaid = async ({ companyId, batchId, actor, req, allowedEmployeeIds = null }) => {
    const batch = await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
    if (!batch) throw ApiError.notFound('Payment batch not found');
    if (['PAID', 'CANCELLED'].includes(batch.status)) {
      throw ApiError.badRequest(`This batch is ${batch.status.toLowerCase().replace(/_/g, ' ')} and cannot be confirmed.`);
    }
    assertFileGenerated(batch);

    const pending = await listPayments({ companyId, batchId, allowedEmployeeIds });
    const targets = pending.filter((row) => row.status !== 'PAID');
    if (!targets.length) {
      throw ApiError.badRequest('Every payment in this batch is already marked.');
    }

    await PayrollPaymentModel.updateMany(
      { companyId, batchId, status: { $ne: 'PAID' } },
      {
        $set: {
          status: 'PAID',
          failureReason: '',
          paidAt: new Date(),
          paidBy: actor?._id || null,
          markedAt: new Date(),
          markedBy: actor?._id || null,
        },
      },
    );

    const summary = await refreshSummary({ companyId, batch });
    const next = statusAfterMarking(summary);
    await moveBatch({
      companyId,
      batch,
      to: next,
      actor,
      req,
      auditAction: 'PAYMENT_CONFIRMED',
      notification: 'PAYMENT_CONFIRMED',
    });

    await invalidate(companyId, batch.month);
    return getBatch({ companyId, batchId, allowedEmployeeIds });
  };

  const markEmployee = async ({
    companyId,
    batchId,
    employeeId,
    status,
    failureReason = '',
    remarks = '',
    actor,
    req,
    allowedEmployeeIds = null,
  }) => {
    const batch = await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
    if (!batch) throw ApiError.notFound('Payment batch not found');
    if (batch.status === 'CANCELLED') throw ApiError.badRequest('This batch is cancelled.');
    if (batch.status === 'PAID') {
      throw ApiError.badRequest('This batch is already paid. Reopen it before changing a payment.');
    }
    assertFileGenerated(batch);
    if (Array.isArray(allowedEmployeeIds) && !allowedEmployeeIds.some((id) => String(id) === String(employeeId))) {
      throw ApiError.forbidden('This employee is outside your payroll scope');
    }
    if (!['PAID', 'FAILED', 'PENDING'].includes(status)) {
      throw ApiError.badRequest('Payment status must be paid, failed or pending');
    }
    if (status === 'FAILED' && !FAILURE_REASONS.includes(failureReason)) {
      throw ApiError.badRequest('Choose a reason for the failed payment');
    }

    const payment = await PayrollPaymentModel.findOne({ companyId, batchId, employeeId }).lean();
    if (!payment) throw ApiError.notFound('Payment not found in this batch');

    const previous = payment.status;

    await PayrollPaymentModel.updateOne(
      { _id: payment._id, companyId },
      {
        $set: {
          status,
          failureReason: status === 'FAILED' ? failureReason : '',
          remarks: String(remarks || '').slice(0, 500),
          paidAt: status === 'PAID' ? new Date() : null,
          paidBy: status === 'PAID' ? actor?._id || null : null,
          markedAt: new Date(),
          markedBy: actor?._id || null,
        },
      },
    );

    const summary = await refreshSummary({ companyId, batch });
    const next = statusAfterMarking(summary);
    if (next !== batch.status && batch.status !== 'CANCELLED') {
      await moveBatch({
        companyId,
        batch,
        to: next,
        actor,
        req,
        auditAction: status === 'FAILED' ? 'PAYMENT_FAILED' : 'PAYMENT_CONFIRMED',
        notification: status === 'FAILED' ? 'PAYMENT_FAILED' : null,
      });
    }

    await writeAudit({
      req,
      action: status === 'FAILED' ? 'PAYMENT_EMPLOYEE_FAILED' : 'PAYMENT_EMPLOYEE_PAID',
      companyId,
      resource: 'PayrollPayment',
      resourceId: payment._id,
      previousValue: { status: previous },
      newValue: {
        status,
        employeeId: String(employeeId),
        paymentReference: payment.paymentReference,
        failureReason: status === 'FAILED' ? failureReason : null,
      },
    });

    await invalidate(companyId, batch.month);
    return getBatch({ companyId, batchId, allowedEmployeeIds });
  };

  // ── retry batches (§15 / §16) ────────────────────────────────────────────

  const createRetryBatch = async ({ companyId, batchId, actor, req, allowedEmployeeIds = null }) => {
    const original = await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
    if (!original) throw ApiError.notFound('Payment batch not found');
    if (original.status === 'CANCELLED') {
      throw ApiError.badRequest('A cancelled batch cannot be retried.');
    }
    if (Number(original.summary?.failedTransactions || 0) === 0 && Number(original.summary?.pendingTransactions || 0) === 0) {
      throw ApiError.badRequest('This batch has no failed or pending payments to retry.');
    }

    // §15 — never pay the same employee twice: skip anyone already PAID in any
    // batch of this month (the original or an earlier retry).
    const paidRows = await PayrollPaymentModel.find({
      companyId,
      month: original.month,
      status: 'PAID',
    })
      .select('employeeId')
      .lean();
    const paidIds = new Set((paidRows || []).map((row) => String(row.employeeId)));

    const source = await listPayments({
      companyId,
      batchId: original._id,
      allowedEmployeeIds,
      withSecret: true,
    });
    const retryable = source.filter(
      (row) => row.status !== 'PAID' && !paidIds.has(String(row.employeeId)),
    );

    if (!retryable.length) {
      throw ApiError.badRequest('Every payment from this batch is already paid.');
    }

    const sequence = (await countBatches({ companyId, month: original.month })) + 1;
    const batchNumber = buildBatchNumber({ month: original.month, sequence });
    const prefix = sanitisePrefix(original.paymentReferencePrefix);

    const batch = await PayrollPaymentBatchModel.create({
      companyId,
      month: original.month,
      cycle: original.cycle,
      currency: original.currency,
      batchNumber,
      status: 'READY',
      paymentDate: new Date(),
      paymentReferencePrefix: prefix,
      sourceBatchId: original._id,
      attempt: Number(original.attempt || 1) + 1,
      summary: {},
      excluded: original.excluded || [],
      approval: original.approval || {},
      createdBy: actor?._id || null,
      updatedBy: actor?._id || null,
    });

    // §11 — a retry gets fresh references; the reference is per transaction.
    let referenceSequence = 0;
    const usedReferences = new Set(
      (
        await PayrollPaymentModel.find({ companyId, month: original.month })
          .select('paymentReference')
          .lean()
      ).map((row) => row.paymentReference),
    );

    for (const row of retryable) {
      let reference = '';
      do {
        referenceSequence += 1;
        reference = buildPaymentReference({
          prefix,
          month: original.month,
          sequence: Number(original.summary?.totalTransactions || retryable.length) + referenceSequence,
        });
      } while (usedReferences.has(reference));

      await PayrollPaymentModel.create({
        companyId,
        month: original.month,
        batchId: batch._id,
        employeeId: row.employeeId,
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        departmentName: row.departmentName,
        netSalary: row.netSalary,
        paymentReference: reference,
        status: 'PENDING',
        resultVersion: row.resultVersion,
        bank: row.bank,
      });
    }

    await refreshSummary({ companyId, batch });
    await invalidate(companyId, original.month);

    await writeAudit({
      req,
      action: 'PAYMENT_RETRY_CREATED',
      companyId,
      resource: 'PayrollPaymentBatch',
      resourceId: batch._id,
      previousValue: { sourceBatchId: String(original._id), batchNumber: original.batchNumber },
      newValue: { batchNumber, employees: retryable.length, attempt: batch.attempt },
    });

    await notifyAudience({
      companyId,
      type: 'PAYMENT_RETRY_CREATED',
      payload: { month: original.month, batchNumber, employees: retryable.length },
      actorId: actor?._id || null,
    });

    return getBatch({ companyId, batchId: batch._id, allowedEmployeeIds });
  };

  // ── cancel / reopen (§4 / §8 / §22) ──────────────────────────────────────

  const cancelBatch = async ({ companyId, batchId, reason = '', actor, req }) => {
    const batch = await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
    if (!batch) throw ApiError.notFound('Payment batch not found');
    if (batch.status === 'PAID') {
      throw ApiError.badRequest('A paid batch cannot be cancelled.');
    }

    await PayrollPaymentBatchModel.updateOne(
      { _id: batch._id, companyId },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: actor?._id || null,
          remarks: String(reason || '').slice(0, 2000),
          updatedBy: actor?._id || null,
        },
      },
    );

    await invalidate(companyId, batch.month);

    await writeAudit({
      req,
      action: 'PAYMENT_CANCELLED',
      companyId,
      resource: 'PayrollPaymentBatch',
      resourceId: batch._id,
      previousValue: { status: batch.status },
      newValue: { status: 'CANCELLED', batchNumber: batch.batchNumber, reason: reason || null },
    });

    await notifyAudience({
      companyId,
      type: 'PAYMENT_CANCELLED',
      payload: { month: batch.month, batchNumber: batch.batchNumber, reason: reason || '' },
      actorId: actor?._id || null,
    });

    return PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
  };

  // §4 — Company Admin may reopen a failed batch to fix and regenerate it.
  const reopenBatch = async ({ companyId, batchId, actor, req, allowedEmployeeIds = null }) => {
    const batch = await PayrollPaymentBatchModel.findOne({ _id: batchId, companyId }).lean();
    if (!batch) throw ApiError.notFound('Payment batch not found');
    if (batch.status !== 'FAILED') {
      throw ApiError.badRequest('Only a failed batch can be reopened.');
    }

    await moveBatch({
      companyId,
      batch,
      to: 'READY',
      actor,
      req,
      auditAction: 'PAYMENT_BATCH_REOPENED',
    });

    await invalidate(companyId, batch.month);
    return getBatch({ companyId, batchId, allowedEmployeeIds });
  };

  return {
    getDashboard,
    listBatches,
    getBatch,
    getBatchAudit,
    validateBatch,
    createBatch,
    generateFile,
    processFile,
    downloadFile,
    markAllPaid,
    markEmployee,
    createRetryBatch,
    cancelBatch,
    reopenBatch,
    invalidate,
  };
};

import PayrollPaymentBatch from '../../models/PayrollPaymentBatch.js';
import PayrollPayment from '../../models/PayrollPayment.js';
import PayrollPaymentFile from '../../models/PayrollPaymentFile.js';
import AuditLog from '../../models/AuditLog.js';
import PayrollResult from '../../models/PayrollResult.js';
import PayrollReview from '../../models/PayrollReview.js';
import PayrollSetup from '../../models/PayrollSetup.js';
import EmployeePayrollProfile from '../../models/EmployeePayrollProfile.js';
import User from '../../models/User.js';
import Department from '../../models/Department.js';
import CompanyRole from '../../models/CompanyRole.js';
import Permission from '../../models/Permission.js';
import {
  buildTenantCacheKey,
  deleteCache,
  getOrSetCache,
  noteCacheInvalidation,
} from '../redisCacheService.js';
import { recordAudit } from '../../utils/securityauditService.js';
import notifySmart from '../../utils/notifyPref.js';
import { decryptSensitiveValue } from '../../utils/fieldEncryption.js';
import { dispatchPayrollPaymentFile } from './payrollPaymentDispatcher.js';
import { notificationCopy as paymentNotificationCopy } from './payrollPaymentRules.js';
import { createHash } from 'node:crypto';

// §21 — resolve the audience by permission (same resolver shape as 29.7).
const resolveAudience = async ({ companyId, permissions = [] }) => {
  const names = (permissions || []).filter((name) => typeof name === 'string');
  if (!companyId || !names.length) return [];

  const permissionDocs = await Permission.find({ name: { $in: names } }).select('_id').lean();
  if (!permissionDocs.length) return [];

  const roles = await CompanyRole.find({
    companyId,
    isActive: true,
    permissions: { $in: permissionDocs.map((doc) => doc._id) },
  })
    .select('code systemRoleKey')
    .lean();

  const roleKeys = [
    ...new Set(roles.map((role) => role.systemRoleKey || role.code).filter(Boolean)),
  ];
  if (!roleKeys.length) return [];

  const users = await User.find({ companyId, status: 'ACTIVE', role: { $in: roleKeys } })
    .select('_id')
    .lean();

  return users.map((user) => user._id);
};

const defaultService = makePayrollPaymentService({
  PayrollPaymentBatchModel: PayrollPaymentBatch,
  PayrollPaymentModel: PayrollPayment,
  PayrollPaymentFileModel: PayrollPaymentFile,
  PayrollResultModel: PayrollResult,
  PayrollReviewModel: PayrollReview,
  PayrollSetupModel: PayrollSetup,
  EmployeePayrollProfileModel: EmployeePayrollProfile,
  UserModel: User,
  DepartmentModel: Department,
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
  notify: ({ userId, type, payload = {} }) =>
    notifySmart(userId, {
      title: 'Salary payment',
      message: paymentNotificationCopy(type, payload),
      link: `/app/payroll/payments?month=${payload?.month || ''}`,
      category: 'PAYROLL',
      metadata: { type, ...payload },
    }),
  audience: resolveAudience,
  // §18 — the batch detail page shows every recorded action for the batch,
  // its payment rows and its generated files, newest first.
  readAudit: async ({ companyId, targetIds = [], limit = 200 } = {}) =>
    AuditLog.find({ companyId, targetId: { $in: targetIds } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
  dispatch: dispatchPayrollPaymentFile,
  decrypt: decryptSensitiveValue,
  hash: (value) =>
    createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8')).digest('hex'),
});

export default defaultService;
