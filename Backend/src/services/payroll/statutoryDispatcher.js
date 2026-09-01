// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY DISPATCHER (§21 / §22)
//
//  Three background jobs on the EXISTING `payroll` queue — no new queue:
//
//    statutory-generate  generate every applicable report for a month
//    statutory-export    large Excel / annual reports / PDF summaries
//    compliance-reminder notify Finance about filings due or overdue
//
//  §21 — "Do not calculate payroll inside BullMQ. Use it only for report
//  generation." Every payload carries REFERENCES ONLY: no salary figure, no
//  employee name, no PAN, no UAN. The worker rebuilds from the 29.6
//  snapshots, so a stale or tampered payload cannot leak another tenant's
//  statutory data (§24).
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

import logger from '../../config/logger.js';
import { enqueueJob } from '../../queues/queueFactory.js';
import { JOB_NAMES, QUEUE_NAMES, getPayrollJobOptions } from '../../config/queueConfig.js';
import {
  EXPORT_FORMATS,
  REPORT_KEYS,
  isReportKey,
  normaliseFormat,
} from './statutoryRules.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const FY_PATTERN = /^\d{4}-\d{2}$/;

// Nothing that identifies a person or a rupee may travel through Redis.
const FORBIDDEN_KEYS = [
  'rows',
  'summary',
  'snapshot',
  'binary',
  'content',
  'report',
  'employees',
  'pan',
  'uan',
  'esiNumber',
  'grossPayroll',
  'netPayroll',
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

// ── monthly report generation (§6 / §21) ───────────────────────────────────

export const validateStatutoryGeneratePayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload);
  if (!MONTH_PATTERN.test(String(payload.month || ''))) errors.push('month must look like 2026-08');
  return { valid: errors.length === 0, errors, value: payload };
};

export const statutoryGenerateJobId = (companyId, month) => `statutory-generate-${companyId}-${month}`;

export const dispatchStatutoryGenerate = async (payload = {}) => {
  const { valid, errors } = validateStatutoryGeneratePayload(payload);
  if (!valid) throw new Error(`Invalid statutory generate payload: ${errors.join(', ')}`);

  const jobId = statutoryGenerateJobId(payload.companyId, payload.month);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.STATUTORY_GENERATE,
    {
      companyId: String(payload.companyId),
      month: String(payload.month),
      actorId: payload.actorId ? String(payload.actorId) : '',
      requestedAt: new Date().toISOString(),
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(
    `[Payroll] statutory generation dispatched (company=${payload.companyId}, month=${payload.month}, job=${job?.id ?? jobId})`,
  );

  return { queued: true, jobId: job?.id ? String(job.id) : jobId, job };
};

// ── export file (§15 / §18 / §21) ──────────────────────────────────────────

export const validateStatutoryExportPayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload);

  if (!mongoose.isValidObjectId(payload.exportId)) errors.push('exportId is invalid');
  if (!isReportKey(payload.reportKey)) errors.push('reportKey is not a known statutory report');
  if (!EXPORT_FORMATS.includes(normaliseFormat(payload.format))) errors.push('format must be CSV, XLSX or PDF');

  // A monthly export carries a month; an annual one carries a financial year.
  // At least one of the two must be present and well-formed.
  const month = String(payload.month || '');
  const fy = String(payload.financialYear || '');
  const monthOk = month ? MONTH_PATTERN.test(month) : false;
  const fyOk = fy ? FY_PATTERN.test(fy) : false;
  if (!monthOk && !fyOk) errors.push('month must look like 2026-08 or financialYear like 2026-27');

  return { valid: errors.length === 0, errors, value: payload };
};

export const statutoryExportJobId = (exportId) => `statutory-export-${exportId}`;

export const dispatchStatutoryExport = async (payload = {}) => {
  const { valid, errors } = validateStatutoryExportPayload(payload);
  if (!valid) throw new Error(`Invalid statutory export payload: ${errors.join(', ')}`);

  const jobId = statutoryExportJobId(payload.exportId);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.STATUTORY_EXPORT,
    {
      companyId: String(payload.companyId),
      month: String(payload.month || ''),
      financialYear: String(payload.financialYear || ''),
      exportId: String(payload.exportId),
      reportKey: String(payload.reportKey),
      format: normaliseFormat(payload.format),
      actorId: payload.actorId ? String(payload.actorId) : '',
      requestedAt: new Date().toISOString(),
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(
    `[Payroll] statutory export dispatched (report=${payload.reportKey}, export=${payload.exportId}, job=${job?.id ?? jobId})`,
  );

  return { queued: true, jobId: job?.id ? String(job.id) : jobId, job };
};

// ── compliance reminders (§19 / §22) ───────────────────────────────────────

export const validateComplianceReminderPayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload);
  // A reminder sweep is company-wide: it looks at every open filing, so a
  // month is optional. When it is present it must still be well-formed.
  const month = String(payload.month || '');
  if (month && !MONTH_PATTERN.test(month)) errors.push('month must look like 2026-08');
  return { valid: errors.length === 0, errors, value: payload };
};

export const complianceReminderJobId = (companyId, month = '') =>
  month ? `compliance-reminder-${companyId}-${month}` : `compliance-reminder-${companyId}`;

export const dispatchComplianceReminder = async (payload = {}) => {
  const { valid, errors } = validateComplianceReminderPayload(payload);
  if (!valid) throw new Error(`Invalid compliance reminder payload: ${errors.join(', ')}`);

  const jobId = complianceReminderJobId(payload.companyId, payload.month);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.COMPLIANCE_REMINDER,
    {
      companyId: String(payload.companyId),
      month: String(payload.month || ''),
      actorId: payload.actorId ? String(payload.actorId) : '',
      requestedAt: new Date().toISOString(),
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(
    `[Payroll] compliance reminder dispatched (company=${payload.companyId}, month=${payload.month || 'all'}, job=${job?.id ?? jobId})`,
  );

  return { queued: true, jobId: job?.id ? String(job.id) : jobId, job };
};

export default {
  dispatchStatutoryGenerate,
  dispatchStatutoryExport,
  dispatchComplianceReminder,
  validateStatutoryGeneratePayload,
  validateStatutoryExportPayload,
  validateComplianceReminderPayload,
  statutoryGenerateJobId,
  statutoryExportJobId,
  complianceReminderJobId,
};
