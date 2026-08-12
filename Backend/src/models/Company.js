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
    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      default: null,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED'],
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

export default mongoose.model('Company', companySchema);