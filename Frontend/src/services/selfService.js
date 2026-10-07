// ============================================================
// SELF-SERVICE API — documents · meetings · announcements
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

// The old `meetingService` (my/create/cancel) was removed: nothing imported it,
// `GET /meetings/my` has never existed on the meetings router, and its `cancel`
// issued a DELETE — which deletes the meeting instead of cancelling it. The one
// real meeting client is `services/meetingService.js` (same wrapper as PUT/PATCH,
// plus the /:id/cancel route). Keeping a second, wrong copy here was a trap for
// the next person who needed to edit a meeting.

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
  managerOverview: () => api.get('/dashboard/manager'), // Phase 10 line
};