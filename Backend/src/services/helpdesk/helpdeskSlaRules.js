import { DateTime, IANAZone } from 'luxon';
import { DAY_KEYS } from '../../utils/scheduleEngine.js';
import { HELPDESK_PRIORITIES } from './helpdeskRules.js';

export const HELPDESK_SLA_CLOCK_MODES = Object.freeze(['CALENDAR', 'BUSINESS_HOURS']);
export const HELPDESK_SLA_CLOCK_STATES = Object.freeze([
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'STOPPED',
]);
export const HELPDESK_SLA_MAX_MINUTES = 10_080;
export const HELPDESK_SLA_MAX_SEARCH_DAYS = 366 * 5;
export const HELPDESK_SLA_MAX_RECONCILE_BATCH = 250;
export const HELPDESK_SLA_PAUSE_STATUSES = Object.freeze([
  'waiting_for_employee',
  'waiting_for_department',
]);

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const CLOCK_TARGET_FIELDS = Object.freeze(['firstResponseMinutes', 'resolutionMinutes']);
const POLICY_FIELDS = Object.freeze([
  'enabled',
  'clockMode',
  'timeZone',
  'excludeHolidays',
  'weeklyHours',
  'targets',
  'warningPercent',
  'pauseStatuses',
]);
const WEEKDAY_FIELDS = Object.freeze(['weekday', 'windows']);
const WINDOW_FIELDS = Object.freeze(['start', 'end']);
const PAUSE_CLOCK_FIELDS = Object.freeze(['firstResponse', 'resolution']);
const TARGET_MINUTE_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const hasUnknown = (value, allowlist) => Object.keys(value || {}).find((key) => !allowlist.includes(key));
const dateValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const minuteOfDay = (value) => {
  if (typeof value !== 'string' || !TARGET_MINUTE_RE.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return (hour * 60) + minute;
};
const safeId = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};
const unique = (values) => [...new Set(values)];

const normalizedPauseStatuses = (value, fallback, field, errors) => {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > HELPDESK_SLA_PAUSE_STATUSES.length) {
    errors.push(`${field} must be an array of supported waiting statuses`);
    return [...fallback];
  }
  const normalized = value.map((entry) => String(entry || '').trim().toLowerCase());
  if (
    normalized.some((entry) => !HELPDESK_SLA_PAUSE_STATUSES.includes(entry))
    || unique(normalized).length !== normalized.length
  ) {
    errors.push(`${field} may contain only unique waiting_for_employee or waiting_for_department statuses`);
  }
  return normalized.filter((entry) => HELPDESK_SLA_PAUSE_STATUSES.includes(entry));
};

/**
 * Strict policy validation shared by HTTP/service/model-facing code. Express
 * validators are intentionally not the only guard: this function rejects
 * unknown keys and normalizes the entire persisted policy snapshot.
 */
export const validateHelpdeskSlaPolicy = (input = {}) => {
  const errors = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ['SLA policy must be an object'] };
  }
  const unknown = hasUnknown(input, POLICY_FIELDS);
  if (unknown) errors.push(`Unsupported SLA policy field: ${unknown}`);

  if (typeof input.enabled !== 'boolean') errors.push('enabled must be a boolean');
  const clockMode = String(input.clockMode || '').trim().toUpperCase();
  if (!HELPDESK_SLA_CLOCK_MODES.includes(clockMode)) {
    errors.push(`clockMode must be one of ${HELPDESK_SLA_CLOCK_MODES.join(', ')}`);
  }

  const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
  if (!timeZone || !IANAZone.isValidZone(timeZone)) errors.push('timeZone must be a valid IANA timezone');

  if (typeof input.excludeHolidays !== 'boolean') errors.push('excludeHolidays must be a boolean');
  if (clockMode === 'CALENDAR' && input.excludeHolidays === true) {
    errors.push('Holiday exclusion is supported only with BUSINESS_HOURS clocks');
  }

  const warningPercent = input.warningPercent;
  if (typeof warningPercent !== 'number' || !Number.isInteger(warningPercent) || warningPercent < 1 || warningPercent > 99) {
    errors.push('warningPercent must be an integer between 1 and 99');
  }

  const weeklyHours = [];
  const sourceDays = input.weeklyHours;
  if (!Array.isArray(sourceDays) || sourceDays.length !== DAY_KEYS.length) {
    errors.push('weeklyHours must contain exactly one entry for every weekday');
  } else {
    const seenDays = new Set();
    let totalWeeklyMinutes = 0;
    for (const entry of sourceDays) {
      if (!isRecord(entry)) {
        errors.push('Each weeklyHours entry must be an object');
        continue;
      }
      const dayUnknown = hasUnknown(entry, WEEKDAY_FIELDS);
      if (dayUnknown) errors.push(`Unsupported weeklyHours field: ${dayUnknown}`);
      const weekday = String(entry.weekday || '').trim().toUpperCase();
      if (!DAY_KEYS.includes(weekday) || seenDays.has(weekday)) {
        errors.push('weeklyHours must use each weekday exactly once');
        continue;
      }
      seenDays.add(weekday);
      if (!Array.isArray(entry.windows) || entry.windows.length > 4) {
        errors.push(`${weekday}.windows must be an array with at most four windows`);
        weeklyHours.push({ weekday, windows: [] });
        continue;
      }
      const windows = [];
      let previousEnd = -1;
      for (const window of entry.windows) {
        if (!isRecord(window)) {
          errors.push(`${weekday} windows must be objects`);
          continue;
        }
        const windowUnknown = hasUnknown(window, WINDOW_FIELDS);
        if (windowUnknown) errors.push(`Unsupported ${weekday} window field: ${windowUnknown}`);
        const start = typeof window.start === 'string' ? window.start.trim() : '';
        const end = typeof window.end === 'string' ? window.end.trim() : '';
        const startMinute = minuteOfDay(start);
        const endMinute = minuteOfDay(end);
        if (startMinute === null || endMinute === null || endMinute <= startMinute) {
          errors.push(`${weekday} windows must use valid same-day HH:mm start/end values with end after start`);
          continue;
        }
        if (startMinute < previousEnd) {
          errors.push(`${weekday} windows must be sorted and must not overlap`);
          continue;
        }
        previousEnd = endMinute;
        totalWeeklyMinutes += endMinute - startMinute;
        windows.push({ start, end });
      }
      weeklyHours.push({ weekday, windows });
    }
    if (seenDays.size !== DAY_KEYS.length) errors.push('weeklyHours must include every weekday');
    if (clockMode === 'BUSINESS_HOURS' && totalWeeklyMinutes < 60) {
      errors.push('BUSINESS_HOURS schedules must provide at least 60 minutes per week');
    }
  }

  const targets = {};
  if (!isRecord(input.targets)) {
    errors.push('targets must define response and resolution minutes for every Helpdesk priority');
  } else {
    const targetUnknown = hasUnknown(input.targets, HELPDESK_PRIORITIES);
    if (targetUnknown) errors.push(`Unsupported SLA priority target: ${targetUnknown}`);
    for (const priority of HELPDESK_PRIORITIES) {
      const target = input.targets[priority];
      if (!isRecord(target)) {
        errors.push(`targets.${priority} is required`);
        continue;
      }
      const targetUnknownField = hasUnknown(target, CLOCK_TARGET_FIELDS);
      if (targetUnknownField) errors.push(`Unsupported targets.${priority} field: ${targetUnknownField}`);
      const firstResponseMinutes = target.firstResponseMinutes;
      const resolutionMinutes = target.resolutionMinutes;
      for (const [name, minutes] of [
        ['firstResponseMinutes', firstResponseMinutes],
        ['resolutionMinutes', resolutionMinutes],
      ]) {
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > HELPDESK_SLA_MAX_MINUTES) {
          errors.push(`targets.${priority}.${name} must be an integer from 1 to ${HELPDESK_SLA_MAX_MINUTES}`);
        }
      }
      targets[priority] = { firstResponseMinutes, resolutionMinutes };
    }
  }

  const rawPauseStatuses = input.pauseStatuses;
  if (rawPauseStatuses !== undefined && !isRecord(rawPauseStatuses)) {
    errors.push('pauseStatuses must be an object');
  }
  const safePauseStatuses = isRecord(rawPauseStatuses) ? rawPauseStatuses : {};
  const pauseUnknown = hasUnknown(safePauseStatuses, PAUSE_CLOCK_FIELDS);
  if (pauseUnknown) errors.push(`Unsupported pauseStatuses clock: ${pauseUnknown}`);
  const pauseStatuses = {
    firstResponse: normalizedPauseStatuses(
      safePauseStatuses.firstResponse,
      [],
      'pauseStatuses.firstResponse',
      errors,
    ),
    resolution: normalizedPauseStatuses(
      safePauseStatuses.resolution,
      ['waiting_for_employee'],
      'pauseStatuses.resolution',
      errors,
    ),
  };

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      enabled: input.enabled,
      clockMode,
      timeZone,
      excludeHolidays: input.excludeHolidays,
      weeklyHours: weeklyHours.sort((left, right) => DAY_KEYS.indexOf(left.weekday) - DAY_KEYS.indexOf(right.weekday)),
      targets,
      warningPercent,
      pauseStatuses,
    },
  };
};

const normalizeHolidaySet = (holidays) => {
  if (holidays instanceof Set) return holidays;
  if (!Array.isArray(holidays)) return new Set();
  const dates = new Set();
  for (const holiday of holidays) {
    if (!holiday || (holiday.isOptional === true && holiday.picked !== true)) continue;
    if (Array.isArray(holiday.dates)) {
      for (const date of holiday.dates) {
        if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
      }
    } else {
      const date = typeof holiday.date === 'string' ? holiday.date : null;
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
    }
  }
  return dates;
};

const localDateTime = (dateKey, hhmm, timeZone, edge) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const dateTime = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { zone: timeZone },
  );
  if (!dateTime.isValid) return null;

  // On a fall-back fold, open at the first occurrence and close at the last
  // occurrence. On a spring-forward gap, Luxon deterministically shifts the
  // nonexistent wall time forward to the first representable local time.
  const possible = dateTime.getPossibleOffsets().sort((left, right) => left.toMillis() - right.toMillis());
  if (!possible.length) return null;
  return edge === 'end' ? possible.at(-1) : possible[0];
};

const dateWindows = (dateTime, snapshot, holidaySet) => {
  const localDay = dateTime.setZone(snapshot.timeZone);
  const dateKey = localDay.toISODate();
  if (!dateKey || (snapshot.excludeHolidays === true && holidaySet.has(dateKey))) return [];
  const weekday = DAY_KEYS[localDay.weekday % DAY_KEYS.length];
  const daily = (snapshot.weeklyHours || []).find((entry) => entry.weekday === weekday);
  if (!daily) return [];
  return (daily.windows || []).flatMap((window) => {
    const start = localDateTime(dateKey, window.start, snapshot.timeZone, 'start');
    const end = localDateTime(dateKey, window.end, snapshot.timeZone, 'end');
    if (!start || !end || end.toMillis() <= start.toMillis()) return [];
    return [{ startMs: start.toMillis(), endMs: end.toMillis() }];
  });
};

const assertUsableSnapshot = (snapshot) => {
  if (
    !snapshot
    || snapshot.clockMode === 'BUSINESS_HOURS'
      && (!IANAZone.isValidZone(snapshot.timeZone) || !Array.isArray(snapshot.weeklyHours))
  ) {
    throw new TypeError('A valid Helpdesk SLA schedule snapshot is required');
  }
};

const addBusinessDurationMs = (startValue, durationMs, snapshot, holidays) => {
  const start = dateValue(startValue);
  if (!start || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs === 0) return start;
  assertUsableSnapshot(snapshot);
  const holidaySet = normalizeHolidaySet(holidays);
  const zone = snapshot.timeZone;
  const initial = DateTime.fromJSDate(start, { zone }).startOf('day');
  if (!initial.isValid) return null;
  let remainingMs = durationMs;
  let cursorMs = start.getTime();

  for (let offset = 0; offset <= HELPDESK_SLA_MAX_SEARCH_DAYS; offset += 1) {
    const localDay = initial.plus({ days: offset });
    const nextLocalDay = initial.plus({ days: offset + 1 });
    if (!localDay.isValid || !nextLocalDay.isValid) return null;
    for (const interval of dateWindows(localDay, snapshot, holidaySet)) {
      const segmentStart = Math.max(cursorMs, interval.startMs);
      const availableMs = interval.endMs - segmentStart;
      if (availableMs <= 0) continue;
      if (remainingMs <= availableMs) return new Date(segmentStart + remainingMs);
      remainingMs -= availableMs;
    }
    cursorMs = nextLocalDay.toMillis();
  }
  return null;
};

/** Add calendar or scheduled business milliseconds, never server-local time. */
export const addHelpdeskSlaDuration = (startValue, durationMs, snapshot, holidays = []) => {
  const start = dateValue(startValue);
  if (!start || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (snapshot?.clockMode === 'CALENDAR') return new Date(start.getTime() + durationMs);
  return addBusinessDurationMs(start, durationMs, snapshot, holidays);
};

/** Count only active scheduled time between two instants, capped when requested. */
export const helpdeskSlaActiveMillisecondsBetween = (
  startValue,
  endValue,
  snapshot,
  holidays = [],
  capMs = Number.POSITIVE_INFINITY,
) => {
  const start = dateValue(startValue);
  const end = dateValue(endValue);
  if (!start || !end || end <= start) return 0;
  if (snapshot?.clockMode === 'CALENDAR') return Math.min(end.getTime() - start.getTime(), capMs);
  assertUsableSnapshot(snapshot);
  const holidaySet = normalizeHolidaySet(holidays);
  const initial = DateTime.fromJSDate(start, { zone: snapshot.timeZone }).startOf('day');
  const final = DateTime.fromJSDate(end, { zone: snapshot.timeZone }).startOf('day');
  if (!initial.isValid || !final.isValid) return 0;
  const daysToCheck = Math.min(
    Math.ceil((final.toMillis() - initial.toMillis()) / DAY_MS) + 2,
    HELPDESK_SLA_MAX_SEARCH_DAYS,
  );
  let elapsedMs = 0;
  for (let offset = 0; offset < daysToCheck; offset += 1) {
    const localDay = initial.plus({ days: offset });
    for (const interval of dateWindows(localDay, snapshot, holidaySet)) {
      const activeStart = Math.max(start.getTime(), interval.startMs);
      const activeEnd = Math.min(end.getTime(), interval.endMs);
      if (activeEnd <= activeStart) continue;
      elapsedMs += activeEnd - activeStart;
      if (elapsedMs >= capMs) return capMs;
    }
  }
  return elapsedMs;
};

const targetMsFor = (minutes) => Number(minutes) * MINUTE_MS;
const warningThresholdMs = (minutes, warningPercent) =>
  Math.ceil(targetMsFor(minutes) * Number(warningPercent) / 100);

const clockTarget = (clockType, targets, priority) => {
  const target = targets?.[priority];
  return clockType === 'firstResponse'
    ? target?.firstResponseMinutes
    : target?.resolutionMinutes;
};

const createClock = ({ targetMinutes, startedAt, snapshot, holidays }) => {
  const started = dateValue(startedAt);
  const dueAt = addHelpdeskSlaDuration(started, targetMsFor(targetMinutes), snapshot, holidays);
  const warningAt = addHelpdeskSlaDuration(
    started,
    warningThresholdMs(targetMinutes, snapshot.warningPercent),
    snapshot,
    holidays,
  );
  if (!dueAt || !warningAt) return null;
  return {
    state: 'RUNNING',
    targetMinutes,
    activeElapsedMs: 0,
    startedAt: started,
    resumedAt: started,
    pausedAt: null,
    dueAt,
    warningAt,
    warningEligibleAt: null,
    completedAt: null,
    lastCompletedAt: null,
    firstResponseAt: null,
    breachedAt: null,
    stoppedAt: null,
  };
};

export const calculateHelpdeskSlaNextActionAt = (sla) => {
  const candidates = [];
  for (const clock of [sla?.firstResponse, sla?.resolution]) {
    if (!clock || clock.state !== 'RUNNING' || clock.breachedAt) continue;
    if (!clock.warningEligibleAt && clock.warningAt) candidates.push(dateValue(clock.warningAt));
    if (clock.dueAt) candidates.push(dateValue(clock.dueAt));
  }
  const valid = candidates.filter(Boolean).sort((left, right) => left.getTime() - right.getTime());
  return valid[0] || null;
};

const safeHolidayContext = (context) => ({
  department: safeId(context?.department) || null,
  branch: typeof context?.branch === 'string' ? context.branch : '',
});

/** Build immutable target/schedule snapshots for a newly created ticket. */
export const createHelpdeskSlaState = ({
  policy,
  policyQueueId,
  priority,
  startedAt,
  holidayContext = null,
  holidays = [],
}) => {
  if (!policy?.enabled) return null;
  const responseMinutes = clockTarget('firstResponse', policy.targets, priority);
  const resolutionMinutes = clockTarget('resolution', policy.targets, priority);
  if (!responseMinutes || !resolutionMinutes) return null;
  const snapshot = {
    clockMode: policy.clockMode,
    timeZone: policy.timeZone,
    excludeHolidays: policy.excludeHolidays === true,
    weeklyHours: policy.weeklyHours,
    targets: policy.targets,
    warningPercent: policy.warningPercent,
    pauseStatuses: policy.pauseStatuses,
  };
  const firstResponse = createClock({
    targetMinutes: responseMinutes,
    startedAt,
    snapshot,
    holidays,
  });
  const resolution = createClock({
    targetMinutes: resolutionMinutes,
    startedAt,
    snapshot,
    holidays,
  });
  if (!firstResponse || !resolution) return null;
  const sla = {
    version: 1,
    policyQueueId: safeId(policyQueueId),
    policyVersion: Number(policy.version) || 1,
    appliedPriority: priority,
    ...snapshot,
    holidayContext: safeHolidayContext(holidayContext),
    firstResponse,
    resolution,
    escalation: {
      state: 'NONE',
      queueId: safeId(policyQueueId),
      eligibleAt: null,
      triggers: [],
    },
    nextActionAt: null,
    updatedAt: dateValue(startedAt),
  };
  sla.nextActionAt = calculateHelpdeskSlaNextActionAt(sla);
  return sla;
};

const cloneState = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const currentElapsedMs = ({ clock, snapshot, now, holidays }) => {
  const persisted = Math.max(0, Number(clock.activeElapsedMs) || 0);
  if (clock.state !== 'RUNNING' || !clock.resumedAt) return persisted;
  const accrued = helpdeskSlaActiveMillisecondsBetween(
    clock.resumedAt,
    now,
    snapshot,
    holidays,
    HELPDESK_SLA_MAX_MINUTES * MINUTE_MS,
  );
  return Math.min(HELPDESK_SLA_MAX_MINUTES * MINUTE_MS, persisted + accrued);
};

const refreshActiveClock = ({ clock, targetMinutes, snapshot, now, holidays }) => {
  const next = clock;
  next.targetMinutes = targetMinutes;
  next.activeElapsedMs = currentElapsedMs({ clock, snapshot, now, holidays });
  if (next.state === 'RUNNING') {
    next.resumedAt = dateValue(now);
    const remainingMs = Math.max(0, targetMsFor(targetMinutes) - next.activeElapsedMs);
    next.dueAt = addHelpdeskSlaDuration(now, remainingMs, snapshot, holidays);
    if (!next.dueAt) throw new RangeError('Could not compute the Helpdesk SLA deadline within the supported horizon');
    if (next.warningEligibleAt) {
      next.warningAt = null;
    } else {
      const warningRemainingMs = Math.max(
        0,
        warningThresholdMs(targetMinutes, snapshot.warningPercent) - next.activeElapsedMs,
      );
      next.warningAt = addHelpdeskSlaDuration(now, warningRemainingMs, snapshot, holidays);
      if (!next.warningAt) throw new RangeError('Could not compute the Helpdesk SLA warning within the supported horizon');
    }
  } else if (next.state === 'PAUSED') {
    next.resumedAt = null;
    next.dueAt = null;
    next.warningAt = null;
  }
  return next;
};

const applyDueClockEvents = (clock, now, completionAt = null) => {
  if (!clock) return;
  const nowDate = dateValue(now);
  const completion = dateValue(completionAt);
  const dueAt = dateValue(clock.dueAt);
  const warningAt = dateValue(clock.warningAt);

  if (completion && (!clock.stoppedAt || completion <= dateValue(clock.stoppedAt))) {
    if (!clock.completedAt || completion < dateValue(clock.completedAt)) {
      clock.completedAt = completion;
      clock.lastCompletedAt = completion;
    }
    if (clock.firstResponseAt === null || clock.firstResponseAt === undefined || completion < dateValue(clock.firstResponseAt)) {
      clock.firstResponseAt = completion;
    }
    if (warningAt && completion > warningAt && !clock.warningEligibleAt) {
      clock.warningEligibleAt = warningAt;
    }
    if (dueAt && completion > dueAt && !clock.breachedAt) clock.breachedAt = dueAt;
    clock.state = 'COMPLETED';
    clock.resumedAt = null;
    clock.pausedAt = null;
    clock.dueAt = null;
    clock.warningAt = null;
    return;
  }

  if (clock.state !== 'RUNNING' || !nowDate) return;
  if (warningAt && warningAt <= nowDate && !clock.warningEligibleAt) {
    clock.warningEligibleAt = warningAt;
    clock.warningAt = null;
  }
  if (dueAt && dueAt <= nowDate && !clock.breachedAt) clock.breachedAt = dueAt;
};

const updateEscalation = (sla, queueId) => {
  const triggers = [];
  if (sla.firstResponse?.breachedAt) triggers.push('FIRST_RESPONSE');
  if (sla.resolution?.breachedAt) triggers.push('RESOLUTION');
  if (!triggers.length) return;
  const existingTriggers = Array.isArray(sla.escalation?.triggers) ? sla.escalation.triggers : [];
  const eligibleDates = [sla.firstResponse?.breachedAt, sla.resolution?.breachedAt]
    .map(dateValue)
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime());
  sla.escalation = {
    state: 'ELIGIBLE',
    queueId: safeId(queueId) || safeId(sla.escalation?.queueId) || null,
    eligibleAt: dateValue(sla.escalation?.eligibleAt) || eligibleDates[0] || dateValue(sla.updatedAt),
    triggers: unique([...existingTriggers, ...triggers]),
  };
};

const setNextAction = (sla, now) => {
  sla.nextActionAt = calculateHelpdeskSlaNextActionAt(sla);
  sla.updatedAt = dateValue(now);
  return sla;
};

/**
 * Persist every time-driven warning/breach marker. Callers should re-read the
 * earliest qualifying message before invoking this for a response clock.
 */
export const applyHelpdeskSlaDueEvents = ({
  sla: rawSla,
  now,
  firstResponseAt = null,
  queueId = null,
}) => {
  if (!rawSla) return null;
  const sla = cloneState(rawSla);
  applyDueClockEvents(sla.firstResponse, now, firstResponseAt);
  applyDueClockEvents(sla.resolution, now);
  updateEscalation(sla, queueId);
  sla.version = (Number(sla.version) || 0) + 1;
  return setNextAction(sla, now);
};

const pauseClock = ({ clock, snapshot, now, holidays }) => {
  if (!clock || clock.state !== 'RUNNING') return clock;
  clock.activeElapsedMs = currentElapsedMs({ clock, snapshot, now, holidays });
  clock.state = 'PAUSED';
  clock.pausedAt = dateValue(now);
  clock.resumedAt = null;
  clock.dueAt = null;
  clock.warningAt = null;
  return clock;
};

const resumeClock = ({ clock, targetMinutes, snapshot, now, holidays }) => {
  if (!clock || !['PAUSED', 'COMPLETED'].includes(clock.state)) return clock;
  if (clock.state === 'COMPLETED') {
    clock.lastCompletedAt = dateValue(clock.completedAt) || dateValue(clock.lastCompletedAt);
    clock.completedAt = null;
  }
  clock.state = 'RUNNING';
  clock.pausedAt = null;
  clock.stoppedAt = null;
  clock.resumedAt = dateValue(now);
  clock.targetMinutes = targetMinutes;
  const remainingMs = Math.max(0, targetMsFor(targetMinutes) - (Number(clock.activeElapsedMs) || 0));
  clock.dueAt = addHelpdeskSlaDuration(now, remainingMs, snapshot, holidays);
  if (!clock.dueAt) throw new RangeError('Could not compute the Helpdesk SLA deadline within the supported horizon');
  if (!clock.warningEligibleAt) {
    const warningRemainingMs = Math.max(
      0,
      warningThresholdMs(targetMinutes, snapshot.warningPercent) - (Number(clock.activeElapsedMs) || 0),
    );
    clock.warningAt = addHelpdeskSlaDuration(now, warningRemainingMs, snapshot, holidays);
    if (!clock.warningAt) throw new RangeError('Could not compute the Helpdesk SLA warning within the supported horizon');
  }
  return clock;
};

const stopClock = (clock, now) => {
  if (!clock || ['COMPLETED', 'STOPPED'].includes(clock.state)) return clock;
  clock.state = 'STOPPED';
  clock.stoppedAt = dateValue(now);
  clock.pausedAt = null;
  clock.resumedAt = null;
  clock.dueAt = null;
  clock.warningAt = null;
  return clock;
};

const completeResolutionClock = ({ clock, snapshot, now, holidays }) => {
  if (!clock || clock.state === 'COMPLETED' || clock.state === 'STOPPED') return clock;
  if (clock.state === 'RUNNING') {
    clock.activeElapsedMs = currentElapsedMs({ clock, snapshot, now, holidays });
  }
  clock.state = 'COMPLETED';
  clock.completedAt = dateValue(now);
  clock.lastCompletedAt = dateValue(now);
  clock.pausedAt = null;
  clock.resumedAt = null;
  clock.dueAt = null;
  clock.warningAt = null;
  return clock;
};

/** Apply status effects without resolving a ticket; the caller owns workflow authorization. */
export const transitionHelpdeskSlaStatus = ({
  sla: rawSla,
  fromStatus,
  toStatus,
  now,
  holidays = [],
  queueId = null,
}) => {
  if (!rawSla) return null;
  const sla = cloneState(rawSla);
  const normalizedFrom = String(fromStatus || '').toLowerCase();
  const normalizedTo = String(toStatus || '').toLowerCase();
  const snapshot = sla;

  // Record a warning/breach that became due before the state transition. These
  // markers are sticky and are never erased by a pause, completion or reopen.
  applyDueClockEvents(sla.firstResponse, now);
  applyDueClockEvents(sla.resolution, now);

  for (const [field, pauseKey] of [
    ['firstResponse', 'firstResponse'],
    ['resolution', 'resolution'],
  ]) {
    const clock = sla[field];
    if (!clock || clock.state === 'STOPPED') continue;
    const pauseStatuses = snapshot.pauseStatuses?.[pauseKey] || [];
    const shouldPause = pauseStatuses.includes(normalizedTo);
    if (shouldPause && clock.state === 'RUNNING') {
      pauseClock({ clock, snapshot, now, holidays });
    } else if (!shouldPause && clock.state === 'PAUSED') {
      resumeClock({
        clock,
        targetMinutes: clock.targetMinutes,
        snapshot,
        now,
        holidays,
      });
    }
  }

  if (normalizedTo === 'resolved') {
    completeResolutionClock({ clock: sla.resolution, snapshot, now, holidays });
  } else if (normalizedFrom === 'resolved' && normalizedTo === 'in_progress') {
    const resolutionTarget = sla.resolution?.targetMinutes;
    if (resolutionTarget && sla.resolution?.state === 'COMPLETED') {
      resumeClock({
        clock: sla.resolution,
        targetMinutes: resolutionTarget,
        snapshot,
        now,
        holidays,
      });
    }
  }

  if (normalizedTo === 'closed' || normalizedTo === 'cancelled') {
    stopClock(sla.firstResponse, now);
    stopClock(sla.resolution, now);
  }

  updateEscalation(sla, queueId);
  sla.version = (Number(sla.version) || 0) + 1;
  return setNextAction(sla, now);
};

const applyTargetSnapshot = ({ sla, targets, priority, policy, policyQueueId, now, holidays }) => {
  const previousSnapshot = sla;
  const elapsedFor = (clock) => {
    const dueAt = dateValue(clock?.dueAt);
    if (clock?.breachedAt || dueAt && dueAt <= dateValue(now)) {
      return Math.max(0, Number(clock?.activeElapsedMs) || 0);
    }
    return currentElapsedMs({ clock, snapshot: previousSnapshot, now, holidays });
  };
  const elapsed = {
    firstResponse: elapsedFor(sla.firstResponse),
    resolution: elapsedFor(sla.resolution),
  };
  const nextSnapshot = {
    clockMode: policy.clockMode,
    timeZone: policy.timeZone,
    excludeHolidays: policy.excludeHolidays === true,
    weeklyHours: policy.weeklyHours,
    targets: policy.targets,
    warningPercent: policy.warningPercent,
    pauseStatuses: policy.pauseStatuses,
  };
  Object.assign(sla, nextSnapshot, {
    policyQueueId: safeId(policyQueueId),
    policyVersion: Number(policy.version) || 1,
    appliedPriority: priority,
    holidayContext: safeHolidayContext(sla.holidayContext),
  });
  for (const [field, targetField] of [
    ['firstResponse', 'firstResponseMinutes'],
    ['resolution', 'resolutionMinutes'],
  ]) {
    const clock = sla[field];
    const storedDueAt = dateValue(clock?.dueAt);
    if (
      !clock
      || ['COMPLETED', 'STOPPED'].includes(clock.state)
      || clock.breachedAt
      || storedDueAt && storedDueAt <= dateValue(now)
    ) continue;
    clock.activeElapsedMs = elapsed[field];
    if (clock.state === 'RUNNING') clock.resumedAt = dateValue(now);
    refreshActiveClock({
      clock,
      targetMinutes: targets[targetField],
      snapshot: nextSnapshot,
      now,
      holidays,
    });
  }
  return sla;
};

/**
 * Rebase active clocks on a priority or queue change. Elapsed active
 * milliseconds are carried forward; breach and warning markers remain sticky.
 */
export const rebaseHelpdeskSla = ({
  sla: rawSla,
  priority,
  now,
  holidays = [],
  policy = null,
  policyQueueId = null,
  currentQueueId = null,
}) => {
  if (!rawSla) return null;
  const sla = cloneState(rawSla);
  const validPriority = HELPDESK_PRIORITIES.includes(priority) ? priority : sla.appliedPriority;
  const selectedPolicy = policy?.enabled === true ? policy : null;
  if (selectedPolicy) {
    const targets = selectedPolicy.targets?.[validPriority];
    if (targets) {
      applyTargetSnapshot({
        sla,
        targets,
        priority: validPriority,
        policy: selectedPolicy,
        policyQueueId,
        now,
        holidays,
      });
    }
  } else {
    // A priority change without an enabled policy uses the ticket's original
    // frozen target table rather than silently disabling or restarting clocks.
    const targets = sla.targets?.[validPriority];
    if (targets) {
      const policySnapshot = {
        clockMode: sla.clockMode,
        timeZone: sla.timeZone,
        excludeHolidays: sla.excludeHolidays,
        weeklyHours: sla.weeklyHours,
        targets: sla.targets,
        warningPercent: sla.warningPercent,
        pauseStatuses: sla.pauseStatuses,
      };
      for (const [field, targetField] of [
        ['firstResponse', 'firstResponseMinutes'],
        ['resolution', 'resolutionMinutes'],
      ]) {
        const clock = sla[field];
        const storedDueAt = dateValue(clock?.dueAt);
        if (
          !clock
          || ['COMPLETED', 'STOPPED'].includes(clock.state)
          || clock.breachedAt
          || storedDueAt && storedDueAt <= dateValue(now)
        ) continue;
        refreshActiveClock({
          clock,
          targetMinutes: targets[targetField],
          snapshot: policySnapshot,
          now,
          holidays,
        });
      }
      sla.appliedPriority = validPriority;
    }
  }
  if (currentQueueId) {
    sla.escalation = {
      ...(sla.escalation || {}),
      queueId: safeId(currentQueueId),
    };
  }
  updateEscalation(sla, currentQueueId);
  sla.version = (Number(sla.version) || 0) + 1;
  return setNextAction(sla, now);
};

export const serializeHelpdeskSlaClock = (clock, now = new Date()) => {
  if (!clock) return null;
  const nowDate = dateValue(now) || new Date();
  const dueAt = dateValue(clock.dueAt);
  const warningAt = dateValue(clock.warningAt);
  let state = clock.state || 'RUNNING';
  if (clock.breachedAt) state = 'BREACHED';
  else if (state === 'RUNNING' && dueAt && dueAt <= nowDate) state = 'OVERDUE';
  else if (state === 'RUNNING' && (clock.warningEligibleAt || warningAt && warningAt <= nowDate)) state = 'WARNING';
  else if (state === 'COMPLETED') state = 'COMPLETED';
  else if (state === 'PAUSED') state = 'PAUSED';
  else if (state === 'STOPPED') state = 'STOPPED';
  else state = 'ON_TRACK';
  return {
    state,
    targetMinutes: Number(clock.targetMinutes) || null,
    dueAt: dueAt || null,
    warningDueAt: warningAt || null,
    warningEligibleAt: dateValue(clock.warningEligibleAt),
    completedAt: dateValue(clock.completedAt),
    firstResponseAt: dateValue(clock.firstResponseAt),
    breachedAt: dateValue(clock.breachedAt),
    pausedAt: dateValue(clock.pausedAt),
  };
};

export const serializeHelpdeskSla = (sla, { includeEscalation = false, now = new Date() } = {}) => {
  if (!sla) return { configured: false };
  const result = {
    configured: true,
    clockMode: sla.clockMode,
    timeZone: sla.timeZone,
    priority: sla.appliedPriority,
    firstResponse: serializeHelpdeskSlaClock(sla.firstResponse, now),
    resolution: serializeHelpdeskSlaClock(sla.resolution, now),
  };
  if (includeEscalation) {
    result.escalation = {
      state: sla.escalation?.state || 'NONE',
      queueId: safeId(sla.escalation?.queueId),
      eligibleAt: dateValue(sla.escalation?.eligibleAt),
      triggers: Array.isArray(sla.escalation?.triggers) ? [...sla.escalation.triggers] : [],
    };
  }
  return result;
};

export const _test = {
  dateValue,
  normalizeHolidaySet,
  localDateTime,
  dateWindows,
  currentElapsedMs,
  refreshActiveClock,
  applyDueClockEvents,
  updateEscalation,
  stopClock,
  resumeClock,
  pauseClock,
};
