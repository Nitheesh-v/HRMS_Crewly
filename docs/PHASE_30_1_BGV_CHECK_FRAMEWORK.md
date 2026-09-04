# PHASE 30.1 — BGV CHECK FRAMEWORK & VERIFIER WORKBENCH

⚠ ACCESS-MODEL UPDATE (Phase 30.1.1): BGV verification EXECUTION is
Crewly-platform operated — the workbench moved to the super-admin
portal and the tenant-side `/api/bgv/checks*` API + BGV_CHECK_*/
BGV_EVIDENCE_* permissions + BGV_VERIFIER template were RETIRED.
The framework internals documented below (model, rules, storage,
SLA, events, audits) remain valid. See
`PHASE_30_1_1_OPS_WORKBENCH.md` for the current routes, permissions
and the revocation migration. Sections 2–5 & 9 below describe the
superseded tenant-operated wiring — kept for history.

Phase 30 program (in-house BGV suite): **30.1 framework (this file)** →
30.2 Identity (DigiLocker + docs + selfie) → 30.3 external request engine →
30.4 Employment → 30.5 Education → 30.6 Court records → 30.7 consolidated
report + HR decision → 30.8 ops analytics.

30.1 EXTENDS the 27.15 BGV foundation. Nothing was forked or rebuilt:

- The 27.15 family (case, checks-by-catalog, history, settings, HR board,
  candidate panel, conversion gate 27.13) is untouched in behavior. All new
  work is additive: two optional fields on the start call, an enum
  back-fill, an idempotent seed hook, and additive settings keys.
- Phase 28.6 queue machinery (bgv-process-check / poll / result, claims,
  reconcile) is deliberately NOT touched. 30.1 introduces NO new queue jobs.
- The new layer is `BgvCheck`: one row per (case, checkType) with a single
  internal verifier owner, SLA clock, follow-up fields (30.3 fills them),
  entries with per-entry evidence, and a human-only status machine.

---

## 1. New backend files

- `Backend/src/models/BgvCheck.js` — schema + 6 explicit compound indexes
  (tenant-first), unique `{companyId, bgvCaseId, checkType}`, SKIPPED guarded
  against required checks at schema level too.
- `Backend/src/services/bgv/bgvCheckRules.js` — 100% pure:
  `computeSlaDueAt`, `requiredCheckTypesForSettings`, `isValidTransition`,
  `rollupCheckStatusFromEntries`, `sanitizeEvidenceMeta`, `maskPhone`,
  `roundGeoForAudit`, `containsRawDocumentNumber`, `agingBucketBounds`.
- `Backend/src/services/bgv/bgvCheckService.js` — seed / list / stats /
  detail / assign / updateStatus / addEvidence / download / extendSla /
  reopen. Every collaborator (models, audit, storage, cache, event bus) is
  injectable via a deps parameter — the same pattern as the Phase 28
  workers, which is what makes the service tests hermetic.
- `Backend/src/services/bgv/bgvEvidenceStorage.js` — private storage only:
  Cloudinary `authenticated/raw` when configured, local private dir in
  dev/test (refused in production without a provider — never a public URL).
- `Backend/src/services/bgv/bgvCheckEvents.js` — domain-event bus. 30.1 only
  EMITS (never throws back into the request); 30.3 subscribes to
  `BGV_CHECK_STATUS_CHANGED`.
- `Backend/src/controllers/bgvCheckController.js`,
  `Backend/src/validators/bgvCheckValidator.js`,
  `Backend/src/middlewares/bgvEvidenceUpload.js` (multer memory, MIME +
  size caps), `Backend/src/routes/bgvCheckRoutes.js`.
- `Backend/scripts/migratePhase30BgvPermissions.js` — existing-tenant role
  migration (supports --dry-run).

## 2. Existing files changed (all additive)

- `models/BackgroundVerificationSettings.js` — `checkConfig` (per-type
  `required` / `slaDays`, defaults true/10) + `fieldVisitGeoInAudit` (true).
- `models/BackgroundVerificationCase.js` — verification-input snapshot:
  `addressHistory[]`, `fatherName`, `pastEmployers[]` (incl. `salaryVisibleOk`
  policy flag), `education[]`.
- `models/BackgroundVerificationHistory.js` — RCA fix: the enum never
  included `BGV_CHECK_PROVIDER_VERIFIED` and `BGV_CONSENT_DECLINED` although
  28.6 code wrote them; those history rows failed validation silently
  (swallowed by the caller catch). Enum back-filled.
- `services/backgroundVerificationService.js` — start now also snapshots
  `verificationInputs` (optional body; old callers unaffected) and fires the
  idempotent `seedChecksForCase` (never fatal); settings get/update round-trip
  `checkConfig` + `fieldVisitGeoInAudit` with whitelisted validation.
- `routes/index.js` — mounts `/api/bgv` (no collision with
  `/api/recruitment/background-verification*`).
- `utils/permissionRegistry.js` + `utils/permissionService.js` — RBAC below.
- `utils/roleTemplates.js` — new opt-in `BGV_VERIFIER` template (data-only,
  never auto-seeded; enable via Settings → Roles & Permissions → create from
  template).
- `test/payrollRbac.test.js` — template-list assertion extended with the new
  opt-in key (its "never seeded" loop covers BGV_VERIFIER too).
- Frontend: `services/bgvCheckService.js`, `pages/bgv/WorkbenchPage.jsx`,
  `pages/bgv/CheckDetailPage.jsx`, routes in `AppRoutes.jsx`, sidebar item +
  icon in `AppLayout.jsx` / `SidebarNav.jsx`. Redux: no new slice — the repo
  has no RTK-Query data slices to be "consistent" with; every existing page
  uses axios services, so 30.1 follows exactly that pattern.

## 3. API (all under /api/bgv, JWT + tenant + subscription + recruitment feature)

30.1.1: this family is gone — execution now lives under
`/api/super-admin/bgv` (platform session + bgv:* permits); `/api/bgv` retains
ONLY `GET /cases/:caseId/checks-summary`. The tables below are historical.

- `GET /checks` — filters: checkType, status (csv), assignedVerifierId,
  assignedToMe, caseId, candidateId, agingBucket (0-3|4-7|8-12|>12),
  search (case-snapshot name/code), page, limit (max 100).
  `BGV_CHECK_READ`; non-`READ_ALL` holders are forced to their own queue.
- `GET /checks/mine`, `GET /checks/stats` (48h workbench widgets; Redis
  read-through, tenant key, namespace `bgv-workbench`, 60s TTL, fail-open).
- `GET /checks/:id` — assignee or `BGV_CHECK_READ_ALL`, else 404 (existence
  never leaks); audit-on-read row; full phone only here, only for READ_ALL.
- `POST /checks/:id/assign` {verifierId} — `BGV_CHECK_ASSIGN`; verifier must
  be an ACTIVE user of the same tenant.
- `POST /checks/:id/status` {entryKey?, toStatus, resultSummary?,
  discrepancyNote?, followUp.closedReason?, reason?} — `BGV_CHECK_VERIFY`.
- `POST /checks/:id/evidence` — `BGV_EVIDENCE_MANAGE`, multipart: kind,
  note, meta (JSON string), optional file (PNG/JPEG/WEBP/PDF).
- `GET /checks/:id/evidence/:evidenceId` — authenticated private download.
- `POST /checks/:id/extend-sla` {days, reason} — `BGV_CHECK_VERIFY`, once.
- `POST /checks/:id/reopen` {reason} — `BGV_CHECK_REOPEN`, terminal only.
- `POST /cases/:caseId/seed-checks` — `BGV_CHECK_ASSIGN`, idempotent repair.

## 4. Status machine (human-only)

```
PENDING ─→ IN_PROGRESS → VERIFIED | DISCREPANCY | UTV | INSUFFICIENT_DATA
         └→ SKIPPED (only when isRequired = false)
INSUFFICIENT_DATA → IN_PROGRESS
DISCREPANCY → VERIFIED (re-verified) | IN_PROGRESS (with reason)
VERIFIED | UTV | SKIPPED → IN_PROGRESS  ONLY via reopen (permission + reason)
```

Guards: VERIFIED requires a result summary; DISCREPANCY requires a note; UTV
requires `followUp.closedReason`. Entries roll up worst-wins (any
DISCREPANCY → DISCREPANCY; else UTV; else INSUFFICIENT_DATA; all settled with
≥1 VERIFIED → VERIFIED; else IN_PROGRESS; nothing touched → PENDING). The
machine can move an entry to UTV automatically in 30.3, but a human decision
is the ONLY way to reach VERIFIED, and nothing here can reject a candidate —
case outcomes stay 27.15 (CLEAR / CLEAR_WITH_DISCREPANCIES / HOLD) and the
conversion gate is unchanged.

SLA: `dueAt = initiatedAt + settings.checkConfig[type].slaDays` (default 10,
bounded 1–90). One justified extension per check.

## 5. Sensitive data

- 30.1 REFUSES raw Aadhaar/PAN/passport values in any verifier text or
  evidence note/meta (regex guard → 400, masked form expected, e.g.
  XXXX XXXX 9012). Real document capture arrives in 30.2 with encryption.
- Call-log phones: stored for the owning check, masked (XXXX-XXXX-last4) in
  list responses and in every audit row; full value only on the detail read
  to `BGV_CHECK_READ_ALL` holders.
- Field-visit geo: exact on detail; rounded to 3 decimals in audit and only
  when `settings.fieldVisitGeoInAudit` is true.
- Evidence audit rows carry kind, filename, mime, sizeBytes, ids — never
  note bodies, never file bytes. Files are private-storage references only.
- No raw payloads or credentials in logs; queue payloads are not produced
  here at all (30.1 does not enqueue).

## 6. RBAC

New permissions: `BGV_CHECK_READ`, `BGV_CHECK_READ_ALL`, `BGV_CHECK_ASSIGN`,
`BGV_CHECK_VERIFY`, `BGV_CHECK_REOPEN`, `BGV_EVIDENCE_MANAGE`.
`SYSTEM_PERMISSION_VERSION` 26 → 27. COMPANY_ADMIN receives them through the
all-company default matrix. They are deliberately NOT added to the generic
HR_MANAGER matrix defaults; existing tenants migrate with
`npm run migrate:bgv30` — as of 30.1.1 this REVERSED into a revocation
script ($pull the six permissions from every tenant role + deactivate the
orphaned Permission rows; `--dry-run` supported). The historical grant run it
replaced: (atomic $addToSet: roles already holding
BACKGROUND_VERIFICATION_MANAGE get all six, READ-only viewers get
BGV_CHECK_READ; --dry-run supported). `BGV_VERIFIER` is an opt-in template.

## 7. Extension points (do not change 30.1 for these)

- 30.2/30.4/30.5/30.6 add per-checkType claim/verification modules writing
  `entries[].claim` (shape owned by the sub-phase) and consuming the input
  snapshot already stored on the case.
- 30.3 subscribes to `BGV_CHECK_STATUS_CHANGED` / `BGV_CHECK_ASSIGNED`,
  populates `followUp.*`, and auto-closes entries as UTV after the timeline
  (the enum and the rollup already support it).
- 30.7 renders the consolidated report from immutable check state + audit.
- 30.8 aggregates SLA/aging buckets (index `{companyId, status, sla.dueAt}`
  is ready for TAT queries).

## 8. New env (documented, none invented silently)

- `PRIVATE_BGV_STORAGE_DIR` — local private evidence directory (dev/test).
- `MAX_BGV_EVIDENCE_SIZE_MB` — evidence cap; falls back to
  `MAX_PRE_ONBOARDING_DOC_SIZE_MB`, then 10 MB.

## 9. Tests

`npm run test:bgv-checks` → 23 hermetic tests (15 service + 8 rules): SLA,
machine, rollup matrix, guards, raw-document refusal, tenant isolation,
own-queue scoping, stats, evidence masking/storage, extend-once, reopen
gating, seeding idempotency, plus route/permission/comment-convention static
checks. `npm run test:all` → 833/833. analytics/fnf/payslip suites need the
developer's `.env` (they validate MONGO_URI presence even though they are
hermetic — unchanged pre-existing behavior, verified identical on the base
commit).
