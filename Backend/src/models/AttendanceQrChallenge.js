import { Schema, model } from 'mongoose';

/*
 * Phase 31.14 — short-lived workplace QR challenges.
 *
 * A challenge proves POSSESSION of a fresh workplace code, never
 * employee identity: identity always comes from the authenticated
 * employee session that redeems it.
 *
 * INVARIANTS (BgvVerifierToken precedent):
 * - raw tokens are returned exactly once at creation; only sha256
 *   hashes persist (tokenHash, select:false);
 * - purpose-isolated, tenant-scoped, location/station-scoped;
 * - short expiry (TTL index reaps dead rows) + single-use atomic
 *   claim (usedAt/compare-and-set — concurrent redeems: one wins);
 * - raw values are never audited, never logged, never queued.
 */
export const QR_CHALLENGE_PURPOSES = ['ATTENDANCE_PUNCH'];

const attendanceQrChallengeSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    purpose: {
      type: String,
      enum: QR_CHALLENGE_PURPOSES,
      required: true,
      default: 'ATTENDANCE_PUNCH',
    },
    // Workplace scope: at least one is required (service-enforced).
    location: {
      type: Schema.Types.ObjectId,
      ref: 'AttendanceLocation',
      default: null,
    },
    station: {
      type: Schema.Types.ObjectId,
      ref: 'AttendanceKiosk',
      default: null,
    },
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    useCount: { type: Number, default: 0, min: 0 },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

attendanceQrChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Admin history (hashes never selected — metadata only).
attendanceQrChallengeSchema.index({ companyId: 1, createdAt: -1 });

const AttendanceQrChallenge = model('AttendanceQrChallenge', attendanceQrChallengeSchema);
export default AttendanceQrChallenge;
