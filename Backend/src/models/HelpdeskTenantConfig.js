import mongoose from 'mongoose';
import { HELPDESK_PRIORITIES } from '../services/helpdesk/helpdeskRules.js';
import {
  HELPDESK_AUTO_CLOSE_DELAY_DEFAULT_HOURS,
  HELPDESK_AUTO_CLOSE_DELAY_MAX_HOURS,
  HELPDESK_AUTO_CLOSE_DELAY_MIN_HOURS,
  HELPDESK_REOPEN_WINDOW_DEFAULT_HOURS,
  HELPDESK_REOPEN_WINDOW_MAX_HOURS,
  HELPDESK_REOPEN_WINDOW_MIN_HOURS,
} from '../services/helpdesk/helpdeskLifecycleRules.js';

const { Schema } = mongoose;

export const HELPDESK_TENANT_DEFAULTS = Object.freeze({
  enabled: false,
  allowEmployeeTickets: true,
  attachmentsEnabled: false,
  confidentialTicketsEnabled: false,
  defaultPriority: 'normal',
  allowEmployeeReopen: true,
  reopenWindowHours: HELPDESK_REOPEN_WINDOW_DEFAULT_HOURS,
  autoCloseEnabled: false,
  autoCloseDelayHours: HELPDESK_AUTO_CLOSE_DELAY_DEFAULT_HOURS,
});

const helpdeskTenantConfigSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      unique: true,
    },
    enabled: { type: Boolean, default: HELPDESK_TENANT_DEFAULTS.enabled },
    allowEmployeeTickets: {
      type: Boolean,
      default: HELPDESK_TENANT_DEFAULTS.allowEmployeeTickets,
    },
    attachmentsEnabled: {
      type: Boolean,
      default: HELPDESK_TENANT_DEFAULTS.attachmentsEnabled,
    },
    confidentialTicketsEnabled: {
      type: Boolean,
      default: HELPDESK_TENANT_DEFAULTS.confidentialTicketsEnabled,
    },
    defaultPriority: {
      type: String,
      enum: HELPDESK_PRIORITIES,
      default: HELPDESK_TENANT_DEFAULTS.defaultPriority,
    },
    allowEmployeeReopen: {
      type: Boolean,
      default: HELPDESK_TENANT_DEFAULTS.allowEmployeeReopen,
    },
    reopenWindowHours: {
      type: Number,
      min: HELPDESK_REOPEN_WINDOW_MIN_HOURS,
      max: HELPDESK_REOPEN_WINDOW_MAX_HOURS,
      default: HELPDESK_TENANT_DEFAULTS.reopenWindowHours,
    },
    autoCloseEnabled: {
      type: Boolean,
      default: HELPDESK_TENANT_DEFAULTS.autoCloseEnabled,
    },
    autoCloseDelayHours: {
      type: Number,
      min: HELPDESK_AUTO_CLOSE_DELAY_MIN_HOURS,
      max: HELPDESK_AUTO_CLOSE_DELAY_MAX_HOURS,
      default: HELPDESK_TENANT_DEFAULTS.autoCloseDelayHours,
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export default mongoose.model('HelpdeskTenantConfig', helpdeskTenantConfigSchema);
