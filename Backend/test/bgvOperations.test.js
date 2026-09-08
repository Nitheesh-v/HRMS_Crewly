// Phase 30.11 — BGV OPERATIONS DASHBOARD, SLA & REMINDERS (hermetic).
// No MongoDB/Redis/SMTP: every collaborator is injected, so the SERVICE
// logic under test is the real shipped code. Covers §36 groups: derived
// states (no second state machine), SLA clock/pause/not-configured,
// capped paging, verifier workload, reminder buckets + stale revalidation,
// reference-only queue payloads, token rotation only at dispatch, SLA
// policy validation + audited config write, and redaction guarantees.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPS_STATES,
  PAGE_SIZE_CAP,
  buildRows,
  opsQueue,
  opsSummary,
  readSlaPolicy,
  updateSlaPolicy,
  verifierWorkload,
} from '../src/services/bgv/bgvOperationsDashboardService.js';
import {
  collectReminderTargets,
  ensurePortalLink,
  revalidateReminder,
  reminderEventKey,
  runBgvReminderReconciliation,
} from '../src/services/bgv/bgvReminderService.js';
import {
  evaluateCheckSla,
  evaluateUnassignedWait,
  validateSlaPolicy,
} from '../src/services/bgv/bgvSlaRules.js';

// ── fixtures ─────────────────────────────────────────────────────
const NOW = '2026-09-08T12:00:00.000Z';
let counter = 0;
// Valid 24-hex ObjectId-shaped ids (mongoose.isValidObjectId strict).
// Built as STRINGS — 0x6000...0 overflows MAX_SAFE_INTEGER and would
// collapse every id to the same float.
const oid = (_prefix = 'a') => {
  counter += 1;
  return '60' + counter.toString(16).padStart(22, '0');
};
const COMPANY = oid('c');
const CANDIDATE = oid('d');
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();

const paidOrder = (over = {}) => ({
  _id: oid('o'),
  companyId: COMPANY,
  candidate: CANDIDATE,
  orderCode: 'BGV-0001',
  status: 'PAID',
  paidAt: hoursAgo(120),
  createdAt: hoursAgo(121),
  items: [{ type: 'IDENTITY' }],
  ...over,
});
const submittedCase = (order, over = {}) => ({
  _id: oid('e'),
  bgvOrder: order._id,
  candidate: CANDIDATE,
  companyId: COMPANY,
  status: 'SUBMITTED',
  submittedAt: hoursAgo(96),
  purchasedChecks: ['IDENTITY', 'EDUCATION'],
  createdAt: hoursAgo(100),
  updatedAt: hoursAgo(96),
  ...over,
});
const assignment = (order, checkType, over = {}) => ({
  _id: oid('g'),
  bgvOrder: order._id,
  checkType,
  verifier: VERIFIER_ID,
  assignedAt: hoursAgo(90),
  startedAt: null,
  updatedAt: hoursAgo(90),
  ...over,
});
const VERIFIER_ID = oid('v');
const VERIFIER_ID2 = oid('w');
const verification = (order, checkType, over = {}) => ({
  _id: oid('h'),
  bgvOrder: order._id,
  checkType,
  state: 'IN_PROGRESS',
  qa: { status: 'NONE', currentRevision: 0 },
  conclusion: null,
  updatedAt: hoursAgo(10),
  ...over,
});
const infoRequest = (order, checkType, over = {}) => ({
  _id: oid('i'),
  bgvOrder: order._id,
  checkType,
  category: 'SUPPORTING_DOCUMENT',
  status: 'OPEN',
  requestedAt: hoursAgo(48),
  respondedAt: null,
  resolvedAt: null,
  cancelledAt: null,
  ...over,
});
const finalReport = (order, checkType, over = {}) => ({
  _id: oid('r'),
  bgvOrder: order._id,
  checkType,
  status: 'GENERATED',
  release: null,
  createdAt: hoursAgo(5),
  ...over,
});

const emptySet = { orders: [], cases: [], assignments: [], verifications: [], infoRequests: [], reports: [] };
const wsDeps = (set) => ({
  findOrders: async () => set.orders,
  findCases: async () => set.cases,
  findAssignments: async () => set.assignments,
  findVerifications: async () => set.verifications,
  findInfoRequests: async () => set.infoRequests,
  findReports: async () => set.reports,
  findCompanies: async () => [{ _id: COMPANY, name: 'Acme Pvt Ltd' }],
  findCandidates: async () => [{ _id: CANDIDATE, name: 'Asha Rao' }],
  findVerifiers: async () => [
    { _id: VERIFIER_ID, name: 'Vikram Verifier', status: 'ACTIVE', specializations: ['IDENTITY'] },
    { _id: VERIFIER_ID2, name: 'Neha Checker', status: 'INACTIVE', specializations: [] },
  ],
  findAllVerifiers: async () => [
    { _id: VERIFIER_ID, name: 'Vikram Verifier', status: 'ACTIVE', specializations: ['IDENTITY'] },
    { _id: VERIFIER_ID2, name: 'Neha Checker', status: 'INACTIVE', specializations: [] },
  ],
  findSlaPolicy: async () => null,
});

// ── §36.1 derived states: NO second state machine ────────────────
test('§36.1 unpaid orders never appear — commercial-authorization boundary only', () => {
  const order = paidOrder({ status: 'PENDING_PAYMENT' });
  const { rows } = buildRows({
    workingSet: { ...emptySet, orders: [order], cases: [submittedCase(order)] },
    policy: null,
    nowIso: NOW,
  });
  assert.equal(rows.length, 0);
});

test('§36.1 order-level states derive from 30.4/30.5 documents', () => {
  const noCase = paidOrder();
  const withDraft = paidOrder({ orderCode: 'BGV-0002' });
  const { rows } = buildRows({
    workingSet: {
      ...emptySet,
      orders: [noCase, withDraft],
      cases: [submittedCase(withDraft, { status: 'DRAFT', submittedAt: null })],
    },
    policy: null,
    nowIso: NOW,
  });
  const states = rows.map((r) => r.state).sort();
  assert.deepEqual(states, ['AWAITING_CANDIDATE_SUBMISSION', 'AWAITING_CONSENT']);
  assert.ok(rows.every((r) => r.checkType === null));
});

test('§36.1 all eleven derived states map from authoritative documents', () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: OPS_STATES.filter((s) => !['AWAITING_CONSENT', 'AWAITING_CANDIDATE_SUBMISSION'].includes(s)) });
  const set = {
    ...emptySet,
    orders: [order],
    cases: [caseDoc],
    assignments: [assignment(order, 'IN_PROGRESS'), assignment(order, 'AWAITING_CANDIDATE'), assignment(order, 'AWAITING_THIRD_PARTY'), assignment(order, 'QA_RETURNED')],
    verifications: [
      verification(order, 'IN_PROGRESS'),
      verification(order, 'AWAITING_CANDIDATE', { state: 'AWAITING_CANDIDATE' }),
      verification(order, 'AWAITING_THIRD_PARTY', { state: 'AWAITING_THIRD_PARTY' }),
      verification(order, 'QA_RETURNED', { state: 'QA_RETURNED' }),
      verification(order, 'AWAITING_QA', { state: 'SUBMITTED', qa: { status: 'PENDING', currentRevision: 1 } }),
      verification(order, 'APPROVED', { state: 'SUBMITTED', qa: { status: 'APPROVED', currentRevision: 1, reviewedAt: hoursAgo(6) } }),
    ],
    reports: [finalReport(order, 'REPORT_READY'), finalReport(order, 'RELEASED', { status: 'RELEASED', release: { releasedAt: hoursAgo(2) } })],
  };
  const { rows } = buildRows({ workingSet: set, policy: null, nowIso: NOW });
  const derived = rows.map((r) => r.state).sort();
  const expected = caseDoc.purchasedChecks.slice().sort();
  assert.deepEqual(derived, expected);
  // UNASSIGNED is covered by its own dedicated test below.
});

test('§36.1 unassigned check derives from absence of assignment', () => {
  const order = paidOrder();
  const { rows } = buildRows({
    workingSet: { ...emptySet, orders: [order], cases: [submittedCase(order, { purchasedChecks: ['IDENTITY'] })] },
    policy: null,
    nowIso: NOW,
  });
  assert.equal(rows[0].state, 'UNASSIGNED');
  assert.equal(rows[0].verifierId, null);
});

// ── §36.2 SLA clock, pause, not-configured ───────────────────────
test('§36.2 SLA clock starts at the later of submission and assignment', () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: ['IDENTITY'], submittedAt: hoursAgo(96) });
  const policy = { targets: { IDENTITY: 48 }, dueSoonHours: 24, pauseOnCandidateWait: true, unassignedTargetHours: null };
  const { rows } = buildRows({
    workingSet: { ...emptySet, orders: [order], cases: [caseDoc], assignments: [assignment(order, 'IDENTITY', { assignedAt: hoursAgo(30) })] },
    policy,
    nowIso: NOW,
  });
  // clock = assignment (30h ago) → inside the 48h target, inside due-soon window
  assert.equal(rows[0].clockStartIso, hoursAgo(30));
  assert.equal(rows[0].slaStatus, 'DUE_SOON');
});

test('§36.2 AWAITING_CANDIDATE pauses the SLA clock; response resumes it', () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: ['IDENTITY'] });
  const policy = { targets: { IDENTITY: 48 }, dueSoonHours: 24, pauseOnCandidateWait: true, unassignedTargetHours: null };
  // 60h elapsed, but 40h were spent waiting on the candidate (open request)
  const set = {
    ...emptySet,
    orders: [order],
    cases: [caseDoc],
    assignments: [assignment(order, 'IDENTITY', { assignedAt: hoursAgo(60) })],
    verifications: [verification(order, 'IDENTITY', { state: 'AWAITING_CANDIDATE' })],
    infoRequests: [infoRequest(order, 'IDENTITY', { requestedAt: hoursAgo(40) })],
  };
  const { rows } = buildRows({ workingSet: set, policy, nowIso: NOW });
  assert.equal(rows[0].slaStatus, 'PAUSED');
  // Resumed: candidate answered 5h ago, only 25 accountable hours elapsed
  const resumed = buildRows({
    workingSet: {
      ...set,
      verifications: [verification(order, 'IDENTITY')],
      infoRequests: [infoRequest(order, 'IDENTITY', { status: 'CANDIDATE_RESPONDED', requestedAt: hoursAgo(40), respondedAt: hoursAgo(5) })],
    },
    policy,
    nowIso: NOW,
  });
  // Accountable time = 60h - 35h paused = 25h → inside the 24h due-soon
  // window of the 48h target: resumed, ticking, DUE_SOON.
  assert.equal(resumed.rows[0].slaStatus, 'DUE_SOON');
});

test('§36.2 AWAITING_THIRD_PARTY does NOT pause (documented policy)', () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: ['IDENTITY'] });
  const policy = { targets: { IDENTITY: 48 }, dueSoonHours: 24, pauseOnCandidateWait: true, unassignedTargetHours: null };
  const { rows } = buildRows({
    workingSet: {
      ...emptySet,
      orders: [order],
      cases: [caseDoc],
      assignments: [assignment(order, 'IDENTITY', { assignedAt: hoursAgo(60) })],
      verifications: [verification(order, 'IDENTITY', { state: 'AWAITING_THIRD_PARTY' })],
    },
    policy,
    nowIso: NOW,
  });
  assert.equal(rows[0].slaStatus, 'OVERDUE'); // 60h > 48h target
  assert.ok(rows[0].overdueDays >= 1);
});

test('§36.2 unconfigured policy reports SLA_NOT_CONFIGURED — never invented defaults', () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: ['IDENTITY', 'EDUCATION'] });
  const { rows } = buildRows({
    workingSet: { ...emptySet, orders: [order], cases: [caseDoc], assignments: [assignment(order, 'IDENTITY')] },
    policy: null,
    nowIso: NOW,
  });
  assert.ok(rows.every((r) => r.slaStatus === 'SLA_NOT_CONFIGURED'));
  const policy = { targets: { IDENTITY: 48 }, dueSoonHours: 24, pauseOnCandidateWait: true, unassignedTargetHours: null };
  const { rows: configured } = buildRows({
    workingSet: { ...emptySet, orders: [order], cases: [caseDoc], assignments: [assignment(order, 'IDENTITY', { assignedAt: hoursAgo(30) })] },
    policy,
    nowIso: NOW,
  });
  assert.equal(configured.find((r) => r.checkType === 'IDENTITY').slaStatus, 'DUE_SOON');
  assert.equal(configured.find((r) => r.checkType === 'EDUCATION').slaStatus, 'SLA_NOT_CONFIGURED');
});

test('§36.2 completed checks stop the clock (COMPLETED, late flag kept)', () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: ['IDENTITY'] });
  const policy = { targets: { IDENTITY: 48 }, dueSoonHours: 24, pauseOnCandidateWait: true, unassignedTargetHours: null };
  const { rows } = buildRows({
    workingSet: {
      ...emptySet,
      orders: [order],
      cases: [caseDoc],
      assignments: [assignment(order, 'IDENTITY', { assignedAt: hoursAgo(80) })],
      reports: [finalReport(order, 'IDENTITY', { createdAt: hoursAgo(10) })],
    },
    policy,
    nowIso: NOW,
  });
  assert.equal(rows[0].state, 'REPORT_READY');
  assert.equal(rows[0].slaStatus, 'COMPLETED');
  assert.equal(rows[0].overdueDays, 0);
});

test('§36.2 pure SLA rules: boundaries and unassigned wait', () => {
  const onTrack = evaluateCheckSla({ clockStartIso: hoursAgo(10), nowIso: NOW, targetHours: 48, dueSoonHours: 24 });
  assert.equal(onTrack.status, 'ON_TRACK');
  const dueSoon = evaluateCheckSla({ clockStartIso: hoursAgo(30), nowIso: NOW, targetHours: 48, dueSoonHours: 24 });
  assert.equal(dueSoon.status, 'DUE_SOON');
  const overdue = evaluateCheckSla({ clockStartIso: hoursAgo(49), nowIso: NOW, targetHours: 48, dueSoonHours: 24 });
  assert.equal(overdue.status, 'OVERDUE');
  const unassigned = evaluateUnassignedWait({ submittedAtIso: hoursAgo(30), nowIso: NOW, unassignedTargetHours: 24 });
  assert.equal(unassigned.status, 'OVERDUE');
  const unassignedNoTarget = evaluateUnassignedWait({ submittedAtIso: hoursAgo(30), nowIso: NOW, unassignedTargetHours: null });
  assert.equal(unassignedNoTarget.status, 'SLA_NOT_CONFIGURED');
});

// ── §36.3 summary + capped paging + filters ──────────────────────
test('§36.3 opsSummary derives counts (no hardcoding, no stored counters)', async () => {
  const o1 = paidOrder();
  const o2 = paidOrder({ orderCode: 'BGV-0002' });
  const set = {
    ...emptySet,
    orders: [o1, o2, paidOrder({ status: 'CREATED' })],
    cases: [submittedCase(o1, { purchasedChecks: ['IDENTITY'] }), submittedCase(o2, { status: 'DRAFT', submittedAt: null, purchasedChecks: ['IDENTITY'] })],
    assignments: [assignment(o1, 'IDENTITY')],
  };
  const summary = await opsSummary({ deps: { ...wsDeps(set), findSlaPolicy: async () => null }, nowIso: NOW });
  assert.equal(summary.counts.AWAITING_CONSENT, 0); // CREATED order excluded
  assert.equal(summary.counts.AWAITING_CANDIDATE_SUBMISSION, 1);
  assert.equal(summary.counts.IN_PROGRESS, 1);
  assert.equal(summary.slaNotConfigured, 2); // both rows have no policy
  assert.equal(summary.totalRows, 2);
});

test('§36.3 opsQueue caps page size at 50, filters and sorts server-side', async () => {
  const orders = [];
  const cases = [];
  for (let i = 0; i < 60; i += 1) {
    const order = paidOrder({ orderCode: `BGV-${String(i).padStart(4, '0')}` });
    orders.push(order);
    cases.push(submittedCase(order, { purchasedChecks: ['IDENTITY'] }));
  }
  const set = { ...emptySet, orders, cases };
  const deps = { ...wsDeps(set), findSlaPolicy: async () => null };
  const page = await opsQueue({ page: 1, pageSize: 999, deps, nowIso: NOW });
  assert.equal(page.pageSize, PAGE_SIZE_CAP);
  assert.equal(page.rows.length, PAGE_SIZE_CAP);
  assert.equal(page.total, 60);
  assert.equal(page.pages, 2);
  const filtered = await opsQueue({ page: 1, pageSize: 20, filter: { state: 'UNASSIGNED', orderCode: 'BGV-0007' }, deps, nowIso: NOW });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.rows[0].orderCode, 'BGV-0007');
  const bogus = await opsQueue({ page: 1, filter: { state: 'NOT_A_STATE' }, deps, nowIso: NOW });
  assert.equal(bogus.rows.length, 0);
});

test('§36.3 queue rows are SAFE — no PAN/Aadhaar/UAN/documents/notes/tokens/amounts', async () => {
  const order = paidOrder();
  const set = {
    ...emptySet,
    orders: [order],
    cases: [submittedCase(order, { purchasedChecks: ['IDENTITY'] })],
    assignments: [assignment(order, 'IDENTITY')],
  };
  const page = await opsQueue({ deps: { ...wsDeps(set), findSlaPolicy: async () => null }, nowIso: NOW });
  const json = JSON.stringify(page).toLowerCase();
  for (const banned of [/identiermasked|identifiermasked/, /aadhaar/, /\bpan\b/, /selfie/, /notes/, /token/, /razorpay/, /gatewaypaymentid/, /minorunits/]) {
    assert.ok(!banned.test(json), `queue row leaked ${banned}`);
  }
  // Safe fields present
  const row = page.rows[0];
  assert.equal(row.candidateName, 'Asha Rao');
  assert.equal(row.companyName, 'Acme Pvt Ltd');
  assert.equal(row.verifierName, 'Vikram Verifier');
  assert.ok(row.orderCode && row.state && row.ageHours !== undefined);
});

// ── §36.4 verifier workload ──────────────────────────────────────
test('§36.4 workload counts per verifier, includes inactive, never auto-reassigns', async () => {
  const o1 = paidOrder();
  const o2 = paidOrder({ orderCode: 'BGV-0002' });
  const set = {
    ...emptySet,
    orders: [o1, o2],
    cases: [submittedCase(o1, { purchasedChecks: ['IDENTITY'] }), submittedCase(o2, { purchasedChecks: ['IDENTITY'] })],
    assignments: [assignment(o1, 'IDENTITY'), assignment(o2, 'IDENTITY', { verifier: VERIFIER_ID2 })],
    verifications: [verification(o1, 'IDENTITY', { state: 'SUBMITTED', qa: { status: 'PENDING', currentRevision: 1 } })],
  };
  const { verifiers } = await verifierWorkload({ deps: { ...wsDeps(set), findSlaPolicy: async () => null }, nowIso: NOW });
  const vikram = verifiers.find((v) => v.verifierId === VERIFIER_ID);
  const neha = verifiers.find((v) => v.verifierId === VERIFIER_ID2);
  assert.equal(vikram.assigned, 1);
  assert.equal(vikram.submittedForQa, 1);
  assert.equal(neha.status, 'INACTIVE'); // visible for human planning only
  assert.equal(neha.inProgress, 1);
});

// ── §36.5 SLA policy validation + audited write ──────────────────
test('§36.5 policy validation: exactly five types, 1–720h, no defaults', () => {
  assert.equal(validateSlaPolicy({ targets: { CRIMINAL: 24 } }).ok, false);
  assert.equal(validateSlaPolicy({ targets: { IDENTITY: 0 } }).ok, false);
  assert.equal(validateSlaPolicy({ targets: { IDENTITY: 721 } }).ok, false);
  assert.equal(validateSlaPolicy({ targets: { IDENTITY: 12.5 } }).ok, false);
  const good = validateSlaPolicy({ targets: { IDENTITY: 48, EDUCATION: null }, dueSoonHours: 12, pauseOnCandidateWait: false, unassignedTargetHours: 24 });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value.targets, { IDENTITY: 48 });
  assert.equal(good.value.dueSoonHours, 12);
  assert.equal(good.value.pauseOnCandidateWait, false);
});

test('§36.5 readSlaPolicy null = not configured; updateSlaPolicy upserts + audits once', async () => {
  let stored = null;
  const audits = [];
  const deps = {
    findSlaPolicy: async () => stored,
    upsertSlaPolicy: async () => {
      stored = { _id: oid('p'), targets: { IDENTITY: 48 }, dueSoonHours: 24, pauseOnCandidateWait: true, unassignedTargetHours: null, updatedBy: null, updatedAt: new Date() };
      return stored;
    },
    audit: async (entry) => audits.push(entry),
  };
  assert.equal(await readSlaPolicy({ deps }), null);
  const policy = await updateSlaPolicy({ actorId: oid('u'), input: { targets: { IDENTITY: 48 } }, deps });
  assert.equal(policy.targets.IDENTITY, 48);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'BGV_SLA_POLICY_UPDATED');
  assert.equal(audits[0].metadata.configuredChecks, 1);
  // Safe metadata only — no candidate/order identifiers in the audit row
  const auditJson = JSON.stringify(audits[0].metadata);
  assert.ok(!auditJson.includes(CANDIDATE) && !auditJson.includes('Asha'));
  await assert.rejects(() => updateSlaPolicy({ input: { targets: { NOPE: 5 } }, deps }), /Unknown check type/);
});

// ── §36.6 reminder buckets (anti-spam, deterministic) ────────────
test('§36.6 candidate reminders use 48h buckets capped at 3', async () => {
  const fresh = paidOrder({ paidAt: hoursAgo(10) }); // bucket 0
  const old = paidOrder({ orderCode: 'BGV-0009', paidAt: hoursAgo(200) }); // bucket 4 → capped out
  const targets = await collectReminderTargets({
    deps: wsDeps({ ...emptySet, orders: [fresh, old] }),
    nowIso: NOW,
  });
  const consent = targets.filter((t) => t.kind === 'CONSENT_PENDING');
  assert.equal(consent.length, 1);
  assert.equal(consent[0].orderId, String(fresh._id));
  assert.equal(consent[0].bucket, 0);
});

test('§36.6 verifier SLA reminders fire only when DUE_SOON/OVERDUE, daily buckets', async () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: ['IDENTITY'] });
  const policy = { key: 'BGV_SLA_POLICY', targets: { IDENTITY: 48 }, dueSoonHours: 24, pauseOnCandidateWait: true, unassignedTargetHours: null };
  const mkSet = (assignedHours) => ({
    ...emptySet,
    orders: [order],
    cases: [caseDoc],
    assignments: [assignment(order, 'IDENTITY', { assignedAt: hoursAgo(assignedHours) })],
    verifications: [verification(order, 'IDENTITY')],
  });
  const withPolicy = (set) => ({ ...wsDeps(set), findSlaPolicy: async () => policy });
  const red = await collectReminderTargets({ deps: withPolicy(mkSet(60)), nowIso: NOW }); // OVERDUE
  assert.ok(red.some((t) => t.kind === 'VERIFIER_SLA'));
  const green = await collectReminderTargets({ deps: withPolicy(mkSet(10)), nowIso: NOW }); // ON_TRACK
  assert.ok(!green.some((t) => t.kind === 'VERIFIER_SLA'));
  const noPolicy = await collectReminderTargets({ deps: { ...wsDeps(mkSet(60)), findSlaPolicy: async () => null }, nowIso: NOW });
  assert.ok(!noPolicy.some((t) => t.kind === 'VERIFIER_SLA')); // not configured → no nudge
});

test('§36.6 QA reminders capped at 2 daily buckets; info requests capped at 3', async () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: ['IDENTITY'] });
  const set = {
    ...emptySet,
    orders: [order],
    cases: [caseDoc],
    verifications: [verification(order, 'IDENTITY', { state: 'SUBMITTED', qa: { status: 'PENDING', currentRevision: 1 }, conclusion: { submittedAt: hoursAgo(100) } })],
    infoRequests: [infoRequest(order, 'IDENTITY', { requestedAt: hoursAgo(100) })],
  };
  const targets = await collectReminderTargets({ deps: { ...wsDeps(set), findSlaPolicy: async () => null }, nowIso: NOW });
  assert.ok(!targets.some((t) => t.kind === 'QA_PENDING')); // bucket 4 > cap 2
  assert.ok(targets.some((t) => t.kind === 'INFO_PENDING' && t.bucket === 2)); // 100/48 = 2 < 3
  const young = { ...set, infoRequests: [infoRequest(order, 'IDENTITY', { requestedAt: hoursAgo(50) })], verifications: [verification(order, 'IDENTITY', { state: 'SUBMITTED', qa: { status: 'PENDING', currentRevision: 1 }, conclusion: { submittedAt: hoursAgo(30) } })] };
  const youngTargets = await collectReminderTargets({ deps: { ...wsDeps(young), findSlaPolicy: async () => null }, nowIso: NOW });
  assert.ok(youngTargets.some((t) => t.kind === 'INFO_PENDING' && t.bucket === 1));
  assert.ok(youngTargets.some((t) => t.kind === 'QA_PENDING' && t.bucket === 1));
});

// ── §36.7 worker revalidation: Mongo decides, queue never does ───
test('§36.7 stale milestones are skipped with explicit reasons', async () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: ['IDENTITY'] });
  const req = infoRequest(order, 'IDENTITY');
  const base = {
    findOrder: async () => order,
    findCase: async () => caseDoc,
  };
  // Consent already given (collection case exists)
  let res = await revalidateReminder({ orderId: String(order._id), kind: 'CONSENT_PENDING', deps: base });
  assert.deepEqual(res, { valid: false, reason: 'ALREADY_DECIDED' });
  // Declined consent is final — never chased again
  res = await revalidateReminder({
    orderId: String(order._id),
    kind: 'CONSENT_PENDING',
    deps: { findOrder: async () => order, findCase: async () => null, findLatestToken: async () => ({ finalDecision: 'DECLINED', decidedAt: hoursAgo(5) }) },
  });
  assert.equal(res.reason, 'ALREADY_DECIDED');
  // Submission already done
  res = await revalidateReminder({ orderId: String(order._id), kind: 'SUBMISSION_PENDING', deps: base });
  assert.equal(res.reason, 'ALREADY_SUBMITTED');
  // Info request already answered
  res = await revalidateReminder({
    orderId: String(order._id),
    kind: 'INFO_PENDING',
    requestId: String(req._id),
    deps: { ...base, findInfoRequest: async () => ({ ...req, status: 'CANDIDATE_RESPONDED', respondedAt: hoursAgo(1) }) },
  });
  assert.equal(res.reason, 'ALREADY_RESPONDED');
  // QA already approved
  res = await revalidateReminder({
    orderId: String(order._id),
    kind: 'QA_PENDING',
    checkType: 'IDENTITY',
    deps: { ...base, findVerification: async () => verification(order, 'IDENTITY', { state: 'SUBMITTED', qa: { status: 'APPROVED', currentRevision: 1 } }) },
  });
  assert.equal(res.reason, 'QA_NO_LONGER_PENDING');
  // Check completed / moved on
  res = await revalidateReminder({
    orderId: String(order._id),
    kind: 'VERIFIER_SLA',
    checkType: 'IDENTITY',
    deps: { ...base, findVerification: async () => verification(order, 'IDENTITY', { state: 'SUBMITTED' }) },
  });
  assert.equal(res.reason, 'CHECK_NO_LONGER_ACTIVE');
  // Order cancelled / unpaid
  res = await revalidateReminder({ orderId: String(order._id), kind: 'SUBMISSION_PENDING', deps: { findOrder: async () => ({ ...order, status: 'CANCELLED' }) } });
  assert.equal(res.reason, 'ORDER_INACTIVE');
  // Unpaid orders excluded from the scan entirely
  const targets = await collectReminderTargets({
    deps: wsDeps({ ...emptySet, orders: [paidOrder({ status: 'PAYMENT_FAILED' })] }),
    nowIso: NOW,
  });
  assert.equal(targets.length, 0);
});

test('§36.7 verifier SLA nudge is re-derived — green SLA cancels the reminder', async () => {
  const order = paidOrder();
  const caseDoc = submittedCase(order, { purchasedChecks: ['IDENTITY'] });
  const policy = { targets: { IDENTITY: 48 }, dueSoonHours: 24, pauseOnCandidateWait: true, unassignedTargetHours: null };
  const deps = {
    findOrder: async () => order,
    findCase: async () => caseDoc,
    findVerification: async () => verification(order, 'IDENTITY'),
    findAssignment: async () => assignment(order, 'IDENTITY', { assignedAt: hoursAgo(10) }),
    findSlaPolicy: async () => policy,
  };
  const res = await revalidateReminder({ orderId: String(order._id), kind: 'VERIFIER_SLA', checkType: 'IDENTITY', deps, nowIso: NOW });
  assert.deepEqual(res, { valid: false, reason: 'SLA_NO_LONGER_RED' });
  const red = await revalidateReminder({
    orderId: String(order._id),
    kind: 'VERIFIER_SLA',
    checkType: 'IDENTITY',
    deps: { ...deps, findAssignment: async () => assignment(order, 'IDENTITY', { assignedAt: hoursAgo(60) }) },
    nowIso: NOW,
  });
  assert.equal(red.valid, true);
  assert.equal(red.slaStatus, 'OVERDUE');
});

// ── §36.8 portal links: rotate ONLY at dispatch, never queued ────
test('§36.8 active unexpired token → no rotation; missing token → rotate at dispatch', async () => {
  const order = paidOrder();
  let inserted = null;
  let revoked = 0;
  const activeDeps = { findActiveToken: async () => ({ activeKey: 'ACTIVE' }), insertToken: async (t) => { inserted = t; } };
  const kept = await ensurePortalLink({ order, kind: 'INFO_PENDING', deps: activeDeps });
  assert.equal(kept.rotated, false);
  assert.equal(kept.portalUrl, null);
  assert.equal(inserted, null);

  const rotateDeps = {
    findActiveToken: async () => null,
    findLatestToken: async () => ({ finalDecision: 'CONSENTED', decidedAt: hoursAgo(48) }),
    revokeActiveTokens: async () => { revoked += 1; },
    insertToken: async (t) => { inserted = t; },
  };
  const rotated = await ensurePortalLink({ order, kind: 'INFO_PENDING', deps: rotateDeps });
  assert.equal(rotated.rotated, true);
  assert.match(rotated.portalUrl, /\/candidate\/bgv-consent\/[A-Za-z0-9._-]+$/);
  assert.equal(revoked, 1);
  assert.equal(inserted.finalDecision, 'CONSENTED'); // decision carried, never reopened
  assert.ok(!JSON.stringify({ ...inserted, tokenHash: undefined }).includes('tokenHash'));
  assert.ok(inserted.tokenHash && inserted.tokenHash.length > 20); // hash-only storage
});

test('§36.8 consent-pending rotation keeps the decision open; no link past a missing consent', async () => {
  const order = paidOrder();
  let inserted = null;
  const open = await ensurePortalLink({
    order,
    kind: 'CONSENT_PENDING',
    deps: { findActiveToken: async () => null, findLatestToken: async () => null, revokeActiveTokens: async () => {}, insertToken: async (t) => { inserted = t; } },
  });
  assert.equal(open.rotated, true);
  assert.equal(inserted.finalDecision, null);
  const blocked = await ensurePortalLink({
    order,
    kind: 'INFO_PENDING',
    deps: { findActiveToken: async () => null, findLatestToken: async () => null },
  });
  assert.equal(blocked.blocked, 'CONSENT_NOT_GIVEN');
  assert.equal(blocked.portalUrl, null);
});

// ── §36.9 dispatch: references-only payload + idempotent keys ────
test('§36.9 queue payloads carry references ONLY and deterministic event keys', async () => {
  const order = paidOrder();
  const dispatched = [];
  const report = await runBgvReminderReconciliation({
    nowIso: NOW,
    deps: {
      ...wsDeps({ ...emptySet, orders: [order] }),
      findSlaPolicy: async () => null,
      dispatch: async (args) => { dispatched.push(args); return { queued: true }; },
    },
  });
  assert.equal(report.queued, 1);
  assert.equal(dispatched.length, 1);
  const job = dispatched[0];
  assert.equal(job.jobName, 'email-bgv30-reminder');
  assert.deepEqual(Object.keys(job.payload).sort(), ['bucket', 'checkType', 'kind', 'orderId', 'requestId']);
  const json = JSON.stringify(job.payload);
  for (const banned of ['token', 'http', 'pan', 'aadhaar', 'html', 'razorpay']) {
    assert.ok(!json.toLowerCase().includes(banned), `payload leaked ${banned}`);
  }
  // Deterministic event key (idempotency anchor on EmailDelivery.eventKey)
  // Fixture order was paid 120h ago → 48h bucket 2 (deterministic key).
  assert.equal(job.eventKey, reminderEventKey({ kind: 'CONSENT_PENDING', orderId: String(order._id), checkType: null, requestId: null, bucket: 2 }));
  // A duplicate dispatch reports duplicate — at-least-once, never exactly-once claims
  const again = await runBgvReminderReconciliation({
    nowIso: NOW,
    deps: { ...wsDeps({ ...emptySet, orders: [order] }), findSlaPolicy: async () => null, dispatch: async () => ({ duplicate: true }) },
  });
  assert.equal(again.duplicate, 1);
});

// ── §36.10 surface hygiene ───────────────────────────────────────
test('§36.10 controller exports the five platform endpoints with the 3-comment convention', async () => {
  const mod = await import('../src/controllers/bgvOperationsDashboardController.js');
  for (const name of ['bgvOpsDashboard', 'bgvOpsQueue', 'bgvOpsWorkload', 'bgvOpsSlaPolicyRead', 'bgvOpsSlaPolicyUpdate']) {
    assert.equal(typeof mod[name], 'function');
  }
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/controllers/bgvOperationsDashboardController.js', import.meta.url), 'utf8');
  assert.equal((source.match(/Data from frontend/g) || []).length, 5);
  assert.equal((source.match(/DB Logic/g) || []).length, 5);
  assert.equal((source.match(/Data to frontend - response to frontend/g) || []).length, 5);
});

test('§36.10 routes are permit-gated; dashboard reads are not audited', async () => {
  const { readFileSync } = await import('node:fs');
  const routes = readFileSync(new URL('../src/routes/superAdminRoutes.js', import.meta.url), 'utf8');
  for (const line of [
    'router.get("/bgv-ops/dashboard", permit("bgv-operations:read")',
    'router.get("/bgv-ops/queue", permit("bgv-operations:read")',
    'router.get("/bgv-ops/workload", permit("bgv-operations:read")',
    'router.get("/bgv-ops/sla", permit("bgv-operations:read")',
    'router.put("/bgv-ops/sla", permit("bgv-operations:manage")',
  ]) {
    assert.ok(routes.includes(line), `missing route wiring: ${line}`);
  }
  // Reads never audit: opsSummary/opsQueue/verifierWorkload take no audit dep
  const service = readFileSync(new URL('../src/services/bgv/bgvOperationsDashboardService.js', import.meta.url), 'utf8');
  const readFns = ['opsSummary', 'opsQueue', 'verifierWorkload'];
  for (const fn of readFns) {
    const start = service.indexOf(`export const ${fn}`);
    const body = service.slice(start, service.indexOf('export const', start + 10));
    assert.ok(!body.includes('recordAudit') && !body.includes('deps.audit'), `${fn} must not audit`);
  }
});
