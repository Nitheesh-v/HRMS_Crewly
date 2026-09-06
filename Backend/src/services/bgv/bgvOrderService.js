// Phase 30.3 — PAID BGV ORDER service.
//
// Lifecycle:  CREATED -> PENDING_PAYMENT -> PAID (success)
//                                        -> PAYMENT_FAILED (verification failed)
//             CREATED/PENDING_PAYMENT -> CANCELLED (HR cancels before payment)
//             (EXPIRED is reserved for future policy; no auto-expiry in 30.3)
//
// Security invariants:
//  - The BACKEND is the only price authority. Client money keys are rejected;
//    prices are re-resolved from the active Phase 30.2 catalogue at order
//    creation and snapshotted immutably.
//  - Payment mirrors the existing billing architecture: server creates the
//    provider (Razorpay) order with the SERVER amount, the existing checkout
//    runs, and the server verifies the HMAC signature itself. A frontend
//    "paid" claim means nothing. Mock gateway exists ONLY when no Razorpay
//    keys are configured (identical to billing) and is an explicit confirm.
//  - Tenant authority comes ONLY from companyId; every load/claim filters by
//    it, so other-tenant ids 404 with no existence leak.
//  - verify/cancel are idempotent-safe: the PAID transition is an atomic
//    conditional update, so a duplicated callback or retry never double-pays
//    (we do NOT claim exactly-once webhooks — Mongo state is the truth).
//  - Stops at paid-order readiness: NO consent token, NO candidate email,
//    NO verifier assignment, NO pipeline/stage mutation (Phase 30.4 scope).
//
// All Mongo/provider/audit collaborators are injectable (deps) so the suite
// runs hermetically without a database or any Razorpay network call.

import crypto from 'crypto';
import mongoose from 'mongoose';
import Candidate from '../../models/Candidate.js';
import BgvOrder from '../../models/BgvOrder.js';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { nextBgvOrderCode } from '../../utils/bgvIdentifiers.js';
import { formatMinorUnits } from './bgvCatalogueRules.js';
import { getCatalogueView } from './bgvCatalogueService.js';
import {
  buildOrderSnapshot,
  clientMoneyViolations,
  evaluateOrderEntryEligibility,
  evaluatePurchaseEligibility,
  orderOpenKey,
} from './bgvOrderRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);

// Response DTO — the immutable snapshot is exposed read-only, never writable.
const orderDto = (order) =>
  order
    ? {
        id: order._id,
        orderCode: order.orderCode,
        status: order.status,
        items: (order.items || []).map((item) => ({
          type: item.type,
          name: item.name,
          description: item.description || '',
          unitPriceMinorUnits: item.unitPriceMinorUnits,
          priceDisplay: formatMinorUnits(item.unitPriceMinorUnits),
          currency: item.currency,
          catalogueVersion: item.catalogueVersion,
        })),
        totalMinorUnits: order.totalMinorUnits,
        totalDisplay: formatMinorUnits(order.totalMinorUnits),
        currency: order.currency,
        gateway: order.gateway || null,
        mock: order.gateway === 'mock',
        paidAt: order.paidAt || null,
        failureReason: order.failureReason || '',
        createdAt: order.createdAt || null,
      }
    : null;

// ── default (Mongo / env / SDK) collaborators ────────────────────
const defaultLoadCandidate = async ({ companyId, candidateRef }) => {
  const filter = isObjectId(candidateRef)
    ? { _id: candidateRef, companyId }
    : { companyId, candidateCode: String(candidateRef || '').trim().toUpperCase() };
  return Candidate.findOne(filter).lean();
};

const defaultLoadOpenOrder = ({ companyId, candidateId }) =>
  BgvOrder.findOne({ companyId, candidate: candidateId, openKey: 'OPEN' }).lean();

const defaultInsertOrder = (doc) => BgvOrder.create(doc);

const defaultLoadOrder = ({ companyId, orderId }) =>
  isObjectId(orderId)
    ? BgvOrder.findOne({ _id: orderId, companyId }).lean()
    : Promise.resolve(null);

// Atomic state claim — the ONLY way an order moves status, so concurrent
// verifiers can never both succeed.
const defaultTransitionOrder = ({ companyId, orderId, fromStatuses, set }) =>
  BgvOrder.findOneAndUpdate(
    { _id: orderId, companyId, status: { $in: fromStatuses } },
    { $set: set },
    { returnDocument: 'after' }
  ).lean();

const defaultNextOrderCode = (companyId) => nextBgvOrderCode(companyId);

// Razorpay SDK loaded lazily — only when keys exist (billing's pattern).
let razorpay = null;
const defaultGetRazorpay = async () => {
  if (!razorpay) {
    const { default: Razorpay } = await import('razorpay');
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpay;
};

const defaultRazorConfigured = () =>
  Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

// Provider order with the SERVER amount (totalMinorUnits is already paise).
const defaultCreateProviderOrder = async ({ order, gateway }) => {
  if (gateway !== 'razorpay') {
    return { providerOrderId: `bgvorder_mock_${order._id}` };
  }
  const rzp = await defaultGetRazorpay();
  const created = await rzp.orders.create({
    amount: order.totalMinorUnits, // server-computed, in paise
    currency: order.currency || 'INR',
    receipt: String(order._id),
  });
  return { providerOrderId: created.id };
};

const defaultVerifySignature = ({ orderId, paymentId, signature }) => {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const defaultAudit = (entry) => recordAudit(entry);

// ── read: what this tenant can actually buy ──────────────────────
// Tenant-safe catalogue projection: only the five fixed services, only
// ACTIVE + CONFIGURED ones are purchasable. No platform mutation surface.
export const listPurchasableBgvServices = async (deps = {}) => {
  const view = await getCatalogueView({ findAll: deps.findAll });
  const services = view.services
    .filter((service) => service.configured && service.active)
    .map((service) => ({
      type: service.type,
      name: service.name,
      description: service.description,
      priceMinorUnits: service.priceMinorUnits,
      priceDisplay: service.priceDisplay,
      currency: service.currency,
    }));
  return {
    currency: view.currency,
    configuredCount: services.length,
    services,
  };
};

// ── create the order (server-priced, immutable snapshot) ─────────
export const createBgvOrder = async ({
  companyId,
  candidateRef,
  actorId,
  payload = {},
  requestContext = null,
  deps = {},
}) => {
  const loadCandidate = deps.loadCandidate || defaultLoadCandidate;
  const loadOpenOrder = deps.loadOpenOrder || defaultLoadOpenOrder;
  const insertOrder = deps.insertOrder || defaultInsertOrder;
  const audit = deps.audit || defaultAudit;
  const findAll = deps.findAll;

  // Defense in depth: client money is NEVER accepted (validator also blocks).
  const violations = clientMoneyViolations(payload);
  if (violations.length) {
    throw ApiError.badRequest(
      `Client-provided amounts are not accepted (${violations.join(', ')})`
    );
  }

  // DB Logic - tenant-scoped load; other-tenant refs 404 (no existence leak).
  const candidate = await loadCandidate({ companyId, candidateRef });
  if (!candidate) throw ApiError.notFound('Candidate not found');

  // Duplicate protection: an existing open order is RETURNED, never a second
  // payable order (double-click, double tab, retry).
  const existing = await loadOpenOrder({ companyId, candidateId: candidate._id });
  if (existing) {
    return { reused: true, changed: false, order: orderDto(existing) };
  }

  // Rule gate — enforced here, independent of any frontend button:
  // post-selection stage + INITIATE BGV decision + a sane selection.
  const eligibility = evaluatePurchaseEligibility({
    stage: candidate.currentStage || candidate.stage,
    decisionStatus: candidate.bgvDecision?.status || 'NONE',
    selectedTypes: payload.selected,
  });
  if (!eligibility.allowed) {
    if (eligibility.code === 'BGV_WAIVED') {
      throw ApiError.conflict(eligibility.reason);
    }
    throw ApiError.badRequest(eligibility.reason);
  }

  // SERVER price authority: re-resolve the ACTIVE catalogue now and snapshot.
  const view = await getCatalogueView({ findAll });
  const purchasable = new Map(
    view.services
      .filter((service) => service.configured && service.active)
      .map((service) => [service.type, service])
  );
  const unavailable = payload.selected.filter((type) => !purchasable.has(type));
  if (unavailable.length) {
    throw ApiError.badRequest(
      `Not available for purchase: ${unavailable.join(', ')}`
    );
  }
  const snapshot = buildOrderSnapshot(
    payload.selected,
    Object.fromEntries(
      payload.selected.map((type) => {
        const service = purchasable.get(type);
        return [
          type,
          {
            priceMinorUnits: service.priceMinorUnits,
            currency: service.currency,
            version: service.version,
            name: service.name,
            description: service.description,
          },
        ];
      })
    )
  );

  const orderCode = await (deps.nextOrderCode || defaultNextOrderCode)(companyId);
  let created;
  try {
    created = await insertOrder({
      companyId,
      candidate: candidate._id,
      orderCode,
      status: 'CREATED',
      items: snapshot.items,
      totalMinorUnits: snapshot.totalMinorUnits,
      currency: snapshot.currency,
      openKey: orderOpenKey('CREATED'),
      createdBy: actorId ?? null,
    });
  } catch (error) {
    // DB-backed duplicate protection: a concurrent create (double tab /
    // double click) hits the partial unique openKey index — return the
    // winner instead of a 500 or a second payable order.
    if (error?.code === 11000) {
      const winner = await loadOpenOrder({ companyId, candidateId: candidate._id });
      if (winner) {
        return { reused: true, changed: false, order: orderDto(winner) };
      }
    }
    throw error;
  }

  // Audit — safe metadata only (no secrets, signatures or documents).
  await audit({
    req: requestContext,
    action: 'BGV_ORDER_CREATED',
    companyId,
    actorId,
    resource: 'BgvOrder',
    resourceId: created._id,
    newValue: {
      orderCode,
      status: 'CREATED',
      services: snapshot.items.map((item) => item.type),
      totalMinorUnits: snapshot.totalMinorUnits,
    },
    metadata: { candidateId: candidate._id, phase: '30.3' },
  }).catch(() => {});

  return { reused: false, changed: true, order: orderDto(created) };
};

// ── initiate payment (server creates the provider order) ─────────
export const initiateBgvOrderPayment = async ({
  companyId,
  orderId,
  deps = {},
}) => {
  const loadOrder = deps.loadOrder || defaultLoadOrder;
  const transitionOrder = deps.transitionOrder || defaultTransitionOrder;
  const razorConfigured = deps.razorConfigured || defaultRazorConfigured;
  const createProviderOrder = deps.createProviderOrder || defaultCreateProviderOrder;

  const order = await loadOrder({ companyId, orderId });
  if (!order) throw ApiError.notFound('BGV order not found');

  // Revisit safety: a paid order just replays its state.
  if (order.status === 'PAID') {
    return { order: orderDto(order), checkout: null };
  }
  if (!['CREATED', 'PENDING_PAYMENT'].includes(order.status)) {
    throw ApiError.badRequest('This order can no longer be paid');
  }
  // Idempotent initiate: reuse the existing provider order, never create two.
  if (order.status === 'PENDING_PAYMENT' && order.providerOrderId) {
    return {
      order: orderDto(order),
      checkout: {
        providerOrderId: order.providerOrderId,
        amountMinorUnits: order.totalMinorUnits,
        currency: order.currency,
        mock: order.gateway === 'mock',
        keyId: order.gateway === 'razorpay' ? process.env.RAZORPAY_KEY_ID || null : null,
      },
    };
  }

  const gateway = razorConfigured() ? 'razorpay' : 'mock';
  let providerOrderId = '';
  try {
    ({ providerOrderId } = await createProviderOrder({ order, gateway }));
  } catch (error) {
    // Transient gateway outage must not void the order (stays payable).
    throw ApiError.badRequest(
      `Payment gateway unavailable: ${error?.message || 'provider error'}`
    );
  }

  const claimed = await transitionOrder({
    companyId,
    orderId,
    fromStatuses: ['CREATED'],
    set: {
      status: 'PENDING_PAYMENT',
      gateway,
      providerOrderId,
      openKey: orderOpenKey('PENDING_PAYMENT'),
    },
  });
  const current = claimed || (await loadOrder({ companyId, orderId }));
  return {
    order: orderDto(current),
    checkout: {
      providerOrderId: current?.providerOrderId || providerOrderId,
      amountMinorUnits: current?.totalMinorUnits ?? order.totalMinorUnits,
      currency: current?.currency || 'INR',
      mock: gateway === 'mock',
      keyId: gateway === 'razorpay' ? process.env.RAZORPAY_KEY_ID || null : null,
    },
  };
};

// ── verify payment (server-side truth; idempotent on PAID) ───────
export const verifyBgvOrderPayment = async ({
  companyId,
  orderId,
  payload = {},
  actorId = null,
  requestContext = null,
  deps = {},
}) => {
  const loadOrder = deps.loadOrder || defaultLoadOrder;
  const transitionOrder = deps.transitionOrder || defaultTransitionOrder;
  const verifySignature = deps.verifySignature || defaultVerifySignature;
  const audit = deps.audit || defaultAudit;

  const order = await loadOrder({ companyId, orderId });
  if (!order) throw ApiError.notFound('BGV order not found');

  // Duplicate callback / retry: replay the authoritative state, no second
  // transition, no duplicate audit.
  if (order.status === 'PAID') {
    return { idempotent: true, changed: false, order: orderDto(order) };
  }
  if (!['CREATED', 'PENDING_PAYMENT'].includes(order.status)) {
    throw ApiError.badRequest('This order is not awaiting payment');
  }

  // Server verification: real gateway => HMAC(orderId|paymentId); mock is
  // possible ONLY when the order itself was created on the mock gateway.
  let verified = false;
  if (order.gateway === 'mock') {
    verified = payload.mock === true; // explicit TEST MODE confirm
  } else if (order.gateway === 'razorpay') {
    verified = verifySignature({
      orderId: order.providerOrderId,
      paymentId: payload.razorpay_payment_id,
      signature: payload.razorpay_signature,
    });
  }

  if (!verified) {
    const failed = await transitionOrder({
      companyId,
      orderId,
      fromStatuses: ['CREATED', 'PENDING_PAYMENT'],
      set: {
        status: 'PAYMENT_FAILED',
        failureReason: 'Payment verification failed',
        openKey: orderOpenKey('PAYMENT_FAILED'),
      },
    });
    if (failed) {
      await audit({
        req: requestContext,
        action: 'BGV_ORDER_PAYMENT_FAILED',
        companyId,
        actorId,
        resource: 'BgvOrder',
        resourceId: orderId,
        previousValue: { status: order.status },
        newValue: { status: 'PAYMENT_FAILED' },
        metadata: { orderCode: order.orderCode, phase: '30.3' },
      }).catch(() => {});
    }
    throw ApiError.badRequest('Payment verification failed');
  }

  // Atomic conditional PAID claim — a concurrent second callback finds PAID
  // and replays it (idempotent).
  const claimed = await transitionOrder({
    companyId,
    orderId,
    fromStatuses: ['CREATED', 'PENDING_PAYMENT'],
    set: {
      status: 'PAID',
      paidAt: new Date(),
      gatewayPaymentId: payload.razorpay_payment_id || '',
      openKey: orderOpenKey('PAID'),
    },
  });
  if (!claimed) {
    const reloaded = await loadOrder({ companyId, orderId });
    if (reloaded?.status === 'PAID') {
      return { idempotent: true, changed: false, order: orderDto(reloaded) };
    }
    throw ApiError.conflict('Order is no longer awaiting payment');
  }

  // Audit — safe metadata only; never signatures, secrets or card data.
  await audit({
    req: requestContext,
    action: 'BGV_ORDER_PAID',
    companyId,
    actorId,
    resource: 'BgvOrder',
    resourceId: orderId,
    previousValue: { status: order.status },
    newValue: { status: 'PAID', totalMinorUnits: order.totalMinorUnits },
    metadata: {
      orderCode: order.orderCode,
      gateway: order.gateway,
      phase: '30.3',
    },
  }).catch(() => {});

  // NOTE: candidate consent is Phase 30.4 — nothing is sent or generated here.
  return { idempotent: false, changed: true, order: orderDto(claimed) };
};

// ── cancel an unpaid order (HR) ──────────────────────────────────
export const cancelBgvOrder = async ({
  companyId,
  orderId,
  actorId = null,
  requestContext = null,
  deps = {},
}) => {
  const loadOrder = deps.loadOrder || defaultLoadOrder;
  const transitionOrder = deps.transitionOrder || defaultTransitionOrder;
  const audit = deps.audit || defaultAudit;

  const order = await loadOrder({ companyId, orderId });
  if (!order) throw ApiError.notFound('BGV order not found');
  if (order.status === 'PAID') {
    throw ApiError.badRequest('A paid BGV order cannot be cancelled');
  }
  if (!['CREATED', 'PENDING_PAYMENT'].includes(order.status)) {
    throw ApiError.badRequest('This order is already closed');
  }

  const cancelled = await transitionOrder({
    companyId,
    orderId,
    fromStatuses: ['CREATED', 'PENDING_PAYMENT'],
    set: {
      status: 'CANCELLED',
      failureReason: 'Cancelled before payment',
      openKey: orderOpenKey('CANCELLED'),
    },
  });
  if (!cancelled) {
    throw ApiError.conflict('This order is already closed');
  }

  await audit({
    req: requestContext,
    action: 'BGV_ORDER_CANCELLED',
    companyId,
    actorId,
    resource: 'BgvOrder',
    resourceId: orderId,
    previousValue: { status: order.status },
    newValue: { status: 'CANCELLED' },
    metadata: { orderCode: order.orderCode, phase: '30.3' },
  }).catch(() => {});

  return { changed: true, order: orderDto(cancelled) };
};

// ── read: the candidate's current order (refresh / resume) ───────
export const getBgvOrderForCandidate = async ({
  companyId,
  candidateRef,
  deps = {},
}) => {
  const loadCandidate = deps.loadCandidate || defaultLoadCandidate;
  const loadOpenOrder = deps.loadOpenOrder || defaultLoadOpenOrder;

  const candidate = await loadCandidate({ companyId, candidateRef });
  if (!candidate) throw ApiError.notFound('Candidate not found');

  const order = await loadOpenOrder({ companyId, candidateId: candidate._id });
  const eligibility = evaluateOrderEntryEligibility({
    stage: candidate.currentStage || candidate.stage,
    decisionStatus: candidate.bgvDecision?.status || 'NONE',
  });
  return {
    order: orderDto(order),
    eligible: eligibility.allowed || Boolean(order),
    code: order ? 'ORDER_EXISTS' : eligibility.code,
    reason: order ? '' : eligibility.reason,
  };
};
