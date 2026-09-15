import api from './api.js';

// Phase 31.8 — Overtime / Comp-Off.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser. Employee identity always
// derives from the login session — never from the payload. Eligibility
// figures always come FROM the server; the client never sends them.
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

const attendanceOvertimeService = {
  eligibility: (from, to) =>
    envelope(api.get('/attendance/overtime/eligibility', { params: { from, to } })),

  mine: () => envelope(api.get('/attendance/overtime/mine')),

  pending: () => envelope(api.get('/attendance/overtime/pending')),

  get: (requestId) => envelope(api.get(`/attendance/overtime/${requestId}`)),

  submit: (payload) => envelope(api.post('/attendance/overtime', payload)),

  cancel: (requestId) => envelope(api.post(`/attendance/overtime/${requestId}/cancel`)),

  approve: (requestId, { approvedMinutes, reviewReason = null } = {}) =>
    envelope(
      api.post(`/attendance/overtime/${requestId}/approve`, {
        approvedMinutes,
        ...(reviewReason ? { reviewReason } : {}),
      }),
    ),

  reject: (requestId, reviewReason = null) =>
    envelope(
      api.post(
        `/attendance/overtime/${requestId}/reject`,
        reviewReason ? { reviewReason } : {},
      ),
    ),
};

export default attendanceOvertimeService;
