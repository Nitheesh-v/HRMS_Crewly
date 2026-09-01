import api from './api.js';

// Phase 29.8 — Bank Transfer File & Salary Payment Preparation.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser (§3).
//
// Nothing here moves money. The file these endpoints produce is uploaded to
// the company's own banking portal by their finance team (§1).
const payrollPaymentService = {
  // §17 — batches + KPI cards (cached server-side, §19).
  dashboard: (month = '') => api.get('/payroll/payments/dashboard', { params: { month: month || undefined } }),

  // §18 — batch list.
  batches: (month = '') => api.get('/payroll/payments', { params: { month: month || undefined } }),

  // §18 — one batch: summary, employees, failures, download history.
  batch: (batchId) => api.get(`/payroll/payments/${batchId}`),

  // §18 / §22 — the batch's audit trail: every status change, employee
  // outcome and file event, newest first.
  batchAudit: (batchId) => api.get(`/payroll/payments/${batchId}/audit`),

  // §7 — bank validation report for a batch.
  validate: (batchId) => api.get(`/payroll/payments/${batchId}/validate`),

  // §5 / §6 — create a batch from the approved payroll.
  createBatch: (month, paymentDate = null) =>
    api.post('/payroll/payments', { month, paymentDate }),

  // §10 — generate the bank file (queued when Redis is configured, §20).
  generateFile: (batchId, format = 'CSV') =>
    api.post(`/payroll/payments/${batchId}/files`, { format }),

  // §12 — downloads count; the raw file streams from this URL.
  downloadFile: (fileId) => api.get(`/payroll/payments/files/${fileId}/download`, { responseType: 'blob' }),

  // §13 — confirm the whole batch.
  markAllPaid: (batchId) => api.post(`/payroll/payments/${batchId}/mark-all-paid`),

  // §14 — mark one employee paid or failed.
  markEmployee: (batchId, employeeId, payload = {}) =>
    api.patch(`/payroll/payments/${batchId}/employees/${employeeId}`, payload),

  // §16 — retry the failures in a fresh batch.
  retry: (batchId) => api.post(`/payroll/payments/${batchId}/retry`),

  // §8 — cancel.
  cancel: (batchId, reason = '') => api.post(`/payroll/payments/${batchId}/cancel`, { reason }),

  // §4 — reopen a failed batch.
  reopen: (batchId) => api.post(`/payroll/payments/${batchId}/reopen`),
};

export default payrollPaymentService;
