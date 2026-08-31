import api from './api.js';

// Phase 29.2 — Salary Components.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser (§4).
const salaryComponentService = {
  list: (params = {}) => api.get('/payroll/components', { params }),

  get: (componentId) => api.get(`/payroll/components/${componentId}`),

  defaults: () => api.get('/payroll/components/defaults'),

  createDefaults: () => api.post('/payroll/components/defaults'),

  create: (payload) => api.post('/payroll/components', payload),

  update: (componentId, payload) => api.patch(`/payroll/components/${componentId}`, payload),

  setStatus: (componentId, status) =>
    api.post(`/payroll/components/${componentId}/status`, { status }),

  duplicate: (componentId, payload = {}) =>
    api.post(`/payroll/components/${componentId}/duplicate`, payload),
};

export default salaryComponentService;
