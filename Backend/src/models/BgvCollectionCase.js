// Phase 30.5 — candidate BGV information & document collection case.
//
// One case per commercially authorized BgvOrder after the candidate has
// explicitly CONSENTED (30.4). The case holds ONLY structured, minimum-
// necessary information for the purchased checks — never a generic
// "upload everything" blob.
//
// Privacy invariants:
//  - Full identity document numbers are NEVER persisted: the service stores
//    a masked display value plus a sha256 fingerprint (select:false) so the
//    candidate can recognize their entry without retaining the raw number.
//  - Repeatable records (education/employment/reference) are structured
//    subdocuments, not opaque JSON blobs.
//  - After SUBMITTED the case is frozen: ordinary edits are blocked until a
//    future authorized additional-information workflow (30.9) exists.

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const BGV_COLLECTION_STATUSES = ['NOT_STARTED', 'DRAFT', 'SUBMITTED'];

// Controlled identity evidence categories (organizational policy set).
export const BGV_IDENTITY_DOCUMENT_TYPES = [
  'PAN',
  'AADHAAR',
  'PASSPORT',
  'DRIVING_LICENSE',
  'OTHER_APPROVED_ID',
];

export const ADDRESS_EVIDENCE_CATEGORIES = [
  'IDENTITY_ADDRESS_DOCUMENT',
  'UTILITY_BILL',
  'RENTAL_AGREEMENT',
  'OTHER_APPROVED_PROOF',
];

export const EMPLOYMENT_EVIDENCE_CATEGORIES = [
  'OFFER_APPOINTMENT_LETTER',
  'RELIEVING_LETTER',
  'EXPERIENCE_LETTER',
  'PAYSLIP_OPTIONAL_SENSITIVE',
  'OTHER_APPROVED_EVIDENCE',
];

export const RESIDENCE_TYPES = ['OWNED', 'RENTED', 'FAMILY', 'HOSTEL', 'OTHER'];
export const EMPLOYMENT_TYPES = ['CURRENT', 'PREVIOUS'];

const identitySubSchema = new Schema(
  {
    legalName: { type: String, trim: true, maxlength: 160, default: '' },
    dateOfBirth: { type: Date, default: null },
    documentType: {
      type: String,
      enum: [...BGV_IDENTITY_DOCUMENT_TYPES, null],
      default: null,
    },
    // Display-safe ONLY (e.g. "XXXXXX1234K") — the full number is never
    // stored anywhere in this system.
    identifierMasked: { type: String, maxlength: 40, default: '' },
    // sha256 of the normalized full value, for future duplicate detection.
    identifierFingerprint: { type: String, maxlength: 64, default: '', select: false },
    // Aadhaar copies are candidate-provided evidence only — never e-KYC or
    // UIDAI-verified; provenance is labeled in the UI.
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const addressSubSchema = new Schema(
  {
    line1: { type: String, trim: true, maxlength: 200, default: '' },
    line2: { type: String, trim: true, maxlength: 200, default: '' },
    locality: { type: String, trim: true, maxlength: 120, default: '' },
    city: { type: String, trim: true, maxlength: 120, default: '' },
    state: { type: String, trim: true, maxlength: 120, default: '' },
    pincode: { type: String, trim: true, maxlength: 12, default: '' },
    country: { type: String, trim: true, maxlength: 120, default: 'India' },
    residenceType: {
      type: String,
      enum: [...RESIDENCE_TYPES, null],
      default: null,
    },
    livingSince: { type: Date, default: null },
    evidenceCategory: {
      type: String,
      enum: [...ADDRESS_EVIDENCE_CATEGORIES, null],
      default: null,
    },
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const educationRecordSchema = new Schema({
  institution: { type: String, required: true, trim: true, maxlength: 200 },
  universityBoard: { type: String, trim: true, maxlength: 200, default: '' },
  qualification: { type: String, required: true, trim: true, maxlength: 120 },
  specialization: { type: String, trim: true, maxlength: 120, default: '' },
  enrollmentNumber: { type: String, trim: true, maxlength: 60, default: '' },
  startYear: { type: Number, min: 1950, max: 2100, default: null },
  endYear: { type: Number, min: 1950, max: 2100, default: null },
  location: { type: String, trim: true, maxlength: 160, default: '' },
});
educationRecordSchema.set({ versionKey: false });

const employmentRecordSchema = new Schema({
  employer: { type: String, required: true, trim: true, maxlength: 200 },
  designation: { type: String, required: true, trim: true, maxlength: 120 },
  employeeId: { type: String, trim: true, maxlength: 60, default: '' },
  startDate: { type: Date, required: true },
  endDate: { type: Date, default: null },
  employmentType: {
    type: String,
    enum: EMPLOYMENT_TYPES,
    default: 'PREVIOUS',
  },
  hrContactName: { type: String, trim: true, maxlength: 120, default: '' },
  hrContactEmail: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
  hrContactPhone: { type: String, trim: true, maxlength: 20, default: '' },
});
employmentRecordSchema.set({ versionKey: false });

const referenceRecordSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  organization: { type: String, trim: true, maxlength: 200, default: '' },
  designation: { type: String, trim: true, maxlength: 120, default: '' },
  relationship: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
  phone: { type: String, trim: true, maxlength: 20, default: '' },
  context: { type: String, trim: true, maxlength: 300, default: '' },
});
referenceRecordSchema.set({ versionKey: false });

const bgvCollectionCaseSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    candidate: {
      type: Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      index: true,
      immutable: true,
    },
    // One collection case per commercially authorized BGV order.
    bgvOrder: {
      type: Schema.Types.ObjectId,
      ref: 'BgvOrder',
      required: true,
      unique: true,
      immutable: true,
    },
    // 30.4 consent token record that authorized collection (audit trail).
    consentTokenRecord: {
      type: Schema.Types.ObjectId,
      ref: 'BgvConsentAccessToken',
      default: null,
      immutable: true,
    },
    // Snapshot of purchased check types from the immutable order items —
    // the ONLY checks the candidate may see forms for.
    purchasedChecks: {
      type: [String],
      required: true,
      validate: {
        validator: (checks) => Array.isArray(checks) && checks.length >= 1,
        message: 'A collection case requires purchased checks',
      },
      immutable: true,
    },
    status: {
      type: String,
      enum: BGV_COLLECTION_STATUSES,
      default: 'NOT_STARTED',
      index: true,
    },
    identity: { type: identitySubSchema, default: () => ({}) },
    address: { type: addressSubSchema, default: () => ({}) },
    educations: { type: [educationRecordSchema], default: [] },
    employments: { type: [employmentRecordSchema], default: [] },
    references: { type: [referenceRecordSchema], default: [] },
    // Final submission freeze (30.9 will add controlled re-open later).
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

export default mongoose.model('BgvCollectionCase', bgvCollectionCaseSchema);
