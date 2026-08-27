# Phase 27 — Enterprise RMS + ATS (Crewly)

Final integration reference for Phase 27.1–27.16.

## Lifecycle

```text
Requisition → Approval → Job Opening → Career Portal Apply
  → Resume Upload → Parse → ATS Score
  → Pipeline / Interviews / Feedback
  → Human Final Selection
  → Offer (approve → PDF → secure portal) → Accept
  → Pre-Onboarding (docs verify) → BGV (optional policy)
  → READY_TO_JOIN → Convert to Employee
  → Secure account setup → EmployeeLifecycle onboarding
```

## Entity map (actual models)

```text
Company
├── JobRequisition
│     └── JobPosting (sourceRequisition)
│           └── Candidate
│                 ├── CandidateResume → ResumeParseResult
│                 ├── ATSResult
│                 ├── CandidatePipelineHistory / CandidateHistory
│                 ├── Interview → InterviewFeedback
│                 ├── OfferLetter (+ OfferAccessToken, OfferHistory, OfferTemplate)
│                 ├── PreOnboarding
│                 │     ├── CandidateDocumentRequirement (snapshot)
│                 │     └── CandidateDocument → CandidateDocumentVersion
│                 ├── BackgroundVerificationCase
│                 │     └── BackgroundVerificationCheck (+ History)
│                 ├── CandidateEmployeeConversion
│                 └── User (Employee) via convertedUser / candidateId
└── BackgroundVerificationSettings / CheckType
```

**Note:** Crewly has no separate `Employee` collection. Employees are `User` records with payroll/profile fields.

## Public APIs (unauthenticated)

| Mount | Authority | Mutations |
|---|---|---|
| `/api/public/careers/:companySlug…` | Company slug | Read published jobs; apply POST |
| `/api/public/candidate/offers/:secureToken…` | Offer token hash | GET read-only; POST view/accept/reject |
| `/api/public/candidate/pre-onboarding/:secureToken…` | Pre-onboarding token hash | GET read; POST view/upload |
| `/setup-account?token=` (frontend) → `/api/auth/reset-password` | PasswordResetToken hash | Password set only |

GET must never finalize decisions (offer accept/reject are POST only).

## Token types

| Token | Storage | Scope |
|---|---|---|
| Offer access | SHA-256 only | Offer portal |
| Pre-onboarding access | SHA-256 only | Pre-onboarding portal |
| Account setup | PasswordResetToken hash | Password establish / reset |

Raw tokens are never persisted. Rate limits key on token hash + IP.

## Pipeline stages

Positive: `APPLIED` → … → `SELECTED` → `OFFER` → `OFFER_ACCEPTED` → `PRE_ONBOARDING` → `JOINED`  
Disposition: `REJECTED` / `HOLD` / `WITHDRAWN`

All mutations go through `transitionCandidateStage` with authorized workflow actions.

## Human decisions (non-negotiable)

- ATS does **not** shortlist/reject
- Interview scores do **not** select/reject
- BGV discrepancy does **not** reject
- Conversion requires HR confirmation after `READY_TO_JOIN`

## Secure conversion

Use:

```text
POST /api/recruitment/candidates/:candidateId/convert-to-employee
```

Legacy:

```text
POST /api/recruitment/candidates/:id/convert
```

is **retired** (returns 400). No temporary passwords.

## BGV

- Internal provider works without vendors
- Provider registry + dispatcher ready for Phase 28 plugins + BullMQ
- Optional gate: `bgvRequiredBeforeConversion` on settings

## Key permissions (current roles only)

| Area | Examples |
|---|---|
| Requisition | `REQUISITION_*` |
| Candidate | `CANDIDATE_*`, `CANDIDATE_FINAL_DECISION`, `CANDIDATE_CONVERT` |
| Interview | `INTERVIEW_*`, `INTERVIEW_FEEDBACK_*` |
| Offer | `OFFER_*`, `OFFER_TEMPLATE_*` |
| Pre-onboarding | `PRE_ONBOARDING_*` |
| BGV | `BACKGROUND_VERIFICATION_*` |
| Analytics | `RECRUITMENT_ANALYTICS_READ` |

`SYSTEM_PERMISSION_VERSION` migrates defaults via atomic `$addToSet` (no role.save loops).

No `HR_HEAD` / `HR_EXECUTIVE` in Phase 27.

## File security

| Asset | Storage | Scan claim |
|---|---|---|
| Resume | Private Cloudinary / local private | `NOT_CONFIGURED` unless real scanner |
| Offer PDF | Authenticated private | N/A |
| Pre-onboarding docs | Private | `NOT_CONFIGURED` unless real scanner |

No permanent public URLs; storage keys are `select: false`.

## Phase 28 queue inventory (not implemented)

| Job | Trigger today | Payload refs only |
|---|---|---|
| `RESUME_PARSE` | Application / reprocess dispatcher | companyId, resumeId, candidateId |
| `ATS_PROCESS` | After parse / reprocess | companyId, candidateId, jobId |
| `RECRUITMENT_EMAIL` | Mailer call sites | companyId, template, entityId |
| `INTERVIEW_NOTIFICATION` | Schedule/reschedule | companyId, interviewId |
| `OFFER_PDF_GENERATE` | Approve | companyId, offerId |
| `OFFER_SEND` | Send | companyId, offerId |
| `DOCUMENT_SCAN` | Upload hooks | companyId, documentVersionId |
| `BGV_VENDOR_SUBMIT` / `BGV_VENDOR_POLL` | BGV dispatcher | companyId, caseId |
| `ACCOUNT_SETUP_EMAIL` | Conversion | companyId, userId |
| `ANALYTICS_REFRESH` | Optional cache | companyId, range |

Workers must re-fetch Mongo state. Never put binaries, raw tokens, passwords, or SMTP secrets in Redis payloads.

## Tests

```bash
cd Backend
node --test test/*.test.js
npm run test:bgv
npm run test:conversion
npm run test:recruitment-analytics
```

Frontend:

```bash
cd Frontend && npm run build
```
