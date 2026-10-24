import ApiError from '../../utils/ApiError.js';
import { hasVisibleText } from '../../utils/chatTextRules.js';

export const HELPDESK_KB_STATUSES = Object.freeze(['draft', 'published', 'archived']);
export const HELPDESK_KB_VISIBILITIES = Object.freeze([
  'employees',
  'queue_staff',
  'confidential_queue_staff',
]);
export const HELPDESK_KB_TITLE_MAX = 120;
export const HELPDESK_KB_SUMMARY_MAX = 500;
export const HELPDESK_KB_BODY_MAX = 5000;
export const HELPDESK_KB_CATEGORY_NAME_MAX = 80;
export const HELPDESK_KB_DESCRIPTION_MAX = 300;
export const HELPDESK_KB_RELATED_ARTICLES_MAX = 10;
export const HELPDESK_KB_MESSAGE_ARTICLES_MAX = 5;
export const HELPDESK_KB_TICKET_HISTORY_REFERENCES_MAX = 250;
export const HELPDESK_KB_SEARCH_MAX = 80;
export const HELPDESK_KB_SEARCH_TERMS_MAX = 8;
export const HELPDESK_KB_INDEX_TOKEN_MAX = 3000;
export const HELPDESK_KB_SEARCH_DEFAULT_LIMIT = 20;
export const HELPDESK_KB_SEARCH_MAX_LIMIT = 50;
export const HELPDESK_KB_CURSOR_MAX = 256;
export const HELPDESK_KB_MAX_SORT_ORDER = 10_000;

const OBJECT_ID = /^[a-f\d]{24}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTENT_FIELDS = Object.freeze([
  'title',
  'summary',
  'body',
  'categoryId',
  'relatedQueueId',
  'visibility',
  'relatedArticleIds',
]);
const INVISIBLE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u2028-\u202F\u205F-\u206F\u3164\uFE0E\uFE0F\uFEFF\uFFA0]/g;
const HTML_TAG = /<\/?[A-Za-z][^>]*>/g;

export const normalizeHelpdeskKbPlainText = (
  value,
  { field, maximum, required = false, collapseWhitespace = false } = {},
) => {
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be plain text.`);
  let normalized = value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(HTML_TAG, '')
    // Preserve literal comparison/code characters without emitting HTML delimiters.
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(INVISIBLE_CONTROLS, '');
  if (collapseWhitespace) normalized = normalized.replace(/\s+/g, ' ');
  normalized = normalized.trim();
  if (required && !hasVisibleText(normalized)) {
    throw ApiError.badRequest(`${field} is required.`);
  }
  if (normalized.length > maximum) {
    throw ApiError.badRequest(`${field} must be ${maximum} characters or fewer.`);
  }
  return normalized;
};

export const normalizeHelpdeskKbSlug = (value, field = 'slug') => {
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a string.`);
  const slug = value.trim().toLowerCase();
  if (slug.length < 2 || slug.length > 120 || !SLUG.test(slug)) {
    throw ApiError.badRequest(`${field} must be a URL-safe slug of 2–120 lowercase letters, digits, or hyphens.`);
  }
  return slug;
};

export const normalizeHelpdeskKbId = (value, field) => {
  const id = String(value ?? '').trim();
  if (!OBJECT_ID.test(id)) throw ApiError.badRequest(`${field} must be a valid identifier.`);
  return id;
};

export const normalizeHelpdeskKbRelatedArticleIds = (
  value,
  { maximum = HELPDESK_KB_RELATED_ARTICLES_MAX, field = 'relatedArticleIds' } = {},
) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw ApiError.badRequest(`${field} must be an array of at most ${maximum} article ids.`);
  }
  const ids = value.map((item) => normalizeHelpdeskKbId(item, field));
  if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
    throw ApiError.badRequest(`${field} must not contain duplicate ids.`);
  }
  return ids;
};

const normalizeCategoryId = (value) => normalizeHelpdeskKbId(value, 'categoryId');

const normalizeQueueId = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return normalizeHelpdeskKbId(value, 'relatedQueueId');
};

const normalizeVisibility = (value) => {
  if (typeof value !== 'string') throw ApiError.badRequest('visibility is required and must be supported.');
  const visibility = value.trim().toLowerCase();
  if (!HELPDESK_KB_VISIBILITIES.includes(visibility)) {
    throw ApiError.badRequest('visibility is not supported.');
  }
  return visibility;
};

export const normalizeHelpdeskKbArticleContent = (
  input = {},
  { base = null, creating = false } = {},
) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw ApiError.badRequest('Article details must be an object.');
  }
  const unknown = Object.keys(input).find((key) => !CONTENT_FIELDS.includes(key));
  if (unknown) throw ApiError.badRequest(`Unsupported article field: ${unknown}`);
  if (creating && ['title', 'body', 'categoryId', 'visibility'].some((field) => input[field] === undefined)) {
    throw ApiError.badRequest('title, body, categoryId, and visibility are required.');
  }
  if (!creating && !Object.keys(input).length) {
    throw ApiError.badRequest('Supply at least one article field.');
  }

  const current = base || {};
  const title = input.title === undefined
    ? current.title
    : normalizeHelpdeskKbPlainText(input.title, {
        field: 'title',
        maximum: HELPDESK_KB_TITLE_MAX,
        required: true,
        collapseWhitespace: true,
      });
  const summary = input.summary === undefined
    ? String(current.summary || '')
    : normalizeHelpdeskKbPlainText(input.summary, {
        field: 'summary',
        maximum: HELPDESK_KB_SUMMARY_MAX,
      });
  const body = input.body === undefined
    ? current.body
    : normalizeHelpdeskKbPlainText(input.body, {
        field: 'body',
        maximum: HELPDESK_KB_BODY_MAX,
        required: true,
      });
  const categoryId = input.categoryId === undefined
    ? (current.categoryId ? normalizeCategoryId(String(current.categoryId?._id || current.categoryId)) : null)
    : normalizeCategoryId(input.categoryId);
  const relatedQueueId = input.relatedQueueId === undefined
    ? (current.relatedQueueId ? String(current.relatedQueueId) : null)
    : normalizeQueueId(input.relatedQueueId);
  const visibility = input.visibility === undefined
    ? current.visibility
    : normalizeVisibility(input.visibility);
  const relatedArticleIds = input.relatedArticleIds === undefined
    ? (current.relatedArticleIds || []).map((id) => String(id?._id || id))
    : normalizeHelpdeskKbRelatedArticleIds(input.relatedArticleIds);

  if (!hasVisibleText(title)) throw ApiError.badRequest('title is required.');
  if (!hasVisibleText(body)) throw ApiError.badRequest('body is required.');
  if (!categoryId || !visibility) {
    throw ApiError.badRequest('categoryId and visibility are required.');
  }
  if (visibility !== 'employees' && !relatedQueueId) {
    throw ApiError.badRequest('Queue-restricted articles require relatedQueueId.');
  }

  return {
    title,
    summary,
    body,
    categoryId,
    relatedQueueId,
    visibility,
    relatedArticleIds,
  };
};

const tokenList = (value) => {
  const tokens = String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]{2,40}/gu) || [];
  return [...new Set(tokens)];
};

export const buildHelpdeskKbSearchTokens = (content = {}) => {
  const tokens = tokenList(`${content.title || ''} ${content.summary || ''} ${content.body || ''}`);
  if (tokens.length > HELPDESK_KB_INDEX_TOKEN_MAX) {
    throw ApiError.badRequest('Article contains too many distinct searchable terms.');
  }
  return tokens.sort((left, right) => left.localeCompare(right, 'en-US'));
};

export const normalizeHelpdeskKbSearch = (query = {}) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw ApiError.badRequest('Knowledge Base filters must be an object.');
  }
  const allowed = ['search', 'categoryId', 'queueId', 'cursor', 'limit'];
  const unsupported = Object.keys(query).find((key) => !allowed.includes(key));
  if (unsupported) throw ApiError.badRequest(`Unsupported Knowledge Base filter: ${unsupported}`);

  let search = '';
  let terms = [];
  if (query.search !== undefined) {
    if (typeof query.search !== 'string') throw ApiError.badRequest('search must be a string.');
    search = query.search.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (search.length < 2 || search.length > HELPDESK_KB_SEARCH_MAX) {
      throw ApiError.badRequest(`search must be 2–${HELPDESK_KB_SEARCH_MAX} characters.`);
    }
    terms = tokenList(search);
    if (!terms.length || terms.length > HELPDESK_KB_SEARCH_TERMS_MAX) {
      throw ApiError.badRequest(`search must contain between 1 and ${HELPDESK_KB_SEARCH_TERMS_MAX} searchable terms.`);
    }
  }

  const categoryId = query.categoryId === undefined
    ? null
    : normalizeHelpdeskKbId(query.categoryId, 'categoryId');
  const queueId = query.queueId === undefined
    ? null
    : normalizeHelpdeskKbId(query.queueId, 'queueId');
  const limit = parseBoundedInteger(
    query.limit,
    'limit',
    HELPDESK_KB_SEARCH_DEFAULT_LIMIT,
    HELPDESK_KB_SEARCH_MAX_LIMIT,
  );
  const cursor = decodeHelpdeskKbCursor(query.cursor);

  return { search, terms, categoryId, queueId, cursor, limit };
};

const parseBoundedInteger = (value, field, fallback, maximum) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  const normalized = String(value).trim();
  if (!/^[0-9]+$/.test(normalized)) throw ApiError.badRequest(`${field} must be a positive integer.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw ApiError.badRequest(`${field} must be between 1 and ${maximum}.`);
  }
  return parsed;
};

export const encodeHelpdeskKbCursor = ({ at, id } = {}) => {
  const date = at instanceof Date ? at : new Date(at);
  const normalizedId = String(id || '');
  if (Number.isNaN(date.getTime()) || !OBJECT_ID.test(normalizedId)) {
    throw new ApiError(500, 'Cannot encode an invalid Knowledge Base cursor.');
  }
  return Buffer.from(JSON.stringify({ v: 1, at: date.toISOString(), id: normalizedId }), 'utf8').toString('base64url');
};

export const decodeHelpdeskKbCursor = (cursor) => {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > HELPDESK_KB_CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw ApiError.badRequest('Knowledge Base cursor is invalid.');
  }
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const value = JSON.parse(decoded);
    const date = new Date(value?.at);
    if (
      Buffer.from(decoded, 'utf8').toString('base64url') !== cursor
      || !value
      || value.v !== 1
      || Number.isNaN(date.getTime())
      || !OBJECT_ID.test(String(value.id || ''))
      || Object.keys(value).sort().join(',') !== 'at,id,v'
    ) {
      throw new Error('invalid cursor');
    }
    return { at: date, id: String(value.id) };
  } catch {
    throw ApiError.badRequest('Knowledge Base cursor is invalid.');
  }
};

export const normalizeHelpdeskKbCategoryInput = (input = {}, { creating = false } = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw ApiError.badRequest('Category details must be an object.');
  }
  const allowed = creating
    ? ['name', 'slug', 'description', 'sortOrder']
    : ['name', 'description', 'sortOrder'];
  const unsupported = Object.keys(input).find((key) => !allowed.includes(key));
  if (unsupported) throw ApiError.badRequest(`Unsupported category field: ${unsupported}`);
  if (creating && (input.name === undefined || input.slug === undefined)) {
    throw ApiError.badRequest('name and slug are required.');
  }
  if (!creating && !Object.keys(input).length) {
    throw ApiError.badRequest('Supply at least one category setting.');
  }

  const patch = {};
  if (input.name !== undefined) {
    patch.name = normalizeHelpdeskKbPlainText(input.name, {
      field: 'name',
      maximum: HELPDESK_KB_CATEGORY_NAME_MAX,
      required: true,
      collapseWhitespace: true,
    });
    if (patch.name.length < 2) throw ApiError.badRequest('Category name must be at least 2 characters.');
    patch.nameKey = patch.name.toLocaleLowerCase('en-US');
  }
  if (creating) {
    patch.slug = normalizeHelpdeskKbSlug(input.slug, 'slug');
    patch.slugKey = patch.slug;
  }
  if (input.description !== undefined || creating) {
    patch.description = normalizeHelpdeskKbPlainText(input.description ?? '', {
      field: 'description',
      maximum: HELPDESK_KB_DESCRIPTION_MAX,
    });
  }
  if (input.sortOrder !== undefined || creating) {
    const sortOrder = input.sortOrder === undefined ? 0 : input.sortOrder;
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > HELPDESK_KB_MAX_SORT_ORDER) {
      throw ApiError.badRequest(`sortOrder must be an integer from 0 to ${HELPDESK_KB_MAX_SORT_ORDER}.`);
    }
    patch.sortOrder = sortOrder;
  }
  return patch;
};

export const normalizeHelpdeskKbRevisionListQuery = (query = {}) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw ApiError.badRequest('Knowledge Base revision filters must be an object.');
  }
  const unsupported = Object.keys(query).find((key) => !['cursor', 'limit'].includes(key));
  if (unsupported) throw ApiError.badRequest(`Unsupported Knowledge Base revision filter: ${unsupported}`);
  return {
    cursor: decodeHelpdeskKbCursor(query.cursor),
    limit: parseBoundedInteger(query.limit, 'limit', HELPDESK_KB_SEARCH_DEFAULT_LIMIT, HELPDESK_KB_SEARCH_MAX_LIMIT),
  };
};

export const normalizeHelpdeskKbRevisionNumber = (value) => {
  const revision = parseBoundedInteger(value, 'revision', 0, 1_000_000_000);
  if (revision < 1) throw ApiError.badRequest('revision must be a positive integer.');
  return revision;
};

export const normalizeHelpdeskKbAdminListQuery = (query = {}) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw ApiError.badRequest('Knowledge Base admin filters must be an object.');
  }
  const allowed = ['status', 'categoryId', 'cursor', 'limit'];
  const unsupported = Object.keys(query).find((key) => !allowed.includes(key));
  if (unsupported) throw ApiError.badRequest(`Unsupported Knowledge Base admin filter: ${unsupported}`);
  const status = query.status === undefined ? null : String(query.status).trim().toLowerCase();
  if (status && !HELPDESK_KB_STATUSES.includes(status)) throw ApiError.badRequest('status is not supported.');
  const categoryId = query.categoryId === undefined ? null : normalizeHelpdeskKbId(query.categoryId, 'categoryId');
  return {
    status,
    categoryId,
    cursor: decodeHelpdeskKbCursor(query.cursor),
    limit: parseBoundedInteger(query.limit, 'limit', HELPDESK_KB_SEARCH_DEFAULT_LIMIT, HELPDESK_KB_SEARCH_MAX_LIMIT),
  };
};

export const normalizeHelpdeskKbExpectedVersion = (value) => {
  const version = parseBoundedInteger(value, 'expectedVersion', 0, 1_000_000_000);
  if (version < 1) throw ApiError.badRequest('expectedVersion must be a positive integer.');
  return version;
};

export const _helpdeskKnowledgeBaseRulesTest = {
  CONTENT_FIELDS,
  HTML_TAG,
  INVISIBLE_CONTROLS,
  OBJECT_ID,
  SLUG,
  parseBoundedInteger,
  tokenList,
};
