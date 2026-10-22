import mongoose from 'mongoose';
import SupportTicket from './SupportTicket.js';
import {
  HELPDESK_PRIORITIES,
  HELPDESK_TICKET_STATUSES,
} from '../services/helpdesk/helpdeskRules.js';
import {
  HELPDESK_NOTIFICATION_EVENT_TYPES,
  HELPDESK_NOTIFICATION_MILESTONES,
} from '../services/helpdesk/helpdeskNotificationRules.js';
import { HELPDESK_FEEDBACK_COMMENT_MAX } from '../services/helpdesk/helpdeskLifecycleRules.js';

const slaWindowSchema = new mongoose.Schema(
  {
    start: { type: String, required: true, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
    end: { type: String, required: true, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
  },
  { _id: false },
);

const slaWeekdaySchema = new mongoose.Schema(
  {
    weekday: { type: String, required: true, enum: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] },
    windows: { type: [slaWindowSchema], default: [] },
  },
  { _id: false },
);

const slaTargetSchema = new mongoose.Schema(
  {
    firstResponseMinutes: { type: Number, required: true, min: 1, max: 10_080 },
    resolutionMinutes: { type: Number, required: true, min: 1, max: 10_080 },
  },
  { _id: false },
);

const slaTargetsSchema = new mongoose.Schema(
  Object.fromEntries(HELPDESK_PRIORITIES.map((priority) => [priority, { type: slaTargetSchema, required: true }])),
  { _id: false },
);

const slaPauseStatusesSchema = new mongoose.Schema(
  {
    firstResponse: { type: [String], default: [] },
    resolution: { type: [String], default: ['waiting_for_employee'] },
  },
  { _id: false },
);

const slaClockSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, enum: ['RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED'] },
    targetMinutes: { type: Number, required: true, min: 1, max: 10_080 },
    activeElapsedMs: { type: Number, required: true, min: 0, default: 0 },
    startedAt: { type: Date, required: true },
    resumedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    dueAt: { type: Date, default: null },
    warningAt: { type: Date, default: null },
    warningEligibleAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastCompletedAt: { type: Date, default: null },
    firstResponseAt: { type: Date, default: null },
    breachedAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
  },
  { _id: false },
);

const slaEscalationSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, enum: ['NONE', 'ELIGIBLE'], default: 'NONE' },
    queueId: { type: mongoose.Schema.Types.ObjectId, ref: 'HelpdeskQueue', default: null },
    eligibleAt: { type: Date, default: null },
    triggers: { type: [String], enum: ['FIRST_RESPONSE', 'RESOLUTION'], default: [] },
  },
  { _id: false },
);

const helpdeskSlaSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, min: 1, default: 1 },
    policyQueueId: { type: mongoose.Schema.Types.ObjectId, ref: 'HelpdeskQueue', required: true },
    policyVersion: { type: Number, required: true, min: 1 },
    appliedPriority: { type: String, required: true, enum: HELPDESK_PRIORITIES },
    clockMode: { type: String, required: true, enum: ['CALENDAR', 'BUSINESS_HOURS'] },
    timeZone: { type: String, required: true, maxlength: 100 },
    excludeHolidays: { type: Boolean, required: true, default: false },
    weeklyHours: { type: [slaWeekdaySchema], required: true },
    targets: { type: slaTargetsSchema, required: true },
    warningPercent: { type: Number, required: true, min: 1, max: 99 },
    pauseStatuses: { type: slaPauseStatusesSchema, required: true },
    holidayContext: {
      department: { type: mongoose.Schema.Types.ObjectId, default: null },
      branch: { type: String, default: '' },
    },
    firstResponse: { type: slaClockSchema, required: true },
    resolution: { type: slaClockSchema, required: true },
    escalation: { type: slaEscalationSchema, required: true },
    nextActionAt: { type: Date, default: null },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const helpdeskNotificationEventSchema = new mongoose.Schema(
  {
    sequence: { type: Number, required: true, min: 1 },
    type: { type: String, required: true, enum: HELPDESK_NOTIFICATION_EVENT_TYPES },
    milestone: { type: String, enum: HELPDESK_NOTIFICATION_MILESTONES, default: null },
    state: { type: String, enum: ['PENDING', 'DELIVERED', 'SUPPRESSED', 'FAILED'], required: true, default: 'PENDING' },
    attemptCount: { type: Number, min: 0, max: 5, default: 0 },
    createdAt: { type: Date, required: true },
    nextAttemptAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
  },
  { _id: false },
);

const helpdeskNotificationGapSchema = new mongoose.Schema(
  {
    fromSequence: { type: Number, required: true, min: 1 },
    throughSequence: { type: Number, required: true, min: 1 },
    state: { type: String, enum: ['PENDING', 'FAILED'], required: true, default: 'PENDING' },
    attemptCount: { type: Number, min: 0, max: 5, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
  },
  { _id: false },
);

const helpdeskFeedbackSchema = new mongoose.Schema(
  {
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: null, maxlength: HELPDESK_FEEDBACK_COMMENT_MAX },
    submittedAt: { type: Date, required: true },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false },
);

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
    // Phase 38.7 — lifecycle state is additive and tenant-scoped with the ticket.
    lifecycleSequence: { type: Number, min: 0, default: 0 },
    resolutionCycle: { type: Number, min: 0, default: 0 },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reopenUntilAt: { type: Date, default: null },
    reopenedAt: { type: Date, default: null },
    reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reopenReason: { type: String, default: null, maxlength: 500 },
    resolutionConfirmedAt: { type: Date, default: null },
    resolutionConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closureReason: {
      type: String,
      enum: [null, 'REQUESTER_CONFIRMED', 'STAFF_CLOSED', 'AUTO_CLOSED'],
      default: null,
    },
    autoCloseAt: { type: Date, default: null },
    feedback: { type: helpdeskFeedbackSchema, default: undefined },
    // Phase 38.5 — Mongo-authoritative ticket SLA clocks. Legacy Helpdesk rows
    // remain untracked unless a policy snapshot was written at ticket creation.
    sla: { type: helpdeskSlaSchema, default: undefined },
    // Phase 38.6 — durable Helpdesk-only notification intent. The event array
    // is capped; a persisted gap marker lets recovery coalesce overflow safely.
    notificationSequence: { type: Number, default: 0, min: 0 },
    notificationProcessedSequence: { type: Number, default: 0, min: 0 },
    notificationEvents: { type: [helpdeskNotificationEventSchema], default: [] },
    notificationGap: { type: helpdeskNotificationGapSchema, default: undefined },
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

helpdeskTicketSchema.index(
  { 'sla.nextActionAt': 1, companyId: 1, _id: 1 },
  {
    name: 'helpdesk_sla_due_reconcile',
    partialFilterExpression: {
      ticketKind: 'HELPDESK',
      'sla.nextActionAt': { $type: 'date' },
    },
  },
);

helpdeskTicketSchema.index(
  { autoCloseAt: 1, companyId: 1, _id: 1 },
  {
    name: 'helpdesk_ticket_auto_close_due',
    partialFilterExpression: {
      ticketKind: 'HELPDESK',
      status: 'resolved',
      autoCloseAt: { $type: 'date' },
    },
  },
);

helpdeskTicketSchema.index(
  { 'notificationEvents.state': 1, 'notificationEvents.nextAttemptAt': 1, companyId: 1, _id: 1 },
  {
    name: 'helpdesk_ticket_notification_recovery',
    partialFilterExpression: { ticketKind: 'HELPDESK' },
  },
);

helpdeskTicketSchema.index(
  { 'notificationGap.state': 1, 'notificationGap.nextAttemptAt': 1, companyId: 1, _id: 1 },
  {
    name: 'helpdesk_ticket_notification_gap_recovery',
    partialFilterExpression: { ticketKind: 'HELPDESK' },
  },
);

const HelpdeskTicket = SupportTicket.discriminator(
  'HelpdeskTicket',
  helpdeskTicketSchema,
  'HELPDESK',
);

export default HelpdeskTicket;
