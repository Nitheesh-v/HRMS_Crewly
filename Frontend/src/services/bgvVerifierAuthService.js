import axios from 'axios';

// Phase 30.6 — dedicated BGV verifier auth client.
// SEPARATE storage key and axios instance: the verifier session token is
// never attached to tenant or platform requests, and tenant tokens are
// never sent to verifier routes.

const TOKEN_KEY = 'crewly_bgv_verifier_token';

const verifierApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: false,
  headers: { Accept: 'application/json' },
});

verifierApi.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

verifierApi.interceptors.response.use(
  (response) => response.data?.data ?? response.data,
  (error) => {
    const normalized = new Error(
      error.response?.data?.message || error.message || 'BGV verifier authentication failed'
    );
    normalized.status = error.response?.status;
    return Promise.reject(normalized);
  }
);

const bgvVerifierAuthService = {
  tokenKey: TOKEN_KEY,
  getToken: () => localStorage.getItem(TOKEN_KEY),
  setToken: (token) => localStorage.setItem(TOKEN_KEY, String(token || '')),
  clearToken: () => localStorage.removeItem(TOKEN_KEY),

  setup: (setupToken, password) =>
    verifierApi.post('/bgv-verifier/auth/setup', { setupToken, password }),
  login: (body) => verifierApi.post('/bgv-verifier/auth/login', body),
  me: () => verifierApi.get('/bgv-verifier/auth/me'),
  logout: () => verifierApi.post('/bgv-verifier/auth/logout', {}),
  forgot: (email) => verifierApi.post('/bgv-verifier/auth/forgot-password', { email }),
  reset: (resetToken, password) =>
    verifierApi.post('/bgv-verifier/auth/reset-password', { resetToken, password }),

  // Phase 30.7 — My Verification Work (session principal only; the backend
  // never accepts a client-supplied verifierId).
  work: () => verifierApi.get('/bgv-verifier/work'),
  workDetail: (orderId, checkType) =>
    verifierApi.get(`/bgv-verifier/work/${orderId}/${checkType}`),
  startWork: (orderId, checkType) =>
    verifierApi.post(`/bgv-verifier/work/${orderId}/${checkType}/start`, {}),
  // Evidence download through the authenticated verifier session — no
  // public URLs; the file must belong to a check assigned to this verifier.
  downloadEvidence: async (fileId) => {
    const response = await verifierApi.get(`/bgv-verifier/work/files/${fileId}`, {
      responseType: 'blob',
    });
    return response;
  },

  // Phase 30.8 — verification workbench (structured activities, findings,
  // conclusion). The backend re-validates method/outcome/observations —
  // this client never widens the controlled registry.
  recordActivity: (orderId, checkType, body) =>
    verifierApi.post(`/bgv-verifier/work/${orderId}/${checkType}/activities`, body),
  recordDiscrepancy: (orderId, checkType, body) =>
    verifierApi.post(`/bgv-verifier/work/${orderId}/${checkType}/discrepancies`, body),
  setWorkbenchState: (orderId, checkType, state) =>
    verifierApi.post(`/bgv-verifier/work/${orderId}/${checkType}/state`, { state }),
  submitConclusion: (orderId, checkType, body) =>
    verifierApi.post(`/bgv-verifier/work/${orderId}/${checkType}/submit`, body),
  uploadActivityEvidence: (orderId, checkType, formData) =>
    verifierApi.post(`/bgv-verifier/work/${orderId}/${checkType}/evidence`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  // Phase 30.9 — additional information requests (current verifier only).
  infoRequests: (orderId, checkType) =>
    verifierApi.get(`/bgv-verifier/work/${orderId}/${checkType}/info-requests`),
  createInfoRequest: (orderId, checkType, body) =>
    verifierApi.post(`/bgv-verifier/work/${orderId}/${checkType}/info-requests`, body),
  resolveInfoRequest: (requestId, body) =>
    verifierApi.post(`/bgv-verifier/work/info-requests/${requestId}/resolve`, body),
  cancelInfoRequest: (requestId, body) =>
    verifierApi.post(`/bgv-verifier/work/info-requests/${requestId}/cancel`, body),
  downloadVerifierEvidence: async (fileId) => {
    const response = await verifierApi.get(`/bgv-verifier/work/evidence/${fileId}`, {
      responseType: 'blob',
    });
    return response;
  },
};

export default bgvVerifierAuthService;
