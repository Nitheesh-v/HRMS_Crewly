import api from './api.js';

// Phase 31.1 — Attendance Policy.
// All calls are tenant-scoped by the backend (req.companyId); no company
// identifier is ever sent from the browser.
const envelope = (promise) => promise.then((response) => response?.data || {});

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
