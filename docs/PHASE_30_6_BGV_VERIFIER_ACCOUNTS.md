# Phase 30.6 — Internal BGV Verifier Accounts & Dedicated Login

Crewly HRMS — Recruitment / Background Verification track.
Builds on 30.1–30.5. **Assignment, evidence access, workbench, findings,
and reports are NOT implemented** (30.7+).

## 1. Principal & security domain
- A BGV verifier is a **Crewly/Infolexus internal operational principal**
  (`BgvVerifier` collection) — **not** a tenant `User`/Employee and **not**
  a platform administrator. Tenant `User` and `AdminSession` are untouched.
- Dedicated session store `BgvVerifierSession` (mirrors `AdminSession`:
  `sessionId`, expiry TTL index, revocation) and dedicated JWT claim
  `principalType: 'BGV_VERIFIER'`.
- Isolation, enforced server-side and tested:
  - tenant `protect` rejects verifier tokens **before any DB lookup**;
  - `superAdminSession` only accepts `PLATFORM_ROLES` on `User` docs —
    verifier tokens can never pass;
  - `requireVerifierAuth` accepts **only** the verifier principal claim
    with a live session row **and** an `ACTIVE` account.
- A verifier account gains nothing tenant- or platform-related by
  authenticating: no HRMS, payroll, recruitment, or Super Admin surface.

## 2. Super Admin management (platform permission gate)
Routes under `/api/super-admin/bgv-verifiers` behind
`protect + superAdminSession + permit('bgv-verifiers:read'|'manage')`.
New permissions exist nowhere else in `PLATFORM_PERMISSIONS`, so only
`SUPER_ADMIN` (`*`) passes; tenant RBAC is never consulted. UI:
Super Admin nav → **BGV Verifiers** (`/super-admin/bgv-verifiers`):
list, invite, safe profile, edit specializations, deactivate/reactivate,
resend / revoke outstanding setup invitations. No assignment/workload UI
(30.7).

## 3. Five specializations
`IDENTITY, ADDRESS, EDUCATION, EMPLOYMENT, REFERENCE` (allowlist on the
model). One or more per verifier. **Specialization ≠ authorization**: it
marks eligibility for future assignment only; nothing in 30.6 exposes
candidates, evidence, orders, or pricing.

## 4. Account setup — no temporary passwords
Invite → `INVITED` account (no password) → hash-only one-time `SETUP`
token (72 h) emailed via Crewly mail (`Crewly BGV Operations` sender
label) → verifier chooses a password under the **platform password
policy** (`validatePassword`, 10+ chars, upper/lower/number/special) →
`ACTIVE`. Raw token never returned to Super Admin, never persisted,
never audited, never queued. Resend rotates (old link dies); revoke
invalidates outstanding links.

## 5. Login / session / logout / recovery
- Dedicated UX at `/bgv-verifier/login` ("Crewly BGV Operations");
  separate frontend token storage (`crewly_bgv_verifier_token`) and axios
  instance.
- Generic `Invalid email or password` for unknown account, wrong
  password, and deactivated account (enumeration resistance); rate
  limited (`securityRateLimit`).
- Optional per-account email-OTP 2FA (`twoFactorEnabled`) reusing the
  platform pattern: hashed 6-digit code, 10-minute bound, one-time.
- Logout revokes the session row; browser back/refresh cannot restore
  access. Deactivation revokes **all** sessions + pending tokens and
  blocks new logins (soft status; history preserved). Reactivation never
  issues a password: setup-complete accounts → `ACTIVE`, never-setup →
  `INVITED`.
- Recovery: `/bgv-verifier/forgot-password` gives an identical response
  whether or not the account exists; `RESET` token is hash-only, 30 min,
  one-time; password change revokes existing sessions.

## 6. Verifier portal (30.6 scope)
`/bgv-verifier` dashboard shows name, email, status, specializations and
the empty-work state *"No verification work is assigned yet."* — no
candidate lists, no documents, no tenant/platform navigation.

## 7. Audit
`BGV_VERIFIER_INVITED / _SETUP_RESENT / _SETUP_REVOKED / _SETUP_COMPLETED
/ _LOGIN / _LOGOUT / _DEACTIVATED / _REACTIVATED / _UPDATED /
_PASSWORD_RESET` — metadata carries ids/specializations/phase only;
never passwords, hashes, raw tokens, token URLs, or session tokens.

## 8. Boundaries & MFA note
- No candidate data, BGV documents, assignment creation, pipeline
  mutation, Razorpay/pricing coupling, or DigiLocker integration.
- MFA: per-account email OTP is supported (platform pattern). Hardware
  key/TOTP hardening remains a future recommendation.

## 9. Automated QA
`Backend/test/bgvVerifier.test.js` — 12 hermetic tests (real bcrypt,
injected collaborators): invite/duplicate/invalid specialization/five
allowlist; no temp password + hash-only tokens + redacted audits; setup
one-time/expired/revoked/resend rotation; login generic failures;
session resolve/logout/deactivation/reactivation; principal isolation
(structural scans of `protect`, `requireVerifierAuth`, route gates);
2FA OTP one-time pattern; specialization audit + zero candidate
coupling; recovery generic/one-time/session-revoking; platform
permission exclusivity. Run: `npm run test:bgv-verifier` (included in
`npm run test:all`).

## 10. Known limitations
- No assignment/evidence access (30.7), no workbench (30.8+).
- 2FA defaults off per account (enable via Super Admin edit).
- Verifier last-login shown from account state only.
- Setup/reset delivery depends on configured SMTP; MOCK mode prints the
  link in dev logs for localhost testing (no bypass in production).
