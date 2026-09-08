# Phase 30.10 — Internal BGV QA Review & Final Report Release

Status: **IMPLEMENTED, awaiting manual localhost acceptance.** Phases 30.11 (ops/SLA), 30.12 (hardening), direct
DigiLocker API, billing modes and criminal checks are **NOT** implemented.

## Purpose & boundary

Verifier submits per-check findings → Crewly internal QA reviews → approve or return for correction → when **all**
purchased checks are QA-approved the immutable report is generated → an authorized platform actor **explicitly
releases** it → tenant HR views/downloads it and makes the employment decision. A verifier conclusion is never a
customer-facing report by itself.

## QA authority (existing platform architecture)

- QA is a Crewly/Infolexus **platform** function. Routes mount on `superAdminRoutes` behind
  `router.use(protect, superAdminSession)` + `permit('bgv-qa:review' | 'bgv-qa:release')`.
- New exact permissions `bgv-qa:review` / `bgv-qa:release` added to `PLATFORM_PERMISSIONS.PLATFORM_ADMIN`;
  `SUPER_ADMIN` holds them via `*`; any other platform user can be granted them through the existing
  `User.platformPermissions` override field. **No tenant User, no verifier principal, no seeding.**
- Verifiers (30.6 `BgvVerifier` sessions) and tenant HR (`protect` + tenant permission middleware) live on separate
  session stacks — they structurally cannot reach QA routes.
- Separation of duties: the QA actor is a platform `User`; a verifier is a `BgvVerifier` — different principal types,
  so the verifier can never QA-approve their own finding; the verifier workbench has no release control.

## QA queue & detail (`bgvQaReportService.qaQueue/qaDetail`)

Only **verifier-submitted** work appears. Collection-pending, consent-pending, unpaid, unassigned, unfinished and
(non-blocking) returned work are filtered by construction. Filters: status (awaiting/returned/approved), check type,
conclusion, order code. Detail carries tenant/candidate safe context, purchased checks, activities, discrepancies,
evidence **metadata** (bytes via the audited `.../evidence/:fileId` route), 30.9 info-request history, submission
revisions and QA state. No storage keys or URLs in any response.

## Decisions & revisions

- `qaApprove` — atomic conditional write on `(state SUBMITTED, qaStatus PENDING, qa.currentRevision)`; idempotent.
- `qaReturn` — reason required (≥10 chars); sets `QA_RETURNED` (new operational state) and records the reason on the
  submission **and** the live mirror. The original submission is never deleted.
- Verifier correction: the 30.8 lock guards only throw on `SUBMITTED`, so `QA_RETURNED` work is correctable; the next
  `submitConclusion` appends **revision N+1** to the append-only `submissions[]` array (`defaultSubmitConclusion`
  conditional write), resets QA to `PENDING`, and returns the check to the queue. v1..vN stay immutable.
- Approved revisions are terminal: QA cannot return them and the verifier cannot resubmit over them.

## Readiness engine (`evaluateReportReadiness`, pure rules)

Report generate/release requires: every purchased check has a QA-**approved** submission (latest revision), and **no
OPEN 30.9 info request**. Enforced in the backend at both `generateReport` and `releaseReport` — a manipulated
frontend cannot bypass it.

## Consolidated outcome (Phase 27.15 semantics reused verbatim)

`computeOverallOutcome` over approved conclusions only: any `UNABLE_TO_VERIFY`/`INCONCLUSIVE` → `HOLD`; else any
`VERIFIED_WITH_DISCREPANCY` → `CLEAR_WITH_DISCREPANCIES`; else all `VERIFIED` → `CLEAR`. **No REJECTED concept; zero
candidate-pipeline mutations** (no `currentStage`, no offer withdrawal, no auto-hire).

## Final report (`BgvFinalReport`)

- Immutable snapshot frozen at generation: tenant/candidate names, **masked** identity (`identifierMasked`), approved
  check conclusions + revision, methods (DigiLocker rendered as "DigiLocker / issuer-assisted manual verification"),
  discrepancies, completion dates, disclaimer, overall outcome. No QA notes, tokens, payment data, raw evidence.
- `reportNumber` = `BGVRPT-000123` via the existing `TenantSequence` convention (`nextBgvReportCode`); unique index
  `(bgvOrder, version)`; reissue = new version, old versions preserved.
- PDF: `buildBgvReportPdf` (PDFKit, payslip pattern) rendered **only from the stored snapshot** → private storage
  (`storeBgvEvidence`), sha256 checksum, safe filename, `storageKey` is `select:false` and never in responses.
- Failure safety: PDF/storage failure → `pdf.status = FAILED`, report stays `GENERATED`, release refused, safe
  `pdf-retry` re-renders deterministically; QA state and findings untouched.
- **GENERATED ≠ RELEASED**: tenant endpoints return nothing until `status === 'RELEASED'`; release is an explicit,
  idempotent conditional write, audited.

## Tenant HR access

`GET /api/recruitment/candidates/:candidateId/bgv-final-report[/download]` behind
`requirePermission('BACKGROUND_VERIFICATION_READ')`; authority is **`req.companyId` only** (the lookup query is
company-scoped; body/query companyId is never read). Downloads stream with `private, no-store` + `nosniff` +
attachment headers; tenant downloads audited (`BGV_FINAL_REPORT_DOWNLOADED`).

## Audit (safe metadata only)

`BGV_QA_APPROVED`, `BGV_QA_RETURNED`, `BGV_QA_EVIDENCE_READ`, `BGV_REPORT_GENERATED`, `BGV_REPORT_PDF_FAILED`,
`BGV_REPORT_RELEASED`, `BGV_REPORT_DOWNLOADED_INTERNAL`, `BGV_FINAL_REPORT_DOWNLOADED`, plus the 30.8
`BGV_CHECK_CONCLUSION_SUBMITTED` now carrying `revision`. Never: report bodies, identifiers, URLs, tokens, payments.

## Frontend

- `SuperAdminBgvQaPage` (`/super-admin/bgv-qa`, "BGV QA Review" nav): queue + filters, review detail (activities,
  discrepancies, private evidence downloads, revision history, 30.9 history), Approve / Return-for-correction with
  reason, readiness panel, Generate / Retry PDF / Release / Download. No hire/reject controls anywhere.
- Verifier workbench: `QaReturnPanel` — returned reason + read-only revision history; correction happens through the
  normal unlocked forms and resubmission creates the next revision.
- Tenant HR: `FinalReportCard` in `BgvPurchasePanel` appears **only after release** (reference, version, outcome,
  per-check summary, disclaimer, private View/Download).

## Tests & build

`test/bgvQaReport.test.js` — 10 hermetic tests covering §33 items #1–69 (access, readiness, approval, return/revision,
consolidation, report/PDF/retry, release/tenancy, data security, DigiLocker wording, business boundary, regression
wiring). `npm run test:all` → **995/995**. Frontend `vite build` → clean.

## Localhost acceptance (Windows PowerShell)

```powershell
cd C:\path\to\HRMS_Crewly\Backend
npm run dev
# second window:
cd C:\path\to\HRMS_Crewly\Frontend
npm run dev
```

A. Complete the 30.1–30.9 flow with synthetic data; verifier submits findings.
B. Platform account with `bgv-qa` (SUPER_ADMIN works): open `http://localhost:5173/super-admin/bgv-qa` — submitted
   work listed; unfinished work absent.
C. Approve a clean VERIFIED check; refresh persists; candidate untouched.
D. Return another check without reason (blocked), then with reason; verifier sees "Returned by QA", corrects,
   resubmits (v2), QA approves v2; v1 remains in history.
E. Leave one check unapproved → Generate blocked; approve all → eligible.
F. Generate with all VERIFIED → CLEAR; inspect PDF (tenant, candidate, reference, methods, no raw IDs/payments/QA notes).
G. A case with an approved discrepancy → CLEAR_WITH_DISCREPANCIES; candidate not rejected.
H. A case with approved UNABLE_TO_VERIFY → HOLD; HR still sees the report.
I. Before release: tenant HR sees nothing; after explicit release: report appears (generated ≠ released).
J. Tenant download: private attachment; another tenant gets 404.
K. DIGILOCKER_ISSUER_ASSISTED check → PDF says "DigiLocker / issuer-assisted manual verification".
L. Order/payment state unchanged after generate/release (no second charge).
M. HR confirms no automatic hire/reject/withdraw for any outcome.
N. Regression: 30.1–30.9 flows still work.

## Known limitations

Report reissue UI is minimal (version architecture exists; reissue is service-level). QA SLA/analytics deferred to
30.11. Candidate-facing report sharing deferred.
