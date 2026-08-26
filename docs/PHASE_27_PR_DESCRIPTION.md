## Summary

Completes **Crewly Phase 27 (Enterprise RMS + ATS)** on branch `arena/01a0398f-hrms-crewly`.

Phases **27.1–27.11** (requisition → career apply → parse/ATS → pipeline/interviews → offers) were already on `main` at `473f881`. This PR delivers **27.12–27.16** and final integration:

| Phase | Delivery |
|---|---|
| **27.12** | Pre-onboarding: configurable docs, secure candidate portal, HR verify/resubmit, `READY_TO_JOIN` |
| **27.13** | Secure Candidate → Employee conversion (no temp passwords), account setup tokens, Lifecycle handoff, `JOINED` |
| **27.14** | Recruitment Command Center: KPIs, funnel, sources/ATS/offers, work queues, tenant-scoped analytics |
| **27.15** | Background verification: internal human workflow, check snapshots, provider/dispatcher seams for Phase 28 |
| **27.16** | Security hardening: retire legacy convert, unique employee codes, regression tests, Phase 27 docs |

**Scale (this branch vs `473f881`):** 91 files · ~15k insertions · 65 new · 26 modified · **127** backend tests green · frontend production build green.

## Lifecycle (end state)

```text
Requisition → Approval → Job → Career Apply → Parse → ATS
→ Pipeline → Interviews → Human Select → Offer (PDF + portal)
→ Pre-Onboarding → BGV (optional policy) → READY_TO_JOIN
→ Convert → Secure account setup → EmployeeLifecycle onboarding
```

Traceability: `JR → JOB → CAN → OFF → Pre-Onboarding/BGV → EMP (User)`.

## Security highlights

- Tenant isolation via `req.companyId` (no client-supplied company authority)
- Offer / pre-onboarding / account-setup tokens: **hash only**, scoped, expiring, rate-limited
- Public GET portals are **non-mutating** for final decisions
- Private document/PDF storage; scan status **`NOT_CONFIGURED`** unless a real scanner runs
- **Human gates only:** ATS and BGV never auto-reject/select
- Conversion is **idempotent** (one User/employee + one onboarding per candidate)
- **Legacy** `POST /candidates/:id/convert` (temp password) **retired** → use `convert-to-employee`

## Key APIs (new / primary)

**Pre-onboarding**
- Authenticated case + requirements + verify/ready
- Public: `/api/public/candidate/pre-onboarding/:secureToken…`

**Conversion**
- `GET …/candidates/:id/conversion-preview`
- `POST …/candidates/:id/convert-to-employee`
- `POST /api/users/:id/resend-account-setup`

**Analytics**
- `GET …/recruitment/analytics/overview`

**BGV**
- Settings, check-types, cases, check actions, complete/cancel
- `POST …/candidates/:id/background-verification/start`

## RBAC

`SYSTEM_PERMISSION_VERSION` → **13** (atomic `$addToSet` migration).

New capability families (defaults: Company Admin + HR Manager):
- `PRE_ONBOARDING_*`
- `CANDIDATE_CONVERT`
- `RECRUITMENT_ANALYTICS_READ`
- `BACKGROUND_VERIFICATION_*` (+ settings)

No `HR_HEAD` / role redesign in this PR.

## UI routes

| Route | Purpose |
|---|---|
| `/app/recruitment` | Command Center (27.14) |
| `/app/recruitment/pre-onboarding…` | Doc collection/review |
| `/app/recruitment/background-verification…` | BGV board/detail/settings |
| `/app/recruitment/candidates/:ref/convert` | Convert to employee |
| `/candidate/pre-onboarding/:token` | Public candidate portal |
| `/setup-account?token=` | Secure password setup |

## Out of scope (intentional)

- Redis / BullMQ (Phase **28**)
- Third-party BGV vendor integrations (Phase **28** plugins on existing registry)
- `HR_HEAD` / `HR_EXECUTIVE` migration
- Deleting candidates after hire

## Test plan

- [x] `cd Backend && node --test test/*.test.js` (127 passed)
- [x] `npm run test:pre-onboarding`
- [x] `npm run test:conversion`
- [x] `npm run test:recruitment-analytics`
- [x] `npm run test:bgv`
- [x] `npm run test:phase27-security`
- [x] `cd Frontend && npm run build`

### Manual smoke

- [ ] HR: `/app/recruitment` loads KPIs; empty department filter returns zeros (no leakage)
- [ ] Candidate with accepted offer → Start pre-onboarding → upload/verify → Ready to Join
- [ ] Optional BGV start → discrepancy does **not** auto-reject → complete human review
- [ ] Convert to employee → MOCK `[DEV ONLY]` setup URL → set password → employee login
- [ ] Convert twice → same employee (idempotent)
- [ ] Legacy `POST …/candidates/:id/convert` returns 400 guidance
- [ ] Employee role cannot open recruitment command center / BGV
- [ ] Public offer GET does not accept/reject without POST

## Docs

- `docs/PHASE_27_RMS_ATS.md` — lifecycle, models, tokens, permissions, Phase 28 queue inventory  
- `docs/PHASE_27_SLIDE_OUTLINE.md` — short stakeholder slides  
- `docs/PHASE_27_PR_DESCRIPTION.md` — this file  

## Commits (high level)

```
df97e5c  27.12 pre-onboarding
…        pre-onboarding / offer UX fixes
2ef87e9  27.13 secure conversion
1bb0ce0  27.14 analytics dashboard
95b42a0  27.15 background verification
8ce1cbe  27.16 final security hardening
```
