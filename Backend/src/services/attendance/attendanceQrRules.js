// ─────────────────────────────────────────────────────────────
// Phase 31.14 — pure QR challenge rules.
//
// A challenge proves possession of a fresh workplace code, never
// employee identity. Deterministic and side-effect-free: no Mongo,
// no req/res, no Redis. sha256 hashing follows the 31.11 rules
// precedent (deterministic digest, no secrets handled here).
// ─────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

export const QR_PURPOSE = 'ATTENDANCE_PUNCH';

// Frontend SPA route that renders the scan → confirm → punch
// screen. The token travels in the path (POST body on use).
export const QR_PUNCH_PATH = '/app/attendance/qr';

// Five minutes: long enough to scan + confirm, short enough that
// a screenshot dies on its own. Single-use consume kills replays
// inside the window.
export const QR_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const QR_TOKEN_BYTES = 32;

export const QR_USE_REASON = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  WRONG_TENANT: 'WRONG_TENANT',
  WRONG_PURPOSE: 'WRONG_PURPOSE',
  EXPIRED: 'EXPIRED',
  ALREADY_USED: 'ALREADY_USED',
});

export const hashQrToken = (token) => {
  if (typeof token !== 'string' || !token) return '';
  return createHash('sha256').update(token, 'utf8').digest('hex');
};

// Pure eligibility over the re-fetched challenge document.
// nowMs is injected (deterministic tests, no hidden clock).
export const validateChallengeForUse = ({ challenge, companyId, nowMs = Date.now() } = {}) => {
  if (!challenge) return { valid: false, reason: QR_USE_REASON.NOT_FOUND };
  if (String(challenge.companyId || '') !== String(companyId || '')) {
    return { valid: false, reason: QR_USE_REASON.WRONG_TENANT };
  }
  if (challenge.purpose !== QR_PURPOSE) return { valid: false, reason: QR_USE_REASON.WRONG_PURPOSE };
  const expiresMs = challenge.expiresAt instanceof Date ? challenge.expiresAt.getTime() : Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    return { valid: false, reason: QR_USE_REASON.EXPIRED };
  }
  if (challenge.usedAt) return { valid: false, reason: QR_USE_REASON.ALREADY_USED };
  return { valid: true, reason: null };
};

// Frontend SPA path encoded in the QR (client-side route — the
// token never appears in a server access log as a page view; the
// API calls carry it in POST bodies only).
export const buildQrPunchPath = (token) => `/app/attendance/qr/${String(token || '')}`;
