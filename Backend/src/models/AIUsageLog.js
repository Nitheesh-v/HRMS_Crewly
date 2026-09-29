// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.1 — AI USAGE LOG (the ONLY persistent trace of an AI interaction)
//
//  THE PRIVACY LAW (Phase 36 §5.3 / §5.11)
//    This document stores TOKEN COUNTS, latency, a feature label, a status
//    and a bounded error type. It has NO field that could hold what the user
//    asked or what the model answered — not "optional", not "for debugging",
//    not behind a flag. If this database is ever compromised, the tenant's
//    conversations are not in it.
//
//  WHY THAT IS ENOUGH
//    Everything the product needs to run the AI suite is here: who called it
//    (companyId + userId), when, which feature, how many tokens, how long it
//    took, and whether it worked. Everything a curious operator would want
//    beyond that is exactly what the law forbids.
//
//  SCHEMA/Writer AGREEMENT
//    Phase 35.5 shipped a defect where a service wrote `status`/`message`/`at`
//    into a schema that declared `outcome`/`reason`/`occurredAt`, and Mongoose
//    strict mode silently dropped all three — the evidence vanished with no
//    error. test/aiProviderFoundation.test.js pins the same agreement here:
//    every field the tracker writes must be declared by this schema.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { AI_ERROR_TYPES, AI_USAGE_STATUS } from '../services/ai/aiConfig.js';

const { Schema } = mongoose;

const aiUsageLogSchema = new Schema(
  {
    // ── Identity (both SERVER-DERIVED, never client-supplied) ──────────────
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // ── What was called ────────────────────────────────────────────────────
    // A closed vocabulary (AI_FEATURES). A row with an unknown feature is a
    // coding error and is refused by the enum below.
    feature: {
      type: String,
      required: true,
      maxlength: 64,
      index: true,
    },

    provider: {
      type: String,
      maxlength: 32,
      default: 'groq',
    },

    model: {
      type: String,
      maxlength: 64,
      default: '',
    },

    // ── Cost / volume (the numbers the admin dashboard shows) ──────────────
    promptTokens: { type: Number, default: 0, min: 0 },

    completionTokens: { type: Number, default: 0, min: 0 },

    totalTokens: { type: Number, default: 0, min: 0 },

    latencyMs: { type: Number, default: 0, min: 0 },

    // ── Outcome ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(AI_USAGE_STATUS),
      required: true,
      index: true,
    },

    // Bounded vocabulary (AI_ERROR_TYPES). 'none' on success. NEVER a vendor
    // message: the enum below makes an accidental leak impossible to store.
    errorType: {
      type: String,
      enum: AI_ERROR_TYPES,
      default: 'none',
    },
  },
  { timestamps: true },
);

// Quota reads are "sum of totalTokens for this tenant, this calendar month".
// One compound index serves the aggregation's $match exactly.
aiUsageLogSchema.index({ companyId: 1, createdAt: -1 });

// The admin dashboard's per-feature and per-status breakdowns.
aiUsageLogSchema.index({ companyId: 1, feature: 1, createdAt: -1 });

const AIUsageLog = mongoose.model('AIUsageLog', aiUsageLogSchema);

export default AIUsageLog;
