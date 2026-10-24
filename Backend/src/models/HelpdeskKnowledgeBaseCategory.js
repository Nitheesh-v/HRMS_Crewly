import mongoose from 'mongoose';
import {
  HELPDESK_KB_CATEGORY_NAME_MAX,
  HELPDESK_KB_DESCRIPTION_MAX,
  HELPDESK_KB_MAX_SORT_ORDER,
} from '../services/helpdesk/helpdeskKnowledgeBaseRules.js';

const { Schema } = mongoose;

const helpdeskKnowledgeBaseCategorySchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
    },
    name: { type: String, required: true, trim: true, maxlength: HELPDESK_KB_CATEGORY_NAME_MAX },
    nameKey: { type: String, required: true, trim: true, lowercase: true, maxlength: HELPDESK_KB_CATEGORY_NAME_MAX },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 120,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      immutable: true,
    },
    slugKey: { type: String, required: true, trim: true, lowercase: true, maxlength: 120, immutable: true },
    description: { type: String, default: '', trim: true, maxlength: HELPDESK_KB_DESCRIPTION_MAX },
    sortOrder: { type: Number, min: 0, max: HELPDESK_KB_MAX_SORT_ORDER, default: 0 },
    version: { type: Number, required: true, min: 1, default: 1 },
    // Writers to this row serialize publication with category archival.
    publicationFenceVersion: { type: Number, required: true, min: 0, default: 0, select: false },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false },
);

helpdeskKnowledgeBaseCategorySchema.index(
  { companyId: 1, slugKey: 1 },
  { unique: true, name: 'helpdesk_kb_category_slug_unique_by_tenant' },
);
helpdeskKnowledgeBaseCategorySchema.index(
  { companyId: 1, nameKey: 1 },
  { unique: true, name: 'helpdesk_kb_category_name_unique_by_tenant' },
);
helpdeskKnowledgeBaseCategorySchema.index(
  { companyId: 1, archivedAt: 1, sortOrder: 1, nameKey: 1, _id: 1 },
  { name: 'helpdesk_kb_category_tenant_sort' },
);

export default mongoose.model('HelpdeskKnowledgeBaseCategory', helpdeskKnowledgeBaseCategorySchema);
