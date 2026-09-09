import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { bgvBillingOverview } from '../src/services/bgv/bgvBillingService.js';

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
  assert.ok(!service.includes('findOneAndUpdate') && !service.includes('.create('), 'billing service is strictly read-only');
});
