// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.6 — PROGRESSIVE REVEAL (the ChatGPT-like feel)
//
// The reply arrives complete in one API response. This hook makes it APPEAR to
// be typed out, which is what the owner asked for in "streaming AI responses
// (word-by-word)".
//
// WHY NOT SERVER-SENT EVENTS.
//
//   SSE was considered and deliberately not used, for reasons recorded in
//   docs/PHASE_36_6_ADVANCED_CHATBOT_UX.md. The short version: an SSE path
//   would have to run through aiProvider.js, whose guard ladder (feature →
//   messages → identity → enabled → tenant → limiter → quota → vendor) is
//   pinned by 68 tests and closed. Reopening it to stream a reply that already
//   exists in full is a large risk for a cosmetic gain, and it would have
//   needed a second half-open HTTP connection per turn for a product whose
//   answers are short enough to read in a few seconds anyway.
//
//   Progressive client-side rendering is explicitly allowed by the build
//   brief, needs no new package, and keeps the guard ladder sealed.
//
// WHY THE STEP IS ADAPTIVE.
//
//   A fixed step would make a two-line answer feel instant and a long answer
//   feel broken. Scaling the step to the length means every reveal finishes in
//   roughly the same second and a half, whatever arrived.
//
// ACCESSIBILITY — THE ONE NON-NEGOTIABLE.
//
//   `prefers-reduced-motion: reduce` disables the animation entirely and shows
//   the reply at once. Anyone who has told their operating system they want
//   less movement gets the complete text immediately, with no timer and no
//   partial state.
//
// THE CONTRACT, stated because the hook is deliberately minimal.
//
//   `text` is expected to be STABLE for the life of the component. A chat
//   message's content never changes after it is created, and the bubble is
//   keyed by message id, so this holds. The effect does restart if the text
//   ever does change, but the reveal always begins from the start of whatever
//   is passed in — it never appends to a previous message's text.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';

/** True when the person has asked their operating system for less movement. */
const prefersReducedMotion = () => {
  if (typeof window === 'undefined') return false;

  if (typeof window.matchMedia !== 'function') return false;

  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

/** How many ticks a full reveal should take. 90 ticks at 16ms ≈ 1.4 seconds. */
export const TARGET_TICKS = 90;

export const TICK_MS = 16;

/**
 * Reveal `text` progressively.
 *
 * @param {string}  text                The complete reply.
 * @param {object}  [options]
 * @param {boolean} [options.enabled]   False renders everything at once.
 * @returns {{shown: string, done: boolean}}
 *          `shown` is the safe string to render. `done` is false while the
 *          animation is running, and gates anything that must not be shown
 *          half-formed — structured cards and suggestion chips in particular.
 */
export const useProgressiveReveal = (text, options = {}) => {
  const enabled = options.enabled !== false;

  const full = typeof text === 'string' ? text : '';

  // Evaluated per render rather than once at module load: the preference can
  // change while the tab is open, and a person who turns it on mid-session
  // should get the effect on the next reply, not after a reload.
  const instant = !enabled || full.length === 0 || prefersReducedMotion();

  const [shown, setShown] = useState(() => (instant ? full : ''));

  useEffect(() => {
    // Nothing to animate. The initial state already holds the full text, so
    // there is deliberately no setState here.
    if (instant) return undefined;

    // A step of at least 2 characters, so a short answer does not crawl.
    const step = Math.max(2, Math.ceil(full.length / TARGET_TICKS));

    let index = 0;

    const timer = window.setInterval(() => {
      index = Math.min(full.length, index + step);

      // The ONLY place state is written, and it is asynchronous: a timer
      // callback, never an effect body.
      setShown(full.slice(0, index));

      if (index >= full.length) {
        window.clearInterval(timer);
      }
    }, TICK_MS);

    return () => window.clearInterval(timer);
  }, [full, instant]);

  // Derived, not stored. `shown` is always a prefix of `full`, so comparing
  // lengths is exact — and a second piece of state that could disagree with
  // the first is a bug waiting to happen.
  const done = instant || shown.length >= full.length;

  return { shown: instant ? full : shown, done };
};

export default { useProgressiveReveal, TARGET_TICKS, TICK_MS };
