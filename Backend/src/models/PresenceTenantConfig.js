// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PER-TENANT PRESENCE CONFIGURATION
//
//  ONE ROW PER TENANT. CONFIGURATION ONLY — there is deliberately no
//  field that could hold a status message, a presence history, a manual
//  status or any other piece of user content. Privacy by absence: the
//  privacy law from 36.1 is not project-specific, it is a standing rule.
//
//  WHY NOT INTO AITENANTCONFIG
//    Phase 37 must work when AI is completely disabled (Phase 37 §22 +
//    §8). Coupling presence to AITenantConfig would mean turning AI off
//    also turned presence off, which is exactly the failure mode the
//    owner has rejected in writing.
//
//  UPSERT + setDefaultsOnInsert (Phase 36 capsule §4.2)
//    On first read the service does:
//
//        findOneAndUpdate(
//          { companyId },
//          { $setOnInsert: { companyId } },
//          { upsert: true, new: true, setDefaultsOnInsert: true },
//        )
//
//    setDefaultsOnInsert is what paints the full default object into the
//    row the first time, so a tenant that has never been configured
//    behaves exactly like the recommended defaults. A test fake MUST
//    implement findOneAndUpdate (not just findOne) — a findOne-only fake
//    returns null, the service falls back to defaults in memory, and the
//    test still passes — except when it asserts persistence.
//
//  TO "SHARE AI COMPANANANANANANANANANA CACHE KEYS"
//    No. Different namespace. A presence cache cannot accidentally land
//    under crewly:<env>::ai:...; the helper namespaces exist in
//    services/presence/presenceConfig.js.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import {
  PRESENCE_TENANT_DEFAULTS,
  WFH_MODES,
  WORK_LOCATION_VALUES,
} from '../services/presence/presenceConfig.js';

const { Schema } = mongoose;

// The platform-wide set of allowed work locations is the frozen
// WORK_LOCATION_VALUES list. A tenant can DISABLE some but cannot
// invent one — Phase 37 §8 / §9.
const ALLOWED_WORK_LOCATIONS_SET = new Set(WORK_LOCATION_VALUES);

const presenceTenantConfigSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: [true, 'companyId is required'],
      unique: true,
      index: true,
    },

    enabled: { type: Boolean, default: PRESENCE_TENANT_DEFAULTS.enabled },
    employeePresenceVisible: {
      type: Boolean,
      default: PRESENCE_TENANT_DEFAULTS.employeePresenceVisible,
    },
    statusMessagesEnabled: {
      type: Boolean,
      default: PRESENCE_TENANT_DEFAULTS.statusMessagesEnabled,
    },
    workLocationEnabled: {
      type: Boolean,
      default: PRESENCE_TENANT_DEFAULTS.workLocationEnabled,
    },

    wfhMode: {
      type: String,
      enum: WFH_MODES,
      default: PRESENCE_TENANT_DEFAULTS.wfhMode,
    },

    awayAfterMinutes: {
      type: Number,
      default: PRESENCE_TENANT_DEFAULTS.awayAfterMinutes,
      min: [1, 'awayAfterMinutes must be a positive integer'],
    },
    offlineAfterMinutes: {
      type: Number,
      default: PRESENCE_TENANT_DEFAULTS.offlineAfterMinutes,
      min: [1, 'offlineAfterMinutes must be a positive integer'],
    },

    lastSeenVisible: {
      type: Boolean,
      default: PRESENCE_TENANT_DEFAULTS.lastSeenVisible,
    },

    // Phase 37 §8 — allowedWorkLocations is a subset of the platform
    // vocabulary. Empty is allowed ONLY when workLocationEnabled=false;
    // when the feature is on, the list must contain at least one entry
    // (validated below).
    allowedWorkLocations: {
      type: [String],
      enum: [...WORK_LOCATION_VALUES],
      default: [...PRESENCE_TENANT_DEFAULTS.allowedWorkLocations],
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

// Phase 37 §9 — invariants enforced at the MODEL layer so no code path can
// persist a config the route is supposed to refuse. The validator mirrors
// these (defence in depth — see capsule §4.2: "an empty allowlist is
// refused at the model, so no code path can persist a tenant that
// silently returns nothing").
presenceTenantConfigSchema.path('allowedWorkLocations').validate(
  (value) => {
    if (!Array.isArray(value)) return false;

    // No duplicates — silent dedupes hide bugs.
    const set = new Set(value);
    if (set.size !== value.length) return false;

    // Every value must be a platform-allowed location.
    for (const v of value) if (!ALLOWED_WORK_LOCATIONS_SET.has(v)) return false;

    return true;
  },
  'allowedWorkLocations must be a deduplicated subset of office, wfh, remote',
);

// If work-location is enabled, allowedWorkLocations cannot be empty. An
// admin who wants "no work location" turns the toggle off — that's one
// switch, not two.
presenceTenantConfigSchema.path('workLocationEnabled').validate(
  function validateWorkLocationEnabled(value) {
    if (!value) return true;
    const list = this.allowedWorkLocations;
    return Array.isArray(list) && list.length > 0;
  },
  'allowedWorkLocations must contain at least one location when workLocationEnabled is true',
);

// Phase 37 §9 — offline > away. Both must be positive. If equal, Offline
// would fire the instant Away did, which makes the value meaningless.
presenceTenantConfigSchema.path('offlineAfterMinutes').validate(
  function validateOfflineGreaterThanAway(value) {
    const away = this.awayAfterMinutes;
    if (typeof away !== 'number' || typeof value !== 'number') return false;
    return value > away;
  },
  'offlineAfterMinutes must be greater than awayAfterMinutes',
);

const PresenceTenantConfig = mongoose.model(
  'PresenceTenantConfig',
  presenceTenantConfigSchema,
);

export default PresenceTenantConfig;

export { presenceTenantConfigSchema };