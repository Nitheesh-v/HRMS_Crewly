import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  HELPDESK_ANALYTICS_MAX_DAYS,
  normalizeHelpdeskAnalyticsQuery,
} from '../src/services/helpdesk/helpdeskAnalyticsRules.js';
import { helpdeskAnalyticsService } from '../src/services/helpdesk/helpdeskAnalyticsService.js';
import HelpdeskMessage from '../src/models/HelpdeskMessage.js';
import HelpdeskTicket from '../src/models/HelpdeskTicket.js';
import HelpdeskTicketLifecycleEvent from '../src/models/HelpdeskTicketLifecycleEvent.js';

process.env.NODE_ENV ||= 'test';
process.env.REDIS_ENABLED ||= 'false';

const oid = (value) => new mongoose.Types.ObjectId(Number(value).toString(16).padStart(24, '0'));
const idSet = (values = []) => new Set(values.map((value) => String(value)));
const asyncQuery = (rows) => {
  let selected = rows;
  return {
    select() { return this; },
    limit(value) { selected = rows.slice(0, value); return this; },
    lean() { return Promise.resolve(selected); },
  };
};
const aggregateResponse = (rows) => ({
  option() { return this; },
  exec() { return Promise.resolve(rows); },
});

const COMPANY = oid(100);
const ACTOR = oid(1);
const MANAGER = oid(2);
const QUEUE_PUBLIC = oid(10);
const QUEUE_CONFIDENTIAL = oid(11);
const QUEUE_REVIEWER = oid(12);
const QUEUE_DENIED = oid(13);
const AGENT = oid(20);
const PERIOD = { from: '2026-01-01', to: '2026-02-01' };

const makeQueues = () => [
  {
    _id: QUEUE_PUBLIC,
    companyId: COMPANY,
    name: 'Public support',
    agents: [ACTOR],
    managers: [],
    confidentiality: { enabled: false, agentIds: [], reviewerIds: [] },
  },
  {
    _id: QUEUE_CONFIDENTIAL,
    companyId: COMPANY,
    name: 'Restricted support',
    agents: [ACTOR],
    managers: [],
    confidentiality: { enabled: true, agentIds: [ACTOR], reviewerIds: [] },
  },
  {
    _id: QUEUE_REVIEWER,
    companyId: COMPANY,
    name: 'Review lane',
    agents: [],
    managers: [],
    confidentiality: { enabled: true, agentIds: [], reviewerIds: [ACTOR] },
  },
  {
    _id: QUEUE_DENIED,
    companyId: COMPANY,
    name: 'Other lane',
    agents: [],
    managers: [],
    confidentiality: { enabled: false, agentIds: [], reviewerIds: [] },
  },
];

const summaryFacet = ({ includeAssignees = false } = {}) => ({
  totals: [{
    _id: null,
    tickets: 4,
    unassigned: 1,
    resolvedOrClosed: 2,
    trackedSla: 3,
    firstResponseObserved: 2,
    firstResponseCompleted: 2,
    firstResponseBreached: 1,
    firstResponseCompliant: 1,
  }],
  byStatus: [{ _id: 'open', count: 2 }, { _id: 'resolved', count: 2 }],
  byPriority: [{ _id: 'normal', count: 3 }, { _id: 'urgent', count: 1 }],
  byQueue: [{ _id: QUEUE_PUBLIC, tickets: 4, unassigned: 1, resolvedOrClosed: 2 }],
  ...(includeAssignees ? { byAssignee: [{ _id: AGENT, tickets: 3, resolvedOrClosed: 2 }] } : {}),
});

const makeService = ({ queues = makeQueues(), manager = false, lifecycleResult = null } = {}) => {
  const captured = { queueFilters: [], ticketPipelines: [], lifecyclePipelines: [], messagePipelines: [], userFilters: [] };
  const users = manager ? [{ _id: AGENT, companyId: COMPANY, status: 'ACTIVE' }] : [];
  const QueueModel = {
    find: (filter) => {
      captured.queueFilters.push(filter);
      return asyncQuery(queues);
    },
  };
  const UserModel = {
    find: (filter) => {
      captured.userFilters.push(filter);
      return asyncQuery(users);
    },
  };
  const TicketModel = {
    collection: { name: 'supporttickets' },
    aggregate: (pipeline) => {
      captured.ticketPipelines.push(pipeline);
      const facet = pipeline.find((stage) => stage.$facet)?.$facet || {};
      if (facet.byStatus && facet.byPriority) {
        return aggregateResponse([summaryFacet({ includeAssignees: Boolean(facet.byAssignee) })]);
      }
      return aggregateResponse([{
        summary: [{ _id: null, responses: 2, averageRating: 4.5 }],
        byRating: [{ _id: 4, responses: 1 }, { _id: 5, responses: 1 }],
      }]);
    },
  };
  const LifecycleEventModel = {
    aggregate: (pipeline) => {
      captured.lifecyclePipelines.push(pipeline);
      return aggregateResponse([lifecycleResult || {
        resolutions: 2,
        firstResolutions: 1,
        firstResolutionDurationMs: 86_400_000,
        requesterReopens: 1,
        staffReopens: 1,
        requesterConfirmed: 1,
        staffClosed: 0,
        autoClosed: 1,
        resolutionSlaTracked: 2,
        resolutionSlaObserved: 2,
        resolutionSlaCompleted: 2,
        resolutionSlaBreached: 1,
        resolutionSlaCompliant: 1,
      }]);
    },
  };
  const MessageModel = {
    collection: { name: 'helpdeskmessages' },
    aggregate: (pipeline) => {
      captured.messagePipelines.push(pipeline);
      if (pipeline.some((stage) => stage.$group?._id === '$authorUserId')) {
        return aggregateResponse([{ _id: AGENT, publicReplies: 7, ticketsRepliedTo: 2 }]);
      }
      const articlePipeline = pipeline.at(-1)?.$facet?.articles;
      const includeArticles = Boolean(articlePipeline);
      const articleLimit = articlePipeline?.find((stage) => stage.$limit)?.$limit ?? 100;
      return aggregateResponse([{
        summary: [{ _id: null, publicReplyReferences: 6, distinctArticles: 2 }],
        ...(includeArticles ? {
          articles: [{ _id: oid(90), publicReplyReferences: 5 }, { _id: oid(91), publicReplyReferences: 1 }].slice(0, articleLimit),
          articleCount: [{ value: 2 }],
        } : {}),
      }]);
    },
  };
  const service = helpdeskAnalyticsService({
    QueueModel,
    UserModel,
    TicketModel,
    LifecycleEventModel,
    MessageModel,
    now: () => new Date('2026-02-01T00:00:00.000Z'),
  });
  return { service, captured };
};

test('analytics periods are strict, UTC-normalizable, paired, and bounded', () => {
  const defaulted = normalizeHelpdeskAnalyticsQuery({}, { now: new Date('2026-02-01T00:00:00.000Z') });
  assert.equal(defaulted.from.toISOString(), '2026-01-02T00:00:00.000Z');
  assert.equal(defaulted.to.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(defaulted.page, 1);
  assert.equal(defaulted.limit, 50);

  const explicit = normalizeHelpdeskAnalyticsQuery({ ...PERIOD, page: '2', limit: '10' });
  assert.equal(explicit.from.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(explicit.to.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(explicit.page, 2);
  assert.equal(explicit.limit, 10);

  assert.throws(() => normalizeHelpdeskAnalyticsQuery({ from: PERIOD.from }), /both from and to/);
  assert.throws(() => normalizeHelpdeskAnalyticsQuery({ ...PERIOD, companyId: String(COMPANY) }), /Unsupported/);
  assert.throws(() => normalizeHelpdeskAnalyticsQuery({ from: PERIOD.to, to: PERIOD.from }), /earlier/);
  assert.throws(() => normalizeHelpdeskAnalyticsQuery({ from: '2024-01-01', to: '2026-01-02' }), new RegExp(`${HELPDESK_ANALYTICS_MAX_DAYS} days`));
  assert.throws(() => normalizeHelpdeskAnalyticsQuery({ ...PERIOD, limit: '101' }), /limit must be between/);
  assert.throws(() => normalizeHelpdeskAnalyticsQuery({ ...PERIOD, page: '1e2' }), /page must be an integer/);
  assert.throws(() => normalizeHelpdeskAnalyticsQuery({ from: '2026-02-30', to: PERIOD.to }), /calendar date/);
});

test('overview aggregates only authorized tenant queues and hides confidential counts outside the current allowlist', async () => {
  const { service, captured } = makeService();
  const report = await service.getOverview({ companyId: COMPANY, actorId: ACTOR, query: PERIOD });
  assert.equal(report.tickets.created, 4);
  assert.equal(report.tickets.currentUnassigned, 1);
  assert.equal(report.sla.firstResponse.complianceRate, 0.5);
  assert.equal(report.sla.resolution.complianceRate, 0.5);
  assert.equal(report.lifecycle.requesterReopens, 1);
  assert.equal(report.lifecycle.staffReopens, 1);
  assert.equal(report.lifecycle.averageFirstResolutionMs, 86_400_000);
  assert.equal(report.feedback.averageRating, 4.5);
  assert.equal(report.knowledgeBase.publicReplyReferences, 6);
  assert.match(report.knowledgeBase.measurement, /views and searches are not tracked/);
  assert.equal(JSON.stringify(report).includes('private ticket subject'), false);
  assert.equal(JSON.stringify(report).includes('feedback comment'), false);

  assert.equal(captured.queueFilters.length, 1);
  assert.equal(String(captured.queueFilters[0].companyId), String(COMPANY));
  assert.ok(captured.queueFilters[0].$or.some((clause) => clause.agents));
  assert.ok(captured.queueFilters[0].$or.some((clause) => clause['confidentiality.reviewerIds']));

  const ticketMatch = captured.ticketPipelines.find((pipeline) => pipeline[0]?.$match?.ticketKind)?.[0].$match;
  assert.equal(ticketMatch.ticketKind, 'HELPDESK');
  assert.equal(String(ticketMatch.companyId), String(COMPANY));
  const publicClause = ticketMatch.$or.find((clause) => clause.isConfidential?.$ne === true);
  const confidentialClause = ticketMatch.$or.find((clause) => clause.isConfidential === true);
  assert.deepEqual(idSet(publicClause.queueId.$in), idSet([QUEUE_PUBLIC, QUEUE_CONFIDENTIAL]));
  assert.deepEqual(idSet(confidentialClause.queueId.$in), idSet([QUEUE_CONFIDENTIAL, QUEUE_REVIEWER]));
  assert.equal(idSet([...publicClause.queueId.$in, ...confidentialClause.queueId.$in]).has(String(QUEUE_DENIED)), false);

  const eventPipeline = captured.lifecyclePipelines[0];
  assert.equal(String(eventPipeline[0].$match.companyId), String(COMPANY));
  assert.ok(eventPipeline.some((stage) => stage.$lookup?.from === 'supporttickets'));
  const messagePipeline = captured.messagePipelines.find((pipeline) => pipeline[0]?.$match?.messageType === 'PUBLIC');
  assert.equal(messagePipeline[0].$match.messageType, 'PUBLIC');
  assert.ok(messagePipeline.some((stage) => stage.$lookup?.from === 'supporttickets'));
});

test('unobserved averages remain null instead of being reported as zero', async () => {
  const { service } = makeService({ lifecycleResult: { firstResolutionDurationMs: null } });
  const report = await service.getOverview({ companyId: COMPANY, actorId: ACTOR, query: PERIOD });
  assert.equal(report.lifecycle.averageFirstResolutionMs, null);
});

test('queue reports hide unauthorized queues and agent reports require explicit manager membership', async () => {
  const queueOnlyService = makeService().service;
  await assert.rejects(
    queueOnlyService.getQueueReport({ companyId: COMPANY, actorId: ACTOR, queueId: QUEUE_DENIED, query: PERIOD }),
    (error) => error.statusCode === 404,
  );

  const managerQueues = [{
    _id: QUEUE_PUBLIC,
    companyId: COMPANY,
    name: 'Managed queue',
    agents: [AGENT],
    managers: [MANAGER],
    confidentiality: { enabled: false, agentIds: [], reviewerIds: [] },
  }];
  const { service, captured } = makeService({ queues: managerQueues, manager: true });
  const report = await service.getQueueAgentPerformance({
    companyId: COMPANY,
    actorId: MANAGER,
    queueId: QUEUE_PUBLIC,
    query: { ...PERIOD, limit: '10' },
  });
  assert.equal(report.agents.total, 1);
  assert.equal(report.agents.items[0].agentId, String(AGENT));
  assert.equal(report.agents.items[0].currentAssigneeTicketsCreatedInPeriod, 3);
  assert.equal(report.agents.items[0].publicRepliesAuthoredInPeriod, 7);
  assert.equal(report.agents.items[0].visibleTicketsRepliedTo, 2);
  assert.match(report.attribution, /current assignee snapshot/);
  assert.ok(captured.userFilters[0].status === 'ACTIVE');
  assert.ok(captured.ticketPipelines.some((pipeline) =>
    pipeline.some((stage) => stage.$facet?.byAssignee),
  ));
  assert.ok(captured.messagePipelines.some((pipeline) =>
    pipeline.some((stage) => stage.$match?.$expr),
  ));
});

test('Knowledge Base usage reports only public-message references and bounds article rows', async () => {
  const { service, captured } = makeService();
  const report = await service.getKnowledgeBaseUsage({
    companyId: COMPANY,
    actorId: ACTOR,
    query: { ...PERIOD, page: '1', limit: '1' },
  });
  assert.equal(report.publicReplyReferences, 6);
  assert.equal(report.distinctArticlesReferenced, 2);
  assert.equal(report.articles.total, 2);
  assert.equal(report.articles.items.length, 1);
  assert.ok(report.articles.items.every((row) => row.articleId && Number.isFinite(row.publicReplyReferences)));
  assert.match(report.measurement, /views and searches are not tracked/);
  const pipeline = captured.messagePipelines.find((entry) => entry.at(-1)?.$facet?.articles);
  assert.equal(pipeline[0].$match.messageType, 'PUBLIC');
  assert.ok(pipeline[0].$match.relatedArticleIds);
  assert.ok(pipeline.some((stage) => stage.$unwind === '$relatedArticleIds'));
  assert.equal(JSON.stringify(report).includes('body'), false);
});

test('analytics routes retain Helpdesk RBAC gates and analytics indexes are declared and boot-verified', () => {
  const source = fs.readFileSync(new URL('../src/routes/helpdeskRoutes.js', import.meta.url), 'utf8');
  assert.match(source, /router\.get\(\s*'\/admin\/analytics\/overview'/);
  assert.match(source, /router\.get\(\s*'\/admin\/analytics\/queues\/:queueId\/agents'/);
  assert.match(source, /requirePermission\('HELPDESK_TICKET_READ'\)[\s\S]*?analyticsController\.getOverview/);
  assert.match(source, /requirePermission\('HELPDESK_QUEUE_MANAGE'\)[\s\S]*?analyticsController\.getQueueAgentPerformance/);
  assert.match(source, /requirePermission\('HELPDESK_KB_MANAGE'\)[\s\S]*?analyticsController\.getKnowledgeBaseUsage/);
  const controllerSource = fs.readFileSync(new URL('../src/controllers/helpdeskAnalyticsController.js', import.meta.url), 'utf8');
  assert.equal((controllerSource.match(/await auditReportRead/g) || []).length, 4);
  assert.match(controllerSource, /action: 'Viewed Helpdesk analytics report'/);
  assert.match(controllerSource, /metadata:\s*\{[\s\S]*?report,[\s\S]*?from: data\?\.period\?\.from/);

  assert.ok(HelpdeskTicket.schema.indexes().some(([keys, options]) =>
    options.name === 'helpdesk_ticket_feedback_analytics'
      && keys['feedback.submittedAt'] === -1,
  ));
  assert.ok(HelpdeskTicketLifecycleEvent.schema.indexes().some(([keys, options]) =>
    options.name === 'helpdesk_lifecycle_analytics'
      && keys.eventType === 1
      && keys.occurredAt === -1,
  ));
  assert.ok(HelpdeskMessage.schema.indexes().some(([keys, options]) =>
    options.name === 'helpdesk_public_message_analytics'
      && keys.createdAt === -1
      && options.partialFilterExpression?.messageType === 'PUBLIC',
  ));
  const dbSource = fs.readFileSync(new URL('../src/config/db.js', import.meta.url), 'utf8');
  assert.match(dbSource, /helpdesk_ticket_feedback_analytics/);
  assert.match(dbSource, /helpdesk_lifecycle_analytics/);
  assert.match(dbSource, /helpdesk_public_message_analytics/);
});
