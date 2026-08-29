// ============================================================
//  PHASE 28.6 — BGV WORKER PROCESSORS
//
// Three job adapters on the reserved BGV queue. The worker NEVER
// trusts the queue and NEVER acts on queued state: everything is
// re-fetched from Mongo by {_id, companyId} and revalidated.
//
// BGV_PROCESS_CHECK
//   case-level provider registration + consent gate.
//   - consent required + not GRANTED  → CONSENT_PENDING skip
//     (case stays AWAITING_CANDIDATE; human decides)
//   - consent DECLINED                → atomic REVIEW_REQUIRED +
//     history; NO auto-reject, NO pipeline change
//   - provider submit is idempotent: atomic set-if-empty claim on
//     providerSubmission.submittedAt (one logical submission per
//     case — no duplicate vendor call path)
//   - providers with polling capability get a DELAYED first poll
//     (INTERNAL never polls — no aggressive vendor hammering)
//
// BGV_PROVIDER_POLL
//   external-provider poll step (delayed jobs, never long-running
//   loops). Still pending → persist attempt + next delayed poll
//   (5→15→30→60min bounded ladder, max window 7d). Final →
//   recordProviderBgvResult (domain mapping) + stop polling.
//
// BGV_PROCESS_RESULT
//   adapter-ready result normalization entry (future webhook path
//   persists results in Mongo, then enqueues this job). Today: no
//   producer — the poll processor calls recordProviderBgvResult
//   directly.
//
// OUTCOMES: { processed | skipped, reason } — stale/terminal
// complete without retry; transient failures throw (retry).
// ============================================================

import logger from '../config/logger.js';
import {
  JOB_NAMES,
  nextBgvPollDelayMs,
  BGV_POLL_MAX_WINDOW_MS,
} from '../config/queueConfig.js';
import BackgroundVerificationCase from '../models/BackgroundVerificationCase.js';
import BackgroundVerificationCheck from '../models/BackgroundVerificationCheck.js';
import { getBgvProvider } from '../services/bgv/bgvProviderRegistry.js';
import { scheduleBgvPoll } from '../services/bgvQueueDispatcher.js';
import {
  recordProviderBgvResult,
  stopCasePolling,
  recordBgvSystemEvent,
} from '../services/backgroundVerificationService.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;

const validateCasePayload = (data, extraKeys) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const expected = ['caseId', 'companyId', 'correlationId', ...extraKeys].sort();
  const keys = Object.keys(data).sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) return false;
  if (extraKeys.includes('providerKey') && typeof data.providerKey !== 'string') return false;
  return OBJECT_ID.test(data.companyId) && OBJECT_ID.test(data.caseId);
};

const loadCase = (value, extraSelect = '') =>
  BackgroundVerificationCase.findOne({
    _id: value.caseId,
    companyId: value.companyId,
  })
    .select(
      `companyId status provider consent candidate startedAt updatedAt assignedVerifier providerReference providerSubmission polling ${extraSelect}`
    )
    .lean();

// ── BGV_PROCESS_CHECK ───────────────────────────────────────────

export const bgvProcessCheckProcessor = async (job, deps = {}) => {
  const load = deps.load || ((value) => loadCase(value));
  const submit = deps.submit ||
    (async (providerKey, caseRecord, checks) =>
      getBgvProvider(providerKey).submitCase({ caseRecord, checks }));
  const loadChecks = deps.loadChecks ||
    (async (caseRecord) =>
      BackgroundVerificationCheck.find({
        companyId: caseRecord.companyId,
        case: caseRecord._id,
      }).sort({ displayOrder: 1 }).lean());
  const claimSubmission = deps.claimSubmission ||
    ((caseRecord) =>
      BackgroundVerificationCase.findOneAndUpdate(
        {
          _id: caseRecord._id,
          companyId: caseRecord.companyId,
          status: { $nin: ['COMPLETED', 'CANCELLED'] },
          'providerSubmission.submittedAt': null,
        },
        { $set: { 'providerSubmission.submittedAt': new Date() } },
        { returnDocument: 'after' }
      ));
  const releaseSubmission = deps.releaseSubmission ||
    ((caseRecord) =>
      BackgroundVerificationCase.updateOne(
        { _id: caseRecord._id, companyId: caseRecord.companyId },
        { $set: { 'providerSubmission.submittedAt': null } }
      ));
  const markReviewRequired = deps.markReviewRequired ||
    ((caseRecord, previousStatus) =>
      BackgroundVerificationCase.findOneAndUpdate(
        {
          _id: caseRecord._id,
          companyId: caseRecord.companyId,
          status: { $nin: ['COMPLETED', 'CANCELLED', 'REVIEW_REQUIRED'] },
        },
        { $set: { status: 'REVIEW_REQUIRED' } },
        { returnDocument: 'after' }
      ));
  const systemEvent = deps.systemEvent || recordBgvSystemEvent;
  const persistPollingState = deps.persistPollingState ||
    ((caseRecord, firstPollAt) =>
      BackgroundVerificationCase.updateOne(
        { _id: caseRecord._id, companyId: caseRecord.companyId },
        {
          $set: { 'polling.status': 'POLLING', 'polling.nextPollAt': firstPollAt },
          $inc: { 'polling.attempts': 1 },
        }
      ));
  const persistReference = deps.persistReference ||
    ((caseRecord, providerReference) =>
      BackgroundVerificationCase.updateOne(
        { _id: caseRecord._id, companyId: caseRecord.companyId },
        { $set: { providerReference: String(providerReference || '').slice(0, 200) } }
      ));
  const poll = deps.schedulePoll || scheduleBgvPoll;

  const value = job.data;
  if (!validateCasePayload(value, ['providerKey'])) {
    throw new Error('BGV_PROCESS_CHECK rejected: payload validation failed');
  }
  const providerKey = value.providerKey || 'INTERNAL';

  const caseRecord = await load(value);
  if (!caseRecord) return { skipped: true, reason: 'NOT_FOUND' };
  if (['COMPLETED', 'CANCELLED'].includes(caseRecord.status)) {
    return { skipped: true, reason: 'CASE_CLOSED' };
  }

  // Consent gate (§41/42): the PERSISTED state decides, never the
  // queued snapshot. No auto-reject — DECLINED routes to human
  // review.
  const consent = caseRecord.consent || { required: false, status: 'NOT_REQUESTED' };
  if (consent.required) {
    if (consent.status === 'DECLINED') {
      const updated = await markReviewRequired(caseRecord, caseRecord.status);
      if (updated) {
        await systemEvent({
          companyId: value.companyId,
          caseRecord: updated,
          action: 'BGV_CONSENT_DECLINED',
          previousStatus: caseRecord.status,
          newStatus: 'REVIEW_REQUIRED',
          metadata: { source: 'SYSTEM', note: 'Candidate declined BGV consent; human review required' },
        }).catch(() => {});
      }
      return { skipped: true, reason: 'CONSENT_DECLINED' };
    }
    if (consent.status !== 'GRANTED') {
      return { skipped: true, reason: 'CONSENT_PENDING' };
    }
  }

  // Idempotent provider submission (atomic set-if-empty claim).
  const claimed = await claimSubmission(caseRecord);
  if (!claimed) return { skipped: true, reason: 'ALREADY_SUBMITTED' };

  const checks = await loadChecks(caseRecord);
  let result;
  try {
    result = await submit(providerKey, claimed, checks);
  } catch (error) {
    // Release the claim so reconciliation can retry (INTERNAL is
    // deterministic and cannot fail; external adapters document
    // provider-side idempotency keys for at-least-once calls).
    await releaseSubmission(claimed).catch(() => {});
    throw error;
  }

  await persistReference(claimed, result?.providerReference || '').catch(() => {});

  // Polling only for providers that actually poll (external
  // adapters). INTERNAL never schedules a poll. Unknown providers
  // simply do not poll — the submit above already failed safely.
  let supportsPolling = false;
  try {
    supportsPolling = getBgvProvider(providerKey).supportsPolling;
  } catch {
    supportsPolling = false;
  }
  if (deps.supportsPolling !== undefined) supportsPolling = deps.supportsPolling;
  if (supportsPolling) {
    const firstPollAt = new Date(Date.now() + nextBgvPollDelayMs(1));
    await persistPollingState(claimed, firstPollAt).catch(() => {});
    const refreshed = { ...claimed, polling: { attempts: 1 } };
    await poll(refreshed, 1, nextBgvPollDelayMs(1), deps);
  }

  logger.info(`[BGV] case processed (case=${caseRecord._id}, provider=${providerKey})`);
  return { processed: true, caseId: String(caseRecord._id), provider: providerKey };
};

// ── BGV_PROVIDER_POLL ───────────────────────────────────────────

const PROVIDER_PENDING = new Set(['PENDING', 'IN_PROGRESS', '', 'SUBMITTED']);

export const bgvPollProcessor = async (job, deps = {}) => {
  const load = deps.load || ((value) => loadCase(value));
  const getStatus = deps.getStatus ||
    (async (providerKey, caseRecord) =>
      getBgvProvider(providerKey).getStatus({ caseRecord }));
  const advance = deps.advance ||
    ((caseRecord, nextAttempt, nextPollAt) =>
      BackgroundVerificationCase.updateOne(
        { _id: caseRecord._id, companyId: caseRecord.companyId, 'polling.status': 'POLLING' },
        { $set: { 'polling.nextPollAt': nextPollAt }, $inc: { 'polling.attempts': 1 } }
      ));
  const poll = deps.schedulePoll || scheduleBgvPoll;
  const record = deps.record || recordProviderBgvResult;
  const stop = deps.stop || stopCasePolling;

  const value = job.data;
  if (!validateCasePayload(value, ['pollAttempt', 'providerKey'])) {
    throw new Error('BGV_PROVIDER_POLL rejected: payload validation failed');
  }
  const attempt = Math.trunc(Number(value.pollAttempt));
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('BGV_PROVIDER_POLL rejected: invalid pollAttempt');
  }

  const caseRecord = await load(value);
  if (!caseRecord) return { skipped: true, reason: 'NOT_FOUND' };
  if (['COMPLETED', 'CANCELLED'].includes(caseRecord.status)) {
    return { skipped: true, reason: 'CASE_CLOSED' };
  }
  const polling = caseRecord.polling || {};
  if (polling.status !== 'POLLING') return { skipped: true, reason: 'POLLING_STOPPED' };
  if (Number(polling.attempts || 0) !== attempt) {
    return { skipped: true, reason: 'STALE_POLL' };
  }

  // Max polling window (§36): stop, route to human review.
  if (caseRecord.startedAt && Date.now() - new Date(caseRecord.startedAt).getTime() > BGV_POLL_MAX_WINDOW_MS) {
    await stop({ companyId: value.companyId, caseId: value.caseId, reason: 'MAX_POLL_WINDOW' }, deps);
    return { processed: true, stopped: 'MAX_POLL_WINDOW' };
  }

  const providerKey = value.providerKey || caseRecord.provider || 'INTERNAL';
  const status = await getStatus(providerKey, caseRecord);
  const normalized = String(status?.status || '').toUpperCase();

  if (PROVIDER_PENDING.has(normalized)) {
    const nextAttempt = attempt + 1;
    const delayMs = nextBgvPollDelayMs(attempt);
    const nextPollAt = new Date(Date.now() + delayMs);
    const advanced = await advance(caseRecord, nextAttempt, nextPollAt);
    if (advanced && (advanced.modifiedCount === 0)) {
      return { skipped: true, reason: 'POLLING_STOPPED' };
    }
    await poll({ ...caseRecord, polling: { ...polling, attempts: nextAttempt } }, nextAttempt, delayMs, deps);
    return { processed: true, pending: true, nextPollAttempt: nextAttempt };
  }

  // Final provider result → normalize into the Crewly domain
  // (VERIFIED / DISCREPANCY / UNABLE_TO_VERIFY — never a candidate
  // rejection), then stop polling.
  const results = Array.isArray(status?.results)
    ? status.results
    : normalized
      ? [{ checkCode: '', providerStatus: normalized, summary: status?.summary || '' }]
      : [];
  const outcome = await record({
    companyId: value.companyId,
    caseId: value.caseId,
    results,
    providerKey,
  });
  await stop({ companyId: value.companyId, caseId: value.caseId, reason: 'RESULT_RECEIVED' }, deps);
  logger.info(`[BGV] poll final result recorded (case=${caseRecord._id})`);
  return { processed: true, ...(outcome || {}) };
};

// ── BGV_PROCESS_RESULT ──────────────────────────────────────────
// Adapter-ready normalization entry. The authoritative result must
// already be in Mongo (no large raw provider payloads in Redis);
// today no producer exists — the poll path records directly.

export const bgvProcessResultProcessor = async (job, deps = {}) => {
  const load = deps.load || ((value) => loadCase(value));
  const record = deps.record || recordProviderBgvResult;

  const value = job.data;
  if (!validateCasePayload(value, ['providerKey'])) {
    throw new Error('BGV_PROCESS_RESULT rejected: payload validation failed');
  }
  const caseRecord = await load(value);
  if (!caseRecord) return { skipped: true, reason: 'NOT_FOUND' };
  if (['COMPLETED', 'CANCELLED'].includes(caseRecord.status)) {
    return { skipped: true, reason: 'CASE_CLOSED' };
  }
  // No persisted provider-result source is configured in 28.6 —
  // completing (not failing) avoids retry spam; a future webhook
  // producer persists results then enqueues this job with them.
  const outcome = await record({
    companyId: value.companyId,
    caseId: value.caseId,
    results: [],
    providerKey: value.providerKey || caseRecord.provider || 'INTERNAL',
  });
  return { processed: true, ...(outcome || {}) };
};

export const registerBgvProcessors = ({ registerProcessor }) => {
  for (const [jobName, processor] of Object.entries({
    [JOB_NAMES.BGV_PROCESS_CHECK]: bgvProcessCheckProcessor,
    [JOB_NAMES.BGV_PROVIDER_POLL]: bgvPollProcessor,
    [JOB_NAMES.BGV_PROCESS_RESULT]: bgvProcessResultProcessor,
  })) {
    registerProcessor(jobName, processor);
  }
  logger.info(
    `[Queue] BGV processors ready (${JOB_NAMES.BGV_PROCESS_CHECK}, ` +
      `${JOB_NAMES.BGV_PROVIDER_POLL}, ${JOB_NAMES.BGV_PROCESS_RESULT})`
  );
};
