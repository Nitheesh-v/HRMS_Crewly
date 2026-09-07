// Phase 30.8 — INTERNAL BGV VERIFICATION WORKBENCH (hermetic suite).
// No MongoDB/Redis/SMTP/storage: every collaborator is injected. Fakes
// simulate the append-only pipeline updates, the submission-lock
// conditional write, and the private storage contract, so history
// immutability and locking are genuinely exercised.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  METHOD_REGISTRY,
  VERIFIER_CONCLUSIONS,
  buildWorkbenchView,
  evaluateConclusionReadiness,
  sanitizeDiscrepancy,
  sanitizeNotes,
  sanitizeObservations,
} from '../src/services/bgv/bgvWorkbenchRules.js';
import {
  cancelCheckByOperations,
  downloadActivityEvidence,
  recordActivity,
  recordDiscrepancy,
  setWorkbenchState,
  submitConclusion,
  uploadActivityEvidence,
} from '../src/services/bgv/bgvWorkbenchService.js';

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
const V_ID = 'ver111111111111111111111'; // assigned verifier
const V2_ID = 'ver222222222222222222222'; // other verifier

const makeWorld = ({ checkType = 'EMPLOYMENT', assignedVerifier = V_ID } = {}) => {
  const state = { verifications: [], evidenceFiles: [], audits: [], nextId: 0 };

  const order = {
    _id: ORDER_ID,
    companyId: COMPANY_ID,
    candidate: CANDIDATE_ID,
    orderCode: 'BGV-2026-0001',
    status: 'PAID',
    openKey: 'OPEN',
    items: [{ type: checkType }],
  };

  const deps = {
    loadOrderById: async ({ orderId }) => (String(orderId) === ORDER_ID ? { ...order } : null),
    loadCase: async () => ({ _id: CASE_ID, companyId: COMPANY_ID, bgvOrder: ORDER_ID, status: 'SUBMITTED' }),
    // 30.7 assignment: the access key. currentVerifier drives former-verifier tests.
    findAssignment: async ({ orderId, checkType: ct }) => {
      if (String(orderId) !== ORDER_ID || ct !== state.checkType) return null;
      if (!state.currentVerifier) return null;
      return { _id: 'asg-1', bgvOrder: ORDER_ID, checkType: ct, verifier: state.currentVerifier, status: 'IN_PROGRESS', activeKey: 'CURRENT' };
    },
    findVerification: async ({ orderId, checkType: ct }) => {
      const found = state.verifications.find((v) => String(v.bgvOrder) === String(orderId) && v.checkType === ct && v.activeKey === 'CURRENT');
      return found ? { ...found } : null;
    },
    insertVerification: async (doc) => {
      const clash = state.verifications.some((v) => String(v.bgvOrder) === String(doc.bgvOrder) && v.checkType === doc.checkType && v.activeKey === 'CURRENT');
      if (clash) {
        const err = new Error('duplicate');
        err.code = 11000;
        throw err;
      }
      const created = { _id: `vfy-${state.nextId++}`, activeKey: 'CURRENT', ...doc };
      state.verifications.push(created);
      return { ...created };
    },
    // Simulates the atomic pipeline append (conditional on conclusion null).
    appendActivity: async ({ verificationId, activity }) => {
      const found = state.verifications.find((v) => String(v._id) === String(verificationId));
      if (!found || found.conclusion) return null;
      found.activities = [...(found.activities || []), { ...activity, seq: (found.activities || []).length + 1 }];
      return { ...found };
    },
    appendDiscrepancy: async ({ verificationId, discrepancy }) => {
      const found = state.verifications.find((v) => String(v._id) === String(verificationId));
      if (!found || found.conclusion) return null;
      found.discrepancies = [...(found.discrepancies || []), discrepancy];
      return { ...found };
    },
    updateVerificationState: async ({ verificationId, onlyStates, set }) => {
      const found = state.verifications.find((v) => String(v._id) === String(verificationId));
      if (!found || found.conclusion) return null;
      if (onlyStates && !onlyStates.includes(found.state)) return null;
      Object.assign(found, set);
      return { ...found };
    },
    // Simulates the submission-lock conditional write.
    submitConclusion: async ({ verificationId, conclusion }) => {
      const found = state.verifications.find((v) => String(v._id) === String(verificationId));
      if (!found || found.conclusion) return null;
      found.conclusion = conclusion;
      found.state = 'SUBMITTED';
      return { ...found };
    },
    insertEvidenceFile: async (doc) => {
      const created = { _id: `evf-${state.nextId++}`, status: 'ACTIVE', ...doc };
      state.evidenceFiles.push(created);
      return { ...created };
    },
    loadEvidenceFile: async ({ fileId }) => {
      const found = state.evidenceFiles.find((f) => String(f._id) === String(fileId));
      return found ? { ...found } : null;
    },
    attachEvidence: async ({ verificationId, activitySeq, evidenceFileId }) => {
      const found = state.verifications.find((v) => String(v._id) === String(verificationId));
      if (!found || found.conclusion) return null;
      const activity = (found.activities || []).find((a) => a.seq === activitySeq);
      if (!activity) return null;
      activity.evidenceFile = evidenceFileId;
      return { ...found };
    },
    storeFile: async ({ buffer }) => ({ storageProvider: 'LOCAL_PRIVATE', storageKey: `key-${buffer.length}` }),
    fetchFile: async ({ storageKey }) => Buffer.from(`bytes:${storageKey}`),
    audit: async (entry) => state.audits.push(entry),
  };

  state.checkType = checkType;
  state.currentVerifier = assignedVerifier;
  return { state, deps, order };
};

const record = (world, verifierId, method, outcome, observations = {}, notes = '', checkType = world.state.checkType) =>
  recordActivity({ verifierId, orderId: ORDER_ID, checkType, method, outcome, observations, notes, deps: world.deps });

// ── AUTHORIZATION (#1-6) ──────────────────────────────────────────
test('30.8 #1-6 authorization: assigned verifier works; unassigned/former/deactivated/specialization-only denied; cannot submit another verifier check', async () => {
  // #1 assigned active verifier records an activity.
  {
    const world = makeWorld();
    const result = await record(world, V_ID, 'DOCUMENT_REVIEW', 'COMPLETED', { matches: 'MATCH' });
    assert.equal(result.activity.seq, 1);
  }
  // #2 unassigned verifier denied.
  {
    const world = makeWorld();
    await assert.rejects(record(world, V2_ID, 'DOCUMENT_REVIEW', 'COMPLETED'), (err) => err.statusCode === 404);
  }
  // #3 former verifier loses access immediately after reassignment.
  {
    const world = makeWorld();
    await record(world, V_ID, 'DOCUMENT_REVIEW', 'COMPLETED');
    world.state.currentVerifier = V2_ID; // reassignment happened
    await assert.rejects(record(world, V_ID, 'HR_TELEPHONE', 'CONTACTED'), (err) => err.statusCode === 404);
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', deps: world.deps }),
      (err) => err.statusCode === 404
    );
  }
  // #4 deactivated verifier: session resolution (30.6) refuses non-ACTIVE.
  {
    const source = readFileSync(new URL('../src/services/bgv/bgvVerifierService.js', import.meta.url), 'utf8');
    assert.ok(/status !== 'ACTIVE'\) return null/.test(source), 'resolveVerifierSession must refuse non-ACTIVE verifiers');
    const routes = readFileSync(new URL('../src/routes/bgvVerifierWorkRoutes.js', import.meta.url), 'utf8');
    assert.ok(/router\.use\(requireVerifierAuth/.test(routes));
  }
  // #5 specialization alone grants nothing (no assignment → 404).
  {
    const world = makeWorld({ checkType: 'EDUCATION' });
    world.state.currentVerifier = null; // eligible by specialization, not assigned
    await assert.rejects(record(world, V_ID, 'CERTIFICATE_REVIEW', 'COMPLETED', {}, '', 'EDUCATION'), (err) => err.statusCode === 404);
  }
  // #6 cannot submit another verifier's check (covered in #3 submit path).
});

// ── METHOD REGISTRY (#7-13) ───────────────────────────────────────
test('30.8 #7-13 registry: per-check allowlists enforced; cross-check and arbitrary methods rejected', async () => {
  const cases = [
    ['IDENTITY', 'DOCUMENT_REVIEW', 'COMPLETED'],
    ['ADDRESS', 'TELEPHONE_VERIFICATION', 'CONTACTED'],
    ['EDUCATION', 'INSTITUTION_PORTAL', 'COMPLETED'],
    ['EMPLOYMENT', 'OFFICIAL_HR_EMAIL', 'RESPONSE_RECEIVED'],
    ['REFERENCE', 'TELEPHONE_REFERENCE', 'CONTACTED'],
  ];
  for (const [checkType, method, outcome] of cases) {
    const world = makeWorld({ checkType });
    const result = await record(world, V_ID, method, outcome, {}, '', checkType);
    assert.equal(result.activity.method, method);
  }
  // #12 method belonging to another check is rejected.
  {
    const world = makeWorld({ checkType: 'EDUCATION' });
    await assert.rejects(record(world, V_ID, 'HR_TELEPHONE', 'CONTACTED', {}, '', 'EDUCATION'), (err) => err.statusCode === 400);
  }
  // #13 arbitrary method rejected; invalid outcome for a valid method rejected.
  {
    const world = makeWorld();
    await assert.rejects(record(world, V_ID, 'ASTROLOGY_CHECK', 'COMPLETED'), (err) => err.statusCode === 400);
    await assert.rejects(record(world, V_ID, 'DOCUMENT_REVIEW', 'NO_RESPONSE'), (err) => err.statusCode === 400);
  }
  // Registry matches the exact controlled names.
  assert.deepEqual(METHOD_REGISTRY.EMPLOYMENT, ['DOCUMENT_REVIEW', 'OFFICIAL_HR_EMAIL', 'HR_TELEPHONE', 'SUPPORTING_SALARY_EVIDENCE', 'UAN_EPFO_SUPPORTING_EVIDENCE']);
  assert.deepEqual(METHOD_REGISTRY.REFERENCE, ['TELEPHONE_REFERENCE', 'EMAIL_REFERENCE', 'RELATIONSHIP_AUTHENTICITY_CHECK']);
});

// ── HISTORY (#14-18) ──────────────────────────────────────────────
test('30.8 #14-18 history: append-only, ordered, per-check, immutable after submission', async () => {
  const world = makeWorld();
  const first = await record(world, V_ID, 'OFFICIAL_HR_EMAIL', 'NO_RESPONSE', { officialDomain: true });
  assert.equal(first.activity.seq, 1);
  const second = await record(world, V_ID, 'HR_TELEPHONE', 'CONTACTED', {});
  assert.equal(second.activity.seq, 2);
  // #15/#16 first attempt intact; ordering preserved.
  const activities = world.state.verifications[0].activities;
  assert.equal(activities.length, 2);
  assert.equal(activities[0].method, 'OFFICIAL_HR_EMAIL');
  assert.equal(activities[0].outcome, 'NO_RESPONSE');
  assert.ok(activities[1].at >= activities[0].at);
  // #17 activities are scoped to the assigned check document.
  assert.equal(world.state.verifications.length, 1);
  assert.equal(world.state.verifications[0].checkType, 'EMPLOYMENT');
  // #18 submitted history cannot be appended to or overwritten.
  await submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', deps: world.deps });
  await assert.rejects(record(world, V_ID, 'HR_TELEPHONE', 'CONTACTED'), (err) => err.statusCode === 409);
  await assert.rejects(
    recordDiscrepancy({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', input: { field: 'X', candidateClaimed: 'a', sourceConfirmed: 'b', explanation: 'because reasons' }, deps: world.deps }),
    (err) => err.statusCode === 409
  );
  assert.equal(world.state.verifications[0].activities.length, 2);
});

// ── IDENTITY (#19-23) ─────────────────────────────────────────────
test('30.8 #19-23 identity: document review, explicit manual selfie comparison, QR provenance, DigiLocker-assisted honesty, no credentials', async () => {
  const world = makeWorld({ checkType: 'IDENTITY' });
  // #19 document review recorded.
  const doc = await record(world, V_ID, 'DOCUMENT_REVIEW', 'COMPLETED', { documentType: 'AADHAAR', matches: 'MATCH' }, '', 'IDENTITY');
  assert.equal(doc.activity.observations.matches, 'MATCH');
  // #20 selfie comparison is explicitly manual (no biometrics anywhere).
  const selfie = await record(world, V_ID, 'SELFIE_MANUAL_COMPARISON', 'COMPLETED', { comparison: 'MATCH', manualComparison: true }, '', 'IDENTITY');
  assert.equal(selfie.activity.observations.manualComparison, true);
  const rules = readFileSync(new URL('../src/services/bgv/bgvWorkbenchRules.js', import.meta.url), 'utf8');
  assert.ok(!/facial.?recognition|biometric/i.test(stripComments(rules)));
  // #21 QR/issuer provenance recorded.
  const qr = await record(world, V_ID, 'QR_ISSUER_VERIFICATION', 'COMPLETED', {
    issuer: 'UIDAI sample issuer page',
    mechanism: 'manual public verification page',
    verifiedAt: new Date().toISOString(),
    established: 'document number masked value consistent with QR payload',
  }, '', 'IDENTITY');
  assert.equal(qr.activity.observations.issuer, 'UIDAI sample issuer page');
  // #22 DigiLocker-assisted never claims API authentication.
  const dl = await record(world, V_ID, 'DIGILOCKER_ISSUER_ASSISTED', 'COMPLETED', {
    originRepresentation: 'CANDIDATE_PROVIDED_DIGILOCKER',
    issuer: 'CBSE',
    mechanism: 'issuer public verification portal',
    established: 'certificate matches candidate-provided DigiLocker-originated copy',
  }, '', 'IDENTITY');
  assert.equal(dl.activity.observations.originRepresentation, 'CANDIDATE_PROVIDED_DIGILOCKER');
  const service = stripComments(readFileSync(new URL('../src/services/bgv/bgvWorkbenchService.js', import.meta.url), 'utf8'));
  assert.ok(!/digilocker\.(in|gov)|DIGILOCKER_CLIENT|api\.digilocker/i.test(service));
  // #23 credential-shaped fields are rejected, never stored.
  await assert.rejects(
    record(world, V_ID, 'DIGILOCKER_ISSUER_ASSISTED', 'COMPLETED', { password: 'hunter2', otp: '123456' }, '', 'IDENTITY'),
    (err) => err.statusCode === 400
  );
  assert.ok(!world.state.verifications[0].activities.some((a) => JSON.stringify(a.observations).includes('hunter2')));
});

// ── ADDRESS (#24-26) ──────────────────────────────────────────────
test('30.8 #24-26 address: document review, phone attempts, field verification without fabricated geolocation', async () => {
  const world = makeWorld({ checkType: 'ADDRESS' });
  await record(world, V_ID, 'DOCUMENT_REVIEW', 'COMPLETED', { evidenceType: 'UTILITY_BILL', matches: 'MATCH' }, '', 'ADDRESS');
  // #25 two phone attempts — attempt 1 preserved.
  await record(world, V_ID, 'TELEPHONE_VERIFICATION', 'NO_RESPONSE', { recipientDescriptor: 'listed landline' }, '', 'ADDRESS');
  await record(world, V_ID, 'TELEPHONE_VERIFICATION', 'CONTACTED', { recipientDescriptor: 'listed landline' }, '', 'ADDRESS');
  assert.equal(world.state.verifications[0].activities.length, 3);
  // #26 field verification: structured fields, geolocation keys rejected.
  const field = await record(world, V_ID, 'FIELD_VERIFICATION', 'COMPLETED', {
    visitDate: new Date().toISOString(),
    located: 'LOCATED',
    residenceConfirmed: 'CONFIRMED',
  }, '', 'ADDRESS');
  assert.equal(field.activity.observations.located, 'LOCATED');
  assert.throws(
    () => sanitizeObservations({ checkType: 'ADDRESS', method: 'FIELD_VERIFICATION', observations: { lat: 11.0, gps: 'x,y', located: 'LOCATED' } }),
    (err) => err.statusCode === 400
  );
});

// ── EDUCATION (#27-31) ────────────────────────────────────────────
test('30.8 #27-31 education: certificate/portal/email activities; no-response supports UNABLE_TO_VERIFY without fake-degree inference', async () => {
  const world = makeWorld({ checkType: 'EDUCATION' });
  await record(world, V_ID, 'CERTIFICATE_REVIEW', 'COMPLETED', { institution: 'PSG Tech', qualification: 'B.E. CSE', matches: 'MATCH' }, '', 'EDUCATION');
  await record(world, V_ID, 'INSTITUTION_PORTAL', 'COMPLETED', { portal: 'university results portal', established: 'roll number listed for 2018 batch' }, '', 'EDUCATION');
  await record(world, V_ID, 'INSTITUTION_EMAIL', 'NO_RESPONSE', { institution: 'PSG Tech', officialDomain: true, responseReceived: false }, '', 'EDUCATION');
  // #31 no automatic conclusion exists: after no-response the check is
  // still open (no "fake degree" inference anywhere in the service).
  assert.equal(world.state.verifications[0].conclusion, null);
  assert.equal(world.state.verifications[0].state, 'IN_PROGRESS');
  // #30 no-response context legitimately supports UNABLE_TO_VERIFY.
  const submitted = await submitConclusion({
    verifierId: V_ID,
    orderId: ORDER_ID,
    checkType: 'EDUCATION',
    conclusion: 'UNABLE_TO_VERIFY',
    reason: 'Institution did not respond after two documented attempts',
    deps: world.deps,
  });
  assert.equal(submitted.conclusion.value, 'UNABLE_TO_VERIFY');
});

// ── EMPLOYMENT (#32-37) ───────────────────────────────────────────
test('30.8 #32-37 employment: official vs personal email, phone, independent facts, UAN last-4 only and never a sole basis', async () => {
  const world = makeWorld();
  // #32 official HR email.
  const official = await record(world, V_ID, 'OFFICIAL_HR_EMAIL', 'RESPONSE_RECEIVED', {
    employer: 'Infolexus',
    officialDomain: true,
    responseReceived: true,
    designationConfirmed: 'CONFIRMED',
    startDateConfirmed: 'CONFIRMED',
    endDateConfirmed: 'DISCREPANT',
  });
  assert.equal(official.activity.observations.officialDomain, true);
  // #33 personal email is stored as NOT official — never coerced/mislabelled.
  const personal = await record(world, V_ID, 'OFFICIAL_HR_EMAIL', 'RESPONSE_RECEIVED', {
    employer: 'Infolexus',
    officialDomain: false,
    responseReceived: true,
  });
  assert.equal(personal.activity.observations.officialDomain, false);
  // #34 telephone method.
  await record(world, V_ID, 'HR_TELEPHONE', 'CONTACTED', { employer: 'Infolexus' });
  // #35 facts recorded independently (designation confirmed, end date discrepant).
  assert.equal(official.activity.observations.designationConfirmed, 'CONFIRMED');
  assert.equal(official.activity.observations.endDateConfirmed, 'DISCREPANT');
  // #36 UAN: last four only; a full UAN field is rejected.
  const uan = await record(world, V_ID, 'UAN_EPFO_SUPPORTING_EVIDENCE', 'COMPLETED', { uanLast4: '123456789012', recordsConsistent: 'CONSISTENT' });
  assert.equal(uan.activity.observations.uanLast4, '9012');
  assert.throws(
    () => sanitizeObservations({ checkType: 'EMPLOYMENT', method: 'UAN_EPFO_SUPPORTING_EVIDENCE', observations: { uan: '999988887777' } }),
    (err) => err.statusCode === 400
  );
  const stored = JSON.stringify(world.state.verifications[0].activities);
  assert.ok(!stored.includes('999988887777') && !stored.includes('123456789012'));
  // #37 UAN/supporting evidence alone never yields VERIFIED.
  {
    const uanWorld = makeWorld();
    await record(uanWorld, V_ID, 'UAN_EPFO_SUPPORTING_EVIDENCE', 'COMPLETED', { uanLast4: '4321', recordsConsistent: 'CONSISTENT' });
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', deps: uanWorld.deps }),
      (err) => err.statusCode === 400
    );
    await record(uanWorld, V_ID, 'OFFICIAL_HR_EMAIL', 'RESPONSE_RECEIVED', { employer: 'Infolexus', officialDomain: true, responseReceived: true });
    const ok = await submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', deps: uanWorld.deps });
    assert.equal(ok.conclusion.value, 'VERIFIED');
  }
});

// ── REFERENCE (#38-42) ────────────────────────────────────────────
test('30.8 #38-42 reference: standardized questionnaire; phone/email attempts; no-response not a candidate failure; no sensitive questions', async () => {
  const world = makeWorld({ checkType: 'REFERENCE' });
  // #38/#39 standardized questionnaire over phone.
  const phone = await record(world, V_ID, 'TELEPHONE_REFERENCE', 'CONTACTED', {
    relationship: 'Former manager',
    periodKnown: '2020-2024',
    roleSummary: 'Analyst on the data team',
    strengths: 'Ownership and clarity',
    reliability: 'STRONG',
    professionalBehavior: 'Consistently professional',
    rehireEligible: 'YES',
    comments: 'Would work together again',
  }, '', 'REFERENCE');
  assert.equal(phone.activity.observations.reliability, 'STRONG');
  assert.equal(phone.activity.observations.rehireEligible, 'YES');
  // #40 email reference attempt with no response.
  await record(world, V_ID, 'EMAIL_REFERENCE', 'NO_RESPONSE', { relationship: 'Former colleague' }, '', 'REFERENCE');
  // #41 no-response never produces an automatic failure — the check stays open.
  assert.equal(world.state.verifications[0].conclusion, null);
  // #42 arbitrary/sensitive questions are not part of the schema — dropped.
  const sanitized = sanitizeObservations({
    checkType: 'REFERENCE',
    method: 'TELEPHONE_REFERENCE',
    observations: { maritalStatus: 'married', religion: 'x', politicalViews: 'y', relationship: 'Former manager' },
  });
  assert.deepEqual(Object.keys(sanitized), ['relationship']);
});

// ── CONCLUSIONS (#43-50) ──────────────────────────────────────────
test('30.8 #43-50 conclusions: readiness engine, discrepancy pairing, locking, idempotency, invalid values, verifier cannot CANCEL', async () => {
  // #43 zero-work VERIFIED rejected.
  {
    const world = makeWorld();
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', deps: world.deps }),
      (err) => err.statusCode === 400 && /primary verification activity/.test(err.message)
    );
  }
  // #44 valid VERIFIED succeeds.
  {
    const world = makeWorld();
    await record(world, V_ID, 'HR_TELEPHONE', 'CONTACTED', { employer: 'Infolexus' });
    const ok = await submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', deps: world.deps });
    assert.equal(ok.idempotent, false);
    assert.equal(ok.conclusion.value, 'VERIFIED');
    assert.ok(world.state.audits.some((a) => a.action === 'BGV_CHECK_CONCLUSION_SUBMITTED'));
  }
  // #45 VERIFIED_WITH_DISCREPANCY requires a structured discrepancy.
  {
    const world = makeWorld();
    await record(world, V_ID, 'OFFICIAL_HR_EMAIL', 'RESPONSE_RECEIVED', { employer: 'Infolexus', officialDomain: true, responseReceived: true, endDateConfirmed: 'DISCREPANT' });
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED_WITH_DISCREPANCY', deps: world.deps }),
      (err) => err.statusCode === 400 && /structured discrepancy/.test(err.message)
    );
    await recordDiscrepancy({
      verifierId: V_ID,
      orderId: ORDER_ID,
      checkType: 'EMPLOYMENT',
      input: { field: 'EMPLOYMENT_END_DATE', candidateClaimed: '2025-03-31', sourceConfirmed: '2025-02-28', severity: 'MINOR', explanation: 'HR confirmed last working day as 28 Feb' },
      deps: world.deps,
    });
    const ok = await submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED_WITH_DISCREPANCY', deps: world.deps });
    assert.equal(ok.conclusion.value, 'VERIFIED_WITH_DISCREPANCY');
    // VERIFIED with recorded discrepancies is refused (must pair correctly).
    const world2 = makeWorld();
    await record(world2, V_ID, 'HR_TELEPHONE', 'CONTACTED', {});
    await recordDiscrepancy({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', input: { field: 'DESIGNATION', candidateClaimed: 'Manager', sourceConfirmed: 'Analyst', severity: 'MAJOR', explanation: 'HR states analyst title' }, deps: world2.deps });
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', deps: world2.deps }),
      (err) => err.statusCode === 400 && /VERIFIED_WITH_DISCREPANCY instead/.test(err.message)
    );
  }
  // #46/#47 UNABLE_TO_VERIFY and INCONCLUSIVE require reason/context.
  {
    const world = makeWorld();
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'UNABLE_TO_VERIFY', reason: '', deps: world.deps }),
      (err) => err.statusCode === 400
    );
    await record(world, V_ID, 'OFFICIAL_HR_EMAIL', 'NO_RESPONSE', {});
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'INCONCLUSIVE', reason: 'short', deps: world.deps }),
      (err) => err.statusCode === 400
    );
    const ok = await submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'INCONCLUSIVE', reason: 'Partial records conflict; awaiting callback', deps: world.deps });
    assert.equal(ok.conclusion.value, 'INCONCLUSIVE');
  }
  // #48 duplicate submission by the same verifier is idempotent.
  {
    const world = makeWorld();
    await record(world, V_ID, 'HR_TELEPHONE', 'CONTACTED', {});
    await submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', deps: world.deps });
    const again = await submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', deps: world.deps });
    assert.equal(again.idempotent, true);
    // #49 locked: a DIFFERENT conclusion or another verifier is refused.
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'INCONCLUSIVE', reason: 'changed my mind later', deps: world.deps }),
      (err) => err.statusCode === 409
    );
    await assert.rejects(
      setWorkbenchState({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', state: 'AWAITING_THIRD_PARTY', deps: world.deps }),
      (err) => err.statusCode === 409
    );
  }
  // #50 invalid conclusion rejected; CANCELLED is never a verifier choice.
  {
    const world = makeWorld();
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'FAILED', deps: world.deps }),
      (err) => err.statusCode === 403
    );
    await assert.rejects(
      submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'CANCELLED', reason: 'no longer needed here', deps: world.deps }),
      (err) => err.statusCode === 403
    );
    assert.ok(!VERIFIER_CONCLUSIONS.includes('CANCELLED'));
  }
});

// ── SECURITY (#51-61) ─────────────────────────────────────────────
test('30.8 #51-61 security: cross-check evidence denied, private storage, redacted audit, no queues, no pipeline mutation, no DigiLocker API', async () => {
  // #51 evidence of an unrelated check denied (assignment is check-scoped).
  {
    const world = makeWorld({ checkType: 'IDENTITY' });
    world.state.evidenceFiles.push({
      _id: 'evf-emp', bgvOrder: ORDER_ID, checkType: 'EMPLOYMENT', status: 'ACTIVE',
      storageProvider: 'LOCAL_PRIVATE', storageKey: 'k', originalFileName: 'letter.pdf',
      mimeType: 'application/pdf', checksumSha256: 'x', fileSize: 10,
    });
    await assert.rejects(
      downloadActivityEvidence({ verifierId: V_ID, fileId: 'evf-emp', deps: world.deps }),
      (err) => err.statusCode === 404
    );
  }
  // #52-54 upload → private store; download DTO has no URL; audit redacted.
  {
    const world = makeWorld();
    const activity = await record(world, V_ID, 'OFFICIAL_HR_EMAIL', 'RESPONSE_RECEIVED', { employer: 'Infolexus', officialDomain: true, responseReceived: true });
    const uploaded = await uploadActivityEvidence({
      verifierId: V_ID,
      orderId: ORDER_ID,
      checkType: 'EMPLOYMENT',
      activitySeq: activity.activity.seq,
      file: { buffer: Buffer.from('pdf-bytes'), originalname: 'hr-response.pdf', mimetype: 'application/pdf', size: 9 },
      deps: world.deps,
    });
    assert.ok(!('url' in uploaded));
    const uploadAudit = world.state.audits.find((a) => a.action === 'BGV_VERIFIER_EVIDENCE_UPLOADED');
    assert.ok(uploadAudit);
    assert.ok(!JSON.stringify(uploadAudit.metadata).includes('storageKey'));
    const file = await downloadActivityEvidence({ verifierId: V_ID, fileId: uploaded.id, deps: world.deps });
    assert.equal(file.fileName, 'hr-response.pdf');
    assert.equal(file.buffer.toString(), 'bytes:key-9');
    assert.deepEqual(Object.keys(file).sort(), ['buffer', 'checksum', 'fileName', 'mimeType']);
    const readAudit = world.state.audits.find((a) => a.action === 'BGV_VERIFIER_EVIDENCE_READ');
    assert.ok(readAudit && !JSON.stringify(readAudit.metadata).includes('hr-response.pdf'));
  }
  // #53 structural: verifier evidence upload uses the hardened uploader.
  {
    const routes = readFileSync(new URL('../src/routes/bgvVerifierWorkRoutes.js', import.meta.url), 'utf8');
    assert.ok(/preOnboardingUpload, bgvVerifierEvidenceUpload/.test(routes));
    const model = readFileSync(new URL('../src/models/BgvVerifierEvidenceFile.js', import.meta.url), 'utf8');
    assert.ok(/storageKey[^\n]*select: false/.test(model));
  }
  // #55 notes/audit redaction: activity audit carries no notes content.
  {
    const world = makeWorld();
    await record(world, V_ID, 'HR_TELEPHONE', 'CONTACTED', {}, 'candidate said Aadhaar 1234 5678 9012 on call');
    const audit = world.state.audits.find((a) => a.action === 'BGV_CHECK_ACTIVITY_RECORDED');
    assert.ok(!JSON.stringify(audit.metadata).includes('Aadhaar'));
    assert.ok(!JSON.stringify(audit.metadata).includes('1234 5678'));
    assert.equal(sanitizeNotes('x'.repeat(5000)).length, 2000);
  }
  // #56-61 structural scans on the workbench service.
  {
    const service = stripComments(readFileSync(new URL('../src/services/bgv/bgvWorkbenchService.js', import.meta.url), 'utf8'));
    const lower = service.toLowerCase();
    assert.ok(!/bullmq|queue|redis/.test(lower), 'no new queue coupling');
    assert.ok(!/currentstage|pipeline/.test(lower), 'no candidate pipeline mutation');
    assert.ok(!/\bclear\b/.test(lower), 'no automatic BGV CLEAR');
    assert.ok(!/\brejected?\b|reject_candidate/.test(lower), 'no candidate rejection semantics');
    assert.ok(!/\bhire[ds]?\b/.test(lower), 'no hiring semantics');
  }
});

// ── CANCELLATION & WORKBENCH VIEW ─────────────────────────────────
test('30.8 cancellation is platform-only with reason; workbench view mirrors registry; HR/ops see SUBMITTED state', async () => {
  // Verifier-created doc, platform cancels.
  const world = makeWorld();
  await record(world, V_ID, 'HR_TELEPHONE', 'NO_RESPONSE', {});
  await assert.rejects(
    cancelCheckByOperations({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'EMPLOYMENT', reason: 'short', deps: world.deps }),
    (err) => err.statusCode === 400
  );
  const cancelled = await cancelCheckByOperations({ actorId: ADMIN, orderId: ORDER_ID, checkType: 'EMPLOYMENT', reason: 'Order cancelled by tenant operations', deps: world.deps });
  assert.equal(cancelled.conclusion.value, 'CANCELLED');
  assert.equal(String(cancelled.conclusion.submittedBy), ADMIN);
  assert.ok(world.state.audits.some((a) => a.action === 'BGV_CHECK_CANCELLED'));
  // Locked after cancellation.
  await assert.rejects(record(world, V_ID, 'HR_TELEPHONE', 'CONTACTED'), (err) => err.statusCode === 409);

  // Workbench view: registry mirror + lock flag, no conclusion leakage of notes into queue payloads.
  const view = buildWorkbenchView(world.state.verifications[0]);
  assert.equal(view.locked, true);
  assert.deepEqual(view.allowedMethods, METHOD_REGISTRY.EMPLOYMENT);
  assert.deepEqual(view.methodOutcomes.HR_TELEPHONE, ['CONTACTED', 'NO_RESPONSE', 'INVALID_CONTACT', 'RESPONSE_RECEIVED', 'CALLBACK_REQUESTED', 'SOURCE_UNAVAILABLE']);
  assert.ok(!view.verifierConclusions.includes('CANCELLED'));
});

// ── REGRESSION MAP (#62-69) ───────────────────────────────────────
test('30.8 #62-69 regression: phase suites are wired into test:all; verifier auth chain intact', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const all = pkg.scripts['test:all'];
  for (const suite of [
    'test/bgvDecision.test.js', // 30.1
    'test/bgvCatalogue.test.js', // 30.2
    'test/bgvOrder.test.js', // 30.3
    'test/bgvConsent.test.js', // 30.4
    'test/bgvCollection.test.js', // 30.5
    'test/bgvVerifier.test.js', // 30.6
    'test/bgvAssignment.test.js', // 30.7
    'test/backgroundVerification.test.js', // 27.15
  ]) {
    assert.ok(all.includes(suite), `test:all must run ${suite}`);
  }
  // 30.7 authorization chain still exported and used by the workbench.
  const assignmentService = readFileSync(new URL('../src/services/bgv/bgvAssignmentService.js', import.meta.url), 'utf8');
  assert.ok(/export \{ loadOwnAssignment \}/.test(assignmentService));
  const workbench = readFileSync(new URL('../src/services/bgv/bgvWorkbenchService.js', import.meta.url), 'utf8');
  assert.ok(/loadOwnAssignment/.test(workbench));
  // sanitizeDiscrepancy requires all four parts.
  assert.throws(
    () => sanitizeDiscrepancy({ field: 'X', candidateClaimed: '', sourceConfirmed: 'b', explanation: 'c' }),
    (err) => err.statusCode === 400
  );
  // Readiness engine unit: INCONCLUSIVE explanation enforced.
  const readiness = evaluateConclusionReadiness({ conclusion: 'INCONCLUSIVE', reason: 'x', activities: [], discrepancies: [] });
  assert.equal(readiness.ok, false);
});
