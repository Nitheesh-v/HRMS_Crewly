# CREWLY — PHASE 36: THE HR CHATBOT SUITE (AI)

This document is the running record of Phase 36. **One unit at a time**, each
unit shipped with its own tests, its own limitations and its own localhost
acceptance steps. Nothing here is a promise about a later unit: a unit is
described only once its code exists in the repository.

> **Numbering note.** Phase 36 is the AI suite. The repository already had a
> **Phase 35** — nine UI/import units (toasts, responsiveness, permissions,
> the attendance import rework). Those keep their number, docs, tests and
> close-out pins untouched. The AI suite runs as 36.x so that a commit message,
> a doc name or an npm script can never be ambiguous about which "35" it means.
> Owner decision, recorded here so it is never re-litigated.

## Purpose

One multi-tenant SaaS platform gains an **HR conversational assistant**: an
employee asks "what is my leave balance", "how does the tax regime affect my
take-home", "when do I get my payslip" and gets an answer built only from data
they are already authorized to see. HR gets drafting help. Nobody gets an AI
that decides anything.

Phase 36 is **strictly the HR Chatbot Suite**. It is *not* recruitment AI,
*not* payroll pipeline AI, *not* analytics AI. Those would be later phases with
their own laws.

## Unit map

| Unit | Scope | Status |
| --- | --- | --- |
| **36.1** | AI Provider Foundation & Guardrails — config, PII redactor, usage tracking, quota, kill switch, rate limit, `POST /api/ai/chat` | **IMPLEMENTED** (this document) |
| **36.2** | HR Context Retriever & Tenant AI Config — `AITenantConfig`, tenant service + cache, the read-only redacted context retriever, config & preview endpoints | **CLOSED** (see [PHASE_36_2](PHASE_36_2_HR_CONTEXT_RETRIEVER.md)) |
| **36.3** | HR Chatbot UI & Conversational API — one employee-facing turn per request: `POST /api/ai/chatbot`, `hrChatbotService`, the `/app/ai-assistant` page and sidebar entry. **No RAG, no embeddings, no vector store** — the retriever from 36.2 is the retrieval. | **CLOSED** (see [PHASE_36_3](PHASE_36_3_HR_CHATBOT_UI.md)) |
| **36.4** | Close-out & hardening — kill-switch runbook rehearsal, cost display, the remaining gaps listed in PHASE_36_3 §9 | NOT BUILT YET |

Later candidates, **not scheduled**: chat-hub AI (summarise/translate/smart
replies inside Phase 33 conversations), document Q&A beyond policy, admin
analytics NL queries. Each needs its own phase number and its own laws before it
is built.

### Current state (end of 36.3)

36.1 made an AI call safe. 36.2 made it **informed and controllable**. 36.3 made
it **usable**: an employee can now open `/app/ai-assistant`, ask a question, and
get one answer built from their own authorized, redacted HR context.

The retriever is **read-only across every HR domain** and its signature is its
authorisation: there is no parameter through which another user's context can be
requested. As of 36.3 it **is wired into the chat path** — `hrChatbotService`
calls it on every turn, prepends a server-owned system prompt, re-redacts every
user turn, and makes exactly **one** vendor call through the 36.1 choke point.
The client receives `{ reply, usage, categoriesUsed }` and never the context.

Two things 36.2 could not deliver and has recorded rather than papered over:
there is **no `ai:admin` permission** in the registry (the config endpoints reuse
`SETTINGS_MANAGE`, which `COMPANY_ADMIN` already inherits), and
`requirePermission` refuses `SUPER_ADMIN` by design, so a platform super-admin
still has **no route** to a tenant's AI config. Both are in
[PHASE_36_2 §6 and §8](PHASE_36_2_HR_CONTEXT_RETRIEVER.md).

36.3 records its own limitation rather than hiding it: the history is capped to
the **last 6 turns**, tighter than the UI's 20-message display cap, because the
system prompt already carries several hundred tokens of context. The person can
scroll back further than the model can remember. See
[PHASE_36_3 §4](PHASE_36_3_HR_CHATBOT_UI.md).

36.3 also shipped one real defect and fixed it: the assistant page rendered a
**blank screen** because the Redux slice was never registered in `store.js`. The
cause, the two-part fix and the regression test are in
[PHASE_36_3 §8.1](PHASE_36_3_HR_CHATBOT_UI.md) — worth reading before adding a
slice to this store, because the slice → service → `api.js` → store cycle only
resolves when the store is loaded first.

36.3 was also **restructured from a page into a floating widget** at the owner's
request: a `Bot` button in the corner opens the assistant as a panel on any
screen, replacing the `/app/ai-assistant` route and the sidebar entry. The three
tabs the reference product shows (*Live Insights*, *Past History*, *Work
Report*) were deliberately **not** built — *Past History* needs the server-side
persistence 36.3 forbids, and the other two are workforce analytics with a
different authorisation surface. See
[PHASE_36_3 §10.4](PHASE_36_3_HR_CHATBOT_UI.md).

36.3 also hit a **vendor-side** failure that is worth recording: the shipped
default model `llama-3.3-70b-versatile` was decommissioned by Groq on
2026-08-16, so every call returned a generic `503 AI_VENDOR_ERROR` while the
key, the network and the code were all fine. The default is now
`openai/gpt-oss-120b` and is pinned by a test. See
[PHASE_36_3 §10.1](PHASE_36_3_HR_CHATBOT_UI.md) — including how to read
`ai.vendor.error` to tell a dead model from a bad key without guessing.

A second, subtler failure followed: the model was fixed on disk but the chatbot
**still** 503'd, because `nodemon` does not watch `.env` and the running server
kept the old config in memory while `config:check` reported the new one. Fixed
with an explicit `nodemonConfig`; see
[PHASE_36_3 §10.2](PHASE_36_3_HR_CHATBOT_UI.md). The general lesson is worth
keeping: **a `config:check` that disagrees with the running app means the app is
stale, not that the config is wrong.**

## Explicitly out of scope for the whole phase

* Presence, availability, last-seen (unchanged from Phase 33/34).
* AI hiring decisions, AI performance reviews, AI BGV verdicts — the human
  decision laws of Phases 27/30/31 are absolute and AI never overrides them.
* Fine-tuning or training on tenant data.
* Streaming responses (deferred past 36.1; SSE infrastructure from 32.11 is
  available when a unit actually benefits).
* Tool calling / function calling / autonomous agents.
* Any billing hook to Razorpay — cost is *estimated and displayed*, never
  charged, in this phase.

## The twelve laws (binding on every unit, forever)

1. **AI is informational, never authoritative.** AI never approves leave, never
   modifies payroll, never creates or deletes records, never sends email, never
   triggers a workflow. AI output is text shown to a human. Same principle as
   the ATS score (Phase 27) and a BGV result (Phase 30).
2. **PII redaction is on by default and cannot be disabled via API.** Before any
   text leaves the server it passes `redactPII`. The only override is
   `AI_PII_REDACTION=false` in development/test, fail-closed in production
   (startup refuses, and the runtime enforces redaction regardless).
3. **No prompt or response is ever stored.** `AIUsageLog` has no text field —
   not optional, not behind a flag, *none exists*. Token counts, latency,
   feature label, status, bounded error type. That is all.
4. **Multi-tenancy is absolute.** Every query is scoped by `req.companyId`,
   derived from the verified token + Mongo user. Company A never sees Company
   B's usage, prompts or responses.
5. **The AI has no implicit data access.** When a feature needs employee data,
   the backend fetches it under the user's own authorization, redacts it, and
   passes redacted text. No Mongo credentials, no service account, no query
   ability. It receives text; it returns text.
6. **Quota and rate limits are hard, not soft.** Monthly token quota per tenant;
   over → `429 QUOTA_EXCEEDED`, refused. Per-user limit via the 32.4 shared
   Redis limiter. Redis down → bounded local buckets. Never a silent overage,
   never fail-open.
7. **Kill switch is global and per-tenant.** `AI_ENABLED=false` disables
   everything; `AITenantConfig.enabled=false` disables one tenant. Either flip
   produces a clean `FEATURE_UNAVAILABLE`/`503` — never a crash, never a silent
   degraded state.
8. **Vendor errors are opaque to clients.** Rate limit, auth failure, timeout,
   network error — all collapse to one generic sentence with the right status.
   Vendor detail stays in metadata-only server logs.
9. **No streaming in the foundation.** Synchronous request/response only; SSE
   (32.11) is untouched until a unit benefits.
10. **No agentic behaviour, no tool calling.** Text in, text out. `tool` and
    `function` message roles are refused at the validator.
11. **Audit every call.** One `AIUsageLog` row per invocation — success, vendor
    error, rate-limit refusal and quota refusal all write a row.
12. **Honest degraded states.** Vendor down → "AI features are temporarily
    unavailable". Redis down → local buckets, quota bypasses cache. Mongo down →
    the API is already down, and the quota read fails **closed**. We never
    pretend AI is available when it is not.

## Vendor and dependency decisions (owner-approved)

* **One new package for the whole foundation: `openai`** (the official Node SDK).
  No LangChain, no LlamaIndex, no agent framework. Primitives are composed here.
* **Vendor: Groq** (`https://api.groq.com/openai/v1`, Llama 3.3 70B) —
  OpenAI-compatible, generous free tier, fast. Lets the product prove itself at
  zero cost.
* **Vendor swap = two env vars.** `AI_BASE_URL` + `AI_API_KEY`. Zero code
  changes, because the SDK is OpenAI's against an OpenAI-compatible endpoint.
* **Env keys** (all optional; the suite is OFF by default): `AI_ENABLED`,
  `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_MAX_TOKENS`, `AI_TEMPERATURE`,
  `AI_TIMEOUT_MS`, `AI_MONTHLY_QUOTA_TOKENS`, `AI_PII_REDACTION`.
* **`AI_API_KEY` is a secret** with the same care as `JWT_SECRET`: never logged,
  never in a response, never in a job payload. `config:check` reports
  `configured|missing` only.
* **Cost model:** one free-tier quota for every tenant (default 1,000,000
  tokens/month), adjustable per tenant from 36.2. Cost is estimated and shown;
  **no Razorpay hook exists in this phase.**

## Interaction with earlier phases

| Phase | How 36 touches it |
| --- | --- |
| 27 RMS/ATS | Untouched. No recruitment AI in this phase. |
| 28 queues/cache | The 32.4 shared limiter is reused unchanged. No new queue. Heavy batch AI, if ever needed, would ride the existing BullMQ queues. |
| 29 payroll | 36.4 reads immutable `PayrollResult` snapshots and explains them. Payroll data is never mutated. |
| 30 BGV | Untouched. BGV stays human-only. |
| 31 attendance | Untouched in this phase. |
| 32 infra | Reuses the 32.4 limiter, the 32.12 observability/redaction pipeline, the 32.15 config-check and `validateProductionConfig`, and the 32.2 startup path. Nothing is bypassed. |
| 33/34 chat | Untouched in this phase. Chat-hub AI would be a later phase. |
| 33.14 session | AI REST endpoints are cookie-authenticated like every tenant surface and carry the same `X-Requested-With` CSRF requirement. |

## Verification matrix

| # | Check | Status |
| --- | --- | --- |
| 1 | `AI_ENABLED` unset → `/api/ai/chat` answers `503 AI_UNAVAILABLE`, rest of the product unaffected | ✅ 36.1 |
| 2 | `AI_ENABLED=true` without `AI_API_KEY` → startup refuses, key named, no value | ✅ 36.1 |
| 3 | `AI_PII_REDACTION=false` in production → startup refuses AND the runtime still redacts | ✅ 36.1 |
| 4 | All eight Indian PII classes removed; ordinary business text untouched | ✅ 36.1 |
| 5 | Redaction happens **before** the vendor call (verified over real HTTP) | ✅ 36.1 |
| 6 | No `companyId`/`userId` in the vendor payload | ✅ 36.1 |
| 7 | Quota exceeded → `429 QUOTA_EXCEEDED`, row recorded, vendor never called | ✅ 36.1 |
| 8 | Quota read failure → refused (fail closed), never allowed | ✅ 36.1 |
| 9 | Rate limited via the 32.4 shared store, key `crewly:<env>:rl:ai:<companyId>:<userId>` | ✅ 36.1 |
| 10 | Vendor error → one generic `503`, classification logged metadata-only | ✅ 36.1 |
| 11 | `AIUsageLog` has no text field, and schema/writer agreement is pinned | ✅ 36.1 |
| 12 | Client-supplied `companyId`/`userId`/`feature` refused by the validator | ✅ 36.1 |
| 13 | `config:check` reports the AI block; `--production` exits 1 on both AI misconfigurations | ✅ 36.1 |
| 14 | Per-tenant enable/disable, quota dial and category allowlist (`PUT /api/ai/config`) | ✅ 36.2 |
| 15 | Month-to-date token usage visible to a tenant admin (`GET /api/ai/config`) | ✅ 36.2 |
| 15b | **Platform super-admin** route to a tenant's AI config | ⬜ blocked — `requirePermission` refuses `SUPER_ADMIN` by design; needs the `superAdminAuth` chain (36.3/36.4) |
| 15c | Cost *estimate* per tenant | ⬜ not built — no billing model exists in this phase |
| 16 | Policy documents → RAG answer with citations (36.3) | ⬜ 36.3 |
| 17 | Employee assistant UI at `/app/ai-assistant` (36.3/36.4) | ⬜ 36.3/36.4 |

Rows 1–13 are pinned by `Backend/test/aiProviderFoundation.test.js` (66 tests)
and by the runtime probe recorded in `docs/PHASE_36_1_FOUNDATION.md` §6.
Rows 14, 15 and the redaction row are additionally pinned by
`Backend/test/aiTenantConfig.test.js` (45) and
`Backend/test/hrContextRetriever.test.js` (47).

## Runbooks

See `docs/PHASE_36_1_FOUNDATION.md` §3.12 (degraded states) and §8 (localhost
verification) plus the per-tenant config endpoints from 36.2.

**Operational runbook for 36.2:**

| Situation | What to do |
| --- | --- |
| One tenant must lose AI immediately | `PUT /api/ai/config` with `{"enabled":false}` as that tenant's admin. Effect is instant (the config cache is invalidated on write). No restart. |
| One tenant is overspending | `PUT /api/ai/config` with `{"monthlyQuotaTokens":<n>}`. Over the cap the tenant gets a hard `429 QUOTA_EXCEEDED`, never a soft overage. |
| A tenant should stop asking about attendance | `PUT /api/ai/config` with `{"allowedCategories":["profile","leaves","policies"]}`. The allowlist cannot be emptied — disabling the tenant is the one-switch way to say "nothing". |
| Reset a tenant to platform defaults | `PUT /api/ai/config` with `{"monthlyQuotaTokens":null}` and the full category list. |
| AI must be off everywhere | `AI_ENABLED=false` + restart. This is the global switch and it beats every tenant row. |
| The vendor is down | Nothing to do: every failure is already one generic `503 AI_VENDOR_ERROR`. |
| Check what a tenant has spent this month | `GET /api/ai/config` as that tenant's admin — token total, call count and a per-status breakdown. |

**Operational runbook for 36.3** (the chatbot surface):

| Situation | What to do |
| --- | --- |
| An employee is hammering the assistant | The `ai-chatbot` 32.4 store allows 20 turns per 60 s per (tenant, user). Over the cap they get `429 AI_RATE_LIMITED`. No admin action needed; it clears itself. |
| An employee says the assistant "made up" an answer | The system prompt forbids it and the context is the only source, but the model can still be wrong — this is why 36.3 shows `Answered using:` so the person can see which categories were consulted. AI output is informational only and is never authoritative. |
| A tenant's employees all see "switched off" | That tenant's `AITenantConfig.enabled` is `false`, or the global `AI_ENABLED` is off. `PUT /api/ai/config` with `{"enabled":true}` restores it. |
| A question comes back as "I do not have that information" | Correct behaviour: the answer was not in that employee's own authorized context. Check the tenant's `allowedCategories`. |
| An employee typed their PAN into the chat | It was redacted before the vendor ever saw it. The assistant's reply quotes `[PAN_REDACTED]`. |

The dedicated per-unit runbook is
[PHASE_36_3 §10](PHASE_36_3_HR_CHATBOT_UI.md).
