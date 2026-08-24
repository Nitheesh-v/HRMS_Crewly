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
    if (response.config.responseType === 'blob') return response.data;
    return response.data?.data ?? response.data;
  },
  (error) => {
    const normalized = new Error(
      error.response?.data?.message || error.message || 'Offer is unavailable'
    );
    normalized.status = error.response?.status;
    return Promise.reject(normalized);
  }
);

const offerService = {
  list: async (params = {}) => {
    const response = await api.get('/recruitment/offers', { params });
    if (Array.isArray(response)) return { offers: response, meta: {} };
    return {
      offers: Array.isArray(response?.data) ? response.data : [],
      meta: response?.meta || {},
    };
  },
  get: async (offerId) => {
    const response = await api.get(`/recruitment/offers/${offerId}`);
    return response?.data ? { offer: response.data, history: response.meta?.history || [] } : { offer: unwrap(response), history: response?.meta?.history || [] };
  },
  options: () => api.get('/recruitment/offers/options').then(unwrap),
  create: (payload) => api.post('/recruitment/offers', payload).then(unwrap),
  update: (offerId, payload) => api.patch(`/recruitment/offers/${offerId}`, payload).then(unwrap),
  submit: (offerId) => api.post(`/recruitment/offers/${offerId}/submit`, {}).then(unwrap),
  approve: (offerId) => api.post(`/recruitment/offers/${offerId}/approve`, {}).then(unwrap),
  returnForChanges: (offerId, reason) => api.post(`/recruitment/offers/${offerId}/return`, { reason }).then(unwrap),
  send: (offerId) => api.post(`/recruitment/offers/${offerId}/send`, {}).then(unwrap),
  withdraw: (offerId, reason) => api.post(`/recruitment/offers/${offerId}/withdraw`, { reason }).then(unwrap),
  document: (offerId) => api.get(`/recruitment/offers/${offerId}/document`, { responseType: 'blob' }),
  templates: async (params = {}) => {
    const response = await api.get('/recruitment/offer-templates', { params });
    if (Array.isArray(response)) return { templates: response, supportedVariables: [] };
    return {
      templates: Array.isArray(response?.data) ? response.data : [],
      supportedVariables: response?.meta?.supportedVariables || [],
    };
  },
  createTemplate: (payload) => api.post('/recruitment/offer-templates', payload).then(unwrap),
  updateTemplate: (templateId, payload) => api.patch(`/recruitment/offer-templates/${templateId}`, payload).then(unwrap),
  deactivateTemplate: (templateId) => api.delete(`/recruitment/offer-templates/${templateId}`).then(unwrap),
  publicRead: (secureToken) => publicApi.get(`/public/candidate/offers/${encodeURIComponent(secureToken)}`),
  publicView: (secureToken) => publicApi.post(`/public/candidate/offers/${encodeURIComponent(secureToken)}/view`, {}),
  publicDocument: (secureToken) => publicApi.get(`/public/candidate/offers/${encodeURIComponent(secureToken)}/document`, { responseType: 'blob' }),
  publicAccept: (secureToken) => publicApi.post(`/public/candidate/offers/${encodeURIComponent(secureToken)}/accept`, { confirmed: true }),
  publicReject: (secureToken, payload) => publicApi.post(`/public/candidate/offers/${encodeURIComponent(secureToken)}/reject`, { confirmed: true, ...payload }),
};

export default offerService;
