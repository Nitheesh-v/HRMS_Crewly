// ─────────────────────────────────────────────────────────────
// EmailDelivery — persistent email delivery intent (28.3 outbox).
//
// Business operation commits to MongoDB first, then a delivery
// record is created and a BullMQ job is enqueued. If the enqueue
// fails (Redis down) the record stays PENDING/FAILED_TO_QUEUE and
// `npm run email:reconcile` re-enqueues it — the business state is
// never rolled back and there is no uncertain sync fallback.
//
// Security: this document stores REFERENCES only (ids, event key).
// Never store SMTP credentials, raw secure tokens, recipient
// addresses, or rendered email bodies here.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

export const EMAIL_DELIVERY_STATUSES = [
  'PENDING', // intent created; enqueue not confirmed yet
  'QUEUED', // BullMQ job accepted
  'PROCESSING', // worker claimed the delivery
  'SENT', // mailer delivered (SMTP or MOCK)
  'FAILED', // terminal failure after classification
  'STALE', // skipped: business state moved on before send
];

const emailDeliverySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
      immutable: true,
    },
    jobName: { type: String, required: true, maxlength: 80 },
    eventType: { type: String, required: true, maxlength: 60 },
    // Stable business identity of THIS logical event (ids only —
    // never email addresses or tokens). Unique = idempotency anchor.
    eventKey: { type: String, required: true, unique: true, maxlength: 255 },
    entityType: { type: String, required: true, maxlength: 40 },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    // References only (candidateId, interviewId, ...). No PII, no
    // tokens, no rendered content. Mirrors the BullMQ job payload.
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    recipientType: {
      type: String,
      enum: ['CANDIDATE', 'INTERVIEWER', 'EMPLOYEE', 'HR'],
      required: true,
    },
    recipientReference: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    status: {
      type: String,
      enum: EMAIL_DELIVERY_STATUSES,
      default: 'PENDING',
      index: true,
    },
    queueJobId: { type: String, default: null, maxlength: 128 },
    attemptCount: { type: Number, default: 0, min: 0 },
    deliveryMode: { type: String, enum: ['SMTP', 'MOCK', ''], default: '' },
    lastFailureCategory: { type: String, default: '', maxlength: 60 },
    queuedAt: { type: Date, default: null },
    processingAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

emailDeliverySchema.index({ status: 1, createdAt: 1 });

export default mongoose.model('EmailDelivery', emailDeliverySchema);
