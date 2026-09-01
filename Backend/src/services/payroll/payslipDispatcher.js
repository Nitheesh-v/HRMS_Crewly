// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP DISPATCHER (§17 / §18 / §24)
//
//  Three background jobs on the EXISTING `payroll` queue — no new queue:
//
//    payslip-generate  bulk PDF generation for a month (progress tracked)
//    payslip-zip       bulk download: department ZIP or company ZIP
//    payslip-email     bulk email delivery with the PDF attached
//
//  Every payload carries REFERENCES ONLY: no salary figure, no employee name,
//  no PDF bytes. The worker rebuilds from MongoDB, so a stale or tampered
//  payload cannot leak another company's salary data (§26).
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

import logger from '../../config/logger.js';
import { enqueueJob } from '../../queues/queueFactory.js';
import { JOB_NAMES, QUEUE_NAMES, getPayrollJobOptions } from '../../config/queueConfig.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// A payslip payload must never carry salary data — the worker re-reads it
// from the immutable snapshot instead.
const FORBIDDEN_KEYS = [
  'payslips',
  'snapshot',
  'earnings',
  'deductions',
  'netSalary',
  'accountNumber',
  'pdf',
  'binary',
  'attachments',
];

const baseValidation = (payload = {}, required = []) => {
  const errors = [];

  if (!mongoose.isValidObjectId(payload.companyId)) errors.push('companyId is invalid');
  if (payload.actorId && !mongoose.isValidObjectId(payload.actorId)) errors.push('actorId is invalid');
  if (!MONTH_PATTERN.test(String(payload.month || ''))) errors.push('month must look like 2026-08');

  required.forEach((key) => {
    if (key === 'month') return;
    if (!mongoose.isValidObjectId(payload[key])) errors.push(`${key} is invalid`);
  });

  FORBIDDEN_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      errors.push(`${key} must not be queued`);
    }
  });

  return errors;
};

// ── bulk generation (§17) ──────────────────────────────────────────────────

export const validatePayslipGeneratePayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload, []);
  return { valid: errors.length === 0, errors, value: payload };
};

export const payslipGenerateJobId = (companyId, month) =>
  `payslip-generate-${companyId}-${month}`;

export const dispatchPayslipGenerate = async (payload = {}) => {
  const { valid, errors } = validatePayslipGeneratePayload(payload);
  if (!valid) throw new Error(`Invalid payslip generate payload: ${errors.join(', ')}`);

  const jobId = payslipGenerateJobId(payload.companyId, payload.month);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.PAYSLIP_GENERATE,
    {
      companyId: String(payload.companyId),
      month: String(payload.month),
      actorId: payload.actorId ? String(payload.actorId) : '',
      requestedAt: new Date().toISOString(),
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(
    `[Payroll] payslip generation dispatched (company=${payload.companyId}, month=${payload.month}, job=${job?.id ?? jobId})`,
  );

  return { queued: true, jobId: job?.id ? String(job.id) : jobId, job };
};

// ── bulk ZIP download (§18) ────────────────────────────────────────────────

export const validatePayslipZipPayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload, ['fileId']);
  if (!['COMPANY', 'DEPARTMENT'].includes(String(payload.scope || '').toUpperCase())) {
    errors.push('scope must be COMPANY or DEPARTMENT');
  }
  if (
    String(payload.scope || '').toUpperCase() === 'DEPARTMENT' &&
    !mongoose.isValidObjectId(payload.departmentId)
  ) {
    errors.push('departmentId is invalid for a DEPARTMENT scope');
  }
  return { valid: errors.length === 0, errors, value: payload };
};

export const payslipZipJobId = (fileId) => `payslip-zip-${fileId}`;

export const dispatchPayslipZip = async (payload = {}) => {
  const { valid, errors } = validatePayslipZipPayload(payload);
  if (!valid) throw new Error(`Invalid payslip zip payload: ${errors.join(', ')}`);

  const jobId = payslipZipJobId(payload.fileId);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.PAYSLIP_ZIP,
    {
      companyId: String(payload.companyId),
      month: String(payload.month),
      fileId: String(payload.fileId),
      scope: String(payload.scope || 'COMPANY').toUpperCase(),
      departmentId: payload.departmentId ? String(payload.departmentId) : '',
      actorId: payload.actorId ? String(payload.actorId) : '',
      requestedAt: new Date().toISOString(),
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(
    `[Payroll] payslip zip dispatched (file=${payload.fileId}, scope=${payload.scope}, job=${job?.id ?? jobId})`,
  );

  return { queued: true, jobId: job?.id ? String(job.id) : jobId, job };
};

// ── bulk email (§19 / §24) ─────────────────────────────────────────────────

export const validatePayslipEmailPayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload, []);
  const employeeIds = Array.isArray(payload.employeeIds) ? payload.employeeIds : null;
  if (employeeIds && employeeIds.some((id) => !mongoose.isValidObjectId(id))) {
    errors.push('employeeIds contains an invalid id');
  }
  return { valid: errors.length === 0, errors, value: payload };
};

export const payslipEmailJobId = (companyId, month) => `payslip-email-${companyId}-${month}`;

export const dispatchPayslipEmail = async (payload = {}) => {
  const { valid, errors } = validatePayslipEmailPayload(payload);
  if (!valid) throw new Error(`Invalid payslip email payload: ${errors.join(', ')}`);

  const jobId = payslipEmailJobId(payload.companyId, payload.month);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.PAYSLIP_EMAIL,
    {
      companyId: String(payload.companyId),
      month: String(payload.month),
      employeeIds: (payload.employeeIds || []).map((id) => String(id)),
      actorId: payload.actorId ? String(payload.actorId) : '',
      requestedAt: new Date().toISOString(),
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(
    `[Payroll] payslip email dispatched (company=${payload.companyId}, month=${payload.month}, job=${job?.id ?? jobId})`,
  );

  return { queued: true, jobId: job?.id ? String(job.id) : jobId, job };
};

export default {
  dispatchPayslipGenerate,
  dispatchPayslipZip,
  dispatchPayslipEmail,
  validatePayslipGeneratePayload,
  validatePayslipZipPayload,
  validatePayslipEmailPayload,
  payslipGenerateJobId,
  payslipZipJobId,
  payslipEmailJobId,
};
