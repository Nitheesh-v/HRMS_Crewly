/*
 * 35.1 — ONE TOAST API FOR THE WHOLE APP.
 *
 * Every user-visible outcome that has no other place to live now goes through
 * here, so feedback looks and behaves the same on all 145 screens:
 *
 *   import { notify } from '../utils/notify.js';
 *   notify.success('Permissions saved.');
 *   notify.error(error, 'Could not save permissions');
 *
 * Why a wrapper and not `toast` directly:
 *   · ONE PLACE FOR THE COPY RULE. `notify.error` accepts anything a call site
 *     happens to be holding — an axios-normalised Error (api.js always rejects
 *     with `Error{ message, status, code, data }`), a plain string from a
 *     socket ACK, or nothing at all — and resolves it to a sentence. A call
 *     site never has to remember the shape.
 *   · ONE PLACE FOR DURATIONS AND DEDUPE. Identical errors arriving together
 *     (a page load that fires five requests, a retrying poll) must read as one
 *     message, not five stacked cards.
 *   · CALLABLE OUTSIDE REACT. axios interceptors, socket callbacks and window
 *     event listeners all use this; nothing here needs a hook or a provider.
 *
 * The rendering half is <AppToaster /> (mounted once in App.jsx). This module
 * only shapes and dispatches messages.
 */

import { toast } from 'sonner';

/*
 * Errors linger longest: they are the ones a person must actually read and
 * possibly act on. Successes are the shortest — the screen already changed.
 */
const DURATION = {
  success: 3200,
  info: 4200,
  warning: 6000,
  error: 7000,
};

const GENERIC_FALLBACK = 'Something went wrong.';

/*
 * Two identical toasts inside this window collapse into the first one. 6s is
 * deliberately longer than any page's initial fetch burst and long enough that
 * a 5s poll cannot stack cards, but still short enough that a genuinely new
 * failure after the card is gone is shown again.
 */
const DEDUPE_WINDOW_MS = 6000;

/*
 * ONE ERROR CARD PER BURST.
 *
 * A single failed action can be reported twice: once by the global report in
 * services/failureReporter.js (the server's sentence) and once by the screen's
 * own catch block (its sentence for this screen). The person must see ONE
 * card. Inside this window a new error REPLACES the error already on screen
 * instead of stacking under it, and the last writer wins — a screen's copy is
 * written for its screen, so it is the better of the two.
 */
const ERROR_COALESCE_MS = 1500;

/** { id, at } of the error toast currently on screen, if any. */
let lastErrorCard = { id: null, at: 0 };

/** message -> timestamp of the last time we showed exactly that text. */
const recentlyShown = new Map();

const pruneRecent = (now) => {
  for (const [key, at] of recentlyShown) {
    if (now - at > DEDUPE_WINDOW_MS) {
      recentlyShown.delete(key);
    }
  }
};

const isDuplicate = (kind, message) => {
  const now = Date.now();

  pruneRecent(now);

  const key = `${kind}:${message}`;

  if (recentlyShown.has(key)) {
    return true;
  }

  recentlyShown.set(key, now);

  return false;
};

/*
 * RESOLVING AN ERROR INTO A SENTENCE.
 *
 * api.js rejects with a plain `Error` whose `.message` is already the server's
 * message (or a network/axios one). Socket code and the chat client hand over
 * strings. Anything else (a bare object, `undefined`, a rejected `null`) must
 * still produce a readable fallback rather than "undefined" on screen.
 */
const errorMessage = (error, fallback) => {
  const excuse = typeof fallback === 'string' && fallback ? fallback : GENERIC_FALLBACK;

  if (!error) {
    return excuse;
  }

  if (typeof error === 'string') {
    return error.trim() || excuse;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error?.message === 'string' && error.message) {
    return error.message;
  }

  if (typeof error?.data?.message === 'string' && error.data.message) {
    return error.data.message;
  }

  return excuse;
};

const titleOf = (message) => message;
const descriptionOf = (options) =>
  typeof options?.description === 'string' && options.description
    ? options.description
    : undefined;

/*
 * The one place a toast is actually created. Every public helper funnels here
 * so the dedupe, the duration defaults and the option pass-through can never
 * drift apart between kinds.
 */
const show = (kind, message, options = {}) => {
  const body = typeof message === 'string' ? message.trim() : '';

  if (!body) {
    return null;
  }

  const dedupe = options.dedupe !== false;

  if (dedupe && isDuplicate(kind, body)) {
    return null;
  }

  if (kind === 'error' && options.coalesce !== false) {
    const now = Date.now();

    if (lastErrorCard.id !== null && now - lastErrorCard.at < ERROR_COALESCE_MS) {
      toast.dismiss(lastErrorCard.id);
    }

    const id = toast.error(titleOf(body), {
      description: descriptionOf(options),
      duration: options.duration ?? DURATION.error,
      id: options.id,
      dismissible: options.dismissible ?? true,
    });

    lastErrorCard = { id, at: Date.now() };

    return id;
  }

  return toast[kind](titleOf(body), {
    description: descriptionOf(options),
    duration: options.duration ?? DURATION[kind],
    id: options.id,
    action: options.action,
    // Errors stay until dismissed or timed out even if the pointer passes over;
    // successes hover-pause by default, which is what sonner already does.
    dismissible: options.dismissible ?? true,
  });
};

/*
 * `notify.error(error, 'Could not save permissions')` is the common call, but
 * `notify.error('exact text')` and `notify.error(error, 'text', { duration })`
 * both work — the second positional argument is only treated as options when
 * it is an object.
 */
const splitErrorArgs = (fallback, options) => {
  if (fallback && typeof fallback === 'object') {
    return { fallback: undefined, options: { ...fallback, ...options } };
  }

  return { fallback, options };
};

export const notify = {
  success(message, options) {
    return show('success', message, options);
  },

  info(message, options) {
    return show('info', message, options);
  },

  warning(message, options) {
    return show('warning', message, options);
  },

  error(error, fallback, options) {
    const resolved = splitErrorArgs(fallback, options);

    return show('error', errorMessage(error, resolved.fallback), resolved.options);
  },

  /*
   * Success feedback that depends on the server's own words — a mutation that
   * answers `{ message: 'Members added' }`. Falls back to the caller's sentence
   * when the body carries no message.
   */
  successFrom(response, fallback, options) {
    const fromBody =
      typeof response?.message === 'string' && response.message
        ? response.message
        : typeof response?.data?.message === 'string' && response.data.message
          ? response.data.message
          : '';

    return show('success', fromBody || fallback, options);
  },

  /** Awaits a promise, toasts both ends, and re-throws nothing. */
  async run(promise, { success, error, options } = {}) {
    try {
      const result = await promise;

      if (success) {
        notify.successFrom(result, success, options);
      }

      return result;
    } catch (failure) {
      notify.error(failure, error);

      return null;
    }
  },

  dismiss(id) {
    toast.dismiss(id);
  },

  clear() {
    toast.dismiss();
  },

  /*
   * Test seam: the dedupe memory outlives a single assertion otherwise.
   */
  resetDedupe() {
    recentlyShown.clear();
    lastErrorCard = { id: null, at: 0 };
  },
};

export { errorMessage as resolveErrorMessage };

export default notify;
