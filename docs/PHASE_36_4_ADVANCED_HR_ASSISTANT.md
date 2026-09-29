# CREWLY — PHASE 36.4: THE ADVANCED HR ASSISTANT

> **Renumbering note.** The hub's unit map originally listed 36.4 as
> *"Close-out & hardening"*. The owner redirected it: the assistant kept
> refusing questions it should have answered, so 36.4 became the unit that
> fixes that. The close-out work is still open and is listed in §11 below
> rather than dropped.

Phase 36.1 made an AI call safe. 36.2 made it **informed**. 36.3 made it
**usable**. 36.4 makes it **actually answer the question**.

The trigger was one exchange, reported by the owner:

> **Q:** *"What are my shift timings?"*
> **A:** *"I do not have that information. Please contact your HR team."*

…while the header still showed `attendance` in **Answered using:**. The data was
in the context the whole time. `5757006` fixed that specific bug by teaching the
prompt the difference between a stated negative and a failed read
([PHASE_36_3 §10.5](PHASE_36_3_HR_CHATBOT_UI.md)).

36.4 fixes the **class** of problem behind it. The employee kept asking about
their own tasks, expenses, payslips, projects and documents — and the retriever
had no category for any of them, so the honest answer was a refusal. Nine new
categories, a static capability catalogue for the "how do I…" questions, and
stricter prompt rules.

---

## 1. The one law that did not bend

The owner asked for a chatbot that reads *all* the data. **That was pushed back
on, deliberately, and it is the most important line in this document.**

The assistant only ever sees what the caller is **already authorized to see**.
36.2's authorization law is unchanged and still absolute:

> Every user-scoped query carries BOTH `companyId` AND the field that owns the
> row, and every value comes from the arguments `getUserHRContext` was given —
> which the controller fills from `req.companyId` / `req.user._id` and nothing
> else. There is **no parameter** through which another employee's context can
> be requested. The signature IS the authorisation.

| Role | What the assistant sees |
| --- | --- |
| Employee | Their **own** records only |
| Manager / Team lead | Their own records + their **team's counts** |
| HR / Admin | Their own records + **company counts** |

Counts, never rows. An employee must never read another employee's salary,
leave or attendance through a chat box — and now there is a test that fails if
an aggregate ever names a person.

---

## 2. The nine new categories

`AI_CONTEXT_CATEGORIES` went from four entries to thirteen. The list is still
the single source of truth: the `AITenantConfig` enum, the request validator and
the retriever all read it.

| Category | Reads | Scoped on |
| --- | --- | --- |
| `payslips` | Which months exist + status | `companyId` + `employeeId` |
| `expenses` | Own claims: date, category, amount, status | `companyId` + `user` |
| `tasks` | Own tasks: title, status, due date | `company` + `assignedTo` |
| `projects` | Own projects | `company` + `manager` / `teamLeads` / `members` |
| `documents` | Own documents: name, category | `companyId` + `user` |
| `leave-requests` | Full history, **including rejected** | `companyId` + `user` |
| `attendance-month` | Month-to-date rollup | `companyId` + `user` |
| `org-aggregates` | **Counts only**, role-aware | `companyId` |
| `capabilities` | The static catalogue | nothing — no DB read |

### 2.1 `leave-requests` is not `leaves`

`leaves` is **balances** — this year, one line per leave type. `leave-requests`
is the actual **requests**, newest first, including rejected and cancelled ones.

They answer different questions. *"How many days do I have left?"* is balances.
*"Why was my leave rejected last month?"* can only be answered from a rejected
row, and a balances section has no concept of one.

### 2.2 `projects` has no owner field

`Project` carries no scalar owner. Membership is an array on **three** fields:
`manager`, `teamLeads[]` and `members[]`. All three must be checked — a team
lead is not in `members`, and the manager is in neither array. Checking only one
would silently show two of the three roles nothing.

### 2.3 What is still deliberately absent

**`performance`.** Reading an appraisal runs the appraisal access chain, and a
config flag must never be able to switch it on. An employee must not be able to
read another employee's rating through a chat box.

---

## 3. The money rule — and why the payslip figures are NOT in the context

This is the finding worth remembering, because the obvious implementation is
wrong in a way that looks fine until an employee asks about their salary.

`piiRedactor` **deliberately masks a number that carries a salary label**. This
was verified, not assumed:

```
"net pay 45000"        ->  "net pay [AMOUNT_REDACTED]"
"gross 60000"          ->  "gross [AMOUNT_REDACTED]"
"deductions 15000"     ->  "deductions 15000"        (no label — survives)
"amount 1200"          ->  "amount 1200"             (no label — survives)
```

So rendering `- June 2026: net pay 45000` in the context would produce:

```
- June 2026: net pay [AMOUNT_REDACTED]
```

…and the assistant would then report the employee's **own** net pay as redacted.
Useless, and confusing.

**The redactor is not loosened.** Salary is the single most sensitive number in
the product and the redactor's whole job is to keep it out of a prompt that
leaves the building. Instead the `payslips` section carries **which payslips
exist and their status**, plus a plain sentence that the figures are on the
payslip screen. Prompt rule 12 tells the model to say exactly that.

Expense amounts **are** rendered: an expense amount is an ordinary business
number, the redactor leaves it alone on purpose, and *"what is the status of my
expense claims?"* is a real question with a real answer.

This is an **honest degraded state**, which the standing laws require — not a
shortcut.

---

## 4. `org-aggregates` — counts only, never rows

The one category where the context is not strictly the caller's own data, so it
is written to be obviously safe. Four rules, all enforced by test:

1. **A count is not a person.** *"3 people are on leave today"* names nobody.
2. **No employee id, name, `employeeCode`, email or designation is ever put in
   an aggregate.** Not in the query, not in the render.
3. **An `EMPLOYEE` gets nothing.** The section states that their role does not
   include company-wide figures — an answer, not a refusal — and issues **no
   count queries at all**.
4. **No salary figure is aggregated, at any role.** Payroll stays out entirely.

A manager sees their direct-report count because they can already open their
team's leave list on screen. An HR user sees company counts because they can
already open the company dashboard. Neither gets a new door.

Prompt rule 13 goes further and tells the model it must never turn a count into
a name, and must never speculate about a colleague.

---

## 5. The capability catalogue

The most common questions are not about data at all — they are about **how to do
something**:

- *"How do I apply for leave?"*
- *"Where do I upload my PAN card?"*
- *"How do I fix a missed punch?"*

None of those can be answered from a database read, so before this existed the
assistant could only refuse — and refusing a question it should answer is the
bug the owner reported.

`AI_CAPABILITIES` is a **static** catalogue of 15 entries. It needs no database
read, which is why the `capabilities` category **cannot fail**: there is nothing
to read, so there is nothing to be unavailable.

**Every entry describes something the product really does.** Each one was
checked against the route that backs it, and a test pins the named screens
(`My Leaves`, `My Payslips`, `My Expenses`, `My Tasks`, `My Documents`,
`My Profile`, `Projects`, `Attendance`) plus a ban on promising anything the
assistant cannot do (*"auto-approve"*, *"on your behalf"*, *"I will apply"*,
*"I have submitted"*). The most dangerous bug here would be the assistant
confidently sending an employee to a screen that was never built.

---

## 6. Prompt rules 10–13

The system prompt went from nine rules to thirteen, and the close-out unit took
it to fourteen. Rules 8 and 9 came from `5757006`; 10–13 are 36.4's; 14 came
from the owner's own ask in this unit.

**Rule 3 no longer ends at a bare refusal.** It used to read *"say I do not
have that information. Please contact your HR team"* – which is a dead end:
the employee learns nothing they can act on. Rule 14 requires three things in
order: name what is missing, give the closest thing that IS known, then say
what to do next. The hard limit is explicit and pinned – **rule 4 still wins
over rule 14**, so being useful is never a licence to invent a number.

| Rule | What it pins |
| --- | --- |
| **10** | *"How do I…"* questions are answered **from the capability catalogue**, and the model must never invent a screen that is not in it. |
| **11** | **Name your source.** An answer drawn from the context says which section it came from. |
| **12** | **Never state a salary figure.** Point at My Payslips; never estimate, never repeat `[AMOUNT_REDACTED]` as if it were a number. |
| **13** | **You only know this employee.** A count is not a person; never turn one into a name; never speculate about a colleague. |
| **14** | **When you cannot answer, still be useful** – say what is missing, give the closest thing you do have, then say what to do next. Rule 4 still wins over rule 14. |

All thirteen are pinned verbatim by `test/hrChatbotService.test.js`, which loops
`1..13` and fails if any rule number is missing. A prompt that drifted silently
would be an instruction the product never approved.

---

## 7. Frontend UX

| Change | Why |
| --- | --- |
| **Try again** on the error banner | A transient vendor failure used to leave the person retyping the question. |
| **Copy** on the newest answer | The reply is the only thing this UI produces, and people paste it into tickets and emails. |
| Quick prompts 6 → **15** | The empty state now introduces the new own-record categories and two capability questions. |
| Welcome text rewritten | It now names the new categories instead of only the original four. |

**Retry adds no state and no queue.** The server is stateless and rebuilds the
HR context from scratch on every call, so the exact payload that just failed is
the exact payload to send again. It deliberately does **not** append a duplicate
user turn — the question is already on screen, and repeating it would read as
the person having asked twice. It is disabled while a send is in flight, so two
requests can never race for the same reply slot.

**Copy degrades quietly.** `navigator.clipboard` is unavailable in insecure
contexts and in some embedded frames; the text stays selectable by hand, so a
swallowed write is the honest behaviour rather than a thrown promise the user
cannot act on.

The 36.3 constraints all still hold: no new npm packages, no server-side chat
persistence, no `localStorage` of chat content, no streaming, no tool calling,
no agentic behaviour, roles still `['system','user','assistant']`, and the
browser still never receives the HR context — only the final reply.

---

## 8. Tests

| Suite | Tests | What it pins |
| --- | --- | --- |
| `test:ai-own-records` (**new**) | **38** | Every new category: query scoping, NONE vs UNAVAILABLE phrasing, the money rule, role gating, the catalogue, and the authorization law |
| `test:ai-context` | 47 | The four original categories (unchanged, still green) |
| `test:ai-chatbot` | 48 | Thirteen prompt rules verbatim |
| `test:ai-tenant-config` | 45 | The enum is closed to the 13 categories and `performance` is not one of them |
| `npm run test:all` | **2939 / 145 / 0 fail** | Whole backend |
| Frontend `npm test` | **31 / 5 / 0 fail** | Widget wiring, pills, retry, copy |
| Frontend build | clean | — |
| `eslint src` | **127** (108 err / 19 warn) | Exactly the pre-existing baseline; the AIAssistant files are clean |

### 8.1 Two test-harness bugs found on the way

Both were **fake-model** defects, not product defects, and both are worth
recording because they produce convincing false failures:

1. **An array from `findOne` is not a null document.** `record.shift` on an
   array is `Array.prototype.shift` — a **truthy function** — which sent
   `resolveCurrentShift` down the `record?.shift` branch and into a
   `findById` call the simple fake never defined. The resulting
   `(attendance unavailable)` looked exactly like a real retriever bug.
2. **One shared chain object across concurrent queries.** The builders run
   under `Promise.all`, so `Attendance` is read as `findOne`, `aggregate` **and**
   `aggregate` in the same tick. A fake that resolved on the *first* recorded
   call made the month rollup resolve to the day-query's shape.

The fix is `makeModelByOp`, which resolves by **operation** (`findOne` → a
document or null, `find` → an array, `aggregate` → an array, `countDocuments` →
a number) and gives **each query its own chain**.

---

## 9. What 36.4 deliberately does NOT do

- **No new npm packages.** Nothing was installed.
- **No payroll aggregate.** Not for HR, not for admin, not for anyone.
- **No performance / appraisal category.**
- **No RAG, no embeddings, no vector store.** The retriever is still the whole
  retrieval story, exactly as in 36.2.
- **No `ai:admin` permission string.** None was added.
- **No new env keys.**
- **No change to the `aiChat` guard ladder, the `AIUsageLog` schema, or any
  36.1 error code.**

---

## 10. How to see exactly what the assistant sees

`GET /api/ai/context/preview` (36.2) prints the whole redacted context string,
section by section. This is the fastest way to answer *"why did it refuse?"* —
and it now prints thirteen sections instead of four.

---

## 11. Still open (carried forward)

- The original 36.4 "close-out & hardening" scope has since been DELIVERED by
  the close-out unit: `Backend/test/phase36Closeout.test.js` (44 tests)
  re-proves the fourteen structural guarantees hermetically, and
  [PHASE_36_RUNBOOKS.md](PHASE_36_RUNBOOKS.md) plus
  [PHASE_36_MEMORY_CAPSULE.md](PHASE_36_MEMORY_CAPSULE.md) record the
  operational and architectural knowledge. **Phase 36 is closed.**
- No `ai:admin` permission in the registry; `requirePermission` refuses
  `SUPER_ADMIN`, so a platform super-admin still has no route to a tenant's AI
  config ([PHASE_36_2 §6 and §8](PHASE_36_2_HR_CONTEXT_RETRIEVER.md)).
- `Backend/.env` was recreated locally with `AI_ENABLED=false` and **no
  `AI_API_KEY`**, because the sandbox re-clone wiped it and an API key must
  never be invented. To test the live Groq chain, set the owner's values back:
  `AI_ENABLED=true`, `AI_PROVIDER=groq`,
  `AI_BASE_URL=https://api.groq.com/openai/v1`,
  `AI_MODEL=openai/gpt-oss-120b`, `AI_MAX_TOKENS=1024`,
  `AI_MONTHLY_QUOTA_TOKENS=1000000`, `AI_TIMEOUT_MS=30000`,
  `AI_PII_REDACTION=enforced`, and the real `AI_API_KEY`. The automated suites
  inject their own dependencies and do not need it.

---

## 12. Localhost acceptance

1. `cd Backend` → `npm run dev` (nodemon now watches `.env`, so an env change
   restarts the server).
2. `cd Frontend` → `npm run dev`.
3. Log in as an **employee**. Open the floating assistant button (bottom-right).
4. Try, in order:
   - *"What tasks are assigned to me?"* → own tasks, or a plain
     *"none assigned to you"*.
   - *"Which payslips do I have?"* → the months, and a sentence that the figures
     are on My Payslips. **No amount.**
   - *"How do I apply for leave?"* → the steps, from the capability catalogue.
   - *"What is my net pay?"* → it says the figure is not shared with the
     assistant and points at My Payslips. It does **not** say
     *"I do not have that information"*.
   - *"How many people are on leave today?"* → as an employee it says your role
     does not include company-wide figures. It never names anyone.
5. Break the vendor deliberately (set a wrong `AI_MODEL`) and confirm the error
   banner offers **Try again**, and that clicking it re-asks without duplicating
   the question.
6. Click **Copy** on an answer and paste it somewhere.
7. `GET /api/ai/context/preview` and read the thirteen sections.
