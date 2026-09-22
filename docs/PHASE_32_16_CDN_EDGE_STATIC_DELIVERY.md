# Phase 32.16 — CDN, Edge & Static Delivery (provider-neutral)

**CDN provider status: NOT SELECTED.** This document is the delivery *contract* any future CDN/static host must satisfy. It contains no vendor configuration, no DNS change, and no production deployment. No `dist/` artifacts are committed.

---

## 1. Static delivery topology (conceptual)

```
Browser
   ↓ DNS (no records changed; documented only)
CDN / Edge  ── cached: public hashed assets (JS/CSS), public root assets
   ├─ static paths        → static origin (serves built dist/)
   ├─ SPA app paths       → index.html (SPA fallback)
   ├─ /api/*              → BYPASS cache → Load Balancer → API #1..#N
   └─ realtime SSE        → BYPASS cache, no buffering → same API origin
```

- Static assets are **not served by the Backend** in production (verified: no `express.static` in the API; test-pinned). The future static origin must: serve the built `dist/`, emit correct MIME, implement the SPA fallback, hold **no private HR files**, and retain previous-release assets.
- **Private object storage (32.8) is never the public static origin.** Even if one provider later hosts both, access policies stay separate. Resumes, payslips, BGV evidence/reports, offers, employee documents must never sit on a public origin.

## 2. Asset classification matrix (§81 audit result)

| Class | Contents | Cache-Control | Owner |
|---|---|---|---|
| Hashed static asset | `dist/assets/*-<hash>.js/css` (incl. 32.9 lazy chunks) | `public, max-age=31536000, immutable` | future CDN/host |
| Root document | `dist/index.html` | `no-cache` (revalidate every load) | future CDN/host |
| Public non-versioned | `favicon.png`, `favicon.svg`, `icons.svg`, `logo-crewly.png` | `public, max-age=3600` (short, revalidate) | future CDN/host |
| Authenticated API | every `/api/*` response (default) | `private, no-store, max-age=0` | **Crewly (implemented)** |
| Private HR file | payslips, payroll exports, BGV, resumes, offers, documents, F&F, receipts | `private, no-store, max-age=0` (+ `Pragma: no-cache` in token flows) | **Crewly (implemented)** |
| Secure-token route | candidate offer / pre-onboarding / BGV consent portals | `private, no-store, max-age=0` | **Crewly (implemented)** |
| Realtime | SSE stream (`text/event-stream`) | `no-store` + `X-Accel-Buffering: no` | **Crewly (implemented, 32.11)** |
| Kiosk API | `/api/kiosk/*` (session/identify/punch) | `private, no-store, max-age=0` (default) | **Crewly (implemented)** |
| Public API opt-in | public careers reads | default-deny today; any future public caching requires a specific approved contract | Crewly (undecided — see policy module) |

The machine-readable matrix lives in `Backend/src/config/staticDeliveryPolicy.js` with `CREWLY` vs `FUTURE_CDN_HOST` ownership per row; `Backend/test/staticDelivery.test.js` pins it.

## 3. index.html policy (§5)

`index.html` references the **current** hashed asset names, so it is never immutable and never year-cached. Final policy: **`Cache-Control: no-cache`** — the browser/CDN revalidates on every navigation while hashed assets themselves stay immutable. This is implemented by the future host; Crewly cannot emit it (the API serves no static files) — the contract and its rationale are pinned by test.

## 4. Hashed Vite asset policy (§3/§4/§46)

Vite content hashes mean changed content ⇒ different URL. Verified against the actual build: `assets/index-<hash>.js`, `CandidateDetailPage-<hash>.js`, … Policy: `public, max-age=31536000, immutable`. **Immutability law:** never overwrite an existing hashed filename with different content (Vite guarantees this; no post-processing may change file content without changing the reference).

## 5. Public non-versioned asset policy (§22/§56)

`favicon.*`, `icons.svg`, `logo-crewly.png` are intentionally public but live at **stable, mutable URLs** — a logo replace must not be trapped in a year-long cache. Policy: short `max-age=3600` (revalidating). If assets later become versioned-by-URL, they graduate to the immutable class. No PWA manifest, no robots.txt, no service worker exists — **none added** (§22/§23).

## 6. Authenticated API policy (§15/§73)

**Default-deny:** `middlewares/apiCachePolicy.js` stamps every `/api/*` response `private, no-store, max-age=0` before the router; explicit controller headers win (last-write-wins). Before 32.16, payslip PDFs/ZIPs, payroll exports, analytics/timesheet/audit CSVs, F&F documents, branding payslip-previews, kiosk API responses and public-careers JSON carried **no** directive — absence is not a safe contract under heuristic/shared caching. Now every response carries an explicit private posture. No `Vary: Authorization` tricks, no `stale-if-error`/`stale-while-revalidate` on API data (§68/§69: those are public-static-only concepts; never Payroll/Attendance/BGV).

## 7. Secure-token route policy (§17)

Offer/pre-onboarding/BGV-consent portals are login-free but **not public content**; all token controllers already set `private, no-store, max-age=0` (pinned). Raw tokens are never cache keys, never logged (edge logs included — a provider-selection consideration, §77), and token-scoped file downloads are as private as authenticated ones.

## 8. Private HR file policy (§13/§14/§42/§75)

All private downloads are authorization-gated, streamed from private storage (32.8), and stamped `private, no-store`. Behaviorally pinned: **Express `res.download()` cannot clobber a pre-set private header on this Express version** — `test/staticDelivery.test.js` proves it over loopback so an Express upgrade can never silently flip a private resume to `public`. No range-request architecture was added (§75); files are not public-URL accessible (32.8 law stands).

## 9. SPA fallback, API bypass, 404 behavior (§20/§21)

Future host routing contract:
- `/assets/*` and exact static files → serve the file; **a missing hashed asset must 404, never return `index.html` with 200** (HTML-as-JS = confusing MIME/ChunkLoad errors).
- Application paths (`/app/*`, `/kiosk`, `/`, deep links) → serve `index.html` (SPA fallback).
- `/api/*` → **bypass cache entirely**, forward to the load balancer.
- Realtime SSE path → forward with **response buffering disabled** (`X-Accel-Buffering: no` already emitted), long read/write timeouts, never to a static origin.

## 10. Compression ownership (§24–§28) — final decision

- **Static text (JS/CSS/HTML/SVG):** Brotli/gzip owned by the **future CDN/edge or static host** (on-the-fly or precompressed). Crewly commits no `.gz`/`.br` files and adds no compression code to React.
- **API responses:** remain **deferred to the edge/proxy** exactly as concluded in 32.10 — no Express compression middleware exists and none is added. Edge must respect `Accept-Encoding`/`Content-Encoding` and cache per-encoding (§28).
- **Already-compressed content** (ZIP, images, PDFs): no re-compression anywhere; edge negotiates appropriately.
- **No double compression**: exactly one layer (edge) compresses a given response.

## 11. ETag / revalidation position (§31/§32)

Express's default weak ETags on API JSON are harmless under `no-store` and stay. HTML benefits from host-supplied `ETag`/`Last-Modified` revalidation; immutable hashed assets need neither. No provider-specific edge ETag transforms are specified. No synthesized timestamps.

## 12. DNS / HTTPS conceptual topology (§36–§40)

Two supported deployment models (no domains chosen):
- **Same-origin:** `https://<host>/` via CDN → static origin; `https://<host>/api/*` routed by the edge to the LB. Simpler CORS (browser sees one origin).
- **Split-origin:** `https://app.<host>` (CDN) + `https://api.<host>` (LB) — works with the existing explicit CORS allowlist (`CLIENT_URL`); **never `Access-Control-Allow-Origin: *`** (32.3 law).
TLS terminates at the edge/LB; origin connections use secure transport per deployment; **certificate validation is never disabled**; HTTP→HTTPS redirection is an edge responsibility (any app-level redirect must respect 32.3 trusted-proxy protocol — no redirect loops behind proxies). HSTS is security-sensitive and **deferred to 32.17**; no preload submission.

## 13. Realtime edge requirements (§50–§52)

32.11 is **SSE over the same API origin** (no second endpoint exists). Future edge/proxy must: not buffer the stream, keep long-lived connections open, respect the emitted `X-Accel-Buffering: no`, apply **no caching**, and not route it to static origins. WebSocket support is not required by current repo truth.

## 14. Deployment asset ordering (§6)

**Hashed assets first, `index.html` second.** A new HTML must only become reachable after its referenced chunks exist on the origin, otherwise browsers holding new HTML fetch not-yet-deployed chunks and fail.

## 15. Asset retention & rollback (§7/§8/§44/§45)

- **Retain previous-release hashed assets** for an overlap period: open browser sessions lazily load old chunks (prevents ChunkLoadError), and rollback = restoring the previous `index.html` **while its assets still exist** — no mass purge needed. Exact retention (release-count or bounded time) is chosen with the provider; the architectural requirement is "previous release assets remain retrievable".
- Frontend rollback therefore never requires `git` history operations and never depends on emergency CDN purges. Cache purge should be a rare, targeted operation (HTML revalidation carries most updates).

## 16. Cache-key / poisoning principles (§33/§70/§71/§72)

Static cache keys = URL path. Public APIs (if ever cached): full query string matters. Authenticated/token routes: **not shared-cached at all**. Cache rules must key on known asset paths/origins, **never on file extension alone** (`/api/x.css` must stay API). Untrusted `Host`/`X-Forwarded-Host`/query never derive asset origin or sensitive links (32.3 proxy trust remains the sole trust boundary). Full adversarial review: 32.17.

## 17. Cookies / Set-Cookie (§74)

Repo truth: cookies are parsed inbound only; **no `res.cookie` writes exist**. No personalized `Set-Cookie` responses therefore exist to shared-cache; the default-deny covers the flows regardless.

## 18. Build-artifact verification (§84/§85)

Actual build verified: `dist/index.html` + hashed `assets/*`, **no source maps** (none enabled; do not enable for CDN debugging, §47), **274 artifact files scanned — zero secret-value patterns** (connection strings, JWT/FIELD_ENCRYPTION_KEY/SMTP/CLOUDINARY/RAZORPAY assignments), only `VITE_API_URL` + `VITE_MAX_RESUME_SIZE_MB` referenced (public by design, §54). `dist/` is not committed.

## 19. Failure behavior (§67)

CDN outage → static content unreachable; the app cannot fall back to anything (no service worker) — acceptable and honest. Origin outage → CDN may serve previously cached immutable assets; **no private API data is ever served from stale public cache as a fallback** (default-deny guarantees this).

## 20. Known limitations

1. Header rows marked `FUTURE_CDN_HOST` cannot be demonstrated end-to-end until a provider exists — localhost validates Crewly-owned headers + build/preview behavior only; `vite preview` headers are **not** the CDN contract.
2. Public-API caching remains undecided by design; enabling it later is a separate approved contract.
3. Retention duration and purge specifics are provider-selection decisions.
4. Frontend lint carries **133 pre-existing problems (114 errors)** — identical at HEAD before 32.16 (verified by stash-baseline); not a 32.16 regression; cleanup belongs to a maintenance task, not this phase.

## 21. Provider-specific work deferred (§101/§103)

After the developer selects a provider, a **separate, explicitly authorized** task may configure DNS, TLS certificates, origins, cache rules, compression, SPA fallback, API bypass, SSE forwarding, purge/revalidation, logs, and private delivery. That task is **not** part of current authorization. 32.17 performs the final adversarial security review (CSP/HSTS/host-header attacks); 32.18 owns structure/runbook consolidation.
