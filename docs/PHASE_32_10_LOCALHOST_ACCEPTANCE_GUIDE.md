# PHASE 32.10 — LOCALHOST ACCEPTANCE GUIDE (Beginner, PowerShell + Browser)

Status: guide for **32.10 implemented** (awaiting localhost acceptance).
Mongo required. **No Redis/worker needed.** Frontend optional (only to
see the pages that consume the changed APIs). No secrets anywhere.

---

## 0. WHAT CHANGED (plain words)

Four older list APIs (Users, Tasks, Projects, Audit Logs) were taught
the same performance/safety laws the newer pages already follow:

1. Search text is now **bounded (60 chars) and matches literally** —
   typing `.*` or weird symbols no longer sends regex machinery to the
   database (it just finds nothing, like a normal search).
2. The **Tasks board** no longer ships every task's full comment and
   attachment history in the list response (~3.5× smaller payload in
   the measured synthetic board; real boards save more). Task DETAIL
   still shows all comments/attachments — nothing missing in the UI.
3. Users/Tasks/Projects/Audit-Log pages paginate **stably** — rows can
   no longer shuffle between pages when many share the same timestamp.

## 1. START

```powershell
# Terminal 1
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev

# Terminal 2 (optional — for the UI checks)
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend
npm run dev
```

Log in as an HR/admin user (needs People, Tasks, Projects, Audit Log
visibility). Some existing data in each list makes the checks real.

## 2. SEARCH STILL WORKS (behavior unchanged for real use)

- **People (Users) page:** search a real name fragment (e.g. `pri`) →
  same results as before. Search a 200-character nonsense string →
  clean result (empty or partial match), never an error/hang.
- Search `*.*` or `(` → treated as LITERAL text (finds nothing) — that
  is the 32.10 fix; before, regex characters reached the database.
- Same quick check on **Tasks** (search box), **Projects**, and
  **Audit Logs** (HR/admin area).

## 3. TASKS BOARD — PAGES WORK, DETAILS COMPLETE

- Open the Tasks page: list renders exactly as before (title, status,
  priority, assignee, project, due date).
- Open a task's detail modal → **comments and attachments are all
  still there** (they come from the detail endpoint — the LIST just
  stopped carrying them unnecessarily).
- Confirm in DevTools → Network: the initial `GET /api/tasks` response
  is small (transfer column), while `GET /api/tasks/:id` for an open
  task carries the history.

## 4. PAGINATION STABILITY + BOUNDS

On the Users page (or any of the four lists):

- Page through pages 1 → 2 → 3 → back to 2: the same rows stay on the
  same pages (stable order — the 32.10 tie-breaker).
- Power-shell check that an excessive limit is still clamped
  (`$token` = a valid local token from your login; never paste it into
  chats):

```powershell
$token = "<your-local-access-token>"
$headers = @{ Authorization = "Bearer $token" }
$r = Invoke-RestMethod -Uri "http://localhost:5000/api/users?page=1&limit=100000" -Headers $headers
$r.data.Count        # clamped (max 200), not 100000
```

- Invalid sort/filter inputs behave exactly as before (this phase added
  NO new query parameters and removed none).

## 5. TENANT / RBAC SPOT CHECK (unchanged by law)

- Log in as a second, lower-privileged user: the same four lists show
  only what they showed before 32.10 (scope/permission middleware was
  not touched).
- Cross-company data never appears (tenant filter untouched).

## 6. PAYROLL / ATTENDANCE SANITY (audited A-class, untouched)

- Open a payroll register/review page and one attendance analytics
  page: figures identical to before (no recalculation anywhere —
  read paths were verified lean/bounded and left alone).

## 7. OPTIONAL: AUTOMATED EVIDENCE

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run test:api-bounds      # 11/11 — bounds, escape matrix, pins, payload delta
npm run test:all             # full suite
```

## 8. ACCEPTANCE CHECKLIST (leave UNCHECKED until YOU see it)

- [ ] Backend starts normally; health routes fine.
- [ ] Login + normal navigation work.
- [ ] Users search behaves identically for real queries; regex characters are literal.
- [ ] Tasks board renders as before; task detail still shows all comments/attachments.
- [ ] `GET /api/tasks` response is visibly smaller in DevTools Network.
- [ ] Projects + Audit Logs search/lists behave normally.
- [ ] Paging is stable (no row shuffle between page views).
- [ ] Excessive `limit` stays clamped.
- [ ] Lower-privileged user sees exactly their previous scope.
- [ ] Payroll/attendance figures unchanged.
- [ ] No Phase 1–31 regression observed.

---

*Phase 32.10 awaiting localhost acceptance.*
