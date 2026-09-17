import api from './api';

const companyService = {
  getMy: () => api.get('/companies/my'),
  updateMy: (payload) => api.put('/companies/my', payload),
  getBranding: () => api.get('/companies/my/branding'),
  updateBranding: (payload) => api.put('/companies/my/branding', payload),
  uploadLogo: (file) => {
    const form = new FormData();
    form.append('logo', file);
    return api.post('/companies/my/branding/logo', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  removeLogo: () => api.delete('/companies/my/branding/logo'),
  // Visual preview only — the backend renders sample data, never a real payslip.
  previewPayslip: (payload) =>
    api
      .post('/companies/my/branding/payslip-preview', payload || {}, { responseType: 'blob' })
      .then((r) => r.data ?? r),
};

export default companyService;
