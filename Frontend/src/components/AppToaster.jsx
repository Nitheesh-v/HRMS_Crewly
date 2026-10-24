/*
 * 35.1 — THE TOAST HOST.
 *
 * Mounted exactly once, in App.jsx, above every layout (AppLayout,
 * SuperAdminLayout, the public layouts and the candidate portals), so a toast
 * raised on any screen — including one raised while a route is being replaced —
 * renders in the same place with the same look.
 *
 * This file owns the two things that must exist in exactly one place:
 *   · the visual configuration (Crewly's dark tokens, not sonner's defaults),
 *   · the global window listeners that raise toasts from outside React.
 *
 * It renders nothing else and holds no state, so it can never be the reason a
 * screen re-renders.
 */

import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { notify } from '../utils/notify.js';


/*
 * Crewly's own palette (Frontend/src/style.css `@theme`) through its variables,
 * so the cards sit on the app shell instead of sonner's own default — and follow
 * the theme switch without this file knowing which theme is on.
 */
const TOAST_STYLE = {
  background: 'var(--color-crewly-card)',
  border: '1px solid var(--color-crewly-border)',
  color: 'var(--color-crewly-text)',
  borderRadius: '12px',
  fontSize: '13.5px',
  boxShadow: 'var(--toast-shadow)',
};

const TOAST_OPTIONS = {
  style: TOAST_STYLE,
  classNames: {
    title: 'text-[13.5px] font-medium leading-snug',
    description: 'text-[12.5px] leading-snug',
    actionButton: 'bg-crewly-green/20 text-crewly-green',
    cancelButton: 'bg-crewly-card text-crewly-dim',
  },
};

/*
 * 33.14 sends this when a refresh could not recover the session and the app is
 * about to send the person to the login screen. The redirect is the real
 * signal; the toast exists so the jump is not unexplained — "why am I on the
 * login page?" is otherwise a support ticket.
 */
const AUTH_EXPIRED_EVENT = 'crewly:auth-expired';

const AppToaster = () => {
  useEffect(() => {
    const onAuthExpired = () => {
      notify.warning('Session expired. Please sign in again.', {
        description: 'You were signed out because this session could no longer be verified.',
        // The login page is a fresh screen; this card must not follow it around.
        duration: 6000,
        id: 'auth-expired',
      });
    };

    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);

    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    };
  }, []);

  return (
    <Toaster
      theme="dark"
      position="top-right"
      closeButton
      expand={false}
      visibleToasts={4}
      offset={16}
      gap={10}
      toastOptions={TOAST_OPTIONS}
    />
  );
};

export default AppToaster;
