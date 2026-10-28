# Area navigation — a few rows in the rail, a tab strip in the page

Two sections of this product had grown into scrollbars. Payroll had seventeen
routes and fifteen sidebar rows; Time & Leave had nineteen. That is not a
section of an HR product, it is a second product stacked under one word, and it
pushed every other module below the fold.

Both now use the Settings screen's pattern: **the rail lists an AREA**, and the
pages inside that area are a horizontal tab strip at the top of the page.

---

## The shape

```
rail                          page
────                          ────
Attendance          →         [ My attendance | My timesheet | Attendance reports | Analytics ]
Leave & holidays    →         [ My leaves | Leave approvals | Holiday calendar ]
Requests            →         [ Regularizations | Work modes | Overtime & comp-off ]
Team & presence     →         [ Who's working | Team availability | Team timesheets ]
Shifts & schedules  →         [ Shifts & rosters | Work schedules ]
Attendance setup    →         [ Policy | Operations | Kiosks | QR challenges | Import ]

Payroll             →         [ Payroll center | Monthly inputs | Run payroll | Review & approval | Salary payment | Analytics & reports ]
Salary architecture →         [ Components & rules | Structures | Statutory & compliance | Company setup ]
Payslips            →         [ Payslip workspace | Final settlement | My payslips (you) | My settlement (you) ]
```

The strip is deliberately the *Settings* tab shape, not a second sidebar: the
active tab is a filled copper pill, the rest are plain text, and the strip wraps
rather than scrolls so nothing is hidden on a laptop.

---

## One definition, two readers

| file | who reads it |
| --- | --- |
| `src/config/timeNav.js` | `layout/AppLayout.jsx` (rail rows) + `components/time/TimeSectionTabs.jsx` (strip) |
| `src/config/payrollNav.js` | `layout/AppLayout.jsx` (rail rows) + `components/payroll/PayrollSectionTabs.jsx` (strip) |
| `src/components/common/AreaTabs.jsx` | the pixels, shared by both strips so they cannot drift apart |

A page therefore cannot be reachable one way and invisible the other.
`AppRoutes.jsx` wraps every page of both modules in `inTime(…)` / `inPayroll(…)`,
which is what draws the strip — so a new page cannot ship without one.

## Who sees what

Each tab keeps the permission array its old sidebar row carried, verbatim, so
this change moved navigation and nothing about access:

- a tab is drawn when the person holds at least one of its permissions;
- where a route has a *role* gate and no permission of its own to read
  (`/app/schedules` — HR builds the schedules), the tab honours the same role
  audience rather than inventing a permission that does not exist;
- an area appears in the rail only when the person can open at least one of its
  tabs, and the row lands on the **first tab they can actually open** — an
  employee's row must not drop them on a manager's page;
- the strip stays hidden until permissions have loaded, and an area that
  resolves to a single tab draws no strip (one pill is noise, not navigation).

Four tabs carry no gate at all because they are personal surfaces and were
ungated rows before too: My attendance, My leaves, Holiday calendar, Shifts &
rosters. `test/timeNavigation.test.js` pins that the ungated list cannot grow
to include a management page.

## Consequences worth naming

- **Breadcrumbs had to learn a second source.** The header used to take the page
  name from the sidebar row that owned the path. Those rows are gone, so
  `utils/breadcrumb.js` now reads `TIME_PAGE_TITLES` / `PAYROLL_PAGE_TITLES` —
  the same words the tabs use. Steps that are not tabs (a staged import batch,
  an employee's payroll record, each payroll sub-report) are named explicitly
  instead of collapsing to the area name.
- **An area row stays lit across its own tabs.** Prefix matching cannot express
  that — `/app/attendance/policy` would light the *Attendance* row instead of
  *Attendance setup* — so area rows carry `ownerPaths` (every path the area
  owns) and `SidebarNav` matches against that set.
- **The role menus no longer list these pages.** `NAV_BY_ROLE` used to carry
  `Attendance`, `My Leaves`, `Holidays`, `Shifts`, `Work Schedules`, `My
  Payslips` for every role. Those rows are now generated from the two configs,
  so keeping them would have produced two doors to the same page in one group.
- **`/app/payslips` forwards** to `Payslips › My payslips`; the thinner duplicate
  page it used to render is gone.
- **No backend, schema or permission changed.** Frontend only.

## Verification

`npm test` → **710 passing** — 9 pins in `test/timeNavigation.test.js` and 9 in
`test/payrollNavigation.test.js`: every tab is a real route, every route is
reachable, every tab page is wrapped in its strip, every tab has a breadcrumb
title in the right section, the rail and the strip read one config, and the
audience for each area is what the old rows granted (employee and manager cases
are asserted tab by tab).

`npm run build` green. `npx eslint src` → 117 problems (103 errors, 14
warnings), the same as before the change.

No browser is available in this environment, so this is verified by lint, build
and source pins — not by pixel comparison.
