import mongoose from 'mongoose';

const { Schema } = mongoose;

const queueCategorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameKey: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    description: { type: String, default: '', trim: true, maxlength: 240 },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: false },
);

const helpdeskQueueSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameKey: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    enabled: { type: Boolean, default: true },
    categories: { type: [queueCategorySchema], default: [] },
    agents: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    managers: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    confidentiality: {
      enabled: { type: Boolean, default: false },
      agentIds: {
        type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
        default: [],
      },
      reviewerIds: {
        type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
        default: [],
      },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

helpdeskQueueSchema.pre('validate', function validateCategoryKeys() {
  const seen = new Set();
  this.categories.forEach((category, index) => {
    const key = String(category.nameKey || '')
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase('en-US');
    if (seen.has(key)) {
      this.invalidate(`categories.${index}.nameKey`, 'Category names must be unique within a queue');
    }
    seen.add(key);
  });
});

helpdeskQueueSchema.index(
  { companyId: 1, nameKey: 1 },
  { unique: true, name: 'helpdesk_queue_name_unique_by_tenant' },
);
// Phase 38.8 — indexed current-membership reads for Knowledge Base audience authorization.
helpdeskQueueSchema.index(
  { companyId: 1, enabled: 1, agents: 1 },
  { name: 'helpdesk_queue_enabled_agent_membership' },
);
helpdeskQueueSchema.index(
  { companyId: 1, enabled: 1, managers: 1 },
  { name: 'helpdesk_queue_enabled_manager_membership' },
);
helpdeskQueueSchema.index(
  { companyId: 1, enabled: 1, 'confidentiality.enabled': 1, 'confidentiality.agentIds': 1 },
  { name: 'helpdesk_queue_enabled_confidential_agent_membership' },
);

export default mongoose.model('HelpdeskQueue', helpdeskQueueSchema);
