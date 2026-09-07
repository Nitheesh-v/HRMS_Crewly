// Phase 30.9 — ADDITIONAL INFORMATION REQUESTS (hermetic suite).
// No MongoDB/Redis/SMTP: every collaborator injected. The fake token store
// mirrors 30.4 hash-only persistence, and the fake collection context
// reuses the REAL loadAuthorizedContext gate through injected deps, so
// candidate isolation/consent checks are genuinely exercised.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { hashToken } from '../src/utils/securityPolicy.js';
import {
  addAlternateReference,
  cancelInfoRequest,
  createInfoRequest,
  listCandidateRequests,
  resolveInfoRequest,
  submitInfoResponse,
  uploadResponseFile,
  verifierListRequests,
} from '../src/services/bgv/bgvInfoRequestService.js';
import { saveIdentityInformation } from '../src/services/bgv/bgvCollectionService.js';

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
const RAW_TOKEN = `tok_${'a'.repeat(64)}`;
const OTHER_TOKEN = `tok_${'b'.repeat(64)}`;

const makeWorld = ({ checkType = 'EMPLOYMENT', verifier = V_ID, orderChecks = null, caseStatus = 'SUBMITTED' } = {}) => {
  const state = {
    requests: [],
    files: [],
    verifications: [],
    tokens: [],
    mails: [],
    audits: [],
    nextId: 0,
    checkType,
    currentVerifier: verifier,
    caseStatus,
    sendResult: { delivered: true, mode: 'MOCK' },
  };

  const order = {
    _id: ORDER_ID,
    companyId: COMPANY_ID,
    candidate: CANDIDATE_ID,
    orderCode: 'BGV-2026-0001',
    status: 'PAID',
    openKey: 'OPEN',
    items: (orderChecks || ['IDENTITY', 'ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'REFERENCE']).map((type) => ({ type })),
  };
  const collectionCase = {
    _id: CASE_ID,
    companyId: COMPANY_ID,
    bgvOrder: ORDER_ID,
    status: state.caseStatus,
    submittedAt: new Date(),
    purchasedChecks: order.items.map((item) => item.type),
    identity: { legalName: 'Priya Raman' },
    references: [],
  };
  state.tokens.push({
    _id: 'ctok-1',
    companyId: COMPANY_ID,
    candidate: CANDIDATE_ID,
    bgvOrder: ORDER_ID,
    purpose: 'BGV_CANDIDATE_CONSENT',
    tokenHash: hashToken(RAW_TOKEN),
    finalDecision: 'CONSENTED',
    decidedAt: new Date(),
    revokedAt: null,
    expiresAt: new Date(Date.now() + 7 * 86400000),
  });

  const deps = {
    loadOrderById: async ({ orderId }) => (String(orderId) === ORDER_ID ? { ...order } : null),
    loadOrder: async ({ companyId }) => ({ ...order, companyId }),
    loadCompany: async () => ({ name: 'Infolexus Tech' }),
    loadCandidate: async () => ({ name: 'Priya Raman', email: 'priya@example.test' }),
    loadCase: async () => ({ ...collectionCase, status: state.caseStatus, references: [...collectionCase.references] }),
    loadLatestToken: async () => ({ ...state.tokens[state.tokens.length - 1] }),
    resolveToken: async (tokenHash) => {
      const found = state.tokens.find((t) => t.tokenHash === tokenHash);
      return found ? { ...found } : null;
    },
    revokeActiveTokens: async () => {
      state.tokens.forEach((t) => {
        if (!t.revokedAt) t.revokedAt = new Date();
      });
    },
    insertToken: async (doc) => {
      const created = { _id: `ctok-${state.nextId++}`, revokedAt: null, ...doc };
      state.tokens.push(created);
      return { ...created };
    },
    findAssignment: async ({ orderId, checkType }) => {
      if (String(orderId) !== ORDER_ID || checkType !== state.checkType || !state.currentVerifier) return null;
      return { _id: 'asg-1', bgvOrder: ORDER_ID, checkType, verifier: state.currentVerifier, status: 'IN_PROGRESS', activeKey: 'CURRENT' };
    },
    findVerification: async ({ orderId, checkType }) => {
      const found = state.verifications.find((v) => String(v.bgvOrder) === String(orderId) && v.checkType === checkType && v.activeKey === 'CURRENT');
      return found ? { ...found } : null;
    },
    insertVerification: async (doc) => {
      const created = { _id: `vfy-${state.nextId++}`, activeKey: 'CURRENT', activities: [], discrepancies: [], conclusion: null, ...doc };
      state.verifications.push(created);
      return { ...created };
    },
    setVerificationState: async ({ verificationId, notStates, state: next }) => {
      const found = state.verifications.find((v) => String(v._id) === String(verificationId));
      if (!found || found.conclusion || notStates.includes(found.state)) return null;
      found.state = next;
      return { ...found };
    },
    insertRequest: async (doc) => {
      const created = { _id: `req-${state.nextId++}`, status: 'OPEN', requestedAt: new Date(), response: { text: '', fileCount: 0, referenceRecordAdded: false }, ...doc };
      state.requests.push(created);
      return { ...created };
    },
    findRequestById: async ({ requestId }) => {
      const found = state.requests.find((r) => String(r._id) === String(requestId));
      return found ? { ...found } : null;
    },
    findOpenByCategory: async ({ orderId, checkType, category }) => {
      const found = state.requests.find((r) => String(r.bgvOrder) === String(orderId) && r.checkType === checkType && r.category === category && r.status === 'OPEN');
      return found ? { ...found } : null;
    },
    listRequests: async ({ caseId }) => state.requests.filter((r) => String(r.bgvCollectionCase) === String(caseId)).map((r) => ({ ...r })),
    listRequestsForCheck: async ({ orderId, checkType }) => state.requests.filter((r) => String(r.bgvOrder) === String(orderId) && r.checkType === checkType).map((r) => ({ ...r })),
    updateRequest: async ({ requestId, onlyStatus, set }) => {
      const found = state.requests.find((r) => String(r._id) === String(requestId));
      if (!found || (onlyStatus && found.status !== onlyStatus)) return null;
      for (const [key, value] of Object.entries(set)) {
        if (key.startsWith('response.')) {
          found.response = { ...(found.response || {}), [key.split('.')[1]]: value };
        } else {
          found[key] = value;
        }
      }
      return { ...found };
    },
    listActiveFiles: async ({ caseId, category }) =>
      state.files.filter((f) => f.isActive && String(f.bgvCollectionCase) === String(caseId) && (!category || f.category === category)).map((f) => ({ ...f })),
    listResponseFiles: async ({ requestId }) => state.files.filter((f) => String(f.bgvInfoRequest) === String(requestId)).map((f) => ({ ...f })),
    createFile: async (doc) => {
      const created = { _id: `fil-${state.nextId++}`, isActive: true, status: 'ACTIVE', ...doc };
      state.files.push(created);
      return { ...created };
    },
    updateFile: async ({ fileId, set }) => {
      const found = state.files.find((f) => String(f._id) === String(fileId));
      if (!found) return null;
      Object.assign(found, set);
      return { ...found };
    },
    persistCase: async ({ caseId, set }) => {
      Object.assign(collectionCase, set);
      return { ...collectionCase };
    },
    storeFile: async ({ buffer }) => ({ storageProvider: 'LOCAL_PRIVATE', storageKey: `k-${buffer.length}` }),
    sendMail: async (payload) => {
      state.mails.push(payload);
      if (state.sendResult instanceof Error) throw state.sendResult;
      return state.sendResult;
    },
    audit: async (entry) => state.audits.push(entry),
    createCase: async () => ({ ...collectionCase }),
  };

  return { state, deps, order, collectionCase };
};

const createRequest = (world, verifierId, category = 'CLEARER_EMPLOYMENT_DOCUMENT', message = 'Please upload a clearer copy', checkType = world.state.checkType) =>
  createInfoRequest({ verifierId, orderId: ORDER_ID, checkType, category, message, deps: world.deps });

// The candidate's ONLY way to learn the rotated link is the Crewly email —
// tests read it from the (mock) delivery exactly like a real candidate.
const tokenFromMail = (world) => {
  const mail = world.state.mails.at(-1);
  const match = /bgv-consent\/([^\s)]+)/.exec(mail?.text || mail?.html || '');
  return match ? match[1] : RAW_TOKEN;
};

// ── AUTHORIZATION (#1-6) ──────────────────────────────────────────
test('30.9 #1-6 authorization: current verifier creates; unassigned/former/specialization-only denied; HR has no create path', async () => {
  {
    const world = makeWorld();
    const result = await createRequest(world, V_ID);
    assert.equal(result.request.status, 'OPEN');
    assert.equal(result.idempotent, false);
    assert.equal(result.notificationSent, true);
  }
  {
    const world = makeWorld();
    await assert.rejects(createRequest(world, V2_ID), (err) => err.statusCode === 404);
  }
  {
    const world = makeWorld();
    await createRequest(world, V_ID);
    world.state.currentVerifier = V2_ID; // reassignment
    await assert.rejects(createRequest(world, V_ID), (err) => err.statusCode === 404);
  }
  {
    const world = makeWorld({ verifier: null });
    await assert.rejects(createRequest(world, V_ID), (err) => err.statusCode === 404); // specialization-only world has no assignment
  }
  // #4 deactivated verifier: session resolution (30.6) refuses non-ACTIVE.
  {
    const source = readFileSync(new URL('../src/services/bgv/bgvVerifierService.js', import.meta.url), 'utf8');
    assert.ok(/status !== 'ACTIVE'\) return null/.test(source));
  }
  // #6 tenant HR / platform routes cannot create verifier info requests.
  {
    const recruitment = readFileSync(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8');
    const superAdmin = readFileSync(new URL('../src/routes/superAdminRoutes.js', import.meta.url), 'utf8');
    assert.ok(!/info-requests/.test(recruitment) && !/info-requests/.test(superAdmin));
    const workRoutes = readFileSync(new URL('../src/routes/bgvVerifierWorkRoutes.js', import.meta.url), 'utf8');
    assert.ok(/router\.use\(requireVerifierAuth/.test(workRoutes));
  }
});

// ── CHECK SCOPE (#7-10) ───────────────────────────────────────────
test('30.9 #7-10 scope: employment categories only for employment check; arbitrary/unpurchased rejected', async () => {
  {
    const world = makeWorld();
    const result = await createRequest(world, V_ID, 'HR_CONTACT', 'Please provide a verifiable HR contact');
    assert.equal(result.request.category, 'HR_CONTACT');
    assert.equal(result.request.responseKind, 'TEXT');
  }
  {
    const world = makeWorld();
    await assert.rejects(createRequest(world, V_ID, 'CLEARER_DOCUMENT'), (err) => err.statusCode === 400); // identity category on employment check
  }
  {
    const world = makeWorld();
    await assert.rejects(createRequest(world, V_ID, 'ASTROLOGY_REPORT'), (err) => err.statusCode === 400);
  }
  {
    const world = makeWorld({ checkType: 'EDUCATION', orderChecks: ['IDENTITY', 'EMPLOYMENT'] }); // education not purchased
    await assert.rejects(createRequest(world, V_ID, 'MARKSHEET', 'please', 'EDUCATION'), (err) => err.statusCode === 409);
  }
});

// ── STATE (#11-15) ────────────────────────────────────────────────
test('30.9 #11-15 state: AWAITING_CANDIDATE only; no conclusion/failure; duplicate idempotent; locked findings refuse', async () => {
  const world = makeWorld();
  await createRequest(world, V_ID);
  // #11 operational state changed, conclusion untouched.
  assert.equal(world.state.verifications[0].state, 'AWAITING_CANDIDATE');
  assert.equal(world.state.verifications[0].conclusion, null);
  // #12/#13 no UNABLE_TO_VERIFY / FAILED / rejection anywhere.
  const auditJson = JSON.stringify(world.state.audits);
  assert.ok(!auditJson.includes('UNABLE_TO_VERIFY') && !auditJson.includes('FAILED'));
  assert.equal(world.state.requests.length, 1);
  // #14 double-click: identical OPEN request returned, no second email.
  const again = await createRequest(world, V_ID);
  assert.equal(again.idempotent, true);
  assert.equal(again.notificationSent, false);
  assert.equal(world.state.requests.length, 1);
  assert.equal(world.state.mails.length, 1);
  // #15 submitted findings are never silently reopened.
  const locked = makeWorld();
  locked.state.verifications.push({ _id: 'vfy-x', bgvOrder: ORDER_ID, checkType: 'EMPLOYMENT', activeKey: 'CURRENT', state: 'SUBMITTED', conclusion: { value: 'VERIFIED' }, activities: [], discrepancies: [] });
  await assert.rejects(createRequest(locked, V_ID), (err) => err.statusCode === 409);
});

// ── NOTIFICATION (#16-20) ─────────────────────────────────────────
test('30.9 #16-20 notification: Crewly sends safe mail; no raw token anywhere; SMTP failure preserves request', async () => {
  const world = makeWorld();
  await createRequest(world, V_ID);
  // #16 mail exists, Crewly context, no payment ask, safe content.
  assert.equal(world.state.mails.length, 1);
  const mail = world.state.mails[0];
  assert.match(mail.subject, /Action needed/);
  assert.ok(mail.text.includes('never asked to pay'));
  assert.ok(mail.text.includes('Employment verification'));
  // #17 raw token never leaves to the verifier response or audits.
  const responseJson = JSON.stringify(world.state.requests);
  assert.ok(!responseJson.includes(RAW_TOKEN));
  assert.ok(!JSON.stringify(world.state.audits).includes(RAW_TOKEN));
  // rotated token carries the completed decision (portal stays usable)
  const rotated = world.state.tokens.at(-1);
  assert.equal(rotated.finalDecision, 'CONSENTED');
  // #18 queue payload safety: no queue coupling in the service.
  const service = stripComments(readFileSync(new URL('../src/services/bgv/bgvInfoRequestService.js', import.meta.url), 'utf8'));
  assert.ok(!/bullmq|redis|enqueue/i.test(service));
  // #19/#20 SMTP failure: request stands OPEN, notification audited failed.
  const failing = makeWorld();
  failing.state.sendResult = new Error('SMTP down');
  const result = await createRequest(failing, V_ID);
  assert.equal(result.notificationSent, false);
  assert.equal(result.request.status, 'OPEN');
  assert.ok(failing.state.audits.some((a) => a.action === 'BGV_INFO_REQUEST_NOTIFICATION' && a.metadata.delivered === false));
  assert.equal(failing.state.requests[0].response.text, '');
});

// ── CANDIDATE PORTAL (#21-25) ─────────────────────────────────────
test('30.9 #21-25 candidate: sees own request only; consent gate; closed requests refuse; GET never submits', async () => {
  const world = makeWorld();
  const created = await createRequest(world, V_ID);
  const portalToken = tokenFromMail(world);
  assert.notEqual(portalToken, RAW_TOKEN, 'rotation must issue a fresh link');
  // #21 own portal lists the request with safe fields.
  const view = await listCandidateRequests({ rawToken: portalToken, deps: world.deps });
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].category, 'CLEARER_EMPLOYMENT_DOCUMENT');
  assert.equal(view.requests[0].status, 'OPEN');
  assert.equal(view.requests[0].message, 'Please upload a clearer copy');
  // #25 GET did not submit anything.
  assert.equal(world.state.requests[0].status, 'OPEN');
  // #22 another candidate token (unknown to this case) sees nothing.
  world.state.tokens.push({ _id: 'ctok-other', companyId: COMPANY_ID, candidate: 'cnd999999999999999999999', bgvOrder: ORDER_ID, purpose: 'BGV_CANDIDATE_CONSENT', tokenHash: hashToken(OTHER_TOKEN), finalDecision: 'CONSENTED', decidedAt: new Date(), revokedAt: null, expiresAt: new Date(Date.now() + 86400000) });
  const otherCase = { ...world.collectionCase, _id: 'cas999999999999999999999' };
  world.deps.loadCase = async () => otherCase;
  const other = await listCandidateRequests({ rawToken: OTHER_TOKEN, deps: world.deps });
  assert.deepEqual(other.requests, []);
  // #23 consent gate: token without CONSENTED is refused.
  world.deps.loadCase = async () => ({ ...world.collectionCase });
  world.state.tokens.push({ _id: 'ctok-noconsent', companyId: COMPANY_ID, candidate: CANDIDATE_ID, bgvOrder: ORDER_ID, purpose: 'BGV_CANDIDATE_CONSENT', tokenHash: hashToken(`tok_${'c'.repeat(64)}`), finalDecision: null, revokedAt: null, expiresAt: new Date(Date.now() + 86400000) });
  await assert.rejects(
    submitInfoResponse({ rawToken: `tok_${'c'.repeat(64)}`, requestId: created.request.id, text: 'x', deps: world.deps }),
    (err) => err.statusCode === 409
  );
  // #24 closed request refuses responses.
  world.deps.updateRequest({ requestId: created.request.id, onlyStatus: 'OPEN', set: { status: 'CANDIDATE_RESPONDED' } });
  await assert.rejects(
    submitInfoResponse({ rawToken: portalToken, requestId: created.request.id, text: 'late reply', deps: world.deps }),
    (err) => err.statusCode === 409
  );
});

// ── CONTROLLED RESUBMISSION (#26-30) ──────────────────────────────
test('30.9 #26-30 controlled edit: requested category only; 30.5 stays locked; versions preserved', async () => {
  const world = makeWorld();
  const created = await createRequest(world, V_ID);
  const portalToken = tokenFromMail(world);
  // #26 replacement upload under the requested evidence category.
  const upload = await uploadResponseFile({
    rawToken: portalToken,
    requestId: created.request.id,
    file: { buffer: Buffer.from('v2-bytes'), originalname: 'experience-letter-v2.pdf', mimetype: 'application/pdf', size: 8 },
    deps: world.deps,
  });
  assert.equal(upload.version, 1);
  assert.equal(world.state.files[0].category, 'EMPLOYMENT_EVIDENCE');
  assert.equal(String(world.state.files[0].bgvInfoRequest), created.request.id);
  // #28/#29 second upload → v2, v1 becomes REPLACED but remains.
  await uploadResponseFile({
    rawToken: portalToken,
    requestId: created.request.id,
    file: { buffer: Buffer.from('v3-bytes!'), originalname: 'experience-letter-v3.pdf', mimetype: 'application/pdf', size: 9 },
    deps: world.deps,
  });
  assert.equal(world.state.files.length, 2);
  const replaced = world.state.files.find((f) => f.status === 'REPLACED');
  const active = world.state.files.find((f) => f.status === 'ACTIVE');
  assert.equal(replaced.version, 1);
  assert.equal(active.version, 2);
  // #30 nothing deleted.
  assert.ok(!world.state.files.some((f) => f.status === 'REMOVED'));
  // #27 the frozen 30.5 surface remains locked (assertEditable unchanged).
  await assert.rejects(
    saveIdentityInformation({ rawToken: portalToken, input: { documentType: 'AADHAAR', identifier: '123456789012', legalName: 'Priya Raman', dateOfBirth: '1996-04-02' }, deps: world.deps }),
    (err) => err.statusCode === 409 && /locked/.test(err.message)
  );
  // Unrelated category upload through 30.9 is impossible: kind TEXT request
  // refuses files; a FILE request only accepts its own evidence category.
  const textWorld = makeWorld();
  const textRequest = await createRequest(textWorld, V_ID, 'EMPLOYMENT_DATES', 'correct dates please');
  await assert.rejects(
    uploadResponseFile({ rawToken: tokenFromMail(textWorld), requestId: textRequest.request.id, file: { buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'x.pdf', size: 1 }, deps: textWorld.deps }),
    (err) => err.statusCode === 409
  );
});

// ── FILES (#31-36) ────────────────────────────────────────────────
test('30.9 #31-36 files: hardened uploader on the route; private storage; honest scan; no public URL', async () => {
  const routes = readFileSync(new URL('../src/routes/publicBgvCollectionRoutes.js', import.meta.url), 'utf8');
  assert.ok(/info-requests\/:requestId\/file', uploadLimit, preOnboardingUpload/.test(routes));
  const uploader = readFileSync(new URL('../src/middlewares/preOnboardingUpload.js', import.meta.url), 'utf8');
  assert.ok(/\.pdf/.test(uploader) && !/\.exe/.test(uploader)); // allowlist posture: executables impossible
  const model = readFileSync(new URL('../src/models/BgvEvidenceFile.js', import.meta.url), 'utf8');
  assert.ok(/storageKey[^\n]*select: false/.test(model));
  const world = makeWorld();
  const created = await createRequest(world, V_ID);
  const upload = await uploadResponseFile({
    rawToken: tokenFromMail(world),
    requestId: created.request.id,
    file: { buffer: Buffer.from('bytes'), originalname: 'doc.pdf', mimetype: 'application/pdf', size: 5 },
    deps: world.deps,
  });
  assert.ok(!('url' in upload));
  assert.equal(world.state.files[0].scanStatus, 'NOT_CONFIGURED'); // honesty, never fake CLEAN
});

// ── RESPONSE & RESOLUTION (#37-42) ────────────────────────────────
test('30.9 #37-42 response: explicit submit, CANDIDATE_RESPONDED, verifier review + resolve, nothing auto-trusted', async () => {
  const world = makeWorld();
  const created = await createRequest(world, V_ID, 'EMPLOYMENT_DATES', 'Please confirm the correct dates');
  const portalToken = tokenFromMail(world);
  // TEXT requires content.
  await assert.rejects(
    submitInfoResponse({ rawToken: portalToken, requestId: created.request.id, text: '', deps: world.deps }),
    (err) => err.statusCode === 400
  );
  // #37/#38 explicit submit persists + state transitions.
  const submitted = await submitInfoResponse({ rawToken: portalToken, requestId: created.request.id, text: 'Correct end date is 2025-02-28', deps: world.deps });
  assert.equal(submitted.request.status, 'CANDIDATE_RESPONDED');
  assert.equal(submitted.request.response.text, 'Correct end date is 2025-02-28');
  assert.equal(world.state.verifications[0].state, 'IN_PROGRESS'); // back to verifier availability
  // #40 response is not auto-verified.
  assert.equal(world.state.verifications[0].conclusion, null);
  // #39 verifier sees the response + history.
  const list = await verifierListRequests({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', deps: world.deps });
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].response.text, 'Correct end date is 2025-02-28');
  assert.equal(list.requests[0].status, 'CANDIDATE_RESPONDED');
  // #41/#42 resolve preserves the request + history + audit.
  const resolved = await resolveInfoRequest({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', requestId: created.request.id, deps: world.deps });
  assert.equal(resolved.request.status, 'RESOLVED');
  assert.equal(String(resolved.request.resolvedBy), V_ID);
  const after = await verifierListRequests({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', deps: world.deps });
  assert.equal(after.requests.length, 1); // never deleted
  assert.ok(world.state.audits.some((a) => a.action === 'BGV_INFO_REQUEST_RESOLVED'));
  // FILE-kind submit requires an uploaded document.
  const fileWorld = makeWorld();
  const fileRequest = await createRequest(fileWorld, V_ID);
  await assert.rejects(
    submitInfoResponse({ rawToken: tokenFromMail(fileWorld), requestId: fileRequest.request.id, text: '', deps: fileWorld.deps }),
    (err) => err.statusCode === 400
  );
  // REFERENCE_RECORD flow: alternate reference then submit.
  const refWorld = makeWorld({ checkType: 'REFERENCE' });
  const refRequest = await createRequest(refWorld, V_ID, 'ALTERNATE_REFERENCE', 'Please add another referee', 'REFERENCE');
  await addAlternateReference({
    rawToken: tokenFromMail(refWorld),
    requestId: refRequest.request.id,
    record: { name: 'Karthik S', relationship: 'Manager', email: 'karthik@example.test' },
    deps: refWorld.deps,
  });
  assert.equal(refWorld.collectionCase.references.length, 1);
  const refSubmitted = await submitInfoResponse({ rawToken: tokenFromMail(refWorld), requestId: refRequest.request.id, deps: refWorld.deps });
  assert.equal(refSubmitted.request.status, 'CANDIDATE_RESPONDED');
});

// ── REASSIGNMENT (#43-45) ─────────────────────────────────────────
test('30.9 #43-45 reassignment: request survives; old verifier out; new verifier reviews/resolves', async () => {
  const world = makeWorld();
  const created = await createRequest(world, V_ID);
  const portalToken = tokenFromMail(world);
  await uploadResponseFile({
    rawToken: portalToken,
    requestId: created.request.id,
    file: { buffer: Buffer.from('candidate-v2'), originalname: 'letter-v2.pdf', mimetype: 'application/pdf', size: 12 },
    deps: world.deps,
  });
  await submitInfoResponse({ rawToken: portalToken, requestId: created.request.id, deps: world.deps });

  world.state.currentVerifier = V2_ID; // Super Admin reassignment
  // #44 old verifier loses everything.
  await assert.rejects(
    verifierListRequests({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', deps: world.deps }),
    (err) => err.statusCode === 404
  );
  // #43 request + history intact, original requester preserved.
  const list = await verifierListRequests({ verifierId: V2_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', deps: world.deps });
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].requestedByVerifierId, V_ID);
  assert.equal(list.requests[0].responseFiles.length, 1);
  // #45 new verifier resolves.
  const resolved = await resolveInfoRequest({ verifierId: V2_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', requestId: created.request.id, deps: world.deps });
  assert.equal(resolved.request.status, 'RESOLVED');
  // Candidate can still respond while open after reassignment (portal is
  // bound to the case token, never to a verifier id).
  const openWorld = makeWorld();
  await createRequest(openWorld, V_ID);
  openWorld.state.currentVerifier = V2_ID;
  const candidateView = await listCandidateRequests({ rawToken: tokenFromMail(openWorld), deps: openWorld.deps });
  assert.equal(candidateView.requests[0].status, 'OPEN');
});

// ── BUSINESS + REGRESSION (#46-60) ────────────────────────────────
test('30.9 #46-60 business safety & regression: no charge, no pipeline, no DigiLocker, suites wired', async () => {
  const world = makeWorld();
  const orderBefore = JSON.stringify(world.order);
  await createRequest(world, V_ID);
  assert.equal(JSON.stringify(world.order), orderBefore); // #46/#47 commercial snapshot untouched

  const service = stripComments(readFileSync(new URL('../src/services/bgv/bgvInfoRequestService.js', import.meta.url), 'utf8'));
  const lower = service.toLowerCase();
  assert.ok(!/razorpay/.test(lower)); // #46
  assert.ok(!/currentstage|pipeline/.test(lower)); // #49
  assert.ok(!/\bclear\b/.test(lower)); // #50
  assert.ok(!/digilocker\.(in|gov)|digilocker_client/i.test(lower)); // #51
  assert.ok(!/\brejected?\b|\bhire[ds]?\b/.test(lower)); // #48
  // No credential-shaped categories exist in the registry.
  const rules = stripComments(readFileSync(new URL('../src/services/bgv/bgvInfoRequestRules.js', import.meta.url), 'utf8')).toLowerCase();
  for (const banned of ['password', 'otp', 'credential', 'epfo_password', 'digilocker_login']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`).test(rules), `registry must not contain ${banned}`);
  }
  // Regression suites wired (30.1-30.8 + 27.15).
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const suite of [
    'test/bgvDecision.test.js',
    'test/bgvCatalogue.test.js',
    'test/bgvOrder.test.js',
    'test/bgvConsent.test.js',
    'test/bgvCollection.test.js',
    'test/bgvVerifier.test.js',
    'test/bgvAssignment.test.js',
    'test/bgvWorkbench.test.js',
    'test/backgroundVerification.test.js',
  ]) {
    assert.ok(pkg.scripts['test:all'].includes(suite), `test:all must run ${suite}`);
  }
  // Cancel path: OPEN → CANCELLED preserves the document.
  const cancelWorld = makeWorld();
  const toCancel = await createRequest(cancelWorld, V_ID, 'HR_CONTACT', 'need hr contact');
  const cancelled = await cancelInfoRequest({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', requestId: toCancel.request.id, deps: cancelWorld.deps });
  assert.equal(cancelled.request.status, 'CANCELLED');
  assert.equal(cancelWorld.state.requests.length, 1); // history preserved
  assert.equal(cancelWorld.state.verifications[0].state, 'IN_PROGRESS'); // left waiting state
  // A resolved request cannot be resolved twice.
  await assert.rejects(
    resolveInfoRequest({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', requestId: toCancel.request.id, deps: cancelWorld.deps }),
    (err) => err.statusCode === 409
  );
  void ADMIN;
});
