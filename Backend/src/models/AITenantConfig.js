// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.2 — PER-TENANT AI CONFIGURATION
//
//  ONE ROW PER TENANT. This is CONFIGURATION, not conversation: there is
//  deliberately no field that could hold a prompt, a response, a chat
//  history or any piece of employee PII. The privacy law from 36.1 is
//  enforced here by absence, exactly as it is in AIUsageLog.
//
//  WHY A DOCUMENT AND NOT ENV
//    Env is process-wide. A tenant-level kill switch and a per-tenant
//    token allowance cannot live in a process-wide variable — a platform
//    hosting N tenants would need N API processes. So the two knobs an
//    operator needs per tenant live here, and the env values stay the
//    DEFAULT for tenants that have never been configured (Phase 36 §5.7).
//
//  READ-ONLY BY THE AI
//    The context retriever reads `allowedCategories` from here. Nothing
//    in this model is ever sent to a vendor.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import {
  AI_CONTEXT_CATEGORIES,
  AI_DEFAULT_LANGUAGE,
  AI_LANGUAGE_CODES,
  AI_TENANT_LANGUAGE_DEFAULT,
} from '../services/ai/aiConfig.js';

const { Schema } = mongoose;

// Closed on purpose (Phase 36 §10): 'payroll' and 'performance' are NOT
// here. Reading payroll needs the payslip-scope authorisation chain and
// reading performance needs the appraisal access chain — neither may be
// switched on by a config row, and neither is in this phase.
export const AI_TENANT_CATEGORY_DEFAULT = Object.freeze([
  ...AI_CONTEXT_CATEGORIES,
]);

const aiTenantConfigSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: [true, 'companyId is required'],
      unique: true,
      index: true,
    },

    // Per-tenant kill switch. Defaults to ON so a tenant that has never
    // been configured still works when the global switch is on; the
    // operator turns this OFF to disable AI for one tenant.
    enabled: { type: Boolean, default: true },

    // null  → use env AI_MONTHLY_QUOTA_TOKENS (the platform default)
    // 0     → unlimited (36.1 semantics: a zero nobody meant must not
    //         lock a tenant out)
    // n > 0 → hard monthly token cap for THIS tenant
    monthlyQuotaTokens: {
      type: Number,
      default: null,
      min: [0, 'monthlyQuotaTokens must be 0 (unlimited) or a positive integer'],
    },

    // Which HR context categories this tenant's employees may retrieve.
    // Non-empty by validation: an operator who wants "nothing" disables
    // the tenant instead, which is one switch rather than four.
    allowedCategories: {
      type: [String],
      enum: [...AI_CONTEXT_CATEGORIES],
      default: AI_TENANT_CATEGORY_DEFAULT,
    },

    // Which reply languages this tenant's employees may pick.
    //
    // 36.7 — an admin adds a language here and it OPENS UP in the
    // assistant's selector. The default is the 36.5 set, so an
    // unconfigured tenant behaves exactly as it did before.
    //
    // The enum is the PLATFORM CATALOGUE, not the default set: an admin
    // may enable any language the platform knows how to ask for, and may
    // not invent one. A free-text language would let a typo reach the
    // prompt, and the model would then answer in something nobody chose
    // while the UI claimed otherwise.
    languages: {
      type: [String],
      enum: [...AI_LANGUAGE_CODES],
      default: AI_TENANT_LANGUAGE_DEFAULT,
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

// An empty allowlist is refused at the model, so no code path can persist
// a tenant that silently returns nothing. The retriever still tolerates an
// empty EFFECTIVE set (requested ∩ allowed can be empty even when the
// allowlist is not) — that is a rendering concern, not a config one.
aiTenantConfigSchema.path('allowedCategories').validate(
  (value) => Array.isArray(value) && value.length > 0,
  'allowedCategories must list at least one category',
);

// WHY ENGLISH IS MANDATORY.
//
// English is the one language the system prompt needs NO rule for, and it
// is the platform's fallback when a caller sends nothing. A tenant that
// switched English off would therefore have a selector promising languages
// the prompt cannot produce for a default request — the same quiet lie the
// 36.5 validator was written to prevent. So the base case cannot be turned
// off, and this is enforced at the model rather than in the UI so no code
// path can persist it.
aiTenantConfigSchema.path('languages').validate(
  (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.includes(AI_DEFAULT_LANGUAGE),
  'languages must list at least one language and must always include English',
);

const AITenantConfig = mongoose.model('AITenantConfig', aiTenantConfigSchema);

export default AITenantConfig;

export { aiTenantConfigSchema };
