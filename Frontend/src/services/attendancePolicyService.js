import api from './api.js';

// Phase 31.1 — Attendance Policy.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser.
// Phase 31.3 fix — the api.js response interceptor pre-unwraps bodies
// WITHOUT meta (hands us bare data) but keeps bodies WITH meta whole.
// Normalize both shapes to { data, ... } so every call site reads
// `.data` exactly once. Without this, non-meta endpoints (activate,
// history) double-unwrap to {} and the page can never show them.
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

const attendancePolicyService = {
  get: () => envelope(api.get('/attendance/policy')),

  history: (params = {}) => envelope(api.get('/attendance/policy/history', { params })),

  saveDraft: (payload) => envelope(api.post('/attendance/policy/draft', payload)),

  activate: (expectedConfigVersion) =>
    envelope(
      api.post(
        '/attendance/policy/activate',
        expectedConfigVersion == null ? {} : { expectedConfigVersion },
      ),
    ),
};

export default attendancePolicyService;
