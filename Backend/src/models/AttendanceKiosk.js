import { Schema, model } from 'mongoose';

/*
 * Phase 31.14 — shared workplace attendance station.
 *
 * A station is a TRUSTED DEVICE, not an employee identity: the
 * station secret authenticates the tablet/terminal; the employee
 * still identifies per punch with their tenant employee code.
 *
 * INVARIANTS:
 * - the raw station secret is shown exactly once (create/rotate)
 *   and only its sha256 persists (secretHash, select:false);
 * - secretVersion invalidates issued kiosk JWTs on rotation;
 * - INACTIVE stations authenticate nothing;
 * - no device fingerprints, no MDM, no surveillance.
 */
const attendanceKioskSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    // Optional 31.3 binding: the station represents this approved
    // workplace. Station-to-location binding is provenance — it is
    // NOT browser-GPS geofence evidence (never claim otherwise).
    location: {
      type: Schema.Types.ObjectId,
      ref: 'AttendanceLocation',
      default: null,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
      index: true,
    },
    secretHash: { type: String, required: true, select: false },
    secretVersion: { type: Number, default: 1, min: 1 },
    lastUsedAt: { type: Date, default: null },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// Station names are unique per tenant: a shared screen must never
// show two "Reception" stations to confuse employees/auditors.
attendanceKioskSchema.index({ companyId: 1, name: 1 }, { unique: true });
attendanceKioskSchema.index({ companyId: 1, status: 1 });

const AttendanceKiosk = model('AttendanceKiosk', attendanceKioskSchema);
export default AttendanceKiosk;
