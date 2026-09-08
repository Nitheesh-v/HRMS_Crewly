// Phase 30.10 — INTERNAL BGV QA REVIEW & FINAL REPORT RELEASE (pure rules).
//
// Deliberately pure (no Mongo/Redis imports) so the QA/readiness/consolidation
// semantics are hermetically testable and reused by the QA/report service.
//
// Product semantics:
//  - A verifier conclusion is an INTERNAL finding. It becomes customer-facing
//    only after QA approval + explicit report release (separation of duties).
//  - QA decides APPROVE / RETURN_FOR_CORRECTION. QA NEVER decides
//    HIRE / REJECT — those remain tenant HR decisions.
//  - Consolidated outcomes reuse the Phase 27.15 enum verbatim
//    (CLEAR / CLEAR_WITH_DISCREPANCIES / HOLD). No REJECTED concept exists.
//  - The final report is an IMMUTABLE snapshot; later source mutations never
//    rewrite a generated report (versioning + reissue instead).

// ── QA lifecycle ──────────────────────────────────────────────────
export const QA_STATUSES = ['PENDING', 'APPROVED', 'RETURNED'];

export const QA_RETURN_REASON_MIN = 10;
export const QA_RETURN_REASON_MAX = 500;

// A check is QA-reviewable only when the verifier has submitted findings and
// QA has not already approved them. QA_RETURNED work is visible to the
// current verifier for correction, and re-enters the queue on resubmission.
export const isQaReviewable = ({ state, qaStatus }) =>
  state === 'SUBMITTED' && (qaStatus === 'PENDING' || qaStatus == null);

export const isQaApproved = ({ state, qaStatus }) =>
  state === 'SUBMITTED' && qaStatus === 'APPROVED';

// ── consolidated outcome (Phase 27.15 semantics reused verbatim) ──
export const BGV_REPORT_OUTCOMES = ['CLEAR', 'CLEAR_WITH_DISCREPANCIES', 'HOLD'];

// Conservative deterministic mapping from APPROVED check conclusions only.
//  - any UNABLE_TO_VERIFY / INCONCLUSIVE approved finding → HOLD (human attention)
//  - else any VERIFIED_WITH_DISCREPANCY                    → CLEAR_WITH_DISCREPANCIES
//  - else all VERIFIED                                     → CLEAR
// NEVER produces a candidate rejection — Crewly reports; HR decides.
export const computeOverallOutcome = (approvedConclusions = []) => {
  const values = approvedConclusions.map((entry) => String(entry).toUpperCase());
  if (values.length === 0) return null;
  if (values.some((value) => value === 'UNABLE_TO_VERIFY' || value === 'INCONCLUSIVE')) {
    return 'HOLD';
  }
  if (values.some((value) => value === 'VERIFIED_WITH_DISCREPANCY')) {
    return 'CLEAR_WITH_DISCREPANCIES';
  }
  return values.every((value) => value === 'VERIFIED') ? 'CLEAR' : 'HOLD';
};

// ── final report readiness (backend engine) ───────────────────────
// ALL purchased checks must carry a QA-approved submission, and no
// additional-information request may be OPEN (30.9) — a candidate still
// responding means the evidence picture is incomplete.
export const evaluateReportReadiness = ({
  purchasedChecks = [],
  checks = [], // [{ checkType, state, qaStatus }]
  openInfoRequests = 0,
}) => {
  const missing = [];
  for (const checkType of purchasedChecks) {
    const check = checks.find((entry) => entry.checkType === checkType);
    if (!check) {
      missing.push(`${checkType}: no verification submitted`);
      continue;
    }
    if (check.state === 'QA_RETURNED') missing.push(`${checkType}: returned by QA`);
    else if (!isQaApproved(check)) missing.push(`${checkType}: awaiting QA approval`);
  }
  if (openInfoRequests > 0) {
    missing.push(`additional information: ${openInfoRequests} open request(s) awaiting candidate`);
  }
  return { ready: missing.length === 0, missing };
};

// ── report content safety ─────────────────────────────────────────
// What a tenant-facing report may carry. Everything else (QA discussion,
// verifier drafts, tokens, payment data, raw identifiers) is excluded by
// construction — the snapshot builder only receives these fields.
export const REPORT_CHECK_FIELDS = [
  'checkType',
  'conclusion',
  'revision',
  'methods',
  'discrepancies',
  'completionNote',
  'completedAt',
];

// DigiLocker honesty (30.8 method → report wording). Phase 30 never
// implements the DigiLocker API, so the report may only describe the
// manual / issuer-assisted flow that actually occurred.
export const digilockerReportWording = (methods = []) =>
  methods.includes('DIGILOCKER_ISSUER_ASSISTED')
    ? 'DigiLocker / issuer-assisted manual verification'
    : '';

export const methodLabel = (method) => {
  if (method === 'DIGILOCKER_ISSUER_ASSISTED') return 'DigiLocker / issuer-assisted manual verification';
  return String(method || '')
    .toLowerCase()
    .replace(/_/g, ' ');
};

// Tenant-facing disclaimer (report footer).
export const REPORT_DISCLAIMER =
  'This report represents only the checks listed above, verified from the sources available at the time of review. ' +
  'It is provided for information and does not constitute an automatic employment decision; the hiring organization ' +
  'remains responsible for any recruitment decision.';

export const sanitizeQaReturnReason = (reason) => {
  const trimmed = String(reason ?? '').trim();
  if (trimmed.length < QA_RETURN_REASON_MIN) {
    return { ok: false, error: 'A return reason of at least 10 characters is required' };
  }
  return { ok: true, value: trimmed.slice(0, QA_RETURN_REASON_MAX) };
};
