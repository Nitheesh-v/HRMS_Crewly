import api from './api.js';

// Phase 29.7 — Payroll Review & Approval.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser (§3). This service never
// calculates anything — every number it shows comes from the 29.6 snapshot.
const payrollReviewService = {
  // §7 — the cached dashboard: review state, KPI cards, checklist, error
  // counts. The employee list is a separate call so the cached blob stays
  // small (§20).
  dashboard: (month) => api.get(`/payroll/review/${month}`),

  // §8 — employee rows with their per-employee review state.
  employees: (month, params = {}) => api.get(`/payroll/review/${month}/employees`, { params }),

  // §9 — one employee's payroll breakdown for review.
  employee: (month, employeeId) => api.get(`/payroll/review/${month}/employees/${employeeId}`),

  // §10 / §22 — the error report.
  errors: (month) => api.get(`/payroll/review/${month}/errors`),

  // §17 — what changed between the last two snapshot versions.
  differences: (month) => api.get(`/payroll/review/${month}/differences`),

  // §11 — tick or clear one checklist box.
  setChecklist: (month, item, value) =>
    api.patch(`/payroll/review/${month}/checklist/${item}`, { value: Boolean(value) }),

  // §15 — remarks are append-only.
  addRemark: (month, message, channel = 'HR') =>
    api.post(`/payroll/review/${month}/remarks`, { message, channel }),

  // §8 — mark one employee reviewed (or back to pending) with a note.
  reviewEmployee: (month, employeeId, payload = {}) =>
    api.patch(`/payroll/review/${month}/employees/${employeeId}`, payload),

  // §18 — bulk review actions. Never touches a salary value.
  bulk: (month, action, employeeIds = []) =>
    api.post(`/payroll/review/${month}/bulk`, { action, employeeIds }),

  // §12 — lock payroll: the month becomes read-only.
  lock: (month) => api.post(`/payroll/review/${month}/lock`),

  // §13 — reopen requires a reason.
  reopen: (month, reason) => api.post(`/payroll/review/${month}/reopen`, { reason }),

  // §14 — submit to finance, then approve or reject.
  submit: (month) => api.post(`/payroll/review/${month}/submit`),
  approve: (month) => api.post(`/payroll/review/${month}/approve`),
  reject: (month, reason) => api.post(`/payroll/review/${month}/reject`, { reason }),

  // §19 — reports. The server queues the job when Redis is up and returns the
  // CSV inline when it is not (§21).
  export: (month, reportKey) =>
    api.post(`/payroll/review/${month}/exports`, { reportKey }),
  getExport: (exportId) => api.get(`/payroll/review/exports/${exportId}`),
};

export default payrollReviewService;
