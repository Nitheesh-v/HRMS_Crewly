# PHASE 32.12 — LOCALHOST ACCEPTANCE GUIDE (Beginner, PowerShell + Browser)

Status: guide for **32.12 implemented** (awaiting localhost acceptance).
Mongo required. **Redis optional** (its state shows as `disabled` when
off — also a valid diagnostic). No worker needed. Frontend optional.
Realtime optional. No secrets anywhere.

---

## 0. WHAT CHANGED (plain words)

1. Every HTTP request now gets a **safe reference number** (request ID).
   It comes back in the `X-Request-ID` response header, appears in the
   backend logs, and follows the request into background jobs. If a
   client sends its own `X-Request-ID`, it is accepted ONLY if it is a
   clean 8–64 character string; anything weird is replaced.
2. The backend now writes **one structured line per request** (method,
   route TEMPLATE like `/api/users/:id` — never the raw URL with any
   token — status, duration). Slow requests (over 1.5s by default) get
   an extra warning line.
3. **Secrets can never reach the logs**: tokens in secure portal URLs
   are masked, passwords/tokens/bank/GPS-shaped fields are redacted,
   error stacks are sanitized. This is enforced by automated tests.
4. A new **Super Admin → Diagnostics** endpoint shows safe aggregates
   (process memory, event loop, Mongo/Redis state, realtime connection
   COUNTS, request counters). No secrets, no payloads, no user lists.

## 1. START

```powershell
# Terminal 1 — Backend
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev

# Terminal 2 — Frontend (optional, for the logged-in check)
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm run dev
```

Expected startup (safe): the port line now ends with a small instance
tag like `(inst-1a2b3c4d)`. **You must NEVER see** `MONGO_URI`,
`mongodb://`, `REDIS_URL`, `redis://`, any JWT/secret value, or SMTP
credentials in any log line — not on startup, not per request.

## 2. REQUEST ID + COMPLETION LOG (PowerShell)

```powershell
$response = Invoke-WebRequest -Uri "http://localhost:5000/api/health/live" -UseBasicParsing
$response.Headers["X-Request-ID"]
```

- Expected: a UUID-style value like `9f1c0e…-…` (36 chars).
- Copy it, then open `Backend\logs\combined.log` and find the
  `http.request.complete` record for `GET /api/health/live`: it carries the
  SAME id. That is the support-correlation contract.
  (Since 33.10-fix the Terminal 1 row is the compact access row and omits the
  ids on purpose — `Get-Content Backend\logs\combined.log -Tail 1` shows the
  full JSON record for the request you just made.)

## 3. NORMAL LOGGED-IN REQUEST (Browser)

1. Start the Frontend, log in, open an ordinary page (e.g. a list).
2. Terminal 1 shows one `http.request.complete` row per API call with:
   method, the route TEMPLATE (e.g. `/api/tasks/:id` — never search text or
   tokens), status, durationMs and bytes. The requestId/userId/companyId for
   the same call are in `Backend\logs\combined.log` (JSON).
3. **Verify nothing else appears**: no Authorization token, no request
   body, no query string with your search words.

## 4. 404 / ERROR SAFETY

```powershell
try { Invoke-WebRequest -Uri "http://localhost:5000/api/definitely-not-a-route" -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

- Expected: 404 with a safe JSON error; the backend logs the reason as a
  short row (`[warn]: 404 - Route not found`) plus the access row with the
  REDACTED path — never a stack trace to the client, never tokens. The
  requestId and the bounded stack are in `Backend\logs\error.log`. Do not
  deliberately crash the process.

## 5. SLOW REQUEST BEHAVIOR

Automated tests are authoritative for the threshold (§102 of the phase
law — no debug-sleep endpoint was created). What you CAN see locally:
pages that take noticeably long (large lists) log an extra
`http.request.slow` warning line with durationMs. Default threshold is
1500 ms; it is tunable with `$env:OBSERVABILITY_SLOW_REQUEST_MS="1000"`
(restart Terminal 1; `Remove-Item Env:OBSERVABILITY_SLOW_REQUEST_MS`
to clear).

## 6. SUPER ADMIN DIAGNOSTICS (platform-only)

1. Log in to the **Super Admin** portal with your platform account.
2. Open the Background Operations page as usual (queue/worker health
   unchanged — same page, same data as before).
3. The new diagnostics aggregate is available at
   `GET /api/super-admin/diagnostics` (same platform permission as
   System Health): process memory, event-loop lag, Mongo/Redis state,
   realtime connection counts, request counters. Verify: NO Redis
   keys, NO job payloads, NO URIs, NO tenant PII.
4. Log in as a normal tenant HR user and attempt the same endpoint →
   **denied** (platform infrastructure is not tenant HR administration).

## 7. TOKEN-ROUTE PRIVACY (automated — no real tokens needed)

Do NOT test this with a real candidate/BGV link. The synthetic-token
redaction tests in `test/observabilityFoundation.test.js` are
authoritative for this case: all five secure-token URL families are
verified to come out as `[REDACTED]` in any URL logging, with query
strings stripped entirely.

## 8. OPTIONAL — REDIS DEGRADED

If Redis is stopped locally: login/pages keep working; the backend logs
its usual single bounded `[Redis] Unavailable…` degraded-mode line, and
Diagnostics shows redis state `down` (never the URL). Never FLUSH.
Restart Redis to recover.

## ACCEPTANCE CHECKLIST (leave unchecked — you check these)

- [ ] Backend starts normally; startup logs contain no secrets/URIs (§1)
- [ ] `X-Request-ID` present; matches the completion log line (§2)
- [ ] Normal logged-in browsing logs route templates, not raw URLs (§3)
- [ ] No Authorization/body/query text in any log line (§3)
- [ ] 404 gives a safe client error; log carries requestId, no stack (§4)
- [ ] Slow pages produce `http.request.slow` warnings (§5)
- [ ] Diagnostics loads for platform account; no secrets/keys/PII (§6)
- [ ] Tenant account is denied platform diagnostics (§6)
- [ ] Queue/worker Background Operations page unchanged and safe (§6)
- [ ] No observability vendor/package was added (verify: no new deps)
- [ ] No Phase 1–31 regression observed

## ROLLBACK

Single commit. Zero schema/env/dependency migrations (morgan's removal
is the only manifest change — restoring it is one line if ever needed).
