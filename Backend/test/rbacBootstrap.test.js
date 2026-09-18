// ============================================================
//  FRESH-DATABASE RBAC BOOTSTRAP — REGRESSION & INVARIANT SUITE.
//
//  Bug fixed: a genuinely empty database did not bootstrap RBAC.
//  The Permission catalogue was never ensured at startup, company
//  registration provisioned no CompanyRole documents, and the lazy
//  in-request bootstrap could be denied by the permission middleware
//  BEFORE it ever ran (bootstrap deadlock on /app/roles-permissions).
//  A process-lifetime catalogue memo could even outlive its database
//  and provision system roles full of DANGLING permission refs that
//  the version-gated migration never repaired (empty effective
//  permissions, permanent 403 for the founder).
//
//  Hermetic: no MongoDB, no Redis, no network. The REAL shipped
//  permissionService logic (ensurePermissions / ensureCompanyRoles /
//  resolveUserPermissions / repairSystemRoleIfNeeded) runs against
//  in-memory collections that faithfully emulate the exact Mongo
//  semantics the service relies on:
//    · bulkWrite($setOnInsert, upsert) with a unique name index and
//      real concurrent-upsert E11000 convergence,
//    · findOneAndUpdate upsert with unique {companyId, code},
//    · updateOne with $addToSet $each + $set,
//    · populate() that silently drops dangling ObjectIds (the poison
//      that made the original bug permanent).
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  permissionService,
  registry,
  companyRoleModule,
] = await Promise.all([
  import('../src/utils/permissionService.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/models/CompanyRole.js'),
]);

const {
  ensurePermissions,
  ensureCompanyRoles,
  resolveUserPermissions,
  hasPermission,
  getPermissionPayload,
  getPermissionByName,
  invalidatePermissionCache,
  _resetEnsurePermissionsForTests,
  _resetPermissionMetaCacheForTests,
  getSystemPermissionVersion,
} = permissionService;

const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;
const { SYSTEM_COMPANY_ROLES } = companyRoleModule;

// Owned by permissionService; tests must track it, never hardcode it.
const SYSTEM_PERMISSION_VERSION = getSystemPermissionVersion();

const CATALOGUE_COUNT = DEFAULT_PERMISSIONS.length;

const newId = (prefix, seq) =>
  `${prefix}${String(seq).padStart(20, '0')}`;

// ─────────────────────────────────────────────────────────────
//  In-memory Permission collection.
//  Emulates: bulkWrite ordered:false with unique name index; find;
//  findOne. Concurrent identical upserts race a real microtask
//  yield and the loser throws a MongoBulkWriteError-shaped E11000
//  exactly like the driver does on a fresh replica set.
// ─────────────────────────────────────────────────────────────
class FakePermissionCollection {
  constructor() {
    this.docs = new Map();
    this.seq = 0;
  }

  nextId() {
    this.seq += 1;
    return newId('perm', this.seq);
  }

  async bulkWrite(operations) {
    const writeErrors = [];

    for (const operation of operations) {
      const { filter, update } = operation.updateOne;
      const name = filter.name;

      // One microtask yield per op: two concurrent bulkWrites both
      // pass this check, then insert in sequence — the second insert
      // hits the unique index, mirroring the real driver race.
      await Promise.resolve();

      const exists = [...this.docs.values()].some(
        (doc) => doc.name === name,
      );

      if (exists) continue;

      const duplicate = [...this.docs.values()].some(
        (doc) => doc.name === name,
      );

      if (duplicate) {
        writeErrors.push({
          code: 11000,
          keyValue: { name },
        });
        continue;
      }

      const doc = {
        // Mongoose applies schema defaults to upserted $setOnInsert
        // documents (Permission.isActive defaults true) — emulated here.
        isActive: true,
        ...(update.$setOnInsert || {}),
        _id: this.nextId(),
      };

      this.docs.set(doc._id, doc);
    }

    if (writeErrors.length) {
      const error = new Error(
        'E11000 duplicate key error (converged concurrent bootstrap)',
      );
      error.code = 11000;
      error.writeErrors = writeErrors;
      throw error;
    }

    return { ok: 1 };
  }

  matchesFilter(doc, filter) {
    return Object.entries(filter).every(
      ([key, value]) => doc[key] === value,
    );
  }

  find(filter = {}, projection = null) {
    const matched = [...this.docs.values()].filter((doc) =>
      this.matchesFilter(doc, filter),
    );

    const project = (doc) => {
      if (!projection) return { ...doc };
      const picked = { _id: doc._id };
      for (const key of Object.keys(projection)) {
        if (projection[key]) picked[key] = doc[key];
      }
      return picked;
    };

    return {
      lean: async () => matched.map(project),
    };
  }

  findOne(filter = {}) {
    return {
      lean: async () => {
        const doc = [...this.docs.values()].find((candidate) =>
          this.matchesFilter(candidate, filter),
        );
        return doc ? { ...doc } : null;
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────
//  In-memory CompanyRole collection.
//  Emulates: findOneAndUpdate upsert with unique {companyId, code};
//  updateOne with $addToSet $each + $set; find/findOne + populate
//  that drops dangling ObjectIds exactly like Mongo does.
// ─────────────────────────────────────────────────────────────
class FakeCompanyRoleCollection {
  constructor(permissionCollection) {
    this.docs = new Map();
    this.permissions = permissionCollection;
    this.seq = 0;
  }

  nextId() {
    this.seq += 1;
    return newId('role', this.seq);
  }

  sameId(a, b) {
    return String(a) === String(b);
  }

  matchesFilter(doc, filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (key === '$or') {
        const matched = value.some((subFilter) =>
          this.matchesFilter(doc, subFilter),
        );
        if (!matched) return false;
        continue;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.$lt !== undefined) {
          if (!(doc[key] !== undefined && doc[key] < value.$lt)) return false;
          continue;
        }
        if (value.$exists !== undefined) {
          if (value.$exists !== (doc[key] !== undefined)) return false;
          continue;
        }
      }

      if (!this.sameId(doc[key], value)) return false;
    }

    return true;
  }

  populateRole(doc) {
    const populated = (doc.permissions || [])
      // Mongo populate silently drops references whose target document
      // no longer exists — THE mechanism that made dangling permission
      // refs resolve to an empty permission set.
      .map((id) => this.permissions.docs.get(String(id)))
      .filter(Boolean);

    return { ...doc, permissions: populated };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const existing = [...this.docs.values()].find((doc) =>
      this.matchesFilter(doc, filter),
    );

    if (existing) return this.populateRole(existing);

    await Promise.resolve();

    const duplicate = [...this.docs.values()].find((doc) =>
      this.matchesFilter(doc, filter),
    );

    if (duplicate) {
      const error = new Error('E11000 duplicate key (unique companyId+code)');
      error.code = 11000;
      throw error;
    }

    if (!options.upsert) return null;

    const doc = {
      ...(update.$setOnInsert || {}),
      _id: this.nextId(),
    };

    this.docs.set(doc._id, doc);

    return this.populateRole(doc);
  }

  async updateOne(filter, update) {
    const target = [...this.docs.values()].find((doc) =>
      this.matchesFilter(doc, filter),
    );

    if (!target) return { modifiedCount: 0 };

    const each = update.$addToSet?.permissions?.$each;

    if (each) {
      const current = target.permissions || [];
      const merged = [...current];
      for (const id of each) {
        if (!merged.some((existing) => this.sameId(existing, id))) {
          merged.push(id);
        }
      }
      target.permissions = merged;
    }

    if (update.$set) Object.assign(target, update.$set);

    return { modifiedCount: 1 };
  }

  query(filter) {
    return [...this.docs.values()].filter((doc) =>
      this.matchesFilter(doc, filter),
    );
  }

  find(filter) {
    const matched = this.query(filter);

    return {
      populate: () => ({
        lean: async () => matched.map((doc) => this.populateRole(doc)),
      }),
    };
  }

  findOne(filter) {
    const first = () => {
      const doc = this.query(filter)[0];
      return doc ? this.populateRole(doc) : null;
    };

    return {
      populate: () => ({
        then: (resolve, reject) =>
          Promise.resolve(first()).then(resolve, reject),
        catch: (onReject) => Promise.resolve(first()).catch(onReject),
        finally: (onFinally) =>
          Promise.resolve(first()).finally(onFinally),
      }),
    };
  }
}

// ─────────────────────────────────────────────────────────────
//  Harness
// ─────────────────────────────────────────────────────────────
const freshRbacWorld = () => {
  _resetEnsurePermissionsForTests();
  _resetPermissionMetaCacheForTests();

  // Unique ids per world: the service caches resolved user grants at
  // module level (and tests share the process), so a reused key would
  // serve a stale previous world's authority and mask real behavior.
  WORLD_SEQ += 1;
  COMPANY_A = newId('comp', WORLD_SEQ * 4 + 0);
  COMPANY_B = newId('comp', WORLD_SEQ * 4 + 1);
  FOUNDER_A = newId('user', WORLD_SEQ * 4 + 2);
  EMPLOYEE_A = newId('user', WORLD_SEQ * 4 + 3);

  for (const companyId of [COMPANY_A, COMPANY_B]) {
    invalidatePermissionCache({ companyId });
  }

  const PermissionModel = new FakePermissionCollection();
  const CompanyRoleModel = new FakeCompanyRoleCollection(PermissionModel);

  const options = { PermissionModel, CompanyRoleModel };

  const provisionTenant = async (companyId, createdBy = null) =>
    ensureCompanyRoles(companyId, createdBy, options);

  const resolve = (user) => resolveUserPermissions(user, options);

  return {
    PermissionModel,
    CompanyRoleModel,
    options,
    provisionTenant,
    resolve,
  };
};

const userFor = (companyId, userId, role, overrides = []) => ({
  _id: userId,
  companyId,
  role,
  roleRef: null,
  permissionOverrides: overrides,
});

let WORLD_SEQ = 0;
let COMPANY_A;
let COMPANY_B;
let FOUNDER_A;
let EMPLOYEE_A;

// ═════════════════════════════════════════════════════════════
//  §25 — EMPTY DATABASE BOOTSTRAP (global catalogue)
// ═════════════════════════════════════════════════════════════

test('§25 empty Permission collection bootstraps the full catalogue exactly once', async () => {
  const { PermissionModel } = freshRbacWorld();

  assert.equal(PermissionModel.docs.size, 0);

  const catalogue = await ensurePermissions({
    PermissionModel,
  });

  assert.equal(catalogue.length, CATALOGUE_COUNT);
  assert.equal(PermissionModel.docs.size, CATALOGUE_COUNT);

  const names = [...PermissionModel.docs.values()].map((doc) => doc.name);

  assert.equal(new Set(names).size, CATALOGUE_COUNT, 'no duplicate permissions');

  for (const expected of DEFAULT_PERMISSIONS) {
    const doc = [...PermissionModel.docs.values()].find(
      (candidate) => candidate.name === expected.name,
    );
    assert.ok(doc, `catalogue missing ${expected.name}`);
    assert.equal(doc.resource, expected.resource);
    assert.equal(doc.action, expected.action);
    assert.equal(doc.isActive, true);
  }

  // Idempotent re-run — same catalogue, no duplicates.
  await ensurePermissions({ PermissionModel });

  assert.equal(PermissionModel.docs.size, CATALOGUE_COUNT);
});

// ═════════════════════════════════════════════════════════════
//  §26 — THE EXACT BUG: fresh DB → provision → founder authorized
// ═════════════════════════════════════════════════════════════

test('§26 fresh DB → bootstrap → register founder → Roles & Permissions authority granted (was 403)', async () => {
  const world = freshRbacWorld();

  assert.equal(world.PermissionModel.docs.size, 0);
  assert.equal(world.CompanyRoleModel.docs.size, 0);

  await world.provisionTenant(COMPANY_A, FOUNDER_A);

  const founder = userFor(COMPANY_A, FOUNDER_A, 'COMPANY_ADMIN');

  // The exact permission the failing page requires (GET /api/roles,
  // GET /api/permissions → requirePermission('SETTINGS_READ')).
  assert.equal(
    await hasPermission(founder, 'SETTINGS_READ', world.options),
    true,
    'COMPANY_ADMIN founder must open Roles & Permissions immediately',
  );
  assert.equal(await hasPermission(founder, 'SETTINGS_MANAGE', world.options), true);

  const payload = await getPermissionPayload(founder, world.options);

  assert.equal(payload.role.code, 'COMPANY_ADMIN');
  assert.equal(payload.role.isSystemRole, true);
  assert.ok(payload.permissions.length > 0);

  // The five default tenant roles exist for the company.
  const roleDocs = world.CompanyRoleModel.query({ companyId: COMPANY_A });
  assert.equal(roleDocs.length, SYSTEM_COMPANY_ROLES.length);

  for (const roleKey of SYSTEM_COMPANY_ROLES) {
    const roleDoc = roleDocs.find((doc) => doc.code === roleKey);
    assert.ok(roleDoc, `missing default role ${roleKey}`);
    assert.equal(roleDoc.isSystemRole, true);
    assert.equal(roleDoc.permissionVersion, SYSTEM_PERMISSION_VERSION);
  }

  // Founder-attributed provisioning (createdBy = the founder, not null).
  const adminRole = roleDocs.find((doc) => doc.code === 'COMPANY_ADMIN');
  assert.equal(String(adminRole.createdBy), String(FOUNDER_A));
});

test('§26 founder resolves the ENTIRE authoritative COMPANY_ADMIN template', async () => {
  const world = freshRbacWorld();

  await world.provisionTenant(COMPANY_A, FOUNDER_A);

  const founder = userFor(COMPANY_A, FOUNDER_A, 'COMPANY_ADMIN');
  const resolved = await world.resolve(founder);

  const catalogueNames = new Set(
    DEFAULT_PERMISSIONS.map((permission) => permission.name),
  );

  const expected = DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.filter((name) =>
    catalogueNames.has(name),
  );

  for (const name of expected) {
    assert.ok(
      resolved.allowed.has(name),
      `COMPANY_ADMIN missing "${name}" from the authoritative template`,
    );
  }

  assert.equal(resolved.role.code, 'COMPANY_ADMIN');
});

// ═════════════════════════════════════════════════════════════
//  Poisoned-database repair — the permanent-403 amplifier
// ═════════════════════════════════════════════════════════════

test('§26 system role with dangling permission refs is self-repaired on resolve', async () => {
  const world = freshRbacWorld();

  // Catalogue exists, but the COMPANY_ADMIN role was provisioned from a
  // stale/foreign catalogue: every reference is dangling. Raw document
  // looks full; populate() resolves to NOTHING; version is current so
  // the version-gated migration never repairs it.
  await ensurePermissions({ PermissionModel: world.PermissionModel });

  const danglingIds = ['dangling1aaaaaaaaaaaaaaa', 'dangling2aaaaaaaaaaaaaaa'];

  world.CompanyRoleModel.docs.set('rolepoison1', {
    _id: 'rolepoison1',
    companyId: COMPANY_A,
    name: 'Company Admin',
    code: 'COMPANY_ADMIN',
    description: 'Protected Company Admin role',
    permissions: danglingIds,
    systemRoleKey: 'COMPANY_ADMIN',
    isSystemRole: true,
    isActive: true,
    permissionVersion: SYSTEM_PERMISSION_VERSION,
    createdBy: null,
    updatedBy: null,
  });

  const founder = userFor(COMPANY_A, FOUNDER_A, 'COMPANY_ADMIN');

  assert.equal(
    await hasPermission(founder, 'SETTINGS_READ', world.options),
    true,
    'resolve must repair a dangling system role, not leave a permanent 403',
  );

  const repaired = world.CompanyRoleModel.query({
    companyId: COMPANY_A,
    code: 'COMPANY_ADMIN',
  })[0];

  const liveIds = repaired.permissions.filter((id) =>
    world.PermissionModel.docs.has(String(id)),
  );

  const catalogueNames = new Set(
    [...world.PermissionModel.docs.values()].map((doc) => doc.name),
  );

  // $addToSet converges to the UNIQUE expected permission set.
  const expectedCount = new Set(
    DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.filter((name) =>
      catalogueNames.has(name),
    ),
  ).size;

  assert.equal(liveIds.length, expectedCount);
  assert.equal(new Set(liveIds.map(String)).size, expectedCount, 'no dupes');
  assert.equal(repaired.permissionVersion, SYSTEM_PERMISSION_VERSION);
});

test('§26 admin-tuned system roles are NEVER rewritten by the repair', async () => {
  const world = freshRbacWorld();

  await ensurePermissions({ PermissionModel: world.PermissionModel });

  const adminTunedBy = newId('user', 9);

  world.CompanyRoleModel.docs.set('roletuned1', {
    _id: 'roletuned1',
    companyId: COMPANY_A,
    name: 'Company Admin',
    code: 'COMPANY_ADMIN',
    description: 'Protected Company Admin role',
    permissions: ['dangling1aaaaaaaaaaaaaaa'],
    systemRoleKey: 'COMPANY_ADMIN',
    isSystemRole: true,
    isActive: true,
    permissionVersion: SYSTEM_PERMISSION_VERSION,
    createdBy: FOUNDER_A,
    updatedBy: adminTunedBy,
  });

  const founder = userFor(COMPANY_A, FOUNDER_A, 'COMPANY_ADMIN');

  assert.equal(
    await hasPermission(founder, 'SETTINGS_READ', world.options),
    false,
    'an admin-tuned (updatedBy set) role is tenant customization — respected',
  );

  const untouched = world.CompanyRoleModel.docs.get('roletuned1');

  assert.deepEqual(untouched.permissions, ['dangling1aaaaaaaaaaaaaaa']);
});

// ═════════════════════════════════════════════════════════════
//  §27 — EMPLOYEE does not gain admin authority
// ═════════════════════════════════════════════════════════════

test('§27 fresh-tenant EMPLOYEE gets self-service only — no admin powers', async () => {
  const world = freshRbacWorld();

  await world.provisionTenant(COMPANY_A, FOUNDER_A);

  const employee = userFor(COMPANY_A, EMPLOYEE_A, 'EMPLOYEE');

  const forbidden = [
    'SETTINGS_READ',
    'SETTINGS_MANAGE',
    'USER_READ',
    'USER_UPDATE',
    'PAYROLL_MANAGE',
    'PAYROLL_RUN_EXECUTE',
    'ATTENDANCE_POLICY_MANAGE',
    'ATTENDANCE_POLICY_ACTIVATE',
    'ATTENDANCE_CAPTURE_MANAGE',
    'ATTENDANCE_ANALYTICS_READ',
    'ATTENDANCE_OPERATIONS_READ',
    'ATTENDANCE_FINALIZATION_MANAGE',
    'SUPPORT_MANAGE',
  ];

  for (const name of forbidden) {
    assert.equal(
      await hasPermission(employee, name, world.options),
      false,
      `EMPLOYEE must NOT hold ${name}`,
    );
  }

  const granted = [
    'PROFILE_READ_SELF',
    'ATTENDANCE_READ_SELF',
    'LEAVE_CREATE_SELF',
    'SUPPORT_UPDATE_SELF',
  ];

  for (const name of granted) {
    assert.equal(
      await hasPermission(employee, name, world.options),
      true,
      `EMPLOYEE must hold ${name}`,
    );
  }
});

// ═════════════════════════════════════════════════════════════
//  §28 — TENANT ISOLATION
// ═════════════════════════════════════════════════════════════

test('§28 provisioning company B never touches company A; roles stay tenant-scoped', async () => {
  const world = freshRbacWorld();

  await world.provisionTenant(COMPANY_A, FOUNDER_A);

  const beforeA = JSON.stringify(
    world.CompanyRoleModel.query({ companyId: COMPANY_A }),
  );

  await world.provisionTenant(COMPANY_B, null);

  assert.equal(
    JSON.stringify(world.CompanyRoleModel.query({ companyId: COMPANY_A })),
    beforeA,
    'company B provisioning must not mutate company A roles',
  );

  const adminB = world.CompanyRoleModel.query({
    companyId: COMPANY_B,
    code: 'COMPANY_ADMIN',
  })[0];

  assert.ok(adminB);
  assert.notEqual(
    String(adminB.companyId),
    String(COMPANY_A),
  );

  // A's admin resolves ONLY through A's role document.
  const founderA = userFor(COMPANY_A, FOUNDER_A, 'COMPANY_ADMIN');
  const resolvedA = await world.resolve(founderA);

  assert.equal(String(resolvedA.role.companyId), String(COMPANY_A));
  assert.notEqual(String(resolvedA.role._id), String(adminB._id));
});

// ═════════════════════════════════════════════════════════════
//  §29 — NEWER MODULE PERMISSIONS in the fresh COMPANY_ADMIN set
// ═════════════════════════════════════════════════════════════

test('§29 fresh COMPANY_ADMIN holds payroll, recruitment, attendance and statutory permissions', async () => {
  const world = freshRbacWorld();

  await world.provisionTenant(COMPANY_A, FOUNDER_A);

  const founder = userFor(COMPANY_A, FOUNDER_A, 'COMPANY_ADMIN');
  const resolved = await world.resolve(founder);

  // Phases 27/29/31 additions — every one must reach a FRESH tenant's
  // admin immediately, without a backend restart.
  const newerModules = [
    'RECRUITMENT_READ',
    'PAYROLL_READ',
    'PAYROLL_RUN_EXECUTE',
    'PAYROLL_RUN_RECALCULATE',
    'PAYROLL_PAYMENT_MARK_PAID',
    'PAYSLIP_GENERATE',
    'PAYROLL_STATUTORY_FILING',
    'FINAL_SETTLEMENT_READ',
    'ATTENDANCE_POLICY_ACTIVATE',
    'ATTENDANCE_CAPTURE_MANAGE',
    'ATTENDANCE_ANALYTICS_READ',
    'ATTENDANCE_FINALIZATION_MANAGE',
  ];

  for (const name of newerModules) {
    assert.ok(
      DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(name),
      `${name} must come from the authoritative template, not a hand list`,
    );
    assert.ok(
      resolved.allowed.has(name),
      `fresh COMPANY_ADMIN must hold ${name}`,
    );
  }
});

// ═════════════════════════════════════════════════════════════
//  §30 — CONCURRENT INITIALIZATION (multi-instance startup)
// ═════════════════════════════════════════════════════════════

test('§30 eight concurrent bootstraps converge to exactly one Permission per name', async () => {
  const world = freshRbacWorld();

  _resetEnsurePermissionsForTests();

  await Promise.all(
    Array.from(
      { length: 8 },
      () => ensurePermissions({ PermissionModel: world.PermissionModel }),
    ),
  );

  const names = [...world.PermissionModel.docs.values()].map(
    (doc) => doc.name,
  );

  assert.equal(names.length, CATALOGUE_COUNT);
  assert.equal(new Set(names).size, CATALOGUE_COUNT, 'no duplicates');
});

test('§30 a racing instance whose upserts all lose with E11000 still converges', async () => {
  const world = freshRbacWorld();

  // Instance #1 wins the race and builds the catalogue.
  await ensurePermissions({ PermissionModel: world.PermissionModel });

  // Instance #2 starts against the same empty-looking collection and
  // loses every upsert with a duplicate-key write error — the exact
  // MongoBulkWriteError shape the driver reports for concurrent
  // identical upserts under the unique name index.
  const losingBulkWrite = async () => {
    const error = new Error(
      'E11000 duplicate key error collection crewly.permissions',
    );
    error.code = 11000;
    error.writeErrors = DEFAULT_PERMISSIONS.map((permission) => ({
      code: 11000,
      keyValue: { name: permission.name },
    }));
    throw error;
  };

  const originalBulkWrite = world.PermissionModel.bulkWrite.bind(
    world.PermissionModel,
  );

  world.PermissionModel.bulkWrite = losingBulkWrite;

  try {
    _resetEnsurePermissionsForTests();

    const catalogue = await ensurePermissions({
      PermissionModel: world.PermissionModel,
    });

    assert.equal(catalogue.length, CATALOGUE_COUNT);

    const names = [...world.PermissionModel.docs.values()].map(
      (doc) => doc.name,
    );

    assert.equal(names.length, CATALOGUE_COUNT);
    assert.equal(new Set(names).size, CATALOGUE_COUNT);
  } finally {
    world.PermissionModel.bulkWrite = originalBulkWrite;
  }
});

test('§30 a non-duplicate bulk-write failure is NOT swallowed — bootstrap fails loudly', async () => {
  const world = freshRbacWorld();

  const failingBulkWrite = async () => {
    const error = new Error('connection timed out during bootstrap');
    error.code = 89;
    error.writeErrors = [{ code: 89, message: 'connection timed out' }];
    throw error;
  };

  const originalBulkWrite = world.PermissionModel.bulkWrite.bind(
    world.PermissionModel,
  );

  world.PermissionModel.bulkWrite = failingBulkWrite;

  try {
    _resetEnsurePermissionsForTests();

    await assert.rejects(
      () =>
        ensurePermissions({ PermissionModel: world.PermissionModel }),
      /connection timed out/,
    );

    // The failed memo is dropped: a retry re-attempts the bootstrap.
    world.PermissionModel.bulkWrite = originalBulkWrite;

    const catalogue = await ensurePermissions({
      PermissionModel: world.PermissionModel,
    });

    assert.equal(catalogue.length, CATALOGUE_COUNT);
  } finally {
    world.PermissionModel.bulkWrite = originalBulkWrite;
    _resetEnsurePermissionsForTests();
  }
});

// ═════════════════════════════════════════════════════════════
//  §31 — IDEMPOTENCY of bootstrap + tenant provisioning
// ═════════════════════════════════════════════════════════════

test('§31 running bootstrap and tenant provisioning twice duplicates nothing', async () => {
  const world = freshRbacWorld();

  await world.provisionTenant(COMPANY_A, FOUNDER_A);

  const before = world.CompanyRoleModel.query({ companyId: COMPANY_A });
  const beforeAdmin = before.find((doc) => doc.code === 'COMPANY_ADMIN');
  const beforeIds = JSON.stringify([...beforeAdmin.permissions].sort());

  await world.provisionTenant(COMPANY_A, FOUNDER_A);
  await world.provisionTenant(COMPANY_A, FOUNDER_A);

  const after = world.CompanyRoleModel.query({ companyId: COMPANY_A });
  const afterAdmin = after.find((doc) => doc.code === 'COMPANY_ADMIN');
  const afterIds = JSON.stringify([...afterAdmin.permissions].sort());

  assert.equal(after.length, before.length, 'no duplicate roles');
  assert.equal(after.length, SYSTEM_COMPANY_ROLES.length);
  assert.equal(afterIds, beforeIds, 'permission ids unchanged');

  const founder = userFor(COMPANY_A, FOUNDER_A, 'COMPANY_ADMIN');
  const payload = await getPermissionPayload(founder, world.options);

  assert.equal(payload.role.code, 'COMPANY_ADMIN');
  assert.ok(payload.permissions.length > 0);
});

// ═════════════════════════════════════════════════════════════
//  §32 — EXISTING CUSTOM ROLE + version upgrade safety
// ═════════════════════════════════════════════════════════════

test('§32 upgrade path: custom roles untouched; system roles gain new catalogue entries additively', async () => {
  const world = freshRbacWorld();

  await ensurePermissions({ PermissionModel: world.PermissionModel });

  const supportUpdateSelfId = [...world.PermissionModel.docs.values()].find(
    (doc) => doc.name === 'SUPPORT_UPDATE_SELF',
  )?._id;

  assert.ok(supportUpdateSelfId, 'catalogue must carry SUPPORT_UPDATE_SELF');

  // A tenant custom role at an old version with its own permission.
  const customPermissionId = [...world.PermissionModel.docs.values()].find(
    (doc) => doc.name === 'EMPLOYEE_READ',
  )?._id;

  world.CompanyRoleModel.docs.set('rolecustom1', {
    _id: 'rolecustom1',
    companyId: COMPANY_A,
    name: 'Ops Lead',
    code: 'OPS_LEAD',
    description: 'Tenant custom role',
    permissions: [customPermissionId],
    systemRoleKey: '',
    isSystemRole: false,
    isActive: true,
    permissionVersion: 0,
    createdBy: FOUNDER_A,
    updatedBy: null,
  });

  // A system role provisioned BEFORE the v36 catalogue addition.
  world.CompanyRoleModel.docs.set('roleold1', {
    _id: 'roleold1',
    companyId: COMPANY_A,
    name: 'Employee',
    code: 'EMPLOYEE',
    description: 'Protected Employee role',
    permissions: [],
    systemRoleKey: 'EMPLOYEE',
    isSystemRole: true,
    isActive: true,
    permissionVersion: 35,
    createdBy: FOUNDER_A,
    updatedBy: null,
  });

  await world.provisionTenant(COMPANY_A, FOUNDER_A);

  const custom = world.CompanyRoleModel.docs.get('rolecustom1');

  assert.deepEqual(
    custom.permissions,
    [customPermissionId],
    'custom roles are never rewritten by bootstrap/migration',
  );
  assert.equal(custom.permissionVersion, 0);
  assert.equal(custom.isSystemRole, false);

  const migrated = world.CompanyRoleModel.docs.get('roleold1');

  assert.ok(
    migrated.permissions.some((id) =>
      world.PermissionModel.docs.has(String(id)),
    ),
    'old system role gained live permission ids via $addToSet',
  );
  assert.ok(
    migrated.permissions.every((id) =>
      world.PermissionModel.docs.has(String(id)),
    ),
    'migrated refs are live, never dangling',
  );
  assert.equal(migrated.permissionVersion, SYSTEM_PERMISSION_VERSION);
});

// ═════════════════════════════════════════════════════════════
//  §33 — CACHE BEHAVIOR: stale null never outlives bootstrap
// ═════════════════════════════════════════════════════════════

test('§33 pre-bootstrap metadata null is cleared by a successful catalogue ensure', async () => {
  const world = freshRbacWorld();

  // A guarded request arrived BEFORE any bootstrap ran: the permission
  // metadata lookup caches null and 403s ("Permission X is not
  // registered.").
  const beforeBootstrap = await getPermissionByName('SETTINGS_READ', {
    PermissionModel: world.PermissionModel,
  });

  assert.equal(beforeBootstrap, null);

  // Bootstrap runs (startup, or the lazy in-request path).
  await ensurePermissions({ PermissionModel: world.PermissionModel });

  const afterBootstrap = await getPermissionByName('SETTINGS_READ', {
    PermissionModel: world.PermissionModel,
  });

  assert.ok(afterBootstrap, 'stale null must not outlive the bootstrap');
  assert.equal(afterBootstrap.name, 'SETTINGS_READ');
});

test('§33 user permission cache invalidates after role migration', async () => {
  const world = freshRbacWorld();

  await world.provisionTenant(COMPANY_A, FOUNDER_A);

  const founder = userFor(COMPANY_A, FOUNDER_A, 'COMPANY_ADMIN');

  assert.equal(
    await hasPermission(founder, 'SETTINGS_READ', world.options),
    true,
  );

  // Simulate a tenant customization revoking the permission.
  const adminRole = world.CompanyRoleModel.query({
    companyId: COMPANY_A,
    code: 'COMPANY_ADMIN',
  })[0];

  adminRole.updatedBy = FOUNDER_A;
  adminRole.permissions = adminRole.permissions.filter(
    (id) =>
      [...world.PermissionModel.docs.values()].find(
        (doc) => String(doc._id) === String(id),
      )?.name !== 'SETTINGS_READ',
  );

  invalidatePermissionCache({ companyId: COMPANY_A });

  const refreshed = await resolveUserPermissions(founder, world.options);

  assert.equal(
    refreshed.allowed.has('SETTINGS_READ'),
    false,
    'cache must not resurrect revoked permissions (Mongo is truth)',
  );
});

// ═════════════════════════════════════════════════════════════
//  Catalogue/matrix drift guard — this drift is how
//  SUPPORT_UPDATE_SELF got silently dropped from every role.
// ═════════════════════════════════════════════════════════════

test('every DEFAULT_ROLE_MATRIX reference exists in the authoritative catalogue', () => {
  const catalogueNames = new Set(
    DEFAULT_PERMISSIONS.map((permission) => permission.name),
  );

  const drift = [];

  for (const [roleKey, names] of Object.entries(DEFAULT_ROLE_MATRIX)) {
    for (const name of names) {
      if (!catalogueNames.has(name)) drift.push(`${roleKey}: ${name}`);
    }
  }

  assert.deepEqual(
    drift,
    [],
    'role matrices must never reference permissions absent from the catalogue',
  );
});

test('catalogue has no duplicate permission names', () => {
  const names = DEFAULT_PERMISSIONS.map((permission) => permission.name);

  assert.equal(new Set(names).size, names.length);
});
