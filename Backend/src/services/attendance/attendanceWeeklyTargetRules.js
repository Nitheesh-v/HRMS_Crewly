// ═══════════════════════════════════════════════════════════════════════════
//  WEEKLY-HOURS FLEXI TARGET — PURE RULES (no I/O, fully hermetic)
//
//  "Finish the weekly hours goal early, rest the remaining working days."
//
//  The week is Monday→Sunday in company-local date strings ('YYYY-MM-DD').
//  All arithmetic uses UTC-safe parsing of those strings so timezones can
//  never shift a day across the week boundary. Qualification NEVER carries
//  across weeks: hours earned count only inside their own week.
// ═══════════════════════════════════════════════════════════════════════════

export const WEEKLY_TARGET_DEFAULTS = Object.freeze({
  enabled: false,
  targetMinutes: 2400, // 40h
  restDayMode: 'AUTO_MARK', // or 'SUGGEST_ONLY'
  includeApprovedOvertime: false,
});

const MIN_TARGET_MINUTES = 60;
const MAX_TARGET_MINUTES = 10080; // 7 × 24h — any target is representable

const toDate = (dateKey) => {
  const [y, m, d] = String(dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
};

const toKey = (date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const addDays = (dateKey, days) => {
  const date = toDate(dateKey);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return toKey(date);
};

// Monday→Sunday window containing dateKey. Monday is the week start by
// convention across the product's calendars.
export const weekWindowFor = (dateKey) => {
  const date = toDate(dateKey);
  if (!date) return { weekStart: null, weekEnd: null };
  const weekday = date.getUTCDay(); // 0=Sun … 6=Sat
  const backToMonday = weekday === 0 ? 6 : weekday - 1;
  const weekStart = addDays(dateKey, -backToMonday);
  return { weekStart, weekEnd: addDays(weekStart, 6) };
};

// Minutes achieved strictly BEFORE beforeDate inside that date's week.
// Rest-day qualification always looks backwards: a day is earned rest only
// if the target was already met by the END of the previous day.
export const achievedMinutesBefore = ({
  weekRows = [],
  targetDate,
  includeApprovedOvertime = false,
}) => {
  let total = 0;
  for (const row of weekRows) {
    if (!row || !row.date || row.date >= targetDate) continue;
    total += Math.max(0, Number(row.workMinutes) || 0);
    if (includeApprovedOvertime) {
      total += Math.max(0, Number(row.overtimeMinutes) || 0);
    }
  }
  return total;
};

export const achievedMinutesThrough = ({
  weekRows = [],
  includeApprovedOvertime = false,
}) => {
  let total = 0;
  for (const row of weekRows) {
    if (!row) continue;
    total += Math.max(0, Number(row.workMinutes) || 0);
    if (includeApprovedOvertime) {
      total += Math.max(0, Number(row.overtimeMinutes) || 0);
    }
  }
  return total;
};

// Normalise a possibly-legacy policy into safe values. Unknown/missing
// shapes fall back to the disabled defaults — the feature is opt-in.
export const normaliseWeeklyTargetPolicy = (policy) => {
  const block = policy?.weeklyTarget;
  if (!block || typeof block !== 'object') {
    return { ...WEEKLY_TARGET_DEFAULTS };
  }
  const targetMinutes = Math.min(
    MAX_TARGET_MINUTES,
    Math.max(MIN_TARGET_MINUTES, Math.trunc(Number(block.targetMinutes) || WEEKLY_TARGET_DEFAULTS.targetMinutes)),
  );
  return {
    enabled: block.enabled === true,
    targetMinutes,
    restDayMode: block.restDayMode === 'SUGGEST_ONLY' ? 'SUGGEST_ONLY' : 'AUTO_MARK',
    includeApprovedOvertime: block.includeApprovedOvertime === true,
  };
};

// Should this elapsed, unworked, leave-free day become earned rest?
// Everything that decides this is here so the service stays a thin I/O shell.
export const restDayDecision = ({
  policyBlock,
  weekRows = [],
  date,
  holidayDates = new Set(),
  leaveDates = new Set(),
  hasRow = false,
  todayKey,
}) => {
  const config = normaliseWeeklyTargetPolicy(policyBlock);
  if (!config.enabled) return { rest: false, reason: 'POLICY_DISABLED' };
  if (config.restDayMode !== 'AUTO_MARK') return { rest: false, reason: 'SUGGEST_ONLY' };
  if (!date || !todayKey || date >= todayKey) return { rest: false, reason: 'NOT_ELAPSED' };
  if (hasRow) return { rest: false, reason: 'HAS_ROW' };
  if (leaveDates.has(date)) return { rest: false, reason: 'ON_APPROVED_LEAVE' };
  if (holidayDates.has(date)) return { rest: false, reason: 'HOLIDAY' };

  const { weekStart } = weekWindowFor(date);
  if (!weekStart) return { rest: false, reason: 'BAD_DATE' };

  const achieved = achievedMinutesBefore({
    weekRows: weekRows.filter((row) => weekWindowFor(row.date).weekStart === weekStart),
    targetDate: date,
    includeApprovedOvertime: config.includeApprovedOvertime,
  });
  if (achieved < config.targetMinutes) {
    return { rest: false, reason: 'WEEK_NOT_QUALIFIED', achievedMinutes: achieved };
  }

  return {
    rest: true,
    reason: 'TARGET_MET',
    achievedMinutes: achieved,
    targetMinutes: config.targetMinutes,
    weekStart,
  };
};

// Did THIS day's minutes push the employee across the target for the first
// time? (Crossing, not mere meeting — the nudge fires exactly once per week
// and only on the day the goal was actually completed.)
export const crossingDecision = ({
  policyBlock,
  weekRows = [],
  date,
}) => {
  const config = normaliseWeeklyTargetPolicy(policyBlock);
  if (!config.enabled) return { crossed: false, reason: 'POLICY_DISABLED' };

  const { weekStart } = weekWindowFor(date);
  const inWeek = weekRows.filter(
    (row) => row && row.date && weekWindowFor(row.date).weekStart === weekStart,
  );
  const before = achievedMinutesBefore({
    weekRows: inWeek,
    targetDate: date,
    includeApprovedOvertime: config.includeApprovedOvertime,
  });
  const through = achievedMinutesThrough({
    weekRows: inWeek,
    includeApprovedOvertime: config.includeApprovedOvertime,
  });

  if (before >= config.targetMinutes) return { crossed: false, reason: 'ALREADY_QUALIFIED' };
  if (through < config.targetMinutes) return { crossed: false, reason: 'NOT_YET' };

  return {
    crossed: true,
    reason: 'CROSSED_TODAY',
    weekStart,
    achievedMinutes: through,
    targetMinutes: config.targetMinutes,
  };
};
