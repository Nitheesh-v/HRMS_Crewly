import mongoose from 'mongoose';
import env from './env.js';
import logger from './logger.js';
import HelpdeskAuthorizationFence from '../models/HelpdeskAuthorizationFence.js';
import HelpdeskTicket from '../models/HelpdeskTicket.js';
import HelpdeskQueue from '../models/HelpdeskQueue.js';
import HelpdeskTicketLifecycleEvent from '../models/HelpdeskTicketLifecycleEvent.js';
import HelpdeskKnowledgeBaseArticle from '../models/HelpdeskKnowledgeBaseArticle.js';
import HelpdeskKnowledgeBaseCategory from '../models/HelpdeskKnowledgeBaseCategory.js';
import HelpdeskKnowledgeBaseRevision from '../models/HelpdeskKnowledgeBaseRevision.js';

const ensureHelpdeskAuthorizationFenceIndex = async () => {
  // Keep the write path disabled at boot unless Mongo confirms the unique
  // compound key that makes the membership fence a shared serialization point.
  await HelpdeskAuthorizationFence.init();
  const cursor = HelpdeskAuthorizationFence.collection.listIndexes();
  const indexes = typeof cursor?.toArray === 'function' ? await cursor.toArray() : await cursor;
  const fenceIndex = (indexes || []).find((index) =>
    index.name === 'helpdesk_authorization_fence_unique'
      && index.unique === true
      && index.key?.companyId === 1
      && index.key?.queueId === 1
      && index.key?.userId === 1
      && Object.keys(index.key || {}).length === 3,
  );
  if (!fenceIndex) {
    throw new Error('Required Helpdesk authorization fence index is not available');
  }
};

const ensureHelpdeskLifecycleIndexes = async () => {
  await HelpdeskTicket.collection.createIndex(
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
  await HelpdeskTicketLifecycleEvent.collection.createIndex(
    { companyId: 1, ticketId: 1, sequence: 1 },
    { unique: true, name: 'helpdesk_ticket_lifecycle_sequence_unique' },
  );
  await HelpdeskTicketLifecycleEvent.collection.createIndex(
    { companyId: 1, ticketId: 1, occurredAt: -1, sequence: -1 },
    { name: 'helpdesk_ticket_lifecycle_history' },
  );

  const ticketCursor = HelpdeskTicket.collection.listIndexes();
  const ticketIndexes = typeof ticketCursor?.toArray === 'function'
    ? await ticketCursor.toArray()
    : await ticketCursor;
  const lifecycleCursor = HelpdeskTicketLifecycleEvent.collection.listIndexes();
  const lifecycleIndexes = typeof lifecycleCursor?.toArray === 'function'
    ? await lifecycleCursor.toArray()
    : await lifecycleCursor;
  const keyMatches = (index, expected) =>
    JSON.stringify(Object.entries(index?.key || {})) === JSON.stringify(Object.entries(expected));
  const autoCloseIndex = (ticketIndexes || []).find((index) =>
    index.name === 'helpdesk_ticket_auto_close_due'
      && keyMatches(index, { autoCloseAt: 1, companyId: 1, _id: 1 }),
  );
  const sequenceIndex = (lifecycleIndexes || []).find((index) =>
    index.name === 'helpdesk_ticket_lifecycle_sequence_unique'
      && index.unique === true
      && keyMatches(index, { companyId: 1, ticketId: 1, sequence: 1 }),
  );
  const historyIndex = (lifecycleIndexes || []).find((index) =>
    index.name === 'helpdesk_ticket_lifecycle_history'
      && keyMatches(index, { companyId: 1, ticketId: 1, occurredAt: -1, sequence: -1 }),
  );
  if (!autoCloseIndex || !sequenceIndex || !historyIndex) {
    throw new Error('Required Helpdesk lifecycle indexes are not available');
  }
};

const ensureHelpdeskKnowledgeBaseIndexes = async () => {
  // Explicit creation makes a missing or incompatible index a startup failure, not a silent search/auth regression.
  await HelpdeskQueue.createIndexes();
  await HelpdeskKnowledgeBaseCategory.createIndexes();
  await HelpdeskKnowledgeBaseArticle.createIndexes();
  await HelpdeskKnowledgeBaseRevision.createIndexes();

  const readIndexes = async (model) => {
    const cursor = model.collection.listIndexes();
    return typeof cursor?.toArray === 'function' ? cursor.toArray() : cursor;
  };
  const [queueIndexes, categoryIndexes, articleIndexes, revisionIndexes] = await Promise.all([
    readIndexes(HelpdeskQueue),
    readIndexes(HelpdeskKnowledgeBaseCategory),
    readIndexes(HelpdeskKnowledgeBaseArticle),
    readIndexes(HelpdeskKnowledgeBaseRevision),
  ]);
  const keyMatches = (index, expected) =>
    JSON.stringify(Object.entries(index?.key || {})) === JSON.stringify(Object.entries(expected));
  const findIndex = (indexes, { name, key, unique = false, partialStatus = null }) =>
    (indexes || []).find((index) =>
      index.name === name
      && keyMatches(index, key)
      && (!unique || index.unique === true)
      && (!partialStatus || index.partialFilterExpression?.status === partialStatus),
    );

  const requiredQueueIndexes = [
    { name: 'helpdesk_queue_enabled_agent_membership', key: { companyId: 1, enabled: 1, agents: 1 } },
    { name: 'helpdesk_queue_enabled_manager_membership', key: { companyId: 1, enabled: 1, managers: 1 } },
    { name: 'helpdesk_queue_enabled_confidential_agent_membership', key: { companyId: 1, enabled: 1, 'confidentiality.enabled': 1, 'confidentiality.agentIds': 1 } },
  ];
  const requiredCategoryIndexes = [
    { name: 'helpdesk_kb_category_slug_unique_by_tenant', key: { companyId: 1, slugKey: 1 }, unique: true },
    { name: 'helpdesk_kb_category_name_unique_by_tenant', key: { companyId: 1, nameKey: 1 }, unique: true },
    { name: 'helpdesk_kb_category_tenant_sort', key: { companyId: 1, archivedAt: 1, sortOrder: 1, nameKey: 1, _id: 1 } },
  ];
  const requiredRevisionIndexes = [
    { name: 'helpdesk_kb_revision_unique_by_tenant_article', key: { companyId: 1, articleId: 1, revision: 1 }, unique: true },
    { name: 'helpdesk_kb_revision_history_order', key: { companyId: 1, articleId: 1, publishedAt: -1, _id: -1 } },
  ];
  const requiredArticleIndexes = [
    { name: 'helpdesk_kb_article_slug_unique_by_tenant', key: { companyId: 1, slugKey: 1 }, unique: true },
    { name: 'helpdesk_kb_article_published_order', key: { companyId: 1, status: 1, publishedAt: -1, _id: -1 }, partialStatus: 'published' },
    { name: 'helpdesk_kb_article_published_tokens', key: { companyId: 1, status: 1, 'publishedContent.searchTokens': 1, publishedAt: -1, _id: -1 }, partialStatus: 'published' },
    { name: 'helpdesk_kb_article_published_visibility', key: { companyId: 1, status: 1, 'publishedContent.visibility': 1, 'publishedContent.relatedQueueId': 1, publishedAt: -1, _id: -1 }, partialStatus: 'published' },
    { name: 'helpdesk_kb_article_published_category', key: { companyId: 1, status: 1, 'publishedContent.categoryId': 1 } },
    { name: 'helpdesk_kb_article_draft_category', key: { companyId: 1, status: 1, 'draftContent.categoryId': 1 } },
    { name: 'helpdesk_kb_article_admin_order', key: { companyId: 1, status: 1, updatedAt: -1, _id: -1 } },
  ];
  if (
    requiredQueueIndexes.some((expected) => !findIndex(queueIndexes, expected))
    || requiredCategoryIndexes.some((expected) => !findIndex(categoryIndexes, expected))
    || requiredArticleIndexes.some((expected) => !findIndex(articleIndexes, expected))
    || requiredRevisionIndexes.some((expected) => !findIndex(revisionIndexes, expected))
  ) {
    throw new Error('Required Helpdesk Knowledge Base indexes are not available');
  }
};

const connectDB = async () => {
  try {
    mongoose.set('strictQuery', true);

    const conn = await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });

    await ensureHelpdeskAuthorizationFenceIndex();
    await ensureHelpdeskLifecycleIndexes();
    await ensureHelpdeskKnowledgeBaseIndexes();
    logger.info(`✅ MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
  } catch (error) {
    logger.error(`❌ MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  logger.warn('⚠️  MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error(`MongoDB error: ${err.message}`);
});

export default connectDB;