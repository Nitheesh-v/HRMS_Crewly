// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.8 — BANK FILE DISPATCHER (§20)
//
//  File generation goes to the existing `payroll` queue as `payroll-payment-file`.
//  The payload carries REFERENCES ONLY: no account number, no amount, no name.
//  The worker rebuilds the file from Mongo, so a stale or tampered payload
//  cannot leak another company's bank details.
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

import logger from '../../config/logger.js';
import { enqueueJob } from '../../queues/queueFactory.js';
import { JOB_NAMES, QUEUE_NAMES, getPayrollJobOptions } from '../../config/queueConfig.js';
import { BANK_FILE_FORMATS } from './payrollPaymentRules.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// The worker revalidates with the same function before it touches MongoDB.
export const validatePayrollPaymentFilePayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = [];

  if (!mongoose.isValidObjectId(payload.companyId)) errors.push('companyId is invalid');
  if (!mongoose.isValidObjectId(payload.batchId)) errors.push('batchId is invalid');
  if (!mongoose.isValidObjectId(payload.fileId)) errors.push('fileId is invalid');
  if (payload.actorId && !mongoose.isValidObjectId(payload.actorId)) errors.push('actorId is invalid');
  if (!MONTH_PATTERN.test(String(payload.month || ''))) errors.push('month must look like 2026-08');
  if (!BANK_FILE_FORMATS.includes(String(payload.format || '').toUpperCase())) {
    errors.push('format must be CSV or XLSX');
  }

  // A payload that smuggles salary or bank data is rejected outright.
  const forbidden = ['payments', 'accountNumber', 'netSalary', 'content', 'rows', 'binary'];
  forbidden.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(payload, key)) errors.push(`${key} must not be queued`);
  });

  return { valid: errors.length === 0, errors, value: payload };
};

export const paymentFileJobId = (fileId) => `payroll-payment-file-${fileId}`;

export const dispatchPayrollPaymentFile = async (payload = {}) => {
  const { valid, errors } = validatePayrollPaymentFilePayload(payload);
  if (!valid) throw new Error(`Invalid payment file payload: ${errors.join(', ')}`);

  const jobId = paymentFileJobId(payload.fileId);

  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.PAYROLL_PAYMENT_FILE,
    {
      companyId: String(payload.companyId),
      month: payload.month,
      batchId: String(payload.batchId),
      fileId: String(payload.fileId),
      format: String(payload.format || 'CSV').toUpperCase(),
      actorId: payload.actorId ? String(payload.actorId) : '',
      requestedAt: new Date().toISOString(),
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(
    `[Payroll] payment file dispatched (batch=${payload.batchId}, format=${payload.format}, job=${job?.id ?? jobId})`,
  );

  return { queued: true, jobId: job?.id ? String(job.id) : jobId, job };
};
