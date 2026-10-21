import mongoose from 'mongoose';

import {
  HELPDESK_MESSAGE_BODY_MAX,
  HELPDESK_MESSAGE_TYPES,
} from '../services/helpdesk/helpdeskRules.js';
import { hasVisibleText } from '../utils/chatTextRules.js';

const { Schema } = mongoose;

const helpdeskMessageSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
    },
    ticketId: {
      type: Schema.Types.ObjectId,
      ref: 'HelpdeskTicket',
      required: true,
      immutable: true,
    },
    authorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    // One tenant/ticket counter allocates this monotonically and atomically.
    sequence: { type: Number, required: true, min: 1, immutable: true },
    // Public-only counter prevents internal-note positions from being visible
    // through employee history cursors.
    publicSequence: { type: Number, min: 1, immutable: true },
    messageType: {
      type: String,
      enum: HELPDESK_MESSAGE_TYPES,
      required: true,
      default: 'PUBLIC',
      immutable: true,
    },
    body: {
      type: String,
      default: null,
      trim: true,
      maxlength: HELPDESK_MESSAGE_BODY_MAX,
      immutable: true,
    },
    attachmentId: {
      type: Schema.Types.ObjectId,
      ref: 'HelpdeskAttachment',
      default: null,
      immutable: true,
    },
    // Phase 38.6 — public messages carry durable notification intent; internal
    // notes are NOT_REQUIRED and are never selected by the delivery worker.
    notificationState: {
      type: String,
      enum: ['NOT_REQUIRED', 'PENDING', 'DELIVERED', 'SUPPRESSED', 'FAILED'],
      default: 'NOT_REQUIRED',
      select: false,
    },
    notificationAttemptCount: { type: Number, min: 0, max: 5, default: 0, select: false },
    notificationNextAttemptAt: { type: Date, default: null, select: false },
    notificationLeaseUntil: { type: Date, default: null, select: false },
    notificationDeliveredAt: { type: Date, default: null, select: false },
  },
  { timestamps: true, versionKey: false },
);

helpdeskMessageSchema.pre('validate', function validateMessageShape() {
  const hasBody = hasVisibleText(this.body);
  if (!hasBody && !this.attachmentId) {
    this.invalidate('body', 'A Helpdesk message requires visible text or one attachment.');
  }
  if (this.messageType === 'PUBLIC') {
    if (!Number.isSafeInteger(this.publicSequence) || this.publicSequence < 1) {
      this.invalidate('publicSequence', 'A public message requires a public sequence.');
    }
  } else if (this.publicSequence !== undefined && this.publicSequence !== null) {
    this.invalidate('publicSequence', 'Internal notes do not have a public sequence.');
  }
});

helpdeskMessageSchema.index(
  { companyId: 1, ticketId: 1, sequence: 1 },
  { unique: true, name: 'helpdesk_message_sequence_unique' },
);
helpdeskMessageSchema.index(
  { companyId: 1, ticketId: 1, publicSequence: 1 },
  {
    unique: true,
    name: 'helpdesk_public_message_sequence_unique',
    partialFilterExpression: { publicSequence: { $type: 'number' } },
  },
);

helpdeskMessageSchema.index(
  { companyId: 1, ticketId: 1, createdAt: 1, _id: 1 },
  {
    name: 'helpdesk_first_public_agent_reply',
    partialFilterExpression: { messageType: 'PUBLIC' },
  },
);

helpdeskMessageSchema.index(
  { notificationState: 1, notificationNextAttemptAt: 1, companyId: 1, createdAt: 1, _id: 1 },
  {
    name: 'helpdesk_message_notification_recovery',
    partialFilterExpression: { messageType: 'PUBLIC', notificationState: 'PENDING' },
  },
);

export default mongoose.model('HelpdeskMessage', helpdeskMessageSchema);
