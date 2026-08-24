import mongoose from 'mongoose';

const offerAccessTokenSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    offer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OfferLetter',
      required: true,
      index: true,
      immutable: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
      immutable: true,
    },
    activeKey: { type: String, default: 'ACTIVE', select: false },
    expiresAt: { type: Date, required: true, index: true, immutable: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: '', maxlength: 200 },
    lastViewedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0, min: 0 },
    finalizedAt: { type: Date, default: null },
    finalAction: {
      type: String,
      enum: ['ACCEPTED', 'REJECTED', null],
      default: null,
    },
    issuedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
  },
  { timestamps: true, versionKey: false }
);

offerAccessTokenSchema.index(
  { offer: 1, activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: 'ACTIVE' } }
);
offerAccessTokenSchema.pre('validate', function normalizeActiveKey() {
  this.activeKey = this.revokedAt ? null : 'ACTIVE';
});

export default mongoose.model('OfferAccessToken', offerAccessTokenSchema);
