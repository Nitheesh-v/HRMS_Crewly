# Phase 32.17 — Production Security Hardening (adversarial audit)

**Scope:** adversarial re-test of the completed Phase-32 production infrastructure *before close-out*. All testing was hermetic/localhost — **no Production, no third parties, no destructive tooling**. **Verdict: no verified Phase-32 security defects.** The adversarial suite added this phase is now a permanent regression guard.

**Central law honored:** performance/scalability never justifies weakening auth, tenant isolation, RBAC, org scope, payroll immutability, BGV authorization, private files, token security, rate limits, geofencing, or audit boundaries.

---

## 1. Threat matrix (S-01 … S-25)

Legend — Test: **32.17** = new `Backend/test/phase32SecurityAdversarial.test.js` probe; otherwise the named existing suite is the standing behavioral defense. Result: **PASS** for every row; Defect: **none**.

| ID | Threat | Surface | Existing defense | Adversarial test | Result |
|---|---|---|---|---|---|
| S-01 | Proxy/header spoof | `config/proxyTrust.js` (32.3) | sole trust point; fail-startup on misconfig; direct mode = headers inert | **32.17**: forged `X-Forwarded-Proto`/`-For` → `req.secure=false`, `req.ip=socket` | PASS |
| S-02 | CORS mistakes | `app.js` cors | explicit `CLIENT_URL` allowlist; dev-only e2b preview guard; never `*` | existing Phase-3x/30 suites + localhost guide (§4 of guide) | PASS |
| S-03 | Auth bypass | auth middleware | phase27SecurityHardening + auth suites | existing suites | PASS |
| S-04 | Tenant isolation | every domain service | `req.companyId` only; scoped lookups `{_id, companyId}` | phase30Security §31.1–3 (behavioral cross-tenant) | PASS |
| S-05 | RBAC/org-scope bypass | route authorize() + payroll scope | §31.6–12; manager subtree suites | existing suites | PASS |
| S-06 | Rate-limit identity bypass | limiters (32.4) | shared Redis tier, local degraded mode | **32.17**: 6 forged rotating XFF → 3×200 + 3×429 (ONE identity); declared loopback trust → distinct identities as designed | PASS |
| S-07 | Health/diag leakage | 32.2 probes | tiny bodies, cached state only | **32.17**: liveness = exactly `{success,status,timestamp}`; readiness/legacy = bounded label fields; zero URI/hostname material even degraded | PASS |
| S-08 | Request-size abuse | `express.json/urlencoded` | 10kb bounds | **32.17** structural pin (limits may not be loosened) + localhost oversize step | PASS |
| S-09 | Upload abuse | 32.8 storage | size caps, type truthfulness (never fake-CLEAN) | privateStorageServices suite | PASS |
| S-10 | Path traversal | dev-inline storage + keys | `../`, nested, absolute, backslash refusal | privateStorageServices (behavioral) | PASS |
| S-11 | Private-file authz | downloads | storage-key possession ≠ authorization; tenant+role+ownership checks | phase30Security §31.x + payslip suites | PASS |
| S-12 | Candidate token routes | offer/pre-onboarding/consent | hash-only storage, GET decision-free, expiry/revocation/rotation, generic errors | phase30Security §31.17–21 | PASS |
| S-13 | BGV public/verifier | verifier/QA boundaries | assignment = authorization | phase30Security §31.11–16 | PASS |
| S-14 | Kiosk device/PIN | kiosk auth | hash-only secrets, timing-safe compare, generic errors, revocation | attendanceKiosk (52 tests) | PASS |
| S-15 | QR challenge | QR flow | crypto-random, hash-only, atomic single-use, POST-only | attendanceQr (19 tests, incl. race) | PASS |
| S-16 | Payroll/financial | payroll paths | tenant+permission+scope, immutable results, masked accounts | payslip/payroll suites | PASS |
| S-17 | Cache cross-tenant leak | caches (32.6) + headers | scoped keys; **32.16 default-deny headers** | **32.17**: error/404 responses keep `private, no-store` | PASS |
| S-18 | Queue/job trust | `workers/registry.js` | allowlist registry; unknown job = loud config fault | **32.17**: invented job name rejects; registry stays infrastructure-only | PASS |
| S-19 | Realtime auth/tenant | 32.11 SSE | one-time tickets, tenant channels, token-class separation | realtimeFoundation (24 tests) | PASS |
| S-20 | Observability/secret leak | logs/redaction (32.12) | key-name redaction, URI/Bearer/JWT scrub, token-path redaction | **32.17**: SSE `?ticket=` + all query strings stripped from URLs; Bearer/JWT/credentialed-URI mid-string scrubbed; log-injection control chars neutralized | PASS |
| S-21 | CDN/cache privacy | every API response | 32.16 `private, no-store, max-age=0` default | **32.17**: extension deception (`/api/x.css`), 404s, errors — all keep default-deny | PASS |
| S-22 | Super Admin isolation | platform routes | platform role ≠ tenant ADMIN | existing platform suites | PASS |
| S-23 | Failure/degraded security | 32.14 modes | cache never authorizes; truthful states; bounded retries | failureRecovery (23 tests) | PASS |
| S-24 | Dev-tool exposure | load/failure tooling | CLI-only; `REFUSED: NODE_ENV=production`; no chaos endpoints/toggles | **32.17** pins: refusal text intact; no `FAIL_*`/`CHAOS_*` in src | PASS |
| S-25 | Frontend secret exposure | build artifact | only public `VITE_API_URL`/`VITE_MAX_RESUME_SIZE_MB` | build scan: 274 files, zero secret patterns (§98, re-run at acceptance) | PASS |

## 2. Defect register (S32-17-…)

**No verified defects — register intentionally empty.** Per the prompt's discipline, no defect IDs were created for non-issues. Two mid-run test failures were **test artifacts, not product defects**, and were fixed in the test file: (1) the adversarial limiter probe reused the limiter's process-global bucket from an earlier probe (isolated the probe key); (2) a job-name pattern regex expected dots where `JOB_NAMES` uses hyphens. The `req.secure` attack was additionally reproduced standalone and **confirmed defended** (`secure:false`, `proto:http`, socket IP under direct topology).

## 3. Security-header audit (§76–§85 — actual captured response headers)

Every API response (helmet, pre-existing + verified this phase):

| Header | Value | Verdict |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | keep (§79 satisfied; no duplicate middleware added) |
| `X-Frame-Options` | `SAMEORIGIN` | keep — HRMS must not be framed |
| CSP `frame-ancestors` | `'self'` | keep (frame protection, §78) |
| `Referrer-Policy` | `no-referrer` | **ideal for secure-token URLs** (§80/§81) on API responses |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (**no preload**) | audited-acceptable; final HSTS/domain policy deferred to provider selection (§40 — never submit preload blindly) |
| `Content-Security-Policy` | helmet default | inert on JSON bodies; the **frontend HTML CSP belongs to the future static host** — template: `default-src 'self'; connect-src 'self' https://<api-origin>; img/font-src 'self' data: https:` (fill domains only after selection; never `script-src *`) |
| COOP/CORP | `same-origin` | keep |

Cookies: **zero `res.cookie` writes exist** (pin) → no ambient-credential/CSRF surface; Bearer-JWT model unchanged (§84/§85: no CSRF package needed — report-only). Open redirect: the four `res.redirect(302, delivery.url)` targets are provider-signed storage URLs built from configured services, never request-controlled hosts. Host header: **no** `req.headers.host`-derived link building exists in `src/`.

## 4. Composed-surface attacks added (the permanent 32.17 suite)

20 hermetic tests in `Backend/test/phase32SecurityAdversarial.test.js`: cache default-deny vs extension deception/errors/404s · health body-shape disclosure (3 scenarios + legacy 200 contract) · forged-XFF limiter identity (untrusted vs declared-trust) · `req.secure` spoof · SSE-ticket/query URL stripping · Bearer/JWT/URI/log-injection scrubbing · unknown-job loud failure + infrastructure-only registry · no static mounts / cookie writes / chaos toggles / innerHTML · load-tool refusal pin · 10kb bounds pin · GET-never-finalizes route scan · frontend raw-HTML scan.

## 5. Known limitations (honest — not vulnerabilities)

- Client geolocation is spoofable; kiosk GPS is a convenience check, not cryptographic proof (no biometrics).
- Queues are at-least-once; duplicate financial outcomes are prevented by idempotent commit points, not exactly-once transport.
- No CDN/vendor selected: edge WAF, edge rate-limiting, final HSTS/CSP-on-HTML and log-privacy policies are provider-selection work.
- App-level rate limits are not DDoS protection; that is an edge/infra capability.
- Realtime transport identity ≠ employee work status (no presence/surveillance — none added).
- Helmet's CSP is a sensible API default, not a frontend CSP; the static-host policy remains a documented template.

## 6. Deferred (32.18 / provider-specific)

Final runbook consolidation, structure audit, and close-out (32.18). Provider-specific: TLS/HSTS final policy, frontend CSP with real domains, edge WAF/rate rules, CDN log redaction configuration, private-CDN/signed-URL delivery if desired.
