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
  // 29.13 §4 — a period preset, or a custom range, alongside the single month.
  dashboard: ({ month = '', preset = '', fromMonth = '', toMonth = '' } = {}) =>
    api.get('/payroll/analytics/dashboard', {
      params: {
        month: month || undefined,
        preset: preset || undefined,
        fromMonth: fromMonth || undefined,
        toMonth: toMonth || undefined,
      },
    }),

  // ── §6 … §21 — one report ────────────────────────────────────────────────
  // `page`, `limit` and `search` (§22) are only honoured by reports that have
  // a row list; the server ignores them elsewhere rather than erroring.
  report: ({
    reportKey,
    month = '',
    period = '',
    preset = '',
    fromMonth = '',
    toMonth = '',
    financialYear = '',
    departmentId = '',
    designation = '',
    employeeId = '',
    status = '',
    employmentStatus = '',
    structureId = '',
    page = 0,
    limit = 0,
    search = '',
  } = {}) =>
    api.get(`/payroll/analytics/${encodeURIComponent(reportKey)}`, {
      params: {
        month: month || undefined,
        period: period || undefined,
        preset: preset || undefined,
        fromMonth: fromMonth || undefined,
        toMonth: toMonth || undefined,
        financialYear: financialYear || undefined,
        departmentId: departmentId || undefined,
        designation: designation || undefined,
        employeeId: employeeId || undefined,
        status: status || undefined,
        employmentStatus: employmentStatus || undefined,
        structureId: structureId || undefined,
        page: page || undefined,
        limit: limit || undefined,
        search: search || undefined,
      },
    }),

  // ── §23 — one employee's salary history ─────────────────────────────────
  employeeHistory: (employeeId) =>
    api.get(`/payroll/analytics/employee-history/${encodeURIComponent(employeeId)}`),

  // §2 / §23 — an employee sees their OWN history and nothing else.
  mySalaryHistory: () => api.get('/payroll/analytics/employee-history/mine'),

  // ── §8 — the company's own salary bands ─────────────────────────────────
  settings: () => api.get('/payroll/analytics/settings'),

  updateSalaryBands: (salaryBands = []) =>
    api.patch('/payroll/analytics/settings/bands', { salaryBands }),

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
