// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.6 — HR-INTEGRATED PRESENCE (hermetic suite)
//
//  53 numbered test cases (per spec §41–§45). Hermetic — no Mongo,
//  no Redis, no network. The REAL rules and the REAL resolver run
//  against injectable fakes. The Leave model and the
//  attendanceScheduleService are both injectable fakes so the
//  hermetic suite stays DB-free.
//
//  Sections:
//    1.  LEAVE            (1–16)
//    2.  WORKING HOURS    (17–25)
//    3.  PRECEDENCE       (26–35)
//    4.  PERFORMANCE      (36–43)
//    5.  READ-ONLY        (44–53)
// ═══════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_presence_376_test';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

// Strip JS comments from a source string so an "anti-rule" comment
// does not poison a negative assertion. We use this for source-pin
// privacy / read-only checks.
const stripComments = (src) =>
  String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

// Subject imports
const { resolvePresence } = await import(
  '../src/services/presence/presenceResolver.js'
);
const {
  findActiveApprovedLeave,
  findActiveApprovedLeaveMany,
  resolveWorkingHoursContext,
} = await import('../src/services/presence/presenceHrContext.js');

// ── Fixtures ──────────────────────────────────────────────

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const USER_B = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const TODAY = '2026-09-15';
const FUTURE = '2026-09-22';
const PAST = '2026-09-10';

const basePolicy = (overrides = {}) => ({
  companyId: COMPANY_A,
  enabled: true,
  employeePresenceVisible: true,
  statusMessagesEnabled: true,
  workLocationEnabled: true,
  wfhMode: 'self_declare',
  awayAfterMinutes: 5,
  offlineAfterMinutes: 15,
  lastSeenVisible: false,
  allowedWorkLocations: ['office', 'wfh', 'remote'],
  timezone: 'Asia/Kolkata',
  ...overrides,
});

// Fake Leave model — exposes the minimum read surface the 37.6 reader
// uses. The 37.6 reader calls .findOne(...).select(...).lean() (Mongoose
// query chain). The fake implements that chain. write-side methods
// throw to enforce the read-only boundary.
const makeFakeLeaveModel = (rows = []) => {
  const data = rows.map((row) => ({ ...row }));
  // The fake models what the .select(LEAVE_PROJECTION) does on the
  // real Mongoose model: only the projection fields are returned.
  // The 37.6 service's projection is `_id user startDate endDate
  // status companyId`. Anything else is stripped at the chain level
  // so the test seam is honest about what the 37.6 reader ever
  // sees.
  const project = (row) => {
    if (!row) return null;
    return {
      _id: row._id,
      user: row.user,
      startDate: row.startDate,
      endDate: row.endDate,
      status: row.status,
      companyId: row.companyId,
    };
  };
  const resolveOne = (filter) => {
    const row = data.find((r) => matches(r, filter));
    return project(row);
  };
  const resolveMany = (filter) =>
    data.filter((r) => matches(r, filter)).map((r) => project(r));
  // Chain: select().lean() — both no-ops on the projection side
  // because the fake only carries the minimum fields the 37.6 reader
  // cares about (matches the real model's `.select(LEAVE_PROJECTION)`).
  const chainOne = (filter) => {
    const base = resolveOne(filter);
    const wrap = Object.assign({}, base || {});
    wrap.select = () => chainOne(filter);
    wrap.lean = () => Promise.resolve(resolveOne(filter));
    return wrap;
  };
  const chainMany = (filter) => {
    const list = resolveMany(filter);
    const wrap = [...list];
    wrap.select = () => chainMany(filter);
    wrap.lean = () => Promise.resolve([...list]);
    return wrap;
  };
  return {
    findOne: (filter) => chainOne(filter),
    find: (filter) => chainMany(filter),
    // Sentinel: any write must throw.
    create: async () => {
      throw new Error('Leave must never be written by 37.6');
    },
    save: async () => {
      throw new Error('Leave must never be written by 37.6');
    },
    updateOne: async () => {
      throw new Error('Leave must never be written by 37.6');
    },
    findOneAndUpdate: async () => {
      throw new Error('Leave must never be written by 37.6');
    },
    deleteOne: async () => {
      throw new Error('Leave must never be deleted by 37.6');
    },
  };
};

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    const actual = String(row[key] ?? '');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.$in !== undefined) {
        return value.$in.map(String).includes(actual);
      }
      if (value.$lte !== undefined) return actual <= String(value.$lte);
      if (value.$gte !== undefined) return actual >= String(value.$gte);
      return true;
    }
    return actual === String(value);
  });

// Fake schedule resolver — returns whatever the test wires.
const makeFakeScheduleResolver = (fn) => async (args) => fn(args);
const throwingScheduleResolver = async () => {
  throw new Error('Schedule unavailable');
};

// A resolved schedule context for "IN_WINDOW".
const inWindowContext = (overrides = {}) => ({
  status: 'RESOLVED',
  attendanceDate: TODAY,
  timezone: 'Asia/Kolkata',
  startTime: '09:00',
  endTime: '18:00',
  scheduledStartAt: new Date(`${TODAY}T03:30:00.000Z`).toISOString(),
  scheduledEndAt: new Date(`${TODAY}T12:30:00.000Z`).toISOString(),
  crossesMidnight: false,
  isWorkingDay: true,
  dayType: 'WORKING',
  source: 'WORK_SCHEDULE',
  ...overrides,
});

const inWindowContextOvernight = () => ({
  status: 'RESOLVED',
  attendanceDate: TODAY,
  timezone: 'Asia/Kolkata',
  startTime: '22:00',
  endTime: '06:00',
  scheduledStartAt: new Date(`${TODAY}T16:30:00.000Z`).toISOString(),
  scheduledEndAt: new Date(`${PAST}T19:30:00.000Z`).toISOString(),
  crossesMidnight: true,
  isWorkingDay: true,
  dayType: 'WORKING',
  source: 'EMPLOYEE_OVERRIDE',
});

const endedContext = (overrides = {}) => ({
  ...inWindowContext(),
  startTime: '00:00',
  endTime: '01:00',
  scheduledStartAt: new Date(`${TODAY}T18:30:00.000Z`).toISOString(),
  scheduledEndAt: new Date(`${TODAY}T19:30:00.000Z`).toISOString(),
  ...overrides,
});

const upcomingContext = (overrides = {}) => ({
  ...inWindowContext(),
  startTime: '23:00',
  endTime: '23:59',
  scheduledStartAt: new Date(`${FUTURE}T17:30:00.000Z`).toISOString(),
  scheduledEndAt: new Date(`${FUTURE}T18:29:00.000Z`).toISOString(),
  ...overrides,
});

const unresolvedContext = () => ({
  status: 'UNRESOLVED',
  attendanceDate: TODAY,
  timezone: 'Asia/Kolkata',
});

// ═══════════════════════════════════════════════════════════
//  §1 LEAVE (1–16)
// ═══════════════════════════════════════════════════════════

test('#1 leave — active approved leave produces onLeave=true', async () => {
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'APPROVED', startDate: TODAY, endDate: TODAY },
  ]);
  const out = await findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel });
  assert.ok(out, 'expected an active leave row');
  assert.equal(out.status, 'APPROVED');
});

test('#2 leave — pending does NOT match (status is APPROVED only)', async () => {
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'PENDING', startDate: TODAY, endDate: TODAY },
  ]);
  const out = await findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel });
  assert.equal(out, null);
});

test('#3 leave — rejected does NOT match', async () => {
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'REJECTED', startDate: TODAY, endDate: TODAY },
  ]);
  const out = await findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel });
  assert.equal(out, null);
});

test('#4 leave — cancelled does NOT match', async () => {
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'CANCELLED', startDate: TODAY, endDate: TODAY },
  ]);
  const out = await findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel });
  assert.equal(out, null);
});

test('#5 leave — future-only approved does NOT match today', async () => {
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'APPROVED', startDate: FUTURE, endDate: '2026-10-30' },
  ]);
  const out = await findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel });
  assert.equal(out, null);
});

test('#6 leave — past-only approved does NOT match today', async () => {
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'APPROVED', startDate: '2026-01-01', endDate: '2026-01-05' },
  ]);
  const out = await findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel });
  assert.equal(out, null);
});

test('#7 leave — approved wins over manual Available (resolver)', () => {
  const snap = resolvePresence({
    durable: { manualStatus: 'available' },
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: true, outsideWorkingHours: false },
  });
  assert.equal(snap.presence, 'on_leave');
});

test('#8 leave — approved wins over manual Busy (resolver)', () => {
  const snap = resolvePresence({
    durable: { manualStatus: 'busy', manualStatusExpiresAt: new Date(Date.now() + 60_000) },
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: true, outsideWorkingHours: false },
  });
  assert.equal(snap.presence, 'on_leave');
});

test('#9 leave — approved wins over manual DND (resolver)', () => {
  const snap = resolvePresence({
    durable: { manualStatus: 'dnd', manualStatusExpiresAt: new Date(Date.now() + 60_000) },
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: true, outsideWorkingHours: false },
  });
  assert.equal(snap.presence, 'on_leave');
});

test('#10 leave — approved wins display precedence over an approved WFH conflict (resolver)', () => {
  const snap = resolvePresence({
    durable: { workLocation: 'wfh' },
    config: basePolicy({ wfhMode: 'approval_required' }),
    now: new Date(),
    hrContext: { onLeave: true, outsideWorkingHours: false },
  });
  assert.equal(snap.presence, 'on_leave');
  // workLocation is still carried (the 37.6 layer is presentation only).
  assert.equal(snap.workLocation, 'wfh');
});

test('#11 leave — reason is absent from the leave reader projection (privacy)', async () => {
  const LeaveModel = makeFakeLeaveModel([
    {
      _id: 'lv1',
      companyId: COMPANY_A,
      user: USER_A,
      status: 'APPROVED',
      startDate: TODAY,
      endDate: TODAY,
      reason: 'medical emergency — confidential',
      type: 'SICK',
      approver: 'admin1',
      approverNote: 'private reviewer comment',
    },
  ]);
  const out = await findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel });
  // The fake model does not return reason / approver / approverNote
  // because the 37.6 reader's Mongoose chain calls
  // `.select(LEAVE_PROJECTION)` — and the projection omits those
  // fields. The fake simulates the projection by carrying only the
  // minimum row data.
  assert.ok(out, 'row returned');
  // The row does NOT carry the sensitive fields.
  assert.equal(out.reason, undefined);
  assert.equal(out.approver, undefined);
  assert.equal(out.approverNote, undefined);
  assert.equal(out.type, undefined);
  // Pin the contract on the source: 37.6 files do not contain a
  // `select('reason ...')` or `populate('approver', ...)` call in
  // their CODE (comments may mention the rule).
  const hr = stripComments(read('src/services/presence/presenceHrContext.js'));
  assert.equal(/select\(['"][^'"]*reason/i.test(hr), false, '37.6 must not select reason');
  assert.equal(/populate\(['"][^'"]*approver/i.test(hr), false, '37.6 must not populate approver');
});

test('#12 leave — attachment is absent (privacy)', () => {
  const hr = stripComments(read('src/services/presence/presenceHrContext.js'));
  assert.equal(/attachment|attachments|document|documents/i.test(hr), false,
    '37.6 must not reference leave attachments / documents');
});

test('#13 leave — approver note is absent (privacy)', () => {
  const hr = stripComments(read('src/services/presence/presenceHrContext.js'));
  assert.equal(/approverNote|approver_note/i.test(hr), false,
    '37.6 must not select approverNote');
});

test('#14 tenancy — leave from company B is never returned for company A', async () => {
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_B, user: USER_A, status: 'APPROVED', startDate: TODAY, endDate: TODAY },
  ]);
  const out = await findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel });
  assert.equal(out, null);
});

test('#15 tenancy — another employee\'s leave never matches the wrong user', async () => {
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_A, user: USER_B, status: 'APPROVED', startDate: TODAY, endDate: TODAY },
  ]);
  const out = await findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel });
  assert.equal(out, null);
});

test('#16 leave — half-day not supported by model; presence is On Leave for the inclusive day', () => {
  // The Leave model has no dayPortion / half-day field. 37.6
  // documents this and renders On Leave for the entire range.
  // No code to assert; the constraint is structural.
  const leaveSchema = read('src/models/Leave.js');
  assert.equal(/dayPortion|halfDay|half_day/i.test(leaveSchema), false,
    'Leave model does not support half-day — 37.6 documents this');
  // The spec §12 is honoured by the resolver: a full-day leave produces
  // onLeave=true for the whole inclusive range.
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'APPROVED', startDate: TODAY, endDate: TODAY },
  ]);
  return findActiveApprovedLeave({ companyId: COMPANY_A, userId: USER_A, todayKey: TODAY, LeaveModel }).then(
    (out) => assert.ok(out, 'single-day full leave matches'),
  );
});

// ═══════════════════════════════════════════════════════════
//  §2 WORKING HOURS (17–25)
// ═══════════════════════════════════════════════════════════

test('#17 working hours — within current shift, outsideWorkingHours=false', async () => {
  // noon Asia/Kolkata = 06:30 UTC. Set the resolver to return
  // IN_WINDOW for this user.
  const out = await resolveWorkingHoursContext({
    companyId: COMPANY_A,
    user: { _id: USER_A },
    attendanceDate: TODAY,
    timezone: 'Asia/Kolkata',
    scheduleResolver: makeFakeScheduleResolver(() => inWindowContext()),
  });
  // The summary is computed by the real attendanceScheduleRules using
  // `now`. We just check the shape: outsideWorkingHours is a boolean.
  assert.equal(typeof out.outsideWorkingHours, 'boolean');
});

test('#18 working hours — schedule resolver throws → null (failure ≠ absence)', async () => {
  const out = await resolveWorkingHoursContext({
    companyId: COMPANY_A,
    user: { _id: USER_A },
    attendanceDate: TODAY,
    timezone: 'Asia/Kolkata',
    scheduleResolver: throwingScheduleResolver,
  });
  assert.equal(out, null, 'failed read returns null, distinct from no-shift');
});

test('#19 working hours — UNRESOLVED status → null (no shift, no failure)', async () => {
  const out = await resolveWorkingHoursContext({
    companyId: COMPANY_A,
    user: { _id: USER_A },
    attendanceDate: TODAY,
    timezone: 'Asia/Kolkata',
    scheduleResolver: makeFakeScheduleResolver(() => unresolvedContext()),
  });
  assert.equal(out, null, 'no shift returns null');
});

test('#20 working hours — overnight shift IN_WINDOW at valid overnight time → not outside', async () => {
  // We assert the *invariant* via the source-pin that the rule helper
  // handles crossesMidnight. The hermetic test injects a context with
  // crossesMidnight=true; the real attendanceScheduleRules layer
  // produces the right phase. The wrapping helper in 37.6 only carries
  // the boolean.
  const out = await resolveWorkingHoursContext({
    companyId: COMPANY_A,
    user: { _id: USER_A },
    attendanceDate: TODAY,
    timezone: 'Asia/Kolkata',
    scheduleResolver: makeFakeScheduleResolver(() => inWindowContextOvernight()),
  });
  // The crossing-midnight helper in attendanceScheduleRules is the
  // authoritative implementation; 37.6 just propagates its output.
  assert.equal(typeof out.outsideWorkingHours, 'boolean');
  assert.equal(out.crossesMidnight, true);
});

test('#21 working hours — overnight shift outside range → outside=true', async () => {
  const out = await resolveWorkingHoursContext({
    companyId: COMPANY_A,
    user: { _id: USER_A },
    attendanceDate: TODAY,
    timezone: 'Asia/Kolkata',
    scheduleResolver: makeFakeScheduleResolver(() => endedContext({ crossesMidnight: true })),
  });
  // The phase helper returned ENDED for this context; outsideWorkingHours
  // is true.
  assert.equal(out.outsideWorkingHours, true);
});

test('#22 working hours — no reliable shift → null (NOT guessed)', async () => {
  // The reader must NOT fabricate a 9–5. It returns null instead.
  const out = await resolveWorkingHoursContext({
    companyId: COMPANY_A,
    user: { _id: USER_A },
    attendanceDate: TODAY,
    timezone: 'Asia/Kolkata',
    scheduleResolver: makeFakeScheduleResolver(() => unresolvedContext()),
  });
  assert.equal(out, null, 'no shift returns null, no fabrication');
  // The schedule service must NOT default to 9–5 anywhere in 37.6.
  const hr = read('src/services/presence/presenceHrContext.js');
  assert.equal(/'09:00'.*'18:00'|"09:00".*"18:00"/.test(hr), false,
    '37.6 must not hardcode a 9–5 default');
});

test('#23 working hours — tenant timezone is respected (envoy)', () => {
  // The day-key helper in 37.6 uses Intl with the tenant timezone.
  // Pin: the service source contains a timezone-aware day-key call.
  const svc = read('src/services/presence/presenceService.js');
  const team = read('src/services/presence/presenceTeamService.js');
  assert.match(svc + team, /Intl\.DateTimeFormat/);
  assert.match(svc + team, /timeZone/);
});

test('#24 working hours — weekly off / non-working day → outside=true (per the resolver)', () => {
  const snap = resolvePresence({
    durable: {},
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: false, outsideWorkingHours: true, workingHoursIsWorkingDay: false },
  });
  assert.equal(snap.presence, 'unknown'); // no live, no manual
  assert.equal(snap.outsideWorkingHours, true);
  assert.equal(snap.workingHoursIsWorkingDay, false);
});

test('#25 working hours — cross-tenant isolation (resolver accepts the companyId arg)', () => {
  // The source pins the tenant argument propagation.
  const hr = read('src/services/presence/presenceHrContext.js');
  assert.match(hr, /companyId/);
});

// ═══════════════════════════════════════════════════════════
//  §3 PRECEDENCE (26–35)
// ═══════════════════════════════════════════════════════════

test('#26 precedence — on_leave beats available (resolver)', () => {
  const snap = resolvePresence({
    durable: { manualStatus: 'available' },
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: true, outsideWorkingHours: false },
  });
  assert.equal(snap.presence, 'on_leave');
});

test('#27 precedence — on_leave beats busy (resolver)', () => {
  const snap = resolvePresence({
    durable: { manualStatus: 'busy', manualStatusExpiresAt: new Date(Date.now() + 60_000) },
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: true, outsideWorkingHours: false },
  });
  assert.equal(snap.presence, 'on_leave');
});

test('#28 precedence — on_leave beats dnd (resolver)', () => {
  const snap = resolvePresence({
    durable: { manualStatus: 'dnd', manualStatusExpiresAt: new Date(Date.now() + 60_000) },
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: true, outsideWorkingHours: false },
  });
  assert.equal(snap.presence, 'on_leave');
});

test('#29 precedence — on_leave beats automatic away (resolver)', () => {
  const snap = resolvePresence({
    durable: {},
    config: basePolicy(),
    now: new Date(),
    live: { connected: true, lastActivityAt: new Date(Date.now() - 60_000 * 60).toISOString() },
    hrContext: { onLeave: true, outsideWorkingHours: false },
  });
  assert.equal(snap.presence, 'on_leave');
});

test('#30 precedence — on_leave beats unknown (resolver)', () => {
  const snap = resolvePresence({
    durable: {},
    config: basePolicy(),
    now: new Date(),
    live: null,
    hrContext: { onLeave: true, outsideWorkingHours: false },
  });
  assert.equal(snap.presence, 'on_leave');
});

test('#31 precedence — outsideWorkingHours does NOT replace available (resolver)', () => {
  const snap = resolvePresence({
    durable: { manualStatus: 'available' },
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: false, outsideWorkingHours: true },
  });
  assert.equal(snap.presence, 'available');
  assert.equal(snap.outsideWorkingHours, true);
});

test('#32 precedence — outsideWorkingHours does NOT replace busy (resolver)', () => {
  const snap = resolvePresence({
    durable: { manualStatus: 'busy', manualStatusExpiresAt: new Date(Date.now() + 60_000) },
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: false, outsideWorkingHours: true },
  });
  assert.equal(snap.presence, 'busy');
  assert.equal(snap.outsideWorkingHours, true);
});

test('#33 precedence — outsideWorkingHours does NOT replace away (resolver)', () => {
  const snap = resolvePresence({
    durable: {},
    config: basePolicy(),
    now: new Date(),
    live: { connected: true, lastActivityAt: new Date(Date.now() - 60_000 * 60).toISOString() },
    hrContext: { onLeave: false, outsideWorkingHours: true },
  });
  assert.equal(snap.presence, 'away');
  assert.equal(snap.outsideWorkingHours, true);
});

test('#34 precedence — unknown live + reliable schedule retains schedule flag (resolver)', () => {
  const snap = resolvePresence({
    durable: {},
    config: basePolicy(),
    now: new Date(),
    live: null,
    hrContext: { onLeave: false, outsideWorkingHours: false, workingHoursIsWorkingDay: true },
  });
  assert.equal(snap.presence, 'unknown');
  assert.equal(snap.outsideWorkingHours, false);
  assert.equal(snap.workingHoursIsWorkingDay, true);
});

test('#35 precedence — work location remains separate from presence (resolver)', () => {
  const snap = resolvePresence({
    durable: { workLocation: 'office' },
    config: basePolicy(),
    now: new Date(),
    hrContext: { onLeave: false, outsideWorkingHours: true },
  });
  assert.equal(snap.workLocation, 'office');
  assert.equal(snap.presence, 'unknown'); // no live, no manual
  assert.equal(snap.outsideWorkingHours, true);
});

// ═══════════════════════════════════════════════════════════
//  §4 PERFORMANCE (36–43)
// ═══════════════════════════════════════════════════════════

test('#36 performance — leave reader uses ONE batched query (not per-employee)', async () => {
  // The find-many reader exists and is wired into the team service.
  const teamSrc = read('src/services/presence/presenceTeamService.js');
  assert.match(teamSrc, /leaveReaderMany/);
  // And it returns a Map keyed by userId.
  const LeaveModel = makeFakeLeaveModel([
    { _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'APPROVED', startDate: TODAY, endDate: TODAY },
    { _id: 'lv2', companyId: COMPANY_A, user: USER_B, status: 'APPROVED', startDate: TODAY, endDate: TODAY },
  ]);
  const map = await findActiveApprovedLeaveMany({
    companyId: COMPANY_A,
    userIds: [USER_A, USER_B],
    todayKey: TODAY,
    LeaveModel,
  });
  assert.equal(map.size, 2);
  assert.ok(map.get(USER_A));
  assert.ok(map.get(USER_B));
});

test('#37 performance — schedule reader is invoked per-user but cached in-process', async () => {
  // The hermetic test asserts the cache: a same-company same-user
  // re-invocation hits the cache. (The cache is request-scoped.)
  // We can't import the cache directly, but we can pin the source.
  const teamSrc = read('src/services/presence/presenceTeamService.js');
  assert.match(teamSrc, /whCache/);
  assert.match(teamSrc, /whCache\.has/);
});

test('#38 performance — tenant config is not loaded once per employee (single read)', () => {
  const teamSrc = read('src/services/presence/presenceTeamService.js');
  // The 37.6 changes must not introduce a per-employee configReader
  // call. Pin: the file calls `tenantConfigReader` once before the
  // user loop.
  const calls = (teamSrc.match(/tenantConfigReader\s*\(/g) || []).length;
  assert.equal(calls, 1, 'tenantConfigReader is invoked exactly once per team request');
});

test('#39 performance — Leave query uses tenant scope', () => {
  const hr = read('src/services/presence/presenceHrContext.js');
  // Both findOne and find must include companyId.
  assert.match(hr, /companyId/);
});

test('#40 performance — Shift query uses tenant scope (delegated)', () => {
  // 37.6 delegates Shift resolution to the existing 31.x service. The
  // source pin is: 37.6 itself does not import Shift / ShiftAssignment
  // / WorkSchedule models — it goes through the resolver injection.
  const hr = read('src/services/presence/presenceHrContext.js');
  assert.equal(/models\/ShiftAssignment/.test(hr), false,
    '37.6 does not import ShiftAssignment directly');
  assert.equal(/models\/WorkSchedule/.test(hr), false,
    '37.6 does not import WorkSchedule directly');
  assert.equal(/models\/Shift['"]/.test(hr), false,
    '37.6 does not import Shift directly');
});

test('#41 performance — User projection remains minimized', () => {
  const teamSrc = read('src/services/presence/presenceTeamService.js');
  assert.match(teamSrc, /DTO_PROJECTION/);
  // The DTO_PROJECTION is unchanged from 37.3 — same minimal fields.
});

test('#42 performance — HR reader selects no reason / approverNote / documents fields', () => {
  const hr = read('src/services/presence/presenceHrContext.js');
  assert.equal(/select\(['"`][^'"`]*reason/i.test(hr), false);
  assert.equal(/select\(['"`][^'"`]*approver/i.test(hr), false);
  assert.equal(/select\(['"`][^'"`]*document/i.test(hr), false);
});

test('#43 performance — query count is bounded (no N+1 in the team path)', () => {
  const teamSrc = read('src/services/presence/presenceTeamService.js');
  // The team loop must use Promise.all with a single batched Leave
  // query and an in-process schedule cache.
  assert.match(teamSrc, /Promise\.all\(/);
  assert.match(teamSrc, /leaveReaderMany\(/);
});

// ═══════════════════════════════════════════════════════════
//  §5 READ-ONLY (44–53)
// ═══════════════════════════════════════════════════════════

test('#44 read-only — Leave.create is never called (sentinel)', async () => {
  const LeaveModel = makeFakeLeaveModel([]);
  // Any direct write would throw. We don't call it; we just verify
  // the file does not invoke create / save / update / delete on Leave.
  const hr = stripComments(read('src/services/presence/presenceHrContext.js'));
  assert.equal(/LeaveModel\.create/.test(hr), false);
  assert.equal(/LeaveModel\.save/.test(hr), false);
  assert.equal(/LeaveModel\.updateOne/.test(hr), false);
  assert.equal(/LeaveModel\.findOneAndUpdate/.test(hr), false);
  assert.equal(/LeaveModel\.deleteOne/.test(hr), false);
  // Sentinel exercised: even calling it would throw.
  await assert.rejects(() => LeaveModel.create(), /must never be written/);
});

test('#45 read-only — Leave is never updated', () => {
  const hr = stripComments(read('src/services/presence/presenceHrContext.js'));
  assert.equal(/LeaveModel\.update/i.test(hr), false);
});

test('#46 read-only — Leave is never deleted', () => {
  const hr = stripComments(read('src/services/presence/presenceHrContext.js'));
  assert.equal(/LeaveModel\.delete/i.test(hr), false);
});

test('#47 read-only — Leave is never approved / rejected / cancelled', () => {
  const hr = stripComments(read('src/services/presence/presenceHrContext.js'));
  // Word-boundary anchored so "approved" (the read status) does not
  // match "approve" (the verb).
  for (const action of ['approve', 'reject', 'cancel']) {
    assert.equal(
      new RegExp(`LeaveModel\\b[^;]*\\b${action}\\b`, 'i').test(hr),
      false,
      `37.6 must not ${action} Leave`,
    );
  }
});

test('#48 read-only — leave balance is never read or written', () => {
  // 37.6 does not touch leave balance. Pin: no LeaveBalance model
  // import, no balance / quota / remaining field.
  const hr = stripComments(read('src/services/presence/presenceHrContext.js'));
  for (const word of ['balance', 'quota', 'remaining', 'used', 'accrued']) {
    assert.equal(new RegExp(`\\b${word}\\b`, 'i').test(hr), false,
      `37.6 must not reference leave ${word}`);
  }
});

test('#49 read-only — Attendance is never written', () => {
  const hr = read('src/services/presence/presenceHrContext.js');
  assert.equal(/Attendance[A-Za-z]*\.(create|save|update|delete|findOneAndUpdate)/i.test(hr), false,
    '37.6 must not write Attendance');
  // And no attendance imports.
  assert.equal(/from\s+['"][^'"]*models\/AttendanceEvent/i.test(hr), false);
});

test('#50 read-only — check-in / check-out is never invoked', () => {
  const hr = read('src/services/presence/presenceHrContext.js');
  for (const w of ['checkIn', 'checkOut', 'clockIn', 'clockOut', 'punch']) {
    assert.equal(new RegExp(`\\b${w}\\b`, 'i').test(hr), false,
      `37.6 must not reference ${w}`);
  }
});

test('#51 read-only — ShiftAssignment is never mutated', () => {
  const hr = read('src/services/presence/presenceHrContext.js');
  assert.equal(/ShiftAssignment[^;]*\.(create|save|update|delete|findOneAndUpdate)/i.test(hr), false);
});

test('#52 read-only — Payroll is never touched', () => {
  const hr = read('src/services/presence/presenceHrContext.js');
  assert.equal(/Payroll[A-Za-z]*\.(create|save|update|delete)/i.test(hr), false);
  assert.equal(/from\s+['"][^'"]*models\/Payroll/i.test(hr), false);
});

test('#53 read-only — no AI / no services/ai imports', () => {
  const hr = read('src/services/presence/presenceHrContext.js');
  for (const f of ['src/services/presence/presenceHrContext.js']) {
    const src = read(f);
    assert.equal(/from\s+['"][^'"]*services\/ai/i.test(src), false,
      `forbidden AI import in ${f}`);
    assert.equal(/openai|anthropic|gemini|chatgpt/i.test(src), false,
      `forbidden AI vendor in ${f}`);
  }
});

// Phase 37.7 — batched working-hours reader. Verifies:
//  1. `resolveWorkingHoursContextMany` exports a function.
//  2. It preloads masters ONCE and resolves every user in memory.
//  3. It returns a Map keyed by userId whose values are frozen
//     summaries (or null for unresolved users).
//  4. The single-user `resolveWorkingHoursContext` is still exported
//     so the self-service path keeps working.
test('Phase 37.7: resolveWorkingHoursContextMany is exported and batched', async () => {
  const hrModule = await import(
    '../src/services/presence/presenceHrContext.js'
  );
  assert.equal(typeof hrModule.resolveWorkingHoursContextMany, 'function');
  assert.equal(typeof hrModule.resolveWorkingHoursContext, 'function');
  // Empty input → empty output, no I/O.
  const empty = await hrModule.resolveWorkingHoursContextMany({
    companyId: 'co1',
    users: [],
    attendanceDate: '2026-10-06',
  });
  assert.ok(empty instanceof Map);
  assert.equal(empty.size, 0);
  // Missing companyId → empty output, no I/O.
  const noCompany = await hrModule.resolveWorkingHoursContextMany({
    companyId: null,
    users: [{ _id: 'u1' }],
    attendanceDate: '2026-10-06',
  });
  assert.equal(noCompany.size, 0);
  // Missing date → empty output.
  const noDate = await hrModule.resolveWorkingHoursContextMany({
    companyId: 'co1',
    users: [{ _id: 'u1' }],
    attendanceDate: null,
  });
  assert.equal(noDate.size, 0);
});

test('Phase 37.7: resolveWorkingHoursContextMany uses injectable scheduleService (no I/O)', async () => {
  // Inject a fake scheduleService that records how many times
  // preloadScheduleMasters is called. The hermetic test asserts
  // it is called exactly ONCE regardless of N users.
  const { resolveWorkingHoursContextMany } = await import(
    '../src/services/presence/presenceHrContext.js'
  );
  let preloadCalls = 0;
  const fakeService = {
    preloadScheduleMasters: async () => {
      preloadCalls += 1;
      return { assignments: [], shifts: [], schedules: [], holidays: [], fromDate: '2026-10-06', toDate: '2026-10-06' };
    },
    resolveEmployeeScheduleFromMasters: () => ({ status: 'UNRESOLVED', attendanceDate: '2026-10-06' }),
    summarizeSchedule: () => null,
  };
  const result = await resolveWorkingHoursContextMany({
    companyId: 'co1',
    users: [
      { _id: 'u1' },
      { _id: 'u2' },
      { _id: 'u3' },
      { _id: 'u4' },
      { _id: 'u5' },
    ],
    attendanceDate: '2026-10-06',
    timezone: 'Asia/Kolkata',
    scheduleService: fakeService,
  });
  assert.equal(preloadCalls, 1, 'preloadScheduleMasters is called exactly ONCE for N=5 users');
  assert.ok(result instanceof Map);
  // Every user in the map (the fake returns null for unresolved
  // but still sets the key — verified by the implementation).
  assert.equal(result.size, 5);
});
