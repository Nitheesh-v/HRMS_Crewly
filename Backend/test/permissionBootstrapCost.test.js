// ─────────────────────────────────────────────────────────────────────────────
// Phase 35.2 — RESPONSIVENESS PINS.
//
// The report behind this unit: "page loads very slowly, selected pages are not
// opening". Two mechanisms were found and fixed:
//
//   · A cold permission resolution ran the whole role-provisioning migration
//     UNCONDITIONALLY — five upserts plus five version-gated updates, ten
//     round-trips per tenant per cache miss, forever. On a remote database that
//     was the most expensive thing an ordinary page load could trigger, and it
//     ran again after every role edit (invalidatePermissionCache) and on every
//     API instance.
//
//   · Nothing was allowed to fail on the client: axios had NO timeout, so a
//     stalled request hung forever, and the route guard rendered "Your account
//     cannot open this page yet" for a permission check that had FAILED —
//     telling the person they were not allowed when the honest answer was
//     "the check did not complete".
//
// Hermetic, like the rest of this suite: the models are injected fakes, the
// frontend files are read as sources.
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/permission-bootstrap-cost';
process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const frontend = path.join(root, 'Frontend');
const backend = path.join(root, 'Backend');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const {
  ensureCompanyRoles,
  resolveUserPermissions,
  getSystemPermissionVersion,
} = await import('../src/utils/permissionService.js');

// ── a counting fake world ────────────────────────────────────────────────────
const PROVISIONED_COMPANY = '507f191e810c19729de860aa';
const FRESH_COMPANY = '507f191e810c19729de860bb';

const SYSTEM_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD', 'EMPLOYEE'];

const makeModels = ({ provisioned }) => {
  const calls = [];

  const roleDoc = (code) => ({
    _id: `role-${code}`,
    companyId: PROVISIONED_COMPANY,
    code,
    name: code,
    isSystemRole: true,
    isActive: true,
    permissionVersion: getSystemPermissionVersion(),
    updatedBy: null,
    permissions: [],
  });

  const CompanyRoleModel = {
    find: (filter) => ({
      lean: async () => {
        calls.push('CompanyRole.find');
        return provisioned && filter?.code ? SYSTEM_ROLES.map(roleDoc) : [];
      },
      populate: () => ({ lean: async () => { calls.push('CompanyRole.find+populate'); return []; } }),
    }),
    findOneAndUpdate: async (filter) => {
      calls.push(`CompanyRole.findOneAndUpdate(${filter?.code || 'any'})`);
      return roleDoc(filter?.code || 'COMPANY_ADMIN');
    },
    updateOne: async () => {
      calls.push('CompanyRole.updateOne');
      return { modifiedCount: 0 };
    },
    findOne: () => {
      calls.push('CompanyRole.findOne');
      const doc = { ...roleDoc('COMPANY_ADMIN'), updatedBy: null };
      return { populate: async () => doc };
    },
  };

  const PermissionModel = {
    bulkWrite: async () => {
      calls.push('Permission.bulkWrite');
      return {};
    },
    find: () => ({
      lean: async () => {
        calls.push('Permission.find');
        return [];
      },
    }),
    countDocuments: async () => 0,
    aggregate: async () => [],
  };

  return { calls, models: { PermissionModel, CompanyRoleModel } };
};

describe('permission bootstrap cost (35.2)', () => {
  test('an up-to-date tenant pays ONE read to ensure its roles, not ten writes', async () => {
    const { calls, models } = makeModels({ provisioned: true });

    // warm-up: the global permission catalogue is memoized per process, so the
    // first call in a process also carries that one-off bootstrap
    await ensureCompanyRoles(PROVISIONED_COMPANY, null, { fetchRoles: false, ...models });

    calls.length = 0;

    await ensureCompanyRoles(PROVISIONED_COMPANY, null, {
      fetchRoles: false,
      ...models,
    });

    assert.deepEqual(
      calls,
      ['CompanyRole.find'],
      'provisioning must not write when every role is present and current',
    );

    const writes = calls.filter((call) => /findOneAndUpdate|updateOne|bulkWrite/.test(call));
    assert.equal(writes.length, 0, 'no writes for an up-to-date tenant');
  });

  test('a COLD resolution of an established tenant costs two reads, not twelve', async () => {
    const { calls, models } = makeModels({ provisioned: true });

    await resolveUserPermissions(
      {
        _id: '507f1f77bcf86cd7994390aa',
        companyId: PROVISIONED_COMPANY,
        role: 'COMPANY_ADMIN',
        roleRef: null,
        permissionOverrides: [],
      },
      models,
    );

    assert.ok(
      calls.length <= 2,
      `cold resolution must stay within two reads, got ${calls.length}: ${calls.join(', ')}`,
    );
    assert.deepEqual(calls, ['CompanyRole.find', 'CompanyRole.findOne']);
  });

  test('a tenant that has never been provisioned still gets the full migration', async () => {
    const { calls, models } = makeModels({ provisioned: false });

    await ensureCompanyRoles(FRESH_COMPANY, 'founder-1', {
      fetchRoles: false,
      ...models,
    });

    const upserts = calls.filter((call) => call.startsWith('CompanyRole.findOneAndUpdate'));
    const migrations = calls.filter((call) => call === 'CompanyRole.updateOne');

    assert.equal(upserts.length, SYSTEM_ROLES.length, 'every system role is upserted once');
    assert.equal(migrations.length, SYSTEM_ROLES.length, 'every system role is migrated once');
  });

  test('a role whose permissionVersion is behind is still migrated immediately', async () => {
    const { calls, models } = makeModels({ provisioned: true });
    const version = getSystemPermissionVersion();

    // one stale role: the gate must let the migration through for that tenant
    models.CompanyRoleModel.find = () => ({
      lean: async () => {
        calls.push('CompanyRole.find');
        return SYSTEM_ROLES.map((code, index) => ({
          _id: `role-${code}`,
          code,
          isSystemRole: true,
          isActive: true,
          permissionVersion: index === 0 ? version - 1 : version,
          updatedBy: null,
          permissions: [],
        }));
      },
      populate: () => ({ lean: async () => [] }),
    });

    await ensureCompanyRoles(PROVISIONED_COMPANY, null, { fetchRoles: false, ...models });

    assert.equal(
      calls.filter((call) => call === 'CompanyRole.updateOne').length,
      1,
      'the stale role is migrated, the current four are left alone',
    );
    assert.equal(
      calls.filter((call) => call.startsWith('CompanyRole.findOneAndUpdate')).length,
      1,
      'one role is touched, not all five',
    );
  });
});

describe('the client is allowed to fail (35.2)', () => {
  test('both axios clients carry a bounded timeout', () => {
    const api = read('Frontend/src/services/api.js');

    const timeouts = api.match(/timeout:\s*REQUEST_TIMEOUT_MS/g) || [];

    assert.equal(timeouts.length, 2, 'the app client and the refresh client both time out');
    assert.match(api, /const REQUEST_TIMEOUT_MS = \d+;/, 'the bound is named and explicit');
  });

  test('a failed permission CHECK is not reported as a refusal', () => {
    const guard = read('Frontend/src/routes/RequirePermission.jsx');

    assert.match(guard, /checkFailed/, 'the guard separates a broken check from a denial');
    assert.match(guard, /We could not check your permissions/, 'and says so plainly');
    assert.match(guard, /Retry/, 'with a way to try again');
    assert.match(guard, /refreshPermissions/, 'that actually re-runs the check');

    // the denial card may only render when the check SUCCEEDED
    const deniedBranch = guard.slice(guard.indexOf('if (!allowed)'));
    assert.ok(!/error/.test(deniedBranch), 'the refusal card never sees the error state');
  });

  test('the roles page opens with one batch and defers the heavy list', () => {
    const page = read('Frontend/src/pages/settings/RolesPermissionsPage.jsx');

    assert.ok(
      !/useEffect\(\(\) => \{\s*load\(\);\s*loadUsers\(\);/.test(page),
      'the user list is not fetched as part of opening the page',
    );
    assert.match(page, /tab === 'users' && !usersLoaded/, 'it is fetched when that tab is opened');
    assert.match(
      page,
      /const \[roleRows, permissionData, templateData\] = await Promise\.all\(/,
      'roles, the permission catalogue and the templates arrive in one parallel batch',
    );

    const service = read('Frontend/src/services/permissionService.js');

    assert.match(service, /params: \{ limit: 200 \}/, 'the request matches the server-side cap');
    assert.ok(!/limit: 500/.test(service), 'and no longer asks for rows the API discards');
  });

  test('the unit is documented', () => {
    const doc = path.join(root, 'docs', 'PHASE_35_RESPONSIVENESS.md');

    assert.ok(fs.existsSync(doc), 'docs/PHASE_35_RESPONSIVENESS.md ships with the unit');

    const text = fs.readFileSync(doc, 'utf8');

    assert.match(text, /35\.2/, 'the document names the unit');
    assert.match(text, /awaiting localhost acceptance/, 'and states where acceptance stands');
  });

  test('no scratch probe is shipped', () => {
    const scratch = fs
      .readdirSync(backend)
      .filter((name) => name.startsWith('.tmp_'));

    assert.deepEqual(scratch, [], 'temporary probes are deleted before the commit');
  });
});
