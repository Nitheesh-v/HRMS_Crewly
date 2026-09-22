# PHASE 32.11 — LOCALHOST ACCEPTANCE GUIDE (Beginner, PowerShell + Browser)

Status: guide for **32.11 implemented** (awaiting localhost acceptance).
Mongo **and Redis** are required for the realtime checks. Frontend
optional but recommended (the visible checks use DevTools). No secrets
anywhere.

---

## 0. WHAT CHANGED (plain words)

Phase 32.11 builds the **plumbing** for future realtime features — it
ships **no visible feature**. What exists now:

1. A logged-in browser tab can hold **one live server connection**
   (SSE — a one-way stream) that the server may push small events
   through later. Today only three harmless "proof of life" events
   exist: `connection:ready` (stream opened), `system:ping`, and
   `realtime:proof` (test event).
2. The connection is **safe by construction**: the browser first makes a
   normal authenticated HTTP call to get a **one-time ticket** (valid 30
   seconds, used once), then opens the stream with that ticket. Your
   login token is **never** put in a URL. The server decides who you are
   and which company you belong to — the browser cannot claim anything.
3. If the backend restarts, the browser quietly re-connects within a few
   seconds (new ticket each time). If Redis is down or realtime is off,
   the stream simply refuses to open — **nothing else breaks**.
4. The feature is **OFF by default**. Only when the backend is started
   with `REALTIME_ENABLED="true"` do streams exist at all.

## 1. START (3 terminals)

```powershell
# Terminal 1 — Redis (if not already running as a service)
redis-server

# Terminal 2 — Backend, with realtime explicitly ON
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
$env:REALTIME_ENABLED="true"
npm run dev

# Terminal 3 — Frontend
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm run dev
```

> PowerShell note: `$env:NAME="value"` sets a variable for that one
> window only. To turn realtime OFF again in that window:
> `Remove-Item Env:REALTIME_ENABLED` (then restart `npm run dev`).

Log in to the app as a normal HR/employee user and go to any `/app`
page. Keep DevTools open (F12 → **Network** tab).

## 2. DEFAULT-OFF SAFETY (do this FIRST)

1. Stop Terminal 2, then start it **without** the `$env:` line.
2. Log in and open DevTools → Network → filter `realtime`.
3. Expected: `POST /api/realtime/ticket` returns **503**, the page works
   normally, and the retries stay quiet (at most one every ~15 seconds —
   never a flood). No errors in the backend console.
4. This proves the safe default: unset flag ⇒ no streams, zero behavior
   change vs 32.10.

## 3. STREAM OPENS AND STAYS ALIVE (flag ON)

1. Restart Terminal 2 WITH `$env:REALTIME_ENABLED="true"`.
2. Log in, DevTools → Network → filter `realtime`.
3. Expected order:
   - `POST /api/realtime/ticket` → **200**
   - `GET /api/realtime/stream` → **200**, type `eventsource`, Status
     stays "pending" (that is correct — it is an open stream).
4. Click the `stream` row → **EventStream** tab. Expected:
   - one `connection:ready` event right away;
   - a heartbeat comment (`:hb`) roughly every **15 seconds** — this is
     only the connection being kept warm; it is NOT any "who is online"
     tracking (no such thing was built).

## 4. BACKEND RESTART → QUIET RECONNECT

1. With the stream open (step 3), press Ctrl+C in Terminal 2, then
   `npm run dev` again (same window, flag still set).
2. Expected: within ~20 seconds the old `stream` row shows
   failed/completed and a **new** `ticket` + `stream` pair appears —
   with a **new** ticket each time. The page never shows an error.
3. This proves the graceful drain: the server ends streams cleanly on
   shutdown and clients re-establish anywhere they land.

## 5. LOGOUT CLOSES THE STREAM

1. With the stream open, click Logout.
2. Expected: the `stream` row ends (cancelled/completed) and NO new
   `realtime` requests appear while sitting on the login page. The
   login page itself never opens a stream.

## 6. REDIS DOWN → NOTHING ELSE BREAKS (optional, advanced)

1. Keep backend + frontend running (flag ON), then stop Redis
   (Ctrl+C in Terminal 1, or `Stop-Service Redis` if installed as a
   service).
2. Expected: opening/refreshing the app still works (login, pages) —
   only the realtime stream cannot open (ticket returns 503). The
   backend console stays calm; nothing crashes. Start Redis again and
   streams recover on their own within a few seconds.

## ACCEPTANCE CHECKLIST (leave unchecked — you check these)

- [ ] With flag OFF: ticket → 503, app normal, retries quiet (§2)
- [ ] With flag ON: ticket 200 → stream 200 → `connection:ready` visible (§3)
- [ ] Heartbeat comments ~15s apart; no "online/presence" anything appears (§3)
- [ ] Backend restart: new ticket+stream pair within ~20s, no UI error (§4)
- [ ] Logout: stream closes; login page opens no stream (§5)
- [ ] Redis stopped: login/pages fine, only stream refuses; recovers after Redis returns (§6)

## ROLLBACK

One commit. Unset the flag (default OFF) for an instant soft-off, or
revert the single 32.11 commit — no data, schema, env, or dependency
changes exist to undo (zero new dependencies Backend and Frontend).
