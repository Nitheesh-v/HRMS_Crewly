// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 38 — PROFILE CHANGE REQUESTS (hermetic suite)
//
//  No MongoDB, no Redis, no network, no HTTP server: the two models, the
//  scope resolver, notifications, the audit sink and the clock are all
//  injected fakes. The REAL rules, service, validators and permission
//  catalogue run against them.
//
//  What this suite pins:
//    1. the field allowlist refuses anything that is not a requestable
//       profile field (role, companyId, password, …);
//    2. tenant isolation — a request is invisible and undecidable from
//       another company, and the scope check runs on the decide path;
//    3. the state machine — pending → approved/rejected/cancelled only,
//       one open request per field, rejections need a reason;
//    4. apply semantics — approving writes the value to the employee record,
//       drift since submission is refused (compensated back to pending),
//       a duplicate employee code is a 409;
//    5. privacy — sensitive values are masked on the wire and the raw
//       copies are structurally excluded from responses;
//    6. no attendance / leave / payroll writes, ever.
// ═══════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const EMPLOYEE = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const HR = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const OUTSIDER = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const STRANGER = 'aaaaaaaaaaaaaaaaaaaaaaa8';

const [
  rules,
  serviceModule,
  validatorModule,
  registry,
] = await Promise.all([
  import('../src/services/profile/profileChangeRules.js'),
  import('../src/services/profile/profileChangeService.js'),
  import('../src/validators/profileChangeValidator.js'),
  import('../src/utils/permissionRegistry.js'),
]);

const {
  CHANGE_STATUS,
  MAX_CHANGES_PER_REQUEST,
  validateChangeRequestInput,
  serializeChangeRequest,
  canTransition,
  reviewEligibility,
  cancelEligibility,
} = rules;
const { profileChangeService } = serviceModule;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;

// ── Fake model plumbing ────────────────────────────────────────────────────

const norm = (value) =>
  value && typeof value === 'object' && !(value instanceof Date) && value._id !== undefined
    ? String(value._id)
    : value instanceof Date
      ? value.toISOString()
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
      if (value.$gt !== undefined) return norm(actual) > norm(value.$gt);
      if (value.$type !== undefined) {
        if (value.$type === 'string') return typeof actual === 'string';
        return true;
      }
      return true;
    }
    if (value === null) return actual === null || actual === undefined;
    return norm(actual) === norm(value);
  });

const chain = (resolve) => {
  const self = {
    select: () => self,
    sort: () => self,
    lean: () => self,
    populate: () => self,
    then: (onFulfilled, onRejected) =>
      Promise.resolve().then(resolve).then(onFulfilled, onRejected),
  };
  return self;
};

const withToObject = (row) => ({ ...row, toObject() { return { ...this }; } });

// Minimal in-memory ProfileChangeRequest.
const makeFakeRequestModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  let seq = rows.length + 1;

  const duplicatePending = (doc, ignoreId = null) => {
    if (doc.status !== 'pending') return false;
    const fields = doc.pendingFields || (doc.changes || []).map((change) => change.field);
    return rows.some(
      (row) =>
        row.status === 'pending' &&
        String(row._id) !== String(ignoreId) &&
        String(row.companyId) === String(doc.companyId) &&
        String(row.employeeId) === String(doc.employeeId) &&
        (row.pendingFields || []).some((field) => fields.includes(field)),
    );
  };

  return {
    rows,
    findOne: (filter) => chain(() => rows.find((row) => matches(row, filter)) || null),
    find: (filter) =>
      chain(() =>
        rows
          .filter((row) => matches(row, filter))
          .map((row) => ({ ...row })),
      ),
    create: async (doc) => {
      if (duplicatePending(doc)) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      const row = {
        status: 'pending',
        reason: '',
        decisionNote: '',
        reviewedAt: null,
        reviewedBy: null,
        appliedAt: null,
        createdAt: new Date(),
        ...doc,
        _id: `pcr${seq}`,
      };
      seq += 1;
      rows.push(row);
      return withToObject(row);
    },
    findOneAndUpdate: async (filter, update, opts = {}) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return null;
      Object.assign(row, update.$set || {});
      return opts.new ? withToObject(row) : { ...row };
    },
    updateOne: async (filter, update) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return { matchedCount: 0 };
      Object.assign(row, update.$set || {});
      return { matchedCount: 1 };
    },
  };
};

// Minimal in-memory User model.
const makeFakeUserModel = (seed = []) => {
  const rows = seed.map((row) => ({ ...row }));
  const writes = [];

  return {
    rows,
    writes,
    find: (filter) =>
      chain(() =>
        rows.filter((row) => matches(row, filter)).map((row) => ({ ...row })),
      ),
    findOne: (filter) => chain(() => rows.find((row) => matches(row, filter)) || null),
    findById: (id) => chain(() => rows.find((row) => String(row._id) === String(id)) || null),
    updateOne: async (filter, update) => {
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return { matchedCount: 0 };
      const set = update.$set || {};
      // Unique { companyId, employeeCode } per tenant, like the real index.
      if (set.employeeCode) {
        const clash = rows.some(
          (other) =>
            String(other._id) !== String(row._id) &&
            String(other.companyId) === String(row.companyId) &&
            String(other.employeeCode || '').toUpperCase() ===
              String(set.employeeCode).toUpperCase(),
        );
        if (clash) {
          const error = new Error('duplicate key');
          error.code = 11000;
          throw error;
        }
      }
      Object.assign(row, set);
      writes.push({ filter, set });
      return { matchedCount: 1 };
    },
  };
};

// If any workflow path ever tries to write attendance / leave / payroll,
// these stubs throw and the test fails loudly.
const makeThrowingSentinel = (label) => ({
  create: async () => {
    throw new Error(`${label} must never be written by Phase 38`);
  },
  updateOne: async () => {
    throw new Error(`${label} must never be written by Phase 38`);
  },
  findOneAndUpdate: async () => {
    throw new Error(`${label} must never be written by Phase 38`);
  },
});

const baseUsers = () => [
  {
    _id: EMPLOYEE,
    companyId: COMPANY_A,
    name: 'Manikandan R',
    designation: 'Software Engineer',
    employeeCode: 'IX-001',
    dateOfJoining: new Date('2024-04-01T00:00:00.000Z'),
    bankAccount: '123456789012',
    ifsc: 'HDFC0001234',
    status: 'ACTIVE',
    role: 'EMPLOYEE',
  },
  { _id: HR, companyId: COMPANY_A, name: 'HRinfo', role: 'HR_MANAGER', status: 'ACTIVE' },
  { _id: ADMIN, companyId: COMPANY_A, name: 'Aditi', role: 'COMPANY_ADMIN', status: 'ACTIVE' },
  {
    _id: OUTSIDER,
    companyId: COMPANY_B,
    name: 'Other Tenant Employee',
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    employeeCode: 'AG-001',
  },
];

const buildService = ({ users = baseUsers(), requests = [], today = '2026-10-07', companyScope = 'COMPANY' } = {}) => {
  const RequestModel = makeFakeRequestModel(requests);
  const UserModel = makeFakeUserModel(users);
  const notifications = [];
  const audits = [];

  const service = profileChangeService({
    RequestModel,
    UserModel,
    AttendanceModel: makeThrowingSentinel('Attendance'),
    LeaveModel: makeThrowingSentinel('Leave'),
    PayrollModel: makeThrowingSentinel('PayrollSnapshot'),
    notify: async (userId, payload) => {
      notifications.push({ userId: String(userId), ...payload });
    },
    audit: async (args) => {
      audits.push(args);
    },
    // Mirrors the production resolver's shape: an ordinary EMPLOYEE is a
    // requester, never a reviewer, so their scope is empty.
    resolveScopeIds: async ({ companyId, viewer }) => {
      if (companyScope === 'SELF_ONLY') return [];
      if (!['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'].includes(viewer?.role)) {
        return [];
      }
      return UserModel.rows
        .filter((row) => String(row.companyId) === String(companyId))
        .map((row) => String(row._id));
    },
    clock: () => new Date(`${today}T09:00:00.000Z`),
    dayKeyInZone: () => today,
  });

  return { service, RequestModel, UserModel, notifications, audits };
};

const employee = { _id: EMPLOYEE, name: 'Manikandan R', role: 'EMPLOYEE' };
const hrUser = { _id: HR, name: 'HRinfo', role: 'HR_MANAGER' };
const adminUser = { _id: ADMIN, name: 'Aditi', role: 'COMPANY_ADMIN' };

// ── 1. Allowlist + validation ─────────────────────────────────────────────

test('38: only allowlisted profile fields may be requested', () => {
  const { errors, changes } = validateChangeRequestInput(
    { changes: { role: 'COMPANY_ADMIN' } },
    { today: '2026-10-07', currentProfile: { role: 'EMPLOYEE' } },
  );
  assert.equal(changes.length, 0);
  assert.match(errors[0], /cannot be changed/);
});

test('38: identity fields are not requestable either', () => {
  for (const field of ['companyId', 'password', 'reportingTo', 'tokenVersion', 'status']) {
    const { errors } = validateChangeRequestInput(
      { changes: { [field]: 'x' } },
      { today: '2026-10-07', currentProfile: {} },
    );
    assert.ok(errors.length > 0, `${field} must be refused`);
  }
});

test('38: a no-op request (same value) is refused, not queued', () => {
  const { errors } = validateChangeRequestInput(
    { changes: { designation: ' Software Engineer ' } },
    { today: '2026-10-07', currentProfile: { designation: 'Software Engineer' } },
  );
  assert.match(errors[0], /already has this value/);
});

test('38: per-field validation — name, employeeCode, dateOfJoining, ifsc, bankAccount', () => {
  const ctx = { today: '2026-10-07', currentProfile: {} };

  assert.match(
    validateChangeRequestInput({ changes: { name: 'A' } }, ctx).errors[0],
    /at least 2 characters/,
  );
  assert.match(
    validateChangeRequestInput({ changes: { employeeCode: 'bad code!' } }, ctx).errors[0],
    /may contain letters/,
  );
  assert.match(
    validateChangeRequestInput({ changes: { dateOfJoining: '2099-01-01' } }, ctx).errors[0],
    /future/,
  );
  assert.match(
    validateChangeRequestInput({ changes: { ifsc: 'HDFC123' } }, ctx).errors[0],
    /11 characters/,
  );
  assert.match(
    validateChangeRequestInput({ changes: { bankAccount: '12 34' } }, ctx).errors[0],
    /9 to 18 digits/,
  );
});

test('38: employee code taken by a colleague is refused at submit time', () => {
  const { errors } = validateChangeRequestInput(
    { changes: { employeeCode: 'IX-002' } },
    { today: '2026-10-07', currentProfile: { employeeCode: 'IX-001' }, takenCodes: ['IX-002'] },
  );
  assert.match(errors[0], /already used/);
});

test('38: at most MAX_CHANGES_PER_REQUEST fields in one request', () => {
  const tooMany = {};
  for (let i = 0; i <= MAX_CHANGES_PER_REQUEST; i += 1) tooMany[`f${i}`] = 'x';
  const { errors } = validateChangeRequestInput(
    { changes: tooMany },
    { today: '2026-10-07', currentProfile: {} },
  );
  assert.match(errors[0], new RegExp(`at most ${MAX_CHANGES_PER_REQUEST}`));
});

// ── 2. Submit ─────────────────────────────────────────────────────────────

test('38: submit stores a diff, masks bank values and notifies reviewers', async () => {
  const { service, RequestModel, notifications, audits } = buildService();

  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: {
      changes: { bankAccount: '999888777666', ifsc: 'ICIC0004321' },
      reason: 'Salary account moved to ICICI',
    },
  });

  assert.equal(created.status, CHANGE_STATUS.PENDING);
  assert.equal(created.changes.length, 2);
  assert.equal(RequestModel.rows.length, 1);
  assert.equal(RequestModel.rows[0].companyId, COMPANY_A);
  assert.equal(RequestModel.rows[0].employeeId, EMPLOYEE);
  assert.deepEqual(RequestModel.rows[0].pendingFields.sort(), ['bankAccount', 'ifsc']);

  // The stored document keeps the raw value so the approver can apply it…
  assert.equal(RequestModel.rows[0].changes[0]._toRaw, '999888777666');
  // …the response does not.
  const serialized = JSON.stringify(created);
  assert.equal(serialized.includes('999888777666'), false);
  // Tail-only mask: 8 bullets + the last four digits, never the middle.
  assert.match(created.changes[0].to, /7666$/);
  assert.match(created.changes[0].to, /^•+7666$/);
  assert.equal(created.changes[0].from, '••••••••9012');

  assert.equal(notifications.length, 2); // HR_MANAGER + COMPANY_ADMIN in tenant A
  assert.ok(audits.some((row) => row.action === 'PROFILE_CHANGE_REQUEST_SUBMITTED'));
});

test('38: a second open request for the same field is a 409', async () => {
  const { service } = buildService();
  await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { name: 'Manikandan Ramasamy' } },
  });

  await assert.rejects(
    () =>
      service.submitRequest({
        companyId: COMPANY_A,
        requester: employee,
        input: { changes: { name: 'Mani R' } },
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /already have an open request/);
      return true;
    },
  );
});

test('38: a non-allowlisted field never reaches the database', async () => {
  const { service, RequestModel } = buildService();
  await assert.rejects(
    () =>
      service.submitRequest({
        companyId: COMPANY_A,
        requester: employee,
        input: { changes: { role: 'COMPANY_ADMIN' } },
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
  assert.equal(RequestModel.rows.length, 0);
});

// ── 3. Tenant isolation ───────────────────────────────────────────────────

test('38: a request from another company cannot be read or decided', async () => {
  const { service } = buildService();
  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { name: 'Manikandan Ramasamy' } },
  });

  const outsider = { _id: OUTSIDER, name: 'Other Tenant Employee', role: 'HR_MANAGER' };
  const otherTenant = await service.listReviewQueue({ companyId: COMPANY_B, viewer: outsider });
  assert.equal(otherTenant.length, 0);

  await assert.rejects(
    () =>
      service.decideRequest({
        companyId: COMPANY_B,
        viewer: outsider,
        requestId: created.id,
        action: 'approve',
      }),
    (error) => {
      assert.equal(error.statusCode, 404);
      return true;
    },
  );

  await assert.rejects(
    () =>
      service.getRequest({
        companyId: COMPANY_B,
        viewer: outsider,
        requestId: created.id,
        asReviewer: true,
      }),
    (error) => {
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test('38: an employee cannot read someone else`s request', async () => {
  const { service } = buildService();
  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { designation: 'Senior Software Engineer' } },
  });

  await assert.rejects(
    () =>
      service.getRequest({
        companyId: COMPANY_A,
        viewer: { _id: ADMIN, role: 'EMPLOYEE' },
        requestId: created.id,
        asReviewer: false,
      }),
    (error) => {
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
});

test('38: a reviewer outside the org scope is refused on the decide path', async () => {
  const { service, RequestModel } = buildService({ companyScope: 'SELF_ONLY' });
  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { ifsc: 'ICIC0004321' } },
  });

  await assert.rejects(
    () =>
      service.decideRequest({
        companyId: COMPANY_A,
        viewer: hrUser,
        requestId: created.id,
        action: 'approve',
      }),
    (error) => {
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
  assert.equal(RequestModel.rows[0].status, CHANGE_STATUS.PENDING);
});

// ── 4. Decide + apply ─────────────────────────────────────────────────────

test('38: approving applies the values to the employee record and stamps appliedAt', async () => {
  const { service, RequestModel, UserModel, notifications, audits } = buildService();

  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: {
      changes: { designation: 'Senior Software Engineer', dateOfJoining: '2024-05-01' },
      reason: 'Promotion letter dated 1 May',
    },
  });

  const decided = await service.decideRequest({
    companyId: COMPANY_A,
    viewer: hrUser,
    requestId: created.id,
    action: 'approve',
    decisionNote: 'Verified against the promotion letter',
  });

  assert.equal(decided.status, CHANGE_STATUS.APPROVED);
  const row = UserModel.rows.find((candidate) => candidate._id === EMPLOYEE);
  assert.equal(row.designation, 'Senior Software Engineer');
  assert.equal(new Date(row.dateOfJoining).toISOString().slice(0, 10), '2024-05-01');
  assert.ok(RequestModel.rows[0].appliedAt);
  assert.equal(RequestModel.rows[0].reviewedBy, HR);
  assert.ok(audits.some((entry) => entry.action === 'PROFILE_CHANGE_REQUEST_APPROVED'));
  assert.ok(
    notifications.some((entry) => entry.userId === EMPLOYEE && /approved/i.test(entry.title)),
  );
});

test('38: a decided request cannot be decided twice', async () => {
  const { service } = buildService();
  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { ifsc: 'ICIC0004321' } },
  });

  await service.decideRequest({
    companyId: COMPANY_A,
    viewer: adminUser,
    requestId: created.id,
    action: 'approve',
    decisionNote: 'ok',
  });

  await assert.rejects(
    () =>
      service.decideRequest({
        companyId: COMPANY_A,
        viewer: hrUser,
        requestId: created.id,
        action: 'approve',
        decisionNote: 'again',
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
});

test('38: a reviewer cannot approve their own request', async () => {
  const { service } = buildService();
  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: { _id: HR, name: 'HRinfo', role: 'HR_MANAGER' },
    input: { changes: { designation: 'HR Manager' } },
  });

  await assert.rejects(
    () =>
      service.decideRequest({
        companyId: COMPANY_A,
        viewer: hrUser,
        requestId: created.id,
        action: 'approve',
      }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /cannot review your own request/);
      return true;
    },
  );
});

test('38: rejection needs a reason, never touches the profile, and frees the field', async () => {
  const { service, UserModel, RequestModel } = buildService();
  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { name: 'Manikandan Ramasamy' } },
  });

  await assert.rejects(
    () =>
      service.decideRequest({
        companyId: COMPANY_A,
        viewer: hrUser,
        requestId: created.id,
        action: 'reject',
        decisionNote: '   ',
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      return true;
    },
  );

  const rejected = await service.decideRequest({
    companyId: COMPANY_A,
    viewer: hrUser,
    requestId: created.id,
    action: 'reject',
    decisionNote: 'Please share the name-change affidavit first.',
  });

  assert.equal(rejected.status, CHANGE_STATUS.REJECTED);
  assert.equal(UserModel.rows.find((row) => row._id === EMPLOYEE).name, 'Manikandan R');

  // The partial unique slot is free again → the employee may ask once more.
  const again = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { name: 'Manikandan Ramasamy' }, reason: 'Affidavit attached' },
  });
  assert.equal(again.status, CHANGE_STATUS.PENDING);
  assert.equal(RequestModel.rows.length, 2);
});

test('38: a profile that moved after submission is refused and stays pending', async () => {
  const { service, RequestModel, UserModel } = buildService();
  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { designation: 'Tech Lead' } },
  });

  // Somebody else (Users page) changes the same field meanwhile.
  UserModel.rows.find((row) => row._id === EMPLOYEE).designation = 'Engineering Manager';

  await assert.rejects(
    () =>
      service.decideRequest({
        companyId: COMPANY_A,
        viewer: hrUser,
        requestId: created.id,
        action: 'approve',
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /changed after this request was submitted/);
      return true;
    },
  );

  // Compensation: back in the queue, still decidable.
  assert.equal(RequestModel.rows[0].status, CHANGE_STATUS.PENDING);
  assert.equal(RequestModel.rows[0].reviewedBy, null);
  assert.equal(
    UserModel.rows.find((row) => row._id === EMPLOYEE).designation,
    'Engineering Manager',
  );
});

test('38: a duplicate employee code surfaces as 409, not a 500', async () => {
  const { service, UserModel, RequestModel } = buildService();

  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { employeeCode: 'IX-777' } },
  });

  // Somebody hires a person with that code between submit and approve.
  UserModel.rows.push({
    _id: 'aaaaaaaaaaaaaaaaaaaaaaa9',
    companyId: COMPANY_A,
    name: 'New Joiner',
    employeeCode: 'IX-777',
    status: 'ACTIVE',
  });

  await assert.rejects(
    () =>
      service.decideRequest({
        companyId: COMPANY_A,
        viewer: hrUser,
        requestId: created.id,
        action: 'approve',
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /already used/);
      return true;
    },
  );

  // Compensation keeps the request in the queue instead of half-applying it.
  assert.equal(RequestModel.rows[0].status, CHANGE_STATUS.PENDING);
  assert.equal(UserModel.rows.find((row) => row._id === EMPLOYEE).employeeCode, 'IX-001');
});

test('38: cancel is owner-or-reviewer only, and pending only', async () => {
  const { service } = buildService();
  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { ifsc: 'ICIC0004321' } },
  });

  await assert.rejects(
    () =>
      service.cancelRequest({
        companyId: COMPANY_A,
        viewer: { _id: STRANGER, role: 'EMPLOYEE' },
        requestId: created.id,
      }),
    (error) => {
      assert.equal(error.statusCode, 403);
      return true;
    },
  );

  const cancelled = await service.cancelRequest({
    companyId: COMPANY_A,
    viewer: employee,
    requestId: created.id,
  });
  assert.equal(cancelled.status, CHANGE_STATUS.CANCELLED);

  await assert.rejects(
    () =>
      service.cancelRequest({
        companyId: COMPANY_A,
        viewer: employee,
        requestId: created.id,
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
});

// ── 5. Rules-level guarantees ─────────────────────────────────────────────

test('38: the state machine is pending-only and terminal states are final', () => {
  assert.equal(canTransition('pending', 'approved'), true);
  assert.equal(canTransition('pending', 'rejected'), true);
  assert.equal(canTransition('pending', 'cancelled'), true);
  assert.equal(canTransition('approved', 'cancelled'), false);
  assert.equal(canTransition('rejected', 'approved'), false);
  assert.equal(canTransition('cancelled', 'pending'), false);
});

test('38: review and cancel eligibility read the status, not the caller`s hopes', () => {
  const row = { status: 'approved', employeeId: EMPLOYEE };
  assert.match(reviewEligibility(row, HR), /already approved/);
  assert.match(cancelEligibility(row, { isOwner: true }), /cannot be cancelled/);
  assert.match(cancelEligibility({ status: 'pending', employeeId: EMPLOYEE }, {}), /not authorized/);
  assert.equal(
    reviewEligibility({ status: 'pending', employeeId: EMPLOYEE }, HR),
    null,
  );
});

test('38: serialization never leaks raw copies', () => {
  const serialized = serializeChangeRequest(
    {
      _id: 'pcr1',
      status: 'pending',
      employeeId: EMPLOYEE,
      changes: [
        {
          field: 'bankAccount',
          label: 'Bank account number',
          from: '••••9012',
          to: '••••7666',
          _fromRaw: '123456789012',
          _toRaw: '999888777666',
        },
      ],
    },
    { viewerId: EMPLOYEE },
  );

  const json = JSON.stringify(serialized);
  assert.equal(json.includes('123456789012'), false);
  assert.equal(json.includes('999888777666'), false);
  // When the raw copies are present the mask is derived from them; the
  // stored display columns are used only when no raw value was captured.
  assert.equal(serialized.changes[0].from, '••••••••9012');
  assert.equal(serialized.changes[0].to, '••••••••7666');
  assert.equal(serialized.canReview, false);
  assert.equal(serialized.canCancel, true);
});

// ── 6. Permissions + validators ───────────────────────────────────────────

test('38: PROFILE_CHANGE_REVIEW is in the catalogue, granted to HR + Admin only', () => {
  const names = DEFAULT_PERMISSIONS.map((permission) => permission.name);
  assert.ok(names.includes('PROFILE_CHANGE_REVIEW'));

  const hr = DEFAULT_ROLE_MATRIX.HR_MANAGER;
  const admin = DEFAULT_ROLE_MATRIX.COMPANY_ADMIN;
  const employeeMatrix = DEFAULT_ROLE_MATRIX.EMPLOYEE;

  assert.ok(hr.includes('PROFILE_CHANGE_REVIEW'), 'HR_MANAGER must review profile changes');
  assert.ok(admin.includes('PROFILE_CHANGE_REVIEW'), 'COMPANY_ADMIN inherits scope-ALL');
  assert.equal(
    employeeMatrix.includes('PROFILE_CHANGE_REVIEW'),
    false,
    'an employee must never review profile changes',
  );
  assert.ok(employeeMatrix.includes('PROFILE_UPDATE_SELF'), 'every employee may ask');
});

// Runs an express-validator chain against a bare request object: the chains
// are real middlewares, so this is the actual validation path minus Express.
const runChain = (chainOfMiddleware, req) =>
  new Promise((resolve) => {
    let index = 0;
    const step = () => {
      const middleware = chainOfMiddleware[index];
      index += 1;
      if (!middleware) return resolve(null);
      try {
        middleware(req, { status: () => ({ json: () => {} }) }, (error) =>
          error ? resolve(error) : step(),
        );
      } catch (error) {
        resolve(error);
      }
    };
    step();
  });

test('38: validators refuse client-supplied identity fields', async () => {
  const error = await runChain(validatorModule.profileChangeSubmitValidator, {
    body: { changes: { name: 'Someone Else' }, employeeId: 'aaaaaaaaaaaaaaaaaaaaaaa9' },
    params: {},
    method: 'POST',
    headers: {},
    get: () => '',
  });
  assert.ok(error, 'employeeId in the body must be refused');
  assert.equal(error.statusCode, 400);
  assert.match(error.errors?.[0]?.message || error.message, /must not be supplied/);
});

test('38: validators accept a well-formed request and refuse a long reason', async () => {
  const ok = await runChain(validatorModule.profileChangeSubmitValidator, {
    body: { changes: { designation: 'Tech Lead' }, reason: 'Promotion' },
    params: {},
    method: 'POST',
    headers: {},
    get: () => '',
  });
  assert.equal(ok, null, 'a valid payload must pass the chain');

  const longReason = await runChain(validatorModule.profileChangeSubmitValidator, {
    body: { changes: { designation: 'Tech Lead' }, reason: 'x'.repeat(301) },
    params: {},
    method: 'POST',
    headers: {},
    get: () => '',
  });
  assert.ok(longReason);
  assert.equal(longReason.statusCode, 400);
  assert.match(longReason.errors?.[0]?.message || longReason.message, /at most 300/);
});

test('38: the decide validator requires a requestId in the path', async () => {
  const missing = await runChain(validatorModule.profileChangeDecideValidator, {
    body: { decisionNote: 'ok' },
    params: {},
    method: 'POST',
    headers: {},
    get: () => '',
  });
  assert.ok(missing);
  assert.equal(missing.statusCode, 400);

  const present = await runChain(validatorModule.profileChangeDecideValidator, {
    body: { decisionNote: 'ok' },
    params: { requestId: 'pcr1' },
    method: 'POST',
    headers: {},
    get: () => '',
  });
  assert.equal(present, null);
});

// ── 7. No cross-domain writes ─────────────────────────────────────────────

test('38: the workflow never writes attendance, leave or payroll', async () => {
  const { service } = buildService();
  const created = await service.submitRequest({
    companyId: COMPANY_A,
    requester: employee,
    input: { changes: { name: 'Manikandan Ramasamy' } },
  });
  await service.decideRequest({
    companyId: COMPANY_A,
    viewer: hrUser,
    requestId: created.id,
    action: 'approve',
    decisionNote: 'verified',
  });
  // The throwing sentinels would have failed the test above if any path
  // reached them; assert the wiring explicitly too.
  assert.equal(service._models.AttendanceModel.create !== undefined, true);
  assert.equal(service._models.LeaveModel.create !== undefined, true);
  assert.equal(service._models.PayrollModel.create !== undefined, true);
});

// ── 8. Wiring pins (source-level) ─────────────────────────────────────────
//  These read the real files: the workflow above is only real if the routes
//  are mounted, the reviewer gate is applied, and the old direct-edit door
//  for bank details is actually closed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

test('38 wiring: /profile/change-requests is mounted BEFORE /profile', () => {
  const index = readSource('src/routes/index.js');
  const changeRequestsAt = index.indexOf('"/profile/change-requests"');
  const profileAt = index.indexOf('router.use("/profile", profileRoutes)');

  assert.ok(changeRequestsAt > -1, 'the change-request router must be mounted');
  assert.ok(profileAt > -1, 'the profile router must still be mounted');
  assert.ok(
    changeRequestsAt < profileAt,
    'the literal /change-requests paths must be matched before the /profile router',
  );
});

test('38 wiring: reviewer endpoints require PROFILE_CHANGE_REVIEW', () => {
  const routes = readSource('src/routes/profileChangeRoutes.js');
  const gate = (path) => routes.slice(routes.indexOf(path), routes.indexOf(path) + 220);

  assert.match(gate("'/:requestId/approve'"), /requirePermission\('PROFILE_CHANGE_REVIEW'\)/);
  assert.match(gate("'/:requestId/reject'"), /requirePermission\('PROFILE_CHANGE_REVIEW'\)/);
  assert.match(gate("'/pending'"), /requirePermission\('PROFILE_CHANGE_REVIEW'\)/);
  // Submitting rides the self-service permission every role already holds.
  assert.match(gate("'/'"), /requirePermission\('PROFILE_UPDATE_SELF'\)/);
  // Reads of your OWN requests carry no gate — the service scopes them.
  assert.match(routes, /router\.get\('\/me', listMyProfileChangeRequests\)/);
});

test('38 wiring: the model keeps one open request per field, in the database', () => {
  const model = readSource('src/models/ProfileChangeRequest.js');
  assert.match(model, /pendingFields: \{ type: \[String\], default: \[\] \}/);
  assert.match(model, /partialFilterExpression: \{ status: 'pending' \}/);
  assert.match(model, /unique: true/);
  assert.match(model, /companyId: \{[\s\S]{0,80}required: \[true, 'companyId is required'\]/);
});

test('38 wiring: bank details are no longer self-editable through PUT /profile/me', () => {
  const controller = readSource('src/controllers/profileController.js');
  const whitelist = controller.slice(
    controller.indexOf('const SELF_EDITABLE'),
    controller.indexOf('const SELF_EDITABLE') + 200,
  );
  assert.equal(whitelist.includes('bankAccount'), false, 'bankAccount must need approval');
  assert.equal(whitelist.includes('ifsc'), false, 'ifsc must need approval');
  assert.ok(whitelist.includes('phone'), 'phone stays self-service');
});
