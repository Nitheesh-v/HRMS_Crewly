import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { hasPermission } from '../utils/permissionService.js';
import { assertNoClientIdentity } from '../services/helpdesk/helpdeskRules.js';
import { helpdeskTenantConfigService } from '../services/helpdesk/helpdeskTenantConfigService.js';
import { helpdeskQueueService } from '../services/helpdesk/helpdeskQueueService.js';
import { helpdeskMembershipService } from '../services/helpdesk/helpdeskMembershipService.js';
import { helpdeskTicketService } from '../services/helpdesk/helpdeskTicketService.js';
import { helpdeskConversationService } from '../services/helpdesk/helpdeskConversationService.js';
import { helpdeskSlaService } from '../services/helpdesk/helpdeskSlaService.js';
import { recordAudit } from '../utils/securityauditService.js';

const configService = helpdeskTenantConfigService();
const queueService = helpdeskQueueService();
const membershipService = helpdeskMembershipService();
const slaService = helpdeskSlaService();
const ticketService = helpdeskTicketService({ configService, slaService });
const conversationService = helpdeskConversationService({ configService, slaService });

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

const getHelpdeskMessagePermissions = async (user) => {
  const [canReadOwn, canReadQueue, canManage] = await Promise.all([
    hasPermission(user, 'HELPDESK_TICKET_READ_SELF'),
    hasPermission(user, 'HELPDESK_TICKET_READ'),
    hasPermission(user, 'HELPDESK_TICKET_MANAGE'),
  ]);
  return { canReadOwn, canReadQueue, canManage };
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

export const searchQueueMembershipCandidates = asyncHandler(async (req, res) => {
  // Data from frontend - bounded search and pagination select candidates; tenant identity is never accepted from query or body.
  const companyId = req.companyId;
  const { search, page, limit } = req.query;
  // DB Logic - Helpdesk administration permission and tenant-scoped, projected active User search are both enforced.
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_MANAGE');
  const result = await membershipService.searchCandidates({ companyId, search, page, limit });
  // Data to frontend - minimized User-backed employee candidates and bounded pagination metadata only.
  return success(res, result.candidates, 200, 'Helpdesk membership candidates', result.meta);
});

export const getQueueMembership = asyncHandler(async (req, res) => {
  // Data from frontend - queueId selects the resource; tenant and actor are authenticated middleware values.
  const companyId = req.companyId;
  const queueId = req.params.queueId;
  // DB Logic - queue and member resolution remain scoped to the authenticated tenant after Helpdesk administration authorization.
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_MANAGE');
  const membership = await membershipService.getQueueMembership({ companyId, queueId });
  // Data to frontend - role-separated display DTOs redact unresolved/cross-tenant member details.
  return success(res, membership, 200, 'Helpdesk queue membership');
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

export const getQueueSlaPolicy = asyncHandler(async (req, res) => {
  // Tenant and actor identity are authenticated; queueId is only a resource selector.
  const companyId = req.companyId;
  const queueId = req.params.queueId;
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_MANAGE');
  const policy = await slaService.getQueuePolicy({ companyId, queueId });
  return success(res, policy, 200, 'Helpdesk queue SLA policy');
});

export const updateQueueSlaPolicy = asyncHandler(async (req, res) => {
  const companyId = req.companyId;
  const actorId = req.user._id;
  const queueId = req.params.queueId;
  const input = req.body || {};
  assertBodyFields(input, [
    'enabled',
    'clockMode',
    'timeZone',
    'excludeHolidays',
    'weeklyHours',
    'targets',
    'warningPercent',
    'pauseStatuses',
  ]);
  await assertHelpdeskPermission(req.user, 'HELPDESK_QUEUE_MANAGE');
  const policy = await slaService.updateQueuePolicy({ companyId, queueId, actorId, input });
  req.helpdeskAuditAction = 'Updated a Helpdesk queue SLA policy';
  return success(res, policy, 200, 'Helpdesk queue SLA policy updated');
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
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const viewerId = req.user._id;
  const queueId = req.params.queueId;
  const query = req.query;
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_READ');
  const result = await ticketService.listQueueTickets({
    companyId,
    viewerId,
    queueId,
    query,
    canReadQueue: true,
  });
  // Data to frontend - response to frontend
  return success(res, result.tickets, 200, 'Queue Helpdesk tickets', result.meta);
});

export const listAssignedTicketsToMe = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const viewerId = req.user._id;
  const queueId = req.params.queueId;
  const query = req.query;
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_READ');
  const result = await ticketService.listAssignedToMe({
    companyId,
    viewerId,
    queueId,
    query,
    canReadQueue: true,
  });
  // Data to frontend - response to frontend
  return success(res, result.tickets, 200, 'Helpdesk tickets assigned to you', result.meta);
});

export const listUnassignedTickets = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const viewerId = req.user._id;
  const queueId = req.params.queueId;
  const query = req.query;
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_READ');
  const result = await ticketService.listUnassignedTickets({
    companyId,
    viewerId,
    queueId,
    query,
    canReadQueue: true,
  });
  // Data to frontend - response to frontend
  return success(res, result.tickets, 200, 'Unassigned Helpdesk tickets', result.meta);
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

export const getTicketSla = asyncHandler(async (req, res) => {
  const companyId = req.companyId;
  const viewerId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
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
  return success(res, ticket.sla || { configured: false }, 200, 'Helpdesk ticket SLA');
});

export const claimTicket = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, []);
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  const ticket = await ticketService.claimTicket({ companyId, actorId, ticketNumber });
  // Data to frontend - response to frontend
  return success(res, ticket, 200, 'Helpdesk ticket claimed');
});

export const updateTicketStatus = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['status']);
  const status = input.status;
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  const ticket = await ticketService.updateStatus({ companyId, actorId, ticketNumber, status });
  // Data to frontend - response to frontend
  return success(res, ticket, 200, 'Helpdesk ticket status updated');
});

export const updateTicketPriority = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['priority']);
  const priority = input.priority;
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  const ticket = await ticketService.updatePriority({ companyId, actorId, ticketNumber, priority });
  // Data to frontend - response to frontend
  return success(res, ticket, 200, 'Helpdesk ticket priority updated');
});

export const assignTicket = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['assigneeId']);
  const assigneeId = input.assigneeId;
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  const ticket = await ticketService.assignTicket({ companyId, actorId, ticketNumber, assigneeId });
  // Data to frontend - response to frontend
  return success(res, ticket, 200, 'Helpdesk ticket assigned');
});

export const transferTicket = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['queueId', 'categoryId', 'assigneeId']);
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  const ticket = await ticketService.transferTicket({ companyId, actorId, ticketNumber, input });
  // Data to frontend - response to frontend
  return success(res, ticket, 200, 'Helpdesk ticket transferred');
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

export const confirmResolution = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const requesterId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  assertBodyFields(req.body || {}, []);
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_READ_SELF');
  const result = await ticketService.confirmResolution({ companyId, requesterId, ticketNumber });
  req.helpdeskAuditAction = 'Confirmed a Helpdesk resolution';
  // Data to frontend - response to frontend
  return success(res, result, 200, 'Helpdesk resolution confirmed');
});

export const reopenOwnTicket = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const requesterId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['reason']);
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_READ_SELF');
  const result = await ticketService.reopenOwnTicket({
    companyId,
    requesterId,
    ticketNumber,
    reason: input.reason,
  });
  req.helpdeskAuditAction = 'Reopened a Helpdesk ticket';
  // Data to frontend - response to frontend
  return success(res, result, 200, 'Helpdesk ticket reopened');
});

export const submitFeedback = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const requesterId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['rating', 'comment']);
  // DB Logic - DB logics
  await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_READ_SELF');
  const result = await ticketService.submitFeedback({
    companyId,
    requesterId,
    ticketNumber,
    rating: input.rating,
    comment: input.comment,
  });
  req.helpdeskAuditAction = 'Submitted Helpdesk satisfaction feedback';
  // Data to frontend - response to frontend
  return success(res, result, 201, 'Helpdesk feedback submitted');
});

export const getFeedback = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const viewerId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  // DB Logic - DB logics
  const [canReadOwn, canReadQueue] = await Promise.all([
    hasPermission(req.user, 'HELPDESK_TICKET_READ_SELF'),
    hasPermission(req.user, 'HELPDESK_TICKET_READ'),
  ]);
  if (!canReadOwn && !canReadQueue) {
    throw ApiError.forbidden('You do not have permission to read Helpdesk feedback.');
  }
  const result = await ticketService.getFeedback({
    companyId,
    viewerId,
    ticketNumber,
    canReadOwn,
    canReadQueue,
  });
  // Data to frontend - response to frontend
  return success(res, result, 200, 'Helpdesk ticket feedback');
});

const sanitizeHelpdeskDownloadName = (rawName) =>
  String(rawName || 'attachment')
    .replace(/[\r\n"]/g, '')
    .replaceAll('/', '_')
    .replaceAll('\\', '_')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .slice(0, 200) || 'attachment';

// GET /api/helpdesk/tickets/:ticketNumber/messages
export const listMessages = asyncHandler(async (req, res) => {
  // Data from frontend - ticket number and bounded cursor/limit select a page; tenant and viewer are authenticated.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const query = req.query;
  // DB Logic - RBAC plus ticket requester/queue/confidentiality checks run before a bounded, explicitly projected history read.
  const [canReadOwn, canReadQueue] = await Promise.all([
    hasPermission(req.user, 'HELPDESK_TICKET_READ_SELF'),
    hasPermission(req.user, 'HELPDESK_TICKET_READ'),
  ]);
  if (!canReadOwn && !canReadQueue) {
    throw ApiError.forbidden('You do not have permission to read Helpdesk messages.');
  }
  const result = await conversationService.listMessages({
    companyId,
    actorId,
    ticketNumber,
    canReadOwn,
    canReadQueue,
    query,
  });
  // Data to frontend - employee history is public-only; the DTO contains only bounded text and minimal author/attachment display data.
  return success(res, result.messages, 200, 'Helpdesk ticket conversation', result.meta);
});

// POST /api/helpdesk/tickets/:ticketNumber/messages
export const createMessage = asyncHandler(async (req, res) => {
  // Data from frontend - the allowlisted body contains plain text and an optional visibility selector, never author or tenant identity.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['body', 'messageType', 'relatedArticleIds']);
  const messageType = String(input.messageType || 'public').trim().toLowerCase();
  // Phase 38.8 — optional article ids are references only; the conversation service revalidates employee visibility in the ticket transaction.
  // DB Logic - RBAC, explicit queue membership, confidentiality and eligible-state checks precede immutable message persistence.
  const { canReadOwn, canReadQueue, canManage } = await getHelpdeskMessagePermissions(req.user);
  if ((messageType === 'internal' || !canReadOwn) && !canManage) {
    await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  }
  const message = await conversationService.createMessage({
    companyId,
    actorId,
    actorDisplayName: req.user.name,
    ticketNumber,
    body: input.body,
    messageType,
    relatedArticleIds: input.relatedArticleIds,
    canReadOwn,
    canReadQueue,
    canManage,
  });
  req.helpdeskAuditAction = messageType === 'internal'
    ? 'Added a Helpdesk internal note'
    : 'Posted a Helpdesk public reply';
  // Data to frontend - the minimized message DTO contains no tenant, storage key, private URL or checksum.
  return success(res, message, 201, 'Helpdesk message created');
});

// POST /api/helpdesk/tickets/:ticketNumber/attachments (authorization before Multer buffers bytes)
export const authorizeAttachmentUpload = asyncHandler(async (req, res, next) => {
  // Data from frontend - only the ticket selector is present before multipart parsing; authority remains middleware-derived.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  // DB Logic - validate requester/queue/confidentiality, write eligibility and the attachment feature flag before reading file bytes.
  const access = await getHelpdeskMessagePermissions(req.user);
  await conversationService.assertAttachmentWriteAllowed({
    companyId,
    actorId,
    ticketNumber,
    ...access,
  });
  req.helpdeskMessageAccess = access;
  // Data to frontend - no ticket DTO is sent; the private server-side permission snapshot is reused after parsing.
  return next();
});

// POST /api/helpdesk/tickets/:ticketNumber/attachments (multipart)
export const uploadAttachment = asyncHandler(async (req, res) => {
  // Data from frontend - one bounded multipart file plus optional plain-text body/visibility; all identities come from middleware.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const input = req.body || {};
  assertBodyFields(input, ['body', 'messageType']);
  const messageType = String(input.messageType || 'public').trim().toLowerCase();
  // DB Logic - RBAC, current ticket access/state, file signatures and the attachment feature flag are verified around private storage.
  const { canReadOwn, canReadQueue, canManage } =
    req.helpdeskMessageAccess || await getHelpdeskMessagePermissions(req.user);
  if ((messageType === 'internal' || !canReadOwn) && !canManage) {
    await assertHelpdeskPermission(req.user, 'HELPDESK_TICKET_MANAGE');
  }
  const message = await conversationService.createMessageWithAttachment({
    companyId,
    actorId,
    actorDisplayName: req.user.name,
    ticketNumber,
    body: input.body,
    messageType,
    file: req.file,
    canReadOwn,
    canReadQueue,
    canManage,
  });
  req.helpdeskAuditAction = messageType === 'internal'
    ? 'Added an attachment to a Helpdesk internal note'
    : 'Added an attachment to a Helpdesk public reply';
  // Data to frontend - only the message/attachment display metadata is returned; no provider URL, bytes or private storage key.
  return success(res, message, 201, 'Helpdesk attachment added');
});

// GET /api/helpdesk/attachments/:attachmentId/download
export const downloadAttachment = asyncHandler(async (req, res) => {
  // Data from frontend - an opaque attachment id selects a resource; it is not authority or a storage path.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const ticketNumber = req.params.ticketNumber;
  const attachmentId = req.params.attachmentId;
  // DB Logic - authenticate ticket ownership/queue access and message visibility before proxying bounded private bytes.
  const [canReadOwn, canReadQueue] = await Promise.all([
    hasPermission(req.user, 'HELPDESK_TICKET_READ_SELF'),
    hasPermission(req.user, 'HELPDESK_TICKET_READ'),
  ]);
  if (!canReadOwn && !canReadQueue) {
    throw ApiError.forbidden('You do not have permission to download Helpdesk attachments.');
  }
  const attachment = await conversationService.authorizeAttachmentDownload({
    companyId,
    actorId,
    ticketNumber,
    attachmentId,
    canReadOwn,
    canReadQueue,
  });
  const delivery = await conversationService.resolveAttachmentDelivery(attachment);
  await recordAudit({
    req,
    action: 'Downloaded a Helpdesk ticket attachment',
    companyId,
    actorId,
    resource: 'HelpdeskAttachment',
    resourceId: attachment._id,
    metadata: {
      ticketId: String(attachment.ticketId),
      messageId: String(attachment.messageId),
    },
    statusCode: 200,
  });

  // Data to frontend - uncacheable attachment bytes with a fixed safe MIME, nosniff, and a sanitized download name.
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', delivery.contentType || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${sanitizeHelpdeskDownloadName(delivery.fileName)}"`);
  return res.status(200).send(delivery.bytes);
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
  listAssignedTicketsToMe,
  listUnassignedTickets,
  getTicket,
  claimTicket,
  updateTicketStatus,
  updateTicketPriority,
  assignTicket,
  transferTicket,
  cancelOwnTicket,
  confirmResolution,
  reopenOwnTicket,
  submitFeedback,
  getFeedback,
  listMessages,
  createMessage,
  authorizeAttachmentUpload,
  uploadAttachment,
  downloadAttachment,
};
