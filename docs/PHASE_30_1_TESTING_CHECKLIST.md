# PHASE 30.1 — MANUAL TESTING CHECKLIST (Verifier Workbench)

30.1.1: the workbench is now the Crewly PORTAL page (log in via
`/super-admin/login`, nav item “BGV Verification”); sections A–E
below describe the retired tenant-side wiring. Run
`docs/PHASE_30_1_1_OPS_WORKBENCH.md` “Manual verification” instead.

Prereq: API + worker up, Redis optional (fail-open), `npm run migrate:bgv30`
executed once per existing tenant (or rely on COMPANY_ADMIN defaults).

## A. Setup

1. Company Settings → BGV settings: confirm `checkConfig` round-trips —
   set EMPLOYMENT slaDays to 14, set ADDRESS required off, save, reload.
2. Roles: create BGV_VERIFIER from template; assign it to a test user.
   Confirm the user sees Verifier Workbench but NOT the BGV HR board
   settings page.

## B. Case start seeds the framework

3. Start BGV for a candidate (HR board) WITH verificationInputs body —
   e.g. 2 pastEmployers, 1 education, addressHistory — via API. The UI
   board flow works unchanged without that body (27.15 behavior).
4. Open /app/bgv/workbench as BGV admin: expect IDENTITY, EDUCATION,
   EMPLOYMENT (2 entries), COURT_RECORD rows; NO Address row (required
   off). Stat cards: Open = 4, others 0; Due in 48h shows checks whose SLA
   window is near (not with a 10–14 day SLA).
5. Restart the seed: POST /api/bgv/cases/:caseId/seed-checks twice →
   created 0 the second time, no duplicates.
6. Flip ADDRESS required back ON + re-seed → ADDRESS row appears; flip
   back OFF and seed an OPEN address check → status becomes SKIPPED
   (history kept, never deleted).

## C. Verifier flow (the acceptance path)

7. HR board → assign the EMPLOYMENT check to the BGV_VERIFIER user.
8. As the verifier: workbench shows ONLY their queue; search by candidate
   name works; aging filters work.
9. Open the check. Entry cards show the claims (Infosys / TCS labels).
10. Change status PENDING → IN_PROGRESS (check-level) — allowed.
11. Try VERIFIED without a summary → blocked with a clear message.
12. Add evidence on entry 1: kind CALL_LOG (phone, duration, outcome) →
    appears in the timeline; phone shows masked in the row; in another
    browser as COMPANY_ADMIN (READ_ALL) the detail shows the full phone.
13. Try putting a 12-digit Aadhaar in the call note → rejected (mask it).
14. Upload a screenshot (PNG) via the dialog → file downloads through the
    app; check Network: request goes to /api/bgv/..., no public CDN URL.
15. Entry 1 → VERIFIED with summary; entry 2 → UTV with closedReason
    NO_RESPONSE_AFTER_TIMELINE → check card rolls up to UTV. Case status
    on the 27.15 HR board remains as before (30.1 does not complete cases).
16. BGV admin reopens the check (reason required) → back to IN_PROGRESS;
    reopen without reason → blocked; verifier (no REOPEN perm) attempts
    the same endpoint → 403.
17. Extend SLA once (+3 days, reason) → pill updates; second extension →
    blocked.
18. Audit trail: for each mutation above there is exactly one audit row
    with resource BgvCheck; open the audit viewer — no evidence note bodies
    and no file bytes; call rows show masked phones.

## D. Isolation & legacy behavior

19. Tenant B admin calls GET /api/bgv/checks/:checkId (a tenant-A id) →
    404, no existence leak. Assigning a tenant-B user as verifier →
    "Verifier not found in this company".
20. 27.15 regression: HR board list/detail, check actions, consent,
    complete with CLEAR_WITH_DISCREPANCIES, candidate panel summary — all
    behave exactly as before. 27.13 conversion gate with BGV required:
    unchanged.
21. Redis stopped: workbench stats still load (fail-open). Storage provider
    "NOT_CONFIGURED" is honest — uploads still work to local private dir
    in dev; production without Cloudinary must show 503, never fake success.

## E. Close-out

22. npm run test:bgv-checks → 23 pass; npm run test:all → 833/833.
23. Frontend: npm run build passes; sidebar shows Verifier Workbench only
    with BGV_CHECK_READ.
