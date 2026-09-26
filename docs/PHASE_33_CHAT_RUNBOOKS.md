# PHASE 33 — CHAT INCIDENT RUNBOOKS

**Audience:** whoever is on call for the Crewly API and the Chat Hub.
**Scope:** Chat Hub only (Phase 33: REST conversations/messages + the
Socket.IO realtime layer). The HTTP API, payroll, attendance and BGV have their
own runbooks.

**Ground rules for every runbook below**

- Chat has NO surveillance: no presence, no typing, no last-seen, no read
  receipts for other people. "Missing" presence data is the design, not an
  incident.
- Never paste secrets (`.env` values, `REDIS_URL`, tokens, cookies) into a
  ticket, a chat, or a log. IDs are fine; secrets are not.
- Never edit the database to fix a chat symptom. Chat rows are append-only
  history with sequence numbers; a manual edit corrupts every read cursor.
- Every command here is PowerShell, run from the repository root unless the
  runbook says otherwise.

**Fast triage table**

| Symptom | Likely runbook |
|---|---|
| Chat page loads history but "Realtime connected" never appears | §1 Redis down |
| "Realtime unavailable" banner for everyone, REST still fine | §1 Redis down |
| Sockets connect then drop constantly behind a load balancer | §2 WebSocket blocked |
| Users report "Too many messages. Slow down and retry." at normal pace | §3 Rate limit spike |
| Messages stay unsent ("sending…"), no error | §4 Send failures |
| Upload fails, or a download returns 404/503 | §5 Attachment failures |
| Messages appear on one instance but not another | §6 Multi-instance mismatch |

---

## §1 — REDIS DOWN → CHAT REALTIME UNAVAILABLE

### DETECT

- Backend log: `[ChatSocket] redis lost — chat realtime is FEATURE_UNAVAILABLE
  until it recovers.` (one line per transition, never per request).
- Users: history loads and pages work, but the header shows realtime
  unavailable and sends fail with `Chat realtime is unavailable right now.
  History still loads read-only.`
- **Platform diagnostics** (Super Admin, `health:read`): the `chat.realtime`
  block shows `state: "UNAVAILABLE"` with a reason word (`REDIS_DISABLED`,
  `REDIS_ERROR`, `REDIS_CONNECT_TIMEOUT`, `REDIS_MISCONFIGURED`,
  `ADAPTER_FAILURE`) on the affected instance. `state: "DISABLED"` means chat
  was never enabled here — check `CHAT_SOCKET_ENABLED`, not Redis.
- `npm run redis:check` reports the connection is not usable.

### IMPACT

- **No new messages** over the socket; **history, conversations, read state,
  uploads and downloads still work** over REST (they do not need Redis).
- If Redis is down (not merely disabled), every socket connection is refused
  `FEATURE_UNAVAILABLE` by design — there is no half-working realtime mode.
- Rate limits stay enforced: they degrade to bounded per-process buckets
  (stricter per instance), never to unlimited.

### DO

1. `cd Backend` then `npm run redis:check` — is Redis reachable at all?
2. If the provider is down: nothing to fix in Crewly. Chat stays in
   `FEATURE_UNAVAILABLE` and recovers by itself when Redis returns.
3. If `REDIS_URL` was changed or rotated: restart the API with the new value
   (never paste it anywhere public).
4. Watch for the recovery line: `[ChatSocket] redis recovered — chat realtime
   is READY again.` Existing clients reconnect on their own; a hard refresh
   forces it.

### DO NOT

- Do not set `REDIS_ENABLED=false` to "make it work": that is a deliberate
  single-instance deployment shape, and with more than one API instance users
  will silently stop seeing each other's messages.
- Do not disable or raise rate limits to compensate.
- Do not `FLUSHALL`/`FLUSHDB` or delete `crewly:*` keys — that erases rate-limit
  budgets and queue state.
- Do not restart every API instance at once.

### VERIFY

- Log shows exactly one `redis lost` line and later one `redis recovered` line.
- Open two browsers as two members of one conversation: send in one, the other
  receives it within a second or two.
- `GET /api/chat/conversations` still returns 200 while realtime is down.

### ESCALATE

- Redis healthy but log keeps flapping between lost/recovered → §6.
- Redis healthy, no recovery line, sockets still refused → check
  `CHAT_SOCKET_ENABLED` is the literal `true` in the API environment.

---

## §2 — WEBSOCKET BLOCKED / FALLING BACK TO POLLING

### DETECT

- Connections succeed but drop within seconds, repeatedly, with
  `transport close` / `ping timeout` in the disconnect reason.
- Browser DevTools → Network → WS: the `socket.io` upgrade request returns 400
  or never leaves "pending"; requests keep cycling on
  `/socket.io/?EIO=4&transport=polling`.

### IMPACT

- Chat works only in degraded polling mode (slower, more REST traffic) or not
  at all, depending on the proxy. History remains readable.

### DO

1. Confirm where the block is, from your machine:
   ```powershell
   curl.exe -i "http://localhost:5000/socket.io/?EIO=4&transport=polling"
   ```
   A normal answer contains `"sid"`. A proxy error page or 400 means the path
   is not reaching the API.
2. On the load balancer / reverse proxy, check ALL of:
   - WebSocket upgrade allowed for the `/socket.io` path (not just `/api`);
   - proxy read/idle timeout **greater than 25 s** (chat pings every 25 s);
   - sticky sessions enabled **if** more than one API instance is behind it;
   - `X-Forwarded-For` and HTTPS termination not breaking the upgrade.
3. If the browser is on a corporate network that blocks WebSockets, polling
   fallback is the correct behaviour — confirm the app still works (slower)
   and tell the user it is their network, not the product.

### DO NOT

- Do not lengthen `CHAT_PING_INTERVAL_MS`/`CHAT_PING_TIMEOUT_MS` in code to
  paper over a proxy timeout — fix the proxy.
- Do not disable the origin allowlist to "make it connect": origins are part of
  the auth model (`CHAT_ALLOW_LOCALHOST_ORIGINS` exists for local dev only).

### VERIFY

- DevTools → Network → WS shows one connection with status 101 and frames
  flowing in both directions.
- Send from one browser, receive in another, with no polling requests to
  `/socket.io/?transport=polling` after the upgrade.

### ESCALATE

- Upgrade fails only from outside the office network → the perimeter or CDN is
  terminating WebSockets; open a ticket with them, quoting the exact path and
  the 400/101 result from step 1.

---

## §3 — RATE LIMIT SPIKE / SPAM ATTEMPT

### DETECT

- **Platform diagnostics**: `chat.limits` shows the policy in force (maximum +
  window per action), and the `counters` section shows
  `chat.rate_limited{action}` — compare what users hit against what the policy
  actually allows.
- Log lines `chat.rate_limited` (warn) — bounded metadata only:
  `surface`, `action`, `tier`, `count`, `maximum`, `windowMs`, `companyId`,
  `userId`.
- A spike in one `companyId` with `action=message.send` or
  `attachment.upload` is abuse; a spike spread evenly across all users with
  `tier=local` is DEgradation (§1), not abuse.
- Users report `429` on REST or `RATE_LIMITED` ACKs on send.

### IMPACT

- The abusive client is throttled; normal users in the same company are
  unaffected **only if** they are different users — the budget is per
  `(companyId, userId, action)`, never per company.

### DO

1. Separate abuse from degradation:
   - `tier=shared` → the shared Redis budget refused; that is the control
     working.
   - `tier=local` → the limiter is running on the degraded per-process bucket;
     go to §1 first, the "abuse" may just be a cache-less limiter.
2. Identify the actor by `companyId` + `userId` (ask the customer's admin which
   account that is; Crewly does not log names or content).
3. If it is one account: the product already refuses it. If it keeps going,
   disable that user's access through the normal admin flow — never by editing
   chat data.
4. If a legitimate integration is hitting a limit, adjust the limit in
   `Backend/src/services/chat/chatRateLimitService.js`
   (`CHAT_REST_LIMITS` / `CHAT_SOCKET_LIMITS`), restart, and note the change in
   the phase doc — these numbers are code-owned on purpose (no env knob).

### DO NOT

- Do not delete limiter keys as a routine remedy: a window expires on its own,
  and a key that lost its TTL **heals itself on the next refused request**
  (`rateLimitStore` checks `TTL` and sets one when it is missing — see §21.8 of
  the phase doc).
- Do not raise a limit without recording why. Every number in §21 of
  `PHASE_33_CHAT_HUB.md` has a stated reason.

**If one identity is refused forever** (the classic shape: the same 429 coming
back hours apart with no burst in the logs), the window lost its TTL. Check it
on the EXACT key — no wildcards, no `KEYS`, no `SCAN`:

```powershell
# A healthy window has TTL between 1 and its window length; -1 means NO TTL
redis-cli TTL "crewly:<env>:rl:refresh:<ip>:refresh"
```

The running API heals it the next time that identity is refused. To release the
identity immediately, delete THAT EXACT key (never a pattern):

```powershell
redis-cli DEL "crewly:<env>:rl:refresh:<ip>:refresh"
```

Confirm the deployed build includes the 33.11 self-heal before treating the
manual delete as more than a stop-gap.
- Do not log or ask for message text to "see what they are sending".

### VERIFY

- The `chat.rate_limited` rate returns to baseline.
- A normal send from a different user in the same company succeeds immediately.

### ESCALATE

- Sustained abuse from many accounts in one company → the customer's admin, and
  consider whether the tenant should be suspended through the platform console.
- A limiter refusing at `tier=local` while Redis is healthy → §1.

---

## §4 — MESSAGE SEND FAILURES (MONGO SLOW, ADAPTER ISSUES)

### DETECT

- Users see a message stuck at "sending…" or the composer error
  "The message could not be sent."
- Log: `chat.message.unrenderable` (only for a body that cannot be rendered —
  a client bug or a crafted payload), `[ChatSocket] chat:message:send failed
  (<ErrorName>)`, or `http.request.error`/`http.request.slow` on the REST
  routes.
- ACK codes observed: `RETRYABLE`, `CONFLICT_EDIT_VERSION`,
  `MESSAGE_NOT_EDITABLE`, `HISTORY_LIMIT_REACHED`, `RATE_LIMITED`.

### IMPACT

- Failed sends are NOT stored and NOT broadcast. A retry with the same
  `clientMessageId` is idempotent: it either stores once or returns the stored
  message — it never duplicates.

### DO

1. Determine the ACK code (the client shows it in the send failure).
   - `RETRYABLE` → server-side hiccup: check Mongo health, disk, and slow
     queries (`npm run index:check` for chat indexes).
   - `CONFLICT_EDIT_VERSION` → someone else's edit won; the user should reload
     the conversation. Working as designed.
   - `MESSAGE_NOT_EDITABLE` / `HISTORY_LIMIT_REACHED` → 33.6 limits, by design.
   - `RATE_LIMITED` → §3.
   - `FEATURE_UNAVAILABLE` → §1.
2. Check whether the conversation is locked (`isDisabled`): a disabled
   conversation refuses send/edit/delete for members by design (33.9); history
   stays readable.
3. If Mongo is slow, fix Mongo — do not raise the socket payload or rate limits.

### DO NOT

- Do not re-send from the server by editing the database.
- Do not "fix" a stuck pending message by deleting chat documents; ask the user
  to retry (idempotent) or reload.
- Do not clear `crewly:*` Redis keys to force a resync.

### VERIFY

- A fresh send in the same conversation succeeds and appears for every member.
- Retrying the SAME message (same `clientMessageId`) does not create a second
  bubble.

### ESCALATE

- Repeated `RETRYABLE` across many users → platform-level Mongo/API incident,
  not a chat bug.
- A single user unable to send while others can → their membership was removed
  or the conversation is locked; verify in the UI, not by editing data.

---

## §5 — ATTACHMENT UPLOAD / DOWNLOAD FAILURES

### DETECT

- Upload: composer shows "The file could not be uploaded." (or the specific
  server reason — the picker shows the real message since 33.10-fix).
- Download: the bubble reports "This file is no longer available." (404) or
  "The file could not be downloaded." (503).
- Log: `http.request.rejected` with `status=400` (policy/size/shape),
  `status=404` (not a member, other tenant, or withdrawn), `status=413`
  (provider body over the cap), `status=503` (storage/signing failure).

### IMPACT

- No file is stored for a refused upload; nothing to clean up.
- A 404 on download is indistinguishable BY DESIGN between "not a member",
  "another tenant" and "file withdrawn" — do not try to distinguish it for a
  user.

### DO

1. Read the exact HTTP status from the access log row for that request:
   - `400` + "Attachments must be sent as multipart/form-data" → the client
     sent a JSON body (a client/build mismatch; the shipped client sends
     multipart).
   - `400` + "File must be 10 MB or smaller." → real size limit.
   - `400` + the allowlist message → PDF/JPG/JPEG/PNG/WEBP only.
   - `404` on upload → the caller is not a member of that conversation.
   - `404` on download → membership, tenancy, or the message was deleted (a
     deletion withdraws the file).
   - `503` → storage provider or the private-storage credentials; check
     Cloudinary configuration and `LOCAL_PRIVATE` fallback in development.
2. For 503s, verify the storage configuration with the existing diagnostics
   (`npm run config:check`) — never print the credentials themselves.
3. In development with no Cloudinary keys, files go to
   `Backend/private_storage/chat-attachments` (gitignored). Confirm the folder
   is writable if that mode is in use.

### DO NOT

- Do not make attachments public to "unblock" a user, and never return a
  provider URL or a signed URL to a browser.
- Do not raise the size cap to accommodate a file the product refuses: the cap
  protects the API's memory.
- Do not delete rows from `ChatAttachment` to free space — tombstone the
  message through the product instead.

### VERIFY

- Upload a small PDF in the affected conversation → chip appears, send
  succeeds, the other member can download it.
- `curl.exe -i -H "Authorization: Bearer <token>" "http://localhost:5000/api/chat/attachments/<id>/download"`
  returns `200` with `Cache-Control: private, no-store, max-age=0`.
- The same request with a NON-member token returns `404` (not 403, not 200).

### ESCALATE

- 503s across all tenants → storage provider incident.
- 404s for a member who should have access → check membership through the
  product (the conversation's member list), and whether the message was
  deleted.

---

## §6 — MULTI-INSTANCE MISMATCH (ADAPTER NOT CONNECTED)

### DETECT

- Users in the same conversation see different subsets of messages: the sender
  always sees their own, others sometimes do not.
- Disconnects show `ping timeout`/`transport close` on a schedule; load tests
  show messages delivered to only one instance's sockets.
- Logs: messages broadcast once but received on some nodes only; adapter ready
  log missing on one instance (`[ChatSocket] adapter ready` per instance).

### IMPACT

- Until fixed, treat realtime as unreliable in that deployment; history via
  REST is still correct (Mongo is the source of truth), so a reload shows the
  full transcript.

### DO

1. Confirm every API instance logged the adapter becoming ready, and that each
   one has its OWN Redis connection (pub/sub clients are per-instance).
2. Confirm all instances point at the SAME Redis and the same environment
   prefix — different prefixes behave like separate deployments and will never
   see each other. There is ONE prefix for every namespace (queues, rate-limit
   counters, realtime tickets, the SSE realtime channel and the chat adapter
   channel) and it comes from `BULLMQ_PREFIX` when set, else `crewly:<NODE_ENV>`.
   `npm run config:check` prints the channel-bearing names; the boot log prints
   the chat adapter key and the realtime channel — **they must agree**.
   (Until 33.11 the SSE channel ignored `BULLMQ_PREFIX`, so an instance could
   announce `crewly:production:chat:adapter` while publishing SSE events on
   `crewly:development:realtime:events`; that is fixed, and an environment pair
   sharing one Redis must now be separated by the prefix on BOTH.)
3. Confirm sticky sessions on the load balancer while polling transport is in
   use, and WebSocket upgrade support (§2).
4. Restart instances ONE AT A TIME if an adapter must be re-established, and
   watch the ready line before moving to the next.

### DO NOT

- Do not run instances with different `NODE_ENV`/prefix values behind one load
  balancer.
- Do not scale down to a single instance as a permanent fix — that removes the
  symptom and keeps the misconfiguration.
- Do not flush Redis to resync: pub/sub is stateless, and flushing erases rate
  limits and queues.

### VERIFY

- Load-test style check: two clients on different instances (force a reload
  until `socket.id` differs) exchange messages both directions within a second.
- Send 20 messages rapidly from one client while the other watches: all 20
  arrive, in `seq` order, with no gaps in the visible sequence.

### ESCALATE

- Adapter ready on all instances, same prefix, upgraded connections, and
  messages still lost → capture instance ids and timestamps and treat it as a
  platform networking incident (Redis Cluster pub/sub routing).

---

## APPENDIX — THE SAFE COMMANDS

```powershell
# Backend (Terminal 1)
cd Backend
npm run dev

# Frontend (Terminal 2)
cd Frontend
npm run dev

# Redis reachability (no secrets printed)
cd Backend
npm run redis:check

# Environment sanity (prints statuses, never secret values) — now includes
# chat enablement, the socket frame-cap law and the limiter tier
cd Backend
npm run config:check

# Chat abuse controls + payload caps + wiring (hermetic, no Redis/Mongo)
cd Backend
node --test test/chatHardening.test.js

# Blank-message audit (read-only; exits 1 when rows cannot render)
cd Backend
npm run chat:blank-check

# The exact JSON record for the last API request (ids + stack, no bodies)
Get-Content Backend\logs\combined.log -Tail 1
```

**Never run:** `FLUSHALL`, `FLUSHDB`, `KEYS`, `SCAN` against production Redis,
manual edits to `chatmessages`/`chatconversations`/`chatattachments`, or any
command that prints `.env` values.
