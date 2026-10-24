import HelpdeskKnowledgeBaseArticle from '../../models/HelpdeskKnowledgeBaseArticle.js';
import HelpdeskKnowledgeBaseCategory from '../../models/HelpdeskKnowledgeBaseCategory.js';
import HelpdeskKnowledgeBaseRevision from '../../models/HelpdeskKnowledgeBaseRevision.js';
import HelpdeskQueue from '../../models/HelpdeskQueue.js';
import ApiError from '../../utils/ApiError.js';
import { runHelpdeskTransaction } from './helpdeskTransaction.js';
import {
  HELPDESK_KB_MESSAGE_ARTICLES_MAX,
  HELPDESK_KB_TICKET_HISTORY_REFERENCES_MAX,
  buildHelpdeskKbSearchTokens,
  encodeHelpdeskKbCursor,
  normalizeHelpdeskKbAdminListQuery,
  normalizeHelpdeskKbArticleContent,
  normalizeHelpdeskKbCategoryInput,
  normalizeHelpdeskKbExpectedVersion,
  normalizeHelpdeskKbId,
  normalizeHelpdeskKbRelatedArticleIds,
  normalizeHelpdeskKbRevisionListQuery,
  normalizeHelpdeskKbRevisionNumber,
  normalizeHelpdeskKbSearch,
  normalizeHelpdeskKbSlug,
} from './helpdeskKnowledgeBaseRules.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const plain = (value) => value && typeof value.toObject === 'function' ? value.toObject() : value;
const idString = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};
const duplicateKey = (error) => {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.code === 11000) return true;
    current = current.cause;
  }
  return false;
};

const ensureCompanyId = (companyId) => {
  if (!companyId) throw ApiError.forbidden('A tenant is required.');
};
const ensureActorId = (actorId) => {
  if (!actorId) throw ApiError.unauthorized('An authenticated user is required.');
};
const ensureObjectId = (value, field = 'id') => {
  const id = String(value || '');
  if (!OBJECT_ID.test(id)) throw ApiError.notFound(`${field} not found.`);
  return id;
};
const unavailable = (message) => ApiError.unavailable(message);

const cursorFilter = (cursor, field) => {
  if (!cursor) return null;
  return {
    $or: [
      { [field]: { $lt: cursor.at } },
      { [field]: cursor.at, _id: { $lt: cursor.id } },
    ],
  };
};

const buildVisibilityFilter = ({ staffQueueIds = [], confidentialQueueIds = [] } = {}) => ({
  $or: [
    { 'publishedContent.visibility': 'employees' },
    ...(staffQueueIds.length
      ? [{
          'publishedContent.visibility': 'queue_staff',
          'publishedContent.relatedQueueId': { $in: staffQueueIds },
        }]
      : []),
    ...(confidentialQueueIds.length
      ? [{
          'publishedContent.visibility': 'confidential_queue_staff',
          'publishedContent.relatedQueueId': { $in: confidentialQueueIds },
        }]
      : []),
  ],
});

const categoryDto = (category) => ({
  id: idString(category?._id),
  name: String(category?.name || ''),
  slug: String(category?.slug || ''),
  description: String(category?.description || ''),
  sortOrder: Number(category?.sortOrder) || 0,
  version: Number(category?.version) || 1,
  archivedAt: category?.archivedAt || null,
  createdAt: category?.createdAt || null,
  updatedAt: category?.updatedAt || null,
});

const employeeCategoryDto = (category) => ({
  id: idString(category?._id),
  name: String(category?.name || ''),
  slug: String(category?.slug || ''),
  description: String(category?.description || ''),
});

const employeeArticleListDto = (article) => ({
  id: idString(article?._id),
  slug: String(article?.slug || ''),
  title: String(article?.publishedContent?.title || ''),
  summary: String(article?.publishedContent?.summary || ''),
  categoryId: idString(article?.publishedContent?.categoryId),
  relatedQueueId: idString(article?.publishedContent?.relatedQueueId) || null,
  publishedAt: article?.publishedAt || null,
});

const employeeArticleLinkDto = (article) => ({
  id: idString(article?._id),
  slug: String(article?.slug || ''),
  title: String(article?.publishedContent?.title || ''),
  summary: String(article?.publishedContent?.summary || ''),
});

const adminContentDto = (content) => {
  if (!content) return null;
  return {
    title: String(content.title || ''),
    summary: String(content.summary || ''),
    body: String(content.body || ''),
    categoryId: idString(content.categoryId),
    relatedQueueId: idString(content.relatedQueueId) || null,
    visibility: String(content.visibility || ''),
    relatedArticleIds: (content.relatedArticleIds || []).map(idString),
  };
};

const adminArticleListDto = (article) => {
  const content = article?.draftContent || article?.publishedContent || {};
  return {
    id: idString(article?._id),
    slug: String(article?.slug || ''),
    status: String(article?.status || 'draft'),
    title: String(content.title || ''),
    categoryId: idString(content.categoryId),
    relatedQueueId: idString(content.relatedQueueId) || null,
    visibility: String(content.visibility || ''),
    version: Number(article?.version) || 1,
    draftRevision: Number(article?.draftRevision) || 1,
    publishedRevision: Number(article?.publishedRevision) || 0,
    publishedAt: article?.publishedAt || null,
    createdAt: article?.createdAt || null,
    updatedAt: article?.updatedAt || null,
  };
};

const adminArticleDetailsDto = (article) => ({
  ...adminArticleListDto(article),
  createdBy: idString(article?.createdBy) || null,
  lastEditorId: idString(article?.lastEditorId) || null,
  publishedBy: idString(article?.publishedBy) || null,
  archivedBy: idString(article?.archivedBy) || null,
  archivedAt: article?.archivedAt || null,
  draftContent: adminContentDto(article?.draftContent),
  publishedContent: adminContentDto(article?.publishedContent),
});

const adminRevisionListDto = (revision) => ({
  id: idString(revision?._id),
  revision: Number(revision?.revision) || 0,
  sourceDraftRevision: Number(revision?.sourceDraftRevision) || 1,
  title: String(revision?.content?.title || ''),
  summary: String(revision?.content?.summary || ''),
  publishedAt: revision?.publishedAt || null,
  publishedBy: idString(revision?.publishedBy) || null,
});

const adminRevisionDetailsDto = (revision) => ({
  ...adminRevisionListDto(revision),
  articleId: idString(revision?.articleId),
  content: adminContentDto(revision?.content),
});

export const helpdeskKnowledgeBaseService = (deps = {}) => {
  const ArticleModel = deps.ArticleModel || HelpdeskKnowledgeBaseArticle;
  const CategoryModel = deps.CategoryModel || HelpdeskKnowledgeBaseCategory;
  const RevisionModel = deps.RevisionModel || HelpdeskKnowledgeBaseRevision;
  const QueueModel = deps.QueueModel || HelpdeskQueue;
  const transactionRunner = deps.transactionRunner || runHelpdeskTransaction;
  const now = deps.now || (() => new Date());

  const queryOne = async (modelQuery, { projection = null, session = null } = {}) => {
    try {
      let query = modelQuery;
      if (session && typeof query?.session === 'function') query = query.session(session);
      if (projection && typeof query?.select === 'function') query = query.select(projection);
      if (typeof query?.lean === 'function') query = query.lean();
      return await query;
    } catch (error) {
      if (error?.statusCode || session) throw error;
      throw unavailable('Knowledge Base data is temporarily unavailable.');
    }
  };

  const queryMany = async (modelQuery, {
    projection = null,
    sort = null,
    limit = null,
    session = null,
  } = {}) => {
    try {
      let query = modelQuery;
      if (session && typeof query?.session === 'function') query = query.session(session);
      if (projection && typeof query?.select === 'function') query = query.select(projection);
      if (sort && typeof query?.sort === 'function') query = query.sort(sort);
      if (Number.isInteger(limit) && typeof query?.limit === 'function') query = query.limit(limit);
      if (typeof query?.lean === 'function') query = query.lean();
      return await query;
    } catch (error) {
      if (error?.statusCode || session) throw error;
      throw unavailable('Knowledge Base data is temporarily unavailable.');
    }
  };

  const loadReaderQueueIds = async ({ companyId, viewerId, canReadQueue = false } = {}) => {
    if (canReadQueue !== true) return { staffQueueIds: [], confidentialQueueIds: [] };
    const [staffQueues, confidentialQueues] = await Promise.all([
      queryMany(
        QueueModel.find({
          companyId,
          enabled: true,
          $or: [{ agents: viewerId }, { managers: viewerId }],
        }),
        { projection: '_id' },
      ),
      queryMany(
        QueueModel.find({
          companyId,
          enabled: true,
          'confidentiality.enabled': true,
          agents: viewerId,
          'confidentiality.agentIds': viewerId,
        }),
        { projection: '_id' },
      ),
    ]);
    return {
      staffQueueIds: (staffQueues || []).map((queue) => queue._id),
      // Queue managers and ticket reviewers do not receive this audience by implication.
      confidentialQueueIds: (confidentialQueues || []).map((queue) => queue._id),
    };
  };

  const validateCategoryAndQueue = async ({ companyId, content, session = null }) => {
    const category = await queryOne(
      CategoryModel.findOne({
        _id: content.categoryId,
        companyId,
        archivedAt: null,
      }),
      { projection: '_id name slug version archivedAt', session },
    );
    if (!category) throw ApiError.badRequest('The selected Knowledge Base category is unavailable.');

    if (content.relatedQueueId) {
      const queueFilter = {
        _id: content.relatedQueueId,
        companyId,
        enabled: true,
      };
      if (content.visibility === 'confidential_queue_staff') queueFilter['confidentiality.enabled'] = true;
      const queue = await queryOne(
        QueueModel.findOne(queueFilter),
        { projection: '_id companyId enabled', session },
      );
      if (!queue) throw ApiError.badRequest('The selected Helpdesk queue is unavailable.');
    }
    if (content.visibility !== 'employees' && !content.relatedQueueId) {
      throw ApiError.badRequest('Queue-restricted articles require a Helpdesk queue.');
    }
    return category;
  };

  const lockArticleCategories = async ({ companyId, categoryIds = [], session = null } = {}) => {
    const uniqueIds = [...new Set(categoryIds.filter(Boolean).map(idString))]
      .sort((left, right) => left.localeCompare(right));
    for (const categoryId of uniqueIds) {
      const result = await CategoryModel.updateOne(
        { _id: categoryId, companyId, archivedAt: null },
        { $inc: { publicationFenceVersion: 1 } },
        { session },
      );
      const matchedCount = Number.isInteger(result?.matchedCount) ? result.matchedCount : result?.n;
      if (!result || result.acknowledged === false || matchedCount !== 1) {
        throw ApiError.conflict('The article category was archived or changed. Refresh and try again.');
      }
    }
  };

  const validateRelatedArticles = async ({
    companyId,
    relatedArticleIds = [],
    excludeArticleId = null,
    session = null,
  } = {}) => {
    const ids = normalizeHelpdeskKbRelatedArticleIds(relatedArticleIds);
    if (!ids.length) return [];
    if (excludeArticleId && ids.some((id) => idString(id).toLowerCase() === idString(excludeArticleId).toLowerCase())) {
      throw ApiError.badRequest('An article cannot be related to itself.');
    }
    const rows = await queryMany(
      ArticleModel.find({
        companyId,
        _id: { $in: ids },
        status: 'published',
        archivedAt: null,
        'publishedContent.visibility': 'employees',
      }),
      { projection: '_id slug status publishedContent.title', session },
    );
    const found = new Set((rows || []).map((row) => idString(row._id).toLowerCase()));
    if (found.size !== ids.length || ids.some((id) => !found.has(id.toLowerCase()))) {
      throw ApiError.badRequest('One or more related Knowledge Base articles are unavailable.');
    }
    return ids;
  };

  const normalizeContent = async ({
    companyId,
    input,
    base = null,
    creating = false,
    articleId = null,
    session = null,
  }) => {
    const content = normalizeHelpdeskKbArticleContent(input, { base, creating });
    await validateCategoryAndQueue({ companyId, content, session });
    await validateRelatedArticles({
      companyId,
      relatedArticleIds: content.relatedArticleIds,
      excludeArticleId: articleId,
      session,
    });
    return content;
  };

  const createArticleDraft = async ({ companyId, actorId, input = {} } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw ApiError.badRequest('Article details must be an object.');
    }
    const allowed = [
      'slug',
      'title',
      'summary',
      'body',
      'categoryId',
      'relatedQueueId',
      'visibility',
      'relatedArticleIds',
    ];
    const unknown = Object.keys(input).find((key) => !allowed.includes(key));
    if (unknown) throw ApiError.badRequest(`Unsupported article field: ${unknown}`);
    const slug = normalizeHelpdeskKbSlug(input.slug);
    const contentInput = { ...input };
    delete contentInput.slug;
    try {
      return await transactionRunner(async (session) => {
        const content = await normalizeContent({ companyId, input: contentInput, creating: true, session });
        await lockArticleCategories({ companyId, categoryIds: [content.categoryId], session });
        const createdRows = await ArticleModel.create([{
          companyId,
          slug,
          slugKey: slug,
          status: 'draft',
          draftContent: content,
          draftRevision: 1,
          publishedRevision: 0,
          version: 1,
          createdBy: actorId,
          lastEditorId: actorId,
        }], { session });
        return adminArticleDetailsDto(plain(Array.isArray(createdRows) ? createdRows[0] : createdRows));
      });
    } catch (error) {
      if (duplicateKey(error)) throw ApiError.conflict('An article with this slug already exists in this tenant.');
      if (error?.statusCode) throw error;
      throw unavailable('The Knowledge Base draft could not be created.');
    }
  };

  const getAdminArticle = async ({ companyId, articleId } = {}) => {
    ensureCompanyId(companyId);
    const id = ensureObjectId(articleId, 'Knowledge Base article');
    const article = await queryOne(
      ArticleModel.findOne({ _id: id, companyId }),
      { projection: '-publishedContent.searchTokens -draftContent.searchTokens' },
    );
    if (!article) throw ApiError.notFound('Knowledge Base article not found.');
    return adminArticleDetailsDto(article);
  };

  const listAdminArticleRevisions = async ({ companyId, articleId, query = {} } = {}) => {
    ensureCompanyId(companyId);
    const id = ensureObjectId(articleId, 'Knowledge Base article');
    const options = normalizeHelpdeskKbRevisionListQuery(query);
    const article = await queryOne(
      ArticleModel.findOne({ _id: id, companyId }),
      { projection: '_id' },
    );
    if (!article) throw ApiError.notFound('Knowledge Base article not found.');
    const filter = { companyId, articleId: id };
    const pageCursor = cursorFilter(options.cursor, 'publishedAt');
    if (pageCursor) filter.$and = [pageCursor];
    const rows = await queryMany(
      RevisionModel.find(filter),
      {
        projection: '_id articleId revision sourceDraftRevision publishedAt publishedBy content.title content.summary',
        sort: { publishedAt: -1, _id: -1 },
        limit: options.limit + 1,
      },
    );
    const hasMore = (rows || []).length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);
    return {
      revisions: page.map(adminRevisionListDto),
      meta: {
        limit: options.limit,
        hasMore,
        nextCursor: hasMore && last
          ? encodeHelpdeskKbCursor({ at: last.publishedAt, id: idString(last._id) })
          : null,
      },
    };
  };

  const getAdminArticleRevision = async ({ companyId, articleId, revision } = {}) => {
    ensureCompanyId(companyId);
    const id = ensureObjectId(articleId, 'Knowledge Base article');
    const revisionNumber = normalizeHelpdeskKbRevisionNumber(revision);
    const article = await queryOne(
      ArticleModel.findOne({ _id: id, companyId }),
      { projection: '_id' },
    );
    if (!article) throw ApiError.notFound('Knowledge Base article not found.');
    const row = await queryOne(
      RevisionModel.findOne({ companyId, articleId: id, revision: revisionNumber }),
      { projection: '-content.searchTokens' },
    );
    if (!row) throw ApiError.notFound('Knowledge Base revision not found.');
    return adminRevisionDetailsDto(row);
  };

  const restoreArticleRevisionToDraft = async ({
    companyId,
    actorId,
    articleId,
    revision,
    expectedVersion,
  } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const id = ensureObjectId(articleId, 'Knowledge Base article');
    const revisionNumber = normalizeHelpdeskKbRevisionNumber(revision);
    const version = normalizeHelpdeskKbExpectedVersion(expectedVersion);
    return transactionRunner(async (session) => {
      const article = await queryOne(
        ArticleModel.findOne({ _id: id, companyId }),
        { projection: '-publishedContent.searchTokens -draftContent.searchTokens', session },
      );
      if (!article) throw ApiError.notFound('Knowledge Base article not found.');
      if (article.status === 'archived') throw ApiError.conflict('Archived articles cannot receive a restored draft.');
      if (Number(article.version) !== version) {
        throw ApiError.conflict('The Knowledge Base article changed. Refresh and try again.');
      }
      const previousRevision = await queryOne(
        RevisionModel.findOne({ companyId, articleId: id, revision: revisionNumber }),
        { projection: '-content.searchTokens', session },
      );
      if (!previousRevision) throw ApiError.notFound('Knowledge Base revision not found.');
      const restoredInput = {
        title: previousRevision.content.title,
        summary: previousRevision.content.summary,
        body: previousRevision.content.body,
        categoryId: idString(previousRevision.content.categoryId),
        relatedQueueId: idString(previousRevision.content.relatedQueueId) || null,
        visibility: previousRevision.content.visibility,
        relatedArticleIds: (previousRevision.content.relatedArticleIds || []).map(idString),
      };
      const content = await normalizeContent({
        companyId,
        input: restoredInput,
        creating: true,
        articleId: id,
        session,
      });
      const currentContent = article.draftContent || article.publishedContent;
      await lockArticleCategories({
        companyId,
        categoryIds: [currentContent?.categoryId, content.categoryId],
        session,
      });
      const draftRevision = (article.draftContent
        ? Number(article.draftRevision) || 0
        : Number(article.publishedRevision) || 0) + 1;
      const updated = await ArticleModel.findOneAndUpdate(
        { _id: id, companyId, status: { $in: ['draft', 'published'] }, version },
        {
          $set: { draftContent: content, draftRevision, lastEditorId: actorId },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', runValidators: true, session },
      );
      if (!updated) throw ApiError.conflict('The Knowledge Base article changed. Refresh and try again.');
      return adminArticleDetailsDto(plain(updated));
    });
  };

  const listAdminArticles = async ({ companyId, query = {} } = {}) => {
    ensureCompanyId(companyId);
    const options = normalizeHelpdeskKbAdminListQuery(query);
    const filter = { companyId };
    if (options.status) filter.status = options.status;
    if (options.categoryId) {
      filter.$or = [
        { 'draftContent.categoryId': options.categoryId },
        { 'publishedContent.categoryId': options.categoryId },
      ];
    }
    const pageCursor = cursorFilter(options.cursor, 'updatedAt');
    if (pageCursor) filter.$and = [pageCursor];
    const rows = await queryMany(
      ArticleModel.find(filter),
      {
        projection: '_id slug status version draftRevision publishedRevision publishedAt createdAt updatedAt draftContent.title draftContent.categoryId draftContent.relatedQueueId draftContent.visibility publishedContent.title publishedContent.categoryId publishedContent.relatedQueueId publishedContent.visibility',
        sort: { updatedAt: -1, _id: -1 },
        limit: options.limit + 1,
      },
    );
    const hasMore = (rows || []).length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);
    return {
      articles: page.map(adminArticleListDto),
      meta: {
        limit: options.limit,
        hasMore,
        nextCursor: hasMore && last
          ? encodeHelpdeskKbCursor({ at: last.updatedAt, id: idString(last._id) })
          : null,
      },
    };
  };

  const searchArticles = async ({
    companyId,
    viewerId,
    canReadQueue = false,
    query = {},
  } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(viewerId);
    const options = normalizeHelpdeskKbSearch(query);
    const readerQueueIds = await loadReaderQueueIds({ companyId, viewerId, canReadQueue });
    const filter = {
      companyId,
      status: 'published',
      archivedAt: null,
      ...buildVisibilityFilter(readerQueueIds),
    };
    if (options.categoryId) {
      const category = await queryOne(
        CategoryModel.findOne({ _id: options.categoryId, companyId, archivedAt: null }),
        { projection: '_id' },
      );
      if (!category) throw ApiError.notFound('Knowledge Base category not found.');
      filter['publishedContent.categoryId'] = options.categoryId;
    }
    if (options.queueId) {
      const queue = await queryOne(
        QueueModel.findOne({ _id: options.queueId, companyId, enabled: true }),
        { projection: '_id' },
      );
      if (!queue) throw ApiError.notFound('Helpdesk queue not found.');
      filter['publishedContent.relatedQueueId'] = options.queueId;
    }
    if (options.terms.length) filter['publishedContent.searchTokens'] = { $all: options.terms };
    const pageCursor = cursorFilter(options.cursor, 'publishedAt');
    if (pageCursor) filter.$and = [pageCursor];

    const rows = await queryMany(
      ArticleModel.find(filter),
      {
        projection: '_id slug status publishedAt publishedContent.title publishedContent.summary publishedContent.categoryId publishedContent.relatedQueueId',
        sort: { publishedAt: -1, _id: -1 },
        limit: options.limit + 1,
      },
    );
    const hasMore = (rows || []).length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);
    return {
      articles: page.map(employeeArticleListDto),
      meta: {
        limit: options.limit,
        hasMore,
        nextCursor: hasMore && last
          ? encodeHelpdeskKbCursor({ at: last.publishedAt, id: idString(last._id) })
          : null,
      },
    };
  };

  const listEmployeeCategories = async ({
    companyId,
    viewerId,
    canReadQueue = false,
  } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(viewerId);
    const readerQueueIds = await loadReaderQueueIds({ companyId, viewerId, canReadQueue });
    const articleFilter = {
      companyId,
      status: 'published',
      archivedAt: null,
      ...buildVisibilityFilter(readerQueueIds),
    };
    let categoryIds;
    try {
      categoryIds = await ArticleModel.distinct('publishedContent.categoryId', articleFilter);
    } catch {
      throw unavailable('Knowledge Base categories are temporarily unavailable.');
    }
    if (!Array.isArray(categoryIds) || !categoryIds.length) return [];
    const categories = await queryMany(
      CategoryModel.find({ companyId, _id: { $in: categoryIds }, archivedAt: null }),
      { projection: '_id name slug description sortOrder', sort: { sortOrder: 1, nameKey: 1, _id: 1 } },
    );
    return (categories || []).map(employeeCategoryDto);
  };

  const getEmployeeArticleBySlug = async ({
    companyId,
    viewerId,
    canReadQueue = false,
    slug,
  } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(viewerId);
    const normalizedSlug = normalizeHelpdeskKbSlug(slug, 'slug');
    const readerQueueIds = await loadReaderQueueIds({ companyId, viewerId, canReadQueue });
    const article = await queryOne(
      ArticleModel.findOne({
        companyId,
        slugKey: normalizedSlug,
        status: 'published',
        archivedAt: null,
        ...buildVisibilityFilter(readerQueueIds),
      }),
      { projection: '-publishedContent.searchTokens -draftContent.searchTokens' },
    );
    if (!article) throw ApiError.notFound('Knowledge Base article not found.');

    const content = article.publishedContent || {};
    const category = await queryOne(
      CategoryModel.findOne({ _id: content.categoryId, companyId, archivedAt: null }),
      { projection: '_id name slug' },
    );
    if (!category) throw ApiError.notFound('Knowledge Base article not found.');

    const relatedIds = (content.relatedArticleIds || []).map((id) => id?._id || id);
    const relatedRows = relatedIds.length
      ? await queryMany(
        ArticleModel.find({
          companyId,
          _id: { $in: relatedIds },
          status: 'published',
          archivedAt: null,
          'publishedContent.visibility': 'employees',
        }),
        { projection: '_id slug publishedContent.title publishedContent.summary' },
      )
      : [];
    const relatedById = new Map((relatedRows || []).map((row) => [idString(row._id).toLowerCase(), employeeArticleLinkDto(row)]));

    return {
      id: idString(article._id),
      slug: String(article.slug || ''),
      title: String(content.title || ''),
      summary: String(content.summary || ''),
      body: String(content.body || ''),
      category: employeeCategoryDto(category),
      relatedQueueId: idString(content.relatedQueueId) || null,
      relatedArticles: relatedIds
        .map((id) => relatedById.get(idString(id).toLowerCase()))
        .filter(Boolean),
      publishedAt: article.publishedAt || null,
      revision: Number(article.publishedRevision) || 1,
    };
  };

  const listAdminCategories = async ({ companyId } = {}) => {
    ensureCompanyId(companyId);
    const categories = await queryMany(
      CategoryModel.find({ companyId }),
      { projection: '_id name nameKey slug slugKey description sortOrder version archivedAt createdAt updatedAt', sort: { archivedAt: 1, sortOrder: 1, nameKey: 1, _id: 1 } },
    );
    return (categories || []).map(categoryDto);
  };

  const createCategory = async ({ companyId, actorId, input = {} } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const patch = normalizeHelpdeskKbCategoryInput(input, { creating: true });
    try {
      const created = await CategoryModel.create({
        companyId,
        ...patch,
        version: 1,
        publicationFenceVersion: 0,
        archivedAt: null,
        createdBy: actorId,
        updatedBy: actorId,
      });
      return categoryDto(plain(created));
    } catch (error) {
      if (duplicateKey(error)) throw ApiError.conflict('A Knowledge Base category with that name or slug already exists.');
      throw unavailable('The Knowledge Base category could not be created.');
    }
  };

  const updateCategory = async ({ companyId, actorId, categoryId, input = {} } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const id = ensureObjectId(categoryId, 'Knowledge Base category');
    const expectedVersion = normalizeHelpdeskKbExpectedVersion(input.expectedVersion);
    const { expectedVersion: _ignored, ...categoryInput } = input;
    const patch = normalizeHelpdeskKbCategoryInput(categoryInput);
    try {
      const updated = await CategoryModel.findOneAndUpdate(
        { _id: id, companyId, archivedAt: null, version: expectedVersion },
        { $set: { ...patch, updatedBy: actorId }, $inc: { version: 1 } },
        { returnDocument: 'after', runValidators: true },
      );
      if (!updated) {
        const exists = await queryOne(CategoryModel.findOne({ _id: id, companyId }), { projection: '_id version archivedAt' });
        if (!exists) throw ApiError.notFound('Knowledge Base category not found.');
        throw ApiError.conflict('The Knowledge Base category changed. Refresh and try again.');
      }
      return categoryDto(plain(updated));
    } catch (error) {
      if (error?.statusCode) throw error;
      if (duplicateKey(error)) throw ApiError.conflict('A Knowledge Base category with that name already exists.');
      throw unavailable('The Knowledge Base category could not be updated.');
    }
  };

  const archiveCategory = async ({ companyId, actorId, categoryId, expectedVersion } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const id = ensureObjectId(categoryId, 'Knowledge Base category');
    const version = normalizeHelpdeskKbExpectedVersion(expectedVersion);
    return transactionRunner(async (session) => {
      const category = await queryOne(
        CategoryModel.findOne({ _id: id, companyId }),
        { projection: '_id companyId version archivedAt', session },
      );
      if (!category) throw ApiError.notFound('Knowledge Base category not found.');
      if (category.archivedAt) throw ApiError.conflict('The Knowledge Base category is already archived.');
      if (Number(category.version) !== version) {
        throw ApiError.conflict('The Knowledge Base category changed. Refresh and try again.');
      }
      const activeReference = await queryOne(
        ArticleModel.findOne({
          companyId,
          status: { $in: ['draft', 'published'] },
          $or: [
            { 'draftContent.categoryId': id },
            { 'publishedContent.categoryId': id },
          ],
        }),
        { projection: '_id', session },
      );
      if (activeReference) {
        throw ApiError.conflict('Move or archive articles using this category before archiving the category.');
      }
      const archivedAt = new Date(now());
      if (Number.isNaN(archivedAt.getTime())) throw unavailable('A trusted Knowledge Base timestamp is unavailable.');
      const updated = await CategoryModel.findOneAndUpdate(
        { _id: id, companyId, archivedAt: null, version },
        {
          $set: { archivedAt, archivedBy: actorId, updatedBy: actorId },
          $inc: { version: 1, publicationFenceVersion: 1 },
        },
        { returnDocument: 'after', runValidators: true, session },
      );
      if (!updated) throw ApiError.conflict('The Knowledge Base category changed. Refresh and try again.');
      return categoryDto(plain(updated));
    });
  };

  const updateArticleDraft = async ({ companyId, actorId, articleId, input = {} } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const id = ensureObjectId(articleId, 'Knowledge Base article');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw ApiError.badRequest('Article details must be an object.');
    const expectedVersion = normalizeHelpdeskKbExpectedVersion(input.expectedVersion);
    const contentInput = { ...input };
    delete contentInput.expectedVersion;
    return transactionRunner(async (session) => {
      const article = await queryOne(
        ArticleModel.findOne({ _id: id, companyId }),
        { projection: '-publishedContent.searchTokens -draftContent.searchTokens', session },
      );
      if (!article) throw ApiError.notFound('Knowledge Base article not found.');
      if (article.status === 'archived') throw ApiError.conflict('Archived articles cannot be edited.');
      if (Number(article.version) !== expectedVersion) {
        throw ApiError.conflict('The Knowledge Base article changed. Refresh and try again.');
      }
      const base = article.draftContent || article.publishedContent;
      if (!base) throw ApiError.conflict('The Knowledge Base article has no editable content.');
      const content = await normalizeContent({
        companyId,
        input: contentInput,
        base,
        articleId: id,
        session,
      });
      await lockArticleCategories({
        companyId,
        categoryIds: [base.categoryId, content.categoryId],
        session,
      });
      const draftRevision = (article.draftContent
        ? Number(article.draftRevision) || 0
        : Number(article.publishedRevision) || 0) + 1;
      const updated = await ArticleModel.findOneAndUpdate(
        { _id: id, companyId, status: { $in: ['draft', 'published'] }, version: expectedVersion },
        {
          $set: { draftContent: content, draftRevision, lastEditorId: actorId },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', runValidators: true, session },
      );
      if (!updated) throw ApiError.conflict('The Knowledge Base article changed. Refresh and try again.');
      return adminArticleDetailsDto(plain(updated));
    });
  };

  const publishArticle = async ({ companyId, actorId, articleId, expectedVersion } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const id = ensureObjectId(articleId, 'Knowledge Base article');
    const version = normalizeHelpdeskKbExpectedVersion(expectedVersion);
    return transactionRunner(async (session) => {
      const article = await queryOne(
        ArticleModel.findOne({ _id: id, companyId }),
        { projection: '-publishedContent.searchTokens -draftContent.searchTokens', session },
      );
      if (!article) throw ApiError.notFound('Knowledge Base article not found.');
      if (article.status === 'archived') throw ApiError.conflict('Archived articles cannot be published.');
      if (Number(article.version) !== version) {
        throw ApiError.conflict('The Knowledge Base article changed. Refresh and try again.');
      }
      if (!article.draftContent) throw ApiError.conflict('There is no unpublished article revision to publish.');
      const draftInput = {
        title: article.draftContent.title,
        summary: article.draftContent.summary,
        body: article.draftContent.body,
        categoryId: idString(article.draftContent.categoryId),
        relatedQueueId: idString(article.draftContent.relatedQueueId) || null,
        visibility: article.draftContent.visibility,
        relatedArticleIds: (article.draftContent.relatedArticleIds || []).map(idString),
      };
      const content = await normalizeContent({
        companyId,
        input: draftInput,
        creating: true,
        articleId: id,
        session,
      });
      const searchTokens = buildHelpdeskKbSearchTokens(content);
      const publishedAt = new Date(now());
      if (Number.isNaN(publishedAt.getTime())) throw unavailable('A trusted Knowledge Base timestamp is unavailable.');
      const revisionNumber = (Number(article.publishedRevision) || 0) + 1;
      const sourceDraftRevision = Number(article.draftRevision) || 1;
      const categoryLock = await CategoryModel.updateOne(
        { _id: content.categoryId, companyId, archivedAt: null },
        { $inc: { publicationFenceVersion: 1 } },
        { session },
      );
      const categoryMatches = Number.isInteger(categoryLock?.matchedCount)
        ? categoryLock.matchedCount
        : categoryLock?.n;
      if (!categoryLock || categoryLock.acknowledged === false || categoryMatches !== 1) {
        throw ApiError.conflict('The article category was archived or changed before publication.');
      }
      await RevisionModel.create([{
        companyId,
        articleId: id,
        revision: revisionNumber,
        sourceDraftRevision,
        content,
        publishedAt,
        publishedBy: actorId,
      }], { session });
      const updated = await ArticleModel.findOneAndUpdate(
        { _id: id, companyId, version, status: { $in: ['draft', 'published'] } },
        {
          $set: {
            status: 'published',
            publishedContent: { ...content, searchTokens },
            publishedAt,
            publishedBy: actorId,
            publishedRevision: revisionNumber,
            draftRevision: revisionNumber,
            draftContent: null,
            lastEditorId: actorId,
            archivedAt: null,
            archivedBy: null,
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', runValidators: true, session },
      );
      if (!updated) throw ApiError.conflict('The Knowledge Base article changed. Refresh and try again.');
      return adminArticleDetailsDto(plain(updated));
    });
  };

  const archiveArticle = async ({ companyId, actorId, articleId, expectedVersion } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const id = ensureObjectId(articleId, 'Knowledge Base article');
    const version = normalizeHelpdeskKbExpectedVersion(expectedVersion);
    const archivedAt = new Date(now());
    if (Number.isNaN(archivedAt.getTime())) throw unavailable('A trusted Knowledge Base timestamp is unavailable.');
    const updated = await ArticleModel.findOneAndUpdate(
      { _id: id, companyId, status: { $in: ['draft', 'published'] }, version },
      {
        $set: { status: 'archived', archivedAt, archivedBy: actorId, lastEditorId: actorId },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', runValidators: true },
    );
    if (!updated) {
      const exists = await queryOne(ArticleModel.findOne({ _id: id, companyId }), { projection: '_id status version' });
      if (!exists) throw ApiError.notFound('Knowledge Base article not found.');
      throw ApiError.conflict('The Knowledge Base article changed or is already archived.');
    }
    return adminArticleDetailsDto(plain(updated));
  };

  const getTicketArticleReferences = async ({ companyId, ticketQueueId, articleIds, session = null } = {}) => {
    ensureCompanyId(companyId);
    const ids = normalizeHelpdeskKbRelatedArticleIds(articleIds, {
      maximum: HELPDESK_KB_MESSAGE_ARTICLES_MAX,
      field: 'relatedArticleIds',
    });
    if (!ids.length) return [];
    const queueId = normalizeHelpdeskKbId(ticketQueueId, 'ticket queueId');
    const rows = await queryMany(
      ArticleModel.find({
        companyId,
        _id: { $in: ids },
        status: 'published',
        archivedAt: null,
        'publishedContent.visibility': 'employees',
        $or: [
          { 'publishedContent.relatedQueueId': null },
          { 'publishedContent.relatedQueueId': queueId },
        ],
      }),
      { projection: '_id slug publishedContent.title publishedContent.summary', session },
    );
    const found = new Set((rows || []).map((row) => idString(row._id).toLowerCase()));
    if (found.size !== ids.length || ids.some((id) => !found.has(id.toLowerCase()))) {
      throw ApiError.badRequest('One or more linked Knowledge Base articles are unavailable.');
    }
    return ids;
  };

  const listTicketArticleReferences = async ({ companyId, ticketQueueId, articleIds } = {}) => {
    ensureCompanyId(companyId);
    const ids = normalizeHelpdeskKbRelatedArticleIds(articleIds, {
      maximum: HELPDESK_KB_TICKET_HISTORY_REFERENCES_MAX,
      field: 'relatedArticleIds',
    });
    if (!ids.length) return [];
    const queueId = normalizeHelpdeskKbId(ticketQueueId, 'ticket queueId');
    const rows = await queryMany(
      ArticleModel.find({
        companyId,
        _id: { $in: ids },
        status: 'published',
        archivedAt: null,
        'publishedContent.visibility': 'employees',
        $or: [
          { 'publishedContent.relatedQueueId': null },
          { 'publishedContent.relatedQueueId': queueId },
        ],
      }),
      { projection: '_id slug publishedContent.title publishedContent.summary' },
    );
    const byId = new Map((rows || []).map((row) => [idString(row._id).toLowerCase(), employeeArticleLinkDto(row)]));
    return ids.map((id) => byId.get(id.toLowerCase())).filter(Boolean);
  };

  return {
    createArticleDraft,
    getAdminArticle,
    listAdminArticleRevisions,
    getAdminArticleRevision,
    restoreArticleRevisionToDraft,
    listAdminArticles,
    searchArticles,
    listEmployeeCategories,
    getEmployeeArticleBySlug,
    listAdminCategories,
    createCategory,
    updateCategory,
    archiveCategory,
    updateArticleDraft,
    publishArticle,
    archiveArticle,
    getTicketArticleReferences,
    listTicketArticleReferences,
  };
};
