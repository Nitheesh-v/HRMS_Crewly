// ─────────────────────────────────────────────────────────────────────────────
// Phase 35.3 — ROLE MEMBERSHIP PIN.
//
// The report behind this unit: the Roles & Permissions screen showed
// "0 user(s) hold this role" for Company Admin — on a tenant whose only user
// IS the Company Admin.
//
// Root cause: membership was counted on `roleRef` alone, but a user can hold a
// role the second way permissionService accepts — the legacy `role` string
// (`findUserRole` falls back to `systemRoleKey === user.role` when there is no
// roleRef). The founder is created with role: COMPANY_ADMIN and no roleRef
// (authController), and so is every user an admin adds through the legacy
// CREATION_RIGHTS path, so the count was zero for exactly the roles people
// most expect to see filled.
//
// Hermetic: the User model is an injected fake (the repo's default-param seam)
// and the wired-up call sites are pinned by reading the controller source.
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/role-member-count';
process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const {
  roleHoldersQuery,
  roleMemberCounts,
  roleMemberCount,
  membersOfRole,
} = await import('../src/controllers/rolePermissionController.js');

const COMPANY = '64b0000000000000000000c1';

const systemRole = (overrides = {}) => ({
  _id: '64b0000000000000000000a1',
  code: 'COMPANY_ADMIN',
  name: 'Company Admin',
  systemRoleKey: 'COMPANY_ADMIN',
  isSystemRole: true,
  ...overrides,
});

const customRole = (overrides = {}) => ({
  _id: '64b0000000000000000000b1',
  code: 'HR_HEAD',
  name: 'HR Head',
  systemRoleKey: '',
  isSystemRole: false,
  ...overrides,
});

// The two aggregations differ by shape: the membership one matches
// `roleRef: { $ne: null }`, the legacy one matches `role: { $in: [...] }`.
const fakeUserModel = ({ refRows = [], legacyRows = [] } = {}) => {
  const pipelines = [];
  return {
    pipelines,
    aggregate: async (pipeline) => {
      pipelines.push(pipeline);
      return 'role' in pipeline[0].$match ? legacyRows : refRows;
    },
  };
};

describe('35.3 · a role holder is counted whether they hold it by roleRef or by role string', () => {
  test('the founder (role COMPANY_ADMIN, no roleRef) counts as a holder', async () => {
    const role = systemRole();
    const model = fakeUserModel({ legacyRows: [{ _id: 'COMPANY_ADMIN', count: 1 }] });

    const counts = await roleMemberCounts(COMPANY, [role], { UserModel: model });

    assert.equal(counts.get(role._id), 1, 'Company Admin must not report 0 users');
  });

  test('the legacy aggregation is tenant-scoped, ACTIVE-only and roleRef-free', async () => {
    const role = systemRole();
    const model = fakeUserModel({ legacyRows: [{ _id: 'COMPANY_ADMIN', count: 1 }] });

    await roleMemberCounts(COMPANY, [role], { UserModel: model });

    assert.equal(model.pipelines.length, 2, 'one aggregation for roleRef holders, one for the rest');
    const match = model.pipelines[1][0].$match;
    assert.equal(String(match.companyId), COMPANY, 'never counts another tenant');
    assert.equal(match.status, 'ACTIVE', 'inactive users never block housekeeping');
    assert.equal(match.roleRef, null, 'a user with a roleRef is counted once, through roleRef');
    assert.deepEqual(match.role.$in, ['COMPANY_ADMIN'], 'matches the legacy role string only');
  });

  test('roleRef holders and legacy holders add up', async () => {
    const role = systemRole();
    const model = fakeUserModel({
      refRows: [{ _id: role._id, count: 2 }],
      legacyRows: [{ _id: 'COMPANY_ADMIN', count: 1 }],
    });

    const counts = await roleMemberCounts(COMPANY, [role], { UserModel: model });

    assert.equal(counts.get(role._id), 3);
  });

  test('a custom role can never gain phantom members from a role string', async () => {
    const role = customRole();
    const model = fakeUserModel({ legacyRows: [{ _id: 'HR_HEAD', count: 9 }] });

    const counts = await roleMemberCounts(COMPANY, [role], { UserModel: model });

    assert.equal(counts.get(role._id), undefined);
    assert.equal(model.pipelines.length, 1, 'never even queries the legacy arm');
  });

  test('one extra aggregation resolves every legacy holder, not one per role', async () => {
    const roles = [
      systemRole(),
      systemRole({ _id: '64b0000000000000000000a2', code: 'EMPLOYEE', systemRoleKey: 'EMPLOYEE' }),
      customRole(),
    ];
    const model = fakeUserModel();

    await roleMemberCounts(COMPANY, roles, { UserModel: model });

    assert.equal(model.pipelines.length, 2);
    assert.deepEqual(
      model.pipelines[1][0].$match.role.$in.sort(),
      ['COMPANY_ADMIN', 'EMPLOYEE'],
      'custom codes are not in the lookup',
    );
  });

  test('an empty role list still counts nothing and skips the legacy pass', async () => {
    const model = fakeUserModel();
    const counts = await roleMemberCounts(COMPANY, [], { UserModel: model });
    assert.equal(counts.size, 0);
    assert.equal(model.pipelines.length, 1, 'no roles → no legacy lookup to run');
  });
});

describe('35.3 · single-role count and member list agree with the list screen', () => {
  test('roleMemberCount matches both ways of holding the role in one query', async () => {
    const role = systemRole();
    const seen = [];
    const UserModel = {
      countDocuments: async (filter) => {
        seen.push(filter);
        return 1;
      },
    };

    const count = await roleMemberCount(COMPANY, role, { UserModel });

    assert.equal(count, 1, 'the founder case: a single user, no roleRef');
    assert.equal(seen.length, 1, 'one round trip');
    assert.equal(seen[0].companyId, COMPANY);
    assert.equal(seen[0].status, 'ACTIVE');
    assert.deepEqual(seen[0].$or, [
      { roleRef: role._id },
      { roleRef: null, role: 'COMPANY_ADMIN' },
    ]);
  });

  test('roleHoldersQuery keeps custom roles roleRef-only', () => {
    assert.deepEqual(roleHoldersQuery(customRole()), { $or: [{ roleRef: customRole()._id }] });
  });

  test('the member list uses the same holder definition as the count', async () => {
    const role = systemRole();
    const calls = [];
    const UserModel = {
      find: (filter) => {
        calls.push(filter);
        return { select: () => ({ limit: () => ({ lean: async () => [] }) }) };
      },
    };

    await membersOfRole(COMPANY, role, 10, { UserModel });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].$or, [
      { roleRef: role._id },
      { roleRef: null, role: 'COMPANY_ADMIN' },
    ]);
    assert.equal(calls[0].status, 'ACTIVE');
  });
});

describe('35.3 · the wired-up handlers keep the shared definition', () => {
  const source = read('Backend/src/controllers/rolePermissionController.js');

  test('listRoles passes the role documents in', () => {
    assert.match(source, /roleMemberCounts\(\s*req\.companyId,\s*roles\s*\)/);
  });

  test('getRole counts and lists through the shared helpers', () => {
    const body = source.slice(
      source.indexOf('export const getRole'),
      source.indexOf('export const updateRole'),
    );
    assert.match(body, /roleMemberCount\(\s*req\.companyId,\s*role\s*\)/);
    assert.match(body, /membersOfRole\(\s*req\.companyId,\s*role\s*\)/);
    assert.doesNotMatch(body, /roleRef:\s*role\._id/, 'no ref-only count left behind in getRole');
  });

  test('updateRolePermissions reports the same memberCount it displays', () => {
    assert.match(source, /const memberCount = await roleMemberCount\(\s*req\.companyId,\s*updatedRole\s*\)/);
  });

  test('deactivateRole stays ref-only on purpose — it only ever sees custom roles', () => {
    // System roles are refused before any counting, and a legacy `role` string
    // only ever resolves to a role WITH a systemRoleKey — so a custom role has
    // no legacy holders to reassign and the ref-only count is already exact.
    const body = source.slice(source.indexOf('export const deactivateRole'));
    const guard = body.indexOf('Protected system roles cannot be deactivated');
    const count = body.indexOf('const assignedUsers');
    assert.ok(guard > -1 && count > guard, 'system-role refusal precedes the count');
    assert.match(body, /roleRef:\s*\n?\s*role\._id/);
  });

  test('the runtime fallback the count mirrors still exists in permissionService', () => {
    const service = read('Backend/src/utils/permissionService.js');
    assert.match(service, /systemRoleKey:\s*user\.role/);
  });
});
