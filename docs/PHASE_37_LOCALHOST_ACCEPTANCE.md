# Phase 37 Localhost Acceptance Script

**Commit under test:** `3f78240` on `arena/01a0fb50-hrms-crewly`.
**User env (per ask):** `PRESENCE_SOCKET_ENABLED=true`, `REDIS_ENABLED=true`, `REDIS_URL` set, `server.js:134` uncommented.
**Defaults:** `awayAfterMinutes=5`, `offlineAfterMinutes=15`, heartbeat TTL 60s, grace TTL 30s, ticker 30s.

This script walks every Phase 37 §1 A–I scenario in the spec. Run it with TWO browser profiles (Employee A, Employee B) on `/app/team`. DevTools Network open (preserve log). Console open. Redis CLI in another terminal.

---

## 0. PRE-FLIGHT (do this ONCE)

### 0.1 Pull + restart

```bash
cd /path/to/HRMS_Crewly
git pull origin arena/01a0fb50-hrms-crewly
# Expected tip: 3f78240 fix(presence/37.7): start runtime on auth + presence:tick for Away transition
git log --oneline -3
# 3f78240 ...
# 881da04 ...
# 8bdef61 ...
```

```bash
# Restart backend so the new presence:tick handler is loaded.
cd Backend
npm install --no-audit --no-fund   # if node_modules was wiped
npm run dev
```

In the backend boot log, verify:

```
[PresenceSocket] accepting connections on /presence
✅ ready (or similar)
```

If you see `[PresenceSocket] disabled (PRESENCE_SOCKET_ENABLED!=true)`, STOP — your `.env` does not match. Re-check step 0.2.

### 0.2 Confirm .env

```bash
grep -E "PRESENCE_SOCKET_ENABLED|REDIS_ENABLED|REDIS_URL" Backend/.env
```

You must see:
```
PRESENCE_SOCKET_ENABLED=true
REDIS_ENABLED=true
REDIS_URL=redis://...   (or rediss://...)
```

And `Backend/src/server.js` around line 134 must read (uncommented):

```js
await getPresenceSocketServer().attach(server);
```

### 0.3 Start Redis

```bash
redis-cli ping
# Expected: PONG
```

If `redis-cli` is not installed: `brew install redis` / `apt install redis-tools` / use Upstash via the URL in `.env`.

### 0.4 Attendance baseline (BEFORE)

Open Mongo shell (or `mongosh`):

```bash
mongosh "$MONGO_URI"
```

```js
// Before tests run, capture the count of attendance rows.
const attCount = db.attendances.countDocuments({
  user: { $in: [<YOUR_USER_ID>, <YOUR_OTHER_USER_ID>] },
  createdAt: { $gte: new Date() },
});
print('ATT_BEFORE', attCount);
```

Replace `<YOUR_USER_ID>` and `<YOUR_OTHER_USER_ID>` with the actual ObjectIds of your two test accounts. Capture the print line. **Expected: ATT_BEFORE = 0** (or whatever your baseline is — write it down).

Also check leave / WFH baselines for completeness:

```js
db.worklocationrequests.countDocuments({ createdAt: { $gte: new Date() } });
db.leaverequests.countDocuments({ createdAt: { $gte: new Date() } });
```

### 0.5 Open the two browsers

- **Chrome (Profile 1):** sign in as Employee A → navigate to `/app/team`.
- **Chrome (Profile 2, or a private window):** sign in as Employee B → navigate to `/app/team`.
- **Both:** open DevTools → Network tab → check "Preserve log" → filter by `socket.io` or `WS`.

You should see in Network, filtered by `WS`:
- ONE WebSocket to `/socket.io/?...&ns=/presence` per browser.

### 0.6 Expected initial state

After sign-in, both browsers should show on the team page:

| Employee | Row state | Why |
|---|---|---|
| A | `Available` | Just authenticated + connected, runtime started, live.lastActivityAt ≈ now |
| B | `Available` | Same |

**Expected dev-tools evidence (Browser A):**
- One WebSocket to `/presence` namespace.
- First 30s tick fires: frames `40` (presence:heartbeat) + `40` (presence:tick) + `40` (presence:activity).
- One `GET /api/presence/team` HTTP call on mount.

**If Browser A shows `Unknown` instead of `Available`, STOP — that means the runtime is not running. Check step 0.5 network tab for the WebSocket. If absent, the runtime never started.**

---

## 1. SCENARIO A — Auth + healthy realtime + recent activity → Available

**Test:** Both browsers are open, both signed in. Both should be `Available`.

**Pass criteria:**
- Both rows show green `Available`.
- Network filter `presence` → see the latest `presence:changed` envelope for each user with `presence: "available"`, `presenceSource: "automatic"`, `source: "connect"` (first envelope after auth).

**Sample envelope (look in DevTools → WS frames):**

```json
{"schemaVersion":1,"companyId":"...","userId":"...","presence":"available","presenceSource":"automatic","occurredAt":"...","source":"connect"}
```

**Redis smoke:**
```bash
redis-cli HGETALL "crewly:development:presence:live:<companyId>:<userId>"
# Expected: connectionCount=1, lastHeartbeatAt=<ISO>, lastActivityAt=<ISO>
```

---

## 2. SCENARIO B — Connected but no activity past awayAfterMinutes (5 min) → Away

**Test:** On Browser A, stop typing. Don't click. Don't focus the window. Wait 5 minutes + the next 30s ticker.

**Pass criteria (after ~5m30s):**
- Row flips to yellow `Away`.
- One new `presence:changed` envelope in WS frames: `source: "tick"` (NOT `activity`).
- Redis `HGET lastActivityAt` is unchanged from before (the tick is read-only).

**Mechanism to verify:** The 30s ticker keeps emitting `presence:tick`. At 5 minutes, `now - lastActivityAt > awayAfterMinutes*60000`, so the resolver returns `'away'`. The memo was `'available'`, so `publishIfChanged` fires.

**If you don't want to wait 5 minutes:** in your tenant settings (`/app/settings/presence`), temporarily set `awayAfterMinutes: 1`. Then re-test in 90s.

**Redis smoke after the flip:**
```bash
redis-cli HGET "crewly:development:presence:live:<companyId>:<userIdA>" lastActivityAt
# Expected: a timestamp ~5 minutes ago (UNCHANGED from baseline — the tick did not write it)
```

---

## 3. SCENARIO C — New activity → Available

**Test:** While Browser A is `Away`, click somewhere in the window or press a key.

**Pass criteria (within 5s — that's the activity throttle window):**
- New WS frame: `presence:activity {at: <now>}`.
- Backend handler calls `store.recordActivity` → `lastActivityAt = now`.
- Backend handler calls `resolvePresence` → returns `available`.
- New `presence:changed` envelope: `source: "activity"`, `presence: "available"`.
- Row flips back to green `Available`.

**Redis smoke:**
```bash
redis-cli HGET "crewly:development:presence:live:<companyId>:<userIdA>" lastActivityAt
# Expected: a fresh ISO timestamp (within last few seconds)
```

---

## 4. SCENARIO D — Manual Busy → Busy (activity must NOT override)

**Test:** On Browser A, open the PresenceMenu (top-right avatar / status pill). Set `Busy`.

**Pass criteria:**
- HTTP `POST /api/presence/me` with `{manualStatus: "busy", manualStatusExpiresAt: <ISO>}`.
- Row flips to red `Busy` immediately.
- Now type in the window. Wait 30s. The row must stay `Busy`.
- Network WS frames show NO `presence:activity → available` envelope (the resolver's manualStatus precedence kicks in).

**Verify in DevTools:**
- `presence:activity` frames ARE sent (the client still emits them).
- BUT the server-side `presence:changed` envelope has `presence: "busy"` (because the resolver's manual branch returns `busy` regardless of activity).
- Look for `presence: "busy"`, `presenceSource: "manual"` in the WS frame after the activity emit.

**Redis smoke:**
```bash
redis-cli HGET "crewly:development:presence:live:<companyId>:<userIdA>" lastActivityAt
# The timestamp WILL update (the activity was recorded) — but the
# effective presence stays busy. This is by design.
```

---

## 5. SCENARIO E — Manual DND → DND (activity must NOT override)

**Test:** On Browser A, open PresenceMenu. Set `Do Not Disturb`.

**Pass criteria:**
- Row flips to red `DND`.
- Type continuously for 30s.
- Row stays `DND`.
- WS envelopes show `presence: "dnd"`, `presenceSource: "manual"` despite `presence:activity` events.

---

## 6. SCENARIO F — Manual expires → automatic state resumes

**Test:** Set manual `Busy` with a 60-second expiry (some tenants allow this — if not, use the `awayAfterMinutes: 1` trick from step 2). Wait for expiry.

**Pass criteria (within 60s + 30s ticker = ~90s):**
- The manual status `expires`.
- Next `presence:tick` → resolver no longer sees `manualStatusActive` → returns `available` or `away` depending on activity.
- WS envelope with `source: "tick"`, `presence: "away"` (if you were idle).
- Row flips back to `Away` (yellow) or `Available` (green).

---

## 7. SCENARIO G — All qualifying connections gone + offline threshold (15 min) → Offline

**Test:** Close Browser A. (Leave Browser B open.)

**Pass criteria (within ~15m + grace TTL 30s = ~15m30s):**
- The Redis live key TTL expires (`PRESENCE_GRACE_TTL_SECONDS_DEFAULT=30` after the last SREM emptied the connection set).
- Browser B's next `GET /api/presence/team` returns Employee A as `Offline`.
- WS envelope to Browser B: `presence: "offline"`, `source: "tick"` (or `resolver`).

**Faster verification:** set `offlineAfterMinutes: 1` in tenant settings. Wait 1m30s.

**Redis smoke after the flip:**
```bash
redis-cli EXISTS "crewly:development:presence:live:<companyId>:<userIdA>"
# Expected: 0 (the key expired)
redis-cli SMEMBERS "crewly:development:presence:conn:<userIdA>"
# Expected: (empty)
```

**Multi-tab check (CRITICAL):** Before closing Browser A, open Browser A-2 in another tab. Confirm Browser B sees both tabs as `Available`. Then close ONLY tab #1. Browser B must still see Employee A as `Available` (because the connection set still has tab #2's socket id).

```bash
redis-cli SCARD "crewly:development:presence:conn:<userIdA>"
# Expected: 2 (both tabs connected)
```

Close tab #1:
```bash
redis-cli SCARD "crewly:development:presence:conn:<userIdA>"
# Expected: 1 (only tab #2)
```

Row must STILL be `Available` on Browser B.

---

## 8. SCENARIO H — Reconnect + interact → Available

**Test:** Reopen Browser A. Sign in. The runtime starts, `markConnected` SADDs the socket id, the live key is repopulated.

**Pass criteria:**
- Browser B sees a `presence:changed` envelope with `source: "connect"`, `presence: "available"`.
- Row flips from `Offline` → `Available`.

---

## 9. SCENARIO I — Infrastructure cannot determine → Unknown (NOT Offline)

**Test:** Stop Redis (`redis-cli shutdown nosave` or kill the process). Browser B's next refetch will see no live data.

**Pass criteria:**
- Browser B shows Employee A as `Unknown` (NOT `Offline`).
- The `Unknown` color is the spec-mandated separate state — different from `Offline` (which requires grace TTL + disconnect).

**Restore:**
```bash
redis-server --daemonize yes  # or docker/start your redis
# Redis should be back; new connections populate the live store.
```

---

## 10. PERFORMANCE + PRIVACY INVARIANTS

### 10.1 Open the Network tab in Browser A. Filter by `WS`. Count frames over a 2-minute window:

| Frame type | Expected count over 2 minutes |
|---|---|
| `presence:heartbeat` | ~4 (every 30s) |
| `presence:tick` | ~4 (every 30s) |
| `presence:activity` | 0 (tab idle, no user signals) |
| `presence:changed` (inbound) | 0 if value unchanged; ≤2 if value changes |

**If you see >100 frames, you have a runaway loop. STOP — the runtime is misbehaving.**

### 10.2 Mousemove `/presence` check

Open DevTools Console. Run:
```js
const orig = window.__eventCount;
window.__eventCount = { m: 0, k: 0, p: 0, f: 0 };
document.addEventListener('mousemove', () => window.__eventCount.m++);
document.addEventListener('keydown', () => window.__eventCount.k++);
document.addEventListener('pointerdown', () => window.__eventCount.p++);
window.addEventListener('focus', () => window.__eventCount.f++);
```

Move the mouse for 30s:
```js
window.__eventCount
# Expected: { m: <thousands>, k: 0, p: ~30 (clicks), f: 0 }
```

`m` is high (mousemove) but the **presence runtime never listens to mousemove**. Verify by opening DevTools → Network → WS → filter for the activity frame — only the `pointerdown` / `keydown` / `focus` events should have produced `presence:activity` frames.

### 10.3 Activity payload check

In a WS frame inspector, expand any `presence:activity` frame. Body must be EXACTLY:
```json
{"at":"2026-...T...Z"}
```

No `companyId`, no `userId`, no `key`, no `coords`, no `value`.

---

## 11. ATTENDANCE INVARIANT (BEFORE/AFTER)

After completing all 9 scenarios, run in `mongosh`:

```js
const attCount = db.attendances.countDocuments({
  user: { $in: [<YOUR_USER_ID>, <YOUR_OTHER_USER_ID>] },
  createdAt: { $gte: new Date(Date.now() - 90*60*1000) },  // last 90 min
});
print('ATT_AFTER', attCount);
```

**Pass criteria:** `ATT_AFTER === ATT_BEFORE` (no new attendance rows were created by presence ticks / activity / heartbeats).

Also confirm no leave / WFH rows were auto-created:
```js
db.leaverequests.countDocuments({ createdAt: { $gte: new Date(Date.now() - 90*60*1000) } });
db.worklocationrequests.countDocuments({ createdAt: { $gte: new Date(Date.now() - 90*60*1000) } });
```

Both should equal their pre-test baselines.

---

## 12. ATTENDANCE TIMELINE (manual presence comparison)

Quick A/B for sanity: while the runtime is alive, your attendance page (`/app/attendance`) for both users must show **no** check-in / check-out / absence entry. The presence automatic state is presentation-only — it does NOT mutate attendance.

---

## 13. CHECKLIST

| # | Scenario | Expected | Pass? |
|---|---|---|---|
| 0 | Pre-flight (pull, restart, env, redis ping, attendance baseline) | env green, PONG, ATT_BEFORE recorded | ☐ |
| 1 | A — auth + connected + recent activity | both Available | ☐ |
| 2 | B — idle past away threshold | A → Away within 5m30s | ☐ |
| 3 | C — new activity | A → Available within 5s | ☐ |
| 4 | D — manual Busy | A → Busy, activity doesn't override | ☐ |
| 5 | E — manual DND | A → DND, activity doesn't override | ☐ |
| 6 | F — manual expires | A → Away/Available within ~30s | ☐ |
| 7 | G — all connections gone + offline threshold | A → Offline; multi-tab kept Available | ☐ |
| 8 | H — reconnect | A → Available on Browser B | ☐ |
| 9 | I — infra cannot determine | Unknown (NOT Offline) when Redis down | ☐ |
| 10 | Performance + privacy | ≤4 frames / 2min per type; no mousemove listener | ☐ |
| 11 | Attendance baseline | ATT_AFTER = ATT_BEFORE | ☐ |

---

## 14. REPORT BACK

Reply with the table above filled in (☐ → ✅ or ❌ with a one-line note). If any check is ❌, share:

1. The WS frame that surprised you (paste the JSON).
2. The browser console error (if any).
3. The exact `presence:changed` envelope that arrived at the team page.
4. The relevant `redis-cli HGETALL` output.

I'll diagnose from the wire frames + Redis state. The fix path is in the data, not in your head.

---

**Phase 37 automatic presence correction awaiting localhost acceptance.**