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
import * as helpdeskKnowledgeBaseControllerNS from '../controllers/helpdeskKnowledgeBaseController.js';
import * as helpdeskAnalyticsControllerNS from '../controllers/helpdeskAnalyticsController.js';
import {
  helpdeskConfigUpdateValidator,
  helpdeskQueueCreateValidator,
  helpdeskQueueUpdateValidator,
  helpdeskQueueIdParamValidator,
  helpdeskMembershipSearchValidator,
  helpdeskTicketCreateValidator,
  helpdeskTicketReadParamValidator,
  helpdeskTicketStatusValidator,
  helpdeskTicketPriorityValidator,
  helpdeskTicketAssignmentValidator,
  helpdeskTicketClaimValidator,
  helpdeskTicketTransferValidator,
  helpdeskTicketCancelValidator,
  helpdeskTicketConfirmResolutionValidator,
  helpdeskTicketReopenValidator,
  helpdeskTicketFeedbackValidator,
  helpdeskTicketFeedbackReadValidator,
  helpdeskTicketListQueryValidator,
  helpdeskQueueTicketListQueryValidator,
  helpdeskMessageHistoryQueryValidator,
  helpdeskSlaPolicyValidator,
  helpdeskMessageCreateValidator,
  helpdeskAttachmentMessageValidator,
  helpdeskAttachmentIdParamValidator,
} from '../validators/helpdeskValidator.js';
import { helpdeskAttachmentUpload } from '../middlewares/helpdeskAttachmentUpload.js';
import {
  helpdeskKbSearchValidator,
  helpdeskKbArticleSlugParamValidator,
  helpdeskKbArticleIdParamValidator,
  helpdeskKbCategoryIdParamValidator,
  helpdeskKbAdminArticleListValidator,
  helpdeskKbAdminRevisionListValidator,
  helpdeskKbRevisionParamValidator,
  helpdeskKbArticleCreateValidator,
  helpdeskKbArticleUpdateValidator,
  helpdeskKbArticleTransitionValidator,
  helpdeskKbCategoryCreateValidator,
  helpdeskKbCategoryUpdateValidator,
} from '../validators/helpdeskKnowledgeBaseValidator.js';
import {
  helpdeskAnalyticsQueueIdValidator,
  helpdeskAnalyticsQueryValidator,
} from '../validators/helpdeskAnalyticsValidator.js';

const mergeExports = (namespace) => ({
  ...namespace,
  ...(namespace.default && typeof namespace.default === 'object' ? namespace.default : {}),
});

const { protect } = mergeExports(authMwNS);
const { tenantContext } = mergeExports(tenantNS);
const controller = mergeExports(helpdeskControllerNS);
const knowledgeBaseController = mergeExports(helpdeskKnowledgeBaseControllerNS);
const analyticsController = mergeExports(helpdeskAnalyticsControllerNS);
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
router.get(
  '/admin/membership-candidates',
  requirePermission('HELPDESK_QUEUE_MANAGE'),
  ...helpdeskMembershipSearchValidator,
  controller.searchQueueMembershipCandidates,
);
router.get(
  '/admin/queues/:queueId/membership',
  requirePermission('HELPDESK_QUEUE_MANAGE'),
  ...helpdeskQueueIdParamValidator,
  controller.getQueueMembership,
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
  '/admin/queues/:queueId/sla-policy',
  requirePermission('HELPDESK_QUEUE_MANAGE'),
  ...helpdeskQueueIdParamValidator,
  controller.getQueueSlaPolicy,
);
router.put(
  '/admin/queues/:queueId/sla-policy',
  checkWriteAccess,
  requirePermission('HELPDESK_QUEUE_MANAGE'),
  ...helpdeskSlaPolicyValidator,
  controller.updateQueueSlaPolicy,
);

// Phase 38.8 — published Knowledge Base reads reauthorize tenant and audience access in the service.
router.get(
  '/knowledge-base/categories',
  requirePermission('HELPDESK_KB_READ'),
  knowledgeBaseController.listEmployeeCategories,
);
router.get(
  '/knowledge-base/articles',
  requirePermission('HELPDESK_KB_READ'),
  ...helpdeskKbSearchValidator,
  knowledgeBaseController.searchEmployeeArticles,
);
router.get(
  '/knowledge-base/articles/:slug',
  requirePermission('HELPDESK_KB_READ'),
  ...helpdeskKbArticleSlugParamValidator,
  knowledgeBaseController.getEmployeeArticle,
);

// Phase 38.8 — only authorized Knowledge Base managers can inspect or author drafts.
router.get(
  '/admin/knowledge-base/categories',
  requirePermission('HELPDESK_KB_MANAGE'),
  knowledgeBaseController.listAdminCategories,
);
router.post(
  '/admin/knowledge-base/categories',
  checkWriteAccess,
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbCategoryCreateValidator,
  knowledgeBaseController.createCategory,
);
router.patch(
  '/admin/knowledge-base/categories/:categoryId',
  checkWriteAccess,
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbCategoryIdParamValidator,
  ...helpdeskKbCategoryUpdateValidator,
  knowledgeBaseController.updateCategory,
);
router.post(
  '/admin/knowledge-base/categories/:categoryId/archive',
  checkWriteAccess,
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbCategoryIdParamValidator,
  ...helpdeskKbArticleTransitionValidator,
  knowledgeBaseController.archiveCategory,
);
router.get(
  '/admin/knowledge-base/articles',
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbAdminArticleListValidator,
  knowledgeBaseController.listAdminArticles,
);
router.post(
  '/admin/knowledge-base/articles',
  checkWriteAccess,
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbArticleCreateValidator,
  knowledgeBaseController.createArticleDraft,
);
router.get(
  '/admin/knowledge-base/articles/:articleId',
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbArticleIdParamValidator,
  knowledgeBaseController.getAdminArticle,
);
router.get(
  '/admin/knowledge-base/articles/:articleId/revisions',
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbArticleIdParamValidator,
  ...helpdeskKbAdminRevisionListValidator,
  knowledgeBaseController.listAdminArticleRevisions,
);
router.get(
  '/admin/knowledge-base/articles/:articleId/revisions/:revision',
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbRevisionParamValidator,
  knowledgeBaseController.getAdminArticleRevision,
);
router.post(
  '/admin/knowledge-base/articles/:articleId/revisions/:revision/restore',
  checkWriteAccess,
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbRevisionParamValidator,
  ...helpdeskKbArticleTransitionValidator,
  knowledgeBaseController.restoreArticleRevision,
);
router.patch(
  '/admin/knowledge-base/articles/:articleId',
  checkWriteAccess,
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbArticleIdParamValidator,
  ...helpdeskKbArticleUpdateValidator,
  knowledgeBaseController.updateArticleDraft,
);
router.post(
  '/admin/knowledge-base/articles/:articleId/publish',
  checkWriteAccess,
  requireAnyPermission(['HELPDESK_KB_MANAGE', 'HELPDESK_KB_PUBLISH']),
  ...helpdeskKbArticleIdParamValidator,
  ...helpdeskKbArticleTransitionValidator,
  knowledgeBaseController.publishArticle,
);
router.post(
  '/admin/knowledge-base/articles/:articleId/archive',
  checkWriteAccess,
  requirePermission('HELPDESK_KB_MANAGE'),
  ...helpdeskKbArticleIdParamValidator,
  ...helpdeskKbArticleTransitionValidator,
  knowledgeBaseController.archiveArticle,
);

// Phase 38.9 — aggregate reports remain limited to tickets the caller can already read.
router.get(
  '/admin/analytics/overview',
  requirePermission('HELPDESK_TICKET_READ'),
  ...helpdeskAnalyticsQueryValidator,
  analyticsController.getOverview,
);
router.get(
  '/admin/analytics/queues/:queueId',
  requirePermission('HELPDESK_TICKET_READ'),
  ...helpdeskAnalyticsQueueIdValidator,
  ...helpdeskAnalyticsQueryValidator,
  analyticsController.getQueueReport,
);
router.get(
  '/admin/analytics/queues/:queueId/agents',
  requirePermission('HELPDESK_TICKET_READ'),
  requirePermission('HELPDESK_QUEUE_MANAGE'),
  ...helpdeskAnalyticsQueueIdValidator,
  ...helpdeskAnalyticsQueryValidator,
  analyticsController.getQueueAgentPerformance,
);
router.get(
  '/admin/analytics/knowledge-base/usage',
  requirePermission('HELPDESK_KB_MANAGE'),
  requirePermission('HELPDESK_TICKET_READ'),
  ...helpdeskAnalyticsQueryValidator,
  analyticsController.getKnowledgeBaseUsage,
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
router.post(
  '/tickets/mine/:ticketNumber/confirm-resolution',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_READ_SELF'),
  ...helpdeskTicketConfirmResolutionValidator,
  controller.confirmResolution,
);
router.post(
  '/tickets/mine/:ticketNumber/reopen',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_READ_SELF'),
  ...helpdeskTicketReopenValidator,
  controller.reopenOwnTicket,
);
router.post(
  '/tickets/mine/:ticketNumber/feedback',
  checkWriteAccess,
  requirePermission('HELPDESK_TICKET_READ_SELF'),
  ...helpdeskTicketFeedbackValidator,
  controller.submitFeedback,
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
  '/tickets/:ticketNumber/feedback',
  requireAnyPermission([
    'HELPDESK_TICKET_READ_SELF',
    'HELPDESK_TICKET_READ',
  ]),
  ...helpdeskTicketFeedbackReadValidator,
  controller.getFeedback,
);
router.get(
  '/tickets/:ticketNumber/sla',
  requireAnyPermission([
    'HELPDESK_TICKET_READ_SELF',
    'HELPDESK_TICKET_READ',
  ]),
  ...helpdeskTicketReadParamValidator,
  controller.getTicketSla,
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
