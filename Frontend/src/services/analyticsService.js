// One function per backend endpoint. Nothing fancy.
// unwrap() handles all 3 response shapes your api.js could produce.
import api from './api.js';

const unwrap = (r) => r?.data?.data ?? r?.data ?? r ?? {};

export const analyticsService = {
  overview: (params) => api.get('/analytics/overview', { params }).then(unwrap),
  attendance: (params) => api.get('/analytics/attendance', { params }).then(unwrap),
  leaves: (params) => api.get('/analytics/leaves', { params }).then(unwrap),
  payroll: (params) => api.get('/analytics/payroll', { params }).then(unwrap),
  work: (params) => api.get('/analytics/work', { params }).then(unwrap),
  recruitment: (params) => api.get('/analytics/recruitment', { params }).then(unwrap),
  my: () => api.get('/analytics/my').then(unwrap),
  saas: () => api.get('/saas/overview').then(unwrap),

  builderMeta: () => api.get('/report-builder/meta').then(unwrap),
  runReport: (payload) => api.post('/report-builder/run', payload).then(unwrap),
  // exports come back as a file (blob), not JSON → responseType: 'blob'
  exportReport: (payload, format) =>
    api.post(`/report-builder/export?format=${format}`, payload, { responseType: 'blob' }).then((r) => r.data ?? r),
};

export default analyticsService;