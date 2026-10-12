# Employees UX Redesign (Figma pass — list surface)

Owner-provided Figma frames (batch of 2026-10-12): `Employee`, `Employee -
Filter`, `Employee - New Profile`, `Employee - New Profile - Select Date`,
`Employee - Directory` are implemented in this unit on top of the existing,
fully wired `/app/users` page (`Frontend/src/pages/users/UsersPage.jsx`).
The remaining frames (`Employee - Detail *` tabs, OTP, onboarding wizard,
Home V1/V2 + welcome popup) are deferred — see §4.

The existing page already carried the real backend contract end to end
(GET `/api/users` with `search|role|department|status` + pagination, POST
`/api/users`, PATCH `/users/:id`, POST `/users/:id/reset-password`,
permission gates via `CREATION_RIGHTS`). This unit is a visual + structural
pass over that working page — no endpoint was added, removed, or re-semanticized.

## 1. What maps to what

| Figma element | Implementation | Notes |
| --- | --- | --- |
| Title "Employees" + subtitle | `Employees` + truthful count line ("N people in your company") | artwork subtitle carried a typo; count is real from `meta.total` |
| Download button | real client-side CSV of the current filter set (cap 200 rows, the backend per-request cap) via blob + `createObjectURL` | never a dead button |
| + Add New | opens the Figma right slide-over drawer (create only) | gated by `CREATION_RIGHTS` as before |
| Search / All Offices / All Job Titles / All Status | search + **All Departments / All Roles / All Status** | backend filters are `department|role|status`; there is no Office column, so that artwork filter is not faked |
| Table columns | Employee (avatar/initials + name + email), Job Title (`designation` else role label), Line Manager (`reportingTo.name`), Department, Employee Status pill, actions | artwork's "Office" and "Account" columns have no backend field — omitted, not faked |
| Status pills | `ACTIVE` (green) / `INACTIVE` (red) only | artwork's ON BOARDING / PROBATION / ON LEAVE have no backend field — not rendered |
| Pagination ‹ 1 2 3 … N › | numbered pagination with ellipsis from `meta.pages` | real page jumps |
| Directory (card grid) | view toggle on the same page; cards show avatar/initials, name, designation/role, email, phone (phone row hidden when empty) | same endpoint, limit 24/page |
| Add New Profile drawer | First Name* + Last Name* (joined into the backend's single `name`), Email Address*, Join Date* (`dateOfJoining`), inline "This field is required." red-ring errors | artwork's custom calendar popover replaced by the native date input used app-wide |
| Date picker popover (artwork) | native `<input type="date">` | functional + accessible; a hand-rolled calendar would be cosmetic-only |

## 2. Figma defects fixed, not propagated

- The artwork drawer shows only First/Last/Email/Join Date, but POST
  `/api/users` **requires** `role` and `password` (min 8). The drawer keeps a
  Role select and an Initial Password field with a helper note — hiding them
  would make every submit fail.
- Artwork typos ("Employeee", "This is director board") not copied.
- Artwork status pills (ON BOARDING / PROBATION / ON LEAVE) and the Office /
  Account columns have no backend fields; rendering them would be fabricated
  data (§14), so they are omitted.
- Row checkboxes in the artwork have no bulk action anywhere in the set —
  omitted (no dead controls).

## 3. Theming

The post-login shell (`AppLayout`/`SidebarNav`) is dark-only today; the light
palette exists solely under `.auth-root[data-theme="light"]` (auth unit).
Scoping a light island inside the dark shell would produce a broken hybrid
(the same hazard that kept the global `[data-theme]` flip out of the 144-file
app), so this unit ships on the shell's existing token classes
(`card`, `input`, `btn-primary`, `btn-ghost`, `crewly-*`) and the app-shell
light mode arrives with the deferred shell/Home unit, whose artwork includes
the sidebar Light/Dark switch.

## 4. Deferred (not dropped)

| Frame(s) | Reason |
| --- | --- |
| Employee - Detail (General/Job/Payroll/Documents/Setting) | new route + per-user documents surface; slice 2 of this redesign, needs its own endpoint audit (personal docs, payslips per user) before implementation |
| OTP Verification | no OTP endpoint in the backend (reset is a token link) — unchanged from the auth unit deferral |
| Onboarding wizard steps 1–4 | fields (domain, size, industry, role-in-company, use-case) have no backend storage; register accepts exactly `{companyName, adminName, email, password}` |
| Home V1/V2 + welcome popup | artwork stats are fabricated; the shell redesign it implies is §15 scope; a Light/Dark shell switch belongs there |

## 5. Gates

`npm test` (frontend) green including `test/employeesFigmaPass.test.js`;
`npm run build` green; `npm run lint` at the pre-existing baseline; eslint on
touched files clean.
