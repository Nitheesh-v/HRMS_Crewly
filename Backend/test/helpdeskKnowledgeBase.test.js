import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.REDIS_ENABLED ||= 'false';

const [serviceModule, rulesModule, registryModule, permissionModule, articleModelModule, categoryModelModule, revisionModelModule, messageModelModule, queueModelModule] = await Promise.all([
  import('../src/services/helpdesk/helpdeskKnowledgeBaseService.js'),
  import('../src/services/helpdesk/helpdeskKnowledgeBaseRules.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/utils/permissionService.js'),
  import('../src/models/HelpdeskKnowledgeBaseArticle.js'),
  import('../src/models/HelpdeskKnowledgeBaseCategory.js'),
  import('../src/models/HelpdeskKnowledgeBaseRevision.js'),
  import('../src/models/HelpdeskMessage.js'),
  import('../src/models/HelpdeskQueue.js'),
]);

const { helpdeskKnowledgeBaseService } = serviceModule;
const rules = rulesModule;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registryModule;
const { getSystemPermissionVersion } = permissionModule;
const HelpdeskKnowledgeBaseArticle = articleModelModule.default;
const HelpdeskKnowledgeBaseCategory = categoryModelModule.default;
const HelpdeskKnowledgeBaseRevision = revisionModelModule.default;
const HelpdeskMessage = messageModelModule.default;
const HelpdeskQueue = queueModelModule.default;

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (relative) => fs.readFileSync(path.join(backendRoot, relative), 'utf8');
const oid = (number) => Number(number).toString(16).padStart(24, '0');
const COMPANY_A = oid(100);
const COMPANY_B = oid(200);
const EMPLOYEE = oid(1);
const AGENT = oid(2);
const CONFIDENTIAL_AGENT = oid(3);
const QUEUE_MANAGER = oid(4);
const REVIEWER = oid(5);
const ADMIN = oid(6);
const QUEUE_ID = oid(900);
const FOREIGN_QUEUE_ID = oid(901);

const idOf = (value) => {
  if (value && typeof value === 'object' && value._id !== undefined) return idOf(value._id);
  if (value && typeof value === 'object' && typeof value.toHexString === 'function') return value.toHexString();
  return String(value ?? '');
};
const getPath = (value, dottedPath) => String(dottedPath).split('.').reduce(
  (current, part) => current == null ? undefined : current[part],
  value,
);
const compare = (left, right) => {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : 1;
};
const scalarMatches = (actual, expected) => {
  if (expected === null) return actual === null || actual === undefined;
  if (Array.isArray(actual)) return actual.some((entry) => scalarMatches(entry, expected));
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
  return idOf(actual) === idOf(expected);
};
const matchesValue = (actual, expected) => {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    return Object.entries(expected).every(([operator, operand]) => {
      if (operator === '$in') {
        const values = Array.isArray(actual) ? actual : [actual];
        return values.some((value) => operand.some((candidate) => scalarMatches(value, candidate)));
      }
      if (operator === '$all') {
        const values = Array.isArray(actual) ? actual : [];
        return operand.every((candidate) => values.some((value) => scalarMatches(value, candidate)));
      }
      if (operator === '$ne') return !scalarMatches(actual, operand);
      if (operator === '$lt') return compare(actual, operand) < 0;
      if (operator === '$exists') return operand ? actual !== undefined : actual === undefined;
      if (operator === '$type') return operand === 'date' ? actual instanceof Date : true;
      return false;
    });
  }
  return scalarMatches(actual, expected);
};
const matches = (row, filter = {}) => Object.entries(filter).every(([key, expected]) => {
  if (key === '$and') return expected.every((part) => matches(row, part));
  if (key === '$or') return expected.some((part) => matches(row, part));
  return matchesValue(getPath(row, key), expected);
});
const clone = (value) => {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  const result = {};
  for (const [key, entry] of Object.entries(value)) result[key] = clone(entry);
  return result;
};

const makeQuery = (resolver) => {
  let projection = null;
  let sortSpec = null;
  let limitCount = null;
  let session = null;
  const query = {
    select(value) { projection = value; return query; },
    sort(value) { sortSpec = value; return query; },
    limit(value) { limitCount = value; return query; },
    session(value) { session = value; return query; },
    lean() { return query; },
    then(resolve, reject) {
      return Promise.resolve()
        .then(() => resolver({ projection, sortSpec, limitCount, session }))
        .then((result) => {
          if (Array.isArray(result)) {
            result = [...result];
            if (sortSpec) {
              result.sort((left, right) => {
                for (const [field, direction] of Object.entries(sortSpec)) {
                  const order = compare(getPath(left, field), getPath(right, field));
                  if (order) return order * direction;
                }
                return 0;
              });
            }
            if (Number.isInteger(limitCount)) result = result.slice(0, limitCount);
          }
          return clone(result);
        })
        .then(resolve, reject);
    },
  };
  return query;
};

const setPath = (target, field, value) => {
  const parts = field.split('.');
  let cursor = target;
  while (parts.length > 1) {
    const part = parts.shift();
    cursor[part] ||= {};
    cursor = cursor[part];
  }
  cursor[parts[0]] = clone(value);
};

const makeModel = (label, rows, { clock, idSeed }) => {
  let nextId = idSeed;
  const calls = { find: [], findOne: [], distinct: [], updates: [], creates: [] };
  const model = {
    rows,
    calls,
    find(filter) {
      calls.find.push(clone(filter));
      return makeQuery(() => rows.filter((row) => matches(row, filter)));
    },
    findOne(filter) {
      calls.findOne.push(clone(filter));
      return makeQuery(() => rows.find((row) => matches(row, filter)) || null);
    },
    async distinct(field, filter) {
      calls.distinct.push({ field, filter: clone(filter) });
      return [...new Set(rows
        .filter((row) => matches(row, filter))
        .map((row) => idOf(getPath(row, field)))
        .filter(Boolean))];
    },
    async create(input, options = {}) {
      calls.creates.push({ input: clone(input), hasSession: Boolean(options.session) });
      const inputs = Array.isArray(input) ? input : [input];
      const created = inputs.map((value) => {
        const row = {
          _id: oid(nextId++),
          createdAt: clock(),
          updatedAt: clock(),
          ...clone(value),
        };
        if (label === 'article' && rows.some((existing) =>
          idOf(existing.companyId) === idOf(row.companyId) && existing.slugKey === row.slugKey)) {
          const error = new Error('duplicate article slug');
          error.code = 11000;
          throw error;
        }
        if (label === 'category' && rows.some((existing) =>
          idOf(existing.companyId) === idOf(row.companyId)
          && (existing.slugKey === row.slugKey || existing.nameKey === row.nameKey))) {
          const error = new Error('duplicate category');
          error.code = 11000;
          throw error;
        }
        if (label === 'revision' && rows.some((existing) =>
          idOf(existing.companyId) === idOf(row.companyId)
          && idOf(existing.articleId) === idOf(row.articleId)
          && existing.revision === row.revision)) {
          const error = new Error('duplicate article revision');
          error.code = 11000;
          throw error;
        }
        rows.push(row);
        return clone(row);
      });
      return Array.isArray(input) ? created : created[0];
    },
    findOneAndUpdate(filter, update, options = {}) {
      calls.updates.push({ filter: clone(filter), update: clone(update), hasSession: Boolean(options.session) });
      return makeQuery(() => {
        const row = rows.find((candidate) => matches(candidate, filter));
        if (!row) return null;
        for (const [field, value] of Object.entries(update.$set || {})) setPath(row, field, value);
        for (const [field, value] of Object.entries(update.$inc || {})) {
          setPath(row, field, Number(getPath(row, field) || 0) + Number(value));
        }
        row.updatedAt = clock();
        return row;
      });
    },
    async updateOne(filter, update, options = {}) {
      calls.updates.push({ filter: clone(filter), update: clone(update), hasSession: Boolean(options.session) });
      const row = rows.find((candidate) => matches(candidate, filter));
      if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, n: 0 };
      for (const [field, value] of Object.entries(update.$set || {})) setPath(row, field, value);
      for (const [field, value] of Object.entries(update.$inc || {})) {
        setPath(row, field, Number(getPath(row, field) || 0) + Number(value));
      }
      row.updatedAt = clock();
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, n: 1 };
    },
  };
  return model;
};

const makeWorld = () => {
  let clockMs = Date.parse('2026-10-22T08:00:00.000Z');
  const clock = () => new Date(clockMs += 1000);
  const categoryRows = [];
  const articleRows = [];
  const revisionRows = [];
  const queueRows = [{
    _id: QUEUE_ID,
    companyId: COMPANY_A,
    enabled: true,
    agents: [AGENT, CONFIDENTIAL_AGENT],
    managers: [QUEUE_MANAGER],
    confidentiality: { enabled: true, agentIds: [CONFIDENTIAL_AGENT], reviewerIds: [REVIEWER] },
  }, {
    _id: FOREIGN_QUEUE_ID,
    companyId: COMPANY_B,
    enabled: true,
    agents: [AGENT],
    managers: [],
    confidentiality: { enabled: false, agentIds: [], reviewerIds: [] },
  }];
  const CategoryModel = makeModel('category', categoryRows, { clock, idSeed: 1000 });
  const ArticleModel = makeModel('article', articleRows, { clock, idSeed: 2000 });
  const RevisionModel = makeModel('revision', revisionRows, { clock, idSeed: 2500 });
  const QueueModel = makeModel('queue', queueRows, { clock, idSeed: 3000 });
  const transactionCalls = [];
  const transactionRunner = async (work) => {
    const session = { id: `kb-session-${transactionCalls.length + 1}` };
    transactionCalls.push(session.id);
    return work(session);
  };
  const service = helpdeskKnowledgeBaseService({
    ArticleModel,
    CategoryModel,
    RevisionModel,
    QueueModel,
    transactionRunner,
    now: clock,
  });
  return { service, ArticleModel, CategoryModel, RevisionModel, QueueModel, transactionCalls };
};

const createCategory = (world, { companyId = COMPANY_A, name = 'Access', slug = 'access' } = {}) =>
  world.service.createCategory({
    companyId,
    actorId: ADMIN,
    input: { name, slug, description: 'How-to guidance', sortOrder: 10 },
  });

const createArticle = async (world, {
  companyId = COMPANY_A,
  categoryId,
  slug,
  title,
  summary = '',
  body,
  visibility = 'employees',
  relatedQueueId = null,
  relatedArticleIds = [],
} = {}) => {
  const draft = await world.service.createArticleDraft({
    companyId,
    actorId: ADMIN,
    input: {
      slug,
      title,
      summary,
      body,
      categoryId,
      relatedQueueId,
      visibility,
      relatedArticleIds,
    },
  });
  return world.service.publishArticle({
    companyId,
    actorId: ADMIN,
    articleId: draft.id,
    expectedVersion: draft.version,
  });
};

const statusOf = (expected) => (error) => error?.statusCode === expected;

// ---------------------------------------------------------------------------
// Rules / bounds
// ---------------------------------------------------------------------------

test('Knowledge Base text, slugs, search tokens, cursor and page limits are bounded and plain-text only', () => {
  const body = rules.normalizeHelpdeskKbArticleContent({
    title: '  VPN <b>access</b>  ',
    summary: '  Secure sign-in  ',
    body: '<p>Open the <strong>secure</strong> reset link.</p><script>alert(1)</script>',
    categoryId: oid(1000),
    visibility: 'employees',
  }, { creating: true });
  assert.equal(body.title, 'VPN access');
  assert.equal(body.body, 'Open the secure reset link.alert(1)');
  assert.equal(body.visibility, 'employees');
  assert.deepEqual(rules.buildHelpdeskKbSearchTokens(body), ['access', 'alert', 'in', 'link', 'open', 'reset', 'secure', 'sign', 'the', 'vpn']);
  assert.equal(rules.normalizeHelpdeskKbSlug('VPN-Access'), 'vpn-access');
  assert.equal(rules.normalizeHelpdeskKbSearch({ search: 'VPN reset', limit: '20' }).terms.length, 2);
  assert.throws(() => rules.normalizeHelpdeskKbSearch({ search: '.*' }), statusOf(400));
  assert.throws(() => rules.normalizeHelpdeskKbSearch({ search: 'x'.repeat(81) }), statusOf(400));
  assert.throws(() => rules.normalizeHelpdeskKbSearch({ search: 'vpn', limit: '51' }), statusOf(400));
  assert.throws(() => rules.decodeHelpdeskKbCursor('not-a-cursor'), statusOf(400));
  assert.throws(() => rules.normalizeHelpdeskKbSlug('a/../secret'), statusOf(400));
  assert.equal(rules.normalizeHelpdeskKbRevisionListQuery({ limit: '1' }).limit, 1);
  assert.throws(() => rules.normalizeHelpdeskKbRevisionListQuery({ articleId: oid(1) }), statusOf(400));
  assert.equal(rules.normalizeHelpdeskKbRevisionNumber('9'), 9);
  assert.throws(() => rules.normalizeHelpdeskKbRevisionNumber('0'), statusOf(400));
  assert.throws(() => rules.normalizeHelpdeskKbRevisionNumber('1e2'), statusOf(400));
  assert.throws(() => rules.normalizeHelpdeskKbExpectedVersion(true), statusOf(400));
  assert.throws(() => rules.normalizeHelpdeskKbArticleContent({ title: 'x', body: 'safe', categoryId: oid(1), visibility: 'employees', arbitrary: true }, { creating: true }), statusOf(400));
});

test('tenant-scoped draft publication and employee search return only published summary DTOs', async () => {
  const world = makeWorld();
  const categoryA = await createCategory(world);
  const categoryB = await createCategory(world, { companyId: COMPANY_B, name: 'Other', slug: 'other' });
  const articleA = await createArticle(world, {
    categoryId: categoryA.id,
    slug: 'vpn-reset',
    title: 'VPN reset steps',
    summary: 'Renew your access securely.',
    body: 'Open the reset portal and follow the verification steps.',
  });
  const foreignArticle = await createArticle(world, {
    companyId: COMPANY_B,
    categoryId: categoryB.id,
    slug: 'vpn-reset',
    title: 'Foreign tenant article',
    body: 'Open the reset portal and follow the verification steps.',
  });
  assert.equal(world.RevisionModel.rows.length, 2);
  assert.equal(world.RevisionModel.rows.some((revision) => idOf(revision.articleId) === articleA.id && revision.revision === 1), true);
  const history = await world.service.listAdminArticleRevisions({
    companyId: COMPANY_A,
    articleId: articleA.id,
    query: { limit: '1' },
  });
  assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].revision, 1);
  assert.equal(history.revisions[0].title, 'VPN reset steps');
  const snapshot = await world.service.getAdminArticleRevision({
    companyId: COMPANY_A,
    articleId: articleA.id,
    revision: 1,
  });
  assert.equal(snapshot.content.body, 'Open the reset portal and follow the verification steps.');
  assert.notEqual(snapshot.articleId, foreignArticle.id);
  await assert.rejects(
    () => world.service.getAdminArticleRevision({ companyId: COMPANY_A, articleId: foreignArticle.id, revision: 1 }),
    statusOf(404),
  );

  const results = await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: EMPLOYEE,
    canReadQueue: false,
    query: { search: 'VPN verification' },
  });
  assert.equal(results.articles.length, 1);
  assert.equal(results.articles[0].id, articleA.id);
  assert.equal(results.articles[0].title, 'VPN reset steps');
  assert.equal(results.articles[0].summary, 'Renew your access securely.');
  assert.equal(Object.hasOwn(results.articles[0], 'body'), false);
  assert.equal(Object.hasOwn(results.articles[0], 'companyId'), false);
  assert.equal(world.ArticleModel.calls.find.at(-1).companyId, COMPANY_A);
  assert.equal(world.CategoryModel.calls.updates.every((call) => call.hasSession), true);

  const article = await world.service.getEmployeeArticleBySlug({
    companyId: COMPANY_A,
    viewerId: EMPLOYEE,
    slug: 'vpn-reset',
  });
  assert.equal(article.body, 'Open the reset portal and follow the verification steps.');
  assert.equal(article.category.name, 'Access');
  assert.equal(article.revision, 1);
  const sameSlugOtherTenant = await world.service.getEmployeeArticleBySlug({
    companyId: COMPANY_B,
    viewerId: EMPLOYEE,
    slug: 'vpn-reset',
  });
  assert.equal(sameSlugOtherTenant.title, 'Foreign tenant article');
  assert.notEqual(sameSlugOtherTenant.id, articleA.id);
  const categories = await world.service.listEmployeeCategories({ companyId: COMPANY_A, viewerId: EMPLOYEE });
  assert.deepEqual(categories.map((category) => category.slug), ['access']);
});

test('employee, queue staff, queue managers, and confidential agents receive explicit dynamically reauthorized audiences', async () => {
  const world = makeWorld();
  const category = await createCategory(world);
  const employeeArticle = await createArticle(world, {
    categoryId: category.id,
    slug: 'employee-guide',
    title: 'Employee guide',
    body: 'Standard company account guidance.',
  });
  const staffArticle = await createArticle(world, {
    categoryId: category.id,
    slug: 'queue-playbook',
    title: 'Queue playbook',
    body: 'Agent-only escalation procedure.',
    visibility: 'queue_staff',
    relatedQueueId: QUEUE_ID,
  });
  const confidentialArticle = await createArticle(world, {
    categoryId: category.id,
    slug: 'confidential-handling',
    title: 'Confidential handling',
    body: 'Restricted agent-only process.',
    visibility: 'confidential_queue_staff',
    relatedQueueId: QUEUE_ID,
  });

  const search = (viewerId, canReadQueue) => world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId,
    canReadQueue,
    query: { search: 'guide playbook process' },
  });
  const employeeResults = await search(EMPLOYEE, false);
  assert.deepEqual(employeeResults.articles.map((article) => article.id), []);
  const employeeGuide = await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: EMPLOYEE,
    canReadQueue: false,
    query: {},
  });
  assert.deepEqual(employeeGuide.articles.map((article) => article.id), [employeeArticle.id]);

  const managerResults = await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: QUEUE_MANAGER,
    canReadQueue: true,
    query: {},
  });
  assert.deepEqual(new Set(managerResults.articles.map((article) => article.id)), new Set([employeeArticle.id, staffArticle.id]));
  assert.equal(managerResults.articles.some((article) => article.id === confidentialArticle.id), false);

  const agentResults = await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: AGENT,
    canReadQueue: true,
    query: {},
  });
  assert.equal(agentResults.articles.some((article) => article.id === staffArticle.id), true);
  assert.equal(agentResults.articles.some((article) => article.id === confidentialArticle.id), false);

  const confidentialResults = await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: CONFIDENTIAL_AGENT,
    canReadQueue: true,
    query: {},
  });
  assert.equal(confidentialResults.articles.some((article) => article.id === confidentialArticle.id), true);
  await assert.rejects(
    () => world.service.getEmployeeArticleBySlug({ companyId: COMPANY_A, viewerId: QUEUE_MANAGER, canReadQueue: true, slug: 'confidential-handling' }),
    statusOf(404),
  );

  world.QueueModel.rows[0].agents = world.QueueModel.rows[0].agents.filter((id) =>
    idOf(id) !== CONFIDENTIAL_AGENT && idOf(id) !== AGENT);
  world.QueueModel.rows[0].confidentiality.agentIds = [];
  const revokedAgentResults = await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: AGENT,
    canReadQueue: true,
    query: {},
  });
  assert.equal(revokedAgentResults.articles.some((article) => article.id === staffArticle.id), false);
  await assert.rejects(
    () => world.service.getEmployeeArticleBySlug({ companyId: COMPANY_A, viewerId: AGENT, canReadQueue: true, slug: 'queue-playbook' }),
    statusOf(404),
  );
  const afterRevocation = await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: CONFIDENTIAL_AGENT,
    canReadQueue: true,
    query: {},
  });
  assert.equal(afterRevocation.articles.some((article) => article.id === confidentialArticle.id), false);
  await assert.rejects(
    () => world.service.getEmployeeArticleBySlug({ companyId: COMPANY_A, viewerId: CONFIDENTIAL_AGENT, canReadQueue: true, slug: 'confidential-handling' }),
    statusOf(404),
  );
});

test('draft revisions use optimistic compare-and-swap and published snapshots remain stable until republished', async () => {
  const world = makeWorld();
  const category = await createCategory(world);
  const published = await createArticle(world, {
    categoryId: category.id,
    slug: 'account-recovery',
    title: 'Original recovery',
    summary: 'Original summary',
    body: 'Original recovery content uses a trusted reset link.',
  });
  assert.equal(world.RevisionModel.rows.length, 1);
  assert.equal(world.RevisionModel.calls.creates.at(-1).hasSession, true);
  const updated = await world.service.updateArticleDraft({
    companyId: COMPANY_A,
    actorId: ADMIN,
    articleId: published.id,
    input: { expectedVersion: published.version, title: 'Revised recovery', body: 'New content uses a verified recovery flow.' },
  });
  assert.equal(updated.status, 'published');
  assert.equal(updated.draftContent.title, 'Revised recovery');
  assert.equal(updated.publishedContent.title, 'Original recovery');
  assert.equal(updated.version, published.version + 1);
  await assert.rejects(
    () => world.service.updateArticleDraft({
      companyId: COMPANY_A,
      actorId: ADMIN,
      articleId: published.id,
      input: { expectedVersion: published.version, title: 'Stale edit' },
    }),
    statusOf(409),
  );

  const beforePublish = await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: EMPLOYEE,
    query: { search: 'trusted reset' },
  });
  assert.equal(beforePublish.articles.length, 1);
  const newTermsBeforePublish = await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: EMPLOYEE,
    query: { search: 'verified recovery' },
  });
  assert.equal(newTermsBeforePublish.articles.length, 0);

  const republished = await world.service.publishArticle({
    companyId: COMPANY_A,
    actorId: ADMIN,
    articleId: published.id,
    expectedVersion: updated.version,
  });
  assert.equal(republished.status, 'published');
  assert.equal(republished.publishedContent.title, 'Revised recovery');
  assert.equal(republished.publishedContent.body, 'New content uses a verified recovery flow.');
  assert.equal(republished.draftContent, null);
  assert.equal(republished.publishedRevision, updated.draftRevision);
  assert.equal(world.RevisionModel.rows.length, 2);
  const snapshots = world.RevisionModel.rows
    .filter((revision) => idOf(revision.articleId) === published.id)
    .sort((left, right) => left.revision - right.revision);
  assert.deepEqual(snapshots.map((revision) => revision.content.title), ['Original recovery', 'Revised recovery']);
  assert.equal(snapshots[0].content.body, 'Original recovery content uses a trusted reset link.');
  assert.equal(snapshots[1].sourceDraftRevision, updated.draftRevision);
  const firstHistoryPage = await world.service.listAdminArticleRevisions({
    companyId: COMPANY_A,
    articleId: published.id,
    query: { limit: '1' },
  });
  assert.equal(firstHistoryPage.revisions[0].revision, 2);
  assert.equal(firstHistoryPage.meta.hasMore, true);
  const secondHistoryPage = await world.service.listAdminArticleRevisions({
    companyId: COMPANY_A,
    articleId: published.id,
    query: { limit: '1', cursor: firstHistoryPage.meta.nextCursor },
  });
  assert.equal(secondHistoryPage.revisions[0].revision, 1);
  assert.equal(secondHistoryPage.meta.hasMore, false);
  const oldTerms = await world.service.searchArticles({ companyId: COMPANY_A, viewerId: EMPLOYEE, query: { search: 'trusted reset' } });
  const newTerms = await world.service.searchArticles({ companyId: COMPANY_A, viewerId: EMPLOYEE, query: { search: 'verified recovery' } });
  assert.equal(oldTerms.articles.length, 0);
  assert.equal(newTerms.articles.length, 1);

  const restoredDraft = await world.service.restoreArticleRevisionToDraft({
    companyId: COMPANY_A,
    actorId: ADMIN,
    articleId: published.id,
    revision: 1,
    expectedVersion: republished.version,
  });
  assert.equal(restoredDraft.publishedContent.title, 'Revised recovery');
  assert.equal(restoredDraft.draftContent.title, 'Original recovery');
  assert.equal(world.RevisionModel.rows.length, 2);
  const republishedRestore = await world.service.publishArticle({
    companyId: COMPANY_A,
    actorId: ADMIN,
    articleId: published.id,
    expectedVersion: restoredDraft.version,
  });
  assert.equal(republishedRestore.publishedRevision, 3);
  assert.equal(republishedRestore.publishedContent.title, 'Original recovery');
  assert.equal(world.RevisionModel.rows.length, 3);
});

test('category archival is transactional and refuses any draft or published reference', async () => {
  const world = makeWorld();
  const category = await createCategory(world);
  const draft = await world.service.createArticleDraft({
    companyId: COMPANY_A,
    actorId: ADMIN,
    input: {
      slug: 'draft-guide',
      title: 'Draft guide',
      body: 'Draft-only content.',
      categoryId: category.id,
      visibility: 'employees',
    },
  });
  await assert.rejects(
    () => world.service.archiveCategory({ companyId: COMPANY_A, actorId: ADMIN, categoryId: category.id, expectedVersion: category.version }),
    statusOf(409),
  );
  await world.service.archiveArticle({ companyId: COMPANY_A, actorId: ADMIN, articleId: draft.id, expectedVersion: draft.version });
  const archived = await world.service.archiveCategory({
    companyId: COMPANY_A,
    actorId: ADMIN,
    categoryId: category.id,
    expectedVersion: category.version,
  });
  assert.ok(archived.archivedAt instanceof Date);
  await assert.rejects(
    () => world.service.createArticleDraft({
      companyId: COMPANY_A,
      actorId: ADMIN,
      input: {
        slug: 'cannot-use-archived',
        title: 'Not allowed',
        body: 'A draft cannot use an archived category.',
        categoryId: category.id,
        visibility: 'employees',
      },
    }),
    statusOf(400),
  );
});

test('archiving a published article removes employee access while preserving immutable admin history', async () => {
  const world = makeWorld();
  const category = await createCategory(world);
  const article = await createArticle(world, {
    categoryId: category.id,
    slug: 'archive-policy',
    title: 'Archive policy',
    body: 'This published guidance can later be archived safely.',
  });
  const archived = await world.service.archiveArticle({
    companyId: COMPANY_A,
    actorId: ADMIN,
    articleId: article.id,
    expectedVersion: article.version,
  });
  assert.equal(archived.status, 'archived');
  assert.ok(archived.archivedAt instanceof Date);
  assert.equal(world.RevisionModel.rows.length, 1);
  assert.equal((await world.service.searchArticles({
    companyId: COMPANY_A,
    viewerId: EMPLOYEE,
    query: { search: 'published guidance' },
  })).articles.length, 0);
  await assert.rejects(
    () => world.service.getEmployeeArticleBySlug({ companyId: COMPANY_A, viewerId: EMPLOYEE, slug: 'archive-policy' }),
    statusOf(404),
  );
  const retained = await world.service.getAdminArticleRevision({
    companyId: COMPANY_A,
    articleId: article.id,
    revision: 1,
  });
  assert.equal(retained.content.body, 'This published guidance can later be archived safely.');
  await assert.rejects(
    () => world.service.publishArticle({
      companyId: COMPANY_A,
      actorId: ADMIN,
      articleId: article.id,
      expectedVersion: archived.version,
    }),
    statusOf(409),
  );
  await assert.rejects(
    () => world.service.restoreArticleRevisionToDraft({
      companyId: COMPANY_A,
      actorId: ADMIN,
      articleId: article.id,
      revision: 1,
      expectedVersion: archived.version,
    }),
    statusOf(409),
  );
});

test('queue references, visibility enums, and same-tenant related article links are validated before publication', async () => {
  const world = makeWorld();
  const category = await createCategory(world);
  await assert.rejects(
    () => createArticle(world, {
      categoryId: category.id,
      slug: 'foreign-queue',
      title: 'Wrong queue',
      body: 'Cannot use a queue in another tenant.',
      visibility: 'queue_staff',
      relatedQueueId: FOREIGN_QUEUE_ID,
    }),
    statusOf(400),
  );
  const foreignCategory = await createCategory(world, {
    companyId: COMPANY_B,
    name: 'Other tenant',
    slug: 'other-tenant',
  });
  await assert.rejects(
    () => world.service.createArticleDraft({
      companyId: COMPANY_B,
      actorId: ADMIN,
      input: {
        slug: 'confidential-disabled-queue',
        title: 'Queue has no confidentiality policy',
        body: 'This queue cannot host confidential knowledge articles.',
        categoryId: foreignCategory.id,
        visibility: 'confidential_queue_staff',
        relatedQueueId: FOREIGN_QUEUE_ID,
      },
    }),
    statusOf(400),
  );
  await assert.rejects(
    () => world.service.createArticleDraft({
      companyId: COMPANY_A,
      actorId: ADMIN,
      input: {
        slug: 'invalid-visibility',
        title: 'Bad visibility',
        body: 'Visibility is never implicit.',
        categoryId: category.id,
        visibility: 'everyone',
      },
    }),
    statusOf(400),
  );

  const publicArticle = await createArticle(world, {
    categoryId: category.id,
    slug: 'public-reference',
    title: 'Public reference',
    body: 'A visible article for linking.',
  });
  await assert.rejects(
    () => createArticle(world, {
      categoryId: category.id,
      slug: 'restricted-source',
      title: 'Restricted source',
      body: 'A source can link to a public article.',
      visibility: 'queue_staff',
      relatedQueueId: QUEUE_ID,
      relatedArticleIds: [oid(9999)],
    }),
    statusOf(400),
  );
  const source = await createArticle(world, {
    categoryId: category.id,
    slug: 'safe-source',
    title: 'Safe source',
    body: 'A source may reference an employee-readable article.',
    visibility: 'queue_staff',
    relatedQueueId: QUEUE_ID,
    relatedArticleIds: [publicArticle.id],
  });
  assert.deepEqual(source.publishedContent.relatedArticleIds, [publicArticle.id]);
});

test('article and category tenant uniqueness is enforced and slug collisions do not cross tenants', async () => {
  const world = makeWorld();
  const a = await createCategory(world, { name: 'Help', slug: 'help' });
  await assert.rejects(() => createCategory(world, { name: 'Help', slug: 'other' }), statusOf(409));
  const b = await createCategory(world, { companyId: COMPANY_B, name: 'Help', slug: 'help' });
  const first = await world.service.createArticleDraft({
    companyId: COMPANY_A,
    actorId: ADMIN,
    input: { slug: 'same-slug', title: 'First', body: 'First article.', categoryId: a.id, visibility: 'employees' },
  });
  await assert.rejects(
    () => world.service.createArticleDraft({
      companyId: COMPANY_A,
      actorId: ADMIN,
      input: { slug: 'same-slug', title: 'Duplicate', body: 'Duplicate article.', categoryId: a.id, visibility: 'employees' },
    }),
    statusOf(409),
  );
  const otherTenant = await world.service.createArticleDraft({
    companyId: COMPANY_B,
    actorId: ADMIN,
    input: { slug: 'same-slug', title: 'Other tenant', body: 'Tenant-scoped slug.', categoryId: b.id, visibility: 'employees' },
  });
  assert.notEqual(first.id, otherTenant.id);
});

test('RBAC, models, routes, audit and startup index checks are explicit and bounded', () => {
  const names = new Set(DEFAULT_PERMISSIONS.map((permission) => permission.name));
  assert.ok(names.has('HELPDESK_KB_READ'));
  assert.ok(names.has('HELPDESK_KB_MANAGE'));
  assert.ok(names.has('HELPDESK_KB_PUBLISH'));
  assert.ok(DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('HELPDESK_KB_READ'));
  assert.ok(DEFAULT_ROLE_MATRIX.MANAGER.includes('HELPDESK_KB_READ'));
  assert.ok(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('HELPDESK_KB_MANAGE'));
  assert.ok(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('HELPDESK_KB_PUBLISH'));
  assert.ok(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes('HELPDESK_KB_PUBLISH'));
  assert.equal(getSystemPermissionVersion(), 40);

  assert.ok(HelpdeskKnowledgeBaseArticle.schema.indexes().some(([keys, options]) =>
    options.name === 'helpdesk_kb_article_slug_unique_by_tenant' && keys.companyId === 1 && keys.slugKey === 1 && options.unique === true));
  assert.ok(HelpdeskKnowledgeBaseArticle.schema.indexes().some(([keys, options]) =>
    options.name === 'helpdesk_kb_article_published_tokens' && keys['publishedContent.searchTokens'] === 1));
  assert.ok(HelpdeskKnowledgeBaseCategory.schema.indexes().some(([keys, options]) =>
    options.name === 'helpdesk_kb_category_slug_unique_by_tenant' && options.unique === true));
  assert.ok(HelpdeskKnowledgeBaseRevision.schema.indexes().some(([keys, options]) =>
    options.name === 'helpdesk_kb_revision_unique_by_tenant_article'
      && keys.companyId === 1 && keys.articleId === 1 && keys.revision === 1 && options.unique === true));
  assert.equal(HelpdeskKnowledgeBaseRevision.schema.path('content').options.immutable, true);
  assert.equal(HelpdeskKnowledgeBaseArticle.schema.path('publishedContent.searchTokens').options.select, false);
  assert.equal(HelpdeskMessage.schema.path('relatedArticleIds').options.immutable, true);
  assert.ok(HelpdeskQueue.schema.indexes().some(([, options]) => options.name === 'helpdesk_queue_enabled_agent_membership'));
  assert.ok(HelpdeskQueue.schema.indexes().some(([, options]) => options.name === 'helpdesk_queue_enabled_confidential_agent_membership'));

  const routes = read('src/routes/helpdeskRoutes.js');
  const controller = read('src/controllers/helpdeskKnowledgeBaseController.js');
  const audit = read('src/middlewares/auditTrail.js');
  const db = read('src/config/db.js');
  assert.match(routes, /HELPDESK_KB_READ/);
  assert.match(routes, /HELPDESK_KB_MANAGE/);
  assert.match(routes, /HELPDESK_KB_PUBLISH/);
  assert.match(routes, /articles\/:articleId\/revisions/);
  assert.match(routes, /revisions\/:revision\/restore/);
  assert.match(controller, /const companyId = req\.companyId/);
  assert.doesNotMatch(controller, /req\.body\.companyId/);
  assert.match(audit, /Published a Helpdesk Knowledge Base article/);
  assert.match(audit, /Restored a Helpdesk Knowledge Base revision to draft/);
  assert.match(db, /ensureHelpdeskKnowledgeBaseIndexes/);
  assert.match(db, /requiredRevisionIndexes/);
});
