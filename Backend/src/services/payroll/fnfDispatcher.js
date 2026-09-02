// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT DISPATCHER (§21 / §22)
//
//  Two background jobs on the EXISTING `payroll` queue — no new queue:
//
//    fnf-statement   the F&F statement PDF for one settlement
//    fnf-register    the bulk settlement register (CSV / XLSX)
//
//  §21 — "Do not calculate payroll through BullMQ. Use it only for long-
//  running document generation." Every payload carries REFERENCES ONLY: no
//  amount, no employee name, no bank detail, no document bytes. The worker
//  rebuilds everything from MongoDB, so a stale or tampered payload cannot
//  leak another tenant's settlement (§24).
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

import logger from '../../config/logger.js';
import { enqueueJob } from '../../queues/queueFactory.js';
import { JOB_NAMES, QUEUE_NAMES, getPayrollJobOptions } from '../../config/queueConfig.js';
import { EXPORT_FORMATS, normaliseFormat } from './fnfRules.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// Nothing that identifies a person or a rupee may travel through Redis.
const FORBIDDEN_KEYS = [
  'settlement',
  'statements',
  'rows',
  'totals',
  'earnings',
  'recoveries',
  'binary',
  'content',
  'netSettlement',
  'employeeName',
  'bank',
  'accountNumber',
];

const baseValidation = (payload = {}) => {
  const errors = [];

  if (!mongoose.isValidObjectId(payload.companyId)) errors.push('companyId is invalid');
  if (payload.actorId && !mongoose.isValidObjectId(payload.actorId)) errors.push('actorId is invalid');

  FORBIDDEN_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      errors.push(`${key} must not be queued`);
    }
  });

  return errors;
};

// ── the F&F statement PDF (§17 / §21) ──────────────────────────────────────

export const validateFnfStatementPayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload);

  if (!mongoose.isValidObjectId(payload.settlementId)) errors.push('settlementId is invalid');
  if (payload.fileId && !mongoose.isValidObjectId(payload.fileId)) errors.push('fileId is invalid');

  return { valid: errors.length === 0, errors, value: payload };
};

export const fnfStatementJobId = (settlementId) => `fnf-statement-${settlementId}`;

export const dispatchFnfStatement = async (payload = {}) => {
  const { valid, errors } = validateFnfStatementPayload(payload);
  if (!valid) throw new Error(`Invalid F&F statement payload: ${errors.join(', ')}`);

  const jobId = fnfStatementJobId(payload.settlementId);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.FNF_STATEMENT,
    {
      companyId: String(payload.companyId),
      settlementId: String(payload.settlementId),
      fileId: payload.fileId ? String(payload.fileId) : '',
      actorId: payload.actorId ? String(payload.actorId) : '',
      requestedAt: new Date().toISOString(),
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(
    `[Payroll] F&F statement dispatched (settlement=${payload.settlementId}, job=${job?.id ?? jobId})`,
  );

  return { queued: true, jobId: job?.id ? String(job.id) : jobId, job };
};

// ── the bulk settlement register (§21) ─────────────────────────────────────

export const validateFnfRegisterPayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload);

  if (!mongoose.isValidObjectId(payload.fileId)) errors.push('fileId is invalid');
  // Checked as typed: normaliseFormat() would quietly turn a PDF into CSV,
  // which is exactly the coercion a validator must not perform.
  if (!EXPORT_FORMATS.includes(String(payload.format || '').toUpperCase())) {
    errors.push('format must be CSV or XLSX');
  }

  // A register may be for one month or for everything; the month, when given,
  // must still be well-formed.
  const month = String(payload.month || '');
  if (month && !MONTH_PATTERN.test(month)) errors.push('month must look like 2026-08');

  return { valid: errors.length === 0, errors, value: payload };
};

export const fnfRegisterJobId = (fileId) => `fnf-register-${fileId}`;

export const dispatchFnfRegister = async (payload = {}) => {
  const { valid, errors } = validateFnfRegisterPayload(payload);
  if (!valid) throw new Error(`Invalid F&F register payload: ${errors.join(', ')}`);

  const jobId = fnfRegisterJobId(payload.fileId);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.FNF_REGISTER,
    {
      companyId: String(payload.companyId),
      fileId: String(payload.fileId),
      month: String(payload.month || ''),
      format: normaliseFormat(payload.format),
      actorId: payload.actorId ? String(payload.actorId) : '',
      requestedAt: new Date().toISOString(),
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(
    `[Payroll] F&F register dispatched (file=${payload.fileId}, format=${payload.format}, job=${job?.id ?? jobId})`,
  );

  return { queued: true, jobId: job?.id ? String(job.id) : jobId, job };
};

export default {
  dispatchFnfStatement,
  dispatchFnfRegister,
  validateFnfStatementPayload,
  validateFnfRegisterPayload,
  fnfStatementJobId,
  fnfRegisterJobId,
};
