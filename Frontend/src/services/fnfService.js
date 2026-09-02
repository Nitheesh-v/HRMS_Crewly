import api from './api.js';
// The blob-saver lives with the statutory service: one place turns a Blob
// into a file, and it is not reinvented here.
import { saveBlob } from './statutoryService.js';

// Phase 29.11 — Final Settlement (F&F), Resignation Recovery & Exit Payroll.
//
// Every call is tenant-scoped by the backend (req.companyId). No amount is
// ever computed in the browser: the server derives every rupee from the exit
// record, the 29.6 payroll snapshot and the company's own policy, so a
// crafted request cannot move a settlement by a rupee (§24).
const fnfService = {
  // ── §19 — dashboard ──────────────────────────────────────────────────────
  dashboard: (month = '') =>
    api.get('/payroll/fnf/dashboard', { params: { month: month || undefined } }),

  // ── §19 — search + department filter ─────────────────────────────────────
  list: ({ month = '', status = '', search = '', departmentId = '' } = {}) =>
    api.get('/payroll/fnf', {
      params: {
        month: month || undefined,
        status: status || undefined,
        search: search || undefined,
        departmentId: departmentId || undefined,
      },
    }),

  // ── §25 — one settlement in full ─────────────────────────────────────────
  get: (settlementId) => api.get(`/payroll/fnf/${settlementId}`),

  // ── §5 — open a settlement from the Exit module ──────────────────────────
  create: (payload) => api.post('/payroll/fnf', payload),

  // ── §7 — calculate / recalculate ─────────────────────────────────────────
  calculate: (settlementId) => api.post(`/payroll/fnf/${settlementId}/calculate`),

  // ── §9 / §10 — manual payables and recoveries ────────────────────────────
  updateItems: ({ settlementId, payables, recoveries }) =>
    api.patch(`/payroll/fnf/${settlementId}/items`, { payables, recoveries }),

  // ── §12 — notice decision ────────────────────────────────────────────────
  setNotice: ({ settlementId, decision, noticePeriodDays }) =>
    api.patch(`/payroll/fnf/${settlementId}/notice`, { decision, noticePeriodDays }),

  // ── §15 — HR review ──────────────────────────────────────────────────────
  hrReview: ({ settlementId, checklist, complete, remarks }) =>
    api.post(`/payroll/fnf/${settlementId}/hr-review`, { checklist, complete, remarks }),

  // ── §16 — Finance approval / rejection ───────────────────────────────────
  finance: ({ settlementId, action, remarks }) =>
    api.post(`/payroll/fnf/${settlementId}/finance`, { action, remarks }),

  // ── §5 — payment ─────────────────────────────────────────────────────────
  markPaid: ({ settlementId, paidAt, reference, method }) =>
    api.post(`/payroll/fnf/${settlementId}/pay`, { paidAt, reference, method }),

  // ── §14 — close / reopen ─────────────────────────────────────────────────
  close: (settlementId) => api.post(`/payroll/fnf/${settlementId}/close`),

  reopen: ({ settlementId, remarks }) => api.post(`/payroll/fnf/${settlementId}/reopen`, { remarks }),

  // ── §17 — the F&F statement ──────────────────────────────────────────────
  requestStatement: (settlementId) => api.post(`/payroll/fnf/${settlementId}/statement`),

  downloadStatement: (settlementId) =>
    api.get(`/payroll/fnf/${settlementId}/statement/download`, { responseType: 'blob' }),

  // ── §21 — the bulk settlement register ───────────────────────────────────
  register: ({ month = '', format = 'CSV' } = {}) =>
    api.get('/payroll/fnf/register', {
      params: { month: month || undefined, format },
      responseType: 'blob',
    }),

  requestRegister: ({ month = '', format = 'XLSX' } = {}) =>
    api.post('/payroll/fnf/register/export', { month: month || undefined, format }),

  files: (month = '') => api.get('/payroll/fnf/files', { params: { month: month || undefined } }),

  downloadFile: (fileId) => api.get(`/payroll/fnf/files/${fileId}`, { responseType: 'blob' }),

  // ── §18 — the employee portal ────────────────────────────────────────────
  mine: () => api.get('/payroll/fnf/mine'),

  downloadMyStatement: () => api.get('/payroll/fnf/mine/statement', { responseType: 'blob' }),
};


export { saveBlob };

export default fnfService;
