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
  // Phase 31.10 — Monthly timesheets. Scope derives backend-side
  // from the session; only allowlisted filters travel on the query.
  myTimesheet: (month) => api.get(`/attendance/timesheets/mine?month=${month}`),
  teamTimesheets: ({ month, search = '', departmentId = '', hasExceptions = false, page = 1, pageSize = 10 } = {}) => {
    const params = new URLSearchParams();
    params.set('month', month);
    if (search) params.set('search', search);
    if (departmentId) params.set('departmentId', departmentId);
    if (hasExceptions) params.set('hasExceptions', 'true');
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    return api.get(`/attendance/timesheets/team?${params.toString()}`);
  },
  employeeTimesheet: (employeeId, month) =>
    api.get(`/attendance/timesheets/employee/${employeeId}?month=${month}`),
  // CSV export (same scope + filters as the team table). Triggers a
  // browser download from the blob the API streams back.
  downloadTeamTimesheets: async ({ month, search = '', departmentId = '', hasExceptions = false } = {}) => {
    const params = new URLSearchParams();
    params.set('month', month);
    if (search) params.set('search', search);
    if (departmentId) params.set('departmentId', departmentId);
    if (hasExceptions) params.set('hasExceptions', 'true');
    const blob = await api.get(`/attendance/timesheets/export?${params.toString()}`, {
      responseType: 'blob',
    });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `crewly-timesheet-${month}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  },
  // Phase 31.11 — Monthly attendance finalization. Status, validate
  // and preview are read-only; finalize / send / reopen mutate one
  // month and are guarded backend-side by dedicated permissions.
  finalizationStatus: (month) => api.get(`/attendance/finalization/${month}/status`),
  finalizationValidate: (month) => api.get(`/attendance/finalization/${month}/validate`),
  finalizationPreview: (month) => api.get(`/attendance/finalization/${month}/preview`),
  finalizeMonth: (month) => api.post(`/attendance/finalization/${month}/finalize`, {}),
  sendFinalizationToPayroll: (month) => api.post(`/attendance/finalization/${month}/send-to-payroll`, {}),
  reopenFinalization: (month, reason) => api.post(`/attendance/finalization/${month}/reopen`, { reason }),
};

export default attendanceService;