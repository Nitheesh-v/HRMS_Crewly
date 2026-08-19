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
};

export default superAdminService;
export { superAdminService };
