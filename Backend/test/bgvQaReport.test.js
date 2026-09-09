// Phase 30.10 — INTERNAL BGV QA REVIEW & FINAL REPORT RELEASE (hermetic).
// No MongoDB/Redis/SMTP: collaborators injected. The PDF step uses the REAL
// PDFKit builder (pure buffer), storage is faked private, and Mongo write
// semantics (conditional updates, arrayFilters) are mirrored by fakes so the
// SERVICE logic under test is the real shipped code.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  computeOverallOutcome,
  evaluateReportReadiness,
} from '../src/services/bgv/bgvQaReportRules.js';
import {
  generateReport,
  platformReportDownload,
  platformReportView,
  qaApprove,
  qaDetail,
  qaEvidenceDownload,
  qaQueue,
  qaReturn,
  releaseReport,
  reportReadiness,
  retryReportPdf,
  tenantReportDownload,
  tenantReportSummary,
} from '../src/services/bgv/bgvQaReportService.js';
import { submitConclusion } from '../src/services/bgv/bgvWorkbenchService.js';
import { PLATFORM_PERMISSIONS, permit } from '../src/middlewares/superAdminAuth.js';

const QA = 'usr111111111111111111111';
const ORDER_ID = '665555555555555555555557';
const COMPANY_A = '665555555555555555555551';
const COMPANY_B = '665555555555555555555552';
const CANDIDATE = '665555555555555555555556';
const V_ID = 'ver111111111111111111111';

const setPath = (target, path, value) => {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    node[parts[i]] = node[parts[i]] || {};
    node = node[parts[i]];
  }
  node[parts.at(-1)] = value;
};

const makeWorld = ({ checks = ['IDENTITY', 'EMPLOYMENT'], companyId = COMPANY_A, storeFile = null } = {}) => {
  const state = {
    verifications: [],
    infoRequests: [],
    reports: [],
    evidence: [{ _id: 'fil111111111111111111111', fileName: 'letter.pdf', mimeType: 'application/pdf', sizeBytes: 10, buffer: Buffer.from('pdf-bytes') }],
    audits: [],
    nextReport: 0,
    companyId,
    checks,
    storeFailure: null,
  };

  const order = {
    _id: ORDER_ID,
    companyId,
    candidate: CANDIDATE,
    orderCode: 'BGVORD-000001',
    status: 'PAID',
    openKey: 'OPEN',
    items: checks.map((type) => ({ type })),
  };
  const collectionCase = {
    _id: 'cas111111111111111111111',
    companyId,
    bgvOrder: ORDER_ID,
    status: 'SUBMITTED',
    purchasedChecks: checks,
    identity: { legalName: 'Priya Raman', documentType: 'PAN', identifierMasked: 'XXXX XXXX 4242' },
  };

  const seedVerification = (checkType, extras = {}) => {
    const verification = {
      _id: `vfy-${checkType}`,
      companyId,
      bgvOrder: ORDER_ID,
      candidate: CANDIDATE,
      checkType,
      state: 'IN_PROGRESS',
      activeKey: 'CURRENT',
      activities: [
        { seq: 1, method: 'DOCUMENT_REVIEW', outcome: 'COMPLETED', verifier: V_ID, at: new Date(), evidenceFile: 'fil111111111111111111111' },
        { seq: 2, method: 'DIGILOCKER_ISSUER_ASSISTED', outcome: 'COMPLETED', verifier: V_ID, at: new Date(), evidenceFile: null },
      ],
      discrepancies: [],
      conclusion: null,
      submissions: [],
      qaStatus: 'NONE',
      qaReturnReason: '',
      qa: { status: 'NONE', currentRevision: 0 },
      ...extras,
    };
    state.verifications.push(verification);
    return verification;
  };

  const applyUpdate = (verification, { set = {}, push = {} }) => {
    for (const [path, value] of Object.entries(set)) {
      if (path.startsWith('submissions.$[s].')) {
        const field = path.split('.').slice(2).join('.');
        const target = (verification.submissions || []).find((entry) => entry.revision === verification.qa?.currentRevision);
        if (target) setPath(target, field, value);
      } else {
        setPath(verification, path, value);
      }
    }
    if (push.submissions) verification.submissions = [...(verification.submissions || []), push.submissions];
  };

  const deps = {
    loadOrderById: async ({ orderId }) => (String(orderId) === String(order._id) ? { ...order } : null),
    loadCompany: async () => ({ name: 'Infolexus Tech' }),
    loadCandidate: async () => ({ name: 'Priya Raman', email: 'priya@example.test' }),
    loadCase: async () => ({ ...collectionCase }),
    listSubmittedCases: async () => [{ ...collectionCase }],
    listVerifications: async ({ orderId }) => state.verifications.filter((v) => String(v.bgvOrder) === String(orderId)).map((v) => ({ ...v })),
    findVerification: async ({ orderId, checkType }) => {
      const found = state.verifications.find((v) => String(v.bgvOrder) === String(orderId) && v.checkType === checkType && v.activeKey === 'CURRENT');
      return found ? { ...found } : null;
    },
    countOpenInfoRequests: async () => state.infoRequests.filter((r) => r.status === 'OPEN').length,
    listInfoRequests: async () => state.infoRequests.map((r) => ({ ...r })),
    findAssignment: async ({ orderId, checkType }) => ({ _id: 'asg-1', bgvOrder: orderId, checkType, verifier: V_ID, status: 'IN_PROGRESS', activeKey: 'CURRENT' }),
    insertVerification: async (doc) => {
      const created = { _id: `vfy-new-${state.verifications.length}`, activities: [], discrepancies: [], submissions: [], conclusion: null, qaStatus: 'NONE', qa: { status: 'NONE', currentRevision: 0 }, ...doc };
      state.verifications.push(created);
      return { ...created };
    },
    // Mirrors defaultSubmitConclusion's conditional write ($nin SUBMITTED)
  // and keeps the live store in sync with the returned lean document.
    submitConclusion: async ({ verificationId, conclusion, revision, discrepancyCount }) => {
      const found = state.verifications.find((v) => String(v._id) === String(verificationId));
      if (!found || found.state === 'SUBMITTED') return null;
      applyUpdate(found, {
        set: {
          conclusion,
          state: 'SUBMITTED',
          qaStatus: 'PENDING',
          qaReturnReason: '',
          'qa.status': 'PENDING',
          'qa.currentRevision': revision,
        },
        push: { submissions: { revision, conclusion, discrepancyCountAtSubmission: discrepancyCount, submittedAt: conclusion.submittedAt, qa: { status: 'PENDING' } } },
      });
      return { ...found, conclusion: { ...conclusion }, submissions: found.submissions.map((entry) => ({ ...entry })) };
    },
    approveUpdate: async ({ verificationId, revision, actorId, now }) => {
      const found = state.verifications.find((v) => String(v._id) === String(verificationId));
      if (!found || found.state !== 'SUBMITTED' || found.qaStatus !== 'PENDING' || found.qa?.currentRevision !== revision) return null;
      applyUpdate(found, {
        set: {
          qaStatus: 'APPROVED',
          'qa.status': 'APPROVED',
          'qa.reviewedBy': actorId,
          'qa.reviewedAt': now,
          'submissions.$[s].qa.status': 'APPROVED',
          'submissions.$[s].qa.reviewedAt': now,
        },
      });
      return { ...found, submissions: found.submissions.map((entry) => ({ ...entry, qa: { ...entry.qa } })) };
    },
    returnUpdate: async ({ verificationId, revision, actorId, now, reason }) => {
      const found = state.verifications.find((v) => String(v._id) === String(verificationId));
      if (!found || found.state !== 'SUBMITTED' || found.qaStatus !== 'PENDING' || found.qa?.currentRevision !== revision) return null;
      applyUpdate(found, {
        set: {
          state: 'QA_RETURNED',
          qaStatus: 'RETURNED',
          qaReturnReason: reason,
          'qa.status': 'RETURNED',
          'qa.reviewedBy': actorId,
          'qa.reviewedAt': now,
          'qa.returnReason': reason,
          'submissions.$[s].qa.status': 'RETURNED',
          'submissions.$[s].qa.returnReason': reason,
        },
      });
      return { ...found, submissions: found.submissions.map((entry) => ({ ...entry, qa: { ...entry.qa } })) };
    },
    findReport: async ({ orderId }) => {
      const found = state.reports.filter((r) => String(r.bgvOrder) === String(orderId)).sort((a, b) => b.version - a.version)[0];
      return found ? { ...found, snapshot: { ...found.snapshot }, pdf: { ...found.pdf } } : null;
    },
    findReportForTenant: async ({ companyId: tenantId, candidateId }) => {
      // Same tenant-scoped query as the real default.
      const found = state.reports.find((r) => String(r.companyId) === String(tenantId) && String(r.candidate) === String(candidateId));
      return found ? { ...found } : null;
    },
    insertReport: async (doc) => {
      if (state.reports.some((r) => String(r.bgvOrder) === String(doc.bgvOrder) && r.version === doc.version)) {
        const err = new Error('dup');
        err.code = 11000;
        throw err;
      }
      const created = { _id: `rpt-${state.nextReport++}`, pdf: { status: 'NONE' }, history: doc.history || [], ...doc };
      state.reports.push(created);
      return { ...created };
    },
    updateReport: async ({ reportId, filter = {}, set, push }) => {
      const found = state.reports.find((r) => String(r._id) === String(reportId));
      if (!found) return null;
      for (const [key, value] of Object.entries(filter)) {
        if (found[key] !== value) return null;
      }
      for (const [path, value] of Object.entries(set)) setPath(found, path, value);
      if (push) found.history = [...(found.history || []), push];
      return { ...found };
    },
    storeFile: async ({ buffer }) => {
      if (state.storeFailure) throw state.storeFailure;
      return storeFile ? storeFile(buffer) : { storageProvider: 'LOCAL_PRIVATE', storageKey: `key-${buffer.length}` };
    },
    fetchFile: async ({ storageKey }) => ({ buffer: Buffer.from(`pdf:${storageKey}`) }),
    loadEvidenceFiles: async ({ ids }) => state.evidence.filter((file) => ids.includes(String(file._id))).map((f) => ({ ...f })),
    nextReportCode: async () => {
      state.nextReport += 1;
      return `BGVRPT-${String(state.nextReport).padStart(6, '0')}`;
    },
    audit: async (entry) => state.audits.push(entry),
  };

  return { state, deps, order, collectionCase, seedVerification };
};

const submitReal = (world, checkType, conclusion, reason = 'synthetic finding reason') =>
  submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType, conclusion, reason, deps: world.deps });

// ── QA ACCESS (#1-5) ──────────────────────────────────────────────
test('30.10 #1-5 access: permit() gate; tenant/verifier/support roles denied; QA on platform stack only', async () => {
  const fakeRes = () => {
    const out = { code: 0 };
    out.status = (code) => ((out.code = code), out);
    out.json = () => out;
    return out;
  };
  // #1 platform QA actor passes.
  permit('bgv-qa:review')({ platformPermissions: PLATFORM_PERMISSIONS.PLATFORM_ADMIN }, fakeRes(), () => {});
  permit('bgv-qa:review')({ platformPermissions: ['*'] }, fakeRes(), () => {});
  // #5 unauthorized platform role denied.
  const denied = fakeRes();
  permit('bgv-qa:review')({ platformPermissions: PLATFORM_PERMISSIONS.SUPPORT_ADMIN }, denied, () => {});
  assert.equal(denied.code, 403);
  // #2/#4 tenant tokens never reach the platform gate (separate stacks).
  const routes = readFileSync(new URL('../src/routes/superAdminRoutes.js', import.meta.url), 'utf8');
  const qaBlock = routes.slice(routes.indexOf('/bgv-qa/queue'));
  assert.ok(routes.indexOf('router.use(protect, superAdminSession)') < routes.indexOf('/bgv-qa/queue'));
  assert.ok((qaBlock.match(/permit\("bgv-qa:/g) || []).length >= 10);
  const recruitment = readFileSync(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8');
  assert.ok(!/bgv-qa/.test(recruitment));
  // #3 verifiers have no QA surface (separate principal + routes).
  const verifierRoutes = readFileSync(new URL('../src/routes/bgvVerifierWorkRoutes.js', import.meta.url), 'utf8');
  assert.ok(!/approve|bgv-qa|release/i.test(verifierRoutes.replace(/info-requests/g, '')));
});

// ── READINESS (#6-9) ──────────────────────────────────────────────
test('30.10 #6-9 readiness: unfinished absent; submitted QA-ready; open 30.9 blocks; all purchased required', async () => {
  const world = makeWorld();
  world.seedVerification('IDENTITY');
  world.seedVerification('EMPLOYMENT');
  // #6 unfinished work is not QA-ready and not in the queue.
  let queue = await qaQueue({ deps: world.deps });
  assert.equal(queue.rows.length, 0);
  // #8 submitted finding becomes QA-ready.
  await submitReal(world, 'IDENTITY', 'VERIFIED');
  queue = await qaQueue({ deps: world.deps });
  assert.equal(queue.rows.length, 1);
  assert.equal(queue.rows[0].qaStatus, 'PENDING');
  // #9 report requires ALL purchased checks approved.
  let readiness = await reportReadiness({ orderId: ORDER_ID, deps: world.deps });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.missing.some((entry) => entry.includes('EMPLOYMENT')));
  // #7 unresolved additional-information blocks final readiness.
  await submitReal(world, 'EMPLOYMENT', 'VERIFIED');
  await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'EMPLOYMENT', deps: world.deps });
  world.state.infoRequests.push({ status: 'OPEN' });
  readiness = await reportReadiness({ orderId: ORDER_ID, deps: world.deps });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.missing.some((entry) => entry.includes('additional information')));
  world.state.infoRequests = [];
  readiness = await reportReadiness({ orderId: ORDER_ID, deps: world.deps });
  assert.equal(readiness.ready, true);
});

// ── APPROVAL (#10-13) ─────────────────────────────────────────────
test('30.10 #10-13 approval: approves pending; preserves finding; idempotent; no destructive QA edits', async () => {
  const world = makeWorld();
  world.seedVerification('IDENTITY');
  world.state.verifications[0].discrepancies = [{ field: 'dates', candidateClaimed: 'a', sourceConfirmed: 'b', severity: 'MINOR', explanation: 'x', recordedBy: V_ID }];
  await submitReal(world, 'IDENTITY', 'VERIFIED_WITH_DISCREPANCY', 'minor mismatch explained');
  const approved = await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  assert.equal(approved.verification.qaStatus, 'APPROVED');
  // #11 verifier finding preserved untouched.
  const live = world.state.verifications[0];
  assert.equal(live.conclusion.value, 'VERIFIED_WITH_DISCREPANCY');
  assert.equal(live.submissions[0].qa.status, 'APPROVED');
  // #12 duplicate approval idempotent.
  const again = await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  assert.equal(again.idempotent, true);
  // #13 approved findings cannot be destructively edited by anyone: QA
  // cannot return an approved revision, and the verifier cannot resubmit
  // over it — the approval is terminal for that revision.
  await assert.rejects(
    submitConclusion({ verifierId: V_ID, orderId: ORDER_ID, checkType: 'IDENTITY', conclusion: 'VERIFIED', reason: 'trying to overwrite approval', deps: world.deps }),
    (err) => err.statusCode === 409
  );
  assert.equal(live.submissions.length, 1);
  assert.equal(live.submissions[0].qa.status, 'APPROVED');
});

// ── RETURN & REVISIONS (#14-21) ───────────────────────────────────
test('30.10 #14-21 return: reason required; v1 preserved; current verifier resubmits v2; approval tracks latest', async () => {
  const world = makeWorld();
  world.seedVerification('EMPLOYMENT');
  await submitReal(world, 'EMPLOYMENT', 'VERIFIED');
  // #15 return without reason blocked.
  await assert.rejects(qaReturn({ actorId: QA, orderId: ORDER_ID, checkType: 'EMPLOYMENT', reason: 'short', deps: world.deps }), (err) => err.statusCode === 400);
  // #14/#16 return with reason; original submission preserved.
  const returned = await qaReturn({ actorId: QA, orderId: ORDER_ID, checkType: 'EMPLOYMENT', reason: 'Experience letter unreadable — upload a clearer copy', deps: world.deps });
  assert.equal(returned.verification.qaStatus, 'RETURNED');
  assert.equal(world.state.verifications[0].state, 'QA_RETURNED');
  assert.equal(world.state.verifications[0].submissions.length, 1);
  assert.equal(world.state.verifications[0].submissions[0].qa.status, 'RETURNED');
  // #17 current verifier corrects → revision 2 (#19), back to QA (#20).
  const resubmitted = await submitReal(world, 'EMPLOYMENT', 'VERIFIED');
  assert.equal(resubmitted.conclusion.submittedAt instanceof Date, true);
  const live = world.state.verifications[0];
  assert.equal(live.state, 'SUBMITTED');
  assert.equal(live.qaStatus, 'PENDING');
  assert.equal(live.submissions.length, 2);
  assert.equal(live.submissions[0].revision, 1); // v1 immutable
  assert.equal(live.submissions[1].revision, 2);
  assert.equal(live.submissions[0].conclusion.value, 'VERIFIED'); // never overwritten
  // #18 former verifier cannot correct (assignment is the authority).
  await assert.rejects(
    submitConclusion({ verifierId: 'ver999999999999999999999', orderId: ORDER_ID, checkType: 'EMPLOYMENT', conclusion: 'VERIFIED', reason: 'interloper', deps: { ...world.deps, findAssignment: async () => null } }),
    (err) => err.statusCode === 404
  );
  // #21 QA approval lands on the LATEST revision.
  const approved = await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'EMPLOYMENT', deps: world.deps });
  assert.equal(approved.verification.revision, 2);
  assert.equal(live.submissions[1].qa.status, 'APPROVED');
  assert.equal(live.submissions[0].qa.status, 'RETURNED'); // history intact
});

// ── CONSOLIDATION (#22-26) ────────────────────────────────────────
test('30.10 #22-26 consolidation: 27.15 semantics; conservative; never REJECTED', async () => {
  assert.equal(computeOverallOutcome(['VERIFIED', 'VERIFIED']), 'CLEAR'); // #22
  assert.equal(computeOverallOutcome(['VERIFIED', 'VERIFIED_WITH_DISCREPANCY']), 'CLEAR_WITH_DISCREPANCIES'); // #23
  assert.equal(computeOverallOutcome(['VERIFIED', 'UNABLE_TO_VERIFY']), 'HOLD'); // #24
  assert.equal(computeOverallOutcome(['INCONCLUSIVE']), 'HOLD');
  // #25 enum identical to Phase 27.15 case outcomes.
  const caseModel = readFileSync(new URL('../src/models/BackgroundVerificationCase.js', import.meta.url), 'utf8');
  for (const outcome of ['CLEAR', 'CLEAR_WITH_DISCREPANCIES', 'HOLD']) {
    assert.ok(caseModel.includes(`'${outcome}'`));
  }
  // #26 no rejection concept produced.
  for (const input of [['VERIFIED'], ['VERIFIED_WITH_DISCREPANCY'], ['UNABLE_TO_VERIFY'], ['INCONCLUSIVE']]) {
    assert.ok(!/REJECT/.test(computeOverallOutcome(input) || ''));
  }
  const service = readFileSync(new URL('../src/services/bgv/bgvQaReportService.js', import.meta.url), 'utf8');
  assert.ok(!/currentStage|transitionCandidate|withdraw/i.test(service));
});

// ── REPORT GENERATION (#27-36) ────────────────────────────────────
test('30.10 #27-36 report: gated by readiness; immutable snapshot; private PDF; failure safe + retry', async () => {
  const world = makeWorld();
  world.seedVerification('IDENTITY');
  world.seedVerification('EMPLOYMENT');
  // #27 not ready → generate refused.
  await assert.rejects(generateReport({ actorId: QA, orderId: ORDER_ID, deps: world.deps }), (err) => err.statusCode === 409);
  await submitReal(world, 'IDENTITY', 'VERIFIED');
  world.state.verifications[1].discrepancies = [{ field: 'employment dates', candidateClaimed: '2024', sourceConfirmed: '2023', severity: 'MINOR', explanation: 'letter shows 2023', recordedBy: V_ID }];
  await submitReal(world, 'EMPLOYMENT', 'VERIFIED_WITH_DISCREPANCY', 'dates differ');
  await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'EMPLOYMENT', deps: world.deps });
  // #28-30 snapshot from approved revisions with unique reference.
  const generated = await generateReport({ actorId: QA, orderId: ORDER_ID, deps: world.deps });
  assert.equal(generated.idempotent, false);
  assert.match(generated.report.reportNumber, /^BGVRPT-\d{6}$/); // #29
  const stored = world.state.reports[0];
  assert.equal(stored.snapshot.overallOutcome, 'CLEAR_WITH_DISCREPANCIES');
  assert.equal(stored.snapshot.checks.find((c) => c.checkType === 'EMPLOYMENT').revision, 1);
  assert.equal(stored.pdf.status, 'GENERATED'); // #33
  assert.ok(stored.pdf.checksumSha256.length === 64);
  assert.ok(!('url' in stored.pdf)); // #34 private: key only, select:false semantics
  // #31 later mutable change cannot touch the snapshot.
  world.state.verifications[1].conclusion.value = 'VERIFIED';
  const view = await platformReportView({ orderId: ORDER_ID, deps: world.deps });
  assert.equal(view.report.snapshot.checks.find((c) => c.checkType === 'EMPLOYMENT').conclusion, 'VERIFIED_WITH_DISCREPANCY');
  // #35 PDF failure never releases; findings untouched.
  const failing = makeWorld({ checks: ['IDENTITY'] });
  failing.seedVerification('IDENTITY');
  await submitReal(failing, 'IDENTITY', 'VERIFIED');
  await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', deps: failing.deps });
  failing.state.storeFailure = new Error('storage down');
  const failedGen = await generateReport({ actorId: QA, orderId: ORDER_ID, deps: failing.deps });
  assert.equal(failedGen.pdfFailed, true);
  assert.equal(failedGen.report.status, 'GENERATED');
  assert.equal(failedGen.report.pdfStatus, 'FAILED');
  await assert.rejects(releaseReport({ actorId: QA, orderId: ORDER_ID, deps: failing.deps }), (err) => err.statusCode === 409);
  assert.equal(failing.state.verifications[0].qaStatus, 'APPROVED'); // QA state preserved
  // #36 retry renders deterministically from the stored snapshot.
  failing.state.storeFailure = null;
  const retried = await retryReportPdf({ actorId: QA, orderId: ORDER_ID, deps: failing.deps });
  assert.equal(retried.report.pdfStatus, 'GENERATED');
  // duplicate generation idempotent (one report per order+version).
  const dup = await generateReport({ actorId: QA, orderId: ORDER_ID, deps: world.deps });
  assert.equal(dup.idempotent, true);
  assert.equal(world.state.reports.length, 1); // #32 version preserved
});

// ── RELEASE & TENANT ACCESS (#37-43) ──────────────────────────────
test('30.10 #37-43 release boundary + tenancy: explicit, idempotent, tenant-scoped', async () => {
  const world = makeWorld({ checks: ['IDENTITY'] });
  world.seedVerification('IDENTITY');
  await submitReal(world, 'IDENTITY', 'VERIFIED');
  await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  await generateReport({ actorId: QA, orderId: ORDER_ID, deps: world.deps });
  // #39 unreleased report invisible to tenant HR.
  const hidden = await tenantReportSummary({ companyId: COMPANY_A, candidateId: CANDIDATE, deps: world.deps });
  assert.equal(hidden.report, null);
  await assert.rejects(
    tenantReportDownload({ companyId: COMPANY_A, candidateId: CANDIDATE, deps: world.deps }),
    (err) => err.statusCode === 404
  );
  // #37 explicit release.
  const released = await releaseReport({ actorId: QA, orderId: ORDER_ID, deps: world.deps });
  assert.equal(released.report.status, 'RELEASED');
  // #38 duplicate release idempotent.
  const again = await releaseReport({ actorId: QA, orderId: ORDER_ID, deps: world.deps });
  assert.equal(again.idempotent, true);
  // #40 released report available to authorized tenant HR.
  const visible = await tenantReportSummary({ companyId: COMPANY_A, candidateId: CANDIDATE, deps: world.deps });
  assert.equal(visible.report.overallOutcome, 'CLEAR');
  const download = await tenantReportDownload({ companyId: COMPANY_A, candidateId: CANDIDATE, deps: world.deps });
  assert.ok(download.buffer.length > 0);
  assert.ok(download.fileName.endsWith('.pdf'));
  // #41/#43 tenant B cannot read tenant A report (query is company-scoped).
  const other = await tenantReportSummary({ companyId: COMPANY_B, candidateId: CANDIDATE, deps: world.deps });
  assert.equal(other.report, null);
  await assert.rejects(
    tenantReportDownload({ companyId: COMPANY_B, candidateId: CANDIDATE, deps: world.deps }),
    (err) => err.statusCode === 404
  );
  // #42 authority never comes from body/query (controller uses req.companyId only).
  const controller = readFileSync(new URL('../src/controllers/bgvOrderController.js', import.meta.url), 'utf8');
  const reportSlice = controller.slice(controller.indexOf('bgvFinalReportSummary'));
  assert.ok(reportSlice.includes('companyId: req.companyId'));
  assert.ok(!/body\.companyId|query\.companyId/.test(reportSlice));
  // #49 tenant download audited.
  assert.ok(world.state.audits.some((a) => a.action === 'BGV_FINAL_REPORT_DOWNLOADED'));
});

// ── DATA SECURITY (#44-49) ────────────────────────────────────────
test('30.10 #44-49 security: masked identity, no QA notes/payment/public URL, audits redacted', async () => {
  const world = makeWorld({ checks: ['IDENTITY'] });
  world.seedVerification('IDENTITY');
  await submitReal(world, 'IDENTITY', 'VERIFIED');
  await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  await generateReport({ actorId: QA, orderId: ORDER_ID, deps: world.deps });
  const stored = world.state.reports[0];
  const json = JSON.stringify(stored);
  // #44 masked identifier only.
  assert.ok(json.includes('XXXX XXXX 4242'));
  assert.ok(!/8211|123456789/.test(json));
  // #45/#46 no QA notes, no payment data.
  assert.ok(!/razorpay|payment|amount/i.test(json));
  assert.ok(!/qaReturnReason":\s*"[^"]/.test(JSON.stringify(stored.snapshot)));
  // #47 no permanent public URL anywhere in the report doc.
  assert.ok(!/https?:\/\//.test(json));
  // #48 audits carry safe metadata only.
  const auditJson = JSON.stringify(world.state.audits);
  assert.ok(!/https?:\/\//.test(auditJson));
  assert.ok(!/storageKey/.test(auditJson));
  // QA detail carries evidence metadata, never storage keys.
  const detail = await qaDetail({ orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  assert.ok(!JSON.stringify(detail).includes('storageKey'));
  // QA evidence read is ownership-checked + audited.
  const foreign = await qaEvidenceDownload({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', fileId: 'fil000000000000000000000', deps: world.deps }).then(() => null, (err) => err);
  assert.equal(foreign.statusCode, 404);
  const okEvidence = await qaEvidenceDownload({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', fileId: 'fil111111111111111111111', deps: world.deps });
  assert.ok(okEvidence.buffer.length > 0);
  assert.ok(world.state.audits.some((a) => a.action === 'BGV_QA_EVIDENCE_READ'));
});

// ── DIGILOCKER + BUSINESS (#50-58) ────────────────────────────────
test('30.10 #50-58 digilocker wording + business boundary: honest methods, no charge, no auto-decisions', async () => {
  const world = makeWorld({ checks: ['IDENTITY'] });
  world.seedVerification('IDENTITY'); // seeded with DIGILOCKER_ISSUER_ASSISTED activity
  await submitReal(world, 'IDENTITY', 'VERIFIED');
  await qaApprove({ actorId: QA, orderId: ORDER_ID, checkType: 'IDENTITY', deps: world.deps });
  await generateReport({ actorId: QA, orderId: ORDER_ID, deps: world.deps });
  const stored = world.state.reports[0];
  const methods = stored.snapshot.checks[0].methods;
  // #50 issuer-assisted wording only.
  assert.ok(methods.includes('DigiLocker / issuer-assisted manual verification'));
  // #51 never claims the API integration.
  assert.ok(!/direct.*digilocker.*api/i.test(JSON.stringify(stored)));
  assert.ok(!JSON.stringify(stored).includes('DIGILOCKER_ISSUER_ASSISTED'));
  // #52/#53 order untouched by reporting.
  assert.equal(world.order.status, 'PAID');
  const service = readFileSync(new URL('../src/services/bgv/bgvQaReportService.js', import.meta.url), 'utf8');
  assert.ok(!/razorpay/i.test(service));
  // #54-58 no automatic hiring/rejection/pipeline mutation.
  assert.ok(!/hire|reject|withdraw|currentStage/i.test(service));
  const readiness = evaluateReportReadiness({ purchasedChecks: ['IDENTITY'], checks: [{ checkType: 'IDENTITY', state: 'SUBMITTED', qaStatus: 'RETURNED' }] });
  assert.equal(readiness.ready, false); // returned work blocks report
});

// ── REGRESSION (#59-69) ───────────────────────────────────────────
test('30.10 #59-69 regression wiring: 30.1-30.9 + 27.15 suites all in test:all; no seeds', async () => {
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
    'test/bgvInfoRequest.test.js',
    'test/backgroundVerification.test.js',
  ]) {
    assert.ok(pkg.scripts['test:all'].includes(suite), `test:all must run ${suite}`);
  }
  // #58 no User conversion / no Phase 30.10 seed/demo scripts introduced
  // (the pre-existing generic platform "seed" script is unrelated to BGV).
  assert.ok(!Object.keys(pkg.scripts).some((name) => /bgv.*(seed|demo)|(seed|demo).*bgv/i.test(name)));
  // Verifier workbench still owns conclusions; QA additions are additive.
  const workbench = readFileSync(new URL('../src/services/bgv/bgvWorkbenchService.js', import.meta.url), 'utf8');
  assert.ok(workbench.includes('BGV_CHECK_CONCLUSION_SUBMITTED'));
  // 30.12: submission writes the authoritative NESTED qa state only.
  assert.ok(workbench.includes("'qa.status': 'PENDING'"));
});

// ── Phase 30.12 regression — QA state lives at the nested qa.* schema paths.
// The historical top-level qaStatus/qaReturnReason never existed on
// BgvCheckVerification, so the queue read 'NONE' forever (submitted work
// invisible to QA) and the approve/return conditional filters never matched.
// These tests feed REAL schema-shaped documents (no top-level qaStatus)
// through the real queue/approve/return logic.
const schemaShaped = (orderId) => ({
  _id: 'e'.repeat(24),
  bgvOrder: orderId,
  checkType: 'IDENTITY',
  state: 'SUBMITTED',
  conclusion: { value: 'VERIFIED', submittedAt: new Date() },
  qa: { status: 'PENDING', currentRevision: 1 },
  submissions: [{ revision: 1, qa: { status: 'PENDING' } }],
  activities: [{ seq: 1 }],
  discrepancies: [],
});

test('§30.12 schema-shaped submission surfaces in the QA awaiting queue', async () => {
  const orderId = 'o'.repeat(24);
  const { rows } = await qaQueue({
    filters: { status: 'awaiting' },
    deps: {
      listSubmittedCases: async () => [{ bgvOrder: orderId, status: 'SUBMITTED', identity: { legalName: 'Candidate' } }],
      loadOrderById: async () => ({ _id: orderId, companyId: 'c'.repeat(24), candidate: 'd'.repeat(24), orderCode: 'BGV-3012', status: 'PAID' }),
      loadCompany: async () => ({ name: 'Tenant' }),
      loadCandidate: async () => ({ name: 'Candidate' }),
      listVerifications: async () => [schemaShaped(orderId)],
      countOpenInfoRequests: async () => 0,
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qaStatus, 'PENDING');
  assert.equal(rows[0].conclusion, 'VERIFIED');
  assert.equal(rows[0].checkType, 'IDENTITY');
});

test('§30.12 qaApprove accepts a schema-shaped PENDING submission', async () => {
  const orderId = 'o'.repeat(24);
  const verification = schemaShaped(orderId);
  const updated = { ...verification, qa: { ...verification.qa, status: 'APPROVED', reviewedBy: 'qa-1' } };
  const result = await qaApprove({
    actorId: 'qa-1',
    orderId,
    checkType: 'IDENTITY',
    deps: {
      loadOrderById: async () => ({ _id: orderId, orderCode: 'BGV-3012', status: 'PAID' }),
      findVerification: async () => verification,
      approveUpdate: async () => updated,
      audit: async () => ({ ok: true, mode: 'test' }),
    },
  });
  assert.equal(result.idempotent, false);
  assert.equal(result.verification.qaStatus, 'APPROVED');
});

test('§30.12 qaReturn accepts a schema-shaped PENDING submission', async () => {
  const orderId = 'o'.repeat(24);
  const verification = schemaShaped(orderId);
  const updated = { ...verification, state: 'QA_RETURNED', qa: { ...verification.qa, status: 'RETURNED', returnReason: 'Please clarify the issuing authority on the document.' } };
  const result = await qaReturn({
    actorId: 'qa-1',
    orderId,
    checkType: 'IDENTITY',
    reason: 'Please clarify the issuing authority on the document.',
    deps: {
      loadOrderById: async () => ({ _id: orderId, orderCode: 'BGV-3012', status: 'PAID' }),
      findVerification: async () => verification,
      returnUpdate: async () => updated,
      audit: async () => ({ ok: true, mode: 'test' }),
    },
  });
  assert.equal(result.idempotent, false);
  assert.equal(result.verification.qaStatus, 'RETURNED');
  assert.equal(result.verification.state, 'QA_RETURNED');
});

test('§30.12 approve/return conditional filters target the nested qa status', () => {
  const source = readFileSync(new URL('../src/services/bgv/bgvQaReportService.js', import.meta.url), 'utf8');
  assert.ok(!source.includes("state: 'SUBMITTED', qaStatus:"), 'no phantom top-level qaStatus in conditional filters');
  assert.ok(source.includes("'qa.status': 'PENDING'"), 'conditional lock queries the nested qa status');
  const model = readFileSync(new URL('../src/models/BgvCheckVerification.js', import.meta.url), 'utf8');
  assert.ok(!model.includes('qaStatus'), 'schema never defined a top-level qaStatus path');
});
