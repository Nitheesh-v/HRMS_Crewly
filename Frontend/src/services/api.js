import axios from 'axios';
import store from '../redux/store.js';
import {
  accessTokenRefreshed,
  logout as logoutAction,
} from '../redux/slices/AuthSlices.js';

const baseURL =
  import.meta.env.VITE_API_URL ||
  '/api';

const api = axios.create({
  baseURL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

/*
 * Separate client avoids sending the expired access token and prevents
 * the main response interceptor from intercepting its own refresh call.
 */
const refreshClient = axios.create({
  baseURL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_ADMIN',
  'BILLING_ADMIN',
];

const PUBLIC_CUSTOMER_AUTH = [
  '/auth/login',
  '/auth/register-company',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
];

let refreshPromise = null;

const getStoredUser = () => {
  try {
    return JSON.parse(
      localStorage.getItem('infolexus_user') ||
      'null',
    );
  } catch {
    return null;
  }
};

const isPlatformRequest = (config) =>
  String(config?.url || '').startsWith(
    '/super-admin',
  );

const isPublicCustomerAuth = (config) =>
  PUBLIC_CUSTOMER_AUTH.some((path) =>
    String(config?.url || '').startsWith(path),
  );

const normalizeError = (error) => {
  const message =
    error.response?.data?.message ||
    error.message ||
    'Something went wrong';

  const normalized = new Error(message);

  normalized.status =
    error.response?.status;

  normalized.code =
    error.response?.data?.code;

  normalized.data =
    error.response?.data;

  return normalized;
};

const clearAuthentication = (redirectPath = '') => {
  store.dispatch(logoutAction());

  window.dispatchEvent(
    new CustomEvent('crewly:auth-expired'),
  );

  if (
    redirectPath &&
    window.location.pathname !== redirectPath
  ) {
    window.location.assign(redirectPath);
  }
};

/*
 * Multiple requests may fail at the same time.
 * All of them wait for this single refresh request.
 */
const refreshAccessToken = () => {
  if (!refreshPromise) {
    refreshPromise = refreshClient
      .post('/auth/refresh', {})
      .then((response) => {
        const payload =
          response?.data?.data ??
          response?.data ??
          {};

        /*
         * Supports both existing backend response names:
         * accessToken and token.
         */
        const token =
          payload.accessToken ||
          payload.token;

        if (!token) {
          throw new Error(
            'Refresh response did not contain an access token',
          );
        }

        localStorage.setItem(
          'infolexus_token',
          token,
        );

        store.dispatch(
          accessTokenRefreshed(token),
        );

        return token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
};

// Always attach the latest token from localStorage.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(
    'infolexus_token',
  );

  if (token) {
    config.headers =
      config.headers || {};

    config.headers.Authorization =
      `Bearer ${token}`;
  }

  return config;
});

api.interceptors.response.use(
  (response) => {
    const body = response.data;

    /*
     * Keep the existing Crewly response unwrapping behavior.
     * Paginated endpoints retain data + meta.
     */
    if (
      body &&
      typeof body === 'object' &&
      !(body instanceof Blob) &&
      'data' in body
    ) {
      return body.meta
        ? body
        : body.data;
    }

    return body;
  },

  async (error) => {
    const originalRequest =
      error.config || {};

    const status =
      error.response?.status;

    const user = getStoredUser();

    const platformRequest =
      isPlatformRequest(originalRequest) ||
      PLATFORM_ROLES.includes(user?.role);

    /*
     * Customer request:
     * refresh once and retry the failed request.
     */
    if (
      status === 401 &&
      !originalRequest._retry &&
      !platformRequest &&
      !isPublicCustomerAuth(originalRequest)
    ) {
      originalRequest._retry = true;

      try {
        const token =
          await refreshAccessToken();

        originalRequest.headers =
          originalRequest.headers || {};

        originalRequest.headers.Authorization =
          `Bearer ${token}`;

        return api(originalRequest);
      } catch (refreshError) {
        const redirectPath =
          window.location.pathname.startsWith(
            '/app',
          )
            ? '/login?session=expired'
            : '';

        clearAuthentication(redirectPath);

        return Promise.reject(
          normalizeError(refreshError),
        );
      }
    }

    /*
     * Super Admin continues using AdminSession.
     * It must never call the customer refresh endpoint.
     */
    const platformLoginRequest =
      String(originalRequest.url || '').includes(
        '/super-admin/auth/login',
      ) ||
      String(originalRequest.url || '').includes(
        '/super-admin/auth/verify-2fa',
      );

    if (
      status === 401 &&
      platformRequest &&
      !platformLoginRequest
    ) {
      const redirectPath =
        window.location.pathname.startsWith(
          '/super-admin',
        )
          ? '/super-admin/login'
          : '';

      clearAuthentication(redirectPath);
    }

    return Promise.reject(
      normalizeError(error),
    );
  },
);

export { api };
export default api;