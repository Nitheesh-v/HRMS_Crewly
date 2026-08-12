import api from './api.js';

const payrollService = {
  setStructure: (userId, payload) => api.put(`/payroll/structure/${userId}`, payload),
  structures: () => api.get('/payroll/structures'),
  generate: (month) => api.post('/payroll/generate', { month }),
  list: (month) => api.get(`/payroll${month ? `?month=${month}` : ''}`),
  markPaid: (id) => api.patch(`/payroll/${id}/pay`),
  my: () => api.get('/payroll/my'),
  // Opens print-ready payslip HTML in a new tab (browser → Save as PDF)
  openPayslip: async (id) => {
    const blob = await api.get(`/payroll/${id}/payslip`, { responseType: 'blob' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};

export default payrollService;