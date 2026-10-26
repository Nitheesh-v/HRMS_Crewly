# Documents — the employee cabinet

`Frontend/src/pages/documents/MyDocumentsPage.jsx`, route `/app/documents`.

The page was a stack of forms: an upload strip, then one panel per category. It is
now a **cabinet**: four counted tiles, a dismissible upload panel, category tabs
with real counts, and the records themselves in list or grid view. The reference
the owner sent was a Document Management screen; the layout follows it, the
palette does not — this app is cream/sage/clay (see `docs/THEME.md`), not white
with lavender.

## Layout

```
header        icon · "Document Management" · one sentence · [Request history] [Upload document]
tiles         Available files · Action required · Storage used · Active folders
requests      only when HR is waiting — one row per request, with the upload field
upload        drag & drop (or browse) · category · file title · Process & upload
tabs          All documents · one tab per non-empty category, each with its count
toolbar       search · status · sort ·  list/grid
records       list rows or a grid of the same `shown` array
footer        "Showing N of M records · Private — …"
```

## Where the numbers come from

| Tile | Source |
| --- | --- |
| Available files | `docs.length` |
| Action required | `pending.length` (requests with `status === 'PENDING'`) |
| Storage used | sum of `size` over `docs` — there is no quota, so none is shown |
| Active folders | categories that actually contain a document |

Tabs are derived the same way: a folder exists because a file is in it, not
because the category list mentions it. `All documents` is the only fixed tab.

## What this page deliberately does not say

The reference mock promised things this product does not have, and the page
never claims them (a test enforces it):

- **no storage quota** — "24.5 MB / 5 GB" would be invented; the tile shows what
  is on disk and that it is this user's cabinet;
- **no "Encrypted AES-256" badge** — the badge says *Private · signed-in only*,
  which is true because bytes are served by the gated
  `GET /documents/:id/file` endpoint, never a public URL;
- **no e-signature checkbox** — signing is not built, so there is no dead control;
- **no "Request HR Document" button** — `POST /documents/requests` is HR asking
  an *employee* for a file (`requirePermission('DOCUMENT_CREATE')`), not the
  other way round. The secondary action is **Request history**, which is real.

## Behaviour kept from the old page

- one load: `Promise.all([getMyDocuments(), getMyDocRequests(), getDocCategories()])`
- `uploadMyDocument` with `document`, `name`, `category` on a `FormData`
- `fulfillDocRequest` for a pending HR request
- `downloadDocument(..., { skipErrorToast: true })` and the page's own sentence
  when a blob cannot be fetched
- toasts, not inline banners

## Tests

`Frontend/test/documentsPage.test.js` pins the endpoints, the derived counts, the
`aria-pressed` tab/view state, the two empty states, the honesty rules above, and
that the page contains no `indigo`/`slate`/`blue` classes from the old palette.

## Two layout traps in this repo

- A base-level `@media (max-width: 640px)` rule rewrites **any**
  `.flex.justify-between` to `flex-wrap: wrap` (and card headers to columns).
  Unlayered CSS beats layered utilities, so `flex-nowrap` will not undo it — the
  tile icons moved under the text until `justify-between` was dropped.
- `.grid.grid-cols-2` without a breakpoint twin is collapsed to one column on
  phones. The tiles are 2×2 there, so the grid carries `sm:grid-cols-2` on
  purpose even though the base class is already `grid-cols-2`.

## The HR cabinet — `/app/employee-files`

Same shape, one employee at a time: pick on the left, and the right side is that
person's cabinet (header, checkpoints, documents, requests).

The four tiles describe **the open cabinet**, not the company, because the
company list endpoint returns no document counts — a company-wide "48 files"
would be invented. With nobody picked, each tile reads `—` and says "Pick an
employee".

`STANDARD_CHECKS` (offer letter, Aadhaar/ID, salary document, contract) is a
checklist with an "On file" / "Upload" state per row. It is not a score: nothing
in the API marks a document mandatory.

Deliberately absent from the reference layout: storage quota, ZIP export, "edit
record", automatic reminder nudges and a completion percentage. None has an
endpoint. Upload / request / withdraw / delete / download are the real actions and
all still hit the same services.

## The lifecycle console — `/app/lifecycle`

`EmployeeLifecycle` is a census, not a forecast:

- four tiles read `GET /lifecycle/overview` (`counts`, `total`,
  `probationEnding`) and fall back to counting `GET /lifecycle/company` if the
  overview call fails;
- **Due soon** is the same 30-day window the overview endpoint uses for its
  probation radar; it covers probation end dates and notice-period end dates;
- **Stage rules** documents the transition graph that
  `Backend/src/controllers/lifecycleController.js` enforces — it is displayed,
  never enforced client-side;
- **Export matrix** writes a CSV of what is currently filtered, client-side.

The employee view (`My Journey`) is unchanged in behaviour: one journey, a
stepper and the event timeline.

## Tests

`Frontend/test/documentsPage.test.js` (employee cabinet) and
`Frontend/test/cabinetPages.test.js` (HR cabinet + lifecycle console) pin the
endpoints, the derived counts, the honesty rules and the absence of the old
indigo/slate palette.
