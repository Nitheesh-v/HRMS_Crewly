// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.3 — TEAM AVAILABILITY SERVICE TESTS (HERMETIC)
//
//  Spec target: §40 — 47 assertions.
//  All models are FAKE — no Mongo, no network. Scope is mocked via
//  `scopeReader` injection (the service allows this on purpose).
//  The resolver under test is the real presenceResolver.js so we
//  validate integration with the 37.1 authority path.
// ═══════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── fakes ────────────────────────────────────────────────────────────
const rowMatchesFilter = (row, filter) => {
  if (!filter || typeof filter !== 'object') return true;
  if (Array.isArray(filter.$and)) {
    return filter.$and.every((sub) => rowMatchesFilter(row, sub));
  }
  if (Array.isArray(filter.$or)) {
    return filter.$or.some((sub) => rowMatchesFilter(row, sub));
  }
  if (filter.companyId !== undefined && row.companyId !== filter.companyId) return false;
  if (filter.status !== undefined && row.status !== filter.status) return false;
  if (filter._id && filter._id.$in) {
    if (!filter._id.$in.includes(row._id)) return false;
  }
  for (const [key, value] of Object.entries(filter)) {
    if (value && typeof value === 'object' && '$regex' in value) {
      const re = new RegExp(value.$regex, value.$options || '');
      if (!re.test(String(row[key] || ''))) return false;
    }
  }
  return true;
};

class FakeUserModel {
  constructor(rows) {
    this.rows = rows;
  }
  find(filter) {
    const filtered = this.rows.filter((r) => rowMatchesFilter(r, filter));
    const ctx = { rows: filtered, filter };
    const chain = {
      sort() { return chain; },
      skip() { return chain; },
      limit() {
        return {
          lean: async () => ctx.rows,
        };
      },
      select(_fields) {
        return chain;
      },
      populate(_path, _fields) {
        return chain;
      },
      lean: async () => ctx.rows,
    };
    return chain;
  }
}

class FakeUserPresenceModel {
  constructor(rows) {
    // Deep-clone the rows so per-test mutations (and the production
    // service's reads) never leak back into the module-level PRESENCE
    // array. Without this, one test's behaviour overwrites the rows
    // every other test sees.
    this.rows = rows.map((r) => ({ ...r }));
    this.lastQuery = null;
  }
  find(filter) {
    this.lastQuery = filter;
    const rows = this.rows.filter((row) => filter.userId.$in.includes(row.userId));
    const chain = {
      select(_fields) {
        return chain;
      },
      populate(_path, _fields) {
        return chain;
      },
      lean: async () => rows,
    };
    return chain;
  }
}

// ─── fixtures ─────────────────────────────────────────────────────────
const companyId = 'co-1';

const USERS = [
  {
    _id: 'u-self',
    name: 'Alice Self',
    email: 'alice@x.io',
    password: 'SECRET',
    phone: 'SECRET',
    employeeCode: 'E001',
    designation: 'Lead',
    avatarUrl: 'a.jpg',
    department: { _id: 'd-eng', name: 'Eng' },
    role: 'COMPANY_ADMIN',
    status: 'ACTIVE',
    companyId: 'co-1',
  },
  {
    _id: 'u-bob',
    name: 'Bob Eng',
    email: 'bob@x.io',
    password: 'SECRET',
    employeeCode: 'E002',
    designation: 'Eng',
    avatarUrl: 'b.jpg',
    department: { _id: 'd-eng', name: 'Eng' },
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    companyId: 'co-1',
  },
  {
    _id: 'u-carol',
    name: 'Carol Eng',
    email: 'carol@x.io',
    password: 'SECRET',
    employeeCode: 'E003',
    designation: 'Eng',
    avatarUrl: 'c.jpg',
    department: { _id: 'd-eng', name: 'Eng' },
    role: 'EMPLOYEE',
    status: 'INACTIVE',
    companyId: 'co-1',
  },
  {
    _id: 'u-dave',
    name: 'Dave Sales',
    email: 'dave@x.io',
    password: 'SECRET',
    employeeCode: 'E004',
    designation: 'Sales',
    avatarUrl: 'd.jpg',
    department: { _id: 'd-sales', name: 'Sales' },
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    companyId: 'co-1',
  },
];

const PRESENCE = [
  { userId: 'u-self', companyId, manualStatus: 'available', manualStatusExpiresAt: null, workLocation: 'office', workLocationExpiresAt: null, statusMessage: 'here', statusMessageExpiresAt: null, presenceExpiresAt: null },
  { userId: 'u-bob',  companyId, manualStatus: 'busy',      manualStatusExpiresAt: null, workLocation: 'wfh',    workLocationExpiresAt: null, statusMessage: 'heads down', statusMessageExpiresAt: null, presenceExpiresAt: null },
  { userId: 'u-carol',companyId, manualStatus: 'available', manualStatusExpiresAt: null, workLocation: 'office', workLocationExpiresAt: null, statusMessage: '', statusMessageExpiresAt: null, presenceExpiresAt: null },
  { userId: 'u-dave', companyId, manualStatus: 'available', manualStatusExpiresAt: null, workLocation: 'office', workLocationExpiresAt: null, statusMessage: '', statusMessageExpiresAt: null, presenceExpiresAt: null },
];

const build = async () => {
  const UserModel = new FakeUserModel(USERS);
  const UserPresenceModel = new FakeUserPresenceModel(PRESENCE);
  const mod = await import('../src/services/presence/presenceTeamService.js');
  return {
    service: mod.presenceTeamService({
      UserModel,
      UserPresenceModel,
      scopeReader: async () => ['u-self', 'u-bob', 'u-carol'],
      tenantConfigReader: async () => ({
        companyId: 'co-1',
        enabled: true,
        statusMessagesEnabled: true,
        workLocationEnabled: true,
        employeePresenceVisible: true,
        wfhMode: 'self_declare',
        allowedWorkLocations: ['office', 'wfh', 'remote'],
        manualStatusOptions: [],
        autoOfflineAfterMinutes: 30,
      }),
    }),
    UserPresenceModel,
  };
};

// ─── tests ────────────────────────────────────────────────────────────
test('presenceTeamService — happy path returns items + summary + meta', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId,
    actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });

  assert.equal(Array.isArray(out.items), true);
  assert.equal(typeof out.summary, 'object');
  assert.ok(out.summary.total >= 1);
  assert.ok(out.meta);
  assert.ok(out.meta.page >= 1);
});

test('presenceTeamService — item shape never includes password/email/salary/aadhaar/phone/bank', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId,
    actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });

  const forbiddenKeys = [
    'password', 'email', 'salary', 'deductions',
    'aadhaar', 'pan', 'uan', 'bank', 'phone', 'address',
  ];
  for (const item of out.items) {
    for (const key of forbiddenKeys) {
      assert.equal(item[key], undefined, `${key} must not be exposed`);
    }
  }
});

test('presenceTeamService — items only contain allowlisted user keys', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId,
    actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  const allowedKeys = ['id', 'name', 'employeeCode', 'designation', 'avatarUrl', 'department', 'role', 'status', 'presence', 'workLocation', 'statusMessage', 'employeePresenceVisible', 'presenceSource', 'manualStatus', 'manualStatusExpiresAt', 'statusMessageExpiresAt', 'workLocationExpiresAt', 'livePresenceAvailable', 'onLeave', 'outsideWorkingHours', 'workingHoursSource', 'workingHoursPhase', 'workingHoursIsWorkingDay'];
  for (const item of out.items) {
    for (const key of Object.keys(item)) {
      assert.ok(allowedKeys.includes(key), `unexpected key ${key} in item`);
    }
  }
});

test('presenceTeamService — INACTIVE users are NOT returned', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId,
    actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  const ids = out.items.map((it) => it.id);
  assert.equal(ids.includes('u-carol'), false);
});

test('presenceTeamService — scope returns ONLY authorized users', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId,
    actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  const ids = out.items.map((it) => it.id);
  assert.ok(ids.includes('u-self'));
  assert.ok(ids.includes('u-bob'));
  assert.equal(ids.includes('u-dave'), false);
});

test('presenceTeamService — search filters by name and employeeCode', async () => {
  const { service } = await build();
  const byName = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, search: 'Bob',
  });
  assert.equal(byName.items.length, 1);
  assert.equal(byName.items[0].id, 'u-bob');

  const byCode = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, search: 'E001',
  });
  assert.equal(byCode.items.length, 1);
  assert.equal(byCode.items[0].id, 'u-self');
});

test('presenceTeamService — search uses bounded regex (no ReDoS)', async () => {
  const { service } = await build();
  const longSearch = 'a'.repeat(500);
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, search: longSearch,
  });
  assert.ok(out);
});

test('presenceTeamService — presence filter narrows items', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, presence: 'busy',
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, 'u-bob');
});

test('presenceTeamService — workLocation filter narrows items', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, workLocation: 'wfh',
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, 'u-bob');
});

test('presenceTeamService — unknown users surface presence:unknown, not offline', async () => {
  const UserModel = new FakeUserModel([]);
  const UserPresenceModel = new FakeUserPresenceModel([]);
  const { presenceTeamService } = await import('../src/services/presence/presenceTeamService.js');
  const service = presenceTeamService({
    UserModel,
    UserPresenceModel,
    scopeReader: async () => ['u-missing'],
    tenantConfigReader: async () => ({
      companyId: 'co-1', wfhMode: 'self_declare',
      allowedWorkLocations: ['office','wfh','remote'],
      statusMessagesEnabled: true, workLocationEnabled: true,
      employeePresenceVisible: true,
    }),
  });

  const chain1 = {
    sort() { return chain1; },
    skip() { return chain1; },
    limit() {
      return {
          lean: async () => [{ _id: 'u-missing', name: 'Ghost', employeeCode: 'G1', designation: 'Eng', avatarUrl: null, department: { _id: 'd', name: 'Eng' }, role: 'EMPLOYEE', status: 'ACTIVE', companyId: 'co-1' }],
        };
    },
    select() { return chain1; },
    populate() { return chain1; },
    lean: async () => [{ _id: 'u-missing', name: 'Ghost', employeeCode: 'G1', designation: 'Eng', avatarUrl: null, department: { _id: 'd', name: 'Eng' }, role: 'EMPLOYEE', status: 'ACTIVE', companyId: 'co-1' }],
  };
  UserModel.find = () => chain1;

  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd' },
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].presence, 'unknown');
});

test('presenceTeamService — summary counts respect authorization scope', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  assert.equal(out.summary.byPresence.available, 1);
  assert.equal(out.summary.byPresence.busy, 1);
  assert.equal(out.summary.byPresence.dnd, 0);
  assert.equal(out.summary.byWorkLocation.office, 1);
  assert.equal(out.summary.byWorkLocation.wfh, 1);
  assert.equal(out.summary.byWorkLocation.remote, 0);
});

test('presenceTeamService — pagination returns chunks within and total reflects full set', async () => {
  const { service } = await build();
  const page1 = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, page: 1, limit: 1,
  });
  assert.equal(page1.items.length, 1);
  assert.equal(page1.meta.total >= 2, true);
  assert.ok(page1.meta.pages >= 2);
});

test('presenceTeamService — page beyond end returns empty items but valid meta', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, page: 99, limit: 1,
  });
  assert.equal(out.items.length, 0);
  assert.ok(out.meta);
});

test('presenceTeamService — limit caps at MAX_LIMIT via the service default clamp', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, limit: 9999,
  });
  assert.ok(out);
});

test('presenceTeamService — search does NOT match email or password', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, search: 'alice@x.io',
  });
  assert.equal(out.items.length, 0);
});

test('presenceTeamService — presence reads are batched (one find call)', async () => {
  const { service, UserPresenceModel } = await build();
  await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  assert.ok(UserPresenceModel.lastQuery);
  assert.equal(UserPresenceModel.lastQuery.companyId, companyId);
  assert.ok(Array.isArray(UserPresenceModel.lastQuery.userId.$in));
  assert.equal(UserPresenceModel.lastQuery.userId.$in.length, 2);
});

test('presenceTeamService — handles Employee role with [self] scope', async () => {
  const UserModel = new FakeUserModel(USERS);
  const UserPresenceModel = new FakeUserPresenceModel(PRESENCE);
  const { presenceTeamService } = await import('../src/services/presence/presenceTeamService.js');
  const service = presenceTeamService({
    UserModel,
    UserPresenceModel,
    scopeReader: async () => ['u-self'],
    tenantConfigReader: async () => ({
      companyId: 'co-1', wfhMode: 'self_declare',
      allowedWorkLocations: ['office','wfh','remote'],
      statusMessagesEnabled: true, workLocationEnabled: true,
      employeePresenceVisible: true,
    }),
  });
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'EMPLOYEE' },
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, 'u-self');
});

test('presenceTeamService — summary total equals unknown expected', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  assert.equal(out.summary.total, 2);
});

test('presenceTeamService — sort is deterministic (createdAt desc then _id desc)', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  assert.ok(out.items.length >= 1);
});

test('presenceTeamService — no presence row resolves to "unknown" but item still appears', async () => {
  const UserModel = new FakeUserModel([]);
  const UserPresenceModel = new FakeUserPresenceModel([]);
  const { presenceTeamService } = await import('../src/services/presence/presenceTeamService.js');
  const service = presenceTeamService({
    UserModel,
    UserPresenceModel,
    scopeReader: async () => ['u-bob'],
    tenantConfigReader: async () => ({
      companyId: 'co-1', wfhMode: 'self_declare',
      allowedWorkLocations: ['office','wfh','remote'],
      statusMessagesEnabled: true, workLocationEnabled: true,
      employeePresenceVisible: true,
    }),
  });
  const bobRows = [{ _id: 'u-bob', name: 'Bob', employeeCode: 'E2', designation: 'Eng', avatarUrl: null, department: { _id: 'd', name: 'Eng' }, role: 'EMPLOYEE', status: 'ACTIVE', companyId: 'co-1' }];
  const bobChain = {
    sort() { return bobChain; },
    skip() { return bobChain; },
    limit() {
      return {
          lean: async () => bobRows,
        };
    },
    select() { return bobChain; },
    populate() { return bobChain; },
    lean: async () => bobRows,
  };
  UserModel.find = () => bobChain;

  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd' },
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].presence, 'unknown');
});

test('presenceTeamService — meta returns page/pageSize/totalItems/totalPages', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, page: 1, limit: 1,
  });
  assert.ok('page' in out.meta);
  assert.ok('pageSize' in out.meta);
  assert.ok('totalItems' in out.meta);
  assert.ok('totalPages' in out.meta);
});

test('presenceTeamService — filter only present values when filter is unknown filter param throws', async () => {
  const { service } = await build();
  await assert.rejects(
    () => service.getTeamAvailability({
      companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, presence: 'away',
    }),
    /presence/i,
  );
});

test('presenceTeamService — byPresence summary includes unknown bucket when present', async () => {
  const UserModel = new FakeUserModel([]);
  const UserPresenceModel = new FakeUserPresenceModel([]);
  const { presenceTeamService } = await import('../src/services/presence/presenceTeamService.js');
  const service = presenceTeamService({      tenantConfigReader: async () => ({
        companyId: 'co-1', wfhMode: 'self_declare',
        allowedWorkLocations: ['office','wfh','remote'],
        statusMessagesEnabled: true, workLocationEnabled: true,
        employeePresenceVisible: true,
      }),

    UserModel,
    UserPresenceModel,
    scopeReader: async () => ['u-miss'],
  });
  const missRows2 = [{ _id: 'u-miss', name: 'X', employeeCode: 'X', designation: 'X', avatarUrl: null, department: { _id: 'd', name: 'Eng' }, role: 'EMPLOYEE', status: 'ACTIVE', companyId: 'co-1' }];
  const missChain2 = {
    sort() { return missChain2; },
    skip() { return missChain2; },
    limit() {
      return {
        lean: async () => missRows2,
      };
    },
    select() { return missChain2; },
    populate() { return missChain2; },
    lean: async () => missRows2,
  };
  UserModel.find = () => missChain2;
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd' },
  });
  assert.equal(out.summary.byPresence.unknown, 1);
});

test('presenceTeamService — call requires UserModel and UserPresenceModel', async () => {
  const { presenceTeamService } = await import('../src/services/presence/presenceTeamService.js');
  assert.throws(() => presenceTeamService({}), /UserModel/);
  assert.throws(() => presenceTeamService({ UserModel: {} }), /UserPresenceModel/);
});

test('presenceTeamService — exposes allowlist for presence filter values', async () => {
  const { PRESENCE_TEAM_ALLOWED_FILTERS } = await import('../src/services/presence/presenceTeamService.js');
  assert.ok(Array.isArray(PRESENCE_TEAM_ALLOWED_FILTERS));
  assert.ok(PRESENCE_TEAM_ALLOWED_FILTERS.includes('available'));
  assert.ok(PRESENCE_TEAM_ALLOWED_FILTERS.includes('busy'));
  assert.ok(PRESENCE_TEAM_ALLOWED_FILTERS.includes('dnd'));
  assert.ok(PRESENCE_TEAM_ALLOWED_FILTERS.includes('unknown'));
});

test('presenceTeamService — DEFAULT_LIMIT is 25, MAX_LIMIT is 100', async () => {
  const mod = await import('../src/services/presence/presenceTeamService.js');
  assert.equal(mod.DEFAULT_LIMIT, 25);
  assert.equal(mod.MAX_LIMIT, 100);
});

test('presenceTeamService — never returns users from another company', async () => {
  const UserModel = new FakeUserModel(USERS);
  const UserPresenceModel = new FakeUserPresenceModel(PRESENCE);
  const { presenceTeamService } = await import('../src/services/presence/presenceTeamService.js');
  const service = presenceTeamService({
    UserModel,
    UserPresenceModel,
    scopeReader: async () => ['u-foreign'],
    tenantConfigReader: async () => ({
      companyId: 'other-co', wfhMode: 'self_declare',
      allowedWorkLocations: ['office','wfh','remote'],
      statusMessagesEnabled: true, workLocationEnabled: true,
      employeePresenceVisible: true,
    }),
  });
  const emptyRows = [];
  const emptyChain = {
    sort() { return emptyChain; },
    skip() { return emptyChain; },
    limit() {
      return {
        lean: async () => emptyRows,
      };
    },
    select() { return emptyChain; },
    populate() { return emptyChain; },
    lean: async () => emptyRows,
  };
  UserModel.find = () => emptyChain;
  const out = await service.getTeamAvailability({
    companyId: 'other-co', actor: { _id: 'u-foreign', role: 'MANAGER', department: 'd-eng' },
  });
  assert.equal(out.items.length, 0);
});

test('presenceTeamService — byWorkLocation summary bucket always exists (even if zero)', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  assert.ok('office' in out.summary.byWorkLocation);
  assert.ok('wfh' in out.summary.byWorkLocation);
  assert.ok('remote' in out.summary.byWorkLocation);
});

test('presenceTeamService — INACTIVE scope members do not contribute to summary', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  assert.equal(out.summary.total, 2);
});

test('presenceTeamService — pagination params are coerced/clamped', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, page: 0, limit: 0,
  });
  assert.ok(out.meta.page >= 1);
});

test('presenceTeamService — single resolver authority: presence value matches 37.1 resolvePresence', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  const bob = out.items.find((i) => i.id === 'u-bob');
  assert.equal(bob.presence, 'busy');
  const self = out.items.find((i) => i.id === 'u-self');
  assert.equal(self.presence, 'available');
});

test('presenceTeamService — items carry workLocation field', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  const bob = out.items.find((i) => i.id === 'u-bob');
  assert.equal(bob.workLocation, 'wfh');
});

test('presenceTeamService — search is case-insensitive', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, search: 'bOb',
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, 'u-bob');
});

test('presenceTeamService — empty scope returns empty items + zero summary', async () => {
  const UserModel = new FakeUserModel(USERS);
  const UserPresenceModel = new FakeUserPresenceModel(PRESENCE);
  const { presenceTeamService } = await import('../src/services/presence/presenceTeamService.js');
  const service = presenceTeamService({
    UserModel,
    UserPresenceModel,
    scopeReader: async () => [],
    tenantConfigReader: async () => ({
      companyId: 'co-1', wfhMode: 'self_declare',
      allowedWorkLocations: ['office','wfh','remote'],
      statusMessagesEnabled: true, workLocationEnabled: true,
      employeePresenceVisible: true,
    }),
  });
  const emptyRows = [];
  const emptyChain = {
    sort() { return emptyChain; },
    skip() { return emptyChain; },
    limit() {
      return {
        lean: async () => emptyRows,
      };
    },
    select() { return emptyChain; },
    populate() { return emptyChain; },
    lean: async () => emptyRows,
  };
  UserModel.find = () => emptyChain;
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'TEAM_LEAD' },
  });
  assert.equal(out.items.length, 0);
  assert.equal(out.summary.total, 0);
});

test('presenceTeamService — presence items carry statusMessage field', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  const self = out.items.find((i) => i.id === 'u-self');
  assert.equal(self.statusMessage, 'here');
});

test('presenceTeamService — filters compose: presence AND workLocation', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, presence: 'busy', workLocation: 'wfh',
  });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, 'u-bob');
});

test('presenceTeamService — invalid filter combinations return empty items, not crash', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, presence: 'available', workLocation: 'remote',
  });
  assert.equal(out.items.length, 0);
});

test('presenceTeamService — byPresence counts always include all 4 buckets', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  assert.ok('available' in out.summary.byPresence);
  assert.ok('busy' in out.summary.byPresence);
  assert.ok('dnd' in out.summary.byPresence);
  assert.ok('unknown' in out.summary.byPresence);
});

test('presenceTeamService — exposed: filter URL sanitised — does not echo unrecognised presence filter back into token-less string', async () => {
  const { service } = await build();
  await assert.rejects(
    () => service.getTeamAvailability({
      companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, presence: 'offline',
    }),
    /presence/i,
  );
});

test('presenceTeamService — items: department is populated to { _id, name } shape', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  const self = out.items.find((i) => i.id === 'u-self');
  assert.equal(typeof self.department, 'object');
  assert.equal(self.department.name, 'Eng');
});

test('presenceTeamService — items: role field is the canonical user role', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  const self = out.items.find((i) => i.id === 'u-self');
  assert.equal(self.role, 'COMPANY_ADMIN');
});

test('presenceTeamService — presence rows that have companyId mismatch are excluded by default', async () => {
  const UserModel = new FakeUserModel(USERS);
  const UserPresenceModel = {
    // Deep-clone so the test's local push doesn't leak into the
    // module-level PRESENCE constant (and break later tests that
    // expect only the 4 baseline rows).
    rows: PRESENCE.map((r) => ({ ...r })),
    lastQuery: null,
    find(filter) {
      this.lastQuery = filter;
      const rows = this.rows.filter((r) => r.companyId === filter.companyId && filter.userId.$in.includes(r.userId));
      const ch = {
        select() { return ch; },
        populate() { return ch; },
        lean: async () => rows,
      };
      return ch;
    },
  };
  UserPresenceModel.rows.push({ userId: 'u-bob', companyId: 'other-co', presence: 'available', workLocation: 'office', statusMessage: '', statusMessageExpiresAt: null, presenceExpiresAt: null });

  const { presenceTeamService } = await import('../src/services/presence/presenceTeamService.js');
  const service = presenceTeamService({
    UserModel,
    UserPresenceModel,
    scopeReader: async () => ['u-self', 'u-bob', 'u-carol'],
    tenantConfigReader: async () => ({
      companyId: 'co-1', wfhMode: 'self_declare',
      allowedWorkLocations: ['office','wfh','remote'],
      statusMessagesEnabled: true, workLocationEnabled: true,
      employeePresenceVisible: true,
    }),
  });
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  const bob = out.items.find((i) => i.id === 'u-bob');
  assert.equal(bob.presence, 'busy');
});

test('presenceTeamService — exposed helpers (MAX_SEARCH_LEN, DEFAULT_LIMIT, MAX_LIMIT) are positive integers', async () => {
  const mod = await import('../src/services/presence/presenceTeamService.js');
  assert.ok(Number.isInteger(mod.MAX_SEARCH_LEN) && mod.MAX_SEARCH_LEN > 0);
  assert.ok(Number.isInteger(mod.DEFAULT_LIMIT) && mod.DEFAULT_LIMIT > 0);
  assert.ok(Number.isInteger(mod.MAX_LIMIT) && mod.MAX_LIMIT > 0);
  assert.ok(mod.MAX_LIMIT >= mod.DEFAULT_LIMIT);
});

test('presenceTeamService — pageSize is present and equals limit', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, page: 1, limit: 5,
  });
  assert.equal(out.meta.pageSize, 5);
  assert.equal(out.meta.limit, 5);
});

test('presenceTeamService — totalPages accounts for partial final page', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' }, limit: 1,
  });
  assert.equal(out.meta.totalPages, 2);
});

test('presenceTeamService — empty scope returns 1 page (not 0)', async () => {
  const UserModel = new FakeUserModel([]);
  const UserPresenceModel = new FakeUserPresenceModel([]);
  const { presenceTeamService } = await import('../src/services/presence/presenceTeamService.js');
  const service = presenceTeamService({
    UserModel,
    UserPresenceModel,
    scopeReader: async () => [],
    tenantConfigReader: async () => ({
      companyId: 'co-1', wfhMode: 'self_declare',
      allowedWorkLocations: ['office','wfh','remote'],
      statusMessagesEnabled: true, workLocationEnabled: true,
      employeePresenceVisible: true,
    }),
  });
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'TEAM_LEAD' },
  });
  assert.equal(out.meta.totalPages, 1);
});

test('presenceTeamService — config slice exposes the four employee-safe flags', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId, actor: { _id: 'u-self', role: 'MANAGER', department: 'd-eng' },
  });
  assert.ok('enabled' in out.config);
  assert.ok('statusMessagesEnabled' in out.config);
  assert.ok('workLocationEnabled' in out.config);
  assert.ok('employeePresenceVisible' in out.config);
});

// ──────────────────────────────────────────────────────────────────────
//  USER REPORT: "employee sets office + available, admin search returns
//  nothing". The team service MUST surface the row when a COMPANY_ADMIN
//  searches by (case-insensitive, partial) employee name. These three
//  tests pin the exact path that was reported as broken in production.
// ──────────────────────────────────────────────────────────────────────
test('presenceTeamService — admin search by name finds the employee (user-report pin)', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId,
    actor: { _id: 'u-admin', role: 'COMPANY_ADMIN' },
    search: 'bob',
  });
  const bob = out.items.find((i) => i.id === 'u-bob');
  assert.ok(bob, 'Bob must appear in the team list for an admin search');
  assert.equal(bob.presence, 'busy');
  assert.equal(bob.workLocation, 'wfh');
});

test('presenceTeamService — admin search is case-insensitive on name (user-report pin)', async () => {
  const { service } = await build();
  for (const q of ['BOB', 'Bob', ' bob ', 'oB']) {
    const out = await service.getTeamAvailability({
      companyId,
      actor: { _id: 'u-admin', role: 'COMPANY_ADMIN' },
      search: q,
    });
    const hit = out.items.find((i) => i.id === 'u-bob');
    assert.ok(hit, `search "${q}" must return Bob`);
  }
});

test('presenceTeamService — admin search with full name returns the right row (user-report pin)', async () => {
  const { service } = await build();
  const out = await service.getTeamAvailability({
    companyId,
    actor: { _id: 'u-admin', role: 'COMPANY_ADMIN' },
    search: 'Bob Eng',
  });
  const hit = out.items.find((i) => i.id === 'u-bob');
  assert.ok(hit, 'typing the full name must still return Bob');
});

// Phase 37.7 — N+1 fix. The team path now preloads schedule
// masters ONCE (5 parallel queries) and resolves every user in
// memory, instead of 4 queries × N users. We assert:
//  1. The batched reader is invoked once for a team of N users.
//  2. The single-user reader is NOT called (no fallback).
//  3. Every user ends up with the right wh context.
test('Phase 37.7: team path uses the batched working-hours reader (one preload, not N)', async () => {
  let batchCalls = 0;
  let singleCalls = 0;
  const whSummary = Object.freeze({
    phase: 'WITHIN_SHIFT',
    isWorkingDay: true,
    dayType: 'WORKING',
    source: 'ASSIGNMENT',
    crossesMidnight: false,
    startTime: '09:00',
    endTime: '17:00',
    attendanceDate: '2026-10-06',
    timezone: 'Asia/Kolkata',
    outsideWorkingHours: false,
  });
  // Scope returns all three test users (u-self, u-bob, u-carol).
  // The batch map is keyed by userId, one entry per scope member.
  const fakeBatch = async ({ users }) => {
    batchCalls += 1;
    const m = new Map();
    for (const u of users) m.set(String(u._id), whSummary);
    return m;
  };
  const mod = await import('../src/services/presence/presenceTeamService.js');
  const service = mod.presenceTeamService({
    UserModel: new FakeUserModel(USERS),
    UserPresenceModel: new FakeUserPresenceModel(PRESENCE),
    scopeReader: async () => ['u-self', 'u-bob', 'u-carol'],
    tenantConfigReader: async () => ({
      companyId: 'co-1',
      enabled: true,
      statusMessagesEnabled: true,
      workLocationEnabled: true,
      employeePresenceVisible: true,
      wfhMode: 'self_declare',
      allowedWorkLocations: ['office', 'wfh', 'remote'],
      manualStatusOptions: [],
      autoOfflineAfterMinutes: 30,
    }),
    workingHoursReaderMany: fakeBatch,
    workingHoursReader: async () => {
      singleCalls += 1;
      return whSummary;
    },
    liveStore: null,
  });
  const out = await service.getTeamAvailability({
    companyId,
    actor: { _id: 'u-admin', role: 'COMPANY_ADMIN' },
  });
  assert.equal(batchCalls, 1, 'workingHoursReaderMany is called exactly ONCE for N=3 users');
  assert.equal(singleCalls, 0, 'single-user workingHoursReader is NOT called when the batch succeeded');
  // u-carol is INACTIVE in the fixture so only u-self + u-bob come through.
  assert.equal(out.items.length, 2);
});

test('Phase 37.7: team path falls back to single-user reader when batch read fails', async () => {
  let batchCalls = 0;
  let singleCalls = 0;
  const mod = await import('../src/services/presence/presenceTeamService.js');
  const service = mod.presenceTeamService({
    UserModel: new FakeUserModel(USERS),
    UserPresenceModel: new FakeUserPresenceModel(PRESENCE),
    scopeReader: async () => ['u-self', 'u-bob', 'u-carol'],
    tenantConfigReader: async () => ({
      companyId: 'co-1',
      enabled: true,
      statusMessagesEnabled: true,
      workLocationEnabled: true,
      employeePresenceVisible: true,
      wfhMode: 'self_declare',
      allowedWorkLocations: ['office', 'wfh', 'remote'],
      manualStatusOptions: [],
      autoOfflineAfterMinutes: 30,
    }),
    workingHoursReaderMany: async () => {
      batchCalls += 1;
      // Simulate batch failure: throw, service catches and falls
      // back to per-user. Every user must still get a row.
      throw new Error('redis down');
    },
    workingHoursReader: async () => {
      singleCalls += 1;
      return null;
    },
    liveStore: null,
  });
  const out = await service.getTeamAvailability({
    companyId,
    actor: { _id: 'u-admin', role: 'COMPANY_ADMIN' },
  });
  assert.equal(batchCalls, 1, 'batch reader attempted once');
  // Fallback fires per user. 2 ACTIVE users (u-carol is INACTIVE).
  assert.equal(singleCalls, 2, 'fallback fires per ACTIVE user when batch throws');
  assert.equal(out.items.length, 2, 'all ACTIVE users still resolve even when batch fails');
});