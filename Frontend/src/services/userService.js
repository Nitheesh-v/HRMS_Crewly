import api from './api.js';

const userService = {
  // returns { data, meta } — see api.js meta handling
  getAll: (params = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return api.get(`/users${query ? `?${query}` : ''}`);
  },
  getHierarchy: () => api.get('/users/hierarchy'),
  create: (payload) => api.post('/users', payload),
  update: (id, payload) => api.put(`/users/${id}`, payload),
  resetPassword: (id, newPassword) => api.patch(`/users/${id}/reset-password`, { newPassword }),
};

export default userService;