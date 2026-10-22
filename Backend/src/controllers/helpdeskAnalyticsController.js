import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { hasPermission } from '../utils/permissionService.js';
import { recordAudit } from '../utils/securityauditService.js';
import { helpdeskAnalyticsService } from '../services/helpdesk/helpdeskAnalyticsService.js';

const analyticsService = helpdeskAnalyticsService();

const success = (res, data, message) => res.status(200).json({
  success: true,
  message,
  data,
});

const assertPermissions = async (user, permissions) => {
  const granted = await Promise.all(permissions.map((permission) => hasPermission(user, permission)));
  if (granted.some((value) => !value)) {
    throw ApiError.forbidden('You do not have permission to read this Helpdesk analytics report.');
  }
};

const auditReportRead = async ({ req, report, data }) => recordAudit({
  req,
  action: 'Viewed Helpdesk analytics report',
  companyId: req.companyId,
  actorId: req.user._id,
  resource: 'HelpdeskAnalytics',
  statusCode: 200,
  metadata: {
    report,
    from: data?.period?.from || null,
    to: data?.period?.to || null,
    queueId: data?.queue?.id || null,
  },
});

// GET /api/helpdesk/admin/analytics/overview
export const getOverview = asyncHandler(async (req, res) => {
  // Data from frontend - date/pagination filters are allowlisted; tenant and actor are middleware-derived.
  const companyId = req.companyId;
  const actorId = req.user._id;
  // DB Logic - RBAC is checked here and the service re-reads queue membership/confidentiality before aggregation.
  await assertPermissions(req.user, ['HELPDESK_TICKET_READ']);
  const report = await analyticsService.getOverview({ companyId, actorId, query: req.query || {} });
  await auditReportRead({ req, report: 'overview', data: report });
  // Data to frontend - only bounded aggregates and allowlisted queue labels are returned.
  return success(res, report, 'Helpdesk analytics overview');
});

// GET /api/helpdesk/admin/analytics/queues/:queueId
export const getQueueReport = asyncHandler(async (req, res) => {
  // Data from frontend - queueId selects a resource only; tenant and viewer are authenticated values.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const queueId = req.params.queueId;
  // DB Logic - RBAC plus current queue membership and ticket confidentiality are enforced before aggregation.
  await assertPermissions(req.user, ['HELPDESK_TICKET_READ']);
  const report = await analyticsService.getQueueReport({ companyId, actorId, queueId, query: req.query || {} });
  await auditReportRead({ req, report: 'queue', data: report });
  // Data to frontend - ticket-level fields and requester/agent profiles are never returned.
  return success(res, report, 'Helpdesk queue analytics');
});

// GET /api/helpdesk/admin/analytics/queues/:queueId/agents
export const getQueueAgentPerformance = asyncHandler(async (req, res) => {
  // Data from frontend - queueId selects the report scope; page/date filters are bounded by the validator.
  const companyId = req.companyId;
  const actorId = req.user._id;
  const queueId = req.params.queueId;
  // DB Logic - tenant RBAC and explicit queue-manager membership gate this aggregate-only agent report.
  await assertPermissions(req.user, ['HELPDESK_TICKET_READ', 'HELPDESK_QUEUE_MANAGE']);
  const report = await analyticsService.getQueueAgentPerformance({ companyId, actorId, queueId, query: req.query || {} });
  await auditReportRead({ req, report: 'queue-agent-performance', data: report });
  // Data to frontend - only current queue-agent ids and aggregate counts are returned, never ticket text.
  return success(res, report, 'Helpdesk queue agent performance');
});

// GET /api/helpdesk/admin/analytics/knowledge-base/usage
export const getKnowledgeBaseUsage = asyncHandler(async (req, res) => {
  // Data from frontend - the requested period/page is bounded; tenant and actor identities are never accepted from input.
  const companyId = req.companyId;
  const actorId = req.user._id;
  // DB Logic - KB administration RBAC and source-ticket read permission are required; queue visibility still filters references.
  await assertPermissions(req.user, ['HELPDESK_KB_MANAGE', 'HELPDESK_TICKET_READ']);
  const report = await analyticsService.getKnowledgeBaseUsage({ companyId, actorId, query: req.query || {} });
  await auditReportRead({ req, report: 'knowledge-base-usage', data: report });
  // Data to frontend - counts come only from persisted public-reply references; no article bodies or search/view claims are returned.
  return success(res, report, 'Helpdesk Knowledge Base usage');
});

export default {
  getOverview,
  getQueueReport,
  getQueueAgentPerformance,
  getKnowledgeBaseUsage,
};
