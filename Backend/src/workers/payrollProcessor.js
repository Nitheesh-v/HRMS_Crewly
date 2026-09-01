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
import { validatePayrollExportPayload } from '../services/payroll/payrollExportDispatcher.js';
import { validatePayrollPaymentFilePayload } from '../services/payroll/payrollPaymentDispatcher.js';
import payrollEngineService from '../services/payroll/payrollEngineService.js';
import payrollReviewService from '../services/payroll/payrollReviewService.js';
import payrollPaymentService from '../services/payroll/payrollPaymentService.js';
import payslipService from '../services/payroll/payslipService.js';
import {
  validatePayslipGeneratePayload,
  validatePayslipZipPayload,
  validatePayslipEmailPayload,
} from '../services/payroll/payslipDispatcher.js';

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

// PAYROLL_EXPORT (29.7 §19 / §21) — builds a review report from the 29.6
// snapshots. It never recalculates anything: the report is a read of stored
// results. The payload is revalidated and the report is rebuilt from Mongo.
export const payrollExportProcessor = async (job) => {
  const { valid, reason, value } = validatePayrollExportPayload(job?.data);
  if (!valid) {
    logger.warn(`[Payroll] export job rejected: ${reason}`);
    return { processed: false, skipped: true, reason };
  }

  const { companyId, month, exportId, reportKey } = value;

  const built = await payrollReviewService.processExport({
    companyId,
    month,
    exportId,
    reportKey,
  });

  logger.info(
    `[Payroll] export ready (report=${reportKey}, rows=${built.rowCount ?? 0})`,
  );

  return { processed: true, skipped: false, rows: built.rowCount || 0 };
};

// PAYROLL_PAYMENT_FILE (29.8 §20) — renders the bank transfer file from the
// payment rows. The payload is references only, so the file is rebuilt from
// Mongo here; the account numbers never travel through the queue.
export const payrollPaymentFileProcessor = async (job) => {
  const { valid, errors, value } = validatePayrollPaymentFilePayload(job?.data);
  if (!valid) {
    logger.warn(`[Payroll] payment file job rejected: ${errors.join(', ')}`);
    return { processed: false, skipped: true, reason: errors.join(', ') };
  }

  const { companyId, batchId, fileId, format } = value;

  await payrollPaymentService.processFile({
    companyId,
    batchId,
    fileId,
    format,
  });

  logger.info(
    `[Payroll] payment file ready (batch=${batchId}, format=${format}, file=${fileId})`,
  );

  return { processed: true, skipped: false, fileId };
};

// PAYSLIP_GENERATE (29.9 §17) — renders every payslip of a month. The payload
// is references only: the month's paid employees, their snapshots and their
// bank masks are all re-read from Mongo here, so a stale or tampered payload
// cannot move a rupee or leak a number.
export const payslipGenerateProcessor = async (job) => {
  const { valid, errors, value } = validatePayslipGeneratePayload(job?.data);
  if (!valid) {
    logger.warn(`[Payroll] payslip generate job rejected: ${errors.join(', ')}`);
    return { processed: false, skipped: true, reason: errors.join(', ') };
  }

  const { companyId, month, actorId } = value;

  const result = await payslipService.runGeneration({
    companyId,
    month,
    actor: actorId ? { _id: actorId } : null,
    onProgress: (progress) => reportProgress(job, progress),
  });

  logger.info(
    `[Payroll] payslips generated (company=${companyId}, month=${month}, created=${result.created}, updated=${result.updated}, failed=${result.failed})`,
  );

  return { processed: true, skipped: false, ...result };
};

// PAYSLIP_ZIP (29.9 §18) — department or company archive.
export const payslipZipProcessor = async (job) => {
  const { valid, errors, value } = validatePayslipZipPayload(job?.data);
  if (!valid) {
    logger.warn(`[Payroll] payslip zip job rejected: ${errors.join(', ')}`);
    return { processed: false, skipped: true, reason: errors.join(', ') };
  }

  const { companyId, fileId } = value;

  const result = await payslipService.runBulkZip({
    companyId,
    fileId,
    onProgress: (progress) => reportProgress(job, progress),
  });

  logger.info(
    `[Payroll] payslip archive ready (file=${fileId}, files=${result.files ?? 0}, bytes=${result.sizeBytes ?? 0})`,
  );

  return { processed: true, skipped: false, ...result };
};

// PAYSLIP_EMAIL (29.9 §19 / §24) — bulk delivery with the PDF attached. The
// PDF bytes are produced HERE, inside the worker, never in the payload.
export const payslipEmailProcessor = async (job) => {
  const { valid, errors, value } = validatePayslipEmailPayload(job?.data);
  if (!valid) {
    logger.warn(`[Payroll] payslip email job rejected: ${errors.join(', ')}`);
    return { processed: false, skipped: true, reason: errors.join(', ') };
  }

  const { companyId, month, employeeIds } = value;

  const result = await payslipService.runEmailMonth({
    companyId,
    month,
    employeeIds: employeeIds?.length ? employeeIds : null,
    onProgress: (progress) => reportProgress(job, progress),
  });

  logger.info(
    `[Payroll] payslip emails processed (company=${companyId}, month=${month}, sent=${result.sent}, failed=${result.failed})`,
  );

  return { processed: true, skipped: false, ...result };
};

export const registerPayrollProcessors = ({ registerProcessor }) => {
  registerProcessor(JOB_NAMES.PAYROLL_RUN, payrollRunProcessor);
  registerProcessor(JOB_NAMES.PAYROLL_EXPORT, payrollExportProcessor);
  registerProcessor(JOB_NAMES.PAYROLL_PAYMENT_FILE, payrollPaymentFileProcessor);
  registerProcessor(JOB_NAMES.PAYSLIP_GENERATE, payslipGenerateProcessor);
  registerProcessor(JOB_NAMES.PAYSLIP_ZIP, payslipZipProcessor);
  registerProcessor(JOB_NAMES.PAYSLIP_EMAIL, payslipEmailProcessor);
};

export default registerPayrollProcessors;
