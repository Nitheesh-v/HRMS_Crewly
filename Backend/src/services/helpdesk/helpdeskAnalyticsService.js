import mongoose from 'mongoose';
import ApiError from '../../utils/ApiError.js';
import HelpdeskMessage from '../../models/HelpdeskMessage.js';
import HelpdeskQueue from '../../models/HelpdeskQueue.js';
import HelpdeskTicket from '../../models/HelpdeskTicket.js';
import HelpdeskTicketLifecycleEvent from '../../models/HelpdeskTicketLifecycleEvent.js';
import User from '../../models/User.js';
import { SUPPORT_TICKET_KIND } from '../../utils/supportTicketKinds.js';
import {
  canReadHelpdeskTicket,
  hasConfidentialHelpdeskAgentAccess,
  idString,
  includesId,
  isHelpdeskQueueStaff,
} from './helpdeskAccess.js';
import {
  HELPDESK_ANALYTICS_MAX_QUEUES,
  HELPDESK_ANALYTICS_MAX_TIME_MS,
  normalizeHelpdeskAnalyticsQuery,
} from './helpdeskAnalyticsRules.js';

const EVENT_TYPES = Object.freeze([
  'RESOLVED',
  'REQUESTER_REOPENED',
  'STAFF_REOPENED',
  'REQUESTER_CONFIRMED_RESOLUTION',
  'STAFF_CLOSED',
  'AUTO_CLOSED',
]);
const OBJECT_ID = /^[a-f\d]{24}$/i;
const asId = (value, label) => {
  const text = idString(value);
  if (!OBJECT_ID.test(text)) throw ApiError.badRequest(`${label} is invalid.`);
  return new mongoose.Types.ObjectId(text);
};
const emptyFacet = () => ({
  tickets: 0,
  unassigned: 0,
  resolvedOrClosed: 0,
  trackedSla: 0,
  firstResponseObserved: 0,
  firstResponseCompleted: 0,
  firstResponseBreached: 0,
  firstResponseCompliant: 0,
});
const first = (rows) => Array.isArray(rows) && rows.length ? rows[0] : {};
const asCount = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const hasDate = (path) => ({ $ne: [{ $ifNull: [path, null] }, null] });
const hasObservedDate = (completedPath, breachedPath) => ({
  $or: [hasDate(completedPath), hasDate(breachedPath)],
});
const isCompliantClock = (completedPath, breachedPath) => ({
  $and: [
    hasDate(completedPath),
    { $eq: [{ $ifNull: [breachedPath, null] }, null] },
  ],
});

const executeAggregate = async (Model, pipeline) => {
  let aggregate = Model.aggregate(pipeline);
  if (typeof aggregate?.option === 'function') {
    aggregate = aggregate.option({ maxTimeMS: HELPDESK_ANALYTICS_MAX_TIME_MS }) || aggregate;
  }
  if (typeof aggregate?.exec === 'function') return aggregate.exec();
  return aggregate;
};

const collectionName = (Model) => {
  const value = Model?.collection?.collectionName || Model?.collection?.name;
  if (typeof value !== 'string' || !value) {
    throw ApiError.unavailable('Helpdesk analytics storage is not configured.');
  }
  return value;
};

const runFind = async (query, { select = null, limit = null } = {}) => {
  let current = query;
  if (select && typeof current?.select === 'function') current = current.select(select) || current;
  if (limit && typeof current?.limit === 'function') current = current.limit(limit) || current;
  if (typeof current?.lean === 'function') current = current.lean() || current;
  return (await current) || [];
};

const visibilityClauses = (scope, prefix = '') => {
  const clauses = [];
  if (scope.publicQueueIds.length) {
    clauses.push({
      [`${prefix}queueId`]: { $in: scope.publicQueueIds },
      [`${prefix}isConfidential`]: { $ne: true },
    });
  }
  if (scope.confidentialQueueIds.length) {
    clauses.push({
      [`${prefix}queueId`]: { $in: scope.confidentialQueueIds },
      [`${prefix}isConfidential`]: true,
    });
  }
  return clauses;
};

const visibleTicketMatch = ({ companyId, scope, from, to, dateField = 'createdAt' }) => ({
  companyId,
  ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
  [dateField]: { $gte: from, $lt: to },
  $or: visibilityClauses(scope),
});

const visibleJoinedTicketMatch = ({ companyId, scope, prefix = 'ticket.' }) => ({
  [`${prefix}companyId`]: companyId,
  [`${prefix}ticketKind`]: SUPPORT_TICKET_KIND.HELPDESK,
  $or: visibilityClauses(scope, prefix),
});

const normalizeSlaClock = ({ observed = 0, completed = 0, breached = 0, compliant = 0, tracked = 0 } = {}) => {
  const totalObserved = asCount(observed);
  const completedCount = asCount(completed);
  const breachedCount = asCount(breached);
  const compliantCount = asCount(compliant);
  return {
    observed: totalObserved,
    completed: completedCount,
    breached: breachedCount,
    compliant: compliantCount,
    pending: Math.max(0, asCount(tracked) - totalObserved),
    complianceRate: totalObserved > 0 ? compliantCount / totalObserved : null,
  };
};

export const helpdeskAnalyticsService = (deps = {}) => {
  const TicketModel = deps.TicketModel || HelpdeskTicket;
  const LifecycleEventModel = deps.LifecycleEventModel || HelpdeskTicketLifecycleEvent;
  const MessageModel = deps.MessageModel || HelpdeskMessage;
  const QueueModel = deps.QueueModel || HelpdeskQueue;
  const UserModel = deps.UserModel || User;
  const now = deps.now || (() => new Date());

  const loadQueueScope = async ({ companyId, actorId, queueId = null, managersOnly = false } = {}) => {
    if (!companyId) throw ApiError.forbidden('A tenant is required for Helpdesk analytics.');
    if (!actorId) throw ApiError.unauthorized('An authenticated user is required for Helpdesk analytics.');
    const tenantId = asId(companyId, 'Tenant');
    const viewerId = asId(actorId, 'Actor');
    const requestedQueueId = queueId ? asId(queueId, 'Queue') : null;
    const membershipSelector = [
      { agents: viewerId },
      { managers: viewerId },
      { 'confidentiality.agentIds': viewerId },
      { 'confidentiality.reviewerIds': viewerId },
    ];
    const filter = {
      companyId: tenantId,
      $or: membershipSelector,
      ...(requestedQueueId ? { _id: requestedQueueId } : {}),
    };
    const rows = await runFind(QueueModel.find(filter), {
      select: '_id companyId name agents managers confidentiality',
      limit: HELPDESK_ANALYTICS_MAX_QUEUES + 1,
    });
    if (rows.length > HELPDESK_ANALYTICS_MAX_QUEUES) {
      throw ApiError.badRequest('Too many Helpdesk queues are in scope; request one queue at a time.');
    }

    const queues = rows.filter((queue) => {
      const access = { canReadOwn: false, canReadQueue: true };
      const canReadPublic = canReadHelpdeskTicket({
        ticket: { isConfidential: false },
        queue,
        viewerId,
        access,
      });
      const canReadConfidential = canReadHelpdeskTicket({
        ticket: { isConfidential: true },
        queue,
        viewerId,
        access,
      });
      return canReadPublic || canReadConfidential;
    });

    const selectedQueue = requestedQueueId
      ? queues.find((queue) => idString(queue._id) === idString(requestedQueueId))
      : null;
    if (requestedQueueId && !selectedQueue) throw ApiError.notFound('Helpdesk queue not found.');
    if (managersOnly && !includesId(selectedQueue?.managers, viewerId)) {
      throw ApiError.notFound('Helpdesk queue not found.');
    }

    const publicQueueIds = [];
    const confidentialQueueIds = [];
    for (const queue of queues) {
      if (canReadHelpdeskTicket({
        ticket: { isConfidential: false },
        queue,
        viewerId,
        access: { canReadOwn: false, canReadQueue: true },
      })) publicQueueIds.push(queue._id);
      if (canReadHelpdeskTicket({
        ticket: { isConfidential: true },
        queue,
        viewerId,
        access: { canReadOwn: false, canReadQueue: true },
      })) confidentialQueueIds.push(queue._id);
    }

    return {
      tenantId,
      viewerId,
      queues,
      selectedQueue,
      publicQueueIds,
      confidentialQueueIds,
    };
  };

  const aggregateTickets = async ({ scope, period, page, limit, includeAssignees = false, assigneeIds = [] } = {}) => {
    if (!scope.queues.length) return { totals: emptyFacet(), byStatus: [], byPriority: [], byQueue: [], byQueueTotal: 0, byAssignee: [] };
    const facets = {
      totals: [
        {
          $group: {
            _id: null,
            tickets: { $sum: 1 },
            unassigned: {
              $sum: { $cond: [{ $eq: [{ $ifNull: ['$assignedTo', null] }, null] }, 1, 0] },
            },
            resolvedOrClosed: {
              $sum: { $cond: [{ $in: ['$status', ['resolved', 'closed']] }, 1, 0] },
            },
            trackedSla: {
              $sum: { $cond: [hasDate('$sla.version'), 1, 0] },
            },
            firstResponseObserved: {
              $sum: { $cond: [hasObservedDate('$sla.firstResponse.completedAt', '$sla.firstResponse.breachedAt'), 1, 0] },
            },
            firstResponseCompleted: {
              $sum: { $cond: [hasDate('$sla.firstResponse.completedAt'), 1, 0] },
            },
            firstResponseBreached: {
              $sum: { $cond: [hasDate('$sla.firstResponse.breachedAt'), 1, 0] },
            },
            firstResponseCompliant: {
              $sum: { $cond: [isCompliantClock('$sla.firstResponse.completedAt', '$sla.firstResponse.breachedAt'), 1, 0] },
            },
          },
        },
      ],
      byStatus: [
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ],
      byPriority: [
        { $group: { _id: '$priority', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ],
      byQueue: [
        {
          $group: {
            _id: '$queueId',
            tickets: { $sum: 1 },
            unassigned: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$assignedTo', null] }, null] }, 1, 0] } },
            resolvedOrClosed: { $sum: { $cond: [{ $in: ['$status', ['resolved', 'closed']] }, 1, 0] } },
          },
        },
        { $sort: { tickets: -1, _id: 1 } },
      ],
    };
    if (includeAssignees) {
      facets.byAssignee = [
        ...(assigneeIds.length ? [{ $match: { assignedTo: { $in: assigneeIds } } }] : [{ $match: { _id: null } }]),
        {
          $group: {
            _id: '$assignedTo',
            tickets: { $sum: 1 },
            resolvedOrClosed: { $sum: { $cond: [{ $in: ['$status', ['resolved', 'closed']] }, 1, 0] } },
          },
        },
        { $sort: { tickets: -1, _id: 1 } },
      ];
    }
    const result = first(await executeAggregate(TicketModel, [
      { $match: visibleTicketMatch({
        companyId: scope.tenantId,
        scope,
        from: period.from,
        to: period.to,
      }) },
      { $facet: facets },
    ]));
    return {
      totals: { ...emptyFacet(), ...first(result.totals || []) },
      byStatus: result.byStatus || [],
      byPriority: result.byPriority || [],
      byQueue: result.byQueue || [],
      byQueueTotal: scope.queues.length,
      byAssignee: result.byAssignee || [],
    };
  };

  const aggregateLifecycle = async ({ scope, period } = {}) => {
    if (!scope.queues.length) return {};
    const ticketCollection = collectionName(TicketModel);
    const result = first(await executeAggregate(LifecycleEventModel, [
      {
        $match: {
          companyId: scope.tenantId,
          eventType: { $in: EVENT_TYPES },
          occurredAt: { $gte: period.from, $lt: period.to },
        },
      },
      {
        $lookup: {
          from: ticketCollection,
          localField: 'ticketId',
          foreignField: '_id',
          as: 'ticket',
        },
      },
      { $unwind: '$ticket' },
      { $match: visibleJoinedTicketMatch({ companyId: scope.tenantId, scope }) },
      {
        $group: {
          _id: null,
          resolutions: { $sum: { $cond: [{ $eq: ['$eventType', 'RESOLVED'] }, 1, 0] } },
          firstResolutions: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$eventType', 'RESOLVED'] }, { $eq: ['$resolutionCycle', 1] }] },
                1,
                0,
              ],
            },
          },
          firstResolutionDurationMs: {
            $avg: {
              $cond: [
                { $and: [{ $eq: ['$eventType', 'RESOLVED'] }, { $eq: ['$resolutionCycle', 1] }] },
                { $subtract: ['$occurredAt', '$ticket.createdAt'] },
                null,
              ],
            },
          },
          requesterReopens: { $sum: { $cond: [{ $eq: ['$eventType', 'REQUESTER_REOPENED'] }, 1, 0] } },
          staffReopens: { $sum: { $cond: [{ $eq: ['$eventType', 'STAFF_REOPENED'] }, 1, 0] } },
          requesterConfirmed: { $sum: { $cond: [{ $eq: ['$eventType', 'REQUESTER_CONFIRMED_RESOLUTION'] }, 1, 0] } },
          staffClosed: { $sum: { $cond: [{ $eq: ['$eventType', 'STAFF_CLOSED'] }, 1, 0] } },
          autoClosed: { $sum: { $cond: [{ $eq: ['$eventType', 'AUTO_CLOSED'] }, 1, 0] } },
          resolutionSlaTracked: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$eventType', 'RESOLVED'] }, hasDate('$slaSnapshot.after.version')] },
                1,
                0,
              ],
            },
          },
          resolutionSlaObserved: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$eventType', 'RESOLVED'] },
                  hasObservedDate('$slaSnapshot.after.resolution.completedAt', '$slaSnapshot.after.resolution.breachedAt'),
                ] },
                1,
                0,
              ],
            },
          },
          resolutionSlaCompleted: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$eventType', 'RESOLVED'] }, hasDate('$slaSnapshot.after.resolution.completedAt')] },
                1,
                0,
              ],
            },
          },
          resolutionSlaBreached: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$eventType', 'RESOLVED'] }, hasDate('$slaSnapshot.after.resolution.breachedAt')] },
                1,
                0,
              ],
            },
          },
          resolutionSlaCompliant: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$eventType', 'RESOLVED'] },
                  isCompliantClock('$slaSnapshot.after.resolution.completedAt', '$slaSnapshot.after.resolution.breachedAt'),
                ] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]));
    return result;
  };

  const aggregateFeedback = async ({ scope, period } = {}) => {
    if (!scope.queues.length) return { summary: {}, byRating: [] };
    const result = first(await executeAggregate(TicketModel, [
      {
        $match: visibleTicketMatch({
          companyId: scope.tenantId,
          scope,
          from: period.from,
          to: period.to,
          dateField: 'feedback.submittedAt',
        }),
      },
      {
        $facet: {
          summary: [
            { $group: { _id: null, responses: { $sum: 1 }, averageRating: { $avg: '$feedback.rating' } } },
          ],
          byRating: [
            { $group: { _id: '$feedback.rating', responses: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]));
    return { summary: first(result.summary || []), byRating: result.byRating || [] };
  };

  const aggregateKnowledgeBase = async ({ scope, period, page, limit, includeArticles = false } = {}) => {
    if (!scope.queues.length) return { summary: {}, articles: [], totalArticles: 0 };
    const ticketCollection = collectionName(TicketModel);
    const articleRowsPipeline = includeArticles
      ? [
        { $group: { _id: '$relatedArticleIds', publicReplyReferences: { $sum: 1 } } },
        { $sort: { publicReplyReferences: -1, _id: 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ]
      : [];
    const articleCountPipeline = includeArticles
      ? [
        { $group: { _id: '$relatedArticleIds' } },
        { $count: 'value' },
      ]
      : [];
    const pipeline = [
      {
        $match: {
          companyId: scope.tenantId,
          messageType: 'PUBLIC',
          createdAt: { $gte: period.from, $lt: period.to },
          relatedArticleIds: { $exists: true },
        },
      },
      {
        $lookup: {
          from: ticketCollection,
          let: { ticketId: '$ticketId', tenantId: '$companyId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$_id', '$$ticketId'] },
                    { $eq: ['$companyId', '$$tenantId'] },
                    { $eq: ['$ticketKind', SUPPORT_TICKET_KIND.HELPDESK] },
                  ],
                },
              },
            },
            { $project: { companyId: 1, ticketKind: 1, queueId: 1, isConfidential: 1 } },
          ],
          as: 'ticket',
        },
      },
      { $unwind: '$ticket' },
      { $match: visibleJoinedTicketMatch({ companyId: scope.tenantId, scope }) },
      { $unwind: '$relatedArticleIds' },
      {
        $facet: {
          summary: [
            { $group: { _id: '$relatedArticleIds', count: { $sum: 1 } } },
            { $group: { _id: null, publicReplyReferences: { $sum: '$count' }, distinctArticles: { $sum: 1 } } },
          ],
          ...(includeArticles
            ? { articles: articleRowsPipeline, articleCount: articleCountPipeline }
            : {}),
        },
      },
    ];
    const result = first(await executeAggregate(MessageModel, pipeline));
    return {
      summary: first(result.summary || []),
      articles: result.articles || [],
      totalArticles: asCount(first(result.articleCount || []).value),
    };
  };

  const aggregateAgentReplies = async ({ scope, period, agentIds } = {}) => {
    if (!scope.queues.length || !agentIds.length) return [];
    const ticketCollection = collectionName(TicketModel);
    return executeAggregate(MessageModel, [
      {
        $match: {
          companyId: scope.tenantId,
          messageType: 'PUBLIC',
          createdAt: { $gte: period.from, $lt: period.to },
          authorUserId: { $in: agentIds },
        },
      },
      {
        $lookup: {
          from: ticketCollection,
          let: { ticketId: '$ticketId', tenantId: '$companyId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$_id', '$$ticketId'] },
                    { $eq: ['$companyId', '$$tenantId'] },
                    { $eq: ['$ticketKind', SUPPORT_TICKET_KIND.HELPDESK] },
                  ],
                },
              },
            },
            { $project: { companyId: 1, ticketKind: 1, queueId: 1, isConfidential: 1, user: 1 } },
          ],
          as: 'ticket',
        },
      },
      { $unwind: '$ticket' },
      { $match: visibleJoinedTicketMatch({ companyId: scope.tenantId, scope }) },
      { $match: { $expr: { $ne: ['$authorUserId', '$ticket.user'] } } },
      {
        $group: {
          _id: '$authorUserId',
          publicReplies: { $sum: 1 },
          ticketsRepliedTo: { $addToSet: '$ticketId' },
        },
      },
      {
        $project: {
          _id: 1,
          publicReplies: 1,
          ticketsRepliedTo: { $size: '$ticketsRepliedTo' },
        },
      },
    ]);
  };

  const composeReport = async ({ scope, period, page, limit, includeQueueBreakdown = false } = {}) => {
    const [ticketStats, lifecycle, feedback, knowledge] = await Promise.all([
      aggregateTickets({ scope, period, page, limit }),
      aggregateLifecycle({ scope, period }),
      aggregateFeedback({ scope, period }),
      aggregateKnowledgeBase({ scope, period, page, limit }),
    ]);
    const totals = ticketStats.totals;
    const resolutionObserved = asCount(lifecycle.resolutionSlaObserved);
    const firstResponse = normalizeSlaClock({
      observed: totals.firstResponseObserved,
      completed: totals.firstResponseCompleted,
      breached: totals.firstResponseBreached,
      compliant: totals.firstResponseCompliant,
      tracked: totals.trackedSla,
    });
    const resolution = normalizeSlaClock({
      observed: resolutionObserved,
      completed: lifecycle.resolutionSlaCompleted,
      breached: lifecycle.resolutionSlaBreached,
      compliant: lifecycle.resolutionSlaCompliant,
      tracked: lifecycle.resolutionSlaTracked,
    });
    const queueStatsById = new Map((ticketStats.byQueue || []).map((item) => [idString(item._id), item]));
    const allQueues = scope.queues.map((queue) => {
      const queueId = idString(queue._id);
      const item = queueStatsById.get(queueId) || {};
      return {
        queueId,
        queueName: String(queue.name || ''),
        ticketsCreated: asCount(item.tickets),
        currentUnassigned: asCount(item.unassigned),
        currentResolvedOrClosed: asCount(item.resolvedOrClosed),
      };
    }).sort((left, right) =>
      right.ticketsCreated - left.ticketsCreated
      || left.queueName.localeCompare(right.queueName)
      || left.queueId.localeCompare(right.queueId));
    const queues = allQueues.slice((page - 1) * limit, page * limit);
    const responseSummary = first(feedback.summary ? [feedback.summary] : []);
    const knowledgeSummary = first(knowledge.summary ? [knowledge.summary] : []);
    const rawDuration = lifecycle.firstResolutionDurationMs;
    const duration = rawDuration === null || rawDuration === undefined ? null : Number(rawDuration);
    const rawAverageRating = responseSummary.averageRating;
    const averageRating = rawAverageRating === null || rawAverageRating === undefined
      ? null
      : Number(rawAverageRating);
    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        semantics: '[from, to)',
      },
      scope: { readableQueues: scope.queues.length },
      tickets: {
        created: asCount(totals.tickets),
        currentUnassigned: asCount(totals.unassigned),
        currentResolvedOrClosed: asCount(totals.resolvedOrClosed),
        byStatus: (ticketStats.byStatus || []).map((entry) => ({ status: String(entry._id || 'unknown'), tickets: asCount(entry.count) })),
        byPriority: (ticketStats.byPriority || []).map((entry) => ({ priority: String(entry._id || 'unknown'), tickets: asCount(entry.count) })),
      },
      sla: {
        trackedTickets: asCount(totals.trackedSla),
        firstResponse,
        trackedResolutionCycles: asCount(lifecycle.resolutionSlaTracked),
        resolution,
      },
      lifecycle: {
        resolutions: asCount(lifecycle.resolutions),
        firstResolutions: asCount(lifecycle.firstResolutions),
        averageFirstResolutionMs: Number.isFinite(duration) ? duration : null,
        requesterReopens: asCount(lifecycle.requesterReopens),
        staffReopens: asCount(lifecycle.staffReopens),
        requesterConfirmed: asCount(lifecycle.requesterConfirmed),
        staffClosed: asCount(lifecycle.staffClosed),
        autoClosed: asCount(lifecycle.autoClosed),
        historyCoverage: 'Lifecycle event metrics include only persisted events; no legacy history is inferred.',
      },
      feedback: {
        responses: asCount(responseSummary.responses),
        averageRating: Number.isFinite(averageRating) ? averageRating : null,
        byRating: (feedback.byRating || []).map((entry) => ({ rating: Number(entry._id), responses: asCount(entry.responses) })),
      },
      knowledgeBase: {
        publicReplyReferences: asCount(knowledgeSummary.publicReplyReferences),
        distinctArticlesReferenced: asCount(knowledgeSummary.distinctArticles),
        measurement: 'Persisted references in public Helpdesk replies; article views and searches are not tracked.',
      },
      ...(includeQueueBreakdown
        ? {
          queues: {
            items: queues,
            total: ticketStats.byQueueTotal,
            page,
            limit,
          },
        }
        : {}),
    };
  };

  const getOverview = async ({ companyId, actorId, query = {} } = {}) => {
    const period = normalizeHelpdeskAnalyticsQuery(query, { now: now() });
    const scope = await loadQueueScope({ companyId, actorId });
    return composeReport({ scope, period, page: period.page, limit: period.limit, includeQueueBreakdown: true });
  };

  const getQueueReport = async ({ companyId, actorId, queueId, query = {} } = {}) => {
    const period = normalizeHelpdeskAnalyticsQuery(query, { now: now() });
    const scope = await loadQueueScope({ companyId, actorId, queueId });
    const report = await composeReport({ scope, period, page: 1, limit: 1 });
    return {
      ...report,
      queue: {
        id: idString(scope.selectedQueue._id),
        name: String(scope.selectedQueue.name || ''),
      },
    };
  };

  const getQueueAgentPerformance = async ({ companyId, actorId, queueId, query = {} } = {}) => {
    const period = normalizeHelpdeskAnalyticsQuery(query, { now: now() });
    const scope = await loadQueueScope({ companyId, actorId, queueId, managersOnly: true });
    const queueAgentIds = [...new Set((scope.selectedQueue.agents || []).map(idString).filter(Boolean))];
    let activeQuery = UserModel.find({
      _id: { $in: queueAgentIds.map((agentId) => asId(agentId, 'Agent')) },
      companyId: scope.tenantId,
      status: 'ACTIVE',
    });
    const activeRows = await runFind(activeQuery, { select: '_id' });
    const activeAgentIds = activeRows.map((row) => row._id);
    const [ticketStats, replyStats] = await Promise.all([
      aggregateTickets({
        scope,
        period,
        page: 1,
        limit: 1,
        includeAssignees: true,
        assigneeIds: activeAgentIds,
      }),
      aggregateAgentReplies({ scope, period, agentIds: activeAgentIds }),
    ]);
    const assignedById = new Map((ticketStats.byAssignee || []).map((row) => [idString(row._id), row]));
    const repliesById = new Map((replyStats || []).map((row) => [idString(row._id), row]));
    const agents = activeAgentIds.map((agentId) => {
      const key = idString(agentId);
      const assigned = assignedById.get(key) || {};
      const replies = repliesById.get(key) || {};
      return {
        agentId: key,
        currentAssigneeTicketsCreatedInPeriod: asCount(assigned.tickets),
        currentResolvedOrClosedTickets: asCount(assigned.resolvedOrClosed),
        publicRepliesAuthoredInPeriod: asCount(replies.publicReplies),
        visibleTicketsRepliedTo: asCount(replies.ticketsRepliedTo),
      };
    }).sort((left, right) =>
      right.publicRepliesAuthoredInPeriod - left.publicRepliesAuthoredInPeriod
      || right.currentAssigneeTicketsCreatedInPeriod - left.currentAssigneeTicketsCreatedInPeriod
      || left.agentId.localeCompare(right.agentId));
    const start = (period.page - 1) * period.limit;
    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        semantics: '[from, to)',
      },
      queue: {
        id: idString(scope.selectedQueue._id),
        name: String(scope.selectedQueue.name || ''),
      },
      attribution: 'Ticket workload uses the current assignee snapshot; replies use persisted public-message authorship. No historical assignment history is inferred.',
      agents: {
        items: agents.slice(start, start + period.limit),
        total: agents.length,
        page: period.page,
        limit: period.limit,
      },
    };
  };

  const getKnowledgeBaseUsage = async ({ companyId, actorId, query = {} } = {}) => {
    const period = normalizeHelpdeskAnalyticsQuery(query, { now: now() });
    const scope = await loadQueueScope({ companyId, actorId });
    const usage = await aggregateKnowledgeBase({
      scope,
      period,
      page: period.page,
      limit: period.limit,
      includeArticles: true,
    });
    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        semantics: '[from, to)',
      },
      measurement: 'Counts of persisted article references in public Helpdesk replies; views and searches are not tracked.',
      publicReplyReferences: asCount(first(usage.summary ? [usage.summary] : []).publicReplyReferences),
      distinctArticlesReferenced: asCount(first(usage.summary ? [usage.summary] : []).distinctArticles),
      articles: {
        items: usage.articles.map((item) => ({
          articleId: idString(item._id),
          publicReplyReferences: asCount(item.publicReplyReferences),
        })),
        total: usage.totalArticles,
        page: period.page,
        limit: period.limit,
      },
    };
  };

  return {
    getOverview,
    getQueueReport,
    getQueueAgentPerformance,
    getKnowledgeBaseUsage,
  };
};
