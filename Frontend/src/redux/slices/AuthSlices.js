import {
  createSlice,
} from '@reduxjs/toolkit';

/*
 * 33.14 — THE CUSTOMER SESSION IS A COOKIE, SO THE STORE HOLDS NO TOKEN.
 *
 * The access token used to live in localStorage under `infolexus_token` and
 * was attached as `Authorization: Bearer …` by src/services/api.js. Any
 * script on the page could read it and post it to another host. It now rides
 * in the HttpOnly `crewly_access` cookie, so the browser holds the session
 * and JavaScript holds nothing to steal: this slice keeps only the user
 * profile (name, role, company — display data, no credential).
 *
 * THE PLATFORM PORTAL IS A DIFFERENT SESSION and keeps its bearer token.
 * Super-admin/Support/Billing authenticate against AdminSession, not a
 * customer SecuritySession, so their requests must carry an explicit header.
 * That token therefore lives in its OWN key — a customer login can never
 * leave a stray platform header attached to tenant calls, or the other way
 * round. A token left in the OLD shared key by an older build is migrated
 * once (platform users) or dropped (everyone else: it is worthless now).
 */

const LEGACY_TOKEN_KEY = 'infolexus_token';
const PLATFORM_TOKEN_KEY = 'infolexus_platform_token';
const USER_KEY = 'infolexus_user';

const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_ADMIN',
  'BILLING_ADMIN',
];

const safeStorage = () =>
  (typeof localStorage === 'undefined' ? null : localStorage);

const readStoredUser = () => {
  const storage = safeStorage();

  if (!storage) return null;

  try {
    const raw = storage.getItem(USER_KEY);

    return raw ? JSON.parse(raw) : null;
  } catch {
    // A corrupt profile blob is not an error worth a crash: clear it and
    // start signed out. The cookie is untouched — the next API call decides
    // whether the session is actually alive.
    storage.removeItem(USER_KEY);

    return null;
  }
};

const isPlatformSession = (user) =>
  PLATFORM_ROLES.includes(user?.role);

const migrateLegacyToken = (user) => {
  const storage = safeStorage();

  if (!storage) return;

  const legacy = storage.getItem(LEGACY_TOKEN_KEY);

  if (!legacy) return;

  if (isPlatformSession(user)) {
    if (!storage.getItem(PLATFORM_TOKEN_KEY)) {
      storage.setItem(PLATFORM_TOKEN_KEY, legacy);
    }
  }

  storage.removeItem(LEGACY_TOKEN_KEY);
};

const initialState = (() => {
  const user = readStoredUser();

  migrateLegacyToken(user);

  const storage = safeStorage();

  return {
    user,

    /*
     * The PLATFORM bearer token, or null for a customer session. Customers
     * have nothing here on purpose: their credential is the cookie, and a
     * null token is what keeps api.js from attaching a header at all.
     */
    token:
      user && isPlatformSession(user)
        ? storage?.getItem(PLATFORM_TOKEN_KEY) || null
        : null,
  };
})();

const authSlice = createSlice({
  name: 'auth',
  initialState,

  reducers: {
    /*
     * `token` is optional: the customer login sends only the user (the
     * session arrived as Set-Cookie), while the platform login still sends
     * its bearer token.
     */
    setCredentials: (
      state,
      action,
    ) => {
      const {
        user,
        token,
      } = action.payload;

      state.user = user;
      state.token = token || null;

      const storage = safeStorage();

      if (!storage) return;

      storage.setItem(
        USER_KEY,
        JSON.stringify(user),
      );

      // A stale legacy key from an older build must never survive a login.
      storage.removeItem(LEGACY_TOKEN_KEY);

      if (token && isPlatformSession(user)) {
        storage.setItem(
          PLATFORM_TOKEN_KEY,
          token,
        );
      } else {
        storage.removeItem(
          PLATFORM_TOKEN_KEY,
        );
      }
    },

    logout: (state) => {
      /*
       * A customer session ending (expired cookie, sign-out) must not wipe a
       * platform token that a super-admin left in this browser profile: two
       * different sessions, two different lifetimes. The platform key is
       * cleared only when the session being ended IS the platform's.
       */
      const wasPlatformSession =
        isPlatformSession(state.user) || Boolean(state.token);

      state.user = null;
      state.token = null;

      const storage = safeStorage();

      if (!storage) return;

      storage.removeItem(USER_KEY);
      storage.removeItem(LEGACY_TOKEN_KEY);

      if (wasPlatformSession) {
        storage.removeItem(PLATFORM_TOKEN_KEY);
      }
    },
  },
});

export const {
  setCredentials,
  logout,
} = authSlice.actions;

export default authSlice.reducer;
