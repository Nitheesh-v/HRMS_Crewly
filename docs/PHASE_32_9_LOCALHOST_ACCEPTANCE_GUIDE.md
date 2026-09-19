# PHASE 32.9 — LOCALHOST ACCEPTANCE GUIDE (Beginner, PowerShell + Browser)

Status: guide for **32.9 implemented** (awaiting localhost acceptance).
PowerShell + Chrome/Edge DevTools only. No secrets involved anywhere.

---

## 0. WHAT CHANGED (plain words)

The app already lazy-loaded almost every page. Two things were still
bundled into the FIRST download for EVERY user:

1. the **Super Admin** app shell (platform-admin only), and
2. the **Billing** page.

32.9 moved both behind lazy loading. Tenants no longer download
platform-admin/billing code; Super Admins/billing users get it on
first visit of that area (a brief "Loading…" is normal the first time).
Auth/permission behavior is UNCHANGED (guards were not touched).

## 1. WHAT YOU NEED

- MongoDB running (backend normal `.env`). Redis/worker NOT needed.
- Backend + Frontend dev servers.
- Accounts: one normal HR/admin tenant user, and (optional) one
  platform Super Admin account, plus (optional) a second tenant user
  for the permission check.
- No new dependencies; nothing to install.

## 2. START

```powershell
# Terminal 1
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev

# Terminal 2
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm run dev
```

Open `http://localhost:5173`.

## 3. INITIAL LOAD TEST (the core proof)

1. Open DevTools (**F12**) → **Network** tab.
2. Tick **Disable cache**.
3. Filter: **JS**.
4. Log in as your normal tenant user (or hard-reload the dashboard:
   **Ctrl+Shift+R**).
5. Look at the JS files loaded right after login.

Expected: you see the entry `index-….js` and a handful of shared files
(axios, api, runtime) — and **NO** file that contains Super Admin or
Billing page code. If you want to check by name: no chunk named
`SuperAdminLayout-….js`, no `BillingPage-….js`, and none of the big
`SuperAdmin*Page-…` / `Payroll*Page-…` chunks appear until you visit
them. (Exact names/hashes change — judge by the absence of
SuperAdmin/Billing chunks, not exact filenames.)

## 4. LAZY ROUTE TEST (feature code loads on demand)

Visit these as an authorized user and watch the Network tab:

- Payroll: open any payroll page you have rights to → a NEW chunk
  (e.g. `Payroll…Page-….js`) loads on first visit, page renders, APIs work.
- Attendance: `http://localhost:5173/app/attendance` and the analytics
  page → same behavior.
- A page you already visited: navigate away and back → NO second
  download (browser cached the chunk).

Expected each time: brief "Loading…" at most, then the page. No blank
screen. Browser **back/forward** works. **Refresh on a deep route**
(paste `http://localhost:5173/app/attendance` directly and reload)
works — lazy routes are real URLs, not sidebar-only.

## 5. SUPER ADMIN TEST (the changed boundary)

With the platform Super Admin account (if you have one):

- Log in → `http://localhost:5173/super-admin/dashboard`.
- Expected: the Super Admin layout chunk loads on demand, the console
  renders, navigation inside works.
- As a normal tenant user: the sidebar shows no Super Admin entry, and
  direct-URL to `/super-admin` bounces to the normal login/403 flow —
  exactly as before 32.9 (guards unchanged; backend remains the
  authority).

## 6. BILLING TEST

- As HR/admin: open the Billing page from the sidebar → its chunk loads
  on first visit, plans/subscription render as before.
- As ordinary employee: billing is not offered, direct URL follows the
  same behavior as before (page-level role check + server authority).

## 7. PERMISSION / AUTH REGRESSION (quick pass)

- Log out / log in — normal.
- Open 2–3 pages you use daily (Dashboard, Documents, one Attendance
  page) — all normal.
- Kiosk sanity: `http://localhost:5173/kiosk` still loads and behaves
  (it was already lazy and untouched).

## 8. STRICT MODE NOTE (dev-only duplicate effects)

In `npm run dev` you may see an endpoint fetched TWICE on first mount
of a page (React StrictMode double-runs effects in development). This
is a dev-only diagnostic — `npm run build` + `npm run preview` does not
do it. Do not "fix" it by removing StrictMode.

## 9. PRODUCTION BUILD (real numbers)

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm run build
npm run preview
```

Expected: `✓ built in ~1–2s`, no errors. `npm run preview` serves the
real production bundle (usually `http://localhost:4173`) — repeat §3
there for honest production numbers. Do NOT judge performance by
`npm run dev` (unminified dev serving).

## 10. ACCEPTANCE CHECKLIST (leave UNCHECKED until YOU see it)

- [ ] Frontend dev server starts; login page renders.
- [ ] Login/auth flow works.
- [ ] Initial load does NOT download Super Admin or Billing chunks for a tenant user (§3).
- [ ] Payroll/Attendance pages load on demand with a brief loading state (§4).
- [ ] Refresh on a deep lazy route works (§4).
- [ ] Back/forward navigation works (§4).
- [ ] Super Admin console works for the platform account; tenants still excluded (§5).
- [ ] Billing page works for HR/admin (§6).
- [ ] `/kiosk` unaffected (§7).
- [ ] `npm run build` passes; `npm run preview` serves correctly (§9).
- [ ] No visual regression (dark theme, sidebar, pages look the same).
- [ ] No Phase 1–31 behavior regression observed.

---

*Phase 32.9 awaiting localhost acceptance.*
