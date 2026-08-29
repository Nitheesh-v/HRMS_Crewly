// ============================================================
// 🛰️ PHASE 28.8 — OPS QUEUE SERVICE (Super Admin tooling)
//
// All platform operations actions live here, behind the
// Super Admin AdminSession (see superAdminRoutes.js). Rules:
//
//   - queueName is ALWAYS validated against the ops allowlist
//     (opsQueueRegistry) — no arbitrary queue names, keys, or
//     commands ever reach Redis.
//   - Counts come from BullMQ's counts API (no job-fetching to
//     count). Oldest-waiting reads exactly ONE job (FIFO head).
//   - Every job surfaced goes through opsJobSerializer
//     (whitelist + redaction) — never raw data/returnvalue.
//   - Retry: FAILED state only, backend-authoritative retryable
//     policy, BullMQ job.retry() (retries the existing job).
//   - Remove: FAILED/COMPLETED only — a state change between
//     check and action yields a 409, never a mutation.
//   - Reconciliation: preview (counts) THEN bounded run (limit
//     clamped 1–100) calling the EXISTING 28.3–28.6 runners.
//   - Redis down → degraded, safe overview shape:
//     { redis: { state: 'down' }, queues: 'unavailable' }.
//   - Audit: platform-scope AuditLog entries (safe metadata
//     only) for every mutating action.
//
// DI: every function accepts a `deps` override so hermetic
// tests can fake queues/Redis/Mongo/audit without live infra.
// ============================================================

import logger from '../config/logger.js';
import { getQueue } from '../queues/queueFactory.js';
import {
  getRedisClient,
  getRedisStatus,
  classifySafeReason,
} from '../config/redis.js';
import {
  OPS_QUEUES,
  OPS_RETENTION,
  OPS_JOB_ID_PATTERN,
  getOpsThresholds,
  classifyOpsFailure,
  getRetryPolicy,
} from './opsQueueRegistry.js';
import {
  serializeJobForOps,
} from './opsJobSerializer.js';
import {
  heartbeatKeyFor,
  workerMemberKey,
  classifyWorkerState,
} from '../workers/workerHeartbeat.js';
import EmailDelivery from '../models/EmailDelivery.js';
import CandidateResume from '../models/CandidateResume.js';
import AuditLog from '../models/AuditLog.js';
import {
  loadInterviewsForReminderReconcile,
  loadOffersForReconcile,
  runScheduledReconcile,
} from './scheduledJobScheduler.js';
import { loadDocumentVersionsForReconcile, runDocumentReconcile } from './documentProcessingDispatcher.js';
import { loadCasesForBgvReconcile, runBgvReconcile } from './bgvQueueDispatcher.js';
import { recoverPendingResumeProcessing } from './resumeProcessingDispatcher.js';
import { recoverPendingATSMatching } from './atsDispatcher.js';
import { reconcileStuckEmailDeliveries } from './emailDeliveryService.js';
import { resumeProcessingConfiguration } from './resumeProcessingService.js';
import { bumpRecruitmentAnalyticsGeneration } from './analyticsCacheInvalidation.js';
import { getCacheStats } from './redisCacheService.js';
import { getRecruitmentAnalyticsCacheTtlSeconds } from './recruitmentAnalyticsService.js';

// -----------------------------------------------------------
// Errors + helpers
// -----------------------------------------------------------

export class OpsError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = 'OpsError';
    this.status = status;
    this.details = details;
  }
}

const clampInt = (value, fallback, min, max) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const assertOpsQueue = (queueName) => {
  const meta = OPS_QUEUES.find((queue) => queue.name === queueName);
  if (!meta) {
    throw new OpsError(404, 'Unknown queue — only implemented Crewly queues can be viewed or managed');
  }
  return meta;
};

const assertJobId = (jobId) => {
  const id = String(jobId || '');
  if (!OPS_JOB_ID_PATTERN.test(id)) {
    throw new OpsError(400, 'Invalid job id');
  }
  return id;
};

const withDefaults = (deps = {}) => ({
  getQueue,
  getRedisClient,
  getRedisStatus,
  classifySafeReason,
  EmailDelivery,
  CandidateResume,
  AuditLog,
  loadInterviewsForReminderReconcile,
  loadOffersForReconcile,
  loadDocumentVersionsForReconcile,
  loadCasesForBgvReconcile,
  runScheduledReconcile,
  runDocumentReconcile,
  runBgvReconcile,
  recoverPendingResumeProcessing,
  recoverPendingATSMatching,
  reconcileStuckEmailDeliveries,
  bumpRecruitmentAnalyticsGeneration,
  getCacheStats,
  getCacheTtlSeconds: getRecruitmentAnalyticsCacheTtlSeconds,
  ...deps,
});

// Short, safe text for a Redis down reason (never a credential).
const safeReason = (reason, classify) => {
  const text = classify ? classify(reason) : String(reason || 'unavailable');
  return text.slice(0, 120);
};

/** Human age for UI-facing strings ("12 minutes"). Exported for tests. */
export const humanAge = (ms) => {
  const n = Math.max(0, Math.trunc(Number(ms) || 0));
  if (n < 15000) return 'a few seconds';
  if (n < 60000) return `${Math.round(n / 1000)} seconds`;
  if (n < 3600000) return `${Math.round(n / 60000)} minutes`;
  if (n < 86400000) return `${Math.round(n / 3600000)} hours`;
  return `${Math.round(n / 86400000)} days`;
};

const recordOpsAudit = async (d, { actor = {}, action, metadata = {} }) => {
  try {
    await d.AuditLog.create({
      companyId: null, // platform scope
      actor: actor.id || null,
      actorName: actor.name || '',
      actorRole: actor.role || '',
      action,
      method: actor.method || 'POST',
      path: actor.path || '',
      statusCode: 200,
      metadata,
    });
  } catch (error) {
    // Audit failure must not mask the operation result, but it
    // must be visible to operators (safe text only).
    logger.error(
      `[Ops] Audit write failed for ${action} (${classifySafeReason(error)})`
    );
  }
};

// -----------------------------------------------------------
// Queue health (pure — exported for hermetic tests)
// -----------------------------------------------------------

/**
 * Compute HEALTHY / WARNING / CRITICAL + human reasons for one
 * queue. DELAYED jobs are one-time scheduled work — never an
 * incident, deliberately never flagged.
 */
export const computeQueueHealth = ({
  counts,
  oldestWaitingMs = null,
  failedRecent = 0,
  paused = false,
  hasOnlineWorker = true,
  thresholds,
}) => {
  const reasons = [];
  let status = 'HEALTHY';
  const bump = (level, reason) => {
    if (level === 'CRITICAL') status = 'CRITICAL';
    else if (level === 'WARNING' && status !== 'CRITICAL') status = 'WARNING';
    reasons.push(reason);
  };

  const waiting = (counts.waiting || 0);
  if (waiting >= thresholds.waitingCritical) {
    bump('CRITICAL', `${waiting} jobs waiting (critical threshold ${thresholds.waitingCritical})`);
  } else if (waiting >= thresholds.waitingWarn) {
    bump('WARNING', `${waiting} jobs waiting (warning threshold ${thresholds.waitingWarn})`);
  }

  if (oldestWaitingMs !== null && oldestWaitingMs !== undefined) {
    const age = `${humanAge(oldestWaitingMs)} old`;
    if (oldestWaitingMs >= thresholds.oldestWaitingCriticalMs) {
      bump('CRITICAL', `Oldest waiting job is ${age}`);
    } else if (oldestWaitingMs >= thresholds.oldestWaitingWarnMs) {
      bump('WARNING', `Oldest waiting job is ${age}`);
    }
  }

  if (failedRecent > 0) {
    bump('WARNING', `${failedRecent} jobs failed in the last ${thresholds.failedRecentMinutes} minutes`);
  }
  if (paused) bump('WARNING', 'Queue is paused — no jobs are being processed');
  if (!hasOnlineWorker) {
    bump('WARNING', 'No online workers — waiting jobs will not be picked up');
  }

  return { status, reasons };
};

// -----------------------------------------------------------
// Workers (heartbeat reads — API side)
// -----------------------------------------------------------

const WORKER_LIST_CAP = 50;

export const getWorkerStates = async (client, source = process.env) => {
  const memberKey = workerMemberKey();
  let members = [];
  try {
    members = (await client.smembers(memberKey)) || [];
  } catch {
    return { workers: [], online: 0 };
  }
  const limited = members.slice(0, WORKER_LIST_CAP);
  const states = [];
  for (const member of limited) {
    let raw = null;
    let ttl = -2;
    try {
      [raw, ttl] = await Promise.all([
        client.get(heartbeatKeyFor(member)),
        client.pttl(heartbeatKeyFor(member)),
      ]);
    } catch {
      raw = null;
      ttl = -2;
    }
    let payloadState = '';
    let lastSeenMs = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        payloadState = parsed.state === 'online' || parsed.state === 'shutting_down' ? parsed.state : '';
        lastSeenMs = Number(parsed.ts) || null;
      } catch {
        payloadState = '';
      }
    }
    states.push({
      workerId: String(member),
      status: classifyWorkerState(ttl, payloadState),
      lastSeenMs,
    });
  }
  const rank = { ONLINE: 0, SHUTTING_DOWN: 1, OFFLINE: 2 };
  states.sort((a, b) => rank[a.status] - rank[b.status]);
  return {
    workers: states,
    online: states.filter((w) => w.status === 'ONLINE').length,
  };
};

// -----------------------------------------------------------
// Overview
// -----------------------------------------------------------

const buildQueueSummaries = async (d, hasOnlineWorker) => {
  const thresholds = getOpsThresholds();
  const now = Date.now();
  const out = [];
  for (const meta of OPS_QUEUES) {
    try {
      const queue = d.getQueue(meta.name);
      const counts = (await queue.getJobCounts()) || {};
      const waiting = (counts.wait || 0) + (counts.prioritized || 0);

      // Oldest waiting = exactly ONE job read (the FIFO head).
      let oldestWaitingMs = null;
      if (waiting > 0) {
        const [oldest] = (await queue.getWaiting(0, 0).catch(() => [])) || [];
        if (oldest && oldest.timestamp) {
          oldestWaitingMs = Math.max(0, now - oldest.timestamp);
        }
      }

      // Recent-failed recency: probe the TAIL of the failed list
      // (newest first, bounded to 50 — retention caps it at 500).
      let failedRecent = 0;
      const failedTotal = counts.failed || 0;
      if (failedTotal > 0) {
        const probe = Math.min(failedTotal, 50);
        const start = failedTotal - probe;
        const tail = await queue
          .getJobs(['failed'], start, failedTotal - 1)
          .catch(() => []);
        const windowMs = thresholds.failedRecentMinutes * 60000;
        failedRecent = (tail || []).filter(
          (job) => job.failedAt && now - job.failedAt <= windowMs
        ).length;
      }

      const paused = await queue.isPaused().catch(() => false);
      const health = computeQueueHealth({
        counts: { waiting },
        oldestWaitingMs,
        failedRecent,
        paused,
        hasOnlineWorker,
        thresholds,
      });

      out.push({
        name: meta.name,
        purpose: meta.purpose,
        counts: {
          waiting,
          active: counts.active || 0,
          delayed: counts.delayed || 0,
          failed: failedTotal,
          completed: counts.completed || 0,
        },
        oldestWaitingMs,
        paused,
        retention: { ...OPS_RETENTION },
        health,
      });
    } catch (error) {
      // One queue being unreadable must not hide the others.
      out.push({
        name: meta.name,
        purpose: meta.purpose,
        counts: null,
        oldestWaitingMs: null,
        paused: false,
        retention: { ...OPS_RETENTION },
        health: {
          status: 'WARNING',
          reasons: ['Queue state could not be read — try again'],
        },
      });
    }
  }
  return out;
};

/**
 * Single GET powering the page header + queue table.
 * Degraded (safe) when Redis is down/disabled.
 */
export const getOpsOverview = async (deps = {}) => {
  const d = withDefaults(deps);
  const redisStatus = d.getRedisStatus();
  if (redisStatus.state !== 'up') {
    return {
      redis: {
        state: redisStatus.state,
        reason: safeReason(redisStatus.reason, d.classifySafeReason),
      },
      queues: 'unavailable',
      workers: 'unavailable',
    };
  }
  const client = d.getRedisClient();
  if (!client) {
    return {
      redis: { state: 'down', reason: 'client unavailable' },
      queues: 'unavailable',
      workers: 'unavailable',
    };
  }

  const workers = await getWorkerStates(client);
  const queues = await buildQueueSummaries(d, workers.online > 0);
  return {
    redis: { state: 'up' },
    workers,
    queues,
  };
};

// -----------------------------------------------------------
// Failed jobs (paginated, bounded, serialized)
// -----------------------------------------------------------

export const OPS_FAILED_PAGE_MAX = 50;

export const getFailedJobs = async ({ queueName, page = 1, limit = 25 } = {}, deps = {}) => {
  assertOpsQueue(queueName);
  const d = withDefaults(deps);
  const p = Math.max(1, Math.trunc(Number(page)) || 1);
  const l = clampInt(limit, 25, 1, OPS_FAILED_PAGE_MAX);
  const queue = d.getQueue(queueName);
  const counts = (await queue.getJobCounts().catch(() => ({}))) || {};
  const total = counts.failed || 0;
  const start = (p - 1) * l;
  const jobs =
    start < total
      ? (await queue.getJobs(['failed'], start, start + l - 1).catch(() => [])) || []
      : [];
  const rows = jobs.map((job) => serializeJobForOps(job, queueName, 'failed'));
  return {
    rows,
    meta: {
      page: p,
      limit: l,
      total,
      pages: Math.max(1, Math.ceil(total / l)),
    },
  };
};

export const getJobDetail = async ({ queueName, jobId } = {}, deps = {}) => {
  assertOpsQueue(queueName);
  const id = assertJobId(jobId);
  const d = withDefaults(deps);
  const queue = d.getQueue(queueName);
  const state = await queue.getJobState(id).catch(() => 'unknown');
  if (state === 'unknown') {
    throw new OpsError(404, 'Job not found in this queue');
  }
  const job = await queue.getJob(id).catch(() => null);
  if (!job) throw new OpsError(404, 'Job not found in this queue');
  return serializeJobForOps(job, queueName, state);
};

// -----------------------------------------------------------
// Retry (FAILED only + backend-authoritative policy)
// -----------------------------------------------------------

const MAX_BATCH_RETRY = 25;

export const retryJob = async ({ queueName, jobId, actor = {} } = {}, deps = {}) => {
  assertOpsQueue(queueName);
  const id = assertJobId(jobId);
  const d = withDefaults(deps);
  const queue = d.getQueue(queueName);
  const job = await queue.getJob(id).catch(() => null);
  if (!job) throw new OpsError(404, 'Job not found in this queue');

  const state = await queue.getJobState(id).catch(() => 'unknown');
  if (state !== 'failed') {
    throw new OpsError(
      409,
      `Job is not in failed state (current state: ${state}) — refresh and try again`
    );
  }

  const attemptsMade = Number(job.attemptsMade ?? 0) || 0;
  const maxAttempts = Number(job.opts?.maxAttempts ?? 0) || 0;
  const category = classifyOpsFailure(job.failedReason, { attemptsMade, maxAttempts });
  const policy = getRetryPolicy(queueName, String(job.name || ''), category, {
    attemptsMade,
    maxAttempts,
  });
  if (!policy.retryable) {
    throw new OpsError(422, policy.reason, {
      retryable: false,
      safeFailureCategory: category,
    });
  }

  try {
    // BullMQ v6: retry() re-queues the SAME job (no reconstruction).
    await job.retry();
  } catch {
    // Two admins clicked at once: the first won, the second sees
    // a state change. Safe either way — the job is not retried
    // twice.
    throw new OpsError(409, 'Job state changed — refresh and try again');
  }

  await recordOpsAudit(d, {
    actor,
    action: 'QUEUE_JOB_RETRIED',
    metadata: { queue: queueName, jobId: id, jobName: String(job.name || ''), safeFailureCategory: category },
  });
  return { ok: true, jobId: id, state: 'waiting' };
};

export const retryFailedJobs = async ({ queueName, jobIds, actor = {} } = {}, deps = {}) => {
  assertOpsQueue(queueName);
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    throw new OpsError(400, 'jobIds must be a non-empty array');
  }
  if (jobIds.length > MAX_BATCH_RETRY) {
    throw new OpsError(400, `At most ${MAX_BATCH_RETRY} jobs can be retried at once`);
  }
  const unique = [...new Set(jobIds.map((id) => assertJobId(id)))];
  const results = [];
  for (const id of unique) {
    try {
      const result = await retryJob({ queueName, jobId: id, actor }, deps);
      results.push({ jobId: id, ok: true, ...result });
    } catch (error) {
      if (error instanceof OpsError) {
        results.push({ jobId: id, ok: false, status: error.status, reason: error.message });
      } else {
        results.push({ jobId: id, ok: false, status: 500, reason: 'Retry failed — try again later' });
      }
    }
  }
  return {
    queue: queueName,
    total: unique.length,
    retried: results.filter((r) => r.ok).length,
    results,
  };
};

// -----------------------------------------------------------
// Remove (FAILED/COMPLETED only — never active, never Mongo)
// -----------------------------------------------------------

export const removeJob = async ({ queueName, jobId, actor = {} } = {}, deps = {}) => {
  assertOpsQueue(queueName);
  const id = assertJobId(jobId);
  const d = withDefaults(deps);
  const queue = d.getQueue(queueName);
  const job = await queue.getJob(id).catch(() => null);
  if (!job) throw new OpsError(404, 'Job not found in this queue');

  const state = await queue.getJobState(id).catch(() => 'unknown');
  if (state !== 'failed' && state !== 'completed') {
    throw new OpsError(
      409,
      `Job can only be removed from failed or completed state (current state: ${state})`
    );
  }

  try {
    await job.remove();
  } catch {
    throw new OpsError(409, 'Job state changed — refresh and try again');
  }

  await recordOpsAudit(d, {
    actor,
    action: 'QUEUE_JOB_REMOVED',
    metadata: { queue: queueName, jobId: id, jobName: String(job.name || ''), removedState: state },
  });
  return { ok: true, jobId: id, removedState: state };
};

// -----------------------------------------------------------
// Pause / resume (risk-documented, Super Admin only)
// -----------------------------------------------------------

export const pauseQueue = async ({ queueName, actor = {} } = {}, deps = {}) => {
  assertOpsQueue(queueName);
  const d = withDefaults(deps);
  try {
    await d.getQueue(queueName).pause();
  } catch {
    throw new OpsError(502, 'Could not pause queue — Redis may be unavailable');
  }
  await recordOpsAudit(d, {
    actor,
    action: 'QUEUE_PAUSED',
    metadata: { queue: queueName },
  });
  return { ok: true, queue: queueName, paused: true };
};

export const resumeQueue = async ({ queueName, actor = {} } = {}, deps = {}) => {
  assertOpsQueue(queueName);
  const d = withDefaults(deps);
  try {
    await d.getQueue(queueName).resume();
  } catch {
    throw new OpsError(502, 'Could not resume queue — Redis may be unavailable');
  }
  await recordOpsAudit(d, {
    actor,
    action: 'QUEUE_RESUMED',
    metadata: { queue: queueName },
  });
  return { ok: true, queue: queueName, paused: false };
};

// -----------------------------------------------------------
// Reconciliation ops (preview → bounded run, existing services)
// -----------------------------------------------------------

export const RECONCILE_MAX_LIMIT = 100;
const RECONCILE_DEFAULT_LIMIT = 25;
const EMAIL_STUCK_MIN_AGE_MS = 60000;

export const RECONCILE_AREAS = Object.freeze({
  email: { label: 'Email deliveries' },
  resume: { label: 'Resume parsing' },
  ats: { label: 'ATS matching' },
  scheduled: { label: 'Scheduled reminders & offer expiry' },
  documents: { label: 'Document processing' },
  bgv: { label: 'Background verification' },
});

const clampReconcileLimit = (limit) =>
  clampInt(limit, RECONCILE_DEFAULT_LIMIT, 1, RECONCILE_MAX_LIMIT);

/**
 * PREVIEW: count-based estimates using the same eligibility
 * criteria as the existing runners (documented mirrors). No
 * mutation, no job data — counts only.
 */
export const getReconcilePreview = async (deps = {}) => {
  const d = withDefaults(deps);
  const now = new Date();
  const areas = [];
  const push = (area, eligible, extra = {}) => {
    const def = RECONCILE_AREAS[area];
    areas.push({
      area,
      label: def.label,
      eligible:
        eligible === null || eligible === undefined
          ? null
          : Math.max(0, Math.trunc(Number(eligible) || 0)),
      maxRun: RECONCILE_MAX_LIMIT,
      ...extra,
    });
  };

  // email: exact mirror of reconcileStuckEmailDeliveries filter.
  try {
    const stuck = await d.EmailDelivery.countDocuments({
      status: { $in: ['PENDING', 'FAILED_TO_QUEUE', 'QUEUED'] },
      createdAt: { $lt: new Date(now.getTime() - EMAIL_STUCK_MIN_AGE_MS) },
    });
    push('email', stuck);
  } catch {
    push('email', null, { unavailable: true });
  }

  // resume: exact mirror of recoverPendingResumeProcessing find.
  try {
    const staleBefore = new Date(now.getTime() - EMAIL_STUCK_MIN_AGE_MS);
    const pending = await d.CandidateResume.countDocuments({
      status: 'UPLOADED',
      scanStatus: { $ne: 'REJECTED' },
      parsingStatus: { $in: ['PENDING', 'RETRY_PENDING'] },
      parsingAttempts: { $lt: resumeProcessingConfiguration.maxAttempts },
      parsingRequestedAt: { $lte: staleBefore },
    });
    push('resume', pending);
  } catch {
    push('resume', null, { unavailable: true });
  }

  // ats: UPPER BOUND (the real runner also requires a missing
  // ATS result or a pending recalculation — not expressible in
  // countDocuments).
  try {
    const candidates = await d.CandidateResume.countDocuments({
      status: 'UPLOADED',
      scanStatus: { $ne: 'REJECTED' },
      parsingStatus: { $in: ['COMPLETED', 'PARSED'] },
    });
    push('ats', candidates, { estimate: true });
  } catch {
    push('ats', null, { unavailable: true, estimate: true });
  }

  // scheduled: via the existing loaders (bounded to 100 each).
  try {
    const [interviews, offers] = await Promise.all([
      d.loadInterviewsForReminderReconcile({ now, windowDays: 14, limit: RECONCILE_MAX_LIMIT }),
      d.loadOffersForReconcile({ now, windowDays: 90, limit: RECONCILE_MAX_LIMIT }),
    ]);
    const i = (interviews || []).length;
    const o = (offers || []).length;
    push('scheduled', i + o, {
      estimate: true, // an offer can yield reminder + expiry jobs
      capped: i >= RECONCILE_MAX_LIMIT || o >= RECONCILE_MAX_LIMIT,
    });
  } catch {
    push('scheduled', null, { unavailable: true, estimate: true });
  }

  // documents: via the existing loader.
  try {
    const versions = await d.loadDocumentVersionsForReconcile({
      now,
      windowDays: 90,
      limit: RECONCILE_MAX_LIMIT,
    });
    const n = (versions || []).length;
    push('documents', n, { capped: n >= RECONCILE_MAX_LIMIT });
  } catch {
    push('documents', null, { unavailable: true });
  }

  // bgv: via the existing loader (missing submissions + due polls).
  try {
    const data = await d.loadCasesForBgvReconcile({
      now,
      windowDays: 60,
      limit: RECONCILE_MAX_LIMIT,
    });
    const n =
      (data?.missingSubmission || []).length + (data?.duePolls || []).length;
    push('bgv', n, {
      capped:
        (data?.missingSubmission || []).length >= RECONCILE_MAX_LIMIT ||
        (data?.duePolls || []).length >= RECONCILE_MAX_LIMIT,
    });
  } catch {
    push('bgv', null, { unavailable: true });
  }

  return { areas, maxRun: RECONCILE_MAX_LIMIT };
};

/**
 * RUN: call the EXISTING bounded runner for one area. The limit
 * is clamped to 1–100 on the backend (client values are never
 * trusted). Idempotency comes from the runners' deterministic
 * job ids.
 */
export const runReconcile = async ({ area, limit, actor = {} } = {}, deps = {}) => {
  if (!RECONCILE_AREAS[area]) {
    throw new OpsError(400, 'Unknown reconciliation area');
  }
  const l = clampReconcileLimit(limit);
  const d = withDefaults(deps);

  let summary;
  try {
    switch (area) {
      case 'email': {
        const r = await d.reconcileStuckEmailDeliveries({
          minAgeMs: EMAIL_STUCK_MIN_AGE_MS,
          limit: l,
        });
        const failedCount = (r.results || []).filter((x) => !x.requeued).length;
        summary = {
          checked: r.scanned || 0,
          requeued: r.requeued || 0,
          skipped: Math.max(0, (r.scanned || 0) - (r.requeued || 0)),
          failed: failedCount,
        };
        break;
      }
      case 'resume': {
        const r = await d.recoverPendingResumeProcessing({ limit: l });
        summary = {
          checked: r.pending || 0,
          requeued: r.queued || 0,
          skipped: r.skipped || 0,
          failed: 0,
        };
        break;
      }
      case 'ats': {
        const r = await d.recoverPendingATSMatching({ limit: l });
        summary = {
          checked: r.pending || 0,
          requeued: r.queued || 0,
          skipped: r.skipped || 0,
          failed: 0,
        };
        break;
      }
      case 'scheduled': {
        const r = await d.runScheduledReconcile({ limit: l });
        summary = {
          checked:
            (r.interviews?.checked || 0) + (r.offers?.checked || 0),
          requeued:
            (r.interviews?.scheduled || 0) +
            (r.offers?.reminders || 0) +
            (r.offers?.expiries || 0),
          skipped:
            (r.interviews?.skipped || 0) + (r.offers?.skipped || 0),
          failed:
            (r.interviews?.errors || 0) + (r.offers?.errors || 0),
        };
        break;
      }
      case 'documents': {
        const r = await d.runDocumentReconcile({ limit: l });
        summary = {
          checked: r.checked || 0,
          requeued: r.scheduled || 0,
          skipped: r.skipped || 0,
          failed: r.errors || 0,
        };
        break;
      }
      case 'bgv': {
        const r = await d.runBgvReconcile({ limit: l });
        summary = {
          checked: r.checked || 0,
          requeued: (r.queued || 0) + (r.pollsScheduled || 0),
          skipped: r.skipped || 0,
          failed: r.errors || 0,
        };
        break;
      }
      default:
        throw new OpsError(400, 'Unknown reconciliation area');
    }
  } catch (error) {
    if (error instanceof OpsError) throw error;
    // Safe: the runner error text is never surfaced verbatim.
    logger.error(
      `[Ops] Reconciliation run failed (area=${area}) (${classifySafeReason(error)})`
    );
    throw new OpsError(502, 'Reconciliation run failed — check server logs (no details shown for safety)');
  }

  await recordOpsAudit(d, {
    actor,
    action: 'RECONCILIATION_TRIGGERED',
    metadata: { area, limit: l },
  });

  return {
    area,
    label: RECONCILE_AREAS[area].label,
    limit: l,
    ...summary,
  };
};

// -----------------------------------------------------------
// Cache ops (28.7 analytics cache — status + controlled bump)
// -----------------------------------------------------------

export const getCacheStatus = async (deps = {}) => {
  const d = withDefaults(deps);
  const ttlSeconds = d.getCacheTtlSeconds();
  return {
    feature: 'recruitment-analytics',
    enabled: ttlSeconds > 0,
    ttlSeconds,
    keyPrefix: 'crewly:cache:company',
    redis: d.getRedisStatus().state,
    stats: d.getCacheStats(),
  };
};

export const invalidateCompanyAnalyticsCache = async (
  { companyId, actor = {} } = {},
  deps = {}
) => {
  const id = String(companyId || '');
  if (!/^[a-f0-9]{24}$/i.test(id)) {
    throw new OpsError(400, 'A valid company id (24 hex characters) is required');
  }
  const d = withDefaults(deps);
  const bumped = await d.bumpRecruitmentAnalyticsGeneration(id);
  await recordOpsAudit(d, {
    actor,
    action: 'CACHE_INVALIDATED',
    metadata: { companyId: id, bumped },
  });
  return { ok: true, companyId: id, bumped };
};
