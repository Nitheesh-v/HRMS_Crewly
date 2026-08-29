// ============================================================
// 🛰️ PHASE 28.8 — SUPER ADMIN QUEUE OPS CONTROLLER
//
// Thin controllers: parse input → call opsQueueService → shape
// the response. All policy (allowlist, retryable, limits,
// serialization, audit) lives in the service. Errors are mapped
// to safe HTTP responses — internals never leak.
//
// Mounted under /api/super-admin/operations with:
//   protect + superAdminSession (AdminSession) + permit(...)
//   + securityRateLimit on every route.
// ============================================================

import logger from '../config/logger.js';
import {
  getOpsOverview,
  getFailedJobs,
  getJobDetail,
  retryJob,
  retryFailedJobs,
  removeJob,
  pauseQueue,
  resumeQueue,
  getReconcilePreview,
  runReconcile,
  getCacheStatus,
  invalidateCompanyAnalyticsCache,
  OpsError,
} from '../services/opsQueueService.js';
import { reconcileBackgroundWork } from '../services/opsReconcileCoordinator.js';

const ok = (res, status, data, message) =>
  res.status(status).json({
    statusCode: status,
    success: true,
    data,
    message,
  });

const fail = (res, status, message) =>
  res.status(status).json({
    statusCode: status,
    success: false,
    message,
  });

// OpsError carries safe, user-facing detail (e.g. why a job is
// not retryable) — safe to send. Anything else → generic 500.
const failOps = (res, error) => {
  const body = {
    statusCode: error.status,
    success: false,
    message: error.message,
  };
  if (error.details && Object.keys(error.details).length > 0) {
    body.data = error.details;
  }
  res.status(error.status).json(body);
};

// The platform actor for audit entries (AdminSession user).
const actorFrom = (req) => ({
  id: req.user?._id,
  name: req.user?.name || '',
  role: req.user?.role || '',
  method: req.method,
  path: String(req.originalUrl || '').split('?')[0],
});

const safeLog = (error) => {
  logger.error(
    `[QueueOps] ${error?.name || 'Error'}: ${String(error?.message || '').slice(0, 200)}`
  );
};

// ---------------------------------------------------------------
// GET /operations/queues — overview (Redis + workers + queue table)
// ---------------------------------------------------------------

export const getQueues = async (req, res) => {
  try {
    const data = await getOpsOverview();
    return ok(res, 200, data, 'Queue operations overview');
  } catch (error) {
    safeLog(error);
    return fail(res, 500, 'Could not load the queue overview — try again');
  }
};

// ---------------------------------------------------------------
// GET /operations/queues/:queueName/failed — paged failed jobs
// ---------------------------------------------------------------

export const getFailed = async (req, res) => {
  try {
    const data = await getFailedJobs({
      queueName: req.params.queueName,
      page: req.query.page,
      limit: req.query.limit,
    });
    return ok(res, 200, data, 'Failed jobs');
  } catch (error) {
    if (error instanceof OpsError) return failOps(res, error);
    safeLog(error);
    return fail(res, 500, 'Could not load failed jobs — try again');
  }
};

// ---------------------------------------------------------------
// GET /operations/queues/:queueName/jobs/:jobId — safe detail
// ---------------------------------------------------------------

export const getJobDetailHandler = async (req, res) => {
  try {
    const data = await getJobDetail({
      queueName: req.params.queueName,
      jobId: req.params.jobId,
    });
    return ok(res, 200, data, 'Job detail');
  } catch (error) {
    if (error instanceof OpsError) return failOps(res, error);
    safeLog(error);
    return fail(res, 500, 'Could not load the job — try again');
  }
};

// ---------------------------------------------------------------
// POST /operations/queues/:queueName/jobs/:jobId/retry
// ---------------------------------------------------------------

export const retryJobHandler = async (req, res) => {
  try {
    const data = await retryJob({
      queueName: req.params.queueName,
      jobId: req.params.jobId,
      actor: actorFrom(req),
    });
    return ok(res, 200, data, 'Job retry requested');
  } catch (error) {
    if (error instanceof OpsError) return failOps(res, error);
    safeLog(error);
    return fail(res, 500, 'Could not retry the job — try again');
  }
};

// ---------------------------------------------------------------
// POST /operations/queues/:queueName/retry-failed (bounded batch)
// ---------------------------------------------------------------

export const batchRetryHandler = async (req, res) => {
  try {
    const data = await retryFailedJobs({
      queueName: req.params.queueName,
      jobIds: req.body?.jobIds,
      actor: actorFrom(req),
    });
    return ok(res, 200, data, 'Batch retry completed');
  } catch (error) {
    if (error instanceof OpsError) return failOps(res, error);
    safeLog(error);
    return fail(res, 500, 'Batch retry failed — try again');
  }
};

// ---------------------------------------------------------------
// DELETE /operations/queues/:queueName/jobs/:jobId
// ---------------------------------------------------------------

export const removeJobHandler = async (req, res) => {
  try {
    const data = await removeJob({
      queueName: req.params.queueName,
      jobId: req.params.jobId,
      actor: actorFrom(req),
    });
    return ok(res, 200, data, 'Job removed');
  } catch (error) {
    if (error instanceof OpsError) return failOps(res, error);
    safeLog(error);
    return fail(res, 500, 'Could not remove the job — try again');
  }
};

// ---------------------------------------------------------------
// POST /operations/queues/:queueName/pause | /resume
// ---------------------------------------------------------------

export const pauseQueueHandler = async (req, res) => {
  try {
    const data = await pauseQueue({
      queueName: req.params.queueName,
      actor: actorFrom(req),
    });
    return ok(res, 200, data, 'Queue paused');
  } catch (error) {
    if (error instanceof OpsError) return failOps(res, error);
    safeLog(error);
    return fail(res, 500, 'Could not pause the queue — try again');
  }
};

export const resumeQueueHandler = async (req, res) => {
  try {
    const data = await resumeQueue({
      queueName: req.params.queueName,
      actor: actorFrom(req),
    });
    return ok(res, 200, data, 'Queue resumed');
  } catch (error) {
    if (error instanceof OpsError) return failOps(res, error);
    safeLog(error);
    return fail(res, 500, 'Could not resume the queue — try again');
  }
};

// ---------------------------------------------------------------
// GET /operations/reconcile/preview
// ---------------------------------------------------------------

export const reconcilePreviewHandler = async (req, res) => {
  try {
    const data = await getReconcilePreview();
    return ok(res, 200, data, 'Reconciliation preview');
  } catch (error) {
    safeLog(error);
    return fail(res, 500, 'Could not load the reconciliation preview — try again');
  }
};

// ---------------------------------------------------------------
// POST /operations/reconcile {area | domains, limit, dryRun}
//
// area: one of the 6 domains, OR 'all' (master coordinator).
// domains: explicit subset (takes precedence over area).
// dryRun: preview counts only (no mutation).
// ---------------------------------------------------------------

export const reconcileRunHandler = async (req, res) => {
  try {
    const { area, limit, dryRun } = req.body || {};
    const domains = req.body?.domains;
    const usesCoordinator =
      Array.isArray(domains) ||
      (domains === undefined && (area === 'all' || area === undefined));
    const data = usesCoordinator
      ? await reconcileBackgroundWork({
          domains: domains === undefined ? 'all' : domains,
          limit,
          dryRun: dryRun === true,
          actor: actorFrom(req),
        })
      : await runReconcile({
          area,
          limit,
          actor: actorFrom(req),
        });
    return ok(res, 200, data, 'Reconciliation run completed');
  } catch (error) {
    if (error instanceof OpsError) return failOps(res, error);
    safeLog(error);
    return fail(res, 500, 'Reconciliation run failed — try again');
  }
};

// ---------------------------------------------------------------
// GET /operations/cache — safe status only
// ---------------------------------------------------------------

export const getCacheStatusHandler = async (req, res) => {
  try {
    const data = await getCacheStatus();
    return ok(res, 200, data, 'Analytics cache status');
  } catch (error) {
    safeLog(error);
    return fail(res, 500, 'Could not load the cache status — try again');
  }
};

// ---------------------------------------------------------------
// POST /operations/cache/invalidate {companyId}
// ---------------------------------------------------------------

export const invalidateCacheHandler = async (req, res) => {
  try {
    const data = await invalidateCompanyAnalyticsCache({
      companyId: req.body?.companyId,
      actor: actorFrom(req),
    });
    return ok(res, 200, data, 'Analytics cache invalidated for the selected company');
  } catch (error) {
    if (error instanceof OpsError) return failOps(res, error);
    safeLog(error);
    return fail(res, 500, 'Could not invalidate the cache — try again');
  }
};
