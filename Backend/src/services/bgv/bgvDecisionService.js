// Phase 30.1 — OPTIONAL BGV DECISION service.
//
// Records the tenant HR decision made after the human final selection:
//   PROCEED_WITHOUT_BGV  -> Candidate.bgvDecision.status = PROCEEDED_WITHOUT_BGV
//   INITIATE_BGV         -> Candidate.bgvDecision.status = BGV_INITIATED
//
// Security invariants:
//   - Tenant authority comes ONLY from companyId (req.companyId); the candidate
//     is loaded with { _id|candidateCode, companyId } so a cross-tenant id is a
//     clean 404 with no existence leak.
//   - Actor comes from the authenticated request context, never the body.
//   - The decision NEVER touches candidate.currentStage (pipeline stays owned
//     by transitionCandidateStage) and NEVER implies CLEAR/VERIFIED/PASSED.
//   - Idempotent for an identical repeated decision; a conflicting opposite
//     decision is rejected (no silent toggle).
//
// All Mongo/audit/history collaborators are injectable (deps) so the suite can
// run hermetically without a database, matching the repository test pattern.

import mongoose from 'mongoose';
import Candidate from '../../models/Candidate.js';
import CandidateHistory from '../../models/CandidateHistory.js';
import BackgroundVerificationCase from '../../models/BackgroundVerificationCase.js';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  BGV_DECISION_NONE,
  decisionStatusFor,
  evaluateDecisionEligibility,
  normalizeDecisionReason,
  resolveDecisionOutcome,
} from './bgvDecisionRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);

// Small DTO so responses/UI never see raw Mongoose docs.
const decisionDto = (bgvDecision) => ({
  status: bgvDecision?.status || BGV_DECISION_NONE,
  decidedBy: bgvDecision?.decidedBy || null,
  decidedAt: bgvDecision?.decidedAt || null,
  reason: bgvDecision?.reason || '',
});

// ── default (Mongo) collaborators ────────────────────────────────
const defaultLoadCandidate = async ({ companyId, candidateRef }) => {
  const filter = isObjectId(candidateRef)
    ? { _id: candidateRef, companyId }
    : { companyId, candidateCode: String(candidateRef || '').trim().toUpperCase() };
  return Candidate.findOne(filter).lean();
};

const defaultLoadActiveCase = async ({ companyId, candidateId }) =>
  BackgroundVerificationCase.findOne({
    companyId,
    candidate: candidateId,
    activeKey: 'ACTIVE',
  })
    .select('+activeKey')
    .lean();

// Atomic NONE -> target claim; guards duplicate clicks / retries.
const defaultClaimDecision = async ({
  companyId,
  candidateId,
  target,
  actorId,
  decidedAt,
  reason,
}) =>
  Candidate.findOneAndUpdate(
    { _id: candidateId, companyId, 'bgvDecision.status': BGV_DECISION_NONE },
    {
      $set: {
        'bgvDecision.status': target,
        'bgvDecision.decidedBy': actorId ?? null,
        'bgvDecision.decidedAt': decidedAt,
        'bgvDecision.reason': reason,
      },
    },
    { new: true }
  ).lean();

const defaultReloadCandidate = async ({ companyId, candidateId }) =>
  Candidate.findOne({ _id: candidateId, companyId }).lean();

const defaultWriteHistory = (entry) => CandidateHistory.create(entry);
const defaultAudit = (entry) => recordAudit(entry);

// ── record the decision ──────────────────────────────────────────
export const recordBgvDecision = async ({
  companyId,
  candidateRef,
  actorId,
  decision,
  reason = '',
  requestContext = null,
  deps = {},
}) => {
  const loadCandidate = deps.loadCandidate || defaultLoadCandidate;
  const loadActiveCase = deps.loadActiveCase || defaultLoadActiveCase;
  const claimDecision = deps.claimDecision || defaultClaimDecision;
  const reloadCandidate = deps.reloadCandidate || defaultReloadCandidate;
  const writeHistory = deps.writeHistory || defaultWriteHistory;
  const audit = deps.audit || defaultAudit;

  // DB Logic - tenant-scoped load; other-tenant refs 404 (no existence leak).
  const candidate = await loadCandidate({ companyId, candidateRef });
  if (!candidate) throw ApiError.notFound('Candidate not found');

  const activeCase = await loadActiveCase({ companyId, candidateId: candidate._id });

  // Rule gate: post-selection stage + no competing active case.
  const stage = candidate.currentStage || candidate.stage;
  const eligibility = evaluateDecisionEligibility({
    stage,
    decision,
    hasActiveCase: Boolean(activeCase),
  });
  if (!eligibility.allowed) {
    throw eligibility.code === 'INVALID_DECISION'
      ? ApiError.badRequest(eligibility.reason)
      : ApiError.conflict(eligibility.reason);
  }

  // Idempotency / conflict resolution on the current stored state.
  const currentStatus = candidate.bgvDecision?.status || BGV_DECISION_NONE;
  const outcome = resolveDecisionOutcome({ currentStatus, decision });

  if (outcome.kind === 'IDEMPOTENT') {
    return {
      idempotent: true,
      changed: false,
      candidateId: candidate._id,
      decision: decisionDto(candidate.bgvDecision),
    };
  }
  if (outcome.kind === 'CONFLICT') {
    throw ApiError.conflict(
      'A different BGV decision is already recorded for this candidate'
    );
  }

  // Persist via atomic claim (NONE -> target). Loser of a duplicate race
  // resolves to idempotent or conflict from the authoritative state.
  const target = decisionStatusFor(decision);
  const decidedAt = new Date();
  const safeReason = normalizeDecisionReason(reason);
  const claimed = await claimDecision({
    companyId,
    candidateId: candidate._id,
    target,
    actorId,
    decidedAt,
    reason: safeReason,
  });

  if (!claimed) {
    const reloaded = await reloadCandidate({ companyId, candidateId: candidate._id });
    const reStatus = reloaded?.bgvDecision?.status || BGV_DECISION_NONE;
    if (reStatus === target) {
      return {
        idempotent: true,
        changed: false,
        candidateId: reloaded._id,
        decision: decisionDto(reloaded.bgvDecision),
      };
    }
    throw ApiError.conflict(
      'A different BGV decision is already recorded for this candidate'
    );
  }

  // Timeline event (immutable append-only), best-effort like other BGV writes.
  const historyAction =
    decision === 'PROCEED_WITHOUT_BGV' ? 'BGV_DECISION_WAIVED' : 'BGV_DECISION_INITIATED';
  await writeHistory({
    companyId,
    candidate: candidate._id,
    job: candidate.job,
    action: historyAction,
    source: 'BGV_DECISION',
    actorType: 'TENANT_USER',
    actor: actorId ?? null,
    metadata: { decision, reason: safeReason },
    eventAt: decidedAt,
  }).catch(() => {});

  // Audit the successful business decision (no sensitive values).
  await audit({
    req: requestContext,
    action: historyAction,
    companyId,
    actorId,
    resource: 'Candidate',
    resourceId: candidate._id,
    previousValue: { bgvDecision: BGV_DECISION_NONE },
    newValue: { bgvDecision: target, reason: safeReason },
    metadata: { decision, phase: '30.1' },
  }).catch(() => {});

  return {
    idempotent: false,
    changed: true,
    candidateId: candidate._id,
    decision: decisionDto(claimed.bgvDecision),
  };
};
