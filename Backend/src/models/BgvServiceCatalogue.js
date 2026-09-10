// Phase 30.2 — BGV SERVICE CATALOGUE (platform-owned, no companyId).
//
// One configurable commercial record per backend-allowlisted product type.
// The fixed product definitions live in services/bgv/bgvCatalogueRules.js;
// this collection stores ONLY commercial configuration. Absence of a record
// means "unconfigured" and therefore NOT purchasable — nothing is seeded.
//
// Historical price safety: future Phase 30.3 orders must snapshot
// priceMinorUnits/currency/version at purchase time. Orders must never store
// a live reference to this document as their historical amount.

import mongoose from 'mongoose';
import {
  BGV_CATALOGUE_TYPES,
  BGV_CATALOGUE_CURRENCY,
  BGV_PRICE_MAX_MINOR,
  BGV_PRICE_MIN_MINOR,
} from '../services/bgv/bgvCatalogueRules.js';

const bgvServiceCatalogueSchema = new mongoose.Schema(
  {
    // Backend-controlled stable product type; unique so duplicate catalogue
    // rows for the same product can never emerge (index + atomic upsert).
    type: {
      type: String,
      enum: BGV_CATALOGUE_TYPES,
      required: true,
      unique: true,
      index: true,
    },
    displayName: { type: String, trim: true, maxlength: 120, default: '' },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    // Integer minor currency units (paise). Never a float.
    priceMinorUnits: {
      type: Number,
      required: true,
      min: BGV_PRICE_MIN_MINOR,
      max: BGV_PRICE_MAX_MINOR,
    },
    currency: {
      type: String,
      enum: [BGV_CATALOGUE_CURRENCY],
      default: BGV_CATALOGUE_CURRENCY,
    },
    // Deactivation hides the product from NEW purchases; the record (and any
    // historical order snapshots referencing its version) is never deleted.
    active: { type: Boolean, default: true },
    // Simple optimistic-concurrency/provenance counter; bumped per mutation
    // and copied into future order snapshots.
    version: { type: Number, default: 1, min: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedReason: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true }
);

const BgvServiceCatalogue = mongoose.model(
  'BgvServiceCatalogue',
  bgvServiceCatalogueSchema
);

export default BgvServiceCatalogue;
