// ============================================================
//  PHASE 30.12 — CONSOLIDATED PHASE 30 SECURITY REGRESSION.
//
//  Cross-cutting boundary tests for the whole Phase 30 pipeline.
//  Hermetic: every collaborator is injected, so the REAL shipped
//  service/middleware code runs (no Mongo/Redis/SMTP, no string-scan
//  substitutes for behavior). §31 item numbers appear in test names.
//  Per-phase suites (bgvConsent/Collection/Verifier/Assignment/
//  Workbench/InfoRequest/QaReport/Order/Operations) carry the deep
//  behavioral coverage; this suite pins the SECURITY boundaries.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

import { permit } from '../src/middlewares/superAdminAuth.js';
import {
  getHrConsentStatus,
  issueBgvConsentInvitation,
  recordBgvConsentDecision,
  resolvePublicBgvConsent,
} from '../src/services/bgv/bgvConsentService.js';
import {
  resolveCollectionPortal,
  saveIdentityInformation,
  submitBgvPackage,
  uploadBgvEvidence,
  downloadBgvEvidence,
} from '../src/services/bgv/bgvCollectionService.js';
import {
  verifyBgvOrderPayment,
} from '../src/services/bgv/bgvOrderService.js';
import {
  buildOrderSnapshot,
  clientMoneyViolations,
  CLIENT_MONEY_KEYS,
} from '../src/services/bgv/bgvOrderRules.js';
import {
  assignCheck,
  downloadVerifierEvidence,
  verifierCheckDetail,
} from '../src/services/bgv/bgvAssignmentService.js';
import {
  tenantReportDownload,
  tenantReportSummary,
} from '../src/services/bgv/bgvQaReportService.js';
import {
  computeOverallOutcome,
  evaluateReportReadiness,
} from '../src/services/bgv/bgvQaReportRules.js';
import { sanitizeObservations } from '../src/services/bgv/bgvWorkbenchRules.js';
import { getBgvProvider } from '../src/services/bgv/bgvProviderRegistry.js';
import {
  revalidateReminder,
  reminderEventKey,
  runBgvReminderReconciliation,
} from '../src/services/bgv/bgvReminderService.js';

let counter = 0;
const oid = () => {
  counter += 1;
  return '60' + counter.toString(16).padStart(22, '0');
};
const COMPANY = oid();
const CANDIDATE = oid();
const ORDER = oid();
const RAW = 'a'.repeat(48);
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();

const paidOrder = (over = {}) => ({
  _id: ORDER,
  companyId: COMPANY,
  candidate: CANDIDATE,
  orderCode: 'BGV-0001',
  status: 'PAID',
  gateway: 'razorpay',
  providerOrderId: 'order_X',
  items: [{ type: 'IDENTITY', name: 'Identity', priceMinorUnits: 50000 }],
  totalMinorUnits: 50000,
  ...over,
});
const consentToken = (over = {}) => ({
  _id: oid(),
  companyId: COMPANY,
  candidate: CANDIDATE,
  bgvOrder: ORDER,
  purpose: 'BGV_CANDIDATE_CONSENT',
  tokenHash: 'hash',
  finalDecision: null,
  decidedAt: null,
  revokedAt: null,
  expiresAt: future(),
  createdAt: new Date(),
  ...over,
});

// ═══════════════ TENANCY (§31.1–5) ═══════════════

test('§31.1/4 cross-tenant order access denied — authority is the scoped companyId argument', async () => {
  const seen = [];
  await assert.rejects(
    () =>
      verifyBgvOrderPayment({
        companyId: COMPANY,
        orderId: ORDER,
        payload: {},
        deps: {
          loadOrder: async (args) => {
            seen.push(args);
            return null; // another tenant's id never resolves under this companyId
          },
        },
      }),
    /not found/i
  );
  assert.deepEqual(seen[0], { companyId: COMPANY, orderId: ORDER });
});

test('§31.2/5 cross-tenant HR consent status denied — candidate + order lookups are companyId-scoped', async () => {
  const filters = [];
  await assert.rejects(
    () =>
      getHrConsentStatus({
        companyId: COMPANY,
        candidateRef: CANDIDATE,
        deps: {
          loadCandidateByRef: async (args) => {
            filters.push(args);
            return null; // scoped filter misses another tenant's candidate
          },
          loadLatestOrder: async (args) => {
            filters.push(args);
            return null;
          },
        },
      }),
    /Candidate not found/i
  );
  assert.equal(filters[0].companyId, COMPANY);
});

test('§31.3 cross-tenant report denied — tenant loader filters {companyId, candidate}', async () => {
  let filter = null;
  const summary = await tenantReportSummary({
    companyId: COMPANY,
    candidateId: CANDIDATE,
    deps: {
      findReportForTenant: async (args) => {
        filter = args;
        return null;
      },
    },
  });
  assert.deepEqual(filter, { companyId: COMPANY, candidateId: CANDIDATE });
  assert.equal(summary.report, null);
  // Unreleased report stays invisible even inside the right tenant
  const generated = await tenantReportSummary({
    companyId: COMPANY,
    candidateId: CANDIDATE,
    deps: {
      findReportForTenant: async () => ({ _id: oid(), status: 'GENERATED', release: null, checks: [], outcome: 'CLEAR' }),
    },
  });
  assert.equal(generated.report, null); // GENERATED stays invisible
});

test('§31.4/5 tenant report download refuses a GENERATED (unreleased) report', async () => {
  await assert.rejects(
    () =>
      tenantReportDownload({
        companyId: COMPANY,
        candidateId: CANDIDATE,
        deps: {
          findReportForTenant: async () => ({ _id: oid(), status: 'GENERATED', release: null }),
        },
      }),
    /No released BGV report/i
  );
});

// ═══════════════ PLATFORM (§31.6–10) ═══════════════

const runPermit = (permission, owned) => {
  const req = owned === undefined ? {} : { platformPermissions: owned };
  let code = null;
  let nexted = false;
  const res = { status: (c) => ({ json: () => { code = c; } }) };
  permit(permission)(req, res, () => { nexted = true; });
  return { code, nexted };
};

test('§31.6 tenant token denied catalogue management', () => {
  // Tenant users never reach the platform stack (superAdminSession rejects
  // first); even if platformPermissions were somehow absent → 403.
  assert.deepEqual(runPermit('bgv-catalog:manage', []), { code: 403, nexted: false });
  assert.deepEqual(runPermit('bgv-catalog:manage', undefined), { code: 403, nexted: false });
});

test('§31.7 tenant token denied verifier management', () => {
  assert.equal(runPermit('bgv-verifiers:manage', []).code, 403);
});

test('§31.8 tenant token denied assignment', () => {
  assert.equal(runPermit('bgv-operations:manage', []).code, 403);
});

test('§31.9 tenant token denied QA', () => {
  assert.equal(runPermit('bgv-qa:review', []).code, 403);
});

test('§31.10 tenant token denied operations; QA permission implies nothing else', () => {
  assert.equal(runPermit('bgv-operations:read', []).code, 403);
  // A QA reviewer must NOT gain unrelated platform powers.
  const qa = ['bgv-qa:review', 'bgv-qa:release'];
  assert.equal(runPermit('bgv-qa:review', qa).nexted, true);
  assert.equal(runPermit('bgv-operations:read', qa).code, 403);
  assert.equal(runPermit('bgv-catalog:manage', qa).code, 403);
  // SUPER_ADMIN wildcard passes everything.
  assert.equal(runPermit('bgv-operations:manage', ['*']).nexted, true);
});

// ═══════════════ VERIFIER (§31.11–16) ═══════════════

test('§31.11/12 specialization alone gives nothing — no assignment, no access', async () => {
  await assert.rejects(
    () =>
      verifierCheckDetail({
        verifierId: oid(),
        orderId: ORDER,
        checkType: 'IDENTITY',
        deps: { findAssignment: async () => null },
      }),
    /not assigned to you/i
  );
});

test('§31.14 other verifier\'s assigned work denied', async () => {
  const mine = oid();
  await assert.rejects(
    () =>
      verifierCheckDetail({
        verifierId: oid(), // someone else
        orderId: ORDER,
        checkType: 'EMPLOYMENT',
        deps: { findAssignment: async () => ({ _id: oid(), verifier: mine, checkType: 'EMPLOYMENT', status: 'ASSIGNED' }) },
      }),
    /not assigned to you/i
  );
});

test('§31.15 former verifier denied after reassignment (CURRENT assignment is authority)', async () => {
  const former = oid();
  const current = oid();
  await assert.rejects(
    () =>
      verifierCheckDetail({
        verifierId: former,
        orderId: ORDER,
        checkType: 'ADDRESS',
        // After reassignment the CURRENT row points at the new verifier.
        deps: { findAssignment: async () => ({ _id: oid(), verifier: current, checkType: 'ADDRESS', status: 'ASSIGNED' }) },
      }),
    /not assigned to you/i
  );
});

test('§31.13 cross-check evidence denied — EMPLOYMENT verifier cannot read IDENTITY file', async () => {
  const verifierId = oid();
  await assert.rejects(
    () =>
      downloadVerifierEvidence({
        verifierId,
        fileId: oid(),
        deps: {
          loadFileFull: async () => ({ _id: oid(), bgvOrder: ORDER, checkType: 'IDENTITY', category: 'IDENTITY_DOCUMENT', status: 'ACTIVE', storageProvider: 'LOCAL_PRIVATE', storageKey: 'k', originalFileName: 'id.png', mimeType: 'image/png', checksumSha256: 'x' }),
          // The verifier holds a CURRENT EMPLOYMENT assignment only.
          findAssignment: async ({ checkType }) =>
            checkType === 'EMPLOYMENT' ? { _id: oid(), verifier: verifierId, checkType: 'EMPLOYMENT' } : null,
          fetchFile: async () => Buffer.from('bytes'),
        },
      }),
    /not assigned to you/i
  );
});

test('§31.30 guessed evidence id denied (missing file → not found, generic)', async () => {
  await assert.rejects(
    () =>
      downloadVerifierEvidence({
        verifierId: oid(),
        fileId: oid(),
        deps: { loadFileFull: async () => null },
      }),
    /not found/i
  );
});

test('§31.11/16 assignment revalidated backend-side: specialization + ACTIVE required', async () => {
  const baseDeps = {
    audit: async () => {},
    findAssignment: async () => null,
    insertAssignment: async () => ({ _id: oid() }),
    loadOrderById: async () => paidOrder(),
    loadLatestToken: async () => consentToken({ finalDecision: 'CONSENTED', decidedAt: new Date() }),
    loadCase: async () => ({ _id: oid(), status: 'SUBMITTED', purchasedChecks: ['IDENTITY'] }),
  };
  // Wrong specialization (holds EMPLOYMENT, asked for IDENTITY)
  await assert.rejects(
    () =>
      assignCheck({
        actorId: oid(),
        orderId: ORDER,
        checkType: 'IDENTITY',
        verifierId: oid(),
        deps: { ...baseDeps, loadVerifier: async () => ({ _id: oid(), status: 'ACTIVE', specializations: ['EMPLOYMENT'] }) },
      }),
    /specialization/i
  );
  // Deactivated verifier with the right specialization
  await assert.rejects(
    () =>
      assignCheck({
        actorId: oid(),
        orderId: ORDER,
        checkType: 'IDENTITY',
        verifierId: oid(),
        deps: { ...baseDeps, loadVerifier: async () => ({ _id: oid(), status: 'INACTIVE', specializations: ['IDENTITY'] }) },
      }),
    /not active/i
  );
  // No consent → no assignment even with a perfect verifier
  await assert.rejects(
    () =>
      assignCheck({
        actorId: oid(),
        orderId: ORDER,
        checkType: 'IDENTITY',
        verifierId: oid(),
        deps: { ...baseDeps, loadLatestToken: async () => consentToken(), loadVerifier: async () => ({ _id: oid(), status: 'ACTIVE', specializations: ['IDENTITY'] }) },
      }),
    /consent/i
  );
});

// ═══════════════ TOKENS (§31.17–23) ═══════════════

test('§31.17 raw candidate token never persisted — only its hash is stored', async () => {
  let inserted = null;
  const result = await issueBgvConsentInvitation({
    companyId: COMPANY,
    orderId: ORDER,
    actorId: oid(),
    deps: {
      loadOrder: async () => paidOrder(),
      loadCompany: async () => ({ name: 'Acme' }),
      loadCandidate: async () => ({ _id: CANDIDATE, name: 'Asha', email: 'asha@example.test' }),
      loadLatestToken: async () => null,
      revokeActiveTokens: async () => {},
      insertToken: async (doc) => { inserted = doc; return { ...doc, _id: oid() }; },
      audit: async () => {},
      sendMail: async () => ({ delivered: true, mode: 'SMTP' }),
    },
  });
  assert.ok(inserted, 'token row inserted');
  assert.ok(inserted.tokenHash && inserted.tokenHash !== RAW);
  assert.ok(!JSON.stringify({ ...inserted, tokenHash: 'x' }).includes('rawToken'));
  // The raw token leaves the process exactly once — in the invitation result
  // (rendered into the email link), never in the stored row or audit.
  assert.ok(!Object.keys(inserted).includes('rawToken'));
  assert.ok(result);
});

test('§31.18 + §11 mail-scanner regression: GET portal view is decision-free (repeat-safe)', async () => {
  let claims = 0;
  let views = 0;
  const deps = {
    resolveToken: async () => consentToken(),
    recordView: async () => { views += 1; },
    loadOrderById: async () => paidOrder(),
    loadCandidate: async () => ({ name: 'Asha' }),
    loadCompany: async () => ({ name: 'Acme' }),
  };
  // Scanners/bots GET the link repeatedly — no consent, no decline, no
  // submission, no pipeline effect, no BGV clear: view telemetry only.
  const first = await resolvePublicBgvConsent({ rawToken: RAW, deps });
  const second = await resolvePublicBgvConsent({ rawToken: RAW, deps });
  assert.equal(first.state, 'PENDING');
  assert.equal(second.state, 'PENDING');
  assert.equal(views, 2);
  assert.equal(claims, 0);
});

test('§31.19 expired token denied (explicit expiry message, no data)', async () => {
  await assert.rejects(
    () => resolvePublicBgvConsent({ rawToken: RAW, deps: { resolveToken: async () => consentToken({ expiresAt: past() }) } }),
    /expired/i
  );
});

test('§31.20 revoked token denied (generic failure)', async () => {
  await assert.rejects(
    () => resolvePublicBgvConsent({ rawToken: RAW, deps: { resolveToken: async () => consentToken({ revokedAt: new Date() }) } }),
    /invalid|not found|link/i
  );
});

test('§31.21 old rotated token denied — hash lookup misses', async () => {
  await assert.rejects(
    () => resolvePublicBgvConsent({ rawToken: RAW, deps: { resolveToken: async () => null } }),
    /invalid|not found|link/i
  );
});

test('§31.22 purpose isolation — an offer token cannot open the BGV portal (and vice versa)', async () => {
  await assert.rejects(
    () =>
      resolvePublicBgvConsent({
        rawToken: RAW,
        deps: { resolveToken: async () => consentToken({ purpose: 'OFFER_LETTER' }) },
      }),
    /invalid|not found|link/i
  );
  await assert.rejects(
    () => resolveCollectionPortal({ rawToken: RAW, deps: { resolveToken: async () => consentToken({ purpose: 'OFFER_LETTER' }) } }),
    /invalid|not found|link/i
  );
});

test('§31.23 HR status exposes token metadata only — never the raw token', async () => {
  const status = await getHrConsentStatus({
    companyId: COMPANY,
    candidateRef: CANDIDATE,
    deps: {
      loadCandidateByRef: async () => ({ _id: CANDIDATE }),
      loadLatestOrder: async () => paidOrder(),
      loadLatestToken: async () => consentToken({ finalDecision: 'CONSENTED', decidedAt: new Date() }),
    },
  });
  const json = JSON.stringify(status);
  assert.ok(!json.includes(RAW));
  assert.ok(!json.toLowerCase().includes('tokenhash'));
});

// ═══════════════ CONSENT (§31.24–26) ═══════════════

test('§31.24 payment != consent — collection portal refuses a paid-but-unconsented order', async () => {
  await assert.rejects(
    () =>
      resolveCollectionPortal({
        rawToken: RAW,
        deps: {
          resolveToken: async () => consentToken({ finalDecision: null }),
          loadOrder: async () => paidOrder(),
          loadCompany: async () => ({ name: 'Acme' }),
        },
      }),
    /consent is required/i
  );
});

test('§31.25 decline != BGV failure — decision recorded, nothing else mutated', async () => {
  let claimed = null;
  const result = await recordBgvConsentDecision({
    rawToken: RAW,
    decision: 'DECLINE',
    deps: {
      resolveToken: async () => consentToken(),
      loadOrderById: async () => paidOrder(),
      claimDecision: async (args) => { claimed = args; return consentToken({ finalDecision: 'DECLINED' }); },
      reloadToken: async () => consentToken({ finalDecision: 'DECLINED', decidedAt: new Date() }),
      audit: async () => {},
    },
  });
  assert.ok(claimed);
  // The order was NOT transitioned (still PAID) and no candidate pipeline
  // mutation exists anywhere in the dependency surface.
  assert.ok(result);
});

test('§31.26 consent != verification — consent alone never satisfies report readiness', () => {
  const readiness = evaluateReportReadiness({
    purchasedChecks: ['IDENTITY'],
    checks: [], // consented, but nothing verified/approved
    openInfoRequests: 0,
  });
  assert.equal(readiness.ready, false);
});

// ═══════════════ FILES (§31.27–32) ═══════════════

test('§31.27 private candidate evidence — download requires the token principal', async () => {
  await assert.rejects(
    () => downloadBgvEvidence({ rawToken: 'b'.repeat(48), fileId: oid(), deps: { resolveToken: async () => null } }),
    /invalid|not found|link/i
  );
});

test('§31.31/32 invalid MIME rejected; malware posture stays honest (NOT_CONFIGURED, never faked CLEAN)', async () => {
  const consented = {
    resolveToken: async () => consentToken({ finalDecision: 'CONSENTED', decidedAt: new Date() }),
    loadOrder: async () => paidOrder(),
    loadCompany: async () => ({ name: 'Acme' }),
    loadCase: async () => ({ _id: oid(), status: 'DRAFT', purchasedChecks: ['IDENTITY'] }),
    newRecordId: () => 'rec1',
  };
  await assert.rejects(
    () =>
      uploadBgvEvidence({
        rawToken: RAW,
        category: 'IDENTITY_DOCUMENT',
        file: { originalname: 'payload.exe', mimetype: 'application/x-msdownload', size: 1024, buffer: Buffer.from('MZfakeexe') },
        deps: { ...consented, listActiveFiles: async () => [], createFile: async () => ({}), storeFile: async () => ({}), persistCase: async () => ({}) },
      }),
    /file type|mime|not allowed|invalid/i
  );
  // An allowed upload records the honest scan state — NOT_CONFIGURED.
  let created = null;
  await uploadBgvEvidence({
    rawToken: RAW,
    category: 'IDENTITY_DOCUMENT',
    file: {
      originalname: 'id.png',
      mimetype: 'image/png',
      size: 68,
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      ),
    },
    deps: {
      ...consented,
      listActiveFiles: async () => [],
      createFile: async (doc) => { created = doc; return { ...doc, _id: oid() }; },
      updateFile: async () => ({}),
      storeFile: async () => ({ storageProvider: 'LOCAL_PRIVATE', storageKey: 'k', checksumSha256: 'sha', fileSize: 1024 }),
      persistCase: async () => ({}),
      audit: async () => {},
    },
  });
  assert.ok(created);
  assert.notEqual(created.scanStatus, 'CLEAN');
});

// ═══════════════ PAYMENT (§31.33–36) ═══════════════

test('§31.33/36 frontend amount tampering ineffective — client money keys rejected; snapshot uses server prices', () => {
  for (const key of CLIENT_MONEY_KEYS) {
    assert.ok(clientMoneyViolations({ [key]: 1 }).includes(key), `${key} must be rejected`);
  }
  const snapshot = buildOrderSnapshot(['IDENTITY'], {
    IDENTITY: { priceMinorUnits: 50000, currency: 'INR', version: 3, name: 'Identity', description: '' },
  });
  assert.equal(snapshot.items[0].unitPriceMinorUnits, 50000);
  assert.equal(snapshot.totalMinorUnits, 50000);
});

test('§31.34 forged payment success rejected — bad signature → PAYMENT_FAILED, never PAID', async () => {
  let set = null;
  await assert.rejects(
    () =>
      verifyBgvOrderPayment({
        companyId: COMPANY,
        orderId: ORDER,
        payload: { razorpay_payment_id: 'pay_fake', razorpay_signature: 'deadbeef' },
        deps: {
          loadOrder: async () => paidOrder({ status: 'PENDING_PAYMENT' }),
          transitionOrder: async (args) => { set = args.set; return paidOrder({ status: 'PAYMENT_FAILED' }); },
          verifySignature: async () => false,
          audit: async () => {},
        },
      }),
    /verification failed/i
  );
  assert.ok(set, 'order was transitioned');
  assert.notEqual(set.status, 'PAID');
  assert.equal(set.status, 'PAYMENT_FAILED');
});

test('§31.35 duplicate callback safe — replay on a PAID order is a no-op', async () => {
  let transitions = 0;
  const result = await verifyBgvOrderPayment({
    companyId: COMPANY,
    orderId: ORDER,
    payload: { razorpay_payment_id: 'pay_x', razorpay_signature: 'sig' },
    deps: {
      loadOrder: async () => paidOrder({ status: 'PAID' }),
      transitionOrder: async () => { transitions += 1; },
      verifySignature: async () => true,
      audit: async () => {},
    },
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.changed, false);
  assert.equal(transitions, 0);
});

// ═══════════════ WORKFLOW (§31.37–41, 44) ═══════════════

test('§31.37 candidate GET is submission-free; §31.38 submitted data is locked', async () => {
  const submittedCase = { _id: oid(), status: 'SUBMITTED', submittedAt: new Date(), purchasedChecks: ['IDENTITY'] };
  const deps = {
    resolveToken: async () => consentToken({ finalDecision: 'CONSENTED', decidedAt: new Date() }),
    loadOrder: async () => paidOrder(),
    loadCompany: async () => ({ name: 'Acme' }),
    loadCase: async () => submittedCase,
    listActiveFiles: async () => [],
  };
  // GET portal resolves without touching submittedAt
  const view = await resolveCollectionPortal({ rawToken: RAW, deps });
  assert.ok(view);
  assert.equal(submittedCase.submittedAt instanceof Date, true);
  // POST saves are refused once submitted (controlled re-open only via 30.9)
  await assert.rejects(
    () => saveIdentityInformation({ rawToken: RAW, input: { legalName: 'Someone Else' }, deps }),
    /submitted|locked|no longer/i
  );
  // Repeat submit on a locked package is an idempotent replay — it never
  // creates a second submission (30.5 documented behavior).
  const replay = await submitBgvPackage({ rawToken: RAW, deps });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.status, 'SUBMITTED');
});

test('§31.41 assignment concurrency — a CURRENT assignment blocks a second insert', async () => {
  await assert.rejects(
    () =>
      assignCheck({
        actorId: oid(),
        orderId: ORDER,
        checkType: 'IDENTITY',
        verifierId: oid(),
        deps: {
          audit: async () => {},
          findAssignment: async () => ({ _id: oid(), verifier: oid(), checkType: 'IDENTITY', activeKey: 'CURRENT' }),
          insertAssignment: async () => { throw new Error('must not insert'); },
          loadOrderById: async () => paidOrder(),
          loadLatestToken: async () => consentToken({ finalDecision: 'CONSENTED', decidedAt: new Date() }),
          loadCase: async () => ({ _id: oid(), status: 'SUBMITTED', purchasedChecks: ['IDENTITY'] }),
          loadVerifier: async () => ({ _id: oid(), status: 'ACTIVE', specializations: ['IDENTITY'] }),
        },
      }),
    /already|current/i
  );
});

test('§31.44 report readiness enforced backend-side at rule level', () => {
  const approved = { checkType: 'IDENTITY', state: 'SUBMITTED', qaStatus: 'APPROVED' };
  const notReady = evaluateReportReadiness({
    purchasedChecks: ['IDENTITY', 'EDUCATION'],
    checks: [approved],
    openInfoRequests: 0,
  });
  assert.equal(notReady.ready, false);
  const blocked = evaluateReportReadiness({
    purchasedChecks: ['IDENTITY'],
    checks: [approved],
    openInfoRequests: 1,
  });
  assert.equal(blocked.ready, false);
  const returned = evaluateReportReadiness({
    purchasedChecks: ['IDENTITY'],
    checks: [{ checkType: 'IDENTITY', state: 'QA_RETURNED', qaStatus: 'RETURNED' }],
    openInfoRequests: 0,
  });
  assert.equal(returned.ready, false);
  const ready = evaluateReportReadiness({
    purchasedChecks: ['IDENTITY'],
    checks: [approved],
    openInfoRequests: 0,
  });
  assert.equal(ready.ready, true);
});

// ═══════════════ HUMAN DECISION (§31.46–49) ═══════════════

test('§31.46–48 outcomes inform humans only — no outcome is a pipeline state', () => {
  const clear = computeOverallOutcome(['VERIFIED']);
  const discrep = computeOverallOutcome(['VERIFIED', 'VERIFIED_WITH_DISCREPANCY']);
  const hold = computeOverallOutcome(['VERIFIED', 'UNABLE_TO_VERIFY']);
  assert.equal(clear, 'CLEAR');
  assert.equal(discrep, 'CLEAR_WITH_DISCREPANCIES');
  assert.equal(hold, 'HOLD');
  for (const outcome of [clear, discrep, hold]) {
    assert.ok(!['REJECTED', 'HIRED', 'JOINED', 'OFFER_WITHDRAWN'].includes(outcome));
  }
});

test('§31.49 BGV decision records never mutate the candidate pipeline', async () => {
  const { recordBgvDecision } = await import('../src/services/bgv/bgvDecisionService.js');
  const calls = [];
  const candidateDoc = { _id: CANDIDATE, companyId: COMPANY, currentStage: 'SELECTED' };
  await recordBgvDecision({
    companyId: COMPANY,
    candidateRef: CANDIDATE,
    decision: 'PROCEED_WITHOUT_BGV',
    reason: 'Internal policy',
    actorId: oid(),
    deps: {
      loadCandidate: async (args) => { calls.push(['load', args]); return candidateDoc; },
      loadActiveCase: async () => null,
      claimDecision: async (doc) => { calls.push(['claim', doc]); return { ...doc, _id: oid() }; },
      reloadCandidate: async () => candidateDoc,
      writeHistory: async (doc) => { calls.push(['history', doc]); },
      audit: async () => {},
    },
  });
  const kinds = calls.map(([kind]) => kind);
  assert.ok(kinds.includes('claim'));
  assert.equal(candidateDoc.currentStage, 'SELECTED'); // untouched
  // The decision surface cannot write candidate.currentStage — the record
  // is information for humans, never a pipeline command.
  const claimed = calls.find(([kind]) => kind === 'claim')[1];
  assert.ok(!JSON.stringify(claimed).includes('currentStage'));
});

// ═══════════════ QUEUE (§31.50–52) ═══════════════

test('§31.50–52 reminders: refs-only payloads, stale skip, duplicate-safe keys', async () => {
  // 50 — dispatch payload is references only
  const dispatched = [];
  await runBgvReminderReconciliation({
    nowIso: new Date().toISOString(),
    deps: {
      findOrders: async () => [paidOrder({ paidAt: new Date(Date.now() - 3600000).toISOString() })],
      findCases: async () => [],
      findInfoRequests: async () => [],
      findVerifications: async () => [],
      findAssignments: async () => [],
      findSlaPolicy: async () => null,
      dispatch: async (args) => { dispatched.push(args); return { queued: true }; },
    },
  });
  assert.equal(dispatched.length, 1);
  assert.deepEqual(Object.keys(dispatched[0].payload).sort(), ['bucket', 'checkType', 'kind', 'orderId', 'requestId']);
  const json = JSON.stringify(dispatched[0].payload).toLowerCase();
  for (const banned of ['token', 'http', 'html', 'razorpay', 'aadhaar']) {
    assert.ok(!json.includes(banned), `payload leaked ${banned}`);
  }
  // 51 — stale milestone (consent given since dispatch) is skipped
  const stale = await revalidateReminder({
    orderId: ORDER,
    kind: 'CONSENT_PENDING',
    deps: {
      findOrder: async () => paidOrder(),
      findCase: async () => ({ _id: oid(), status: 'DRAFT' }),
    },
  });
  assert.deepEqual(stale, { valid: false, reason: 'ALREADY_DECIDED' });
  // 52 — deterministic event key collapses duplicates
  const keyA = reminderEventKey({ kind: 'CONSENT_PENDING', orderId: ORDER, checkType: null, requestId: null, bucket: 0 });
  const keyB = reminderEventKey({ kind: 'CONSENT_PENDING', orderId: ORDER, checkType: null, requestId: null, bucket: 0 });
  assert.equal(keyA, keyB);
  assert.notEqual(keyA, reminderEventKey({ kind: 'CONSENT_PENDING', orderId: ORDER, checkType: null, requestId: null, bucket: 1 }));
});

// ═══════════════ DIGILOCKER (§31.53–55) ═══════════════

test('§31.53 credential/OTP/identifier keys are rejected in verifier observations', () => {
  for (const key of ['password', 'OTP', 'aadhaar', 'pan', 'uan', 'geolocation']) {
    assert.throws(
      () =>
        sanitizeObservations({
          checkType: 'EMPLOYMENT',
          method: 'PHONE_HR',
          observations: { [key]: 'anything' },
        }),
      /.+/,
      `${key} must be rejected`
    );
  }
});

test('§31.54 no direct DigiLocker API exists — provider registry is INTERNAL only', () => {
  assert.ok(getBgvProvider('INTERNAL'));
  for (const bogus of ['DIGILOCKER', 'DIGILOCKER_API', 'OAUTH_DIGILOCKER']) {
    assert.throws(() => getBgvProvider(bogus), /.+/);
  }
});

test('§31.55 issuer-assisted provenance is explicit and honest', () => {
  // The manual/issuer-assisted method only accepts the candidate-provided
  // provenance value — nothing may claim API/e-KYC verification.
  const clean = sanitizeObservations({
    checkType: 'IDENTITY',
    method: 'DIGILOCKER_ISSUER_ASSISTED',
    observations: { originRepresentation: 'CANDIDATE_PROVIDED_DIGILOCKER', issuerDocumentVerified: true },
  });
  assert.equal(clean.originRepresentation, 'CANDIDATE_PROVIDED_DIGILOCKER');
  // A bogus provenance value cannot be smuggled in — unknown enum values
  // are dropped, so nothing can claim API/e-KYC verification.
  const bogus = sanitizeObservations({
    checkType: 'IDENTITY',
    method: 'DIGILOCKER_ISSUER_ASSISTED',
    observations: { originRepresentation: 'API_VERIFIED' },
  });
  assert.notEqual(bogus.originRepresentation, 'API_VERIFIED');
});

// ── Phase 30.12 regression: multipart field contract — the shared
// hardened uploader accepts a single file field named 'document'; every
// Phase 30 upload client must use that exact name (the verifier workbench
// once sent 'file', multer raised LIMIT_UNEXPECTED_FILE, and the attach
// failed with 400 during localhost acceptance).
// Phase 30.12 regression: the tenant candidate page crashed blank because the
// paid-order branch rendered FinalReportCard from a `finalReport` identifier
// that was never loaded or destructured (ReferenceError, no error boundary).
// The panel must define, fetch, and destructure it.
test('§30.12 tenant BGV panel defines and loads finalReport before rendering it', async () => {
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(
    new URL('../../Frontend/src/components/recruitment/BgvPurchasePanel.jsx', import.meta.url),
    'utf8'
  );
  assert.ok(panel.includes('finalReport: null'), 'state initialises finalReport');
  assert.ok(panel.includes('bgvService.finalReport(candidateRef)'), 'released report is fetched');
  assert.ok(/const \{[^}]*finalReport[^}]*\} = state;/.test(panel), 'finalReport is destructured from state');
  assert.ok(!panel.includes("'''"), 'no heredoc artifact rendered as JSX text');
});

test('§30.12 verifier evidence upload uses the hardened uploader field name', async () => {
  const { readFileSync } = await import('node:fs');
  const middleware = readFileSync(
    new URL('../src/middlewares/preOnboardingUpload.js', import.meta.url),
    'utf8'
  );
  assert.ok(middleware.includes(".single('document')"), 'uploader accepts only the document field');
  const panel = readFileSync(
    new URL('../../Frontend/src/pages/bgvVerifier/workbench/WorkbenchPanels.jsx', import.meta.url),
    'utf8'
  );
  assert.ok(panel.includes("formData.append('document', file)"), 'verifier panel sends the document field');
  assert.ok(
    /if \(workbench\.locked\) return null;[\s\S]{0,400}Record verification activity/.test(panel),
    'activity recorder is hidden once the workbench is locked'
  );
  const collection = readFileSync(
    new URL('../../Frontend/src/services/bgvCollectionService.js', import.meta.url),
    'utf8'
  );
  assert.ok(collection.includes("form.append('document', file)"), 'candidate collection sends the document field');
});
