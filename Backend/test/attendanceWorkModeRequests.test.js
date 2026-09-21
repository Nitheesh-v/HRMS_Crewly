// Phase 31.4 — Work-Mode Requests (hermetic suite).
//
// No MongoDB, no Redis, no network: request/leave/event/user models,
// policy reads, org scope, notify and audit are injected fakes; the
// REAL request rules, request service, event service (CLOCK_IN
// integration), validators and permission registry run against them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const USER_B = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const MGR_A = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const MGR_UNRELATED = 'aaaaaaaaaaaaaaaaaaaaaaa4';
const TODAY = '2026-09-15';

const [requestRules, requestService, eventService, policyRules, requestValidator, registry] =
  await Promise.all([
    import('../src/services/attendance/attendanceWorkModeRules.js'),
    import('../src/services/attendance/attendanceWorkModeService.js'),
    import('../src/services/attendance/attendanceEventService.js'),
    import('../src/services/attendance/attendancePolicyRules.js'),
    import('../src/validators/attendance/attendanceWorkModeValidator.js'),
    import('../src/utils/permissionRegistry.js'),
  ]);

const {
  REQUESTABLE_MODES,
  REQUEST_STATUS,
  DAY_PORTION,
  MAX_RANGE_DAYS,
  isRequestableMode,
  isValidDayString,
  rangeDayCount,
  validateRequestInput,
  requestPolicyCheck,
  modeRequiresApproval,
  requestableModesForPolicy,
  requestsOverlap,
  findOverlappingRequest,
  findAuthorization,
  canTransition,
  cancelEligibility,
  reviewEligibility,
  validateReviewReason,
} = requestRules;
const {
  submitWorkModeRequest,
  listMyWorkModeRequests,
  listPendingWorkModeRequests,
  getWorkModeRequest,
  decideWorkModeRequest,
  cancelWorkModeRequest,
} = requestService;
const { recordEvent, getLiveAttendance } = eventService;
const { WORK_MODE } = policyRules;

// ── Fakes ────────────────────────────────────────────────────

const norm = (value) =>
  value && typeof value === 'object' && !(value instanceof Date) && value._id !== undefined
    ? String(value._id)
    : String(value ?? '');

const getPath = (row, key) =>
  String(key)
    .split('.')
    .reduce((acc, part) => (acc == null ? undefined : acc[part]), row);

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    const actual = getPath(row, key);
    if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      if (value.$in !== undefined) return value.$in.map(norm).includes(norm(actual));
      if (value.$ne !== undefined) return norm(actual) !== norm(value.$ne);
      if (value.$lte !== undefined) return norm(actual) <= norm(value.$lte);
      if (value.$gte !== undefined) return norm(actual) >= norm(value.$gte);
      if (value.$exists !== undefined) {
        const exists = actual !== undefined;
        return value.$exists ? exists : !exists;
      }
      return true;
    }
    return norm(actual) === norm(value);
  });

const chain = (resolve) => {
  const self = {
    populate: () => self,
    sort: () => self,
    lean: () => self,
    select: () => self,
    then: (resolvePromise, rejectPromise) =>
      Promise.resolve().then(resolve).then(resolvePromise, rejectPromise),
  };
  return self;
};

const withToObject = (row) => ({ ...row, toObject() { return { ...this }; } });

const makeFakeRequestModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  let seq = rows.length + 1;
  return {
    rows,
    findOne: (filter) => chain(() => rows.find((row) => matches(row, filter)) || null),
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    create: async (doc) => {
      // Mirrors schema defaults the real model applies on write.
      const row = { status: 'PENDING', ...doc, _id: `wr${seq}`, createdAt: new Date(), updatedAt: new Date() };
      seq += 1;
      rows.push(row);
      return withToObject(row);
    },
    findOneAndUpdate: async (filter, update, opts = {}) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, update.$set || {});
      row.updatedAt = new Date();
      return opts.new ? withToObject(row) : { ...row };
    },
  };
};

const makeFakeLeaveModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  const writes = [];
  return {
    rows,
    writes,
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    create: async (doc) => { writes.push(['create', doc]); throw new Error('Leave must never be written by 31.4'); },
    findOneAndUpdate: async () => { writes.push(['update']); throw new Error('Leave must never be written by 31.4'); },
  };
};

const makeFakeUserModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  return {
    rows,
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    findById: (id) => chain(() => rows.find((row) => String(row._id) === String(id)) || null),
  };
};

const makeFakeAttendanceModel = () => {
  const rows = [];
  let seq = 1;
  return {
    rows,
    findOne: (filter) => chain(() => rows.find((row) => matches(row, filter)) || null),
    findOneAndUpdate: async (filter, update, opts = {}) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, update.$set || {});
      if (update.$inc) {
        for (const [key, delta] of Object.entries(update.$inc)) row[key] = Number(row[key] || 0) + delta;
      }
      return opts.new ? row : { ...row };
    },
    create: async (doc) => {
      const dup = rows.find((row) => String(row.user) === String(doc.user) && String(row.date) === String(doc.date));
      if (dup) { const err = new Error('duplicate key'); err.code = 11000; throw err; }
      const row = { ...doc, _id: `att${seq}`, id: `att${seq}` };
      seq += 1;
      rows.push(row);
      return row;
    },
  };
};

const makeFakeEventModel = () => {
  const rows = [];
  let seq = 1;
  return {
    rows,
    findOne: (filter) => chain(() => {
      const found = rows.find((row) => matches(row, filter));
      return found ? { ...found } : null;
    }),
    find: (filter) => chain(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }))),
    create: async (doc) => {
      const dupSeq = rows.find(
        (row) =>
          String(row.companyId) === String(doc.companyId) &&
          String(row.user) === String(doc.user) &&
          String(row.date) === String(doc.date) &&
          Number(row.seq) === Number(doc.seq),
      );
      if (dupSeq) { const err = new Error('duplicate key'); err.code = 11000; throw err; }
      if (doc.requestId) {
        const dupKey = rows.find(
          (row) =>
            String(row.companyId) === String(doc.companyId) &&
            String(row.user) === String(doc.user) &&
            String(row.requestId || '') === String(doc.requestId),
        );
        if (dupKey) { const err = new Error('duplicate key'); err.code = 11000; throw err; }
      }
      const row = { ...doc, _id: `evt${seq}`, id: `evt${seq}` };
      seq += 1;
      rows.push(row);
      return withToObject(row);
    },
  };
};

const EMP = { _id: USER_A, name: 'Asha Employee', reportingTo: MGR_A };
const MGR = { _id: MGR_A, name: 'Mohan Manager' };

const makePolicy = (overrides = {}) => ({
  version: 4,
  timezone: 'Asia/Kolkata',
  locationEnforcement: 'DISABLED',
  breaks: { includeInWorkedTime: false },
  workModes: { office: true, wfh: true, field: true, clientSite: true, businessTravel: true },
  workModeApproval: { wfh: true, field: true, clientSite: true, businessTravel: true },
  ...overrides,
});

const makeSvcCtx = ({ policy = makePolicy(), requests = [], leaves = [], users = [] } = {}) => {
  const RequestModel = makeFakeRequestModel(requests);
  const LeaveModel = makeFakeLeaveModel(leaves);
  const UserModel = makeFakeUserModel(users);
  const AttendanceEventModel = makeFakeEventModel();
  const notifications = [];
  const audits = [];
  const base = {
    today: TODAY,
    policyReader: async () => ({ policy, configured: true, hasActive: true }),
    RequestModel,
    LeaveModel,
    UserModel,
    AttendanceEventModel,
    notify: async (userId, payload) => notifications.push({ userId: String(userId), payload }),
    audit: async (entry) => audits.push(entry),
  };
  return { ...base, RequestModel, LeaveModel, UserModel, AttendanceEventModel, notifications, audits, policy };
};

const makeClockCtx = ({ policy = makePolicy(), requests = [] } = {}) => {
  const AttendanceModel = makeFakeAttendanceModel();
  const AttendanceEventModel = makeFakeEventModel();
  const WorkModeRequestModel = makeFakeRequestModel(requests);
  const deps = {
    AttendanceModel,
    AttendanceEventModel,
    WorkModeRequestModel,
    CompanyModel: { findById: () => ({ select: () => ({ lean: async () => ({ timezone: 'Asia/Kolkata' }) }) }) },
    policyReader: async () => ({ policy, configured: true, hasActive: true }),
    engine: { evaluatePunch: () => ({ status: 'PRESENT', lateMinutes: 0 }) },
    resolveScheduleRule: async () => ({
      rule: { name: 'Default', startTime: '09:00', endTime: '18:00', breakMinutes: 0, graceMinutes: 15, minWorkingHours: 8, halfDayHours: 4, overtimeEligible: false },
      shift: null,
      schedule: null,
      source: 'DEFAULT',
    }),
    now: () => new Date('2026-09-15T09:00:00+05:30'),
    sleep: async () => {},
  };
  return { deps, AttendanceModel, AttendanceEventModel, WorkModeRequestModel, policy };
};

const punch = (ctx, action, overrides = {}) =>
  recordEvent({ companyId: COMPANY_A, userId: USER_A, action, workMode: null, date: null, idempotencyKey: null, location: null, deps: ctx.deps, ...overrides });

const approvedCover = (mode, startDate = TODAY, endDate = startDate, extra = {}) => ({
  _id: `seed-${mode}-${startDate}`,
  companyId: COMPANY_A,
  user: USER_A,
  mode,
  startDate,
  endDate,
  dayPortion: 'FULL_DAY',
  reason: 'seeded approval',
  placeLabel: null,
  status: 'APPROVED',
  approver: MGR_A,
  ...extra,
});

// ── PURE RULES ─────────────────────────────────────────────

test('rules: the four non-office modes are requestable, OFFICE is not', () => {
  assert.deepEqual([...REQUESTABLE_MODES], ['WFH', 'FIELD', 'CLIENT_SITE', 'BUSINESS_TRAVEL']);
  assert.equal(isRequestableMode(WORK_MODE.WFH), true);
  assert.equal(isRequestableMode(WORK_MODE.FIELD), true);
  assert.equal(isRequestableMode(WORK_MODE.CLIENT_SITE), true);
  assert.equal(isRequestableMode(WORK_MODE.BUSINESS_TRAVEL), true);
  assert.equal(isRequestableMode(WORK_MODE.OFFICE), false);
  assert.equal(isRequestableMode('REMOTE'), false);
  assert.equal(isRequestableMode(null), false);
});

test('rules: approval needs an explicit flag (legacy policies grandfathered)', () => {
  assert.equal(modeRequiresApproval('WFH', makePolicy()), true);
  assert.equal(modeRequiresApproval('WFH', makePolicy({ workModeApproval: { wfh: false } })), false);
  assert.equal(modeRequiresApproval('WFH', makePolicy({ workModeApproval: undefined })), false);
  assert.equal(modeRequiresApproval('WFH', null), false);
  assert.equal(modeRequiresApproval('OFFICE', makePolicy()), false);
  assert.equal(modeRequiresApproval('FIELD', makePolicy({ workModeApproval: { field: true } })), true);
});

test('rules: policy gate refuses disabled modes only', () => {
  assert.equal(requestPolicyCheck('WFH', makePolicy()), null);
  assert.match(requestPolicyCheck('WFH', makePolicy({ workModes: { office: true, wfh: false } })), /not enabled/);
  assert.match(requestPolicyCheck('OFFICE', makePolicy()), /not a requestable/);
  assert.match(requestPolicyCheck('WFH', null), /not enabled/);
});

test('rules: requestable modes follow the enabled subset', () => {
  assert.deepEqual(requestableModesForPolicy(makePolicy()), ['WFH', 'FIELD', 'CLIENT_SITE', 'BUSINESS_TRAVEL']);
  assert.deepEqual(
    requestableModesForPolicy(makePolicy({ workModes: { office: true, wfh: true } })),
    ['WFH'],
  );
  assert.deepEqual(requestableModesForPolicy(null), []);
});

test('rules: valid single-day and range inputs pass', () => {
  assert.deepEqual(validateRequestInput({ mode: 'WFH', startDate: '2026-09-16', reason: 'Deep work' }, TODAY), []);
  assert.deepEqual(
    validateRequestInput({ mode: 'BUSINESS_TRAVEL', startDate: '2026-09-16', endDate: '2026-09-20', reason: 'Client visit', placeLabel: 'Bengaluru' }, TODAY),
    [],
  );
  assert.deepEqual(
    validateRequestInput({ mode: 'FIELD', startDate: TODAY, dayPortion: 'FIRST_HALF', reason: 'Install' }, TODAY),
    [],
  );
});

test('rules: invalid dates, ranges and portions are refused', () => {
  const base = { mode: 'WFH', startDate: '2026-09-16', reason: 'x' };
  assert.ok(validateRequestInput({ ...base, startDate: '2026-09-18', endDate: '2026-09-16' }, TODAY).some((m) => m.includes('endDate')));
  assert.ok(validateRequestInput({ ...base, startDate: '2026-09-14' }, TODAY).some((m) => m.includes('past')));
  assert.ok(validateRequestInput({ ...base, startDate: '2026-09-16', endDate: '2026-10-20' }, TODAY).some((m) => m.includes(`${MAX_RANGE_DAYS}`)));
  assert.ok(validateRequestInput({ ...base, startDate: '2026-09-16', endDate: '2026-09-17', dayPortion: 'FIRST_HALF' }, TODAY).some((m) => m.includes('single-day')));
  assert.ok(validateRequestInput({ ...base, dayPortion: 'MORNING' }, TODAY).some((m) => m.includes('dayPortion')));
  assert.ok(validateRequestInput({ ...base, startDate: '2026-02-30' }, TODAY).some((m) => m.includes('startDate')));
  assert.ok(validateRequestInput({ ...base, startDate: '16-09-2026' }, TODAY).some((m) => m.includes('startDate')));
  assert.equal(rangeDayCount('2026-09-16', '2026-09-16'), 1);
  assert.equal(rangeDayCount('2026-09-16', '2026-09-20'), 5);
  assert.equal(isValidDayString('2026-02-30'), false);
  assert.equal(isValidDayString(TODAY), true);
});

test('rules: reason and placeLabel lengths are bounded', () => {
  const base = { mode: 'WFH', startDate: '2026-09-16' };
  assert.ok(validateRequestInput({ ...base, reason: '  ' }, TODAY).some((m) => m.includes('reason is required')));
  assert.ok(validateRequestInput({ ...base, reason: 'x'.repeat(301) }, TODAY).some((m) => m.includes('300')));
  assert.ok(validateRequestInput({ ...base, reason: 'ok', placeLabel: 'x'.repeat(121) }, TODAY).some((m) => m.includes('placeLabel')));
});

test('rules: overlap matrix — full collides, split halves coexist', () => {
  const full = (startDate, endDate = startDate, dayPortion = 'FULL_DAY') => ({ startDate, endDate, dayPortion });
  assert.equal(requestsOverlap(full('2026-09-16'), full('2026-09-16')), true);
  assert.equal(requestsOverlap(full('2026-09-16', '2026-09-18'), full('2026-09-18', '2026-09-20')), true);
  assert.equal(requestsOverlap(full('2026-09-16'), full('2026-09-17')), false);
  assert.equal(requestsOverlap(full('2026-09-16', 'FULL_DAY' in {} ? '2026-09-16' : '2026-09-16', 'FIRST_HALF'), full('2026-09-16', '2026-09-16', 'FIRST_HALF')), true);
  assert.equal(requestsOverlap(full('2026-09-16', '2026-09-16', 'FIRST_HALF'), full('2026-09-16', '2026-09-16', 'SECOND_HALF')), false);
  assert.equal(requestsOverlap(full('2026-09-16', '2026-09-16', 'FIRST_HALF'), full('2026-09-16')), true);
});

test('rules: overlap search honors active statuses only', () => {
  const candidate = { startDate: '2026-09-16', endDate: '2026-09-16', dayPortion: 'FULL_DAY' };
  const pending = { ...candidate, status: 'PENDING', mode: 'WFH' };
  const approved = { ...candidate, status: 'APPROVED', mode: 'FIELD' };
  const rejected = { ...candidate, status: 'REJECTED', mode: 'WFH' };
  const cancelled = { ...candidate, status: 'CANCELLED', mode: 'WFH' };
  assert.equal(findOverlappingRequest(candidate, [rejected, cancelled]), null);
  assert.equal(findOverlappingRequest(candidate, [rejected, pending]).mode, 'WFH');
  assert.equal(findOverlappingRequest(candidate, [approved]).mode, 'FIELD');
  const otherDay = { ...candidate, startDate: '2026-09-17', endDate: '2026-09-17', status: 'PENDING' };
  assert.equal(findOverlappingRequest(candidate, [otherDay]), null);
});

test('rules: transition table — forward only, terminals frozen', () => {
  assert.equal(canTransition('PENDING', 'APPROVED'), true);
  assert.equal(canTransition('PENDING', 'REJECTED'), true);
  assert.equal(canTransition('PENDING', 'CANCELLED'), true);
  assert.equal(canTransition('APPROVED', 'CANCELLED'), true);
  assert.equal(canTransition('APPROVED', 'REJECTED'), false);
  assert.equal(canTransition('APPROVED', 'PENDING'), false);
  assert.equal(canTransition('REJECTED', 'APPROVED'), false);
  assert.equal(canTransition('CANCELLED', 'PENDING'), false);
});

test('rules: cancellation eligibility matrix', () => {
  const pending = { status: 'PENDING', startDate: '2026-09-16' };
  const approvedFuture = { status: 'APPROVED', startDate: '2026-09-20' };
  const approvedToday = { status: 'APPROVED', startDate: TODAY };
  assert.equal(cancelEligibility(pending, { isOwner: true, today: TODAY }), null);
  assert.equal(cancelEligibility(pending, { isReviewer: true, today: TODAY }), null);
  assert.match(cancelEligibility(pending, { today: TODAY }), /not authorized/);
  assert.equal(cancelEligibility(approvedFuture, { isOwner: true, today: TODAY }), null);
  assert.equal(cancelEligibility(approvedFuture, { isReviewer: true, today: TODAY }), null);
  assert.match(cancelEligibility(approvedFuture, { isOwner: true, usedForAttendance: true, today: TODAY }), /history/);
  assert.match(cancelEligibility(approvedToday, { isOwner: true, today: TODAY }), /reviewer cancellation/);
  assert.equal(cancelEligibility(approvedToday, { isReviewer: true, today: TODAY }), null);
  assert.match(cancelEligibility({ status: 'REJECTED' }, { isOwner: true, today: TODAY }), /only pending or approved/);
});

test('rules: review guard — pending only, never self', () => {
  assert.equal(reviewEligibility({ status: 'PENDING', user: USER_A }, MGR_A), null);
  assert.match(reviewEligibility({ status: 'PENDING', user: USER_A }, USER_A), /own request/);
  assert.match(reviewEligibility({ status: 'APPROVED', user: USER_A }, MGR_A), /already approved/);
  assert.match(reviewEligibility(null, MGR_A), /not found/);
});

test('rules: review reason required on reject, optional on approve', () => {
  assert.match(validateReviewReason('', { required: true }), /at least 3/);
  assert.match(validateReviewReason('  ok  '.slice(0, 2), { required: true }), /at least 3/);
  assert.equal(validateReviewReason('Quota full this week', { required: true }), null);
  assert.equal(validateReviewReason(null, { required: false }), null);
  assert.match(validateReviewReason('x'.repeat(301), { required: false }), /at most 300/);
});

test('rules: authorization matches approved cover for the day', () => {
  const rows = [approvedCover('WFH', '2026-09-15', '2026-09-17')];
  assert.equal(findAuthorization(rows, { mode: 'WFH', date: '2026-09-16' }).mode, 'WFH');
  assert.equal(findAuthorization(rows, { mode: 'WFH', date: '2026-09-18' }), null);
  assert.equal(findAuthorization(rows, { mode: 'FIELD', date: '2026-09-16' }), null);
  assert.equal(findAuthorization([{ ...rows[0], status: 'PENDING' }], { mode: 'WFH', date: '2026-09-16' }), null);
  assert.equal(findAuthorization([], { mode: 'WFH', date: TODAY }), null);
});

// ── SUBMIT ─────────────────────────────────────────────────

test('submit: creates PENDING, audits, notifies the direct manager (no reason leak)', async () => {
  const ctx = makeSvcCtx();
  const created = await submitWorkModeRequest({
    ...ctx,
    companyId: COMPANY_A,
    requester: EMP,
    input: { mode: 'WFH', startDate: '2026-09-16', reason: 'Deep focus work' },
  });
  assert.equal(created.status, 'PENDING');
  assert.equal(created.mode, 'WFH');
  assert.equal(created.endDate, '2026-09-16');
  assert.equal(created.canCancel, true);
  assert.equal(ctx.RequestModel.rows[0].user, USER_A);
  assert.equal(ctx.audits.length, 1);
  assert.equal(ctx.audits[0].action, 'ATTENDANCE_WORK_MODE_SUBMITTED');
  assert.equal(ctx.audits[0].newValue.mode, 'WFH');
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].userId, MGR_A);
  assert.equal(ctx.notifications[0].payload.category, 'ATTENDANCE');
  assert.ok(!JSON.stringify(ctx.notifications[0].payload).includes('Deep focus'));
  assert.ok(!JSON.stringify(ctx.audits[0]).includes('Deep focus'));
});

test('submit: falls back to Admin+HR when no reporting manager', async () => {
  const ctx = makeSvcCtx({
    users: [
      { _id: 'bbbbbbbbbbbbbbbbbbbbbbb1', companyId: COMPANY_A, role: 'COMPANY_ADMIN' },
      { _id: 'bbbbbbbbbbbbbbbbbbbbbbb2', companyId: COMPANY_A, role: 'HR_MANAGER' },
    ],
  });
  await submitWorkModeRequest({
    ...ctx,
    companyId: COMPANY_A,
    requester: { _id: USER_A, name: 'Solo', reportingTo: null },
    input: { mode: 'FIELD', startDate: '2026-09-16', reason: 'Install' },
  });
  assert.deepEqual(ctx.notifications.map((n) => n.userId).sort(), ['bbbbbbbbbbbbbbbbbbbbbbb1', 'bbbbbbbbbbbbbbbbbbbbbbb2']);
});

test('submit: refuses disabled modes (backend authoritative)', async () => {
  const ctx = makeSvcCtx({ policy: makePolicy({ workModes: { office: true, wfh: false } }) });
  await assert.rejects(
    () => submitWorkModeRequest({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { mode: 'WFH', startDate: '2026-09-16', reason: 'x' } }),
    /not enabled/,
  );
  assert.equal(ctx.RequestModel.rows.length, 0);
});

test('submit: refuses overlapping active requests, allows split halves', async () => {
  const ctx = makeSvcCtx({ requests: [{ ...approvedCover('WFH', '2026-09-16'), _id: 'wr1' }] });
  await assert.rejects(
    () => submitWorkModeRequest({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { mode: 'FIELD', startDate: '2026-09-16', reason: 'x' } }),
    /Overlaps your approved WFH/,
  );
  const half = await submitWorkModeRequest({
    ...ctx,
    companyId: COMPANY_A,
    requester: EMP,
    input: { mode: 'FIELD', startDate: '2026-09-17', dayPortion: 'FIRST_HALF', reason: 'AM visit' },
  });
  assert.equal(half.dayPortion, 'FIRST_HALF');
  const otherHalf = await submitWorkModeRequest({
    ...ctx,
    companyId: COMPANY_A,
    requester: EMP,
    input: { mode: 'CLIENT_SITE', startDate: '2026-09-17', dayPortion: 'SECOND_HALF', reason: 'PM client' },
  });
  assert.equal(otherHalf.status, 'PENDING');
  await assert.rejects(
    () => submitWorkModeRequest({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { mode: 'WFH', startDate: '2026-09-17', dayPortion: 'FIRST_HALF', reason: 'dup' } }),
    /Overlaps your pending FIELD/,
  );
});

test('submit: approved leave blocks, pending leave does not, Leave untouched', async () => {
  const ctx = makeSvcCtx({
    leaves: [
      { _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'APPROVED', startDate: '2026-09-16', endDate: '2026-09-16' },
      { _id: 'lv2', companyId: COMPANY_A, user: USER_A, status: 'PENDING', startDate: '2026-09-18', endDate: '2026-09-18' },
    ],
  });
  await assert.rejects(
    () => submitWorkModeRequest({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { mode: 'WFH', startDate: '2026-09-16', reason: 'x' } }),
    /Approved leave already covers/,
  );
  const ok = await submitWorkModeRequest({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { mode: 'WFH', startDate: '2026-09-18', reason: 'x' } });
  assert.equal(ok.status, 'PENDING');
  assert.equal(ctx.LeaveModel.writes.length, 0);
  assert.equal(ctx.LeaveModel.rows.length, 2);
});

test('submit: past starts and bad input are refused, nothing stored', async () => {
  const ctx = makeSvcCtx();
  await assert.rejects(
    () => submitWorkModeRequest({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { mode: 'WFH', startDate: '2026-09-14', reason: 'x' } }),
    /past/,
  );
  await assert.rejects(
    () => submitWorkModeRequest({ ...ctx, companyId: COMPANY_A, requester: EMP, input: { mode: 'OFFICE', startDate: '2026-09-16', reason: 'x' } }),
    /requestable/,
  );
  assert.equal(ctx.RequestModel.rows.length, 0);
  assert.equal(ctx.notifications.length, 0);
  assert.equal(ctx.audits.length, 0);
});

test('submit: payload identity fields can never impersonate', async () => {
  const ctx = makeSvcCtx();
  const created = await submitWorkModeRequest({
    ...ctx,
    companyId: COMPANY_A,
    requester: EMP,
    input: { mode: 'WFH', startDate: '2026-09-16', reason: 'x', user: USER_B, employeeId: USER_B, companyId: COMPANY_B },
  });
  assert.equal(ctx.RequestModel.rows[0].user, USER_A);
  assert.equal(ctx.RequestModel.rows[0].companyId, COMPANY_A);
  assert.equal(created.id, String(ctx.RequestModel.rows[0]._id));
});

// ── READ ───────────────────────────────────────────────────

test('read: mine lists own only, plus server-computed requestable modes', async () => {
  const ctx = makeSvcCtx({
    policy: makePolicy({ workModes: { office: true, wfh: true, field: false } }),
    requests: [
      { ...approvedCover('WFH', '2026-09-16'), _id: 'wr1' },
      { ...approvedCover('FIELD', '2026-09-16'), _id: 'wr2', user: USER_B },
    ],
  });
  const mine = await listMyWorkModeRequests({ ...ctx, companyId: COMPANY_A, userId: USER_A });
  assert.equal(mine.requests.length, 1);
  assert.equal(mine.requests[0].mode, 'WFH');
  assert.deepEqual(mine.requestableModes, ['WFH']);
});

test('read: get is owner-or-scoped-reviewer, tenant-isolated', async () => {
  const inScope = async () => [USER_A];
  const outOfScope = async () => [USER_B];
  const ctx = makeSvcCtx({ requests: [{ ...approvedCover('WFH', '2026-09-16'), _id: 'wr1' }] });
  const own = await getWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: EMP, requestId: 'wr1', resolveScopeIds: outOfScope });
  assert.equal(own.mode, 'WFH');
  const scoped = await getWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', asReviewer: true, resolveScopeIds: inScope });
  assert.equal(scoped.employee, null); // stored user is an id here, not populated
  await assert.rejects(
    () => getWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: { _id: MGR_UNRELATED }, requestId: 'wr1', asReviewer: true, resolveScopeIds: outOfScope }),
    /not in your team/,
  );
  await assert.rejects(
    () => getWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: { _id: USER_B }, requestId: 'wr1' }),
    /not found/,
  );
  await assert.rejects(
    () => getWorkModeRequest({ ...ctx, companyId: COMPANY_B, viewer: EMP, requestId: 'wr1' }),
    /not found/,
  );
});

test('read: pending queue shows in-scope PENDING with employee cards', async () => {
  const ctx = makeSvcCtx({
    requests: [
      { _id: 'wr1', companyId: COMPANY_A, user: { _id: USER_A, name: 'Asha', email: 'a@x.com', designation: 'Dev' }, mode: 'WFH', startDate: '2026-09-16', endDate: '2026-09-16', dayPortion: 'FULL_DAY', reason: 'x', status: 'PENDING' },
      { _id: 'wr2', companyId: COMPANY_A, user: USER_B, mode: 'FIELD', startDate: '2026-09-16', endDate: '2026-09-16', dayPortion: 'FULL_DAY', reason: 'y', status: 'PENDING' },
      { _id: 'wr3', companyId: COMPANY_A, user: USER_A, mode: 'WFH', startDate: '2026-09-10', endDate: '2026-09-10', dayPortion: 'FULL_DAY', reason: 'z', status: 'APPROVED' },
    ],
  });
  const rows = await listPendingWorkModeRequests({ ...ctx, companyId: COMPANY_A, viewer: MGR, resolveScopeIds: async () => [USER_A] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].employee.name, 'Asha');
  assert.equal(rows[0].canCancel, true);
});

// ── DECIDE ─────────────────────────────────────────────────

const pendingSeed = (extra = {}) => ({
  _id: 'wr1',
  companyId: COMPANY_A,
  user: USER_A,
  mode: 'WFH',
  startDate: '2026-09-16',
  endDate: '2026-09-16',
  dayPortion: 'FULL_DAY',
  reason: 'Focus day',
  placeLabel: null,
  status: 'PENDING',
  ...extra,
});

test('decide: in-scope approve stamps, audits, notifies (reason stays out)', async () => {
  const ctx = makeSvcCtx({ requests: [pendingSeed()] });
  const decided = await decideWorkModeRequest({
    ...ctx,
    companyId: COMPANY_A,
    viewer: MGR,
    requestId: 'wr1',
    action: 'APPROVE',
    resolveScopeIds: async () => [USER_A],
  });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.approver.name, 'Mohan Manager');
  assert.ok(decided.decidedAt);
  assert.equal(ctx.audits[0].action, 'ATTENDANCE_WORK_MODE_APPROVED');
  assert.equal(ctx.audits[0].newValue.to, 'APPROVED');
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].userId, USER_A);
  assert.ok(!JSON.stringify(ctx.notifications[0].payload).includes('Focus day'));
  // Approval creates no attendance.
  assert.equal(ctx.AttendanceEventModel.rows.length, 0);
});

test('decide: approve revalidates policy, overlap and leave', async () => {
  const disabled = makeSvcCtx({ policy: makePolicy({ workModes: { office: true, wfh: false } }), requests: [pendingSeed()] });
  await assert.rejects(
    () => decideWorkModeRequest({ ...disabled, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_A] }),
    /not enabled/,
  );
  const clash = makeSvcCtx({ requests: [pendingSeed(), { ...approvedCover('FIELD', '2026-09-16'), _id: 'wr2' }] });
  await assert.rejects(
    () => decideWorkModeRequest({ ...clash, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_A] }),
    /Overlaps/,
  );
  const leaveClash = makeSvcCtx({
    requests: [pendingSeed()],
    leaves: [{ _id: 'lv1', companyId: COMPANY_A, user: USER_A, status: 'APPROVED', startDate: '2026-09-16', endDate: '2026-09-16' }],
  });
  await assert.rejects(
    () => decideWorkModeRequest({ ...leaveClash, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_A] }),
    /leave already covers/,
  );
  assert.equal(leaveClash.LeaveModel.writes.length, 0);
});

test('decide: reject needs a real reason, stored for the employee', async () => {
  const ctx = makeSvcCtx({ requests: [pendingSeed()] });
  await assert.rejects(
    () => decideWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', action: 'REJECT', reviewReason: '  ', resolveScopeIds: async () => [USER_A] }),
    /at least 3/,
  );
  const rejected = await decideWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', action: 'REJECT', reviewReason: 'Onsite-UAT week, need you here', resolveScopeIds: async () => [USER_A] });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reviewReason, 'Onsite-UAT week, need you here');
  assert.equal(ctx.audits[0].action, 'ATTENDANCE_WORK_MODE_REJECTED');
  assert.equal(ctx.notifications[0].userId, USER_A);
});

test('decide: self, scope, tenant and double-decide guards', async () => {
  const ctx = makeSvcCtx({ requests: [pendingSeed()] });
  await assert.rejects(
    () => decideWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: EMP, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_A] }),
    /own request/,
  );
  await assert.rejects(
    () => decideWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: { _id: MGR_UNRELATED }, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_B] }),
    /not in your team/,
  );
  await assert.rejects(
    () => decideWorkModeRequest({ ...ctx, companyId: COMPANY_B, viewer: MGR, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_A] }),
    /not found/,
  );
  await decideWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_A] });
  const second = await decideWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_A] }).then(
    () => null,
    (err) => err,
  );
  assert.ok(second);
  assert.equal(second.statusCode, 409);
  assert.equal(ctx.RequestModel.rows.filter((row) => row.status === 'APPROVED').length, 1);
});

test('decide: lost CAS race refuses instead of double-deciding', async () => {
  const RequestModel = makeFakeRequestModel([pendingSeed()]);
  const realUpdate = RequestModel.findOneAndUpdate;
  RequestModel.findOneAndUpdate = async () => null; // someone else decided first
  const ctx = makeSvcCtx();
  await assert.rejects(
    () => decideWorkModeRequest({ ...ctx, RequestModel, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_A] }),
    /no longer pending/,
  );
  assert.equal(ctx.notifications.length, 0);
  assert.equal(RequestModel.rows[0].status, 'PENDING');
  RequestModel.findOneAndUpdate = realUpdate;
});

// ── CANCEL ─────────────────────────────────────────────────

test('cancel: owner cancels PENDING, manager hears about it', async () => {
  const ctx = makeSvcCtx({ requests: [pendingSeed()] });
  const cancelled = await cancelWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: EMP, requestId: 'wr1' });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(ctx.audits[0].action, 'ATTENDANCE_WORK_MODE_CANCELLED');
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].userId, MGR_A);
});

test('cancel: approved future can go, used or started cannot (owner)', async () => {
  const ctx = makeSvcCtx({ requests: [{ ...approvedCover('WFH', '2026-09-20'), _id: 'wr1' }] });
  const cancelled = await cancelWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: EMP, requestId: 'wr1' });
  assert.equal(cancelled.status, 'CANCELLED');

  const started = makeSvcCtx({ requests: [{ ...approvedCover('WFH', TODAY), _id: 'wr1' }] });
  await assert.rejects(
    () => cancelWorkModeRequest({ ...started, companyId: COMPANY_A, viewer: EMP, requestId: 'wr1' }),
    /reviewer cancellation/,
  );

  const used = makeSvcCtx({ requests: [{ ...approvedCover('WFH', '2026-09-20'), _id: 'wr1' }] });
  used.AttendanceEventModel.rows.push({ companyId: COMPANY_A, authorization: { requestId: 'wr1' } });
  await assert.rejects(
    () => cancelWorkModeRequest({ ...used, companyId: COMPANY_A, viewer: EMP, requestId: 'wr1' }),
    /already permitted attendance/,
  );
  // History survives: request + event untouched.
  assert.equal(used.RequestModel.rows[0].status, 'APPROVED');
  assert.equal(used.AttendanceEventModel.rows.length, 1);
});

test('cancel: reviewer scope rules, strangers refused', async () => {
  const ctx = makeSvcCtx({ requests: [{ ...approvedCover('WFH', '2026-09-20'), _id: 'wr1' }] });
  const cancelled = await cancelWorkModeRequest({ ...ctx, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', asReviewer: true, resolveScopeIds: async () => [USER_A] });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(ctx.notifications[0].userId, USER_A);

  const ctx2 = makeSvcCtx({ requests: [pendingSeed()] });
  await assert.rejects(
    () => cancelWorkModeRequest({ ...ctx2, companyId: COMPANY_A, viewer: { _id: MGR_UNRELATED }, requestId: 'wr1', asReviewer: true, resolveScopeIds: async () => [USER_B] }),
    /not authorized|not in your team/,
  );
  const ctx3 = makeSvcCtx({ requests: [pendingSeed()] });
  await assert.rejects(
    () => cancelWorkModeRequest({ ...ctx3, companyId: COMPANY_A, viewer: { _id: USER_B }, requestId: 'wr1' }),
    /not authorized/,
  );
  const ctx4 = makeSvcCtx({ requests: [{ ...pendingSeed(), status: 'REJECTED' }] });
  await assert.rejects(
    () => cancelWorkModeRequest({ ...ctx4, companyId: COMPANY_A, viewer: EMP, requestId: 'wr1' }),
    /only pending or approved/,
  );
});

// ── RBAC ───────────────────────────────────────────────────

test('rbac: REQUEST is self-service, REVIEW is least-privilege', () => {
  const names = registry.DEFAULT_PERMISSIONS.map((permission) => permission.name);
  assert.ok(names.includes('ATTENDANCE_WORK_MODE_REQUEST'));
  assert.ok(names.includes('ATTENDANCE_WORK_MODE_REVIEW'));
  assert.ok(registry.DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('ATTENDANCE_WORK_MODE_REQUEST'));
  assert.ok(!registry.DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('ATTENDANCE_WORK_MODE_REVIEW'));
  assert.ok(registry.DEFAULT_ROLE_MATRIX.MANAGER.includes('ATTENDANCE_WORK_MODE_REVIEW'));
  assert.ok(registry.DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('ATTENDANCE_WORK_MODE_REVIEW'));
  assert.ok(!registry.DEFAULT_ROLE_MATRIX.MANAGER.includes('ATTENDANCE_LOCATION_MANAGE'));
});

// ── VALIDATOR ──────────────────────────────────────────────

const runChain = async (chainList, { body = {}, params = {} } = {}) => {
  const req = { body, params, query: {} };
  for (const middleware of chainList) {
    await new Promise((resolve, reject) => {
      Promise.resolve(middleware(req, {}, (err) => (err ? reject(err) : resolve()))).then(
        () => resolve(),
        (err) => reject(err),
      );
    });
  }
};

test('validator: identity overrides are refused outright', async () => {
  const good = { mode: 'WFH', startDate: '2026-09-16', reason: 'ok' };
  await assert.rejects(() => runChain(requestValidator.workModeRequestCreateValidator, { body: { ...good, employeeId: USER_B } }), /must not be supplied/);
  await assert.rejects(() => runChain(requestValidator.workModeRequestCreateValidator, { body: { ...good, approverId: MGR_A } }), /must not be supplied/);
  await assert.rejects(() => runChain(requestValidator.workModeRequestCreateValidator, { body: { ...good, companyId: COMPANY_B } }), /must not be supplied/);
  await assert.rejects(() => runChain(requestValidator.workModeRequestCreateValidator, { body: { ...good, user: USER_B } }), /must not be supplied/);
});

test('validator: legitimate payloads pass, bad shapes fail', async () => {
  await runChain(requestValidator.workModeRequestCreateValidator, {
    body: { mode: 'BUSINESS_TRAVEL', startDate: '2026-09-16', endDate: '2026-09-18', dayPortion: 'FULL_DAY', reason: 'Client UAT', placeLabel: 'Bengaluru' },
  });
  await runChain(requestValidator.workModeRequestIdValidator, { params: { requestId: COMPANY_A } });
  await assert.rejects(() => runChain(requestValidator.workModeRequestCreateValidator, { body: { mode: 'OFFICE', startDate: '2026-09-16', reason: 'x' } }), /mode must be/);
  await assert.rejects(() => runChain(requestValidator.workModeRequestCreateValidator, { body: { mode: 'WFH', startDate: 'tomorrow', reason: 'x' } }), /YYYY-MM-DD/);
  await assert.rejects(() => runChain(requestValidator.workModeRequestIdValidator, { params: { requestId: 'nope' } }), /valid id/);
});

// ── CLOCK-IN INTEGRATION ───────────────────────────────────

test('clock-in: approved WFH succeeds with an authorization snapshot', async () => {
  const ctx = makeClockCtx({ requests: [approvedCover('WFH')] });
  const result = await punch(ctx, 'CLOCK_IN', { workMode: 'WFH', idempotencyKey: 'wm-a' });
  assert.equal(result.snapshot.liveState, 'WORKING');
  assert.equal(result.event.workMode, 'WFH');
  assert.equal(result.event.authorization.mode, 'WFH');
  assert.equal(result.event.authorization.startDate, TODAY);
  assert.equal(result.event.authorization.dayPortion, 'FULL_DAY');
  assert.ok(result.event.authorization.requestId);
  assert.equal(result.event.location, null);
});

test('clock-in: missing approval refuses, nothing written', async () => {
  const ctx = makeClockCtx();
  const err = await punch(ctx, 'CLOCK_IN', { workMode: 'WFH', idempotencyKey: 'wm-b' }).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(err);
  assert.equal(err.statusCode, 403);
  assert.match(err.message, /Approved Work From Home request required/);
  assert.equal(ctx.AttendanceModel.rows.length, 0);
  assert.equal(ctx.AttendanceEventModel.rows.length, 0);
});

test('clock-in: each non-office mode enforces its own approval', async () => {
  for (const mode of ['FIELD', 'CLIENT_SITE', 'BUSINESS_TRAVEL']) {
    const okCtx = makeClockCtx({ requests: [approvedCover(mode)] });
    const ok = await punch(okCtx, 'CLOCK_IN', { workMode: mode, idempotencyKey: `wm-ok-${mode}` });
    assert.equal(ok.event.authorization.mode, mode);
    const bareCtx = makeClockCtx();
    await assert.rejects(
      () => punch(bareCtx, 'CLOCK_IN', { workMode: mode, idempotencyKey: `wm-no-${mode}` }),
      /Approved .* request required/,
      `expected ${mode} to require approval`,
    );
    assert.equal(bareCtx.AttendanceEventModel.rows.length, 0);
  }
});

test('clock-in: approval-free and legacy policies punch without requests', async () => {
  const free = makeClockCtx({ policy: makePolicy({ workModeApproval: { wfh: false } }) });
  const plain = await punch(free, 'CLOCK_IN', { workMode: 'WFH', idempotencyKey: 'wm-free' });
  assert.equal(plain.event.authorization, null);
  const legacy = makeClockCtx({ policy: makePolicy({ workModeApproval: undefined }) });
  const grand = await punch(legacy, 'CLOCK_IN', { workMode: 'WFH', idempotencyKey: 'wm-legacy' });
  assert.equal(grand.snapshot.liveState, 'WORKING');
});

test('clock-in: disabled mode refuses before approval is even considered', async () => {
  const ctx = makeClockCtx({
    policy: makePolicy({ workModes: { office: true, wfh: false } }),
    requests: [approvedCover('WFH')],
  });
  await assert.rejects(
    () => punch(ctx, 'CLOCK_IN', { workMode: 'WFH', idempotencyKey: 'wm-dis' }),
    /not enabled/,
  );
});

test('clock-in: approved WFH skips the office geofence entirely', async () => {
  const ctx = makeClockCtx({
    policy: makePolicy({ locationEnforcement: 'REQUIRED' }),
    requests: [approvedCover('WFH')],
  });
  const result = await punch(ctx, 'CLOCK_IN', { workMode: 'WFH', idempotencyKey: 'wm-geo' });
  assert.equal(result.snapshot.liveState, 'WORKING');
  assert.equal(result.event.location, null);
  assert.ok(!('locationVerification' in ctx.AttendanceEventModel.rows[0]));
  assert.ok(!('position' in ctx.AttendanceEventModel.rows[0]));
});

test('clock-in: OFFICE path untouched — no approval, geofence intact', async () => {
  const ctx = makeClockCtx({ policy: makePolicy({ locationEnforcement: 'REQUIRED' }) });
  await assert.rejects(
    () => punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', idempotencyKey: 'wm-off' }),
    /required by company policy/,
  );
  const open = makeClockCtx();
  const result = await punch(open, 'CLOCK_IN', { workMode: 'OFFICE', idempotencyKey: 'wm-off2' });
  assert.equal(result.snapshot.liveState, 'WORKING');
  assert.equal(result.event.authorization, null);
});

test('clock-in: same-key retry replays the original authorization', async () => {
  const ctx = makeClockCtx({ requests: [approvedCover('WFH')] });
  const first = await punch(ctx, 'CLOCK_IN', { workMode: 'WFH', idempotencyKey: 'wm-replay' });
  // Approval vanishes mid-flight (cancelled) — replay still serves the fact.
  ctx.WorkModeRequestModel.rows.length = 0;
  const retry = await punch(ctx, 'CLOCK_IN', { workMode: 'WFH', idempotencyKey: 'wm-replay' });
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.event.authorization, first.event.authorization);
});

test('clock-in: used authorization blocks later cancellation (end-to-end)', async () => {
  const svc = makeSvcCtx({ requests: [pendingSeed({ startDate: TODAY, endDate: TODAY })] });
  const decided = await decideWorkModeRequest({ ...svc, companyId: COMPANY_A, viewer: MGR, requestId: 'wr1', action: 'APPROVE', resolveScopeIds: async () => [USER_A] });
  assert.equal(decided.status, 'APPROVED');
  const clock = makeClockCtx({ requests: svc.RequestModel.rows });
  // Share the event store so the service sees the punch.
  svc.AttendanceEventModel.rows.push(...clock.AttendanceEventModel.rows);
  const clockEvents = clock.AttendanceEventModel.rows;
  await punch(clock, 'CLOCK_IN', { workMode: 'WFH', idempotencyKey: 'wm-used' });
  assert.equal(clockEvents.length, 1);
  svc.AttendanceEventModel.rows.push(...clockEvents);
  await assert.rejects(
    () => cancelWorkModeRequest({ ...svc, companyId: COMPANY_A, viewer: EMP, requestId: 'wr1' }),
    /already permitted attendance/,
  );
});

test('live: today-card authorization map reflects approvals', async () => {
  const ctx = makeClockCtx({ requests: [approvedCover('WFH')] });
  const live = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps: ctx.deps });
  assert.deepEqual(live.workModeAuthorization, { WFH: true, FIELD: false, CLIENT_SITE: false, BUSINESS_TRAVEL: false });
  const bare = makeClockCtx();
  const live2 = await getLiveAttendance({ companyId: COMPANY_A, userId: USER_A, deps: bare.deps });
  assert.deepEqual(live2.workModeAuthorization, { WFH: false, FIELD: false, CLIENT_SITE: false, BUSINESS_TRAVEL: false });
});

// ── 31.2 REGRESSION SLICE ──────────────────────────────────

test('regression: full OFFICE cycle + breaks + replay under 31.4', async () => {
  const ctx = makeClockCtx();
  const clockIn = await punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', idempotencyKey: 'reg-in' });
  assert.equal(clockIn.snapshot.liveState, 'WORKING');
  await punch(ctx, 'BREAK_START', { idempotencyKey: 'reg-b1' });
  await punch(ctx, 'BREAK_END', { idempotencyKey: 'reg-b1e' });
  await punch(ctx, 'BREAK_START', { idempotencyKey: 'reg-b2' });
  await punch(ctx, 'BREAK_END', { idempotencyKey: 'reg-b2e' });
  const out = await punch(ctx, 'CLOCK_OUT', { idempotencyKey: 'reg-out' });
  assert.equal(out.snapshot.liveState, 'COMPLETED');
  assert.equal(ctx.AttendanceEventModel.rows.length, 6);
  const replay = await punch(ctx, 'CLOCK_IN', { workMode: 'OFFICE', idempotencyKey: 'reg-in' });
  assert.equal(replay.replayed, true);
  assert.equal(ctx.AttendanceEventModel.rows.length, 6);
  assert.ok(ctx.AttendanceEventModel.rows.every((event) => event.authorization === undefined));
});

// ── STATIC GUARDS ──────────────────────────────────────────

test('static: 31.4 backend modules never touch payroll', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = [
    'models/AttendanceWorkModeRequest.js',
    'services/attendance/attendanceWorkModeRules.js',
    'services/attendance/attendanceWorkModeService.js',
    'validators/attendance/attendanceWorkModeValidator.js',
    'controllers/attendance/attendanceWorkModeController.js',
    'routes/attendance/attendanceWorkModeRoutes.js',
  ];
  for (const file of files) {
    // Boundary comments may NAME payroll to forbid it; code must not
    // touch it — strip comments before checking.
    const raw = readFileSync(join(root, file), 'utf8');
    const content = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.ok(!/payroll/i.test(content), `${file} must not reference payroll`);
  }
});
