// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — USER PRESENCE (DURABLE PREFERENCES ONLY)
//
//  WHAT THIS DOCUMENT OWNS
//    One row per employee. The CURRENT (manual) row carries the four
//    durable preferences Phase 37.1 is allowed to remember:
//        manualStatus / manualStatusExpiresAt
//        statusMessage / statusMessageExpiresAt
//        workLocation / workLocationExpiresAt
//
//  WHAT THIS DOCUMENT DELIBERATELY DOES NOT OWN (Phase 37 §6, §7, §18)
//    · No heartbeat / last-active field — realtime lives in 37.4.
//    · No activity history — a status change history that records every
//      Available → Busy transition is surveillance, not presence. Phase
//      37 §19 bans this in plain English.
//    · No presence timeline / PresenceHistory collection. Pinned by a
//      source-grep test (test/presenceFoundation.test.js).
//
//  WHY A DEDICATED DOCUMENT, NOT FIELDS ON USER
//    · Presence values change at high frequency during a working day.
//      Keeping them on User would mean every save is a write on a row
//      with select-sensitive fields (password, payrollProfile,
//      bankAccount, etc). A dedicated document scopes writes to the
//      narrow set of fields Phase 37 actually owns.
//    · Compromise: it also makes Phase 36's PII redaction policy trivially
//      correct — nothing in this document is a PII value; the redactor
//      does not even know this document exists. Adding fields here will
//      be a deliberate edit, not a containment escape.
//
//  COMPOUNDITY (Phase 37 §6)
  //    The compound unique index on { companyId, userId } exists so a
  //    duplicate write cannot create two rows for the same employee. It
  //    is NOT authorization: every query still passes both fields
  //    explicitly (Phase 37 §32).
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import {
  PRESENCE_MANUAL_VALUES,
  WORK_LOCATION_VALUES,
} from '../services/presence/presenceConfig.js';

const { Schema } = mongoose;

const userPresenceSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: [true, 'companyId is required'],
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      index: true,
    },

    // Manual status — only the three Phase 37 §3 allows.
    manualStatus: {
      type: String,
      enum: [...PRESENCE_MANUAL_VALUES],
      default: null,
    },
    manualStatusExpiresAt: { type: Date, default: null },

    // Status message — short plain-text availability hint.
    statusMessage: {
      type: String,
      default: '',
      trim: true,
      maxlength: 160,
    },
    statusMessageExpiresAt: { type: Date, default: null },

    // Work location — Office / WFH / Remote.
    workLocation: {
      type: String,
      enum: [...WORK_LOCATION_VALUES],
      default: null,
    },
    workLocationExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One row per employee per tenant. Reads and writes always include both
// fields (Phase 37 §32 — do not rely on uniqueness as authorization).
userPresenceSchema.index({ companyId: 1, userId: 1 }, { unique: true });

const UserPresence = mongoose.model('UserPresence', userPresenceSchema);

export default UserPresence;

export { userPresenceSchema };