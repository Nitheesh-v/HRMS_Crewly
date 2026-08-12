// ─────────────────────────────────────────────────────────────
// User model — one account per person in a company.
// Payslip fields (optional): employeeCode, designation, DOB, DOJ,
// PAN, UAN, ESIC, bankAccount, IFSC.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

import bcrypt from 'bcryptjs';
import { ROLES } from '../utils/constants.js';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: 2,
      maxlength: 60,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 8,
      select: false, // never returned by queries unless explicitly asked
    },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.EMPLOYEE,
    },
    // null only for the platform SUPER_ADMIN (Crewly owner)
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
    },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    reportingTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    lastLogin: { type: Date, default: null },
        // ── 👤 Self-service profile (Phase 9) ─────────────────────────
    avatarUrl: { type: String, default: '' },
    avatarPublicId: { type: String, default: '' }, // Cloudinary reference (for deletes)
    phone: { type: String, trim: true, default: '' },
    gender: { type: String, enum: ['', 'MALE', 'FEMALE', 'OTHER'], default: '' },
    address: {
      line: { type: String, default: '' },
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      pincode: { type: String, default: '' },
    },
    emergencyContact: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      relation: { type: String, default: '' },
    },

    // ── Payroll profile (shown on the payslip left column) ──
    employeeCode: { type: String, trim: true, maxlength: 20, default: '' },
    designation: { type: String, trim: true, maxlength: 80, default: '' },
    dateOfBirth: { type: Date, default: null },
    dateOfJoining: { type: Date, default: null },
    pan: { type: String, trim: true, uppercase: true, maxlength: 10, default: '' },
    uan: { type: String, trim: true, maxlength: 12, default: '' },
    esic: { type: String, trim: true, maxlength: 17, default: '' },
    bankAccount: { type: String, trim: true, maxlength: 18, default: '' },
    ifsc: { type: String, trim: true, uppercase: true, maxlength: 11, default: '' },
  },
  { timestamps: true }
);

// Same email can exist in DIFFERENT companies, but only once per company
userSchema.index({ email: 1, companyId: 1 }, { unique: true });

// Hash the password whenever it is created/changed.
// NOTE: Mongoose 6+ — async hooks must NOT accept/call next().
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Password check at login (aliases = any controller style works)
userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};
userSchema.methods.matchPassword = userSchema.methods.comparePassword;
userSchema.methods.verifyPassword = userSchema.methods.comparePassword;

export default mongoose.model('User', userSchema);