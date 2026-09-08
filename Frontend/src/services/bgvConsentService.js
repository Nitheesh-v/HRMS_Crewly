import axios from 'axios';

// Public candidate BGV consent portal client — token-authorized, no
// employee session, no credential cookies (same posture as the offer portal).
const publicApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: false,
  headers: { Accept: 'application/json' },
});

publicApi.interceptors.response.use(
  (response) => response.data?.data ?? response.data,
  (error) => {
    const normalized = new Error(
      error.response?.data?.message || error.message || 'BGV consent link is unavailable'
    );
    normalized.status = error.response?.status;
    return Promise.reject(normalized);
  }
);

const bgvConsentService = {
  read: (secureToken) =>
    publicApi.get(`/public/candidate/bgv-consent/${encodeURIComponent(secureToken)}`),
  consent: (secureToken) =>
    publicApi.post(`/public/candidate/bgv-consent/${encodeURIComponent(secureToken)}/consent`, {}),
  decline: (secureToken) =>
    publicApi.post(`/public/candidate/bgv-consent/${encodeURIComponent(secureToken)}/decline`, {}),
};

export default bgvConsentService;
