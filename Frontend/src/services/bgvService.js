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
  // Phase 30.1 — optional BGV decision (Proceed Without BGV / Initiate BGV).
  decide: async (candidateId, payload) =>
    unwrap(
      await api.post(`/recruitment/candidates/${candidateId}/bgv-decision`, payload)
    ),
  // Phase 30.3 — paid BGV order (backend is the only price authority).
  purchasableServices: async () =>
    unwrap(await api.get('/recruitment/bgv-purchase/services')),
  createOrder: async (candidateId, payload) =>
    unwrap(await api.post(`/recruitment/candidates/${candidateId}/bgv-order`, payload)),
  orderFor: async (candidateId) =>
    unwrap(await api.get(`/recruitment/candidates/${candidateId}/bgv-order`)),
  initiatePayment: async (orderId) =>
    unwrap(await api.post(`/recruitment/bgv-orders/${orderId}/payment/initiate`)),
  verifyPayment: async (orderId, payload) =>
    unwrap(await api.post(`/recruitment/bgv-orders/${orderId}/payment/verify`, payload)),
  cancelOrder: async (orderId) =>
    unwrap(await api.post(`/recruitment/bgv-orders/${orderId}/cancel`)),
  // Phase 30.4 — candidate consent invitation (requires a PAID 30.3 order).
  issueConsentInvitation: async (orderId) =>
    unwrap(await api.post(`/recruitment/bgv-orders/${orderId}/consent-invitation`)),
  consentStatus: async (candidateId) =>
    unwrap(await api.get(`/recruitment/candidates/${candidateId}/bgv-consent-status`)),
  // Phase 30.5 — candidate collection status (status only; no raw evidence).
  collectionStatus: async (candidateId) =>
    unwrap(await api.get(`/recruitment/candidates/${candidateId}/bgv-collection-status`)),
  // Phase 30.7 — high-level assignment progress (UNASSIGNED/ASSIGNED/
  // IN_PROGRESS per check). Never internal verifier identity or evidence.
  assignmentStatus: async (candidateId) =>
    unwrap(await api.get(`/recruitment/candidates/${candidateId}/bgv-assignment-status`)),
  // Phase 30.10 — released final BGV report (tenant HR, BACKGROUND_VERIFICATION_READ).
  finalReport: async (candidateId) =>
    unwrap(await api.get(`/recruitment/candidates/${candidateId}/bgv-final-report`)),
  finalReportDownload: (candidateId) =>
    api.get(`/recruitment/candidates/${candidateId}/bgv-final-report/download`, { responseType: 'blob' }),
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
};

export default bgvService;
