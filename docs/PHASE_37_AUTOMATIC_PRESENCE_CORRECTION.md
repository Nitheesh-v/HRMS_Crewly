# Phase 37 Automatic Presence Correction — Build Plan

## A. REPOSITORY FINDINGS — REPOSITORY EVIDENCE

The 20 questions in §2 answered from actual code, not inference.

### 1. Where the frontend realtime connection is created
**None.** `Frontend/src/services/realtime/presenceRuntime.js` exists and
exports `startPresenceRuntime()`, but a `grep -rn startPresenceRuntime
Frontend/src/` returns **only the export and a comment in the slice**.
There is **no caller** anywhere in the React tree.

Concretely:
```bash
$ grep -rn "startPresenceRuntime" Frontend/src/
Frontend/src/redux/slices/presenceSlice.js:352: //  presenceRuntime's
Frontend/src/services/realtime/presenceRuntime.js:101: export const
```

`AppLayout.jsx` has a `useEffect` that runs only
`dispatch(fetchMyPermissions())` on `userId` change. The presence
runtime is never started.

### 2. Whether Socket.IO actually connects
**No, not in practice.** The frontend code that would open the
Socket.IO connection is `presenceChannel.js` → `startPresenceChannel`,
which itself is only called from `presenceRuntime.startPresenceRuntime`.
Since the runtime is never started, no Socket.IO client connects.

The backend `presenceSocket.attach(server)` line in `server.js:134` is
**commented out** (the `db177d9` perf stop-gate). The socket namespace
is fully implemented but never attached in this build.

### 3. Whether a shared socket singleton/runtime exists
**Yes, the code path exists; the code is dead in production.**
- Frontend: `presenceChannel.js` has module-scoped `socket` and
  `connecting` singletons. The runtime owns the lifecycle.
- Backend: `presenceSocket.js` has `getPresenceSocketServer()`
  returning a process singleton. It is never attached.

### 4. Which frontend event represents heartbeat
**`presence:heartbeat`** — emitted on the socket in
`presenceChannel.js:sendHeartbeat`. Defined in
`presenceSocketHandlers.js:127` (no payload; server stamps `now`).

### 5. Heartbeat interval
**30 seconds** in production (`presenceChannel.js:80` —
`VISIBILITY_HEARTBEAT_MS = 30_000`). On visibility-change back to
"visible", the ticker fires an extra activity. Heartbeat is
piggy-backed with activity in the same tick (one frame, not two).

### 6. Which frontend event represents recent activity
**`presence:activity`** with `{at: <ISO>}`. The browser computes
`at`; the server validates and stamps Redis. The browser NEVER
sends keys, mouse coords, or text — only the timestamp.

### 7. How browser activity is throttled
**Visibility-tick piggyback (30s).** The runtime's
`startVisibilityTicker` runs `setInterval(..., 30_000)`. On each tick
when `document.visibilityState === 'visible'`, it fires both the
heartbeat AND the activity in the same frame. There is no
`mousemove` / `keydown` listener at all (this is by design — see the
old comment in `presenceChannel.js:130`: "the resolver decides").

There is **no client-side activity throttle** because there is **no
client-side activity listener** — only the periodic visibility tick.
This is one of the issues: the user might be active for an hour with
the tab focused, and the resolver sees the same `lastActivityAt` as
60s ago. Available is computed from `lastActivityAt`, not from a
real-time activity signal.

### 8. Which backend socket handler receives heartbeat/activity
- `presence:heartbeat` → `presenceSocketHandlers.js:124-130`,
  calls `store.refreshHeartbeat({companyId, userId})`. No publish.
- `presence:activity` → `presenceSocketHandlers.js:133-145`,
  validates `at`, calls `store.recordActivity`, then
  `resolveEffectivePresence` and `publishIfChanged`.

### 9. Where current connection state is stored
**Redis** (when enabled) or in-process memory (when not):
- `crewly:<env>:presence:conn:<userId>` — SET of socket ids
- `crewly:<env>:presence:live:<companyId>:<userId>` — HASH with
  `connectionCount`, `lastHeartbeatAt`, `lastActivityAt` + TTL
- `presenceLiveStore.js` defines `markConnected`,
  `markDisconnected`, `refreshHeartbeat`, `recordActivity`, `readLive`.

When `redis` is null, the store methods are safeCall wrappers that
return `null`. The resolver then returns `unknown` (NOT `offline`).

### 10. Whether Redis is actually involved
**Yes at the code level, but the developer's local environment
status is unknown.** The store uses the shared client
`config/redis.js#getRedisClient()`. If `REDIS_ENABLED=true` and
`REDIS_URL` set, the store writes to real Redis. If either is
missing, the store returns null and the resolver returns
`unknown`. The team page shows `Unknown` for everyone.

The presence socket also requires Redis (the adapter) to even
attach. Without Redis, the socket returns
`FEATURE_UNAVAILABLE` and the runtime falls into the
"channel refused" path.

### 11. How multiple tabs/connections are represented
**SADD/SREM on a connection set per user.** `markConnected` SADDs
the socket id; `markDisconnected` SREMs. The `connectionCount`
mirrors `SCARD`. Closing one of two tabs does NOT clear liveness.
Only the LAST qualifying disconnect (SREM empties the set) starts
the grace window. This is the multi-tab law from §15.

### 12. Where `lastActivityAt` lives
**Redis HASH** at `crewly:<env>:presence:live:<companyId>:<userId>`,
field `lastActivityAt`. Updated by `store.recordActivity` on the
activity socket event.

### 13. How `awayAfterMinutes` is obtained
**From tenant config.** `presenceResolver.js:264-266` reads
`config.awayAfterMinutes` (loaded from `PresenceTenantConfig` by
`getPresenceTenantConfigOrThrow`). Default 5. Frontend
`presenceConstants.js` has the same constants.

### 14. How `offlineAfterMinutes` is obtained
**From tenant config.** `presenceResolver.js:268-270` reads
`config.offlineAfterMinutes`. Default 15.

### 15. Which exact backend function resolves automatic Available
**`deriveAutomaticPresence({live, config, now})`** in
`presenceResolver.js:259-296` (or the `presenceResolver.resolvePresence`
caller). Pure function. Returns `'available'` when:
- `live.connected` is true AND
- `lastActivityAt` age <= `awayAfterMinutes` OR
  `lastActivityAt` missing AND `lastHeartbeatAt` age <=
  `offlineAfterMinutes`.

### 16. Which exact backend function resolves Away
**`deriveAutomaticPresence`** (same function, different branch).
Returns `'away'` when connected AND `lastActivityAt` age >
`awayAfterMinutes`.

### 17. Which exact backend function resolves Offline
**`deriveAutomaticPresence`** (same function, different branch).
Returns `'offline'` when:
- `live === null` OR
- `!connected` (no entries in connection set) OR
- `lastHeartbeatAt` age > `offlineAfterMinutes` (if a heartbeat
  ever existed).

### 18. How Team Availability learns a state changed
**Two paths**:
- `presence:changed` socket envelope → backend
  `presenceBus.publishPresenceChanged` → frontend redux
  `presenceTicked` reducer → `presenceRuntime` re-dispatches
  `presenceInvalidateTeam` → `TeamAvailabilityPage` re-fetches
  (debounced 1s).
- HTTP refetch on demand (page mount, filter change, page change).

### 19. Whether the frontend listens for that change
**The code is wired but the socket is never connected in this
build** (finding #1). The `presenceRuntime.onPresenceChanged`
listener would fire on `sock.on('presence:changed', listener)` —
but `sock` is `null` because the runtime was never started.

### 20. Whether an HTTP refetch/update follows it
**The team page would refetch via the debounced
`refetchTeamDebounced` thunk**, but only AFTER the runtime
receives a `presence:changed` envelope. Since the runtime is
never started, the team page refetches only on:
- Mount
- Filter / pagination change
- User-driven manual refresh

The team page **does not poll**. There is no
`setInterval(fetchTeamAvailability)`. So the team page shows
stale state.

### 21. Why the current runtime path fails
**Two compounding root causes:**

**A. Runtime never starts.** `startPresenceRuntime` has no caller
in the React tree. The socket is never opened. No heartbeat, no
activity, no presence:changed envelope. The live store stays
empty. The resolver returns `unknown` for everyone.

**B. No Away timer.** Even if the runtime started and recorded
activity, the resolver is event-driven — it only recomputes on
the next HTTP GET. If Employee A goes idle, the
`lastActivityAt` Redis key is set, but nothing triggers
`resolvePresence({durable, config, now, live})` to compare
`now - lastActivityAt` to `awayAfterMinutes`. The team page
only re-renders the row when the next HTTP read happens.

**C. Attach commented out.** `server.js:134` keeps the
`await getPresenceSocketServer().attach(server);` line commented
out (`db177d9` perf stop-gate). Even if the runtime started and
the frontend opened a socket, the backend would refuse the
handshake as `FEATURE_UNAVAILABLE` (no namespace attached).

## B. SECURITY / DATA BOUNDARIES

Re-affirmed from Phase 37.6 / 37.7:
- No NATS. No `VITE_REDIS_URL`. No frontend Redis.
- No Mongo writes on heartbeat. No `PresenceHistory`.
- Identity is the auth handshake. No `companyId` / `userId` in
  the activity/heartbeat body.
- Heartbeat/activity payloads are minimal: heartbeat is `{}`,
  activity is `{at: ISO}`. The browser never sends keys, mouse
  coords, or text.
- Redis down → `unknown`, never `offline`.

## C. IMPLEMENTATION

The fix is **frontend-only** for the runtime bootstrap (the
existing backend code is correct). The Away timer is also
added on the **frontend runtime** to keep the design simple
(no per-employee server intervals).

### C.1 AppLayout — start the runtime on auth

`Frontend/src/layout/AppLayout.jsx` — add a `useEffect` that:
- On `userId` change → `startPresenceRuntime()` if the
  `presenceConfig.data` (or a fetch on mount) reports the
  feature is enabled.
- On logout / unmount → `stopPresenceRuntime()`.

StrictMode-safe (the runtime already has an epoch guard).

### C.2 presenceChannel — listen for browser activity

`Frontend/src/services/realtime/presenceChannel.js` — in
addition to the visibility-tick piggyback, register a small set
of pointer/keyboard signals that emit `presence:activity`
throttled to ≤ 1 / 5s.

Throttle helper (5s minimum between emits):
```js
let lastActivityEmitMs = 0;
const ACTIVITY_THROTTLE_MS = 5_000;
const maybeEmitActivity = () => {
  const now = Date.now();
  if (now - lastActivityEmitMs < ACTIVITY_THROTTLE_MS) return;
  lastActivityEmitMs = now;
  s.emit('presence:activity', { at: new Date().toISOString() });
};
```

Listeners (added on `startVisibilityTicker`):
- `pointerdown` (mouse + touch)
- `keydown` (no text captured, no value captured)
- `focus` (when the window regains focus)
- `visibilitychange` (already wired)

Cleanup on `stopVisibilityTicker`:
- `removeEventListener` for all four

### C.3 presenceChannel — Away timer

`Frontend/src/services/realtime/presenceChannel.js` — to make
the `Available → Away` transition actually happen without
requiring the user to interact, the runtime needs a way to
trigger a server-side recomputation when the threshold
passes. The cheapest design is a small client-side scheduler
that emits a `presence:activity` (or a dedicated
`presence:recompute` event) at the threshold.

**Design choice: piggyback on the existing 30s visibility
tick.** The tick already calls `sendActivity` every 30s. With
the tick frequency at 30s, the threshold (5 min by default) is
re-evaluated every 30s on the next `GET /api/presence/me` or
`/api/presence/team` that the user makes. But the user might
not make any GET, so the team page won't re-resolve.

**The cheapest, spec-compliant fix: the client emits a synthetic
"recompute" event when the visibility tick fires AND the
client has not seen a recent server-published change.** This is
done by sending `presence:activity` (the same event the server
already handles) at a low rate. The server's existing handler
recomputes and publishes if the value changed. This means:

- Every 30s the client emits `presence:activity`. The server
  records `lastActivityAt = now` and re-resolves. For an
  active tab, `now - lastActivityAt = 0` → `available`. For
  an idle tab (the user closed the laptop), the client never
  re-emits → the server's stored `lastActivityAt` is old.

This is wrong. We need the client to NOT emit activity on
behalf of the user when the user is idle. So the activity
emission must be **gated on real user signals** (pointerdown
/ keydown / focus), not on the visibility tick.

**Better design: a dedicated `presence:tick` event that asks
the server to "re-evaluate me right now, but don't update my
lastActivityAt".** This event does not change `lastActivityAt`
and does not count as activity. The server's resolver runs
with the existing `live.lastActivityAt` (old) and returns
`away` or `offline` as appropriate.

But adding a new event requires backend changes. To keep this
**backend-clean for this correction**, the simpler path is:

**Add a new client-side `presence:recompute` event** that the
backend already accepts as `presence:activity` (same shape
`{at: ISO}`) but treated as "ask, don't write". Actually no,
this conflates "I am active" with "please re-resolve me".

**Cleanest path: add a new dedicated event `presence:tick`
that the backend handles as read-only.** The server handler
calls `resolveEffectivePresence` and publishes IF the result
differs from the last published value. It does NOT call
`recordActivity`. Implementation:

- Backend: in `presenceSocketHandlers.js`, add a 4th event
  `presence:tick` that calls `resolveEffectivePresence` and
  `publishIfChanged` only. No `recordActivity`, no
  `refreshHeartbeat`.
- Frontend: `startVisibilityTicker` also emits `presence:tick`
  at the same 30s cadence (in addition to the heartbeat).
  Real user signals emit `presence:activity` (throttled to
  5s) which DOES update `lastActivityAt`.
- The 30s tick ensures the server re-resolves on its own
  schedule — the resolver compares `now - lastActivityAt` to
  `awayAfterMinutes` and returns `away` if the threshold has
  passed.

**This satisfies the §10 critical away-timer requirement**:
the resolver actually re-runs on the client tick, so
Available → Away happens within 30s of the threshold
expiring, without requiring the user to interact again.

### C.4 AppLayout — start the runtime on auth

(Already in C.1.) The runtime only starts if the user's
tenant config has `enabled: true`. We do a single
`getTenantConfig()` read on mount and dispatch
`loadPresenceConfig()` to redux.

### C.5 Tests

#### Backend
- `Backend/test/presenceRealtime.test.js` — extend with:
  - heartbeat handler does NOT call `recordActivity`
  - new `presence:tick` handler calls `publishIfChanged` only
  - new `presence:tick` handler does NOT call `recordActivity`
  - re-publish is suppressed when the resolved value matches
    the memo

#### Frontend
- `Frontend/test/presenceRuntime.test.js` — extend with:
  - runtime start on auth
  - runtime stop on logout
  - StrictMode-safe (start, stop, start → 1 active)
  - activity throttled to 5s
  - tick piggybacks on the 30s visibility tick
  - listener cleanup
  - no socket per PresenceIndicator
  - no localStorage writes
  - payload contains no companyId / userId / keys / coords

## D. TEST PLAN

### Backend (`presenceRealtime.test.js` extension)
- `presence:heartbeat` handler calls `refreshHeartbeat`,
  does NOT call `recordActivity`, does NOT publish.
- `presence:activity` handler validates `at`, calls
  `recordActivity`, recomputes, publishes if changed.
- NEW: `presence:tick` handler calls resolve + publish
  only, does NOT call `recordActivity` or
  `refreshHeartbeat`.

### Frontend (`presenceRuntime.test.js` extension)
- One `startPresenceRuntime` per auth.
- `stopPresenceRuntime` on logout.
- StrictMode-safe.
- Activity throttle ≤ 5s.
- Tick piggybacked on visibility ticker.
- No localStorage writes.
- No companyId / userId / keys in payload.
- No socket per PresenceIndicator.

### Regression
- 376/376 prior presence + workLocation tests still green.
- 25/25 closeout tests still green.
- 18/18 hr-integration tests still green.
- 24/24 workLocation requests tests still green.

## E. ENVIRONMENT / DEPENDENCIES

- **No new env vars.**
- **No new packages.**
- **No new collections / Mongo fields.**
- **No NATS.**
- **No frontend Redis.**
- **No `.env` modification.**
- The runtime + tick use the existing `PRESENCE_SOCKET_ENABLED`
  switch (opt-in for the socket attach). The frontend runtime
  works whether or not the socket is attached — if the attach
  line is commented out, the runtime logs "channel refused"
  and the resolver returns `unknown` for everyone. The
  team page stays correct (shows `unknown` for everyone,
  not `offline`).
