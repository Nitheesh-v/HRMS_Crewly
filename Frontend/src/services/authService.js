import api from './api.js';

const authService = {
  login: (payload) =>
    api.post('/auth/login', payload),

  registerCompany: (payload) =>
    api.post(
      '/auth/register-company',
      payload,
    ),

  getMe: () =>
    api.get('/auth/me'),

  refresh: () =>
    api.post('/auth/refresh', {}),

  logout: () =>
    api.post('/auth/logout', {}),

  logoutAll: () =>
    api.post('/auth/logout-all', {}),

  forgotPassword: (payload) =>
    api.post(
      '/auth/forgot-password',
      payload,
    ),

  resetPassword: (payload) =>
    api.post(
      '/auth/reset-password',
      payload,
    ),

  changePassword: (payload) =>
    api.patch(
      '/auth/change-password',
      payload,
    ),

  sessions: () =>
    api.get('/auth/sessions'),

  revokeSession: (sessionId) =>
    api.delete(
      `/auth/sessions/${encodeURIComponent(
        sessionId,
      )}`,
    ),
};

export default authService;