Traceability goal:
JR → JOB → CAN → Resume/ATS → Interviews → OFF → Pre-Onboarding → BGV → EMP → User login

2. Phase-by-Phase: What Was Done
27.1 — Job Requisition
Purpose: Capture hiring demand with approvals workflow.
Done:

Requisition model, codes, statuses (DRAFT → SUBMITTED/PENDING_HR → APPROVED/REJECTED/SENT_BACK…)
Create / update / submit APIs
Manager/TL can raise; HR operates approval queue
Tenant-scoped (companyId)
27.2 — HR Requisition Approval
Purpose: Formal HR decision gate.
Done:

Approve / Reject / Send-back with reasons
Exact permission checks (REQUISITION_APPROVE, etc.)
Approval UI (RequisitionApprovalsPage)
27.3 — Job Opening
Purpose: Turn approved requisition into a job.
Done:

Create job from approved requisition
Job codes, publication statuses, open/closed
Link job ↔ requisition (provenance)
27.4 — Public Multi-Tenant Career Portal
Purpose: External candidates browse/apply without employee login.
Done:

Public routes /api/public/careers/:companySlug…
Only PUBLISHED jobs
Company resolved by safe public slug (not raw companyId from client)
Separate public Axios client (withCredentials: false)
Rate limiting + validation
27.5 — Candidate Application + Resume Upload
Purpose: Capture applications with secure resume storage.
Done:

Application APIs + candidate codes (CAN-######)
Resume upload (PDF/DOCX), size/MIME checks
Private storage (Cloudinary authenticated or local private)
Malware scan abstraction (NOT_CONFIGURED — never fake CLEAN)
No public permanent resume URLs
27.6 — Deterministic Resume Parsing
Purpose: Structured extraction without inventing facts.
Done:

Background-style processing dispatcher (no BullMQ yet)
Parse statuses: completed / failed / unsupported / review
Original resume preserved; candidate-entered data not silently overwritten
Provenance via ResumeParseResult
27.7 — Explainable ATS Matching
Purpose: Assistive scoring, not auto-hire/reject.
Done:

Weighted scoring (skills, experience, education, location/notice)
Stores explanations, matched/missing skills, category (STRONG/GOOD/MODERATE/WEAK)
Engine version + fingerprint for idempotent reprocess
May advance pipeline APPLIED → ATS_SCREENING only
Does not shortlist/select/reject automatically
27.8 — Candidate Pipeline + Timeline
Purpose: Controlled stage machine + history.
Done:

Canonical stages through JOINED + dispositions
Only transitionCandidateStage mutates stage (authorized workflow actions)
Immutable CandidatePipelineHistory + business CandidateHistory timeline
Bulk actions with tenant guards
27.9 — Interview Management
Purpose: Schedule and run interview rounds.
Done:

Interview model, statuses, reschedule/cancel (no hard delete of history)
Interviewer assignment (same tenant)
Notifications (mailer/dispatcher pattern)
Timezone-aware scheduling utilities
27.10 — Interview Evaluation + Human Final Selection
Purpose: Structured feedback + human decision.
Done:

Scorecards + per-interviewer feedback ownership
Unique feedback per interview/interviewer
Submitted feedback locked by policy
Final Review / Final Decision workflow (human only)
ATS/scores never auto-select
27.11 — Enterprise Offer Management
Purpose: Controlled offers with PDF + candidate portal.
Done (already on main before this branch):

Templates (plain text, allowlisted variables)
Offer state machine: DRAFT → … → SENT/VIEWED → ACCEPTED/REJECTED (+ EXPIRED/WITHDRAWN)
Approval, PDFKit snapshot, private storage + checksum
Secure offer tokens (hash only)
Public candidate portal; GET is scanner-safe; accept/reject are POST
Duplicate active-offer protection
Pipeline: send → OFFER; accept → OFFER_ACCEPTED
27.12 — Pre-Onboarding + Document Management (this branch)
Purpose: After offer accept, collect/verify joining documents before employee creation.

Done:

Configurable tenant document requirements (snapshot at start)
PreOnboarding case + status machine through READY_TO_JOIN
Versioned private candidate documents (resubmission keeps history)
Secure candidate portal token (PRE_ONBOARDING_PORTAL capability)
HR verify / reject / mark ready (backend readiness engine)
Pipeline: OFFER_ACCEPTED → PRE_ONBOARDING via authorized action only
No Employee/User/JOINED in this phase
Notifications + audit + timeline events
Fixes: candidate id for start button, expiry date UX, currentVersion validation, MOCK portal URL logging in dev
27.13 — Candidate → Employee Conversion (this branch)
Purpose: Create one employee account safely and hand off to existing onboarding.

Done:

Conversion preview + convert APIs
Eligibility: stage PRE_ONBOARDING, offer ACCEPTED, pre-onboarding READY_TO_JOIN, docs verified
Optional BGV gate (when settings require it — wired in 27.15)
Employee = User (Crewly has no separate Employee collection)
Links: Candidate.convertedUser ↔ User.candidateId
Unique conversion record (CandidateEmployeeConversion)
Idempotent double-click protection
No temp passwords — unusable password + secure setup token (hash only) via existing PasswordResetToken + /setup-account
Starts EmployeeLifecycle onboarding once
Pipeline → JOINED via EMPLOYEE_CONVERSION
Atomic employee codes EMP-#### via TenantSequence (not countDocuments()+1)
HR UI: Convert page + candidate panel
27.14 — Recruitment Dashboard + Analytics (this branch)
Purpose: HR command center for funnel, KPIs, queues.

Done:

GET /api/recruitment/analytics/overview (tenant-scoped aggregations)
KPIs: requisitions, open jobs, applications, ATS, shortlist, interviews, offers, ready-to-join, joined
Funnel (history-first milestone counts)
Sources, ATS distribution, offer outcomes, hiring speed (time-to-hire / fill proxy)
Operational work queues with deep links
Jobs table
Filters: range, department, job, source, recruiter
Fix: department filter applies to ATS/interviews/offers/etc. (empty dept → zeros, no leakage)
UI: /app/recruitment Command Center; sidebar + tabs wired
Permission: RECRUITMENT_ANALYTICS_READ
No new chart library (Tailwind bars/sparklines)
27.15 — Background Verification (this branch)
Purpose: Human-controlled BGV; ready for third-party plugins later.

Done:

Settings (trigger stage, consent, require-before-conversion flags)
Configurable check types (snapshot onto case)
Case + checks + immutable history
Internal provider only (no paid vendor required)
Provider registry + dispatcher seams for Phase 28 Redis/BullMQ + SpringVerify/OnGrid-style adapters
HR board / detail / settings UI
Candidate BGV panel (start/open)
Outcomes: CLEAR / CLEAR_WITH_DISCREPANCIES / HOLD — never auto-reject
Conversion eligibility hook
Fix: atomic settings upsert (no Duplicate companyId race)
27.16 — Final Integration + Security Hardening (this branch)
Purpose: Close Phase 27 safely; no new major feature.

Done:

Full security audit of tenant isolation, tokens, files, public APIs, pipeline, human-decision boundaries
Retired legacy convert that emailed temp passwords (POST …/convert → 400 guidance)
Unique index on (companyId, employeeCode) when non-empty
Security regression test suite (phase27SecurityHardening.test.js)
Developer documentation docs/PHASE_27_RMS_ATS.md
UI branding footer → "Phase 27"
Confirmed: GET offer is decision-free; scans not fake-CLEAN; conversion is secure path only




