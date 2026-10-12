// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — LIVE STORE REGISTRY (process-local singleton)
//
//  WHY THIS MODULE EXISTS
//    The presence controller (HTTP) and the presence socket (WebSocket)
//    both need to read + write the SAME Redis-backed live store. A
//    process-local singleton keeps the seam one-line, lets the socket
//    module attach the store at server start, and lets the controller
//    pick it up lazily on the next request.
//
//  TEST-FRIENDLY
//    The registry is `let current = null`. Hermetic tests call
//    `setPresenceLiveStore(fakeStore)` in beforeEach and
//    `_resetPresenceLiveStoreForTests()` in afterEach. The fake
//    store is the SAME interface the real store exposes (markConnected,
//    refreshHeartbeat, recordActivity, markDisconnected, readLive,
//    readLiveMany, describe).
//
//  FAILURE POSTURE
//    `getPresenceLiveStore()` returns the current store OR null. The
//    controller + team service treat null as "no live source" and
//    the resolver returns 'unknown' for every row — the same shape
//    the 37.1 contract returns when no live source is wired.
// ═══════════════════════════════════════════════════════════════════════════

let current = null;

export const getPresenceLiveStore = () => current;

export const setPresenceLiveStore = (store) => {
  current = store || null;
  return current;
};

export const clearPresenceLiveStore = () => {
  current = null;
};

// Test-only: clear module state between hermetic unit tests.
export const _resetPresenceLiveStoreForTests = () => {
  current = null;
};

// Re-exported here so callers (e.g. the socket module) can import a
// single name. The factory itself lives in presenceLiveStore.js to
// keep the redis-touching code next to the data it touches.
export { createPresenceLiveStore } from './presenceLiveStore.js';
