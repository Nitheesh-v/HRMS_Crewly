# CREWLY — TOTAL PROJECT MEMORY CAPSULE

For starting a new Agent/session on this project. Read this first, then the
repo (the repo is always the source of truth).
Last updated: 2026-08-29, after Phase 28.9 close (commit a869ad9).

---

## 1. What this is

Crewly: multi-tenant SaaS HRMS + Enterprise RMS/ATS (recruitment management
+ applicant tracking), with billing, platform super-admin, and a public
career portal.

- Backend/: Node.js ESM + Express + MongoDB (Atlas) + Mongoose; workers run
  as a separate process; scripts/ for ops tooling; test/ (node:test).
- Frontend/: Vite + React (tenant app + Super Admin app + public pages).
- docs/: phase reference documents (27 + full 28 series).
- Redis + BullMQ v6.3.1 (Phase 28) — background work, scheduled jobs, cache.
- Integrations: Razorpay (billing), Cloudinary (private file storage),
  SMTP (email).
- Multi-tenancy is NON-NEGOTIABLE: every business doc scoped by
  `companyId`; tenant authority comes ONLY from `req.companyId`; never
  trust client-supplied tenant ids.
- There is NO separate Employee collection: employees are `User` records
  with payroll/profile fields.

## 2. Phase map (all closed)

- Phases 1–26 (mainline HRMS, on `main`): companies/roles/RBAC, users &
  profiles, attendance, leaves, shifts/work schedules, payroll,
  performance/appraisals, assets, expenses, projects & tasks, meetings,
  notifications (+prefs), announcements, org chart, documents/requests,
  exit management (resignation), billing & subscriptions (Razorpay),
  support tickets, analytics, security (sessions, security events,
  password reset, company security policy), platform super-admin
  (subscriptions, platform settings/tokens), audit.
- Phase 27 (RMS + ATS, 27.1–27.16): full hiring lifecycle —
  Requisition → Approval → Job Posting → Career Portal apply → Resume
  upload → Parse → ATS score → Pipeline → Interviews/Feedback → Human
  final selection → Offer (approve → PDF → secure portal) → Accept →
  Pre-Onboarding (doc verify) → BGV (optional policy) → READY_TO_JOIN →
  Convert to Employee → Secure account setup → onboarding.
  Reference: `docs/PHASE_27_RMS_ATS.md` (entity map, public APIs, token
  types, ATS weights, file security, permissions, tests).
- Phase 29 (Payroll, 29.1+): 29.1 = **Company Payroll Setup** — the
  tenant configuration layer (legal entity, statutory applicability,
  payroll cycle/payment date/currency/FY, weekend-LOP-overtime policies,
  company salary bank account) with wizard + activation + audit + tenant
  Redis cache. Decides *what applies*, never *how much* (no calculation).
  Reference: `docs/PHASE_29_1_COMPANY_PAYROLL_SETUP.md`. Roadmap:
  29.2 Salary Components → 29.3 Salary Structures → 29.4 Employee Payroll
  Profile → … → 29.14 Payroll Reports & Analytics.
  29.3 is closed: `docs/PHASE_29_3_SALARY_STRUCTURES.md` +
  `docs/PHASE_29_3_TESTING_CHECKLIST.md`; 34 hermetic tests
  (`npm run test:salary-structures`).
  29.4 is closed: `docs/PHASE_29_4_EMPLOYEE_PAYROLL_PROFILE.md` +
  `docs/PHASE_29_4_TESTING_CHECKLIST.md`; 24 hermetic tests
  (`npm run test:employee-payroll`).
  29.5 is closed: `docs/PHASE_29_5_VARIABLE_PAY_MONTHLY_INPUTS.md` +
  `docs/PHASE_29_5_TESTING_CHECKLIST.md`; 32 hermetic tests
  (`npm run test:monthly-inputs`).
  29.6 is closed: `docs/PHASE_29_6_PAYROLL_ENGINE.md` +
  `docs/PHASE_29_6_TESTING_CHECKLIST.md`; 27 hermetic tests
  (`npm run test:payroll-engine`), 311/311 on the payroll + foundation
  ladder.
  29.7 is closed: `docs/PHASE_29_7_PAYROLL_REVIEW.md` +
  `docs/PHASE_29_7_TESTING_CHECKLIST.md`; 22 hermetic tests
  (`npm run test:payroll-review`), 238/238 on the payroll ladder and 604/604
  on `test:all`. It also
  fixed a live 29.6 defect: `getRunSummary` called the cache seam with
  positional args, so `GET /api/payroll/runs/:month` threw `loader is not a
  function`; both services now share a `readThrough` helper.
  29.8 is closed: `docs/PHASE_29_8_BANK_FILE_PAYMENT.md` +
  `docs/PHASE_29_8_TESTING_CHECKLIST.md`; 32 hermetic tests
  (`npm run test:payroll-payment`). It builds
  the bank transfer file and records payment confirmation, but NEVER moves
  money — the company's finance team uploads the file to their own bank.
  29.9 is closed: `docs/PHASE_29_9_PAYSLIPS.md` +
  `docs/PHASE_29_9_TESTING_CHECKLIST.md`; 28 hermetic tests
  (`npm run test:payslip`), 298/298 on the payroll ladder, 664/664 on
  `test:all`. It also fixed a live cross-phase defect:
  `registerPayrollProcessors()` existed since 29.6 but NOTHING ever called
  it, so the payroll queue had no consumer and every 29.6/29.7/29.8 job
  silently ran through the API's inline fallback. `src/workers/index.js`
  now starts the payroll worker with its own connection.
  Next: 29.10 Statutory Compliance & Government Reports.
- Phase 28 (background infrastructure, 28.1–28.9): Redis foundation,
  BullMQ foundation (7 queues), email delivery queue, processing queues
  (resume/ATS/documents), scheduled one-time jobs, pre-onboarding + BGV
  queues, Redis analytics cache, queue operations + failure management,
  final hardening. Reference: `docs/PHASE_28_FINAL_ARCHITECTURE.md`
  (diagram, full inventory, runbooks, production guidance, §15 capsule).

## 3. Domain invariants (project-wide)

- Human decisions: ATS scores are informational (never auto-reject); BGV
  discrepancy/UNABLE_TO_VERIFY → human HR decision; offer accept/reject
  only via POST on secure token routes (GET never finalizes).
- Secure tokens: offer + pre-onboarding access stored as SHA-256 hashes
  only; account setup via hashed PasswordResetToken.
- Files: resumes/offers/pre-onboarding docs in private storage (Cloudinary
  or local private dirs); no permanent public URLs; storage keys
  `select: false`; security scan state `NOT_CONFIGURED` unless a real
  scanner exists. `FIELD_ENCRYPTION_KEY` for field encryption.
- Public (unauthenticated) surface is small and slug/token scoped:
  `/api/public/careers/:companySlug/…`,
  `/api/public/candidate/offers/:secureToken/…`,
  `/api/public/candidate/pre-onboarding/:secureToken/…`,
  `setup-account?token=` → `/api/auth/reset-password`.
- RBAC: company roles + `Permission` model; `SYSTEM_PERMISSION_VERSION`
  migrates defaults via atomic `$addToSet` (no role.save loops).
  HR_HEAD / HR_EXECUTIVE do NOT exist yet (deferred).
- Platform (super admin): `AdminSession` (Mongo) + `PLATFORM_ROLES` +
  `PLATFORM_PERMISSIONS`; `superAdminSession` middleware;
  `operations:read` (SUPER_ADMIN + PLATFORM_ADMIN) / `operations:manage`
  (SUPER_ADMIN only); per-IP rate limits; platform-scope audit.
- Audit: `AuditLog`, `SecurityEvent`, `SystemEvent` models; every
  sensitive mutation audited.

## 4. Auth model

- Customer: stateless JWT (Bearer) + optional refresh tokens; `protect`
  middleware → RBAC checks.
- Platform: `AdminSession` lookup + role gate (role gate runs BEFORE any
  DB access for non-platform roles — tenant tokens get 403 instantly).
- Redis/queue ids, worker details, and job internals are NEVER exposed in
  tenant or candidate UIs.

## 5. Phase 28 infrastructure (condensed)

- Redis client (28.1): explicit `REDIS_ENABLED` parser (never
  `Boolean(env)`); `redis://` + `rediss://` (TLS verification always ON);
  bounded capped exponential reconnect; state-change-only logging;
  degraded API mode (cache→Mongo, enqueue→reject to outbox-recoverable).
- BullMQ (28.2): 7 implemented queues — system, email, resume, ats,
  scheduled, documents, bgv (reserved `analytics` unimplemented and
  allowlist-excluded); prefix `crewly:<env>`; dedicated ioredis per queue
  (producer + worker purposes, `maxRetriesPerRequest: null`); retention
  completed=100 / failed=500.
- 23 job types: 2 system + 10 email + 1 resume-parse + 1 ats-process +
  5 scheduled (interview-reminder, offer-expiry-reminder, offer-expire,
  preonboarding-reminder, bgv-reminder) + 1 document-process +
  3 bgv (process-check, provider-poll, process-result).
- Worker: ONE process, seven workers, shared `jobRegistry` dispatch
  (unknown job name → safe CONFIGURATION failure), per-queue env
  concurrency, strict payload whitelists, Mongo re-fetch by
  `{_id, companyId}` + revalidation before acting, small-metadata
  returns, startup reconciliation, graceful SIGTERM (10s hard stop),
  throttled error logging.
- Payload contract: reference-only (ids, versions, epochs, correlation
  ids). NEVER in payloads/ids/logs: raw tokens, offer URLs, resume text
  or binary, documents, government/bank data, SMTP/Redis/provider
  credentials. Workers never trust payloads (Mongo is truth).
- Email (28.3): outbox `EmailDelivery` + eventKey dedupe + atomic
  `claimEmailDelivery`; token-bearing send emails stay synchronous by
  policy; SMTP classification — auth failure NON-retryable,
  connection/timeout retryable; honest at-least-once boundary (accepted
  but crashed before SENT).
- Processing (28.4): resume parse (lease, versioned, corrupt → terminal
  UNSUPPORTED attempt 1, scanned/image → REVIEW_REQUIRED, no fake scores)
  → ATS (versioned result upsert, one authoritative result); documents
  (version-scoped, security state in Mongo, V1 never touches V2).
- Scheduled (28.5): native BullMQ `delay` one-time jobs (no
  QueueScheduler); worker revalidates Mongo (stale/terminal → SKIP);
  attempted removal on reschedule/cancel/accept/withdraw + validation.
- Pre-onboarding + BGV (28.6): reminders via scheduled queue; BGV
  consent → atomic submission claim → poll ladder 5→15→30→60 min within
  7-day window → VERIFIED / DISCREPANCY / UNABLE_TO_VERIFY → NEVER
  auto-reject.
- Cache (28.7): tenant-scoped key
  `crewly:cache:company:<id>:recruitment:analytics:v1:g<gen>:<hash16>`;
  generation INCR + 24h TTL invalidated at 24 mutation hooks; short value
  TTL (60s default, 10–3600); fail-open to Mongo; envelope + 256KB guard;
  process-local single-flight (documented multi-instance limitation);
  never used for authorization.
- Operations (28.8): 12 allowlisted `/api/super-admin/operations/*`
  routes (counts, safe serializer, retry policy backend-authoritative —
  no force flag, pause/resume, reconciliation preview + bounded run,
  cache status/invalidate); Super Admin "Background Operations" page;
  worker heartbeat `crewly:ops:worker:<env>:worker-<uuid>` TTL 60s /
  beat 15s (+ member set, no KEYS/SCAN); ONLINE/SHUTTING_DOWN/OFFLINE.
- Reconciliation: 6 idempotent bounded Mongo-authoritative runners (email
  stuck, resume pending, ATS missing, scheduled, documents, BGV) +
  master coordinator (dryRun, limit clamped 1–100 per domain,
  per-domain error isolation); startup + CLI + ops API.
- Hardening (28.9): throttled error logging, signed-customer-JWT gate
  tests, §90 script grouping, opt-in load/backpressure check
  (`scripts/ops-load-check.js` — isolated prefix, never FLUSH).
- Production: workers deploy first; managed Redis with persistence +
  verified no-queue-key eviction; one worker process (split only on
  measured load); separate env per stage; see
  `docs/PHASE_28_FINAL_ARCHITECTURE.md` §10–13 (runbooks, topology,
  checklist, limitations).

## 6. Environment variables (names only — never store real values here)

- Core: NODE_ENV, PORT, MONGO_URI, CLIENT_URL, JWT_SECRET, JWT_EXPIRES_IN
- Billing: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
- Email: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
- Storage: CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET,
  MAX_RESUME_SIZE_MB, PRIVATE_RESUME_STORAGE_DIR,
  PRIVATE_OFFER_STORAGE_DIR, OFFER_TOKEN_MAX_DAYS,
  PRIVATE_PRE_ONBOARDING_STORAGE_DIR, PRE_ONBOARDING_TOKEN_MAX_DAYS,
  MAX_PRE_ONBOARDING_DOC_SIZE_MB
- Security: FIELD_ENCRYPTION_KEY
- Parse/ATS: RESUME_PARSE_MAX_RAW_TEXT_CHARS, RESUME_PARSE_MAX_DOCX_
  EXPANDED_BYTES, RESUME_PARSE_MAX_PDF_PAGES, RESUME_PARSE_TIMEOUT_MS,
  RESUME_PARSE_MAX_ATTEMPTS, RESUME_PARSE_LEASE_MS,
  RESUME_REPROCESS_COOLDOWN_MS, ATS_WEIGHT_* (required/experience/
  preferred/education/location), ATS_DEFAULT_MAX_NOTICE_PERIOD_DAYS
- Phase 29.1: PAYROLL_SETUP_CACHE_TTL_SECONDS
- Phase 28: REDIS_ENABLED, REDIS_URL (secret — env only),
  REDIS_CONNECT_TIMEOUT_MS, BULLMQ_PREFIX, WORKER_CONCURRENCY,
  EMAIL/RESUME/ATS/SCHEDULED/DOCUMENT/BGV_WORKER_CONCURRENCY,
  OFFER_REMINDER_OFFSET_HOURS, PREONBOARDING_DOCS_REMINDER_HOURS,
  PREONBOARDING_RESUBMISSION_REMINDER_HOURS,
  PREONBOARDING_JOINING_REMINDER_DAYS_BEFORE,
  BGV_CANDIDATE_REMINDER_HOURS, BGV_VERIFIER_REMINDER_HOURS,
  RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS, OPS_* (optional, commented)
- `.env.example` holds placeholders/defaults ONLY; `.env` is
  gitignored and must never be committed.

## 7. Commands (developer machine: Windows PowerShell)

```powershell
# setup
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend; npm install
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend; npm install

# run (two terminals)
npm run dev        # Backend API
npm run worker     # Background worker (separate process)
# Frontend: npm run dev

# tests (Backend)
npm run test:all          # 24 non-live suites, 366 hermetic tests
npm run test:phase28      # Phase 28 suites
npm run test:redis / test:bullmq / test:email / test:processing /
npm run test:scheduled / test:background-jobs / test:cache / test:operations
npm run test:payroll-setup   # Phase 29.1 — hermetic (no Mongo, no Redis)
node --test test/<file>.test.js   # single file
# opt-in live (dev Redis + Mongo; isolated prefixes; NEVER FLUSH):
npm run test:bullmq:live
npm run test:ops:live
# controlled load check (dev only):
npm run ops:load-check -- --jobs 100 --concurrency 4

# ops CLI
npm run redis:check; npm run queue:check; npm run email:reconcile;
npm run processing:reconcile; npm run scheduled:reconcile; npm run queue:reconcile

# frontend
npm run build
```

Note: in a fresh sandbox checkout, run `npm install` in BOTH Backend and
Frontend first (node_modules may be missing).

## 8. Standing rules (user-set — never violate)

- Inspect the actual repo before modifying; repo is authoritative over
  any capsule; STOP and report security-sensitive discrepancies before
  destructive changes.
- NEVER ask for, print, or commit secrets (REDIS_URL, SMTP, Cloudinary,
  Razorpay, JWT_SECRET, FIELD_ENCRYPTION_KEY); no real values in
  `.env.example`; no `VITE_REDIS_URL` or any frontend Redis dependency.
- Normal `npm install` (lockfile npm-managed); no unrelated packages; no
  `npm audit fix --force` without approval; no legacy `bull`; verify
  BullMQ v6.3.1 API — "do not guess".
- Explicit `REDIS_ENABLED` parser; support `redis://` AND `rediss://`;
  never `rejectUnauthorized: false` as a blanket fix.
- Style: pure ESM (no `require()`), arrow functions, thin controllers,
  no emojis in new UI, compact maintainable files, follow existing
  repo organization.
- Developer is a Windows PowerShell beginner: exact beginner-friendly
  commands; no Unix-only env-prefix npm scripts; explicit opt-in
  commands; beware `.js.js` filename traps; no destructive
  `git reset --hard`.
- Never claim exactly-once (document at-least-once boundaries); worker
  revalidates Mongo (never trust queue data); no raw tokens/PII/links in
  job data/jobId/returnvalues/logs; no Redis-only lock as sole truth
  (Mongo atomic claims); no automatic candidate rejection from BGV; no
  provider credentials in BullMQ or logs; no Redis/BullMQ/job ids in
  candidate or HR UI.
- Failure tests use isolated prefix / mocks / exact-key removal;
  NEVER FLUSHALL/FLUSHDB on real Redis; no `KEYS` in production hot
  paths; hermetic unit tests never require live Redis; live tests use
  dev namespace + exact cleanup only.
- Cache only after auth + tenant + RBAC; short TTL + Redis generation
  (no Mongo cache-version fields); keep compatibility with future
  separate `REDIS_CACHE_URL`.
- Report exactly ONE build plan (with required subsections) BEFORE
  coding; no repeated plans; implement one phase only; STOP with a next-
  phase handoff at the end.
- **Controller comment convention (house style):** every request handler
  carries three section comments, in this order:

    ```js
    export const offerDetail = asyncHandler(async (req, res) => {
      // Data from frontend - requests from frontend
      const { offerId } = req.params;
      // DB Logic - DB logics
      const result = await getOffer({ companyId: req.companyId, offerId });
      // Data to frontend - response to frontend
      return ApiResponse.success(res, { message: 'Offer fetched', data: result.offer });
    });
    ```

  Placement rules: the request comment goes before the first statement that
  reads `req` (params / query / body); the DB comment before the first
  service or query call; the response comment before the statement that
  emits the response (`return`, `res.json(...)`, `ApiResponse.x(res, ...)`).
  When a handler is wrapped in `try { }`, the comments go INSIDE the try,
  never in the catch. If the very first statement is already the query,
  omit the request comment rather than mislabelling a DB call.
- **ES6+ only, everywhere:** `const`/`let`, arrow functions, destructuring,
  spread/rest, template literals, optional chaining (`?.`), `??`,
  `async`/`await`, and ESM `import`/`export`. Never `var`, never
  `function` declarations, never `require()`/`module.exports`, never
  `.prototype`, `Object.assign` or `.indexOf()` where modern syntax exists.
- Preferred closing phrase: "pit rules locked in 🏁".

- Phase 29.5 = Variable Pay & Monthly Payroll Inputs: pure rules in
  services/payroll/monthlyInputRules.js, tenant models
  models/PayrollPeriod.js (unique {companyId, month}) and
  models/EmployeeMonthlyInput.js (unique {companyId, month, employeeId},
  read-only `auto` sub-document + HR-owned `entries`), injectable service
  (models/cache/audit/notify), routes at /api/payroll/inputs, and
  middlewares/payrollInputScope.js which layers the 29.1 payroll scope over
  every read (resolvePayrollVisibility returns null = whole company, otherwise
  the manager's subtree plus self; out-of-scope single reads are refused with
  403 PAYROLL_ACCESS_DENIED). Permissions
  PAYROLL_INPUT_{READ,MANAGE,LOCK} (SYSTEM_PERMISSION_VERSION is 19):
  COMPANY_ADMIN all three, HR_MANAGER READ+MANAGE but NOT LOCK (§20),
  MANAGER READ only, TEAM_LEAD/EMPLOYEE nothing. Status is DERIVED, never
  stored (locked -> LOCKED, issues -> ERROR, else READY); locking runs
  validation first and refuses while any employee has an error; reopen is the
  only way out of LOCKED and is audited. §11 import is a PURE synchronous CSV
  parser with a 5,000-row cap (no BullMQ, no xlsx dependency — the template is
  generated in the browser), preview-then-confirm, and every bulk action writes
  one audit row per employee. §14 LOP = attendance absence with
  lopSource 'ATTENDANCE' until the Leave module owns a LOP leave type, at which
  point it becomes 'LEAVE' with no migration. Redis namespace 'payroll-inputs'
  (TTL PAYROLL_INPUT_CACHE_TTL_SECONDS). UI at /app/payroll/inputs: month
  dashboard + §25 KPI cards, input table, employee input drawer
  (§13 auto figures read-only + variable pay), bulk import, bulk actions,
  validation report, lock/reopen. Leave is split by type, LOP keeps the leave
  record ids behind it, the OT policy is stored as a 29.1 RATE PREVIEW (no
  amount), claims carry claimStatus + approvedBy/approvedAt and can be approved
  or rejected inline (§16), and HR notes live on the employee month (§10).
  Fence honoured: no payroll calculation, no net salary, no PF/ESI/TDS/PT, no
  payslip, no bank file, no approval, no final settlement — that is 29.6.

- Phase 29.6 = Payroll Calculation Engine: pure rules in
  services/payroll/payrollEngineRules.js (payable days, LOP, OT, PF with the
  15,000 ceiling and the EPS/EPF employer split, ESI with the 21,000 ceiling,
  state professional-tax slabs, annualised regime-aware TDS with 87A and cess,
  gratuity 4.81%), models models/PayrollRun.js (control record: status,
  progress, summary, cycle copy, runCount) and models/PayrollResult.js (the
  IMMUTABLE snapshot, unique {companyId, month, employeeId, version} with
  isCurrent). Routes at /api/payroll/runs. BullMQ IS used here (unlike 29.5):
  reserved QUEUE_NAMES.PAYROLL + JOB_NAMES.PAYROLL_RUN, deterministic job id
  payroll-run-<companyId>-<month>-<runId>, one attempt, references-only payload
  revalidated by src/workers/payrollProcessor.js, live progress via
  job.updateProgress + the run document; the same loop runs INLINE when Redis
  is off because the API runs without Redis (28.1). Permissions are the ones
  29.1 already declared — PAYROLL_RUN_READ/_EXECUTE/_RECALCULATE
  (SYSTEM_PERMISSION_VERSION is 20; HR_MANAGER loses RECALCULATE per §21).
  Snapshots are versioned: recalculation writes v(n+1) and never touches v(n).
  Cache namespace 'payroll-run'. UI at /app/payroll/run: pre-checks, §23 KPI
  cards, §27 progress tracker, results table, §24 employee breakdown drawer,
  §22 error report. Fence honoured: no approval, no lock approval, no bank
  file, no payment, no payslip, no finance approval, no final settlement.

- Phase 29.7 = Payroll Review & Approval: pure rules in
  services/payroll/payrollReviewRules.js (REVIEW_STATUSES CALCULATED →
  UNDER_REVIEW → LOCKED → PENDING_FINANCE_APPROVAL → APPROVED/REJECTED →
  REOPENED, the transition table, the 6-box review checklist, the §10 error
  catalogue with CRITICAL/WARNING severities, KPIs, summary report,
  diffResults and the CSV builders), models models/PayrollReview.js (one per
  company+month: status, checklist, employeeReviews[], append-only remarks[]
  with author/role/channel/statusAtTime, lock/submit/approve/reject/reopen
  stamps + reasons, lockCount) and models/PayrollExport.js (status
  QUEUED|PROCESSING|READY|FAILED + CSV content, capped at 4 MiB). Routes at
  /api/payroll/review (16). BullMQ reuses QUEUE_NAMES.PAYROLL with the new
  JOB_NAMES.PAYROLL_EXPORT job and the deterministic job id
  payroll-export-<exportId>; the worker rebuilds the report from Mongo rather
  than trusting the payload, and the same build runs INLINE when Redis is off.
  Permissions are the ones 29.1 already declared — PAYROLL_RUN_READ/_PREPARE/
  _REVIEW/_LOCK/_REOPEN/_APPROVE/_REJECT (SYSTEM_PERMISSION_VERSION is 21:
  29.7 added PAYROLL_RUN_REJECT to the FINANCE_MANAGER template, because a
  finance manager who can approve must be able to reject with a reason).
  §12 lock reuses the 29.5 PayrollPeriod state machine (LOCKED →
  SENT_TO_PAYROLL; an authorized reopen → COLLECTING_INPUTS, the only 29.5
  state that accepts input writes) instead of a parallel flag. §22
  notifications are addressed by PERMISSION, not role name:
  NOTIFICATION_AUDIENCE maps each event to permissions and resolveAudience
  walks Permission → CompanyRole → User, so "notify finance" reaches whoever
  can approve; the actor is excluded and a throwing notifier never rolls back
  an approval. §20 cache keys live in
  services/payroll/payrollReviewCache.js, shared with the engine so a 29.6
  recalculation drops the review dashboard. §18 EXPORT_ERROR_LIST and
  DOWNLOAD_PAYROLL_SUMMARY are bulk actions that return a report, touch no
  review row, and are the only bulk actions allowed on a locked month.
  Cache namespace 'payroll-review', version 1 — the employee list is never
  cached. UI at /app/payroll/review: KPI cards, checklist, tabs (employees,
  errors, differences, remarks, reports), employee breakdown drawer, CSV
  export. Fence honoured: no payment, no bank file, no payslip, no email, no
  settlement, and no calculation — every figure is read from the 29.6
  snapshot.

- Phase 29.8 = Bank Transfer File & Salary Payment Preparation: pure rules in
  services/payroll/payrollPaymentRules.js (9 payment statuses DRAFT → READY →
  FILE_GENERATED → DOWNLOADED → PROCESSING → PAID/PARTIALLY_PAID/FAILED →
  CANCELLED with the transition table, IFSC validation, bank-detail
  validation, batch numbers SAL-<YYYY-MM>-<seq>, payment references
  <PREFIX>-<YYYY-MM>-<seq>, the 5 failure reasons, batch summary, the §17 KPIs
  and the file builders). models/PayrollPaymentBatch.js (parent, unique
  {companyId, batchNumber}, attempt, retryOf, snapshot summary),
  models/PayrollPayment.js (one row per employee, unique
  {companyId, paymentReference}, the ENCRYPTED bank blob is snapshotted into
  the row so history cannot be rewritten by a later profile edit) and
  models/PayrollPaymentFile.js (append-only generation history: content CSV /
  binary XLSX, checksum, rowCount, downloadCount, lastDownloadedAt, jobId).
  Routes at /api/payroll/payments (12). BullMQ reuses QUEUE_NAMES.PAYROLL with
  JOB_NAMES.PAYROLL_PAYMENT_FILE and a references-only payload that the worker
  rebuilds from Mongo; the same build runs INLINE when Redis is off.
  Permissions are the ones 29.1 already declared — PAYROLL_PAYMENT_READ/
  _GENERATE/_CONFIRM/_MARK_PAID (SYSTEM_PERMISSION_VERSION is 22: 29.8 gave
  HR_MANAGER PAYROLL_PAYMENT_READ, because §4 grants HR view-only access to
  payment status). XLSX is produced by a dependency-free OOXML/ZIP writer in
  the rules module — no new npm package, following the 29.5/29.7 precedent.
  SECURITY: full account numbers exist ONLY in the encrypted blob and inside
  the generated file; every API response and every table shows
  accountNumberMasked, the dispatcher rejects any queue payload carrying
  account numbers or file content, and buildFileContent is the single decrypt
  site. §26 defect the tests caught: a batch could be marked PAID with no bank
  file behind it, so assertFileGenerated() now refuses confirmation from
  DRAFT/READY, and READY deliberately reaches no payment outcome. §15/§16
  no-double-pay: a retry batch unions the PAID ids across EVERY batch of the
  month and issues fresh references. Cache namespace 'payroll-payment',
  version 1. UI at /app/payroll/salary-payment: §17 KPI cards, batch list,
  batch detail with employees/failures/validation/downloads tabs, CSV+XLSX
  generation, mark all paid, mark failed with a reason, retry, cancel, reopen.
  Fence honoured: no bank API, no UPI/NEFT/RTGS integration, no payslip, no
  email payslip, no auto reconciliation, no final settlement, no employee
  notification, and no calculation — every figure comes from the approved
  29.6 snapshot.

- Phase 29.9 = Payslip Generation & Employee Salary Portal: pure rules in
  services/payroll/payslipRules.js (§21 statuses PENDING → GENERATED →
  EMAILED/DOWNLOADED → FAILED, payslip numbers PS-<YYYY>-<MM>-<nnnnnn> on a
  company-wide sequence that is never reused, the §6 snapshot builder, the
  values fingerprint regeneration is checked against, §15 filters by
  month/year/FY/search, §27 counters, §18 file names, §19 email copy and §20
  notification copy). models/Payslip.js (unique {companyId, employeeId,
  month} and {companyId, payslipNumber}; the rendered PDF is stored WITH the
  record so history stays downloadable, `select: false` so list reads never
  pay for it) and models/PayslipFile.js (bulk archives with status + live
  progress). 14 routes at /api/payroll/payslips, including the /mine/*
  employee portal where NO employee id is accepted at all — the controller
  reads req.user._id, which is the strongest form of the §26 rule. PDF: the
  existing utils/payslipPdf.js (PDFKit, already a dependency) is EXTENDED
  with a snapshot-driven buildPayslipPdf() covering every §8 section; the
  legacy streamPayslipPdf() and models/Payroll.js are untouched (29.3
  precedent — a hermetic test guards them). ZIP: the 29.8 writer was
  extracted to utils/minimalZip.js and shared, so bulk download adds no npm
  package. BullMQ reuses QUEUE_NAMES.PAYROLL with payslip-generate /
  payslip-zip / payslip-email jobs, references-only payloads (salary, bank,
  pdf, binary and attachments keys are rejected outright), worker rebuild,
  inline fallback. §19 email extends the existing utils/mailer.js sendMail()
  with an optional attachments argument — no new email system. Permissions
  are the ones 29.1 already declared — PAYSLIP_READ/_GENERATE/_RELEASE/
  _RERELEASE plus PAYSLIP_READ_SELF (SYSTEM_PERMISSION_VERSION is 23: 29.9
  gave HR_MANAGER and both finance templates PAYSLIP_READ, because §4 makes
  them viewers). Cache namespace 'payroll-payslips', version 1, invalidated
  on generate, regenerate, email and every status change. UI:
  /app/payroll/payslips (dashboard, generate, list, preview, email,
  regenerate, bulk download) and /app/payroll/my-payslips (employee history,
  filters, preview, download, print), sharing one on-screen payslip
  component. THE LAW: a payslip is generated only for employees whose 29.8
  payment row is PAID, so a partially paid month payslips the 142 who were
  paid instead of blocking on the 3 who failed; and regeneration re-renders
  the STORED snapshot, never new payroll data. Fence honoured: no Form 16,
  no tax declaration, no PF/ESI filing, no government portals, no settlement
  payslip, no loan statements, and no calculation.

## 9. Current state (2026-09-01)

- Phase 29.1 = Company Payroll Setup + an RBAC update on top of it: 39
  granular payroll permissions (10 resources), opt-in role templates
  (HR_HEAD / HR_EXECUTIVE / PAYROLL_ADMIN / PAYROLL_EXECUTIVE /
  FINANCE_MANAGER / FINANCE_EXECUTIVE — DATA ONLY, never seeded), org scope
  SELF|TEAM|DEPARTMENT|ASSIGNED_DEPARTMENTS|COMPANY (utils/payrollScope.js,
  team reach reuses orgHelpers.getSubtreeIds), payroll permission grant/revoke
  audit, and tenant→role→permission→scope enforced on payslip access.
  utils/payrollActionAudit.js holds the §11 sensitive-action audit hooks
  (salary changed … payslips released) for 29.2+; bank numbers are masked to
  the last 4 digits and PAN/UAN/ESI are written as [REDACTED].
  SYSTEM_PERMISSION_VERSION is 19 (29.5 added PAYROLL_INPUT_READ/_MANAGE/
  _LOCK).
  PAYROLL_SETUP_*, SALARY_COMPONENT_*, SALARY_STRUCTURE_* and
  EMPLOYEE_SALARY_* are enforced;
  the rest of the catalogue is declared for the later payroll phases.
  Permission totals: 202 in the catalogue (29.5 added three).
- Phase 29.2 = Salary Components: pure rules in
  services/payroll/salaryComponentRules.js, tenant model
  models/SalaryComponent.js (unique {companyId, code}, company-first indexes),
  injectable service (cache + audit + model injected so tests stay hermetic),
  permissions SALARY_COMPONENT_{READ,MANAGE,ACTIVATE} (SYSTEM_PERMISSION_VERSION
  is 16), Redis fail-open cache 'payroll-components', versioning that writes a
  NEW version when a component has history, deactivation instead of deletion,
  controlled formula operation list (no eval), and defaults that follow the
  29.1 statutory config (PF off => no PF component).
  Payroll nav + /app/payroll/setup and /app/payroll/components are
  PERMISSION-driven, not gated on the COMPANY_ADMIN/HR_MANAGER role names.
- Phase 29.4 = Employee Payroll Profile: pure rules in
  services/payroll/employeePayrollRules.js, tenant model
  models/EmployeePayrollProfile.js (one CURRENT profile per employee via a
  partial unique index, company-first indexes), injectable service
  (models/cache/audit/notify), routes at /api/payroll/employees, and
  middlewares/payrollProfileAccess.js which layers tenant -> self -> permission
  -> payroll scope on top of payrollAccessService (29.1). Permissions
  EMPLOYEE_SALARY_{READ,MANAGE} (already in the 29.1 catalogue) plus the new
  EMPLOYEE_SALARY_READ_SELF (SYSTEM_PERMISSION_VERSION is 18); MANAGER and
  TEAM_LEAD deliberately get nothing, EMPLOYEE gets READ_SELF only, and it is
  NOT in SELF_SERVICE_PERMISSIONS because that list leaks to Manager/Team Lead.
  Bank account reuses 29.1 fieldEncryption (select:false + masked mirror),
  statutory applicability is READ from 29.1 PayrollSetup.statutory, the §9
  breakup reuses the 29.3 preview (never the engine), CTC is validated as
  12 x (gross + employer cost), salary changes write a NEW version, and
  candidateConversionService seeds a DRAFT profile from the offered CTC
  (best-effort + idempotent). Redis namespace 'payroll-employee'; no new queue.
  Frontend: /app/payroll/employees + /app/payroll/employees/:employeeId
  (Overview/Bank/Statutory/Tax/Salary History tabs).
- Navigation rework (2026-09-01): the flat 35-row sidebar became
  layout/SidebarNav.jsx — every page now belongs to a GROUP (Home, People,
  Time & Leave, Payroll, Recruitment, Work, Insights, Me are pinned;
  Finance + Administration sit behind "More"), one group open at a time,
  the group owning the current page opens itself, a search box filters all
  pages, and a collapse toggle (w-60 <-> w-16 icon rail) is remembered in
  localStorage. AppLayout keeps header/main and only builds the menu.
- Phase 29.3 = Salary Structures: pure rules in
  services/payroll/salaryStructureRules.js, tenant model
  models/SalaryStructureTemplate.js (unique {companyId, code}, company-first
  indexes). It is deliberately NOT models/SalaryStructure.js: that file is the
  LEGACY per-employee monthly salary row (user/basic/hra/allowances/pfPercent/
  professionalTax) used by PayrollPage + payrollController, and 29.3 must not
  break it. The 29.3 API therefore lives at /api/payroll/salary-structures and
  leaves the legacy /api/payroll/structures alone (a hermetic test guards it).
  injectable service (cache + audit + models injected), permissions
  SALARY_STRUCTURE_{READ,MANAGE,ACTIVATE} (SYSTEM_PERMISSION_VERSION is 17;
  HR_MANAGER gets READ+MANAGE but NOT ACTIVATE, the PAYROLL_ADMIN template
  gets all three), Redis fail-open cache 'payroll-structures', versioning that
  writes a NEW version when a structure with history is reconfigured, clone as
  a fresh DRAFT v1, and an unstored §9 preview (never the payroll engine).
  salaryComponentService.getUsage() now counts the structures that reference a
  component (injected `structureUsage`), which closes the 29.2 -> 29.3 loop.
  Frontend: /app/payroll/structures + permission-driven sidebar entry.
- Phase 29.1 closed: Company Payroll Setup (backend model/service/routes/
  validator + 33 hermetic tests + frontend wizard & dashboard + docs).
  One current config per company (partial unique index on `companyId` where
  `isCurrent: true`); bank account encrypted (`FIELD_ENCRYPTION_KEY`) +
  `select: false` + masked-only API; `SYSTEM_PERMISSION_VERSION` 14 with the
  new `PAYROLL_SETUP_READ/_UPDATE/_ACTIVATE` permissions (ACTIVATE reserved
  for Company Admin); cache key
  `crewly:cache:company:<id>:payroll-setup:v1:current` via the existing
  Phase 28.7 service; audit via `recordAudit`; activation notification via
  the existing `notifySmart` seam (no new BullMQ queue or job name).
- Still OPEN (dev machine): opt-in live ladders `test:ops:live` /
  `test:bullmq:live`, and a first real `ops:load-check` run.
- Phase 29.1 tests are hermetic — they run without MongoDB/Redis, so they are
  green in a clean sandbox; the other 24 suites still need local MongoDB.

## 9b. Previous state (2026-08-29)

- Branch `arena/01a04272-hrms-crewly`, HEAD `a869ad9` (Phase 28.9),
  pushed; latest `main` = `fc34a35` (Phase 27 notes). Working tree clean.
- Phase 28: fully closed — 366/366 hermetic tests green, npm audit 0/0,
  frontend build passing, secrets scan clean, no FLUSH/KEYS/arbitrary-
  command surface anywhere, tenant tokens denied at platform gate
  (tested).
- OPEN (dev machine only): opt-in live ladders not yet run by the
  developer (`test:ops:live` / `test:bullmq:live`) — first run verifies
  heartbeat export/import + member-set key format; the live ops test
  creates ONE EmailDelivery fixture with exact-`_id` cleanup (documented
  exception). `ops:load-check` also awaits a first real run.
- Workspace quirk (Agent sandboxes): snapshot restore can drop
  `node_modules` (excluded from snapshots → just `npm install` again) and
  can leave local git HEAD stale (remote is authoritative — reset local
  branch to the pushed remote tip after backing up uncommitted work).
- Credential incidents (historical, handled): a live Redis URL+password
  was pasted into chat once (rotated) and a `.env` screenshot exposed
  real Cloudinary credentials (rotation recommended). Never echo these
  again.

## 10. Next-phase candidates (start ONLY on explicit instruction)

- HR_HEAD / HR_EXECUTIVE roles; payroll redesign; L&D module;
  asset/expense upgrades; helpdesk.
- Hardening backlog: external BGV provider integration; OCR for scanned
  resumes; provider message-id/outbox tracking (close the email
  at-least-once boundary); Redis-based cache single-flight (multi-
  instance stampede); worker splitting + auto-scaling (only with load
  evidence from `ops:load-check`); external alerting vendor.
