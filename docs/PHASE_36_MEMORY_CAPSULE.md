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

Seven units, in dependency order:

| Unit | What it added |
| --- | --- |
| **36.1** | `aiProvider` (the single vendor choke point), `piiRedactor`, `aiUsageTracker`, `AIUsageLog`, quota, global + per-tenant kill switch, rate limit, opaque vendor errors, `POST /api/ai/chat` |
| **36.2** | `hrContextRetriever` (read-only, redacted, authorized), `AITenantConfig` + tenant service + cache, `allowedCategories` allowlist, config & preview endpoints |
| **36.3** | `hrChatbotService`, `POST /api/ai/chatbot`, the employee chat surface |
| **36.3b** | The surface became a **floating widget** — the `/app/ai-assistant` route and the sidebar entry were removed |
| **36.4** | Nine more own-record context categories, a static capability catalogue, role-aware aggregate counts, prompt rules 10-14, retry/copy UX |
| **36.5** | Voice (browser-native `SpeechRecognition` / `speechSynthesis`) and five reply languages. No new package. |
| **36.6** | Progressive reveal, follow-up chips, deep-link navigation chips, structured answer cards, named payslip fields, onboarding empty state, transcript export, typing-stops-speech, admin usage dashboard. No new package. |
| **36.7** | Admin-configurable reply languages. A 14-language platform catalogue, `AITenantConfig.languages`, a new AI Settings page, and a tenant-aware validator. No new package. |

**It is strictly the HR Chatbot Suite.** Not recruitment AI, not payroll
pipeline AI, not analytics AI. Those need their own phase numbers and their own
laws.

### What it is deliberately NOT

- **Not RAG.** No embeddings, no vector store. The retriever *is* the retrieval.
- **Not agentic.** No tool calling, no multi-step plans. One turn is one
  request and the reply arrives whole.
- **Not streamed.** 36.6 added a client-side *reveal* animation. There is
  still no SSE and no second HTTP connection — see
  [PHASE_36_6 §2](PHASE_36_6_ADVANCED_CHATBOT_UX.md).
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

### 36.5 traps, paid for in this unit

**A `/**` doc block with no closing ` */` is invisible to `node --check`.**
Three were written into `aiConfig.js` and the later `*/` terminated the
comment, silently swallowing three `export const` declarations. The module
loaded, the syntax checked, and `AI_LANGUAGE_LABELS` was simply `undefined`.
**Always count `/*` against `*/` after a patch that inserts a comment block,
and assert the exports exist at runtime before trusting `node --check`.**

**`str.replace(anchor, new, 1)` hits the FIRST match, which is not always the
one you meant.** The language chain landed in `aiChatValidator` instead of
`chatbotValidator` because both end with the same `  validate,\n];\n`. Split on
the enclosing `export const` marker instead.

**`{/* comment */}` is illegal inside a JSX opening tag.** It parses as a
spread attribute and the build fails with `Expected ... but found }`. Put
the comment above the element or drop it.

**`createSlice` action creators must be exported explicitly.** Adding
`languageSet:` to `reducers` is not enough — the destructure
`export const { ... } = slice.actions` has to name it, or the build fails
with `"languageSet" is not exported by ...`.

**`react-hooks/refs` and `react-hooks/set-state-in-effect` are enforced
here.** Writing a ref during render, and calling `setState` in an effect
body, both fail lint. The fixes are honest ones: move the ref write into an
effect, and let the speech module set the marker through its own `onStart`
hook instead of the caller.

---

## 5. How to verify you have not broken anything

```powershell
cd Backend
npm run test:ai-foundation      # 36.1
npm run test:ai-tenant-config   # 36.2 config
npm run test:ai-context         # 36.2 retriever
npm run test:ai-chatbot         # 36.3 service + 36.5 language (58 tests)
npm run test:ai-own-records     # 36.4 own-record categories
node --test test/phase36Closeout.test.js   # the 14 guarantees + 36.5 validator (49 tests)
npm run test:all                # the whole platform
```

```powershell
cd Frontend
npm test          # widget, pills, store, retry, copy, languages, voice wiring (61 tests)
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

## 5b. The 36.5 laws, in one place

1. **English carries no language rule at all.** `languageRule` is replaced
   with the empty string for `en`, so an English turn is byte-identical to a
   36.3 turn.
2. **The language rule is 16, and it is CONDITIONAL.** It is omitted for
   English. 36.6 put the follow-up rule at 15 because that one is
   unconditional, so the default English prompt reads a clean 1—15.
   If you ever add another unconditional rule it goes at 17 and
   `RULE_COUNT` moves with it.
3. **Language is a preference, never an authority.** It is NOT in
   `chatbotIdentityOverride`, and a test asserts that.
4. **Validator refuses, service normalizes.** A 400 at the edge, a silent
   fallback to `en` inside the service. Both, on purpose.
5. **`sentViaVoice` lives on a ref.** A state flag would speak the reply
   twice under strict mode.
6. **No audio is persisted anywhere.** Neither voice module may reference
   `MediaRecorder`, `Blob`, `FileReader`, `createObjectURL`, `FormData`,
   `indexedDB` or `localStorage`.
7. **No network call of ours.** Neither voice module may import `api.js` or
   call `fetch`.
8. **`language` lives in Redux only.** No `localStorage`, ever.
9. **No server-side language detection and no backend auto-translation.**
10. **The frontend voice features are NOT hermetically tested.**
    `aiVoice.test.js` pins wiring only. The owner verifies in Chrome.

---

## 5c. The 36.6 laws, in one place

1. **The assistant NAVIGATES. It never ACTS.** `AI_DEEP_LINKS` is hardcoded in
   `aiConfig.js` and keyed by the category the retriever filled. It is never
   taken from the model. No chip calls an API, dispatches or mutates.
2. **No chip path may contain `://`, `?` or `#`.** An absolute URL leaves the
   product; a query string can carry data. Pinned by test.
3. **`/app/attendance`, NOT `/app/attendance/my-attendance`.** The latter does
   not exist in `AppRoutes.jsx`. Every path in the map was verified before it
   was written down.
4. **A card may RE-RENDER information. It may never REMOVE or CHANGE it.**
   `parseReplyBlocks` requires a run of two or more lines that ALL match
   `- Label: value`, renders label and value verbatim, and collapses the whole
   run back to text if any line fails. A misparse degrades to 36.3, never
   worse.
5. **A bullet with no colon is never a card.** `- none assigned to you` is an
   ANSWER (rule 8), and a card row would strip the prose that makes it
   readable.
6. **The money rule did not move.** `renderPayslips` still carries month and
   status only. 36.6 only NAMED the three withheld fields. The query's
   `.select()` is still narrowed so `snapshot.salary.*` is never read from
   Mongo.
7. **`Total Deductions` is NOT a salary label in the redactor.** That is the
   decisive reason the prompt's payslip format was refused — that one
   figure would have survived into the vendor payload.
8. **No SSE.** The reveal is client-side. An SSE path would have to reopen
   `aiProvider.js`'s guard ladder, which 68 tests pin.
9. **`prefers-reduced-motion` disables the reveal.** Checked per render, not
   once at load.
10. **The transcript is never sent anywhere.** `buildTranscript` is a pure
    string function; `downloadTranscript` is the only function that touches a
    browser API, and it revokes its object URL.
11. **A message with no timestamp prints `[unknown time]`.** Never the export
    time. A transcript that lies about when a question was asked is worthless.
12. **`getUsage` reads NOTHING from the request.** No body, no query, no
    params. `now` is server-side and the company comes from the caller's token.
13. **`byStatus` is an OBJECT keyed by status, not an array.** Treating it as
    an array renders nothing and looks like an empty dashboard.
14. **`SETTINGS_MANAGE`, never `ai:admin`.** There is no `ai:admin` permission
    in this repo; inventing one needs a registry change and a migration.
15. **`QuickPromptPills.jsx` was DELETED** in 36.6. The grouped onboarding
    chips replaced it and nothing else imported it.

---

## 5d. Pitfalls paid for during 36.6

- **A source pin can match the module's own doc comment.** Three of them did.
  " + `"Nothing is written to localStorage"` + " is a sentence about NOT using
  the thing the pin bans. **Strip comments before grepping** — `aiChatUx.test.js`
  has a `readCode()` helper for exactly this, and `aiVoice.test.js` already had
  one.
- **A pin on the whole file is not a pin on the request.** The 36.5
  " + `"client sends no identity fields"` + " test searched all of
  `aiService.js`. 36.6 added `getAiUsage`, which *reads* a `userId` out of the
  *response*. Reading is not sending. Scope such a pin to the request block.
- **A slice-to-EOF pin breaks the moment something is appended.** Two pins
  sliced `routes/ai.js` from `/context/preview` to the end. Adding `GET /usage`
  after it failed both, for reasons that had nothing to do with the preview
  route. Bound them at the next `route(`.
- **`(.+)` vs `(.*)` in the follow-up marker.** With `(.+)` a bare
  `Follow-up:` never matched, so `sawMarker` never fired and the marker leaked
  into the answer. The flag was correct; the regex starved it.
- **`parseFollowUps` returns `cleanReply`. `askHRAssistant` returns `reply`.**
  The names are close enough that a find-and-replace broke four pre-existing
  tests and two new ones.
- **A recording fake that REPLACES the vendor result drops `usage`.** Pass the
  whole object, not just `content`.
- **A Python raw string turns `\n` into a literal backslash-n.** One comment
  swallowed the line after it and the module failed at runtime with
  " + `"match is not defined"` + ". `node --check` passed.
- **`{/* comment */}` is illegal inside a JSX opening tag.** It parses as a
  spread. Hit again in 36.6. Put the comment above the element.
- **`await import()` in a file that already uses it at top level.** Add the
  name to the EXISTING destructuring, or hold the module in a variable. A
  second `await import` between an import and its `.default` breaks the file.
- **The Unicode Extended_Pictographic property, not a hand-built emoji
  range.** A literal
  class containing U+FE0F is a combining character and
  `no-misleading-character-class` rejects it.
- **`npm run test:<one-suite>` prints a describe-level failure that a
  `# tests`/`# pass` grep will hide.** Always read `# fail` too. — this is how
  a broken `aiTenantConfig` suite looked green for one whole turn.

---

## 5e. The 36.7 laws, in one place

1. **The catalogue is the ceiling, the tenant list is the offer.**
   `AI_LANGUAGE_CATALOGUE` is 14 codes; `AI_TENANT_LANGUAGE_DEFAULT` is the
   36.5 five. The model's ENUM is the catalogue and its DEFAULT is the five
   — that is what makes an admin able to add a language at all.
   `AI_SUPPORTED_LANGUAGES` is an ALIAS of the default set, kept so 36.5
   imports still resolve. It is NOT the catalogue.
2. **No free-text language entry.** Ever. The owner decided this. A typo
   would become a language the model cannot produce and the admin would
   believe they had added it.
3. **English is mandatory per tenant**, enforced at the MODEL
   (`AITenantConfig`'s path validator), in the validator chain, AND in the
   settings page. Three layers because the model is the one that cannot be
   bypassed. English is the one language the prompt needs no rule for and the
   platform fallback for a preference-less request.
4. **A language is PRESENTATION.** It changes how an answer is phrased and in
   which script. It never changes what a caller may read — the server scopes
   that from `req.companyId` and `req.user._id` before this value is looked
   at. Language is not an identity field and `noIdentityOverride` still
   refuses it from a body.
5. **The validator checks the platform enum FIRST, the tenant list SECOND.**
   `isIn(AI_LANGUAGE_CODES).bail().custom(tenant list)`. Two different
   problems need two different messages: a typo is a typo, a disabled
   language says it is not enabled for your company.
6. **`getTenantLanguages` fails CLOSED to the default set and never throws.**
   A language list is cosmetic; refusing the whole assistant because a config
   read timed out is the wrong trade.
7. **`GET /ai/languages` has NO RBAC** — any authenticated user. The widget
   is open to every employee and its selector must list what the admin
   enabled. It returns presentation preferences only: no quota, no enabled
   flag, no usage. Reading the QUOTA still needs `SETTINGS_MANAGE`.
8. **Rule 16 is the language rule and it is CONDITIONAL** — omitted
   entirely for English, so an English turn stays byte-identical to a 36.3
   turn. Follow-up stays rule 15 and unconditional.
9. **The frontend keeps a copy of the catalogue, and a test imports the
   backend module and compares FIELD BY FIELD.** Codes, labels, native names,
   hints and BCP-47 tags. Never scrape the backend file as text.
10. **`chatLanguagesFor` keeps only codes that are actually on the
    platform.** Filtering by type is not filtering: an empty string is a
    string, and a list of `['']` reads as "one language enabled".
11. **Catalogue order, not arrival order.** `chatLanguagesFor` preserves the
    catalogue's sequence so the selector does not reshuffle between reloads
    because Mongo returned the array differently.

---

## 5f. Pitfalls paid for during 36.7

- **A source pin that greps raw source matches the file's own
  documentation.** `aiSettings.test.js`'s first version asserted the panel
  contains no `localStorage` and FAILED — the panel's header comment
  explains at length that the language is deliberately NOT stored there. The
  pin was right and the test was wrong. Every code pin now goes through a
  comment-stripping helper, the same one `aiVoice.test.js` has used since
  36.5.
- **A validator chain can THROW instead of calling `next(error)`.**
  `validate` throws an `ApiError` once `validationResult` has anything in it.
  A promise wrapper that only watches `next` never sees the refusal, and
  every assertion about a 400 silently passes for the wrong reason.
- **A fake model must expose the method the code actually calls.**
  `loadFromMongo` uses `findOneAndUpdate` (upsert + `setDefaultsOnInsert`),
  NOT `findOne`. A `findOne`-only fake returns null, the caller falls back to
  the default set, and the test looks like a product bug.
- **A source pin sliced to "the next export" can be EMPTY.**
  `chatbotValidator` is the LAST export in `aiValidator.js`;
  `updateConfigValidator` comes BEFORE it. Slicing to that name produced an
  empty string and the pin passed for the wrong reason.
- **`await import()` inside a `describe` callback is illegal.** Hoist every
  import to the top of the file. Hit again in 36.7.
- **A hand-copied Unicode string WILL be wrong.** The Telugu native name
  arrived as `ଲ` (Odia LA) instead of `ల` (Telugu LA) — visually
  near identical, wrong script, and only a field-by-field comparison against
  the backend caught it. Regenerate the frontend copy from the backend module.
- **A `builder` chain terminated by `;` cannot be extended.** Appending
  `.addCase(...)` after the semicolon is a `SyntaxError` at the leading dot.
- **`toSnapshot` and `UPDATABLE_FIELDS` must BOTH be updated** or the field
  silently does nothing: one drops it on read, the other answers
  `Unsupported AI config field(s)` on write.
- **`AI_DEFAULT_LANGUAGE` must be imported into the validator** before it is
  used in a `custom()`. Node reports it as
  `AI_DEFAULT_LANGUAGE is not defined` from inside the chain, which reads
  like a product bug and is not.
- **The frontend's circular import is real and order-dependent.**
  `aiChatSlice -> aiService -> api -> store -> aiChatSlice`. Import the STORE
  first in any test that touches the slice, or you get
  `Cannot access 'aiChatReducer' before initialization`. `aiChatStore.test.js`
  has the same ordering for the same reason.
- **A patch script that asserts against the wrong variable writes nothing
  and reports success.** One 36.7 script checked `assert ANCHOR in s` while
  holding the OTHER file's contents in `r`. It aborted, which is the correct
  outcome, but only because the anchor genuinely was not in `s`.

- **A sticky bar at the TOP of a page fights the app shell.** The shell is
  `sticky top-0 z-30`, so a second top bar has to be offset past a height that
  changes per breakpoint and slides underneath the shell whenever the guess is
  wrong. Put the save bar at the BOTTOM (`sticky bottom-4 z-20`) and the
  conflict disappears entirely.
- **`useBlocker` only works with a data router.** With `<BrowserRouter>` it
  silently does nothing, so a settings page that "guards navigation" guards
  nothing. Use `beforeunload` and state the in-app limitation in the source.
- **A test cannot pin a comment.** `code()` strips comments, so a pin on prose
  that lives in a comment is not a pin at all. Pin the CODE that implements
  the decision — for the router limit, assert the handler exists and that
  `useBlocker` is genuinely not imported.
- **A backslash before a backtick survives a Python heredoc.** `` \` `` is an
  unrecognised escape, so Python keeps both characters and a JS pin written
  that way never matches. Use `'\n'.join(...)` or a plain string.
- **Pinning the absence of a token catches the comment about it.**
  `fileUrl` appears once in `hrContextRetriever.js` — in a comment saying it
  is never selected. Pin the `.select(...)` call instead.
- **Renaming a state variable is not the same as adding one.** A patch that
  replaced `const [catalogue, setCatalogue]` with `const [categoryCodes,
  setCategoryCodes]` left three uses of `catalogue` dangling. `no-undef` caught
  it; a `node --check` on a `.jsx` file would not have.
- **`if (dirty)` is not `if (this field changed)`.** One save payload keyed its
  language write to the page-wide dirty flag, so toggling the kill switch
  re-sent the whole language list. Key every write to its own comparison.

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
