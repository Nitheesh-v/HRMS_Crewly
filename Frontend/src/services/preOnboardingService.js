import axios from 'axios';
import api from './api.js';

// api interceptor already unwraps { success, data, meta } responses.
// Accept both the unwrapped payload and a raw axios-style body.
const unwrap = (response) => {
  if (response == null) return {};
  if (Array.isArray(response)) return response;
  if (response?.data?.data !== undefined) return response.data.data;
  if (response?.data !== undefined && response?.success !== undefined) {
    return response.data;
  }
  if (response?.data !== undefined && response?.meta !== undefined) {
    return response.data;
  }
  return response;
};

const metaOf = (response) =>
  response?.meta ||
  response?.data?.meta ||
  {};

const publicApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: false,
  headers: { Accept: 'application/json' },
});

publicApi.interceptors.response.use(
  (response) => {
    if (response.config.responseType === 'blob') return response;
    return response?.data?.data ?? response?.data ?? response;
  },
  async (error) => {
    const payload = error?.response?.data;
    const message =
      payload?.message ||
      error.message ||
      'Pre-onboarding request failed';
    const wrapped = new Error(message);
    wrapped.status = error?.response?.status;
    wrapped.payload = payload;
    throw wrapped;
  }
);

const list = async (params = {}) => {
  const response = await api.get('/recruitment/pre-onboarding', { params });
  const data = unwrap(response);
  const meta = metaOf(response);
  return {
    cases: Array.isArray(data) ? data : Array.isArray(data?.cases) ? data.cases : [],
    meta,
  };
};

const detail = async (preOnboardingId) => {
  const response = await api.get(`/recruitment/pre-onboarding/${preOnboardingId}`);
  const data = unwrap(response);
  const meta = metaOf(response);
  return {
    case: data?.case || data,
    documents: meta.documents || data?.documents || [],
    history: meta.history || data?.history || [],
  };
};

const start = async (candidateId, payload = {}) => {
  if (!candidateId) {
    throw new Error('Candidate id is required to start pre-onboarding');
  }
  const response = await api.post(
    `/recruitment/candidates/${candidateId}/pre-onboarding/start`,
    payload
  );
  return unwrap(response);
};

const resendInvite = async (preOnboardingId) => {
  const response = await api.post(
    `/recruitment/pre-onboarding/${preOnboardingId}/resend-invite`
  );
  return unwrap(response);
};

const verifyDocument = async (preOnboardingId, documentId) => {
  const response = await api.post(
    `/recruitment/pre-onboarding/${preOnboardingId}/documents/${documentId}/verify`
  );
  return unwrap(response);
};

const rejectDocument = async (preOnboardingId, documentId, reason) => {
  const response = await api.post(
    `/recruitment/pre-onboarding/${preOnboardingId}/documents/${documentId}/reject`,
    { reason }
  );
  return unwrap(response);
};

const markReady = async (preOnboardingId) => {
  const response = await api.post(
    `/recruitment/pre-onboarding/${preOnboardingId}/mark-ready`
  );
  return unwrap(response);
};

const downloadDocument = async (preOnboardingId, documentId, fileName = 'document') => {
  const response = await api.get(
    `/recruitment/pre-onboarding/${preOnboardingId}/documents/${documentId}/file`,
    { responseType: 'blob' }
  );
  const blob = response instanceof Blob ? response : response?.data;
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.URL.revokeObjectURL(url);
};

const listRequirements = async () => {
  const response = await api.get('/recruitment/pre-onboarding/document-requirements');
  const data = unwrap(response);
  return Array.isArray(data) ? data : [];
};

const createRequirement = async (payload) => {
  const response = await api.post(
    '/recruitment/pre-onboarding/document-requirements',
    payload
  );
  return unwrap(response);
};

const updateRequirement = async (requirementId, payload) => {
  const response = await api.patch(
    `/recruitment/pre-onboarding/document-requirements/${requirementId}`,
    payload
  );
  return unwrap(response);
};

const deactivateRequirement = async (requirementId) => {
  const response = await api.post(
    `/recruitment/pre-onboarding/document-requirements/${requirementId}/deactivate`
  );
  return unwrap(response);
};

const publicRead = async (secureToken) =>
  publicApi.get(
    `/public/candidate/pre-onboarding/${encodeURIComponent(secureToken)}`
  );

const publicView = async (secureToken) =>
  publicApi.post(
    `/public/candidate/pre-onboarding/${encodeURIComponent(secureToken)}/view`
  );

const publicUpload = async (secureToken, requirementCode, formData) =>
  publicApi.post(
    `/public/candidate/pre-onboarding/${encodeURIComponent(secureToken)}/documents/${encodeURIComponent(requirementCode)}`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );

const publicDocument = async (secureToken, documentCode) => {
  const response = await publicApi.get(
    `/public/candidate/pre-onboarding/${encodeURIComponent(secureToken)}/documents/${encodeURIComponent(documentCode)}`,
    { responseType: 'blob' }
  );
  return response instanceof Blob ? response : response?.data;
};

const preOnboardingService = {
  list,
  detail,
  start,
  resendInvite,
  verifyDocument,
  rejectDocument,
  markReady,
  downloadDocument,
  listRequirements,
  createRequirement,
  updateRequirement,
  deactivateRequirement,
  publicRead,
  publicView,
  publicUpload,
  publicDocument,
};

export default preOnboardingService;
