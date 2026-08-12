import api from './api';

// ---------- helpers (survive both api response shapes) ----------
export const arr = (x) => (Array.isArray(x) ? x : x?.data ?? []);
export const obj = (x) => (x?.data ?? x);

// ---------- projects ----------
export const listProjects = (params = {}) => api.get('/projects', { params });
export const getProject = (id) => api.get(`/projects/${id}`);
export const createProject = (payload) => api.post('/projects', payload);
export const updateProject = (id, payload) => api.put(`/projects/${id}`, payload);
export const deleteProject = (id) => api.delete(`/projects/${id}`);

// ---------- tasks ----------
export const listTasks = (params = {}) => api.get('/tasks', { params });
export const getTask = (id) => api.get(`/tasks/${id}`);
export const createTask = (payload) => api.post('/tasks', payload);
export const updateTask = (id, payload) => api.put(`/tasks/${id}`, payload);
export const updateTaskStatus = (id, payload) => api.patch(`/tasks/${id}/status`, payload);
export const addComment = (id, text) => api.post(`/tasks/${id}/comments`, { text });
export const uploadAttachment = (id, formData) =>
  api.post(`/tasks/${id}/attachments`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
export const deleteAttachment = (taskId, attachmentId) => api.delete(`/tasks/${taskId}/attachments/${attachmentId}`);
export const deleteTask = (id) => api.delete(`/tasks/${id}`);

// 🔔 Phase 13 — notification preferences
export const getNotifyPrefs = () => api.get('/notification-prefs');
export const saveNotifyPrefs = (payload) => api.put('/notification-prefs', payload);