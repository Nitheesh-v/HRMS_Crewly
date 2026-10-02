// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — EFFECTIVE-PRESENCE RESOLVER (the ONE backend authority)
//
//  WHY THIS MODULE EXISTS
//    Phase 37 §26: there must be ONE place that decides effective
//    presence. The frontend, the HTTP controller, the socket handler
//    and the team page MUST NOT invent their own precedence. Every
//    Phase 37 surface that displays or persists a presence call flows
//    through this file.
//
//  THE INITIAL PRECEDENCE (Phase 37.1)
//    37.1 has NO realtime signal and NO Leave / Shift derived inputs.
//    The resolver is honest about that: it returns `unknown` (never
//    Offline — §20 / Phase 37 §20), and `livePresenceAvailable: false`.
//
//    Effective presence rule for 37.1:
//
//        manual DND or Busy or Available, not expired -> that value
//        no manual, no live                               -> unknown
//
//    Higher precedence layers (Leave, shift / working-hours) will be
//    added by 37.6 and 37.4 WITHOUT touching the call sites. Each
//    later unit adds ONE input to this module, and the precedence order
//    stays in this file.
//
//  THE MONEY RULE / PRIVACY RULE
//    Presence is not attendance (§3). WFH is not leave (§15). The
//    resolver never calls Attendance / Leave / Payroll / Shift — those
//    are imports the resolver deliberately does not contain. Pinned by
//    a source-grep test (test/presenceFoundation.test.js §3.4–3.5).
//
//  THE OUTPUT SHAPE (Phase 37 §16 + §20)
//    The snapshot is frozen, ISO-8601 date strings, never Mongo
//    ObjectIds. Frontend renders directly from it. Data minimisation:
//    the consumer sees presence and config — nothing else from the User
//    document, no PII, no salary, no leave reason.
// ═══════════════════════════════════════════════════════════════════════════

import { PRESENCE_MANUAL_VALUES } from './presenceConfig.js';

const toIsoOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
};

const isExpired = (expiry, now) => {
  if (!expiry) return false;
  const exp = expiry instanceof Date ? expiry : new Date(expiry);
  if (Number.isNaN(exp.getTime())) return true;
  return exp.getTime() <= now.getTime();
};

/**
 * Resolve effective presence from one user's durable prefs and the tenant
 * config.
 *
 * @param {Object} args
 * @param {Object} args.durable — the UserPresence document (or in-memory
 *                                object with the same shape, possibly null)
 * @param {Object} args.config  — frozen tenant-config snapshot
 * @param {Date}   [args.now]   — testable clock
 * @returns {Object} the frozen normalised presence snapshot
 */
export const resolvePresence = ({ durable, config, now } = {}) => {
  const nowDate = now instanceof Date ? now : new Date();
  const cfg = config || {};
  const d = durable || {};

  const manualStatus = PRESENCE_MANUAL_VALUES.includes(d.manualStatus)
    ? d.manualStatus
    : null;

  const manualStatusActive =
    manualStatus && !isExpired(d.manualStatusExpiresAt, nowDate);

  const statusMessage = (() => {
    if (!cfg.statusMessagesEnabled) return '';
    if (typeof d.statusMessage !== 'string') return '';
    if (isExpired(d.statusMessageExpiresAt, nowDate)) return '';
    return d.statusMessage;
  })();

  const workLocation = (() => {
    if (!cfg.workLocationEnabled) return null;
    if (typeof d.workLocation !== 'string') return null;
    if (isExpired(d.workLocationExpiresAt, nowDate)) return null;
    // The policy allowlist is the final say. A row written before the
    // tenant narrowed its allowed list should not surface a value the
    // tenant now refuses.
    const allowed = Array.isArray(cfg.allowedWorkLocations)
      ? cfg.allowedWorkLocations
      : [];
    if (!allowed.includes(d.workLocation)) return null;
    return d.workLocation;
  })();

  // The effective manual value (the precedence layer below 37.6 / 37.4).
  const effectiveManual = manualStatusActive ? manualStatus : null;

  let presence;
  let presenceSource;

  if (effectiveManual) {
    presence = effectiveManual;
    presenceSource = 'manual';
  } else {
    // 37.1 has no live presence. Phase 37 §20: do NOT lie that the
    // employee is Offline just because we can't see them. Unknown is the
    // honest answer; the UI surfaces "Presence unavailable" instead.
    presence = 'unknown';
    presenceSource = 'none';
  }

  // Employee-safe config slice — the four flags the self-UI needs.
  const configSlice = Object.freeze({
    enabled: cfg.enabled !== false,
    statusMessagesEnabled: cfg.statusMessagesEnabled !== false,
    workLocationEnabled: cfg.workLocationEnabled !== false,
    wfhMode:
      typeof cfg.wfhMode === 'string' ? cfg.wfhMode : 'self_declare',
    allowedWorkLocations: Array.isArray(cfg.allowedWorkLocations)
      ? [...cfg.allowedWorkLocations]
      : [],
  });

  return Object.freeze({
    presence,
    presenceSource,
    manualStatus: effectiveManual,
    manualStatusExpiresAt: toIsoOrNull(d.manualStatusExpiresAt),
    statusMessage,
    statusMessageExpiresAt: toIsoOrNull(d.statusMessageExpiresAt),
    statusMessageEnabled: configSlice.statusMessagesEnabled,
    workLocation,
    workLocationExpiresAt: toIsoOrNull(d.workLocationExpiresAt),
    workLocationEnabled: configSlice.workLocationEnabled,
    allowedWorkLocations: configSlice.allowedWorkLocations,
    wfhMode: configSlice.wfhMode,
    // 37.1 has no live presence. The UI MUST render this honestly. Do not
    // add "Offline" here — Phase 37 §20 / §6.
    livePresenceAvailable: false,
    config: configSlice,
  });
};

export const __test__ = { isExpired, toIsoOrNull };