# CREWLY — PHASE 36.3: HR CHATBOT UI & CONVERSATIONAL API

**Status: IMPLEMENTED.** One employee-facing turn per request, built on 36.1's
guardrails and 36.2's context retriever.

| | |
| --- | --- |
| Unit | 36.3 |
| Parent doc | [PHASE_36_HR_CHATBOT.md](PHASE_36_HR_CHATBOT.md) |
| Depends on | 36.1 (provider + guardrails), 36.2 (context retriever + tenant config) |
| Tests | `npm run test:ai-chatbot` — **46 tests, 8 suites, 0 fail** |
| Full suite | `npm run test:all` — **2897 tests, 132 suites, 0 fail** (was 2851/124) |
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
| `pages/AIAssistant/AiAssistantPage.jsx` | the page |
| `pages/AIAssistant/ChatMessageBubble.jsx` | one bubble + the typing indicator |
| `pages/AIAssistant/QuickPromptPills.jsx` | six starting questions |
| `pages/AIAssistant/ChatInputBar.jsx` | controlled textarea, Enter to send |
| `pages/AIAssistant/chatLimits.js` | mirrors the server's 2000-char limit |

Registered in `redux/store.js` as `aiChat`, routed in `routes/AppRoutes.jsx`,
and reachable from the sidebar for **all five tenant roles** via
`layout/AppLayout.jsx` (the nav is `NAV_BY_ROLE` — five separate per-role arrays,
not one) with a `Bot` icon from `NAV_ICON_BY_PATH` in `layout/SidebarNav.jsx`.
**No permission gate** and no new permission string.

**Privacy in the client:** the conversation is React state for the life of the
tab. Nothing is persisted server-side and **nothing is written to
`localStorage`**. `usage` reports tokens only — never text.

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

**Not verified:** anything against the real Groq API — there is no key and no
network in the build sandbox.
