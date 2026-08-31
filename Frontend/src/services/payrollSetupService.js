import api from './api.js';

// Phase 29.1 — Company Payroll Setup.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser.
const payrollSetupService = {
  get: () => api.get('/payroll/setup'),
  start: () => api.post('/payroll/setup/start'),
  saveSection: (section, payload) => api.patch(`/payroll/setup/${section}`, payload),
  activate: (configVersion) => api.post('/payroll/setup/activate', { configVersion }),
  suspend: (reason) => api.post('/payroll/setup/suspend', { reason }),
};

export default payrollSetupService;
