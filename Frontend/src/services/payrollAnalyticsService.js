import api from './api.js';
// The blob-saver lives with the statutory service: one place turns a Blob
// into a file, and it is not reinvented here.
import { saveBlob } from './statutoryService.js';

// Phase 29.12 — Payroll Analytics, Reports & Financial Dashboard.
//
// Every call is tenant-scoped by the backend (req.companyId). No figure is
// ever computed in the browser: the server derives everything from the 29.6
// payroll snapshots (§11 — "Do not recalculate old payroll"), so a crafted
// request cannot move a number by a rupee (§25).
const payrollAnalyticsService = {
  // ── §5 / §6 — the executive dashboard ─────────────────────────────────────
  dashboard: (month = '') =>
    api.get('/payroll/analytics/dashboard', { params: { month: month || undefined } }),

  // ── §6 … §17 — one report ────────────────────────────────────────────────
  report: ({ reportKey, month = '', period = '', financialYear = '', departmentId = '', designation = '', employeeId = '', status = '' } = {}) =>
    api.get(`/payroll/analytics/${encodeURIComponent(reportKey)}`, {
      params: {
        month: month || undefined,
        period: period || undefined,
        financialYear: financialYear || undefined,
        departmentId: departmentId || undefined,
        designation: designation || undefined,
        employeeId: employeeId || undefined,
        status: status || undefined,
      },
    }),

  // ── §19 — export straight away (small reports) ────────────────────────────
  exportReport: ({ reportKey, format = 'CSV', ...filters } = {}) =>
    api.get(`/payroll/analytics/export/${encodeURIComponent(reportKey)}`, {
      params: { format, ...filters },
      responseType: 'blob',
    }),

  // ── §19 / §22 — queue a large export ─────────────────────────────────────
  requestExport: ({ reportKey, format = 'XLSX', ...filters } = {}) =>
    api.post(`/payroll/analytics/export/${encodeURIComponent(reportKey)}`, { format, ...filters }),

  files: (reportKey = '') =>
    api.get('/payroll/analytics/files', { params: { reportKey: reportKey || undefined } }),

  downloadFile: (fileId) => api.get(`/payroll/analytics/files/${fileId}`, { responseType: 'blob' }),

  // ── §20 — scheduled reports ──────────────────────────────────────────────
  schedules: () => api.get('/payroll/analytics/schedules'),

  createSchedule: (payload) => api.post('/payroll/analytics/schedules', payload),

  updateSchedule: (scheduleId, patch) => api.patch(`/payroll/analytics/schedules/${scheduleId}`, patch),

  deleteSchedule: (scheduleId) => api.delete(`/payroll/analytics/schedules/${scheduleId}`),

  // ── §22 executive dashboard refresh ──────────────────────────────────────
  refresh: (month = '') => api.post('/payroll/analytics/refresh', { month: month || undefined }),
};

export { saveBlob };

export default payrollAnalyticsService;
