# Hotfix after Phase 30.3 — offer portal blank page, ATS stall, scorecard UX

Three issues found during localhost acceptance of 30.3; all fixed forward.

## 1. Public offer portal rendered a blank white page

**Root cause (reproduced headlessly):** `CandidateOfferPortalPage` rendered
`offer.candidate.name`, `offer.company.name`, `offer.terms.…` unguarded, and
`publicOfferService.publicDto` emitted `company: undefined` /
`compensation: undefined` for offer documents created before the snapshot
fields existed. One undefined access throws during render; with no error
boundary React unmounts the root → fully white page, zero subsequent
requests.

**Fix:**
- Backend `publicDto` now always emits a safe shape (fallback candidate
  name, `company: { name }`, `terms` object, zeroed compensation block).
- Frontend portal page uses defensive locals (`offer.candidate?.name`,
  `offer.terms || {}`, `offer.document?.fileName`); no nested access can
  blank the page again.
- Verified with a headless jsdom render harness
  (`Frontend/scripts/diagnose-offer*.mjs`, dev-only): a minimal legacy DTO
  `{ offerCode, status }` crashed before the fix and renders after it.

## 2. ATS stuck at "Waiting for resume parsing" forever

**Root cause:** MongoDB `parsingStatus: PENDING` is the durable dispatch
intent and BullMQ is best-effort transport. When the job is lost (enqueue
while Redis was down in degraded mode, or the worker started before the
upload), recovery only ran at **worker startup** or via
`npm run processing:reconcile` — a running worker never picked the intent
up. Meanwhile `requestResumeReprocess` 409'd on any PENDING status and the
UI hid the Reprocess button while PENDING → dead end.

**Fix:**
- `RESUME_RECOVERY_MIN_AGE_MS` (60 s) is now the shared staleness threshold
  (`config/queueConfig.js`).
- The `resume/parsed` poll detects a stale PENDING/RETRY_PENDING intent and
  re-dispatches the deterministic BullMQ job id (idempotent; never throws;
  no-op when the queue is down). The existing 60 s UI poll therefore
  self-heals a stuck parse while the worker runs.
- `reprocessAvailable` and a new `stalePending` flag are returned, and the
  ATS pending card shows a **"Reprocess resume"** button.
- `requestResumeReprocess` now allows stale PENDING/RETRY_PENDING instead
  of a blanket 409. PROCESSING keeps its 409 — the worker lease owns that
  state and lease-expiry recovery handles crashed workers.
- Hermetic tests: `test/resumeSelfHeal.test.js` (4) + updated
  `test/resumeParsing.test.js` (9).

Operator note: parsing/ATS still require the worker process
(`npm run worker:dev`) and Redis — that architecture is unchanged since
Phase 28. The fix removes the *silent dead end*, not the worker.

## 3. Interview scorecard "Complete all required criteria" dead end

The 400 itself is correct backend validation (the submission contained no
ratings). The UX trap: the confirm step opened anyway and the error banner
sat out of scroll. The modal now pre-checks required criteria +
recommendation client-side and shows the missing list at the footer before
opening the confirm step. Backend remains the authority.

## Verification

- `npm run test:all` → 885/885 (includes 4 new self-heal tests).
- Frontend `npm run build` ✓.
- Headless offer-portal render harness: legacy minimal DTO renders.
