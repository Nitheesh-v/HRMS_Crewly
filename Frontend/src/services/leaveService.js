import api from './api.js';

const leaveService = {
  apply: (payload) => api.post('/leaves', payload),
  my: () => api.get('/leaves/my'),
  cancel: (id) => api.patch(`/leaves/${id}/cancel`),
  pending: () => api.get('/leaves/pending'),
  requests: (status = 'ALL') => api.get(`/leaves/requests?status=${status}`),
  decide: (id, action, note) => api.patch(`/leaves/${id}/decide`, { action, note }),
};

export default leaveService;