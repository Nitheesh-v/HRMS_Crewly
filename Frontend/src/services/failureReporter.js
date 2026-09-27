/*
 * 35.1 — THE GLOBAL FAILURE REPORT.
 *
 * Every screen now gets a toast for a failed request even where nobody wrote a
 * catch-and-tell branch. This module is the single place that decision lives,
 * and it is attached to every axios client the app uses:
 *
 *   · services/api.js        — the customer API client (the vast majority)
 *   · the axios default client — the few services that keep their own client
 *     (attendance capture, BGV collection/consent/verifier, offers,
 *     pre-onboarding, public careers). They talk to the same backend, so a
 *     failure there must read the same way.
 *
 * It is an INTERCEPTOR ADDED ALONGSIDE the existing ones, never a replacement:
 * it observes, raises a toast, and re-rejects the untouched error so api.js's
 * refresh/retry logic and every existing catch block keep working exactly as
 * before.
 *
 * FOUR THINGS IT DELIBERATELY DOES NOT RAISE:
 *   · a cancelled request — the caller aborted it (a screen unmounted, a search
 *     was superseded); there is nothing for the person to do about it;
 *   · a request opted out with `{ skipErrorToast: true }` — the call site is
 *     raising its own, more specific card (the chat send path, for example,
 *     knows the difference between "not a member" and "the socket is down");
 *   · a session that has ended — a customer 401 is either silently refreshed
 *     and retried, or the session is over and `crewly:auth-expired` raises the
 *     one "Session expired" card (AppToaster). A raw "Unauthorized" underneath
 *     it would be noise. The exception is a public auth screen, where a 401 is
 *     a real answer to a real attempt ("Invalid email or password") and must be
 *     shown;
 *   · the refresh plumbing itself (`/auth/refresh`) — a message there is an
 *     implementation detail of a session ending.
 *
 * ONE LATCH PER ENDPOINT, NOT ONE PER REQUEST. Background screens poll (the
 * notification bell every 30s, the attendance and payroll boards on timers).
 * A dead endpoint must produce ONE card that stays until it recovers — not a
 * new card every tick. The latch is cleared the moment that same endpoint
 * answers successfully, so a later outage is reported again.
 */

import axios from 'axios';

import { notify } from '../utils/notify.js';

const QUIET_PATHS = ['/auth/refresh'];

/*
 * A 401 here is an answer to something the person just tried, not a session
 * that ran out — so it is reported like any other failure.
 */
const PUBLIC_AUTH_PATHS = [
  '/auth/login',
  '/auth/register-company',
  '/auth/forgot-password',
  '/auth/reset-password',
];

const NETWORK_FALLBACK = 'Cannot reach the server. Check your connection and try again.';
const SLOW_FALLBACK = 'The server took too long to respond. Please try again.';

/** requestKey -> the message currently on screen for that endpoint. */
const openFailures = new Map();

export const requestKeyOf = (config) =>
  `${String(config?.method || 'get').toLowerCase()} ${String(config?.url || '')}`;

const urlOf = (config) => {
  const raw = String(config?.url || '');

  /*
   * A client's baseURL is not part of `config.url`; the paths compared below
   * are registered without it, so a baseURL-prefixed url still matches.
   */
  return raw;
};

const matchesAny = (url, paths) => paths.some((path) => url.startsWith(path) || url.includes(path));

export const clearFailureLatch = (config) => {
  if (config) {
    openFailures.delete(requestKeyOf(config));
  }
};

export const failureMessageOf = (error) => {
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
    return SLOW_FALLBACK;
  }

  if (!error?.response) {
    return NETWORK_FALLBACK;
  }

  const serverMessage = error.response?.data?.message;

  if (typeof serverMessage === 'string' && serverMessage.trim()) {
    return serverMessage.trim();
  }

  return error.message || NETWORK_FALLBACK;
};

export const shouldReportFailure = (error, config) => {
  if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') {
    return false;
  }

  if (!config || config.skipErrorToast === true) {
    return false;
  }

  const url = urlOf(config);

  if (matchesAny(url, QUIET_PATHS)) {
    return false;
  }

  if (error?.response?.status === 401 && !matchesAny(url, PUBLIC_AUTH_PATHS)) {
    return false;
  }

  return true;
};

export const reportFailure = (error, config) => {
  if (!shouldReportFailure(error, config)) {
    return null;
  }

  const message = failureMessageOf(error);
  const key = requestKeyOf(config);

  // Still on screen for this endpoint: do not stack a second card.
  if (openFailures.get(key) === message) {
    return null;
  }

  openFailures.set(key, message);

  notify.error(message, { id: `request-failed:${key}` });

  return message;
};

/*
 * Attaches observation only. The instance's own interceptors still run and the
 * error still reaches the caller unchanged.
 */
export const attachFailureReporter = (instance) => {
  instance.interceptors.response.use(
    (response) => {
      clearFailureLatch(response.config);

      return response;
    },
    (error) => {
      reportFailure(error, error?.config);

      return Promise.reject(error);
    },
  );

  return instance;
};

/** Test seam: the latch outlives a single assertion otherwise. */
export const resetFailureLatches = () => {
  openFailures.clear();
};

export default { attachFailureReporter, reportFailure, shouldReportFailure };
