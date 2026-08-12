import api from './api.js';

const projectService = {
  list: () => api.get('/projects'),
  detail: (id) => api.get(`/projects/${id}`),
  create: (payload) => api.post('/projects', payload),
  update: (id, payload) => api.put(`/projects/${id}`, payload),
  updateTeam: (id, payload) => api.patch(`/projects/${id}/team`, payload),
  remove: (id) => api.delete(`/projects/${id}`),
};

export default projectService;