// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST HERMETIC SUITE
//
//  61 numbered test cases. Hermetic — no Mongo, no Redis, no network.
//  Models, tenant config, notification, audit, and the realtime bus
//  are all injectable fakes; the REAL rules and service run against them.
//
//  Sections (per spec §48):
//    1.  POLICY          (1–4)
//    2.  IDENTITY        (5–9)
//    3.  TENANCY         (10–12)
//    4.  DATES           (13–18)
//    5.  WORKFLOW        (19–26)
//    6.  AUTHORIZATION   (27–32)
//    7.  ATOMICITY       (33–34)
//    8.  RESOLUTION      (35–40)
//    9.  NOTIF/AUDIT     (41–45)
//   10.  REALTIME        (46–48)
//   11.  HR BOUNDARIES   (49–56)
//   12.  DATA MIN        (57–61)
// ═══════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_work_location_request_test';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

// ── Subject imports ──────────────────────────────────────

const rules = await import('../src/services/presence/workLocationRequestRules.js');
const {
  REQUEST_STATUS,
  MAX_RANGE_DAYS,
  isValidLocation,
  isValidDayString,
  rangeDayCount,
  validateRequestInput,
  requestPolicyCheck,
  isApprovalRequired,
  requestsOverlap,
  findOverlappingRequest,
  canTransition,
  cancelEligibility,
  reviewEligibility,
  validateDecisionNote,
  serializeRequest,
} = rules;
const { workLocationRequestService } = await import(
  '../src/services/presence/workLocationRequestService.js'
);

// ── Fixtures ──────────────────────────────────────────────

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const USER_B = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const MGR_A = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const MGR_UNRELATED = 'aaaaaaaaaaaaaaaaaaaaaaa4';
const HR_A = 'aaaaaaaaaaaaaaaaaaaaaaa5';
const ADMIN_A = 'aaaaaaaaaaaaaaaaaaaaaaa6';
const TODAY = '2026-09-15';
const FUTURE = '2026-09-22';

const basePolicy = (overrides = {}) => ({
  companyId: COMPANY_A,
  enabled: true,
  employeePresenceVisible: true,
  statusMessagesEnabled: true,
  workLocationEnabled: true,
  wfhMode: 'approval_required',
  awayAfterMinutes: 5,
  offlineAfterMinutes: 15,
  lastSeenVisible: false,
  allowedWorkLocations: ['office', 'wfh', 'remote'],
  timezone: 'Asia/Kolkata',
  ...overrides,
});

// ── Fake-model plumbing (mirrors the 31.4 suite) ─────────

const norm = (value) => {
  if (value && typeof value === 'object' && value._id !== undefined) {
    return String(value._id);
  }
  return String(value ?? '');
};

const getPath = (row, key) =>
  String(key)
    .split('.')
    .reduce((acc, part) => (acc == null ? undefined : acc[part]), row);

const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    const actual = getPath(row, key);
    if (
      value !== null &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      !Array.isArray(value)
    ) {
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
    findOne: (filter) =>
      chain(() => rows.find((row) => matches(row, filter)) || null),
    find: (filter) =>
      chain(() =>
        rows.filter((row) => matches(row, filter)).map((row) => ({ ...row })),
      ),
    create: async (doc) => {
      const row = {
        status: 'pending',
        ...doc,
        _id: `wl${seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
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

const makeFakeUserModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  return {
    rows,
    find: (filter) =>
      chain(() =>
        rows.filter((row) => matches(row, filter)).map((row) => ({ ...row })),
      ),
    findById: (id) =>
      chain(() => rows.find((row) => String(row._id) === String(id)) || null),
  };
};

// Throw-on-write sentinels. Any 37.5 code path that touches these
// surfaces a 37.5 boundary violation.
const makeThrowingSentinel = (name) => ({
  create: async () => {
    throw new Error(`${name} must never be written by 37.5`);
  },
  findOneAndUpdate: async () => {
    throw new Error(`${name} must never be written by 37.5`);
  },
  updateOne: async () => {
    throw new Error(`${name} must never be written by 37.5`);
  },
});

// Tenant config reader — the 37.5 suite drives the snapshot.
const makeTenantConfigReader = (overrides = {}) => async () =>
  basePolicy(overrides);

// ── Default fake wiring ───────────────────────────────────

const makeRecorder = () => {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    return Promise.resolve();
  };
  fn.calls = calls;
  return fn;
};

const makeNotify = () => {
  const calls = [];
  const fn = (userId, payload) => {
    calls.push({ userId: String(userId || ''), payload });
    return Promise.resolve();
  };
  fn.calls = calls;
  return fn;
};

const makePublisher = (opts = {}) => {
  const calls = [];
  const { throws = false } = opts;
  const fn = (input) => {
    calls.push(input);
    if (throws) throw new Error('publish failed');
    return Promise.resolve({ ok: true, delivered: 'pubsub', receivers: 1 });
  };
  fn.calls = calls;
  return fn;
};

// Reporting-tree stub: HR and ADMIN see the whole company; MGR_A sees
// USER_A; MGR_UNRELATED sees USER_B.
const makeResolveScopeIds = () => async ({ user }) => {
  const id = String(user?._id || user?.id);
  if (id === ADMIN_A || id === HR_A) {
    return [USER_A, USER_B, MGR_A, MGR_UNRELATED, HR_A, ADMIN_A];
  }
  if (id === MGR_A) {
    return [USER_A];
  }
  if (id === MGR_UNRELATED) {
    return [USER_B];
  }
  return [id];
};

const makeClock = (iso = `${TODAY}T09:00:00Z`) => () => new Date(iso);

// User object shape that the service consumes.
const makeUser = (id, name = 'Employee') => ({
  _id: id,
  id,
  name,
  email: `${id}@example.test`,
  role: 'EMPLOYEE',
});

// ── Setup helper ──────────────────────────────────────────

const setup = (overrides = {}) => {
  const {
    policy = {},
    seed = [],
    audit = makeRecorder(),
    notify = makeNotify(),
    publish = makePublisher(),
    throwingAttendance = true,
    throwingLeave = true,
    throwingPayroll = true,
  } = overrides;

  const RequestModel = makeFakeRequestModel(seed);
  const UserModel = makeFakeUserModel([
    { _id: USER_A, name: 'Alice' },
    { _id: USER_B, name: 'Bob' },
    { _id: MGR_A, name: 'Marge' },
    { _id: MGR_UNRELATED, name: 'Ralph' },
    { _id: HR_A, name: 'Helen' },
    { _id: ADMIN_A, name: 'Alan' },
  ]);
  const tenantConfigReader = makeTenantConfigReader(policy);
  const AttendanceModel = throwingAttendance ? makeThrowingSentinel('Attendance') : null;
  const LeaveModel = throwingLeave ? makeThrowingSentinel('Leave') : null;
  const PayrollSnapshotModel = throwingPayroll ? makeThrowingSentinel('PayrollSnapshot') : null;
  const resolveScopeIds = makeResolveScopeIds();

  const service = workLocationRequestService({
    RequestModel,
    UserModel,
    tenantConfigReader,
    AttendanceModel,
    LeaveModel,
    PayrollSnapshotModel,
    notify,
    audit,
    publishInvalidation: publish,
    resolveScopeIds,
    clock: makeClock(),
    dayKeyInZone: (_at, tz) => TODAY, // force today for hermetic tests
  });

  return {
    service,
    RequestModel,
    UserModel,
    tenantConfigReader,
    audit,
    notify,
    publish,
    AttendanceModel,
    LeaveModel,
    PayrollSnapshotModel,
  };
};

// ═══════════════════════════════════════════════════════════
//   §1 POLICY (1–4)
// ═══════════════════════════════════════════════════════════

test('#1 policy — wfhMode=disabled refuses submission', async () => {
  const ctx = setup({ policy: { wfhMode: 'disabled' } });
  await assert.rejects(
    () =>
      ctx.service.submitRequest({
        companyId: COMPANY_A,
        requester: makeUser(USER_A),
        input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
      }),
    (err) => /WFH is disabled/i.test(err.message),
  );
});

test('#2 policy — self_declare does not require a request (returns 409)', async () => {
  const ctx = setup({ policy: { wfhMode: 'self_declare' } });
  await assert.rejects(
    () =>
      ctx.service.submitRequest({
        companyId: COMPANY_A,
        requester: makeUser(USER_A),
        input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
      }),
    (err) => err.statusCode === 409,
  );
});

test('#3 policy — approval_required accepts and creates a PENDING request', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  assert.equal(row.status, 'pending');
  assert.equal(row.location, 'wfh');
});

test('#4 policy — allowedWorkLocations missing "wfh" refuses (cannot bypass allowlist)', async () => {
  const ctx = setup({ policy: { allowedWorkLocations: ['office', 'remote'] } });
  await assert.rejects(
    () =>
      ctx.service.submitRequest({
        companyId: COMPANY_A,
        requester: makeUser(USER_A),
        input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
      }),
    (err) => /not in the allowed work locations/i.test(err.message),
  );
});

// ═══════════════════════════════════════════════════════════
//   §2 IDENTITY (5–9)
// ═══════════════════════════════════════════════════════════

test('#5 identity — validator refuses companyId in body', async () => {
  const { workLocationRequestSubmitValidator } = await import(
    '../src/validators/presence/workLocationRequestValidator.js'
  );
  const req = { body: { companyId: 'x', location: 'wfh', startDate: FUTURE } };
  let threw = null;
  for (const m of workLocationRequestSubmitValidator) {
    try {
      await m.run(req);
    } catch (e) {
      threw = e;
    }
  }
  assert.ok(threw, 'identity-override companyId should have thrown');
});

test('#6 identity — validator refuses userId in body', async () => {
  const { workLocationRequestSubmitValidator } = await import(
    '../src/validators/presence/workLocationRequestValidator.js'
  );
  const req = { body: { userId: 'x', location: 'wfh', startDate: FUTURE } };
  let threw = null;
  for (const m of workLocationRequestSubmitValidator) {
    try {
      await m.run(req);
    } catch (e) {
      threw = e;
    }
  }
  assert.ok(threw, 'identity-override userId should have thrown');
});

test('#7 identity — validator refuses employeeId in body', async () => {
  const { workLocationRequestSubmitValidator } = await import(
    '../src/validators/presence/workLocationRequestValidator.js'
  );
  const req = { body: { employeeId: 'x', location: 'wfh', startDate: FUTURE } };
  let threw = null;
  for (const m of workLocationRequestSubmitValidator) {
    try {
      await m.run(req);
    } catch (e) {
      threw = e;
    }
  }
  assert.ok(threw);
});

test('#8 identity — validator refuses reviewedBy in body', async () => {
  const { workLocationRequestDecideValidator } = await import(
    '../src/validators/presence/workLocationRequestValidator.js'
  );
  const req = {
    body: { reviewedBy: 'someone' },
    params: { requestId: 'wl1' },
  };
  let threw = null;
  for (const m of workLocationRequestDecideValidator) {
    try {
      await m.run(req);
    } catch (e) {
      threw = e;
    }
  }
  assert.ok(threw);
});

test('#9 identity — listMyRequests always scopes to req.user (no override)', async () => {
  const ctx = setup();
  await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_B),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const mine = await ctx.service.listMyRequests({
    companyId: COMPANY_A,
    userId: USER_A,
  });
  assert.equal(mine.requests.length, 1);
  assert.equal(mine.requests[0].status, 'pending');
});

// ═══════════════════════════════════════════════════════════
//   §3 TENANCY (10–12)
// ═══════════════════════════════════════════════════════════

test('#10 tenancy — company B cannot see company A request (404, no existence leak)', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await assert.rejects(
    () =>
      ctx.service.getRequest({
        companyId: COMPANY_B,
        viewer: makeUser(USER_B),
        requestId: row.id || row._id,
        asReviewer: true,
      }),
    (err) => err.statusCode === 404,
  );
});

test('#11 tenancy — company B cannot decide company A request', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await assert.rejects(
    () =>
      ctx.service.decideRequest({
        companyId: COMPANY_B,
        viewer: makeUser(USER_B),
        requestId: row.id || row._id,
        action: 'approve',
      }),
    (err) => err.statusCode === 404,
  );
});

test('#12 tenancy — company B cannot cancel company A request', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await assert.rejects(
    () =>
      ctx.service.cancelRequest({
        companyId: COMPANY_B,
        viewer: makeUser(USER_B),
        requestId: row.id || row._id,
      }),
    (err) => err.statusCode === 404,
  );
});

// ═══════════════════════════════════════════════════════════
//   §4 DATES (13–18)
// ═══════════════════════════════════════════════════════════

test('#13 dates — valid single day accepted', () => {
  const errs = validateRequestInput(
    { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
    TODAY,
  );
  assert.equal(errs.length, 0);
});

test('#14 dates — valid range accepted', () => {
  const errs = validateRequestInput(
    { location: 'wfh', startDate: FUTURE, endDate: '2026-10-15' },
    TODAY,
  );
  assert.equal(errs.length, 0);
});

test('#15 dates — endDate before startDate rejected', () => {
  const errs = validateRequestInput(
    { location: 'wfh', startDate: '2026-10-15', endDate: FUTURE },
    TODAY,
  );
  assert.ok(errs.some((m) => /endDate must be the same as or after startDate/.test(m)));
});

test('#16 dates — startDate in the past rejected', () => {
  const errs = validateRequestInput(
    { location: 'wfh', startDate: '2026-01-01', endDate: '2026-01-02' },
    TODAY,
  );
  assert.ok(errs.some((m) => /startDate cannot be in the past/.test(m)));
});

test('#17 dates — over MAX_RANGE_DAYS rejected', () => {
  const start = '2026-09-22';
  const end = '2028-01-01';
  const errs = validateRequestInput(
    { location: 'wfh', startDate: start, endDate: end },
    TODAY,
  );
  assert.ok(errs.some((m) => /at most/.test(m)));
  assert.ok(MAX_RANGE_DAYS >= 365);
});

test('#18 dates — invalid day strings (Feb 30) rejected', () => {
  const errs = validateRequestInput(
    { location: 'wfh', startDate: '2026-02-30', endDate: '2026-02-30' },
    TODAY,
  );
  assert.ok(errs.length > 0);
});

// ═══════════════════════════════════════════════════════════
//   §5 WORKFLOW (19–26)
// ═══════════════════════════════════════════════════════════

test('#19 workflow — submit lists as PENDING on the owner list', async () => {
  const ctx = setup();
  await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const mine = await ctx.service.listMyRequests({
    companyId: COMPANY_A,
    userId: USER_A,
  });
  assert.equal(mine.requests.length, 1);
  assert.equal(mine.requests[0].status, 'pending');
});

test('#20 workflow — review queue shows pending only', async () => {
  const ctx = setup();
  await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const queue = await ctx.service.listReviewQueue({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
  });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'pending');
});

test('#21 workflow — approve flips status to APPROVED', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const decided = await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
    decisionNote: 'lgtm',
  });
  assert.equal(decided.status, 'approved');
  assert.equal(decided.decisionNote, 'lgtm');
});

test('#22 workflow — reject flips status to REJECTED with decisionNote', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const decided = await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'reject',
    decisionNote: 'not now',
  });
  assert.equal(decided.status, 'rejected');
  assert.equal(decided.decisionNote, 'not now');
});

test('#23 workflow — owner can cancel PENDING', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const cancelled = await ctx.service.cancelRequest({
    companyId: COMPANY_A,
    viewer: makeUser(USER_A),
    requestId: row.id || row._id,
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('#24 workflow — reviewer can cancel PENDING', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const cancelled = await ctx.service.cancelRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('#25 workflow — owner can cancel APPROVED when startDate > today', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  const cancelled = await ctx.service.cancelRequest({
    companyId: COMPANY_A,
    viewer: makeUser(USER_A),
    requestId: row.id || row._id,
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('#26 workflow — owner cannot cancel APPROVED when startDate <= today', async () => {
  const ctx = setup();
  // Use TODAY as start so it falls on the boundary.
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: TODAY, endDate: TODAY },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  await assert.rejects(
    () =>
      ctx.service.cancelRequest({
        companyId: COMPANY_A,
        viewer: makeUser(USER_A),
        requestId: row.id || row._id,
      }),
    (err) => /reviewer cancellation/.test(err.message),
  );
});

// ═══════════════════════════════════════════════════════════
//   §6 AUTHORIZATION (27–32)
// ═══════════════════════════════════════════════════════════

test('#27 authorization — employee cannot decide own (403)', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await assert.rejects(
    () =>
      ctx.service.decideRequest({
        companyId: COMPANY_A,
        viewer: makeUser(USER_A),
        requestId: row.id || row._id,
        action: 'approve',
      }),
    (err) => err.statusCode === 403,
  );
});

test('#28 authorization — unrelated manager cannot decide (403)', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await assert.rejects(
    () =>
      ctx.service.decideRequest({
        companyId: COMPANY_A,
        viewer: makeUser(MGR_UNRELATED),
        requestId: row.id || row._id,
        action: 'approve',
      }),
    (err) => err.statusCode === 403,
  );
});

test('#29 authorization — admin can decide', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const decided = await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(ADMIN_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  assert.equal(decided.status, 'approved');
});

test('#30 authorization — HR can decide', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const decided = await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(HR_A),
    requestId: row.id || row._id,
    action: 'reject',
    decisionNote: 'offline',
  });
  assert.equal(decided.status, 'rejected');
});

test('#31 authorization — direct manager can decide', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const decided = await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  assert.equal(decided.status, 'approved');
});

test('#32 authorization — only admin can cross-team cancel', async () => {
  const ctx = setup();
  // USER_B reports to MGR_UNRELATED.
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_B),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  // MGR_A cannot cancel cross-team.
  await assert.rejects(
    () =>
      ctx.service.cancelRequest({
        companyId: COMPANY_A,
        viewer: makeUser(MGR_A),
        requestId: row.id || row._id,
      }),
    (err) => err.statusCode === 403,
  );
  // Admin can.
  const cancelled = await ctx.service.cancelRequest({
    companyId: COMPANY_A,
    viewer: makeUser(ADMIN_A),
    requestId: row.id || row._id,
  });
  assert.equal(cancelled.status, 'cancelled');
});

// ═══════════════════════════════════════════════════════════
//   §7 ATOMICITY (33–34)
// ═══════════════════════════════════════════════════════════

test('#33 atomicity — two parallel approves: exactly one wins (other 409)', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const id = row.id || row._id;
  const a = ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(HR_A),
    requestId: id,
    action: 'approve',
  });
  const b = ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(ADMIN_A),
    requestId: id,
    action: 'reject',
  });
  const settled = await Promise.allSettled([a, b]);
  const winners = settled.filter((s) => s.status === 'fulfilled');
  const losers = settled.filter((s) => s.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.statusCode, 409);
});

test('#34 atomicity — cancel a non-pending returns 409', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const id = row.id || row._id;
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: id,
    action: 'reject',
    decisionNote: 'no',
  });
  await assert.rejects(
    () =>
      ctx.service.cancelRequest({
        companyId: COMPANY_A,
        viewer: makeUser(USER_A),
        requestId: id,
      }),
    (err) => err.statusCode === 409,
  );
});

// ═══════════════════════════════════════════════════════════
//   §8 RESOLUTION (35–40)
// ═══════════════════════════════════════════════════════════

test('#35 resolution — findActiveApproval returns row covering a day in range', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: '2026-10-05' },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  const found = await ctx.service.findActiveApproval({
    companyId: COMPANY_A,
    userId: USER_A,
    date: '2026-09-30',
  });
  assert.ok(found, 'expected an active approval on a date inside the range');
  assert.equal(found.startDate, FUTURE);
});

test('#36 resolution — findActiveApproval returns null for an out-of-range day', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  const found = await ctx.service.findActiveApproval({
    companyId: COMPANY_A,
    userId: USER_A,
    date: '2027-01-01',
  });
  assert.equal(found, null);
});

test('#37 resolution — findActiveApproval returns null after cancel', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  await ctx.service.cancelRequest({
    companyId: COMPANY_A,
    viewer: makeUser(USER_A),
    requestId: row.id || row._id,
  });
  const found = await ctx.service.findActiveApproval({
    companyId: COMPANY_A,
    userId: USER_A,
    date: FUTURE,
  });
  assert.equal(found, null);
});

test('#38 resolution — overlap check blocks duplicate PENDING', async () => {
  const ctx = setup();
  await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: '2026-10-05' },
  });
  await assert.rejects(
    () =>
      ctx.service.submitRequest({
        companyId: COMPANY_A,
        requester: makeUser(USER_A),
        input: { location: 'wfh', startDate: '2026-10-04', endDate: '2026-10-10' },
      }),
    (err) => /Overlaps an existing/.test(err.message),
  );
});

test('#39 resolution — overlap check is per-user (USER_B not blocked by USER_A)', async () => {
  const ctx = setup();
  await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_B),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  assert.equal(row.status, 'pending');
});

test('#40 resolution — pure rule: rangesIntersect', () => {
  assert.equal(
    requestsOverlap(
      { startDate: '2026-01-01', endDate: '2026-01-10' },
      { startDate: '2026-01-05', endDate: '2026-01-15' },
    ),
    true,
  );
  assert.equal(
    requestsOverlap(
      { startDate: '2026-01-01', endDate: '2026-01-10' },
      { startDate: '2026-01-11', endDate: '2026-01-15' },
    ),
    false,
  );
});

// ═══════════════════════════════════════════════════════════
//   §9 NOTIFICATIONS / AUDIT (41–45)
// ═══════════════════════════════════════════════════════════

test('#41 notifications — approve notifies the requester', async () => {
  const notify = makeNotify();
  const ctx = setup({ notify });
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  const recipientIds = notify.calls.map((c) => c.userId);
  assert.ok(recipientIds.includes(USER_A), 'requester should have been notified');
});

test('#42 notifications — reject notifies the requester', async () => {
  const notify = makeNotify();
  const ctx = setup({ notify });
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'reject',
    decisionNote: 'no',
  });
  const recipientIds = notify.calls.map((c) => c.userId);
  assert.ok(recipientIds.includes(USER_A));
});

test('#43 notifications — cancel by reviewer notifies the owner', async () => {
  const notify = makeNotify();
  const ctx = setup({ notify });
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.cancelRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
  });
  const recipientIds = notify.calls.map((c) => c.userId);
  assert.ok(recipientIds.includes(USER_A));
});

test('#44 notifications — notify failure does NOT roll back Mongo', async () => {
  const bad = () => Promise.reject(new Error('notify down'));
  const ctx = setup({ notify: bad });
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  // Decide must succeed even if every notify throws.
  const decided = await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  assert.equal(decided.status, 'approved');
});

test('#45 audit — every transition writes a recordAudit row', async () => {
  const audit = makeRecorder();
  const ctx = setup({ audit });
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  await ctx.service.cancelRequest({
    companyId: COMPANY_A,
    viewer: makeUser(USER_A),
    requestId: row.id || row._id,
  });
  const actions = audit.calls.map((c) => c.action);
  assert.ok(actions.includes('PRESENCE_WORK_MODE_REQUEST_SUBMITTED'));
  assert.ok(actions.includes('PRESENCE_WORK_MODE_REQUEST_APPROVED'));
  assert.ok(actions.includes('PRESENCE_WORK_MODE_REQUEST_CANCELLED'));
});

// ═══════════════════════════════════════════════════════════
//   §10 REALTIME (46–48)
// ═══════════════════════════════════════════════════════════

test('#46 realtime — approve publishes presence:invalidated for the requester', async () => {
  const publish = makePublisher();
  const ctx = setup({ publish });
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  const last = publish.calls[publish.calls.length - 1];
  assert.equal(last.userId, USER_A);
  assert.equal(last.source, 'approve');
  assert.equal(last.companyId, COMPANY_A);
});

test('#47 realtime — envelope carries NO PII fields (assert field set)', async () => {
  const { buildPresenceInvalidatedEnvelope } = await import(
    '../src/services/presence/presenceEvents.js'
  );
  const built = buildPresenceInvalidatedEnvelope({
    companyId: COMPANY_A,
    userId: USER_A,
    source: 'approve',
    occurredAt: '2026-09-15T09:00:00.000Z',
  });
  const keys = Object.keys(built.envelope).sort();
  assert.deepEqual(keys, [
    'companyId',
    'occurredAt',
    'schemaVersion',
    'source',
    'userId',
  ]);
  // Explicit anti-leak assertions.
  for (const forbidden of [
    'decisionNote',
    'email',
    'phone',
    'salary',
    'reviewer',
    'reviewedBy',
    'token',
  ]) {
    assert.equal(built.envelope[forbidden], undefined);
  }
});

test('#48 realtime — publish failure does NOT roll back Mongo', async () => {
  const publish = makePublisher({ throws: true });
  const ctx = setup({ publish });
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  // Even if publish throws, the decision commits.
  const decided = await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  assert.equal(decided.status, 'approved');
});

// ═══════════════════════════════════════════════════════════
//   §11 HR BOUNDARIES (49–56)
// ═══════════════════════════════════════════════════════════

test('#49 boundary — Attendance.create is never called (sentinel throws)', async () => {
  const ctx = setup();
  // Submit + decide + cancel + a happy-path refetch. None may touch
  // Attendance.
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'approve',
  });
  // If Attendance.create had been called, the sentinel would have
  // thrown. Reaching this line means it was not.
  assert.ok(true);
});

test('#50 boundary — Leave.create is never called (sentinel throws)', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.cancelRequest({
    companyId: COMPANY_A,
    viewer: makeUser(USER_A),
    requestId: row.id || row._id,
  });
  assert.ok(true);
});

test('#51 boundary — PayrollSnapshot.create is never called', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'reject',
    decisionNote: 'no',
  });
  assert.ok(true);
});

test('#52 boundary — no services/ai/ imports in 37.5 backend files', () => {
  const files = [
    'src/models/WorkLocationRequest.js',
    'src/services/presence/workLocationRequestRules.js',
    'src/services/presence/workLocationRequestService.js',
    'src/controllers/presence/workLocationRequestController.js',
    'src/routes/presence/workLocationRequestRoutes.js',
    'src/validators/presence/workLocationRequestValidator.js',
  ];
  for (const f of files) {
    const src = read(f);
    assert.equal(
      /from\s+['"][^'"]*services\/ai/i.test(src),
      false,
      `forbidden AI import in ${f}`,
    );
  }
});

test('#53 boundary — no NATS / nats.js imports in 37.5 backend files', () => {
  const files = [
    'src/models/WorkLocationRequest.js',
    'src/services/presence/workLocationRequestRules.js',
    'src/services/presence/workLocationRequestService.js',
    'src/controllers/presence/workLocationRequestController.js',
    'src/routes/presence/workLocationRequestRoutes.js',
    'src/validators/presence/workLocationRequestValidator.js',
  ];
  for (const f of files) {
    const src = read(f);
    assert.equal(/nats/i.test(src), false, `forbidden NATS import in ${f}`);
  }
});

test('#54 boundary — no localStorage / browser storage in 37.5 backend files', () => {
  const files = [
    'src/models/WorkLocationRequest.js',
    'src/services/presence/workLocationRequestService.js',
    'src/controllers/presence/workLocationRequestController.js',
  ];
  for (const f of files) {
    const src = read(f);
    assert.equal(/localStorage/i.test(src), false, `localStorage in ${f}`);
    assert.equal(/sessionStorage/i.test(src), false, `sessionStorage in ${f}`);
  }
});

test('#55 boundary — no .env reads or writes in 37.5 backend files', () => {
  const files = [
    'src/models/WorkLocationRequest.js',
    'src/services/presence/workLocationRequestService.js',
    'src/services/presence/workLocationRequestRules.js',
    'src/controllers/presence/workLocationRequestController.js',
    'src/routes/presence/workLocationRequestRoutes.js',
    'src/validators/presence/workLocationRequestValidator.js',
  ];
  for (const f of files) {
    const src = read(f);
    assert.equal(/process\.env\.([A-Z_]+_NEW|.*NEW.*)/.test(src), false);
    assert.equal(/\.env\.write/i.test(src), false);
  }
});

test('#56 boundary — service does not import Attendance / Leave / Payroll models', () => {
  const src = read('src/services/presence/workLocationRequestService.js');
  assert.equal(/from\s+['"][^'"]*models\/AttendanceEvent/i.test(src), false);
  assert.equal(/from\s+['"][^'"]*models\/AttendancePayrollSnapshot/i.test(src), false);
  assert.equal(/from\s+['"][^'"]*models\/Leave['"]/i.test(src), false);
});

// ═══════════════════════════════════════════════════════════
//   §12 DATA MINIMIZATION (57–61)
// ═══════════════════════════════════════════════════════════

test('#57 datamin — serialized response excludes PII fields', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  const ser = serializeRequest(row, { viewerId: USER_A, today: TODAY });
  const forbidden = [
    'salary',
    'bank',
    'aadhaar',
    'pan',
    'uan',
    'address',
    'attendance',
    'leaveReason',
    'medical',
    'password',
    'refreshToken',
  ];
  for (const key of forbidden) {
    assert.equal(ser[key], undefined, `${key} should not be in serialized payload`);
  }
});

test('#58 datamin — invalidation envelope has the fixed 5 keys', async () => {
  const { buildPresenceInvalidatedEnvelope } = await import(
    '../src/services/presence/presenceEvents.js'
  );
  const built = buildPresenceInvalidatedEnvelope({
    companyId: COMPANY_A,
    userId: USER_A,
    source: 'approve',
    occurredAt: '2026-09-15T09:00:00.000Z',
  });
  assert.equal(Object.keys(built.envelope).length, 5);
});

test('#59 datamin — queue payload does not include reviewer note (only requesterName)', async () => {
  const ctx = setup();
  const row = await ctx.service.submitRequest({
    companyId: COMPANY_A,
    requester: makeUser(USER_A),
    input: { location: 'wfh', startDate: FUTURE, endDate: FUTURE },
  });
  await ctx.service.decideRequest({
    companyId: COMPANY_A,
    viewer: makeUser(MGR_A),
    requestId: row.id || row._id,
    action: 'reject',
    decisionNote: 'no',
  });
  // Re-seed: the rejected row's decisionNote must NOT appear in the
  // review queue payload (it would not be there anyway because the
  // row is no longer PENDING, but the serializer should never carry
  // it through to a queue item).
  const queue = await ctx.service.listReviewQueue({
    companyId: COMPANY_A,
    viewer: makeUser(HR_A),
  });
  for (const item of queue) {
    assert.equal(item.decisionNote, undefined);
  }
});

test('#60 datamin — past-date and overlap errors carry no PII', async () => {
  const ctx = setup();
  let err;
  try {
    await ctx.service.submitRequest({
      companyId: COMPANY_A,
      requester: makeUser(USER_A),
      input: { location: 'wfh', startDate: '2020-01-01', endDate: '2020-01-01' },
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.email, undefined);
  assert.equal(err.salary, undefined);
  assert.equal(err.aadhaar, undefined);
});

test('#61 datamin — service has no hard-coded secrets or tokens', () => {
  const src = read('src/services/presence/workLocationRequestService.js');
  assert.equal(/sk_live/i.test(src), false);
  assert.equal(/bearer\s+[A-Za-z0-9]/i.test(src), false);
  assert.equal(/password\s*[:=]\s*['"`]/i.test(src), false);
});
