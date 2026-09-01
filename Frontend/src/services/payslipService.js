import api from './api.js';

// Phase 29.9 — Payslip Generation & Employee Salary Portal.
//
// Every call is tenant-scoped by the backend (req.companyId). The employee
// routes (/mine/*) send no employee id at all — the backend reads it from
// the JWT, so a crafted id cannot widen the query (§3 / §26).
const payslipService = {
  // ── admin / payroll side (§27) ───────────────────────────────────────────

  // §27.1 — dashboard counters for a month.
  dashboard: (month = '') => api.get('/payroll/payslips/dashboard', { params: { month: month || undefined } }),

  // §27.3 — the payslip list, filterable (§15).
  list: ({ month = '', year = '', financialYear = '', search = '' } = {}) =>
    api.get('/payroll/payslips', {
      params: {
        month: month || undefined,
        year: year || undefined,
        financialYear: financialYear || undefined,
        search: search || undefined,
      },
    }),

  // §16 — one payslip as JSON (preview).
  detail: (payslipId) => api.get(`/payroll/payslips/${payslipId}`),

  // §17 — generate every payslip of a month (background when possible).
  generate: (month) => api.post('/payroll/payslips/generate', { month }),

  // §22 — re-render the PDF from the stored snapshot.
  regenerate: (payslipId) => api.post(`/payroll/payslips/${payslipId}/regenerate`),

  // §19 — email one payslip.
  emailOne: (payslipId) => api.post(`/payroll/payslips/${payslipId}/email`),

  // §19 / §24 — email the whole month.
  emailMonth: (month) => api.post('/payroll/payslips/email', { month }),

  // §4 — the Company Admin's payroll register (CSV).
  register: (month = '') =>
    api.get('/payroll/payslips/register', { params: { month: month || undefined }, responseType: 'blob' }),

  // §18 — bulk download: department ZIP or company ZIP.
  requestBulkDownload: ({ month, scope = 'COMPANY', departmentId = null }) =>
    api.post('/payroll/payslips/bulk-download', { month, scope, departmentId }),

  bulkDownloads: (month = '') =>
    api.get('/payroll/payslips/bulk-download', { params: { month: month || undefined } }),

  // ── employee self-service (§14) ──────────────────────────────────────────

  mine: () => api.get('/payroll/payslips/mine'),

  // §25 — opening a payslip is an audited "viewed" action.
  mineDetail: (payslipId) => api.get(`/payroll/payslips/mine/${payslipId}`),

  download: (payslipId) =>
    api.get(`/payroll/payslips/${payslipId}/pdf`, { responseType: 'blob' }),

  downloadMine: (payslipId) =>
    api.get(`/payroll/payslips/mine/${payslipId}/pdf`, { responseType: 'blob' }),

  downloadBulk: (fileId) =>
    api.get(`/payroll/payslips/bulk-download/${fileId}`, { responseType: 'blob' }),
};

// Downloads come back as Blobs (the api interceptor passes Blob responses
// straight through), so this is the one place that turns one into a file.
export const saveBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export default payslipService;
