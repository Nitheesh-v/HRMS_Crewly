// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE RUNTIME
//
//  One controlled socket lifecycle (Phase 36.5 + 37.4 §46):
//    · AppLayout wires start()/stop() to the auth state.
//    · The runtime owns:
//        — the /presence channel (presenceChannel.js)
//        — a `presence:changed` listener that dispatches into redux
//        — the visibility ticker (one heartbeat / 30s + activity on
//          tab return)
//        — a 1s-debounced team refetch on same-company envelopes
//
//  LIFECYCLE
//    start() is called once on auth (presence of `user.id`). It:
//      1. opens the /presence channel
//      2. registers ONE `presence:changed` listener (the dispatch is
//         idempotent — `presenceTicked` is a no-op if the value is
//         unchanged)
//      3. starts the visibility ticker
//      4. records the per-tab epoch (StrictMode-safe)
//
//    stop() is called on logout / unmount. It closes the channel,
//      stops the ticker, and tears down listeners.
//
//  WHAT THIS IS NOT
//    · Not a presence *value* source — the value is read over REST.
//    · Not a NATS or Redis client. The browser only ever talks to
//      the API.
//    · Not a storage layer. No localStorage / sessionStorage.
// ═══════════════════════════════════════════════════════════════════════════

import store from '../../redux/store.js';
import {
  startPresenceChannel,
  stopPresenceChannel,
  startVisibilityTicker,
  stopVisibilityTicker,
  isPresenceChannelConnected,
} from './presenceChannel.js';
import {
  presenceTicked,
  presenceInvalidateTeam,
} from '../../redux/slices/presenceSlice.js';

// ────────────────────────────────────────────────────────────────────────
//  LIFECYCLE EPOCH
//
//  React StrictMode runs effects twice in dev. The runtime must
//  survive that (an already-running runtime is a no-op start) AND
//  not race (a teardown that finishes after a re-start must not
//  kill the re-started instance). The epoch guards that.
// ────────────────────────────────────────────────────────────────────────
let epoch = 0;
let started = false;
let listener = null;

const TEAM_REFETCH_DEBOUNCE_MS = 1_000;
let teamRefetchTimer = null;

const refetchTeamDebounced = () => {
  if (teamRefetchTimer) clearTimeout(teamRefetchTimer);
  teamRefetchTimer = setTimeout(() => {
    teamRefetchTimer = null;
    // 37.3 — the team page already polls / reads on mount; a redux
    // nudge re-runs the existing `fetchTeamAvailability` thunk
    // (which honours the current filters and pagination).
    store.dispatch(presenceInvalidateTeam());
  }, TEAM_REFETCH_DEBOUNCE_MS);
};

const onPresenceChanged = (envelope) => {
  // envelope is the strict 37.4 shape (see presenceEvents.js):
  //   { schemaVersion, companyId, userId, presence, presenceSource,
  //     occurredAt, source }
  if (!envelope || typeof envelope !== 'object') return;
  if (envelope.schemaVersion !== 1) return; // forward-safe drop
  const me = store.getState().auth?.user;
  if (!me) return;

  // Per-user self-update path. The redux `presenceTicked` reducer is
  // a no-op if the value is unchanged; same here, no per-frame work.
  const myId = String(me._id || me.id || '');
  if (myId && String(envelope.userId) === myId) {
    store.dispatch(presenceTicked(envelope));
    return;
  }

  // Team-page path. A same-company envelope triggers a debounced
  // refetch; the existing fetchTeamAvailability thunk is the
  // single source of truth for the team table.
  const myCompany = String(me.companyId || me.company?._id || '');
  if (myCompany && String(envelope.companyId) === myCompany) {
    refetchTeamDebounced();
  }
};

/**
 * Open the presence channel and start the visibility ticker. Idempotent.
 * Returns true if a fresh start ran, false if already running.
 */
export const startPresenceRuntime = async () => {
  if (started) return false;
  started = true;
  epoch += 1;
  const myEpoch = epoch;

  const sock = await startPresenceChannel();
  if (myEpoch !== epoch) {
    // A stop() ran while we were starting. The late socket becomes
    // a no-op — we just don't register a listener.
    return false;
  }
  if (!sock) {
    // Channel refused (Redis down / presence disabled). The runtime
    // is still "started" so future auth states can re-try.
    return true;
  }

  listener = (envelope) => onPresenceChanged(envelope);
  sock.on('presence:changed', listener);
  startVisibilityTicker();
  return true;
};

export const stopPresenceRuntime = () => {
  epoch += 1;
  started = false;
  stopVisibilityTicker();
  if (teamRefetchTimer) {
    clearTimeout(teamRefetchTimer);
    teamRefetchTimer = null;
  }
  // We do NOT close the socket inside the runtime if the channel
  // is shared with another surface — but in 37.4 the channel is
  // presence-only, so a stop closes it.
  const sock = (typeof window !== 'undefined') ? null : null;
  // The presence channel helper owns the socket; closing it
  // through the helper also clears its listeners.
  stopPresenceChannel();
  listener = null;
  return sock;
};

export const isPresenceRuntimeActive = () =>
  started && isPresenceChannelConnected();

// Test seam: reset module state between tests.
export const __resetPresenceRuntimeForTests = () => {
  epoch = 0;
  started = false;
  listener = null;
  if (teamRefetchTimer) {
    clearTimeout(teamRefetchTimer);
    teamRefetchTimer = null;
  }
};
