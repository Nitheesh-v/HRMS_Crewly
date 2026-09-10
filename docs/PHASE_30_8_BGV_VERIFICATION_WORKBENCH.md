# Phase 30.8 — Internal BGV Verification Workbench

## Scope

The assigned internal verifier can now actually work a BGV check:
structured verification activities (attempts), structured findings,
discrepancies, and a validated final conclusion per check. Supported checks:
IDENTITY, ADDRESS, EDUCATION, EMPLOYMENT, REFERENCE.

**Explicitly NOT implemented:** Phase 30.9 additional-information workflow,
Phase 30.10 QA/final tenant report release, Phase 30.11 operations/SLA
expansion, **direct DigiLocker API integration**, criminal/court checks,
future billing modes.

## Architecture (no competing state machine)

- **`BgvCheckVerification`** — one CURRENT row per `(bgvOrder, checkType)`
  (same partial-unique pattern as 30.7 assignments). Holds operational
  `state` (`IN_PROGRESS / AWAITING_THIRD_PARTY / SUBMITTED`), append-only
  `activities[]`, append-only `discrepancies[]`, and a write-once
  `conclusion`.
- **Authorization** reuses the 30.7 chain verbatim (`loadOwnAssignment`):
  authenticated verifier session → CURRENT assignment to the exact check →
  valid order/workflow state. Specialization alone grants nothing; former
  verifiers lose access immediately; deactivated accounts cannot hold
  sessions (30.6). `req.body.verifierId` / `req.query.verifierId` are never
  read.
- **Status vs conclusion are separate concepts.** Operational state never
  encodes a result; conclusions never appear as workflow states. `FAILED`
  does not exist anywhere.

## Controlled method registry (backend-authoritative)

`bgvWorkbenchRules.js` defines per-check allowlists (exact names), per-method
outcome allowlists, and per-method structured observation schemas. Unknown
methods/outcomes → 400; unknown observation fields are dropped; forbidden
keys (password/otp/credentials/token/lat/lng/gps/aadhaar/pan/uan) → 400.

- IDENTITY: DOCUMENT_REVIEW, SELFIE_MANUAL_COMPARISON (explicitly manual —
  no automated facial recognition/biometrics), CROSS_DOCUMENT_CONSISTENCY,
  QR_ISSUER_VERIFICATION, DIGILOCKER_ISSUER_ASSISTED, MANUAL_VIDEO_VERIFICATION
  (recorded only; video never auto-stored)
- ADDRESS: DOCUMENT_REVIEW, TELEPHONE_VERIFICATION, FIELD_VERIFICATION
  (no GPS/geolocation fields exist; nothing faked)
- EDUCATION: CERTIFICATE_REVIEW, INSTITUTION_PORTAL, INSTITUTION_EMAIL,
  INSTITUTION_PHONE, DIGILOCKER_ISSUER_ASSISTED
- EMPLOYMENT: DOCUMENT_REVIEW, OFFICIAL_HR_EMAIL (official-domain flag —
  personal email is an attempt source only, never mislabelled),
  HR_TELEPHONE, SUPPORTING_SALARY_EVIDENCE (consistency only; amounts never
  stored), UAN_EPFO_SUPPORTING_EVIDENCE (**last four digits only**;
  supporting evidence; never a sole basis — readiness engine refuses
  VERIFIED on supporting-only methods)
- REFERENCE: TELEPHONE_REFERENCE, EMAIL_REFERENCE (standardized structured
  questionnaire: relationship, period known, role, strengths, reliability,
  professional behavior, rehire eligibility, comments — no
  protected-characteristic questions; unknown/sensitive fields dropped),
  RELATIONSHIP_AUTHENTICITY_CHECK

## Activity/attempt history

Atomic pipeline appends with monotonic `seq`; attempts preserve method,
outcome, verifier, timestamp, sanitized structured observations, notes
(≤2000 chars, rendered as escaped text — never HTML), and optional evidence
reference. Attempt 2 never overwrites Attempt 1. An attempt outcome
(e.g. NO_RESPONSE) is never the check conclusion and never an automatic
candidate failure ("fake degree" inference does not exist).

## DigiLocker boundary

DIGILOCKER_ISSUER_ASSISTED records a **manual / issuer-assisted**
verification of candidate-provided material: origin representation, issuer,
mechanism, timestamp, and exactly what was established. There is **no
DigiLocker API integration**, no client id/secret env requirements, no
login/OTP/scraping, and uploaded PDFs are never auto-labelled
"DIGILOCKER VERIFIED". Direct API integration is a future phase requiring
Infolexus onboarding/approval and official documentation.

## Email / telephone contacts

External-contact automation is **not** implemented: verifiers record
manually sent/received email and manually made phone calls through the
attempt history (channel, date/time, outcome, safe recipient descriptor,
notes). No telephony integration, no fabricated call records, no SMTP
coupling, no new BullMQ queues (payload policy unchanged: refs only). This
is a documented 30.8 limitation.

## Conclusion readiness engine (backend)

- VERIFIED → ≥1 substantive-outcome activity from a PRIMARY method
  (supporting UAN/salary evidence excluded) + zero recorded discrepancies
  (otherwise VERIFIED_WITH_DISCREPANCY is required).
- VERIFIED_WITH_DISCREPANCY → ≥1 complete structured discrepancy
  (field / candidate-claimed / source-confirmed / severity INFO|MINOR|MAJOR
  / explanation) + ≥1 activity.
- UNABLE_TO_VERIFY → reason (≥10 chars) + recorded attempt context.
- INCONCLUSIVE → explanation (≥10 chars).
- CANCELLED → **Super Admin only** (`POST /api/super-admin/bgv-operations/cancel-check`,
  reason ≥10 chars); excluded from verifier choices by design.

## Submission locking

Submission is an atomic conditional write (`conclusion: null` filter).
Afterwards activities/discrepancies/state/evidence are locked (409); the
same verifier resubmitting the same conclusion is idempotent; anything else
409s. No delete/overwrite path exists. 30.10 QA review will add the
controlled correction workflow.

## Human-decision boundary (non-negotiable)

A conclusion is a BGV finding. Nothing in 30.8 mutates
`candidate.currentStage`, rejects/selects/hires, converts to User, or
withdraws offers. One check being VERIFIED never marks the whole BGV CLEAR;
per-check completion is tracked and 30.10 owns consolidated reporting.
Tenant HR sees only per-check state (now including "Submitted for
review") — never draft notes or internal findings.

## Verifier evidence

Verifier-created evidence (official responses, issuer-verification
screenshots, field photos) reuses the 30.5 posture: hardened
`preOnboardingUpload` multer (PDF/JPG/PNG/WEBP allowlist, size limit),
`storeBgvEvidence` private storage (authenticated Cloudinary or 0600 local),
`BgvVerifierEvidenceFile` with `storageKey/checksum select:false`,
assignment-scoped download, audit (`BGV_VERIFIER_EVIDENCE_UPLOADED/READ`,
safe metadata). No public URLs.

## Audit

`BGV_CHECK_ACTIVITY_RECORDED`, `BGV_CHECK_DISCREPANCY_RECORDED`,
`BGV_CHECK_CONCLUSION_SUBMITTED`, `BGV_CHECK_CANCELLED`,
`BGV_VERIFIER_EVIDENCE_UPLOADED`, `BGV_VERIFIER_EVIDENCE_READ` — safe
metadata only (order code, check, method, outcome, conclusion enum,
verifier id). Never notes content, identifiers, UANs, filenames, storage
keys, or credentials.

## API surface

Verifier (all `requireVerifierAuth`, identity from session):
- `GET /api/bgv-verifier/work/:orderId/:checkType` (detail now includes `workbench`)
- `POST …/activities`, `…/discrepancies`, `…/state`, `…/submit`
- `POST …/evidence` (multipart), `GET /api/bgv-verifier/work/evidence/:fileId`

Super Admin: `POST /api/super-admin/bgv-operations/cancel-check`
(`permit('bgv-operations:manage')`).

## Frontend

Check-specific workbench inside the existing check-detail page (only the
assigned check's form ever renders): method selector from the registry
mirror, structured per-method forms (no giant free-text box), append-only
timeline, verifier evidence attach/download, structured discrepancy panel,
conclusion panel with hints + confirmation + locked/read-only state,
AWAITING_THIRD_PARTY toggle. Super Admin ops queue gained FINDINGS
SUBMITTED / AWAITING 3RD PARTY chips and the platform Cancel-check dialog.
HR panel gained the "Submitted for review" badge. Dark Crewly theme,
Lucide icons, React FC + Tailwind, no `dangerouslySetInnerHTML`.

## Tests

`Backend/test/bgvWorkbench.test.js` — 12 hermetic node:test cases covering
§34 behaviors 1–69 (authorization 1–6, registry 7–13, history 14–18,
identity 19–23, address 24–26, education 27–31, employment 32–37,
reference 38–42, conclusions 43–50, security 51–61, cancellation/view,
regression map 62–69). Run `npm run test:bgv-workbench`; full suite
`npm run test:all` (974 passing at delivery).

## Known limitations

- External-contact email/telephony automation: recorded manually (above).
- No verifier-facing notification channel yet (deferred with 30.7).
- QA review/return of submitted findings: Phase 30.10.
- Direct DigiLocker API: NOT implemented (future phase).
