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
  // 31.16 D-05 — the backend serves status at GET
  // /finalization/:month (no /status suffix); align the call.
  finalizationStatus: (month) => api.get(`/attendance/finalization/${month}`),
  finalizationValidate: (month) => api.get(`/attendance/finalization/${month}/validate`),
  finalizationPreview: (month) => api.get(`/attendance/finalization/${month}/preview`),
  finalizeMonth: (month) => api.post(`/attendance/finalization/${month}/finalize`, {}),
  sendFinalizationToPayroll: (month) => api.post(`/attendance/finalization/${month}/send-to-payroll`, {}),
  reopenFinalization: (month, reason) => api.post(`/attendance/finalization/${month}/reopen`, { reason }),
  // Phase 31.12 — HR attendance operations dashboard (read-only).
  // Allowlisted filters only; scope derives backend-side.
  operations: ({ date = '', search = '', departmentId = '', managerId = '', shift = '', location = '', presence = '', workMode = '', category = '', page = 1, pageSize = 25 } = {}) => {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (search) params.set('search', search);
    if (departmentId) params.set('departmentId', departmentId);
    if (managerId) params.set('managerId', managerId);
    if (shift) params.set('shift', shift);
    if (location) params.set('location', location);
    if (presence) params.set('presence', presence);
    if (workMode) params.set('workMode', workMode);
    if (category) params.set('category', category);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    return api.get(`/attendance/operations?${params.toString()}`);
  },
  // Phase 31.15 — Attendance reports & analytics (read-only).
  // Scope, FINALIZED-vs-LIVE source and rate math all derive
  // backend-side; only allowlisted filters travel on the query.
  // Range is month | from/to | preset+month anchor; filters are
  // singular ids mirroring the validator (departmentId/shiftId/
  // locationId/employeeId/workMode).
  analyticsOverview: ({ month = '', from = '', to = '', preset = '', departmentId = '', shiftId = '', locationId = '', employeeId = '', workMode = '' } = {}) => {
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (preset) params.set('preset', preset);
    if (departmentId) params.set('departmentId', departmentId);
    if (shiftId) params.set('shiftId', shiftId);
    if (locationId) params.set('locationId', locationId);
    if (employeeId) params.set('employeeId', employeeId);
    if (workMode) params.set('workMode', workMode);
    return api.get(`/attendance/analytics/overview?${params.toString()}`);
  },
  analyticsTrends: ({ month = '', from = '', to = '', preset = '', departmentId = '', shiftId = '', locationId = '', employeeId = '', workMode = '' } = {}) => {
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (preset) params.set('preset', preset);
    if (departmentId) params.set('departmentId', departmentId);
    if (shiftId) params.set('shiftId', shiftId);
    if (locationId) params.set('locationId', locationId);
    if (employeeId) params.set('employeeId', employeeId);
    if (workMode) params.set('workMode', workMode);
    return api.get(`/attendance/analytics/trends?${params.toString()}`);
  },
  analyticsEmployees: ({ month = '', from = '', to = '', preset = '', departmentId = '', shiftId = '', locationId = '', employeeId = '', workMode = '', sort = 'name', page = 1, pageSize = 25 } = {}) => {
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (preset) params.set('preset', preset);
    if (departmentId) params.set('departmentId', departmentId);
    if (shiftId) params.set('shiftId', shiftId);
    if (locationId) params.set('locationId', locationId);
    if (employeeId) params.set('employeeId', employeeId);
    if (workMode) params.set('workMode', workMode);
    params.set('sort', sort);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    return api.get(`/attendance/analytics/employees?${params.toString()}`);
  },
  analyticsMine: ({ month = '', from = '', to = '', preset = '' } = {}) =>
    api.get(`/attendance/analytics/mine?${new URLSearchParams(
      Object.fromEntries(
        [['month', month], ['from', from], ['to', to], ['preset', preset]].filter(([, v]) => v)
      )
    ).toString()}`),
  analyticsReconciliation: (month) =>
    api.get(`/attendance/analytics/payroll-reconciliation?month=${month}`),
  // Phase 31.15 — CSV / XLSX export (same scope + filters as the
  // on-screen report). Triggers a browser download from the blob
  // the API streams back; metadata-only audit stays server-side.
  downloadAnalytics: async ({ reportType = 'employees', format = 'csv', month = '', from = '', to = '', preset = '', departmentId = '', shiftId = '', locationId = '', employeeId = '', workMode = '' } = {}) => {
    const params = new URLSearchParams();
    params.set('reportType', reportType);
    params.set('format', format);
    if (month) params.set('month', month);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (preset) params.set('preset', preset);
    if (departmentId) params.set('departmentId', departmentId);
    if (shiftId) params.set('shiftId', shiftId);
    if (locationId) params.set('locationId', locationId);
    if (employeeId) params.set('employeeId', employeeId);
    if (workMode) params.set('workMode', workMode);
    const blob = await api.get(`/attendance/analytics/export?${params.toString()}`, {
      responseType: 'blob',
    });
    const stamp = month || (from && to ? `${from}_${to}` : 'range');
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `crewly-attendance-${reportType}-${stamp}.${format === 'xlsx' ? 'xlsx' : 'csv'}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  },
};

export default attendanceService;