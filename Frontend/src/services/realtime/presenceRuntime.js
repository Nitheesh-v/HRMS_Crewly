// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE RUNTIME
//
//  One controlled socket lifecycle (Phase 36.5 + 37.4 §46):
//    · AppLayout wires start()/stop() to the auth state.
//    · The runtime owns:
//        — the /presence channel (presenceChannel.js)
//        — listeners for `presence:changed` and `presence:invalidated`
//        — the visibility ticker (heartbeat + read-only tick / 30s;
//          activity only on actual user interaction)
//        — a 1s-debounced team refetch on same-company envelopes
//
//  LIFECYCLE
//    start() is called once on auth (presence of `user.id`). It:
//      1. opens the /presence channel
//      2. registers typed change/invalidation listeners
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
  loadMyPresence,
  fetchMyWorkLocationRequests,
  presenceTicked,
  presenceInvalidateTeam,
  presenceWlrInvalidateForUser,
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
let invalidationListener = null;

const TEAM_REFETCH_DEBOUNCE_MS = 1_000;
let teamRefetchTimer = null;

const refetchTeamDebounced = () => {
  if (teamRefetchTimer) clearTimeout(teamRefetchTimer);
  teamRefetchTimer = setTimeout(() => {
    teamRefetchTimer = null;
    // The team page watches this bump and re-runs the existing
    // `fetchTeamAvailability` thunk, preserving its filters and page.
    store.dispatch(presenceInvalidateTeam());
  }, TEAM_REFETCH_DEBOUNCE_MS);
};

const onPresenceChanged = (envelope) => {
  // Strict server-built shape: schemaVersion, companyId, userId,
  // presence, presenceSource, occurredAt, source.
  if (!envelope || typeof envelope !== 'object' || envelope.schemaVersion !== 1) return;
  const me = store.getState().auth?.user;
  if (!me) return;

  const myId = String(me._id || me.id || '');
  const myCompany = String(me.companyId || me.company?._id || '');
  const sameCompany = myCompany && String(envelope.companyId) === myCompany;

  if (myId && String(envelope.userId) === myId) {
    // Fast status update, then reload the authoritative self snapshot so
    // manualStatus / Leave flags cannot go stale across tabs.
    store.dispatch(presenceTicked(envelope));
    store.dispatch(loadMyPresence());
  }

  // Includes our own row: the team table is REST-backed and must refetch
  // after an Offline, manual-status, Leave, or activity transition.
  if (sameCompany) refetchTeamDebounced();
};

const onPresenceInvalidated = (envelope) => {
  // Smaller 37.5 envelope: { schemaVersion, companyId, userId,
  // occurredAt, source }. It carries no changed HR data; refetch it.
  if (!envelope || typeof envelope !== 'object' || envelope.schemaVersion !== 1) return;
  const me = store.getState().auth?.user;
  if (!me) return;

  const myId = String(me._id || me.id || '');
  const myCompany = String(me.companyId || me.company?._id || '');
  if (!myCompany || String(envelope.companyId) !== myCompany) return;

  if (myId && String(envelope.userId) === myId) {
    store.dispatch(presenceWlrInvalidateForUser());
    store.dispatch(fetchMyWorkLocationRequests());
    store.dispatch(loadMyPresence());
  }
  refetchTeamDebounced();
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
  invalidationListener = (envelope) => onPresenceInvalidated(envelope);
  sock.on('presence:changed', listener);
  sock.on('presence:invalidated', invalidationListener);
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
  invalidationListener = null;
  return sock;
};

export const isPresenceRuntimeActive = () =>
  started && isPresenceChannelConnected();

// Narrow seam for the invalidation regression test. Production callers
// subscribe through the single runtime-owned socket listener above.
export const __onPresenceInvalidatedForTests = onPresenceInvalidated;

// Test seam: reset module state between tests.
export const __resetPresenceRuntimeForTests = () => {
  epoch = 0;
  started = false;
  listener = null;
  invalidationListener = null;
  if (teamRefetchTimer) {
    clearTimeout(teamRefetchTimer);
    teamRefetchTimer = null;
  }
};
