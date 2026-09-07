// Phase 30.7 — BGV CHECK ASSIGNMENT & verifier workspace (hermetic suite).
// No MongoDB/Redis/SMTP: every collaborator is injected. The fake
// insertAssignment simulates the partial unique index (error.code 11000)
// and updateAssignment simulates the atomic conditional update, so the
// concurrency contract is genuinely exercised.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

import { BGV_ASSIGNMENT_STATUSES } from '../src/models/BgvCheckAssignment.js';
import {
  assignCheck,
  downloadVerifierEvidence,
  eligibleVerifiersForCheck,
  getHrAssignmentStatus,
  listOperationsQueue,
  reassignCheck,
  startCheckWork,
  unassignCheck,
  verifierCheckDetail,
  verifierWorkQueue,
} from '../src/services/bgv/bgvAssignmentService.js';

const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const ADMIN = 'adm111111111111111111111';
const ORDER_ID = 'ord111111111111111111111';
const CASE_ID = 'cas111111111111111111111';
const COMPANY_ID = 'com111111111111111111111';
const CANDIDATE_ID = 'cnd111111111111111111111';
const V_ID = 'ver111111111111111111111';
const V2_ID = 'ver222222222222222222222';
const V3_ID = 'ver333333333333333333333';

const makeWorld = (overrides = {}) => {
  const state = {
    assignments: [],
    audits: [],
    nextId: 0,
    caseStatus: 'SUBMITTED',
    consentDecision: 'CONSENTED',
    orderStatus: 'PAID',
    ...overrides,
  };

  const order = {
    _id: ORDER_ID,
    companyId: COMPANY_ID,
    candidate: CANDIDATE_ID,
    orderCode: 'BGV-2026-0001',
    status: state.orderStatus,
    openKey: 'OPEN',
    items: [
      { type: 'IDENTITY' },
      { type: 'ADDRESS' },
      { type: 'EDUCATION' },
      { type: 'EMPLOYMENT' },
      { type: 'REFERENCE' },
    ],
  };

  const collectionCase = {
    _id: CASE_ID,
    companyId: COMPANY_ID,
    bgvOrder: ORDER_ID,
    status: state.caseStatus,
    submittedAt: new Date(Date.now() - 3 * 86400000),
    purchasedChecks: ['IDENTITY', 'ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'REFERENCE'],
    identity: {
      legalName: 'Priya Raman',
      dateOfBirth: new Date('1996-04-02T00:00:00Z'),
      documentType: 'AADHAAR',
      identifierMasked: 'XXXX-XXXX-4321',
    },
    address: { line1: '12 Gandhipuram', city: 'Coimbatore' },
    educations: [{ _id: 'edu1', institution: 'PSG Tech', qualification: 'B.E. CSE' }],
    employments: [{ _id: 'emp1', employer: 'Infolexus', designation: 'Analyst', startDate: new Date('2020-01-01') }],
    references: [{ _id: 'ref1', name: 'Karthik S', relationship: 'MANAGER' }],
  };

  const verifiers = [
    { _id: V_ID, name: 'Verifier One', email: 'v1@crewly.test', status: 'ACTIVE', specializations: ['IDENTITY', 'ADDRESS'] },
    { _id: V2_ID, name: 'Verifier Two', email: 'v2@crewly.test', status: 'ACTIVE', specializations: ['EDUCATION', 'EMPLOYMENT', 'REFERENCE'] },
    { _id: V3_ID, name: 'Verifier Three', email: 'v3@crewly.test', status: 'DEACTIVATED', specializations: ['IDENTITY'] },
  ];

  const files = [
    { _id: 'fil-identity', bgvCollectionCase: CASE_ID, bgvOrder: ORDER_ID, checkType: 'IDENTITY', category: 'SELFIE', originalFileName: 'selfie.jpg', mimeType: 'image/jpeg', fileSize: 100, version: 1, scanStatus: 'NOT_CONFIGURED', uploadedAt: new Date(), storageProvider: 'LOCAL', storageKey: 'private/bgv/fil-identity', checksumSha256: 'abc', status: 'ACTIVE', isActive: true },
    { _id: 'fil-education', bgvCollectionCase: CASE_ID, bgvOrder: ORDER_ID, checkType: 'EDUCATION', category: 'DEGREE_CERTIFICATE', originalFileName: 'degree.pdf', mimeType: 'application/pdf', fileSize: 200, version: 1, scanStatus: 'NOT_CONFIGURED', uploadedAt: new Date(), storageProvider: 'LOCAL', storageKey: 'private/bgv/fil-education', checksumSha256: 'def', status: 'ACTIVE', isActive: true },
  ];

  const deps = {
    loadOrderById: async ({ orderId }) => (String(orderId) === ORDER_ID ? { ...order, status: state.orderStatus } : null),
    loadCompany: async () => ({ name: 'Infolexus Tech' }),
    loadCandidate: async () => ({ name: 'Priya Raman', candidateCode: 'C-001' }),
    loadLatestToken: async () => ({ finalDecision: state.consentDecision }),
    loadCase: async () => ({ ...collectionCase, status: state.caseStatus }),
    listActiveFiles: async () => files.filter((f) => f.isActive).map((f) => ({ ...f })),
    loadVerifier: async ({ verifierId }) => {
      const found = verifiers.find((v) => String(v._id) === String(verifierId));
      return found ? { ...found } : null;
    },
    listActiveVerifiers: async () => verifiers.filter((v) => v.status === 'ACTIVE').map((v) => ({ ...v })),
    findAssignment: async ({ orderId, checkType }) => {
      const found = state.assignments.find(
        (a) => String(a.bgvOrder) === String(orderId) && a.checkType === checkType && a.activeKey === 'CURRENT'
      );
      return found ? { ...found } : null;
    },
    // Simulates the partial unique index on (bgvOrder, checkType, CURRENT).
    insertAssignment: async (doc) => {
      const clash = state.assignments.find(
        (a) => String(a.bgvOrder) === String(doc.bgvOrder) && a.checkType === doc.checkType && a.activeKey === 'CURRENT'
      );
      if (clash) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      const created = { _id: `asg-${state.nextId++}`, activeKey: 'CURRENT', ...doc };
      state.assignments.push(created);
      return { ...created };
    },
    // Simulates the atomic conditional update: null result on lost race.
    updateAssignment: async ({ assignmentId, onlyStatus, set, push }) => {
      const found = state.assignments.find((a) => String(a._id) === String(assignmentId));
      if (!found || found.activeKey !== 'CURRENT') return null;
      if (onlyStatus && found.status !== onlyStatus) return null;
      Object.assign(found, set);
      if (push) found.history = [...(found.history || []), push];
      return { ...found };
    },
    listAssignmentsForOrders: async ({ orderIds }) =>
      state.assignments
        .filter((a) => a.activeKey === 'CURRENT' && (orderIds === null || orderIds === undefined || orderIds.map(String).includes(String(a.bgvOrder))))
        .map((a) => ({ ...a })),
    listSubmittedCases: async () => (state.caseStatus === 'SUBMITTED' ? [{ ...collectionCase }] : []),
    loadFileFull: async ({ fileId }) => {
      const found = files.find((f) => String(f._id) === String(fileId));
      return found ? { ...found } : null;
    },
    fetchFile: async ({ storageKey }) => Buffer.from(`content:${storageKey}`),
    loadCandidateByRef: async () => ({ _id: CANDIDATE_ID, name: 'Priya Raman' }),
    loadLatestOrder: async () => ({ ...order, status: state.orderStatus }),
    audit: async (entry) => {
      state.audits.push(entry);
    },
  };

  return { state, deps, order, collectionCase, verifiers, files };
};

const expectConflict = async (promise, label) => {
  await assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, 409, `${label}: expected 409, got ${err.statusCode} (${err.message})`);
    return true;
  }, label);
};

// ── readiness (backend-authoritative gates) ───────────────────────
test('30.7 #1-5 readiness gates: ready check assigns; unauthorized/unconsented/unsubmitted/unpurchased rejected', async () => {
  {
    const world = makeWorld();
    const result = await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps });
    assert.equal(result.idempotent, false);
    assert.equal(result.assignment.status, 'ASSIGNED');
    assert.equal(result.assignment.verifier, V_ID);
    assert.equal(result.assignment.history.length, 1);
    assert.equal(result.assignment.history[0].action, 'ASSIGNED');
    assert.equal(world.state.audits[0].action, 'BGV_CHECK_ASSIGNED');
    assert.equal(world.state.audits[0].metadata.orderCode, 'BGV-2026-0001');
  }
  {
    const world = makeWorld({ orderStatus: 'PENDING_PAYMENT' });
    await expectConflict(
      assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps }),
      'unauthorized order'
    );
  }
  {
    const world = makeWorld({ consentDecision: 'DECLINED' });
    await expectConflict(
      assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps }),
      'unconsented'
    );
  }
  {
    const world = makeWorld({ caseStatus: 'DRAFT' });
    await expectConflict(
      assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps }),
      'not submitted'
    );
  }
  {
    // Unknown/not-in-platform check type → 400.
    const world = makeWorld();
    await assert.rejects(
      assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'CRIMINAL', verifierId: V_ID, deps: world.deps }),
      (err) => err.statusCode === 400
    );
  }
  {
    // Valid platform check but NOT purchased on this order → conflict.
    const world = makeWorld();
    world.deps.loadOrderById = async () => ({
      _id: ORDER_ID, companyId: COMPANY_ID, candidate: CANDIDATE_ID, orderCode: 'BGV-2026-0001',
      status: 'PAID', openKey: 'OPEN', items: [{ type: 'IDENTITY' }],
    });
    await expectConflict(
      assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'EDUCATION', verifierId: V2_ID, deps: world.deps }),
      'unpurchased check'
    );
  }
});

// ── eligibility (specialization + ACTIVE, backend-revalidated) ────
test('30.7 #6-9 eligibility: deactivated/mismatched rejected; eligible list sanitized; specialization alone grants no access', async () => {
  {
    const world = makeWorld();
    await expectConflict(
      assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V3_ID, deps: world.deps }),
      'deactivated verifier'
    );
  }
  {
    const world = makeWorld(); // V2 has EDUCATION.. not IDENTITY
    await expectConflict(
      assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V2_ID, deps: world.deps }),
      'missing specialization'
    );
  }
  {
    const world = makeWorld();
    const eligible = await eligibleVerifiersForCheck({ checkType: 'EDUCATION', deps: world.deps });
    assert.deepEqual(eligible.map((v) => String(v.id || v._id)), [V2_ID]);
    const json = JSON.stringify(eligible);
    assert.ok(!json.includes('passwordHash'), 'eligible list must be sanitized');
  }
  {
    // Specialization ≠ authorization: V2 is EDUCATION-eligible but with no
    // assignment its workspace is EMPTY.
    const world = makeWorld();
    const queue = await verifierWorkQueue({ verifierId: V2_ID, deps: world.deps });
    assert.deepEqual(queue.rows, []);
  }
});

// ── authorization (assignment is the access key) ──────────────────
test('30.7 #10-13 authorization: unassigned verifier gets 404 detail; files cross-check/cross-order rejected; no client-supplied verifierId', async () => {
  const world = makeWorld();
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps });

  // Unassigned verifier (even a valid one) sees nothing.
  await assert.rejects(
    verifierCheckDetail({ verifierId: V2_ID, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps }),
    (err) => err.statusCode === 404
  );
  // Assigned verifier cannot read an unassigned check's detail either.
  await assert.rejects(
    verifierCheckDetail({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EDUCATION', deps: world.deps }),
    (err) => err.statusCode === 404
  );
  // File belongs to a different check than the assignment.
  await assert.rejects(
    downloadVerifierEvidence({ verifierId: V_ID, fileId: 'fil-education', deps: world.deps }),
    (err) => err.statusCode === 404
  );
  // Structural: verifier identity comes from the session principal only.
  const controller = readFileSync(new URL('../src/controllers/bgvVerifierWorkController.js', import.meta.url), 'utf8');
  assert.ok(!/req\.query\.verifierId/.test(controller));
  assert.ok(/req\.verifier\._id/.test(controller));
  const routes = readFileSync(new URL('../src/routes/bgvVerifierWorkRoutes.js', import.meta.url), 'utf8');
  assert.ok(/requireVerifierAuth/.test(routes));
  assert.ok(!/assign/i.test(stripComments(routes)), 'verifier surface must have no assignment management');
});

// ── concurrency (unique index + atomic conditional update) ────────
test('30.7 #14-16 concurrency: race yields one winner + 409; same-verifier duplicate is idempotent; lost conditional update conflicts', async () => {
  const world = makeWorld();
  // Pre-create a CURRENT row, then a second operator tries insert (simulating
  // the window between the read and the insert).
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps });
  await expectConflict(
    assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V2_ID, deps: world.deps }),
    'already assigned to another verifier'
  );
  // Same verifier twice → idempotent, still exactly one row.
  const again = await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps });
  assert.equal(again.idempotent, true);
  assert.equal(world.state.assignments.length, 1);
  // True insert race: bypass findAssignment so insertAssignment hits the
  // unique-index simulation → conflict (different verifier).
  const blindDeps = { ...world.deps, findAssignment: async () => null };
  await expectConflict(
    assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V2_ID, deps: blindDeps }),
    'insert race'
  );
  // Lost conditional update on reassign → conflict, not silent overwrite.
  world.verifiers.push({ _id: 'ver777777777777777777777', name: 'Verifier Seven', status: 'ACTIVE', specializations: ['IDENTITY'] });
  const staleDeps = { ...world.deps, updateAssignment: async () => null };
  await expectConflict(
    reassignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', newVerifierId: 'ver777777777777777777777', reason: 'ops', deps: staleDeps }),
    'lost update'
  );
  assert.equal(String(world.state.assignments[0].verifier), V_ID, 'failed update must not change the assignment');
});

// ── reassignment & unassignment ───────────────────────────────────
test('30.7 #17-21 reassignment: eligible switch with history + reason; ineligible/unassigned/no-reason rejected; history never overwritten', async () => {
  const world = makeWorld();
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'EDUCATION', verifierId: V2_ID, deps: world.deps });

  // No reason → rejected.
  await assert.rejects(
    reassignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'EDUCATION', newVerifierId: V2_ID, reason: '', deps: world.deps }),
    (err) => err.statusCode === 400
  );
  // Ineligible (deactivated) → conflict and original assignment intact.
  await expectConflict(
    reassignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'EDUCATION', newVerifierId: V3_ID, reason: 'handover', deps: world.deps }),
    'deactivated target'
  );
  assert.equal(world.state.assignments[0].verifier, V2_ID);

  // Valid reassignment (V2 → another EDUCATION-eligible active verifier).
  world.verifiers.push({ _id: 'ver444444444444444444444', name: 'Verifier Four', status: 'ACTIVE', specializations: ['EDUCATION'] });
  const reassigned = await reassignCheck({
    actorId: ADMIN,
    orderId: ORDER_ID,
    checkType: 'EDUCATION',
    newVerifierId: 'ver444444444444444444444',
    reason: 'verifier on leave',
    deps: world.deps,
  });
  assert.equal(String(reassigned.assignment.verifier), 'ver444444444444444444444');
  const history = reassigned.assignment.history;
  assert.equal(history.length, 2);
  assert.equal(history[1].action, 'REASSIGNED');
  assert.equal(String(history[1].verifierFrom), V2_ID);
  assert.equal(history[1].reason, 'verifier on leave');
  assert.ok(world.state.audits.some((a) => a.action === 'BGV_CHECK_REASSIGNED'));

  // Reassignment of an unassigned check → conflict.
  await expectConflict(
    reassignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'ADDRESS', newVerifierId: V_ID, reason: 'x', deps: world.deps }),
    'no current assignment'
  );
});

test('30.7 #21/#40 unassignment: only before work starts; history kept; former verifier loses access; IN_PROGRESS must reassign', async () => {
  const world = makeWorld();
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps });

  const unassigned = await unassignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', reason: 'wrong queue', deps: world.deps });
  assert.equal(unassigned.assignment.verifier, null);
  assert.equal(unassigned.assignment.history.at(-1).action, 'UNASSIGNED');
  assert.ok(world.state.audits.some((a) => a.action === 'BGV_CHECK_UNASSIGNED'));

  // Former verifier's access is gone immediately.
  await assert.rejects(
    verifierCheckDetail({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps }),
    (err) => err.statusCode === 404
  );

  // Once work starts, unassignment is refused (reassignment is the path).
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'ADDRESS', verifierId: V_ID, deps: world.deps });
  await startCheckWork({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'ADDRESS', deps: world.deps });
  await expectConflict(
    unassignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'ADDRESS', deps: world.deps }),
    'started work cannot be unassigned'
  );
});

// ── verifier queue ────────────────────────────────────────────────
test('30.7 #22-25 queue: only own CURRENT assignments; safe fields only; deactivated forbidden; ops queue shows states', async () => {
  const world = makeWorld();
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps });
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'EDUCATION', verifierId: V2_ID, deps: world.deps });

  const mine = await verifierWorkQueue({ verifierId: V_ID, deps: world.deps });
  assert.equal(mine.rows.length, 1);
  const row = mine.rows[0];
  assert.equal(row.checkType, 'IDENTITY');
  assert.equal(row.orderCode, 'BGV-2026-0001');
  assert.equal(row.companyName, 'Infolexus Tech');
  assert.equal(row.candidateName, 'Priya Raman');
  assert.equal(row.status, 'ASSIGNED');
  const rowJson = JSON.stringify(row).toLowerCase();
  for (const banned of ['price', 'amount', 'razorpay', 'invoice', 'aadhaar', 'masked']) {
    assert.ok(!rowJson.includes(banned), `queue row must not include ${banned}`);
  }

  // Deactivated verifier is refused at the queue.
  world.verifiers.find((v) => v._id === V3_ID).status = 'DEACTIVATED';
  await assert.rejects(verifierWorkQueue({ verifierId: V3_ID, deps: world.deps }), (err) => err.statusCode === 403);

  // Operations queue: unassigned rows have assignment null, assigned rows
  // carry state + verifier identity for the operator (no evidence fields).
  const ops = await listOperationsQueue({ deps: world.deps });
  assert.equal(ops.rows.length, 5);
  const identityRow = ops.rows.find((r) => r.checkType === 'IDENTITY');
  assert.equal(identityRow.assignment.status, 'ASSIGNED');
  assert.equal(identityRow.assignment.verifier.name, 'Verifier One');
  const unassignedRow = ops.rows.find((r) => r.checkType === 'REFERENCE');
  assert.equal(unassignedRow.assignment, null);
  assert.equal(unassignedRow.waitingDays, 3);
  const opsJson = JSON.stringify(ops).toLowerCase();
  assert.ok(!opsJson.includes('storagekey') && !opsJson.includes('checksum'));
});

// ── check detail: minimum-data projection per check ───────────────
test('30.7 #26-31 detail: per-check projections; no cross-check data; no payment/full-identifier fields', async () => {
  const world = makeWorld();
  for (const [check, verifier] of [['IDENTITY', V_ID], ['ADDRESS', V_ID], ['EDUCATION', V2_ID], ['EMPLOYMENT', V2_ID], ['REFERENCE', V2_ID]]) {
    await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: check, verifierId: verifier, deps: world.deps });
  }

  const identity = await verifierCheckDetail({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  assert.equal(identity.identity.legalName, 'Priya Raman');
  assert.equal(identity.identity.identifierMasked, 'XXXX-XXXX-4321');
  assert.equal(identity.identity.provenance, 'candidate-provided');
  assert.equal(identity.files.length, 1);
  assert.equal(identity.files[0].category, 'SELFIE');
  assert.ok(!('address' in identity) && !('educations' in identity));

  const address = await verifierCheckDetail({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'ADDRESS', deps: world.deps });
  assert.equal(address.address.city, 'Coimbatore');
  assert.equal(address.candidateName, 'Priya Raman');
  assert.ok(!('educations' in address) && !('employments' in address) && !('identity' in address));

  const education = await verifierCheckDetail({ verifierId: V2_ID, orderId: ORDER_ID, checkType: 'EDUCATION', deps: world.deps });
  assert.equal(education.educations[0].institution, 'PSG Tech');
  assert.equal(education.files.length, 1);
  assert.ok(!('employments' in education));

  const employment = await verifierCheckDetail({ verifierId: V2_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', deps: world.deps });
  assert.equal(employment.employments[0].employer, 'Infolexus');
  assert.ok(!('educations' in employment));

  const reference = await verifierCheckDetail({ verifierId: V2_ID, orderId: ORDER_ID, checkType: 'REFERENCE', deps: world.deps });
  assert.equal(reference.references[0].name, 'Karthik S');
  assert.deepEqual(reference.files, []);

  const allJson = JSON.stringify([identity, address, education, employment, reference]).toLowerCase();
  for (const banned of ['totalminorunits', 'razorpay', 'payment', 'fingerprint', 'invoice']) {
    assert.ok(!allJson.includes(banned), `detail DTOs must never include ${banned}`);
  }
});

// ── evidence downloads ────────────────────────────────────────────
test('30.7 #32-37 files: assigned-check download works and is audited; cross-check/cross-order/removed/former-verifier denied; audit metadata safe', async () => {
  const world = makeWorld();
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps });

  const file = await downloadVerifierEvidence({ verifierId: V_ID, fileId: 'fil-identity', deps: world.deps });
  assert.equal(file.fileName, 'selfie.jpg');
  assert.equal(file.buffer.toString(), 'content:private/bgv/fil-identity');
  const readAudit = world.state.audits.find((a) => a.action === 'BGV_EVIDENCE_READ_VERIFIER');
  assert.ok(readAudit, 'sensitive read must be audited');
  const auditJson = JSON.stringify(readAudit.metadata).toLowerCase();
  for (const banned of ['storagekey', 'selfie.jpg', 'abc']) {
    assert.ok(!auditJson.includes(banned), `audit metadata must not include ${banned}`);
  }

  // Cross-check file (education file, identity assignment).
  await assert.rejects(
    downloadVerifierEvidence({ verifierId: V_ID, fileId: 'fil-education', deps: world.deps }),
    (err) => err.statusCode === 404
  );
  // File from another order.
  world.deps.loadFileFull = async () => ({ ...world.files[0], _id: 'fil-other', bgvOrder: 'ord999999999999999999999', bgvCollectionCase: 'cas999999999999999999999' });
  await assert.rejects(
    downloadVerifierEvidence({ verifierId: V_ID, fileId: 'fil-other', deps: world.deps }),
    (err) => err.statusCode === 404
  );
  world.deps.loadFileFull = async ({ fileId }) => {
    const found = world.files.find((f) => String(f._id) === String(fileId));
    return found ? { ...found } : null;
  };
  // Removed file.
  world.deps.loadFileFull = async () => ({ ...world.files[0], status: 'REMOVED' });
  await assert.rejects(
    downloadVerifierEvidence({ verifierId: V_ID, fileId: 'fil-identity', deps: world.deps }),
    (err) => err.statusCode === 404
  );
  world.deps.loadFileFull = async ({ fileId }) => {
    const found = world.files.find((f) => String(f._id) === String(fileId));
    return found ? { ...found } : null;
  };
  // Former verifier after reassignment loses the file immediately.
  world.verifiers.push({ _id: 'ver555555555555555555555', name: 'Verifier Five', status: 'ACTIVE', specializations: ['IDENTITY'] });
  await reassignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', newVerifierId: 'ver555555555555555555555', reason: 'rotation', deps: world.deps });
  await assert.rejects(
    downloadVerifierEvidence({ verifierId: V_ID, fileId: 'fil-identity', deps: world.deps }),
    (err) => err.statusCode === 404
  );
  // New verifier can read it.
  const moved = await downloadVerifierEvidence({ verifierId: 'ver555555555555555555555', fileId: 'fil-identity', deps: world.deps });
  assert.equal(moved.fileName, 'selfie.jpg');
});

// ── deactivation visibility & operational states ──────────────────
test('30.7 #38-40/#42 deactivated verifier identifiable in ops queue + reassignable; statuses are operational only', async () => {
  assert.deepEqual(BGV_ASSIGNMENT_STATUSES, ['ASSIGNED', 'IN_PROGRESS']);

  const world = makeWorld();
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps });
  world.verifiers.find((v) => v._id === V_ID).status = 'DEACTIVATED';

  const ops = await listOperationsQueue({ deps: world.deps });
  const identityRow = ops.rows.find((r) => r.checkType === 'IDENTITY');
  assert.equal(identityRow.assignment.verifier.status, 'DEACTIVATED');

  // Outstanding work of a deactivated verifier can be reassigned (no silent
  // auto-reassignment: the operator acts explicitly).
  world.verifiers.push({ _id: 'ver666666666666666666666', name: 'Verifier Six', status: 'ACTIVE', specializations: ['IDENTITY'] });
  const reassigned = await reassignCheck({
    actorId: ADMIN,
    orderId: ORDER_ID,
    checkType: 'IDENTITY',
    newVerifierId: 'ver666666666666666666666',
    reason: 'verifier deactivated',
    deps: world.deps,
  });
  assert.equal(String(reassigned.assignment.verifier), 'ver666666666666666666666');
});

// ── business safety ───────────────────────────────────────────────
test('30.7 #41-46 business safety: no mutation of order/case; START idempotent + audited; unassigned verifier cannot start; HR status state-only', async () => {
  const world = makeWorld();
  const caseBefore = JSON.stringify(world.collectionCase);
  await assignCheck({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'IDENTITY', verifierId: V_ID, deps: world.deps });
  assert.equal(JSON.stringify(world.collectionCase), caseBefore, 'assignment must not mutate the collection case');

  // START: ASSIGNED → IN_PROGRESS, audited, idempotent on repeat.
  const started = await startCheckWork({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  assert.equal(started.idempotent, false);
  assert.equal(started.assignment.status, 'IN_PROGRESS');
  assert.ok(started.assignment.startedAt);
  assert.ok(world.state.audits.some((a) => a.action === 'BGV_CHECK_STARTED'));
  const again = await startCheckWork({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  assert.equal(again.idempotent, true);
  const startedEntries = world.state.assignments[0].history.filter((h) => h.action === 'STARTED');
  assert.equal(startedEntries.length, 1);

  // A verifier without the assignment cannot start someone else's check.
  await assert.rejects(
    startCheckWork({ verifierId: V2_ID, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps }),
    (err) => err.statusCode === 404
  );

  // HR progress: state per purchased check only — no verifier identity,
  // no evidence, no payment data.
  const hr = await getHrAssignmentStatus({ companyId: COMPANY_ID, candidateRef: CANDIDATE_ID, deps: world.deps });
  assert.equal(hr.perCheck.IDENTITY, 'IN_PROGRESS');
  assert.equal(hr.perCheck.REFERENCE, 'UNASSIGNED');
  const hrJson = JSON.stringify(hr).toLowerCase();
  assert.ok(!hrJson.includes('verifier'));
  assert.ok(!hrJson.includes('priya'), 'HR status carries no candidate payload beyond state');

  // Not-submitted candidate → no per-check states exposed.
  const draft = makeWorld({ caseStatus: 'DRAFT' });
  const hrDraft = await getHrAssignmentStatus({ companyId: COMPANY_ID, candidateRef: CANDIDATE_ID, deps: draft.deps });
  assert.deepEqual(hrDraft.perCheck, {});
});

// ── structural regression scans ───────────────────────────────────
test('30.7 #47-53 structural: model index/history, route guards, no seeds, no forbidden coupling', async () => {
  const model = readFileSync(new URL('../src/models/BgvCheckAssignment.js', import.meta.url), 'utf8');
  assert.ok(/unique: true/.test(model) && /bgvOrder: 1, checkType: 1, activeKey: 1/.test(model));
  assert.ok(/assignmentHistorySchema/.test(model));

  const superRoutes = readFileSync(new URL('../src/routes/superAdminRoutes.js', import.meta.url), 'utf8');
  assert.ok(/bgv-operations\/queue", permit\("bgv-operations:read"\)/.test(superRoutes));
  assert.ok(/bgv-operations\/assign", permit\("bgv-operations:manage"\)/.test(superRoutes));

  const index = readFileSync(new URL('../src/routes/index.js', import.meta.url), 'utf8');
  assert.ok(/router\.use\("\/bgv-verifier\/work", bgvVerifierWorkRoutes\)/.test(index));

  const recruitment = readFileSync(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8');
  assert.ok(/bgv-assignment-status/.test(recruitment));
  assert.ok(/BACKGROUND_VERIFICATION_READ/.test(recruitment));

  // No seeding scripts for assignments (repo policy).
  const scripts = readdirSync(new URL('../scripts', import.meta.url));
  assert.ok(!scripts.some((name) => /bgv.*assign|assign.*bgv/i.test(name)), 'no BGV assignment seed scripts allowed');

  // No payment/DigiLocker/conclusion coupling in the assignment service.
  const service = stripComments(readFileSync(new URL('../src/services/bgv/bgvAssignmentService.js', import.meta.url), 'utf8'));
  const lower = service.toLowerCase();
  for (const banned of ['razorpay', 'digilocker', 'invoice', 'totalminorunits', 'verified', 'pass', 'fail']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`).test(lower), `assignment service must not reference ${banned}`);
  }

  // Controllers carry the 3-comment convention.
  for (const file of ['../src/controllers/bgvOperationsController.js', '../src/controllers/bgvVerifierWorkController.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok((source.match(/Data from frontend/g) || []).length >= 4);
    assert.ok((source.match(/DB Logic/g) || []).length >= 4);
    assert.ok((source.match(/Data to frontend/g) || []).length >= 4);
  }
});
