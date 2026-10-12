# Diagnose the 25s timeout — global slowness on every request

If the user is seeing `timeout of 25000ms exceeded` on multiple
endpoints (not just the presence save), the backend is slow
systemically, not on a single query. The frontend axios default
is 25s — every request that takes longer than that gets a toast.

The backend ALREADY has the right hooks for this; nothing has to
be coded.

## A. The slow-request logger (built-in, ships in every release)

`Backend/src/infrastructure/observability/httpObservability.js`
logs `http.request.slow` for any request whose total time exceeds
`OBSERVABILITY_SLOW_REQUEST_MS`. The default is 1500ms; set it
to 500ms in your `.env` to make it aggressive:

```
OBSERVABILITY_SLOW_REQUEST_MS=500
```

Then restart the backend. Every request over 500ms leaves a line
like:

```
[warn] http.request.slow { method: "GET", route: "/api/presence/me",
                              status: 200, durationMs: 8234,
                              bytes: 412, userId: "…", companyId: "…" }
```

The `route` + `durationMs` pair is enough to know which endpoint
is the bottleneck. The first one to look at is the one closest
to 25s.

## B. The per-request perf log (PERF_TIMING=true)

```
PERF_TIMING=true
```

The middleware at `Backend/src/middlewares/perfTiming.js` mounts
a Mongoose query-counter and logs one line per request:

```
[Perf] GET /api/users -> 200 totalMs=8432 mongoQueries=5
      marks={"auth":12,"tenant":40,"rbac":120}
      collections=users.find=2,companies.find=1,subscriptions.find=1
```

The `marks` dict is CUMULATIVE milliseconds — the cost of a phase
is its mark minus the previous one. The `collections` list tells
you exactly which Mongo collection+method pair dominated.
Together they answer "which middleware ate the time AND which
collection is slow".

## C. The presence + system per-controller diagnostics (37.4)

The presence controller and the system controller have per-call
timing that logs `STILL RUNNING after 500ms` and a final elapsed
ms, gated to a 500ms threshold. Look for lines like:

```
[presence/putStatus] STILL RUNNING after 500ms — userId: …
[presence/putStatus] service.setMyStatus took 12345 ms
[system/unreadCount]  Notification.countDocuments took 1234 ms
```

These are always on (no env var). They catch the per-controller
slowness for the paths they cover.

## How to start

1. Stop the backend.
2. Add to your backend `.env`:
   ```
   PERF_TIMING=true
   OBSERVABILITY_SLOW_REQUEST_MS=500
   ```
3. Start the backend.
4. Open the user page (the screenshot showed `/app/users` with
   the Add User modal). Open the bell. Save a status. Click
   around. Each request leaves a log line.
5. Paste the slowest line here. I can pinpoint the exact step
   from the route, duration, and the `collections` / `marks`
   dict.

## What to look for in the log

- If `marks.tenant` is large: the `tenantContext` middleware
  (Company + Subscription populate) is the bottleneck. Check the
  Company + Subscription collections for missing indexes.
- If `marks.auth` is large: the auth middleware's `User.findById`
  + `SecuritySession.findOne` is the bottleneck. Check the User
  + SecuritySession collections.
- If `marks.rbac` is large: a permission check is querying a
  slow collection. Look at the `collections` list.
- If `collections` shows one collection dominating: that's the
  specific query. Add an index or rewrite the query.

## Most likely causes for systemic 25s timeouts

1. **Mongo connection pool exhausted** — too many concurrent
   requests waiting for a free connection. The pool default is
   100; check the Atlas dashboard.
2. **Mongo host high latency** — a remote Atlas cluster with
   200ms+ pings turns 5 round-trips into 1s+. The perf log
   shows it as `companies.find=1,subscriptions.find=1,...` each
   taking 200-300ms.
3. **A slow populate** — the `tenantContext` middleware does
   `populate('subscription')` on every request. If the
   Subscription collection is huge, this is slow. Cache it.
4. **A missing index** — the perf log shows the same collection
   hit many times. Add the index.

## Once you've got the log

Paste 5-10 of the slowest lines here. From the `route` +
`durationMs` + `collections` I'll tell you exactly which Mongo
collection is the bottleneck and which index to add.
