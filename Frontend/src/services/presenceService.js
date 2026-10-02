// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PRESENCE FRONTEND SERVICE (minimal prep for 37.2)
//
//  WHAT THIS MODULE IS
//    The thin axios layer for the Phase 37.1 backend. Phase 37.2 (the
//    self-presence UI) will import this file and the redux slice it
//    registers, and nothing else. No widget, no popover, no UI lives
//    here yet — that is 37.2.
//
//  INTERCEPTOR BEHAVIOUR (Phase 36 capsule §4.3, paid for many times)
//    `api.post(...)` ALREADY returns the unwrapped payload. The
//    response interceptor returns the body object directly, NOT a
//    `{data: ...}` envelope. So callers write:
//
//        const result = await api.post('/presence/me/status', { ... });
//
//    NOT:
//
//        const { data } = await api.post('/presence/me/status', { ... });
//
//  IDENTITY
//    Per Phase 37 §16 / §19 the request body MUST NOT carry
//    companyId / company / userId / user / employeeId / employee.
//    The backend validator refuses these; sending them anyway would be
//    a 400. We do not send them here — the auth middleware is the
//    authority.
//
//  ERROR SHAPE
//    A presence failure from the backend carries
//    `{ code: 'PRESENCE_*' | 'INVALID_*' | 'EXPIRY_*' | ...,
//       message, errors? }`. The slice stores the code, not the
//    message, so a widget can render policy-aware copy without scraping
//    prose.
// ═══════════════════════════════════════════════════════════════════════════

import api from './api.js';

// The full URL prefix. Resolved at request time so the same code works in
// dev (/api) and in a split deploy where VITE_API_URL points at the API
// origin. Mirrors the convention every other service file uses.
const PREFIX = '/presence';

// Helper that turns a PRESENCE_* error into a structured Error so a slice
// can store the code. axios's default behaviour is to reject on any 4xx
// with err.response.data already JSON-decoded.
const presenceErrorFromAxios = (err) => {
  const data = err && err.response && err.response.data;
  const code =
    (data && data.code) ||
    (err && err.code) ||
    'PRESENCE_UNKNOWN_ERROR';
  const message =
    (data && data.message) ||
    (err && err.message) ||
    'Presence request failed';
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

export const getMyPresence = () =>
  unwrap(api.get(`${PREFIX}/me`));

export const setMyStatus = ({ status, expiresAt } = {}) => {
  const body = { status };
  if (expiresAt !== undefined && expiresAt !== null) body.expiresAt = expiresAt;
  return unwrap(api.put(`${PREFIX}/me/status`, body));
};

export const setMyStatusMessage = ({ message, expiresAt } = {}) => {
  const body = { message };
  if (expiresAt !== undefined && expiresAt !== null) body.expiresAt = expiresAt;
  return unwrap(api.put(`${PREFIX}/me/status-message`, body));
};

export const setMyWorkLocation = ({ location, expiresAt } = {}) => {
  const body = { location };
  if (expiresAt !== undefined && expiresAt !== null) body.expiresAt = expiresAt;
  return unwrap(api.put(`${PREFIX}/me/work-location`, body));
};

export const getTenantConfig = () =>
  unwrap(api.get(`${PREFIX}/config`));

export const updateTenantConfig = (patch) =>
  unwrap(api.put(`${PREFIX}/config`, patch));

// EMPTY_PRESENCE re-exported for callers that prefer to import from
// the service. The canonical definition lives in
// redux/slices/presenceConstants.js to break the slice <-> service
// circular import (Phase 36 capsule §4.9).
export { EMPTY_PRESENCE } from '../redux/slices/presenceConstants.js';

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.3 — TEAM AVAILABILITY (read-only)
//
//  Identity is the auth handshake. The query string ONLY carries the
//  filter chips; nothing else. The backend validator refuses
//  ?companyId / ?userId / ?employeeId and unknown filter tokens.
// ═══════════════════════════════════════════════════════════════════════════
export const getTeamAvailability = (params = {}) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  const url = qs ? `${PREFIX}/team?${qs}` : `${PREFIX}/team`;
  return unwrap(api.get(url));
};