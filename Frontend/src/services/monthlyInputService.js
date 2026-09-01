import api from './api.js';

// Phase 29.5 — Variable Pay & Monthly Payroll Inputs.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser (§3).
const monthlyInputService = {
  periods: () => api.get('/payroll/inputs/periods'),

  list: (params = {}) => api.get('/payroll/inputs', { params }),

  // §7 / §14 / §15 — pull attendance, leave and shift figures in.
  importAutomatic: (month) => api.post('/payroll/inputs/import', { month }),

  get: (employeeId, month) =>
    api.get(`/payroll/inputs/employee/${employeeId}`, { params: { month } }),

  addEntry: (employeeId, payload) =>
    api.post(`/payroll/inputs/employee/${employeeId}/entries`, payload),

  updateEntry: (employeeId, entryId, payload) =>
    api.patch(`/payroll/inputs/employee/${employeeId}/entries/${entryId}`, payload),

  removeEntry: (employeeId, entryId, month) =>
    api.delete(`/payroll/inputs/employee/${employeeId}/entries/${entryId}`, {
      params: { month },
    }),

  // §11 — preview first, store only after HR confirms.
  previewImport: (payload) => api.post('/payroll/inputs/bulk/preview', payload),

  confirmImport: (payload) => api.post('/payroll/inputs/bulk/confirm', payload),

  // §12
  bulkAction: (payload) => api.post('/payroll/inputs/bulk/action', payload),

  // §19
  validate: (month) => api.post('/payroll/inputs/validate', { month }),

  // §20
  setStatus: (month, status) => api.post('/payroll/inputs/status', { month, status }),
};

// The template is generated in the browser so no server round trip is needed.
const TEMPLATE_HEADER = ['employeeCode', 'type', 'amount', 'reason', 'claimDate', 'remarks'];

export const downloadImportTemplate = () => {
  const rows = [
    TEMPLATE_HEADER.join(','),
    'EMP001,BONUS_FESTIVAL,5000,Diwali bonus,2026-08-15,Annual festival bonus',
    'EMP002,REIMBURSEMENT_TRAVEL,1200,Client visit,2026-08-09,Cab and toll',
  ].join('\n');

  const blob = new Blob([rows], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = 'crewly-monthly-inputs-template.csv';
  link.click();

  URL.revokeObjectURL(url);
};

export default monthlyInputService;
