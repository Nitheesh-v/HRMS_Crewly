import api from './api.js';

// Phase 29.4 — Employee Payroll Profiles.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser (§3).
const employeePayrollService = {
  list: (params = {}) => api.get('/payroll/employees', { params }),

  get: (employeeId) => api.get(`/payroll/employees/${employeeId}`),

  // §9 — display-only breakup. Nothing is stored.
  preview: (payload) => api.post('/payroll/employees/preview', payload),

  // Creates the profile, or writes a new salary revision (§15).
  save: (employeeId, payload) => api.put(`/payroll/employees/${employeeId}`, payload),

  setStatus: (employeeId, status) =>
    api.post(`/payroll/employees/${employeeId}/status`, { status }),
};

export default employeePayrollService;
