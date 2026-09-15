import api from './api.js';

const attendanceService = {
  punchIn: () => api.post('/attendance/punch-in'),
  punchOut: () => api.post('/attendance/punch-out'),
  today: () => api.get('/attendance/today'),
  // Phase 31.2 — advanced punching. recordEvent normalizes the replay
  // envelope (200 + meta) to the same { event, snapshot } shape as 201.
  todayLive: () => api.get('/attendance/today/live'),
  recordEvent: async ({ action, workMode = null, date = null, idempotencyKey = null, location = null }) => {
    const result = await api.post('/attendance/events', {
      action,
      ...(workMode ? { workMode } : {}),
      ...(date ? { date } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      // Phase 31.3 — CLOCK_IN geofence inputs (locationId + one-shot
      // position). Only sent for explicit attendance actions that need
      // verification; the backend measures everything server-side.
      ...(location?.locationId ? { locationId: location.locationId } : {}),
      ...(location?.position ? { position: location.position } : {}),
    });
    return result && result.success !== undefined && result.data ? result.data : result;
  },
  my: (month) => api.get(`/attendance/my?month=${month}`),
  company: (date) => api.get(`/attendance/company${date ? `?date=${date}` : ''}`),
  report: (month, department) =>
    api.get(`/attendance/report?month=${month}${department ? `&department=${department}` : ''}`),
  // Phase 31.9 — Who's Working live board. Scope derives backend-side
  // from the session; only allowlisted filters travel on the query.
  presence: ({ search = '', departmentId = '', presence = '', workMode = '', page = 1, pageSize = 25 } = {}) => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (departmentId) params.set('departmentId', departmentId);
    if (presence) params.set('presence', presence);
    if (workMode) params.set('workMode', workMode);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    return api.get(`/attendance/presence?${params.toString()}`);
  },
};

export default attendanceService;