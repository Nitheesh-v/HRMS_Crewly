// Phase 30.12 — BGV BILLING (platform reporting surface, read-only).
//
// A super-admin view over the IMMUTABLE commercial snapshot already stored
// on BgvOrder (server-authoritative prices, frozen at creation). This is
// reporting only:
//  - NO new billing model (no prepaid wallets, monthly plans, subscriptions,
//    or postpaid invoicing — those remain NOT implemented by design).
//  - NO payment mutation, retry, or refund paths live here.
//  - Amounts always come from order.totalMinorUnits / item.unitPriceMinorUnits
//    (the snapshot), never from client input and never re-priced.
//  - Gateway references are the provider label only (mock/razorpay) — the
//    billing view never depends on or exposes gateway payment identifiers.

import BgvOrder from '../../models/BgvOrder.js';
import Company from '../../models/Company.js';
import { formatMinorUnits } from './bgvCatalogueRules.js';

const defaultListOrders = ({ filter, skip, limit }) =>
  BgvOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
const defaultCountOrders = (filter) => BgvOrder.countDocuments(filter);
const defaultLoadCompany = (companyId) =>
  Company.findById(companyId).select('name').lean();
const defaultAggregate = (pipeline) => BgvOrder.aggregate(pipeline);

const billingRow = (order, companyName) => ({
  orderId: String(order._id),
  orderCode: order.orderCode,
  companyName: companyName || '',
  status: order.status,
  gateway: order.gateway || null,
  currency: order.currency || 'INR',
  totalMinorUnits: order.totalMinorUnits || 0,
  totalDisplay: formatMinorUnits(order.totalMinorUnits || 0),
  items: (order.items || []).map((item) => ({
    type: item.type,
    name: item.name,
    unitPriceMinorUnits: item.unitPriceMinorUnits,
    priceDisplay: formatMinorUnits(item.unitPriceMinorUnits),
  })),
  createdAt: order.createdAt || null,
  paidAt: order.paidAt || null,
});

// GET overview — paginated order lines + status-grouped revenue totals.
export const bgvBillingOverview = async ({ filters = {}, deps = {} }) => {
  const listOrders = deps.listOrders || defaultListOrders;
  const countOrders = deps.countOrders || defaultCountOrders;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const aggregate = deps.aggregate || defaultAggregate;

  const filter = {};
  if (filters.status) filter.status = String(filters.status).toUpperCase();

  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(filters.pageSize) || 20));

  const [total, orders, groups] = await Promise.all([
    countOrders(filter),
    listOrders({ filter, skip: (page - 1) * pageSize, limit: pageSize }),
    aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalMinorUnits: { $sum: '$totalMinorUnits' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const rows = [];
  for (const order of orders) {
    const company = await loadCompany(order.companyId);
    rows.push(billingRow(order, company?.name));
  }

  const byStatus = (groups || []).map((group) => ({
    status: group._id,
    count: group.count,
    totalMinorUnits: group.totalMinorUnits || 0,
    totalDisplay: formatMinorUnits(group.totalMinorUnits || 0),
  }));
  const paid = byStatus.find((entry) => entry.status === 'PAID');

  return {
    rows,
    page,
    pageSize,
    total,
    summary: {
      orderCount: total,
      collectedMinorUnits: paid?.totalMinorUnits || 0,
      collectedDisplay: formatMinorUnits(paid?.totalMinorUnits || 0),
      paidOrderCount: paid?.count || 0,
      byStatus,
    },
  };
};
