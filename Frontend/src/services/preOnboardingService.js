import axios from 'axios';
import api from './api.js';

const unwrap = (response) => response?.data?.data ?? response?.data ?? response ?? {};

const publicApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: false,
  headers: { Accept: 'application/json' },
});

publicApi.interceptors.response.use(
  (response) => {
    if (response.config.responseType === 'blob') return response;
    return response;
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
  return {
    cases: unwrap(response) || [],
    meta: response?.data?.meta || {},
  };
};

const detail = async (preOnboardingId) => {
  const response = await api.get(`/recruitment/pre-onboarding/${preOnboardingId}`);
  return {
    case: unwrap(response),
    documents: response?.data?.meta?.documents || [],
    history: response?.data?.meta?.history || [],
  };
};

const start = async (candidateId, payload = {}) => {
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
  const blob = response.data;
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.URL.revokeObjectURL(url);
};

const listRequirements = async () => {
  const response = await api.get('/recruitment/pre-onboarding/document-requirements');
  return unwrap(response) || [];
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

const publicRead = async (secureToken) => {
  const response = await publicApi.get(
    `/public/candidate/pre-onboarding/${encodeURIComponent(secureToken)}`
  );
  return unwrap(response);
};

const publicView = async (secureToken) => {
  const response = await publicApi.post(
    `/public/candidate/pre-onboarding/${encodeURIComponent(secureToken)}/view`
  );
  return unwrap(response);
};

const publicUpload = async (secureToken, requirementCode, formData) => {
  const response = await publicApi.post(
    `/public/candidate/pre-onboarding/${encodeURIComponent(secureToken)}/documents/${encodeURIComponent(requirementCode)}`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
  return unwrap(response);
};

const publicDocument = async (secureToken, documentCode) => {
  const response = await publicApi.get(
    `/public/candidate/pre-onboarding/${encodeURIComponent(secureToken)}/documents/${encodeURIComponent(documentCode)}`,
    { responseType: 'blob' }
  );
  return response.data;
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
