// Phase 30.6 — BGV verifier account rules (pure, no I/O).

import { BGV_VERIFIER_SPECIALIZATIONS } from '../../models/BgvVerifier.js';

export const SETUP_TOKEN_HOURS = 72; // 3 days to complete account setup
export const RESET_TOKEN_MINUTES = 30;
export const OTP_MINUTES = 10;

export const isAllowedSpecializationList = (list) =>
  Array.isArray(list) &&
  list.length >= 1 &&
  [...new Set(list)].length === list.length &&
  list.every((entry) => BGV_VERIFIER_SPECIALIZATIONS.includes(entry));

export const normalizeVerifierEmail = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 160);

export const isValidVerifierEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// Safe projection — never password hashes, tokens, or session ids.
export const sanitizeVerifier = (verifier) =>
  verifier
    ? {
        id: String(verifier._id),
        name: verifier.name,
        email: verifier.email,
        specializations: verifier.specializations || [],
        status: verifier.status,
        twoFactorEnabled: Boolean(verifier.twoFactorEnabled),
        setupCompletedAt: verifier.setupCompletedAt || null,
        lastLoginAt: verifier.lastLoginAt || null,
        deactivatedAt: verifier.deactivatedAt || null,
        createdAt: verifier.createdAt || null,
      }
    : null;

// Generic authentication failure — identical for unknown account, wrong
// password, and deactivated account (account-enumeration resistance).
export const GENERIC_AUTH_FAILURE = 'Invalid email or password';
