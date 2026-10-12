// ============================================================
// PROFILE SERVICE — /api/profile/*
//
// Two lanes (Phase 38):
//   1. DIRECT   — fields the employee may change themselves
//                 (phone, gender, birthday, address, emergency contact).
//   2. REQUEST  — fields an approver must confirm first
//                 (name, designation, employee code, date of joining,
//                  bank account, IFSC). Nothing is written until HR/admin
//                  approves, so the UI never pretends the edit landed.
// ============================================================
import api from './api';

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

  // ── Phase 38 — profile change requests ──────────────────────
  // `payload` = { changes: { field: value, ... }, reason?: string }
  submitChangeRequest: (payload) => api.post('/profile/change-requests', payload),
  myChangeRequests: () => api.get('/profile/change-requests/me'),
  cancelChangeRequest: (id) => api.post(`/profile/change-requests/${id}/cancel`),

  // Reviewer lane — requires PROFILE_CHANGE_REVIEW on the server.
  pendingChangeRequests: () => api.get('/profile/change-requests/pending'),
  changeRequestHistory: (status = 'approved') =>
    api.get(`/profile/change-requests/history?status=${status}`),
  getChangeRequest: (id) => api.get(`/profile/change-requests/${id}`),
  decideChangeRequest: (id, action, decisionNote = '') =>
    api.post(`/profile/change-requests/${id}/${action}`, { decisionNote }),
};

export default profileService;
export { profileService };
