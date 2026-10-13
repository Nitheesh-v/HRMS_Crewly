import ApiError from '../../utils/ApiError.js';
import HelpdeskTicket from '../../models/HelpdeskTicket.js';
import HelpdeskQueue from '../../models/HelpdeskQueue.js';
import User from '../../models/User.js';
import TenantSequence from '../../models/TenantSequence.js';
import { SUPPORT_TICKET_KIND } from '../../utils/supportTicketKinds.js';
import { nextHelpdeskTicketNumber } from './helpdeskTicketNumbers.js';
import { helpdeskTenantConfigService } from './helpdeskTenantConfigService.js';
import {
  HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH,
  normalizeHelpdeskTicketListQuery,
  validateHelpdeskTicketCreateInput,
  validateHelpdeskPriority,
  validateHelpdeskStatusTransition,
} from './helpdeskRules.js';
import {
  serializeHelpdeskEmployeeTicketDetails,
  serializeHelpdeskEmployeeTicketListItem,
  serializeHelpdeskTicket,
} from './helpdeskDto.js';
import { boundedSearchTerm } from '../../utils/searchInput.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const TICKET_NUMBER = /^HD-\d{6,}$/;
const MAX_LIST_LIMIT = 100;

const idString = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const ensureCompanyId = (companyId) => {
  if (!companyId) throw ApiError.forbidden('A tenant is required');
};

const ensureActorId = (actorId) => {
  if (!actorId) throw ApiError.unauthorized('An authenticated user is required');
};

const includesId = (values, id) =>
  (values || []).some((value) => idString(value).toLowerCase() === String(id || '').toLowerCase());

const boundedLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, MAX_LIST_LIMIT);
};

export const helpdeskTicketService = (deps = {}) => {
  const TicketModel = deps.TicketModel || HelpdeskTicket;
  const QueueModel = deps.QueueModel || HelpdeskQueue;
  const UserModel = deps.UserModel || User;
  const SequenceModel = deps.SequenceModel || TenantSequence;
  const configService = deps.configService || helpdeskTenantConfigService({
    ConfigModel: deps.ConfigModel,
  });

  const findQueue = async (companyId, queueId) => {
    if (!OBJECT_ID.test(String(queueId || ''))) return null;
    return QueueModel.findOne({ _id: queueId, companyId }).lean();
  };

  const findTicket = async (companyId, ticketNumber) => {
    if (!TICKET_NUMBER.test(String(ticketNumber || ''))) return null;
    return TicketModel.findOne({
      companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      ticketNumber,
    });
  };

  const canReadTicket = ({ ticket, queue, viewerId, access = {} }) => {
    const viewer = idString(viewerId);
    if (access.canReadOwn === true && idString(ticket.user) === viewer) return true;
    if (access.canReadQueue !== true) return false;

    if (ticket.isConfidential === true) {
      const hasRestrictedAgentAccess = includesId(queue.confidentiality?.agentIds, viewer)
        && includesId(queue.agents, viewer);
      const hasReviewerAccess = includesId(queue.confidentiality?.reviewerIds, viewer);
      return hasRestrictedAgentAccess || hasReviewerAccess;
    }
    return includesId(queue.agents, viewer) || includesId(queue.managers, viewer);
  };

  const assertQueueStaff = ({ queue, actorId, managersOnly = false }) => {
    const actorIsManager = includesId(queue.managers, actorId);
    const actorIsAgent = includesId(queue.agents, actorId);
    if (managersOnly ? !actorIsManager : !(actorIsManager || actorIsAgent)) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }
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
            'isConfidential createdAt updatedAt',
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
    limit = 50,
    canReadQueue = false,
  } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(viewerId);
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
      queueId,
    };
    if (isConfidentialReviewer && !isQueueStaff) {
      filter.isConfidential = true;
    } else {
      const canReadAllConfidential = includesId(queue.confidentiality?.agentIds, viewerId)
        || isConfidentialReviewer;
      if (!canReadAllConfidential) {
        filter.$or = [
          { isConfidential: { $ne: true } },
          { user: viewerId },
        ];
      }
    }

    const tickets = await TicketModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(boundedLimit(limit))
      .lean();
    return (tickets || []).map(serializeHelpdeskTicket);
  };

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
    return serializeHelpdeskTicket(ticket);
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

    const ticketNumber = await nextHelpdeskTicketNumber(companyId, { SequenceModel });
    const ticket = await TicketModel.create({
      companyId,
      user: requesterId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      ticketNumber,
      queueId: queue._id,
      categoryId: category._id,
      categoryName: category.name,
      // The legacy-compatible field is deliberately not an organizational Department.
      category: 'OTHER',
      subject: normalized.subject,
      message: normalized.description,
      requestedPriority: normalized.requestedPriority,
      assignedTo: null,
      priority: config.defaultPriority || 'normal',
      status: 'open',
      isConfidential: normalized.confidential,
    });

    return serializeHelpdeskTicket(ticket);
  };

  const updateStatus = async ({ companyId, actorId, ticketNumber, status } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const ticket = await findTicket(companyId, ticketNumber);
    if (!ticket) throw ApiError.notFound('Helpdesk ticket not found');
    const queue = await findQueue(companyId, ticket.queueId);
    if (!queue) throw ApiError.notFound('Helpdesk ticket not found');
    assertQueueStaff({ queue, actorId });
    if (ticket.isConfidential === true
      && !includesId(queue.confidentiality?.agentIds, actorId)) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }

    const nextStatus = validateHelpdeskStatusTransition({
      currentStatus: ticket.status,
      nextStatus: status,
    });
    ticket.status = nextStatus;
    await ticket.save();
    return serializeHelpdeskTicket(ticket);
  };

  const updatePriority = async ({ companyId, actorId, ticketNumber, priority } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const ticket = await findTicket(companyId, ticketNumber);
    if (!ticket) throw ApiError.notFound('Helpdesk ticket not found');
    const queue = await findQueue(companyId, ticket.queueId);
    if (!queue) throw ApiError.notFound('Helpdesk ticket not found');
    assertQueueStaff({ queue, actorId });
    if (ticket.isConfidential === true
      && !includesId(queue.confidentiality?.agentIds, actorId)) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }

    const nextPriority = validateHelpdeskPriority(priority);
    ticket.priority = nextPriority;
    await ticket.save();
    return serializeHelpdeskTicket(ticket);
  };

  const assignTicket = async ({ companyId, actorId, ticketNumber, assigneeId } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(actorId);
    const ticket = await findTicket(companyId, ticketNumber);
    if (!ticket) throw ApiError.notFound('Helpdesk ticket not found');
    const queue = await findQueue(companyId, ticket.queueId);
    if (!queue) throw ApiError.notFound('Helpdesk ticket not found');
    assertQueueStaff({ queue, actorId, managersOnly: true });
    if (ticket.isConfidential === true
      && !includesId(queue.confidentiality?.agentIds, actorId)) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }
    if (!OBJECT_ID.test(String(assigneeId || ''))) {
      throw ApiError.badRequest('assigneeId must be a valid identifier');
    }
    if (ticket.isConfidential === true) {
      if (!includesId(queue.confidentiality?.agentIds, assigneeId)) {
        throw ApiError.badRequest('Confidential tickets can only be assigned to a restricted queue agent');
      }
    } else if (!includesId(queue.agents, assigneeId)) {
      throw ApiError.badRequest('Assignee must be an explicitly assigned queue agent');
    }

    const activeAssignee = await UserModel.findOne({
      _id: assigneeId,
      companyId,
      status: 'ACTIVE',
    }).select('_id').lean();
    if (!activeAssignee) throw ApiError.badRequest('Assignee must be active in this tenant');

    ticket.assignedTo = activeAssignee._id;
    if (ticket.status === 'open') ticket.status = 'assigned';
    await ticket.save();
    return serializeHelpdeskTicket(ticket);
  };

  const cancelOwnTicket = async ({ companyId, requesterId, ticketNumber } = {}) => {
    ensureCompanyId(companyId);
    ensureActorId(requesterId);
    if (!TICKET_NUMBER.test(String(ticketNumber || ''))) {
      throw ApiError.notFound('Helpdesk ticket not found');
    }

    const ticket = await TicketModel.findOneAndUpdate(
      {
        companyId,
        ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
        user: requesterId,
        ticketNumber,
        status: { $in: ['open', 'assigned'] },
      },
      { $set: { status: 'cancelled' } },
      { returnDocument: 'after', runValidators: true },
    );
    if (ticket) return serializeHelpdeskTicket(ticket);

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
    getTicket,
    createTicket,
    updateStatus,
    updatePriority,
    assignTicket,
    cancelOwnTicket,
  };
};

export const _test = { boundedLimit, includesId };
