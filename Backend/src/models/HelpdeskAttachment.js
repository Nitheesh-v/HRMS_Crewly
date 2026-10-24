import mongoose from 'mongoose';

import {
  DOCUMENT_SCAN_STATUSES,
  DOCUMENT_STORAGE_PROVIDERS,
} from './CandidateDocument.js';
import {
  HELPDESK_ATTACHMENT_MAX_BYTES,
  HELPDESK_ATTACHMENT_MIME_TYPES,
} from '../services/helpdesk/helpdeskFileRules.js';

const { Schema } = mongoose;

const helpdeskAttachmentSchema = new Schema(
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
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'HelpdeskMessage',
      required: true,
      immutable: true,
    },
    uploadedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    storageProvider: {
      type: String,
      enum: DOCUMENT_STORAGE_PROVIDERS,
      required: true,
      immutable: true,
    },
    storageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
      select: false,
      immutable: true,
    },
    checksumSha256: {
      type: String,
      required: true,
      lowercase: true,
      match: /^[a-f\d]{64}$/,
      maxlength: 64,
      select: false,
      immutable: true,
    },
    originalFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 220,
      immutable: true,
    },
    mimeType: {
      type: String,
      required: true,
      enum: HELPDESK_ATTACHMENT_MIME_TYPES,
      trim: true,
      maxlength: 120,
      immutable: true,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
      max: HELPDESK_ATTACHMENT_MAX_BYTES,
      immutable: true,
    },
    // The repository has no scanner; this value is never promoted to CLEAN.
    scanStatus: {
      type: String,
      enum: DOCUMENT_SCAN_STATUSES,
      default: 'NOT_CONFIGURED',
      immutable: true,
    },
    persistenceStatus: {
      type: String,
      enum: ['UPLOADING', 'PENDING', 'ACTIVE', 'CLEANUP_REQUIRED'],
      default: 'UPLOADING',
      select: false,
    },
    cleanupRequired: {
      type: Boolean,
      default: false,
      select: false,
    },
  },
  { timestamps: true, versionKey: false },
);

helpdeskAttachmentSchema.index(
  { companyId: 1, ticketId: 1, messageId: 1 },
  { unique: true, name: 'helpdesk_attachment_message_unique' },
);
helpdeskAttachmentSchema.index(
  { companyId: 1, createdAt: 1 },
  {
    name: 'helpdesk_attachment_cleanup_recovery',
    partialFilterExpression: { cleanupRequired: true },
  },
);
helpdeskAttachmentSchema.index(
  { companyId: 1, persistenceStatus: 1, createdAt: 1 },
  { name: 'helpdesk_attachment_commit_recovery' },
);

export default mongoose.model('HelpdeskAttachment', helpdeskAttachmentSchema);
