import api from './api.js';

// Phase 29.3 — Salary Structures.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser (§3).
const salaryStructureService = {
  list: (params = {}) => api.get('/payroll/salary-structures', { params }),

  get: (structureId) => api.get(`/payroll/salary-structures/${structureId}`),

  // §9 — display-only preview. The server never stores the result.
  preview: (payload) => api.post('/payroll/salary-structures/preview', payload),

  create: (payload) => api.post('/payroll/salary-structures', payload),

  update: (structureId, payload) => api.patch(`/payroll/salary-structures/${structureId}`, payload),

  setStatus: (structureId, status) =>
    api.post(`/payroll/salary-structures/${structureId}/status`, { status }),

  clone: (structureId, payload = {}) =>
    api.post(`/payroll/salary-structures/${structureId}/clone`, payload),
};

export default salaryStructureService;
