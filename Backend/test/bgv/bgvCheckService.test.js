// ============================================================
//  PHASE 30.1 — bgvCheckService hermetic tests
//
//  No Mongo, no Redis, no network: the service's injectable deps
//  (same pattern as the Phase 28 workers) are backed by small
//  in-memory collections with a mini query engine that speaks the
//  subset of Mongoose the service actually uses.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';

const {
  addEvidence,
  assignVerifier,
  extendSla,
  getCheck,
  getEvidenceFile,
  listChecks,
  reopenCheck,
  seedChecksForCase,
  updateStatus,
  workbenchStats,
} = await import('../../src/services/bgv/bgvCheckService.js');

const COMP_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMP_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CASE_A = 'cccccccccccccccccccccccc';
const CAND_A = 'dddddddddddddddddddddddd';
const USER_V = 'eeeeeeeeeeeeeeeeeeeeeeee';
const USER_X = 'ffffffffffffffffffffffff';

// ── mini in-memory query engine ────────────────────────────────

const getPath = (doc, path) => {
  let cur = doc;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      cur = cur.map((item) => (item == null ? undefined : item[part]));
      continue;
    }
    cur = cur[part];
  }
  return cur;
};

const setPath = (doc, path, value) => {
  const parts = path.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i += 1) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
};

const matchCond = (value, cond) => {
  const values = Array.isArray(value) ? value : [value];
  return Object.entries(cond).every(([op, operand]) => {
    switch (op) {
      case '$in':
        return values.some((v) => operand.map(String).includes(String(v)));
      case '$nin':
        return values.every((v) => !operand.map(String).includes(String(v)));
      case '$gt':
        return values.some((v) => v !== null && v !== undefined && new Date(v) > new Date(operand));
      case '$gte':
        return values.some((v) => v !== null && v !== undefined && new Date(v) >= new Date(operand));
      case '$lte':
        return values.some((v) => v !== null && v !== undefined && new Date(v) <= new Date(operand));
      case '$ne':
        return values.every((v) => v !== operand && !(operand === null && v === undefined));
      case '$regex':
        return values.some((v) => new RegExp(operand, cond.$options || '').test(String(v ?? '')));
      case '$options':
        return true;
      default:
        throw new Error(`unsupported op ${op}`);
    }
  });
};

const matchDoc = (doc, filter) =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((sub) => matchDoc(doc, sub));
    if (key === '$and') return cond.every((sub) => matchDoc(doc, sub));
    const value = getPath(doc, key);
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      return matchCond(value, cond);
    }
    if (Array.isArray(value)) return value.some((v) => String(v) === String(cond));
    return String(value ?? '') === String(cond ?? '');
  });

const applySort = (docs, spec) => {
  const entries = Object.entries(spec);
  return [...docs].sort((a, b) => {
    for (const [key, dir] of entries) {
      const av = getPath(a, key);
      const bv = getPath(b, key);
      const an = av instanceof Date ? av.getTime() : av;
      const bn = bv instanceof Date ? bv.getTime() : bv;
      if (an === bn) continue;
      if (an === undefined || an === null) return 1;
      if (bn === undefined || bn === null) return -1;
      return (an < bn ? -1 : 1) * dir;
    }
    return 0;
  });
};

class FakeQuery {
  constructor(docs, { single = false, update = null, filter = null, collection = null } = {}) {
    this.docs = docs;
    this.single = single;
    this.updateOp = update;
    this.filter = filter;
    this.collection = collection;
    this.sortSpec = null;
    this.skipCount = 0;
    this.limitCount = 0;
  }

  select() { return this; }
  sort(spec) { this.sortSpec = spec; return this; }
  skip(n) { this.skipCount = n; return this; }
  limit(n) { this.limitCount = n; return this; }
  lean() { return Promise.resolve(this.execute()); }
  then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }

  execute() {
    let out = this.docs;
    if (this.sortSpec) out = applySort(out, this.sortSpec);
    if (this.skipCount) out = out.slice(this.skipCount);
    if (this.limitCount) out = out.slice(0, this.limitCount);
    if (this.updateOp) {
      const target = out[0];
      if (target) applyUpdate(this.collection, target, this.updateOp, this.filter);
      return target ? structuredClone(target) : null;
    }
    if (this.single) return out[0] ? structuredClone(out[0]) : null;
    return out.map((doc) => structuredClone(doc));
  }
}

const applyUpdate = (collection, doc, update, filter = {}) => {
  const entryIndexOf = (key) => {
    if (!key.startsWith('entries.$.')) return -1;
    const entryKey = filter['entries.entryKey'];
    return (doc.entries || []).findIndex((entry) => entry.entryKey === entryKey);
  };
  for (const [key, value] of Object.entries(update.$set || {})) {
    const idx = entryIndexOf(key);
    if (idx >= 0) setPath(doc.entries[idx], key.replace('entries.$.', ''), value);
    else setPath(doc, key, value);
  }
  for (const [key, value] of Object.entries(update.$push || {})) {
    const idx = entryIndexOf(key);
    const items = Array.isArray(value) ? value : [value];
    if (idx >= 0) {
      const field = key.replace('entries.$.', '');
      doc.entries[idx][field] = [...(doc.entries[idx][field] || []), ...items.map((item) => ({ _id: `${collection.evSeq++}`, ...structuredClone(item) }))];
    }
  }
  doc.updatedAt = new Date();
};

class FakeCollection {
  constructor(name, docs = []) {
    this.name = name;
    this.docs = docs;
    this.seq = 100;
    this.evSeq = 1;
  }

  matched(filter) { return this.docs.filter((doc) => matchDoc(doc, filter || {})); }

  find(filter = {}) { return new FakeQuery(this.matched(filter)); }
  findOne(filter = {}) {
    const query = new FakeQuery(this.matched(filter).slice(0, 1), { single: true });
    return query;
  }
  countDocuments(filter = {}) { return Promise.resolve(this.matched(filter).length); }

  async create(doc) {
    const created = { _id: `${this.name[0]}${++this.seq}`, entries: [], sla: {}, followUp: {}, ...structuredClone(doc) };
    this.docs.push(created);
    return structuredClone(created);
  }

  findOneAndUpdate(filter, update) {
    const doc = this.matched(filter)[0];
    return new FakeQuery(doc ? [doc] : [], { single: true, update, filter, collection: this });
  }

  updateOne(filter, update) {
    const doc = this.matched(filter)[0];
    if (!doc) return Promise.resolve({ modifiedCount: 0 });
    applyUpdate(this, doc, update, filter);
    return Promise.resolve({ modifiedCount: 1 });
  }
}

// ── fixture factory ────────────────────────────────────────────

const makeFixture = ({ caseDoc, settingsDoc = {}, extraChecks = [], users = [] } = {}) => {
  const auditRows = [];
  const events = [];
  const stores = [];
  const caseCollection = new FakeCollection('caseModel', caseDoc ? [{ _id: CASE_A, ...caseDoc }] : []);
  const checkCollection = new FakeCollection('checkModel', extraChecks);
  const deps = {
    caseModel: caseCollection,
    checkModel: checkCollection,
    settingsModel: new FakeCollection('settingsModel', settingsDoc ? [{ companyId: COMP_A, ...settingsDoc }] : []),
    userModel: new FakeCollection('userModel', [
      { _id: USER_V, companyId: COMP_A, status: 'ACTIVE', name: 'Vera Verify', employeeCode: 'EMP-9' },
      ...users,
    ]),
    audit: async (payload) => { auditRows.push(payload); },
    emitEvent: async (event) => { events.push(event); },
    store: async ({ buffer, companyId }) => {
      stores.push({ size: buffer.length, companyId });
      return { storageProvider: 'LOCAL_PRIVATE', storageKey: 'stored-key-1', fileUrl: `bgv-evidence/${companyId}/stored-key-1` };
    },
    read: async () => Buffer.from('file-bytes'),
    cacheThrough: async ({ loader }) => loader(),
  };
  return { deps, auditRows, events, stores, checkCollection, caseCollection };
};

const seedCaseDoc = (overrides = {}) => ({
  companyId: COMP_A,
  status: 'IN_PROGRESS',
  candidate: CAND_A,
  candidateSnapshot: { name: 'K. Mahalingam', candidateCode: 'CAN-000123' },
  jobSnapshot: { title: 'Backend Engineer' },
  addressHistory: [{ kind: 'PERMANENT', line: '12 Anna Nagar', city: 'Coimbatore', district: 'Coimbatore', state: 'Tamil Nadu', pinCode: '641002', fromDate: null, toDate: null }],
  pastEmployers: [
    { orgName: 'Infosys', designation: 'SE', employeeId: 'E-44128', fromDate: new Date('2019-06-01'), toDate: new Date('2022-01-31'), salaryVisibleOk: true },
    { orgName: 'TCS', designation: 'Analyst', employeeId: 'T-991', fromDate: new Date('2022-02-01'), toDate: null, salaryVisibleOk: false },
  ],
  education: [{ institution: 'Anna University', degree: 'B.Tech', yearOfPassing: 2019 }],
  ...overrides,
});

// ── seeding ─────────────────────────────────────────────────────

test('seedChecksForCase creates one row per required type, idempotently, with entries from claims', async () => {
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), settingsDoc: { checkConfig: { ADDRESS: { required: false } } } });
  const first = await seedChecksForCase({ companyId: COMP_A, caseId: CASE_A, actorId: USER_V }, fixture.deps);
  assert.deepEqual(first.created, 4); // IDENTITY, EDUCATION, EMPLOYMENT, COURT_RECORD (ADDRESS off)

  const second = await seedChecksForCase({ companyId: COMP_A, caseId: CASE_A, actorId: USER_V }, fixture.deps);
  assert.equal(second.created, 0, 're-run must duplicate nothing');

  const checks = fixture.checkCollection.docs;
  const employment = checks.find((c) => c.checkType === 'EMPLOYMENT');
  const education = checks.find((c) => c.checkType === 'EDUCATION');
  const identity = checks.find((c) => c.checkType === 'IDENTITY');
  assert.equal(employment.entries.length, 2, 'one entry per past employer');
  assert.equal(employment.entries[0].claim.orgName, 'Infosys');
  assert.equal(education.entries.length, 1);
  assert.equal(identity.entries.length, 1, 'single-entity checks still carry one entry');
  assert.equal(checks.every((c) => c.status === 'PENDING' && c.isRequired === true), true);
  assert.equal(checks.every((c) => c.sla.dueAt instanceof Date), true, 'SLA due dates computed');
  assert.equal(fixture.auditRows.filter((row) => row.action === 'BGV_CHECK_SEEDED').length, 4);
});

test('seedChecksForCase marks previously created no-longer-required checks SKIPPED (never deletes)', async () => {
  const existing = [{
    _id: 'chkAddr', companyId: COMP_A, bgvCaseId: CASE_A, candidateId: CAND_A,
    checkType: 'ADDRESS', status: 'IN_PROGRESS', isRequired: true,
    entries: [], sla: {}, followUp: {},
  }];
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), settingsDoc: { checkConfig: { ADDRESS: { required: false } } }, extraChecks: existing });
  const result = await seedChecksForCase({ companyId: COMP_A, caseId: CASE_A, actorId: USER_V }, fixture.deps);
  assert.equal(result.skippedTypes, 1);
  assert.equal(fixture.checkCollection.docs.find((c) => c._id === 'chkAddr').status, 'SKIPPED');
});

test('seedChecksForCase refuses closed cases and unknown tenants', async () => {
  const closed = makeFixture({ caseDoc: seedCaseDoc({ status: 'COMPLETED' }) });
  assert.deepEqual(await seedChecksForCase({ companyId: COMP_A, caseId: CASE_A, actorId: USER_V }, closed.deps), { created: 0, skippedTypes: 0, reason: 'CASE_CLOSED' });

  const foreign = makeFixture({ caseDoc: seedCaseDoc() });
  await assert.rejects(
    () => seedChecksForCase({ companyId: COMP_B, caseId: CASE_A, actorId: USER_V }, foreign.deps),
    /not found/i
  );
});

// ── reads + scoping ─────────────────────────────────────────────

const openCheck = (overrides = {}) => ({
  _id: 'chk1', companyId: COMP_A, bgvCaseId: CASE_A, candidateId: CAND_A,
  checkType: 'EMPLOYMENT', status: 'PENDING', isRequired: true,
  assignedVerifierId: USER_V, assignedAt: null, assignedBy: null,
  entries: [
    { entryKey: 'e1', label: 'Infosys', claim: {}, status: 'PENDING', resultSummary: '', discrepancyNote: '', evidence: [] },
    { entryKey: 'e2', label: 'TCS', claim: {}, status: 'PENDING', resultSummary: '', discrepancyNote: '', evidence: [] },
  ],
  sla: { initiatedAt: new Date(), dueAt: new Date(Date.now() + 10 * 86400000), extendedOnce: false, extensionReason: '', extensionDays: 0 },
  followUp: { emailAttempts: 0, callAttempts: 0, lastFollowUpAt: null, nextFollowUpAt: null, closedReason: '' },
  resultSummary: '', discrepancyNote: '', closedAt: null, closedBy: null,
  ...overrides,
});

test('cross-tenant and non-assignee reads return NOT_FOUND (existence never leaks)', async () => {
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck()] });
  await assert.rejects(() => getCheck({ companyId: COMP_B, checkId: 'chk1', actor: { userId: USER_V, canReadAll: true } }, fixture.deps), /not found/i);
  await assert.rejects(() => getCheck({ companyId: COMP_A, checkId: 'chk1', actor: { userId: USER_X, canReadAll: false } }, fixture.deps), /not found/i);
  const mine = await getCheck({ companyId: COMP_A, checkId: 'chk1', actor: { userId: USER_V, canReadAll: false } }, fixture.deps);
  assert.equal(mine.id, 'chk1');
  assert.equal(fixture.auditRows.some((row) => row.action === 'BGV_CHECK_VIEWED'), true, 'audit-on-read');
});

test('list scoping: non-privileged sees own queue; READ_ALL sees everything; case info joined', async () => {
  const other = openCheck({ _id: 'chk2', assignedVerifierId: USER_X, checkType: 'IDENTITY' });
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck(), other] });
  const own = await listChecks({ companyId: COMP_A, actor: { userId: USER_V, canReadAll: false }, filters: {} }, fixture.deps);
  assert.equal(own.checks.length, 1);
  const privileged = await listChecks({ companyId: COMP_A, actor: { userId: USER_X, canReadAll: true }, filters: {} }, fixture.deps);
  assert.equal(privileged.checks.length, 2);
  // Looked up by id — the dueAt sort could legitimately order either
  // fixture first when they straddle a millisecond boundary.
  const chk1Dto = privileged.checks.find((check) => check.id === 'chk1');
  assert.equal(chk1Dto.caseInfo.candidateName, 'K. Mahalingam');
  assert.equal(chk1Dto.assignedVerifierName, 'Vera Verify');
});

test('workbenchStats counts open / due-soon / overdue / awaiting and respects scope', async () => {
  const dueSoon = openCheck({
    _id: 'chkA',
    sla: { initiatedAt: new Date(), dueAt: new Date(Date.now() + 24 * 3600 * 1000), extendedOnce: false },
  });
  const overdue = openCheck({ _id: 'chkB', assignedVerifierId: USER_X, status: 'IN_PROGRESS', sla: { initiatedAt: new Date(Date.now() - 20 * 86400000), dueAt: new Date(Date.now() - 86400000), extendedOnce: false }, followUp: { emailAttempts: 2, callAttempts: 1, lastFollowUpAt: new Date(), nextFollowUpAt: null, closedReason: '' } });
  const verified = openCheck({ _id: 'chkC', status: 'VERIFIED', assignedVerifierId: USER_X });
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [dueSoon, overdue, verified] });
  const all = await workbenchStats({ companyId: COMP_A, actor: { userId: USER_V, canReadAll: true } }, fixture.deps);
  assert.deepEqual(all, { open: 2, dueSoonIn48h: 1, overdue: 1, awaitingResponse: 1 });
  const own = await workbenchStats({ companyId: COMP_A, actor: { userId: USER_V, canReadAll: false } }, fixture.deps);
  assert.equal(own.open, 1);
});

// ── mutations ───────────────────────────────────────────────────

test('updateStatus enforces the machine, guards required text, and audits safely', async () => {
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck()] });
  const actor = { userId: USER_V, canReadAll: false };

  await assert.rejects(
    () => updateStatus({ companyId: COMP_A, checkId: 'chk1', toStatus: 'VERIFIED', payload: { resultSummary: 'done' }, actor }, fixture.deps),
    /Cannot move PENDING to VERIFIED/
  );

  const started = await updateStatus({ companyId: COMP_A, checkId: 'chk1', toStatus: 'IN_PROGRESS', payload: {}, actor }, fixture.deps);
  assert.equal(started.status, 'IN_PROGRESS');

  await assert.rejects(
    () => updateStatus({ companyId: COMP_A, checkId: 'chk1', toStatus: 'VERIFIED', payload: {}, actor }, fixture.deps),
    /result summary is required/i
  );

  // Raw document numbers are refused in verifier text (30.2 owns them).
  await assert.rejects(
    () => updateStatus({ companyId: COMP_A, checkId: 'chk1', toStatus: 'VERIFIED', payload: { resultSummary: 'aadhaar 123456789012 matched' }, actor }, fixture.deps),
    /mask them/i
  );

  const done = await updateStatus({ companyId: COMP_A, checkId: 'chk1', toStatus: 'VERIFIED', payload: { resultSummary: 'HR confirmed both employments via domain email' }, actor }, fixture.deps);
  assert.equal(done.status, 'VERIFIED');
  assert.ok(done.closedAt);
  const statusAudit = fixture.auditRows.find((row) => row.action === 'BGV_CHECK_STATUS_CHANGED');
  assert.equal(JSON.stringify(statusAudit.metadata).includes('HR confirmed'), false, 'audit metadata must not carry summary bodies');
  assert.equal(fixture.events.some((event) => event.type === 'BGV_CHECK_STATUS_CHANGED'), true, 'domain event emitted for 30.3 subscribers');
});

test('entry-level status updates roll the check status up (never a rejection)', async () => {
  const startedEntries = [
    { entryKey: 'e1', label: 'Infosys', claim: {}, status: 'IN_PROGRESS', resultSummary: '', discrepancyNote: '', evidence: [] },
    { entryKey: 'e2', label: 'TCS', claim: {}, status: 'PENDING', resultSummary: '', discrepancyNote: '', evidence: [] },
  ];
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck({ status: 'IN_PROGRESS', entries: startedEntries })] });
  const actor = { userId: USER_V, canReadAll: false };

  const first = await updateStatus({ companyId: COMP_A, checkId: 'chk1', entryKey: 'e1', toStatus: 'VERIFIED', payload: { resultSummary: 'Infosys confirmed' }, actor }, fixture.deps);
  assert.equal(first.status, 'IN_PROGRESS', 'one entry settled does not finish the check');
  assert.equal(first.entries.find((entry) => entry.entryKey === 'e1').status, 'VERIFIED');

  await updateStatus({ companyId: COMP_A, checkId: 'chk1', entryKey: 'e2', toStatus: 'IN_PROGRESS', payload: {}, actor }, fixture.deps);
  const bad = await updateStatus({ companyId: COMP_A, checkId: 'chk1', entryKey: 'e2', toStatus: 'DISCREPANCY', payload: {}, actor }, fixture.deps).catch((error) => error);
  assert.match(bad.message, /discrepancy note is required/i);

  const second = await updateStatus({ companyId: COMP_A, checkId: 'chk1', entryKey: 'e2', toStatus: 'UTV', payload: { followUp: { closedReason: 'NO_RESPONSE_AFTER_TIMELINE' } }, actor }, fixture.deps);
  assert.equal(second.status, 'UTV', 'entry UTV (no discrepancy) drives check UTV');
  assert.equal(second.followUp.closedReason, 'NO_RESPONSE_AFTER_TIMELINE');
});

test('addEvidence validates per kind, stores privately, masks audit; list masks phone, READ_ALL sees full', async () => {
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck()] });
  const actor = { userId: USER_V, canReadAll: false };

  await assert.rejects(
    () => addEvidence({ companyId: COMP_A, checkId: 'chk1', kind: 'SCREENSHOT', file: null, actor }, fixture.deps),
    /require a file/i
  );
  await assert.rejects(
    () => addEvidence({ companyId: COMP_A, checkId: 'chk1', kind: 'CALL_LOG', note: 'called +91 98765 43210 about aadhaar 123456789012', meta: {}, actor }, fixture.deps),
    /mask them/i
  );

  const added = await addEvidence({
    companyId: COMP_A,
    checkId: 'chk1',
    entryKey: 'e1',
    kind: 'CALL_LOG',
    note: 'Spoke to HR desk, employment confirmed 2019-2022',
    meta: { phone: '9876543210', durationSec: 180, outcome: 'Confirmed' },
    actor,
  }, fixture.deps);
  assert.equal(added.added, true);
  assert.equal(fixture.stores.length, 0, 'no file, no storage call');

  const auditRow = [...fixture.auditRows].reverse().find((row) => row.action === 'BGV_CHECK_EVIDENCE_ADDED');
  assert.equal(JSON.stringify(auditRow.metadata).includes('9876543210'), false, 'audit carries masked phone only');
  assert.equal(auditRow.metadata.meta.phone, 'XXXX-XXXX-3210');
  assert.equal(auditRow.metadata.note, undefined, 'audit carries no note body');

  const withFile = await addEvidence({
    companyId: COMP_A,
    checkId: 'chk1',
    entryKey: 'e1',
    kind: 'SCREENSHOT',
    meta: {},
    file: { buffer: Buffer.from('png-bytes'), mimetype: 'image/png', originalname: '../../etc/passwd.png', size: 9 },
    actor,
  }, fixture.deps);
  assert.equal(withFile.added, true);
  assert.equal(fixture.stores.length, 1, 'private storage used');

  const maskedList = await listChecks({ companyId: COMP_A, actor: { userId: USER_V, canReadAll: false }, filters: {} }, fixture.deps);
  const callLog = maskedList.checks[0].entries[0].evidence.find((item) => item.kind === 'CALL_LOG');
  assert.equal(callLog.meta.phone, 'XXXX-XXXX-3210', 'list masks phone');
  const detailFull = await getCheck({ companyId: COMP_A, checkId: 'chk1', actor: { userId: USER_X, canReadAll: true } }, fixture.deps);
  const fullLog = detailFull.entries[0].evidence.find((item) => item.kind === 'CALL_LOG');
  assert.equal(fullLog.meta.phone, '9876543210', 'READ_ALL detail sees full phone');
  assert.equal(detailFull.entries[0].evidence.find((item) => item.kind === 'SCREENSHOT').filename, 'passwd.png', 'stored filename is basename-only');

  const downloaded = await getEvidenceFile({ companyId: COMP_A, checkId: 'chk1', evidenceId: detailFull.entries[0].evidence[1].id, actor: { userId: USER_X, canReadAll: true } }, fixture.deps);
  assert.equal(downloaded.buffer.toString(), 'file-bytes');
});

test('single-entity checks accept evidence without an entryKey; multi-entry checks demand one', async () => {
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck({ checkType: 'IDENTITY', entries: [{ entryKey: 'solo', label: 'Identity', claim: {}, status: 'IN_PROGRESS', resultSummary: '', discrepancyNote: '', evidence: [] }] })] });
  const actor = { userId: USER_V, canReadAll: false };
  const ok = await addEvidence({ companyId: COMP_A, checkId: 'chk1', kind: 'NOTE', note: 'Docs match selfie', meta: {}, actor }, fixture.deps);
  assert.equal(ok.entryKey, 'solo');
  const multi = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck()] });
  await assert.rejects(
    () => addEvidence({ companyId: COMP_A, checkId: 'chk1', kind: 'NOTE', note: 'x', meta: {}, actor }, multi.deps),
    /choose the entry/i
  );
});

test('assignVerifier: same-tenant guard, follow-up default, reassignment history', async () => {
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck({ assignedVerifierId: null })] });
  await assert.rejects(
    () => assignVerifier({ companyId: COMP_A, checkId: 'chk1', verifierId: '0000000000000000000000be', actorId: USER_X }, fixture.deps),
    /verifier not found/i
  );
  const assigned = await assignVerifier({ companyId: COMP_A, checkId: 'chk1', verifierId: USER_V, actorId: USER_X }, fixture.deps);
  assert.equal(assigned.assignedVerifierId, USER_V);
  assert.ok(assigned.followUp.nextFollowUpAt, 'next follow-up seeded once');
  const auditRow = [...fixture.auditRows].reverse().find((row) => row.action === 'BGV_CHECK_ASSIGNED');
  assert.equal(auditRow.previousValue.assignedVerifierId, '', 'previous assignee preserved in audit');
});

test('extendSla is a one-time, justified change; reopen is terminal-only with BGV_CHECK_REOPEN', async () => {
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck()] });
  const actor = { userId: USER_V, canReadAll: true };

  await assert.rejects(() => extendSla({ companyId: COMP_A, checkId: 'chk1', days: 3, reason: '', actor }, fixture.deps), /reason is required/i);
  const extended = await extendSla({ companyId: COMP_A, checkId: 'chk1', days: 3, reason: 'Awaiting college registrar reply', actor }, fixture.deps);
  assert.equal(extended.sla.extendedOnce, true);
  assert.equal(extended.sla.extensionDays, 3);
  await assert.rejects(() => extendSla({ companyId: COMP_A, checkId: 'chk1', days: 2, reason: 'again', actor }, fixture.deps), /only be extended once/i);

  await assert.rejects(() => reopenCheck({ companyId: COMP_A, checkId: 'chk1', reason: 'nope', actor }, fixture.deps), /only terminal/i);

  // Drive to terminal through the machine, then reopen.
  await updateStatus({ companyId: COMP_A, checkId: 'chk1', toStatus: 'IN_PROGRESS', payload: {}, actor }, fixture.deps);
  await updateStatus({ companyId: COMP_A, checkId: 'chk1', toStatus: 'VERIFIED', payload: { resultSummary: 'complete' }, actor }, fixture.deps);
  const reopened = await reopenCheck({ companyId: COMP_A, checkId: 'chk1', reason: 'New relieving letter received', actor }, fixture.deps);
  assert.equal(reopened.status, 'IN_PROGRESS');
  assert.equal(reopened.closedAt, null, 'closed markers cleared, history stays');
  const reopenAudit = [...fixture.auditRows].reverse().find((row) => row.action === 'BGV_CHECK_REOPENED');
  assert.equal(reopenAudit.critical, true);
});

test('verifiers cannot act on checks they do not own (READ_ALL holders can)', async () => {
  const fixture = makeFixture({ caseDoc: seedCaseDoc(), extraChecks: [openCheck()] });
  await assert.rejects(
    () => updateStatus({ companyId: COMP_A, checkId: 'chk1', toStatus: 'IN_PROGRESS', payload: {}, actor: { userId: USER_X, canReadAll: false } }, fixture.deps),
    /not found/i
  );
  const asPrivileged = await updateStatus({ companyId: COMP_A, checkId: 'chk1', toStatus: 'IN_PROGRESS', payload: {}, actor: { userId: USER_X, canReadAll: true } }, fixture.deps);
  assert.equal(asPrivileged.status, 'IN_PROGRESS');
});

// ── wiring guards (static, like the 27.15 suite style) ─────────

test('routes are tenant-guarded, permission-gated and mounted at /api/bgv', async () => {
  const { readFile } = await import('node:fs/promises');
  const [routes, mounted, registry] = await Promise.all([
    readFile(new URL('../../src/routes/bgvCheckRoutes.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/routes/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/utils/permissionRegistry.js', import.meta.url), 'utf8'),
  ]);
  assert.match(routes, /protect/);
  assert.match(routes, /tenantContext/);
  assert.match(routes, /requirePermission\('BGV_CHECK_READ'\)/);
  assert.match(routes, /requirePermission\('BGV_CHECK_REOPEN'\)/);
  assert.match(mounted, /router\.use\("\/bgv", bgvCheckRoutes\)/);
  assert.match(registry, /"BGV_CHECK", \["READ", "READ_ALL", "ASSIGN", "VERIFY", "REOPEN"\]/);
  assert.match(registry, /"BGV_EVIDENCE", \["MANAGE"\]/);
});

test('controllers follow the Data-from-frontend / DB-Logic / Data-to-frontend comment convention', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../src/controllers/bgvCheckController.js', import.meta.url), 'utf8');
  const handlerCount = (source.match(/= asyncHandler\(/g) || []).length;
  assert.equal(handlerCount, 11, 'one asyncHandler per endpoint');
  assert.equal((source.match(/Data from frontend - requests from frontend/g) || []).length, handlerCount);
  assert.equal((source.match(/DB Logic - DB logics/g) || []).length, handlerCount);
  assert.equal((source.match(/Data to frontend - response to frontend/g) || []).length, handlerCount);
});
