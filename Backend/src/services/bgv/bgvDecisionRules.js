// Phase 30.1 — OPTIONAL BGV DECISION (pure rules).
//
// These rules are deliberately pure (no Mongo/Redis/imports) so the decision
// semantics can be tested hermetically and reused by both the recording
// service and the conversion eligibility engine.
//
// Product semantics:
//  - BGV is OPTIONAL. Tenant HR decides AFTER the human final selection.
//  - PROCEED_WITHOUT_BGV is an HR acknowledgement. It is NOT candidate consent
//    and it must NEVER be displayed/treated as CLEAR / VERIFIED / PASSED.
//  - INITIATE_BGV records the HR intention to use Crewly BGV. Pricing,
//    purchase, consent and verification belong to later Phase 30 sub-phases.
//  - The decision is separate from the recruitment pipeline stage: Phase 30.1
//    never mutates currentStage and never auto-selects/rejects/hires.

// The two explicit HR choices exposed by Phase 30.1.
export const BGV_DECISIONS = ['PROCEED_WITHOUT_BGV', 'INITIATE_BGV'];

// Stored on Candidate.bgvDecision.status once a decision is recorded.
export const BGV_DECISION_NONE = 'NONE';
export const BGV_DECISION_WAIVED = 'PROCEEDED_WITHOUT_BGV';
export const BGV_DECISION_INITIATED = 'BGV_INITIATED';

// Human final selection completes at SELECTED (recordCandidateFinalDecision).
// The BGV decision is only meaningful from that post-selection point onward.
export const POST_SELECTION_STAGES = [
  'SELECTED',
  'OFFER',
  'OFFER_ACCEPTED',
  'PRE_ONBOARDING',
  'JOINED',
];

export const BGV_DECISION_MAX_REASON_LENGTH = 300;

// Map a frontend decision choice to the persisted status.
export const decisionStatusFor = (decision) =>
  decision === 'PROCEED_WITHOUT_BGV'
    ? BGV_DECISION_WAIVED
    : decision === 'INITIATE_BGV'
      ? BGV_DECISION_INITIATED
      : null;

// Optional tenant business reason; trimmed, length-capped, never required.
export const normalizeDecisionReason = (reason) =>
  String(reason ?? '')
    .trim()
    .slice(0, BGV_DECISION_MAX_REASON_LENGTH);

// Eligibility of a decision attempt for a candidate snapshot.
// Returns { allowed: true } or { allowed: false, code, reason }.
export const evaluateDecisionEligibility = ({
  stage,
  decision,
  hasActiveCase = false,
}) => {
  if (!BGV_DECISIONS.includes(decision)) {
    return {
      allowed: false,
      code: 'INVALID_DECISION',
      reason: 'Choose Proceed Without BGV or Initiate BGV',
    };
  }
  if (!POST_SELECTION_STAGES.includes(stage)) {
    return {
      allowed: false,
      code: 'NOT_POST_SELECTION',
      reason:
        'The BGV decision is available only after the human final selection (Selected or later)',
    };
  }
  if (hasActiveCase && decision === 'PROCEED_WITHOUT_BGV') {
    return {
      allowed: false,
      code: 'BGV_ALREADY_STARTED',
      reason:
        'A background verification case is already in progress; it cannot be waived from here',
    };
  }
  if (hasActiveCase && decision === 'INITIATE_BGV') {
    return {
      allowed: false,
      code: 'BGV_CASE_EXISTS',
      reason: 'A background verification case already exists for this candidate',
    };
  }
  return { allowed: true, code: '', reason: '' };
};

// Idempotency / conflict resolution for a repeated or opposite decision.
//  - IDEMPOTENT: the exact same decision is already recorded → return the
//    authoritative state, no duplicate business effects.
//  - CONFLICT: a different decision was recorded → reject (no silent toggle).
//  - RECORD: no decision yet → persist the new one.
export const resolveDecisionOutcome = ({ currentStatus, decision }) => {
  const target = decisionStatusFor(decision);
  const current = currentStatus || BGV_DECISION_NONE;
  if (current === target) return { kind: 'IDEMPOTENT' };
  if (current !== BGV_DECISION_NONE) return { kind: 'CONFLICT' };
  return { kind: 'RECORD' };
};

// What the UI should show for a persisted decision. Keeps the "never cleared"
// semantics in one place so no screen can invent a clearance.
export const decisionDisplay = (decisionSnapshot = {}) => {
  const status = decisionSnapshot?.status || BGV_DECISION_NONE;
  if (status === BGV_DECISION_WAIVED) {
    return {
      label: 'BGV Not Requested',
      cleared: false,
      note: 'HR chose to proceed without Crewly BGV. The candidate has NOT been BGV cleared.',
    };
  }
  if (status === BGV_DECISION_INITIATED) {
    return {
      label: 'BGV Requested',
      cleared: false,
      note: 'HR initiated Crewly BGV. Check selection and purchase follow in the next product step.',
    };
  }
  return { label: 'No BGV decision yet', cleared: false, note: '' };
};

// Conversion-gate composition used by evaluateBgvForConversion (27.13/27.15).
// Mirrors the Phase 27.15 branches EXACTLY and adds one explicit per-candidate
// waiver:
//  - settings off                  → not required (unchanged).
//  - required + no case + waiver   → satisfied via audited HR acknowledgement.
//  - required + no case, no waiver → blocking (unchanged).
//  - required + active case        → existing case rules (unchanged; a waiver
//    never overrides an in-progress or unfavourable case).
export const composeConversionBgvEligibility = ({
  settings,
  caseRecord,
  decisionStatus = BGV_DECISION_NONE,
}) => {
  if (!settings?.enabled || !settings?.bgvRequiredBeforeConversion) {
    return {
      required: false,
      satisfied: true,
      waived: false,
      blockingReasons: [],
      caseSummary: null,
    };
  }

  if (!caseRecord) {
    if (decisionStatus === BGV_DECISION_WAIVED) {
      return {
        required: true,
        satisfied: true,
        waived: true,
        blockingReasons: [],
        caseSummary: null,
      };
    }
    return {
      required: true,
      satisfied: false,
      waived: false,
      blockingReasons: ['Background verification is required before conversion'],
      caseSummary: null,
    };
  }

  const caseSummary = {
    id: caseRecord._id,
    caseCode: caseRecord.caseCode,
    status: caseRecord.status,
    overallOutcome: caseRecord.overallOutcome || '',
  };

  if (caseRecord.status !== 'COMPLETED') {
    return {
      required: true,
      satisfied: false,
      waived: false,
      blockingReasons: [
        `Background verification case ${caseRecord.caseCode} is ${caseRecord.status}`,
      ],
      caseSummary,
    };
  }

  if (!['CLEAR', 'CLEAR_WITH_DISCREPANCIES'].includes(caseRecord.overallOutcome)) {
    return {
      required: true,
      satisfied: false,
      waived: false,
      blockingReasons: [
        `Background verification outcome ${caseRecord.overallOutcome || 'unknown'} blocks conversion`,
      ],
      caseSummary,
    };
  }

  return {
    required: true,
    satisfied: true,
    waived: false,
    blockingReasons: [],
    caseSummary: {
      id: caseRecord._id,
      caseCode: caseRecord.caseCode,
      status: caseRecord.status,
      overallOutcome: caseRecord.overallOutcome,
    },
  };
};
