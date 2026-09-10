// Phase 30.3 — BGV ORDER (paid background-verification purchase).
//
// One document = one tenant's commercial purchase of BGV services for one
// candidate, entered ONLY through the Phase 30.1 INITIATE BGV decision.
//
// Invariants enforced at the schema level:
//  - `items` and `totalMinorUnits` are IMMUTABLE snapshots of the server
//    catalogue at purchase time; later Phase 30.2 price changes must never
//    rewrite a historical order.
//  - `openKey` + the partial unique index give DB-backed duplicate protection
//    (double-click, double tab, retry): at most ONE open (CREATED /
//    PENDING_PAYMENT / PAID) order per (company, candidate). Failed or
//    cancelled orders release the candidate (openKey -> null) so a fresh
//    order can be raised.
//  - Tenant scope: companyId is required and immutable; every lookup filters
//    by it.

import mongoose from 'mongoose';
import { BGV_CATALOGUE_TYPES } from '../services/bgv/bgvCatalogueRules.js';
import { BGV_ORDER_STATUSES } from '../services/bgv/bgvOrderRules.js';

const { Schema } = mongoose;

// Commercial line-item snapshot — every field frozen at creation.
const bgvOrderItemSchema = new Schema(
  {
    type: {
      type: String,
      enum: BGV_CATALOGUE_TYPES,
      required: true,
      immutable: true,
    },
    name: { type: String, required: true, immutable: true },
    description: { type: String, default: '', immutable: true },
    // Server-authoritative unit price in minor units (paise), INR.
    unitPriceMinorUnits: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
    },
    currency: { type: String, default: 'INR', enum: ['INR'], immutable: true },
    // Catalogue version the price came from (provenance only).
    catalogueVersion: { type: Number, default: 0, immutable: true },
  },
  { _id: false }
);

const bgvOrderSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
      index: true,
    },
    candidate: {
      type: Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      immutable: true,
    },
    // Human-readable reference via TenantSequence ('BGV_ORDER' key),
    // e.g. BGVORD-000042 — never Date.now/Math.random.
    orderCode: { type: String, required: true, immutable: true },
    status: {
      type: String,
      enum: BGV_ORDER_STATUSES,
      default: 'CREATED',
    },
    // Immutable commercial snapshot (see item schema).
    items: {
      type: [bgvOrderItemSchema],
      required: true,
      immutable: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length >= 1,
        message: 'A BGV order must contain at least one service',
      },
    },
    totalMinorUnits: { type: Number, required: true, min: 0, immutable: true },
    currency: { type: String, default: 'INR', enum: ['INR'], immutable: true },

    // ── payment (mirrors the existing billing Payment architecture) ──
    gateway: { type: String, enum: ['razorpay', 'mock', null], default: null },
    providerOrderId: { type: String, default: '' }, // gateway (or mock) order id
    gatewayPaymentId: { type: String, default: '' }, // gateway payment id
    failureReason: { type: String, default: '' },
    paidAt: { type: Date, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    // Duplicate-protection key: 'OPEN' while the order blocks a second
    // purchase, null once terminal-unpaid (PAYMENT_FAILED / CANCELLED /
    // EXPIRED). PAID stays 'OPEN' — the paid order is the candidate's order.
    openKey: { type: String, enum: ['OPEN', null], default: null },
  },
  { timestamps: true }
);

// At most ONE open order per (company, candidate) — DB-level guarantee.
bgvOrderSchema.index(
  { companyId: 1, candidate: 1, openKey: 1 },
  { unique: true, partialFilterExpression: { openKey: 'OPEN' } }
);

// Human reference lookups (tenant-scoped).
bgvOrderSchema.index({ companyId: 1, orderCode: 1 }, { unique: true });
// Resume/refresh lookups: latest order for a candidate.
bgvOrderSchema.index({ companyId: 1, candidate: 1, createdAt: -1 });

export default mongoose.model('BgvOrder', bgvOrderSchema);
