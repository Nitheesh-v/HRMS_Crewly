import mongoose from 'mongoose';
import { HELPDESK_PRIORITIES } from '../services/helpdesk/helpdeskRules.js';

const { Schema } = mongoose;

export const HELPDESK_TENANT_DEFAULTS = Object.freeze({
  enabled: false,
  allowEmployeeTickets: true,
  attachmentsEnabled: false,
  confidentialTicketsEnabled: false,
  defaultPriority: 'normal',
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
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export default mongoose.model('HelpdeskTenantConfig', helpdeskTenantConfigSchema);
