// Phase 30.11 — BGV OPERATIONAL SLA (pure rules).
//
// Deliberately pure (no Mongo/Redis) so SLA math is hermetically testable.
//
// Authoritative clock rule (documented business policy):
//   A check's SLA clock starts when Crewly can first act on it:
//     clockStart = max(collectionCase.submittedAt, assignment.assignedAt)
//   i.e. commercially authorized + consented + candidate-submitted, and an
//   assignment exists. Unassigned work is tracked by its own waiting age
//   (submittedAt) and an optional unassignedTargetHours — it never pretends
//   a verifier SLA is running.
//
// Pause rule:
//   Candidate-wait intervals (Phase 30.9 additional-information requests:
//   requestedAt → respondedAt/cancelledAt/resolvedAt) are EXCLUDED from
//   accountable time when pauseOnCandidateWait is enabled. Third-party
//   waiting (AWAITING_THIRD_PARTY) does NOT pause by default — that policy
//   choice is explicit here rather than hidden.
//
// No countdowns are stored; everything is derived deterministically from
// authoritative timestamps + configuration at read time.

export const SLA_CHECK_TYPES = ['IDENTITY', 'ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'REFERENCE'];

export const SLA_STATUSES = [
  'ON_TRACK',
  'DUE_SOON',
  'OVERDUE',
  'PAUSED',
  'COMPLETED',
  'SLA_NOT_CONFIGURED',
];

export const SLA_LIMITS = { minHours: 1, maxHours: 24 * 30, maxDueSoonHours: 24 * 7 };

const ms = (value) => {
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? null : time;
};

// Validate one configured target entry. Returns { ok, value } or { ok:false, error }.
export const validateSlaTarget = (raw) => {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }; // unconfigured
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < SLA_LIMITS.minHours || hours > SLA_LIMITS.maxHours) {
    return { ok: false, error: `SLA target must be a whole number of hours between ${SLA_LIMITS.minHours} and ${SLA_LIMITS.maxHours}` };
  }
  return { ok: true, value: hours };
};

// Validate a full policy update payload (five checks + knobs).
export const validateSlaPolicy = (input = {}) => {
  const targets = {};
  for (const key of Object.keys(input.targets || {})) {
    const upper = String(key).toUpperCase();
    if (!SLA_CHECK_TYPES.includes(upper)) {
      return { ok: false, error: `Unknown check type "${key}" — supported: ${SLA_CHECK_TYPES.join(', ')}` };
    }
    const checked = validateSlaTarget(input.targets[key]);
    if (!checked.ok) return { ok: false, error: `${upper}: ${checked.error}` };
    if (checked.value !== null) targets[upper] = checked.value;
  }
  const dueSoon = validateSlaTarget(input.dueSoonHours === undefined ? null : input.dueSoonHours);
  if (!dueSoon.ok) return { ok: false, error: `dueSoonHours: ${dueSoon.error}` };
  if (dueSoon.value !== null && dueSoon.value > SLA_LIMITS.maxDueSoonHours) {
    return { ok: false, error: `dueSoonHours must be ≤ ${SLA_LIMITS.maxDueSoonHours}` };
  }
  return {
    ok: true,
    value: {
      targets,
      dueSoonHours: dueSoon.value ?? 24,
      pauseOnCandidateWait: input.pauseOnCandidateWait !== false,
      unassignedTargetHours: validateSlaTarget(input.unassignedTargetHours).ok
        ? validateSlaTarget(input.unassignedTargetHours).value
        : null,
    },
  };
};

// Sum non-overlapping paused milliseconds between clockStart and effectiveEnd.
// intervals: [{ startIso, endIso|null }] — an open interval (end null) pauses
// until effectiveEnd.
export const pausedMs = ({ intervals = [], clockStartMs, effectiveEndMs }) => {
  let total = 0;
  for (const interval of intervals) {
    const start = Math.max(ms(interval.startIso) ?? 0, clockStartMs);
    const rawEnd = interval.endIso === null || interval.endIso === undefined ? effectiveEndMs : ms(interval.endIso);
    if (rawEnd === null) continue;
    const end = Math.min(rawEnd, effectiveEndMs);
    if (end > start) total += end - start;
  }
  return total;
};

// Deterministic SLA evaluation for ONE check.
export const evaluateCheckSla = ({
  clockStartIso,
  completedAtIso = null,
  pausedIntervals = [],
  nowIso,
  targetHours = null,
  dueSoonHours = 24,
  currentlyPaused = false,
}) => {
  const start = ms(clockStartIso);
  const now = ms(nowIso);
  if (start === null || now === null) return { status: 'SLA_NOT_CONFIGURED', accountableMs: 0, remainingMs: null };
  if (targetHours === null || targetHours === undefined) {
    return { status: 'SLA_NOT_CONFIGURED', accountableMs: 0, remainingMs: null };
  }
  const completed = ms(completedAtIso);
  const effectiveEnd = completed !== null ? Math.min(completed, now) : now;
  const paused = pausedMs({ intervals: pausedIntervals, clockStartMs: start, effectiveEndMs: effectiveEnd });
  const accountableMs = Math.max(0, effectiveEnd - start - paused);
  const targetMs = targetHours * 3600000;
  const remainingMs = targetMs - accountableMs;

  if (completed !== null) {
    // Completed work stops the clock; it is reported as COMPLETED (late
    // completions remain visible via accountableMs for ops reporting).
    return { status: 'COMPLETED', accountableMs, remainingMs, completedLate: accountableMs > targetMs };
  }
  if (currentlyPaused) {
    return { status: 'PAUSED', accountableMs, remainingMs };
  }
  if (remainingMs <= 0) return { status: 'OVERDUE', accountableMs, remainingMs };
  if (remainingMs <= dueSoonHours * 3600000) return { status: 'DUE_SOON', accountableMs, remainingMs };
  return { status: 'ON_TRACK', accountableMs, remainingMs };
};

// Unassigned waiting indicator (age against optional unassigned target).
export const evaluateUnassignedWait = ({ submittedAtIso, nowIso, unassignedTargetHours = null }) => {
  const start = ms(submittedAtIso);
  const now = ms(nowIso);
  if (start === null || now === null) return { status: 'SLA_NOT_CONFIGURED', waitingMs: 0 };
  const waitingMs = Math.max(0, now - start);
  if (unassignedTargetHours === null) return { status: 'SLA_NOT_CONFIGURED', waitingMs };
  if (waitingMs > unassignedTargetHours * 3600000) return { status: 'OVERDUE', waitingMs };
  return { status: 'ON_TRACK', waitingMs };
};

// Human-safe duration label helper (frontend may use; no timers required).
export const durationLabel = (millis) => {
  const value = Math.max(0, Number(millis) || 0);
  const hours = Math.floor(value / 3600000);
  if (hours < 1) return `${Math.floor(value / 60000)}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};
