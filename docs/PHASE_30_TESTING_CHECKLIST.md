# Phase 30 — Testing Checklist

Companion to `docs/PHASE_30_INTERNAL_BGV.md`. Tick items on the developer's
localhost (own `.env`; never display it). Synthetic data only — no real
Aadhaar/PAN/passport/salary records, no real candidate PII.

## 1. Automated (run first)

```powershell
cd Backend
git branch --show-current          # arena/01a0706f-hrms-crewly
git status                         # expect clean after pull
npm run test:phase30-security      # 39/39 consolidated security boundary suite
npm run test:bgv-decision          # 30.1
npm run test:bgv-catalogue         # 30.2
npm run test:bgv-order             # 30.3
npm run test:bgv-consent           # 30.4
npm run test:bgv-collection        # 30.5
npm run test:bgv-verifier          # 30.6
npm run test:bgv-assignment        # 30.7
npm run test:bgv-workbench         # 30.8
npm run test:bgv-info-request      # 30.9
npm run test:bgv-qa-report         # 30.10
npm run test:bgv-operations        # 30.11 (26/26)
npm run test:phase28               # queue/email/worker foundation
npm run test:all                   # full regression (current: 1060 pass)
cd ..\Frontend
npm run build                      # production build must succeed
```

## 2. Manual localhost acceptance (A–T)

| # | Scenario | Key expectations |
|---|---|---|
| A | Proceed WITHOUT BGV | confirm→cancel→confirm; persists after refresh; "Not Requested"; never "CLEAR/VERIFIED"; recruitment continues |
| B | Super Admin catalogue | exactly 5 checks; price edit persists; activate/deactivate; invalid price rejected; no seed needed |
| C | Paid BGV order | backend prices only; TEST payment (or record provider-blocked); snapshot immutable after refresh |
| D | Crewly invitation | sender Crewly (tenant named as requester); GET link changes nothing (scanner-safe); HR sees PENDING |
| E | Consent | explicit consent persists; payment ≠ consent; consent ≠ verified |
| F | Candidate collection | drafts survive reload; synthetic docs only; invalid file rejected; unpurchased checks absent; final submission locks |
| G | Verifier account | invite → setup email → password (no temp password); dedicated login; tenant/SA access denied |
| H | Assignment | wrong specialization unavailable; assigned verifier sees only own check; EMPLOYMENT verifier cannot see other checks' data |
| I | Verification | activities append; VERIFIED / VERIFIED_WITH_DISCREPANCY / UNABLE_TO_VERIFY paths; no auto-reject ever |
| J | DigiLocker boundary | "issuer-assisted" wording only; no password/OTP fields; no API claim |
| K | Additional info | candidate notified; only requested category editable; v1 preserved; no new charge |
| L | QA | return requires reason (≥10); old revision preserved; approve gates report |
| M | Report | blocked before all approvals; GENERATED invisible to tenant; RELEASED visible; download private (no public URL); no full IDs/payment/QA notes |
| N | Human decision | CLEAR / CLEAR_WITH_DISCREPANCIES / HOLD change no pipeline stage |
| O | Operations dashboard | cards/queues/filters/paging/SLA/workload; tenant & verifier locked out |
| P | Deactivation | deactivated verifier loses access instantly; history preserved; reassignable |
| Q | Cross-role security | tenant↛SA, verifier↛tenant/SA, candidate token↛other candidate |
| R | Reminders/worker | worker script runs; stale reminder skipped; SMTP-blocked recorded honestly |
| S | Refresh/revisit | every major state survives refresh (backend authoritative) |
| T | No seeding | whole E2E possible through UI/API only; no seed scripts, no manual Mongo edits |

## 3. Environment-blocked in Arena (must run on localhost)

- Live Razorpay TEST payment + webhook (provider credentials)
- Real SMTP sends (invitation/reminder emails)
- Redis-backed worker round-trips + reconcile scripts against live queues
- Cloudinary private storage path (falls back to local private dir)

BLOCKED is never counted as PASS.
