import api from './api.js';

const authService = {
  login: (payload) => api.post('/auth/login', payload),
  registerCompany: (payload) => api.post('/auth/register-company', payload),
  getMe: () => api.get('/auth/me'),
};

export default authService;