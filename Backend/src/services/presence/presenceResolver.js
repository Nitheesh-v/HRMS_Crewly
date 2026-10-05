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
 * Resolve effective presence from one user's durable prefs, the tenant
 * config, and the (optional) ephemeral live snapshot.
 *
 * PRECEDENCE (37.4 — top wins)
 *   1. Manual DND / Busy / Available  (durable, not expired)
 *   2. Connected + recent activity    -> 'available'  (liveSource = 'automatic')
 *   3. Connected + recent inactivity  -> 'away'       (liveSource = 'automatic')
 *   4. Connected + no recent signal   -> 'available'  (recent connect counts)
 *   5. No connection                  -> 'offline'    (liveSource = 'automatic')
 *   6. Infrastructure uncertain (live === null) -> 'unknown' (liveSource = 'none')
 *
 * @param {Object} args
 * @param {Object} args.durable — the UserPresence document (or in-memory
 *                                object with the same shape, possibly null)
 * @param {Object} args.config  — frozen tenant-config snapshot
 * @param {Date}   [args.now]   — testable clock
 * @param {Object|null} [args.live] — Phase 37.4 ephemeral snapshot:
 *                                    {connected, connectionCount,
 *                                     lastHeartbeatAt, lastActivityAt}.
 *                                    When `null` the resolver behaves
 *                                    exactly like 37.1 (presence is
 *                                    `unknown` if no manual status is
 *                                    set; livePresenceAvailable = false).
 *                                    When a snapshot is provided, the
 *                                    resolver applies the precedence
 *                                    above and sets
 *                                    livePresenceAvailable = true.
 * @param {Object|null} [args.hrContext] — Phase 37.6 read-only HR
 *                                    context. Shape:
 *                                      {
 *                                        onLeave: true | false | null,
 *                                        outsideWorkingHours: true | false | null,
 *                                        workingHoursSource: string|null,
 *                                        workingHoursPhase: 'IN_WINDOW' | 'UPCOMING' | 'ENDED' | null,
 *                                        workingHoursIsWorkingDay: boolean|null,
 *                                        leaveReadFailed?: boolean,
 *                                        scheduleReadFailed?: boolean,
 *                                      }
 *                                    `null` is treated as "HR context
 *                                    unavailable" — the resolver
 *                                    behaves exactly like 37.4.
 *                                    `onLeave: true` is the
 *                                    HIGHEST precedence layer (above
 *                                    manual, above live).
 * @returns {Object} the frozen normalised presence snapshot
 */
export const resolvePresence = ({
  durable,
  config,
  now,
  live = null,
  hrContext = null,
} = {}) => {
  const nowDate = now instanceof Date ? now : new Date();
  const cfg = config || {};
  const d = durable || {};

  // 37.6 — read the HR context. Default to a fully-unknown object so
  // existing call sites that do not pass one keep behaving exactly
  // like 37.4.
  const hr = hrContext || {};
  const onLeave = hr.onLeave === true;
  const leaveReadFailed = hr.leaveReadFailed === true;
  const scheduleReadFailed = hr.scheduleReadFailed === true;

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

  // The effective manual value (the precedence layer above 37.4 automatic).
  const effectiveManual = manualStatusActive ? manualStatus : null;

  let presence;
  let presenceSource;
  let livePresenceAvailable;

  if (onLeave) {
    // 37.6 — APPROVED ACTIVE leave is the highest-precedence
    // presentation layer (spec §8, §20). Even a manual DND set
    // before the leave started does not override the workforce
    // fact that the employee is on approved leave today.
    // `livePresenceAvailable` is still carried so the chrome dot
    // can hint at technical liveness separately (37.4 honesty).
    presence = 'on_leave';
    presenceSource = 'leave';
    livePresenceAvailable = live !== null && live !== undefined;
  } else if (effectiveManual) {
    // Manual ALWAYS wins. Even if the live signal says the user is
    // online, the user explicitly said "Busy until 3 PM" — surface that.
    presence = effectiveManual;
    presenceSource = 'manual';
    // 37.4 honesty: live IS available (we read Redis), but the manual
    // value is the displayed answer. The widget shows the manual value
    // and a small "online" dot in the chrome (see 37.2 widget).
    livePresenceAvailable = live !== null && live !== undefined;
  } else if (live === null || live === undefined) {
    // 37.1 behaviour preserved: no live source at all (Redis down, or
    // 37.1 call sites that never wired live). Phase 37 §20: do NOT lie
    // that the employee is Offline just because we can't see them.
    presence = 'unknown';
    presenceSource = 'none';
    livePresenceAvailable = false;
  } else {
    // Live present, no manual. Run the 37.4 precedence:
    //   connected + recent activity  -> available
    //   connected + recent inactivity past awayAfterMinutes -> away
    //   connected + heartbeat older than offlineAfterMinutes -> offline
    //   no connection (count == 0) -> offline
    const derived = deriveAutomaticPresence({ live, config: cfg, now: nowDate });
    presence = derived;
    presenceSource = 'automatic';
    livePresenceAvailable = true;
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

  // 37.6 — Outside Working Hours is an additional flag. It rides
  // alongside presence and NEVER replaces it (spec §13). A `null`
  // value here means the schedule read failed and the value is
  // genuinely unknown — distinct from `false` ("within shift,
  // definitely") and `true` ("outside, definitely").
  let outsideWorkingHours = null;
  if (hr.outsideWorkingHours === true) outsideWorkingHours = true;
  else if (hr.outsideWorkingHours === false) outsideWorkingHours = false;

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
    // 37.1: false. 37.4: true when the live source was readable.
    livePresenceAvailable,
    config: configSlice,
    // 37.6 — the two new authoritative facts. `onLeave` is
    // `null` when the read failed; the frontend treats `null`
    // as "not currently reportable" and renders neither pill.
    onLeave: onLeave ? true : leaveReadFailed ? null : false,
    outsideWorkingHours,
    // Optional context — only carries the source / phase when the
    // read succeeded. Never carries employee name, salary, leave
    // type, or any other PII.
    workingHoursSource:
      hr.workingHoursSource != null ? String(hr.workingHoursSource) : null,
    workingHoursPhase:
      hr.workingHoursPhase != null ? String(hr.workingHoursPhase) : null,
    workingHoursIsWorkingDay:
      hr.workingHoursIsWorkingDay === true
        ? true
        : hr.workingHoursIsWorkingDay === false
        ? false
        : null,
  });
};

/**
 * 37.4 — derive the AUTOMATIC presence value from one live snapshot +
 * tenant config + clock. Pure, no I/O. Kept in this file so the
 * precedence lives next to the resolver output it produces.
 */
const deriveAutomaticPresence = ({ live, config, now }) => {
  const connected = Boolean(live?.connected) || Number(live?.connectionCount || 0) > 0;

  if (!connected) {
    return 'offline';
  }

  const awayAfterMinutes = Number.isInteger(config?.awayAfterMinutes)
    ? config.awayAfterMinutes
    : 5;
  const offlineAfterMinutes = Number.isInteger(config?.offlineAfterMinutes)
    ? config.offlineAfterMinutes
    : 15;

  const lastHb = live?.lastHeartbeatAt ? new Date(live.lastHeartbeatAt) : null;
  const lastAct = live?.lastActivityAt ? new Date(live.lastActivityAt) : null;

  // 1) Heartbeat older than offline threshold OR no heartbeat at all
  //    but never connected => Offline.
  if (lastHb && !Number.isNaN(lastHb.getTime())) {
    const ageMs = now.getTime() - lastHb.getTime();
    if (ageMs > offlineAfterMinutes * 60_000) {
      return 'offline';
    }
  }

  // 2) Activity freshness drives Available / Away.
  if (lastAct && !Number.isNaN(lastAct.getTime())) {
    const ageMs = now.getTime() - lastAct.getTime();
    if (ageMs <= awayAfterMinutes * 60_000) {
      return 'available';
    }
    return 'away';
  }

  // 3) No activity recorded yet but the connection is fresh
  //    (heartbeat exists, was within offline window) => Available.
  return 'available';
};

export const __test__ = { isExpired, toIsoOrNull, deriveAutomaticPresence };