# CREWLY — PHASE 36 OPERATIONAL RUNBOOKS

Production runbooks for the Phase 36 AI suite. Every runbook follows the same
six sections so an on-call engineer never has to hunt for the action:

```
DETECT    how you find out
IMPACT    what the employee actually experiences
DO        the exact steps, in order
DO NOT    the shortcuts that make it worse
VERIFY    how you know it is fixed
ESCALATE  when to hand it to someone else
```

**Standing rule for every runbook:** the AI suite is **informational only**. It
never approves, applies, punches, pays or decides anything. An AI outage is
never a payroll, attendance or leave outage — the product keeps working and
only the assistant is silent. Say that out loud to the employee before
escalating anything.

---

## Incident 1 — Groq AI Provider Outage / Timeout Spike

### DETECT
- Employees report the assistant replying *"The AI provider did not answer"*
  (`AI_VENDOR_ERROR`, one generic 503).
- `GET /api/ai/config` as a tenant admin shows a spike in `errorType: 'vendor'`.
- Server log lines `ai.vendor.error { feature, errorType, status, latencyMs }`.
- A `timeout` `errorType` with `latencyMs` near `AI_TIMEOUT_MS` (30 s).

### IMPACT
Every AI answer fails. **Nothing else in the product is affected** — leave,
attendance, payroll and tasks are untouched, because the assistant is a read-only
consumer. An employee who needed their leave balance can still open My Leaves.

### DO
1. Classify from the log metadata before touching anything:

   | `errorType` | Meaning | Action |
   | --- | --- | --- |
   | `auth` | bad or rotated `AI_API_KEY` | go to Incident 2 |
   | `rate_limit` | the vendor's own limit | lower `AI_MONTHLY_QUOTA_TOKENS` per tenant, or wait |
   | `timeout` | network or vendor slowness | raise `AI_TIMEOUT_MS`, then watch |
   | `network` | no internet / DNS / firewall from the app host | check egress |
   | `vendor` | dead model string, or payload too large | check `AI_MODEL` |

2. Confirm the model string is still current:

   ```powershell
   curl.exe -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $env:AI_API_KEY"
   ```

   `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` were decommissioned on
   the free/developer tier on **2026-08-16**. The shipped default is
   `openai/gpt-oss-120b`.

3. If the vendor is genuinely down, switch AI off globally rather than letting
   every employee hit a dead endpoint:

   ```ini
   AI_ENABLED=false
   ```

   Then restart the backend (nodemon watches `.env`, so it restarts itself).

4. Tell the affected tenants the assistant is off and where to find the data
   directly. That sentence is the whole incident response.

### DO NOT
- **Do not retry in a loop.** The rate limiter and quota are the real
  protection; a retry storm turns a vendor outage into a quota outage.
- **Do not** put the vendor's error text in front of an employee. The
  opaque-error law exists because a vendor message names keys and hosts.
- **Do not** "fix" it by disabling PII redaction. That turns an outage into a
  privacy incident.
- **Do not** change `AI_MODEL` to something unverified — a 404 with a correct
  key almost always means the dev server is serving a stale `.env`.

### VERIFY
Ask one question through the assistant and get a real answer. Then:

```powershell
curl.exe -s -b cookies.txt http://localhost:5000/api/ai/config
```

`status` is back to `success` and `errorType` is empty.

### ESCALATE
If `auth` or `network` persists after step 2, it is an infrastructure problem,
not an AI problem — hand it to whoever owns the host's egress and the secret
store.

---

## Incident 2 — `AI_API_KEY` Leak or Emergency Key Rotation

### DETECT
- The key appears in a commit, a log line, a screenshot or a ticket.
- Groq reports unexpected usage, or `errorType: 'auth'` appears after a
  rotation you did not perform.
- `config:check` reports the AI block as invalid.

### IMPACT
Anyone holding the key can spend the tenant's quota. They cannot read Crewly
data — the key only reaches the vendor, and the HR context is assembled
server-side and redacted before it leaves. The exposure is **cost and abuse**,
not customer data.

### DO
1. **Revoke the old key at the provider first.** Everything else is secondary.
2. Generate a replacement key.
3. Put it in `Backend/.env`:

   ```ini
   AI_API_KEY=<new key>
   ```

4. Restart the backend. nodemon watches `.env` (`watch: ["src", ".env"]`), so
   the process restarts on save — but restart it explicitly if in doubt.
5. Run the config check:

   ```powershell
   cd Backend
   npm run config:check
   ```

6. Confirm one assistant turn succeeds.

### DO NOT
- **Do not commit the key.** `.env` is gitignored; keep it that way. A key in
  git history is a leaked key, and rewriting history is not a fix.
- **Do not** paste the key into a ticket, a chat or a log line. Treat it exactly
  like `JWT_SECRET`.
- **Do not** rotate quietly. If the old key was ever exposed, the spend during
  the exposure window is unknown — check `GET /api/ai/config` for the month's
  token total before and after.

### VERIFY
`config:check` reports the AI block valid, and a real assistant turn returns an
answer rather than `AI_UNAVAILABLE`.

### ESCALATE
If the leak reached git history or a public channel, treat the key as burned:
revoke, rotate, and raise it with whoever owns secret management. There is no
partial remediation for a published credential.

---

## Incident 3 — Tenant Quota Exhaustion & Emergency Token Grant

### DETECT
- Employees in **one** tenant only see *"The monthly AI budget for your
  organization is used up"* (`429 QUOTA_EXCEEDED`).
- `GET /api/ai/config` shows `monthToDateTokens` at or above
  `monthlyQuotaTokens`.
- Other tenants are unaffected — that is the tell that this is the per-tenant
  cap, not the global switch.

### IMPACT
That tenant's AI is refused for the rest of the month. The rest of the product
is unaffected. Refusal is **fail-closed by design**: a quota read that throws is
also a refusal, never a bypass.

### DO
1. Confirm the scope. If every tenant is affected, this is Incident 1 or the
   global switch, not the quota.
2. Read the current cap:

   ```powershell
   curl.exe -s -b cookies.txt http://localhost:5000/api/ai/config
   ```

3. **Option A — raise the cap** (the normal answer):

   ```powershell
   curl.exe -X PUT -b cookies.txt -H "Content-Type: application/json" `
     -d '{\"monthlyQuotaTokens\":2000000}' `
     http://localhost:5000/api/ai/config
   ```

   The config cache is invalidated on write, so this takes effect instantly.
   **No restart.**

4. **Option B — emergency grant** when the budget genuinely cannot move:
   set `monthlyQuotaTokens` to `0`, which means **unlimited**. This is the
   documented escape hatch for "a zero nobody meant must not lock a tenant
   out". Record who authorised it and set a real cap back when the month turns.

5. **Option C — narrow the categories** to cut spend without a new budget:

   ```powershell
   curl.exe -X PUT -b cookies.txt http://localhost:5000/api/ai/config
   ```

   with `allowedCategories` trimmed. `capabilities` alone answers the "how do
   I…" questions and costs one cheap call.

### DO NOT
- **Do not** empty `allowedCategories`. Validation refuses it — an operator who
  wants "nothing" disables the tenant instead, which is one switch rather than
  four.
- **Do not** raise the global `AI_MONTHLY_QUOTA_TOKENS` to fix one tenant. That
  raises it for everybody.
- **Do not** leave a `0` (unlimited) in place past the month. It is an
  emergency lever, not a setting.

### VERIFY
Ask that tenant's employee a question and get an answer. `GET /api/ai/config`
shows the new cap and usage below it.

### ESCALATE
If the same tenant exhausts the quota two months running, the problem is
usage shape, not the cap — take it to the tenant's admin and narrow categories
rather than raising the number again.

---

## Incident 4 — Redis Cache Down & Mongo Fallback Performance

### DETECT
- `AI_CONFIG_READ_FAILED` (503) for some or all tenants.
- Redis connection errors in the server log.
- Elevated latency on the first AI call after a Redis restart.

### IMPACT
The tenant AI config cannot be read from cache. **This must fail closed** — 503
`AI_CONFIG_READ_FAILED` — because guessing the allowlist would hand the model
data the tenant never allowed. The fallback is a Mongo read, which is slower
but correct.

### DO
1. Confirm Redis is the problem, not the AI suite: check the Redis connection
   and the other features that share it.
2. **Let it fail closed.** A slow correct answer beats a fast wrong one, and a
   503 here is honest.
3. Restore Redis. On recovery the config cache repopulates on the next read
   per tenant.
4. If Redis will be down for a while, consider switching AI off globally
   (`AI_ENABLED=false`) rather than letting every employee see 503s — but
   understand that is an availability choice, not a correctness one.

### DO NOT
- **Do not** add a silent persist-to-Mongo fallback for AI state. The standing
   law forbids it: Redis down must fail closed (503 / `FEATURE_UNAVAILABLE`),
   never fail open.
- **Do not** flush the cache to "clear" it. No `FLUSHALL`, no `FLUSHDB`, no
   `KEYS`, no wildcard `crewly:*` delete. Invalidation is a `DEL` of the exact
   key, which `updateTenantConfig` already does.
- **Do not** treat a cache write failure as an error. It is best-effort by
   design; the entry simply is not cached and the next read hits Mongo.

### VERIFY
AI calls succeed again and the first call after recovery is not an outlier.
`GET /api/ai/config` returns promptly.

### ESCALATE
If Mongo is also degraded, this is a database incident and the AI suite is the
least of it — hand it to the database owner.

---

## Incident 5 — PII Redaction Audit & Pattern Verification

### DETECT
- Scheduled audit, or a report that a phone number, Aadhaar, PAN or email
  appeared in an assistant answer.
- A change to `piiRedactor.js` (any change here needs an audit).
- A new identifier class appearing in the product.

### IMPACT
A redaction gap means an identifier left the server inside a vendor payload.
That is a privacy incident regardless of what the model did with it.

### DO
1. Run the redaction pins:

   ```powershell
   cd Backend
   node --test test/phase36Closeout.test.js
   ```

   Row 4 asserts the guarantee for Aadhaar, PAN, UAN, mobile, email, bank
   account, IFSC and salary-labelled amounts, plus idempotence.

2. Read the assembled context to see exactly what the assistant sees:

   ```powershell
   curl.exe -s -b cookies.txt http://localhost:5000/api/ai/context/preview
   ```

3. Grep for a known-bad value across the log. The log is metadata-only by
   design, so a hit means something is logging text it should not:

   ```powershell
   findstr /S /I "9876543210" Backend\logs\*.log
   ```

4. If a gap is found, fix the pattern in `piiRedactor.js` and add a row-4 case
   **in the same change**. A pattern without a pin is a pattern that will rot.

### DO NOT
- **Do not** split the Aadhaar and UAN rows. They are one row **on purpose**:
  both are 12-digit numbers, no regex can tell them apart, and guessing means a
  wrong guess leaks. The placeholder names the more common one and the guarantee
  (the number does not leave the server) holds for both.
- **Do not** relax the salary rule. A salary-labelled number is masked by
  design; that is why the payslip context carries months and not figures.
- **Do not** add an opt-out. There is no per-request redaction bypass.
- **Do not** trust field selection alone. Free text (a holiday name, an
  announcement title, a leave reason) is typed by a human, which is why the
  assembled string goes through `redactPII()` as the last step.

### VERIFY
Row 4 is green, the preview shows `[AADHAAR_REDACTED]` style placeholders, and
no raw identifier appears anywhere in the logs.

### ESCALATE
Any confirmed leak of a real identifier is a privacy incident: stop, preserve
the logs, and escalate to whoever owns compliance. Do not "just patch it" and
move on.

---

## Incident 6 — Rate Limiter Abuse & IP/User Throttling

### DETECT
- One user sees `429 AI_RATE_LIMITED` while colleagues do not.
- `ai.rate_limited` log entries clustering on one `(companyId, userId)`.
- A tenant's token spend rising far faster than headcount would explain.

### IMPACT
That user is throttled to **20 turns per 60 seconds** on the chatbot endpoint.
Everyone else is unaffected. The limiter key is
`crewly:<env>:rl:ai-chatbot:<companyId>:<userId>`.

### DO
1. Confirm the scope. If **every** user in a tenant is limited, it is the
   vendor's own limit (Incident 1), not this limiter.
2. Check whether it is a script. A real person does not send 20 questions a
   minute; a misconfigured client or a scraper does.
3. Let it clear itself — the window is 60 seconds and the store resets on its
   own. There is no admin action for a normal burst.
4. If the pattern persists, find the caller. The key names the tenant and the
   user, and the log records the same pair.

### DO NOT
- **Do not** add a second limiter "for safety". The rate limit is enforced in
  **exactly one place** (the controller). Enforcing it twice double-counts: two
  stores with two windows means a tenant can be throttled by a counter nobody
  resets, or not throttled at all. Row 12 of the close-out suite fails if a
  second enforcement point appears.
- **Do not** raise `AI_CHATBOT_RATE_LIMIT.maximum` to silence one abuser. That
  raises it for every employee in the platform.
- **Do not** key the limiter on IP alone. Behind a corporate NAT every employee
  in a building shares one address, and you would throttle the whole company.

### VERIFY
The user's next request after the window succeeds, and `ai.rate_limited`
entries stop for that key.

### ESCALATE
If a single `userId` keeps hitting the ceiling with no human behind it, that is
an account-security question, not an AI one — hand it to whoever owns accounts.

---

## Incident 7 — A Language Is Missing From The Assistant Dropdown

**Phase 36.7.** The one new failure mode this unit adds. It is almost never a
bug.

### DETECT

An employee says the assistant's language dropdown does not offer the language
they want, or an admin says a language they enabled is not appearing.

### IMPACT

**Cosmetic and total.** The person gets answers in one of the languages that
IS offered. Nothing is unreadable, nothing is unauthorized, and no data is at
risk. A language decides how an answer is phrased, never what a caller may
read.

### DO

**1. Confirm the tenant's list, not the platform's.**

The platform catalogue is 14 languages. The tenant offers whatever its admin
enabled, defaulting to five. A language being absent is the normal case for a
tenant that never enabled it — there is nothing to fix.

Ask the `COMPANY_ADMIN` to open `/app/settings/ai-settings` and read the
"enabled" counter on the Reply languages card.

**2. If the admin enabled it and it still does not appear:**

Have them hard-reload (`Ctrl+Shift+R`). The widget loads the tenant's list
once, when it first mounts, and a tab opened before the save still holds the
old list.

**3. If it appears in the admin's list but not in the employee's dropdown:**

The employee's tab is stale, as above. Nothing else can cause this: the
selector reads the same tenant-scoped value the admin page saves, and there is
no per-user or per-role language list.

**4. If the admin CANNOT enable it** — the checkbox is missing entirely —
the language is not on the platform catalogue. That is a code change and a
redeploy, by design. Free-text language entry was refused because a typo would
become a language the model cannot actually produce.

**5. If saving answers 400:**

Read the message. `languages must always include English` means the list lost
English, which the model refuses to persist. `languages may only contain: ...`
means a code that is not on the catalogue reached the payload.

### DO NOT

* **Do not add the language to the platform catalogue to unblock one
  tenant.** It is a shared, curated list; a language added for one company is
  offered to all of them.
* **Do not let an admin switch English off** to make room for something else.
  English is the one language the prompt needs no rule for and the platform's
  fallback for a preference-less request. The model refuses to persist such a
  list, so attempting it produces a 400 and nothing else.
* **Do not treat a missing language as a permissions problem.** The language
  list is not scoped by role. `GET /ai/languages` deliberately has no RBAC so
  that every employee's selector can render.
* **Do not clear Redis to fix this.** The tenant config cache holds the same
  list the widget reads, and a stale entry expires on its own.

### VERIFY

Ask the employee to hard-reload and open the widget. The dropdown lists
exactly the languages the admin enabled, in catalogue order, with English
first. Pick one, ask a question, and confirm the reply is in that language's
script.

### ESCALATE

Only if the admin's saved list and the employee's dropdown disagree after a
hard-reload. That would mean the tenant list is being read from the wrong
company, which is a multi-tenancy defect and the most serious thing this
feature could do wrong. Capture the `companyId` from the admin's session, the
codes the admin sees, and the codes the employee sees, and treat it as a
security incident, not a UI bug.

---

## Appendix — the codes an on-call engineer will actually see

| Code | Status | What it means | Runbook |
| --- | --- | --- | --- |
| `AI_UNAVAILABLE` | 503 | Global `AI_ENABLED=false`, or the tenant is switched off | Incident 1 |
| `AI_CONFIG_READ_FAILED` | 503 | The tenant config could not be read. Fails closed. | Incident 4 |
| `AI_VENDOR_ERROR` | 503 | The provider did not answer. One generic sentence. | Incident 1 |
| `AI_CONFIG_INVALID` | 500 | The AI block is misconfigured | Incident 2 |
| `AI_REQUEST_INVALID` | 400 | A malformed request, or a client-supplied identity | — |
| `AI_RATE_LIMITED` | 429 | 20 chatbot turns per 60 s per (tenant, user) | Incident 6 |
| `QUOTA_EXCEEDED` | 429 | The monthly token cap is reached | Incident 3 |

**Never** trust a vendor message, and never put one in front of an employee.
Every failure above is already one generic sentence by construction.
