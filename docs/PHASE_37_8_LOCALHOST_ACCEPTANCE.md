# Phase 37.8 — Localhost acceptance (Windows PowerShell)

**Status:** owner/local acceptance is pending. These steps are instructions only; automated hermetic tests are not owner acceptance. Run only against a dedicated local development database and Redis, never shared staging/production infrastructure.

The old [`PHASE_37_LOCALHOST_ACCEPTANCE.md`](./PHASE_37_LOCALHOST_ACCEPTANCE.md) is superseded: it contains obsolete Bash commands, old commit instructions, the former SSE architecture, stale key names, and a 60-second TTL assumption.

## 1. Local prerequisites (no secret values in chat or logs)

- MongoDB, Redis, Backend dependencies, Frontend dependencies, and two test accounts in the **same** test company.
- The backend's private, ignored `Backend/.env` has valid local Mongo/Redis settings. Keep `REDIS_URL`, Mongo connection strings, JWT/session secrets, cookies, and tokens private. Do not paste them into chat or commit them.
- Keep `PRESENCE_SOCKET_ENABLED=false` in `.env.example`; enable only your private local `.env` or the current PowerShell process. No source edit or uncomment step is required.
- `CHAT_ALLOW_LOCALHOST_ORIGINS=true` is needed for loopback browser origins when the production-safe default is false.
- The default API port is 5000; the default Vite port is 5173. Use the actual local ports if overridden.

In the PowerShell window that will start the backend, set only the non-secret flags (or set them in the private local `.env`):

```powershell
$env:PRESENCE_SOCKET_ENABLED = 'true'
$env:REDIS_ENABLED = 'true'
$env:CHAT_ALLOW_LOCALHOST_ORIGINS = 'true'
```

Check Redis without printing its URL:

```powershell
if ([string]::IsNullOrWhiteSpace($env:REDIS_URL)) {
  Write-Host 'REDIS_URL is not present in this PowerShell process; verify the private Backend/.env instead.'
} else {
  Write-Host 'A private Redis URL is configured (value intentionally not displayed).'
}
Test-NetConnection -ComputerName 127.0.0.1 -Port 6379
```

`Test-NetConnection` is only a port check; it does not validate Redis authentication or TLS. Once the backend is listening, inspect runtime readiness with the existing endpoint `GET http://localhost:5000/api/health/ready`:

```powershell
Invoke-RestMethod -Uri 'http://localhost:5000/api/health/ready'
```

An optional Redis degradation is reported as `dependencies.cache = degraded`; it does not by itself make the HTTP process unready.

## 2. Start Backend and Frontend

PowerShell window 1:

```powershell
Set-Location .\Backend
npm run dev
```

The API should remain available while the optional adapter initializes. With Redis healthy, look for the safe log line indicating the `/presence` namespace adapter is attached and ready. Do not expect a log containing a Redis URL or employee identity.

PowerShell window 2:

```powershell
Set-Location .\Frontend
npm run dev -- --host 127.0.0.1
```

Open `http://localhost:5173`, sign in as Employee A, and open `/app/team`. Open a second private browser profile as a same-company viewer for checking authorized team rows. In browser DevTools → Network, filter for `socket.io` and `presence`.

Confirm:

- The page uses the existing HTTP API and one `/presence` Socket.IO namespace connection per signed-in browser; the browser does not connect to Redis.
- The handshake is authenticated. The browser does not send a company/user room join event.
- The team page's initial data and every fallback refresh are the authorized, batched REST result.
- If the adapter is unavailable, presence sockets are refused as `FEATURE_UNAVAILABLE`, the HTTP API still serves requests, and Redis failure maps presence to `Unknown` rather than mass `Offline`.

## 3. A–I scenarios

Use DevTools Network → WebSocket frames and the visible UI. Do not infer a state from a heartbeat frame. Heartbeats are liveness-only, ticks are read-only resolver checks, and only actual pointer/keyboard/focus activity emits `presence:activity` while the tab is visible.

### A — New authenticated connection → Available

1. Sign in as Employee A with a healthy Redis adapter and no active manual status/Leave override.
2. Expected: `/app/team` shows Employee A as `Available` shortly after the live REST snapshot is read.
3. Expected socket behavior: server-stamped `connect` transition may be emitted to Employee A's private tenant/user room. A healthy team-wide socket event is **not** promised; other team viewers converge through their authorized REST refresh.

### B — Idle connected employee → Away without interaction

1. Set the tenant's Away threshold to its normal/default value (5 minutes unless configured otherwise).
2. Leave Employee A's tab visible and connected. Do not click, type, or focus it after the baseline; allow the read-only `presence:tick` schedule to continue.
3. Wait for the configured Away threshold plus one ticker interval (normally about 5 minutes + 30 seconds).
4. Expected: Employee A's effective REST state becomes `Away`. The final transition, if emitted, is sourced by `tick`, not `activity`. `lastActivityAt` must remain unchanged.

### C — Genuine activity → Available

1. After B, interact with Employee A's visible page (pointer or keyboard).
2. Expected: one server-stamped activity within the 5-second throttle window, `lastActivityAt` advances, and the resolver returns `Available` if no higher-precedence manual/Leave state applies.
3. Idle timers, heartbeats, visibility changes, and ticks must not create activity.

### D — Manual Busy and DND precedence

1. Set `Busy` in the presence menu. Interact with the page and wait through at least one tick.
2. Expected: effective presence remains `Busy`; automatic activity does not override it.
3. Repeat with `Do Not Disturb`; expected: it remains `DND`.
4. Clear each manual state before continuing. Approved Leave remains higher precedence as defined by the existing resolver.

### E — Manual expiry → automatic state resumes

1. In the status expiry selector, choose a short custom expiry (for example, about two minutes in the future), save a manual status, and note the displayed expiry.
2. Do not interact after setting it. Wait until after expiry plus one ticker interval.
3. Expected: the next resolver read/tick no longer applies the expired manual value and returns `Available` or `Away` based on the existing activity/session anchor. Do not expect the expired manual preference to be rewritten by a heartbeat.

### F — Final disconnect → Offline; one remaining tab stays online

1. Open Employee A in two tabs. Verify both are connected. Close only one tab.
2. Expected: the remaining tab keeps the shared connection count nonzero; Employee A does not become Offline.
3. Close the final tab (or log out). Expected: a zero-connection snapshot is written immediately with a 30-second grace TTL; the authoritative self/team REST read resolves Offline. Reconnect quickly to exercise the grace-window path.
4. Reopen two tabs, then close both quickly. Duplicate disconnects/events are acceptable; effective state must remain idempotently Offline.

### G — Away session disconnect/reconnect → Available, without fake activity

1. Leave Employee A connected until Away, then close its final tab.
2. Reconnect/sign in again. Expected: the new session's `connectedAt` anchor makes the effective state Available initially; reconnect itself does not advance `lastActivityAt`.
3. After the Away threshold with no real activity, it should become Away again. Confirm the idle tab emits no fake activity.

### H — Redis outage → Unknown/degraded, not everyone Offline

Run only against a dedicated local Redis instance. First ensure Employee A has no manual status and no active Leave override.

1. Stop/disable that **local** Redis service using the mechanism appropriate to your machine. Do not use `FLUSHALL`, `FLUSHDB`, `KEYS`, `SCAN`, or delete shared data.
2. Keep the browser open and request the self/team presence views again.
3. Expected: the presence surface reports `Unknown`/degraded where Redis truth cannot be read; the HTTP application stays up. Existing sockets may be refused or lose fan-out until adapter recovery.
4. Restore the same local Redis instance. Wait for the bounded adapter reconnect/retry. New sockets should be admitted after both adapter clients are ready; REST remains the authority for any missed event.

### I — No Attendance mutation and no request storm

1. With Employee A idle on `/app/team`, keep DevTools Network open for at least two minutes. The team page performs one visible page-scoped batched fallback refresh per minute; presence frames are bounded (server minimums: heartbeat/activity 5 seconds, tick 10 seconds; the client normally ticks every 30 seconds). There must not be per-employee polling, a rapid HTTP loop, or activity generated by idle ticks.
2. Compare the Attendance rows for only the test employees before and after in your normal local Mongo inspection workflow. Expected: no Attendance row is created or changed by presence. Presence adds no history collection and no heartbeat Mongo writes.
3. Stop the backend and frontend normally. Do not run any Redis-wide cleanup command.

## 4. Optional two-process Redis fan-out check

This is an operator acceptance check for the **existing Socket.IO Redis adapter**; it is not required to run the hermetic test suite. Use two API processes sharing the same dedicated local Mongo/Redis, identical auth secrets, and identical queue prefix. Do not use production Redis.

PowerShell windows 1 and 2 (start from `Backend` in each):

```powershell
$env:PRESENCE_SOCKET_ENABLED = 'true'
$env:REDIS_ENABLED = 'true'
$env:CHAT_ALLOW_LOCALHOST_ORIGINS = 'true'
$env:PORT = '5000'   # window 1
npm run dev
```

```powershell
$env:PRESENCE_SOCKET_ENABLED = 'true'
$env:REDIS_ENABLED = 'true'
$env:CHAT_ALLOW_LOCALHOST_ORIGINS = 'true'
$env:PORT = '5001'   # window 2
npm run dev
```

Use two Frontend dev-server processes with API URLs selected **before** Vite starts:

```powershell
# Frontend window 1
$env:VITE_API_URL = 'http://localhost:5000/api'
npm run dev -- --host 127.0.0.1 --port 5173
```

```powershell
# Frontend window 2
$env:VITE_API_URL = 'http://localhost:5001/api'
npm run dev -- --host 127.0.0.1 --port 5174
```

Sign in as the **same test employee** in two isolated browser profiles, one on each frontend. After both private `/presence` sockets are connected, change/clear that employee's manual status from one profile. The other profile should receive the self-targeted status event across instances and refetch the authoritative REST snapshot. A different test employee must not receive that private event; team rows still converge through the authorized one-minute REST refresh.

To verify adapter recovery, stop only the dedicated local Redis service briefly, observe that the adapter closes admission/degrades, then restore it and wait for readiness. Do not manually delete presence keys. This acceptance check is not a substitute for running against your actual deployment topology.

## 5. Automated checks (run from PowerShell)

These tests are hermetic; they do not require live Redis and do not alter Attendance/Leave/Payroll data.

```powershell
Set-Location .\Backend
$env:MONGO_URI = 'mongodb://127.0.0.1:27017/crewly_phase37_distributed_test'
npm run test:presence
npm run test:presence-realtime
```

```powershell
Set-Location ..\Frontend
node --import ./test/loaders/register.mjs --test test/presenceRuntime.test.js test/presenceSourcePins.test.js
```

Record the command result locally. At the current closeout, `test:presence` reports **217/217 passing**, `test:presence-realtime` reports **108/108 passing**, and the focused frontend command reports **27/27 passing**. Passing automated tests does not mark the owner acceptance scenarios above complete.
