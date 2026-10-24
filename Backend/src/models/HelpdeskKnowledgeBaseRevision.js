import mongoose from 'mongoose';

import {
  HELPDESK_KB_VISIBILITIES,
  HELPDESK_KB_TITLE_MAX,
  HELPDESK_KB_SUMMARY_MAX,
  HELPDESK_KB_BODY_MAX,
  HELPDESK_KB_RELATED_ARTICLES_MAX,
} from '../services/helpdesk/helpdeskKnowledgeBaseRules.js';

const { Schema } = mongoose;

const revisionContentSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: HELPDESK_KB_TITLE_MAX, immutable: true },
    summary: { type: String, default: '', trim: true, maxlength: HELPDESK_KB_SUMMARY_MAX, immutable: true },
    body: { type: String, required: true, maxlength: HELPDESK_KB_BODY_MAX, immutable: true },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'HelpdeskKnowledgeBaseCategory',
      required: true,
      immutable: true,
    },
    relatedQueueId: { type: Schema.Types.ObjectId, ref: 'HelpdeskQueue', default: null, immutable: true },
    visibility: { type: String, enum: HELPDESK_KB_VISIBILITIES, required: true, immutable: true },
    relatedArticleIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'HelpdeskKnowledgeBaseArticle', immutable: true }],
      default: [],
      immutable: true,
      validate: (value) => Array.isArray(value)
        && value.length <= HELPDESK_KB_RELATED_ARTICLES_MAX
        && new Set(value.map((id) => String(id).toLowerCase())).size === value.length,
    },
  },
  { _id: false },
);

const helpdeskKnowledgeBaseRevisionSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
    },
    articleId: {
      type: Schema.Types.ObjectId,
      ref: 'HelpdeskKnowledgeBaseArticle',
      required: true,
      immutable: true,
    },
    revision: { type: Number, required: true, min: 1, immutable: true },
    sourceDraftRevision: { type: Number, required: true, min: 1, immutable: true },
    content: { type: revisionContentSchema, required: true, immutable: true },
    publishedAt: { type: Date, required: true, immutable: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  },
  { timestamps: true, versionKey: false },
);

helpdeskKnowledgeBaseRevisionSchema.index(
  { companyId: 1, articleId: 1, revision: 1 },
  { unique: true, name: 'helpdesk_kb_revision_unique_by_tenant_article' },
);
helpdeskKnowledgeBaseRevisionSchema.index(
  { companyId: 1, articleId: 1, publishedAt: -1, _id: -1 },
  { name: 'helpdesk_kb_revision_history_order' },
);

export default mongoose.model('HelpdeskKnowledgeBaseRevision', helpdeskKnowledgeBaseRevisionSchema);
