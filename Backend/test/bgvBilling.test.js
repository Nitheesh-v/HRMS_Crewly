import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  bgvBillingOverview,
  bgvAwaitingCandidateResponses,
  cancelUnansweredBgvRequest,
} from '../src/services/bgv/bgvBillingService.js';

// Phase 30.12 — BGV billing reporting is read-only over immutable snapshots.
const oid = (ch) => ch.repeat(24);

const makeOrder = ({ status, total, code }) => ({
  _id: oid('a'),
  orderCode: code,
  companyId: oid('c'),
  status,
  gateway: status === 'PAID' ? 'mock' : null,
  currency: 'INR',
  totalMinorUnits: total,
  items: [{ type: 'IDENTITY', name: 'Identity Verification', unitPriceMinorUnits: total }],
  createdAt: new Date(),
  paidAt: status === 'PAID' ? new Date() : null,
});

test('§30.12 bgv billing aggregates snapshot totals and paginates rows', async () => {
  const orders = [makeOrder({ status: 'PAID', total: 14000, code: 'BGVORD-000002' })];
  let seenFilter = null;
  const result = await bgvBillingOverview({
    filters: { status: 'paid', page: 1, pageSize: 20 },
    deps: {
      listOrders: async ({ filter, skip, limit }) => {
        seenFilter = { filter, skip, limit };
        return orders;
      },
      countOrders: async (filter) => {
        assert.equal(filter.status, 'PAID', 'status filter upper-cased server-side');
        return 1;
      },
      loadCompany: async () => ({ name: 'Infolexus Solutions' }),
      aggregate: async () => [
        { _id: 'PAID', count: 2, totalMinorUnits: 30000 },
        { _id: 'PENDING_PAYMENT', count: 1, totalMinorUnits: 5000 },
      ],
    },
  });
  assert.deepEqual(seenFilter, { filter: { status: 'PAID' }, skip: 0, limit: 20 });
  assert.equal(result.total, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].companyName, 'Infolexus Solutions');
  assert.equal(result.rows[0].totalDisplay, '₹140.00');
  assert.equal(result.summary.collectedMinorUnits, 30000);
  assert.equal(result.summary.paidOrderCount, 2);
  assert.equal(result.summary.byStatus.length, 2);
});

test('§30.12 billing route is permit-gated and never touches gateway payment ids', () => {
  const routes = readFileSync(new URL('../src/routes/superAdminRoutes.js', import.meta.url), 'utf8');
  assert.ok(routes.includes('"/bgv-billing/overview", permit("bgv-billing:read")'), 'billing route is permit-gated');
  const service = readFileSync(new URL('../src/services/bgv/bgvBillingService.js', import.meta.url), 'utf8');
  assert.ok(!service.includes('razorpayPaymentId'), 'billing view never couples to gateway payment ids');
  // Reporting stays read-only; the stale-cancel is the ONLY sanctioned write
  // and it never creates orders nor touches payment/price fields.
  assert.ok(!service.includes('BgvOrder.create'), 'billing service never creates orders');
  assert.ok(
    !service.includes('$set: { status: \'PAID\'') && !/paidAt:\s*(new Date|Date\.now)/.test(service),
    'billing service never marks anything PAID'
  );
});

// ── Phase 30.12 addendum — HR initiated, candidate never replied ──────────
const DAY = 86400000;
const paidOrder = {
  _id: oid('b'),
  orderCode: 'BGVORD-000002',
  companyId: oid('c'),
  candidate: oid('d'),
  status: 'PAID',
  totalMinorUnits: 14000,
};

const awaitingDeps = (groups, orders) => ({
  groupUnanswered: async () => groups,
  loadOrdersByIds: async () => orders,
  loadCompany: async () => ({ name: 'Infolexus Solutions' }),
  loadCandidate: async () => ({ name: 'Nitheesh V' }),
});

test('§30.12 awaiting list flags only expired windows as cancellable', async () => {
  const now = Date.now();
  const groups = [
    { _id: paidOrder._id, finalDecision: null, sentAt: new Date(now - 9 * DAY), expiresAt: new Date(now - 2 * DAY), viewCount: 3, lastViewedAt: new Date(now - 8 * DAY) },
    { _id: oid('e'), finalDecision: null, sentAt: new Date(now - 1 * DAY), expiresAt: new Date(now + 6 * DAY), viewCount: 0, lastViewedAt: null },
  ];
  const orders = [paidOrder, { ...paidOrder, _id: oid('e'), orderCode: 'BGVORD-000003' }];
  const result = await bgvAwaitingCandidateResponses({ deps: awaitingDeps(groups, orders) });
  assert.equal(result.total, 2);
  const [oldest, newest] = result.rows;
  assert.equal(oldest.orderCode, 'BGVORD-000002', 'oldest wait first');
  assert.equal(oldest.cancellable, true);
  assert.equal(oldest.candidateName, 'Nitheesh V');
  assert.equal(oldest.daysWaiting, 9);
  assert.equal(newest.cancellable, false, 'open window is not cancellable');
});

test('§30.12 unanswered list only contains PAID orders', async () => {
  const now = Date.now();
  const groups = [{ _id: paidOrder._id, finalDecision: null, sentAt: new Date(now - DAY), expiresAt: new Date(now - 1) }];
  const result = await bgvAwaitingCandidateResponses({
    deps: awaitingDeps(groups, [{ ...paidOrder, status: 'PENDING_PAYMENT' }]),
  });
  assert.equal(result.total, 0, 'unpaid orders are never "candidate not replying"');
});

const cancelHappyDeps = (order, token) => {
  const calls = { updated: null, revoked: null, audited: null };
  return {
    calls,
    deps: {
      loadOrder: async () => order,
      loadLatestToken: async () => token,
      updateOrder: async (id, set) => {
        calls.updated = { id, set };
        return { ...order, ...set };
      },
      revokeActiveTokens: async (args) => {
        calls.revoked = args;
      },
      audit: async (entry) => {
        calls.audited = entry;
      },
    },
  };
};

test('§30.12 stale-cancel closes the order, kills the link and releases the candidate', async () => {
  const now = Date.now();
  const { calls, deps } = cancelHappyDeps(paidOrder, {
    _id: oid('f'),
    companyId: paidOrder.companyId,
    finalDecision: null,
    expiresAt: new Date(now - DAY),
    createdAt: new Date(now - 8 * DAY),
  });
  const result = await cancelUnansweredBgvRequest({
    orderId: String(paidOrder._id),
    reason: 'Candidate never replied to the consent invitation',
    actorId: oid('1'),
    deps,
  });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(calls.updated.set.status, 'CANCELLED');
  assert.equal(calls.updated.set.openKey, null, 'candidate released for a fresh request');
  assert.equal(calls.revoked.reason, 'PLATFORM_CANCELLED');
  assert.equal(calls.audited.type, 'BGV_ORDER_PLATFORM_CANCELLED');
  assert.equal(calls.audited.level, 'WARN');
});

test('§30.12 cancel is refused before the window ends, after a reply, or unpaid', async () => {
  const now = Date.now();
  const openToken = { finalDecision: null, expiresAt: new Date(now + DAY), companyId: paidOrder.companyId };
  let fixture = cancelHappyDeps(paidOrder, openToken);
  await assert.rejects(
    cancelUnansweredBgvRequest({ orderId: 'x', reason: 'still waiting on candidate', deps: fixture.deps }),
    /response window has not ended/,
    'cancel before expiry is refused'
  );

  fixture = cancelHappyDeps(paidOrder, { ...openToken, finalDecision: 'DECLINED', expiresAt: new Date(now - DAY) });
  await assert.rejects(
    cancelUnansweredBgvRequest({ orderId: 'x', reason: 'candidate declined long ago', deps: fixture.deps }),
    /already responded/,
    'a decision means the candidate replied'
  );

  fixture = cancelHappyDeps({ ...paidOrder, status: 'PENDING_PAYMENT' }, openToken);
  await assert.rejects(
    cancelUnansweredBgvRequest({ orderId: 'x', reason: 'order was never paid here', deps: fixture.deps }),
    /paid BGV request/,
    'only PAID orders enter the stale-cancel path'
  );

  fixture = cancelHappyDeps(paidOrder, null);
  await assert.rejects(
    cancelUnansweredBgvRequest({ orderId: 'x', reason: 'no invitation was ever sent', deps: fixture.deps }),
    /No consent invitation/,
    'nothing unanswered without an invitation'
  );

  fixture = cancelHappyDeps(paidOrder, openToken);
  await assert.rejects(
    cancelUnansweredBgvRequest({ orderId: 'x', reason: 'short', deps: fixture.deps }),
    /at least 10 characters/,
    'reason is mandatory like QA returns'
  );
});

test('§30.12 cancel route carries its own platform permission', () => {
  const routes = readFileSync(new URL('../src/routes/superAdminRoutes.js', import.meta.url), 'utf8');
  assert.ok(routes.includes('"/bgv-billing/awaiting-candidate", permit("bgv-billing:read")'));
  assert.ok(routes.includes('"/bgv-billing/cancel/:orderId", permit("bgv-billing:cancel")'));
});
