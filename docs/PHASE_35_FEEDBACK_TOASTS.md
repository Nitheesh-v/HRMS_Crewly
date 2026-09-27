# Phase 35 — Feedback toasts (35.1)

**Status:** 35.1 implemented and verified locally — **awaiting localhost acceptance**.

The request behind this phase: *"add toasters for all like errors, successful etc where it needed"*.
The attendance mistakes the person mentioned separately are **not** part of this unit; they come next.

---

## 1. What was missing before 35.1

| Finding | Where |
| --- | --- |
| No toast system at all | the app had four hand-rolled `flash()` banners and nothing global |
| Five blocking `window.alert()` calls | billing, exit, assets, meetings ×2 |
| 64 inline "message" flags across 63 page files | each page re-invented its own success/error box |
| Failures on background calls were silent | a page could fail a save and say nothing at all |
| Session expiry left the person on a dead screen | `crewly:auth-expired` was fired but nothing spoke to the person |

## 2. The foundation (35.1)

| File | Role |
| --- | --- |
| `Frontend/src/utils/notify.js` | React-free wrapper over `sonner`: `success` / `info` / `warning` / `error` / `successFrom` / `run` / `dismiss` / `clear`, plus a 6 s dedupe and 1500 ms error coalescing. Importable from axios interceptors and socket handlers, not just components. |
| `Frontend/src/components/AppToaster.jsx` | The single `<Toaster>` host, mounted once in `App.jsx`. Dark theme, top-right, `closeButton`, four visible toasts, Crewly hex colours. Owns the `crewly:auth-expired` listener → "Session expired" card. |
| `Frontend/src/services/failureReporter.js` | `attachFailureReporter(instance)`: the global failure net. Skips cancelled requests, `config.skipErrorToast === true`, `/auth/refresh`, and session-death 401s (except the public auth paths). Per-endpoint latch so a polling page cannot stack identical toasts; the latch clears on the next success. **4xx stays with the page** — the net only speaks for network and 5xx failures. |
| `Frontend/src/services/api.js` + `Frontend/src/main.jsx` | Reporter attached to the app client **and** to the global axios default, which covers the seven services that build their own client (`attendanceCaptureService`, `bgvCollectionService`, `bgvConsentService`, `bgvVerifierAuthService`, `offerService`, `preOnboardingService`, `publicCareerService`). |

Dependency: **sonner 2.0.8** (approved for this unit). It injects its own CSS — no style import, theme through `toastOptions.style`.

### The rules the layer follows

1. **One surface per event.** When a page raises its own toast, the request carries `skipErrorToast` so the net stays quiet.
2. **Success is quiet by default.** Only mutations that change something the person asked for (save, create, delete, queue an export, leave a group) speak.
3. **Failures keep the server's own words** when there are words to keep: `notify.error(error, 'Fallback sentence')` renders the server message with the fallback as the description.
4. **Validation stays inline.** "Passwords do not match" is a warning next to the field, not a toast in the corner.
5. **Interactive retry affordances are never swept away.**

## 3. What 35.1 converted

### Earlier in the same unit (already in this tree)

* 27 `flash()` re-points and the removal of the five `window.alert()` calls.
* The `flash()` helpers themselves: they still exist where pages want a local helper, but their bodies now call `notify.*`.
* `login/LoginPage`, `payroll/PayrollSetupPage`, `org-chart/OrgChartPage`, `attendance/AttendanceOvertimePage`, `documents/MyDocumentsPage`, `payroll/MyFinalSettlementPage`, `payroll/MyPayslipsPortalPage`, `payroll/SalaryPaymentPage`, `payroll/StatutoryCompliancePage`.
* `settings/RolesPermissionsPage`, `profile/MyProfilePage`, `departments/DepartmentsPage`, `announcements/AnnouncementsPage`, `leaves/LeavesPage`, `support/SupportPage` — dead state removed, success toasts added, and the role-deactivation refusal keeps its explanation ("Still held by …") as the toast description.
* **Payroll analytics (17 pages).** `ExportMenu` now raises the queued / downloaded toast itself (it is the only place that knows which happened), `useReport` reports load failures through `notify.error(err, 'Unable to load this report')`, and the per-page `banner` plumbing is gone. The shared `<Banner>` component **stays** — four pages use it for data-integrity notices that are part of the report, not a transient message (`Deductions`, `Earnings`, `PayrollOverview`, `ScheduledReports`).
* **`chat/ChatPage`.** Six success toasts: conversation disabled / re-opened, members added, member removed, left the group, group created, message removed for everyone.

### The sweep in this unit (28 files, `.tmp_toast_convert.py`)

Every one of these lost its private `error` / `message` / `notice` state, its inline render, and its setter calls now report through `notify`:

```
components/attendance/KioskPinCard.jsx                    components/recruitment/CandidateBgvPanel.jsx
components/recruitment/CandidateOfferPanel.jsx            components/recruitment/InterviewScheduleModal.jsx
components/recruitment/OfferEditor.jsx                    pages/admin/SuperAdminBgvCataloguePage.jsx
pages/admin/SuperAdminBgvOpsDashboardPage.jsx             pages/admin/SuperAdminBgvQaPage.jsx
pages/admin/SuperAdminBgvVerifiersPage.jsx                pages/admin/SuperAdminCommercePage.jsx
pages/admin/SuperAdminCompaniesPage.jsx                   pages/admin/SuperAdminOperationsPage.jsx
pages/attendance/AttendanceReportPage.jsx                 pages/bgvVerifier/BgvVerifierForgotPage.jsx
pages/bgvVerifier/BgvVerifierLoginPage.jsx                pages/bgvVerifier/BgvVerifierResetPage.jsx
pages/bgvVerifier/BgvVerifierSetupPage.jsx                pages/notifications/NotificationSettingsPage.jsx
pages/recruitment/BackgroundVerificationPage.jsx          pages/recruitment/BackgroundVerificationSettingsPage.jsx
pages/recruitment/CandidateInboxPage.jsx                  pages/recruitment/ConvertToEmployeePage.jsx
pages/recruitment/InterviewsPage.jsx                      pages/recruitment/OfferTemplatesPage.jsx
pages/recruitment/OffersPage.jsx                          pages/recruitment/PreOnboardingPage.jsx
pages/recruitment/PreOnboardingRequirementsPage.jsx       pages/recruitment/RecruitmentDashboardPage.jsx
```

The converter is deliberately **all-or-nothing per state variable**: if a setter call or a render does not match a shape it knows exactly, the file is skipped rather than half-converted, so a page can never end up double-surfacing (inline banner *and* toast).

## 4. Deliberate exceptions (kept inline, on purpose)

| Surface | Why it stays |
| --- | --- |
| The six attendance pages (`AttendancePage`, `AttendanceTeamPage`, `AttendanceAnalyticsPage`, `AttendanceOperationsPage`, `AttendanceTimesheetPage`, `AttendanceTeamTimesheetsPage`) | The error box **is** the retry affordance — it carries the button. Replacing it with a toast would remove the only way to try again. |
| `components/chat/*` (composer, attachment picker/bubble, edit-message modal, new-conversation modal) | Phase 34 contracts: a chat failure shows the server's own sentence next to the control that caused it. |
| The four analytics data-integrity `<Banner>` notices | They describe the report's own numbers, not a transient event. |

## 5. Still to convert (next unit)

39 files keep a private feedback state that the sweep could not convert safely. They are not double-reporting — they are simply not converted yet:

* **Load-error banners that also gate rendering** (the hardest group): `AnalyticsPage`, `AnalyticsHubPage`, `CareerJobsPage`, `GovernancePage`, `LeaveApprovalsPage`, `NotificationsPage`, `MyPayslipsPage`, `PayrollPage`, `ProjectsPage`, `ProjectDetailPage`, `TasksPage`, `SecuritySettingsPage`, `AuditLogsPage`, `SecurityDashboardPage`, `SubscriptionPage`, `CandidateDetailPage`, `OfferDetailPage`, `PreOnboardingDetailPage`, `BackgroundVerificationDetailPage`, `BgvVerifierCheckDetailPage`, `BgvVerifierWorkPage`, `SuperAdminBgvBillingPage`, `SuperAdminBgvOperationsPage`, `SuperAdminCompanyDetailPage`, `SuperAdminDashboardPage`, `CareerApplyShellPage`, `Candidate*PortalPage` ×3, `InfoRequestPanel`.
* **Dual-purpose flags** where one state carries both success and failure (`TasksPage`, `ProjectsPage`, `CandidatePreOnboardingPanel`, `InterviewFeedbackModal`, …) — these need the two paths split before the state can go.
* **Modal-level validation** (`CreateTaskModal`, `TaskDetailModal`, `CandidateFinalReview`, `CandidateBgvDecisionSection`, `InterviewDetailModal`, `BgvCollectionPortal`, `AttendanceFinalizationPanel`) — the same "next to the control" reasoning as chat.

## 6. Verification (real output from this machine)

| Check | Result |
| --- | --- |
| `npm run build` (Frontend) | **✓ built in 1.66 s** |
| `npm run lint` vs the pre-unit baseline (135 = 115 errors / 20 warnings) | **128 problems = 109 errors / 19 warnings — 0 new, 7 removed** |
| `npm run test:toasts` | 11 pins |
| `npm run test:chat` | 480 tests / 31 suites / 0 fail |
| `npm run test:all` | see the close-out message for the run of this tree |

The pins live in `Backend/test/frontendToastFoundation.test.js` and read the Frontend sources (there is no browser test runner in this repo). They assert: sonner is the only toast dependency and only `notify.js` imports it; `notify.js` stays React-free; one host is mounted, in the dark theme, and owns the session card; the reporter skips exactly four kinds of request and never rewrites the error; both axios clients are covered; the five blocking dialogs are extinct; the private `flash()` helpers now report through `notify` and park no banner; the attendance retry affordances survived; `LoginPage` and `RolesPermissionsPage` still speak; the layer carries no emoji; and this document exists.

## 7. Limitations

* Toasts are per-request feedback, not an audit trail. Nothing here is persisted, and a toast that is missed is gone.
* The dedupe (6 s) and the error coalescing (1500 ms) are per browser tab. Two tabs will each speak.
* The reporter's latch is per endpoint path. Two different endpoints failing at once produce two toasts.
* `notify` is called from non-React modules; it needs the Redux/`App.jsx` tree mounted to render, so a failure during boot shows in the console, not on screen.
* No backend behaviour changed in this unit: no new endpoints, no schema, no Redis keys.
* The sweep's converter is a build-time helper, not shipped code.

## 8. Localhost verification (PowerShell)

```powershell
cd Frontend
npm install
npm run dev
```

Then, in the browser at `http://localhost:5173`:

1. **Success toast** — Departments → create a department. A green toast appears top-right and the page no longer shows an inline "Created" line.
2. **Server sentence kept** — Roles & Permissions → try to deactivate a role that is still held by someone. The toast shows the server's own explanation in the description line.
3. **Session expiry** — sign in, then clear the access cookie (DevTools → Application → Cookies) and click anything that calls the API. One "Session expired" card appears, not a stack.
4. **No double toast** — open a payroll analytics report for a month with no data. One toast for the load failure, no inline banner and no second toast from the net.
5. **Retry still there** — Attendance → Team. Force a failure (DevTools → Network → Offline → Retry). The inline error box with its Retry button is still the thing that lets you try again.
6. **Chat** — create a group and add a member. Two success toasts ("Group created", "Member added"); a failure still appears next to the control that caused it.

Sign-off line for the unit: **Phase 35.1 awaiting localhost acceptance.**
