import api from './api.js';

const unwrap = (response) => {
  if (response == null) return {};
  if (Array.isArray(response)) return response;
  if (response?.data?.data !== undefined) return response.data.data;
  if (
    response?.data !== undefined &&
    (response?.success !== undefined || response?.meta !== undefined)
  ) {
    return response.data;
  }
  return response;
};

const metaOf = (response) => response?.meta || response?.data?.meta || {};

const bgvService = {
  getSettings: async () => unwrap(await api.get('/recruitment/background-verification/settings')),
  updateSettings: async (payload) =>
    unwrap(await api.patch('/recruitment/background-verification/settings', payload)),
  listCheckTypes: async () =>
    unwrap(await api.get('/recruitment/background-verification/check-types')),
  createCheckType: async (payload) =>
    unwrap(await api.post('/recruitment/background-verification/check-types', payload)),
  updateCheckType: async (checkTypeId, payload) =>
    unwrap(
      await api.patch(
        `/recruitment/background-verification/check-types/${checkTypeId}`,
        payload
      )
    ),
  list: async (params = {}) => {
    const response = await api.get('/recruitment/background-verifications', { params });
    const data = unwrap(response);
    return {
      cases: Array.isArray(data) ? data : data?.cases || [],
      meta: metaOf(response),
    };
  },
  detail: async (caseId) =>
    unwrap(await api.get(`/recruitment/background-verifications/${caseId}`)),
  start: async (candidateId) =>
    unwrap(
      await api.post(
        `/recruitment/candidates/${candidateId}/background-verification/start`
      )
    ),
  summary: async (candidateId) =>
    unwrap(
      await api.get(`/recruitment/candidates/${candidateId}/background-verification`)
    ),
  assign: async (caseId, verifierId) =>
    unwrap(
      await api.post(`/recruitment/background-verifications/${caseId}/assign`, {
        verifierId,
      })
    ),
  updateCheck: async (caseId, checkId, payload) =>
    unwrap(
      await api.patch(
        `/recruitment/background-verifications/${caseId}/checks/${checkId}`,
        payload
      )
    ),
  complete: async (caseId, payload) =>
    unwrap(
      await api.post(
        `/recruitment/background-verifications/${caseId}/complete`,
        payload
      )
    ),
  cancel: async (caseId, reason) =>
    unwrap(
      await api.post(`/recruitment/background-verifications/${caseId}/cancel`, {
        reason,
      })
    ),
  // Phase 30.1.1 — read-only Crewly verification progress for a case:
  // ONLY [{ checkType, status, updatedAt }] — the tenant never sees
  // evidence, verifier names or notes (execution is platform-side).
  getChecksSummary: async (caseId) =>
    unwrap(await api.get(`/bgv/cases/${caseId}/checks-summary`)),

};

export default bgvService;
