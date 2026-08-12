// ============================================================
// 👤 PROFILE SERVICE — /api/profile/*
// ============================================================
import * as apiNS from './api';

const api = apiNS.default || apiNS.api || apiNS;

const profileService = {
  getMe: () => api.get('/profile/me'),
  updateMe: (payload) => api.put('/profile/me', payload),
  uploadAvatar: (file) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return api.post('/profile/avatar', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  removeAvatar: () => api.delete('/profile/avatar'),
};

export default profileService;
export { profileService };