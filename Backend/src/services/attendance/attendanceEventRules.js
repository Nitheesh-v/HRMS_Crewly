// ─────────────────────────────────────────────────────────────
// Phase 31.2 — attendance event rules (PURE).
//
// State machine, live-state derivation, timeline ordering and
// duration maths for CLOCK_IN → BREAK_START → BREAK_END → CLOCK_OUT.
//
// Vocabulary (EVENT_TYPE, LIVE_STATE, WORK_MODE, EVENT_SOURCE) is owned
// by Phase 31.1 (attendancePolicyRules.js) and reused verbatim — this
// module defines no competing constants.
//
// No Mongo. No req/res. No Redis. No payroll. No side effects.
// ─────────────────────────────────────────────────────────────
import {
  EVENT_TYPE,
  LIVE_STATE,
  WORK_MODE,
} from './attendancePolicyRules.js';

const MS_PER_MINUTE = 60 * 1000;

const EVENT_TYPES = Object.values(EVENT_TYPE);
const LIVE_STATES = Object.values(LIVE_STATE);
const WORK_MODES = Object.values(WORK_MODE);

// Policy workModes object keys (camelCase) → WORK_MODE vocabulary.
const POLICY_MODE_TO_WORK_MODE = Object.freeze({
  office: WORK_MODE.OFFICE,
  wfh: WORK_MODE.WFH,
  field: WORK_MODE.FIELD,
  clientSite: WORK_MODE.CLIENT_SITE,
  businessTravel: WORK_MODE.BUSINESS_TRAVEL,
});

// ── Transition table ─────────────────────────────────────────
// ON_BREAK + CLOCK_OUT is REJECTED: the break must be ended first.
// No repository evidence justified an atomic "end break + checkout".
const TRANSITIONS = Object.freeze({
  [LIVE_STATE.NOT_IN]: Object.freeze({
    [EVENT_TYPE.CLOCK_IN]: LIVE_STATE.WORKING,
  }),
  [LIVE_STATE.WORKING]: Object.freeze({
    [EVENT_TYPE.BREAK_START]: LIVE_STATE.ON_BREAK,
    [EVENT_TYPE.CLOCK_OUT]: LIVE_STATE.COMPLETED,
  }),
  [LIVE_STATE.ON_BREAK]: Object.freeze({
    [EVENT_TYPE.BREAK_END]: LIVE_STATE.WORKING,
  }),
  [LIVE_STATE.COMPLETED]: Object.freeze({}),
});

// ── Validation primitives ────────────────────────────────────

export const isValidEventType = (type) => EVENT_TYPES.includes(type);

export const isValidLiveState = (state) => LIVE_STATES.includes(state);

export const isValidWorkMode = (mode) => WORK_MODES.includes(mode);

// Which work modes a company allows. With no active policy the only
// safe default is OFFICE — every other mode requires explicit
// enablement in the 31.1 policy, never fail-open.
export const enabledWorkModes = (policy) => {
  if (!policy || typeof policy !== 'object') return [WORK_MODE.OFFICE];
  const flags = policy.workModes || {};
  const modes = Object.entries(POLICY_MODE_TO_WORK_MODE)
    .filter(([key]) => flags[key] === true)
    .map(([, mode]) => mode);
  // 31.1 guarantees office stays enabled; defend anyway.
  if (!modes.includes(WORK_MODE.OFFICE)) modes.unshift(WORK_MODE.OFFICE);
  return modes;
};

export const isWorkModeAllowed = (mode, policy) => {
  if (!isValidWorkMode(mode)) return false;
  return enabledWorkModes(policy).includes(mode);
};

// ── State machine ────────────────────────────────────────────

export const isSessionOpen = (liveState) =>
  liveState === LIVE_STATE.WORKING || liveState === LIVE_STATE.ON_BREAK;

// Backend-derived next actions. The frontend must render these, never
// invent its own state-machine permissions.
export const allowedActions = (liveState) => {
  const row = TRANSITIONS[liveState];
  if (!row) return [];
  return Object.keys(row);
};

// Returns { allowed, next, reason, code } — never throws.
export const transition = (liveState, action) => {
  if (!isValidLiveState(liveState)) {
    return { allowed: false, next: null, reason: 'Unknown attendance state', code: 'UNKNOWN_STATE' };
  }
  if (!isValidEventType(action)) {
    return { allowed: false, next: null, reason: 'Unknown attendance action', code: 'UNKNOWN_ACTION' };
  }
  if (liveState === LIVE_STATE.COMPLETED) {
    return {
      allowed: false,
      next: null,
      reason: 'This attendance session is already completed',
      code: 'SESSION_COMPLETED',
    };
  }
  const next = TRANSITIONS[liveState][action] || null;
  if (!next) {
    return {
      allowed: false,
      next: null,
      reason: invalidTransitionMessage(liveState, action),
      code: 'INVALID_TRANSITION',
    };
  }
  return { allowed: true, next, reason: null, code: null };
};

const invalidTransitionMessage = (liveState, action) => {
  if (liveState === LIVE_STATE.NOT_IN && action === EVENT_TYPE.BREAK_START) {
    return 'Clock in before starting a break';
  }
  if (liveState === LIVE_STATE.NOT_IN && action === EVENT_TYPE.CLOCK_OUT) {
    return 'You have not clocked in yet';
  }
  if (liveState === LIVE_STATE.NOT_IN && action === EVENT_TYPE.BREAK_END) {
    return 'There is no active break to end';
  }
  if (liveState === LIVE_STATE.WORKING && action === EVENT_TYPE.CLOCK_IN) {
    return 'You have already clocked in';
  }
  if (liveState === LIVE_STATE.WORKING && action === EVENT_TYPE.BREAK_END) {
    return 'There is no active break to end';
  }
  if (liveState === LIVE_STATE.ON_BREAK && action === EVENT_TYPE.BREAK_START) {
    return 'A break is already in progress';
  }
  if (liveState === LIVE_STATE.ON_BREAK && action === EVENT_TYPE.CLOCK_OUT) {
    return 'End your break before clocking out';
  }
  if (liveState === LIVE_STATE.ON_BREAK && action === EVENT_TYPE.CLOCK_IN) {
    return 'You have already clocked in';
  }
  return `Cannot ${action} while ${liveState}`;
};

// Derive the live state for a session control record.
// The control record is authoritative once 31.2 owns the session
// (liveState set). Legacy records (liveState null/missing) derive from
// punch facts: punchOut → COMPLETED, punchIn → WORKING, else NOT_IN.
// Adoption never fabricates events — see the service layer.
export const deriveLiveState = (control) => {
  if (!control) return LIVE_STATE.NOT_IN;
  if (isValidLiveState(control.liveState)) return control.liveState;
  if (control.punchOut) return LIVE_STATE.COMPLETED;
  if (control.punchIn) return LIVE_STATE.WORKING;
  return LIVE_STATE.NOT_IN;
};

// ── Timeline ─────────────────────────────────────────────────

const toMs = (value) => {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

// Deterministic total order: sequence first, timestamp as tie-break.
export const orderEvents = (events) =>
  [...(events || [])].sort((a, b) => {
    const seqDelta = Number(a?.seq || 0) - Number(b?.seq || 0);
    if (seqDelta !== 0) return seqDelta;
    return toMs(a?.at) - toMs(b?.at);
  });

const TIMELINE_LABEL = Object.freeze({
  [EVENT_TYPE.CLOCK_IN]: 'Clocked in',
  [EVENT_TYPE.BREAK_START]: 'Break started',
  [EVENT_TYPE.BREAK_END]: 'Break ended',
  [EVENT_TYPE.CLOCK_OUT]: 'Clocked out',
});

export const timelineLabel = (type) => TIMELINE_LABEL[type] || String(type);

// UI-safe timeline rows. Internal ids are caller's choice — the default
// UI renders label/time/mode only.
export const buildTimeline = (events) =>
  orderEvents(events).map((event) => ({
    seq: event.seq,
    type: event.type,
    label: timelineLabel(event.type),
    at: event.at instanceof Date ? event.at.toISOString() : new Date(event.at).toISOString(),
    workMode: event.workMode || null,
    source: event.source || null,
  }));

// ── Durations ────────────────────────────────────────────────
// All segments clamp at zero: skewed/duplicate timestamps can never
// produce negative time. Minute outputs use Math.round to match the
// established scheduleEngine precision for persisted facts.

const segmentize = (events, { sessionOpenedAt = null, horizonMs = null } = {}) => {
  const ordered = orderEvents(events);
  let workMs = 0;
  let breakMs = 0;
  let openWorkStartMs = sessionOpenedAt ? toMs(sessionOpenedAt) : null;
  let openBreakStartMs = null;
  let firstAtMs = sessionOpenedAt ? toMs(sessionOpenedAt) : null;
  let lastClosedAtMs = null;

  for (const event of ordered) {
    const atMs = toMs(event.at);
    if (firstAtMs === null || atMs < firstAtMs) {
      // CLOCK_IN is authoritative for session open; adoption supplies it.
      if (event.type === EVENT_TYPE.CLOCK_IN) firstAtMs = atMs;
    }
    switch (event.type) {
      case EVENT_TYPE.CLOCK_IN:
        firstAtMs = atMs;
        if (openWorkStartMs === null) openWorkStartMs = atMs;
        break;
      case EVENT_TYPE.BREAK_START:
        if (openWorkStartMs !== null) {
          workMs += Math.max(0, atMs - openWorkStartMs);
          openWorkStartMs = null;
        }
        if (openBreakStartMs === null) openBreakStartMs = atMs;
        break;
      case EVENT_TYPE.BREAK_END:
        if (openBreakStartMs !== null) {
          breakMs += Math.max(0, atMs - openBreakStartMs);
          openBreakStartMs = null;
        }
        if (openWorkStartMs === null) openWorkStartMs = atMs;
        break;
      case EVENT_TYPE.CLOCK_OUT:
        if (openWorkStartMs !== null) {
          workMs += Math.max(0, atMs - openWorkStartMs);
          openWorkStartMs = null;
        }
        lastClosedAtMs = atMs;
        break;
      default:
        break;
    }
  }

  // Open intervals run to the horizon (live "so far" figures).
  let openKind = null;
  let openStartedAtMs = null;
  if (openBreakStartMs !== null) {
    openKind = 'BREAK';
    openStartedAtMs = openBreakStartMs;
    if (horizonMs !== null) breakMs += Math.max(0, horizonMs - openBreakStartMs);
  } else if (openWorkStartMs !== null) {
    openKind = 'WORK';
    openStartedAtMs = openWorkStartMs;
    if (horizonMs !== null) workMs += Math.max(0, horizonMs - openWorkStartMs);
  }

  const endMs = lastClosedAtMs !== null ? lastClosedAtMs : horizonMs;
  const spanMs =
    firstAtMs !== null && endMs !== null ? Math.max(0, endMs - firstAtMs) : 0;

  return { workMs, breakMs, spanMs, openKind, openStartedAtMs, firstAtMs, lastClosedAtMs };
};

const roundMinutes = (ms) => Math.max(0, Math.round(ms / MS_PER_MINUTE));

// Persisted-facts derivation: closed segments only, integer minutes.
// `includeBreaks` comes from the 31.1 policy (breaks included vs
// excluded from worked time).
export const deriveClosedDurations = (
  events,
  { sessionOpenedAt = null, sessionClosedAt = null, includeBreaks = false } = {},
) => {
  const horizonMs = sessionClosedAt ? toMs(sessionClosedAt) : null;
  const { workMs, breakMs, spanMs } = segmentize(events, { sessionOpenedAt, horizonMs });
  const breakMinutes = roundMinutes(breakMs);
  const spanMinutes = roundMinutes(spanMs);
  // Worked time stays deterministic from facts: with excluded breaks it
  // equals span minus breaks; with included breaks it equals the span.
  const workedMinutes = includeBreaks
    ? spanMinutes
    : Math.max(0, spanMinutes - breakMinutes);
  void workMs;
  return { spanMinutes, breakMinutes, workedMinutes };
};

// Live derivation: closed totals plus the open interval (if any) for
// client-side ticking. Seconds are computed, never persisted.
export const deriveLiveDurations = (
  events,
  { now = new Date(), sessionOpenedAt = null, includeBreaks = false } = {},
) => {
  const nowMs = toMs(now);
  const { workMs, breakMs, spanMs, openKind, openStartedAtMs } = segmentize(events, {
    sessionOpenedAt,
    horizonMs: nowMs,
  });
  const breakMinutes = roundMinutes(breakMs);
  const spanMinutes = roundMinutes(spanMs);
  const workedMinutes = includeBreaks ? spanMinutes : Math.max(0, spanMinutes - breakMinutes);
  const openInterval = openKind
    ? {
        kind: openKind,
        startedAt: new Date(openStartedAtMs).toISOString(),
        elapsedSeconds: Math.max(0, Math.floor((nowMs - openStartedAtMs) / 1000)),
      }
    : null;
  return {
    spanMinutes,
    breakMinutes,
    workedMinutes,
    workedSecondsSoFar: Math.max(0, Math.floor(workMs / 1000)),
    breakSecondsSoFar: Math.max(0, Math.floor(breakMs / 1000)),
    openInterval,
  };
};

// Worked-minutes selector shared by the service: policy treatment when
// a policy is active, legacy fixed-deduction otherwise. Pure maths.
export const applyBreakTreatment = ({ spanMinutes, actualBreakMinutes, includeBreaks }) =>
  includeBreaks
    ? Math.max(0, spanMinutes)
    : Math.max(0, spanMinutes - actualBreakMinutes);
