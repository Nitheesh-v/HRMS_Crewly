import api from './api.js';

// Phase 31.5 — Attendance Regularization & Exception Center.
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

const attendanceRegularizationService = {
  mine: () => envelope(api.get('/attendance/regularizations/mine')),

  pending: () => envelope(api.get('/attendance/regularizations/pending')),

  get: (requestId) => envelope(api.get(`/attendance/regularizations/${requestId}`)),

  submit: (payload) => envelope(api.post('/attendance/regularizations', payload)),

  cancel: (requestId) => envelope(api.post(`/attendance/regularizations/${requestId}/cancel`)),

  approve: (requestId, reviewReason = null) =>
    envelope(
      api.post(
        `/attendance/regularizations/${requestId}/approve`,
        reviewReason ? { reviewReason } : {},
      ),
    ),

  reject: (requestId, reviewReason) =>
    envelope(api.post(`/attendance/regularizations/${requestId}/reject`, { reviewReason })),
};

export default attendanceRegularizationService;
