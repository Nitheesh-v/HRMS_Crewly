// Phase 30.3 — PAID BGV REQUEST / ORDER (pure rules).
//
// Commercial invariants:
//  - The backend is the ONLY price authority. Client-submitted money is
//    rejected, never used.
//  - The order snapshot (items + total) is immutable: later catalogue price
//    changes must never rewrite a historical order.
//  - Only PAID orders become eligible for Phase 30.4 candidate consent
//    (consent itself is NOT implemented here).

import { BGV_CATALOGUE_TYPES } from './bgvCatalogueRules.js';
import { POST_SELECTION_STAGES } from './bgvDecisionRules.js';

export const BGV_ORDER_STATUSES = [
  'CREATED',
  'PENDING_PAYMENT',
  'PAID',
  'PAYMENT_FAILED',
  'CANCELLED',
  'EXPIRED',
];

// Orders that block a second purchase for the same candidate (duplicate
// protection). A FAILED/CANCELLED/EXPIRED order releases the candidate for a
// fresh order; PAID keeps the block (revisit shows the paid order).
export const BGV_ORDER_OPEN_STATUSES = ['CREATED', 'PENDING_PAYMENT', 'PAID'];

export const BGV_ORDER_TRANSITIONS = {
  CREATED: ['PENDING_PAYMENT', 'CANCELLED', 'EXPIRED'],
  PENDING_PAYMENT: ['PAID', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED'],
  // Phase 30.12 — the ONLY exit from PAID is the platform stale-cancel
  // (super admin cancels an answered-nowhere consent request after the
  // invitation window expired; reason + SystemEvent audit mandatory).
  // Tenant flows can never take this edge.
  PAID: ['CANCELLED'],
  PAYMENT_FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const canTransitionOrder = (from, to) =>
  (BGV_ORDER_TRANSITIONS[from] || []).includes(to);

export const orderOpenKey = (status) =>
  BGV_ORDER_OPEN_STATUSES.includes(status) ? 'OPEN' : null;

// Client money keys are never accepted on order creation.
export const CLIENT_MONEY_KEYS = [
  'price',
  'unitPrice',
  'priceMinorUnits',
  'total',
  'totalMinorUnits',
  'amount',
  'currency',
];

export const clientMoneyViolations = (payload = {}) =>
  CLIENT_MONEY_KEYS.filter((key) => payload?.[key] !== undefined);

// Build the immutable commercial snapshot from SERVER-resolved prices only.
// priceMap: type -> { priceMinorUnits, currency, version, name, description }
export const buildOrderSnapshot = (selectedTypes = [], priceMap = {}) => {
  const items = selectedTypes.map((type) => {
    const price = priceMap[type];
    return {
      type,
      name: price?.name || type,
      description: price?.description || '',
      unitPriceMinorUnits: price?.priceMinorUnits ?? 0,
      currency: price?.currency || 'INR',
      catalogueVersion: price?.version ?? 0,
    };
  });
  const totalMinorUnits = items.reduce(
    (sum, item) => sum + item.unitPriceMinorUnits,
    0
  );
  return { items, totalMinorUnits, currency: 'INR' };
};

// Purchase entry requires the Phase 30.1 INITIATE BGV decision on an
// eligible post-selection candidate. The backend enforces this independently
// of any React button.
// Stage + 30.1-decision gate ONLY (used by read/entry points where no
// selection exists yet).
export const evaluateOrderEntryEligibility = ({ stage, decisionStatus }) => {
  if (!POST_SELECTION_STAGES.includes(stage)) {
    return {
      allowed: false,
      code: 'NOT_POST_SELECTION',
      reason: 'BGV purchase is available only after the human final selection',
    };
  }
  if (decisionStatus === 'PROCEEDED_WITHOUT_BGV') {
    return {
      allowed: false,
      code: 'BGV_WAIVED',
      reason: 'This candidate was explicitly proceeded without BGV',
    };
  }
  if (decisionStatus !== 'BGV_INITIATED') {
    return {
      allowed: false,
      code: 'BGV_NOT_INITIATED',
      reason: 'Record the Initiate BGV decision before purchasing checks',
    };
  }
  return { allowed: true, code: '', reason: '' };
};

// Full purchase gate: entry + a sane selection.
export const evaluatePurchaseEligibility = ({
  stage,
  decisionStatus,
  selectedTypes = [],
}) => {
  const entry = evaluateOrderEntryEligibility({ stage, decisionStatus });
  if (!entry.allowed) return entry;
  if (!Array.isArray(selectedTypes) || selectedTypes.length === 0) {
    return {
      allowed: false,
      code: 'NO_SELECTION',
      reason: 'Select at least one BGV service',
    };
  }
  const unknown = selectedTypes.filter((type) => !BGV_CATALOGUE_TYPES.includes(type));
  if (unknown.length) {
    return {
      allowed: false,
      code: 'UNKNOWN_SERVICE',
      reason: `Unsupported BGV service: ${unknown.join(', ')}`,
    };
  }
  const duplicated = selectedTypes.filter(
    (type, index) => selectedTypes.indexOf(type) !== index
  );
  if (duplicated.length) {
    return {
      allowed: false,
      code: 'DUPLICATE_SELECTION',
      reason: 'Each BGV service can be selected once per order',
    };
  }
  return { allowed: true, code: '', reason: '' };
};

// ── commercial authorization boundary (30.4 addendum) ───────────
// The single mapping from the 30.3 order state to commercial readiness.
// Today only a verified per-candidate payment (PAID) authorizes processing;
// future billing modes (prepaid credits, monthly invoice, subscription
// allowance, enterprise postpaid — NOT implemented) must reach this same
// boundary, so consent/invitation code never consults payment-provider
// fields directly.
export const BGV_COMMERCIAL_READINESS = {
  AUTHORIZED: 'AUTHORIZED_FOR_PROCESSING',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
};

export const commercialReadinessOf = (order) =>
  order?.status === 'PAID'
    ? BGV_COMMERCIAL_READINESS.AUTHORIZED
    : BGV_COMMERCIAL_READINESS.NOT_AUTHORIZED;

export const isCommerciallyAuthorized = (order) =>
  commercialReadinessOf(order) === BGV_COMMERCIAL_READINESS.AUTHORIZED;
