import api from './api.js';

// Weekly-hours flexi target — the employee's running Mon→Sun context.
// Read-only: rest-day rows are materialized server-side. The api.js
// response interceptor pre-unwraps bodies WITHOUT meta but keeps bodies
// WITH meta whole — normalize both shapes to { data } so callers read
// `.data` exactly once (same convention as attendancePolicyService).
const envelope = (promise) =>
  promise.then((response) => {
    if (
      response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      'data' in response &&
      'success' in response
    ) {
      return response;
    }
    return { data: response ?? null };
  });

const attendanceWeeklyTargetService = {
  weeklyTarget: () => envelope(api.get('/attendance/weekly-target')),
};

export { attendanceWeeklyTargetService };
export default attendanceWeeklyTargetService;
