# Organization structure

`/app/org-chart` — who reports to whom, in three views over one payload.

## Data

One request: `GET /api/users/hierarchy` → `{ data: [rootNodes] }`. Each node is a
person plus `children`, already scoped by the backend:

| Viewer | Sees |
| --- | --- |
| `COMPANY_ADMIN`, `HR_MANAGER` | the whole company |
| everyone else | their own department, or their own reporting chain if they have no department |

The page adds nothing to that. No sample roster, no invented headcount: every
number on screen is counted from the payload (`genuinely counted`, below), and an
empty payload renders the shared empty state rather than a fake card.

## The three views

| View | Question it answers | Built from |
| --- | --- | --- |
| Chart Canvas | who sits under whom | the tree, recursively, with a spine and elbow per level |
| Hierarchy List | show me everyone, in order | the same tree flattened depth-first, depth kept as indent |
| Department Grid | who is in Payroll | the same tree grouped by `department` |

Switching views never refetches — all three read the same `roots`.

## Counted, never typed

```
Total Members  = every node in the tree
Departments    = distinct non-empty department names
Direct Reports = children of the viewer (falling back to the first root)
```

`Direct Reports` describes *you*, not the CEO: an HR manager who sits three
levels down must not be shown the top of the chart's report count.

## Filtering

The search box matches name, employee code, designation, department and role
label. A match keeps its **ancestors** — a filtered tree is still a tree, so you
can see where the person sits instead of getting an orphan row. The department
select applies the same way. When nothing matches, the page says so and offers a
way back rather than showing an empty frame.

## Add Member

Only rendered for someone holding `USER_CREATE`, which is exactly what
`POST /api/users` requires on the server. It links to User Management — the page
where a person is actually created — instead of duplicating that form here.

## Placement line

`designation · department`, minus the repetition: the API often returns
`"Human Resource"` for both, and `Human Resource · Human Resource` reads like a
bug. Only the display is de-duplicated.

## The header breadcrumb

`People › Organization Structure`, in `AppLayout`'s header for every page.

- the page half is derived from the same `menu` the sidebar renders;
- the section half comes from `src/utils/breadcrumb.js`, longest prefix wins;
- a few routes have a shorter sidebar label than page title (`Organization` vs
  `Organization Structure`) — that mapping lives in `PAGE_TITLES`, one place.

The sidebar's `NAV_GROUPS` and the breadcrumb's `SECTIONS` are deliberately
separate (the groups are a rendering concern of `SidebarNav`), so
`test/orgChart.test.js` fails if a label exists in one and not the other.

## Responsive

- **≥ sm** — full tab labels, department name beside the search box, the
  breadcrumb in the header.
- **< sm** — tabs read `Chart / List / Departments`, the department select and
  the collapse control stack under the tabs, and the header drops the breadcrumb
  (the page's own `<h1>` is an inch below it).

Verified at 1440 and 390 in both themes: no horizontal overflow, no console
errors.

## Tests

`test/orgChart.test.js` — one endpoint only, three views over the same tree,
counters derived, ancestors kept by the filter, the empty and no-match states,
the `USER_CREATE` gate, the placement de-duplication, and the breadcrumb's
agreement with the sidebar.
