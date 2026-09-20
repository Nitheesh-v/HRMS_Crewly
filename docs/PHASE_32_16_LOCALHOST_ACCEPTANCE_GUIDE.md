# Phase 32.16 — Localhost Acceptance Guide (Windows PowerShell)

**Read first: NO REAL CDN IS BEING TESTED.** Nothing here contacts any provider. This validates Crewly's *readiness*: build artifact correctness, Crewly-owned cache headers, chunk-failure behavior, and the documented host contract. `vite preview` is **not** production hosting and its headers are not the CDN contract.

**Needs:** Backend (Mongo required — your dev `.env`), Frontend build + preview, Redis/worker/realtime **not** required for this walkthrough. No special permissions. Paste one block at a time; `$env:` values live only in that window.

---

## Step 1 — Production frontend build

```powershell
cd C:\path\to\HRMS_Crewly\Frontend
npm run build
```

**Expect:** `✓ built in ~1–2s` and a `dist/` folder. Do **not** manually edit anything in `dist/` — it is a disposable build artifact and is not committed to git.

## Step 2 — Inspect dist (the hashed-asset model, §88/§89)

```powershell
Get-ChildItem .\dist
Get-ChildItem .\dist\assets | Select-Object -First 12 -ExpandProperty Name
```

**Expect:** `index.html` + dozens of files like `AttendanceAnalyticsPage-DdbNDiUP.js` — **name + content hash + extension**. Every JS/CSS asset is content-hashed (changed content ⇒ new filename ⇒ safe immutable caching + old/new releases coexist). `dist\assets` holds **only code** — no resumes/payslips/HR documents anywhere in dist.

## Step 3 — What the host must do (documented contract check, §97)

Open `docs/PHASE_32_16_CDN_EDGE_STATIC_DELIVERY.md` and confirm it clearly states: publish **assets before HTML**, retain **previous-release hashed assets** (open tabs + rollback), rollback = restore prior `index.html` while assets remain (no git reset, no mass purge), and missing `/assets/…` must **404, never return HTML**. No action — verify the words are unambiguous.

## Step 4 — Preview the built SPA (§90)

Window A (backend):

```powershell
cd C:\path\to\HRMS_Crewly\Backend
npm run dev
```

Window B (built frontend + static preview):

```powershell
cd C:\path\to\HRMS_Crewly\Frontend
npm run preview
```

Use the URL Vite prints (http://localhost:4173). In a browser test: the landing page loads; a **deep-link** (paste an app route URL directly, e.g. a careers route) loads via SPA fallback (this works because 32.16 added a localhost `preview.proxy` so `/api` reaches your backend — a testing convenience, **not** production hosting); `/kiosk` route loads its shell.

**Limitation (be honest):** `vite preview` does not demonstrate CDN cache headers, global SPA-fallback header behavior, or edge routing. It proves the build artifact + routing architecture only.

## Step 5 — Crewly-owned cache headers (the real §92 test)

These headers **are** enforceable on localhost because the API owns them:

```powershell
# Health endpoint — a real Crewly response
(Invoke-WebRequest http://localhost:5000/api/health/live).Headers["Cache-Control"]
```

**Expect:** `private, no-store, max-age=0` — the new default-deny. Every `/api/*` response carries it now (before 32.16 many carried nothing). Repeat mentally for any authenticated endpoint via the browser (Step 6) — **never paste your JWT into chat**.

```powershell
# Simulated stale-asset 404: preview must not serve HTML for a missing asset
try { Invoke-WebRequest http://localhost:4173/assets/does-not-exist-abc123.js } catch { $_.Exception.Response.StatusCode.value__ }
```

**Expect:** **404** (not 200-HTML): the SPA-fallback contract — missing hashed assets must fail fast, not return HTML as JavaScript.

## Step 6 — Browser DevTools network pass (§91)

Open the preview URL → F12 → **Network** tab (tick "Disable cache" OFF — you want to see real headers):
1. Initial load: JS/CSS requests show **hashed** filenames.
2. Click through into the authenticated app; open a feature page (e.g., Attendance → Analytics): a **lazy chunk** loads on navigation (32.9 splitting intact).
3. Inspect any `/api/...` request → Response Headers contain `cache-control: private, no-store, max-age=0`.
4. No response anywhere shows `Cache-Control: public, max-age=31536000` — that policy belongs to **hashed static assets only**, at the future CDN, and must never appear on an API response.
5. No private HR document appears as an ordinary frontend asset. Do not inspect or log secure tokens.

## Step 7 — Kiosk route (§95)

Browse to `http://localhost:4173/kiosk`. **Expect:** the kiosk screen loads (its JS chunk is a normal public hashed asset — that's correct). Kiosk **business responses** (session/identify/punch) inherit `private, no-store` from the API default — verified by the Step 5 header behavior; no geofence/punch behavior changed.

## Step 8 — Update simulation + rollback explanation (§96/§97)

Conceptual — **no source change needed**: edit any tiny style, rebuild, and observe `dist\assets` gains **different hash names** while old names disappear locally (on a real origin the host *retains* old files for the overlap window — that's the documented contract, Step 3). Frontend rollback = restore previous `index.html`, which still references the retained old hashes. Verify the guide/doc states this; **no git reset/rebase is performed or needed**.

## Step 9 — Frontend regression + secret scan (§86/§85)

```powershell
npm run lint    # expect: pre-existing repo findings only (see handoff) — your changes add none
npm run build   # expect: clean build
```

The automated secret scan already ran in the build pipeline (274 artifact files, zero backend-secret patterns; only `VITE_API_URL`/`VITE_MAX_RESUME_SIZE_MB` — public by design). Backend regression evidence: `npm run test:all` → **2147/2147 ×2** (includes the 20 new `staticDelivery` tests).

## Step 10 — Backend cache-policy tests (optional re-run)

```powershell
cd C:\path\to\HRMS_Crewly\Backend
npm run test:all
```

**Expect:** all pass; the `staticDelivery` suite pins the header matrix, the private-download survival law, and the no-auto-reload law.

---

## Acceptance Checklist (leave UNCHECKED until YOU verify)

- [ ] Step 1: production build passes; `dist/index.html` exists
- [ ] Step 2: assets are content-hashed; no private HR files in dist
- [ ] Step 3: assets-before-HTML ordering + retention + rollback documented unambiguously
- [ ] Step 4: preview loads root, a deep-link, and `/kiosk` (with backend running)
- [ ] Step 5: `/api/health/live` returns `private, no-store, max-age=0`; missing asset 404s
- [ ] Step 6: hashed chunks + lazy chunk navigation in Network tab; no public year-long header on ANY API response
- [ ] Step 7: kiosk route loads; kiosk API inherits private/no-store
- [ ] Step 8: hash-change simulation understood; rollback explained without git surgery
- [ ] Step 9: lint shows only the pre-existing findings; build clean
- [ ] No CDN vendor selected/configured; DNS untouched; no production deployment
- [ ] No secret value printed at any step

---

*Reply with your recorded results. Handoff line:*
**Phase 32.16 awaiting localhost acceptance.**
