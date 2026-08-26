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

const recruitmentAnalyticsService = {
  overview: async (params = {}) => {
    const response = await api.get('/recruitment/analytics/overview', {
      params,
    });
    return unwrap(response);
  },
};

export default recruitmentAnalyticsService;
