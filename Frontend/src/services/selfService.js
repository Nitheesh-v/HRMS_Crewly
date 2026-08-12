// ============================================================
// 🧩 SELF-SERVICE API — documents · meetings · announcements
// support tickets · dashboards (Phase 9 + 10)
// ============================================================
import api from './api';

export const documentService = {
  my: () => api.get('/documents/my'),
  upload: (file, name, category) => {
    const fd = new FormData();
    fd.append('document', file);
    fd.append('name', name);
    fd.append('category', category);
    return api.post('/documents', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  remove: (id) => api.delete(`/documents/${id}`),
};

export const meetingService = {
  my: () => api.get('/meetings/my'),
  create: (payload) => api.post('/meetings', payload),
  cancel: (id) => api.delete(`/meetings/${id}`),
};

export const announcementService = {
  list: () => api.get('/announcements'),
  create: (payload) => api.post('/announcements', payload),
  remove: (id) => api.delete(`/announcements/${id}`),
};

export const supportService = {
  my: () => api.get('/support/my'),
  listAll: (status) => api.get('/support', { params: status ? { status } : {} }),
  create: (payload) => api.post('/support', payload),
  reply: (id, message) => api.post(`/support/${id}/reply`, { message }),
  setStatus: (id, status) => api.patch(`/support/${id}/status`, { status }),
};

export const dashboardService = {
  employeeOverview: () => api.get('/dashboard/employee'),
  managerOverview: () => api.get('/dashboard/manager'), // 👈 Phase 10 line
};