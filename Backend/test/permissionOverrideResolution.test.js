// ─────────────────────────────────────────────────────────────────────────────
// Phase 35.3 — USER PERMISSION OVERRIDES MUST SURVIVE THE REQUEST PATH.
//
// The report behind this unit: "I think they are not storing" — a change that
// was saved successfully and then appeared to be gone.
//
// The save was fine. The READ was not:
//
//   `protect` hands resolveUserPermissions() a plain User document, where
//   `permissionOverrides.permission` is an ObjectId — not a populated
//   Permission document. The resolution loop read `override.permission?.name`,
//   got undefined and skipped every override in silence. An administrator
//   granted a permission for a user, the API answered "saved", and the user's
//   own screens never changed a thing — the classic "it did not store".
//
// Overrides from PUT /users/:userId/permissions (populated documents) were
// re-read from the database by refreshPermissions, so the two entry points
// disagreed with each other, which is exactly how a saved change can look like
// it vanished later.
//
// The fix resolves names with ONE extra read, and only when an override is
// present and unpopulated.
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/permission-overrides';
process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const {
  ensureCompanyRoles,
  resolveUserPermissions,
  getSystemPermissionVersion,
} = await import('../src/utils/permissionService.js');

const COMPANY = '64c0000000000000000000c9';
const SYSTEM_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD', 'EMPLOYEE'];

const OVERRIDE_PERMISSION_ID = '64c0000000000000000000d1';
const OVERRIDE_PERMISSION_NAME = 'reports.view';

const roleDoc = (code) => ({
  _id: `role-${code}`,
  companyId: COMPANY,
  code,
  name: code,
  isSystemRole: true,
  isActive: true,
  permissionVersion: getSystemPermissionVersion(),
  // A curated system role: the repair pass is skipped, as in production once
  // an admin has touched the role.
  updatedBy: '64c0000000000000000000e1',
  permissions: code === 'EMPLOYEE' ? [] : [],
});

// Distinct ids per case: the resolved decision is cached per user in-process.
let userSeq = 0;

const makeWorld = ({ overrides, permissionRows }) => {
  userSeq += 1;
  const calls = [];

  const CompanyRoleModel = {
    find: () => ({
      lean: async () => {
        calls.push('CompanyRole.find');
        return SYSTEM_ROLES.map(roleDoc);
      },
      populate: () => ({
        lean: async () => {
          calls.push('CompanyRole.find+populate');
          return [];
        },
      }),
    }),
    findOneAndUpdate: async (filter) => {
      calls.push(`CompanyRole.findOneAndUpdate(${filter?.code || 'any'})`);
      return roleDoc(filter?.code || 'EMPLOYEE');
    },
    updateOne: async () => {
      calls.push('CompanyRole.updateOne');
      return { modifiedCount: 0 };
    },
    findOne: () => {
      calls.push('CompanyRole.findOne');
      return { populate: async () => roleDoc('EMPLOYEE') };
    },
  };

  const PermissionModel = {
    find: (filter, projection) => {
      calls.push('Permission.find');
      return {
        lean: async () => {
          calls.push(`Permission.find.lean(${JSON.stringify(filter?._id?.$in || [])})`);
          return permissionRows;
        },
        // ensureCompanyRoles' catalogue pass uses .lean() too; the projection
        // argument above is what the override resolver passes.
        then: undefined,
        select: undefined,
      };
    },
    bulkWrite: async () => {
      calls.push('Permission.bulkWrite');
      return {};
    },
    countDocuments: async () => permissionRows.length,
    aggregate: async () => [],
  };

  const user = {
    _id: `64c0000000000000000000a${userSeq}`,
    companyId: COMPANY,
    role: 'EMPLOYEE',
    roleRef: null,
    permissionOverrides: overrides,
  };

  return { calls, models: { PermissionModel, CompanyRoleModel }, user };
};

describe('35.3 · an override saved for a user is honoured on the next request', () => {
  test('ALLOW survives when the override carries an ObjectId (the request path)', async () => {
    const { models, user, calls } = makeWorld({
      // What `protect` actually hands over: ObjectIds, not documents.
      overrides: [{ permission: OVERRIDE_PERMISSION_ID, effect: 'ALLOW' }],
      permissionRows: [{ _id: OVERRIDE_PERMISSION_ID, name: OVERRIDE_PERMISSION_NAME }],
    });

    const result = await resolveUserPermissions(user, models);

    assert.ok(
      result.allowed.has(OVERRIDE_PERMISSION_NAME),
      'a granted permission must be granted — this is the "it did not store" bug',
    );
    assert.ok(calls.includes('Permission.find.lean(["64c0000000000000000000d1"])'), 'names resolved with one lookup');
  });

  test('DENY survives when the override carries an ObjectId', async () => {
    const { models, user } = makeWorld({
      overrides: [{ permission: OVERRIDE_PERMISSION_ID, effect: 'DENY' }],
      permissionRows: [{ _id: OVERRIDE_PERMISSION_ID, name: OVERRIDE_PERMISSION_NAME }],
    });

    const result = await resolveUserPermissions(user, models);

    assert.ok(result.denied.has(OVERRIDE_PERMISSION_NAME), 'an explicit denial is honoured');
    assert.ok(!result.allowed.has(OVERRIDE_PERMISSION_NAME));
  });

  test('populated overrides still cost ZERO extra reads', async () => {
    const { models, user, calls } = makeWorld({
      overrides: [{ permission: { _id: OVERRIDE_PERMISSION_ID, name: OVERRIDE_PERMISSION_NAME }, effect: 'ALLOW' }],
      permissionRows: [],
    });

    const result = await resolveUserPermissions(user, models);

    assert.ok(result.allowed.has(OVERRIDE_PERMISSION_NAME));
    assert.ok(!calls.some((call) => call.startsWith('Permission.find.lean')), 'no lookup needed');
  });

  test('a user without overrides pays nothing extra', async () => {
    const { models, user, calls } = makeWorld({ overrides: [], permissionRows: [] });

    await resolveUserPermissions(user, models);

    assert.ok(!calls.some((call) => call.startsWith('Permission.find.lean')));
  });

  test('an override whose permission no longer exists is skipped, never guessed', async () => {
    const { models, user } = makeWorld({
      overrides: [{ permission: '64c0000000000000000000ff', effect: 'ALLOW' }],
      permissionRows: [], // deleted from the catalogue
    });

    const result = await resolveUserPermissions(user, models);

    assert.equal(result.allowed.size, 0);
  });
});

describe('35.3 · the resolution loop keeps the two-step contract', () => {
  const source = read('Backend/src/utils/permissionService.js');

  test('overrides resolve by populated name first, then by lookup', () => {
    assert.match(source, /const overrideNames = await resolveOverrideNames\(/);
    assert.match(
      source,
      /override\.permission\?\.name \|\|\s*\n?\s*overrideNames\.get\(/,
      'the populated fast path must be kept alongside the lookup',
    );
  });

  test('the lookup is skipped entirely when nothing needs resolving', () => {
    assert.match(source, /if \(pending\.length === 0\) return new Map\(\);/);
  });

  test('the overrides-write endpoint still invalidates this user cache entry', () => {
    const controller = read('Backend/src/controllers/rolePermissionController.js');
    const body = controller.slice(controller.indexOf('export const updateUserPermissions'));
    const invalidate = body.indexOf('invalidatePermissionCache({');
    assert.ok(invalidate > -1, 'a saved override must invalidate the cached decision');
    const block = body.slice(invalidate, invalidate + 200);
    assert.match(block, /companyId/);
    assert.match(block, /userId:\s*\n?\s*user\._id/);
  });
});
