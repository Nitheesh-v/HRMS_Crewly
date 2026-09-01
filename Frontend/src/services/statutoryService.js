import api from './api.js';

// Phase 29.10 — Statutory Compliance & Government Reports.
//
// Every call is tenant-scoped by the backend (req.companyId). No salary
// figure is ever sent from the browser: the server reads every number from
// the immutable payroll snapshot, so a crafted request cannot move a rupee.
const statutoryService = {
  // ── §5 — dashboard ───────────────────────────────────────────────────────
  dashboard: (month = '') =>
    api.get('/payroll/statutory/dashboard', { params: { month: month || undefined } }),

  // ── §7–§12, §16 — one report ─────────────────────────────────────────────
  report: ({ type, month = '' } = {}) =>
    api.get(`/payroll/statutory/reports/${type}`, { params: { month: month || undefined } }),

  // ── §6 — generate every applicable report for a month ────────────────────
  generate: (month) => api.post('/payroll/statutory/generate', { month }),

  // ── §14 — filing status ──────────────────────────────────────────────────
  updateFiling: ({ type, month, status, filingReference = '', filingRemarks = '' }) =>
    api.patch(
      `/payroll/statutory/reports/${type}/status`,
      { status, filingReference, filingRemarks },
      { params: { month: month || undefined } },
    ),

  // ── §15 — Excel / CSV / PDF ──────────────────────────────────────────────
  exportReport: ({ reportKey, month = '', financialYear = '', format = 'CSV' }) =>
    api.get('/payroll/statutory/export', {
      params: {
        reportKey,
        month: month || undefined,
        financialYear: financialYear || undefined,
        format,
      },
      responseType: 'blob',
    }),

  // ── §13 — the monthly compliance register ────────────────────────────────
  register: (financialYear = '') =>
    api.get('/payroll/statutory/register', {
      params: { financialYear: financialYear || undefined },
      responseType: 'blob',
    }),

  history: (financialYear = '') =>
    api.get('/payroll/statutory/history', {
      params: { financialYear: financialYear || undefined },
    }),

  // ── §18 — annual reports ─────────────────────────────────────────────────
  annual: (financialYear = '') =>
    api.get('/payroll/statutory/annual', {
      params: { financialYear: financialYear || undefined },
    }),

  requestAnnualExport: ({ financialYear, reportKey, format = 'XLSX' }) =>
    api.post('/payroll/statutory/annual/export', { financialYear, reportKey, format }),

  exports: ({ month = '', financialYear = '' } = {}) =>
    api.get('/payroll/statutory/exports', {
      params: { month: month || undefined, financialYear: financialYear || undefined },
    }),

  downloadExport: (exportId) =>
    api.get(`/payroll/statutory/exports/${exportId}`, { responseType: 'blob' }),

  // ── §19 — the compliance calendar ────────────────────────────────────────
  calendar: (months = []) =>
    api.get('/payroll/statutory/calendar', {
      params: { months: months.length ? months.join(',') : undefined },
    }),

  updateCalendarTask: ({ month, type, done = true, note = '' }) =>
    api.post('/payroll/statutory/calendar/tasks', { month, type, done, note }),

  sendReminders: (month = '') => api.post('/payroll/statutory/calendar/reminders', { month }),

  // ── §17 — the employee statutory view ────────────────────────────────────
  employee: (employeeId, month = '') =>
    api.get(`/payroll/statutory/employees/${employeeId}`, {
      params: { month: month || undefined },
    }),

  // Self-service: no employee id travels — the backend reads it from the JWT.
  mine: (month = '') =>
    api.get('/payroll/statutory/mine', { params: { month: month || undefined } }),
};

// Downloads come back as Blobs; this is the one place that turns one into a
// file. Reused from the payslip service's pattern.
export const saveBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export default statutoryService;
