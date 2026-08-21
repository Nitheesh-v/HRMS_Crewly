# Phase 27 — Recruitment (RMS) + ATS — Build Plan

Status: PLAN ONLY. No code written yet. Approve before Batch A.

---

## 0. What already exists in this repo (inspected, not assumed)

| Area | Finding | Decision |
|---|---|---|
| `Backend/src/models/JobPosting.js` (23 lines) | title, department, location, employmentType, openings, description, status `OPEN/CLOSED` | **Extend, do not replace.** Keep `OPEN/CLOSED` values valid so `RecruitmentPage.jsx` keeps working; add `DRAFT / PENDING_APPROVAL / PUBLISHED / PAUSED / CLOSED / ARCHIVED`. |
| `Backend/src/models/Candidate.js` (34 lines) | job, name, email, stage `APPLIED…HIRED/REJECTED`, offerStatus, `convertedUser`, unique index `{job,email}` | **Split.** `Candidate` becomes the person (company-unique by email); a new `JobApplication` collection holds job-specific data. Legacy fields kept + back-filled so old UI does not break. |
| `recruitmentController.js` (193) / `recruitmentRoutes.js` (132) | protect → tenantContext → checkSubscriptionStatus → requireFeature('recruitment'), permissions `RECRUITMENT_*`, `CANDIDATE_*`, usage limits `jobPostingsMonthly`, `recruitmentCandidatesMonthly` | Keep untouched as the legacy surface. New endpoints mount under the same router file group with the same middleware chain. |
| `permissionRegistry.js` | Has `RECRUITMENT_*`, `CANDIDATE_*`, `INTERVIEW_*` | Add resources `REQUISITION`, `OFFER`, `ONBOARDING`, `ATS`. |
| `permissionService.js` | `SYSTEM_PERMISSION_VERSION = 3`, atomic migration | Bump **3 → 4**, `findOneAndUpdate` + `$addToSet` only (never `role.save()`). |
| `uploadMiddleware.js` | multer memory, image 2MB / doc 5MB, PDF+images only | Add `resumeUpload` (PDF + DOCX, 5MB) and `candidateDocUpload` — same wrap/400 pattern. |
| `config/cloudinary.js` | `cloudinaryReady` flag + dev fallback | Reuse. Resumes go to Cloudinary `raw` with `type: authenticated`; dev fallback = local `Backend/uploads/private/` served only through an authorised controller. |
| `utils/mailer.js` | MOCK when no SMTP, `sendMail` never throws, `shell()` HTML template | Reuse. Add `recruitmentMailer.js` with the ~20 templates on top of `shell()`. |
| `utils/notify.js` | `notifyUser`, `notifyRoles` | Reuse for all in-app recruitment notifications. |
| `models/AuditLog.js` + `middlewares/auditTrail.js` | requires `method` + `path` | Reuse; recruitment writes go through a `recruitmentAudit()` helper that always fills method/path. |
| `Company.code` | unique, lowercase (e.g. `infolexussol`) | Public career page URL = `/careers/:companyCode`. |
| Frontend | `PublicLayout`, `RequireAuth`, `RequireRole`, `RequirePermission`, `Can.jsx`, `Modal.jsx`, Redux, Lucide | Reuse all. No new auth, no PermissionContext. |
| Backend deps present | pdfkit (offer PDF ✅), multer, nodemailer, cloudinary | Need to add: `pdf-parse`, `mammoth` (DOCX). Parser uses **dynamic import with graceful fallback** so a missing dep degrades to "parse failed → manual entry", never a 500. |

---

## 1. Multi-tenant behaviour — how it works when many companies and many HRs use it

### 1.1 Tenant isolation
Every new collection carries `companyId` (indexed, required). Every query is built by a shared helper:

```
const scope = (req, extra = {}) => ({ companyId: req.companyId, ...extra });
```

`req.companyId` comes only from the JWT via `tenantContext`. `req.body.companyId` / `req.query.companyId` are never read for authorisation. Compound indexes are always `{ companyId, ... }`.

**Public routes are the only unauthenticated surface**, so they get their own trust rule: the company is resolved from the URL (`/careers/:companyCode`) or from the job document itself, and only *published* jobs of *active-subscription* companies are returned. Public responses are passed through a whitelist serializer — no `companyId`, no internal `_id` of requisition/recruiter, no salary unless `salaryVisible`.

### 1.2 One career page per company
```
/careers/infolexussol          → Infolexus jobs only
/careers/agrihub               → Agrihub jobs only
/careers/:companyCode/jobs/:jobId
/careers/:companyCode/jobs/:jobId/apply
```
A job id from Agrihub opened under `/careers/infolexussol/...` returns 404 — the backend checks `job.companyId === company._id`.

### 1.3 Many HRs inside one company
- Every application has `assignedRecruiter` (a user) — HR Manager or Company Admin can assign; recruiters filter "My candidates".
- Interviewers see only interviews where they are listed in `interviewers[]` (enforced backend-side, not by hiding buttons).
- An interviewer can create/edit **only their own** feedback document (`interviewer === req.user._id`); HR sees all feedback.
- Managers/TLs see requisitions they raised + candidates for jobs of their department/team; they never see other departments' pipelines.
- Concurrency: stage moves use `findOneAndUpdate` with an expected-current-stage guard, so two HRs dragging the same card cannot double-advance; the loser gets a 409 "candidate already moved".

### 1.4 Email routing per company (27.34)
```
CompanyMailSetting (new, per tenant)
  provider: CREWLY | SMTP
  host, port, secure, user, passEnc (AES-256-GCM, key = COMPANY_SMTP_ENC_KEY)
  fromName, fromEmail, replyTo, verifiedAt
```
`resolveTransport(companyId)` → company SMTP if configured and verified, else the platform Crewly SMTP, else MOCK (console). Passwords are encrypted at rest, never returned by the API (masked as `••••`), never logged.

### 1.5 Fairness / cost
Resume parsing + ATS run in a queue with per-company concurrency caps, so one company bulk-importing 500 resumes cannot starve another tenant. Usage counters (`jobPostingsMonthly`, `recruitmentCandidatesMonthly`) continue to feed the existing subscription limits; public applications increment the candidate counter but **never hard-block a candidate** — if the limit is exceeded the application is still saved and HR sees an "over plan limit" banner.

---

## 2. The end-to-end workflow (who does what, what emails fire)

### Stage 1 — Requisition (Manager / TL)
1. Manager opens **Recruitment → Hiring Requests → New**, fills department/team/position/openings/experience/skills/budget/priority/expected joining, saves **Draft**.
2. **Submit** → status `SUBMITTED` → `PENDING_HR`.
   - 📧 internal: *Job Requisition Submitted* → HR Managers + Company Admin, plus in-app bell.
   - Audit: `REQUISITION_CREATED`, `REQUISITION_SUBMITTED`.

### Stage 2 — HR review
3. HR opens the requisition board (Pending / Approved / Rejected / Sent Back) and picks **Approve**, **Reject**, or **Send Back** (reason mandatory for the last two).
   - 📧 to requester: *Requisition Approved* / *Rejected* / *Changes Requested*.
   - Sent-back requisitions become editable again by the requester and can be resubmitted (full history retained).

### Stage 3 — Job opening
4. From an approved requisition HR clicks **Create Job** — the form is pre-filled from the requisition (department, skills, experience, salary band, openings, work mode, location). HR adds description, responsibilities, benefits, deadline, screening questions.
5. Job status `DRAFT` → (optional `PENDING_APPROVAL` if company config requires) → **Publish**.
   - Publishing calls the **Job Distribution Service**: `crewly_career` adapter marks the job live; `linkedin` / `indeed` / `naukri` adapters exist but report `NOT_CONNECTED`.
   - Audit: `JOB_CREATED`, `JOB_PUBLISHED`. Requisition auto-links: `requisition.jobOpening = job._id`.

### Stage 4 — Candidate applies (no login)
6. Candidate browses `/careers/:companyCode`, opens a job, clicks **Apply Now**, fills the form, uploads a PDF/DOCX resume, answers screening questions, ticks consent.
7. Backend: validate (job published? deadline passed? duplicate application?) → find-or-create `Candidate` by `{companyId, email}` → create `JobApplication` → store resume privately → **enqueue** `resume.parse` → respond `201` in well under a second with an application reference like `APP-2026-000123`.
   - 📧 to candidate: *Application Received* (with reference number).
   - 📧/🔔 internal: *New Candidate* → assigned recruiter / HR.
   - Audit: `CANDIDATE_APPLIED`, `RESUME_UPLOADED`.

### Stage 5 — Background processing (async, never blocks the request)
8. Worker: `resume.parse` → text extraction → structured fields → `CandidateResume.parsed` (original file untouched) → enqueue `ats.score`.
9. Worker: `ats.score` → compares parsed profile + form data against the job's requirements → writes `AtsResult` (score, matched/missing skills, per-dimension breakdown, strengths, concerns, recommendation) → moves the application `APPLIED → ATS_SCREENING` → 🔔 HR.
   - If parsing or scoring fails: application stays valid, `atsStatus = FAILED`, HR sees a **Retry / Enter manually** button. Never an auto-reject.

### Stage 6 — HR screening & pipeline (Kanban)
10. HR opens the job's **Pipeline** board — Kanban columns = configurable stages, cards show name, ATS score chip, experience, notice period, source.
11. Filters: ATS ≥ 80, experience 2–4y, skills React/Node/Mongo, location, expected salary, notice period, education, date, source, stage.
12. Bulk select → Shortlist / Move stage / Reject / Hold / Assign recruiter / Send email. Each candidate still gets its own `PipelineHistory` row + audit entry.
   - 📧 to candidate on shortlist: *Application Update — Shortlisted* (configurable, can be silent).

### Stage 7 — Interviews
13. HR schedules Round 1: type (Online/Offline/Phone/Video), interviewers, date/time/duration, link/location, notes. Conflict detection warns if an interviewer already has an overlapping interview.
   - 📧 candidate: *Interview Invitation*; 📧 interviewer: *Interview Assigned*; 🔔 both.
14. Interviewer opens **My Interviews**, submits a scorecard (criteria ratings + comments + recommendation Pass/Fail/Hold/Next Round).
   - 📧 HR: *Interview Feedback Submitted*. Feedback is immutable to other interviewers.
15. Rounds are data, not hard-coded — a company can define 1, 4 or 7 rounds per job.

### Stage 8 — Selection & offer
16. After the final round HR marks **Selected / Rejected / On Hold**. Rejected candidates are kept with full history (📧 *Rejection*, optional).
17. HR generates an offer from a template (`{{candidateName}}`, `{{designation}}`, `{{salary}}` … resolved from candidate + job + company, logo auto-injected). PDF via **pdfkit** (already installed), stored privately.
18. If proposed CTC > requisition `maxSalary`/budget → offer is flagged `budgetExceeded` and forced into `PENDING_APPROVAL`.
   - 📧 approver: *Offer Approval Required*. Approver approves/rejects with a note.
19. **Send Offer** → candidate email contains a link with a cryptographically random token (stored **hashed**, expiring):
   `/candidate/offer/:token`
   Candidate views (records `viewedAt`), downloads the PDF through the token-scoped endpoint, then **Accept** or **Reject**.
   - 📧 HR + hiring manager: *Offer Accepted* / *Offer Rejected*. After acceptance the offer is locked — no salary/date edits, only a formal Withdraw with reason.

### Stage 9 — Pre-onboarding
20. Acceptance auto-creates a checklist from the company's configurable document set (ID, PAN, address, education, previous employment, bank, photo, tax…).
   - 📧 candidate: *Document Request* with a secure upload link (same token family, separate scope).
21. Each document: `PENDING → UPLOADED → UNDER_REVIEW → VERIFIED / REJECTED (resubmit)`. HR verifies; rejected documents trigger 📧 *Document Rejected* and can be replaced (history kept).

### Stage 10 — Conversion & account
22. On the joining date HR clicks **Convert to Employee**. Everything is pre-filled from candidate + offer; HR confirms employee ID, department, team, manager, TL, role, employment type, location, shift.
23. Creates the `User` through the **existing** user-creation path (no second auth system), links `user.candidateId` and `candidate.convertedUser`, sets stage `JOINED`.
   - 📧 employee: *Welcome / Set Your Password* — a secure `PasswordResetToken`-style activation link (existing Phase 22 machinery). No plaintext password in email. Fallback mode (if the company insists on temp passwords) sets `mustChangePassword = true`.
   - Audit: `CANDIDATE_CONVERTED`, `EMPLOYEE_CREATED`. The chain `JR-0001 → JOB-0001 → CAN-0001 → APP-0001 → INT-0001 → OFF-0001 → EMP-0001` stays queryable forever.

### The HR daily to-do surface
The recruitment dashboard opens on an **Action Center**: requisitions awaiting my review · applications never screened · ATS failures to retry · interviews to schedule · feedback overdue · offers awaiting approval · offers sent but not viewed (>3 days) · documents to verify · candidates joining this week.

---

## 3. Data model (new collections — all with `companyId`)

| Collection | Purpose |
|---|---|
| `JobRequisition` | 27.1 hiring request + approval trail |
| `JobOpening` *(extend existing `JobPosting`)* | published job + screening questions + distribution state |
| `Candidate` *(extended)* | the person, unique per `{companyId, email}` |
| `JobApplication` | candidate ↔ job, stage, source, screening answers, assigned recruiter |
| `CandidateResume` | original file ref + parsed data + parse status + versions |
| `AtsResult` | score, breakdown, matched/missing skills, recommendation, weights used |
| `PipelineStageConfig` | per-company configurable stages (seeded with the 16 defaults) |
| `PipelineHistory` | from → to, actor, timestamp, reason |
| `Interview` | round, type, interviewers, schedule, link |
| `InterviewFeedback` | per-interviewer scorecard, immutable to others |
| `OfferTemplate` | body with `{{variables}}`, version, active flag |
| `OfferLetter` | resolved offer, status machine, hashed token, PDF ref, approval trail |
| `CandidateDocument` | pre-onboarding doc + verification state + history |
| `OnboardingChecklistConfig` | per-company required documents |
| `CompanyMailSetting` | encrypted per-tenant SMTP |
| `RecruitmentEvent` | recruitment-specific audit stream (in addition to AuditLog) |

No giant nested document; everything is referenced by id.

---

## 4. Service / architecture layer (`Backend/src/services/recruitment/`)

```
requisitionService.js        state machine + guards
jobService.js                requisition→job prefill, publish rules
distribution/
  index.js                   registry + dispatch (no provider logic in controllers)
  crewlyCareerAdapter.js     ACTIVE
  linkedinAdapter.js         NOT_CONNECTED stub
  indeedAdapter.js           NOT_CONNECTED stub
  naukriAdapter.js           NOT_CONNECTED stub
resume/
  resumeStorage.js           Cloudinary authenticated / private local fallback
  resumeTextExtractor.js     pdf-parse / mammoth via dynamic import
  resumeParser.js            text → structured profile
atsEngine.js                 explainable scoring, configurable weights
pipelineService.js           stage transitions + history + concurrency guard
interviewService.js          scheduling + conflict detection
offerService.js              template render, PDF, token, status machine
onboardingService.js         checklist + document verification
conversionService.js         candidate → User (reuses existing creation path)
recruitmentAudit.js          audit + RecruitmentEvent writer
recruitmentMailer.js         all candidate + internal templates
queue/
  index.js                   enqueue(name, payload) — driver switch
  inlineDriver.js            setImmediate + retry/backoff (Phase 27 default)
  bullmqDriver.js            stub, activated in Phase 28 by REDIS_URL
  handlers/resumeParseJob.js
  handlers/atsScoreJob.js
  handlers/emailJob.js
```
Controllers stay thin and keep your comment convention:
`// data from frontend` · `// DB Logic` · `// Data to frontend`.

---

## 5. API surface (new)

**Tenant (protect + tenantContext + subscription + permission):**
```
/api/recruitment/requisitions            GET POST
/api/recruitment/requisitions/:id        GET PATCH
/api/recruitment/requisitions/:id/submit POST
/api/recruitment/requisitions/:id/decision POST   (APPROVE|REJECT|SEND_BACK)
/api/recruitment/requisitions/:id/history GET
/api/recruitment/openings                GET POST
/api/recruitment/openings/from-requisition/:reqId POST
/api/recruitment/openings/:id            GET PATCH
/api/recruitment/openings/:id/status     PATCH  (publish/pause/close/archive)
/api/recruitment/openings/:id/distribution GET POST
/api/recruitment/applications            GET (filters+pagination)
/api/recruitment/applications/bulk       POST
/api/recruitment/applications/:id        GET
/api/recruitment/applications/:id/stage  PATCH
/api/recruitment/applications/:id/timeline GET
/api/recruitment/applications/:id/resume GET (streamed, authorised)
/api/recruitment/applications/:id/ats/retry POST
/api/recruitment/candidates/:id          GET PATCH   (HR corrects parsed data)
/api/recruitment/pipeline/config         GET PUT
/api/recruitment/interviews              GET POST
/api/recruitment/interviews/mine         GET
/api/recruitment/interviews/:id          GET PATCH DELETE
/api/recruitment/interviews/:id/feedback GET POST
/api/recruitment/offers/templates        GET POST PATCH
/api/recruitment/offers                  GET POST
/api/recruitment/offers/:id              GET PATCH
/api/recruitment/offers/:id/approve      POST
/api/recruitment/offers/:id/send         POST
/api/recruitment/offers/:id/pdf          GET
/api/recruitment/onboarding/config       GET PUT
/api/recruitment/onboarding/:appId       GET
/api/recruitment/onboarding/documents/:docId/verify PATCH
/api/recruitment/convert/:applicationId  POST
/api/recruitment/dashboard               GET
/api/recruitment/analytics/funnel        GET
/api/recruitment/mail-settings           GET PUT (Company Admin)
```

**Public (no auth, rate-limited, validated):**
```
GET  /api/public/careers/:companyCode
GET  /api/public/careers/:companyCode/jobs
GET  /api/public/careers/:companyCode/jobs/:jobId
POST /api/public/careers/:companyCode/jobs/:jobId/apply   (multipart, resume)
GET  /api/public/offers/:token
POST /api/public/offers/:token/accept
POST /api/public/offers/:token/reject
GET  /api/public/offers/:token/pdf
GET  /api/public/onboarding/:token
POST /api/public/onboarding/:token/documents
```

---

## 6. Frontend (React + Tailwind dark Crewly + Lucide)

**Public:** `pages/careers/CareersHomePage.jsx`, `JobDetailPage.jsx`, `JobApplyPage.jsx`, `ApplicationSuccessPage.jsx`, `pages/candidate/OfferPage.jsx`, `pages/candidate/OnboardingUploadPage.jsx` — new `CareersLayout.jsx` (own light/dark public shell, no app sidebar).

**Tenant `/app/recruitment/*`:** `RecruitmentDashboardPage`, `RequisitionsPage`, `RequisitionFormPage`, `RequisitionDetailPage`, `JobOpeningsPage`, `JobFormPage`, `JobDetailPage`, `PipelineBoardPage` (Kanban), `CandidateDetailDrawer` (profile + resume + ATS explanation + timeline), `InterviewsPage`, `MyInterviewsPage`, `InterviewFeedbackPage`, `OffersPage`, `OfferTemplatesPage`, `OfferBuilderPage`, `PreOnboardingPage`, `ConvertToEmployeePage`, `RecruitmentSettingsPage` (stages, documents, ATS weights, mail).

**Components:** `KanbanBoard.jsx` + `KanbanColumn.jsx` + `CandidateCard.jsx` (HTML5 drag & drop, no new dependency), `AtsScoreBadge.jsx`, `AtsExplanationPanel.jsx`, `CandidateTimeline.jsx`, `StageChip.jsx`, `ScorecardForm.jsx`, `FunnelChart.jsx` (pure SVG), `FilterBar.jsx`, `BulkActionBar.jsx`.

**Services:** `careersService.js` (public, plain axios without auth interceptor), `requisitionService.js`, `jobOpeningService.js`, `applicationService.js`, `interviewService.js`, `offerService.js`, `onboardingService.js`, `recruitmentAnalyticsService.js`.

Routing: one new public parent `/careers`, one `/candidate/*`, and one `recruitment` subtree inside the existing `/app` parent — **the existing `/app/recruitment` route stays as-is and becomes the subtree index**, so no duplicate paths. Sidebar gets Lucide `Briefcase`, `ClipboardList`, `Users`, `CalendarClock`, `FileSignature`.

---

## 7. Build batches (each ends with `node --check` on all touched backend files + `npm run build` + a manual test script)

| Batch | Sub-phases | Rough size |
|---|---|---|
| **A** | 27.1 Requisition, 27.2 HR approval, permissions v4, audit helper | 6 backend + 4 frontend files |
| **B** | 27.3 Job opening, 27.4 career portal, 27.5 distribution adapters | 8 backend + 5 frontend |
| **C** | 27.6 Application + resume storage, 27.7 parser, ATS engine, queue | 10 backend + 3 frontend |
| **D** | 27.8 Pipeline Kanban, filters, bulk actions, timeline | 5 backend + 7 frontend |
| **E** | 27.9–27.11 Interviews, evaluation, final selection | 6 backend + 5 frontend |
| **F** | 27.12 Offers (template, PDF, approval, candidate portal), 27.13 pre-onboarding | 8 backend + 6 frontend |
| **G** | 27.14 conversion + account, 27.15 dashboard/analytics, 27.16 audit + settings + mail | 7 backend + 5 frontend |

---

## 8. Environment variables (added, all optional with safe defaults)

```
APP_PUBLIC_URL=http://localhost:5173      # links in candidate emails
RESUME_MAX_MB=5
RESUME_ALLOWED_TYPES=pdf,docx
OFFER_TOKEN_TTL_DAYS=7
ONBOARDING_TOKEN_TTL_DAYS=30
RECRUITMENT_QUEUE_DRIVER=inline           # inline | bullmq (Phase 28)
RECRUITMENT_QUEUE_CONCURRENCY=2
COMPANY_SMTP_ENC_KEY=<32-byte hex>        # required only for per-company SMTP
# REDIS_URL=                              # Phase 28
```

## 9. Migrations
1. `SYSTEM_PERMISSION_VERSION` 3 → 4, atomic `$addToSet` of `REQUISITION_*`, `OFFER_*`, `ONBOARDING_*`, `ATS_*` into COMPANY_ADMIN / HR_MANAGER / MANAGER / TEAM_LEAD defaults.
2. Backfill script `Backend/src/scripts/migrateRecruitmentPhase27.js`: existing `Candidate` docs → one `Candidate` + one `JobApplication` each; existing `JobPosting.status OPEN` → `PUBLISHED` (keeping `OPEN` accepted in the enum); seed default `PipelineStageConfig` and `OnboardingChecklistConfig` per company. Idempotent, re-runnable, dry-run flag.

## 10. Known limitations (planned, to be stated at the end too)
- Resume parsing is rule/heuristic based (no LLM) — accuracy ~70–85% on clean resumes; HR correction UI is mandatory, not optional.
- Inline queue driver = in-process; a server restart mid-job requires the **Retry ATS** button. BullMQ in Phase 28 fixes durability.
- No external job boards (by design), no calendar/Zoom integration, no malware scanning (hook point only), no e-signature on offers.
- Scanned/image-only PDFs cannot be parsed (no OCR).

## 11. Questions before Batch A
1. `pdf-parse` + `mammoth` — OK to add to `Backend/package.json`? (Graceful fallback if not installed.)
2. Career page URL: `/careers/:companyCode` (recommended, multi-tenant safe) vs single global `/careers`?
3. Job publish approval: always publish directly, or make `PENDING_APPROVAL` a per-company setting (default: direct)?
4. Employee account on joining: activation link (recommended) or temp password + force change — or both, per company setting?
