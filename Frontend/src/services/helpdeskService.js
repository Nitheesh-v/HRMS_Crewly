import api from './api.js';

const ROOT = '/helpdesk';
const ticketPath = (ticketNumber) => `${ROOT}/tickets/${encodeURIComponent(String(ticketNumber || ''))}`;
const articlePath = (articleId) => `${ROOT}/admin/knowledge-base/articles/${encodeURIComponent(String(articleId || ''))}`;
const responseBody = (response) => response?.data ?? {};

/** Tenant Helpdesk API client. Tenant and actor identifiers are deliberately never accepted here. */
export const helpdeskService = {
  getConfig: () => api.get(`${ROOT}/config`),
  listQueues: () => api.get(`${ROOT}/queues`),
  listAdminQueues: () => api.get(`${ROOT}/admin/queues`),
  listMyTickets: (params = {}) => api.get(`${ROOT}/tickets/mine`, { params }),
  createTicket: (payload) => api.post(`${ROOT}/tickets`, payload),
  getTicket: (ticketNumber) => api.get(ticketPath(ticketNumber)),
  getTicketSla: (ticketNumber) => api.get(`${ticketPath(ticketNumber)}/sla`),
  cancelTicket: (ticketNumber) => api.patch(`${ROOT}/tickets/mine/${encodeURIComponent(String(ticketNumber || ''))}/cancel`, {}),
  confirmResolution: (ticketNumber) => api.post(`${ROOT}/tickets/mine/${encodeURIComponent(String(ticketNumber || ''))}/confirm-resolution`, {}),
  reopenTicket: (ticketNumber, reason) => api.post(`${ROOT}/tickets/mine/${encodeURIComponent(String(ticketNumber || ''))}/reopen`, { reason }),
  submitFeedback: (ticketNumber, payload) => api.post(`${ROOT}/tickets/mine/${encodeURIComponent(String(ticketNumber || ''))}/feedback`, payload),
  getFeedback: (ticketNumber) => api.get(`${ticketPath(ticketNumber)}/feedback`),
  listMessages: (ticketNumber, params = {}) => api.get(`${ticketPath(ticketNumber)}/messages`, { params }),
  createMessage: (ticketNumber, payload) => api.post(`${ticketPath(ticketNumber)}/messages`, payload),
  uploadAttachment: (ticketNumber, { file, body = '', messageType = 'public' }) => {
    const form = new FormData();
    form.append('file', file);
    if (body) form.append('body', body);
    form.append('messageType', messageType);
    return api.post(`${ticketPath(ticketNumber)}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  downloadAttachment: (ticketNumber, attachmentId) => api.get(
    `${ticketPath(ticketNumber)}/attachments/${encodeURIComponent(String(attachmentId || ''))}/download`,
    { responseType: 'blob' },
  ),
  listQueueTickets: (queueId, params = {}) => api.get(`${ROOT}/queues/${encodeURIComponent(String(queueId || ''))}/tickets`, { params }),
  listAssignedTickets: (queueId, params = {}) => api.get(`${ROOT}/queues/${encodeURIComponent(String(queueId || ''))}/tickets/assigned-to-me`, { params }),
  listUnassignedTickets: (queueId, params = {}) => api.get(`${ROOT}/queues/${encodeURIComponent(String(queueId || ''))}/tickets/unassigned`, { params }),
  claimTicket: (ticketNumber) => api.patch(`${ticketPath(ticketNumber)}/claim`, {}),
  updateTicketStatus: (ticketNumber, status) => api.patch(`${ticketPath(ticketNumber)}/status`, { status }),
  updateTicketPriority: (ticketNumber, priority) => api.patch(`${ticketPath(ticketNumber)}/priority`, { priority }),
  assignTicket: (ticketNumber, assigneeId) => api.patch(`${ticketPath(ticketNumber)}/assignment`, { assigneeId }),
  transferTicket: (ticketNumber, payload) => api.patch(`${ticketPath(ticketNumber)}/transfer`, payload),

  listKnowledgeBaseCategories: () => api.get(`${ROOT}/knowledge-base/categories`),
  searchKnowledgeBase: (params = {}) => api.get(`${ROOT}/knowledge-base/articles`, { params }),
  getKnowledgeBaseArticle: (slug) => api.get(`${ROOT}/knowledge-base/articles/${encodeURIComponent(String(slug || ''))}`),
  listAdminKnowledgeBaseCategories: () => api.get(`${ROOT}/admin/knowledge-base/categories`),
  createKnowledgeBaseCategory: (payload) => api.post(`${ROOT}/admin/knowledge-base/categories`, payload),
  updateKnowledgeBaseCategory: (categoryId, payload) => api.patch(`${ROOT}/admin/knowledge-base/categories/${encodeURIComponent(String(categoryId || ''))}`, payload),
  archiveKnowledgeBaseCategory: (categoryId, expectedVersion) => api.post(
    `${ROOT}/admin/knowledge-base/categories/${encodeURIComponent(String(categoryId || ''))}/archive`,
    { expectedVersion },
  ),
  listAdminKnowledgeBaseArticles: (params = {}) => api.get(`${ROOT}/admin/knowledge-base/articles`, { params }),
  createKnowledgeBaseDraft: (payload) => api.post(`${ROOT}/admin/knowledge-base/articles`, payload),
  getAdminKnowledgeBaseArticle: (articleId) => api.get(articlePath(articleId)),
  updateKnowledgeBaseDraft: (articleId, payload) => api.patch(articlePath(articleId), payload),
  publishKnowledgeBaseArticle: (articleId, expectedVersion) => api.post(`${articlePath(articleId)}/publish`, { expectedVersion }),
  archiveKnowledgeBaseArticle: (articleId, expectedVersion) => api.post(`${articlePath(articleId)}/archive`, { expectedVersion }),
  listKnowledgeBaseRevisions: (articleId, params = {}) => api.get(`${articlePath(articleId)}/revisions`, { params }),
  getKnowledgeBaseRevision: (articleId, revision) => api.get(`${articlePath(articleId)}/revisions/${encodeURIComponent(String(revision || ''))}`),
  restoreKnowledgeBaseRevision: (articleId, revision, expectedVersion) => api.post(
    `${articlePath(articleId)}/revisions/${encodeURIComponent(String(revision || ''))}/restore`,
    { expectedVersion },
  ),
};

export const helpdeskResponseData = (response) => responseBody(response).data;
export const helpdeskResponseMeta = (response) => responseBody(response).meta || null;

export default helpdeskService;
