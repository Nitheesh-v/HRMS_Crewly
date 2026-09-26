import axios from 'axios';
import store from '../redux/store.js';
import {
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

/*
 * 33.14 — THE CLIENT NO LONGER TOUCHES A TOKEN AT ALL.
 *
 * The access token is an HttpOnly cookie the server sets on login and on
 * every rotation; JavaScript cannot read it, so nothing here stores, adopts,
 * or re-reads one. (The platform portal's bearer token is a different
 * session and is attached by the request interceptor below.)
 *
 * What stays, and why:
 *   · ONE ROTATION, ONE WRITER. The refresh token is single use and the
 *     cookie is shared by every tab. Tabs that expire together used to
 *     rotate twice; the second presentation looked like theft and signed the
 *     person out of every device. The cross-tab lock serialises them — and
 *     the loser now gets 409 REFRESH_IN_PROGRESS (server-side grace window,
 *     33.13) which it retries, because the winner's fresh cookie is already
 *     installed in this browser.
 *   · The retry is BOUNDED (3 attempts with jitter), never a loop.
 */
const requestRefresh = async () => {
  // No token to read and none to write back: the response's Set-Cookie IS
  // the new session. The separate client keeps the response interceptor of
  // the main one from intercepting this call.
  const response = await refreshClient.post('/auth/refresh', {});

  return response?.data ?? {};
};

const performRefresh = async () => {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestRefresh();
    } catch (error) {
      lastError = error;

      const status = error?.response?.status;
      const code = error?.response?.data?.code;

      /*
       * 409 REFRESH_IN_PROGRESS: another tab rotated first and its cookie is
       * already in this browser. Waiting briefly and retrying is the whole
       * recovery — no logout, no re-login.
       */
      if ((code === 'REFRESH_IN_PROGRESS' || status === 409) && attempt < 2) {
        await sleep(REFRESH_RETRY_MS + Math.random() * REFRESH_RETRY_MS);

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
const refreshAccessToken = () => {
  if (!refreshPromise) {
    const run = () => performRefresh();

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

/*
 * 33.14 — WHAT EVERY REQUEST CARRIES.
 *
 *  · X-Requested-With: the CSRF proof the API requires on cookie-authenticated
 *    writes. The cookie is attached by the browser; this header is the part a
 *    hostile page cannot add (a custom header needs a CORS preflight, and the
 *    API never approves one from an unknown origin).
 *  · Authorization: ONLY for the platform portal (super-admin/support/billing),
 *    whose AdminSession is a bearer token by design. A customer request never
 *    sends one — there is no customer token in JavaScript to send — so the
 *    cookie is the only identity it can present.
 */
api.interceptors.request.use((config) => {
  config.headers = config.headers || {};

  config.headers['X-Requested-With'] = 'XMLHttpRequest';

  const user = getStoredUser();

  const platformToken = PLATFORM_ROLES.includes(user?.role)
    ? localStorage.getItem('infolexus_platform_token')
    : '';

  if (platformToken) {
    config.headers.Authorization = `Bearer ${platformToken}`;
  }

  return config;
});

/*
 * The refresh call must carry the CSRF header too: it is a state-changing
 * POST (it rotates the refresh token). It deliberately has no Authorization
 * header — even for the platform portal — so it can never be confused with a
 * platform session.
 */
refreshClient.interceptors.request.use((config) => {
  config.headers = config.headers || {};
  config.headers['X-Requested-With'] = 'XMLHttpRequest';

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
         * 33.14 — nothing to swap here. The refresh answered with a new
         * HttpOnly cookie, and the browser attaches it to the retry
         * automatically; there is no header to rewrite (and no token in
         * JavaScript to rewrite it with).
         */
        await refreshAccessToken();

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