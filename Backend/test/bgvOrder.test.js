// Phase 30.3 — PAID BGV ORDER (hermetic suite).
//
// No MongoDB/Redis/Razorpay network: the service accepts injected
// collaborators, so every state transition, signature path and duplicate
// guard is exercised against in-memory fakes. The HMAC path uses the REAL
// defaultVerifySignature with a DUMMY in-process secret (not a credential).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  BGV_ORDER_OPEN_STATUSES,
  BGV_ORDER_STATUSES,
  buildOrderSnapshot,
  canTransitionOrder,
  clientMoneyViolations,
  evaluatePurchaseEligibility,
  orderOpenKey,
} from '../src/services/bgv/bgvOrderRules.js';
import {
  cancelBgvOrder,
  createBgvOrder,
  getBgvOrderForCandidate,
  initiateBgvOrderPayment,
  listPurchasableBgvServices,
  verifyBgvOrderPayment,
} from '../src/services/bgv/bgvOrderService.js';
import BgvOrder from '../src/models/BgvOrder.js';

const COMPANY = 'aaa111111111111111111111';
const OTHER_COMPANY = 'bbb222222222222222222222';
const ACTOR = 'eee555555555555555555555';
const CANDIDATE_ID = 'ccc333333333333333333333';
const DUMMY_SECRET = 'hermetic-test-secret-not-a-credential';

// ── fakes ────────────────────────────────────────────────────────
const makeCatalogue = () => [
  { _id: 'cat-identity', type: 'IDENTITY', priceMinorUnits: 50000, currency: 'INR', version: 3, active: true, displayName: 'Identity Verification', description: 'Aadhaar/PAN match' },
  { _id: 'cat-education', type: 'EDUCATION', priceMinorUnits: 80000, currency: 'INR', version: 1, active: true, displayName: 'Education Verification', description: 'Degree check' },
  { _id: 'cat-employment', type: 'EMPLOYMENT', priceMinorUnits: 120000, currency: 'INR', version: 2, active: false }, // configured but INACTIVE
  { _id: 'cat-address', type: 'ADDRESS', priceMinorUnits: 60000, currency: 'INR', version: 1, active: true },
  // REFERENCE intentionally absent => unconfigured
];

const makeCandidate = (overrides = {}) => ({
  _id: CANDIDATE_ID,
  companyId: COMPANY,
  currentStage: 'SELECTED',
  bgvDecision: { status: 'BGV_INITIATED' },
  ...overrides,
});

const makeDeps = (opts = {}) => {
  const state = {
    catalogue: opts.catalogue || makeCatalogue(),
    candidate: opts.candidate ?? makeCandidate(),
    orders: [],
    audits: [],
    providerCalls: [],
    seq: 0,
    insertError: null,
  };
  const deps = {
    findAll: async () => state.catalogue.map((record) => ({ ...record })),
    loadCandidate: async ({ companyId, candidateRef }) => {
      const c = state.candidate;
      return c && String(c.companyId) === String(companyId) &&
        (String(c._id) === String(candidateRef) || c.candidateCode === candidateRef)
        ? { ...c }
        : null;
    },
    loadOpenOrder: async ({ companyId, candidateId }) => {
      const found = state.orders.find(
        (order) =>
          String(order.companyId) === String(companyId) &&
          String(order.candidate) === String(candidateId) &&
          order.openKey === 'OPEN'
      );
      return found ? { ...found } : null;
    },
    insertOrder: async (doc) => {
      if (state.insertError) {
        const error = state.insertError;
        state.insertError = null;
        throw error;
      }
      const order = { ...doc, _id: `order-${state.orders.length + 1}`, createdAt: new Date(), providerOrderId: '', gatewayPaymentId: '', failureReason: '', paidAt: null, gateway: null };
      state.orders.push(order);
      return { ...order };
    },
    loadOrder: async ({ companyId, orderId }) => {
      const found = state.orders.find(
        (order) => String(order.companyId) === String(companyId) && String(order._id) === String(orderId)
      );
      return found ? { ...found } : null;
    },
    transitionOrder: async ({ companyId, orderId, fromStatuses, set }) => {
      const order = state.orders.find(
        (candidate) => String(candidate.companyId) === String(companyId) && String(candidate._id) === String(orderId)
      );
      if (!order || !fromStatuses.includes(order.status)) return null;
      Object.assign(order, set);
      return { ...order };
    },
    nextOrderCode: async () => {
      state.seq += 1;
      return `BGVORD-${String(state.seq).padStart(6, '0')}`;
    },
    createProviderOrder: async ({ order, gateway }) => {
      state.providerCalls.push({ gateway, amount: order.totalMinorUnits, receipt: String(order._id) });
      return { providerOrderId: gateway === 'razorpay' ? 'order_rzp_TEST001' : `bgvorder_mock_${order._id}` };
    },
    razorConfigured: () => opts.razor ?? false,
    audit: async (entry) => {
      state.audits.push(entry);
    },
  };
  return { deps, state };
};

const createOk = (deps, payload = { selected: ['IDENTITY', 'EDUCATION'] }) =>
  createBgvOrder({ companyId: COMPANY, candidateRef: CANDIDATE_ID, actorId: ACTOR, payload, deps });

// ── pure rules ───────────────────────────────────────────────────
test('rules: only the five catalogue types, no sixth service', () => {
  const result = evaluatePurchaseEligibility({
    stage: 'SELECTED',
    decisionStatus: 'BGV_INITIATED',
    selectedTypes: ['SIXTH_MAGIC_SERVICE'],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'UNKNOWN_SERVICE');
});

test('rules: transitions only along the declared state machine', () => {
  assert.equal(canTransitionOrder('CREATED', 'PENDING_PAYMENT'), true);
  assert.equal(canTransitionOrder('PENDING_PAYMENT', 'PAID'), true);
  assert.equal(canTransitionOrder('PENDING_PAYMENT', 'PAYMENT_FAILED'), true);
  assert.equal(canTransitionOrder('PAID', 'PAYMENT_FAILED'), false);
  assert.equal(canTransitionOrder('PAYMENT_FAILED', 'PAID'), false);
  assert.equal(canTransitionOrder('CANCELLED', 'PAID'), false);
  assert.equal(BGV_ORDER_STATUSES.length, 6);
  assert.deepEqual(BGV_ORDER_OPEN_STATUSES, ['CREATED', 'PENDING_PAYMENT', 'PAID']);
  assert.equal(orderOpenKey('PAID'), 'OPEN');
  assert.equal(orderOpenKey('PAYMENT_FAILED'), null);
});

test('rules: client money keys are detected for rejection', () => {
  assert.deepEqual(clientMoneyViolations({ total: 1 }), ['total']);
  assert.deepEqual(clientMoneyViolations({ selected: ['X'], price: 5, currency: 'INR' }), ['price', 'currency']);
  assert.deepEqual(clientMoneyViolations({ selected: ['X'] }), []);
});

test('rules: snapshot totals are server integers, never client input', () => {
  const snapshot = buildOrderSnapshot(
    ['IDENTITY', 'EDUCATION'],
    {
      IDENTITY: { priceMinorUnits: 50000, currency: 'INR', version: 3, name: 'Identity', description: '' },
      EDUCATION: { priceMinorUnits: 80000, currency: 'INR', version: 1, name: 'Education', description: '' },
    }
  );
  assert.equal(snapshot.totalMinorUnits, 130000);
  assert.equal(snapshot.currency, 'INR');
  assert.equal(snapshot.items[0].catalogueVersion, 3);
});

// ── purchasable catalogue (tenant-safe read) ─────────────────────
test('catalogue: only ACTIVE + CONFIGURED services are purchasable', async () => {
  const { deps } = makeDeps();
  const view = await listPurchasableBgvServices(deps);
  const types = view.services.map((service) => service.type);
  assert.deepEqual(types, ['IDENTITY', 'ADDRESS', 'EDUCATION']);
  assert.equal(view.configuredCount, 3); // EMPLOYMENT inactive + REFERENCE unconfigured excluded
  assert.ok(view.services.every((service) => service.priceMinorUnits > 0));
});

// ── create: eligibility gate ─────────────────────────────────────
test('create: other-tenant candidate is a clean 404', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    createBgvOrder({ companyId: OTHER_COMPANY, candidateRef: CANDIDATE_ID, actorId: ACTOR, payload: { selected: ['IDENTITY'] }, deps }),
    (error) => error.statusCode === 404
  );
});

test('create: no 30.1 decision => rejected (button-independent)', async () => {
  const { deps, state } = makeDeps({ candidate: makeCandidate({ bgvDecision: { status: 'NONE' } }) });
  await assert.rejects(createOk(deps), (error) => error.statusCode === 400 && /Initiate BGV/.test(error.message));
  assert.equal(state.orders.length, 0);
});

test('create: PROCEEDED_WITHOUT_BGV candidate is conflicted out (30.1 regression)', async () => {
  const { deps, state } = makeDeps({ candidate: makeCandidate({ bgvDecision: { status: 'PROCEEDED_WITHOUT_BGV' } }) });
  await assert.rejects(createOk(deps), (error) => error.statusCode === 409);
  assert.equal(state.orders.length, 0);
});

test('create: pre-selection stage rejected', async () => {
  const { deps, state } = makeDeps({ candidate: makeCandidate({ currentStage: 'APPLIED' }) });
  await assert.rejects(createOk(deps), (error) => error.statusCode === 400 && /final selection/.test(error.message));
  assert.equal(state.orders.length, 0);
});

test('create: empty selection rejected', async () => {
  const { deps } = makeDeps();
  await assert.rejects(createOk(deps, { selected: [] }), (error) => error.statusCode === 400 && /at least one/.test(error.message));
});

test('create: sixth/unknown service rejected', async () => {
  const { deps, state } = makeDeps();
  await assert.rejects(createOk(deps, { selected: ['ASTROLOGY_CHECK'] }), (error) => error.statusCode === 400 && /Unsupported/.test(error.message));
  assert.equal(state.orders.length, 0);
});

test('create: inactive and unconfigured services are not purchasable', async () => {
  const { deps, state } = makeDeps();
  await assert.rejects(
    createOk(deps, { selected: ['EMPLOYMENT'] }),
    (error) => error.statusCode === 400 && /Not available for purchase/.test(error.message)
  );
  await assert.rejects(
    createOk(deps, { selected: ['REFERENCE'] }),
    (error) => error.statusCode === 400 && /Not available for purchase/.test(error.message)
  );
  assert.equal(state.orders.length, 0);
});

// ── create: price authority + snapshot ───────────────────────────
test('create: total is server-computed from the active catalogue', async () => {
  const { deps, state } = makeDeps();
  const result = await createOk(deps);
  assert.equal(result.reused, false);
  assert.equal(result.order.totalMinorUnits, 130000); // 50000 + 80000 server prices
  assert.equal(result.order.items[0].unitPriceMinorUnits, 50000);
  assert.equal(result.order.items[1].catalogueVersion, 1);
  assert.equal(result.order.orderCode, 'BGVORD-000001');
  assert.equal(result.order.status, 'CREATED');
  assert.equal(state.orders[0].openKey, 'OPEN');
  assert.equal(state.audits[0].action, 'BGV_ORDER_CREATED');
});

test('create: tampered client money is rejected, order untouched', async () => {
  const { deps, state } = makeDeps();
  await assert.rejects(
    createOk(deps, { selected: ['IDENTITY'], total: 1, amount: 1, price: 1, currency: 'USD' }),
    (error) => error.statusCode === 400 && /not accepted/.test(error.message)
  );
  assert.equal(state.orders.length, 0);
});

test('create: body companyId is ignored — tenant comes from the call context', async () => {
  const { deps, state } = makeDeps();
  const seen = [];
  const wrapped = {
    ...deps,
    loadCandidate: async (args) => {
      seen.push(String(args.companyId));
      return deps.loadCandidate(args);
    },
  };
  const result = await createOk(wrapped, { selected: ['IDENTITY'], companyId: OTHER_COMPANY });
  assert.deepEqual(seen, [String(COMPANY)]); // body value never reached the load
  assert.equal(String(state.orders[0].companyId), String(COMPANY));
  assert.equal(result.reused, false);
});

test('snapshot: later catalogue price change never rewrites the stored order', async () => {
  const { deps, state } = makeDeps();
  const created = await createOk(deps);
  assert.equal(created.order.totalMinorUnits, 130000);
  // Phase 30.2 repricing AFTER the purchase:
  state.catalogue[0].priceMinorUnits = 999900;
  state.catalogue[0].version = 4;
  const reloaded = await deps.loadOrder({ companyId: COMPANY, orderId: created.order.id });
  assert.equal(reloaded.totalMinorUnits, 130000);
  assert.equal(reloaded.items[0].unitPriceMinorUnits, 50000);
  assert.equal(reloaded.items[0].catalogueVersion, 3);
});

test('model: items/total/currency are schema-immutable; duplicate-guard index exists', () => {
  assert.equal(BgvOrder.schema.path('items').options.immutable, true);
  assert.equal(BgvOrder.schema.path('totalMinorUnits').options.immutable, true);
  assert.equal(BgvOrder.schema.path('currency').options.immutable, true);
  assert.equal(BgvOrder.schema.path('companyId').options.immutable, true);
  const uniquePartial = BgvOrder.schema.indexes().find(
    ([keys]) => keys.companyId && keys.candidate && keys.openKey
  );
  assert.ok(uniquePartial, 'partial unique openKey index must exist');
  assert.equal(uniquePartial[1].unique, true);
  assert.deepEqual(uniquePartial[1].partialFilterExpression, { openKey: 'OPEN' });
});

// ── duplicate protection ─────────────────────────────────────────
test('duplicate: second create returns the existing open order (no double purchase)', async () => {
  const { deps, state } = makeDeps();
  const first = await createOk(deps);
  const second = await createOk(deps);
  assert.equal(second.reused, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal(state.orders.length, 1);
});

test('duplicate: concurrent create hitting the unique index returns the winner', async () => {
  const { deps, state } = makeDeps();
  const first = await createOk(deps);
  // Simulate the race: open-order check passed in both tabs, second insert
  // collides with the partial unique index.
  state.insertError = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  const raced = await createOk(deps);
  assert.equal(raced.reused, true);
  assert.equal(raced.order.id, first.order.id);
  assert.equal(state.orders.length, 1);
});

// ── payment initiate ─────────────────────────────────────────────
test('initiate: provider order uses the SERVER amount (paise), status PENDING_PAYMENT', async () => {
  const { deps, state } = makeDeps({ razor: true });
  const created = await createOk(deps);
  const initiated = await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  assert.equal(state.providerCalls.length, 1);
  assert.equal(state.providerCalls[0].amount, 130000); // server total, not client
  assert.equal(state.providerCalls[0].gateway, 'razorpay');
  assert.equal(initiated.order.status, 'PENDING_PAYMENT');
  assert.equal(initiated.checkout.providerOrderId, 'order_rzp_TEST001');
  assert.equal(initiated.checkout.amountMinorUnits, 130000);
  assert.equal(initiated.checkout.mock, false);
});

test('initiate: without Razorpay keys the mock gateway is used (TEST MODE)', async () => {
  const { deps, state } = makeDeps({ razor: false });
  const created = await createOk(deps);
  const initiated = await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  assert.equal(initiated.checkout.mock, true);
  assert.equal(initiated.order.gateway, 'mock');
  assert.ok(initiated.checkout.providerOrderId.startsWith('bgvorder_mock_'));
  assert.equal(state.providerCalls[0].gateway, 'mock');
});

test('initiate: provider outage keeps the order payable (no false failure)', async () => {
  const { deps, state } = makeDeps({ razor: true });
  const created = await createOk(deps);
  deps.createProviderOrder = async () => {
    throw new Error('gateway down');
  };
  await assert.rejects(
    initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps }),
    (error) => error.statusCode === 400 && /gateway unavailable/i.test(error.message)
  );
  const order = await deps.loadOrder({ companyId: COMPANY, orderId: created.order.id });
  assert.equal(order.status, 'CREATED');
  assert.equal(state.orders[0].openKey, 'OPEN');
});

test('initiate: retry reuses the same provider order (no second order)', async () => {
  const { deps, state } = makeDeps({ razor: true });
  const created = await createOk(deps);
  await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  const second = await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  assert.equal(state.providerCalls.length, 1);
  assert.equal(second.checkout.providerOrderId, 'order_rzp_TEST001');
});

test('initiate: a PAID order just replays its state', async () => {
  const { deps } = makeDeps();
  const created = await createOk(deps);
  await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  await verifyBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, payload: { mock: true }, deps });
  const replay = await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  assert.equal(replay.order.status, 'PAID');
  assert.equal(replay.checkout, null);
});

// ── verification ─────────────────────────────────────────────────
test('verify: mock confirm on a mock order transitions to PAID with audit', async () => {
  const { deps, state } = makeDeps();
  const created = await createOk(deps);
  await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  const paid = await verifyBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, payload: { mock: true }, deps });
  assert.equal(paid.idempotent, false);
  assert.equal(paid.order.status, 'PAID');
  assert.ok(paid.order.paidAt);
  const paidAudit = state.audits.find((entry) => entry.action === 'BGV_ORDER_PAID');
  assert.ok(paidAudit);
  const auditBlob = JSON.stringify(state.audits);
  assert.ok(!auditBlob.includes('razorpay_signature'));
  assert.ok(!auditBlob.includes(DUMMY_SECRET));
});

test('verify: mock claim on a real-gateway order is rejected', async () => {
  const { deps } = makeDeps({ razor: true });
  const created = await createOk(deps);
  await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  await assert.rejects(
    verifyBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, payload: { mock: true }, deps }),
    (error) => error.statusCode === 400 && /verification failed/i.test(error.message)
  );
  const order = await deps.loadOrder({ companyId: COMPANY, orderId: created.order.id });
  assert.equal(order.status, 'PAYMENT_FAILED');
  assert.equal(order.openKey, null);
});

test('verify: forged signature is rejected and the order fails closed', async () => {
  const { deps } = makeDeps({ razor: true });
  const created = await createOk(deps);
  await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  await assert.rejects(
    verifyBgvOrderPayment({
      companyId: COMPANY,
      orderId: created.order.id,
      payload: { razorpay_payment_id: 'pay_FAKE', razorpay_signature: 'deadbeef' },
      deps,
    }),
    (error) => error.statusCode === 400
  );
  const order = await deps.loadOrder({ companyId: COMPANY, orderId: created.order.id });
  assert.equal(order.status, 'PAYMENT_FAILED');
  assert.notEqual(order.status, 'PAID');
});

test('verify: valid HMAC(orderId|paymentId) with the real verifier transitions to PAID', async () => {
  process.env.RAZORPAY_KEY_SECRET = DUMMY_SECRET;
  try {
    const { deps } = makeDeps({ razor: true });
    const created = await createOk(deps);
    const initiated = await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
    const signature = crypto
      .createHmac('sha256', DUMMY_SECRET)
      .update(`${initiated.checkout.providerOrderId}|pay_HERMETIC01`)
      .digest('hex');
    const paid = await verifyBgvOrderPayment({
      companyId: COMPANY,
      orderId: created.order.id,
      payload: { razorpay_payment_id: 'pay_HERMETIC01', razorpay_signature: signature },
      deps, // NOTE: defaultVerifySignature (real crypto) is used, no injection
    });
    assert.equal(paid.order.status, 'PAID');
  } finally {
    delete process.env.RAZORPAY_KEY_SECRET;
  }
});

test('verify: duplicate callback after PAID replays idempotently (no double audit)', async () => {
  const { deps, state } = makeDeps();
  const created = await createOk(deps);
  await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  await verifyBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, payload: { mock: true }, deps });
  const again = await verifyBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, payload: { mock: true }, deps });
  assert.equal(again.idempotent, true);
  assert.equal(again.changed, false);
  assert.equal(state.audits.filter((entry) => entry.action === 'BGV_ORDER_PAID').length, 1);
  const order = await deps.loadOrder({ companyId: COMPANY, orderId: created.order.id });
  assert.equal(order.status, 'PAID');
  assert.equal(order.totalMinorUnits, 130000); // snapshot untouched
});

test('verify: a PAYMENT_FAILED or CANCELLED order can never become PAID', async () => {
  const { deps } = makeDeps();
  const failed = await createOk(deps, { selected: ['IDENTITY'] });
  await initiateBgvOrderPayment({ companyId: COMPANY, orderId: failed.order.id, deps });
  await assert.rejects(verifyBgvOrderPayment({ companyId: COMPANY, orderId: failed.order.id, payload: { mock: false }, deps }));
  await assert.rejects(
    verifyBgvOrderPayment({ companyId: COMPANY, orderId: failed.order.id, payload: { mock: true }, deps }),
    (error) => error.statusCode === 400 && /not awaiting payment/i.test(error.message)
  );
  const cancelled = await createOk(deps, { selected: ['ADDRESS'] });
  await cancelBgvOrder({ companyId: COMPANY, orderId: cancelled.order.id, actorId: ACTOR, deps });
  await assert.rejects(
    verifyBgvOrderPayment({ companyId: COMPANY, orderId: cancelled.order.id, payload: { mock: true }, deps }),
    (error) => error.statusCode === 400
  );
});

// ── cancel + revisit ─────────────────────────────────────────────
test('cancel: unpaid cancel frees the candidate; a paid order can never be cancelled', async () => {
  // Fresh order -> cancel -> a new order is allowed again.
  const { deps, state } = makeDeps();
  const unpaid = await createOk(deps, { selected: ['ADDRESS'] });
  const cancelled = await cancelBgvOrder({ companyId: COMPANY, orderId: unpaid.order.id, actorId: ACTOR, deps });
  assert.equal(cancelled.order.status, 'CANCELLED');
  assert.equal(state.orders.find((order) => order._id === unpaid.order.id).openKey, null);
  const fresh = await createOk(deps, { selected: ['ADDRESS'] });
  assert.equal(fresh.reused, false);
  assert.equal(state.orders.length, 2);

  // A PAID order (which keeps the candidate blocked by design) is immutable.
  const paidDeps = makeDeps();
  const paid = await createOk(paidDeps.deps, { selected: ['IDENTITY'] });
  await initiateBgvOrderPayment({ companyId: COMPANY, orderId: paid.order.id, deps: paidDeps.deps });
  await verifyBgvOrderPayment({ companyId: COMPANY, orderId: paid.order.id, payload: { mock: true }, deps: paidDeps.deps });
  await assert.rejects(
    cancelBgvOrder({ companyId: COMPANY, orderId: paid.order.id, actorId: ACTOR, deps: paidDeps.deps }),
    (error) => error.statusCode === 400 && /cannot be cancelled/.test(error.message)
  );
});

// ── refresh / resume read ────────────────────────────────────────
test('read: candidate order view supports refresh/resume; other tenant 404s', async () => {
  const { deps } = makeDeps();
  const created = await createOk(deps);
  const view = await getBgvOrderForCandidate({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps });
  assert.equal(view.order.id, created.order.id);
  assert.equal(view.order.totalDisplay, '₹1,300.00');
  assert.equal(view.eligible, true);
  await assert.rejects(
    getBgvOrderForCandidate({ companyId: OTHER_COMPANY, candidateRef: CANDIDATE_ID, deps }),
    (error) => error.statusCode === 404
  );
});

test('read: no order + eligible flag drives the UI entry point', async () => {
  const { deps } = makeDeps();
  const view = await getBgvOrderForCandidate({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps });
  assert.equal(view.order, null);
  assert.equal(view.eligible, true);
  const undecided = await getBgvOrderForCandidate({
    companyId: COMPANY,
    candidateRef: CANDIDATE_ID,
    deps: { ...deps, loadCandidate: async () => ({ ...makeCandidate(), bgvDecision: { status: 'NONE' } }) },
  });
  assert.equal(undecided.eligible, false);
  assert.equal(undecided.code, 'BGV_NOT_INITIATED');
});

// ── scope: 30.4 is NOT implemented here ──────────────────────────
test('scope: purchase never mutates candidate stage, consent or BGV case', async () => {
  const { deps, state } = makeDeps();
  const before = JSON.stringify(state.candidate);
  const created = await createOk(deps);
  await initiateBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, deps });
  await verifyBgvOrderPayment({ companyId: COMPANY, orderId: created.order.id, payload: { mock: true }, deps });
  assert.equal(JSON.stringify(state.candidate), before); // no consent/stage/case writes
  const actions = state.audits.map((entry) => entry.action);
  assert.deepEqual(actions, ['BGV_ORDER_CREATED', 'BGV_ORDER_PAID']);
});
