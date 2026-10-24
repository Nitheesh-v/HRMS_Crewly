import api from './api.js';

const ROOT = '/helpdesk';
const queuePath = (queueId) => `${ROOT}/admin/queues/${encodeURIComponent(String(queueId || ''))}`;
const analyticsPath = `${ROOT}/admin/analytics`;

// Additive calls for Phase 38.10. The original untracked Helpdesk client is
// intentionally left intact; all server authorization remains authoritative.
export const helpdeskWorkspaceService = {
  updateConfig: (payload) => api.patch(`${ROOT}/config`, payload),
  createQueue: (payload) => api.post(`${ROOT}/admin/queues`, payload),
  updateQueue: (queueId, payload) => api.patch(queuePath(queueId), payload),
  getQueueMembership: (queueId) => api.get(`${queuePath(queueId)}/membership`),
  searchMembershipCandidates: (params = {}) => api.get(`${ROOT}/admin/membership-candidates`, { params }),
  getQueueSlaPolicy: (queueId) => api.get(`${queuePath(queueId)}/sla-policy`),
  updateQueueSlaPolicy: (queueId, payload) => api.put(`${queuePath(queueId)}/sla-policy`, payload),
  getAnalyticsOverview: (params = {}) => api.get(`${analyticsPath}/overview`, { params }),
  getQueueAnalytics: (queueId, params = {}) => api.get(
    `${analyticsPath}/queues/${encodeURIComponent(String(queueId || ''))}`,
    { params },
  ),
  getAgentPerformance: (queueId, params = {}) => api.get(
    `${analyticsPath}/queues/${encodeURIComponent(String(queueId || ''))}/agents`,
    { params },
  ),
  getKnowledgeBaseUsage: (params = {}) => api.get(`${analyticsPath}/knowledge-base/usage`, { params }),
};

export default helpdeskWorkspaceService;
