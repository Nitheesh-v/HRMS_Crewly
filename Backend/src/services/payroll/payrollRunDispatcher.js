// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.6 — PAYROLL RUN DISPATCH (BullMQ, §26)
//
//  The API never calculates inline when Redis is available: it records the
//  intent in Mongo (PayrollRun, status DRAFT) and enqueues a `payroll-run`
//  job on the reserved `payroll` queue. The dedicated worker process owns
//  execution, so HR can leave the page (§27) and a crash cannot take the API
//  down with it.
//
//  PAYLOAD: references only (companyId, month, runId, actorId) — never
//  salary figures, never PII. The worker re-reads everything from Mongo.
//
//  JOB ID: `payroll-run-<companyId>-<month>-<runId>` — BullMQ custom ids may
//  not contain ':'. Deterministic per run, so a double submit cannot create
//  two concurrent runs of the same month.
//
//  NO REDIS: `enqueueJob` throws when Redis is not configured. That is not an
//  error — the API runs without Redis by 28.1 policy — the caller falls back
//  to the synchronous loop and says so in the response.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import logger from '../../config/logger.js';
import { enqueueJob } from '../../queues/queueFactory.js';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  getPayrollJobOptions,
} from '../../config/queueConfig.js';

const buildJobId = ({ companyId, month, runId }) =>
  `payroll-run-${companyId}-${month}-${runId}`;

export const validatePayrollRunPayload = (data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, reason: 'payload must be a plain object' };
  }
  if (!mongoose.isValidObjectId(data.companyId)) {
    return { valid: false, reason: 'invalid companyId' };
  }
  if (!mongoose.isValidObjectId(data.runId)) return { valid: false, reason: 'invalid runId' };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(data.month || ''))) {
    return { valid: false, reason: 'invalid payroll month' };
  }
  if (data.actorId !== null && data.actorId !== undefined && !mongoose.isValidObjectId(data.actorId)) {
    return { valid: false, reason: 'invalid actorId' };
  }
  if (data.employeeIds !== null && data.employeeIds !== undefined && !Array.isArray(data.employeeIds)) {
    return { valid: false, reason: 'employeeIds must be an array or null' };
  }
  return { valid: true, value: data };
};

export const dispatchPayrollRun = async ({
  companyId,
  month,
  runId,
  actorId = null,
  trigger = 'FULL',
  employeeIds = null,
}) => {
  const payload = {
    companyId: String(companyId),
    month: String(month),
    runId: String(runId),
    actorId: actorId ? String(actorId) : null,
    trigger: String(trigger || 'FULL'),
    employeeIds: Array.isArray(employeeIds) ? employeeIds.map(String) : null,
    requestedAt: new Date().toISOString(),
  };

  const { valid, reason } = validatePayrollRunPayload(payload);
  if (!valid) throw new Error(`payroll run payload rejected: ${reason}`);

  const jobId = buildJobId({ companyId, month, runId });

  const job = await enqueueJob(QUEUE_NAMES.PAYROLL, JOB_NAMES.PAYROLL_RUN, payload, {
    ...getPayrollJobOptions(),
    jobId,
  });

  logger.info(
    `[Payroll] run dispatched (month=${month}, run=${runId}, job=${job.id ?? jobId})`,
  );

  return { queued: true, jobId: job.id ? String(job.id) : jobId };
};

export default dispatchPayrollRun;
