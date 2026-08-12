import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('infolexus_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/*
 * Unwraps the backend's global format { success, message, data, meta? }:
 *   - body has meta    → return { data, meta }   (paginated lists)
 *   - body has 'data'  → return body.data        (may LEGITIMATELY be null!)
 *   - otherwise        → return the raw body
 */
api.interceptors.response.use(
  (response) => {
    const body = response.data;
    if (body && typeof body === 'object' && 'data' in body) {
      return body.meta ? body : body.data;
    }
    return body;
  },
  (error) => {
    const message = error.response?.data?.message || error.message || 'Something went wrong';
    if (error.response?.status === 401) {
      localStorage.removeItem('infolexus_token');
      localStorage.removeItem('infolexus_user');
    }
    return Promise.reject(new Error(message));
  }
);

export default api;