# Phase 30.7 — BGV Check Assignment & Verifier Workspace

## Scope

Connects the candidate's submitted BGV package (30.5) to internal verifiers
(30.6) through **check-level assignment**. This phase ships operational
assignment + a minimum-data verifier workspace ONLY. It intentionally does
NOT include (deferred to Phase 30.8+):

- Verification conclusions/results (PASS/FAIL/VERIFIED)
- Actual per-check verification execution
- Contacting institutions / employers / references
- DigiLocker API integration or verification labels
- Additional-info requests, QA, final reports, findings submission

## Relationship to the legacy 27.15 flow

The legacy `BackgroundVerificationCase` model (Phase 27.15) has a
**case-level** `assignedVerifier` referencing a tenant `User`. That belongs
to the old tenant-driven BGV flow and is untouched. Phase 30.7 introduces a
separate assignment layer for the Phase-30 pipeline
(`BgvOrder → BgvCollectionCase → BgvVerifier`), where verifiers are internal
Crewly principals (`BgvVerifier`), never tenant users. The two never mix.

## Data model — `BgvCheckAssignment`

- One document per `(bgvOrder, checkType)` with `activeKey: 'CURRENT'`;
  a **partial unique index** `{ bgvOrder, checkType, activeKey }` guarantees
  exactly one authoritative current assignment per purchased check.
- `verifier` → `BgvVerifier`; `status` ∈ `ASSIGNED | IN_PROGRESS`
  (operational only — no conclusion states).
- Embedded immutable `history[]`: `ASSIGNED / REASSIGNED / UNASSIGNED /
  STARTED` with `verifierFrom/verifierTo/actor/at/reason`. Reassignment
  appends; nothing is silently overwritten.
- No candidate PII is copied — companyId/candidate/order are references;
  the authoritative `BgvCollectionCase`/`BgvEvidenceFile` records remain the
  single source of truth.

## Readiness gates (backend-authoritative)

Assignment requires ALL of:

1. Order exists and `isCommerciallyAuthorized` (single 30.4 boundary).
2. Check is in the immutable `order.items` snapshot (purchased-checks-only).
3. Latest consent token `finalDecision === 'CONSENTED'` (30.4).
4. `BgvCollectionCase.status === 'SUBMITTED'` (30.5).
5. Verifier `status === 'ACTIVE'`.
6. Verifier specialization includes the check type.

**Specialization is eligibility, not authorization.** A specialized verifier
with no assignment sees zero candidate data.

## Authority

- **Assign/reassign/unassign:** platform operators only —
  `POST /api/super-admin/bgv-operations/{assign,reassign,unassign}` behind
  `protect + superAdminSession + permit('bgv-operations:manage')`. The new
  `bgv-operations:*` permissions are held only by `SUPER_ADMIN` (via `*`).
  Tenant tokens are rejected at the platform gate before platform data is
  read; tenant RBAC is never an authority here.
- **Verifier workspace:** `requireVerifierAuth` only; identity comes from
  the session principal (`req.verifier._id`) — `req.query.verifierId` is
  never accepted. There are no assignment-management routes on the verifier
  surface.
- **Tenant HR:** `GET /api/recruitment/candidates/:candidateId/bgv-assignment-status`
  returns per-check `UNASSIGNED / ASSIGNED / IN_PROGRESS` only — no internal
  verifier identity, no evidence, no management controls.

## Concurrency

- Create: unique-index insert; duplicate-key (11000) is resolved
  idempotently for the same verifier, otherwise 409.
- Reassign/unassign/start: atomic conditional `findOneAndUpdate`
  (matching `activeKey: 'CURRENT'` and, where required, the expected
  status) with a `$push` to history. A lost race returns 409 — never a
  silent overwrite.

## Reassignment & unassignment

- Reassignment: reason required; new verifier revalidated (ACTIVE +
  specialization); allowed while the assignment is non-terminal; audited;
  history chain preserved.
- Unassignment: allowed only while `status === 'ASSIGNED'` (work has not
  materially started). Once `IN_PROGRESS`, reassignment is the only path.
- Former verifiers lose access **immediately** — authorization re-reads the
  CURRENT row on every request; history grants nothing.
- Deactivated verifiers: cannot log in (30.6 revokes all sessions/tokens),
  cannot receive assignments, and their outstanding work is flagged in the
  operations queue (`DEACTIVATED` badge) so an operator can explicitly
  reassign. There is no silent auto-reassignment.

## Verifier workspace ("My Verification Work")

- `GET /api/bgv-verifier/work` — only CURRENT assignments of the
  authenticated verifier. Rows carry work reference, safe candidate display
  name, company, check type, assignment date, operational state, submission
  date. No identifiers, evidence, or payment data.
- `GET /api/bgv-verifier/work/:orderId/:checkType` — backend-projected
  minimum-data DTO per check type:
  - IDENTITY → identity context (legal name, DOB, doc type, masked
    identifier, `provenance: candidate-provided`) + IDENTITY files
    (incl. selfie when collected)
  - ADDRESS → address data + candidate name
  - EDUCATION → education records + EDUCATION files
  - EMPLOYMENT → employment records + EMPLOYMENT files
  - REFERENCE → reference records (no files)
- `POST /api/bgv-verifier/work/:orderId/:checkType/start` — operational
  `ASSIGNED → IN_PROGRESS`, idempotent, audited. NOT a conclusion.
- `GET /api/bgv-verifier/work/files/:fileId` — streams evidence ONLY when
  the file's case/order carries a CURRENT assignment to this verifier for
  the file's own check type. Private storage, `Cache-Control: no-store`,
  `Content-Disposition: attachment`, checksum header; audited
  (`BGV_EVIDENCE_READ_VERIFIER`, safe metadata only). No public URLs, no id
  guessing.

## Super Admin UI

`/super-admin/bgv-operations` — operations queue over submitted cases ×
purchased checks with UNASSIGNED/ASSIGNED/IN_PROGRESS + check-type filters,
eligible-verifier selection (ACTIVE + specialization, backend-filtered),
assign/reassign (reason required)/unassign dialogs, deactivated-verifier
flagging. Queue rows are safe operational context only — no raw documents.

## Notifications

No new notification infrastructure was added. Verifier-facing "new
assignment" notifications (refs-only, no PII) are a documented follow-up
when the internal principal notification channel is designed.

## Audit actions (safe metadata only)

`BGV_CHECK_ASSIGNED`, `BGV_CHECK_REASSIGNED`, `BGV_CHECK_UNASSIGNED`,
`BGV_CHECK_STARTED`, `BGV_EVIDENCE_READ_VERIFIER` — order code, check type,
verifier id, phase. Never tokens, filenames content, storage keys,
Aadhaar/PAN/UAN, selfie data, addresses, or payment details.

## Tests

`Backend/test/bgvAssignment.test.js` — 12 hermetic node:test cases covering
§34 behaviors 1–53 (readiness 1–5, eligibility 6–9, authorization 10–13,
concurrency 14–16, reassignment 17–21, queue 22–25, detail 26–31, files
32–37, deactivation 38–40, business safety 41–46, structural 47–53).
Run: `npm run test:bgv-assignment`. Full suite: `npm run test:all`.

## Explicitly NOT implemented

No seeding scripts. No conclusion states or forms. No external contacting.
No DigiLocker verification. No payment/pricing exposure to verifiers. No
candidate pipeline mutation. Phase 30.8 must not be started before 30.7
acceptance.
