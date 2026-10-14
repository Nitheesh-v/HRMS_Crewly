import express from 'express';
import * as authMwNS from '../middlewares/authMiddleware.js';
import * as tenantNS from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import * as helpdeskControllerNS from '../controllers/helpdeskController.js';
import {
  helpdeskConfigUpdateValidator,
  helpdeskQueueCreateValidator,
  helpdeskQueueUpdateValidator,
  helpdeskQueueIdParamValidator,
  helpdeskTicketCreateValidator,
  helpdeskTicketReadParamValidator,
  helpdeskTicketStatusValidator,
  helpdeskTicketPriorityValidator,
  helpdeskTicketAssignmentValidator,
  helpdeskTicketClaimValidator,
  helpdeskTicketTransferValidator,
  helpdeskTicketCancelValidator,
  helpdeskTicketListQueryValidator,
  helpdeskQueueTicketListQueryValidator,
  helpdeskMessageHistoryQueryValidator,
  helpdeskMessageCreateValidator,
  helpdeskAttachmentMessageValidator,
  helpdeskAttachmentIdParamValidator,
} from '../validators/helpdeskValidator.js';
import { helpdeskAttachmentUpload } from '../middlewares/helpdeskAttachmentUpload.js';

const mergeExports = (namespace) => ({
  ...namespace,
  ...(namespace.default && typeof namespace.default === 'object' ? namespace.default : {}),
});

const { protect } = mergeExports(authMwNS);
const { tenantContext } = mergeExports(tenantNS);
const controller = mergeExports(helpdeskControllerNS);
const router = express.Router();

const requireTenant = (req, res, next) => {
  if (!req.companyId) {
    return res.status(403).json({
      statusCode: 403,
      success: false,
      message: 'A customer tenant is required for Helpdesk access',
    });
  }
  return next();
};

router.use(protect, tenantContext, requireTenant, checkSubscriptionStatus);

router.get(
  '/config',
  requirePermission('HELPDESK_QUEUE_READ'),
  controller.getConfig,
);
router.patch(
  '/config',
  checkWriteAccess,
  requirePermission('HELPDESK_QUEUE_MANAGE'),
  ...helpdeskConfigUpdateValidator,
  controller.updateConfig,
);

router.get(
  '/queues',
  requirePermission('HELPDESK_QUEUE_READ'),
  controller.listAvailableQueues,
);
router.get(
  '/queues/:queueId',
  requirePermission('HELPDESK_QUEUE_READ'),
  ...helpdeskQueueIdParamValidator,
  controller.getAvailableQueue,
);

router.get(
  '/admin/queues',
  requirePermission('HELPDESK_QUEUE_MANAGE'),
  controller.listAdminQueues,
);
router.post(
  '/admin/queues',
  checkWriteAccess,
  requirePermission('HELPDESK_QUEUE_MANAGE'),
  ...helpdeskQueueCreateValidator,
  controller.createQueue,
);
router.patch(
  '/admin/queues/:queueId',
  checkWriteAccess,
  requirePermission('HELPDESK_QUEUE_MANAGE'),
  ...helpdeskQueueUpdateValidator,
  controller.updateQueue,
);

router.get(
  '/tickets/mine',
  requirePermission('HELPDESK_TICKET_READ_SELF'),
  ...helpdeskTicketListQueryValidator,
  controller.listMyTickets,
);
router.post(
  '/tickets',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_CREATE_SELF'),
  ...helpdeskTicketCreateValidator,
  controller.createTicket,
);
router.patch(
  '/tickets/mine/:ticketNumber/cancel',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_READ_SELF'),
  ...helpdeskTicketCancelValidator,
  controller.cancelOwnTicket,
);

router.get(
  '/queues/:queueId/tickets/assigned-to-me',
  requirePermission('HELPDESK_TICKET_READ'),
  ...helpdeskQueueIdParamValidator,
  ...helpdeskQueueTicketListQueryValidator,
  controller.listAssignedTicketsToMe,
);
router.get(
  '/queues/:queueId/tickets/unassigned',
  requirePermission('HELPDESK_TICKET_READ'),
  ...helpdeskQueueIdParamValidator,
  ...helpdeskQueueTicketListQueryValidator,
  controller.listUnassignedTickets,
);
router.get(
  '/queues/:queueId/tickets',
  requirePermission('HELPDESK_TICKET_READ'),
  ...helpdeskQueueIdParamValidator,
  ...helpdeskQueueTicketListQueryValidator,
  controller.listQueueTickets,
);
router.get(
  '/tickets/:ticketNumber',
  requireAnyPermission([
    'HELPDESK_TICKET_READ_SELF',
    'HELPDESK_TICKET_READ',
  ]),
  ...helpdeskTicketReadParamValidator,
  controller.getTicket,
);
router.get(
  '/tickets/:ticketNumber/messages',
  requireAnyPermission([
    'HELPDESK_TICKET_READ_SELF',
    'HELPDESK_TICKET_READ',
  ]),
  ...helpdeskMessageHistoryQueryValidator,
  controller.listMessages,
);
router.post(
  '/tickets/:ticketNumber/messages',
  checkWriteAccess,
  requireAnyPermission([
    'HELPDESK_TICKET_READ_SELF',
    'HELPDESK_TICKET_MANAGE',
  ]),
  ...helpdeskMessageCreateValidator,
  controller.createMessage,
);
router.post(
  '/tickets/:ticketNumber/attachments',
  checkWriteAccess,
  requireAnyPermission([
    'HELPDESK_TICKET_READ_SELF',
    'HELPDESK_TICKET_MANAGE',
  ]),
  ...helpdeskTicketReadParamValidator,
  controller.authorizeAttachmentUpload,
  helpdeskAttachmentUpload,
  ...helpdeskAttachmentMessageValidator,
  controller.uploadAttachment,
);
router.get(
  '/tickets/:ticketNumber/attachments/:attachmentId/download',
  requireAnyPermission([
    'HELPDESK_TICKET_READ_SELF',
    'HELPDESK_TICKET_READ',
  ]),
  ...helpdeskAttachmentIdParamValidator,
  controller.downloadAttachment,
);

router.patch(
  '/tickets/:ticketNumber/claim',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_MANAGE'),
  ...helpdeskTicketClaimValidator,
  controller.claimTicket,
);
router.patch(
  '/tickets/:ticketNumber/status',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_MANAGE'),
  ...helpdeskTicketStatusValidator,
  controller.updateTicketStatus,
);
router.patch(
  '/tickets/:ticketNumber/priority',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_MANAGE'),
  ...helpdeskTicketPriorityValidator,
  controller.updateTicketPriority,
);
router.patch(
  '/tickets/:ticketNumber/assignment',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_MANAGE'),
  ...helpdeskTicketAssignmentValidator,
  controller.assignTicket,
);
router.patch(
  '/tickets/:ticketNumber/transfer',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_MANAGE'),
  ...helpdeskTicketTransferValidator,
  controller.transferTicket,
);

export default router;
