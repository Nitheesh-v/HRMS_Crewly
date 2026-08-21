import api from './api';

// Phase 27.1 / 27.2 — hiring requisitions.
// Keeps the existing unwrap behaviour: api already returns response data.
const requisitionService = {
  list: (params = {}) => api.get('/recruitment/requisitions', { params }),

  get: (id) => api.get(`/recruitment/requisitions/${id}`),

  create: (data) => api.post('/recruitment/requisitions', data),

  update: (id, data) => api.patch(`/recruitment/requisitions/${id}`, data),

  submit: (id) => api.post(`/recruitment/requisitions/${id}/submit`),

  decide: (id, decision, reason = '') =>
    api.post(`/recruitment/requisitions/${id}/decision`, { decision, reason }),

  remove: (id) => api.delete(`/recruitment/requisitions/${id}`),
};

export default requisitionService;
