import api from './api';

const exitService = {
  resign: (data) => api.post('/exit/resign', data),
  my: () => api.get('/exit/my'),
  requests: (status) => api.get('/exit/requests', { params: status ? { status } : {} }),
  decide: (id, data) => api.patch(`/exit/${id}/decide`, data),
  withdraw: (id) => api.patch(`/exit/${id}/withdraw`),
};

export default exitService;