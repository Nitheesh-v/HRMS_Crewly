// ============================================================
//  PHASE 28.6 — PRE-ONBOARDING + BGV REMINDER SCHEDULING
//
// Two SCHEDULED-queue reminder families (28.5 delayed-job
// architecture, SCHEDULED_WORKER_CONCURRENCY):
//
//   PREONBOARDING_REMINDER  (candidate nudge, non-sensitive —
//     the token-bearing invite email stays synchronous per
//     28.3 policy; the reminder points to the link already
//     sent, and carries NO token)
//     types: DOCUMENTS_PENDING, DOCUMENT_RESUBMISSION, JOINING
//
//   BGV_REMINDER            (HR, reference-based)
//     types: CANDIDATE_INFO, VERIFIER, REVIEW_REQUIRED
//
// ONE reminder per state per version; eventKey idempotency makes
// even a double-fire a single email. Mongo state (workflow status,
// requirement statuses, case status, joining date) decides at
// execution whether the reminder is still valid.
//
// JOB IDS (colon-free, deterministic, Mongo-reconstructable):
//   preonboarding-reminder-<preOnboardingId>-<type>-<stateVersionMs>
//   bgv-reminder-<caseId>-<type>-<stateVersionMs>
//
// stateVersion = the Mongo-derivable timestamp that entered the
// state (startedAt / joiningDate / requirement updatedAt /
// case startedAt|updatedAt) — hooks and reconciliation rebuild
// the SAME id from Mongo.
// ============================================================

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  getPreOnboardingReminderPolicy,
  getBgvReminderPolicy,
} from '../config/queueConfig.js';
import { addScheduledJob } from './scheduledJobScheduler.js';
import { buildEventKey, requestEmailDelivery } from './emailDeliveryService.js';
import PreOnboarding from '../models/PreOnboarding.js';
import CandidateDocumentRequirement from '../models/CandidateDocumentRequirement.js';
import BackgroundVerificationCase from '../models/BackgroundVerificationCase.js';
import logger from '../config/logger.js';

const safeIdSegment = (value) =>
  /^[a-f0-9]{24}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';

const toEpochMs = (value) => {
  if (value === null || value === undefined || value === '') return null;
  let ms;
  if (typeof value === 'number') ms = value;
  else if (typeof value?.getTime === 'function') ms = value.getTime();
  else ms = Date.parse(String(value)); // ISO strings from Mongo/reconcile
  ms = Math.trunc(ms);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

const ACTIVE_PREONBOARDING_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'ACTION_REQUIRED', 'UNDER_REVIEW'];
const ACTIVE_BGV_CASE_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_CANDIDATE', 'AWAITING_VERIFIER', 'REVIEW_REQUIRED'];

// ── Job ids ─────────────────────────────────────────────────────

export const buildPreOnboardingReminderJobId = (preOnboardingId, reminderType, stateVersion) => {
  const id = safeIdSegment(preOnboardingId);
  const version = toEpochMs(stateVersion);
  if (!id || version === null) return null;
  return `preonboarding-reminder-${id}-${reminderType.toLowerCase()}-${version}`;
};

export const buildBgvReminderJobId = (caseId, reminderType, stateVersion) => {
  const id = safeIdSegment(caseId);
  const version = toEpochMs(stateVersion);
  if (!id || version === null) return null;
  return `bgv-reminder-${id}-${reminderType.toLowerCase()}-${version}`;
};

// ── Scheduling (never-throw; Mongo intent is the recovery source) ─

export const schedulePreOnboardingReminder = async (
  { preOnboarding, reminderType, stateVersion, dueAt, enqueue }
) => {
  if (
    !preOnboarding?._id ||
    !mongoose.isValidObjectId(preOnboarding.companyId) ||
    !ACTIVE_PREONBOARDING_STATUSES.includes(preOnboarding.status) ||
    !stateVersion
  ) {
    return { scheduled: false, reason: 'NOT_ELIGIBLE' };
  }
  const jobId = buildPreOnboardingReminderJobId(preOnboarding._id, reminderType, stateVersion);
  if (!jobId) return { scheduled: false, reason: 'INVALID_ID' };

  return addScheduledJob({
    jobName: JOB_NAMES.PREONBOARDING_REMINDER,
    jobId,
    payload: {
      companyId: String(preOnboarding.companyId),
      preOnboardingId: String(preOnboarding._id),
      reminderType,
      stateVersionIso: new Date(stateVersion).toISOString(),
      correlationId: crypto.randomUUID(),
    },
    executeAt: dueAt,
    enqueue,
  });
};

export const scheduleBgvReminder = async ({ caseRecord, reminderType, stateVersion, dueAt, enqueue }) => {
  if (
    !caseRecord?._id ||
    !mongoose.isValidObjectId(caseRecord.companyId) ||
    !ACTIVE_BGV_CASE_STATUSES.includes(caseRecord.status) ||
    !stateVersion
  ) {
    return { scheduled: false, reason: 'NOT_ELIGIBLE' };
  }
  const jobId = buildBgvReminderJobId(caseRecord._id, reminderType, stateVersion);
  if (!jobId) return { scheduled: false, reason: 'INVALID_ID' };

  return addScheduledJob({
    jobName: JOB_NAMES.BGV_REMINDER,
    jobId,
    payload: {
      companyId: String(caseRecord.companyId),
      caseId: String(caseRecord._id),
      reminderType,
      stateVersionIso: new Date(stateVersion).toISOString(),
      correlationId: crypto.randomUUID(),
    },
    executeAt: dueAt,
    enqueue,
  });
};

// ── Worker-side delivery (via the 28.3 email queue only) ─────────

export const deliverPreOnboardingReminder = async (
  { preOnboarding, reminderType, stateVersionIso, dispatch } = {}
) => {
  const doDispatch = dispatch || requestEmailDelivery;
  if (!preOnboarding?._id) return { dispatched: false, reason: 'NOT_FOUND' };

  const outcome = await doDispatch({
    jobName: JOB_NAMES.EMAIL_PREONBOARDING_REMINDER,
    eventType: `PREONBOARDING_${reminderType}`,
    eventKey: buildEventKey(
      'PREONBOARDING_REMINDER',
      preOnboarding._id,
      reminderType,
      stateVersionIso
    ),
    companyId: preOnboarding.companyId,
    entityType: 'PRE_ONBOARDING',
    entityId: preOnboarding._id,
    recipientType: 'CANDIDATE',
    recipientReference: preOnboarding.candidate,
    payload: {
      preOnboardingId: String(preOnboarding._id),
      reminderType,
      stateVersionIso,
    },
  });
  return { dispatched: Boolean(outcome?.queued || outcome?.duplicate) };
};

export const deliverBgvReminder = async ({ caseRecord, reminderType, stateVersionIso, dispatch } = {}) => {
  const doDispatch = dispatch || requestEmailDelivery;
  if (!caseRecord?._id) return { dispatched: false, reason: 'NOT_FOUND' };

  const outcome = await doDispatch({
    jobName: JOB_NAMES.EMAIL_BGV_REMINDER,
    eventType: `BGV_${reminderType}`,
    eventKey: buildEventKey('BGV_REMINDER', caseRecord._id, reminderType, stateVersionIso),
    companyId: caseRecord.companyId,
    entityType: 'BGV_CASE',
    entityId: caseRecord._id,
    recipientType: 'HR',
    recipientReference: caseRecord.assignedVerifier || null,
    payload: {
      caseId: String(caseRecord._id),
      reminderType,
      stateVersionIso,
    },
  });
  return { dispatched: Boolean(outcome?.queued || outcome?.duplicate) };
};

// Best-effort retirement of a pre-onboarding's deterministic
// reminder jobs (workflow terminal). Execution-time validation is
// the final guard — removal is hygiene, not the protection.
export const cancelPreOnboardingReminderJobs = async (preOnboarding) => {
  const results = [];
  const startedAt = preOnboarding?.startedAt;
  if (startedAt) {
    const id = buildPreOnboardingReminderJobId(
      preOnboarding._id,
      'DOCUMENTS_PENDING',
      startedAt
    );
    if (id) results.push(await removeScheduledJob(id));
  }
  const joiningDate = preOnboarding?.offerSnapshot?.joiningDate;
  if (joiningDate) {
    const id = buildPreOnboardingReminderJobId(
      preOnboarding._id,
      'JOINING',
      joiningDate
    );
    if (id) results.push(await removeScheduledJob(id));
  }
  const rejected = await CandidateDocumentRequirement.findOne({
    companyId: preOnboarding?.companyId,
    preOnboarding: preOnboarding?._id,
    required: true,
    status: 'RESUBMISSION_REQUIRED',
  })
    .select('updatedAt')
    .sort({ updatedAt: -1 })
    .lean().catch(() => null);
  if (rejected?.updatedAt) {
    const id = buildPreOnboardingReminderJobId(
      preOnboarding._id,
      'DOCUMENT_RESUBMISSION',
      rejected.updatedAt
    );
    if (id) results.push(await removeScheduledJob(id));
  }
  return results;
};

const removeScheduledJob = async (jobId) => {
  if (!jobId) return 'absent';
  try {
    const { getQueue } = await import('../queues/queueFactory.js');
    const queue = getQueue(QUEUE_NAMES.SCHEDULED);
    const existing = await queue.getJob(jobId);
    if (!existing) return 'absent';
    const state = await existing.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'failed') {
      await existing.remove().catch(() => {});
      return `removed-${state}`;
    }
    return state;
  } catch {
    return 'unavailable';
  }
};

// ── Reconcile loaders (bounded windows, trusted internal process) ─

export const loadPreOnboardingsForReminderReconcile = async ({ now, windowDays = 90, limit = 500 }) =>
  PreOnboarding.find({
    status: { $in: ACTIVE_PREONBOARDING_STATUSES },
    startedAt: { $ne: null, $gt: new Date(now.getTime() - windowDays * 86400000), $lte: now },
  })
    .select('companyId status candidate startedAt offerSnapshot.jobSnapshot job')
    .sort({ startedAt: 1, _id: 1 })
    .limit(Math.min(2000, Math.max(1, limit)))
    .lean();

export const loadBgvCasesForReminderReconcile = async ({ now, windowDays = 60, limit = 500 }) =>
  BackgroundVerificationCase.find({
    status: { $in: ACTIVE_BGV_CASE_STATUSES },
    startedAt: { $ne: null, $gt: new Date(now.getTime() - windowDays * 86400000), $lte: now },
  })
    .select('companyId status startedAt consent assignedVerifier')
    .sort({ startedAt: 1, _id: 1 })
    .limit(Math.min(2000, Math.max(1, limit)))
    .lean();

// Re-derive the reminder jobs that Mongo state says should exist.
// Idempotent: deterministic job ids + eventKey idempotency.
export const ensurePreOnboardingReminders = async (preOnboarding, { enqueue } = {}) => {
  const policy = getPreOnboardingReminderPolicy();
  const results = [];
  const now = Date.now();
  const startedAt = preOnboarding.startedAt;
  if (!startedAt) return results;

  // DOCUMENTS_PENDING — from the start, if mandatory docs are still
  // pending (worker revalidates the condition at execution).
  results.push(
    await schedulePreOnboardingReminder({
      preOnboarding,
      reminderType: 'DOCUMENTS_PENDING',
      stateVersion: startedAt,
      dueAt: new Date(new Date(startedAt).getTime() + policy.documentsPendingOffsetMs),
      enqueue,
    })
  );

  // DOCUMENT_RESUBMISSION — per rejection state (latest rejection
  // timestamp is the version; older rejection jobs stay stale).
  const rejected = await CandidateDocumentRequirement.find({
    companyId: preOnboarding.companyId,
    preOnboarding: preOnboarding._id,
    required: true,
    status: 'RESUBMISSION_REQUIRED',
  })
    .select('updatedAt')
    .sort({ updatedAt: -1 })
    .limit(1)
    .lean();
  if (rejected?.updatedAt) {
    results.push(
      await schedulePreOnboardingReminder({
        preOnboarding,
        reminderType: 'DOCUMENT_RESUBMISSION',
        stateVersion: rejected.updatedAt,
        dueAt: new Date(new Date(rejected.updatedAt).getTime() + policy.resubmissionOffsetMs),
        enqueue,
      })
    );
  }

  // JOINING — approaching joining date.
  const joiningDate = preOnboarding.offerSnapshot?.joiningDate;
  if (joiningDate && new Date(joiningDate).getTime() > now) {
    const dueAt = new Date(new Date(joiningDate).getTime() - policy.joiningDaysBefore);
    results.push(
      await schedulePreOnboardingReminder({
        preOnboarding,
        reminderType: 'JOINING',
        stateVersion: joiningDate,
        dueAt,
        enqueue,
      })
    );
  }
  return results;
};

// Bounded reconcile runners (CLI / worker startup). Re-derive the
// reminder jobs Mongo state says should exist; deterministic ids +
// eventKey idempotency keep re-runs safe. Never throw.
export const runPreOnboardingReminderReconcile = async ({
  now = new Date(),
  windowDays = 90,
  limit = 500,
  enqueue,
  loadPreOnboardings = loadPreOnboardingsForReminderReconcile,
  ensure = ensurePreOnboardingReminders,
} = {}) => {
  const summary = { checked: 0, queued: 0, skipped: 0, errors: 0 };
  let rows = [];
  try {
    rows = await loadPreOnboardings({ now, windowDays, limit });
  } catch {
    summary.errors += 1;
    return summary;
  }
  for (const po of rows) {
    summary.checked += 1;
    try {
      const results = await ensure(po, { enqueue });
      for (const r of results) {
        if (r.scheduled) summary.queued += 1;
        else summary.skipped += 1;
      }
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
};

export const runBgvReminderReconcile = async ({
  now = new Date(),
  windowDays = 60,
  limit = 500,
  enqueue,
  loadCases = loadBgvCasesForReminderReconcile,
  ensure = ensureBgvReminders,
} = {}) => {
  const summary = { checked: 0, queued: 0, skipped: 0, errors: 0 };
  let rows = [];
  try {
    rows = await loadCases({ now, windowDays, limit });
  } catch {
    summary.errors += 1;
    return summary;
  }
  for (const caseRecord of rows) {
    summary.checked += 1;
    try {
      const results = await ensure(caseRecord, { enqueue });
      for (const r of results) {
        if (r.scheduled) summary.queued += 1;
        else summary.skipped += 1;
      }
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
};

export const ensureBgvReminders = async (caseRecord, { enqueue } = {}) => {
  const policy = getBgvReminderPolicy();
  const results = [];
  if (!caseRecord.startedAt) return results;

  if (caseRecord.consent?.required) {
    results.push(
      await scheduleBgvReminder({
        caseRecord,
        reminderType: 'CANDIDATE_INFO',
        stateVersion: caseRecord.startedAt,
        dueAt: new Date(new Date(caseRecord.startedAt).getTime() + policy.candidateInfoOffsetMs),
        enqueue,
      })
    );
  }
  if (caseRecord.assignedVerifier) {
    const updatedAt = caseRecord.updatedAt || caseRecord.startedAt;
    results.push(
      await scheduleBgvReminder({
        caseRecord,
        reminderType: 'VERIFIER',
        stateVersion: updatedAt,
        dueAt: new Date(new Date(updatedAt).getTime() + policy.verifierOffsetMs),
        enqueue,
      })
    );
  }
  if (caseRecord.status === 'REVIEW_REQUIRED') {
    const updatedAt = caseRecord.updatedAt || caseRecord.startedAt;
    results.push(
      await scheduleBgvReminder({
        caseRecord,
        reminderType: 'REVIEW_REQUIRED',
        stateVersion: updatedAt,
        dueAt: new Date(new Date(updatedAt).getTime() + policy.candidateInfoOffsetMs),
        enqueue,
      })
    );
  }
  return results;
};
