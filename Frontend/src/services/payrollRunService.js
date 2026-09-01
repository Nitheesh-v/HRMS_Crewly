import api from './api.js';

// Phase 29.6 — Payroll Calculation Engine.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser (§3).
const payrollRunService = {
  list: () => api.get('/payroll/runs'),

  // §23 — the run, its live progress and the KPI cards.
  summary: (month) => api.get(`/payroll/runs/${month}`),

  // §24 — employee payroll results for the month.
  results: (month, params = {}) => api.get(`/payroll/runs/${month}/results`, { params }),

  result: (month, employeeId) => api.get(`/payroll/runs/${month}/results/${employeeId}`),

  // §5 / §26 — starts the run; the server queues it (BullMQ) when Redis is up.
  run: (month, payload = {}) => api.post(`/payroll/runs/${month}/run`, payload),

  // §21 — recalculate the month, or just the selected employees.
  recalculate: (month, payload = {}) => api.post(`/payroll/runs/${month}/recalculate`, payload),

  // §28
  cancel: (month) => api.post(`/payroll/runs/${month}/cancel`),
};

export default payrollRunService;
