import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { hasPermission } from '../utils/permissionService.js';
import { assertNoClientIdentity } from '../services/helpdesk/helpdeskRules.js';
import { helpdeskKnowledgeBaseService } from '../services/helpdesk/helpdeskKnowledgeBaseService.js';

const knowledgeBaseService = helpdeskKnowledgeBaseService();

const success = (res, data, status = 200, message = 'Knowledge Base request completed', meta = null) =>
  res.status(status).json({
    success: true,
    message,
    data,
    ...(meta ? { meta } : {}),
  });

const assertKnowledgeBasePermission = async (user, permission) => {
  if (!user || !(await hasPermission(user, permission))) {
    throw ApiError.forbidden('You do not have permission to use this Knowledge Base operation.');
  }
};

const assertBodyFields = (body = {}, allowed = []) => {
  assertNoClientIdentity(body);
  const unsupported = Object.keys(body).find((field) => !allowed.includes(field));
  if (unsupported) throw ApiError.badRequest(`Unsupported Knowledge Base field: ${unsupported}`);
};

// GET /api/helpdesk/knowledge-base/categories
export const listEmployeeCategories = asyncHandler(async (req, res) => {
  // Data from frontend - the tenant and viewer come only from authenticated middleware; query filters are not accepted here.
  const companyId = req.companyId;
  const viewerId = req.user._id;
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_READ');
  const canReadQueue = await hasPermission(req.user, 'HELPDESK_TICKET_READ');
  // DB Logic - the service re-reads current queue memberships and filters categories to currently published visible articles.
  const categories = await knowledgeBaseService.listEmployeeCategories({ companyId, viewerId, canReadQueue });
  // Data to frontend - only category names/descriptions with at least one readable published article are returned.
  return success(res, categories, 200, 'Knowledge Base categories');
});

// GET /api/helpdesk/knowledge-base/articles
export const searchEmployeeArticles = asyncHandler(async (req, res) => {
  // Data from frontend - bounded search, category, queue and cursor filters; tenant and viewer are middleware-derived.
  const companyId = req.companyId;
  const viewerId = req.user._id;
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_READ');
  const canReadQueue = await hasPermission(req.user, 'HELPDESK_TICKET_READ');
  // DB Logic - audience predicates are applied before indexed token search and before any result DTO is constructed.
  const result = await knowledgeBaseService.searchArticles({
    companyId,
    viewerId,
    canReadQueue,
    query: req.query,
  });
  // Data to frontend - snippets are limited to authorized published summaries; raw query/body data is never logged.
  return success(res, result.articles, 200, 'Knowledge Base search results', result.meta);
});

// GET /api/helpdesk/knowledge-base/articles/:slug
export const getEmployeeArticle = asyncHandler(async (req, res) => {
  // Data from frontend - a stable slug selects an article; it is never an authorization identity.
  const companyId = req.companyId;
  const viewerId = req.user._id;
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_READ');
  const canReadQueue = await hasPermission(req.user, 'HELPDESK_TICKET_READ');
  // DB Logic - the service reauthorizes the published audience and current queue/confidential-agent membership at detail time.
  const article = await knowledgeBaseService.getEmployeeArticleBySlug({
    companyId,
    viewerId,
    canReadQueue,
    slug: req.params.slug,
  });
  // Data to frontend - plain-text published content only; drafts, staff metadata and search tokens are excluded.
  return success(res, article, 200, 'Knowledge Base article');
});

// GET /api/helpdesk/admin/knowledge-base/categories
export const listAdminCategories = asyncHandler(async (req, res) => {
  // Data from frontend - no query/body-supplied tenant or actor identifiers are accepted.
  const companyId = req.companyId;
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - category administration is tenant-scoped and returns allowlisted category metadata.
  const categories = await knowledgeBaseService.listAdminCategories({ companyId });
  // Data to frontend - no article body or private user profile fields are exposed.
  return success(res, categories, 200, 'Knowledge Base categories');
});

// POST /api/helpdesk/admin/knowledge-base/categories
export const createCategory = asyncHandler(async (req, res) => {
  // Data from frontend - a strict category allowlist is validated; tenant and author are middleware-derived.
  const companyId = req.companyId;
  const actorId = req.user._id;
  assertBodyFields(req.body || {}, ['name', 'slug', 'description', 'sortOrder']);
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - the service enforces tenant-unique slug/name indexes and writes an explicit audit action.
  const category = await knowledgeBaseService.createCategory({ companyId, actorId, input: req.body || {} });
  req.helpdeskAuditAction = 'Created a Helpdesk Knowledge Base category';
  // Data to frontend - only the new category DTO is returned.
  return success(res, category, 201, 'Knowledge Base category created');
});

// PATCH /api/helpdesk/admin/knowledge-base/categories/:categoryId
export const updateCategory = asyncHandler(async (req, res) => {
  // Data from frontend - expectedVersion enables compare-and-swap; category/tenant identity is never accepted from the body.
  const companyId = req.companyId;
  const actorId = req.user._id;
  assertBodyFields(req.body || {}, ['expectedVersion', 'name', 'description', 'sortOrder']);
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - a tenant-scoped optimistic update preserves stable category slugs and the publication/archive serialization fence.
  const category = await knowledgeBaseService.updateCategory({
    companyId,
    actorId,
    categoryId: req.params.categoryId,
    input: req.body || {},
  });
  req.helpdeskAuditAction = 'Updated a Helpdesk Knowledge Base category';
  // Data to frontend - only the updated category DTO is returned.
  return success(res, category, 200, 'Knowledge Base category updated');
});

// POST /api/helpdesk/admin/knowledge-base/categories/:categoryId/archive
export const archiveCategory = asyncHandler(async (req, res) => {
  // Data from frontend - only the expected version is accepted; identity and tenant come from middleware.
  const companyId = req.companyId;
  const actorId = req.user._id;
  assertBodyFields(req.body || {}, ['expectedVersion']);
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - a Mongo transaction rechecks active article references and serializes category archival against draft writes/publication.
  const category = await knowledgeBaseService.archiveCategory({
    companyId,
    actorId,
    categoryId: req.params.categoryId,
    expectedVersion: req.body?.expectedVersion,
  });
  req.helpdeskAuditAction = 'Archived a Helpdesk Knowledge Base category';
  // Data to frontend - only the archived category DTO is returned.
  return success(res, category, 200, 'Knowledge Base category archived');
});

// GET /api/helpdesk/admin/knowledge-base/articles
export const listAdminArticles = asyncHandler(async (req, res) => {
  // Data from frontend - bounded status/category/cursor filters; tenant is derived from authenticated middleware.
  const companyId = req.companyId;
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - the service applies tenant scope before filtering or cursor pagination.
  const result = await knowledgeBaseService.listAdminArticles({ companyId, query: req.query });
  // Data to frontend - only management summary DTOs are returned, never search indexes or unrelated tenant rows.
  return success(res, result.articles, 200, 'Knowledge Base articles', result.meta);
});

// POST /api/helpdesk/admin/knowledge-base/articles
export const createArticleDraft = asyncHandler(async (req, res) => {
  // Data from frontend - a bounded plain-text draft and stable slug are accepted; author and tenant come from middleware.
  const companyId = req.companyId;
  const actorId = req.user._id;
  assertBodyFields(req.body || {}, ['slug', 'title', 'summary', 'body', 'categoryId', 'relatedQueueId', 'visibility', 'relatedArticleIds']);
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - the service validates tenant-scoped references, locks the active category and creates the draft transactionally.
  const article = await knowledgeBaseService.createArticleDraft({ companyId, actorId, input: req.body || {} });
  req.helpdeskAuditAction = 'Created a Helpdesk Knowledge Base article draft';
  // Data to frontend - the author receives an allowlisted draft DTO, not tokens or storage/provider metadata.
  return success(res, article, 201, 'Knowledge Base article draft created');
});

// GET /api/helpdesk/admin/knowledge-base/articles/:articleId
export const getAdminArticle = asyncHandler(async (req, res) => {
  // Data from frontend - a validated article id selects a tenant-scoped admin record.
  const companyId = req.companyId;
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - an administrative permission is required before draft or publication metadata is loaded.
  const article = await knowledgeBaseService.getAdminArticle({ companyId, articleId: req.params.articleId });
  // Data to frontend - both current draft and published revision are returned only to authorized Knowledge Base managers.
  return success(res, article, 200, 'Knowledge Base article details');
});

// GET /api/helpdesk/admin/knowledge-base/articles/:articleId/revisions
export const listAdminArticleRevisions = asyncHandler(async (req, res) => {
  // Data from frontend - a tenant-scoped article id and bounded cursor/limit select immutable publication history.
  const companyId = req.companyId;
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - the service verifies the parent article in this tenant before reading revision documents.
  const result = await knowledgeBaseService.listAdminArticleRevisions({
    companyId,
    articleId: req.params.articleId,
    query: req.query,
  });
  // Data to frontend - history listing contains revision summaries only; full content is available through the authorized detail route.
  return success(res, result.revisions, 200, 'Knowledge Base article revisions', result.meta);
});

// GET /api/helpdesk/admin/knowledge-base/articles/:articleId/revisions/:revision
export const getAdminArticleRevision = asyncHandler(async (req, res) => {
  // Data from frontend - the article id and positive revision number are selectors, not tenant/author identities.
  const companyId = req.companyId;
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - parent and immutable revision reads are both scoped by the authenticated tenant.
  const revision = await knowledgeBaseService.getAdminArticleRevision({
    companyId,
    articleId: req.params.articleId,
    revision: req.params.revision,
  });
  // Data to frontend - only an authorized manager receives the immutable plain-text snapshot.
  return success(res, revision, 200, 'Knowledge Base article revision');
});

// POST /api/helpdesk/admin/knowledge-base/articles/:articleId/revisions/:revision/restore
export const restoreArticleRevision = asyncHandler(async (req, res) => {
  // Data from frontend - a published revision plus expectedVersion selects a restore source; tenant and actor remain middleware-derived.
  const companyId = req.companyId;
  const actorId = req.user._id;
  assertBodyFields(req.body || {}, ['expectedVersion']);
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - the service revalidates old references and creates a new draft transactionally without changing the current publication.
  const article = await knowledgeBaseService.restoreArticleRevisionToDraft({
    companyId,
    actorId,
    articleId: req.params.articleId,
    revision: req.params.revision,
    expectedVersion: req.body?.expectedVersion,
  });
  req.helpdeskAuditAction = 'Restored a Helpdesk Knowledge Base revision to draft';
  // Data to frontend - the new draft and untouched published snapshot are returned with their CAS version numbers.
  return success(res, article, 200, 'Knowledge Base revision restored to draft');
});

// PATCH /api/helpdesk/admin/knowledge-base/articles/:articleId
export const updateArticleDraft = asyncHandler(async (req, res) => {
  // Data from frontend - a strict partial content patch plus expectedVersion; identities remain server-derived.
  const companyId = req.companyId;
  const actorId = req.user._id;
  assertBodyFields(req.body || {}, ['expectedVersion', 'title', 'summary', 'body', 'categoryId', 'relatedQueueId', 'visibility', 'relatedArticleIds']);
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - transactionally re-read the draft, validate references, CAS the revision and serialize against category archival.
  const article = await knowledgeBaseService.updateArticleDraft({
    companyId,
    actorId,
    articleId: req.params.articleId,
    input: req.body || {},
  });
  req.helpdeskAuditAction = 'Updated a Helpdesk Knowledge Base article draft';
  // Data to frontend - the allowlisted result includes current version numbers for the next CAS operation.
  return success(res, article, 200, 'Knowledge Base article draft updated');
});

// POST /api/helpdesk/admin/knowledge-base/articles/:articleId/publish
export const publishArticle = asyncHandler(async (req, res) => {
  // Data from frontend - only expectedVersion is accepted; both management and publication grants are mandatory.
  const companyId = req.companyId;
  const actorId = req.user._id;
  assertBodyFields(req.body || {}, ['expectedVersion']);
  await Promise.all([
    assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE'),
    assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_PUBLISH'),
  ]);
  // DB Logic - a transaction revalidates category/queue/article references, builds the token index and atomically swaps the published revision.
  const article = await knowledgeBaseService.publishArticle({
    companyId,
    actorId,
    articleId: req.params.articleId,
    expectedVersion: req.body?.expectedVersion,
  });
  req.helpdeskAuditAction = 'Published a Helpdesk Knowledge Base article';
  // Data to frontend - publication returns the new version; employee reads still reauthorize visibility at request time.
  return success(res, article, 200, 'Knowledge Base article published');
});

// POST /api/helpdesk/admin/knowledge-base/articles/:articleId/archive
export const archiveArticle = asyncHandler(async (req, res) => {
  // Data from frontend - only expectedVersion is accepted; archive authority uses the authenticated actor and tenant.
  const companyId = req.companyId;
  const actorId = req.user._id;
  assertBodyFields(req.body || {}, ['expectedVersion']);
  await assertKnowledgeBasePermission(req.user, 'HELPDESK_KB_MANAGE');
  // DB Logic - a tenant-scoped compare-and-swap immediately removes the article from search/detail/ticket-link reads.
  const article = await knowledgeBaseService.archiveArticle({
    companyId,
    actorId,
    articleId: req.params.articleId,
    expectedVersion: req.body?.expectedVersion,
  });
  req.helpdeskAuditAction = 'Archived a Helpdesk Knowledge Base article';
  // Data to frontend - only the archived article DTO is returned.
  return success(res, article, 200, 'Knowledge Base article archived');
});

export default {
  listEmployeeCategories,
  searchEmployeeArticles,
  getEmployeeArticle,
  listAdminCategories,
  createCategory,
  updateCategory,
  archiveCategory,
  listAdminArticles,
  createArticleDraft,
  getAdminArticle,
  listAdminArticleRevisions,
  getAdminArticleRevision,
  restoreArticleRevision,
  updateArticleDraft,
  publishArticle,
  archiveArticle,
};
