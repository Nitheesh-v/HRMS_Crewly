// ─────────────────────────────────────────────────────────────
// Company (tenant) model
// One document per registered company.
//   · code         — unique login code (stored LOWERCASE, e.g. "infolexussol")
//   · email        — company contact email (from registration)
//   · subscription — ref to the company's Subscription document
//   · address      — printed on payslip headers (Phase 6.5)
// ⚠️ IMPORTANT: `code` uses lowercase:true. Do NOT switch it to
//    uppercase:true — Mongoose applies that transform to QUERY
//    filters too, which breaks login for codes stored lowercase!
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const companySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Company name is required'],
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      lowercase: true, // matches the codes created by generateCompanyCode()
      trim: true,
      minlength: 4,
      maxlength: 20,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: '',
    },
        phone: {
      type: String,
      trim: true,
      default: '',
    },

    logoUrl: {
      type: String,
      default: '',
    },

    country: {
      type: String,
      default: 'India',
      trim: true,
    },

    timezone: {
      type: String,
      default: 'Asia/Kolkata',
      trim: true,
    },

    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      trim: true,
    },

    industry: {
      type: String,
      default: '',
      trim: true,
    },

    archivedAt: {
      type: Date,
      default: null,
      index: true,
    },

    platformNotes: {
      type: String,
      default: '',
      trim: true,
      maxlength: 1000,
    },
    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      default: null,
    },
    status: {
      type: String,
 enum: [
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED',
  'ARCHIVED',
],
      default: 'ACTIVE',
    },
    // Printed on the payslip header (blank = "Address not set")
    address: {
      line: { type: String, trim: true, maxlength: 160, default: '' },
      city: { type: String, trim: true, maxlength: 60, default: '' },
      state: { type: String, trim: true, maxlength: 60, default: '' },
      pincode: { type: String, trim: true, maxlength: 10, default: '' },
    },
  },
  { timestamps: true }
);



companySchema.index({
  status: 1,
  createdAt: -1,
});

companySchema.index({
  archivedAt: 1,
  createdAt: -1,
});

companySchema.index({
  name: 'text',
  code: 'text',
  email: 'text',
});
export default mongoose.model('Company', companySchema);