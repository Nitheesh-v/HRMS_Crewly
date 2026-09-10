// ============================================================
//  PHASE 30.11 — BGV pipeline reminders (candidate / verifier / QA).
//
//  Architecture (reuses Phase 28 — nothing new is invented):
//   - A bounded reconciliation scan (scripts/bgv-reminder-reconcile.js,
//     operator-triggered or cron'd OUTSIDE this repo) derives pending
//     milestones from the authoritative Mongo documents — Mongo is the
//     source of truth; Redis losing jobs loses nothing.
//   - Each pending milestone is dispatched through the EXISTING
//     EmailDelivery outbox (requestEmailDelivery) on the existing
//     email queue with a NEW job name (email-bgv30-reminder).
//   - Idempotency: deterministic per-bucket event keys. Candidate
//     nudges fire in 48-hour buckets (max 3); verifier SLA nudges in
//     daily buckets (max 5); QA nudges daily (max 2). Re-running the
//     scan collapses onto existing deliveries (duplicate: true).
//     Email is honestly at-least-once — never claimed exactly-once.
//   - Queue payloads carry REFERENCES ONLY (orderId, kind, checkType,
//     requestId, bucket). Never tokens, portal URLs, PII, documents,
//     notes, report content or rendered HTML.
//   - The worker re-fetches Mongo and skips stale milestones; SMTP
//     failure only marks the EmailDelivery FAILED (or retries) — it
//     NEVER mutates BGV business state.
//   - Portal tokens are rotated synchronously at dispatch time and
//     only when no active unexpired token exists (30.4/30.9 security:
//     hash-only storage, raw token never queued or logged).
// ============================================================

import mongoose from 'mongoose';
import env from '../../config/env.js';
import { hashToken, randomToken } from '../../utils/securityPolicy.js';
import { BGV_CONSENT_PURPOSE, BGV_CONSENT_TOKEN_MAX_DAYS } from './bgvConsentRules.js';
import { isCommerciallyAuthorized } from './bgvOrderRules.js';
import { evaluateCheckSla } from './bgvSlaRules.js';
import { readSlaPolicy } from './bgvOperationsDashboardService.js';

export const REMINDER_KINDS = [
  'CONSENT_PENDING', // 30.4 candidate consent still open
  'SUBMISSION_PENDING', // 30.5 candidate submission still open
  'INFO_PENDING', // 30.9 info request awaiting candidate response
  'VERIFIER_SLA', // 30.11 verifier near/past turnaround target
  'QA_PENDING', // 30.10 submitted check awaiting QA review
];

export const REMINDER_EVERY_HOURS = 48; // candidate nudge cadence (48h buckets)
export const MAX_CANDIDATE_REMINDERS = 3; // hard anti-spam cap per milestone
export const MAX_VERIFIER_REMINDERS = 5; // daily buckets while SLA is red
export const MAX_QA_REMINDERS = 2; // daily buckets for a pending QA review

import BgvOrder from '../../models/BgvOrder.js';
import BgvCollectionCase from '../../models/BgvCollectionCase.js';
import BgvCheckAssignment from '../../models/BgvCheckAssignment.js';
import BgvCheckVerification from '../../models/BgvCheckVerification.js';
import BgvInfoRequest from '../../models/BgvInfoRequest.js';
import BgvConsentAccessToken from '../../models/BgvConsentAccessToken.js';
import BgvVerifier from '../../models/BgvVerifier.js';
import Company from '../../models/Company.js';
import Candidate from '../../models/Candidate.js';
import User from '../../models/User.js';

// Direct model references (the app's normal pattern). Every query below
// can still be replaced through deps for hermetic tests.
const MODELS = {
  BgvOrder,
  BgvCollectionCase,
  BgvCheckAssignment,
  BgvCheckVerification,
  BgvInfoRequest,
  BgvConsentAccessToken,
  BgvVerifier,
  Company,
  Candidate,
  User,
};
const loadModels = () => MODELS;

const id = (v) => String(v?._id ?? v ?? '');
const iso = (v) => (v ? new Date(v).toISOString() : null);
const hoursSince = (from, nowIso) => (from ? (Date.parse(nowIso) - Date.parse(iso(from))) / 3600000 : 0);

// ── Scan: derive pending milestones from authoritative documents ──
export const collectReminderTargets = async ({ deps = {}, nowIso = new Date().toISOString(), limit = 25 } = {}) => {
  const m = deps.models || loadModels();
  const [orders, cases, infoRequests, verifications, assignments] = await Promise.all([
    (deps.findOrders ||
      (() =>
        m.BgvOrder.find({ status: 'PAID' })
          .select('_id companyId candidate orderCode paidAt createdAt')
          .lean()))(),
    (deps.findCases ||
      (() => m.BgvCollectionCase.find({}).select('_id bgvOrder status submittedAt createdAt').lean()))(),
    (deps.findInfoRequests ||
      (() => m.BgvInfoRequest.find({ status: 'OPEN' }).select('_id bgvOrder checkType category requestedAt').lean()))(),
    (deps.findVerifications ||
      (() =>
        m.BgvCheckVerification.find({ activeKey: 'CURRENT' })
          .select('+activeKey _id bgvOrder checkType state qa conclusion')
          .lean()))(),
    (deps.findAssignments ||
      (() =>
        m.BgvCheckAssignment.find({ activeKey: 'CURRENT' })
          .select('+activeKey _id bgvOrder checkType verifier assignedAt')
          .lean()))(),
  ]);
  const policy = await readSlaPolicy({ deps });
  const caseByOrder = new Map(cases.map((c) => [id(c.bgvOrder), c]));
  const assignByKey = new Map(assignments.map((a) => [`${id(a.bgvOrder)}|${a.checkType}`, a]));
  const infoByOrderCheck = new Map(
    infoRequests.map((r) => [`${id(r.bgvOrder)}|${r.checkType}`, r])
  );

  const targets = [];
  const push = (target) => {
    if (targets.length < limit) targets.push(target);
  };

  for (const order of orders) {
    if (!isCommerciallyAuthorized(order)) continue; // payment future-proofing boundary
    const caseDoc = caseByOrder.get(id(order._id));

    if (!caseDoc) {
      // 30.4 — consent still open (no collection case exists yet).
      const bucket = Math.floor(hoursSince(order.paidAt || order.createdAt, nowIso) / REMINDER_EVERY_HOURS);
      if (bucket >= 0 && bucket < MAX_CANDIDATE_REMINDERS) {
        push({ kind: 'CONSENT_PENDING', orderId: id(order._id), companyId: id(order.companyId), checkType: null, requestId: null, bucket });
      }
      continue;
    }

    if (caseDoc.status !== 'SUBMITTED' || !caseDoc.submittedAt) {
      // 30.5 — submission still open.
      const bucket = Math.floor(hoursSince(caseDoc.createdAt, nowIso) / REMINDER_EVERY_HOURS);
      if (bucket >= 0 && bucket < MAX_CANDIDATE_REMINDERS) {
        push({ kind: 'SUBMISSION_PENDING', orderId: id(order._id), companyId: id(order.companyId), checkType: null, requestId: null, bucket });
      }
      continue;
    }

    // 30.9 — open info requests awaiting the candidate.
    for (const request of infoRequests.filter((r) => id(r.bgvOrder) === id(order._id))) {
      const bucket = Math.floor(hoursSince(request.requestedAt, nowIso) / REMINDER_EVERY_HOURS);
      if (bucket >= 0 && bucket < MAX_CANDIDATE_REMINDERS) {
        push({ kind: 'INFO_PENDING', orderId: id(order._id), companyId: id(order.companyId), checkType: request.checkType, requestId: id(request._id), bucket });
      }
    }

    // Verifier SLA + QA reminders need the SLA policy to be configured.
    for (const verification of verifications.filter((v) => id(v.bgvOrder) === id(order._id))) {
      const assignment = assignByKey.get(`${id(order._id)}|${verification.checkType}`);

      if (['IN_PROGRESS', 'AWAITING_THIRD_PARTY'].includes(verification.state) && assignment) {
        const clockStartIso = [caseDoc.submittedAt, assignment.assignedAt]
          .filter(Boolean)
          .map((d) => new Date(d).toISOString())
          .sort()
          .pop();
        const info = infoByOrderCheck.get(`${id(order._id)}|${verification.checkType}`);
        const sla = evaluateCheckSla({
          clockStartIso,
          pausedIntervals:
            policy?.pauseOnCandidateWait && info
              ? [{ startIso: iso(info.requestedAt), endIso: iso(info.respondedAt || info.resolvedAt || info.cancelledAt) }]
              : [],
          nowIso,
          targetHours: policy?.targets?.[verification.checkType] ?? null,
          dueSoonHours: policy?.dueSoonHours ?? 24,
          currentlyPaused: verification.state === 'AWAITING_CANDIDATE',
        });
        if (['DUE_SOON', 'OVERDUE'].includes(sla.status)) {
          const bucket = Math.floor(hoursSince(clockStartIso, nowIso) / 24);
          if (bucket >= 0 && bucket < MAX_VERIFIER_REMINDERS) {
            push({ kind: 'VERIFIER_SLA', orderId: id(order._id), companyId: id(order.companyId), checkType: verification.checkType, requestId: null, bucket });
          }
        }
      }

      if (verification.state === 'SUBMITTED' && ['NONE', 'PENDING'].includes(verification.qa?.status || 'PENDING')) {
        const qaStart = verification.conclusion?.submittedAt || verification.qa?.reviewedAt;
        const bucket = Math.floor(hoursSince(qaStart, nowIso) / 24);
        if (bucket >= 0 && bucket < MAX_QA_REMINDERS) {
          push({ kind: 'QA_PENDING', orderId: id(order._id), companyId: id(order.companyId), checkType: verification.checkType, requestId: null, bucket });
        }
      }
    }
  }
  return targets;
};

// ── Worker-side revalidation: skip anything already actioned ─────
// The queue never decides; Mongo does. Every kind re-checks the
// authoritative document and returns a stale reason when the
// milestone has moved on since dispatch.
export const revalidateReminder = async ({ orderId, kind, checkType, requestId, deps = {}, nowIso = new Date().toISOString() } = {}) => {
  const m = deps.models || loadModels();
  if (!mongoose.isValidObjectId(orderId)) return { valid: false, reason: 'ORDER_INACTIVE' };
  const order = await (deps.findOrder ||
    (() => m.BgvOrder.findById(orderId).select('_id companyId candidate orderCode status paidAt createdAt').lean()))();
  if (!order || !isCommerciallyAuthorized(order)) return { valid: false, reason: 'ORDER_INACTIVE' };

  const findCase = deps.findCase ||
    (() => m.BgvCollectionCase.findOne({ bgvOrder: order._id }).select('_id status submittedAt createdAt').lean());
  const caseDoc = await findCase();

  if (kind === 'CONSENT_PENDING') {
    // Consent was given as soon as the collection case exists; a
    // decided token (incl. DECLINED) also ends the reminder forever —
    // a decline is not a failure to chase.
    if (caseDoc) return { valid: false, reason: 'ALREADY_DECIDED' };
    const token = await (deps.findLatestToken ||
      (() =>
        m.BgvConsentAccessToken.findOne({ bgvOrder: order._id, purpose: BGV_CONSENT_PURPOSE })
          .sort({ createdAt: -1 })
          .select('finalDecision decidedAt')
          .lean()))();
    if (token?.decidedAt || token?.finalDecision) return { valid: false, reason: 'ALREADY_DECIDED' };
    return { valid: true, order, needsPortalLink: true };
  }

  if (kind === 'SUBMISSION_PENDING') {
    if (!caseDoc) return { valid: false, reason: 'ORDER_INACTIVE' };
    if (caseDoc.status === 'SUBMITTED' || caseDoc.submittedAt) return { valid: false, reason: 'ALREADY_SUBMITTED' };
    return { valid: true, order, needsPortalLink: true };
  }

  if (kind === 'INFO_PENDING') {
    if (!mongoose.isValidObjectId(requestId)) return { valid: false, reason: 'ALREADY_RESPONDED' };
    const request = await (deps.findInfoRequest ||
      (() => m.BgvInfoRequest.findById(requestId).select('_id bgvOrder status respondedAt checkType category').lean()))();
    if (!request || id(request.bgvOrder) !== id(order._id)) return { valid: false, reason: 'ALREADY_RESPONDED' };
    if (request.status !== 'OPEN' || request.respondedAt) return { valid: false, reason: 'ALREADY_RESPONDED' };
    return { valid: true, order, needsPortalLink: true, categoryLabel: request.category };
  }

  if (kind === 'VERIFIER_SLA') {
    const verification = await (deps.findVerification ||
      (() =>
        m.BgvCheckVerification.findOne({ bgvOrder: order._id, checkType, activeKey: 'CURRENT' })
          .select('+activeKey state qa conclusion')
          .lean()))();
    if (!verification || !['IN_PROGRESS', 'AWAITING_THIRD_PARTY', 'QA_RETURNED'].includes(verification.state)) {
      return { valid: false, reason: 'CHECK_NO_LONGER_ACTIVE' };
    }
    // Recompute the SLA now — it may have been completed on time since
    // dispatch (then the nudge would be noise).
    const assignment = await (deps.findAssignment ||
      (() =>
        m.BgvCheckAssignment.findOne({ bgvOrder: order._id, checkType, activeKey: 'CURRENT' })
          .select('+activeKey assignedAt')
          .lean()))();
    const policy = await readSlaPolicy({ deps });
    const clockStartIso = [caseDoc?.submittedAt, assignment?.assignedAt]
      .filter(Boolean)
      .map((d) => new Date(d).toISOString())
      .sort()
      .pop();
    const sla = evaluateCheckSla({
      clockStartIso,
      nowIso,
      targetHours: policy?.targets?.[checkType] ?? null,
      dueSoonHours: policy?.dueSoonHours ?? 24,
    });
    if (!['DUE_SOON', 'OVERDUE'].includes(sla.status)) return { valid: false, reason: 'SLA_NO_LONGER_RED' };
    return { valid: true, order, slaStatus: sla.status };
  }

  if (kind === 'QA_PENDING') {
    const verification = await (deps.findVerification ||
      (() =>
        m.BgvCheckVerification.findOne({ bgvOrder: order._id, checkType, activeKey: 'CURRENT' })
          .select('+activeKey state qa')
          .lean()))();
    if (!verification || verification.state !== 'SUBMITTED' || !['NONE', 'PENDING'].includes(verification.qa?.status || 'PENDING')) {
      return { valid: false, reason: 'QA_NO_LONGER_PENDING' };
    }
    return { valid: true, order };
  }

  return { valid: false, reason: 'UNKNOWN_KIND' };
};

// ── Portal link at dispatch time (30.4/30.9 security preserved) ──
// Rotate ONLY when the candidate has no active, unexpired token; the
// raw token is used to build the URL in-process and is NEVER queued,
// logged or audited. Post-consent nudges carry the completed
// CONSENTED decision — rotation never reopens a decision.
export const ensurePortalLink = async ({ order, kind, deps = {}, nowIso = new Date() } = {}) => {
  const m = deps.models || loadModels();
  const active = await (deps.findActiveToken ||
    (() =>
      m.BgvConsentAccessToken.findOne({
        bgvOrder: order._id,
        purpose: BGV_CONSENT_PURPOSE,
        finalDecision: kind === 'CONSENT_PENDING' ? null : 'CONSENTED',
        revokedAt: null,
        expiresAt: { $gt: nowIso },
      })
        .select('+activeKey activeKey')
        .lean()))();
  if (active?.activeKey === 'ACTIVE') return { portalUrl: null, rotated: false };

  const latest = await (deps.findLatestToken ||
    (() =>
      m.BgvConsentAccessToken.findOne({ bgvOrder: order._id, purpose: BGV_CONSENT_PURPOSE })
        .sort({ createdAt: -1 })
        .select('finalDecision decidedAt')
        .lean()))();
  if (kind !== 'CONSENT_PENDING' && latest?.finalDecision !== 'CONSENTED') {
    // Never link a candidate past a decision that was not given.
    return { portalUrl: null, rotated: false, blocked: 'CONSENT_NOT_GIVEN' };
  }
  const rawToken = randomToken(48);
  const expiresAt = new Date(Date.parse(new Date(nowIso).toISOString()) + BGV_CONSENT_TOKEN_MAX_DAYS * 24 * 60 * 60 * 1000);
  await (deps.revokeActiveTokens ||
    (async () =>
      m.BgvConsentAccessToken.updateMany(
        { bgvOrder: order._id, purpose: BGV_CONSENT_PURPOSE, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'ROTATED_FOR_REMINDER', activeKey: null } }
      )))();
  const tokenDoc = {
    companyId: order.companyId,
    candidate: order.candidate,
    bgvOrder: order._id,
    purpose: BGV_CONSENT_PURPOSE,
    tokenHash: hashToken(rawToken),
    expiresAt,
    issuedBy: null,
    orderCode: order.orderCode,
    finalDecision: kind === 'CONSENT_PENDING' ? null : 'CONSENTED',
    decidedAt: kind === 'CONSENT_PENDING' ? null : latest?.decidedAt || new Date(),
  };
  if (deps.insertToken) await deps.insertToken(tokenDoc);
  else await m.BgvConsentAccessToken.create(tokenDoc);
  const clientOrigin = String(env.CLIENT_URL || '').split(',')[0].trim().replace(/\/$/, '');
  return { portalUrl: `${clientOrigin}/candidate/bgv-consent/${rawToken}`, rotated: true };
};

// ── Recipient resolvers (authoritative Mongo only) ───────────────
// Returns the safe candidate contact { email, name } (authoritative
// Mongo only) or null. Name is display-only for the greeting.
export const resolveCandidateEmail = async (candidateId, deps = {}) => {
  const m = deps.models || loadModels();
  if (!mongoose.isValidObjectId(candidateId)) return null;
  const candidate = await (deps.findCandidate ||
    (() => m.Candidate.findById(candidateId).select('email name').lean()))();
  return candidate?.email ? { email: candidate.email, name: candidate.name || 'Candidate' } : null;
};

export const resolveCompany = async (companyId, deps = {}) => {
  const m = deps.models || loadModels();
  if (!mongoose.isValidObjectId(companyId)) return null;
  return (deps.findCompany || (() => m.Company.findById(companyId).select('name').lean()))();
};

export const resolveVerifier = async (orderId, checkType, deps = {}) => {
  const m = deps.models || loadModels();
  const assignment = await (deps.findAssignment ||
    (() =>
      m.BgvCheckAssignment.findOne({ bgvOrder: orderId, checkType, activeKey: 'CURRENT' })
        .select('+activeKey verifier assignedAt')
        .lean()))();
  if (!assignment?.verifier) return null;
  const verifier = await (deps.findVerifier ||
    (() => m.BgvVerifier.findById(assignment.verifier).select('name email status').lean()))();
  if (!verifier || verifier.status !== 'ACTIVE') return null;
  return { assignment, verifier };
};

// Internal QA recipient resolution (platform users holding bgv-qa:review).
export const resolveQaRecipients = async (_companyId, deps = {}) => {
  const m = deps.models || loadModels();
  const users = await (deps.findQaUsers ||
    (() =>
      m.User.find({
        $or: [{ role: { $in: ['SUPER_ADMIN', 'PLATFORM_ADMIN'] } }, { platformPermissions: 'bgv-qa:review' }],
        isActive: { $ne: false },
      })
        .select('email')
        .lean()))();
  return users.map((u) => u.email).filter(Boolean);
};

// ── Dispatch through the EXISTING EmailDelivery outbox ───────────
// Deterministic event key = honest idempotency anchor (unique on
// EmailDelivery.eventKey). Delivery is at-least-once: a crash after
// enqueue but before send may resend; the unique key never double-
// creates a delivery for the same bucket.
export const reminderEventKey = (target) =>
  `bgv30-${target.kind}-${target.orderId}-${target.checkType || 'ORDER'}-${target.requestId || 'na'}-b${target.bucket}`;

export const runBgvReminderReconciliation = async ({ deps = {}, nowIso = new Date().toISOString(), limit = 25 } = {}) => {
  const targets = await collectReminderTargets({ deps, nowIso, limit });
  const dispatch =
    deps.dispatch ||
    (async (args) => {
      const { requestEmailDelivery } = await import('../emailDeliveryService.js');
      return requestEmailDelivery(args);
    });
  const report = { scanned: targets.length, queued: 0, duplicate: 0, failed: 0 };
  for (const target of targets) {
    const recipientType = ['CONSENT_PENDING', 'SUBMISSION_PENDING', 'INFO_PENDING'].includes(target.kind)
      ? 'CANDIDATE'
      : 'EMPLOYEE'; // verifier / QA are internal principals (delivery metadata only)
    const result = await dispatch({
      jobName: 'email-bgv30-reminder',
      eventType: `bgv30.${target.kind.toLowerCase()}`,
      eventKey: reminderEventKey(target),
      companyId: target.companyId,
      entityType: target.kind === 'INFO_PENDING' ? 'bgv_info_request' : 'bgv_order',
      entityId: target.requestId || target.orderId,
      recipientType,
      recipientReference: target.orderId,
      // REFERENCES ONLY — never tokens, URLs, PII or HTML.
      payload: {
        orderId: target.orderId,
        kind: target.kind,
        checkType: target.checkType || null,
        requestId: target.requestId || null,
        bucket: target.bucket,
      },
    });
    if (result?.queued) report.queued += 1;
    else if (result?.duplicate) report.duplicate += 1;
    else report.failed += 1;
  }
  return report;
};
