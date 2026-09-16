import api from './api.js';

// Phase 31.4 — Work-Mode Requests.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser. Employee identity always
// derives from the login session — never from the payload.
// NOTE: the api.js interceptor pre-unwraps bodies WITHOUT meta, so the
// envelope normalizes both shapes to { data, ... } (31.3 lesson).
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

const attendanceWorkModeService = {
  mine: () => envelope(api.get('/attendance/work-mode-requests/mine')),

  pending: () => envelope(api.get('/attendance/work-mode-requests/pending')),

  get: (requestId) => envelope(api.get(`/attendance/work-mode-requests/${requestId}`)),

  submit: (payload) => envelope(api.post('/attendance/work-mode-requests', payload)),

  cancel: (requestId) => envelope(api.post(`/attendance/work-mode-requests/${requestId}/cancel`)),

  approve: (requestId, reviewReason = null) =>
    envelope(
      api.post(
        `/attendance/work-mode-requests/${requestId}/approve`,
        reviewReason ? { reviewReason } : {},
      ),
    ),

  reject: (requestId, reviewReason) =>
    envelope(api.post(`/attendance/work-mode-requests/${requestId}/reject`, { reviewReason })),
};

export default attendanceWorkModeService;
