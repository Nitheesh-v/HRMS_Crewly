import api from "./api.js";

const unwrap = (r) => r?.data?.data ?? r?.data ?? r ?? {};

const get = (url, params) => api.get(url, { params }).then(unwrap);

const post = (url, body) => api.post(url, body).then(unwrap);

const patch = (url, body) => api.patch(url, body).then(unwrap);

const superAdminService = {
  // Authentication
  login: (body) => post("/super-admin/auth/login", body),

  verifyTwoFactor: (body) => post("/super-admin/auth/verify-2fa", body),

  forgotPassword: (email) =>
    post("/super-admin/auth/forgot-password", {
      email,
    }),

  resetPassword: (body) => post("/super-admin/auth/reset-password", body),

  logout: () => post("/super-admin/auth/logout", {}),

  sessions: () => get("/super-admin/auth/sessions"),

  logoutOthers: () => post("/super-admin/auth/logout-others", {}),

  changePassword: (body) => patch("/super-admin/auth/change-password", body),

  setTwoFactor: (enabled) => patch("/super-admin/auth/2fa", { enabled }),

  // Phase 30.6 — internal BGV verifier account management (SUPER_ADMIN).
  bgvVerifiers: () => get("/super-admin/bgv-verifiers"),
  bgvVerifier: (id) => get(`/super-admin/bgv-verifiers/${id}`),
  inviteBgvVerifier: (body) => post("/super-admin/bgv-verifiers", body),
  resendBgvVerifierSetup: (id) =>
    post(`/super-admin/bgv-verifiers/${id}/resend-setup`, {}),
  revokeBgvVerifierSetup: (id) =>
    post(`/super-admin/bgv-verifiers/${id}/revoke-setup`, {}),
  updateBgvVerifier: (id, body) =>
    patch(`/super-admin/bgv-verifiers/${id}`, body),
  deactivateBgvVerifier: (id, body) =>
    post(`/super-admin/bgv-verifiers/${id}/deactivate`, body || {}),
  reactivateBgvVerifier: (id) =>
    post(`/super-admin/bgv-verifiers/${id}/reactivate`, {}),

  // Phase 30.7 — BGV check assignment operations (platform-only).
  bgvOperationsQueue: () => get("/super-admin/bgv-operations/queue"),
  bgvEligibleVerifiers: (checkType) =>
    get(`/super-admin/bgv-operations/checks/${checkType}/eligible-verifiers`),
  bgvAssignCheck: (body) => post("/super-admin/bgv-operations/assign", body),

  // Phase 30.10 — internal BGV QA review + final report release.
  bgvQaQueue: (params) => get("/super-admin/bgv-qa/queue", params),
  bgvQaDetail: (orderId, checkType) => get(`/super-admin/bgv-qa/check/${orderId}/${checkType}`),
  bgvQaApprove: (orderId, checkType) => post(`/super-admin/bgv-qa/check/${orderId}/${checkType}/approve`, {}),
  bgvQaReturn: (orderId, checkType, body) => post(`/super-admin/bgv-qa/check/${orderId}/${checkType}/return`, body),
  bgvQaEvidence: async (orderId, checkType, fileId) =>
    api.get(`/super-admin/bgv-qa/check/${orderId}/${checkType}/evidence/${fileId}`, { responseType: "blob" }),
  bgvQaReportStatus: (orderId) => get(`/super-admin/bgv-qa/report/${orderId}`),
  bgvQaGenerateReport: (orderId) => post(`/super-admin/bgv-qa/report/${orderId}/generate`, {}),
  bgvQaRetryPdf: (orderId) => post(`/super-admin/bgv-qa/report/${orderId}/pdf-retry`, {}),
  bgvQaReleaseReport: (orderId) => post(`/super-admin/bgv-qa/report/${orderId}/release`, {}),
  bgvQaDownloadReport: (orderId) =>
    api.get(`/super-admin/bgv-qa/report/${orderId}/download`, { responseType: "blob" }),
  bgvReassignCheck: (body) => post("/super-admin/bgv-operations/reassign", body),
  bgvUnassignCheck: (body) => post("/super-admin/bgv-operations/unassign", body),
  // Phase 30.8 — platform-only check cancellation (CANCELLED is never a
  // verifier choice; business reason required).
  bgvCancelCheck: (body) => post("/super-admin/bgv-operations/cancel-check", body),

  // Dashboard
  dashboard: () => get("/super-admin/dashboard"),

  charts: () => get("/super-admin/dashboard/charts"),

  search: (q) => get("/super-admin/search", { q }),

  // Companies
  companies: (params) => get("/super-admin/companies", params),

  company: (id) => get(`/super-admin/companies/${id}`),

  createCompany: (body) => post("/super-admin/companies", body),

  updateCompany: (id, body) => patch(`/super-admin/companies/${id}`, body),

  setCompanyStatus: (id, status) =>
    patch(`/super-admin/companies/${id}/status`, { status }),

  archiveCompany: (id) =>
    api.delete(`/super-admin/companies/${id}`).then(unwrap),

  users: (params) => get("/super-admin/users", params),

  platformAdmins: () => get("/super-admin/platform-admins"),

  // Phase 30.2 — BGV service catalogue & pricing (platform commerce).
  bgvCatalogue: () => get("/super-admin/bgv-catalogue"),

  updateBgvCatalogue: (type, body) =>
    patch(`/super-admin/bgv-catalogue/${type}`, body),

  // Subscriptions and plans
  subscriptions: (params) => get("/super-admin/subscriptions", params),

  updateSubscription: (companyId, body) =>
    patch(`/super-admin/subscriptions/${companyId}`, body),

  plans: () => get("/super-admin/plans"),

  savePlan: (body) => post("/super-admin/plans", body),

  // Billing and revenue
  billing: (params) => get("/super-admin/billing", params),

  updatePayment: (id, body) =>
    patch(`/super-admin/billing/payments/${id}`, body),

  revenue: () => get("/super-admin/revenue"),

  // Operations
  usage: (params) => get("/super-admin/usage", params),

  support: (params) => get("/super-admin/support", params),

  updateSupport: (id, body) => patch(`/super-admin/support/${id}`, body),

  health: () => get("/super-admin/system-health"),

  auditLogs: (params) => get("/super-admin/audit-logs", params),

  settings: () => get("/super-admin/settings"),

  updateSettings: (body) => patch("/super-admin/settings", body),

  // Platform notifications
  notifications: (params) => get("/super-admin/notifications", params),

  markNotification: (id) => patch(`/super-admin/notifications/${id}/read`, {}),

  markAllNotifications: () => patch("/super-admin/notifications/read-all", {}),

  // ---- 28.8 Background Operations (queue / worker / cache ops) ----
  opsOverview: () => get("/super-admin/operations/queues"),

  opsFailedJobs: (queueName, params) =>
    get(`/super-admin/operations/queues/${queueName}/failed`, params),

  opsJobDetail: (queueName, jobId) =>
    get(`/super-admin/operations/queues/${queueName}/jobs/${jobId}`),

  opsRetryJob: (queueName, jobId) =>
    post(`/super-admin/operations/queues/${queueName}/jobs/${jobId}/retry`, {}),

  opsBatchRetry: (queueName, jobIds) =>
    post(`/super-admin/operations/queues/${queueName}/retry-failed`, { jobIds }),

  opsRemoveJob: (queueName, jobId) =>
    api.delete(`/super-admin/operations/queues/${queueName}/jobs/${jobId}`).then(unwrap),

  opsPauseQueue: (queueName) =>
    post(`/super-admin/operations/queues/${queueName}/pause`, {}),

  opsResumeQueue: (queueName) =>
    post(`/super-admin/operations/queues/${queueName}/resume`, {}),

  opsReconcilePreview: () => get("/super-admin/operations/reconcile/preview"),

  opsReconcileRun: (area, limit) =>
    post("/super-admin/operations/reconcile", { area, limit }),

  opsCacheStatus: () => get("/super-admin/operations/cache"),

  opsInvalidateCache: (companyId) =>
    post("/super-admin/operations/cache/invalidate", { companyId }),
};

export default superAdminService;
export { superAdminService };
