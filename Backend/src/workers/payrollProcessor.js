// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.6 — PAYROLL WORKER PROCESSOR (BullMQ)
//
//  The worker NEVER trusts the queue: it re-reads the run, the setup, the
//  period and every employee from Mongo by {_id, companyId} and revalidates
//  before a single rupee is calculated (28.2/28.4 discipline).
//
//  PROGRESS (§27): every employee commit updates the run document AND
//  job.updateProgress, so the UI shows "260 / 300 · 86% · Asha Rao" live.
//
//  IDEMPOTENT (§26): the job id is deterministic per run and the service is
//  version-safe, so a redelivery re-calculates the same version rather than
//  writing a second snapshot.
//
//  FAILURE: a per-employee problem becomes an ERROR row and never aborts the
//  run (§22). Only an infrastructure failure throws and retries.
// ═══════════════════════════════════════════════════════════════════════════

import logger from '../config/logger.js';
import { JOB_NAMES } from '../config/queueConfig.js';
import { validatePayrollRunPayload } from '../services/payroll/payrollRunDispatcher.js';
import payrollEngineService from '../services/payroll/payrollEngineService.js';

const reportProgress = async (job, progress) => {
  try {
    if (job && typeof job.updateProgress === 'function') {
      await job.updateProgress({
        processed: progress.processed,
        total: progress.total,
        percent: progress.percent,
        currentEmployeeName: progress.currentEmployeeName,
      });
    }
  } catch {
    // Progress is cosmetic — never fail a run because the UI could not be
    // told how far it had got.
  }
};

export const payrollRunProcessor = async (job) => {
  const { valid, reason, value } = validatePayrollRunPayload(job?.data);
  if (!valid) {
    logger.warn(`[Payroll] job rejected: ${reason}`);
    return { processed: false, skipped: true, reason };
  }

  const { companyId, month, runId, actorId, trigger, employeeIds } = value;
  const actor = actorId ? { _id: actorId } : null;

  logger.info(`[Payroll] run started (month=${month}, run=${runId}, trigger=${trigger})`);

  const outcome = await payrollEngineService.processRun({
    companyId,
    month,
    actor,
    employeeIds,
    trigger: trigger || 'FULL',
    onProgress: (progress) => reportProgress(job, progress),
  });

  logger.info(
    `[Payroll] run finished (month=${month}, status=${outcome.status}, ` +
      `calculated=${outcome.summary?.calculated ?? 0}, errors=${outcome.summary?.errors ?? 0})`,
  );

  if (outcome.status === 'ERROR') {
    return { processed: false, skipped: false, errors: outcome.errors || [] };
  }

  return {
    processed: true,
    skipped: false,
    calculated: outcome.summary?.calculated || 0,
    errors: outcome.summary?.errors || 0,
    version: outcome.version,
  };
};

export const registerPayrollProcessors = ({ registerProcessor }) => {
  registerProcessor(JOB_NAMES.PAYROLL_RUN, payrollRunProcessor);
};

export default registerPayrollProcessors;
