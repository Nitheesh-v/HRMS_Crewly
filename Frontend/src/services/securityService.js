import api from './api.js';

const securityService = {
  dashboard: () =>
    api.get('/security/dashboard'),

  events: (params) =>
    api.get('/security/events', {
      params,
    }),

  settings: () =>
    api.get('/security/settings'),

  updateSettings: (payload) =>
    api.patch(
      '/security/settings',
      payload,
    ),

  auditLogs: (params) =>
    api.get('/audit', {
      params,
    }),

  auditSummary: (params) =>
    api.get('/audit/summary', {
      params,
    }),

  auditDetail: (id) =>
    api.get(`/audit/${id}`),

  exportAudit: (params) =>
    api.get('/audit/export', {
      params,
      responseType: 'blob',
    }),
};

export default securityService;