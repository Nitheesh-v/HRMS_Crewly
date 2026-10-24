import mongoose from 'mongoose';

import {
  HELPDESK_KB_STATUSES,
  HELPDESK_KB_VISIBILITIES,
  HELPDESK_KB_TITLE_MAX,
  HELPDESK_KB_SUMMARY_MAX,
  HELPDESK_KB_BODY_MAX,
  HELPDESK_KB_RELATED_ARTICLES_MAX,
  HELPDESK_KB_INDEX_TOKEN_MAX,
} from '../services/helpdesk/helpdeskKnowledgeBaseRules.js';

const { Schema } = mongoose;

const articleContentSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: HELPDESK_KB_TITLE_MAX },
    summary: { type: String, default: '', trim: true, maxlength: HELPDESK_KB_SUMMARY_MAX },
    body: { type: String, required: true, maxlength: HELPDESK_KB_BODY_MAX },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'HelpdeskKnowledgeBaseCategory',
      required: true,
    },
    relatedQueueId: { type: Schema.Types.ObjectId, ref: 'HelpdeskQueue', default: null },
    visibility: { type: String, enum: HELPDESK_KB_VISIBILITIES, required: true },
    relatedArticleIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'HelpdeskKnowledgeBaseArticle' }],
      default: [],
      validate: (value) => Array.isArray(value)
        && value.length <= HELPDESK_KB_RELATED_ARTICLES_MAX
        && new Set(value.map((id) => String(id).toLowerCase())).size === value.length,
    },
    // Derived only from published plain-text content; never returned in DTOs.
    searchTokens: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 40 }],
      default: undefined,
      select: false,
      validate: (value) => value === undefined || (Array.isArray(value) && value.length <= HELPDESK_KB_INDEX_TOKEN_MAX),
    },
  },
  { _id: false },
);

const helpdeskKnowledgeBaseArticleSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      immutable: true,
    },
    // Stable URL identity; revisions never change a published article's slug.
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
    status: { type: String, enum: HELPDESK_KB_STATUSES, required: true, default: 'draft' },
    draftContent: { type: articleContentSchema, default: null },
    publishedContent: { type: articleContentSchema, default: null },
    version: { type: Number, required: true, min: 1, default: 1 },
    draftRevision: { type: Number, required: true, min: 1, default: 1 },
    publishedRevision: { type: Number, required: true, min: 0, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    lastEditorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    publishedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

helpdeskKnowledgeBaseArticleSchema.pre('validate', function validateKnowledgeBaseArticleState() {
  if (this.status === 'draft' && !this.draftContent) {
    this.invalidate('draftContent', 'A draft article requires editable content.');
  }
  if (this.status === 'published' && (!this.publishedContent || !this.publishedAt)) {
    this.invalidate('publishedContent', 'A published article requires an immutable published snapshot.');
  }
  if (this.status === 'archived' && !this.archivedAt) {
    this.invalidate('archivedAt', 'An archived article requires an archive timestamp.');
  }
  if (Number(this.publishedRevision) > 0 && !this.publishedAt) {
    this.invalidate('publishedAt', 'A published revision requires a publication timestamp.');
  }
});

helpdeskKnowledgeBaseArticleSchema.index(
  { companyId: 1, slugKey: 1 },
  { unique: true, name: 'helpdesk_kb_article_slug_unique_by_tenant' },
);
helpdeskKnowledgeBaseArticleSchema.index(
  { companyId: 1, status: 1, publishedAt: -1, _id: -1 },
  {
    name: 'helpdesk_kb_article_published_order',
    partialFilterExpression: { status: 'published' },
  },
);
helpdeskKnowledgeBaseArticleSchema.index(
  { companyId: 1, status: 1, 'publishedContent.searchTokens': 1, publishedAt: -1, _id: -1 },
  {
    name: 'helpdesk_kb_article_published_tokens',
    partialFilterExpression: { status: 'published' },
  },
);
helpdeskKnowledgeBaseArticleSchema.index(
  { companyId: 1, status: 1, 'publishedContent.visibility': 1, 'publishedContent.relatedQueueId': 1, publishedAt: -1, _id: -1 },
  {
    name: 'helpdesk_kb_article_published_visibility',
    partialFilterExpression: { status: 'published' },
  },
);
helpdeskKnowledgeBaseArticleSchema.index(
  { companyId: 1, status: 1, 'publishedContent.categoryId': 1 },
  { name: 'helpdesk_kb_article_published_category' },
);
helpdeskKnowledgeBaseArticleSchema.index(
  { companyId: 1, status: 1, 'draftContent.categoryId': 1 },
  { name: 'helpdesk_kb_article_draft_category' },
);
helpdeskKnowledgeBaseArticleSchema.index(
  { companyId: 1, status: 1, updatedAt: -1, _id: -1 },
  { name: 'helpdesk_kb_article_admin_order' },
);

export default mongoose.model('HelpdeskKnowledgeBaseArticle', helpdeskKnowledgeBaseArticleSchema);
