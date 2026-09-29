# Phase 36.1 — AI Provider Foundation & Guardrails

**Status:** 36.1 implemented, hermetic suite green, end-to-end runtime probe
verified locally — **awaiting localhost acceptance.**

Phase 36 is the **HR Chatbot Suite**. This unit is the plumbing only: a secure
connection to the AI vendor, PII redaction, usage tracking, hard quotas, a kill
switch and one verification endpoint. No RAG, no streaming, no per-tenant admin
UI — those are 36.2 and 36.3.

**Owner decisions this unit honours (from the Phase 36 overview + the two
follow-up questions):**

| Decision | Where it lives |
| --- | --- |
| AI Suite is **Phase 36**, not Phase 35 | the repo already had a Phase 35 (nine UI/import units); both tracks now coexist without ambiguity |
| `AI_PII_REDACTION=false` is **fail-closed** | `aiConfig.isRedactionEnforced` + `validateAIConfig` + a test pin |
| `openai` SDK is the only new package | `Backend/package.json` (`openai ^7.23.0`) |
| Groq today, OpenAI/Anthropic later via two env vars | `aiProvider.buildClient` reads `AI_BASE_URL` + `AI_API_KEY` |

---

## 1. What was actually wrong before

Nothing — this is greenfield. The honest statement is that CREWLY had **no AI
capability at all**, and adding one naively would have created four new attack
surfaces on day one: an unauthenticated cost amplifier (no quota), a PII pipe to
a third party (no redaction), an unbounded retry loop (no rate limit) and an
undeletable audit gap (usage stored as text). This unit exists so that none of
those ever exists.

## 2. The shape

```
POST /api/ai/chat
  │
  ├─ protect ──────────── verified JWT (or access cookie) → req.user
  ├─ tenantContext ────── verified user → req.companyId   (tenant authority)
  ├─ aiChatValidator ──── shape, roles, sizes, NO identity from the body
  │
  └─ aiController.chat ──► aiProvider.aiChat  ← THE ONE CHOKE POINT
                             1. AI_ENABLED (global kill switch)      → 503
                             2. AITenantConfig (per-tenant switch)   → 503
                             3. SDK client present                   → 500
                             4. 32.4 shared rate limit               → 429
                             5. monthly token quota                  → 429
                             6. redactPII on EVERY message           ← before the vendor
                             7. vendor call (bounded timeout)        → 503
                             8. recordUsage (fire-and-forget)
```

### Files

| File | Role |
| --- | --- |
| `Backend/src/services/ai/aiConfig.js` | Pure parsers + bounds + vocabularies + `validateAIConfig`. No imports from `src/config`, so no cycle. |
| `Backend/src/services/ai/piiRedactor.js` | `redactPII` / `redactMessages`. Pure, dependency-free, never throws. |
| `Backend/src/services/ai/aiErrors.js` | `AIError`, stable codes, `sendAIError`, `classifyVendorError`. |
| `Backend/src/models/AIUsageLog.js` | Token-only usage/audit row. **No text field exists.** |
| `Backend/src/services/ai/aiUsageTracker.js` | `recordUsage` (fire-and-forget), `checkQuota` (hard, calendar month). |
| `Backend/src/services/ai/aiProvider.js` | `initAIProvider`, `aiChat`, `embed`, provider state. |
| `Backend/src/controllers/aiController.js` | Thin controller; identity from the session only. |
| `Backend/src/validators/ai/aiValidator.js` | Message shape + identity-override refusal. |
| `Backend/src/routes/ai.js` | `POST /api/ai/chat` behind `protect` + `tenantContext`. |
| `Backend/test/aiProviderFoundation.test.js` | 66 hermetic pins. |
| `docs/PHASE_36_HR_CHATBOT.md` | The phase hub. |

Modified: `src/config/env.js` (AI config + production validation),
`scripts/config-check.js` (AI section), `src/routes/index.js` (mount `/ai`),
`src/server.js` (`initAIProvider()` fail-fast), `Backend/.env.example`,
`Backend/package.json` (`test:ai-foundation` + `test:all`).

## 3. The laws, and exactly how each is enforced

### 3.1 AI is informational, never authoritative

There is no code path from `aiChat` to a write. It takes messages and returns a
string plus token counts. It has no model handle, no service account and no
query ability (Phase 36 §5.5). Pinned: the vendor payload contains no
`companyId`/`userId`, and the route reads identity only from `req`.

### 3.2 PII redaction is mandatory

`redactPII` is a pure function over a fixed pattern table. It removes:

| Class | Shape matched | Placeholder |
| --- | --- | --- |
| Aadhaar **and** UAN | 12 digits, bare or 4-4-4 grouped | `[AADHAAR_REDACTED]` |
| PAN | `ABCDE1234F` | `[PAN_REDACTED]` |
| Indian mobile | optional `+91`/`0`, then `[6-9]` + 9 digits | `[MOBILE_REDACTED]` |
| Email | standard | `[EMAIL_REDACTED]` |
| Bank account | **label-anchored** (`a/c`, `account number is`, …) | `[BANK_ACCOUNT_REDACTED]` |
| IFSC | 4 letters + `0` + 6 alphanumerics | `[IFSC_REDACTED]` |
| Salary / currency amounts | `₹1,20,000`, `Rs 45,000`, `INR 85000`, `salary 45000`, `60000/-` | `[AMOUNT_REDACTED]` |

**Aadhaar and UAN share one row on purpose.** Both are 12-digit numbers and no
regex can tell them apart. Guessing would mean a wrong guess leaks; the
placeholder names the more common one and the guarantee — the number does not
leave the server — holds for both.

**Order is a law.** EMAIL first (a digit run inside a local part must not be
eaten by the identifier rules), then the labelled rules (IFSC / bank account),
then the bare identifier rules, then amounts. Reordering changes what is
removed.

**The override is fail-closed.** `AI_PII_REDACTION=false` is honoured only when
`NODE_ENV` is `development` or `test`. In production:
* `validateAIConfig` refuses startup (exit 1, key named, no value);
* `isRedactionEnforced` still returns `true`, so a process that somehow boots
  with the flag off **redacts anyway**;
* there is no API surface for it — env only, and `AITenantConfig` can never
  re-enable redaction-off.

### 3.3 No prompt or response is ever stored

`AIUsageLog` declares exactly: `companyId`, `userId`, `feature`, `provider`,
`model`, `promptTokens`, `completionTokens`, `totalTokens`, `latencyMs`,
`status`, `errorType`, plus timestamps. A test walks `schema.paths` and asserts
none of `prompt`/`response`/`message`/`content`/`text`/`body`/`question`/
`answer`/`completion`/`input`/`output` exists — not "is unused", **does not
exist**. `errorType` is an enum, so a vendor sentence cannot be stored by
accident either.

The same test pins **schema/writer agreement**: every field `recordUsage`
writes is declared by the schema. Phase 35.5 shipped a real defect where a
service wrote `status`/`message`/`at` into a schema declaring
`outcome`/`reason`/`occurredAt`, and Mongoose strict mode silently dropped all
three — the evidence vanished with no error.

### 3.4 Multi-tenancy

`companyId` comes from `req.companyId`, which `tenantContext` derives from the
verified token + Mongo user. The validator **refuses** `companyId`, `userId` and
`feature` in the body outright. The limiter key and the usage row both use the
server-derived pair. Company A's quota is computed from Company A's rows only
(pinned).

### 3.5 The AI has no implicit data access

It receives text and returns text. When a later unit needs employee data, the
**backend** fetches it under the user's own authorization, redacts it, and passes
the redacted text. That is a 36.3+ concern; this unit only guarantees the shape
exists.

### 3.6 Quota and rate limits are hard

* **Quota** — `checkQuota` sums `totalTokens` for the tenant over the current
  UTC calendar month. Over the allowance → `429 QUOTA_EXCEEDED`, request
  refused, one usage row with `status: QUOTA_EXCEEDED`, `totalTokens: 0`.
  `AI_MONTHLY_QUOTA_TOKENS=0` means unlimited (documented).
* **Fail closed** — if the quota read fails, the call is **refused**
  (`503 AI_UNAVAILABLE`). A silent allowance is the exact overage the quota
  exists to prevent. Verified at runtime: with no Mongo the happy path returns
  503, not an answer.
* **Rate limit** — `createRateLimitStore({ sharedName: 'ai' })`, i.e. the 32.4
  store, key `crewly:<env>:rl:ai:<companyId>:<userId>`, 20 per 60 s. Redis down
  → the store's bounded per-process bucket, same refusal contract, never
  unlimited. One enforcement point (inside `aiChat`), so a request can never be
  double-counted by a route middleware plus a service check.

### 3.7 Kill switch, global and per-tenant

* Global: `AI_ENABLED` (default **false**). Off → `503 AI_UNAVAILABLE`, and the
  shipped default means an operator who never configures AI gets a clean
  disabled feature, not a crash.
* Per-tenant: `aiChat` takes an injectable `isTenantEnabled` resolver whose
  default is `true`. **36.2 replaces that default with the `AITenantConfig`
  read.** The seam exists now so 36.2 does not have to reopen this unit. A
  resolver that throws also refuses — never allows.

### 3.8 Vendor errors are opaque

`classifyVendorError` maps any thrown vendor error into one of
`timeout | auth | network | rate_limit | vendor`. The client always gets
`503 AI_VENDOR_ERROR` with the sentence *"The AI service could not complete your
request. Please try again shortly."* The vendor's own words are classified,
logged metadata-only (`ai.vendor.error` carries `feature`, `errorType`, status,
latency), and never returned. Verified at runtime: a throwing vendor produced
exactly that response and that log line.

### 3.9 No streaming

Synchronous request/response only. SSE (32.11) is untouched and unused here.

### 3.10 No tool calling, no agents

`AI_MESSAGE_ROLES` is `['system', 'user', 'assistant']`. `tool` and `function`
are deliberately absent, so a client cannot ask for a capability that does not
exist.

### 3.11 Audit every call

`recordUsage` appends one row per invocation — success, vendor error, rate-limit
refusal and quota refusal all write a row. It is **fire-and-forget**: a failed
audit write must not turn a good answer into an error, and `drainAIUsageWrites()`
exists so tests and shutdown can await the pending set.

### 3.12 Honest degraded states

| Condition | Behaviour |
| --- | --- |
| `AI_ENABLED=false` (default) | `503 AI_UNAVAILABLE` on `/api/ai/chat`; rest of the product unaffected |
| `AI_ENABLED=true`, no `AI_API_KEY` | **startup refuses** (exit 1, key named) |
| Per-tenant disabled | `503 AI_UNAVAILABLE` |
| Vendor down / timeout / 401 / 429 | `503 AI_VENDOR_ERROR` (one generic sentence) |
| Quota exceeded | `429 QUOTA_EXCEEDED` |
| Rate limited | `429 RATE_LIMITED` |
| Redis down | bounded per-process limiter bucket; quota read bypasses cache |
| Mongo down | the whole API is already down; the quota read fails **closed** |
| Embeddings requested | `501 AI_EMBEDDINGS_UNSUPPORTED`, immediately |

## 4. `embed()` — deliberately a loud refusal

Groq exposes an OpenAI-compatible **chat completions** API; it publishes no
first-party `/embeddings` endpoint. `embed()` therefore throws
`501 AI_EMBEDDINGS_UNSUPPORTED` immediately rather than making a call that fails
halfway. 501 (not 503) so a future caller cannot mistake it for a transient
outage and build a retry loop on it.

**Consequence for 36.3 (RAG):** embeddings need a provider that serves
`/embeddings`. That decision is 36.3's, and it is paired with the vector-store
decision. This unit deliberately does not pretend the capability exists.

## 5. Defects found and fixed during this unit

Four were caught by my own probe/suite before they shipped, and all four are now
pinned:

1. **`+919876543210` was redacted as `+[AADHAAR_REDACTED]`.** The 12-digit rule
   ran before the mobile rule and ate the country code, leaving a dangling `+`
   and the wrong placeholder. Fixed by excluding `+` from the Aadhaar
   lookbehind.
2. **`Rs 45,000` (with a space) was not matched at all.** Only `inr` tolerated a
   space after the currency mark. Fixed — every currency alternative now does.
3. **The bank-account rule kept the wrong capture group**, producing
   `my 00112233445566[BANK_ACCOUNT_REDACTED]` (digits kept, label dropped).
   Fixed with an explicit `keep: [1]` group list.
4. **`isRedactionEnforced` returned the override's permission, not whether
   redaction runs** — i.e. it answered `false` in production, the opposite of
   the law. Fixed to `!isRedactionOverridePermitted(...)`.

Two more were caught by the full suite and are worth recording because they
would have shipped as an invisible runtime failure:

5. **`aiValidator.js` had two wrong relative import paths**
   (`../../../utils/ApiError.js`, `../../../services/ai/aiConfig.js`). Every
   source-string pin passed — the file reads correctly — and the failure only
   appeared as an async `ERR_MODULE_NOT_FOUND` inside two *other* suites that
   import the route tree. Fixed, and a new pin imports the real validator, route
   and controller modules so this class of bug can never ship silently again.
6. **`sendAIError` passed an arbitrary `statusCode` through** for an unknown
   code, which would let a vendor's 502 reach the browser. Now forced to 503.

Also noted: the sandbox's gitignored `Backend/.env` disappeared mid-session
(known quirk, §K.3) and made 14 suites exit on their import-time `MONGO_URI`
guard. Unrelated to this unit; recreating the file restored 2693 → 2759.

## 6. Tests

`Backend/test/aiProviderFoundation.test.js` — **66 tests / 8 suites / 0 fail**,
hermetic (in-memory fakes, no Mongo, no Redis, no network).

Coverage: all eight PII classes + clean text + idempotence + non-string
degradation + role coverage · strict parsers and every redaction-override
branch · provider init (disabled / no key / with key / state never carries the
key) · `embed()` 501 · the full `aiChat` guard ladder in order, including
fail-closed quota, per-tenant refusal, config-refusal and vendor-error opacity ·
the schema privacy law and schema/writer agreement · quota semantics (window,
cross-tenant isolation, hard refusal, unlimited) · the coded reply shape and the
pitfall that forces it · the HTTP surface.

**Bite check (mutations applied, then reverted):**

| Mutation | Result |
| --- | --- |
| `aiChat` stops redacting before the vendor call | 1 pin fails |
| quota read fails open | 1 pin fails |
| redaction override honoured in production | 1 pin fails |
| mobile pattern removed | 2 pins fail |

**Runtime probe** (ad-hoc, not committed — real Express, real controller, real
validator, real provider, stubbed auth, fake vendor client):

```
1. AI disabled (default)        → 503 {"code":"AI_UNAVAILABLE", ...}
2. 11 messages                  → 400 "messages must be an array of 1 to 10 entries."
3. client-supplied companyId    → 400 "companyId must not be supplied by the client"
4. role: "tool"                 → 400 "role must be one of: system, user, assistant."
5. blank content                → 400 "content must be 1 to 2000 characters."
6. happy path with PII          → 200 {"content":"Your balance is 12 days.",
                                       "usage":{"promptTokens":5,...}}
7. what the VENDOR received     → [{"role":"user","content":"My Aadhaar is
                                  [AADHAAR_REDACTED], what is my leave balance?"}]
8. tenant identity in payload?  → absent (correct)
```

Plus the real `protect` middleware refusing a tokenless request with 401, and
`config:check --production` exiting 1 for both AI misconfigurations while
exiting 0 for a clean AI-off deployment.

## 7. Limitations (honest)

* **No embeddings.** 36.3 must choose an embeddings provider; this unit refuses
  loudly instead of faking it.
* **No per-tenant config model yet.** The kill switch and quota are env-wide;
  the `isTenantEnabled` / `resolveQuota` seams are in place for 36.2.
* **No frontend.** This unit ships no UI; `/api/ai/chat` is a verification
  endpoint. The employee-facing chat is 36.3.
* **Token counts come from the vendor's `usage` block.** If a provider omits it,
  the row records zeros rather than an estimate.
* **The redactor matches identifier SHAPES.** A salary written as "twelve lakhs
  a year", or a mobile written as `+91-98765-43210` in an unusual grouping, is
  not guaranteed to be caught. It is a floor, not a ceiling.
* **Known false positive:** a 10-digit business number starting 6–9 (an order
  id, say) is redacted as a mobile. Over-redaction is the deliberate direction.
* **The quota window is a UTC calendar month**, not a rolling 30 days.
* **`AI_MONTHLY_QUOTA_TOKENS=0` means unlimited.** A tenant with no configured
  allowance is not locked out.
* **One limiter, one place.** `aiChat` owns the rate limit; the route adds no
  middleware for it, so a request is never counted twice.
* **`maxRetries: 0`** on the SDK. No automatic retry; a retry would double the
  token spend on a call the person has already given up on.
* **The default quota is 1,000,000 tokens/month for every tenant.** On a paid
  vendor that is a real cost; 36.2 gives the super-admin the dial.

## 8. Localhost verification (PowerShell)

**Restart the backend** — the running process has none of this code:

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev
```

**Expect:** the API boots normally and says nothing about AI. That is correct —
`AI_ENABLED` defaults to false, so this unit is inert until you configure it.

**1. Config truth (no keys needed):**

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run config:check
```

You should see an `AI_ENABLED false` line, `AI_API_KEY missing`,
`AI_PII_REDACTION enforced (redaction always runs before the vendor)`, and
`✓ Configuration valid`.

**2. The kill switch, live.** With the backend running, from a third terminal:

```powershell
curl.exe -X POST http://localhost:5000/api/ai/chat -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

Expected: `503` with `"code":"AI_UNAVAILABLE"`. (Without a session cookie you
will get `401` first — that is `protect` doing its job; either answer proves the
route exists and is guarded.)

**3. Turn it on.** Add to `Backend\.env`:

```
AI_ENABLED=true
AI_API_KEY=<your Groq key>
```

Restart `npm run dev`. The API must boot. If you comment the key back out and
leave `AI_ENABLED=true`, the API must **refuse to start** with a message naming
`AI_API_KEY` and no value.

**4. The redaction override is refused in production:**

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
$env:JWT_SECRET = ("x" * 40); $env:MONGO_URI = "mongodb://127.0.0.1:27017/crewly"
$env:AI_ENABLED = "true"; $env:AI_API_KEY = "synthetic"; $env:AI_PII_REDACTION = "false"
node scripts/config-check.js --production
```

Expected: exit code 1 and a line naming `AI_PII_REDACTION`. Then close that
terminal so the variables do not leak into the next command.

**5. The pins:**

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run test:ai-foundation
```

Expected: 66 tests, 0 fail. Then `npm run test:all` for the whole suite.

Sign-off line for the unit: **Phase 36.1 AI Provider Foundation — pit rules locked in 🏁**
