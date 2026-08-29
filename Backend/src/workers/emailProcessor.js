// ─────────────────────────────────────────────────────────────
// Email job processors (28.3)
//
// Extends the 28.2 worker registry. Each processor:
//   validate job (name + strict payload) → claim delivery
//   (atomic, idempotent) → reload domain data UNDER companyId
//   → stale-state check against CURRENT state → render with the
//   existing mailer template builders → send via the existing
//   mailer (SMTP / MOCK) → mark the delivery result.
//
// Security: payloads carry references only; recipients, names and
// tokens are re-fetched from MongoDB; nothing sensitive is logged.
// Delivery semantics are at-least-once: every handler must be safe
// to run again (stale checks + delivery claim guarantee no double
// send of the same logical event).
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import { JOB_NAMES, EMAIL_JOB_NAMES } from '../config/queueConfig.js';
import {
  claimEmailDelivery,
  markEmailDelivery,
} from '../services/emailDeliveryService.js';
import Candidate from '../models/Candidate.js';
import JobPosting from '../models/JobPosting.js';
import Company from '../models/Company.js';
import Interview from '../models/Interview.js';
import User from '../models/User.js';
import OfferLetter from '../models/OfferLetter.js';
import PreOnboarding from '../models/PreOnboarding.js';
import CandidateDocument from '../models/CandidateDocument.js';
import CandidateDocumentRequirement from '../models/CandidateDocumentRequirement.js';
import BackgroundVerificationCase from '../models/BackgroundVerificationCase.js';
import {
  sendMail,
  applicationReceivedEmail,
  candidatePipelineUpdateEmail,
  candidateInterviewEmail,
  interviewerAssignmentEmail,
  offerDecisionConfirmationEmail,
  offerReminderEmail,
  offerWithdrawnEmail,
  preOnboardingDocumentDecisionEmail,
  preOnboardingReminderEmail,
  bgvReminderEmail,
} from '../utils/mailer.js';
import { formatInterviewSchedule } from '../utils/interviewDateTime.js';
import { normalizeCandidateStage } from '../services/candidatePipelineService.js';

// ─── Payload validation (strict, per job) ───────────────────────

const OBJECT_ID_FIELDS = new Set([
  'candidateId',
  'jobId',
  'interviewId',
  'interviewerId',
  'offerId',
  'preOnboardingId',
  'documentId',
  'requirementId',
]);

const COMMON_KEYS = ['deliveryId', 'correlationId', 'companyId'];

const EMAIL_JOB_KEYS = {
  [JOB_NAMES.EMAIL_APPLICATION_RECEIVED]: [...COMMON_KEYS, 'candidateId', 'jobId'],
  [JOB_NAMES.EMAIL_PIPELINE_UPDATE]: [...COMMON_KEYS, 'candidateId', 'stage'],
  [JOB_NAMES.EMAIL_INTERVIEW_CANDIDATE]: [...COMMON_KEYS, 'interviewId', 'eventType', 'scheduleVersion'],
  [JOB_NAMES.EMAIL_INTERVIEW_INTERVIEWER]: [...COMMON_KEYS, 'interviewId', 'interviewerId', 'eventType', 'scheduleVersion'],
  [JOB_NAMES.EMAIL_OFFER_DECISION]: [...COMMON_KEYS, 'offerId', 'decision'],
  [JOB_NAMES.EMAIL_OFFER_WITHDRAWN]: [...COMMON_KEYS, 'offerId'],
  // 28.5: non-sensitive candidate nudge (no token, no compensation).
  [JOB_NAMES.EMAIL_OFFER_REMINDER]: [...COMMON_KEYS, 'offerId', 'expiryDateIso'],
  // 28.6: pre-onboarding candidate nudge (no token) + BGV HR notice.
  [JOB_NAMES.EMAIL_PREONBOARDING_REMINDER]: [
    ...COMMON_KEYS,
    'preOnboardingId',
    'reminderType',
    'stateVersionIso',
  ],
  [JOB_NAMES.EMAIL_BGV_REMINDER]: [...COMMON_KEYS, 'caseId', 'reminderType', 'stateVersionIso'],
  [JOB_NAMES.EMAIL_PREONBOARDING_DOC_DECISION]: [
    ...COMMON_KEYS,
    'preOnboardingId',
    'documentId',
    'requirementId',
    'decision',
    'documentVersion',
  ],
};

// 28.5: REMINDER = the one scheduled reminder per interview
// schedule (dispatched by the SCHEDULED worker via the 28.3 queue).
const INTERVIEW_EVENT_TYPES = new Set(['SCHEDULED', 'RESCHEDULED', 'CANCELLED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW', 'REMINDER']);
const OFFER_DECISIONS = new Set(['ACCEPTED', 'REJECTED']);
const PREONBOARDING_DECISIONS = new Set(['VERIFIED', 'RESUBMISSION_REQUIRED', 'READY_TO_JOIN']);

// A malformed/stale Redis payload must never become authorization.
export const validateEmailJobPayload = (jobName, data) => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, reason: 'payload must be a plain object' };
  }
  const allowed = EMAIL_JOB_KEYS[jobName];
  if (!allowed) return { valid: false, reason: `unknown email job: ${jobName}` };
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) return { valid: false, reason: `unknown payload key: ${key}` };
  }
  for (const key of COMMON_KEYS) {
    if (typeof data[key] !== 'string' || data[key].length === 0) {
      return { valid: false, reason: `${key} is required` };
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (OBJECT_ID_FIELDS.has(key)) {
      if (typeof value !== 'string' || !mongoose.isValidObjectId(value)) {
        return { valid: false, reason: `${key} must be a valid id` };
      }
    } else if (key !== 'documentVersion' && typeof value !== 'string') {
      return { valid: false, reason: `${key} must be a string` };
    }
  }
  if (data.eventType && !INTERVIEW_EVENT_TYPES.has(data.eventType)) {
    return { valid: false, reason: 'invalid eventType' };
  }
  if (jobName === JOB_NAMES.EMAIL_OFFER_DECISION && !OFFER_DECISIONS.has(data.decision)) {
    return { valid: false, reason: 'invalid decision' };
  }
  if (
    jobName === JOB_NAMES.EMAIL_PREONBOARDING_DOC_DECISION &&
    !PREONBOARDING_DECISIONS.has(data.decision)
  ) {
    return { valid: false, reason: 'invalid decision' };
  }
  if (jobName === JOB_NAMES.EMAIL_PREONBOARDING_DOC_DECISION) {
    const hasDocFields = 'documentId' in data || 'requirementId' in data || 'documentVersion' in data;
    if (data.decision === 'READY_TO_JOIN') {
      // Ready-to-join is a pre-onboarding-level event: document
      // fields must be absent (contract drift would corrupt the
      // idempotency key shape).
      if (hasDocFields) return { valid: false, reason: 'READY_TO_JOIN must omit document fields' };
    } else {
      // VERIFIED / RESUBMISSION_REQUIRED must carry the exact
      // document + version the decision was made on.
      if (!hasDocFields) return { valid: false, reason: 'document fields required for this decision' };
      if (!mongoose.isValidObjectId(data.documentId)) {
        return { valid: false, reason: 'documentId must be a valid id' };
      }
      if (!mongoose.isValidObjectId(data.requirementId)) {
        return { valid: false, reason: 'requirementId must be a valid id' };
      }
      const version = Number(data.documentVersion);
      if (!Number.isInteger(version) || version < 1) {
        return { valid: false, reason: 'documentVersion must be a positive integer' };
      }
    }
  }
  return { valid: true, value: data };
};

// ─── Failure classification (§29/30) ───────────────────────────

export const FAILURE_CATEGORIES = Object.freeze({
  SMTP_AUTH_ERROR: { retryable: false },
  SMTP_CONNECTION_ERROR: { retryable: true },
  SMTP_TIMEOUT: { retryable: true },
  RECIPIENT_REJECTED: { retryable: false },
  MAIL_CONFIG_MISSING: { retryable: false },
  ENTITY_NOT_FOUND: { retryable: false },
  TENANT_MISMATCH: { retryable: false },
  STALE_STATE: { retryable: false },
  RETRIES_EXHAUSTED: { retryable: false },
  UNKNOWN: { retryable: true },
});

// Classifies a mailer error string (the mailer never throws — it
// returns { delivered, error }). Auth/config/recipient problems must
// NOT be retried (they would only hammer the provider).
export const classifyEmailSendFailure = (errorText) => {
  const msg = String(errorText || '').toLowerCase();
  if (!msg) return { category: 'UNKNOWN', retryable: true };
// Auth is detected with specific phrases/subcodes only — a bare
// "account" or "550" also appears in recipient-rejection messages
// (e.g. "550 5.1.1 ... does not exist").
  if (/(authenticat|invalid (credentials?|password|user name)|login failed|535|550 5\.7\.|553 5\.7\.|account (locked|suspended|disabled|expired))/i.test(msg)) {
    return { category: 'SMTP_AUTH_ERROR', retryable: false };
  }
  if (/(not configured|no hosts|no smtp|missing.*config|mail config)/.test(msg)) {
    return { category: 'MAIL_CONFIG_MISSING', retryable: false };
  }
  if (/(recipient|550|551|552|553|554|user unknown|invalid address|address rejected|mailbox|no such user|does not exist|cannot be delivered)/.test(msg)) {
    return { category: 'RECIPIENT_REJECTED', retryable: false };
  }
// Timeout family first: "connect ETIMEDOUT" must not be swallowed by
// the generic connect/connection branch.
  if (/(timeout|etimedout|timed out|esockethangup)/.test(msg)) {
    return { category: 'SMTP_TIMEOUT', retryable: true };
  }
  if (/(econnrefused|econnreset|econnaborted|enotfound|eai_again|socket|network|connect)/.test(msg)) {
    return { category: 'SMTP_CONNECTION_ERROR', retryable: true };
  }
  return { category: 'UNKNOWN', retryable: true };
};

// ─── Stale-state predicates (§33/34) ───────────────────────────

// The interview's current status must still allow this event, and
// for SCHEDULED/RESCHEDULED the schedule must still match the
// version this event was created for (reschedule #2 supersedes #1).
const INTERVIEW_EVENT_ALLOWED_STATUS = {
  SCHEDULED: ['SCHEDULED'],
  RESCHEDULED: ['RESCHEDULED'],
  CANCELLED: ['CANCELLED'],
  IN_PROGRESS: ['IN_PROGRESS'],
  COMPLETED: ['COMPLETED'],
  NO_SHOW: ['NO_SHOW'],
  // A reminder is valid for any still-active upcoming schedule.
  REMINDER: ['SCHEDULED', 'RESCHEDULED'],
};

// Schedule-version-checked events: the event must match the CURRENT
// scheduledStartAt — a reschedule supersedes the previous version.
const SCHEDULE_VERSIONED_EVENTS = new Set(['SCHEDULED', 'RESCHEDULED', 'REMINDER']);

export const isInterviewEventStale = ({ currentStatus, currentStartAtIso, eventType, scheduleVersion }) => {
  const allowed = INTERVIEW_EVENT_ALLOWED_STATUS[eventType];
  if (!allowed || !allowed.includes(currentStatus)) return true;
  if (
    SCHEDULE_VERSIONED_EVENTS.has(eventType) &&
    scheduleVersion &&
    currentStartAtIso &&
    String(currentStartAtIso) !== String(scheduleVersion)
  ) {
    return true;
  }
  return false;
};

// ─── Shared skeleton ────────────────────────────────────────────

const failTerminal = async ({ value, category, mode = '' }) => {
  await markEmailDelivery(value.deliveryId, value.companyId, {
    status: 'FAILED',
    lastFailureCategory: category,
    deliveryMode: mode,
  }).catch(() => {});
};

const skipStale = async (value) => {
  await markEmailDelivery(value.deliveryId, value.companyId, {
    status: 'STALE',
    lastFailureCategory: 'STALE_STATE',
  }).catch(() => {});
};

// Runs one email job. Handlers return a safe result; they throw
// ONLY for retryable transport failures (BullMQ backs off and
// retries). Terminal business failures (entity missing, tenant
// mismatch, stale) mark the delivery and return.
export const processEmailJob = async (job) => {
  const jobName = job?.name;
  if (!EMAIL_JOB_NAMES.includes(jobName)) {
    throw new Error(`email processor: unknown job name ${jobName}`);
  }
  const { valid, reason, value } = validateEmailJobPayload(jobName, job?.data);
  if (!valid) throw new Error(`email payload rejected: ${reason}`);

  // Atomic claim: null = already SENT/FAILED/STALE (duplicate or
  // replayed job) → safe no-op, no double send.
  const delivery = await claimEmailDelivery(value.deliveryId, value.companyId);
  if (!delivery) {
    return { skipped: true, reason: 'ALREADY_FINAL', deliveryId: value.deliveryId };
  }

  // Handlers mark terminal business outcomes (entity missing, tenant
  // mismatch, stale) and RETURN safe results; they throw ONLY for
  // retryable transport failures, which propagate to BullMQ so it
  // can back off and retry.
  const handler = EMAIL_HANDLERS[jobName];
  return handler(value);
};

// ─── Handlers ───────────────────────────────────────────────────

const loadCompany = async (companyId) =>
  Company.findOne({ _id: companyId }).select('_id name').lean();

const emailApplicationReceived = async (value) => {
  const candidate = await Candidate.findOne({ _id: value.candidateId, companyId: value.companyId }).lean();
  if (!candidate) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  const job = await JobPosting.findOne({ _id: value.jobId, companyId: value.companyId })
    .select('_id title jobCode')
    .lean();
  if (!job) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  if (!candidate.job || String(candidate.job) !== String(value.jobId)) {
    // Candidate no longer references this job — the event is obsolete.
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  if (candidate.status && candidate.status !== 'ACTIVE') {
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  const company = await loadCompany(value.companyId);
  if (!company) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }

  const result = await sendMail({
    to: candidate.email,
    ...applicationReceivedEmail({
      candidateName: candidate.name,
      companyName: company.name,
      jobTitle: job.title,
      jobCode: job.jobCode,
      applicationReference: candidate.candidateCode,
    }),
    sensitive: true,
  });
  return finishSend({ value, result });
};

const emailPipelineUpdate = async (value) => {
  const candidate = await Candidate.findOne({ _id: value.candidateId, companyId: value.companyId }).lean();
  if (!candidate) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  const currentStage = normalizeCandidateStage(candidate.currentStage || candidate.stage);
  if (currentStage !== value.stage) {
    // A newer transition superseded this event.
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  const company = await loadCompany(value.companyId);
  if (!company) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  const jobTitle = candidate.job
    ? (await JobPosting.findOne({ _id: candidate.job, companyId: value.companyId }).select('title').lean())?.title || 'the position'
    : 'the position';

  const result = await sendMail({
    to: candidate.email,
    ...candidatePipelineUpdateEmail({
      candidateName: candidate.name,
      companyName: company.name,
      jobTitle,
      candidateCode: candidate.candidateCode,
      stage: currentStage,
    }),
    sensitive: true,
  });
  return finishSend({ value, result });
};

const loadInterviewContext = async (value) => {
  const interview = await Interview.findOne({ _id: value.interviewId, companyId: value.companyId }).lean();
  if (!interview) return { error: 'ENTITY_NOT_FOUND' };
  const candidate = await Candidate.findOne({ _id: interview.candidate, companyId: value.companyId }).lean();
  if (!candidate) return { error: 'ENTITY_NOT_FOUND' };
  const job = interview.job
    ? await JobPosting.findOne({ _id: interview.job, companyId: value.companyId }).select('title').lean()
    : null;
  const company = await loadCompany(value.companyId);
  if (!company) return { error: 'ENTITY_NOT_FOUND' };
  return { interview, candidate, job, company };
};

// Loads the interview context and applies the stale-state check in
// one pass; returns either { error } or { stale, ...ctx }.
const interviewStaleCheck = async (value) => {
  const ctx = await loadInterviewContext(value);
  if (ctx.error) return { error: ctx.error };
  const stale = isInterviewEventStale({
    currentStatus: ctx.interview.status,
    currentStartAtIso: ctx.interview.scheduledStartAt ? new Date(ctx.interview.scheduledStartAt).toISOString() : '',
    eventType: value.eventType,
    scheduleVersion: value.scheduleVersion,
  });
  return { ...ctx, stale };
};

const interviewRender = (value, ctx) => {
  const { interview, candidate, job, company } = ctx;
  const scheduleLabel = formatInterviewSchedule({
    startAt: interview.scheduledStartAt,
    timezone: interview.timezone,
  });
  const base = {
    event: value.eventType,
    candidateName: candidate.name,
    companyName: company.name,
    jobTitle: job?.title,
    interviewCode: interview.interviewCode,
    roundName: interview.round?.name,
    scheduleLabel,
    interviewType: interview.interviewType,
  };
  const cancelled = value.eventType === 'CANCELLED';
  return {
    candidateEmail: candidateInterviewEmail({
      ...base,
      meetingLink: cancelled ? '' : interview.meetingLink,
      location: cancelled ? '' : interview.location,
      instructions: cancelled ? '' : interview.candidateInstructions,
    }),
    interviewerEmail: (interviewerName) =>
      interviewerAssignmentEmail({
        ...base,
        interviewerName,
        candidateEmail: candidate.email,
        meetingLink: cancelled ? '' : interview.meetingLink,
        location: cancelled ? '' : interview.location,
        internalNotes: cancelled ? '' : interview.internalNotes,
      }),
  };
};

const emailInterviewCandidate = async (value) => {
  const check = await interviewStaleCheck(value);
  if (check.error) {
    await failTerminal({ value, category: check.error });
    return { sent: false, reason: check.error, deliveryId: value.deliveryId };
  }
  if (check.stale) {
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  const { candidateEmail } = interviewRender(value, check);
  const result = await sendMail({
    to: check.candidate.email,
    ...candidateEmail,
    sensitive: true,
  });
  return finishSend({ value, result });
};

const emailInterviewInterviewer = async (value) => {
  const check = await interviewStaleCheck(value);
  if (check.error) {
    await failTerminal({ value, category: check.error });
    return { sent: false, reason: check.error, deliveryId: value.deliveryId };
  }
  if (check.stale) {
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  const interviewer = await User.findOne({ _id: value.interviewerId, companyId: value.companyId })
    .select('name email')
    .lean();
  if (!interviewer) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  const stillAssigned = (check.interview.interviewers || []).some(
    (id) => String(id) === String(value.interviewerId)
  );
  if (!stillAssigned) {
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  const { interviewerEmail } = interviewRender(value, check);
  const result = await sendMail({
    to: interviewer.email,
    ...interviewerEmail(interviewer.name),
    sensitive: true,
  });
  return finishSend({ value, result });
};

const emailOfferDecision = async (value) => {
  const offer = await OfferLetter.findOne({ _id: value.offerId, companyId: value.companyId }).lean();
  if (!offer) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  if (offer.status !== value.decision) {
    // Offer moved on (e.g. withdrawn after the decision was queued).
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  if (!offer.candidateSnapshot?.email) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  const result = await sendMail({
    to: offer.candidateSnapshot.email,
    ...offerDecisionConfirmationEmail({ offer, decision: value.decision }),
    sensitive: true,
  });
  return finishSend({ value, result });
};

// 28.5: offer expiry reminder — a NON-SENSITIVE nudge. It never
// carries the secure portal token (the token-bearing offer-SEND
// email is intentionally synchronous by 28.3 policy); the candidate
// is directed to the link from the original offer email.
const emailOfferReminder = async (value) => {
  const offer = await OfferLetter.findOne({ _id: value.offerId, companyId: value.companyId }).lean();
  if (!offer) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  if (!['SENT', 'VIEWED'].includes(offer.status)) {
    // Decided/withdrawn/expired after the reminder was queued.
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  if (new Date(offer.terms?.expiryDate).toISOString() !== value.expiryDateIso) {
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  if (new Date(offer.terms.expiryDate).getTime() <= Date.now()) {
    // The atomic expiry path owns that moment (history/audit).
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  if (!offer.candidateSnapshot?.email) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  const result = await sendMail({
    to: offer.candidateSnapshot.email,
    ...offerReminderEmail({ offer }),
    sensitive: false,
  });
  return finishSend({ value, result });
};

// 28.6: pre-onboarding candidate reminder. Re-fetches the workflow
// state and revalidates the CONDITION before sending (the scheduled
// worker already validated once — belt and braces). Non-sensitive:
// no portal token, no document details.
const emailPreOnboardingReminder = async (value) => {
  const preOnboarding = await PreOnboarding.findOne({
    _id: value.preOnboardingId,
    companyId: value.companyId,
  }).lean();
  if (!preOnboarding) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  if (['COMPLETED', 'READY_TO_JOIN', 'WITHDRAWN'].includes(preOnboarding.status)) {
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  const candidate = await Candidate.findOne({
    _id: preOnboarding.candidate,
    companyId: value.companyId,
  })
    .select('_id convertedUser')
    .lean();
  if (!candidate || candidate.convertedUser) {
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  const reqBase = {
    companyId: value.companyId,
    preOnboarding: preOnboarding._id,
    required: true,
  };
  if (value.reminderType === 'DOCUMENTS_PENDING') {
    const pending = await CandidateDocumentRequirement.countDocuments({ ...reqBase, status: 'PENDING' });
    if (pending === 0) {
      await skipStale(value);
      return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
    }
  } else if (value.reminderType === 'DOCUMENT_RESUBMISSION') {
    const rejected = await CandidateDocumentRequirement.countDocuments({
      ...reqBase,
      status: 'RESUBMISSION_REQUIRED',
    });
    if (rejected === 0) {
      await skipStale(value);
      return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
    }
  } else if (value.reminderType === 'JOINING') {
    const joiningDate = preOnboarding.offerSnapshot?.joiningDate;
    if (!joiningDate || new Date(joiningDate).getTime() <= Date.now()) {
      await skipStale(value);
      return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
    }
  } else {
    await failTerminal({ value, category: 'STALE_STATE' });
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  if (!preOnboarding.candidateSnapshot?.email) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  const result = await sendMail({
    to: preOnboarding.candidateSnapshot.email,
    ...preOnboardingReminderEmail({ preOnboarding, reminderType: value.reminderType }),
    sensitive: false,
  });
  return finishSend({ value, result });
};

// 28.6: BGV HR reminder. Resolves the recipient server-side
// (assigned verifier, else a company HR user) — the payload carries
// no names/emails.
const emailBgvReminder = async (value) => {
  const caseRecord = await BackgroundVerificationCase.findOne({
    _id: value.caseId,
    companyId: value.companyId,
  }).lean();
  if (!caseRecord) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  if (['COMPLETED', 'CANCELLED'].includes(caseRecord.status)) {
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  if (value.reminderType === 'CANDIDATE_INFO') {
    if (caseRecord.status !== 'AWAITING_CANDIDATE') {
      await skipStale(value);
      return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
    }
  } else if (value.reminderType === 'VERIFIER') {
    if (caseRecord.status !== 'AWAITING_VERIFIER' || !caseRecord.assignedVerifier) {
      await skipStale(value);
      return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
    }
  } else if (value.reminderType === 'REVIEW_REQUIRED') {
    if (caseRecord.status !== 'REVIEW_REQUIRED') {
      await skipStale(value);
      return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
    }
  } else {
    await failTerminal({ value, category: 'STALE_STATE' });
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }

  let recipient = caseRecord.assignedVerifier
    ? await User.findOne({ _id: caseRecord.assignedVerifier, companyId: value.companyId })
        .select('name email')
        .lean()
    : null;
  if (!recipient) {
    recipient = await User.findOne({
      companyId: value.companyId,
      role: { $in: ['HR_MANAGER', 'COMPANY_ADMIN'] },
      status: 'ACTIVE',
    })
      .select('name email')
      .sort({ createdAt: 1 })
      .lean();
  }
  if (!recipient?.email) {
    // No HR recipient configured — skip safely (not an error).
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }

  const result = await sendMail({
    to: recipient.email,
    ...bgvReminderEmail({
      caseRecord,
      reminderType: value.reminderType,
      recipientName: recipient.name || 'Hiring team',
    }),
    sensitive: false,
  });
  return finishSend({ value, result });
};

const emailOfferWithdrawn = async (value) => {
  const offer = await OfferLetter.findOne({ _id: value.offerId, companyId: value.companyId }).lean();
  if (!offer) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  if (offer.status !== 'WITHDRAWN') {
    await skipStale(value);
    return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
  }
  if (!offer.candidateSnapshot?.email) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  const result = await sendMail({
    to: offer.candidateSnapshot.email,
    ...offerWithdrawnEmail({ offer }),
    sensitive: true,
  });
  return finishSend({ value, result });
};

const emailPreOnboardingDocDecision = async (value) => {
  const preOnboarding = await PreOnboarding.findOne({ _id: value.preOnboardingId, companyId: value.companyId }).lean();
  if (!preOnboarding) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }
  if (!preOnboarding.candidateSnapshot?.email) {
    await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
    return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
  }

  let requirementName = 'Pre-onboarding';
  if (value.decision === 'READY_TO_JOIN') {
    if (preOnboarding.status !== 'READY_TO_JOIN') {
      await skipStale(value);
      return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
    }
  } else {
    const document = await CandidateDocument.findOne({ _id: value.documentId, companyId: value.companyId }).lean();
    if (!document) {
      await failTerminal({ value, category: 'ENTITY_NOT_FOUND' });
      return { sent: false, reason: 'ENTITY_NOT_FOUND', deliveryId: value.deliveryId };
    }
    if (String(document.preOnboarding) !== String(value.preOnboardingId)) {
      await failTerminal({ value, category: 'TENANT_MISMATCH' });
      return { sent: false, reason: 'TENANT_MISMATCH', deliveryId: value.deliveryId };
    }
    if (
      document.status !== value.decision ||
      Number(document.currentVersion) !== Number(value.documentVersion)
    ) {
      // A newer review decision superseded this event.
      await skipStale(value);
      return { skipped: true, reason: 'STALE_STATE', deliveryId: value.deliveryId };
    }
    const requirement = await CandidateDocumentRequirement.findOne({
      _id: document.candidateRequirement,
      companyId: value.companyId,
    })
      .select('nameSnapshot')
      .lean();
    requirementName = requirement?.nameSnapshot || document.requirementCode;
  }

  const message = preOnboardingDocumentDecisionEmail({
    candidateName: preOnboarding.candidateSnapshot.name,
    companyName: preOnboarding.companySnapshot?.name,
    requirementName,
    decision: value.decision,
    ...(value.decision === 'RESUBMISSION_REQUIRED'
      ? await getResubmissionReason({ documentId: value.documentId, companyId: value.companyId })
      : {}),
  });
  const result = await sendMail({
    to: preOnboarding.candidateSnapshot.email,
    ...message,
    sensitive: true,
  });
  return finishSend({ value, result });
};

// Re-read the CURRENT rejection reason from MongoDB (never from the
// queue payload) so the email reflects authoritative state.
const getResubmissionReason = async ({ documentId, companyId }) => {
  const document = await CandidateDocument.findOne({ _id: documentId, companyId })
    .select('rejectionReason')
    .lean();
  return { reason: document?.rejectionReason || '' };
};

// ─── Send result handling ───────────────────────────────────────

const finishSend = async ({ value, result }) => {
  if (result?.delivered) {
    await markEmailDelivery(value.deliveryId, value.companyId, {
      status: 'SENT',
      deliveryMode: result.mode || '',
      lastFailureCategory: '',
    }).catch(() => {});
    return { sent: true, deliveryId: value.deliveryId, deliveryMode: result.mode || '' };
  }

  const { category, retryable } = classifyEmailSendFailure(result?.error || '');
  if (retryable) {
    // Leave the delivery PROCESSING; BullMQ backs off and retries,
    // and the claim logic is re-entrant. After the final attempt the
    // worker's failed handler marks RETRIES_EXHAUSTED.
    throw new Error(`email send retryable failure (${category}): ${String(result?.error || '').slice(0, 160)}`);
  }
  await failTerminal({ value, category, mode: result?.mode || '' });
  return { sent: false, reason: category, deliveryId: value.deliveryId };
};

const EMAIL_HANDLERS = {
  [JOB_NAMES.EMAIL_APPLICATION_RECEIVED]: emailApplicationReceived,
  [JOB_NAMES.EMAIL_PIPELINE_UPDATE]: emailPipelineUpdate,
  [JOB_NAMES.EMAIL_INTERVIEW_CANDIDATE]: emailInterviewCandidate,
  [JOB_NAMES.EMAIL_INTERVIEW_INTERVIEWER]: emailInterviewInterviewer,
  [JOB_NAMES.EMAIL_OFFER_DECISION]: emailOfferDecision,
  [JOB_NAMES.EMAIL_OFFER_REMINDER]: emailOfferReminder,
  [JOB_NAMES.EMAIL_OFFER_WITHDRAWN]: emailOfferWithdrawn,
  [JOB_NAMES.EMAIL_PREONBOARDING_REMINDER]: emailPreOnboardingReminder,
  [JOB_NAMES.EMAIL_BGV_REMINDER]: emailBgvReminder,
  [JOB_NAMES.EMAIL_PREONBOARDING_DOC_DECISION]: emailPreOnboardingDocDecision,
};

// Registers all email processors into the 28.2 job registry.
export const registerEmailProcessors = ({ registerProcessor }) => {
  for (const jobName of Object.keys(EMAIL_HANDLERS)) {
    registerProcessor(jobName, processEmailJob);
  }
};

export default processEmailJob;
