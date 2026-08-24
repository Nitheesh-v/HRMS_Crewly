import mongoose from 'mongoose';

export const OFFER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'VIEWED',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'WITHDRAWN',
];

export const ACTIVE_OFFER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'VIEWED',
];

const moneyField = {
  type: Number,
  default: 0,
  min: 0,
  max: 1000000000000,
};

const offerLetterSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    offerCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      immutable: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      index: true,
      immutable: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      required: true,
      index: true,
      immutable: true,
    },
    requisition: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobRequisition',
      default: null,
      immutable: true,
    },
    status: {
      type: String,
      enum: OFFER_STATUSES,
      default: 'DRAFT',
      index: true,
    },
    activeKey: { type: String, default: 'ACTIVE', select: false },
    revisionNumber: { type: Number, default: 1, min: 1, immutable: true },
    replacesOffer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OfferLetter',
      default: null,
      immutable: true,
    },
    replacedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OfferLetter',
      default: null,
    },
    template: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OfferTemplate',
      required: true,
    },
    templateSnapshot: {
      templateId: { type: mongoose.Schema.Types.ObjectId, required: true },
      name: { type: String, required: true, maxlength: 120 },
      version: { type: Number, required: true, min: 1 },
      content: { type: String, required: true, maxlength: 20000 },
      variables: [{ type: String }],
    },
    renderedContent: { type: String, default: '', maxlength: 30000 },
    unresolvedVariables: [{ type: String }],
    candidateSnapshot: {
      name: { type: String, required: true, maxlength: 160 },
      email: { type: String, required: true, maxlength: 254 },
      candidateCode: { type: String, required: true, maxlength: 40 },
      phone: { type: String, default: '', maxlength: 40 },
    },
    jobSnapshot: {
      title: { type: String, required: true, maxlength: 180 },
      jobCode: { type: String, default: '', maxlength: 40 },
      departmentName: { type: String, default: '', maxlength: 160 },
      requisitionCode: { type: String, default: '', maxlength: 40 },
    },
    companySnapshot: {
      name: { type: String, required: true, maxlength: 180 },
      address: { type: String, default: '', maxlength: 1000 },
    },
    terms: {
      designation: { type: String, required: true, trim: true, maxlength: 180 },
      departmentName: { type: String, default: '', trim: true, maxlength: 160 },
      location: { type: String, default: '', trim: true, maxlength: 240 },
      employmentType: {
        type: String,
        enum: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'],
        default: 'FULL_TIME',
      },
      workMode: {
        type: String,
        enum: ['ONSITE', 'REMOTE', 'HYBRID'],
        default: 'ONSITE',
      },
      reportingManager: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      reportingManagerName: { type: String, default: '', maxlength: 160 },
      joiningDate: { type: Date, required: true },
      offerDate: { type: Date, required: true },
      expiryDate: { type: Date, required: true, index: true },
      probationMonths: { type: Number, default: 0, min: 0, max: 36 },
      noticePeriodDays: { type: Number, default: 0, min: 0, max: 365 },
      additionalTerms: { type: String, default: '', maxlength: 5000 },
    },
    compensationSnapshot: {
      currency: {
        type: String,
        required: true,
        uppercase: true,
        trim: true,
        minlength: 3,
        maxlength: 3,
      },
      annualCTC: { ...moneyField, required: true },
      monthly: {
        basic: moneyField,
        hra: moneyField,
        allowances: moneyField,
      },
      variablePay: moneyField,
      bonus: moneyField,
    },
    approval: {
      attempt: { type: Number, default: 0, min: 0 },
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      submittedAt: { type: Date, default: null },
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      approvedAt: { type: Date, default: null },
      returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      returnedAt: { type: Date, default: null },
      returnReason: { type: String, default: '', maxlength: 1000 },
    },
    document: {
      storageProvider: {
        type: String,
        enum: ['CLOUDINARY_AUTHENTICATED', 'LOCAL_PRIVATE'],
        default: undefined,
      },
      storageKey: { type: String, default: undefined, select: false },
      checksum: { type: String, default: '', maxlength: 64 },
      fileName: { type: String, default: '', maxlength: 180 },
      mimeType: { type: String, default: '' },
      size: { type: Number, default: 0, min: 0 },
      version: { type: Number, default: 0, min: 0 },
      generatedAt: { type: Date, default: null },
    },
    documentSnapshots: [
      {
        _id: false,
        storageProvider: {
          type: String,
          enum: ['CLOUDINARY_AUTHENTICATED', 'LOCAL_PRIVATE'],
          required: true,
        },
        storageKey: { type: String, required: true, select: false },
        checksum: { type: String, required: true, maxlength: 64 },
        fileName: { type: String, required: true, maxlength: 180 },
        mimeType: { type: String, default: 'application/pdf' },
        size: { type: Number, default: 0, min: 0 },
        version: { type: Number, required: true, min: 1 },
        generatedAt: { type: Date, required: true },
        invalidatedAt: { type: Date, required: true },
      },
    ],
    delivery: {
      sendClaimHash: { type: String, default: null, select: false },
      sendClaimedAt: { type: Date, default: null },
      lastAttemptAt: { type: Date, default: null },
      lastError: { type: String, default: '', maxlength: 500 },
      sentAt: { type: Date, default: null },
      mode: { type: String, enum: ['SMTP', 'MOCK', null], default: null },
    },
    viewedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejection: {
      category: { type: String, default: '', maxlength: 80 },
      comment: { type: String, default: '', maxlength: 1000 },
    },
    expiredAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    withdrawalReason: { type: String, default: '', maxlength: 1000 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true, versionKey: false }
);

offerLetterSchema.index({ companyId: 1, offerCode: 1 }, { unique: true });
offerLetterSchema.index(
  { companyId: 1, candidate: 1, job: 1, activeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeKey: 'ACTIVE' },
  }
);
offerLetterSchema.index({ companyId: 1, status: 1, createdAt: -1 });
offerLetterSchema.index({ companyId: 1, candidate: 1, createdAt: -1 });

offerLetterSchema.pre('validate', function normalizeActiveKey() {
  this.activeKey = ACTIVE_OFFER_STATUSES.includes(this.status) ? 'ACTIVE' : null;
});

export default mongoose.model('OfferLetter', offerLetterSchema);
