import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { hasPermission } from '../utils/permissionService.js';
import { assertNoClientIdentity } from '../services/helpdesk/helpdeskRules.js';
import { helpdeskTenantConfigService } from '../services/helpdesk/helpdeskTenantConfigService.js';
import { helpdeskQueueService } from '../services/helpdesk/helpdeskQueueService.js';
import { helpdeskTicketService } from '../services/helpdesk/helpdeskTicketService.js';

const configService = helpdeskTenantConfigService();
const queueService = helpdeskQueueService();
const ticketService = helpdeskTicketService({ configService });

const success = (res, data, status = 200, message = 'Helpdesk request completed', meta = null) =>
  res.status(status).json({
    success: true,
    message,
    data,
    ...(meta ? { meta } : {}),
  });

export const assertHelpdeskPermission = async (
  user,
  permission,
  permissionChecker = hasPermission,
) => {
  if (!user || !(await permissionChecker(user, permission))) {
    throw ApiError.forbidden('You do not have permission to use this Helpdesk operation');
  }
};

const assertBodyFields = (body = {}, allowed = []) => {
  assertNoClientIdentity(body);
  const unsupportedField = Object.keys(body).find((field) => !allowed.includes(field));
  if (unsupportedField) {
    throw ApiError.badRequest(`Unsupported Helpdesk field: ${unsupportedField}`);
  }
};

export const getConfig = asyncHandler(async (req, res) => {
  // Data from frontend - tenant identity is derived exclusively from authenticated middleware context.
  const companyId = req.companyId;
  // DB Logic - RBAC check and config access are limited to this authenticated tenant.
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_READ');
  const config = await configService.getConfig({ companyId });
  // Data to frontend - config DTO contains only allowlisted Helpdesk settings.
  return success(res, config, 200, 'Helpdesk configuration');
});

export const updateConfig = asyncHandler(async (req, res) => {
  // Data from frontend - actor and tenant come from authentication; body is settings only.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const input = req.body;
  // DB Logic - RBAC check precedes the tenant-scoped, whitelisted configuration update.
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_MANAGE');
  const config = await configService.updateConfig({ companyId, actorId, input });
  // Data to frontend - no internal config document is returned.
  return success(res, config, 200, 'Helpdesk configuration updated');
});

export const listAvailableQueues = asyncHandler(async (req, res) => {
  // Data from frontend - the tenant comes from authenticated middleware only.
  const companyId = req.companyId;
  // DB Logic - RBAC and fail-closed config reads gate this tenant's available queues.
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_READ');
  const config = await configService.getConfig({ companyId });
  const queues = config.enabled && config.allowEmployeeTickets
    ? await queueService.listAvailableQueues({ companyId })
    : [];
  // Data to frontend - only enabled tenant queues and enabled local categories are returned.
  return success(res, queues, 200, 'Available Helpdesk queues');
});

export const getAvailableQueue = asyncHandler(async (req, res) => {
  // Data from frontend - route id is a queue selector, never an authorization identity.
  const companyId = req.companyId;
  const queueId = req.params.queueId;
  // DB Logic - RBAC, config, and queue reads remain within this tenant.
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_READ');
  const config = await configService.getConfig({ companyId });
  if (!config.enabled || !config.allowEmployeeTickets) {
    throw ApiError.notFound('Helpdesk queue not found');
  }
  const queue = await queueService.getQueue({ companyId, queueId, administrative: false });
  // Data to frontend - categories are limited to this enabled queue.
  return success(res, queue, 200, 'Helpdesk queue');
});

export const listAdminQueues = asyncHandler(async (req, res) => {
  // Data from frontend - tenant identity is not accepted from query or body.
  const companyId = req.companyId;
  // DB Logic - RBAC check and administrative queue listing are tenant-scoped.
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_MANAGE');
  const queues = await queueService.listQueues({
    companyId,
    includeDisabled: true,
    administrative: true,
  });
  // Data to frontend - DTOs contain ids, not populated user or employee documents.
  return success(res, queues, 200, 'Helpdesk queues');
});

export const createQueue = asyncHandler(async (req, res) => {
  // Data from frontend - queue fields are validated; tenant and creator are not client supplied.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const input = req.body;
  // DB Logic - RBAC plus tenant-local names, categories, and membership users are checked.
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_MANAGE');
  const queue = await queueService.createQueue({ companyId, actorId, input });
  // Data to frontend - no full User documents are populated.
  return success(res, queue, 201, 'Helpdesk queue created');
});

export const updateQueue = asyncHandler(async (req, res) => {
  // Data from frontend - queue id selects a resource; tenant and actor are authenticated values.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const queueId = req.params.queueId;
  const input = req.body;
  // DB Logic - RBAC check and update use both the queue id and authenticated tenant.
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_MANAGE');
  const queue = await queueService.updateQueue({ companyId, actorId, queueId, input });
  // Data to frontend - only queue configuration and opaque member ids are returned.
  return success(res, queue, 200, 'Helpdesk queue updated');
});

export const listMyTickets = asyncHandler(async (req, res) => {
  // Data from frontend - filters are selectors only; requester identity comes from req.user._id.
  const companyId = req.companyId;
  const requesterId = req.user._id;
  const query = req.query;
  // DB Logic - self-read permission and tenant/requester filters gate every result and count.
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_READ_SELF');
  const result = await ticketService.listMine({ companyId, requesterId, query });
  // Data to frontend - minimized ticket DTOs and bounded pagination metadata only.
  return success(res, result.tickets, 200, 'Your Helpdesk tickets', result.meta);
});

export const createTicket = asyncHandler(async (req, res) => {
  // Data from frontend - body contains ticket fields only; requester and tenant are authenticated values.
  const companyId = req.companyId;
  const requesterId = req.user._id;
  const input = req.body;
  // DB Logic - self-create permission, config, queue, category, and atomic tenant number gate insert.
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_CREATE_SELF');
  const ticket = await ticketService.createTicket({ companyId, requesterId, input });
  // Data to frontend - return the minimized ticket DTO with its user-facing number.
  return success(res, ticket, 201, 'Helpdesk ticket created');
});

export const listQueueTickets = asyncHandler(async (req, res) => {
  // Data from frontend - queue id selects a queue; tenant and reader are authenticated values.
  const companyId = req.companyId;
  const viewerId = req.user._id;
  const queueId = req.params.queueId;
  const limit = req.query.limit;
  // DB Logic - queue-read permission, explicit membership, and confidentiality filters gate listing.
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_READ');
  const tickets = await ticketService.listQueueTickets({
    companyId,
    viewerId,
    queueId,
    limit,
    canReadQueue: true,
  });
  // Data to frontend - no counts are returned, so hidden records cannot be inferred.
  return success(res, tickets, 200, 'Queue Helpdesk tickets');
});

export const getTicket = asyncHandler(async (req, res) => {
  // Data from frontend - opaque ticket number is a selector; reader and tenant come from middleware.
  const companyId = req.companyId;
  const viewerId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  // DB Logic - service enforces requester permissions, queue membership, and confidentiality policy.
  const [canReadOwn, canReadQueue] = await Promise.all([
    hasPermission(req.user, 'HELPDESK_TICKET_READ_SELF'),
    hasPermission(req.user, 'HELPDESK_TICKET_READ'),
  ]);
  const ticket = await ticketService.getTicket({
    companyId,
    viewerId,
    ticketNumber,
    canReadOwn,
    canReadQueue,
  });
  // Data to frontend - unauthorized callers receive the same not-found response as missing tickets.
  return success(res, ticket, 200, 'Helpdesk ticket');
});

export const updateTicketStatus = asyncHandler(async (req, res) => {
  // Data from frontend - only the status transition is accepted from the client.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['status']);
  const status = input.status;
  // DB Logic - manage permission, centralized transition rules, and queue membership gate status changes.
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  const ticket = await ticketService.updateStatus({ companyId, actorId, ticketNumber, status });
  // Data to frontend - return the minimized updated ticket DTO.
  return success(res, ticket, 200, 'Helpdesk ticket status updated');
});

export const updateTicketPriority = asyncHandler(async (req, res) => {
  // Data from frontend - priority is available only to authorized queue staff.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['priority']);
  const priority = input.priority;
  // DB Logic - manage permission, queue membership, and enum validation gate effective priority changes.
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  const ticket = await ticketService.updatePriority({ companyId, actorId, ticketNumber, priority });
  // Data to frontend - requester cannot set or override effective priority.
  return success(res, ticket, 200, 'Helpdesk ticket priority updated');
});

export const assignTicket = asyncHandler(async (req, res) => {
  // Data from frontend - assignee is only a proposed user id; tenant identity is not client supplied.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['assigneeId']);
  const assigneeId = input.assigneeId;
  // DB Logic - manage permission and active explicit queue membership gate assignment.
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  const ticket = await ticketService.assignTicket({ companyId, actorId, ticketNumber, assigneeId });
  // Data to frontend - no assignee User document is populated.
  return success(res, ticket, 200, 'Helpdesk ticket assigned');
});

export const cancelOwnTicket = asyncHandler(async (req, res) => {
  // Data from frontend - requester id is never accepted from the client.
  const companyId = req.companyId;
  const requesterId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  assertBodyFields(req.body || {}, []);
  // DB Logic - self-read permission, authenticated requester, tenant, and ticket state gate cancellation.
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_READ_SELF');
  const ticket = await ticketService.cancelOwnTicket({ companyId, requesterId, ticketNumber });
  // Data to frontend - no other tenant or employee records are exposed.
  return success(res, ticket, 200, 'Helpdesk ticket cancelled');
});

export default {
  assertHelpdeskPermission,
  getConfig,
  updateConfig,
  listAvailableQueues,
  getAvailableQueue,
  listAdminQueues,
  createQueue,
  updateQueue,
  listMyTickets,
  createTicket,
  listQueueTickets,
  getTicket,
  updateTicketStatus,
  updateTicketPriority,
  assignTicket,
  cancelOwnTicket,
};
