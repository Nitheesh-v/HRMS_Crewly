// ─────────────────────────────────────────────────────────────
// Phase 31.14 — pure attendance-import rules.
//
// Mirrors the 29.5 parseImportCsv conventions (quoted-field CSV,
// header validation, {rows, rejected}, in-file duplicates, 5000
// row cap) with one hardening: unbalanced quotes reject the row
// instead of silently merging cells. Deterministic and
// side-effect-free: no Mongo, no req/res, no Redis.
// ─────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { transition } from './attendanceEventRules.js';
import { EVENT_TYPE, LIVE_STATE } from './attendancePolicyRules.js';

export const IMPORT_TEMPLATE_HEADER = [
  'employeeCode',
  'timestamp',
  'eventType',
  'workMode',
  'sourceReference',
];

// Same established cap as 29.5 (MAX_IMPORT_ROWS). Bounded import
// stays synchronous — no queue for a 5,000-row CSV.
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_CONTENT_CHARS = 2000000;
export const MAX_IMPORT_FIELD_CHARS = 200;
export const MAX_SOURCE_REFERENCE_CHARS = 120;

// Imported events may be historical but stay recent: within the
// past 12 months, never in the future. Operational bound,
// documented (no authoritative source defines an import window).
export const IMPORT_WINDOW_MONTHS = 12;

export const IMPORT_EVENT_TYPES = Object.freeze([
  'CLOCK_IN',
  'BREAK_START',
  'BREAK_END',
  'CLOCK_OUT',
]);

export const IMPORT_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  CONFIRMING: 'CONFIRMING',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
});

const IMPORT_TRANSITIONS = Object.freeze({
  [IMPORT_STATUS.DRAFT]: [IMPORT_STATUS.CONFIRMING],
  [IMPORT_STATUS.CONFIRMING]: [IMPORT_STATUS.CONFIRMED, IMPORT_STATUS.FAILED],
  [IMPORT_STATUS.CONFIRMED]: [],
  [IMPORT_STATUS.FAILED]: [],
});

export const canTransitionImport = (from, to) =>
  (IMPORT_TRANSITIONS[from] || []).includes(to);

// ── CSV ──────────────────────────────────────────────────────
// 29.5 splitCsvLine pattern: quote-aware, "" escapes, trims cells.

const splitCsvLine = (line) => {
  const cells = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return { cells, unbalanced: quoted };
};

const hasUnbalancedQuotes = (line) => {
  let count = 0;
  for (const char of line) {
    if (char === '"') count += 1;
  }
  return count % 2 === 1;
};

// ISO instant WITH an explicit zone designator (Z or ±offset).
// Naive datetimes ("2026-09-16 09:00") are ambiguous across zones
// and are rejected — the source system must state the zone.
const ZONED_INSTANT_RE = /(Z|[+-]\d{2}:?\d{2})\s*$/;
export const parseZonedTimestamp = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (!ZONED_INSTANT_RE.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : null;
};

const normalizeContent = (content) =>
  String(content || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

export const parseAttendanceImportCsv = (content = '') => {
  const text = normalizeContent(content);
  if (text.length > MAX_IMPORT_CONTENT_CHARS) {
    return {
      rows: [],
      rejected: [{ line: 1, employeeCode: '', message: 'File is too large — split it and retry' }],
      header: [],
      truncated: false,
    };
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (!lines.length) {
    return { rows: [], rejected: [{ line: 1, employeeCode: '', message: 'File is empty' }], header: [], truncated: false };
  }

  const header = splitCsvLine(lines[0]).cells.map((cell) => cell.toLowerCase());
  const indexOf = (name) => header.indexOf(name);
  if (indexOf('employeecode') === -1 || indexOf('timestamp') === -1 || indexOf('eventtype') === -1) {
    return {
      rows: [],
      rejected: [{ line: 1, employeeCode: '', message: 'The header must contain employeeCode, timestamp and eventType' }],
      header,
      truncated: false,
    };
  }

  const rows = [];
  const rejected = [];
  const seen = new Set();

  lines.slice(1, MAX_IMPORT_ROWS + 1).forEach((line, offset) => {
    const lineNumber = offset + 2;
    if (hasUnbalancedQuotes(line)) {
      rejected.push({ line: lineNumber, employeeCode: '', message: 'Malformed row — unbalanced quotes' });
      return;
    }
    const { cells } = splitCsvLine(line);
    const value = (name) => {
      const index = indexOf(name);
      return index === -1 ? '' : (cells[index] || '');
    };

    const employeeCode = value('employeecode');
    const timestampRaw = value('timestamp');
    const eventType = value('eventtype');
    const workMode = value('workmode');
    const sourceReference = value('sourcereference');

    if (!employeeCode) {
      rejected.push({ line: lineNumber, employeeCode: '', message: 'Employee code is missing' });
      return;
    }
    if (employeeCode.length > MAX_IMPORT_FIELD_CHARS || timestampRaw.length > MAX_IMPORT_FIELD_CHARS) {
      rejected.push({ line: lineNumber, employeeCode: employeeCode.slice(0, 24), message: 'Field is too long' });
      return;
    }
    const occurredMs = parseZonedTimestamp(timestampRaw);
    if (occurredMs === null) {
      rejected.push({
        line: lineNumber,
        employeeCode,
        message: 'Timestamp must be an ISO instant with a zone (e.g. 2026-09-16T09:00:00+05:30)',
      });
      return;
    }
    if (!IMPORT_EVENT_TYPES.includes(eventType)) {
      rejected.push({
        line: lineNumber,
        employeeCode,
        message: 'Event type must be CLOCK_IN, BREAK_START, BREAK_END, or CLOCK_OUT',
      });
      return;
    }
    if (workMode && workMode.length > MAX_IMPORT_FIELD_CHARS) {
      rejected.push({ line: lineNumber, employeeCode, message: 'Work mode is too long' });
      return;
    }
    if (sourceReference && sourceReference.length > MAX_SOURCE_REFERENCE_CHARS) {
      rejected.push({ line: lineNumber, employeeCode, message: 'Source reference is too long' });
      return;
    }

    const fingerprint = `${employeeCode}${occurredMs}${eventType}`;
    if (seen.has(fingerprint)) {
      rejected.push({
        line: lineNumber,
        employeeCode,
        message: 'Duplicate row — the same employee, timestamp and event already appears above',
      });
      return;
    }
    seen.add(fingerprint);

    rows.push({ line: lineNumber, employeeCode, occurredMs, eventType, workMode, sourceReference });
  });

  const truncated = lines.length - 1 > MAX_IMPORT_ROWS;
  if (truncated) {
    rejected.push({
      line: MAX_IMPORT_ROWS + 2,
      employeeCode: '',
      message: `Only the first ${MAX_IMPORT_ROWS} rows are imported — split the file`,
    });
  }
  return { rows, rejected, header, truncated };
};

// Batch fingerprint: same canonical content → same batch, even
// across CRLF/LF endings or a BOM. Re-uploads return the prior
// batch instead of duplicating events.
export const fingerprintImportContent = (content = '') => {
  const canonical = normalizeContent(content)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line.trim() !== '' || index === 0)
    .join('\n')
    .trim();
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
};

// Import window check over instants (callers supply nowMs).
export const isWithinImportWindow = (occurredMs, nowMs = Date.now()) => {
  if (!Number.isFinite(occurredMs) || occurredMs <= 0) return false;
  if (occurredMs > nowMs) return false;
  const oldest = new Date(nowMs);
  oldest.setUTCMonth(oldest.getUTCMonth() - IMPORT_WINDOW_MONTHS);
  return occurredMs >= oldest.getTime();
};

// YYYY-MM of an instant in a zone (finalized-month lookup).
export const monthOfInstantInZone = (instantMs, timeZone) => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date(instantMs));
    return parts.slice(0, 7);
  } catch {
    return new Date(instantMs).toISOString().slice(0, 7);
  }
};

export const IMPORT_TEMPLATE_FILENAME = 'attendance-import-template.csv';

export const buildImportTemplate = () =>
  `${IMPORT_TEMPLATE_HEADER.join(',')}\nEMP001,2026-09-16T09:00:00+05:30,CLOCK_IN,OFFICE,\n`;

// ── Session planning (pure) ──────────────────────────────────
// Merges imported rows with already-recorded events per employee
// and simulates the 31.2 transition machine over the merged
// timeline. Recorded facts always win: imported rows that break
// validity are rejected, never force-fit.
//   rows:     [{ line, userKey, occurredMs, eventType }]
//   existing: [{ userKey, sessionDay, type, atMs }]
//   openState: Map userKey → { liveState, sessionDay } | null
//     (the employee's currently-open session, if any — seeded
//     from the live control record so imports extend reality)
//   dayKeyOf: (ms) => 'YYYY-MM-DD' in the company zone
// Returns [{ line, valid, reason, reasonCode, sessionDay }].
// reasonCode: OK | NO_OPEN_SESSION | SESSION_BUSY |
//   ALREADY_RECORDED | COLLISION | DAY_CONFLICT | PREDATES_SESSION.

export const planImportSessions = ({ rows, existing = [], openState = new Map(), dayKeyOf }) => {
  const existingByUser = new Map();
  for (const ev of existing || []) {
    if (!existingByUser.has(ev.userKey)) existingByUser.set(ev.userKey, []);
    existingByUser.get(ev.userKey).push(ev);
  }
  const rowsByUser = new Map();
  for (const row of rows || []) {
    if (!rowsByUser.has(row.userKey)) rowsByUser.set(row.userKey, []);
    rowsByUser.get(row.userKey).push(row);
  }

  const plans = [];
  for (const [userKey, userRows] of rowsByUser) {
    const userExisting = (existingByUser.get(userKey) || []).slice().sort((a, b) => a.atMs - b.atMs);
    const seed = openState instanceof Map ? openState.get(userKey) : null;
    // A poisoned day's rows are excluded and the user re-walked
    // (loop converges: each pass poisons ≥1 new day or finishes).
    const poisonedDays = new Set();
    let pass = [];
    for (let attempt = 0; attempt < (userExisting.length + userRows.length + 2); attempt += 1) {
      pass = walkUserTimeline({ userRows, userExisting, seed, dayKeyOf, poisonedDays });
      const newlyPoisoned = pass.newPoisonDay;
      if (!newlyPoisoned || poisonedDays.has(newlyPoisoned)) break;
      poisonedDays.add(newlyPoisoned);
    }
    for (const plan of pass.plans) plans.push(plan);
  }
  return plans.sort((a, b) => a.line - b.line);
};

const walkUserTimeline = ({ userRows, userExisting, seed, dayKeyOf, poisonedDays }) => {
  const plans = new Map(); // line → plan
  const poisoned = new Set(poisonedDays);
  let newPoisonDay = null;

  // Timeline: existing facts first on ties (recorded wins).
  const timeline = [];
  for (const ev of userExisting) {
    timeline.push({ atMs: ev.atMs, existing: true, ref: ev, line: -1 });
  }
  for (const row of userRows.slice().sort((a, b) => a.occurredMs - b.occurredMs || a.line - b.line)) {
    timeline.push({ atMs: row.occurredMs, existing: false, ref: row, line: row.line });
  }
  timeline.sort((a, b) => a.atMs - b.atMs || (a.existing ? -1 : 1) || a.line - b.line);

  let liveState = seed?.liveState || LIVE_STATE.NOT_IN;
  let openDay = seed?.sessionDay || null;
  // The seed summarizes its whole day: recorded events on the seed
  // day are skipped in the walk (but kept for collision checks) so
  // the opening CLOCK_IN is never applied twice.
  const seedDay = seed?.sessionDay || null;
  const seedDayStart = seedDay
    ? Math.min(...userExisting.filter((ev) => ev.sessionDay === seedDay).map((ev) => ev.atMs), Number.POSITIVE_INFINITY)
    : null;
  // One session per day: COMPLETED resets when a new day begins.
  let completedDay = null;
  const maybeResetCompleted = (day, type) => {
    if (liveState === LIVE_STATE.COMPLETED && type === EVENT_TYPE.CLOCK_IN && day !== completedDay) {
      liveState = LIVE_STATE.NOT_IN;
      openDay = null;
    }
  };

  const dayTaken = (day, type) =>
    userExisting.some((ev) => ev.sessionDay === day && ev.type === type);

  for (const point of timeline) {
    if (point.existing) {
      if (seedDay && point.ref.sessionDay === seedDay) continue; // seed is authoritative
      maybeResetCompleted(point.ref.sessionDay, point.ref.type);
      const check = transition(liveState, point.ref.type);
      if (!check.allowed) {
        // Recorded facts never break: the imported rows sharing
        // this day conflict with reality — poison the day.
        newPoisonDay = point.ref.sessionDay;
        poisoned.add(point.ref.sessionDay);
        continue;
      }
      liveState = check.next;
      if (point.ref.type === EVENT_TYPE.CLOCK_IN) openDay = point.ref.sessionDay;
      if (point.ref.type === EVENT_TYPE.CLOCK_OUT) {
        liveState = LIVE_STATE.COMPLETED;
        completedDay = openDay || point.ref.sessionDay;
        openDay = null;
      }
      continue;
    }

    const row = point.ref;
    const provisionalDay = dayKeyOf(row.occurredMs);
    if (poisoned.has(provisionalDay)) {
      plans.set(row.line, {
        line: row.line, valid: false, sessionDay: null,
        reasonCode: 'DAY_CONFLICT',
        reason: 'Conflicts with recorded events — use regularization',
      });
      continue;
    }

    // Same-instant collision with a recorded fact.
    const clash = userExisting.find((ev) => ev.atMs === row.occurredMs);
    if (clash) {
      const identical = clash.type === row.eventType;
      plans.set(row.line, {
        line: row.line, valid: !identical ? false : true, sessionDay: identical ? clash.sessionDay : null,
        reasonCode: identical ? 'ALREADY_RECORDED' : 'COLLISION',
        reason: identical
          ? 'Already recorded — will be skipped'
          : 'Timestamp collides with a recorded event',
      });
      if (!identical) continue;
      // ALREADY_RECORDED rows keep their skip note and leave the
      // walk to the recorded twin already in the timeline.
      continue;
    }

    // No timeline inversions: a row on the open day that predates
    // the recorded session (device clock skew) goes to
    // regularization instead of silently inverting history.
    if (seedDay && provisionalDay === seedDay && Number.isFinite(seedDayStart) && row.occurredMs < seedDayStart) {
      plans.set(row.line, {
        line: row.line, valid: false, sessionDay: null,
        reasonCode: 'PREDATES_SESSION',
        reason: 'Predates the recorded session — use regularization',
      });
      continue;
    }

    // Competing sessions: import extends open sessions and fills
    // empty days — it never interleaves a rival session.
    if (row.eventType === EVENT_TYPE.CLOCK_IN && dayTaken(provisionalDay, EVENT_TYPE.CLOCK_IN)) {
      plans.set(row.line, {
        line: row.line, valid: false, sessionDay: null,
        reasonCode: 'DAY_CONFLICT',
        reason: 'Day already has a recorded clock-in — use regularization',
      });
      continue;
    }
    if (row.eventType === EVENT_TYPE.CLOCK_OUT && dayTaken(provisionalDay, EVENT_TYPE.CLOCK_OUT)) {
      plans.set(row.line, {
        line: row.line, valid: false, sessionDay: null,
        reasonCode: 'DAY_CONFLICT',
        reason: 'Day already has a recorded clock-out — use regularization',
      });
      continue;
    }

    // Day rollover: a CLOCK_IN on a later day than the open one
    // without an OUT means the earlier session never closed.
    if (row.eventType === EVENT_TYPE.CLOCK_IN && openDay && openDay !== provisionalDay) {
      plans.set(row.line, {
        line: row.line, valid: false, sessionDay: null,
        reasonCode: 'SESSION_BUSY',
        reason: 'An earlier session is still open — close or regularize it first',
      });
      continue;
    }

    maybeResetCompleted(provisionalDay, row.eventType);
    const check = transition(liveState, row.eventType);
    if (!check.allowed) {
      const noSession = liveState === LIVE_STATE.NOT_IN || liveState === LIVE_STATE.COMPLETED;
      plans.set(row.line, {
        line: row.line, valid: false, sessionDay: null,
        reasonCode: noSession && row.eventType !== EVENT_TYPE.CLOCK_IN ? 'NO_OPEN_SESSION' : 'SESSION_BUSY',
        reason: row.eventType !== EVENT_TYPE.CLOCK_IN && noSession
          ? 'No open session for this event — a CLOCK_IN must come first'
          : check.reason || 'Event breaks the attendance sequence',
      });
      continue;
    }

    liveState = check.next;
    let sessionDay = openDay;
    if (row.eventType === EVENT_TYPE.CLOCK_IN) {
      sessionDay = provisionalDay;
      openDay = provisionalDay;
    }
    if (row.eventType === EVENT_TYPE.CLOCK_OUT) {
      liveState = LIVE_STATE.COMPLETED;
      completedDay = sessionDay;
      openDay = null;
    }
    const already = plans.get(row.line);
    if (already?.reasonCode === 'ALREADY_RECORDED') continue; // keep the skip note
    plans.set(row.line, {
      line: row.line, valid: true, sessionDay, reasonCode: 'OK', reason: '',
    });
  }

  return { plans: [...plans.values()], newPoisonDay };
};
