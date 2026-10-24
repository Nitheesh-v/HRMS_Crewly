import ApiError from '../../utils/ApiError.js';
import HelpdeskAuthorizationFence from '../../models/HelpdeskAuthorizationFence.js';
import HelpdeskTicket from '../../models/HelpdeskTicket.js';
import HelpdeskTicketLifecycleEvent from '../../models/HelpdeskTicketLifecycleEvent.js';
import HelpdeskQueue from '../../models/HelpdeskQueue.js';
import User from '../../models/User.js';
import TenantSequence from '../../models/TenantSequence.js';
import { SUPPORT_TICKET_KIND } from '../../utils/supportTicketKinds.js';
import { nextHelpdeskTicketNumber } from './helpdeskTicketNumbers.js';
import { helpdeskTenantConfigService } from './helpdeskTenantConfigService.js';
import { helpdeskSlaService } from './helpdeskSlaService.js';
import {
  HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH,
  canTransitionHelpdeskTicket,
  isHelpdeskTerminalStatus,
  normalizeHelpdeskQueueTicketListQuery,
  normalizeHelpdeskTicketListQuery,
  validateHelpdeskTicketCreateInput,
  validateHelpdeskPriority,
  validateHelpdeskStatusTransition,
  validateHelpdeskTransferInput,
} from './helpdeskRules.js';
import {
  serializeHelpdeskAgentTicketDetails,
  serializeHelpdeskAgentTicketListItem,
  serializeHelpdeskEmployeeTicketDetails,
  serializeHelpdeskEmployeeTicketListItem,
  serializeHelpdeskTicket,
} from './helpdeskDto.js';
import { boundedSearchTerm } from '../../utils/searchInput.js';
import {
  addHelpdeskNotificationSequenceFilter,
  buildHelpdeskTicketNotificationAppend,
  buildHelpdeskTicketNotificationCreateFields,
  diffHelpdeskSlaNotificationEvents,
} from './helpdeskNotificationRules.js';
import {
  HELPDESK_AUTO_CLOSE_BATCH_MAX,
  HELPDESK_AUTO_CLOSE_DELAY_DEFAULT_HOURS,
  HELPDESK_REOPEN_WINDOW_DEFAULT_HOURS,
  lifecycleCounterFilter,
  normalizeHelpdeskFeedback,
  normalizeHelpdeskReopenReason,
  serializeHelpdeskFeedback,
  snapshotHelpdeskSla,
} from './helpdeskLifecycleRules.js';
import {
  canReadHelpdeskTicket as canReadTicket,
  hasConfidentialHelpdeskAgentAccess as hasConfidentialAgentAccess,
  idString,
  includesId,
} from './helpdeskAccess.js';
import { bumpHelpdeskAuthorizationFence } from './helpdeskAuthorizationFence.js';
import { runHelpdeskTransaction } from './helpdeskTransaction.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const TICKET_NUMBER = /^HD-\d{6,}$/;
const AGENT_LIST_FIELDS =
  'ticketNumber subject queueId categoryId categoryName status priority assignedTo ' +
  'isConfidential createdAt updatedAt sla';

const ensureCompanyId = (companyId) => {
  if (!companyId) throw ApiError.forbidden('A tenant is required');
};

const ensureActorId = (actorId) => {
  if (!actorId) throw ApiError.unauthorized('An authenticated user is required');
};

const dateValue = (value) => {
  if (value instanceof Date) return new Date(value.getTime());
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const addHours = (value, hours) => {
  const date = dateValue(value);
  return date ? new Date(date.getTime() + Number(hours) * 60 * 60 * 1000) : null;
};

const requesterReopenAvailability = ({ ticket, config, at } = {}) => {
  const resolvedAt = dateValue(ticket?.resolvedAt);
  const configuredWindow = Number(config?.reopenWindowHours) || HELPDESK_REOPEN_WINDOW_DEFAULT_HOURS;
  const reopenUntilAt = dateValue(ticket?.reopenUntilAt)
    || (resolvedAt ? addHours(resolvedAt, configuredWindow) : null);
  const evaluatedAt = dateValue(at);
  const eligibilityKnown = Boolean(config && evaluatedAt);
  const canReopen = eligibilityKnown
    && ticket?.status === 'resolved'
    && config.allowEmployeeReopen !== false
    && resolvedAt
    && reopenUntilAt
    && evaluatedAt.getTime() <= reopenUntilAt.getTime();

  return {
    canReopen: Boolean(canReopen),
    reopenEligibilityKnown: eligibilityKnown,
    reopenUntilAt,
  };
};

const lifecycleTicketDto = (ticket) => ({
  ticketNumber: String(ticket?.ticketNumber || ''),
  status: String(ticket?.status || ''),
  resolvedAt: ticket?.resolvedAt || null,
  resolutionCycle: Number(ticket?.resolutionCycle) || 0,
  reopenUntilAt: ticket?.reopenUntilAt || null,
  reopenedAt: ticket?.reopenedAt || null,
  closedAt: ticket?.closedAt || null,
  resolutionConfirmedAt: ticket?.resolutionConfirmedAt || null,
  autoCloseAt: ticket?.autoCloseAt || null,
});

export const helpdeskTicketService = (deps = {}) => {
  const TicketModel = deps.TicketModel || HelpdeskTicket;
  const LifecycleEventModel = deps.LifecycleEventModel || HelpdeskTicketLifecycleEvent;
  const QueueModel = deps.QueueModel || HelpdeskQueue;
  const FenceModel = deps.FenceModel || HelpdeskAuthorizationFence;
  const transactionRunner = deps.transactionRunner || runHelpdeskTransaction;
  // Integration harnesses may suppress only notification intent; authorization,
  // transaction, and ticket persistence behavior remain the real service path.
  const notificationIntentsEnabled = deps.notificationIntentsEnabled !== false;
  const UserModel = deps.UserModel || User;
  const SequenceModel = deps.SequenceModel || TenantSequence;
  const configService = deps.configService || helpdeskTenantConfigService({
    ConfigModel: deps.ConfigModel,
  });
  const slaService = deps.slaService || helpdeskSlaService({
    TicketModel,
    QueueModel,
    UserModel,
    PolicyModel: deps.PolicyModel,
    MessageModel: deps.MessageModel,
    holidayReader: deps.holidayReader,
    now: deps.now,
    notificationIntentsEnabled,
  });
  const now = deps.now || (() => new Date());

  const withSession = (query, session) =>
    session && typeof query?.session === 'function' ? query.session(session) : query;

  const findQueue = async (companyId, queueId, session = null) => {
    if (!OBJECT_ID.test(String(queueId || ''))) return null;
    let query = withSession(QueueModel.findOne({ _id: queueId, companyId }), session);
    if (typeof query?.lean === 'function') query = query.lean();
    return query;
  };

  const findTicket = async (companyId, ticketNumber, session = null) => {
    if (!TICKET_NUMBER.test(String(ticketNumber || ''))) return null;
    const query = withSession(TicketModel.findOne({
      companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      ticketNumber,
    }), session);
    return query;
  };

  const assertQueueStaff = ({ queue, actorId, managersOnly = false }) => {
    const actorIsManager = includesId(queue.managers, actorId);
    const actorIsAgent = includesId(queue.agents, actorId);
    if (managersOnly ? !actorIsManager : !(actorIsManager || actorIsAgent)) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }
  };

  const assertQueueAgent = ({ queue, actorId }) => {
    if (!includesId(queue.agents, actorId)) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }
  };

  const assertTicketMutationAccess = ({
    ticket,
    queue,
    actorId,
    managersOnly = false,
    agentsOnly = false,
  }) => {
    if (agentsOnly) assertQueueAgent({ queue, actorId });
    else assertQueueStaff({ queue, actorId, managersOnly });
    // A manager's queue role never substitutes for the restricted-agent list.
    if (ticket.isConfidential === true && !hasConfidentialAgentAccess({ queue, actorId })) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }
  };

  const getMutationContext = async ({
    companyId,
    actorId,
    ticketNumber,
    managersOnly = false,
    agentsOnly = false,
    session = null,
  } = {}) => {
    const ticket = await findTicket(companyId, ticketNumber, session);
    if (!ticket) throw ApiError.notFound('Helpdesk ticket not found');
    const queue = await findQueue(companyId, ticket.queueId, session);
    if (!queue) throw ApiError.notFound('Helpdesk ticket not found');
    assertTicketMutationAccess({ ticket, queue, actorId, managersOnly, agentsOnly });
    return { ticket, queue };
  };

  const conditionalTicketFilter = ({
    companyId,
    ticket,
    includePriority = false,
    includeSlaVersion = false,
  }) => ({
    _id: ticket._id,
    companyId,
    ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
    ticketNumber: ticket.ticketNumber,
    user: ticket.user,
    queueId: ticket.queueId,
    isConfidential: ticket.isConfidential === true ? true : { $ne: true },
    status: ticket.status,
    assignedTo: ticket.assignedTo ?? null,
    ...(includePriority ? { priority: ticket.priority } : {}),
    ...(includeSlaVersion
      ? { 'sla.version': ticket.sla?.version ?? { $exists: false } }
      : {}),
  });

  const sameMutationSnapshot = (expected, current, { includePriority, includeSlaVersion }) =>
    idString(expected?._id) === idString(current?._id)
    && idString(expected?.user) === idString(current?.user)
    && idString(expected?.queueId) === idString(current?.queueId)
    && idString(expected?.assignedTo) === idString(current?.assignedTo)
    && String(expected?.status || '') === String(current?.status || '')
    && (expected?.isConfidential === true) === (current?.isConfidential === true)
    && (!includePriority || String(expected?.priority || '') === String(current?.priority || ''))
    && (!includeSlaVersion
      || (expected?.sla?.version ?? null) === (current?.sla?.version ?? null));

  const readConfigInTransaction = async ({ companyId, session }) => {
    if (typeof configService.readConfig === 'function') {
      return configService.readConfig({ companyId, session });
    }
    return configService.getConfig({ companyId });
  };

  const commitConditionalUpdate = async ({
    companyId,
    actorId,
    ticketNumber,
    ticket,
    update,
    notificationEvents = [],
    lifecycleEvent = null,
    includePriority = false,
    includeSlaVersion = false,
    managersOnly = false,
    agentsOnly = false,
    validateInTransaction = async () => ({}),
  }) => transactionRunner(async (session) => {
    const { ticket: currentTicket, queue: currentQueue } = await getMutationContext({
      companyId,
      actorId,
      ticketNumber,
      managersOnly,
      agentsOnly,
      session,
    });
    if (!sameMutationSnapshot(ticket, currentTicket, { includePriority, includeSlaVersion })) {
      throw ApiError.conflict('The ticket changed while you were acting. Refresh and try again.');
    }

    const validation = await validateInTransaction({
      ticket: currentTicket,
      queue: currentQueue,
      session,
    }) || {};
    const rawUpdatePatch = typeof update === 'function'
      ? await update({ ticket: currentTicket, queue: currentQueue, validation, session })
      : update;
    const updatePatch = { ...(rawUpdatePatch || {}) };
    const lifecycleSpec = typeof lifecycleEvent === 'function'
      ? await lifecycleEvent({
        ticket: currentTicket,
        queue: currentQueue,
        update: updatePatch,
        validation,
        session,
      })
      : lifecycleEvent;
    const lifecycleSequence = lifecycleSpec
      ? (Number(currentTicket.lifecycleSequence) || 0) + 1
      : null;
    if (lifecycleSpec) {
      if (!Number.isSafeInteger(lifecycleSequence) || lifecycleSequence < 1) {
        throw ApiError.conflict('The Helpdesk lifecycle sequence is invalid.');
      }
      updatePatch.lifecycleSequence = lifecycleSequence;
    }
    const fenceEntries = [
      { queueId: currentQueue._id, userId: actorId },
      ...(validation.fenceEntries || []),
    ];
    const fencesByQueue = new Map();
    for (const entry of fenceEntries) {
      if (!entry?.queueId || !entry?.userId) continue;
      const queueKey = idString(entry.queueId).toLowerCase();
      if (!fencesByQueue.has(queueKey)) fencesByQueue.set(queueKey, { queueId: entry.queueId, userIds: [] });
      fencesByQueue.get(queueKey).userIds.push(entry.userId);
    }
    for (const fence of fencesByQueue.values()) {
      await bumpHelpdeskAuthorizationFence({
        FenceModel,
        companyId,
        queueId: fence.queueId,
        userIds: fence.userIds,
        session,
      });
    }

    const notificationAppend = notificationIntentsEnabled
      ? buildHelpdeskTicketNotificationAppend({
        ticket: currentTicket,
        eventTypes: notificationEvents,
        at: now(),
      })
      : null;
    const filter = conditionalTicketFilter({
      companyId,
      ticket: currentTicket,
      includePriority,
      includeSlaVersion,
    });
    if (lifecycleSpec) {
      filter.lifecycleSequence = lifecycleCounterFilter(currentTicket.lifecycleSequence);
    }
    const updateDocument = { $set: updatePatch };
    if (notificationAppend) {
      Object.assign(updateDocument, notificationAppend.update);
      updateDocument.$set = {
        ...updateDocument.$set,
        ...(notificationAppend.update.$set || {}),
      };
      Object.assign(filter, addHelpdeskNotificationSequenceFilter({}, currentTicket));
    }
    let query = TicketModel.findOneAndUpdate(
      filter,
      updateDocument,
      { returnDocument: 'after', runValidators: true, session },
    );
    if (typeof query?.lean === 'function') query = query.lean();
    const updated = await query;
    if (!updated) {
      // Membership and confidentiality were rechecked against this snapshot;
      // a lost conditional write remains non-enumerating and never commits a fence alone.
      throw ApiError.conflict('The ticket changed while you were acting. Refresh and try again.');
    }
    if (lifecycleSpec) {
      await LifecycleEventModel.create([{
        companyId,
        ticketId: currentTicket._id,
        ticketNumber: currentTicket.ticketNumber,
        sequence: lifecycleSequence,
        eventType: lifecycleSpec.eventType,
        actorType: lifecycleSpec.actorType || 'USER',
        actorId: lifecycleSpec.actorId ?? actorId ?? null,
        fromStatus: lifecycleSpec.fromStatus ?? currentTicket.status ?? null,
        toStatus: lifecycleSpec.toStatus ?? updatePatch.status ?? currentTicket.status ?? null,
        occurredAt: lifecycleSpec.occurredAt || now(),
        resolutionCycle: Number(lifecycleSpec.resolutionCycle ?? updatePatch.resolutionCycle ?? currentTicket.resolutionCycle) || 0,
        reason: lifecycleSpec.reason ?? null,
        slaSnapshot: lifecycleSpec.slaSnapshot ?? null,
      }], { session });
    }
    return { updated, queueName: validation.queueName || currentQueue.name };
  });

  const commitLifecycleUpdate = async ({
    companyId,
    ticket,
    session,
    patch,
    eventType,
    actorType = 'USER',
    actorId = null,
    fromStatus = ticket.status,
    toStatus = patch.status ?? ticket.status,
    occurredAt,
    reason = null,
    resolutionCycle = ticket.resolutionCycle || 0,
    slaBefore = ticket.sla,
    slaAfter = patch.sla || ticket.sla,
    notificationEvents = [],
    extraFilter = {},
  }) => {
    const sequence = (Number(ticket.lifecycleSequence) || 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw ApiError.conflict('The Helpdesk lifecycle sequence is invalid.');
    }
    const updatePatch = { ...patch, lifecycleSequence: sequence };
    const filter = {
      _id: ticket._id,
      companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      ticketNumber: ticket.ticketNumber,
      user: ticket.user,
      status: ticket.status,
      lifecycleSequence: lifecycleCounterFilter(ticket.lifecycleSequence),
      ...extraFilter,
      ...(ticket.sla ? { 'sla.version': Number(ticket.sla.version) || 1 } : {}),
    };
    const notificationAppend = notificationIntentsEnabled
      ? buildHelpdeskTicketNotificationAppend({ ticket, eventTypes: notificationEvents, at: occurredAt })
      : null;
    const updateDocument = { $set: updatePatch };
    if (notificationAppend) {
      Object.assign(updateDocument, notificationAppend.update);
      updateDocument.$set = {
        ...updateDocument.$set,
        ...(notificationAppend.update.$set || {}),
      };
      Object.assign(filter, addHelpdeskNotificationSequenceFilter({}, ticket));
    }
    let query = TicketModel.findOneAndUpdate(
      filter,
      updateDocument,
      { returnDocument: 'after', runValidators: true, session },
    );
    if (typeof query?.lean === 'function') query = query.lean();
    const updated = await query;
    if (!updated) throw ApiError.conflict('The ticket changed while you were acting. Refresh and try again.');

    await LifecycleEventModel.create([{
      companyId,
      ticketId: ticket._id,
      ticketNumber: ticket.ticketNumber,
      sequence,
      eventType,
      actorType,
      actorId,
      fromStatus,
      toStatus,
      occurredAt,
      resolutionCycle: Number(resolutionCycle) || 0,
      reason,
      slaSnapshot: {
        before: snapshotHelpdeskSla(slaBefore),
        after: snapshotHelpdeskSla(slaAfter),
      },
    }], { session });
    return updated;
  };

  const listMine = async ({ companyId, requesterId, query = {} } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(requesterId);

    const options = normalizeHelpdeskTicketListQuery(query);
    const filter = {
      companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      user: requesterId,
    };
    if (options.status) filter.status = options.status;
    if (options.priority) filter.priority = options.priority;
    if (options.queueId) filter.queueId = options.queueId;

    const searchTerm = boundedSearchTerm(
      options.search,
      HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH,
    );
    if (searchTerm) {
      const literalSearch = new RegExp(searchTerm, 'i');
      filter.$or = [
        { ticketNumber: literalSearch },
        { subject: literalSearch },
      ];
    }

    const sort = {
      newest: { createdAt: -1, _id: -1 },
      oldest: { createdAt: 1, _id: 1 },
      recently_updated: { updatedAt: -1, _id: -1 },
    }[options.sort];
    const skip = (options.page - 1) * options.limit;

    const [tickets, total] = await Promise.all([
      TicketModel.find(filter)
        .select(
          'ticketNumber subject queueId categoryId categoryName status priority ' +
            'isConfidential createdAt updatedAt sla',
        )
        .sort(sort)
        .skip(skip)
        .limit(options.limit)
        .lean(),
      TicketModel.countDocuments(filter),
    ]);

    const queueIds = [...new Set((tickets || []).map((ticket) => idString(ticket.queueId)).filter(Boolean))];
    const queues = queueIds.length
      ? await QueueModel.find({ companyId, _id: { $in: queueIds } })
        .select('_id name')
        .lean()
      : [];
    const queueNames = new Map((queues || []).map((queue) => [idString(queue._id), queue.name]));

    return {
      tickets: (tickets || []).map((ticket) => serializeHelpdeskEmployeeTicketListItem(ticket, {
        queueName: queueNames.get(idString(ticket.queueId)) ?? null,
      })),
      meta: {
        page: options.page,
        limit: options.limit,
        total,
        pages: Math.max(1, Math.ceil(total / options.limit)),
      },
    };
  };

  const listQueueTickets = async ({
    companyId,
    viewerId,
    queueId,
    query = {},
    limit,
    view = 'queue',
    canReadQueue = false,
  } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(viewerId);
    if (!['queue', 'assigned-to-me', 'unassigned'].includes(view)) {
      throw ApiError.badRequest('Helpdesk queue ticket view is not supported');
    }

    const listQuery = Object.keys(query || {}).length || limit === undefined
      ? query
      : { limit: String(limit) };
    const options = normalizeHelpdeskQueueTicketListQuery(listQuery);
    const queue = await findQueue(companyId, queueId);
    const isQueueStaff = canReadQueue === true && queue
      && (includesId(queue.agents, viewerId) || includesId(queue.managers, viewerId));
    const isConfidentialReviewer = canReadQueue === true && queue
      && includesId(queue.confidentiality?.reviewerIds, viewerId);
    if (!queue || (!isQueueStaff && !isConfidentialReviewer)) {
      throw ApiError.notFound('Helpdesk queue not found');
    }

    const filter = {
      companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      queueId: queue._id,
    };
    if (options.status) filter.status = options.status;
    if (options.priority) filter.priority = options.priority;
    if (view === 'assigned-to-me') filter.assignedTo = viewerId;
    if (view === 'unassigned') filter.assignedTo = null;

    const clauses = [];
    if (isConfidentialReviewer && !isQueueStaff) {
      filter.isConfidential = true;
    } else if (!hasConfidentialAgentAccess({ queue, actorId: viewerId })
      && !isConfidentialReviewer) {
      clauses.push({
        $or: [
          { isConfidential: { $ne: true } },
          { user: viewerId },
        ],
      });
    }

    const searchTerm = boundedSearchTerm(
      options.search,
      HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH,
    );
    if (searchTerm) {
      const literalSearch = new RegExp(searchTerm, 'i');
      clauses.push({
        $or: [
          { ticketNumber: literalSearch },
          { subject: literalSearch },
        ],
      });
    }
    if (clauses.length) filter.$and = clauses;

    const sort = {
      newest: { createdAt: -1, _id: -1 },
      oldest: { createdAt: 1, _id: 1 },
      recently_updated: { updatedAt: -1, _id: -1 },
    }[options.sort];
    const skip = (options.page - 1) * options.limit;
    const rows = await TicketModel.find(filter)
      .select(AGENT_LIST_FIELDS)
      .sort(sort)
      .skip(skip)
      .limit(options.limit + 1)
      .lean();
    const hasMore = (rows || []).length > options.limit;

    return {
      tickets: (rows || []).slice(0, options.limit).map((ticket) =>
        serializeHelpdeskAgentTicketListItem(ticket, { queueName: queue.name })),
      meta: {
        page: options.page,
        limit: options.limit,
        hasMore,
      },
    };
  };

  const listAssignedToMe = async (input = {}) =>
    listQueueTickets({ ...input, view: 'assigned-to-me' });

  const listUnassignedTickets = async (input = {}) =>
    listQueueTickets({ ...input, view: 'unassigned' });

  const getTicket = async ({
    companyId,
    viewerId,
    ticketNumber,
    canReadOwn = false,
    canReadQueue = false,
  } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(viewerId);

    let ticket = null;
    let isRequester = false;
    if (canReadOwn === true && TICKET_NUMBER.test(String(ticketNumber || ''))) {
      ticket = await TicketModel.findOne({
        companyId,
        ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
        user: viewerId,
        ticketNumber,
      });
      isRequester = Boolean(ticket);
    }
    if (!ticket && canReadQueue === true) {
      ticket = await findTicket(companyId, ticketNumber);
    }
    if (!ticket) throw ApiError.notFound('Helpdesk ticket not found');

    const queue = await findQueue(companyId, ticket.queueId);
    if (!queue) throw ApiError.notFound('Helpdesk ticket not found');
    if (isRequester) {
      let reopenAvailability = null;
      if (ticket.status === 'resolved') {
        try {
          const config = await configService.getConfig({ companyId });
          reopenAvailability = requesterReopenAvailability({ ticket, config, at: now() });
        } catch {
          // Ticket history remains readable if policy lookup is temporarily
          // unavailable; reopening stays hidden until eligibility is known.
          reopenAvailability = requesterReopenAvailability({ ticket, config: null, at: now() });
        }
      }
      return serializeHelpdeskEmployeeTicketDetails(ticket, {
        queueName: queue.name,
        reopenAvailability,
      });
    }
    if (!canReadTicket({
      ticket,
      queue,
      viewerId,
      access: { canReadOwn: false, canReadQueue },
    })) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }
    return serializeHelpdeskAgentTicketDetails(ticket, { queueName: queue.name });
  };

  const createTicket = async ({ companyId, requesterId, input = {} } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(requesterId);
    const normalized = validateHelpdeskTicketCreateInput(input);
    const config = await configService.getConfig({ companyId });
    if (!config.enabled || !config.allowEmployeeTickets) {
      throw ApiError.forbidden('Employee Helpdesk tickets are not enabled');
    }

    const queue = await QueueModel.findOne({
      _id: normalized.queueId,
      companyId,
      enabled: true,
    }).lean();
    if (!queue) throw ApiError.badRequest('The selected queue is not available');

    const category = (queue.categories || []).find(
      (item) => idString(item._id).toLowerCase() === normalized.categoryId.toLowerCase(),
    );
    if (!category || category.enabled === false) {
      throw ApiError.badRequest('The selected category is not available in this queue');
    }

    if (normalized.confidential && (!config.confidentialTicketsEnabled || !queue.confidentiality?.enabled)) {
      throw ApiError.badRequest('Confidential tickets are not enabled for this queue');
    }

    const createdAtValue = now();
    const createdAt = createdAtValue instanceof Date
      ? new Date(createdAtValue.getTime())
      : new Date(createdAtValue);
    if (Number.isNaN(createdAt.getTime())) {
      throw ApiError.unavailable('A trusted Helpdesk ticket timestamp is unavailable.');
    }
    const priority = config.defaultPriority || 'normal';
    const sla = await slaService.initializeTicketSla({
      companyId,
      queueId: queue._id,
      requesterId,
      priority,
      createdAt,
    });
    const ticketNumber = await nextHelpdeskTicketNumber(companyId, { SequenceModel });
    const creationNotificationAppend = notificationIntentsEnabled
      ? buildHelpdeskTicketNotificationAppend({
        ticket: {},
        eventTypes: ['TICKET_CREATED'],
        at: createdAt,
      })
      : null;
    const ticket = await TicketModel.create({
      companyId,
      user: requesterId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      ticketNumber,
      ...(creationNotificationAppend
        ? buildHelpdeskTicketNotificationCreateFields(creationNotificationAppend)
        : {}),
      queueId: queue._id,
      categoryId: category._id,
      categoryName: category.name,
      // The legacy-compatible field is deliberately not an organizational Department.
      category: 'OTHER',
      subject: normalized.subject,
      message: normalized.description,
      requestedPriority: normalized.requestedPriority,
      assignedTo: null,
      priority,
      status: 'open',
      isConfidential: normalized.confidential,
      createdAt,
      ...(sla ? { sla } : {}),
    });

    return serializeHelpdeskTicket(ticket);
  };

  const updateStatus = async ({ companyId, actorId, ticketNumber, status } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const { ticket, queue } = await getMutationContext({ companyId, actorId, ticketNumber });
    const nextStatus = validateHelpdeskStatusTransition({
      currentStatus: ticket.status,
      nextStatus: status,
    });
    if (nextStatus === 'assigned') {
      const assignedAgentId = idString(ticket.assignedTo);
      if (!assignedAgentId || !includesId(queue.agents, assignedAgentId)
        || (ticket.isConfidential === true
          && !includesId(queue.confidentiality?.agentIds, assignedAgentId))) {
        throw ApiError.conflict('Assign the ticket to an eligible queue agent before marking it assigned');
      }
      const activeAssignee = await UserModel.findOne({
        _id: assignedAgentId,
        companyId,
        status: 'ACTIVE',
      }).select('_id').lean();
      if (!activeAssignee) {
        throw ApiError.conflict('Assign the ticket to an active queue agent before marking it assigned');
      }
    }

    const update = { status: nextStatus };
    if (ticket.status === 'assigned' && nextStatus === 'open') {
      // Returning an active assignment to the open queue also releases its agent.
      update.assignedTo = null;
    }
    const transitionAt = dateValue(now());
    if (!transitionAt) throw ApiError.unavailable('A trusted Helpdesk timestamp is unavailable.');
    const sla = ticket.sla
      ? await slaService.applyStatusTransition({
        companyId,
        ticket,
        fromStatus: ticket.status,
        toStatus: nextStatus,
        at: transitionAt,
      })
      : null;
    const statusEvent = nextStatus === 'resolved'
      ? 'TICKET_RESOLVED'
      : ticket.status === 'resolved' && nextStatus === 'in_progress'
        ? 'TICKET_REOPENED_BY_STAFF'
        : ticket.status === 'resolved' && nextStatus === 'closed'
          ? 'TICKET_CLOSED'
          : 'TICKET_STATUS_CHANGED';
    const lifecycleEventType = nextStatus === 'resolved'
      ? 'RESOLVED'
      : ticket.status === 'resolved' && nextStatus === 'in_progress'
        ? 'STAFF_REOPENED'
        : ticket.status === 'resolved' && nextStatus === 'closed'
          ? 'STAFF_CLOSED'
          : null;
    const result = await commitConditionalUpdate({
      companyId,
      actorId,
      ticketNumber,
      ticket,
      update: ({ ticket: currentTicket, validation }) => {
        const patch = { ...update, ...(sla ? { sla } : {}) };
        if (nextStatus === 'resolved') {
          const config = validation.tenantConfig || {};
          const reopenWindowHours = Number(config.reopenWindowHours) || HELPDESK_REOPEN_WINDOW_DEFAULT_HOURS;
          const autoCloseDelayHours = Number(config.autoCloseDelayHours) || HELPDESK_AUTO_CLOSE_DELAY_DEFAULT_HOURS;
          patch.resolvedAt = transitionAt;
          patch.resolvedBy = actorId;
          patch.resolutionCycle = (Number(currentTicket.resolutionCycle) || 0) + 1;
          patch.reopenUntilAt = addHours(transitionAt, reopenWindowHours);
          patch.autoCloseAt = config.autoCloseEnabled === true
            ? addHours(transitionAt, autoCloseDelayHours)
            : null;
          patch.reopenedAt = null;
          patch.reopenedBy = null;
          patch.reopenReason = null;
          patch.resolutionConfirmedAt = null;
          patch.resolutionConfirmedBy = null;
          patch.closedAt = null;
          patch.closedBy = null;
          patch.closureReason = null;
        } else if (ticket.status === 'resolved' && nextStatus === 'in_progress') {
          patch.reopenedAt = transitionAt;
          patch.reopenedBy = actorId;
          patch.reopenReason = null;
          patch.autoCloseAt = null;
        } else if (nextStatus === 'closed') {
          patch.closedAt = transitionAt;
          patch.closedBy = actorId;
          patch.closureReason = 'STAFF_CLOSED';
          patch.autoCloseAt = null;
        }
        return patch;
      },
      notificationEvents: [
        statusEvent,
        ...diffHelpdeskSlaNotificationEvents(ticket.sla, sla),
      ],
      lifecycleEvent: lifecycleEventType
        ? ({ ticket: currentTicket, update: patch }) => ({
          eventType: lifecycleEventType,
          actorType: 'USER',
          actorId,
          fromStatus: currentTicket.status,
          toStatus: nextStatus,
          occurredAt: transitionAt,
          resolutionCycle: patch.resolutionCycle ?? currentTicket.resolutionCycle ?? 0,
          slaSnapshot: {
            before: snapshotHelpdeskSla(currentTicket.sla),
            after: snapshotHelpdeskSla(patch.sla || currentTicket.sla),
          },
        })
        : null,
      includePriority: true,
      includeSlaVersion: Boolean(ticket.sla),
      validateInTransaction: async ({ ticket: currentTicket, queue: currentQueue, session }) => {
        const validation = {};
        if (nextStatus === 'resolved') {
          validation.tenantConfig = await readConfigInTransaction({ companyId, session });
        }
        if (nextStatus !== 'assigned') return validation;
        const assignedAgentId = idString(currentTicket.assignedTo);
        if (!assignedAgentId || !includesId(currentQueue.agents, assignedAgentId)
          || (currentTicket.isConfidential === true
            && !includesId(currentQueue.confidentiality?.agentIds, assignedAgentId))) {
          throw ApiError.conflict('Assign the ticket to an eligible queue agent before marking it assigned');
        }
        let activeQuery = UserModel.findOne({
          _id: assignedAgentId,
          companyId,
          status: 'ACTIVE',
        });
        activeQuery = withSession(activeQuery, session);
        const activeAssignee = await activeQuery.select('_id').lean();
        if (!activeAssignee) {
          throw ApiError.conflict('Assign the ticket to an active queue agent before marking it assigned');
        }
        validation.fenceEntries = [{ queueId: currentQueue._id, userId: assignedAgentId }];
        return validation;
      },
    });
    return serializeHelpdeskAgentTicketDetails(result.updated, { queueName: result.queueName });
  };

  const getTenantTicketContext = async ({ companyId, ticketNumber, session }) => {
    const ticket = await findTicket(companyId, ticketNumber, session);
    if (!ticket) throw ApiError.notFound('Helpdesk ticket not found');
    const queue = await findQueue(companyId, ticket.queueId, session);
    if (!queue) throw ApiError.notFound('Helpdesk ticket not found');
    return { ticket, queue };
  };

  const getRequesterTicketContext = async ({ companyId, requesterId, ticketNumber, session }) => {
    const context = await getTenantTicketContext({ companyId, ticketNumber, session });
    if (idString(context.ticket.user) !== idString(requesterId)) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }
    return context;
  };

  const confirmResolution = async ({ companyId, requesterId, ticketNumber } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(requesterId);
    if (!TICKET_NUMBER.test(String(ticketNumber || ''))) throw ApiError.notFound('Helpdesk ticket not found');

    return transactionRunner(async (session) => {
      const { ticket } = await getRequesterTicketContext({ companyId, requesterId, ticketNumber, session });
      if (
        ticket.status === 'closed'
        && ticket.closureReason === 'REQUESTER_CONFIRMED'
        && idString(ticket.resolutionConfirmedBy) === idString(requesterId)
      ) {
        return { ...lifecycleTicketDto(ticket), idempotent: true };
      }
      if (ticket.status !== 'resolved') {
        throw ApiError.conflict('Only a resolved ticket can be confirmed.');
      }
      const confirmedAt = dateValue(now());
      if (!confirmedAt) throw ApiError.unavailable('A trusted Helpdesk timestamp is unavailable.');
      const sla = ticket.sla
        ? await slaService.applyStatusTransition({
          companyId,
          ticket,
          fromStatus: 'resolved',
          toStatus: 'closed',
          at: confirmedAt,
        })
        : null;
      const patch = {
        status: 'closed',
        closedAt: confirmedAt,
        closedBy: requesterId,
        closureReason: 'REQUESTER_CONFIRMED',
        resolutionConfirmedAt: confirmedAt,
        resolutionConfirmedBy: requesterId,
        autoCloseAt: null,
        ...(sla ? { sla } : {}),
      };
      const updated = await commitLifecycleUpdate({
        companyId,
        ticket,
        session,
        patch,
        eventType: 'REQUESTER_CONFIRMED_RESOLUTION',
        actorType: 'USER',
        actorId: requesterId,
        fromStatus: 'resolved',
        toStatus: 'closed',
        occurredAt: confirmedAt,
        resolutionCycle: ticket.resolutionCycle || 0,
        slaBefore: ticket.sla,
        slaAfter: sla || ticket.sla,
        notificationEvents: ['TICKET_RESOLUTION_CONFIRMED'],
      });
      return { ...lifecycleTicketDto(updated), idempotent: false };
    });
  };

  const reopenOwnTicket = async ({ companyId, requesterId, ticketNumber, reason } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(requesterId);
    const normalizedReason = normalizeHelpdeskReopenReason(reason);
    if (!TICKET_NUMBER.test(String(ticketNumber || ''))) throw ApiError.notFound('Helpdesk ticket not found');

    return transactionRunner(async (session) => {
      const { ticket } = await getRequesterTicketContext({ companyId, requesterId, ticketNumber, session });
      if (ticket.status !== 'resolved') {
        throw ApiError.conflict('Only a resolved ticket can be reopened.');
      }
      const config = await readConfigInTransaction({ companyId, session });
      if (config.allowEmployeeReopen === false) {
        throw ApiError.forbidden('Employee reopening is disabled for this tenant.');
      }
      const resolvedAt = dateValue(ticket.resolvedAt);
      if (!resolvedAt) {
        throw ApiError.conflict('This ticket has no recorded resolution time and cannot be reopened.');
      }
      const reopenedAt = dateValue(now());
      if (!reopenedAt) throw ApiError.unavailable('A trusted Helpdesk timestamp is unavailable.');
      const availability = requesterReopenAvailability({ ticket, config, at: reopenedAt });
      const reopenUntilAt = availability.reopenUntilAt;
      if (!availability.canReopen) {
        throw ApiError.conflict('The Helpdesk reopening window has expired.');
      }
      const sla = ticket.sla
        ? await slaService.applyStatusTransition({
          companyId,
          ticket,
          fromStatus: 'resolved',
          toStatus: 'in_progress',
          at: reopenedAt,
        })
        : null;
      const patch = {
        status: 'in_progress',
        reopenUntilAt,
        reopenedAt,
        reopenedBy: requesterId,
        reopenReason: normalizedReason,
        autoCloseAt: null,
        ...(sla ? { sla } : {}),
      };
      const updated = await commitLifecycleUpdate({
        companyId,
        ticket,
        session,
        patch,
        eventType: 'REQUESTER_REOPENED',
        actorType: 'USER',
        actorId: requesterId,
        fromStatus: 'resolved',
        toStatus: 'in_progress',
        occurredAt: reopenedAt,
        reason: normalizedReason,
        resolutionCycle: ticket.resolutionCycle || 0,
        slaBefore: ticket.sla,
        slaAfter: sla || ticket.sla,
        notificationEvents: ['TICKET_REOPENED_BY_REQUESTER'],
      });
      return lifecycleTicketDto(updated);
    });
  };

  const submitFeedback = async ({ companyId, requesterId, ticketNumber, rating, comment } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(requesterId);
    const feedback = normalizeHelpdeskFeedback({ rating, comment });
    if (!TICKET_NUMBER.test(String(ticketNumber || ''))) throw ApiError.notFound('Helpdesk ticket not found');

    return transactionRunner(async (session) => {
      const { ticket } = await getRequesterTicketContext({ companyId, requesterId, ticketNumber, session });
      if (!['resolved', 'closed'].includes(String(ticket.status || '').toLowerCase())) {
        throw ApiError.conflict('Feedback is available only after ticket resolution.');
      }
      if (ticket.feedback) throw ApiError.conflict('Feedback has already been submitted for this ticket.');
      const submittedAt = dateValue(now());
      if (!submittedAt) throw ApiError.unavailable('A trusted Helpdesk timestamp is unavailable.');
      const feedbackRecord = {
        ...feedback,
        submittedAt,
        submittedBy: requesterId,
      };
      const updated = await commitLifecycleUpdate({
        companyId,
        ticket,
        session,
        patch: { feedback: feedbackRecord },
        eventType: 'FEEDBACK_SUBMITTED',
        actorType: 'USER',
        actorId: requesterId,
        fromStatus: ticket.status,
        toStatus: ticket.status,
        occurredAt: submittedAt,
        resolutionCycle: ticket.resolutionCycle || 0,
        slaBefore: ticket.sla,
        slaAfter: ticket.sla,
        notificationEvents: ['TICKET_FEEDBACK_SUBMITTED'],
        extraFilter: { $or: [{ feedback: { $exists: false } }, { feedback: null }] },
      });
      return serializeHelpdeskFeedback(updated.feedback);
    });
  };

  const getFeedback = async ({
    companyId,
    viewerId,
    ticketNumber,
    canReadOwn = false,
    canReadQueue = false,
  } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(viewerId);
    const ticket = await findTicket(companyId, ticketNumber);
    if (!ticket) throw ApiError.notFound('Helpdesk ticket not found');
    const queue = await findQueue(companyId, ticket.queueId);
    if (!queue) throw ApiError.notFound('Helpdesk ticket not found');
    const isRequester = canReadOwn === true && idString(ticket.user) === idString(viewerId);
    if (!isRequester && !canReadTicket({
      ticket,
      queue,
      viewerId,
      access: { canReadOwn: false, canReadQueue },
    })) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }
    return {
      ticketNumber: ticket.ticketNumber,
      feedback: serializeHelpdeskFeedback(ticket.feedback),
    };
  };

  const closeAutoDueTicket = async ({ candidate, at }) => transactionRunner(async (session) => {
    const { ticket } = await getTenantTicketContext({
      companyId: candidate.companyId,
      ticketNumber: candidate.ticketNumber,
      session,
    });
    if (
      idString(ticket._id) !== idString(candidate._id)
      || ticket.status !== 'resolved'
      || !dateValue(ticket.autoCloseAt)
      || dateValue(ticket.autoCloseAt).getTime() > at.getTime()
    ) return { closed: false, skipped: true };

    const config = await readConfigInTransaction({ companyId: ticket.companyId, session });
    if (config.autoCloseEnabled !== true) {
      const filter = {
        _id: ticket._id,
        companyId: ticket.companyId,
        ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
        user: ticket.user,
        status: 'resolved',
        autoCloseAt: ticket.autoCloseAt,
        lifecycleSequence: lifecycleCounterFilter(ticket.lifecycleSequence),
      };
      const query = TicketModel.findOneAndUpdate(
        filter,
        { $set: { autoCloseAt: null } },
        { returnDocument: 'after', runValidators: true, session },
      );
      await query;
      return { closed: false, skipped: true, policyDisabled: true };
    }

    const sla = ticket.sla
      ? await slaService.applyStatusTransition({
        companyId: ticket.companyId,
        ticket,
        fromStatus: 'resolved',
        toStatus: 'closed',
        at,
      })
      : null;
    const patch = {
      status: 'closed',
      closedAt: at,
      closedBy: null,
      closureReason: 'AUTO_CLOSED',
      autoCloseAt: null,
      ...(sla ? { sla } : {}),
    };
    const updated = await commitLifecycleUpdate({
      companyId: ticket.companyId,
      ticket,
      session,
      patch,
      eventType: 'AUTO_CLOSED',
      actorType: 'SYSTEM',
      actorId: null,
      fromStatus: 'resolved',
      toStatus: 'closed',
      occurredAt: at,
      resolutionCycle: ticket.resolutionCycle || 0,
      slaBefore: ticket.sla,
      slaAfter: sla || ticket.sla,
      notificationEvents: ['TICKET_AUTO_CLOSED'],
      extraFilter: { autoCloseAt: ticket.autoCloseAt },
    });
    return { closed: Boolean(updated), skipped: !updated };
  });

  const reconcileDueAutoClosures = async ({ limit = HELPDESK_AUTO_CLOSE_BATCH_MAX, now: at } = {}) => {
    const when = dateValue(at) || dateValue(now());
    if (!when) throw ApiError.unavailable('A trusted Helpdesk timestamp is unavailable.');
    const batchSize = Number.isInteger(Number(limit))
      ? Math.min(HELPDESK_AUTO_CLOSE_BATCH_MAX, Math.max(1, Number(limit)))
      : HELPDESK_AUTO_CLOSE_BATCH_MAX;
    let candidates = TicketModel.find({
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      status: 'resolved',
      autoCloseAt: { $type: 'date', $lte: when },
    });
    if (typeof candidates?.select === 'function') {
      candidates = candidates.select(
        '_id companyId user queueId ticketNumber status lifecycleSequence resolutionCycle resolvedAt autoCloseAt sla ' +
          'notificationSequence notificationProcessedSequence notificationEvents notificationGap',
      );
    }
    if (typeof candidates?.sort === 'function') candidates = candidates.sort({ autoCloseAt: 1, companyId: 1, _id: 1 });
    if (typeof candidates?.limit === 'function') candidates = candidates.limit(batchSize);
    if (typeof candidates?.lean === 'function') candidates = candidates.lean();
    const rows = await candidates;
    const summary = { inspected: (rows || []).length, closed: 0, skipped: 0, failed: 0, limit: batchSize };
    for (const candidate of rows || []) {
      try {
        const result = await closeAutoDueTicket({ candidate, at: when });
        if (result.closed) summary.closed += 1;
        else summary.skipped += 1;
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  };

  const updatePriority = async ({ companyId, actorId, ticketNumber, priority } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const { ticket, queue } = await getMutationContext({ companyId, actorId, ticketNumber });
    if (isHelpdeskTerminalStatus(ticket.status)) {
      throw ApiError.conflict('A closed or cancelled ticket cannot change priority');
    }

    const nextPriority = validateHelpdeskPriority(priority);
    if (nextPriority === ticket.priority) {
      return serializeHelpdeskAgentTicketDetails(ticket, { queueName: queue.name });
    }

    const priorityAt = now();
    const sla = ticket.sla
      ? await slaService.applyPriorityChange({
        companyId,
        ticket,
        priority: nextPriority,
        at: priorityAt,
      })
      : null;
    const result = await commitConditionalUpdate({
      companyId,
      actorId,
      ticketNumber,
      ticket,
      update: { priority: nextPriority, ...(sla ? { sla } : {}) },
      notificationEvents: diffHelpdeskSlaNotificationEvents(ticket.sla, sla),
      includePriority: true,
      includeSlaVersion: Boolean(ticket.sla),
    });
    return serializeHelpdeskAgentTicketDetails(result.updated, { queueName: result.queueName });
  };

  const assignTicket = async ({ companyId, actorId, ticketNumber, assigneeId } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const { ticket, queue } = await getMutationContext({
      companyId,
      actorId,
      ticketNumber,
      managersOnly: true,
    });
    if (isHelpdeskTerminalStatus(ticket.status)) {
      throw ApiError.conflict('A closed or cancelled ticket cannot be assigned');
    }
    if (!OBJECT_ID.test(String(assigneeId || ''))) {
      throw ApiError.badRequest('assigneeId must be a valid identifier');
    }
    if (!includesId(queue.agents, assigneeId)) {
      throw ApiError.badRequest('Assignee must be an explicitly assigned queue agent');
    }
    if (ticket.isConfidential === true && !includesId(queue.confidentiality?.agentIds, assigneeId)) {
      throw ApiError.badRequest('Confidential tickets can only be assigned to a restricted queue agent');
    }

    const activeAssignee = await UserModel.findOne({
      _id: assigneeId,
      companyId,
      status: 'ACTIVE',
    }).select('_id').lean();
    if (!activeAssignee) throw ApiError.badRequest('Assignee must be active in this tenant');

    const nextStatus = ticket.status === 'open' ? 'assigned' : ticket.status;
    if (nextStatus !== ticket.status && !canTransitionHelpdeskTicket(ticket.status, nextStatus)) {
      throw ApiError.conflict('The ticket cannot move to the assigned state');
    }
    const assignmentChanged = idString(ticket.assignedTo) !== idString(activeAssignee._id)
      || nextStatus !== ticket.status;
    if (!assignmentChanged) {
      return serializeHelpdeskAgentTicketDetails(ticket, { queueName: queue.name });
    }
    const result = await commitConditionalUpdate({
      companyId,
      actorId,
      ticketNumber,
      ticket,
      managersOnly: true,
      update: { assignedTo: activeAssignee._id, status: nextStatus },
      notificationEvents: [ticket.assignedTo ? 'TICKET_REASSIGNED' : 'TICKET_ASSIGNED'],
      validateInTransaction: async ({ ticket: currentTicket, queue: currentQueue, session }) => {
        if (!includesId(currentQueue.agents, assigneeId)) {
          throw ApiError.badRequest('Assignee must be an explicitly assigned queue agent');
        }
        if (currentTicket.isConfidential === true
          && !includesId(currentQueue.confidentiality?.agentIds, assigneeId)) {
          throw ApiError.badRequest('Confidential tickets can only be assigned to a restricted queue agent');
        }
        let assigneeQuery = UserModel.findOne({
          _id: assigneeId,
          companyId,
          status: 'ACTIVE',
        });
        assigneeQuery = withSession(assigneeQuery, session);
        const currentAssignee = await assigneeQuery.select('_id').lean();
        if (!currentAssignee) throw ApiError.badRequest('Assignee must be active in this tenant');
        return { fenceEntries: [{ queueId: currentQueue._id, userId: assigneeId }] };
      },
    });
    return serializeHelpdeskAgentTicketDetails(result.updated, { queueName: result.queueName });
  };

  const claimTicket = async ({ companyId, actorId, ticketNumber } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const { ticket, queue } = await getMutationContext({ companyId, actorId, ticketNumber });
    assertQueueAgent({ queue, actorId });
    if (ticket.isConfidential === true && !hasConfidentialAgentAccess({ queue, actorId })) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }
    if (ticket.status !== 'open' || ticket.assignedTo) {
      throw ApiError.conflict('Only an open, unassigned ticket can be claimed');
    }

    const result = await commitConditionalUpdate({
      companyId,
      actorId,
      ticketNumber,
      ticket,
      agentsOnly: true,
      update: { assignedTo: actorId, status: 'assigned' },
      notificationEvents: ['TICKET_CLAIMED'],
      validateInTransaction: async ({ ticket: currentTicket }) => {
        if (currentTicket.status !== 'open' || currentTicket.assignedTo) {
          throw ApiError.conflict('The ticket was claimed or changed by another agent');
        }
        return {};
      },
    });
    return serializeHelpdeskAgentTicketDetails(result.updated, { queueName: result.queueName });
  };

  const transferTicket = async ({
    companyId,
    actorId,
    ticketNumber,
    input = {},
  } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const normalized = validateHelpdeskTransferInput(input);
    const { ticket, queue: sourceQueue } = await getMutationContext({
      companyId,
      actorId,
      ticketNumber,
      managersOnly: true,
    });
    if (isHelpdeskTerminalStatus(ticket.status)) {
      throw ApiError.conflict('A closed or cancelled ticket cannot be transferred');
    }
    if (idString(sourceQueue._id).toLowerCase() === normalized.queueId.toLowerCase()) {
      throw ApiError.conflict('The ticket is already in that queue');
    }

    const targetQueue = await findQueue(companyId, normalized.queueId);
    if (!targetQueue || targetQueue.enabled === false) {
      throw ApiError.notFound('Destination Helpdesk queue not found');
    }
    assertQueueStaff({ queue: targetQueue, actorId, managersOnly: true });
    if (ticket.isConfidential === true) {
      if (!hasConfidentialAgentAccess({ queue: sourceQueue, actorId })
        || !targetQueue.confidentiality?.enabled
        || !hasConfidentialAgentAccess({ queue: targetQueue, actorId })) {
        throw ApiError.notFound('Helpdesk ticket not found');
      }
      const config = await configService.getConfig({ companyId });
      if (!config.confidentialTicketsEnabled) {
        throw ApiError.conflict('Confidential ticket transfers are not enabled for this tenant');
      }
    }

    const category = (targetQueue.categories || []).find(
      (item) => idString(item._id).toLowerCase() === normalized.categoryId.toLowerCase(),
    );
    if (!category || category.enabled === false) {
      throw ApiError.badRequest('The selected category is not available in the destination queue');
    }

    const assigneeId = normalized.assigneeId || idString(ticket.assignedTo) || null;
    let activeAssignee = null;
    if (assigneeId) {
      if (!includesId(targetQueue.agents, assigneeId)) {
        throw ApiError.badRequest('Destination assignee must be an explicitly assigned queue agent');
      }
      if (ticket.isConfidential === true
        && !includesId(targetQueue.confidentiality?.agentIds, assigneeId)) {
        throw ApiError.badRequest('Confidential tickets can only be assigned to a restricted destination agent');
      }
      activeAssignee = await UserModel.findOne({
        _id: assigneeId,
        companyId,
        status: 'ACTIVE',
      }).select('_id').lean();
      if (!activeAssignee) {
        throw ApiError.conflict('Assign the ticket to an active destination-queue agent before transferring');
      }
    } else if (ticket.status === 'assigned') {
      throw ApiError.conflict('Assign the ticket to an active destination-queue agent before transferring');
    }

    const nextStatus = ticket.status === 'open' && activeAssignee ? 'assigned' : ticket.status;
    if (nextStatus !== ticket.status && !canTransitionHelpdeskTicket(ticket.status, nextStatus)) {
      throw ApiError.conflict('The ticket cannot move to the assigned state');
    }
    const transferAt = now();
    const sla = ticket.sla
      ? await slaService.applyQueueTransfer({
        companyId,
        ticket,
        queueId: targetQueue._id,
        priority: ticket.priority,
        at: transferAt,
      })
      : null;
    const result = await commitConditionalUpdate({
      companyId,
      actorId,
      ticketNumber,
      ticket,
      managersOnly: true,
      includePriority: true,
      includeSlaVersion: Boolean(ticket.sla),
      update: ({ validation }) => ({
        ...validation.update,
        ...(sla ? { sla } : {}),
      }),
      notificationEvents: [
        'TICKET_TRANSFERRED',
        ...diffHelpdeskSlaNotificationEvents(ticket.sla, sla),
      ],
      validateInTransaction: async ({ ticket: currentTicket, queue: currentSourceQueue, session }) => {
        const currentTargetQueue = await findQueue(companyId, normalized.queueId, session);
        if (!currentTargetQueue || currentTargetQueue.enabled === false) {
          throw ApiError.notFound('Destination Helpdesk queue not found');
        }
        assertQueueStaff({ queue: currentTargetQueue, actorId, managersOnly: true });
        if (idString(currentSourceQueue._id).toLowerCase() === normalized.queueId.toLowerCase()) {
          throw ApiError.conflict('The ticket is already in that queue');
        }
        if (currentTicket.isConfidential === true) {
          if (!hasConfidentialAgentAccess({ queue: currentSourceQueue, actorId })
            || !currentTargetQueue.confidentiality?.enabled
            || !hasConfidentialAgentAccess({ queue: currentTargetQueue, actorId })) {
            throw ApiError.notFound('Helpdesk ticket not found');
          }
          const config = await readConfigInTransaction({ companyId, session });
          if (!config.confidentialTicketsEnabled) {
            throw ApiError.conflict('Confidential ticket transfers are not enabled for this tenant');
          }
        }

        const currentCategory = (currentTargetQueue.categories || []).find(
          (item) => idString(item._id).toLowerCase() === normalized.categoryId.toLowerCase(),
        );
        if (!currentCategory || currentCategory.enabled === false) {
          throw ApiError.badRequest('The selected category is not available in the destination queue');
        }

        const currentAssigneeId = normalized.assigneeId || idString(currentTicket.assignedTo) || null;
        let currentAssignee = null;
        const fenceEntries = [{ queueId: currentTargetQueue._id, userId: actorId }];
        if (currentAssigneeId) {
          if (!includesId(currentTargetQueue.agents, currentAssigneeId)) {
            throw ApiError.badRequest('Destination assignee must be an explicitly assigned queue agent');
          }
          if (currentTicket.isConfidential === true
            && !includesId(currentTargetQueue.confidentiality?.agentIds, currentAssigneeId)) {
            throw ApiError.badRequest('Confidential tickets can only be assigned to a restricted destination agent');
          }
          let assigneeQuery = UserModel.findOne({
            _id: currentAssigneeId,
            companyId,
            status: 'ACTIVE',
          });
          assigneeQuery = withSession(assigneeQuery, session);
          currentAssignee = await assigneeQuery.select('_id').lean();
          if (!currentAssignee) {
            throw ApiError.conflict('Assign the ticket to an active destination-queue agent before transferring');
          }
          fenceEntries.push({ queueId: currentTargetQueue._id, userId: currentAssigneeId });
        } else if (currentTicket.status === 'assigned') {
          throw ApiError.conflict('Assign the ticket to an active destination-queue agent before transferring');
        }

        const currentNextStatus = currentTicket.status === 'open' && currentAssignee
          ? 'assigned'
          : currentTicket.status;
        if (currentNextStatus !== currentTicket.status
          && !canTransitionHelpdeskTicket(currentTicket.status, currentNextStatus)) {
          throw ApiError.conflict('The ticket cannot move to the assigned state');
        }
        return {
          queueName: currentTargetQueue.name,
          fenceEntries,
          update: {
            queueId: currentTargetQueue._id,
            categoryId: currentCategory._id,
            categoryName: currentCategory.name,
            assignedTo: currentAssignee?._id || null,
            status: currentNextStatus,
          },
        };
      },
    });
    return serializeHelpdeskAgentTicketDetails(result.updated, { queueName: result.queueName });
  };

  const cancelOwnTicket = async ({ companyId, requesterId, ticketNumber } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(requesterId);
    if (!TICKET_NUMBER.test(String(ticketNumber || ''))) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }

    const activeFilter = {
      companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      user: requesterId,
      ticketNumber,
      status: { $in: ['open', 'assigned'] },
    };
    const currentQuery = TicketModel.findOne(activeFilter);
    const current = await (typeof currentQuery?.select === 'function'
      ? currentQuery.select(
        '_id companyId user queueId ticketNumber status priority sla ' +
          'notificationSequence notificationProcessedSequence notificationEvents notificationGap',
      ).lean()
      : currentQuery);
    if (current) {
      const cancelledAt = now();
      const sla = current.sla
        ? await slaService.applyStatusTransition({
          companyId,
          ticket: current,
          fromStatus: current.status,
          toStatus: 'cancelled',
          at: cancelledAt,
        })
        : null;
      const cancellationFilter = {
        _id: current._id,
        companyId,
        ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
        user: requesterId,
        ticketNumber,
        status: { $in: ['open', 'assigned'] },
        ...(current.sla
          ? { 'sla.version': current.sla.version ?? { $exists: false } }
          : {}),
      };
      const notificationAppend = notificationIntentsEnabled
        ? buildHelpdeskTicketNotificationAppend({
          ticket: current,
          eventTypes: [
            'TICKET_CANCELLED',
            ...diffHelpdeskSlaNotificationEvents(current.sla, sla),
          ],
          at: cancelledAt,
        })
        : null;
      const cancellationUpdate = { $set: { status: 'cancelled', ...(sla ? { sla } : {}) } };
      if (notificationAppend) {
        Object.assign(cancellationFilter, addHelpdeskNotificationSequenceFilter({}, current));
        Object.assign(cancellationUpdate, notificationAppend.update);
        cancellationUpdate.$set = {
          ...cancellationUpdate.$set,
          ...(notificationAppend.update.$set || {}),
        };
      }
      const updated = await TicketModel.findOneAndUpdate(
        cancellationFilter,
        cancellationUpdate,
        { returnDocument: 'after', runValidators: true },
      );
      if (updated) return serializeHelpdeskTicket(updated);
    }

    const existingOwnedTicket = await TicketModel.findOne({
      companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      user: requesterId,
      ticketNumber,
    }).select('status').lean();
    if (!existingOwnedTicket) throw ApiError.notFound('Helpdesk ticket not found');
    throw ApiError.conflict('Only an open or assigned ticket can be cancelled by its requester');
  };

  return {
    listMine,
    listQueueTickets,
    listAssignedToMe,
    listUnassignedTickets,
    getTicket,
    createTicket,
    claimTicket,
    updateStatus,
    confirmResolution,
    reopenOwnTicket,
    submitFeedback,
    getFeedback,
    reconcileDueAutoClosures,
    updatePriority,
    assignTicket,
    transferTicket,
    cancelOwnTicket,
  };
};

export const _test = { includesId };
