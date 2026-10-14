import mongoose from 'mongoose';
import SupportTicket from './SupportTicket.js';
import {
  HELPDESK_PRIORITIES,
  HELPDESK_TICKET_STATUSES,
} from '../services/helpdesk/helpdeskRules.js';

const helpdeskTicketSchema = new mongoose.Schema(
  {
    ticketNumber: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },
    queueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HelpdeskQueue',
      required: true,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    categoryName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    requestedPriority: {
      type: String,
      enum: [null, ...HELPDESK_PRIORITIES],
      default: null,
    },
    isConfidential: {
      type: Boolean,
      default: false,
    },
    // Phase 38.4 — atomic per-ticket ordering counters. Legacy tickets need no
    // backfill: Mongo's first $inc creates a counter starting at one.
    lastMessageSequence: { type: Number, default: 0, min: 0 },
    lastPublicMessageSequence: { type: Number, default: 0, min: 0 },
    // These paths override the legacy defaults for this discriminator only.
    status: {
      type: String,
      enum: HELPDESK_TICKET_STATUSES,
      default: 'open',
    },
    priority: {
      type: String,
      enum: HELPDESK_PRIORITIES,
      default: 'normal',
    },
  },
  { _id: false },
);

helpdeskTicketSchema.index(
  { companyId: 1, ticketNumber: 1 },
  {
    unique: true,
    name: 'helpdesk_ticket_number_unique_by_tenant',
    partialFilterExpression: {
      ticketKind: 'HELPDESK',
      ticketNumber: { $type: 'string' },
    },
  },
);

helpdeskTicketSchema.index(
  { companyId: 1, queueId: 1, createdAt: -1 },
  {
    name: 'helpdesk_queue_ticket_list',
    partialFilterExpression: { ticketKind: 'HELPDESK' },
  },
);

// Phase 38.3 — queue-agent list paths use stable date + _id ordering.
// Assignment indexes also cover the unassigned view (`assignedTo: null`).
helpdeskTicketSchema.index(
  { companyId: 1, queueId: 1, createdAt: -1, _id: -1 },
  {
    name: 'helpdesk_agent_queue_ticket_created',
    partialFilterExpression: { ticketKind: 'HELPDESK' },
  },
);

helpdeskTicketSchema.index(
  { companyId: 1, queueId: 1, updatedAt: -1, _id: -1 },
  {
    name: 'helpdesk_agent_queue_ticket_updated',
    partialFilterExpression: { ticketKind: 'HELPDESK' },
  },
);

helpdeskTicketSchema.index(
  { companyId: 1, queueId: 1, assignedTo: 1, createdAt: -1, _id: -1 },
  {
    name: 'helpdesk_agent_queue_assigned_created',
    partialFilterExpression: { ticketKind: 'HELPDESK' },
  },
);

helpdeskTicketSchema.index(
  { companyId: 1, queueId: 1, assignedTo: 1, updatedAt: -1, _id: -1 },
  {
    name: 'helpdesk_agent_queue_assigned_updated',
    partialFilterExpression: { ticketKind: 'HELPDESK' },
  },
);

helpdeskTicketSchema.index(
  { companyId: 1, user: 1, createdAt: -1, _id: -1 },
  {
    name: 'helpdesk_requester_ticket_list_created',
    partialFilterExpression: { ticketKind: 'HELPDESK' },
  },
);

helpdeskTicketSchema.index(
  { companyId: 1, user: 1, updatedAt: -1, _id: -1 },
  {
    name: 'helpdesk_requester_ticket_list_updated',
    partialFilterExpression: { ticketKind: 'HELPDESK' },
  },
);

const HelpdeskTicket = SupportTicket.discriminator(
  'HelpdeskTicket',
  helpdeskTicketSchema,
  'HELPDESK',
);

export default HelpdeskTicket;
