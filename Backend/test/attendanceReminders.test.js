// ─────────────────────────────────────────────────────────────
// Phase 31.13 — attendance notifications & automation.
// Hermetic: every Mongo collaborator is an in-memory fake; the
// clock is fixed; no network, Redis, audit, or payroll. The real
// 31.6 resolver is covered by 31.6's own suite — here it is an
// injectable stub, and one test pins the seam contract.
//
// The worker modules are imported dynamically AFTER a dummy
// MONGO_URI is set: their import chain (via offerService) demands
// the variable at load time. Nothing ever connects — the URI is
// never used by these tests.
// ─────────────────────────────────────────────────────────────
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REMINDER_TYPE,
  REVIEW_REMINDER_KIND,
  SKIP_REASON,
  NOTIFICATION_BOUNDS,
  NOTIFICATION_DEFAULTS,
  REMINDER_RECONCILE_BOUNDS,
  REVIEW_PENDING_THRESHOLD_MS,
  validateNotificationsConfig,
  normalizeNotificationsConfig,
  isReminderEnabled,
  shiftStartDueMs,
  missingClockInDueMs,
  missingClockOutDueMs,
  incompleteBreakDueMs,
  evaluateShiftStartEligibility,
  evaluateMissingClockInEligibility,
  evaluateMissingClockOutEligibility,
  evaluateIncompleteBreakEligibility,
  evaluateReviewEligibility,
  evaluateFinalizationEligibility,
  toDayCompact,
  buildAttendanceReminderJobId,
  buildAttendanceReminderEventKey,
  buildReviewEventKey,
  buildFinalizationEventKey,
  ATTENDANCE_REMINDER_JOB_KEYS,
  validateAttendanceReminderPayload,
  buildReminderCopy,
  formatTimeInZone,
} from '../src/services/attendance/attendanceReminderRules.js';
import {
  loadReminderContext,
  loadActiveUser,
  scheduleShiftReminders,
  scheduleBreakReminder,
  cancelShiftReminderJobs,
  scheduleForAssignmentDays,
  deliverReminder,
  executeReminder,
  notifyRegReviewers,
  notifyOtReviewers,
  notifyFinalizationPending,
  reconcileCompanyAttendance,
  runAttendanceReminderReconcile,
} from '../src/services/attendance/attendanceReminderService.js';
import { JOB_NAMES, SCHEDULED_JOB_NAMES } from '../src/config/queueConfig.js';
let attendanceReminderProcessor;
let registerScheduledProcessors;
let validateEmailJobPayload;

before(async () => {
  if (!process.env.MONGO_URI) {
    process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/crewly-31-13-hermetic-unused';
  }
  ({ attendanceReminderProcessor, registerScheduledProcessors } = await import(
    '../src/workers/scheduledProcessor.js'
  ));
  ({ validateEmailJobPayload } = await import('../src/workers/emailProcessor.js'));
});
import { NOTIFY_CATEGORIES } from '../src/models/NotificationPref.js';
import { EVENT_TYPE } from '../src/services/attendance/attendancePolicyRules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const CID = '507f1f77bcf86cd799439011';
const UID = '507f1f77bcf86cd799439012';
const RID = '507f1f77bcf86cd799439013';
const REQ = '507f1f77bcf86cd799439014';
const OTHER_COMPANY = '507f1f77bcf86cd799439099';

const DAY = '2026-09-16';
// 09:00–18:00 IST on DAY (IST = UTC+5:30, no DST).
const START_MS = Date.parse('2026-09-16T03:30:00.000Z');
const END_MS = Date.parse('2026-09-16T12:30:00.000Z');
const MORNING_MS = Date.parse('2026-09-16T02:00:00.000Z'); // 07:30 IST
const FIXED_NOW = new Date('2026-09-16T02:00:00.000Z');
const hoursBeforeFixed = (h) => new Date(FIXED_NOW.getTime() - h * 3600 * 1000);

const ENABLED_ALL = {
  shiftStart: { enabled: true, minutesBefore: 30 },
  missingClockIn: { enabled: true, minutesAfter: 30 },
  missingClockOut: { enabled: true, minutesAfter: 30 },
  incompleteBreak: { enabled: true, minutesAfter: 45 },
};

// ── Fake collaborators ───────────────────────────────────────

const fakeQuery = (value) => {
  const q = {
    _limit: null,
    select: () => q,
    sort: () => q,
    limit: (n) => {
      q._limit = n;
      return q;
    },
    lean: async () => value,
  };
  return q;
};

const makeDeps = (overrides = {}) => {
  const calls = { enqueued: [], cancelled: [], notifications: [], emails: [], audiences: [] };
  const policy = overrides.policy === undefined ? { hasActive: true, policy: { timezone: 'Asia/Kolkata', notifications: ENABLED_ALL, breaks: { enabled: true } } } : overrides.policy;
  const deps = {
    getCurrentPolicy: async () => policy,
    preloadScheduleMasters: async () => ({}),
    resolveDaySchedule:
      overrides.resolveDaySchedule ||
      (() => ({
        status: 'RESOLVED',
        scheduledStartAt: new Date(START_MS),
        scheduledEndAt: new Date(END_MS),
        isWorkingDay: true,
      })),
    UserModel: {
      findOne: (filter) => {
        assert.equal(String(filter._id || ''), UID);
        const doc = overrides.user === undefined ? { _id: UID, companyId: CID, status: 'ACTIVE' } : overrides.user;
        // Honor the status filter like real Mongo (loadActiveUser queries ACTIVE).
        const visible = doc && (!filter.status || doc.status === filter.status) ? doc : null;
        return fakeQuery(visible);
      },
      find: () => fakeQuery(overrides.users || []),
    },
    AttendanceModel: {
      findOne: () => fakeQuery(overrides.attendance === undefined ? null : overrides.attendance),
    },
    AttendanceEventModel: {
      find: () => ({
        sort: () => ({ limit: () => ({ select: () => ({ lean: async () => overrides.breakEvents || [] }) }) }),
      }),
    },
    LeaveModel: { find: () => fakeQuery(overrides.leaves || []) },
    NotificationModel: {
      findOne: () => ({ select: () => ({ lean: async () => overrides.seen || null }) }),
      create: async (doc) => {
        if (overrides.createError) throw overrides.createError;
        calls.notifications.push(doc);
        return { _id: 'n1', ...doc };
      },
    },
    NotificationPrefModel: {
      findOne: () => ({ lean: async () => overrides.pref || null }),
    },
    RegularizationModel: { find: () => fakeQuery(overrides.regs || []) },
    OvertimeModel: { find: () => fakeQuery(overrides.ots || []) },
    PeriodModel: { find: () => fakeQuery(overrides.periods || []) },
    CompanyModel: { find: () => fakeQuery(overrides.companies || []) },
    resolveNotificationAudience: async ({ permissions }) => {
      calls.audiences.push(permissions);
      return overrides.audience === undefined ? [{ _id: RID }] : overrides.audience;
    },
    dispatch: async (args) => {
      calls.emails.push(args);
      return overrides.dispatchResult || { queued: true };
    },
    cancelScheduledJob: async (id) => {
      calls.cancelled.push(id);
      return 'removed-delayed';
    },
    ...overrides.deps,
  };
  const enqueue = async (id, data, delay) => {
    if (overrides.enqueueThrows) throw new Error('Redis down');
    calls.enqueued.push({ id, data, delay });
  };
  return { deps, calls, enqueue };
};

// ── A. Policy validation ─────────────────────────────────────

test('notifications config: absent section is valid (secure defaults apply)', () => {
  assert.deepEqual(validateNotificationsConfig(undefined), []);
  assert.deepEqual(validateNotificationsConfig(null), []);
});

test('notifications config: non-object rejected', () => {
  assert.equal(validateNotificationsConfig('yes').length, 1);
  assert.equal(validateNotificationsConfig([]).length, 1);
});

test('notifications config: enabled must be boolean', () => {
  const errors = validateNotificationsConfig({ shiftStart: { enabled: 'yes', minutesBefore: 30 } });
  assert.ok(errors.some((e) => e.includes('shiftStart.enabled')));
});

test('notifications config: minutesBefore bounds 0..180', () => {
  assert.deepEqual(validateNotificationsConfig({ shiftStart: { enabled: true, minutesBefore: 0 } }), []);
  assert.deepEqual(validateNotificationsConfig({ shiftStart: { enabled: true, minutesBefore: 180 } }), []);
  assert.ok(validateNotificationsConfig({ shiftStart: { minutesBefore: -1 } }).length);
  assert.ok(validateNotificationsConfig({ shiftStart: { minutesBefore: 181 } }).length);
  assert.ok(validateNotificationsConfig({ shiftStart: { minutesBefore: 1.5 } }).length);
});

test('notifications config: missing-* minutesAfter bounds 0..720', () => {
  assert.deepEqual(validateNotificationsConfig({ missingClockIn: { minutesAfter: 720 } }), []);
  assert.deepEqual(validateNotificationsConfig({ missingClockOut: { minutesAfter: 0 } }), []);
  assert.ok(validateNotificationsConfig({ missingClockIn: { minutesAfter: 721 } }).length);
  assert.ok(validateNotificationsConfig({ missingClockOut: { minutesAfter: -5 } }).length);
});

test('notifications config: break threshold minimum is 15 (no instant nag)', () => {
  assert.deepEqual(validateNotificationsConfig({ incompleteBreak: { minutesAfter: 15 } }), []);
  assert.deepEqual(validateNotificationsConfig({ incompleteBreak: { minutesAfter: 720 } }), []);
  assert.ok(validateNotificationsConfig({ incompleteBreak: { minutesAfter: 14 } }).length);
  assert.ok(validateNotificationsConfig({ incompleteBreak: { minutesAfter: 0 } }).length);
});

test('notifications config: section must be an object when present', () => {
  assert.ok(validateNotificationsConfig({ missingClockIn: true }).some((e) => e.includes('missingClockIn')));
});

test('normalize: null → all disabled with documented defaults', () => {
  const config = normalizeNotificationsConfig(null);
  assert.equal(config.shiftStart.enabled, false);
  assert.equal(config.shiftStart.minutesBefore, NOTIFICATION_DEFAULTS.shiftStart.minutesBefore);
  assert.equal(config.missingClockIn.enabled, false);
  assert.equal(config.missingClockOut.enabled, false);
  assert.equal(config.incompleteBreak.enabled, false);
  assert.equal(config.incompleteBreak.minutesAfter, NOTIFICATION_DEFAULTS.incompleteBreak.minutesAfter);
});

test('normalize: partial old-doc configs merge over defaults', () => {
  const config = normalizeNotificationsConfig({ shiftStart: { enabled: true } });
  assert.equal(config.shiftStart.enabled, true);
  assert.equal(config.shiftStart.minutesBefore, 30);
  assert.equal(config.missingClockIn.enabled, false);
});

test('normalize: enabled requires strict true (truthy junk stays off)', () => {
  const config = normalizeNotificationsConfig({ shiftStart: { enabled: 'yes', minutesBefore: 30 } });
  assert.equal(config.shiftStart.enabled, false);
});

test('normalize: non-integer minutes fall back to defaults', () => {
  const config = normalizeNotificationsConfig({ shiftStart: { enabled: true, minutesBefore: 'soon' } });
  assert.equal(config.shiftStart.minutesBefore, 30);
});

test('isReminderEnabled: per-type gating + unknown type is off', () => {
  assert.equal(isReminderEnabled(ENABLED_ALL, REMINDER_TYPE.SHIFT_START), true);
  assert.equal(isReminderEnabled(ENABLED_ALL, REMINDER_TYPE.INCOMPLETE_BREAK), true);
  assert.equal(isReminderEnabled(null, REMINDER_TYPE.SHIFT_START), false);
  assert.equal(isReminderEnabled(ENABLED_ALL, 'NOPE'), false);
  assert.equal(
    isReminderEnabled({ ...ENABLED_ALL, shiftStart: { enabled: false, minutesBefore: 30 } }, REMINDER_TYPE.SHIFT_START),
    false
  );
});

test('bounds constants are the documented reasonable maximums', () => {
  assert.deepEqual(NOTIFICATION_BOUNDS.minutesBefore, { min: 0, max: 180 });
  assert.deepEqual(NOTIFICATION_BOUNDS.minutesAfter, { min: 0, max: 720 });
  assert.deepEqual(NOTIFICATION_BOUNDS.breakMinutesAfter, { min: 15, max: 720 });
  assert.equal(REVIEW_PENDING_THRESHOLD_MS, 24 * 3600 * 1000);
});

// ── B. Due calculators ───────────────────────────────────────

test('due: shift-start = anchor − minutesBefore', () => {
  assert.equal(shiftStartDueMs(START_MS, ENABLED_ALL), START_MS - 30 * 60000);
});

test('due: missing-in = anchor + minutesAfter', () => {
  assert.equal(missingClockInDueMs(START_MS, ENABLED_ALL), START_MS + 30 * 60000);
});

test('due: missing-out uses the END anchor (overnight-safe, pure arithmetic)', () => {
  // Night shift ending 02:00 IST next day: the end anchor is already
  // the next-day instant — no calendar guessing in the calculator.
  const endNextDay = Date.parse('2026-09-17T20:30:00.000Z');
  assert.equal(missingClockOutDueMs(endNextDay, ENABLED_ALL), endNextDay + 30 * 60000);
  assert.equal(missingClockOutDueMs(END_MS, ENABLED_ALL), END_MS + 30 * 60000);
});

test('due: break = break start + policy threshold', () => {
  const breakStart = Date.parse('2026-09-16T07:00:00.000Z');
  assert.equal(incompleteBreakDueMs(breakStart, ENABLED_ALL), breakStart + 45 * 60000);
});

test('due: invalid anchors → null (caller skips, never schedules)', () => {
  assert.equal(shiftStartDueMs(null, ENABLED_ALL), null);
  assert.equal(missingClockInDueMs('not-a-date', ENABLED_ALL), null);
  assert.equal(missingClockOutDueMs(-5, ENABLED_ALL), null);
  assert.equal(incompleteBreakDueMs(undefined, ENABLED_ALL), null);
});

test('due: missing config falls back to secure defaults', () => {
  assert.equal(shiftStartDueMs(START_MS, null), START_MS - 30 * 60000);
  assert.equal(incompleteBreakDueMs(START_MS, {}), START_MS + 45 * 60000);
});

// ── C. Eligibility ───────────────────────────────────────────

test('eligibility: shift-start happy path', () => {
  const v = evaluateShiftStartEligibility({
    policyEnabled: true,
    isWorkDay: true,
    onApprovedLeave: false,
    anchorChanged: false,
    hasClockedIn: false,
  });
  assert.deepEqual(v, { eligible: true, reason: null });
});

test('eligibility: shift-start vetoes', () => {
  const base = { policyEnabled: true, isWorkDay: true, onApprovedLeave: false, anchorChanged: false, hasClockedIn: false };
  assert.equal(evaluateShiftStartEligibility({ ...base, policyEnabled: false }).reason, SKIP_REASON.POLICY_DISABLED);
  assert.equal(evaluateShiftStartEligibility({ ...base, isWorkDay: false }).reason, SKIP_REASON.NOT_A_WORK_DAY);
  assert.equal(evaluateShiftStartEligibility({ ...base, onApprovedLeave: true }).reason, SKIP_REASON.ON_APPROVED_LEAVE);
  assert.equal(evaluateShiftStartEligibility({ ...base, anchorChanged: true }).reason, SKIP_REASON.ANCHOR_CHANGED);
  assert.equal(evaluateShiftStartEligibility({ ...base, hasClockedIn: true }).reason, SKIP_REASON.ALREADY_CLOCKED_IN);
});

test('eligibility: missing-in happy path + clocked-in veto', () => {
  const base = { policyEnabled: true, isWorkDay: true, onApprovedLeave: false, anchorChanged: false, hasClockedIn: false };
  assert.equal(evaluateMissingClockInEligibility(base).eligible, true);
  assert.equal(
    evaluateMissingClockInEligibility({ ...base, hasClockedIn: true }).reason,
    SKIP_REASON.ALREADY_CLOCKED_IN
  );
  assert.equal(
    evaluateMissingClockInEligibility({ ...base, onApprovedLeave: true }).reason,
    SKIP_REASON.ON_APPROVED_LEAVE
  );
});

test('eligibility: missing-out requires an open day (in, not out)', () => {
  const open = { policyEnabled: true, isWorkDay: true, onApprovedLeave: false, anchorChanged: false, hasClockedIn: true, hasClockedOut: false };
  assert.equal(evaluateMissingClockOutEligibility(open).eligible, true);
  assert.equal(
    evaluateMissingClockOutEligibility({ ...open, hasClockedOut: true }).reason,
    SKIP_REASON.ALREADY_CLOCKED_OUT
  );
  assert.equal(
    evaluateMissingClockOutEligibility({ ...open, hasClockedIn: false }).reason,
    SKIP_REASON.NO_CLOCK_IN
  );
});

test('eligibility: break requires policy + enabled breaks + open anchor', () => {
  const open = { policyEnabled: true, breaksEnabled: true, anchorChanged: false, breakStillOpen: true };
  assert.equal(evaluateIncompleteBreakEligibility(open).eligible, true);
  assert.equal(
    evaluateIncompleteBreakEligibility({ ...open, breakStillOpen: false }).reason,
    SKIP_REASON.BREAK_CLOSED
  );
  assert.equal(
    evaluateIncompleteBreakEligibility({ ...open, breaksEnabled: false }).reason,
    SKIP_REASON.BREAKS_DISABLED
  );
  assert.equal(
    evaluateIncompleteBreakEligibility({ ...open, anchorChanged: true }).reason,
    SKIP_REASON.ANCHOR_CHANGED
  );
  assert.equal(
    evaluateIncompleteBreakEligibility({ ...open, policyEnabled: false }).reason,
    SKIP_REASON.POLICY_DISABLED
  );
});

test('eligibility: review needs PENDING older than 24h', () => {
  const now = Date.now();
  assert.equal(
    evaluateReviewEligibility({ status: 'PENDING', pendingSinceMs: now - 25 * 3600 * 1000, nowMs: now }).eligible,
    true
  );
  assert.equal(
    evaluateReviewEligibility({ status: 'PENDING', pendingSinceMs: now - 3600 * 1000, nowMs: now }).reason,
    SKIP_REASON.NOT_YET_DUE
  );
  assert.equal(
    evaluateReviewEligibility({ status: 'APPROVED', pendingSinceMs: now - 99 * 3600 * 1000, nowMs: now }).reason,
    SKIP_REASON.NOT_PENDING_ANYMORE
  );
  assert.equal(evaluateReviewEligibility({ status: 'PENDING', pendingSinceMs: null, nowMs: now }).reason, SKIP_REASON.NOT_PENDING_ANYMORE);
});

test('eligibility: finalization needs OPEN/REOPENED + elapsed month', () => {
  assert.equal(evaluateFinalizationEligibility({ periodStatus: 'OPEN', monthElapsed: true }).eligible, true);
  assert.equal(evaluateFinalizationEligibility({ periodStatus: 'REOPENED', monthElapsed: true }).eligible, true);
  assert.equal(
    evaluateFinalizationEligibility({ periodStatus: 'FINALIZED', monthElapsed: true }).reason,
    SKIP_REASON.PERIOD_FINALIZED
  );
  assert.equal(
    evaluateFinalizationEligibility({ periodStatus: 'SENT_TO_PAYROLL', monthElapsed: true }).reason,
    SKIP_REASON.PERIOD_FINALIZED
  );
  assert.equal(
    evaluateFinalizationEligibility({ periodStatus: 'OPEN', monthElapsed: false }).reason,
    SKIP_REASON.MONTH_NOT_ELAPSED
  );
});

// ── D. Ids + keys ────────────────────────────────────────────

test('jobId: deterministic, colon-free, lowercase', () => {
  const a = buildAttendanceReminderJobId(UID, REMINDER_TYPE.SHIFT_START, DAY, START_MS);
  const b = buildAttendanceReminderJobId(UID.toUpperCase(), REMINDER_TYPE.SHIFT_START, DAY, START_MS);
  assert.equal(a, b);
  assert.ok(a.startsWith('attendance-reminder-'));
  assert.ok(!a.includes(':'));
  assert.ok(a.includes('shift_start'));
  assert.ok(a.includes('20260916'));
  assert.ok(a.includes(String(START_MS)));
});

test('jobId: distinct per type/day/anchor (schedule change → new id, old goes stale)', () => {
  const a = buildAttendanceReminderJobId(UID, REMINDER_TYPE.SHIFT_START, DAY, START_MS);
  assert.notEqual(a, buildAttendanceReminderJobId(UID, REMINDER_TYPE.MISSING_CLOCK_IN, DAY, START_MS));
  assert.notEqual(a, buildAttendanceReminderJobId(UID, REMINDER_TYPE.SHIFT_START, '2026-09-17', START_MS));
  assert.notEqual(a, buildAttendanceReminderJobId(UID, REMINDER_TYPE.SHIFT_START, DAY, START_MS + 60000));
});

test('jobId: rejects malformed refs', () => {
  assert.equal(buildAttendanceReminderJobId('nope', REMINDER_TYPE.SHIFT_START, DAY, START_MS), null);
  assert.equal(buildAttendanceReminderJobId(UID, 'NOPE', DAY, START_MS), null);
  assert.equal(buildAttendanceReminderJobId(UID, REMINDER_TYPE.SHIFT_START, '16-09-2026', START_MS), null);
  assert.equal(buildAttendanceReminderJobId(UID, REMINDER_TYPE.SHIFT_START, DAY, null), null);
});

test('eventKey: shape + rejects bad company', () => {
  const key = buildAttendanceReminderEventKey(CID, REMINDER_TYPE.MISSING_CLOCK_OUT, UID, DAY, END_MS);
  assert.equal(key, `attendance:missing_clock_out:${CID}:${UID}:20260916:${END_MS}`);
  assert.equal(buildAttendanceReminderEventKey('bad', REMINDER_TYPE.SHIFT_START, UID, DAY, START_MS), null);
});

test('review key: per-recipient (shared keys would starve co-reviewers)', () => {
  const a = buildReviewEventKey(CID, REVIEW_REMINDER_KIND.REG_REVIEW, REQ, RID);
  const b = buildReviewEventKey(CID, REVIEW_REMINDER_KIND.REG_REVIEW, REQ, UID);
  assert.ok(a.includes('reg_review'));
  assert.notEqual(a, b);
  assert.equal(buildReviewEventKey(CID, REVIEW_REMINDER_KIND.REG_REVIEW, REQ, null), null);
  assert.equal(buildReviewEventKey(CID, 'NOPE', REQ, RID), null);
});

test('finalization key: per-recipient per month + bad month rejected', () => {
  const key = buildFinalizationEventKey(CID, '2026-08', RID);
  assert.equal(key, `attendance:finalization_pending:${CID}:2026-08:${RID}`);
  assert.equal(buildFinalizationEventKey(CID, '2026-13', RID), null);
  assert.equal(buildFinalizationEventKey(CID, '2026-08', null), null);
});

test('toDayCompact: strict YYYY-MM-DD only', () => {
  assert.equal(toDayCompact('2026-09-16'), '20260916');
  assert.equal(toDayCompact('2026-9-6'), '');
  assert.equal(toDayCompact(''), '');
  assert.equal(toDayCompact(null), '');
});

// ── E. Payload validator ─────────────────────────────────────

const validPayload = () => ({
  companyId: CID,
  employeeId: UID,
  attendanceDate: DAY,
  reminderType: REMINDER_TYPE.SHIFT_START,
  anchorIso: new Date(START_MS).toISOString(),
  correlationId: 'corr-1',
});

test('payload: the exact allowlist is references only (6 keys)', () => {
  assert.deepEqual([...ATTENDANCE_REMINDER_JOB_KEYS].sort(), [
    'anchorIso',
    'attendanceDate',
    'companyId',
    'correlationId',
    'employeeId',
    'reminderType',
  ]);
});

test('payload: valid reference-only payload passes', () => {
  assert.deepEqual(validateAttendanceReminderPayload(validPayload()), { valid: true, errors: [] });
});

test('payload: PII/body keys fail closed', () => {
  for (const smuggled of ['email', 'phone', 'message', 'title', 'body', 'coordinates', 'latitude', 'salary', 'amount', 'reason', 'location', 'name']) {
    const check = validateAttendanceReminderPayload({ ...validPayload(), [smuggled]: 'x' });
    assert.equal(check.valid, false, `key ${smuggled} must be rejected`);
  }
});

test('payload: non-objects fail', () => {
  assert.equal(validateAttendanceReminderPayload(null).valid, false);
  assert.equal(validateAttendanceReminderPayload('x').valid, false);
  assert.equal(validateAttendanceReminderPayload([]).valid, false);
});

test('payload: missing keys fail', () => {
  const { anchorIso, ...rest } = validPayload();
  const check = validateAttendanceReminderPayload(rest);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.includes('anchorIso')));
});

test('payload: malformed refs fail', () => {
  assert.equal(validateAttendanceReminderPayload({ ...validPayload(), companyId: 'bad' }).valid, false);
  assert.equal(validateAttendanceReminderPayload({ ...validPayload(), employeeId: 'bad' }).valid, false);
  assert.equal(validateAttendanceReminderPayload({ ...validPayload(), attendanceDate: 'yesterday' }).valid, false);
  assert.equal(validateAttendanceReminderPayload({ ...validPayload(), reminderType: 'SHIFT' }).valid, false);
  assert.equal(validateAttendanceReminderPayload({ ...validPayload(), anchorIso: 'soon' }).valid, false);
});

// ── F. Copy ──────────────────────────────────────────────────

test('copy: shift-start carries the zone-formatted time label', () => {
  const copy = buildReminderCopy(REMINDER_TYPE.SHIFT_START, { timeLabel: '9:00 AM' });
  assert.ok(copy.message.includes('9:00 AM'));
  assert.equal(copy.link, '/app/attendance');
});

test('copy: break carries minutes-open; reviewer links route to queues', () => {
  const copy = buildReminderCopy(REMINDER_TYPE.INCOMPLETE_BREAK, { minutesOpen: 50 });
  assert.ok(copy.message.includes('50'));
  assert.equal(buildReminderCopy(REVIEW_REMINDER_KIND.REG_REVIEW).link, '/app/attendance/regularizations');
  assert.equal(buildReminderCopy(REVIEW_REMINDER_KIND.OT_REVIEW).link, '/app/attendance/overtime');
});

test('copy: finalization names the month + state, never money', () => {
  const copy = buildReminderCopy(REVIEW_REMINDER_KIND.FINALIZATION_PENDING, { month: '2026-08', periodStatus: 'open' });
  assert.ok(copy.message.includes('2026-08'));
  assert.ok(!copy.message.includes('₹') && !copy.message.includes('salary'));
});

test('copy: neutral vocabulary (no location/money/reason words anywhere)', () => {
  const bodies = [
    buildReminderCopy(REMINDER_TYPE.SHIFT_START, { timeLabel: '9:00 AM' }),
    buildReminderCopy(REMINDER_TYPE.MISSING_CLOCK_IN),
    buildReminderCopy(REMINDER_TYPE.MISSING_CLOCK_OUT),
    buildReminderCopy(REMINDER_TYPE.INCOMPLETE_BREAK, { minutesOpen: 45 }),
    buildReminderCopy(REVIEW_REMINDER_KIND.REG_REVIEW),
    buildReminderCopy(REVIEW_REMINDER_KIND.OT_REVIEW),
    buildReminderCopy(REVIEW_REMINDER_KIND.FINALIZATION_PENDING, { month: '2026-08' }),
  ].map((c) => `${c.title} ${c.message}`.toLowerCase());
  for (const body of bodies) {
    for (const banned of ['gps', 'track', 'salary', '₹', 'reason:', 'latitude', 'penalty']) {
      assert.ok(!body.includes(banned), `copy must not contain "${banned}": ${body}`);
    }
  }
});

test('formatTimeInZone: zone-aware label with UTC fallback', () => {
  assert.equal(formatTimeInZone(START_MS, 'Asia/Kolkata'), '9:00 AM');
  assert.equal(formatTimeInZone('bad', 'Asia/Kolkata'), '');
  assert.ok(formatTimeInZone(START_MS, 'Not/AZone').length > 0);
});

// ── G. Scheduling ────────────────────────────────────────────

test('schedule: morning reconcile queues all three shift legs with exact payloads', async () => {
  const { deps, calls, enqueue } = makeDeps();
  const outcome = await scheduleShiftReminders({
    companyId: CID,
    user: { _id: UID },
    day: DAY,
    enqueue,
    nowMs: MORNING_MS,
    deps,
  });
  assert.equal(outcome.results.length, 3);
  assert.ok(outcome.results.every((r) => r.scheduled), JSON.stringify(outcome.results));
  assert.equal(calls.enqueued.length, 3);
  for (const job of calls.enqueued) {
    assert.deepEqual(Object.keys(job.data).sort(), [...ATTENDANCE_REMINDER_JOB_KEYS].sort());
    assert.equal(job.data.companyId, CID);
    assert.equal(job.data.employeeId, UID);
  }
  const byType = Object.fromEntries(outcome.results.map((r) => [r.type, r]));
  assert.equal(byType[REMINDER_TYPE.SHIFT_START].dueAt, new Date(START_MS - 30 * 60000).toISOString());
  assert.equal(byType[REMINDER_TYPE.MISSING_CLOCK_IN].dueAt, new Date(START_MS + 30 * 60000).toISOString());
  assert.equal(byType[REMINDER_TYPE.MISSING_CLOCK_OUT].dueAt, new Date(END_MS + 30 * 60000).toISOString());
});

test('schedule: deterministic job ids (reconcile re-runs dedupe in BullMQ)', async () => {
  const first = makeDeps();
  const second = makeDeps();
  const args = { companyId: CID, user: { _id: UID }, day: DAY, nowMs: MORNING_MS };
  const a = await scheduleShiftReminders({ ...args, enqueue: first.enqueue, deps: first.deps });
  const b = await scheduleShiftReminders({ ...args, enqueue: second.enqueue, deps: second.deps });
  assert.deepEqual(
    a.results.map((r) => r.jobId),
    b.results.map((r) => r.jobId)
  );
});

test('schedule: disabled types skip with POLICY_DISABLED (others still queue)', async () => {
  const partial = { ...ENABLED_ALL, missingClockOut: { enabled: false, minutesAfter: 30 } };
  const { deps, calls, enqueue } = makeDeps({
    policy: { hasActive: true, policy: { timezone: 'Asia/Kolkata', notifications: partial, breaks: { enabled: true } } },
  });
  const outcome = await scheduleShiftReminders({ companyId: CID, user: { _id: UID }, day: DAY, enqueue, nowMs: MORNING_MS, deps });
  const byType = Object.fromEntries(outcome.results.map((r) => [r.type, r]));
  assert.equal(byType[REMINDER_TYPE.MISSING_CLOCK_OUT].scheduled, false);
  assert.equal(byType[REMINDER_TYPE.MISSING_CLOCK_OUT].reason, SKIP_REASON.POLICY_DISABLED);
  assert.equal(byType[REMINDER_TYPE.SHIFT_START].scheduled, true);
  assert.equal(calls.enqueued.length, 2);
});

test('schedule: no active policy → NO_POLICY, nothing queued', async () => {
  const { deps, calls, enqueue } = makeDeps({ policy: { hasActive: false, policy: null } });
  const outcome = await scheduleShiftReminders({ companyId: CID, user: { _id: UID }, day: DAY, enqueue, nowMs: MORNING_MS, deps });
  assert.ok(outcome.results.every((r) => !r.scheduled && r.reason === SKIP_REASON.NO_POLICY));
  assert.equal(calls.enqueued.length, 0);
});

test('schedule: non-work day and approved leave skip everything', async () => {
  const off = makeDeps({ resolveDaySchedule: () => ({ status: 'RESOLVED', isWorkingDay: false }) });
  const offOutcome = await scheduleShiftReminders({ companyId: CID, user: { _id: UID }, day: DAY, enqueue: off.enqueue, nowMs: MORNING_MS, deps: off.deps });
  assert.ok(offOutcome.results.every((r) => r.reason === SKIP_REASON.NOT_A_WORK_DAY));

  const leave = makeDeps({ leaves: [{ status: 'APPROVED', startDate: DAY, endDate: DAY }] });
  const leaveOutcome = await scheduleShiftReminders({ companyId: CID, user: { _id: UID }, day: DAY, enqueue: leave.enqueue, nowMs: MORNING_MS, deps: leave.deps });
  assert.ok(leaveOutcome.results.every((r) => r.reason === SKIP_REASON.ON_APPROVED_LEAVE));
  assert.equal(leave.calls.enqueued.length, 0);
});

test('schedule: past-due shift-start skips (missing-in owns late arrivals)', async () => {
  const { deps, enqueue } = makeDeps();
  const outcome = await scheduleShiftReminders({
    companyId: CID,
    user: { _id: UID },
    day: DAY,
    enqueue,
    nowMs: START_MS + 60000,
    deps,
  });
  const byType = Object.fromEntries(outcome.results.map((r) => [r.type, r]));
  assert.equal(byType[REMINDER_TYPE.SHIFT_START].scheduled, false);
  assert.equal(byType[REMINDER_TYPE.SHIFT_START].reason, 'PAST_DUE');
  // Missing legs fire immediately when already due (delay clamps to 0).
  assert.equal(byType[REMINDER_TYPE.MISSING_CLOCK_IN].scheduled, true);
});

test('schedule: already-punched day skips in-legs but still queues missing-out when open', async () => {
  const { deps, enqueue } = makeDeps({
    attendance: { punchIn: new Date(START_MS), punchOut: null },
  });
  const outcome = await scheduleShiftReminders({ companyId: CID, user: { _id: UID }, day: DAY, enqueue, nowMs: MORNING_MS, deps });
  const byType = Object.fromEntries(outcome.results.map((r) => [r.type, r]));
  assert.equal(byType[REMINDER_TYPE.SHIFT_START].reason, SKIP_REASON.ALREADY_CLOCKED_IN);
  assert.equal(byType[REMINDER_TYPE.MISSING_CLOCK_IN].reason, SKIP_REASON.ALREADY_CLOCKED_IN);
  assert.equal(byType[REMINDER_TYPE.MISSING_CLOCK_OUT].scheduled, true);
});

test('schedule: missing-out does NOT require a clock-in yet (morning reconcile)', async () => {
  const { deps, enqueue } = makeDeps({ attendance: null });
  const outcome = await scheduleShiftReminders({ companyId: CID, user: { _id: UID }, day: DAY, enqueue, nowMs: MORNING_MS, deps });
  const missingOut = outcome.results.find((r) => r.type === REMINDER_TYPE.MISSING_CLOCK_OUT);
  assert.equal(missingOut.scheduled, true);
});

test('schedule: closed day skips missing-out; already-notified skips requeue', async () => {
  const closed = makeDeps({ attendance: { punchIn: new Date(START_MS), punchOut: new Date(END_MS) } });
  const closedOutcome = await scheduleShiftReminders({ companyId: CID, user: { _id: UID }, day: DAY, enqueue: closed.enqueue, nowMs: MORNING_MS, deps: closed.deps });
  assert.equal(
    closedOutcome.results.find((r) => r.type === REMINDER_TYPE.MISSING_CLOCK_OUT).reason,
    SKIP_REASON.ALREADY_CLOCKED_OUT
  );

  const seen = makeDeps({ seen: { _id: 'n1' } });
  const seenOutcome = await scheduleShiftReminders({ companyId: CID, user: { _id: UID }, day: DAY, enqueue: seen.enqueue, nowMs: MORNING_MS, deps: seen.deps });
  assert.ok(seenOutcome.results.every((r) => r.reason === SKIP_REASON.ALREADY_NOTIFIED));
  assert.equal(seen.calls.enqueued.length, 0);
});

test('schedule: queue down → QUEUE_UNAVAILABLE, never throws (Redis-degraded)', async () => {
  const { deps, enqueue } = makeDeps({ enqueueThrows: true });
  const outcome = await scheduleShiftReminders({ companyId: CID, user: { _id: UID }, day: DAY, enqueue, nowMs: MORNING_MS, deps });
  assert.ok(outcome.results.every((r) => !r.scheduled && r.reason === 'QUEUE_UNAVAILABLE'));
});

test('schedule: invalid refs fail closed without touching the queue', async () => {
  const { deps, calls, enqueue } = makeDeps();
  const outcome = await scheduleShiftReminders({ companyId: 'bad', user: { _id: UID }, day: DAY, enqueue, nowMs: MORNING_MS, deps });
  assert.ok(outcome.results.every((r) => !r.scheduled));
  assert.equal(calls.enqueued.length, 0);
});

test('scheduleBreak: happy path queues one threshold-backed job', async () => {
  const { deps, calls, enqueue } = makeDeps();
  const breakStart = new Date('2026-09-16T07:00:00.000Z');
  const outcome = await scheduleBreakReminder({ companyId: CID, userId: UID, day: DAY, breakStartAt: breakStart, enqueue, deps });
  assert.equal(outcome.scheduled, true);
  assert.ok(outcome.jobId.includes('incomplete_break'));
  assert.equal(outcome.dueAt, new Date(breakStart.getTime() + 45 * 60000).toISOString());
  assert.equal(calls.enqueued.length, 1);
  assert.deepEqual(Object.keys(calls.enqueued[0].data).sort(), [...ATTENDANCE_REMINDER_JOB_KEYS].sort());
});

test('scheduleBreak: policy-off or breaks-disabled skips', async () => {
  const off = makeDeps({
    policy: { hasActive: true, policy: { timezone: 'Asia/Kolkata', notifications: { ...ENABLED_ALL, incompleteBreak: { enabled: false, minutesAfter: 45 } }, breaks: { enabled: true } } },
  });
  const r1 = await scheduleBreakReminder({ companyId: CID, userId: UID, day: DAY, breakStartAt: new Date(START_MS), enqueue: off.enqueue, deps: off.deps });
  assert.equal(r1.reason, SKIP_REASON.POLICY_DISABLED);

  const breaksOff = makeDeps({
    policy: { hasActive: true, policy: { timezone: 'Asia/Kolkata', notifications: ENABLED_ALL, breaks: { enabled: false } } },
  });
  const r2 = await scheduleBreakReminder({ companyId: CID, userId: UID, day: DAY, breakStartAt: new Date(START_MS), enqueue: breaksOff.enqueue, deps: breaksOff.deps });
  assert.equal(r2.reason, SKIP_REASON.BREAKS_DISABLED);
});

test('cancel: snapshot anchors rebuild exact job ids; failures never throw', async () => {
  const { deps, calls } = makeDeps({
    attendance: { scheduleSnapshot: { scheduledStartAt: new Date(START_MS), scheduledEndAt: new Date(END_MS) } },
  });
  const results = await cancelShiftReminderJobs({ companyId: CID, userId: UID, day: DAY, deps });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.result === 'removed-delayed'));
  assert.deepEqual(
    calls.cancelled,
    results.map((r) => r.jobId)
  );
  assert.ok(calls.cancelled[0].includes(String(START_MS)));
});

test('cancel: unresolvable anchors → unknown (worker guard is the real protection)', async () => {
  const { deps, calls } = makeDeps({
    attendance: null,
    resolveDaySchedule: () => ({ status: 'UNRESOLVED' }),
  });
  const results = await cancelShiftReminderJobs({ companyId: CID, userId: UID, day: DAY, deps });
  assert.ok(results.every((r) => r.result === 'unknown' && r.jobId === null));
  assert.equal(calls.cancelled.length, 0);
});

test('scheduleForAssignmentDays: bounded horizon, masters preloaded once', async () => {
  let preloads = 0;
  const { deps, calls, enqueue } = makeDeps({
    deps: {
      preloadScheduleMasters: async () => {
        preloads += 1;
        return {};
      },
    },
  });
  const summary = await scheduleForAssignmentDays({
    companyId: CID,
    users: [{ _id: UID }],
    fromDay: DAY,
    days: 2,
    enqueue,
    nowMs: MORNING_MS,
    deps,
  });
  assert.equal(preloads, 1);
  assert.equal(summary.users, 1);
  assert.equal(summary.days, 2);
  // Day 1 resolves (stub); day 2 also resolves (stub ignores the date).
  assert.equal(summary.queued, 6);
  assert.equal(calls.enqueued.length, 6);
});

// ── H. Execute + deliver ─────────────────────────────────────

test('execute: shift-start happy path delivers in-app + email with one eventKey', async () => {
  const { deps, calls } = makeDeps();
  const result = await executeReminder(
    {
      companyId: CID,
      employeeId: UID,
      attendanceDate: DAY,
      reminderType: REMINDER_TYPE.SHIFT_START,
      anchorIso: new Date(START_MS).toISOString(),
    },
    deps
  );
  assert.equal(result.processed, true);
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.emails.length, 1);
  const bell = calls.notifications[0];
  assert.equal(bell.type, 'ATTENDANCE');
  assert.ok(bell.title.length <= 120 && bell.message.length <= 300);
  assert.equal(bell.link, '/app/attendance');
  assert.equal(bell.eventKey, calls.emails[0].eventKey);
  assert.equal(calls.emails[0].jobName, JOB_NAMES.EMAIL_ATTENDANCE_REMINDER);
  assert.equal(String(calls.emails[0].recipientReference), UID);
  assert.equal(calls.emails[0].payload.reminderType, REMINDER_TYPE.SHIFT_START);
});

test('execute: cross-tenant payload fails closed (recipient re-derived from Mongo)', async () => {
  const { deps, calls } = makeDeps({
    user: { _id: UID, companyId: OTHER_COMPANY, status: 'ACTIVE' },
  });
  const result = await executeReminder(
    {
      companyId: CID,
      employeeId: UID,
      attendanceDate: DAY,
      reminderType: REMINDER_TYPE.SHIFT_START,
      anchorIso: new Date(START_MS).toISOString(),
    },
    deps
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, SKIP_REASON.EMPLOYEE_INACTIVE);
  assert.equal(calls.notifications.length, 0);
  assert.equal(calls.emails.length, 0);
});

test('execute: business skips (inactive / no-policy / disabled / unresolved / stale / leave / resolved)', async () => {
  const base = {
    companyId: CID,
    employeeId: UID,
    attendanceDate: DAY,
    reminderType: REMINDER_TYPE.MISSING_CLOCK_IN,
    anchorIso: new Date(START_MS).toISOString(),
  };
  const run = (overrides) => {
    const { deps } = makeDeps(overrides);
    return executeReminder(base, deps);
  };
  assert.equal((await run({ user: null })).reason, SKIP_REASON.EMPLOYEE_INACTIVE);
  assert.equal((await run({ user: { _id: UID, companyId: CID, status: 'INACTIVE' } })).reason, SKIP_REASON.EMPLOYEE_INACTIVE);
  assert.equal((await run({ policy: { hasActive: false, policy: null } })).reason, SKIP_REASON.NO_POLICY);
  assert.equal(
    (
      await run({
        policy: { hasActive: true, policy: { timezone: 'Asia/Kolkata', notifications: { ...ENABLED_ALL, missingClockIn: { enabled: false, minutesAfter: 30 } }, breaks: { enabled: true } } },
      })
    ).reason,
    SKIP_REASON.POLICY_DISABLED
  );
  assert.equal((await run({ resolveDaySchedule: () => ({ status: 'UNRESOLVED' }) })).reason, SKIP_REASON.NOT_A_WORK_DAY);
  const stale = makeDeps();
  const staleResult = await executeReminder({ ...base, anchorIso: new Date(START_MS + 3600000).toISOString() }, stale.deps);
  assert.equal(staleResult.reason, SKIP_REASON.ANCHOR_CHANGED);
  assert.equal((await run({ leaves: [{ status: 'APPROVED', startDate: DAY, endDate: DAY }] })).reason, SKIP_REASON.ON_APPROVED_LEAVE);
  assert.equal((await run({ attendance: { punchIn: new Date(START_MS) } })).reason, SKIP_REASON.ALREADY_CLOCKED_IN);
});

test('execute: missing-out needs an open day at execution', async () => {
  const base = {
    companyId: CID,
    employeeId: UID,
    attendanceDate: DAY,
    reminderType: REMINDER_TYPE.MISSING_CLOCK_OUT,
    anchorIso: new Date(END_MS).toISOString(),
  };
  const open = makeDeps({ attendance: { punchIn: new Date(START_MS), punchOut: null } });
  assert.equal((await executeReminder(base, open.deps)).processed, true);
  const neverIn = makeDeps({ attendance: null });
  assert.equal((await executeReminder(base, neverIn.deps)).reason, SKIP_REASON.NO_CLOCK_IN);
  const closed = makeDeps({ attendance: { punchIn: new Date(START_MS), punchOut: new Date(END_MS) } });
  assert.equal((await executeReminder(base, closed.deps)).reason, SKIP_REASON.ALREADY_CLOCKED_OUT);
});

test('execute: break leg follows the event ledger (open → deliver, closed → skip)', async () => {
  const breakStart = new Date('2026-09-16T07:00:00.000Z');
  const base = {
    companyId: CID,
    employeeId: UID,
    attendanceDate: DAY,
    reminderType: REMINDER_TYPE.INCOMPLETE_BREAK,
    anchorIso: breakStart.toISOString(),
  };
  const open = makeDeps({ breakEvents: [{ type: EVENT_TYPE.BREAK_START, at: breakStart }] });
  const delivered = await executeReminder(base, open.deps);
  assert.equal(delivered.processed, true);
  assert.ok(open.calls.notifications[0].message.includes('minute'));

  const closed = makeDeps({ breakEvents: [{ type: EVENT_TYPE.BREAK_END, at: new Date() }] });
  assert.equal((await executeReminder(base, closed.deps)).reason, SKIP_REASON.BREAK_CLOSED);

  const restarted = makeDeps({ breakEvents: [{ type: EVENT_TYPE.BREAK_START, at: new Date('2026-09-16T08:00:00.000Z') }] });
  assert.equal((await executeReminder(base, restarted.deps)).reason, SKIP_REASON.ANCHOR_CHANGED);
});

test('deliver: fully muted user → nothing sent, nothing consumed', async () => {
  const { deps, calls } = makeDeps({ pref: { inapp: { ATTENDANCE: false }, email: { ATTENDANCE: false } } });
  const outcome = await deliverReminder({
    companyId: CID,
    userId: UID,
    kind: REMINDER_TYPE.SHIFT_START,
    eventKey: 'k1',
    entityId: UID,
    deps,
  });
  assert.equal(outcome.dispatched, false);
  assert.equal(outcome.inapp, 'muted');
  assert.equal(outcome.email, 'muted');
  assert.equal(calls.notifications.length, 0);
  assert.equal(calls.emails.length, 0);
});

test('deliver: per-channel prefs honored independently (Mongoose Map + POJO shapes)', async () => {
  const mapPref = makeDeps({ pref: { inapp: new Map([['ATTENDANCE', false]]), email: new Map() } });
  const r1 = await deliverReminder({ companyId: CID, userId: UID, kind: REMINDER_TYPE.SHIFT_START, eventKey: 'k1', entityId: UID, deps: mapPref.deps });
  assert.equal(r1.inapp, 'muted');
  assert.equal(r1.email, 'queued');
  assert.equal(mapPref.calls.notifications.length, 0);
  assert.equal(mapPref.calls.emails.length, 1);

  const pojoPref = makeDeps({ pref: { inapp: {}, email: { ATTENDANCE: false } } });
  const r2 = await deliverReminder({ companyId: CID, userId: UID, kind: REMINDER_TYPE.SHIFT_START, eventKey: 'k2', entityId: UID, deps: pojoPref.deps });
  assert.equal(r2.inapp, 'sent');
  assert.equal(r2.email, 'muted');
});

test('deliver: duplicate eventKey (11000) → benign duplicate, email still deduped', async () => {
  const { deps, calls } = makeDeps({ createError: Object.assign(new Error('dup'), { code: 11000 }) });
  const outcome = await deliverReminder({
    companyId: CID,
    userId: UID,
    kind: REMINDER_TYPE.SHIFT_START,
    eventKey: 'k1',
    entityId: UID,
    deps,
  });
  assert.equal(outcome.dispatched, true);
  assert.equal(outcome.duplicate, true);
  assert.equal(outcome.inapp, 'duplicate');
  assert.equal(calls.emails.length, 1);
});

test('deliver: non-duplicate infra failure propagates (worker retries; effects stay idempotent)', async () => {
  const { deps } = makeDeps({ createError: new Error('Mongo blip') });
  await assert.rejects(
    () =>
      deliverReminder({ companyId: CID, userId: UID, kind: REMINDER_TYPE.SHIFT_START, eventKey: 'k1', entityId: UID, deps }),
    /Mongo blip/
  );
});

test('deliver: invalid refs fail closed', async () => {
  const { deps, calls } = makeDeps();
  const outcome = await deliverReminder({ companyId: 'bad', userId: UID, kind: REMINDER_TYPE.SHIFT_START, eventKey: 'k', entityId: UID, deps });
  assert.equal(outcome.dispatched, false);
  assert.equal(calls.notifications.length, 0);
});

test('context: policy read failure resolves to all-disabled (never throws)', async () => {
  const { deps } = makeDeps({ deps: { getCurrentPolicy: async () => { throw new Error('down'); } } });
  const ctx = await loadReminderContext({ companyId: CID, deps });
  assert.equal(ctx.hasActive, false);
  assert.equal(isReminderEnabled(ctx.notifications, REMINDER_TYPE.SHIFT_START), false);
  const bad = await loadReminderContext({ companyId: 'bad', deps });
  assert.equal(bad.hasActive, false);
  assert.equal(await loadActiveUser({ userId: 'bad', companyId: CID, deps }), null);
});

// ── I. Reviewer + finalization + reconcile ───────────────────

test('reg reviewers: stale PENDING notifies the REVIEW audience once per recipient', async () => {
  const { deps, calls } = makeDeps();
  const request = { _id: REQ, companyId: CID, status: 'PENDING', createdAt: new Date(Date.now() - 25 * 3600 * 1000) };
  const summary = await notifyRegReviewers({ request, deps });
  assert.equal(summary.notified, 1);
  assert.deepEqual(calls.audiences, [['ATTENDANCE_REGULARIZATION_REVIEW']]);
  assert.equal(calls.notifications.length, 1);
  assert.ok(calls.notifications[0].eventKey.includes(REQ.toLowerCase()));
  assert.ok(calls.notifications[0].eventKey.includes(RID.toLowerCase()));
  assert.equal(calls.emails[0].payload.requestId, REQ);
  assert.equal(calls.emails[0].recipientType, 'HR');
});

test('reviewers: fresh/decided/already-notified requests stay silent', async () => {
  const fresh = makeDeps();
  const r1 = await notifyRegReviewers({
    request: { _id: REQ, companyId: CID, status: 'PENDING', createdAt: new Date() },
    deps: fresh.deps,
  });
  assert.equal(r1.reason, SKIP_REASON.NOT_YET_DUE);
  assert.equal(fresh.calls.notifications.length, 0);

  const decided = makeDeps();
  const r2 = await notifyOtReviewers({
    request: { _id: REQ, companyId: CID, status: 'APPROVED', createdAt: new Date(Date.now() - 99 * 3600 * 1000) },
    deps: decided.deps,
  });
  assert.equal(r2.reason, SKIP_REASON.NOT_PENDING_ANYMORE);

  const seen = makeDeps({ seen: { _id: 'n1' } });
  const r3 = await notifyOtReviewers({
    request: { _id: REQ, companyId: CID, status: 'PENDING', createdAt: new Date(Date.now() - 99 * 3600 * 1000) },
    deps: seen.deps,
  });
  assert.equal(r3.notified, 0);
  assert.equal(seen.calls.notifications.length, 0);
});

test('ot reviewers: uses the overtime REVIEW permission', async () => {
  const { deps, calls } = makeDeps();
  await notifyOtReviewers({
    request: { _id: REQ, companyId: CID, status: 'PENDING', createdAt: new Date(Date.now() - 30 * 3600 * 1000) },
    deps,
  });
  assert.deepEqual(calls.audiences, [['ATTENDANCE_OVERTIME_REVIEW']]);
});

test('finalization: elapsed OPEN month notifies MANAGE holders with month copy', async () => {
  const { deps, calls } = makeDeps();
  const summary = await notifyFinalizationPending({
    companyId: CID,
    period: { _id: REQ, month: '2026-08', status: 'OPEN' },
    deps,
  });
  assert.equal(summary.notified, 1);
  assert.deepEqual(calls.audiences, [['ATTENDANCE_FINALIZATION_MANAGE']]);
  assert.ok(calls.notifications[0].message.includes('2026-08'));
  assert.equal(calls.notifications[0].link, '/app/attendance/finalization');
});

test('finalization: finalized periods stay silent', async () => {
  const { deps, calls } = makeDeps();
  const summary = await notifyFinalizationPending({
    companyId: CID,
    period: { _id: REQ, month: '2026-08', status: 'FINALIZED' },
    deps,
  });
  assert.equal(summary.reason, SKIP_REASON.PERIOD_FINALIZED);
  assert.equal(calls.notifications.length, 0);
});

test('reconcile: company run queues forward window + reviewer legs (bounded)', async () => {
  const users = Array.from({ length: 3 }, (_, i) => ({ _id: `507f1f77bcf86cd79943901${i}`, companyId: CID }));
  const { deps, calls } = makeDeps({
    users,
    regs: [{ _id: REQ, companyId: CID, status: 'PENDING', createdAt: hoursBeforeFixed(30) }],
    periods: [{ _id: REQ, companyId: CID, month: '2026-08', status: 'REOPENED' }],
  });
  const summary = await reconcileCompanyAttendance({
    companyId: CID,
    now: new Date('2026-09-16T02:00:00.000Z'),
    enqueue: async (id, data, delay) => calls.enqueued.push({ id, data, delay }),
    deps,
  });
  assert.equal(summary.checked, 3);
  assert.equal(summary.queued, 3 * 2 * 3); // users × days × legs
  assert.equal(summary.reviewerNotified, 2); // 1 reg + 1 finalization
  assert.equal(summary.errors, 0);
});

test('reconcile: disabled employee legs skip fast, reviewer legs still run', async () => {
  const { deps } = makeDeps({
    policy: { hasActive: true, policy: { timezone: 'Asia/Kolkata', notifications: normalizeNotificationsConfig(null), breaks: { enabled: true } } },
    users: [{ _id: UID, companyId: CID }],
    regs: [{ _id: REQ, companyId: CID, status: 'PENDING', createdAt: hoursBeforeFixed(30) }],
  });
  const summary = await reconcileCompanyAttendance({ companyId: CID, now: new Date('2026-09-16T02:00:00.000Z'), deps });
  assert.equal(summary.checked, 0);
  assert.equal(summary.queued, 0);
  assert.equal(summary.reviewerNotified, 1);
});

test('reconcile: per-employee errors are isolated, never fatal', async () => {
  let n = 0;
  const { deps } = makeDeps({
    users: [{ _id: UID, companyId: CID }],
    deps: {
      resolveDaySchedule: () => {
        n += 1;
        throw new Error('bad master row');
      },
    },
  });
  const summary = await reconcileCompanyAttendance({ companyId: CID, now: new Date('2026-09-16T02:00:00.000Z'), deps });
  // resolveDaySchedule catches internally → NOT_A_WORK_DAY skips, no errors.
  assert.equal(summary.errors, 0);
  assert.ok(n >= 1);
  assert.ok(summary.skipped >= 2);
});

test('reconcile: runner bounds companies + aggregates without throwing', async () => {
  const companies = Array.from({ length: 60 }, (_, i) => ({ _id: `607f1f77bcf86cd7994390${String(i).padStart(2, '0')}`.slice(0, 24) }));
  const { deps } = makeDeps({ users: [] });
  const summary = await runAttendanceReminderReconcile({
    now: new Date('2026-09-16T02:00:00.000Z'),
    deps,
    loadCompanies: async () => companies,
  });
  assert.equal(summary.companies, REMINDER_RECONCILE_BOUNDS.maxCompaniesPerRun);
  const failing = await runAttendanceReminderReconcile({
    deps,
    loadCompanies: async () => {
      throw new Error('Mongo down');
    },
  });
  assert.equal(failing.errors, 1);
  assert.equal(failing.companies, 0);
});

// ── J. Worker processor ──────────────────────────────────────

test('worker: valid job executes with references only (recipient derived server-side)', async () => {
  let got = null;
  const result = await attendanceReminderProcessor(
    { data: validPayload() },
    { execute: async (refs) => {
      got = refs;
      return { processed: true };
    } }
  );
  assert.deepEqual(Object.keys(got).sort(), ['anchorIso', 'attendanceDate', 'companyId', 'employeeId', 'reminderType']);
  assert.deepEqual(result, { processed: true, reminderType: REMINDER_TYPE.SHIFT_START });
});

test('worker: skip results pass through untouched', async () => {
  const result = await attendanceReminderProcessor(
    { data: validPayload() },
    { execute: async () => ({ processed: false, skipped: true, reason: SKIP_REASON.ON_APPROVED_LEAVE }) }
  );
  assert.deepEqual(result, { processed: false, skipped: true, reason: SKIP_REASON.ON_APPROVED_LEAVE });
});

test('worker: poison payloads throw (28.6 semantics — never silently swallowed)', async () => {
  let executed = false;
  await assert.rejects(
    () =>
      attendanceReminderProcessor(
        { data: { ...validPayload(), email: 'a@b.c' } },
        { execute: async () => {
          executed = true;
          return { processed: true };
        } }
      ),
    /ATTENDANCE_REMINDER rejected/
  );
  assert.equal(executed, false);
  await assert.rejects(() => attendanceReminderProcessor({ data: null }, { execute: async () => ({}) }), /rejected/);
});

test('worker: registered under the scheduled job name', () => {
  const registered = [];
  registerScheduledProcessors({ registerProcessor: (name, fn) => registered.push([name, fn]) });
  const hit = registered.find(([name]) => name === JOB_NAMES.ATTENDANCE_REMINDER);
  assert.ok(hit, 'attendance-reminder must be registered');
  assert.equal(hit[1], attendanceReminderProcessor);
  assert.ok(SCHEDULED_JOB_NAMES.includes(JOB_NAMES.ATTENDANCE_REMINDER));
  assert.equal(JOB_NAMES.ATTENDANCE_REMINDER, 'attendance-reminder');
});

// ── K. Email contract ────────────────────────────────────────

test('email validator: attendance payloads validate; bad kinds/keys fail', () => {
  const good = {
    deliveryId: 'd1',
    correlationId: 'c1',
    companyId: CID,
    employeeId: UID,
    reminderType: REMINDER_TYPE.SHIFT_START,
    attendanceDate: DAY,
    anchorIso: new Date(START_MS).toISOString(),
  };
  assert.equal(validateEmailJobPayload(JOB_NAMES.EMAIL_ATTENDANCE_REMINDER, good).valid, true);
  const minimal = { deliveryId: 'd1', correlationId: 'c1', companyId: CID, employeeId: RID, reminderType: REVIEW_REMINDER_KIND.REG_REVIEW, requestId: REQ };
  assert.equal(validateEmailJobPayload(JOB_NAMES.EMAIL_ATTENDANCE_REMINDER, minimal).valid, true);
  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_ATTENDANCE_REMINDER, { ...good, reminderType: 'NOPE' }).valid,
    false
  );
  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_ATTENDANCE_REMINDER, { ...good, salary: 'x' }).valid,
    false
  );
  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_ATTENDANCE_REMINDER, { ...good, companyId: '' }).valid,
    false
  );
  assert.equal(validateEmailJobPayload('email-nope', good).valid, false);
});

test('email job name rides the 28.3 email-job family', () => {
  assert.equal(JOB_NAMES.EMAIL_ATTENDANCE_REMINDER, 'email-attendance-reminder');
  assert.ok(JOB_NAMES.EMAIL_ATTENDANCE_REMINDER.startsWith('email-'));
});

test('notify category ATTENDANCE exists (no second prefs system)', () => {
  assert.ok(NOTIFY_CATEGORIES.includes('ATTENDANCE'));
});

// ── L. Source hygiene ────────────────────────────────────────

test('hygiene: reminder service never writes attendance (reads + notification writes only)', () => {
  const source = readSource('src/services/attendance/attendanceReminderService.js');
  for (const banned of [
    'findOneAndUpdate',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
    'recordEvent',
    'finalize',
    'coordinates',
    'latitude',
    'longitude',
    'salary',
    'payable',
    'process.env',
  ]) {
    assert.ok(!source.includes(banned), `service must not contain "${banned}"`);
  }
  const creates = source.match(/\.\s*create\s*\(/g) || [];
  const bellCreates = source.match(/NotificationModel\.create\s*\(/g) || [];
  assert.ok(creates.length > 0, 'expected the bell write to exist');
  assert.equal(creates.length, bellCreates.length, 'the ONLY create() must be the Notification bell write');
});

test('hygiene: rules are dependency-free (zero imports — pure by construction)', () => {
  const source = readSource('src/services/attendance/attendanceReminderRules.js');
  assert.ok(!/^import /m.test(source), 'rules must not import anything');
  assert.ok(!source.includes('mongoose'));
  assert.ok(!source.includes('process.env'));
});

test('hygiene: scheduled processor does no I/O itself (delegates to execute)', () => {
  const source = readSource('src/workers/scheduledProcessor.js');
  const section = source.split('ATTENDANCE_REMINDER (31.13)')[1].split('export const registerScheduledProcessors')[0];
  for (const banned of ['findOne', '.create(', '.update', 'delete', 'Notification', 'Attendance.']) {
    assert.ok(!section.includes(banned), `processor section must not contain "${banned}"`);
  }
  assert.ok(section.includes('validateAttendanceReminderPayload'));
});

test('hygiene: email handler revalidates staleness before sending (belt + braces)', () => {
  const source = readSource('src/workers/emailProcessor.js');
  assert.ok(source.includes('isAttendanceReminderStale'));
  assert.ok(source.includes('skipStale(value)'));
});

test('hygiene: no 31.14+ scaffolding in reminder code', () => {
  for (const rel of [
    'src/services/attendance/attendanceReminderRules.js',
    'src/services/attendance/attendanceReminderService.js',
  ]) {
    const source = readSource(rel);
    assert.ok(!source.includes('31.14'), `${rel} must not reference 31.14`);
    assert.ok(!/TODO.*31\.1[4-9]/i.test(source), `${rel} must not carry forward TODOs`);
  }
});

test('hygiene: event hooks are fire-and-forget (never awaited, never throwing)', () => {
  const source = readSource('src/services/attendance/attendanceEventService.js');
  assert.ok(source.includes('fireReminderHooks({ companyId, userId, action, day: control.date, at, events });'));
  assert.ok(!source.includes('await fireReminderHooks'));
  const hook = source.split('const fireReminderHooks')[1].split('export const recordEvent')[0];
  assert.ok(hook.includes('.catch(() => {})'));
});

test('hygiene: no surveillance vocabulary in reminder code', () => {
  for (const rel of [
    'src/services/attendance/attendanceReminderRules.js',
    'src/services/attendance/attendanceReminderService.js',
  ]) {
    const source = readSource(rel).toLowerCase();
    for (const banned of ['gps', 'tracking', 'track employee', 'idle', 'score', 'surveillance']) {
      assert.ok(!source.includes(banned), `${rel} must not contain "${banned}"`);
    }
  }
});
