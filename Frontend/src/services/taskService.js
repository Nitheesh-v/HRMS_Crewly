import api from './api.js';

const taskService = {
  list: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return api.get(`/tasks${q ? `?${q}` : ''}`);
  },
  create: (payload) => api.post('/tasks', payload),
  update: (id, payload) => api.put(`/tasks/${id}`, payload),
  updateStatus: (id, status) => api.patch(`/tasks/${id}/status`, { status }),
  // Phase 32.8 — gated attachment delivery (task visibility checked backend-side).
  downloadAttachment: (taskId, attachmentId) =>
    api.get(`/tasks/${taskId}/attachments/${attachmentId}/file`, { responseType: 'blob' }),
  remove: (id) => api.delete(`/tasks/${id}`),
};

export default taskService;