import { Schema, model } from 'mongoose';

/*
 * Phase 31.3 — tenant attendance locations (offices, branches, sites).
 *
 * Company premises an OFFICE punch can be verified against: a name, a
 * point on Earth and an allowed radius. Employees are never assigned
 * here in 31.3 — every active location of the tenant is eligible and
 * the employee picks one at Clock In when policy requires it.
 *
 * LIFECYCLE: active ⇄ inactive via isActive. There is intentionally no
 * delete path — historical event snapshots reference these rows and
 * must stay interpretable. Deactivate instead of deleting.
 *
 * PRIVACY: these coordinates describe COMPANY PREMISES, not people.
 * Employee positions are validated against them and discarded.
 *
 * MIDDLEWARE NOTE (31.2 lesson): this schema carries NO pre/post hooks
 * at all — nothing here may ever break a write path.
 */
const attendanceLocationSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    code: {
      type: String,
      default: null,
      trim: true,
      maxlength: 32,
    },
    displayAddress: {
      type: String,
      default: null,
      trim: true,
      maxlength: 300,
    },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    radiusMeters: {
      type: Number,
      required: true,
      min: 10,
      max: 100000,
      validate: {
        validator: Number.isInteger,
        message: 'radiusMeters must be an integer',
      },
    },
    isActive: { type: Boolean, default: true },
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
  { timestamps: true },
);

// Tenant-scoped reads: management listing + eligible-location lookup.
attendanceLocationSchema.index({ companyId: 1, isActive: 1 });

const AttendanceLocation = model('AttendanceLocation', attendanceLocationSchema);

export default AttendanceLocation;
