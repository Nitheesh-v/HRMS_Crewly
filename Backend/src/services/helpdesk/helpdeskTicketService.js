import ApiError from '../../utils/ApiError.js';
import HelpdeskAuthorizationFence from '../../models/HelpdeskAuthorizationFence.js';
import HelpdeskTicket from '../../models/HelpdeskTicket.js';
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

export const helpdeskTicketService = (deps = {}) => {
  const TicketModel = deps.TicketModel || HelpdeskTicket;
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
    const updatePatch = typeof update === 'function'
      ? await update({ ticket: currentTicket, queue: currentQueue, validation, session })
      : update;
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
    return { updated, queueName: validation.queueName || currentQueue.name };
  });

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
      return serializeHelpdeskEmployeeTicketDetails(ticket, { queueName: queue.name });
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
    const transitionAt = now();
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
      : 'TICKET_STATUS_CHANGED';
    const result = await commitConditionalUpdate({
      companyId,
      actorId,
      ticketNumber,
      ticket,
      update: { ...update, ...(sla ? { sla } : {}) },
      notificationEvents: [
        statusEvent,
        ...diffHelpdeskSlaNotificationEvents(ticket.sla, sla),
      ],
      includePriority: true,
      includeSlaVersion: Boolean(ticket.sla),
      validateInTransaction: async ({ ticket: currentTicket, queue: currentQueue, session }) => {
        if (nextStatus !== 'assigned') return {};
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
        return { fenceEntries: [{ queueId: currentQueue._id, userId: assignedAgentId }] };
      },
    });
    return serializeHelpdeskAgentTicketDetails(result.updated, { queueName: result.queueName });
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
    updatePriority,
    assignTicket,
    transferTicket,
    cancelOwnTicket,
  };
};

export const _test = { includesId };
