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
import BgvConsentAccessToken from '../../models/BgvConsentAccessToken.js';
import Candidate from '../../models/Candidate.js';
import Company from '../../models/Company.js';
import SystemEvent from '../../models/SystemEvent.js';
import ApiError from '../../utils/ApiError.js';
import { formatMinorUnits } from './bgvCatalogueRules.js';
import { canTransitionOrder, orderOpenKey } from './bgvOrderRules.js';

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

// ── Phase 30.12 addendum — HR initiated BGV, candidate never replied ──────
// "Unanswered" = the LATEST consent invitation on a PAID order carries no
// finalDecision (CONSENTED/DECLINED both count as replied). Superseded
// (rotated) tokens never fake a pending row: only the latest token per
// order decides. The super admin may cancel ONLY after the invitation
// window expired — the existing consent token expiry is the clock, so no
// new SLA constant is invented here.

const defaultGroupUnanswered = () =>
  BgvConsentAccessToken.aggregate([
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$bgvOrder',
        finalDecision: { $first: '$finalDecision' },
        sentAt: { $first: '$createdAt' },
        expiresAt: { $first: '$expiresAt' },
        viewCount: { $first: '$viewCount' },
        lastViewedAt: { $first: '$lastViewedAt' },
      },
    },
    { $match: { finalDecision: null } },
  ]);
const defaultLoadOrdersByIds = (ids) =>
  BgvOrder.find({ _id: { $in: ids } }).lean();
const defaultLoadCandidateName = (candidateId) =>
  Candidate.findById(candidateId).select('name').lean();
const defaultLoadOrder = (orderId) => BgvOrder.findById(orderId).lean();
const defaultLoadLatestToken = (orderId) =>
  BgvConsentAccessToken.findOne({ bgvOrder: orderId })
    .sort({ createdAt: -1 })
    .lean();
const defaultUpdateOrder = (orderId, set) =>
  BgvOrder.findOneAndUpdate({ _id: orderId }, { $set: set }, { new: true }).lean();
const defaultRevokeActiveTokens = ({ companyId, orderId, reason }) =>
  BgvConsentAccessToken.updateMany(
    { companyId, bgvOrder: orderId, activeKey: 'ACTIVE' },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
const defaultAudit = (entry) => SystemEvent.create(entry);

// GET awaiting-candidate — every PAID order whose latest consent invitation
// is still unanswered, oldest wait first.
export const bgvAwaitingCandidateResponses = async ({ filters = {}, deps = {} }) => {
  const groupUnanswered = deps.groupUnanswered || defaultGroupUnanswered;
  const loadOrdersByIds = deps.loadOrdersByIds || defaultLoadOrdersByIds;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const loadCandidate = deps.loadCandidate || defaultLoadCandidateName;

  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(filters.pageSize) || 20));

  const grouped = await groupUnanswered();
  const byOrder = new Map((grouped || []).map((g) => [String(g._id), g]));
  const orders = (await loadOrdersByIds([...byOrder.keys()]))
    .filter((order) => order.status === 'PAID')
    .sort((a, b) => {
      const ga = byOrder.get(String(a._id))?.sentAt || new Date(0);
      const gb = byOrder.get(String(b._id))?.sentAt || new Date(0);
      return new Date(ga) - new Date(gb);
    });

  const total = orders.length;
  const slice = orders.slice((page - 1) * pageSize, page * pageSize);
  const now = Date.now();
  const rows = [];
  for (const order of slice) {
    const entry = byOrder.get(String(order._id)) || {};
    const [company, candidate] = await Promise.all([
      loadCompany(order.companyId),
      loadCandidate(order.candidate),
    ]);
    const expired =
      !!entry.expiresAt && new Date(entry.expiresAt).getTime() <= now;
    rows.push({
      orderId: String(order._id),
      orderCode: order.orderCode,
      companyName: company?.name || '',
      candidateName: candidate?.name || '',
      totalDisplay: formatMinorUnits(order.totalMinorUnits || 0),
      sentAt: entry.sentAt || null,
      expiresAt: entry.expiresAt || null,
      expired,
      daysWaiting: entry.sentAt
        ? Math.floor((now - new Date(entry.sentAt).getTime()) / 86400000)
        : 0,
      viewCount: entry.viewCount || 0,
      lastViewedAt: entry.lastViewedAt || null,
      // Server-authoritative: cancel is offered only after the window ended.
      cancellable: expired,
    });
  }
  return { rows, page, pageSize, total };
};

// POST cancel — platform stale-cancel of an unanswered request.
export const cancelUnansweredBgvRequest = async ({
  orderId,
  reason,
  actorId,
  deps = {},
}) => {
  const loadOrder = deps.loadOrder || defaultLoadOrder;
  const loadLatestToken = deps.loadLatestToken || defaultLoadLatestToken;
  const updateOrder = deps.updateOrder || defaultUpdateOrder;
  const revokeActiveTokens = deps.revokeActiveTokens || defaultRevokeActiveTokens;
  const audit = deps.audit || defaultAudit;

  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 10) {
    throw ApiError.badRequest('Give a cancellation reason of at least 10 characters');
  }

  const order = await loadOrder(orderId);
  if (!order) throw ApiError.notFound('BGV order not found');
  if (order.status !== 'PAID') {
    throw ApiError.badRequest(
      'Only a paid BGV request stuck on the candidate can be cancelled here'
    );
  }
  const latest = await loadLatestToken(order._id);
  if (!latest) {
    throw ApiError.badRequest('No consent invitation was ever sent for this order — nothing unanswered to cancel');
  }
  if (latest.finalDecision) {
    throw ApiError.badRequest('The candidate already responded — this request is not unanswered');
  }
  const expired =
    !!latest.expiresAt && new Date(latest.expiresAt).getTime() <= Date.now();
  if (!expired) {
    throw ApiError.badRequest(
      'The candidate response window has not ended yet — cancel becomes available only after the invitation expired'
    );
  }
  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    throw ApiError.badRequest('This order cannot be cancelled from its current state');
  }

  const updated = await updateOrder(order._id, {
    status: 'CANCELLED',
    // Release the candidate so the tenant can raise a fresh request.
    openKey: orderOpenKey('CANCELLED'),
  });
  await revokeActiveTokens({
    companyId: order.companyId,
    orderId: order._id,
    reason: 'PLATFORM_CANCELLED',
  });
  await audit({
    type: 'BGV_ORDER_PLATFORM_CANCELLED',
    level: 'WARN',
    title: `BGV request ${order.orderCode} cancelled (candidate never replied)`,
    message: cleanReason,
    targetType: 'BgvOrder',
    targetId: order._id,
    metadata: {
      companyId: order.companyId,
      actorId: actorId ?? null,
      totalMinorUnits: order.totalMinorUnits,
      invitationSentAt: latest.createdAt || null,
      invitationExpiredAt: latest.expiresAt || null,
    },
  });
  return {
    orderId: String(order._id),
    orderCode: order.orderCode,
    status: updated?.status || 'CANCELLED',
  };
};
