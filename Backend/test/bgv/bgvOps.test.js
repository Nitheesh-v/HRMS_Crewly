// ============================================================
//  PHASE 30.1.1 — bgvOps hermetic tests (platform-operated BGV)
//
//  No Mongo, no Redis, no network, no .env: the service's injectable
//  deps are backed by a small in-memory collection engine speaking
//  the subset of Mongoose the service uses. Route/gate behavior that
//  would drag the env chain into a test process is verified with
//  static wiring assertions (the same trick the 28.x ops suite uses).
//
//  Covers the 30.1.1 acceptance list: platform gate ordering,
//  permission wiring, cross-tenant resolution, platform-only
//  assignment (400 on tenant ids), the masked tenant summary, the
//  unbounded-list cap, audit actor stamping, and the revocation
//  migration facts (registry/roles no longer expose BGV perms;
//  SYSTEM_PERMISSION_VERSION bumped to 28).
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

const {
  addEvidence,
  assignVerifier,
  extendSla,
  getCheck,
  getEvidenceFile,
  listChecks,
  listVerifiers,
  reopenCheck,
  seedChecksForCase,
  tenantChecksSummary,
  updateStatus,
  workbenchStats,
} = await import('../../src/services/bgv/bgvCheckService.js');

const { BGV_CHECK_TYPES } = await import('../../src/services/bgv/bgvCheckRules.js');
const { PLATFORM_ROLES } = await import('../../src/utils/constants.js');
const { ROLE_TEMPLATE_KEYS } = await import('../../src/utils/roleTemplates.js');

const COMP_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMP_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CASE_A = 'cccccccccccccccccccccccc';
const CASE_B = 'c2c2c2c2c2c2c2c2c2c2c2c2';
const CAND_A = 'dddddddddddddddddddddddd';
const CREW = 'eeeeeeeeeeeeeeeeeeeeeeee';   // BGV_TEAM platform user
const CREW_LEAD = 'e2e2e2e2e2e2e2e2e2e2e2e2'; // PLATFORM_ADMIN
const TENANT_USER = 'ffffffffffffffffffffffff'; // EMPLOYEE — must be rejected

const OPS_ACTOR = { userId: CREW_LEAD, canAssign: true };
const VERIFY_ACTOR = { userId: CREW, canAssign: false };

// ── mini in-memory query engine ────────────────────────────────

const getPath = (doc, dotted) => {
  let cur = doc;
  for (const part of dotted.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && !/^\d+$/.test(part)) {
      cur = cur.map((item) => (item == null ? undefined : item[part]));
      continue;
    }
    cur = /^\d+$/.test(part) && Array.isArray(cur) ? cur[Number(part)] : cur[part];
  }
  return cur;
};

const leafMatch = (value, cond) => {
  if (Array.isArray(value) && !(cond && typeof cond === 'object' && !Array.isArray(cond))) {
    return value.some((item) => leafMatch(item, cond));
  }
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, want]) => {
      if (op === '$in') return (want || []).includes(value);
      if (op === '$nin') return !(want || []).includes(value);
      if (op === '$ne') return value !== want;
      if (op === '$gt') return new Date(value) > new Date(want);
      if (op === '$gte') return new Date(value) >= new Date(want);
      if (op === '$lt') return new Date(value) < new Date(want);
      if (op === '$lte') return new Date(value) <= new Date(want);
      if (op === '$regex') return want.test(String(value ?? ''));
      throw new Error(`engine: unsupported op ${op}`);
    });
  }
  return String(value ?? '') === String(cond ?? '');
};

const docMatches = (doc, query = {}) =>
  Object.entries(query).every(([key, cond]) => {
    if (key === '$or') return cond.some((alt) => docMatches(doc, alt));
    if (key.endsWith('.$')) return (getPath(doc, key.slice(0, -2)) || []).some((item) => leafMatch(item, cond));
    return leafMatch(getPath(doc, key), cond);
  });

class Collection {
  constructor(rows = []) {
    this.rows = rows;
    this.subSeq = 0;
  }

  find(query = {}) {
    const state = {
      docs: this.rows.filter((doc) => docMatches(doc, query)),
      sortKey: null,
      skipN: 0,
      limitN: 0,
    };
    const api = {
      sort: (spec) => {
        const key = Object.keys(spec)[0];
        const dir = spec[key] >= 0 ? 1 : -1;
        state.docs = [...state.docs].sort((a, b) => {
          const av = getPath(a, key);
          const bv = getPath(b, key);
          return (av == null ? 0 : String(av).localeCompare(String(bv))) * dir || a._id.localeCompare(b._id);
        });
        return api;
      },
      skip: (n) => ((state.skipN = n), api),
      limit: (n) => ((state.limitN = n), api),
      select: () => api,
      lean: async () => {
        let docs = state.docs;
        if (state.skipN) docs = docs.slice(state.skipN);
        if (state.limitN) docs = docs.slice(0, state.limitN);
        return docs.map((doc) => ({ ...doc }));
      },
      then: (resolve, reject) => api.lean().then(resolve, reject),
    };
    return api;
  }

  findOne(query = {}) {
    const doc = this.rows.find((row) => docMatches(row, query));
    const copy = doc ? { ...doc } : null;
    const api = {
      select: () => api,
      lean: async () => copy,
      then: (resolve, reject) => Promise.resolve(copy).then(resolve, reject),
    };
    return api;
  }

  async countDocuments(query = {}) {
    return this.rows.filter((doc) => docMatches(doc, query)).length;
  }

  async create(doc) {
    const row = { _id: `gen${Math.random().toString(36).slice(2, 14)}`, updatedAt: new Date(), ...doc };
    this.rows.push(row);
    return row;
  }

  applyUpdate(row, update) {
    const positional = row.__matchedIndex;
    for (const [key, value] of Object.entries(update.$set || {})) {
      setPath(row, key.replace(/\.\$\./g, `.${positional}.`), value);
    }
    for (const [key, value] of Object.entries(update.$push || {})) {
      const arrPath = key.replace(/\.\$\./g, `.${positional}.`);
      if (value && typeof value === 'object' && !value._id) value._id = `sub${++this.subSeq}`;
      const arr = getPath(row, arrPath);
      if (Array.isArray(arr)) arr.push(value);
      else setPath(row, arrPath, [value]);
    }
    delete row.__matchedIndex;
    row.updatedAt = new Date();
  }

  async updateOne(query, update) {
    const row = this.rows.find((doc) => docMatches(doc, query));
    if (!row) return { modifiedCount: 0 };
    this.markPositional(row, query);
    this.applyUpdate(row, update);
    return { modifiedCount: 1 };
  }

  markPositional(row, query) {
    const entryKeyQuery = Object.entries(query).find(([key]) => key.endsWith('.entryKey'));
    if (entryKeyQuery) {
      const [, want] = entryKeyQuery;
      row.__matchedIndex = (row.entries || []).findIndex((entry) => entry.entryKey === want);
    }
  }

  findOneAndUpdate(query, update, options = {}) {
    const self = this;
    const promise = (async () => {
      const row = self.rows.find((doc) => docMatches(doc, query));
      if (!row) return null;
      self.markPositional(row, query);
      self.applyUpdate(row, update);
      return row;
    })();
    return {
      lean: () => promise,
      then: (resolve, reject) => promise.then(resolve, reject),
    };
  }
}

const setPath = (doc, dotted, value) => {
  const parts = dotted.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cur[key] == null) cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
};

const makeWorld = () => {
  const auditLog = [];
  const events = [];
  const files = new Map();
  const users = [
    { _id: CREW, name: 'Crew Verifier', role: 'BGV_TEAM', status: 'ACTIVE', employeeCode: 'CRW-90' },
    { _id: CREW_LEAD, name: 'Crew Lead', role: 'PLATFORM_ADMIN', status: 'ACTIVE', employeeCode: 'CRW-01' },
    { _id: TENANT_USER, name: 'Tenant Employee', role: 'EMPLOYEE', status: 'ACTIVE' },
  ];
  const companies = [
    { _id: COMP_A, name: 'Acme Textiles' },
    { _id: COMP_B, name: 'Beta Logistics' },
  ];
  const cases = new Collection([
    {
      _id: CASE_A,
      companyId: COMP_A,
      candidate: CAND_A,
      status: 'IN_PROGRESS',
      candidateSnapshot: { name: 'Priya Raman', candidateCode: 'CAND-7' },
      jobSnapshot: { title: 'Line Supervisor' },
      pastEmployers: [{ orgName: 'Acme Mills', fromDate: '2020-01-01', toDate: '2023-06-30', designation: 'Operator', employeeId: 'AM-441' }],
      education: [{ degree: 'B.E.', institution: 'Anna University', university: 'Anna University', rollNumber: 'R1', yearOfPassing: 2019 }],
      addressHistory: [{ kind: 'PERMANENT', line: '12 x St', city: 'Coimbatore', district: 'Coimbatore', state: 'TN', pinCode: '641001' }],
    },
    {
      _id: CASE_B,
      companyId: COMP_B,
      candidate: CAND_A,
      status: 'IN_PROGRESS',
      candidateSnapshot: { name: 'Vikram S', candidateCode: 'CAND-8' },
      jobSnapshot: { title: 'Driver' },
      pastEmployers: [],
      education: [],
      addressHistory: [],
    },
  ]);
  const checks = new Collection([]);
  const d = {
    checkModel: checks,
    caseModel: cases,
    settingsModel: { findOne: () => ({ lean: async () => ({}) }) },
    userModel: new Collection(users),
    companyModel: new Collection(companies),
    store: async ({ buffer }) => {
      const key = `mem${files.size + 1}`;
      files.set(key, buffer);
      return { storageProvider: 'memory', storageKey: key, fileUrl: '' };
    },
    read: async ({ storageKey }) => files.get(storageKey),
    emitEvent: async (event) => { events.push(event); },
    audit: async (payload) => { auditLog.push(payload); },
    cacheThrough: async ({ loader }) => loader(),
  };
  return { d, auditLog, events, files, checks };
};

const seedBothTenants = async (d) => {
  const a = await seedChecksForCase({ companyId: COMP_A, caseId: CASE_A, actorId: CREW_LEAD }, d);
  const b = await seedChecksForCase({ companyId: COMP_B, caseId: CASE_B, actorId: CREW_LEAD }, d);
  return [a, b];
};

// ── 1 · framework: seeding for two tenants (cross-tenant rows) ──

test('30.1.1 seeds one check per required type per tenant case', async () => {
  const { d } = makeWorld();
  const [a, b] = await seedBothTenants(d);
  assert.equal(a.created, BGV_CHECK_TYPES.length);
  assert.equal(b.created, BGV_CHECK_TYPES.length);
  assert.equal(d.checkModel.rows.length, BGV_CHECK_TYPES.length * 2);
  assert.equal(d.checkModel.rows.filter((r) => String(r.companyId) === COMP_A).length, BGV_CHECK_TYPES.length);
});

test('30.1.1 seeding is idempotent per case', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const again = await seedChecksForCase({ companyId: COMP_A, caseId: CASE_A, actorId: CREW_LEAD }, d);
  assert.equal(again.created, 0);
});

test('platform repair seed may omit companyId — the CASE decides ownership', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const before = d.checkModel.rows.length;
  const result = await seedChecksForCase({ caseId: CASE_B, actorId: CREW_LEAD }, d);
  assert.equal(result.created, 0); // already seeded; ownership resolved from the case
  assert.equal(d.checkModel.rows.length, before);
});

// ── 2 · list: cross-tenant + hard cap when unfiltered ───────────

test('cross-tenant list returns every tenant row for bgv:read', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const { checks, meta } = await listChecks({ actor: VERIFY_ACTOR, filters: { companyId: COMP_A }, limit: 100 }, d);
  assert.ok(checks.length > 0);
  assert.ok(checks.every((check) => check.companyId === COMP_A));
  assert.ok(checks.every((check) => check.company.name === 'Acme Textiles'));
  assert.equal(meta.capped, false);
});

test('unfiltered queue is hard-capped (no all-tenant dump)', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const { meta } = await listChecks({ actor: OPS_ACTOR, filters: {}, limit: 500 }, d);
  assert.equal(meta.capped, true);
  assert.ok(meta.limit <= 50);
  assert.match(meta.notice, /capped/);
});

test('status filter + mine filter scope the queue', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const all = await listChecks({ actor: OPS_ACTOR, filters: { status: 'PENDING,VERIFIED' }, limit: 100 }, d);
  assert.ok(all.checks.every((check) => ['PENDING', 'VERIFIED'].includes(check.status)));
  const mine = await listChecks({ actor: VERIFY_ACTOR, filters: { assignedToMe: true }, limit: 100 }, d);
  assert.equal(mine.checks.length, 0); // nothing assigned yet
});

// ── 3 · detail read: per-record tenant resolution + audit-on-read ─

test('detail read resolves the record, audits PLATFORM_USER view', async () => {
  const { d, auditLog } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.companyId === COMP_B);
  const view = await getCheck({ checkId: row._id, actor: VERIFY_ACTOR }, d);
  assert.equal(view.companyId, COMP_B);
  assert.equal(view.company.name, 'Beta Logistics');
  const viewed = auditLog.find((entry) => entry.action === 'BGV_CHECK_VIEWED');
  assert.ok(viewed, 'audit-on-read missing');
  assert.equal(viewed.actorRole, 'PLATFORM_USER');
  assert.equal(viewed.metadata.actorType, 'PLATFORM_USER');
  assert.equal(String(viewed.companyId), COMP_B);
  assert.equal(String(viewed.actorId), CREW);
});

// ── 4 · assignment: platform users only (tenant id = 400) ───────

test('assign accepts a platform verifier', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.checkType === 'EMPLOYMENT' && r.companyId === COMP_A);
  const updated = await assignVerifier({ checkId: row._id, verifierId: CREW, actor: OPS_ACTOR }, d);
  assert.equal(updated.assignedVerifierId, CREW);
});

test('assign REJECTS a tenant User id with 400', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.companyId === COMP_A);
  await assert.rejects(
    () => assignVerifier({ checkId: row._id, verifierId: TENANT_USER, actor: OPS_ACTOR }, d),
    (error) => error.statusCode === 400 && /platform users/.test(error.message)
  );
});

test('assign of an unknown verifier 404s; requireOps blocks non-manage actors', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.companyId === COMP_A);
  await assert.rejects(
    () => assignVerifier({ checkId: row._id, verifierId: CAND_A, actor: OPS_ACTOR }, d),
    (error) => error.statusCode === 404
  );
  await assert.rejects(
    () => assignVerifier({ checkId: row._id, verifierId: CREW, actor: VERIFY_ACTOR }, d),
    (error) => error.statusCode === 403 && /bgv:assign/.test(error.message)
  );
});

test('verifier picker only lists platform users', async () => {
  const { d } = makeWorld();
  const verifiers = await listVerifiers({}, d);
  assert.deepEqual(verifiers.map((v) => v.id).sort(), [CREW, CREW_LEAD].sort());
  assert.ok(!verifiers.some((v) => v.id === TENANT_USER));
});

// ── 5 · work writes: verify actor works any check, own tenant ───

test('bgv:verify holder may update status on any check (no own-only rule)', async () => {
  const { d, events } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.checkType === 'EMPLOYMENT' && r.companyId === COMP_B);
  const updated = await updateStatus(
    { checkId: row._id, entryKey: null, toStatus: 'IN_PROGRESS', payload: {}, actor: VERIFY_ACTOR },
    d
  );
  assert.equal(updated.status, 'IN_PROGRESS');
  assert.equal(events[events.length - 1].type, 'BGV_CHECK_STATUS_CHANGED');
});

test('a status write only mutates the record resolved to its own tenant', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const target = d.checkModel.rows.find((r) => r.checkType === 'EMPLOYMENT' && r.companyId === COMP_B);
  const sibling = d.checkModel.rows.find((r) => r.checkType === 'EMPLOYMENT' && r.companyId === COMP_A);
  await updateStatus({ checkId: target._id, toStatus: 'IN_PROGRESS', payload: {}, actor: VERIFY_ACTOR }, d);
  const freshB = d.checkModel.rows.find((r) => r._id === target._id);
  const freshA = d.checkModel.rows.find((r) => r._id === sibling._id);
  assert.equal(freshB.status, 'IN_PROGRESS');
  assert.equal(freshA.status, 'PENDING', 'cross-tenant mutation leaked');
});

test('raw Aadhaar in verifier text is refused', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.companyId === COMP_A);
  await assert.rejects(
    () => updateStatus({ checkId: row._id, toStatus: 'DISCREPANCY', payload: { resultSummary: 'Aadhaar 1234 5678 9012 mismatch' }, actor: VERIFY_ACTOR }, d),
    (error) => error.statusCode === 400 && /mask/i.test(error.message)
  );
});

test('evidence: phone masked in audit, never raw; file facts only', async () => {
  const { d, auditLog, files } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.checkType === 'EMPLOYMENT' && r.companyId === COMP_A);
  const entryKey = row.entries[0].entryKey;
  await addEvidence(
    {
      checkId: row._id,
      kind: 'CALL_LOG',
      note: 'HR confirmed tenure',
      meta: { outcome: 'CONFIRMED', phone: '9876543210' },
      actor: VERIFY_ACTOR,
    },
    d
  );
  await addEvidence(
    {
      checkId: row._id,
      kind: 'SCREENSHOT',
      note: 'portal screenshot',
      file: { buffer: Buffer.from('x'), originalname: 'shot.png', mimetype: 'image/png', size: 1 },
      actor: VERIFY_ACTOR,
    },
    d
  );
  const stored = d.checkModel.rows.find((r) => r._id === row._id);
  const evidences = stored.entries[0].evidence;
  assert.equal(evidences.length, 2);
  const auditEntry = auditLog.find((entry) => entry.action === 'BGV_CHECK_EVIDENCE_ADDED');
  assert.equal(auditEntry.metadata.meta.phone, 'XXXX-XXXX-3210');
  assert.equal(auditEntry.metadata.meta.outcome, 'CONFIRMED');
  assert.ok(!JSON.stringify(auditEntry).includes('HR confirmed'), 'note body must not reach audit');
  assert.equal(files.size, 1);
});

test('evidence file download is audited and bytes come back', async () => {
  const { d, auditLog } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.checkType === 'ADDRESS' && r.companyId === COMP_B);
  await addEvidence(
    { checkId: row._id, kind: 'DOCUMENT', note: 'field visit form', file: { buffer: Buffer.from('PDFDATA'), originalname: 'form.pdf', mimetype: 'application/pdf', size: 7 }, actor: VERIFY_ACTOR },
    d
  );
  const stored = d.checkModel.rows.find((r) => r._id === row._id);
  const evidenceId = stored.entries[0].evidence[0]._id;
  const file = await getEvidenceFile({ checkId: row._id, evidenceId, actor: VERIFY_ACTOR }, d);
  assert.equal(file.buffer.toString(), 'PDFDATA');
  assert.ok(auditLog.some((entry) => entry.action === 'BGV_CHECK_EVIDENCE_DOWNLOADED'));
});

test('SLA extend: once per check, bounded, audited', async () => {
  const { d, auditLog } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.checkType === 'EDUCATION' && r.companyId === COMP_A);
  const updated = await extendSla({ checkId: row._id, days: 5, reason: 'Employer HR on leave', actor: VERIFY_ACTOR }, d);
  assert.equal(updated.sla.extendedOnce, true);
  assert.equal(updated.sla.extensionDays, 5);
  await assert.rejects(
    () => extendSla({ checkId: row._id, days: 2, reason: 'again', actor: VERIFY_ACTOR }, d),
    (error) => error.statusCode === 409
  );
  assert.ok(auditLog.some((entry) => entry.action === 'BGV_CHECK_SLA_EXTENDED'));
});

// ── 6 · reopen is a queue-operations act (bgv:assign) ───────────

test('reopen requires bgv:assign and a written reason; clears terminal state', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.checkType === 'EMPLOYMENT' && r.companyId === COMP_A);
  await updateStatus({ checkId: row._id, toStatus: 'IN_PROGRESS', payload: {}, actor: VERIFY_ACTOR }, d);
  await updateStatus(
    { checkId: row._id, toStatus: 'UTV', payload: { followUp: { closedReason: 'Employer unreachable' } }, actor: VERIFY_ACTOR },
    d
  );
  await assert.rejects(
    () => reopenCheck({ checkId: row._id, reason: 'new employer contact', actor: VERIFY_ACTOR }, d),
    (error) => error.statusCode === 403
  );
  const reopened = await reopenCheck({ checkId: row._id, reason: 'new employer contact', actor: OPS_ACTOR }, d);
  assert.equal(reopened.status, 'IN_PROGRESS');
  assert.equal(reopened.followUp.closedReason, '');
});

// ── 7 · stats cards + tenant summary (masked to the bone) ───────

test('workbench stats expose the four ops cards', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const stats = await workbenchStats({ actor: OPS_ACTOR }, d);
  assert.deepEqual(Object.keys(stats).sort(), ['awaitingResponse', 'dueSoonIn48h', 'open', 'overdue']);
  assert.equal(stats.open, BGV_CHECK_TYPES.length * 2);
});

test('tenant summary = ONLY checkType/status/updatedAt per check', async () => {
  const { d } = makeWorld();
  await seedBothTenants(d);
  const row = d.checkModel.rows.find((r) => r.checkType === 'EMPLOYMENT' && r.companyId === COMP_A);
  await assignVerifier({ checkId: row._id, verifierId: CREW, actor: OPS_ACTOR }, d);
  await addEvidence({ checkId: row._id, kind: 'CALL_LOG', note: 'private verifier remark', meta: { phone: '9876543210' }, actor: VERIFY_ACTOR }, d);
  const summary = await tenantChecksSummary({ companyId: COMP_A, caseId: CASE_A }, d);
  assert.equal(summary.length, BGV_CHECK_TYPES.length);
  for (const item of summary) {
    assert.deepEqual(Object.keys(item).sort(), ['checkType', 'status', 'updatedAt']);
  }
  const blob = JSON.stringify(summary);
  assert.ok(!/private verifier remark/.test(blob));
  assert.ok(!blob.includes(CREW));          // no assignee ids
  assert.ok(!/Crew Verifier/.test(blob));   // no assignee names
  assert.ok(!blob.includes('9876543210') && !blob.includes('XXXX3210')); // no contact data
  // other tenants never surface:
  const other = await tenantChecksSummary({ companyId: COMP_B, caseId: CASE_B }, d);
  assert.ok(other.every((item) => item.status === 'PENDING'));
});

// ── 8 · static wiring: gate order + mounts + retired surface ────

test('tenant /api/bgv family is summary-only; verifier routes are gone', () => {
  const index = read('routes', 'index.js');
  assert.ok(index.includes('router.use("/bgv", bgvTenantRoutes)'), 'tenant mount must be the summary router');
  assert.ok(!index.includes('bgvCheckRoutes'), 'execution router must NOT be mounted tenant-side');
  const tenant = read('routes', 'bgvTenantRoutes.js');
  assert.equal((tenant.match(/^router\.get\(/gm) || []).length, 1, 'exactly one tenant route');
  assert.ok(tenant.includes("'/cases/:caseId/checks-summary'"));
  assert.ok(tenant.includes("requirePermission('BACKGROUND_VERIFICATION_READ')"));
  for (const verb of ['assign', 'status', 'evidence', 'extend-sla', 'reopen']) {
    assert.ok(!tenant.includes(`/${verb}`), `tenant surface must not expose ${verb}`);
  }
});

test('platform mount sits AFTER the session gate and gates with permits', () => {
  const superRoutes = read('routes', 'superAdminRoutes.js');
  const gateAt = superRoutes.indexOf('router.use(protect, superAdminSession)');
  const bgvAt = superRoutes.indexOf('router.use("/bgv", bgvCheckRoutes)');
  assert.ok(gateAt !== -1 && bgvAt !== -1 && gateAt < bgvAt, 'session gate must run before /bgv');
  const routes = read('routes', 'bgvCheckRoutes.js');
  assert.ok(routes.includes("permit('bgv:verify', 'bgv:assign')"), 'work writes gated');
  assert.ok(routes.includes("router.post('/checks/:checkId/assign', permit('bgv:assign')"), 'assign gated to ops');
  assert.ok(routes.includes("router.get('/checks', permit('bgv:read')"), 'list gated to read');
  assert.ok(!routes.includes('bgv:manage'), 'retired permission name must not survive');
  assert.ok(!routes.includes('requirePermission'), 'platform sub-router never uses tenant permission middleware');
});

test('superAdminSession 403s non-platform roles BEFORE any DB lookup', () => {
  const src = read('middlewares', 'superAdminAuth.js');
  const body = src.slice(src.indexOf('export const superAdminSession'));
  const forbiddenAt = body.indexOf("'Platform administrator access required'");
  const lookupAt = body.indexOf('AdminSession.findOne');
  assert.ok(forbiddenAt !== -1 && lookupAt !== -1 && forbiddenAt < lookupAt, 'role check must precede DB');
});

test('platform permission map matches the 30.1.1 contract', () => {
  const src = read('middlewares', 'superAdminAuth.js');
  const bgvTeam = src.slice(src.indexOf("'BGV_TEAM': ["));
  const adminBlock = src.slice(src.indexOf('PLATFORM_ADMIN: ['), src.indexOf('SUPPORT_ADMIN: ['));
  assert.ok(bgvTeam.includes("'bgv:read'") && bgvTeam.includes("'bgv:verify'"));
  assert.ok(!bgvTeam.includes("'bgv:assign'"), 'BGV_TEAM verifies; assign stays with admins');
  assert.ok(adminBlock.includes("'bgv:read'") && adminBlock.includes("'bgv:verify'") && adminBlock.includes("'bgv:assign'"));
  assert.ok(PLATFORM_ROLES.includes('BGV_TEAM'));
});

test('registry revokes the tenant BGV family; role templates drop BGV_VERIFIER', () => {
  const registry = read('utils', 'permissionRegistry.js');
  const registryCode = registry.replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['BGV_CHECK_READ', 'BGV_CHECK_ASSIGN', 'BGV_CHECK_VERIFY', 'BGV_CHECK_MANAGE', 'BGV_CHECK_OVERRIDE', 'BGV_EVIDENCE_MANAGE']) {
    assert.ok(!registryCode.includes(`"${name}"`) && !registryCode.includes(`'${name}'`), `${name} still live`);
  }
  assert.ok(!ROLE_TEMPLATE_KEYS.includes('BGV_VERIFIER'), 'BGV_VERIFIER template must be retired');
});

test('permission version bumped 27 → 28 with the revocation note', () => {
  const src = read('utils', 'permissionService.js');
  assert.match(src, /const SYSTEM_PERMISSION_VERSION = 28;/);
  assert.ok(src.includes('27 → 28 : 30.1.1'), 'changelog entry missing');
});

test('migration script pulls by ObjectId rows and deactivates permissions', () => {
  const script = fs.readFileSync(path.join(SRC, '../scripts/migratePhase30BgvPermissions.js'), 'utf8');
  assert.ok(script.includes('$pull'), 'must be atomic $pull');
  assert.ok(script.includes('Permission.updateMany'), 'must deactivate retired permission rows');
  assert.ok(script.includes("'BGV_CHECK_READ'") && script.includes("'BGV_EVIDENCE_MANAGE'"), 'revoked name list');
  assert.ok(!script.includes('$addToSet'), 'revocation script never re-grants');
});
