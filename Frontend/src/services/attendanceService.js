import api from './api.js';

const attendanceService = {
  punchIn: () => api.post('/attendance/punch-in'),
  punchOut: () => api.post('/attendance/punch-out'),
  today: () => api.get('/attendance/today'),
  // Phase 31.2 — advanced punching. recordEvent normalizes the replay
  // envelope (200 + meta) to the same { event, snapshot } shape as 201.
  todayLive: () => api.get('/attendance/today/live'),
  recordEvent: async ({ action, workMode = null, date = null, idempotencyKey = null }) => {
    const result = await api.post('/attendance/events', {
      action,
      ...(workMode ? { workMode } : {}),
      ...(date ? { date } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return result && result.success !== undefined && result.data ? result.data : result;
  },
  my: (month) => api.get(`/attendance/my?month=${month}`),
  company: (date) => api.get(`/attendance/company${date ? `?date=${date}` : ''}`),
  report: (month, department) =>
    api.get(`/attendance/report?month=${month}${department ? `&department=${department}` : ''}`),
};

export default attendanceService;