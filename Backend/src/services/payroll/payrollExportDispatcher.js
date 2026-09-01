// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.7 — PAYROLL EXPORT DISPATCH (BullMQ, §21)
//
//  Review exports ride the SAME reserved `payroll` queue the 29.6 engine
//  uses — one queue per business domain, one worker process for both.
//
//  PAYLOAD: references only (companyId, month, exportId, reportKey). The
//  worker rebuilds the report from Mongo, so nothing about salary figures
//  travels through Redis.
//
//  JOB ID: `payroll-export-<exportId>` — deterministic, so a double click
//  cannot create two identical reports.
//
//  NO REDIS: the caller falls back to building the report inline (the API
//  runs without Redis by 28.1 policy).
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import logger from '../../config/logger.js';
import { enqueueJob } from '../../queues/queueFactory.js';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  getPayrollJobOptions,
} from '../../config/queueConfig.js';

export const validatePayrollExportPayload = (data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, reason: 'payload must be a plain object' };
  }
  if (!mongoose.isValidObjectId(data.companyId)) return { valid: false, reason: 'invalid companyId' };
  if (!mongoose.isValidObjectId(data.exportId)) return { valid: false, reason: 'invalid exportId' };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(data.month || ''))) {
    return { valid: false, reason: 'invalid payroll month' };
  }
  if (!/^[A-Z_]{3,40}$/.test(String(data.reportKey || ''))) {
    return { valid: false, reason: 'invalid report key' };
  }
  if (data.actorId !== null && data.actorId !== undefined && !mongoose.isValidObjectId(data.actorId)) {
    return { valid: false, reason: 'invalid actorId' };
  }
  return { valid: true, value: data };
};

export const dispatchPayrollExport = async ({
  companyId,
  month,
  exportId,
  reportKey,
  actorId = null,
}) => {
  const payload = {
    companyId: String(companyId),
    month: String(month),
    exportId: String(exportId),
    reportKey: String(reportKey),
    actorId: actorId ? String(actorId) : null,
    requestedAt: new Date().toISOString(),
  };

  const { valid, reason } = validatePayrollExportPayload(payload);
  if (!valid) throw new Error(`payroll export payload rejected: ${reason}`);

  const jobId = `payroll-export-${payload.exportId}`;

  const job = await enqueueJob(QUEUE_NAMES.PAYROLL, JOB_NAMES.PAYROLL_EXPORT, payload, {
    ...getPayrollJobOptions(),
    jobId,
  });

  logger.info(
    `[Payroll] export dispatched (report=${reportKey}, export=${exportId}, job=${job.id ?? jobId})`,
  );

  return { queued: true, jobId: job.id ? String(job.id) : jobId };
};

export default dispatchPayrollExport;
