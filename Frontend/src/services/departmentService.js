import api from './api.js';

const departmentService = {
  getAll: () => api.get('/departments'),
  create: (payload) => api.post('/departments', payload),
  update: (id, payload) => api.put(`/departments/${id}`, payload),
  remove: (id) => api.delete(`/departments/${id}`),
};

export default departmentService;