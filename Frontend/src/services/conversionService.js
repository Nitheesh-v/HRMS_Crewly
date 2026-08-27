import api from './api.js';

const unwrap = (response) => {
  if (response == null) return {};
  if (Array.isArray(response)) return response;
  if (response?.data?.data !== undefined) return response.data.data;
  if (response?.data !== undefined && (response?.success !== undefined || response?.meta !== undefined)) {
    return response.data;
  }
  return response;
};

const conversionService = {
  preview: async (candidateId) => {
    const response = await api.get(
      `/recruitment/candidates/${candidateId}/conversion-preview`
    );
    return unwrap(response);
  },

  convert: async (candidateId, payload = {}) => {
    const response = await api.post(
      `/recruitment/candidates/${candidateId}/convert-to-employee`,
      payload
    );
    return unwrap(response);
  },

  resendSetup: async (employeeId) => {
    const response = await api.post(
      `/users/${employeeId}/resend-account-setup`
    );
    return unwrap(response);
  },

  recruitmentOrigin: async (employeeId) => {
    const response = await api.get(
      `/users/${employeeId}/recruitment-origin`
    );
    return unwrap(response);
  },
};

export default conversionService;
