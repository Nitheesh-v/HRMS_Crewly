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

const REFRESH_LOCK = 'crewly.refresh';
const REFRESH_RETRY_MS = 250;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const readStoredToken = () =>
  localStorage.getItem('infolexus_token');

/*
 * One rotation, one writer.
 *
 * The refresh token is SINGLE USE server-side, and the cookie is shared by
 * every tab of the browser. Two tabs whose access token expires together used
 * to rotate the same token twice: the second rotation looked like theft, the
 * whole family was revoked and User.tokenVersion was bumped — every tab and
 * every device signed out, mid-work. (That is the "session expired too fast"
 * bug.)
 *
 * So: the tab that wins the race writes the token to localStorage; the others
 * see it changed and adopt it instead of rotating again.
 */
const requestRefresh = async () => {
  const response = await refreshClient
    .post('/auth/refresh', {});

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
};

const performRefresh = async (tokenBeforeRefresh) => {
  /*
   * Another tab refreshed while this one was waiting for the cross-tab lock:
   * its token is already in localStorage, so there is nothing to rotate.
   */
  const current = readStoredToken();

  if (
    current &&
    tokenBeforeRefresh &&
    current !== tokenBeforeRefresh
  ) {
    store.dispatch(
      accessTokenRefreshed(current),
    );

    return current;
  }

  let lastError = null;

  for (
    let attempt = 0;
    attempt < 3;
    attempt += 1
  ) {
    try {
      return await requestRefresh();
    } catch (error) {
      lastError = error;

      const status =
        error?.response?.status;

      const code =
        error?.response?.data?.code;

      /*
       * 409 REFRESH_IN_PROGRESS: another client rotated first and its cookie
       * is already in this browser. Waiting briefly and retrying is the whole
       * recovery — no logout, no re-login.
       */
      if (
        (code === 'REFRESH_IN_PROGRESS' ||
          status === 409) &&
        attempt < 2
      ) {
        await sleep(
          REFRESH_RETRY_MS +
            Math.random() * REFRESH_RETRY_MS,
        );

        const afterRace =
          readStoredToken();

        if (
          afterRace &&
          tokenBeforeRefresh &&
          afterRace !== tokenBeforeRefresh
        ) {
          store.dispatch(
            accessTokenRefreshed(afterRace),
          );

          return afterRace;
        }

        continue;
      }

      throw error;
    }
  }

  throw lastError;
};

/*
 * Multiple requests may fail at the same time. All of them wait for this
 * single refresh — and, when the browser has the Web Locks API, so does every
 * other tab (a real cross-tab mutex, no extra dependency).
 */
const refreshAccessToken = (tokenBeforeRefresh) => {
  if (!refreshPromise) {
    const run = () =>
      performRefresh(tokenBeforeRefresh);

    const settled =
      globalThis.navigator?.locks?.request
        ? globalThis.navigator.locks.request(
            REFRESH_LOCK,
            run,
          )
        : run();

    refreshPromise = settled.finally(() => {
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
        /*
         * The token this request actually carried. If another tab has already
         * replaced it, the refresh becomes a no-op read instead of a rotation.
         */
        const usedHeader =
          originalRequest.headers?.Authorization ??
          originalRequest.headers?.authorization ??
          (typeof originalRequest.headers?.get ===
          'function'
            ? originalRequest.headers.get(
                'Authorization',
              )
            : null);

        const usedToken =
          typeof usedHeader === 'string' &&
          usedHeader.startsWith('Bearer ')
            ? usedHeader.slice(7)
            : null;

        const token =
          await refreshAccessToken(usedToken);

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