// Phase 30.4 — CANDIDATE BGV CONSENT (pure rules).
//
// Three different decisions stay separate:
//   A. 30.1 HR WITHOUT-BGV acknowledgement      (Candidate.bgvDecision)
//   B. 30.3 tenant commercial authorization     (BgvOrder.status === 'PAID')
//   C. 30.4 CANDIDATE consent                   (this module)
// Payment != consent. Opening the email/portal != consent. Only an explicit
// candidate POST records a decision; GET is decision-free (scanner-safe).

import crypto from 'crypto';

// Consent wording version. If the wording changes later, bump this — historical
// consents keep the version they accepted.
export const CONSENT_POLICY_VERSION = '30.4.1';

export const BGV_CONSENT_PURPOSE = 'BGV_CANDIDATE_CONSENT';

// Human-readable consent statement shown in the public portal and hashed into
// every recorded decision so provenance is provable.
export const CONSENT_STATEMENT_TEXT = [
  'I understand that the requesting organisation has engaged Crewly to coordinate a background verification for my candidature.',
  'I understand which verification checks are included, and that verification activities only begin after I give this consent.',
  'I understand that I may decline, and that declining is recorded as a consent decision — it is not a verification failure and does not by itself determine the recruitment outcome.',
  'I understand that information I later provide for verification will be processed only for verification purposes, retained only as long as required, and handled under Crewly privacy and data-protection practices.',
  'I consent to the background verification checks listed below being initiated for my candidature.',
].join(' ');

export const consentStatementHash = (text = CONSENT_STATEMENT_TEXT) =>
  crypto.createHash('sha256').update(String(text)).digest('hex');

// Token lifetime follows the established project style: env-overridable with
// a production-safe default and bounds (offer tokens use the same shape).
export const BGV_CONSENT_TOKEN_MAX_DAYS = Math.min(
  30,
  Math.max(1, Number(process.env.BGV_CONSENT_TOKEN_MAX_DAYS) || 7)
);

// HR-facing consent visibility states (derived, never stored twice).
export const BGV_CONSENT_STATES = [
  'NONE', // no invitation ever issued
  'INVITATION_SENT', // active unexpired token, no candidate decision yet
  'INVITATION_EXPIRED', // latest token expired without a decision
  'INVITATION_REVOKED', // latest token revoked without a decision
  'INVITATION_FAILED', // latest delivery failed; order stays authorized
  'CONSENTED',
  'CONSENT_DECLINED',
];

export const deriveConsentState = ({ token }) => {
  if (!token) return 'NONE';
  if (token.finalDecision === 'CONSENTED') return 'CONSENTED';
  if (token.finalDecision === 'DECLINED') return 'CONSENT_DECLINED';
  if (token.revokedAt) {
    return token.revokedReason === 'DELIVERY_FAILED'
      ? 'INVITATION_FAILED'
      : 'INVITATION_REVOKED';
  }
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    return 'INVITATION_EXPIRED';
  }
  return 'INVITATION_SENT';
};

// Decision transition rules: repeats are idempotent replays; opposites are
// terminal conflicts (no silent re-consent in 30.4).
export const evaluateConsentDecision = ({ current, requested }) => {
  if (current === requested) {
    return { allowed: true, idempotent: true, code: '' };
  }
  if (current === null) {
    return { allowed: true, idempotent: false, code: '' };
  }
  return {
    allowed: false,
    idempotent: false,
    code: 'DECISION_CONFLICT',
  };
};

export const isTerminalConsent = (decision) =>
  decision === 'CONSENTED' || decision === 'DECLINED';
