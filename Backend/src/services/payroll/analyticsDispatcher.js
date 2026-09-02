// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — ANALYTICS DISPATCHER (§20 / §22)
//
//  Three background jobs on the EXISTING `payroll` queue — no new queue:
//
//    analytics-export    a large report file (XLSX / PDF / CSV)
//    analytics-schedule  one scheduled report, delayed until its due date
//    analytics-refresh   warm the executive dashboard cache
//
//  §22 — "Do not perform heavy aggregation synchronously." The aggregation
//  still happens in the service, never here and never in the payload: every
//  job carries REFERENCES ONLY. The worker rebuilds from MongoDB, so a stale
//  or tampered payload cannot leak another tenant's payroll (§3 / §25).
// ═══════════════════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

import logger from '../../config/logger.js';
import { enqueueJob } from '../../queues/queueFactory.js';
import { JOB_NAMES, QUEUE_NAMES, getPayrollJobOptions } from '../../config/queueConfig.js';
import { REPORT_KEYS } from './analyticsRules.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const FORMATS = ['CSV', 'XLSX', 'PDF'];

// Nothing that could identify a person or a rupee may travel through Redis.
const FORBIDDEN_KEYS = [
  'rows',
  'summary',
  'report',
  'content',
  'binary',
  'employeeId',
  'employeeName',
  'employeeCode',
  'gross',
  'net',
  'netSalary',
  'totalPayrollCost',
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

// ── a large export (§19 / §22) ─────────────────────────────────────────────

export const validateAnalyticsExportPayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload);

  if (!mongoose.isValidObjectId(payload.fileId)) errors.push('fileId is invalid');
  if (!REPORT_KEYS.includes(String(payload.reportKey || '').toUpperCase())) errors.push('reportKey is invalid');
  // A validator must REJECT what it does not understand, never coerce it into
  // something it does — the same rule that fixed 29.11's `PDF` → `CSV` bug.
  // Checked as delivered. Normalising the case would be harmless in itself,
  // but the 29.11 audit's rule is that a validator reports what it did not
  // understand instead of quietly fixing it: a caller sending 'pdf'
  // should learn that, not have it silently accepted.
  if (!FORMATS.includes(payload.format)) errors.push('format must be CSV, XLSX or PDF');

  const filters = payload.filters && typeof payload.filters === 'object' && !Array.isArray(payload.filters) ? payload.filters : {};
  if (filters.month && !MONTH_PATTERN.test(String(filters.month))) errors.push('filters.month is invalid');
  if (filters.employeeId && !mongoose.isValidObjectId(filters.employeeId)) errors.push('filters.employeeId is invalid');
  if (filters.departmentId && !mongoose.isValidObjectId(filters.departmentId)) errors.push('filters.departmentId is invalid');

  return { valid: errors.length === 0, errors, value: { ...payload, filters } };
};

export const analyticsExportJobId = (fileId) => `analytics-export-${fileId}`;

export const dispatchAnalyticsExport = async (payload = {}) => {
  const { valid, errors, value } = validateAnalyticsExportPayload(payload);
  if (!valid) throw new Error(`Invalid analytics export payload: ${errors.join(', ')}`);

  const jobId = analyticsExportJobId(value.fileId);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.ANALYTICS_EXPORT,
    {
      companyId: String(value.companyId),
      fileId: String(value.fileId),
      reportKey: String(value.reportKey).toUpperCase(),
      format: String(value.format).toUpperCase(),
      filters: {
        month: value.filters.month ? String(value.filters.month) : '',
        financialYear: value.filters.financialYear ? String(value.filters.financialYear) : '',
        period: value.filters.period ? String(value.filters.period).toUpperCase() : 'MONTHLY',
        departmentId: value.filters.departmentId ? String(value.filters.departmentId) : '',
        designation: value.filters.designation ? String(value.filters.designation) : '',
        employeeId: value.filters.employeeId ? String(value.filters.employeeId) : '',
        status: value.filters.status ? String(value.filters.status).toUpperCase() : '',
      },
      actorId: value.actorId ? String(value.actorId) : '',
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(`[Analytics] export queued (file=${value.fileId}, report=${value.reportKey}, job=${job.id})`);
  return { queued: true, jobId, job: job.id };
};

// ── a scheduled report (§20) ───────────────────────────────────────────────

export const validateAnalyticsSchedulePayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload);

  if (!mongoose.isValidObjectId(payload.scheduleId)) errors.push('scheduleId is invalid');

  const delay = Number(payload.delay);
  if (payload.delay !== undefined && (!Number.isFinite(delay) || delay < 0)) errors.push('delay must be a positive number');

  return { valid: errors.length === 0, errors, value: payload };
};

export const analyticsScheduleJobId = (scheduleId) => `analytics-schedule-${scheduleId}`;

/**
 * §20 — BullMQ's native `delay` is the scheduler. The schedule itself lives in
 * MongoDB, so a Redis restart cannot silently stop a CFO's monthly report: on
 * restart, `runDueSchedules()` re-arms anything whose time has come.
 */
export const dispatchAnalyticsSchedule = async (payload = {}) => {
  const { valid, errors, value } = validateAnalyticsSchedulePayload(payload);
  if (!valid) throw new Error(`Invalid analytics schedule payload: ${errors.join(', ')}`);

  const jobId = analyticsScheduleJobId(value.scheduleId);
  const delay = Math.max(0, Number(value.delay) || 0);

  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.ANALYTICS_SCHEDULE,
    {
      companyId: String(value.companyId),
      scheduleId: String(value.scheduleId),
      actorId: value.actorId ? String(value.actorId) : '',
    },
    { ...getPayrollJobOptions(), jobId, delay },
  );

  logger.info(`[Analytics] schedule queued (schedule=${value.scheduleId}, delay=${delay}ms)`);
  return { queued: true, jobId, job: job.id, delay };
};

// ── executive dashboard refresh (§22) ──────────────────────────────────────

export const validateAnalyticsRefreshPayload = (data = {}) => {
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const errors = baseValidation(payload);

  if (payload.month && !MONTH_PATTERN.test(String(payload.month))) errors.push('month is invalid');

  return { valid: errors.length === 0, errors, value: payload };
};

export const analyticsRefreshJobId = (companyId, month = '') => `analytics-refresh-${companyId}-${month || 'all'}`;

export const dispatchAnalyticsRefresh = async (payload = {}) => {
  const { valid, errors, value } = validateAnalyticsRefreshPayload(payload);
  if (!valid) throw new Error(`Invalid analytics refresh payload: ${errors.join(', ')}`);

  const jobId = analyticsRefreshJobId(value.companyId, value.month);
  const job = await enqueueJob(
    QUEUE_NAMES.PAYROLL,
    JOB_NAMES.ANALYTICS_REFRESH,
    {
      companyId: String(value.companyId),
      month: value.month ? String(value.month) : '',
      actorId: value.actorId ? String(value.actorId) : '',
    },
    { ...getPayrollJobOptions(), jobId },
  );

  logger.info(`[Analytics] refresh queued (company=${value.companyId}, month=${value.month || 'all'})`);
  return { queued: true, jobId, job: job.id };
};

export default {
  dispatchAnalyticsExport,
  dispatchAnalyticsSchedule,
  dispatchAnalyticsRefresh,
  validateAnalyticsExportPayload,
  validateAnalyticsSchedulePayload,
  validateAnalyticsRefreshPayload,
};
