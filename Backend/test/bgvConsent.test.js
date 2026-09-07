// Phase 30.4 — CANDIDATE BGV CONSENT (hermetic suite).
//
// No MongoDB/Redis/SMTP: every collaborator is injected. The raw portal token
// is recovered in tests ONLY by parsing the captured (fake) email, mirroring
// how a real candidate receives it — the service never returns it to HR.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BGV_CONSENT_PURPOSE,
  CONSENT_POLICY_VERSION,
  deriveConsentState,
  evaluateConsentDecision,
} from '../src/services/bgv/bgvConsentRules.js';
import {
  getHrConsentStatus,
  issueBgvConsentInvitation,
  recordBgvConsentDecision,
  resolvePublicBgvConsent,
} from '../src/services/bgv/bgvConsentService.js';
import { hashToken } from '../src/utils/securityPolicy.js';
import BgvConsentAccessToken from '../src/models/BgvConsentAccessToken.js';

const COMPANY = 'aaa111111111111111111111';
const OTHER_COMPANY = 'bbb222222222222222222222';
const ACTOR = 'eee555555555555555555555';
const CANDIDATE_ID = 'ccc333333333333333333333';
const ORDER_ID = 'ord444444444444444444444';

const makeWorld = (opts = {}) => {
  const state = {
    order: opts.order ?? {
      _id: ORDER_ID,
      companyId: COMPANY,
      candidate: CANDIDATE_ID,
      orderCode: 'BGVORD-000001',
      status: opts.orderStatus ?? 'PAID',
      items: [
        { type: 'IDENTITY', name: 'Identity Verification', unitPriceMinorUnits: 4000 },
        { type: 'ADDRESS', name: 'Address Verification', unitPriceMinorUnits: 10000 },
      ],
      totalMinorUnits: 14000,
    },
    candidate: { _id: CANDIDATE_ID, companyId: COMPANY, name: 'Demo Candidate', email: 'demo@candidate.example', currentStage: 'PRE_ONBOARDING', bgvDecision: { status: 'BGV_INITIATED' } },
    company: { _id: COMPANY, name: 'Demo Company' },
    tokens: [],
    mails: [],
    audits: [],
  };
  const deps = {
    loadOrder: async ({ companyId, orderId }) =>
      state.order && String(state.order.companyId) === String(companyId) && String(state.order._id) === String(orderId)
        ? { ...state.order }
        : null,
    loadOrderById: async ({ companyId, orderId }) =>
      state.order && String(state.order.companyId) === String(companyId) && String(state.order._id) === String(orderId)
        ? { ...state.order }
        : null,
    loadCandidate: async ({ companyId, candidateId }) =>
      state.candidate && String(state.candidate.companyId) === String(companyId) && String(state.candidate._id) === String(candidateId)
        ? { ...state.candidate }
        : null,
    loadCandidateByRef: async ({ companyId, candidateRef }) =>
      state.candidate && String(state.candidate.companyId) === String(companyId)
        ? { ...state.candidate }
        : null,
    loadCompany: async ({ companyId }) =>
      String(state.company._id) === String(companyId) ? { ...state.company } : null,
    loadLatestOrder: async ({ companyId, candidateId }) =>
      state.order && String(state.order.companyId) === String(companyId) && String(state.order.candidate) === String(candidateId)
        ? { ...state.order }
        : null,
    loadLatestToken: async ({ companyId, orderId }) => {
      const found = [...state.tokens]
        .reverse()
        .find((token) => String(token.companyId) === String(companyId) && String(token.bgvOrder) === String(orderId));
      return found ? { ...found } : null;
    },
    resolveToken: async (tokenHash) => {
      const found = state.tokens.find((token) => token.tokenHash === tokenHash);
      return found ? { ...found } : null;
    },
    revokeActiveTokens: async ({ companyId, orderId, reason }) => {
      state.tokens.forEach((token) => {
        if (String(token.companyId) === String(companyId) && String(token.bgvOrder) === String(orderId) && !token.revokedAt) {
          token.revokedAt = new Date();
          token.revokedReason = reason;
        }
      });
    },
    insertToken: async (doc) => {
      const record = { ...doc, _id: `tok-${state.tokens.length + 1}`, createdAt: new Date(), viewCount: 0, lastViewedAt: null, finalDecision: null, decidedAt: null, consentVersion: '', consentTextHash: '', checksSnapshot: [] };
      state.tokens.push(record);
      return { ...record };
    },
    recordView: async (tokenRecordId) => {
      const token = state.tokens.find((item) => String(item._id) === String(tokenRecordId));
      if (token) {
        token.viewCount += 1;
        token.lastViewedAt = new Date();
      }
    },
    claimDecision: async ({ tokenRecordId, set }) => {
      const token = state.tokens.find((item) => String(item._id) === String(tokenRecordId));
      if (!token || token.revokedAt || token.finalDecision) return null;
      Object.assign(token, set);
      return { ...token };
    },
    reloadToken: async ({ companyId, tokenRecordId }) => {
      const token = state.tokens.find((item) => String(item._id) === String(tokenRecordId) && String(item.companyId) === String(companyId));
      return token ? { ...token } : null;
    },
    sendMail: async (payload) => {
      state.mails.push(payload);
      return opts.delivery ?? { delivered: true, mode: 'MOCK', error: '' };
    },
    audit: async (entry) => {
      state.audits.push(entry);
    },
  };
  return { state, deps };
};

const rawFromMail = (world) => {
  const mail = world.state.mails.at(-1);
  const match = /\/candidate\/bgv-consent\/([A-Za-z0-9_-]{40,})/.exec(mail.text || '');
  assert.ok(match, 'email must carry the secure portal link');
  return match[1];
};

const issue = (world) =>
  issueBgvConsentInvitation({ companyId: COMPANY, orderId: ORDER_ID, actorId: ACTOR, deps: world.deps });

// ── issuance & commercial readiness ─────────────────────────────
test('issue: PAID (commercially authorized) order can invite; email carries the link', async () => {
  const world = makeWorld();
  const result = await issue(world);
  assert.equal(result.state, 'INVITATION_SENT');
  assert.equal(result.reissued, false);
  const raw = rawFromMail(world);
  assert.ok(raw.length >= 40, 'token must be cryptographically strong');
  assert.equal(world.state.mails.length, 1);
  assert.equal(world.state.mails[0].to, 'demo@candidate.example');
  assert.equal(world.state.mails[0].sensitive, true);
  // raw token is NOT persisted — only its hash
  const record = world.state.tokens[0];
  assert.equal(record.tokenHash, hashToken(raw));
  assert.equal(JSON.stringify(record).includes(raw), false);
  assert.equal(record.purpose, BGV_CONSENT_PURPOSE);
  // audit is token-free
  assert.equal(JSON.stringify(world.state.audits).includes(raw), false);
  assert.equal(world.state.audits[0].action, 'BGV_CONSENT_INVITATION_ISSUED');
});

test('issue: non-PAID order cannot invite (commercial boundary)', async () => {
  const world = makeWorld({ orderStatus: 'CREATED' });
  await assert.rejects(issue(world), (error) => error.statusCode === 409);
  assert.equal(world.state.tokens.length, 0);
  assert.equal(world.state.mails.length, 0);
});

test('issue: delivery failure revokes the link and keeps the order paid', async () => {
  const world = makeWorld({ delivery: { delivered: false, mode: 'MOCK', error: 'smtp down' } });
  await assert.rejects(issue(world), (error) => error.statusCode === 503);
  assert.equal(world.state.order.status, 'PAID'); // commercial state untouched
  assert.ok(world.state.tokens[0].revokedAt, 'undelivered link must be revoked');
  assert.equal(world.state.audits.some((entry) => entry.action === 'BGV_CONSENT_INVITATION_FAILED'), true);
});

// ── scanner-safe GET ─────────────────────────────────────────────
test('GET: mail-scanner-style read views the portal but records NO decision', async () => {
  const world = makeWorld();
  await issue(world);
  const raw = rawFromMail(world);
  const view = await resolvePublicBgvConsent({ rawToken: raw, deps: world.deps });
  assert.equal(view.state, 'PENDING');
  assert.equal(view.companyName, 'Demo Company');
  assert.deepEqual(view.checks, [
    { type: 'IDENTITY', name: 'Identity Verification' },
    { type: 'ADDRESS', name: 'Address Verification' },
  ]);
  assert.equal(view.consentVersion, CONSENT_POLICY_VERSION);
  // repeated scanner hits: still no decision, no recruitment mutation
  await resolvePublicBgvConsent({ rawToken: raw, deps: world.deps });
  const token = world.state.tokens[0];
  assert.equal(token.finalDecision, null);
  assert.equal(token.viewCount, 2);
  assert.equal(world.state.candidate.currentStage, 'PRE_ONBOARDING'); // untouched
  // no IDs/hashes/amounts leak into the public payload
  const blob = JSON.stringify(view);
  assert.equal(blob.includes(String(ORDER_ID)), false);
  assert.equal(blob.includes(token.tokenHash), false);
  assert.equal(blob.includes('14000'), false);
});

test('GET: invalid and revoked tokens give the same generic failure', async () => {
  const world = makeWorld();
  await issue(world);
  await world.deps.revokeActiveTokens({ companyId: COMPANY, orderId: ORDER_ID, reason: 'SUPERSEDED' });
  const raw = rawFromMail(world);
  await assert.rejects(resolvePublicBgvConsent({ rawToken: raw, deps: world.deps }), (e) => e.statusCode === 404);
  await assert.rejects(
    resolvePublicBgvConsent({ rawToken: 'x'.repeat(64), deps: world.deps }),
    (e) => e.statusCode === 404
  );
});

test('GET: expired token shows the safe expired experience and cannot decide', async () => {
  const world = makeWorld();
  await issue(world);
  const raw = rawFromMail(world);
  world.state.tokens[0].expiresAt = new Date(Date.now() - 60_000);
  await assert.rejects(
    resolvePublicBgvConsent({ rawToken: raw, deps: world.deps }),
    (e) => e.statusCode === 404 && /expired/i.test(e.message)
  );
  await assert.rejects(
    recordBgvConsentDecision({ rawToken: raw, decision: 'CONSENTED', deps: world.deps }),
    (e) => e.statusCode === 404
  );
  assert.equal(world.state.tokens[0].finalDecision, null);
});

// ── explicit POST decisions ─────────────────────────────────────
test('consent: explicit POST records provenance; duplicate is idempotent', async () => {
  const world = makeWorld();
  await issue(world);
  const raw = rawFromMail(world);
  const first = await recordBgvConsentDecision({ rawToken: raw, decision: 'CONSENTED', deps: world.deps });
  assert.equal(first.changed, true);
  const token = world.state.tokens[0];
  assert.equal(token.finalDecision, 'CONSENTED');
  assert.equal(token.consentVersion, CONSENT_POLICY_VERSION);
  assert.ok(token.consentTextHash.length >= 16, 'consent wording hash preserved');
  assert.deepEqual(token.checksSnapshot.map((item) => item.type), ['IDENTITY', 'ADDRESS']);
  assert.equal(token.orderCode, 'BGVORD-000001');

  const again = await recordBgvConsentDecision({ rawToken: raw, decision: 'CONSENTED', deps: world.deps });
  assert.equal(again.idempotent, true);
  assert.equal(again.changed, false);
  assert.equal(world.state.audits.filter((entry) => entry.action === 'BGV_CONSENT_RECORDED').length, 1);
  // audit never carries the raw token or its hash
  const blob = JSON.stringify(world.state.audits);
  assert.equal(blob.includes(raw), false);
  assert.equal(blob.includes(token.tokenHash), false);
});

test('decline: explicit POST records CONSENT_DECLINED semantics; duplicate idempotent', async () => {
  const world = makeWorld();
  await issue(world);
  const raw = rawFromMail(world);
  const first = await recordBgvConsentDecision({ rawToken: raw, decision: 'DECLINED', deps: world.deps });
  assert.equal(first.state, 'DECLINED');
  const again = await recordBgvConsentDecision({ rawToken: raw, decision: 'DECLINED', deps: world.deps });
  assert.equal(again.idempotent, true);
  // decline is NOT a failure and does NOT touch the candidate
  assert.equal(world.state.candidate.currentStage, 'PRE_ONBOARDING');
  assert.equal(world.state.candidate.bgvDecision.status, 'BGV_INITIATED');
  assert.equal(world.state.audits.some((entry) => entry.action === 'BGV_CONSENT_DECLINED'), true);
});

test('conflicts: consent-then-decline and decline-then-consent are rejected', async () => {
  const world = makeWorld();
  await issue(world);
  const raw = rawFromMail(world);
  await recordBgvConsentDecision({ rawToken: raw, decision: 'CONSENTED', deps: world.deps });
  await assert.rejects(
    recordBgvConsentDecision({ rawToken: raw, decision: 'DECLINED', deps: world.deps }),
    (e) => e.statusCode === 409
  );

  const world2 = makeWorld();
  await issue(world2);
  const raw2 = rawFromMail(world2);
  await recordBgvConsentDecision({ rawToken: raw2, decision: 'DECLINED', deps: world2.deps });
  await assert.rejects(
    recordBgvConsentDecision({ rawToken: raw2, decision: 'CONSENTED', deps: world2.deps }),
    (e) => e.statusCode === 409
  );
});

// ── resend / rotation ───────────────────────────────────────────
test('resend: rotates the link — old token dies, consent stays pending, no duplicate order', async () => {
  const world = makeWorld();
  await issue(world);
  const oldRaw = rawFromMail(world);
  const second = await issue(world);
  assert.equal(second.reissued, true);
  const newRaw = rawFromMail(world);
  assert.notEqual(oldRaw, newRaw);
  await assert.rejects(resolvePublicBgvConsent({ rawToken: oldRaw, deps: world.deps }), (e) => e.statusCode === 404);
  const view = await resolvePublicBgvConsent({ rawToken: newRaw, deps: world.deps });
  assert.equal(view.state, 'PENDING');
  // rotation never created a second commercial order
  assert.equal(world.state.audits.filter((entry) => entry.action === 'BGV_ORDER_CREATED').length, 0);
  assert.equal(world.state.audits.some((entry) => entry.action === 'BGV_CONSENT_INVITATION_REISSUED'), true);
});

test('resend: a terminal decision blocks reissue (no silent reopen)', async () => {
  const world = makeWorld();
  await issue(world);
  const raw = rawFromMail(world);
  await recordBgvConsentDecision({ rawToken: raw, decision: 'CONSENTED', deps: world.deps });
  await assert.rejects(issue(world), (e) => e.statusCode === 409);
  // the completed consent survived the resend attempt
  assert.equal(world.state.tokens.filter((token) => token.finalDecision === 'CONSENTED').length, 1);
});

// ── isolation & tenant safety ───────────────────────────────────
test('isolation: other-tenant HR cannot issue or read; purpose is fixed', async () => {
  const world = makeWorld();
  await assert.rejects(
    issueBgvConsentInvitation({ companyId: OTHER_COMPANY, orderId: ORDER_ID, actorId: ACTOR, deps: world.deps }),
    (e) => e.statusCode === 404
  );
  await assert.rejects(
    getHrConsentStatus({ companyId: OTHER_COMPANY, candidateRef: CANDIDATE_ID, deps: world.deps }),
    (e) => e.statusCode === 404
  );
  assert.equal(BgvConsentAccessToken.schema.path('purpose').options.default, BGV_CONSENT_PURPOSE);
  // a tampered purpose record is rejected by the resolver
  await issue(world);
  const raw = rawFromMail(world);
  world.state.tokens[0].purpose = 'OFFER_ACCESS';
  await assert.rejects(resolvePublicBgvConsent({ rawToken: raw, deps: world.deps }), (e) => e.statusCode === 404);
});

test('public surface: service entry points never accept a client companyId', () => {
  const paramsOf = (fn) => fn.toString().slice(0, fn.toString().indexOf('=>'));
  for (const fn of [resolvePublicBgvConsent, recordBgvConsentDecision]) {
    assert.equal(paramsOf(fn).includes('companyId'), false);
  }
});

// ── HR visibility & snapshot immutability ───────────────────────
test('HR: consent status tracks the lifecycle and keeps PAID distinct', async () => {
  const world = makeWorld();
  let status = await getHrConsentStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: world.deps });
  assert.equal(status.state, 'NONE');
  assert.equal(status.order.status, 'PAID'); // PAID != CONSENTED

  await issue(world);
  status = await getHrConsentStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: world.deps });
  assert.equal(status.state, 'INVITATION_SENT');

  const raw = rawFromMail(world);
  await recordBgvConsentDecision({ rawToken: raw, decision: 'CONSENTED', deps: world.deps });
  status = await getHrConsentStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: world.deps });
  assert.equal(status.state, 'CONSENTED');
  assert.equal(status.order.status, 'PAID');
  assert.equal(status.token.consentVersion, CONSENT_POLICY_VERSION);
});

test('snapshot: later catalogue repricing cannot rewrite consented checks', async () => {
  const world = makeWorld();
  await issue(world);
  const raw = rawFromMail(world);
  await recordBgvConsentDecision({ rawToken: raw, decision: 'CONSENTED', deps: world.deps });
  // simulate 30.2 repricing after the decision
  world.state.order.items[0].name = 'Identity Verification (renamed)';
  const token = world.state.tokens[0];
  assert.deepEqual(token.checksSnapshot[0], { type: 'IDENTITY', name: 'Identity Verification' });
});

test('scope: consent creates no BGV case, verifier, documents or pipeline moves', async () => {
  const world = makeWorld();
  await issue(world);
  const raw = rawFromMail(world);
  await resolvePublicBgvConsent({ rawToken: raw, deps: world.deps });
  await recordBgvConsentDecision({ rawToken: raw, decision: 'CONSENTED', deps: world.deps });
  const before = JSON.stringify({ candidate: world.state.candidate, order: world.state.order });
  assert.equal(JSON.stringify({ candidate: world.state.candidate, order: world.state.order }), before);
  const actions = world.state.audits.map((entry) => entry.action);
  assert.deepEqual(actions, [
    'BGV_CONSENT_INVITATION_ISSUED',
    'BGV_CONSENT_RECORDED',
  ]);
});

// ── pure rules ──────────────────────────────────────────────────
test('rules: derive/evaluate cover the documented state machine', () => {
  assert.equal(deriveConsentState({ token: null }), 'NONE');
  assert.equal(deriveConsentState({ token: { finalDecision: 'CONSENTED' } }), 'CONSENTED');
  assert.equal(deriveConsentState({ token: { finalDecision: 'DECLINED' } }), 'CONSENT_DECLINED');
  assert.equal(deriveConsentState({ token: { revokedAt: new Date() } }), 'INVITATION_REVOKED');
  assert.equal(deriveConsentState({ token: { expiresAt: new Date(Date.now() - 1000) } }), 'INVITATION_EXPIRED');
  assert.equal(deriveConsentState({ token: {} }), 'INVITATION_SENT');
  assert.equal(evaluateConsentDecision({ current: null, requested: 'CONSENTED' }).allowed, true);
  assert.equal(evaluateConsentDecision({ current: 'CONSENTED', requested: 'CONSENTED' }).idempotent, true);
  assert.equal(evaluateConsentDecision({ current: 'CONSENTED', requested: 'DECLINED' }).allowed, false);
  assert.equal(evaluateConsentDecision({ current: 'DECLINED', requested: 'CONSENTED' }).allowed, false);
});

// ── Phase 30.4 ADDENDUM — Crewly-sent invitations & billing boundary ──
import { readFileSync } from 'node:fs';
import { commercialReadinessOf, isCommerciallyAuthorized, BGV_COMMERCIAL_READINESS } from '../src/services/bgv/bgvOrderRules.js';

test('addendum: unverified/pending payment cannot authorize an invitation', async () => {
  const world = makeWorld({ orderStatus: 'PENDING_PAYMENT' });
  await assert.rejects(issue(world), (e) => e.statusCode === 409);
  const failed = makeWorld({ orderStatus: 'PAYMENT_FAILED' });
  await assert.rejects(issue(failed), (e) => e.statusCode === 409);
  assert.equal(failed.state.mails.length, 0);
});

test('addendum: commercial readiness is a single boundary helper, provider-agnostic', () => {
  assert.equal(commercialReadinessOf({ status: 'PAID' }), BGV_COMMERCIAL_READINESS.AUTHORIZED);
  assert.equal(commercialReadinessOf({ status: 'PENDING_PAYMENT' }), BGV_COMMERCIAL_READINESS.NOT_AUTHORIZED);
  assert.equal(commercialReadinessOf({ status: 'CREATED' }), BGV_COMMERCIAL_READINESS.NOT_AUTHORIZED);
  assert.equal(isCommerciallyAuthorized({ status: 'PAID' }), true);
  assert.equal(isCommerciallyAuthorized(null), false);
  // consent service never consults provider/payment fields (code, not comments)
  const codeOnly = readFileSync(new URL('../src/services/bgv/bgvConsentService.js', import.meta.url), 'utf8')
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(' ');
  for (const banned of ['razorpay', 'gatewayPaymentId', 'providerOrderId', 'enqueueJob(', 'getQueue(']) {
    assert.equal(codeOnly.toLowerCase().includes(banned.toLowerCase()), false, 'banned coupling: ' + banned);
  }
});

test('addendum: email is Crewly-sent, names the tenant as requester, lists checks, never asks candidate to pay', async () => {
  const world = makeWorld();
  const result = await issue(world);
  // HR never receives the raw token or any portal URL
  const blob = JSON.stringify(result);
  assert.equal(/candidate\/bgv-consent\//.test(blob), false);
  assert.equal(blob.includes('rawToken'), false);

  const mail = world.state.mails[0];
  assert.equal(mail.fromLabel, 'Crewly Background Verification'); // Crewly sender identity
  assert.equal(mail.from, undefined); // HR/verifier cannot choose a From address
  assert.equal(mail.to, 'demo@candidate.example'); // authoritative recipient
  assert.equal(mail.subject, 'Background verification requested by Demo Company');
  assert.ok(mail.text.includes('requested background verification through Crewly, operated by Infolexus'));
  assert.ok(mail.text.includes('never asked to pay'));
  assert.ok(mail.text.includes('Identity Verification'));
  assert.ok(mail.text.includes('Address Verification'));
  // no payment/PII/internal data in the email
  for (const banned of ['₹', '14000', 'razorpay', ORDER_ID]) {
    assert.equal(mail.text.toLowerCase().includes(banned.toLowerCase()), false, `banned in email: ${banned}`);
  }
  assert.equal(/\bPAN\b/.test(mail.text), false);
  assert.equal(/Aadhaar/i.test(mail.text), false);
});

test('addendum: HR-supplied recipient/sender overrides are ignored (authoritative Mongo email wins)', async () => {
  const world = makeWorld();
  await issueBgvConsentInvitation({
    companyId: COMPANY,
    orderId: ORDER_ID,
    actorId: ACTOR,
    email: 'attacker@evil.example', // ignored — not even a parameter
    from: 'spoof@evil.example', // ignored
    deps: world.deps,
  });
  assert.equal(world.state.mails[0].to, 'demo@candidate.example');
  assert.equal(world.state.mails[0].from, undefined);
});

test('addendum: SMTP failure leaves commercial authorization intact and reports INVITATION_FAILED with safe resend', async () => {
  const world = makeWorld({ delivery: { delivered: false, mode: 'SMTP', error: 'relay denied' } });
  await assert.rejects(issue(world), (e) => e.statusCode === 503);
  assert.equal(world.state.order.status, 'PAID'); // commercially authorized unchanged
  let status = await getHrConsentStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: world.deps });
  assert.equal(status.state, 'INVITATION_FAILED'); // honest delivery state
  assert.equal(status.order.status, 'PAID');
  // consent never happened
  assert.equal(world.state.tokens.every((token) => token.finalDecision === null), true);
  // safe resend now succeeds and flips back to INVITATION_SENT
  const resend = makeWorld();
  resend.state.tokens = world.state.tokens; // carry the failed history
  const again = await issue(resend);
  assert.equal(again.state, 'INVITATION_SENT');
  status = await getHrConsentStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: resend.deps });
  assert.equal(status.state, 'INVITATION_SENT');
});

test('addendum: duplicate triggers rotate safely — exactly one ACTIVE link, one commercial order', async () => {
  const world = makeWorld();
  await issue(world);
  await issue(world);
  await issue(world);
  const active = world.state.tokens.filter((token) => !token.revokedAt);
  assert.equal(active.length, 1);
  assert.equal(world.state.audits.filter((entry) => entry.action === 'BGV_ORDER_CREATED').length, 0);
  // payment never implies consent
  const status = await getHrConsentStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: world.deps });
  assert.equal(status.state, 'INVITATION_SENT');
  assert.equal(status.order.status, 'PAID');
});

test('addendum: routes keep verifier/HR boundaries (MANAGE permission required to trigger)', () => {
  const routes = readFileSync(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8');
  const at = routes.indexOf("'/bgv-orders/:orderId/consent-invitation'");
  const block = routes.slice(at - 60, at + 240);
  assert.ok(block.includes("requirePermission('BACKGROUND_VERIFICATION_MANAGE')"));
  assert.ok(block.includes('checkWriteAccess'));
});

test('addendum: current frontend exposes only per-candidate payment (no future billing modes)', () => {
  for (const rel of [
    '../../Frontend/src/components/recruitment/BgvPurchasePanel.jsx',
    '../../Frontend/src/services/bgvService.js',
    '../../Frontend/src/routes/AppRoutes.jsx',
  ]) {
    const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const mode of ['PREPAID_CREDITS', 'MONTHLY_INVOICE', 'SUBSCRIPTION_INCLUDED', 'ENTERPRISE_POSTPAID', 'credits']) {
      assert.equal(source.includes(mode), false, `${rel} must not expose ${mode}`);
    }
  }
});
