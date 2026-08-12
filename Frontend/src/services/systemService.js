import api from './api';

const systemService = {
  notifications: () => api.get('/notifications'),
  unreadCount: () => api.get('/notifications/unread-count'),
  markRead: (id) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.patch('/notifications/read-all'),

  audit: (params) => api.get('/audit', { params }),
  permissions: () => api.get('/permissions'),
  analytics: () => api.get('/analytics/overview'),
};

export default systemService;