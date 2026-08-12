import api from './api';

export const listMeetings = (params = {}) => api.get('/meetings', { params });
export const getMeetingHistory = () => api.get('/meetings', { params: { view: 'history' } });
export const createMeeting = (payload) => api.post('/meetings', payload);
export const updateMeeting = (id, payload) => api.put(`/meetings/${id}`, payload);
export const cancelMeeting = (id, reason = '') => api.patch(`/meetings/${id}/cancel`, { reason });
export const deleteMeeting = (id) => api.delete(`/meetings/${id}`);