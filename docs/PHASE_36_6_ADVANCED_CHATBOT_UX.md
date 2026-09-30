# CREWLY — PHASE 36.6: ADVANCED CHATBOT INTELLIGENCE & UX PACK

> **STATUS: BUILT. Backend and frontend shipped, tests green.**
> `npm run test:all` → **3024 tests / 160 suites / 0 fail**
> (was 2999 / 156). Frontend `npm test` → **111 tests / 19 suites / 0 fail**
> (was 61 / 7). Frontend `npm run build` → clean.
>
> Not signed off until the owner has pressed through it on localhost — see
> [§11](#11-localhost-acceptance).

Additive to 36.1–36.5. Reopens nothing: the guard ladder, the context
markers, the history cap, the redactor and the money rule are all untouched.

---

## 1. The nine deliverables, and what each one actually became

| # | Deliverable | Shipped as |
|---|---|---|
| 1 | Streaming responses | **Progressive client-side reveal.** No SSE. See §3. |
| 2 | Follow-up suggestion chips | `parseFollowUps` + a static fallback table |
| 3 | Deep-link action chips | `AI_DEEP_LINKS`, **navigation only** |
| 4 | Structured answer cards | `parseReplyBlocks`, deliberately conservative |
| 5 | Own payslip Q&A | `payslips` was already a category; the *output* changed |
| 6 | Empty state & onboarding | Grouped chips + four capability badges |
| 7 | Transcript export | Client-side Blob, zero server calls |
| 8 | Voice UX polish | Typing stops the speech |
| 9 | Admin usage dashboard | `GET /ai/usage` + `AiUsagePage` |

---

## 2. Deliverable 1 — why there is no SSE

The brief offered SSE **or** "smooth progressive UI rendering". It got the
second, for four reasons that are worth writing down because the question
will come back.

1. **It would have reopened a closed guard ladder.** `aiProvider.js` runs
   feature → messages → identity → `config.enabled` → `isTenantEnabled` →
   limiter → `resolveQuota`/`checkQuotaFn` → vendor. That ladder is pinned by
   **68** tests in `aiProviderFoundation.test.js`. A streaming path is a
   second way in, and every one of those guarantees would have to be
   re-proved for it.
2. **It buys nothing here.** A turn costs ~556 tokens against a 1024 ceiling.
   The answer is two or three sentences. Streaming a reply that is already
   complete in one response is a cosmetic gain for a large risk.
3. **It needs a second half-open connection per turn** for a product whose
   longest answer is read in seconds.
4. **Zero new packages was a hard rule**, and the progressive reveal needs
   none.

What ships instead is `useProgressiveReveal.js`: the complete reply is
revealed character by character over roughly 1.4 seconds, with the step
scaled to the length so a two-line answer and a long one finish in about the
same time. **It respects `prefers-reduced-motion` and shows the whole reply
at once when that is set.**

The bubble renders ONE plain text block while the reveal runs, and only
switches to the card/chip layout when it finishes. A card built from a
half-typed bullet list would flicker in and out of existence.

---

## 3. Deliverable 2 — follow-up questions

The system prompt gained **rule 15**, always present:

> `15. IF IT HELPS, END WITH 2 SHORT FOLLOW-UP QUESTIONS the employee might
> ask next, in this exact format on its own line:
> Follow-up: [Question 1] | [Question 2]`

`parseFollowUps(reply, categoriesUsed)` then:

* strips the marker line and everything after it from the visible reply;
* splits on `|`, trims, and drops the prompt's own `[ ]` placeholders;
* caps the result at `AI_FOLLOW_UP_MAX` (**3**);
* **falls back to `AI_FOLLOW_UP_FALLBACKS`** — eight categories of static,
  answerable questions — when the model produced nothing usable.

### Why the rule numbers moved

36.5 shipped the language rule as **15** and it is *conditional*: it is
omitted for English, which is the default. 36.6's follow-up rule is
*unconditional*. With language=15 and follow-up=16, the default English
prompt read `1…14, 16` — a visible gap that no single `RULE_COUNT` could
satisfy in `phase36Closeout.test.js`.

So the numbers swapped: **follow-up is 15, language is 16.** The default
English prompt is now a clean `1–15`, and the gap check keeps its teeth. A
test that wants to see 16 must pass a language explicitly, which is what the
36.5 language tests do.

### The empty-marker bug

`Follow-up:` with nothing after it used to survive into the answer the
employee reads, because the parser's regex required `(.+)` after the colon
and the `sawMarker` flag therefore never fired. The regex is now `(.*)`, and
a test pins it.

---

## 4. Deliverable 3 — deep links, and the law they obey

**The assistant never performs an action. It points at a screen and the
person decides.**

`AI_DEEP_LINKS` is a hardcoded map in `aiConfig.js`, keyed by the category
the **retriever** actually filled. It is never taken from the model: a
model-chosen path is a model-chosen action, and no model output is allowed
to move this product.

```js
leaves      -> /app/leaves                Apply Leave / View Ledger
attendance  -> /app/attendance            View Attendance Records
payslips    -> /app/payroll/my-payslips   View Full Payslips
policies    -> /app/documents             View Company Documents
```

`AI_DEEP_LINK_ORDER` fixes the order, so two turns that used the same
categories always produce the same chips in the same order.

### The route that does not exist

The build prompt named `/app/attendance/my-attendance`. **That route is not
in `AppRoutes.jsx`.** The real one is `/app/attendance`. Shipping the
prompt's path would have produced a chip that 404s. Every other path was
verified against `AppRoutes.jsx` before it was written down, and a test pins
each one plus the rule that no path may contain `://`, `?` or `#`.

---

## 5. Deliverable 4 — structured cards, and why they are so timid

`parseReplyBlocks` re-renders a run of `- Label: value` bullets as a small
grid. The whole design is one rule:

> **A card may RE-RENDER information. It may never REMOVE or CHANGE it.**

The reply is model output answering an HR question. A parser that misreads a
line and drops half a leave balance leaves the employee worse off than with
the plain text 36.3 shipped. So:

* only a run of **two or more** consecutive key-value bullets is considered;
* **every** line in the run must match, or the whole run stays text;
* label and value are rendered **verbatim** — nothing is reworded, rounded or
  reordered;
* a bullet with no colon (`- none assigned to you`) is never a card.

That last one matters most. **A stated negative is an answer** (rule 8), and
turning it into a card row would strip the prose that makes it readable.

The net effect: a misparse degrades to exactly what 36.3 shipped, never to
something worse.

---

## 6. Deliverable 5 — own payslip Q&A, and the prompt that was refused

### The money rule, restated

A salary figure is **not** rendered into the context, even though the
employee is asking about their own payslip. The redactor would mask it on the
way out, so the assistant would reply *"your net pay is `[AMOUNT_REDACTED]`"*
— worse than saying nothing.

`renderPayslips` carries **month + status only**, plus an "open My Payslips"
line. The query's `.select()` is narrowed so `snapshot.salary.*` is **never
read from Mongo at all**. The redactor is untouched.

### What 36.6 asked for, and why it did not get it

The build prompt asked this section to carry **Gross Salary, Net Pay and
Total Deductions**, with a format example showing two of the three as
`[AMOUNT_REDACTED]`. That example is the tell — the author knew they would be
masked. Rendering them would have produced:

```
Gross Salary: [AMOUNT_REDACTED]
Net Pay: [AMOUNT_REDACTED]
Total Deductions: 8000
```

which is strictly **worse** than what ships. Two lines are noise, and the
third is a **real leak**: `Total Deductions` is **not** in the redactor's
salary-label list, so that figure would have survived into the vendor payload
— exactly the number the money rule exists to keep out.

Probed and confirmed:

```
"net pay 45000"          -> "net pay [AMOUNT_REDACTED]"     MASKED
"Gross Salary: 62000"    -> "Gross Salary: [AMOUNT_REDACTED]"  MASKED
"Total Deductions: 8000" -> "Total Deductions: 8000"        NOT MASKED
```

### What 36.6 did change

The withheld fields are now **named**:

> `- Gross salary, total deductions and net pay are not shown here by design.
> Open My Payslips to view them.`

Before, the line said "Earnings, deductions and net pay figures", which told
the employee that something *unspecified* was unavailable. Now the assistant
can say what a payslip contains and where to open it — a useful answer
instead of a gesture.

A test pins that all three names appear, that none of the three figures
appears even when a fake row carries them, and that an expense amount
**does** still render (the money rule is deliberate, not blanket).

---

## 7. Deliverable 6 — the empty state

36.3 opened with one welcome sentence and a flat row of 15 pills. That says
what the assistant *is* but not what it can *do*, and a leave question and a
holiday question looked equally likely to be answered.

The empty state now carries:

* a short welcome that names what it can answer and states plainly that it
  can never approve, apply or change anything;
* **four capability badges** — Instant Answers, 100% Private & Redacted,
  Multilingual, Voice Enabled;
* **grouped example chips** — Leaves / Attendance & Shifts / Payslips &
  Holidays.

The groups name **real** quick prompts from `chatPrompts.js` and are
**resolved against that list**, not trusted. A renamed or removed prompt
degrades to fewer chips, never to a chip that promises something the context
cannot answer — the same rule `aiChatPills.test.js` enforces for the pills.

`QuickPromptPills.jsx` was **deleted**. Nothing imported it once the grouped
chips replaced it, and the grouped chips are a strict superset of what it
rendered.

---

## 8. Deliverable 7 — transcript export

`buildTranscript` is a pure string function; `downloadTranscript` is the one
function that touches a browser API.

```
CREWLY HR Assistant — chat transcript
Exported: [2026-09-30 09:16]
4 message(s). This file contains your own HR questions and the
assistant's answers about your own records. It was generated in your browser
and was never sent to a server.

[2026-09-30 10:15] User: What is my leave balance?
[2026-09-30 10:15] Assistant: You have 4 sick leaves remaining.
```

**Zero server calls.** No upload, no email, no storage key. The file is
written to the machine the person is already sitting at, by a click they
made.

### The privacy argument

The transcript contains the employee's **own** questions and the assistant's
**own** answers about their **own** records — the server scoped every turn to
`req.user._id` before this text existed. What is worth saying out loud is
that the file now exists *outside* the browser, so it is theirs to protect,
the same as any payslip PDF they have already downloaded. The header says so.

### The timestamp law

36.6 added `at: Date.now()` to every message **in the slice's reducers**, so
one change covers every dispatch site. `messageTime` prefers `at`, falls back
to the epoch embedded in a 36.3–36.5 id, and when neither exists prints
`[unknown time]` — **never the export time**. Stamping "now" on a turn that
happened twenty minutes ago is a lie about when the question was asked, and a
transcript that lies about its own timestamps is worthless as a record.

`URL.createObjectURL` appears **only** here. 36.5 bans it in
`useSpeechRecognition.js` and `speechSynthesis.js` because audio must never
be persisted; a text file the person explicitly asked for is a different
thing, and the ban is scoped to those two files by design.

---

## 9. Deliverables 8 & 9 — voice polish and the usage dashboard

### Typing stops the speech

`handleDraftChange` calls `stopSpeaking()` when something is actually
speaking, then updates the draft. Two deliberate choices: it only fires when
`speakingId` is set (otherwise every keystroke would cancel the engine for
no reason), and **the draft still updates normally** — stopping the voice must
never swallow a character.

### The usage dashboard

`GET /ai/usage`, behind `requirePermission('SETTINGS_MANAGE')`, returning
aggregates for the caller's own company:

```
totals     { totalTokens, calls, quotaTokens }
window     { start, end }
byFeature  [ { feature, totalTokens, calls } ]
byStatus   { SUCCESS: { totalTokens, calls }, ... }   <- an OBJECT
topUsers   [ { userId, name, designation, totalTokens, calls } ]
```

**The controller reads nothing from the request** — no body, no query, no
params. `now` is server-side, so the month window cannot be shifted by
editing a request in the browser, and the company comes from the caller's own
token. A client-supplied `companyId` would be a multi-tenancy hole and is
refused by the validator.

`getUsageBreakdown` runs three aggregations and `$lookup`s `users` for
`name` and `designation` only, with `preserveNullAndEmptyArrays` so a
**deleted user keeps their token spend** — hiding it would understate the
company's real usage. It fails safe to an empty dashboard with a
`logger.warn`.

**Why this is safe to build at all:** `AIUsageLog` has no field that could
hold a prompt or a reply, so the dashboard cannot leak a conversation. The
only two human-readable fields it surfaces are `name` and `designation`, both
already visible to this admin on the employee screen.

**`SETTINGS_MANAGE`, not `ai:admin`.** There is no `ai:admin` permission in
this repository. Inventing one would mean a registry change plus a
`SYSTEM_PERMISSION_VERSION` bump plus a migration for every existing tenant.
`COMPANY_ADMIN` already inherits `SETTINGS_MANAGE`, so this reaches exactly
the people who need it.

---

## 10. The standing rules, and where each one is enforced

| Rule | Where |
|---|---|
| Controller comment convention | `getUsage` carries all three comments |
| ES6+ only, no `var`, no `function` decls | lint + review |
| AI outputs informational & navigational only | `AI_DEEP_LINKS` is hardcoded; no chip mutates |
| PII redaction mandatory | redactor untouched; the payslip PAN test pins it |
| Scoping from `req.companyId` / `req.user._id` | `getUsageBreakdown` match stage |
| **No chat prompt or transcript persistence** | no new `AIUsageLog` field; `test:all` |
| Own payslip Q&A reads only `req.user._id` | 36.4 scoping, unchanged |
| **Zero new npm packages** | `package.json` unchanged in both halves |
| No emojis in new UI | `aiChatUx.test.js` pins all new files |

---

## 11. Localhost acceptance

1. Restart both halves. `Backend` — `npm run dev`. `Frontend` — `npm run
   dev`. Hard-reload the browser (Ctrl+Shift+R).
2. Open the assistant with an **empty conversation**. The onboarding card
   should show the four badges and the three grouped chip rows. Click a chip
   and confirm it sends.
3. Ask *"what is my leave balance?"*. Watch the reply **type itself out**,
   then the follow-up chips and the **Apply Leave / View Ledger** chip appear.
4. Click the deep-link chip. It should navigate to `/app/leaves` and **change
   nothing**.
5. Ask *"what is on my payslip?"*. The reply must name gross salary, total
   deductions and net pay, and must **not** show a figure.
6. Ask something the context cannot answer. The reply must still be useful —
   what it does not have, the closest thing it does, what to do next. It must
   never stop at "I do not have that information".
7. Click **Listen**, then start typing. The speech must stop on the first
   keystroke and the character must still appear.
8. Click **Export**. A `crewly-chat-transcript-YYYY-MM-DD.txt` should
   download, open it, and confirm every turn is present with a real
   timestamp.
9. As a `COMPANY_ADMIN`, open `/app/settings/ai-usage`. Four tiles, three
   sections, and a real token count. Confirm the page shows **nothing** for a
   deleted employee except the label.

---

## 12. Known limitations

* **No true streaming.** The reveal is client-side. If the vendor stalls, the
  whole reply waits — which is the same behaviour 36.3–36.5 shipped.
* **Cards only fire on `- Label: value` runs.** A model that answers in prose
  gets prose. That is the conservative choice and it is deliberate.
* **Four categories get a deep link.** The rest have no single obvious
  destination, and a link there would be decoration.
* **The dashboard shows this month only.** There is no date-range picker,
  because a client-supplied range is exactly the kind of parameter this
  feature refuses to accept.
* **`Frontend` lint is 128 problems**, one more than the 127 baseline. The
  new one is `react-hooks/set-state-in-effect` in `AiUsagePage.jsx`, the same
  rule that already fires 66 times across the codebase for the same
  fetch-on-mount pattern.
