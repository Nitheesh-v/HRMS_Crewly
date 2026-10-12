// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST FRONTEND SERVICE
//
//  Thin axios layer for the Phase 37.5 backend. Mirrors
//  presenceService.js (37.1) and attendanceWorkModeService.js (31.4).
//
//  IDENTITY
//    Per Phase 37.5 §9 the request body MUST NOT carry companyId /
//    userId / employeeId / reviewedBy. The backend validator refuses
//    them; we never send them.
// ═══════════════════════════════════════════════════════════════════════════

import api from '../api.js';

const PREFIX = '/presence/work-location-requests';

const presenceErrorFromAxios = (err) => {
  const data = err && err.response && err.response.data;
  const code =
    (data && data.code) ||
    (err && err.code) ||
    'WORK_LOCATION_REQUEST_UNKNOWN_ERROR';
  const message =
    (data && data.message) || (err && err.message) || 'WFH request failed';
  const wrapped = new Error(message);
  wrapped.presenceCode = code;
  wrapped.status = (err && err.response && err.response.status) || 0;
  return wrapped;
};

const unwrap = async (promise) => {
  try {
    return await promise;
  } catch (err) {
    throw presenceErrorFromAxios(err);
  }
};

const workLocationRequestService = {
  submit: (payload) => unwrap(api.post(PREFIX, payload)),

  mine: () => unwrap(api.get(`${PREFIX}/me`)),

  pending: () => unwrap(api.get(`${PREFIX}/pending`)),

  get: (requestId) => unwrap(api.get(`${PREFIX}/${requestId}`)),

  cancel: (requestId) =>
    unwrap(api.post(`${PREFIX}/${requestId}/cancel`)),

  approve: (requestId, decisionNote = null) =>
    unwrap(
      api.post(
        `${PREFIX}/${requestId}/approve`,
        decisionNote ? { decisionNote } : {},
      ),
    ),

  reject: (requestId, decisionNote) =>
    unwrap(api.post(`${PREFIX}/${requestId}/reject`, { decisionNote })),
};

export default workLocationRequestService;
