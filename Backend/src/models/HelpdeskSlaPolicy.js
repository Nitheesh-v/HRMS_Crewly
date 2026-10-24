import mongoose from 'mongoose';
import { HELPDESK_PRIORITIES } from '../services/helpdesk/helpdeskRules.js';
import {
  HELPDESK_SLA_CLOCK_MODES,
  HELPDESK_SLA_MAX_MINUTES,
  HELPDESK_SLA_PAUSE_STATUSES,
} from '../services/helpdesk/helpdeskSlaRules.js';
import { DAY_KEYS } from '../utils/scheduleEngine.js';

const { Schema } = mongoose;

const slaWindowSchema = new Schema(
  {
    start: { type: String, required: true, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
    end: { type: String, required: true, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
  },
  { _id: false },
);

const weekdayHoursSchema = new Schema(
  {
    weekday: { type: String, required: true, enum: DAY_KEYS },
    windows: { type: [slaWindowSchema], required: true, default: [] },
  },
  { _id: false },
);

const priorityTargetSchema = new Schema(
  {
    firstResponseMinutes: { type: Number, required: true, min: 1, max: HELPDESK_SLA_MAX_MINUTES },
    resolutionMinutes: { type: Number, required: true, min: 1, max: HELPDESK_SLA_MAX_MINUTES },
  },
  { _id: false },
);

const targetsSchema = new Schema(
  Object.fromEntries(HELPDESK_PRIORITIES.map((priority) => [priority, { type: priorityTargetSchema, required: true }])),
  { _id: false },
);

const pauseStatusesSchema = new Schema(
  {
    firstResponse: {
      type: [{ type: String, enum: HELPDESK_SLA_PAUSE_STATUSES }],
      default: [],
      validate: (value) => Array.isArray(value) && new Set(value).size === value.length,
    },
    resolution: {
      type: [{ type: String, enum: HELPDESK_SLA_PAUSE_STATUSES }],
      default: ['waiting_for_employee'],
      validate: (value) => Array.isArray(value) && new Set(value).size === value.length,
    },
  },
  { _id: false },
);

const helpdeskSlaPolicySchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
    },
    queueId: {
      type: Schema.Types.ObjectId,
      ref: 'HelpdeskQueue',
      required: true,
      immutable: true,
    },
    enabled: { type: Boolean, required: true, default: false },
    version: { type: Number, required: true, min: 1, default: 1 },
    clockMode: { type: String, required: true, enum: HELPDESK_SLA_CLOCK_MODES },
    timeZone: { type: String, required: true, trim: true, maxlength: 100 },
    excludeHolidays: { type: Boolean, required: true, default: false },
    weeklyHours: {
      type: [weekdayHoursSchema],
      required: true,
      validate: (value) => Array.isArray(value) && value.length === DAY_KEYS.length,
    },
    targets: { type: targetsSchema, required: true },
    warningPercent: { type: Number, required: true, min: 1, max: 99, default: 80 },
    pauseStatuses: { type: pauseStatusesSchema, required: true, default: () => ({}) },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
);

helpdeskSlaPolicySchema.index(
  { companyId: 1, queueId: 1 },
  { unique: true, name: 'helpdesk_sla_policy_tenant_queue_unique' },
);

export default mongoose.model('HelpdeskSlaPolicy', helpdeskSlaPolicySchema);
