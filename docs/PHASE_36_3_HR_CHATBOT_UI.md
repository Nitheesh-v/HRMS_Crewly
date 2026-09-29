# CREWLY — PHASE 36.3: HR CHATBOT UI & CONVERSATIONAL API

**Status: IMPLEMENTED.** One employee-facing turn per request, built on 36.1's
guardrails and 36.2's context retriever.

| | |
| --- | --- |
| Unit | 36.3 |
| Parent doc | [PHASE_36_HR_CHATBOT.md](PHASE_36_HR_CHATBOT.md) |
| Depends on | 36.1 (provider + guardrails), 36.2 (context retriever + tenant config) |
| Tests | `npm run test:ai-chatbot` — **48 tests, 8 suites, 0 fail** |
| Full suite | `npm run test:all` — **2901 tests, 133 suites, 0 fail** (was 2851/124) |
| Frontend tests | `npm test` (in `Frontend/`) — **27 tests, 3 suites, 0 fail** |
| Superseded by | 36.4 — see §10.6 below for the current totals |
| Mutation check | **11 mutations, 11 caught** |

---

## 1. What this unit delivers

An employee opens `/app/ai-assistant`, asks a question in plain English, and
gets one answer assembled from their own authorized HR data.

```
POST /api/ai/chatbot
   protect  ->  tenantContext  ->  validator  ->  aiController.askChatbot
                                            |
   hrChatbotService.askHRAssistant  <-------+----  rate limit enforced INSIDE the controller
        |
        +-- getUserHRContext()        36.2 — the caller's own authorized, redacted context
        +-- buildSystemPrompt()       server-owned, never from the client
        +-- redactHistory()           user turns re-redacted, assistant turns untouched
        +-- aiChat({ feature:'chatbot' })   36.1 — every guard runs here, once
        |
        v
   { reply, usage, categoriesUsed }
```

**Three response-shape decisions that cost a defect each if got wrong:**

1. `getUserHRContext` returns an **object** `{ context, categoriesUsed,
   sections }` — not a string. The service destructures it.
2. The axios response interceptor in `Frontend/src/services/api.js` **already
   unwraps `body.data`**, so `const { data } = await api.post(...)` yields
   `undefined`. `aiService.js` uses the `bare()` helper from `chatService.js`.
3. The rate limit is a **separate 32.4 store** (`ai-chatbot`, 20 per 60 s) and is
   charged **inside the controller and nowhere else** — a second check in the
   service would count one turn twice (the 36.1 lesson).

---

## 2. The system prompt (verbatim, pinned by test)

Nine rules. Rules 8 and 9 were added by §10.5 and are the reason a **stated
negative is answered rather than refused** — read that section before editing
this prompt.

The prompt is **server-owned**. A client that could write it could instruct the
model to ignore the HR context or to invent data, so the validator refuses the
`system` role outright by simply not listing it.

```
You are the Crewly HR Assistant, a helpful and professional AI assistant embedded in the Crewly HR platform.

Your job is to answer the employee's HR questions using ONLY the information provided in the Employee HR Context below.

Rules you must follow:
1. Answer concisely and clearly. Use plain language.
2. If the answer is in the context, give it directly.
3. If the answer is NOT in the context, say "I do not have that information. Please contact your HR team." Do NOT guess.
4. NEVER invent leave balances, policies, holidays, or employee data.
5. NEVER reveal or repeat sensitive personal identifiers (Aadhaar, PAN, mobile numbers, bank accounts). If you see [REDACTED] placeholders, treat them as intentionally hidden.
6. NEVER offer to take actions on behalf of the employee (you cannot apply for leave, punch attendance, or update records).
7. Be polite and empathetic. This is a workplace assistant.

=== EMPLOYEE HR CONTEXT ===
{retrievedContext}
=== END CONTEXT ===
```

The seven rules are asserted **as text** in `test/hrChatbotService.test.js`, not
merely as behaviour, so a prompt that drifted silently would fail the suite.

> **Superseded (36.4 / close-out).** The count is no longer seven. `5757006`
> added rules 8 and 9, 36.4 added 10-13, and the close-out unit added 14, so
> the prompt now carries **fourteen** rules and the test loops `1..14`. The
> block above is kept as the 36.3-as-shipped record; the current text is in
> `Backend/src/services/ai/hrChatbotService.js`. See
> [PHASE_36_MEMORY_CAPSULE.md](PHASE_36_MEMORY_CAPSULE.md) §3.

---

## 3. One call per turn — and why there is no agent loop

`hrChatbotService.js` makes exactly **one** `aiChat` call. There is no retry, no
follow-up call, no tool dispatch, no `while` loop and no `for` loop — the last
two are pinned as source assertions because a reviewer should be able to see the
absence rather than infer it.

This keeps the cost bounded, the audit trail one `AIUsageLog` row per turn, and
the failure modes countable. Roles stay `['system', 'user', 'assistant']`
forever; `tool` and `function` are never added.

---

## 4. The token budget, and the honest limit it forces

The system prompt carries the whole HR context — several hundred tokens before
the employee types anything. Sending ten more turns on top of that would spend
the budget on history the model rarely needs.

**The history is capped to the LAST 6 turns** (`AI_CHATBOT_HISTORY_LIMIT`),
deliberately tighter than the UI's 20-message display cap. The person can scroll
back further than the model can remember, and that is the honest trade: a
chatbot that silently forgot turn 3 is worse than one that never claimed to
remember it. This is recorded here rather than papered over.

Order matters: `slice(-6)` keeps the **newest** turns in chronological order.
Reversing or head-slicing would read as nonsense to the model — both are pinned
by tests.

---

## 5. PII: two independent layers

1. The **context is already redacted** by 36.2's retriever.
2. Every **user** turn is redacted **again here**, because a person can type
   their Aadhaar number into a chat box no matter what the UI says.

Verified in tests against the **real** redactor: a PAN, a mobile number, an
email and an Aadhaar typed by the user are all masked in the payload, and the
raw value is absent from the JSON the vendor receives.

**Assistant turns are NOT re-redacted.** They are model output derived from
already-redacted input, and re-redacting them would corrupt a legitimate answer
that happens to quote a masked placeholder. A test pins an assistant reply
containing `[EMAIL_REDACTED]` byte-for-byte.

The returned array is **new** — the caller's history is React state, and
mutating it would corrupt the conversation the person is still reading. Pinned.

---

## 6. Errors propagate — never a fake reply

A vendor `AI_UNAVAILABLE`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `AI_VENDOR_ERROR`
or `AI_CONFIG_INVALID` is **rethrown unchanged**. Swallowing one and returning a
plausible-looking reply would be the single worst thing this module could do:
the employee would act on an answer the vendor never gave.

A tenant-config read failure from the retriever **also propagates**, and the
vendor is **never called** in that case — answering an HR question with no
context at all would invite the model to guess, which is exactly what rule 4
forbids. Both are pinned.

**Partial context is different and is welcome**: 36.2 ships partial results by
design, so a missing announcement list must not stop the employee learning their
leave balance.

---

## 7. The API contract

`POST /api/ai/chatbot` — `protect` → `tenantContext` → `chatbotValidator`.

**Request** (nothing else is accepted):

| Field | Rule |
| --- | --- |
| `messages` | array of 1–20 entries, `{ role, content }` |
| `messages.*.role` | `user` or `assistant`. **`system` is refused.** |
| `messages.*.content` | 1–2000 characters |
| `categories` | optional array from the 36.2 allowlist |

**Refused outright in body:** `companyId`, `company`, `userId`, `user`,
`feature` — with a message naming the field. Tenant authority is `req.companyId`
only; the caller is `req.user._id`. There is no client-supplied tenant id to
send, which is the point.

**Response** — `ApiResponse`-shaped:

```json
{
  "statusCode": 200,
  "success": true,
  "data": {
    "reply": "You have 12 earned leave days remaining.",
    "usage": { "promptTokens": 120, "completionTokens": 18, "totalTokens": 138 },
    "categoriesUsed": ["profile", "leaves"]
  },
  "message": "Chatbot reply generated"
}
```

The response carries **no** context, no prompt and no HR row. `categoriesUsed`
is surfaced in the UI so the person can see which of their categories actually
answered.

---

## 8. The frontend

| File | Role |
| --- | --- |
| `services/aiService.js` | one method, `askHRAssistant({ messages, categories })` |
| `redux/slices/aiChatSlice.js` | session-only state + `sendChatMessage` thunk |
| `components/AIAssistant/AiAssistantWidget.jsx` | the floating button + modal shell |
| `components/AIAssistant/AiAssistantPanel.jsx` | the chat body |
| `components/AIAssistant/ChatMessageBubble.jsx` | one bubble + the typing indicator |
| `components/AIAssistant/QuickPromptPills.jsx` + `chatPrompts.js` | six starting questions, every one answerable (see §10.3) |
| `components/AIAssistant/ChatInputBar.jsx` | controlled textarea, Enter to send |
| `components/AIAssistant/chatLimits.js` | mirrors the server's 2000-char limit |

Registered in `redux/store.js` as `aiChat`. **No permission gate** and no new
permission string — the API itself is the authority.

**The assistant is a floating widget, not a page.** It is mounted once in
`layout/AppLayout.jsx`, so it is reachable from every screen in the tenant app
without leaving the one you are on. The `/app/ai-assistant` route and the
sidebar entry that 36.3 first shipped have been removed: the floating button is
the single entry point, and a dead route would let someone bookmark a screen the
product no longer advertises.

The conversation lives in the `aiChat` slice, so it is **shared across
screens** — opening the panel on one page and then on another shows the same
conversation, and closing the panel does not clear it.

**The assistant gets its OWN sidebar group.** 36.3 first put the entry inside
the existing "Me" group, which made it read as a profile sub-page. It now has
its own `NAV_GROUPS` entry in `layout/SidebarNav.jsx` (`id: "ai"`, `Bot` icon,
placed just before "Me"). A group with exactly one non-soon item renders as a
**direct icon button** when the sidebar is collapsed, which is what "a separate
icon" means in this codebase.

**Privacy in the client:** the conversation is React state for the life of the
tab. Nothing is persisted server-side and **nothing is written to
`localStorage`**. `usage` reports tokens only — never text.

### 8.1 The blank-page bug, and why it happened

`/app/ai-assistant` rendered a **completely black page** — no sidebar, no
error, nothing.

**Cause:** 36.3 shipped the `aiChatSlice` **without registering it** in
`Frontend/src/redux/store.js`. `state.aiChat` was therefore `undefined`, and
`AiAssistantPage`'s destructuring of it threw during the very first render. A
React crash with no error boundary is a blank screen, which is why it looked
like a routing problem rather than a store problem.

**Fix (two parts, deliberately):**

1. Register the reducer: `aiChat: aiChatReducer` in `store.js`.
2. Give the page safe defaults so a future slice slip degrades to an **empty
   chat** instead of a blank screen.

**Test:** `Frontend/test/aiChatStore.test.js` asserts against the **real**
store that `state.aiChat` exists and that all four slices are present. This is
the regression pin — it fails loudly on the exact omission that shipped.

Note for anyone extending this: the slice imports the service, the service
imports `api.js`, and `api.js` imports the store — a real cycle. It resolves
cleanly **when the store is loaded first**, which is the app's entry order. A
test that imports the slice before the store will hit a TDZ error that has
nothing to do with the app.

Because plain Node has no `import.meta.env`, the frontend tests run through a
small test-only loader (`Frontend/test/loaders/`) registered by the `test`
script. It rewrites `import.meta.env` for the duration of a run and never
touches the dev server or the production build.

**Degraded states are honest:** a failed turn renders **outside** the message
list, so an error can never be mistaken for the assistant's answer, and each
server code maps to a human-readable next step (`AI_RATE_LIMITED` → wait,
`QUOTA_EXCEEDED` → ask the admin, `AI_UNAVAILABLE` → the tenant switched it
off).

---

## 9. What did not change

The `aiChat` guard ladder, every shipped 36.1 error code, `AIUsageLog`,
`hrContextRetriever`, `aiTenantConfigService`, every HR model, `.env.example`
(**no new keys**) and the Phase 33 chat hub are all untouched. The one additive
change to 36.1 code is `'chatbot'` joining the closed `AI_FEATURES` list so a
usage row can say which surface spent the tokens.

---

## 10. Verification (localhost)

```powershell
cd Backend
npm run test:ai-chatbot
npm run test:all
npm run config:check
```

```powershell
cd Frontend
npm run build
```

Login, open the sidebar **AI Assistant** entry, and try:

```
What is my current leave balance?
What is my attendance status for today?
Which holidays are coming up next?
my PAN is ABCDE1234F, is it on file?
```

Expected: an answer drawn only from your own data; `Answered using:` in the
header naming the categories; the PAN rendered as `[PAN_REDACTED]` in the
reply; a 20-turn-per-minute ceiling returning a red **wait a few seconds** banner.

### 10.1 The vendor retired the model — and how it looked

The first localhost run failed on **every** turn with a generic
`503 AI_VENDOR_ERROR` ("The AI provider did not answer"). The key was valid, the
network was fine and the code was correct.

**Cause:** `llama-3.3-70b-versatile` — the shipped default — was
**decommissioned by Groq on the free/developer tier on 2026-08-16**
([deprecations](https://console.groq.com/docs/deprecations)). Groq answers a
dead model with a 404 "the model does not exist or you do not have access to
it", and the opaque-vendor-error law correctly collapses that into one generic
503. So the product behaved *as designed* while being completely broken — the
only place the real cause appeared was the backend log line
`ai.vendor.error { errorType: 'vendor', status: 404 }`.

**Fix:** the default is now `openai/gpt-oss-120b`, Groq's own recommended
replacement, and it is **pinned by a test** (`test/aiProviderFoundation.test.js`
asserts `AI_DEFAULT_MODEL`). A vendor retiring a model is not a one-off, so a
dead default is treated as product rot rather than an environment problem.

**How to diagnose this class of failure yourself:** read the backend terminal,
not the browser. Every vendor failure logs
`ai.vendor.error { feature, errorType, status, latencyMs }` — metadata only, by
the privacy law. `errorType` is one of `auth` (401/403 → bad key),
`rate_limit` (429 → the vendor's own limit), `timeout`, `network` (no
internet/DNS) or `vendor` (anything else, including a dead model).

### 10.2 The trap that made a correct config look broken

After the model default was fixed, the chatbot **still** failed with the same
generic 503 — while `npm run config:check` reported the new, correct model.

**Cause:** `nodemon` watches `.js` and `.json` by default and **not `.env`**.
Editing `Backend/.env` therefore never restarted the dev server. The running
process kept sending the old, decommissioned model; `config:check` is a
**separate process** that read the file fresh and showed the new one. The two
disagreed, and the browser could only ever show the generic 503 — so a
perfectly correct `.env` looked exactly like a vendor fault.

**Fix:** `Backend/package.json` now carries an explicit `nodemonConfig` that
watches `.env`:

```json
"nodemonConfig": {
  "watch": ["src", ".env"],
  "ext": "js,json,env",
  "ignore": ["test/*", "docs/*"]
}
```

With this, saving `.env` restarts the server and the running process agrees
with `config:check`. Pinned by a test that fails if the config is dropped.

**The rule to remember:** if you edit `Backend/.env` and the behaviour does not
change, the server did not restart. `Ctrl+C` and `npm run dev` — or trust the
`nodemonConfig` above to do it for you. A `config:check` that disagrees with the
running app is telling you the app is stale, not that the config is wrong.

### 10.3 "I do not have that information" is the assistant working correctly

Once the vendor call succeeded, asking **"Explain the leave policy to me"**
returned *"I do not have that information. Please contact your HR team."* That is
**not** a bug — it is rules 3 and 4 of the system prompt doing their job.

**There is no leave-policy document source in this repository.** The model list
has `AttendancePolicy`, `BgvSlaPolicy` and `CompanySecurityPolicy`, and no
leave-policy model of any kind. 36.2's `policies` category therefore carries
**upcoming holidays and recent announcement titles, and nothing else** — its
name is broader than its contents.

**What was a real defect:** `QuickPromptPills` shipped a **"Leave policy"** pill.
A quick prompt that is guaranteed to be refused is worse than no quick prompt at
all, because it teaches the employee that the assistant is broken.

**Fix:** the pill is now **"Latest announcements"**, which the context genuinely
holds. The prompt data moved to `pages/AIAssistant/chatPrompts.js` (a `.js`
module, so a test can import it without a JSX transform), and
`Frontend/test/aiChatPills.test.js` enforces the rule:

- no prompt may promise a policy document, handbook or manual;
- every prompt must map to one of the four categories the retriever fills;
- the set must cover at least three of them.

**The rule to remember:** before adding a quick prompt, check that its answer can
be assembled from `profile`, `leaves`, `attendance` or `policies`
(= holidays + announcements). If it cannot, the assistant will refuse —
correctly.

### 10.4 The floating-widget restructure

36.3 shipped the assistant as a **page** at `/app/ai-assistant` with a sidebar
entry under "Me". The owner asked for the pattern comparable HR tools use
instead: a **floating robot button** in the corner that opens the assistant as a
panel, reachable from any screen.

| Before | After |
| --- | --- |
| Sidebar entry, nested in "Me" | Floating `Bot` button, bottom-right, fixed |
| Full page at `/app/ai-assistant` | Modal panel, ~420px, bottom-right |
| Route in `AppRoutes.jsx` | No route — mounted in `AppLayout.jsx` |
| `pages/AIAssistant/` | `components/AIAssistant/` |

**Two decisions worth recording:**

1. **No notification badge.** The reference product shows a count badge on its
   button. Nothing in this feature generates a count, so a badge would be a lie
   told in the corner of every screen. Pinned by a test so it is not added for
   looks.
2. **The button hides while the panel is open.** Two affordances for one action
   is noise; the panel carries its own close control, plus Escape and a backdrop
   click. The Escape listener is attached **only while the panel is open**, so it
   can never swallow an Escape meant for something else on the page.

**Not built, and why:** the reference panel has three tabs — *Live Insights*,
*Past History* and *Work Report*. Those are a different feature, not a
restyling of this one:

* *Past History* needs server-side persistence, which 36.3 forbids by design
  (session-only, no `localStorage`). Building it would reverse a standing law.
* *Live Insights* and *Work Report* are rule-based analytics over the tenant's
  whole workforce, not the caller's own authorized data — a different
  authorisation surface, and a separate unit with its own laws.

The chatbot answers all three questions conversationally today, from the
employee's own context.

### 10.5 "What are my shift timings?" answered "I do not have that information"

The owner reported that asking for their own shift timings returned the refusal
sentence, even though `attendance` was listed in `Answered using:`.

**The context was not empty.** It contained `- Shift: (no shift assigned)`. The
bug was that the context has **two different kinds of "nothing"** and the system
prompt only taught one of them:

| Phrasing | Meaning | Correct reply |
| --- | --- | --- |
| `none`, `NO_RECORD`, `no ... assigned` | the read succeeded and the answer **is** "nothing" | **state it plainly** |
| `(x unavailable)` | the read **failed** | say it could not be retrieved, suggest HR |

Rule 3 of the prompt said only *"if the answer is NOT in the context, say 'I do
not have that information'"* — so the model read a stated negative as missing
data and refused. A confirmed fact was being reported as ignorance.

**Fix, two parts:**

1. **The prompt gained rules 8 and 9**, which name the distinction explicitly
   and give the model a worked example of each.
2. **The retriever's phrasing was made unambiguous**, so the two classes are
   visually distinct at a glance: `none assigned to you` versus
   `(attendance unavailable)`. The `UNAVAILABLE` helper now carries a comment
   explaining why the two must never look alike.

**The rule to remember:** a negative fact is still an answer. If the context says
`none`, the employee gets *"You do not have a shift assigned to you yet"* — not
*"I do not have that information"*.

**To see exactly what the assistant sees**, ask for the preview (36.2):

```powershell
curl.exe -s -b cookies.txt http://localhost:5000/api/ai/context/preview
```

That prints the whole redacted context string, section by section. If a section
reads `(none posted)` or `(none scheduled)`, the tenant simply has no data
there — and the assistant is right to say so.

**Not verified:** anything against the real Groq API — there is no key and no
network in the build sandbox.

---

## 10.6 Superseded by 36.4 (recorded, not erased)

The counts in this document's header are the numbers **as 36.3 closed**. They
are no longer current, and 36.4 changed them:

| | 36.3 close | after 36.4 |
| --- | --- | --- |
| `npm run test:all` | 2901 / 133 / 0 fail | **2939 / 145 / 0 fail** |
| Frontend `npm test` | 27 / 3 / 0 fail | **31 / 5 / 0 fail** |
| Context categories | 4 | **13** |
| System-prompt rules | 9 | **13** |
| Quick prompts | 6 | **15** |

What 36.4 changed about this unit's surface:

- **Retry** on the error banner and **Copy** on the newest answer were added
  to `AiAssistantPanel.jsx` and `ChatMessageBubble.jsx`.
- **Quick prompts** went from 6 to 15, covering the new own-record categories
  and two capability questions. The rule did not change: a pill is only
  allowed if its answer can be assembled from a category the retriever fills.
- **The welcome text** now names the new categories.
- A new pin forbids a pill that asks for a salary figure, because 36.4's
  context deliberately carries no amounts.

Everything in §8.1 (the blank page), §10.1 — §10.5 still applies unchanged. The
full record is [PHASE_36_4](PHASE_36_4_ADVANCED_HR_ASSISTANT.md).
