# Employee referrals — posted jobs visible to every employee — build plan (2026-10-09)

Owner ask: "if any job opening should be posted it should be visible for all employees
for referral. make this option." Plus localhost testing steps.

## A. Repository findings

- **"Posted" already has one truth**: `JobPosting.publicationStatus: 'PUBLISHED'` +
  `publishedAt != null` (+ `status: 'OPEN'`) is exactly the public career page's
  visibility filter (`publicCareerService.publicVisibilityFilter`, currently module-private).
  Requisition approval only creates the posting; publishing is an explicit HR action
  (`recruitmentController` `publishingNow`), so employee visibility should follow the
  same switch — not invent a new one.
- **Candidates already carry a source enum** (`CANDIDATE_SOURCES = ['INTERNAL',
  'CAREER_PAGE']`) and a per-job unique index `{ job: 1, email: 1 }` — the DB already
  rejects the same email twice for one job (E11000). There is no `referredBy` field yet.
- **The career-page application flow** (`candidateApplicationService`) creates
  Candidate + CandidateResume + CandidateHistory and dispatches resume parsing. A
  referral starts leaner: no resume file, no public consent flow — name/email/phone +
  optional note, then HR enriches in the existing inbox/pipeline. `Candidate.notes`
  (500 chars) exists; `nextCandidateCode` (TenantSequence-backed) exists.
- **Analytics hard-codes the two sources in three spots**
  (`recruitmentAnalyticsService` ~165 filter validation, ~844 grouping + labels,
  ~1225 options) — a new source must be added there or referral rows break the
  dashboard and the filter rejects it.
- **Frontend menu** is `NAV_BY_ROLE` (COMPANY_ADMIN, HR_MANAGER, MANAGER, TEAM_LEAD,
  EMPLOYEE) + permission-conditioned extras; the referral page needs no permission
  (tenant membership is the gate), so **no permission-registry change and no
  SYSTEM_PERMISSION_VERSION bump**.
- Frontend source labels hard-coded in `CandidateInboxPage` (label fn + `<option>`)
  and `CandidateDetailPage` (ternary) — REFERRAL must render as "Referral", not the
  wrong "Internal".

## B. Security / data boundaries

- All routes require `protect` + `tenantContext`; every query filters by `req.companyId`
  (or the `req.company._id` the middleware loads) — an employee of Infolexus can never
  see or refer into Agrihub's jobs. No cross-tenant identifiers in URLs beyond the
  in-tenant `jobCode`.
- No new permissions: visibility is tenant-membership, submissions are self-scoped
  (`referredBy = req.user._id`), reads of "my referrals" filter by the caller's id.
  HR-side pipeline actions stay behind the existing recruitment permissions — a referral
  lands as an ordinary APPLIED candidate and nothing about the RBAC model changes.
- POST lanes go through `checkSubscriptionStatus` + `checkWriteAccess` like every
  tenant mutation. No PII leaves the tenant; no new env vars; no secrets.

## C. Implementation

1. `models/Candidate.js`: add `'REFERRAL'` to `CANDIDATE_SOURCES`; add `referredBy`
   (ObjectId ref `'User'`, default null).
2. `publicCareerService.js`: export `publicVisibilityFilter` (one truth for "posted").
3. New `services/recruitment/employeeReferralService.js`:
   - `listReferralOpenings` — posted+open jobs, referral-safe projection (title,
     jobCode, department, location, workMode, employmentType, description, skills,
     experience level — **no salary/budget fields**);
   - `submitReferral` — validates the job is posted+open for the tenant, friendly
     duplicate pre-check plus the E11000 catch → 409 `REFERRAL_ALREADY_APPLIED`,
     creates the candidate (source `REFERRAL`, `referredBy`, APPLIED) with
     `nextCandidateCode` + CandidateHistory entry;
   - `listMyReferrals` — the employee's own referrals with job title + live stage.
4. New `controllers/recruitment/employeeReferralController.js` +
   `routes/referralRoutes.js` (`GET /openings`, `GET /mine`, `POST /:jobCode`;
   protect + tenantContext on all, subscription/write gates on POST), mounted at
   `/api/referrals` in `routes/index.js`.
5. `recruitmentAnalyticsService.js`: accept and label `REFERRAL` ("Employee referral")
   in the filter validation, grouping array and options list.
6. Frontend: `services/referralService.js`; `pages/referrals/ReferralsPage.jsx`
   (openings grid → refer dialog: name*, email*, phone, note; "My referrals" tab with
   live stage); lazy route `/app/referrals` with **no role gate**; menu entry added to
   **all five** role arrays; `SidebarNav` icon + Work-group membership; the three
   source-label spots in the recruitment pages.
7. Tests: Backend `test/referrals.test.js` (hermetic — real service, stubbed model
   statics; tenant scoping, posted-only visibility, duplicate rejection, referral
   attribution, self-scoped "mine"); Frontend `test/referralsPage.test.js` (lazy route,
   no role gate, all-role menu entry, real endpoints, truthful copy).

## D. Test plan

- New backend suite + targeted `recruitmentAnalytics`, `candidatePipeline` suites.
- New frontend suite; frontend `npm test`; `npm run build`.
- Full backend `test:all` green. Bite-proof the new suites (revert a pin's target
  behavior in memory → suite fails → restore).
- Owner-visible: publish a job → every employee's sidebar shows **Job Referrals** →
  they see the opening and can refer → HR sees the candidate with source "Referral".

## E. Environment / dependencies

- Zero new npm dependencies; no env vars; no permission version bump; additive model
  change only (new enum value + nullable field — no data migration).


---

## F. RESULTS

### Files
- **Backend (new):** `services/recruitment/employeeReferralService.js`,
  `controllers/recruitment/employeeReferralController.js`,
  `routes/referralRoutes.js` (mounted `/api/referrals`), `test/referrals.test.js`.
- **Backend (changed):** `models/Candidate.js` (`REFERRAL` source + `referredBy`),
  `models/CandidateHistory.js` (`REFERRAL` in the source enum),
  `services/recruitment/publicCareerService.js` (exported
  `publicVisibilityFilter` — one truth for "posted"),
  `services/recruitment/recruitmentAnalyticsService.js` (accept + group + label
  "Employee referral"), `routes/index.js`, `package.json` (`test:referrals`, `test:all`).
- **Frontend (new):** `services/referralService.js`,
  `pages/referrals/ReferralsPage.jsx` (Open roles / My referrals, refer dialog),
  `test/referralsPage.test.js` (9 pins).
- **Frontend (changed):** `routes/AppRoutes.jsx` (lazy `/app/referrals`, no role gate),
  `layout/AppLayout.jsx` (menu entry in **all five** role arrays),
  `layout/SidebarNav.jsx` (UserPlus icon + Work group),
  `pages/recruitment/CandidateInboxPage.jsx` + `CandidateDetailPage.jsx`
  (REFERRAL renders as "Referral", filter option added).

### Evidence
- Backend `test:all` → **3367 tests / 178 suites / 0 fail** (3362 + 5).
  Targeted: referrals + candidatePipeline + recruitmentAnalytics +
  publicCareerPortal → 28/28.
- Frontend `npm test` → **426 / 0** (417 + 9); `npm run build` clean.
- The pins bite: duplicate pre-check → 409 with create never called; E11000 race →
  409; unposted/foreign job → 404; openings projection excludes salary/budget;
  "my referrals" filters `referredBy` + tenant; the referrals route has no
  RequireRole wrapper; all five role menus expose the entry.
- No permission-registry change, **no SYSTEM_PERMISSION_VERSION bump**, no new npm
  dependencies, no env vars, additive model change only (no data migration).

### Process notes (caught by verification, fixed before push)
- The mid-turn re-clone raced two parallel edits: the `referredBy` field silently
  reverted (caught by the new frontend pin on the model), and the service's ApiError
  import reverted (caught by the suite failing to load). Both re-applied and verified
  by grep + suite before continuing.
- The truthful-copy pin flagged my own explanatory comments twice ('rewards', then
  'incentive' — words used to say the page avoids them). The scan now strips
  comments before judging user-facing copy.
