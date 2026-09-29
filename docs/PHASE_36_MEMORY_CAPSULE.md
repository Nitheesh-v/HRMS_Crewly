# CREWLY — PHASE 36 MEMORY CAPSULE

> Read this before touching anything in `Backend/src/services/ai/`,
> `src/models/AI*.js`, `src/validators/ai/` or the `AIAssistant` frontend.
>
> It records what Phase 36 is, the laws it will not break, and the mistakes
> that were paid for. A capsule that lists only successes is a trap for whoever
> picks this up next.

---

## 1. What Phase 36 is

An **HR conversational assistant** inside a multi-tenant SaaS HR platform. An
employee asks *"what is my leave balance"* and gets an answer built only from
data they are already authorized to see.

Four units, in dependency order:

| Unit | What it added |
| --- | --- |
| **36.1** | `aiProvider` (the single vendor choke point), `piiRedactor`, `aiUsageTracker`, `AIUsageLog`, quota, global + per-tenant kill switch, rate limit, opaque vendor errors, `POST /api/ai/chat` |
| **36.2** | `hrContextRetriever` (read-only, redacted, authorized), `AITenantConfig` + tenant service + cache, `allowedCategories` allowlist, config & preview endpoints |
| **36.3** | `hrChatbotService`, `POST /api/ai/chatbot`, the employee chat surface |
| **36.3b** | The surface became a **floating widget** — the `/app/ai-assistant` route and the sidebar entry were removed |
| **36.4** | Nine more own-record context categories, a static capability catalogue, role-aware aggregate counts, prompt rules 10-14, retry/copy UX |

**It is strictly the HR Chatbot Suite.** Not recruitment AI, not payroll
pipeline AI, not analytics AI. Those need their own phase numbers and their own
laws.

### What it is deliberately NOT

- **Not RAG.** No embeddings, no vector store. The retriever *is* the retrieval.
- **Not agentic.** No tool calling, no streaming, no multi-step plans. One turn
  is one request and the reply arrives whole.
- **Not authoritative.** AI output is text shown to a human. It never approves,
  applies, punches, pays or decides anything.

---

## 2. The invariant laws

These are not preferences. Every one is pinned by a test.

### 2.1 PII redaction is mandatory

`redactPII()` runs on the **assembled context** as the last step before the
boundary, and again on every **user turn**. There is no per-request opt-out.

Stripped: Aadhaar, PAN, UAN, Indian mobile, email, bank account, IFSC, and
**salary-labelled amounts**.

> **Aadhaar and UAN share one row on purpose.** Both are 12-digit numbers and
> no regex can tell them apart. Pretending otherwise means guessing, and a wrong
> guess leaks. The placeholder names the more common one; the guarantee — the
> number does not leave the server — holds for both. **Do not split this row.**

### 2.2 Privacy by absence

`AIUsageLog` has **no** prompt, response, reply, text, message, content, body,
input, output or PII field. Not "encrypted" — **absent**. It records counts and
metadata: `promptTokens`, `completionTokens`, `totalTokens`, `latencyMs`,
`status`, `errorType`, `provider`, `model`, `feature`, `companyId`, `userId`.

There is also **no server-side chat persistence** and **no `localStorage` of
chat content**. The conversation is React state for the life of the tab.

### 2.3 Scoping is `req.companyId` and `req.user._id`, always

The tenant authority is `req.companyId` and nothing else. **Never** a
client-supplied id — the validator refuses `companyId`, `company`, `userId`,
`user` and `feature` from a request body outright.

`getUserHRContext({ companyId, userId, ... })` has **no alternate-identity
parameter of any kind**. The signature *is* the authorisation. Every query
carries `companyId` **and** the field that owns the row.

### 2.4 Informational only

**AI output is text shown to a human. It is never authoritative.** The assistant
reads; it never writes. `hrContextRetriever` uses `find`, `findOne`, `findById`,
`aggregate` and `countDocuments` — no `save`, `update`, `delete` or counter.
Nothing in User, Leave, Attendance, ShiftAssignment, Holiday, Announcement,
Payslip, Expense, Task, Project or Document is ever written by it.

Every human decision stays human: ATS scores never auto-reject, BGV
discrepancies go to a person, GET never finalizes, payroll never moves money.
An AI outage is never a payroll, attendance or leave outage.

### 2.5 The authorization ceiling

The assistant sees **what the caller is already authorized to see**:

| Role | Sees |
| --- | --- |
| Employee | Own records only |
| Manager / Team lead | Own records + team **counts** |
| HR / Admin | Own records + company **counts** |

Counts, never rows. An aggregate never carries an id, a name, a designation or
a salary figure. An employee cannot read another employee's salary, leave or
attendance through a chat box.

### 2.6 Fail closed, always

A quota read that throws is a **refusal**, never a bypass. A tenant-config read
that throws is `503 AI_CONFIG_READ_FAILED`. Redis down fails closed
(`503` / `FEATURE_UNAVAILABLE`) — **never** fail open, and **never** a silent
persist-to-Mongo fallback for transient AI conversation state.

### 2.7 Opaque vendor errors

Every vendor failure becomes one generic `503 AI_VENDOR_ERROR` with one
sentence. The browser never sees a vendor status, a vendor message, a host or a
key. Logs carry metadata only: `{ feature, errorType, status, latencyMs }`.

### 2.8 Two kinds of "nothing" — never let them look alike

The single most useful thing in this capsule.

```
NONE         "none assigned to you" / "NO_RECORD - none recorded" /
             "none - you have no pending leave requests"
             -> the read SUCCEEDED and the answer IS that nothing exists.
                State it plainly. It is an answer.

UNAVAILABLE  "(attendance unavailable)"
             -> the read FAILED. Say it could not be retrieved, suggest HR.
```

Conflating them is what made the assistant answer *"I do not have that
information"* to a question it could answer. Prompt rules 8 and 9 encode the
distinction; the `UNAVAILABLE(label)` helper's parenthesised form is
deliberately visually distinct from a "none" line.

### 2.9 The money rule

The redactor masks a **salary-labelled** number by design:

```
"net pay 45000"  ->  "net pay [AMOUNT_REDACTED]"
"gross 60000"    ->  "gross [AMOUNT_REDACTED]"
"deductions 15000" -> "deductions 15000"      (no label — survives)
"amount 1200"    ->  "amount 1200"            (no label — survives)
```

So the payslip context carries **which months exist and their status**, and
never a figure — otherwise the context would read `net pay [AMOUNT_REDACTED]`
and the assistant would report the employee's own net pay as redacted. The
payslip query is narrowed to `month status snapshot.payroll.month
snapshot.payroll.monthLabel` so the salary sub-document is never even selected.

Expense amounts **are** rendered: a bare business number is not salary.

---

## 3. Entity & service map

```
POST /api/ai/chat          -> aiController.chat          -> aiChat()          (36.1)
POST /api/ai/chatbot       -> aiController.chatbot       -> askHRAssistant()  (36.3)
GET  /api/ai/config        -> aiController.getConfig     -> getTenantConfig() (36.2)
PUT  /api/ai/config        -> aiController.updateConfig  -> updateTenantConfig()
GET  /api/ai/context/preview -> aiController.previewContext -> getUserHRContext()
```

| Module | Responsibility | The one thing to know |
| --- | --- | --- |
| `aiProvider.js` | The **single** vendor choke point. Exports `aiChat` and `embed`. | Every guard runs here and nowhere else. `embed()` returns `UNSUPPORTED` — Groq has no first-party embeddings endpoint. |
| `aiConfig.js` | Strict env parsers, `AI_CONTEXT_CATEGORIES`, `AI_CHATBOT_CLIENT_ROLES`, limits. | `AI_CONTEXT_CATEGORIES` is the **single source of truth** for the allowlist: the `AITenantConfig` enum, the validator and the retriever all read it. |
| `aiErrors.js` | `AIError`, `AI_ERROR_CODES`, `sendAIError`. | `sendAIError` is the **one place** a code-bearing reply is produced — the shared `errorHandler` drops `err.code`. |
| `piiRedactor.js` | The pattern table and `redactPII()`. | One row per identifier class, applied in array order. Idempotent. Aadhaar+UAN share a row. |
| `aiUsageTracker.js` | Usage rows and the monthly quota check. | Metadata only. No text. |
| `aiTenantConfigService.js` | Tenant config + cache, `getTenantConfig`, `updateTenantConfig`. | Invalidation is a `DEL` of the exact key. Never a wildcard. |
| `AITenantConfig.js` | One row per tenant: `enabled`, `monthlyQuotaTokens`, `allowedCategories`. | `allowedCategories` defaults to the **full** list; `0` quota means unlimited. |
| `AIUsageLog.js` | The usage ledger. | Privacy by absence — no text fields exist. |
| `hrContextRetriever.js` | Assembles the caller's authorized, redacted HR context. | Read-only. Signature is the authorisation. One `redactPII()` call, at the end. |
| `hrChatbotService.js` | One conversational turn. | Caps history FIRST, then fetches context, redacts user turns only, **one** vendor call. Logs and persists nothing. |
| `aiValidator.js` | Express-validator chains. | Structural only. Refuses client-supplied identity and the `system` role. |

### The 13 context categories

`profile`, `payslips`, `expenses`, `tasks`, `projects`, `documents`,
`leave-requests`, `leaves`, `attendance`, `attendance-month`, `policies`,
`org-aggregates`, `capabilities`

`performance` is **deliberately absent** — reading an appraisal runs its own
access chain and a config flag must never switch it on.

`capabilities` is static and needs no database read, which is why that category
cannot fail.

### The 14 system-prompt rules

1. Answer concisely, plain language.
2. If the answer is in the context, give it directly.
3. If not, do **not** guess — and a bare refusal is not enough (see rule 14).
4. **NEVER invent** leave balances, policies, holidays or employee data.
5. Never reveal or repeat identifiers; `[REDACTED]` is intentional.
6. Never offer to act on the employee's behalf.
7. Be polite and empathetic.
8. **"NONE" is an answer.** State it plainly.
9. **"UNAVAILABLE" is not an answer.** The read failed; say so.
10. "How do I…" questions come from the capability catalogue.
11. **Name your source.**
12. **Never state a salary figure.**
13. **You only know this employee.** A count is not a person.
14. **When you cannot answer, still be useful** — say what is missing, give the
    closest thing you do have, then say what to do next. Rule 4 still wins over
    rule 14.

All fourteen are pinned verbatim by `test/hrChatbotService.test.js`. If you
change a rule, change the pin in the same commit.

---

## 4. Pitfalls & dead ends — paid for, do not re-buy

### 4.1 Double-counting the rate limit

The AI rate limit is enforced in **exactly one place: the controller**. Adding a
second enforcement point inside `aiChat` or in middleware means two stores with
two windows — a tenant can be throttled by a counter nobody resets, or not
throttled at all. `test/phase36Closeout.test.js` row 12 walks `src/` and fails
if `AI_CHATBOT_RATE_LIMIT` is referenced anywhere except the controller.

Also: `createRateLimitStore({ sharedName, windowMs, io })` already exposes
`keyPrefix` (`crewly:<env>:rl:<sharedName>:`). There is **no** `keyBuilder`,
`windowSeconds` or `max` — do not build a limiter shape that expects them.

### 4.2 Mongoose `upsert` + `setDefaultsOnInsert`

`loadFromMongo` uses `findOneAndUpdate` with `{ $setOnInsert: { companyId } }`,
`{ upsert: true, new: true, setDefaultsOnInsert: true }`. Consequences that
cost time:

- A tenant with no config row gets one **created on first read**, with defaults.
- `setDefaultsOnInsert` is what makes `enabled: true` and the full
  `allowedCategories` list appear on that first read.
- A test fake model **must** implement `findOneAndUpdate`. One that only has
  `find`/`findOne` throws `AI_CONFIG_READ_FAILED`, which looks exactly like a
  real config outage.

### 4.3 The response interceptor already unwraps

`const { data } = await api.post(...)` is wrong — the interceptor returns the
payload directly. Use `const result = await api.post(...)`. This bites in every
new service call.

### 4.4 A fake model is not a document

`record.shift` on an **array** is `Array.prototype.shift` — a truthy **function**.
Returning an array from `findOne` therefore sends `resolveCurrentShift` down the
`record?.shift` branch and into a `findById` call the fake never defined,
producing a `(attendance unavailable)` that looks like a real retriever bug.

Resolve by **operation**: `findOne`/`findById` → a document or `null`, `find` →
an array, `aggregate` → an array, `countDocuments` → a number. And give **each
query its own chain object** — the builders run under `Promise.all`, so
`Attendance` is read as `findOne`, `aggregate` and `aggregate` in the same tick,
and a shared chain resolves the month rollup with the day query's shape.

See `makeModelByOp` in `test/hrContextOwnRecords.test.js`.

### 4.5 A source pin can match its own doc comment

Hit more than once. A pin asserting `source.includes('badge')` passes against
the comment that explains why there is no badge. **Strip `/* */` and `//`
comments before grepping a pin.** The same trap applies to `Object.keys(` (real
JavaScript) when pinning a Redis `KEYS` ban.

### 4.6 A quick prompt can promise what the context cannot supply

36.3 shipped a *"Leave policy"* pill. There is **no** leave-policy model,
handbook or manual anywhere in this repo — `policies` is upcoming holidays plus
recent announcement titles and nothing else. Every click produced a refusal.
A prompt guaranteed to fail is worse than no prompt. `test/aiChatPills.test.js`
enforces this, and 36.4 added a pin forbidding any pill that asks for a salary
figure.

### 4.7 The Groq model timeline

`llama-3.3-70b-versatile` and `llama-3.1-8b-instant` were decommissioned on the
free/developer tier on **2026-08-16**. The shipped default is
`openai/gpt-oss-120b`, pinned by test. A 404 with a correct, current model
string and a correct key almost always means the dev server is serving a stale
`.env`.

Groq is OpenAI-compatible at `api.groq.com/openai/v1` for chat completions, but
has **no documented first-party `/embeddings` endpoint** — which is why `embed()`
ships `UNSUPPORTED`.

### 4.8 nodemon never watched `.env`

An `.env` change silently did nothing until the server was restarted by hand,
which made a correct config look broken. Fixed in `Backend/package.json`:

```json
"nodemonConfig": {
  "watch": ["src", ".env"],
  "ext": "js,json,env",
  "ignore": ["test/*", "docs/*"]
}
```

### 4.9 The store import cycle

`aiChatSlice -> aiService -> api.js -> store.js -> aiChatSlice`. It resolves
only when the store loads first. A test importing the slice before the store
hits `Cannot access 'aiChatReducer' before initialization` — a test artifact,
not an app bug. Frontend tests run through `Frontend/test/loaders/`.

### 4.10 The 36.3 black page

`Frontend/src/redux/store.js` shipped **without the `aiChat` reducer**.
`state.aiChat` was `undefined`, the destructuring threw on first render, and the
whole screen went blank. **Always verify a Redux registration with
`grep -n <sliceName> store.js` before declaring a page wired.** Pinned by
`Frontend/test/aiChatStore.test.js`.

### 4.11 A stated negative is an answer

See §2.8. This is the one that produced a visible user-facing bug, and the fix
was in the **prompt**, not the retriever — the data had been there all along.

### 4.12 Design paths rejected — do not retry

- Throwing `AIError` through the shared `errorHandler` relying on `err.code`
  (it drops it).
- Enforcing the AI rate limit in both middleware and `aiChat`.
- Failing open on a quota-read error.
- Treating Aadhaar and UAN as distinguishable patterns.
- `RBAC('ai:admin')` — no such permission string exists.
- `Announcement.visibility` / `publishedAt` — not in this repo.
- The `crewly:${env}:ai:config:${companyId}` namespace.
- `User.workEmail` — the field is `email`.
- `AI_INVALID_INPUT` — the code is `AI_REQUEST_INVALID`.
- `components/layout/Sidebar.jsx`.
- A quick prompt that promises a leave-policy document, handbook or manual.
- Restoring the `/app/ai-assistant` route or its sidebar entry after 36.3b.
- A notification-count badge on the assistant button.
- **Making the assistant read data the caller is not authorized to see.**

---

## 5. How to verify you have not broken anything

```powershell
cd Backend
npm run test:ai-foundation      # 36.1
npm run test:ai-tenant-config   # 36.2 config
npm run test:ai-context         # 36.2 retriever
npm run test:ai-chatbot         # 36.3 service
npm run test:ai-own-records     # 36.4 own-record categories
node --test test/phase36Closeout.test.js   # the 14 structural guarantees
npm run test:all                # the whole platform
```

```powershell
cd Frontend
npm test          # widget, pills, store, retry, copy
npm run build
npx eslint src    # 127 problems at baseline — anything above that is yours
```

### Seeing exactly what the assistant sees

```powershell
curl.exe -s -b cookies.txt http://localhost:5000/api/ai/context/preview
```

Prints the whole redacted context, section by section. This is the fastest way
to answer *"why did it refuse?"* — and if a section reads `(x unavailable)`,
the read failed, whereas `none` means the answer genuinely is nothing.

---

## 6. Reading a vendor failure

Every vendor failure logs `ai.vendor.error { feature, errorType, status,
latencyMs }` — metadata only. The browser always shows one generic 503.

| `errorType` | Meaning |
| --- | --- |
| `auth` | bad or rotated `AI_API_KEY` |
| `rate_limit` | the vendor's own limit |
| `timeout` | network slow |
| `network` | no internet / DNS / firewall |
| `vendor` | dead model string, or payload too large |

Runbooks for each are in [PHASE_36_RUNBOOKS.md](PHASE_36_RUNBOOKS.md).
