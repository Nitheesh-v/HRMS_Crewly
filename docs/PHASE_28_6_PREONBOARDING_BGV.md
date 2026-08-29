# Phase 28.6 — Pre-Onboarding Document Processing + BGV Background Jobs

Background execution for the two remaining recruitment workflows:

- **DOCUMENTS queue** — security/integrity processing of uploaded
  pre-onboarding document versions (server-side, on the STORED bytes).
- **BGV queue** — background-verification case execution through the
  27.15 provider adapter architecture (registry + INTERNAL provider),
  consent-gated, idempotent, with bounded delayed polling for future
  external providers.
- **Two reminder families** on the existing SCHEDULED queue
  (pre-onboarding candidate nudges + BGV HR nudges) delivered through
  the 28.3 EMAIL queue (two new non-sensitive email jobs).

The worker process now runs **seven** BullMQ workers (system, email,
resume, ats, scheduled, documents, bgv) — one ioredis connection each,
same connection-ownership rules as 28.2.

## Core flow

### Document processing

```
upload (synchronous — unchanged: extension/MIME/magic-byte/size/
filename/private storage/sha256) + inspectPreOnboardingFile
        │  version committed (processingStatus PENDING)
        ▼
scheduleDocumentProcessing(version)      ← never throws (intent stays in Mongo)
        ▼
DOCUMENTS queue: document-process-<versionId>-<processingVersion>
        ▼
worker (re-fetches everything by {_id, companyId}):
  strict payload → tenant-scoped version load → relationship checks
  → atomic lease claim (version-scoped, 2-min lease)
  → bounded server-side fetch of the STORED bytes
  → sha256 integrity vs stored checksum (mismatch → INTEGRITY_MISMATCH, terminal)
  → existing security abstraction on the stored bytes
  → update THIS version document only (version + tenant + processingVersion scoped)
```

- **NOT_CONFIGURED stays honest**: with no scanner configured the
  version's `scanStatus` remains `NOT_CONFIGURED` — the worker never
  fakes `CLEAN`. `CLEAN`/`REJECTED` only come from a real scanner.
- **Security ≠ business**: scan success never marks a document
  VERIFIED; the business review state (`status`) is untouched by the
  worker. A real `REJECTED` verdict records ONE business event
  (pre-onboarding history + audit + HR in-app notice) and never
  auto-rejects anyone.
- **Version scoping**: an old version's worker run can only update its
  own version; a re-versioned (resubmitted) job supersedes stale ones
  (`STALE_VERSION` skip).

### BGV execution

```
case start (service, checks committed)
        │  scheduleBgvCaseProcessing(case) + reminder(s)   ← never throws
        ▼
BGV queue: bgv-check-<caseId>
        ▼
worker: re-fetch case → terminal? → consent gate (PERSISTED state):
  required + not GRANTED → CONSENT_PENDING skip (no provider call)
  required + DECLINED    → atomic REVIEW_REQUIRED + history + HR notice
                           (NO auto-reject, NO pipeline change)
  GRANTED/not required   → atomic set-if-empty claim on
                           providerSubmission.submittedAt (duplicate-submit
                           prevention) → registry submitCase → persist
                           providerReference
  → providers that actually poll: persist polling state + ONE delayed
    first poll (INTERNAL never polls)
        ▼
bgv-poll-<caseId>-<attempt>   (delayed jobs only — never long-running loops)
  pending  → advance attempt + next delayed poll (bounded ladder)
  final    → recordProviderBgvResult (domain mapping) + stop polling
```

- **No fake vendor calls**: INTERNAL is deterministic and never polls;
  the poll path exists for external adapters registered in the same
  27.15 registry. `BGV_PROCESS_RESULT` is adapter-ready (webhook path)
  with no producer today — the poll processor records results directly.
- **Result mapping (explicit, conservative)**:
  `VERIFIED/PASS/CLEAR → VERIFIED`, `MISMATCH/FAIL/DISCREPANCY →
  DISCREPANCY`, `INCONCLUSIVE/UNVERIFIABLE/UNKNOWN →
  UNABLE_TO_VERIFY`, unrecognized → skipped. A provider FAIL can become
  at most a DISCREPANCY for human review — **a candidate is never
  auto-rejected, withdrawn, or pipeline-moved by BGV**.
- **Polling is bounded**: 5 → 15 → 30 → 60 min ladder (clamped), max
  window 7 days from case start → `STOPPED (MAX_POLL_WINDOW)` + human
  review. Terminal/cancelled cases stop polling + retire queued jobs
  (best-effort removal; execution-time validation is the final guard).

### Reminders (SCHEDULED queue, 28.5 architecture)

| Job | Types | Trigger (Mongo state) | Audience |
|---|---|---|---|
| `preonboarding-reminder` | DOCUMENTS_PENDING / DOCUMENT_RESUBMISSION / JOINING | start / rejection / joining date approaching; skipped for READY_TO_JOIN/COMPLETED/WITHDRAWN/converted candidates | candidate — non-sensitive, NO token (points to the original invite link) |
| `bgv-reminder` | CANDIDATE_INFO / VERIFIER / REVIEW_REQUIRED | consent required (case start) / verifier assigned / review required; skipped for COMPLETED/CANCELLED | HR — assigned verifier, else company HR_MANAGER/COMPANY_ADMIN; none → skip |

ONE reminder per state per version; eventKey idempotency makes even a
double-fire a single email. The worker revalidates the CONDITION (not
just the version) against Mongo before dispatching through the 28.3
EMAIL queue (`EMAIL_PREONBOARDING_REMINDER`, `EMAIL_BGV_REMINDER`).

## Job ids (deterministic, colon-free, Mongo-reconstructable)

```
document-process-<versionId>-<processingVersion>
bgv-check-<caseId>
bgv-poll-<caseId>-<attempt>
preonboarding-reminder-<preOnboardingId>-<type>-<stateVersionMs>
bgv-reminder-<caseId>-<type>-<stateVersionMs>
```

`stateVersion` is Mongo-derivable: PENDING = preOnboarding.startedAt;
RESUBMISSION = rejected requirement.updatedAt; JOINING = joiningDate;
BGV CANDIDATE_INFO = case.startedAt; VERIFIER/REVIEW_REQUIRED =
case.updatedAt. Hooks and reconciliation rebuild the SAME id from
Mongo — dedupe + reconcile are idempotent by construction.

## Payloads (references only — strictly validated by the worker)

```
document: { companyId, documentId, documentVersionId, processingVersion, correlationId }
bgv check: { companyId, caseId, providerKey, correlationId }
bgv poll:  { companyId, caseId, providerKey, pollAttempt, correlationId }
reminders: { companyId, preOnboardingId|caseId, reminderType, stateVersionIso, correlationId }
email reminder jobs add delivery fields only (deliveryId, recipientReference, ...)
```

Never in Redis: file bytes/paths/names, checksums, storage keys,
candidate PII beyond reference ids, government IDs, BGV evidence,
provider credentials, tokens. Strict key-set validation rejects any
extra key before any business logic runs.

## Retry model (documents)

| Category | Meaning | Behavior |
|---|---|---|
| — (5xx/network/transient DB) | storage or scanner temporarily down | throw → BullMQ 3 attempts (2s exponential) + lease cleared per attempt |
| `FILE_NOT_FOUND` (404) | stored object gone | terminal `PROCESSING_FAILED` — reconcile MAY re-queue (storage can recover) |
| `STORAGE_UNAVAILABLE` (413/other terminal) | fetch impossible | terminal `PROCESSING_FAILED` — reconcile MAY re-queue |
| `INTEGRITY_MISMATCH` | stored bytes ≠ recorded checksum | terminal — permanent for the stored bytes; reconcile does NOT re-queue |
| `UNSUPPORTED_FILE` / `CORRUPT_FILE` (verify 400) | content invalid | terminal — reconcile does NOT re-queue |
| `TENANT_MISMATCH` / `STALE_VERSION` / `ALREADY_PROCESSED` / `IN_FLIGHT` | scoping/validation | completed skip (no retry) |

`PROCESSING_FAILED` + a permanent category is excluded from the
reconcile scan, so a corrupt file cannot generate reconcile→retry
noise on every worker startup.

## Stale-state protection (defense in depth)

Every job re-fetches Mongo by `{_id, companyId}` and revalidates:
document (version + processingVersion + relationship + lease), BGV
(case status + consent + claim + polling attempt), reminders
(workflow status + per-type condition + state version). Queue removal
on reschedule/cancel/complete is best-effort hygiene only — a racing
job always degrades to a safe skip.

## Worker + reconciliation

- **Worker startup recovery** (28.4/28.5 pattern, non-fatal):
  `recoverPendingDocumentProcessing` (90-day window) +
  `recoverPendingBgvProcessing` (60-day window: missing submissions +
  overdue polls) run before the queues start serving.
- **`npm run queue:reconcile`** (new, dev/ops CLI, no HTTP endpoint):
  re-derives DOCUMENTS + BGV jobs from Mongo intent.
- **`npm run scheduled:reconcile`** (extended): now also re-derives
  the pre-onboarding + BGV reminder families (same SCHEDULED queue).
- Concurrency: `DOCUMENT_WORKER_CONCURRENCY` / `BGV_WORKER_CONCURRENCY`
  (default 2, clamped 1–8 — modest by design; external vendors must
  not be hammered).

## Verification

- **Hermetic unit tests (no live Redis/Mongo, full DI)**:
  - `test/documentProcessing.test.js` (15): job ids, strict payload,
    tenant/relationship/stale-version skips, claim semantics, honest
    NOT_CONFIGURED, integrity mismatch, terminal vs retryable
    categories, version-scoped writes, reconcile (DI), clamps.
  - `test/bgvQueue.test.js` (27): job ids, references-only payloads,
    consent gate (pending/declined — no provider call, no
    auto-reject), duplicate-submit prevention, INTERNAL-never-polls,
    bounded poll ladder + max window, result mapping, payload
    validation, reconcile (DI), cancel-builtin safety, reminder ids +
    eligibility + payload safety.
- **Full backend sweep: 23 suites / 274 tests, all green**
  (209 pre-existing + 42 new; `emailDelivery` count assertion updated
  8 → 10 email jobs).
- `node --check` on every new/edited file; `npm audit` → 0
  vulnerabilities (no `--force`); secrets scan of the diff clean;
  `.env` untouched. Frontend: zero changes (no frontend build
  required).

## Manual live ladder (developer's machine — Windows PowerShell)

```
# Terminal 1 — API (worker OFF while doing step 1)
npm run dev

# Terminal 2 — worker (now 7 workers: system, email, resume, ats,
# scheduled, documents, bgv)
npm run worker:dev
```

1. Upload a pre-onboarding document with the worker **off** → upload
   succeeds (synchronous path), version is `PENDING` (processing),
   scan status `NOT_CONFIGURED`. Start the worker → job runs, version
   becomes `PROCESSED`, scan stays `NOT_CONFIGURED`.
2. Start a BGV case with consent required → case stays
   `AWAITING_CANDIDATE`, `CONSENT_PENDING` skip in worker logs (no
   provider call). Candidate declines → case `REVIEW_REQUIRED` +
   history + HR notification. Consent granted (or not required) →
   `providerReference INTERNAL:<caseCode>` persisted, no polls.
3. Re-run `npm run queue:reconcile` + `npm run scheduled:reconcile` →
   idempotent (deterministic ids; "Nothing to do" when settled).
4. Redis outage during upload / BGV start → API succeeds (Mongo
   committed), worker logs a safe enqueue warning, reconcile re-queues
   after Redis returns — no HR re-creation.

## Security model

- No file bytes/URLs/keys, PII, evidence, or provider credentials in
  any job payload, id, or log (strict payload validation + safe log
  lines; connection errors redacted via `redactConnectionSecrets`).
- Multi-tenancy: every read/write is scoped `{_id, companyId}` from
  the payload; a cross-tenant id resolves to NOT_FOUND/TENANT_MISMATCH.
- No public endpoints (reconcile is CLI-only; no job/queue identifiers
  in any UI). No SMTP in the document/BGV workers — emails only via
  the 28.3 EMAIL queue. The secure candidate token portal is
  untouched; reminders carry no token.

## Known operational notes

- `bgvDispatcher.js` (27.15 synchronous shim) is retained but
  SUPERSEDED — the start flow schedules to the BGV queue instead.
- `BGV_PROCESS_RESULT` has no producer yet (future webhook entry);
  it validates + no-ops safely today.
- The reminder email for pre-onboarding intentionally omits a portal
  link/token (28.3 policy: token-bearing emails are synchronous); it
  points to the link in the original invite.
- Mongoose buffering: hermetic tests DI out ALL Mongo reads/writes —
  a leaked default model call costs a 10s buffering timeout (and the
  test fails or slows); keep new DI points in the processors.

## 28.7 handoff (Analytics Cache)

Carry-over candidates for the next phase (NOT built in 28.6):

1. **Analytics cache** — recruitment analytics read models are
   computed on demand; a bounded SCHEDULED/processing-cache refresh
   (TTL + invalidation on the business events now recorded in
   history/timeline) is the natural next queue workload.
2. **Queue operations UI** — still out of scope by explicit request;
   if ever added: read-only, reference-based, no job data in the UI.
3. **Watch items** — 7-worker process health (one ioredis per
   worker); BGV poll volume if an external provider is configured
   (per-vendor rate limits may need `queueConfig` tuning); scanner
   configuration (a real scanner flips `NOT_CONFIGURED` → real
   verdicts automatically — no code change).
