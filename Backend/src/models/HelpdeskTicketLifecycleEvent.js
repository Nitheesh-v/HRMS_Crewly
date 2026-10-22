import mongoose from 'mongoose';
import { HELPDESK_LIFECYCLE_EVENT_TYPES } from '../services/helpdesk/helpdeskLifecycleRules.js';

const { Schema } = mongoose;

const helpdeskTicketLifecycleEventSchema = new Schema(
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
    ticketNumber: { type: String, required: true, immutable: true },
    sequence: { type: Number, required: true, min: 1, immutable: true },
    eventType: {
      type: String,
      enum: HELPDESK_LIFECYCLE_EVENT_TYPES,
      required: true,
      immutable: true,
    },
    actorType: { type: String, enum: ['USER', 'SYSTEM'], required: true, immutable: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null, immutable: true },
    fromStatus: { type: String, default: null, immutable: true },
    toStatus: { type: String, default: null, immutable: true },
    occurredAt: { type: Date, required: true, immutable: true },
    resolutionCycle: { type: Number, min: 0, default: 0, immutable: true },
    reason: { type: String, default: null, maxlength: 500, immutable: true },
    slaSnapshot: { type: Schema.Types.Mixed, default: null, immutable: true },
  },
  { timestamps: false, versionKey: false },
);

helpdeskTicketLifecycleEventSchema.index(
  { companyId: 1, ticketId: 1, sequence: 1 },
  { unique: true, name: 'helpdesk_ticket_lifecycle_sequence_unique' },
);

helpdeskTicketLifecycleEventSchema.index(
  { companyId: 1, ticketId: 1, occurredAt: -1, sequence: -1 },
  { name: 'helpdesk_ticket_lifecycle_history' },
);

export default mongoose.model('HelpdeskTicketLifecycleEvent', helpdeskTicketLifecycleEventSchema);
