# Empty states

The app has one way of saying "nothing here yet":

```jsx
import EmptyState, { TableEmpty } from '../../components/common/EmptyState.jsx';

<EmptyState
  illustration="documents"
  title="No documents yet"
  description="Upload a file above, and anything HR issues to you appears here by category."
  action={<button className="btn-primary px-4 py-2 text-sm">Upload</button>}
/>

// inside <tbody>
<TableEmpty colSpan={6} illustration="calendar" title="No leave requests yet"
            description="Requests from your team land here for approval." />
```

## Why

Before this, every module invented its own version: a bare `text-crewly-dim`
sentence, a dashed box, a lone lucide icon, sometimes a sentence with an
exclamation mark. The screens a brand-new workspace sees first were the least
designed ones.

An empty state is not a dead end. It carries four things, in this order:

1. **a picture** — `components/common/EmptyIllustration.jsx`, 14 flat scenes;
2. **a short headline** — `text-sm font-semibold`, no full stop, no `!`;
3. **one line** saying what will appear here and who makes it appear;
4. **the action** that fills it, when the screen has one.

## Rules

- **Art is original and inline.** No bitmaps, no remote URLs, no third-party
  illustration sets (Storyset etc. were a style reference only). Every scene
  shares one `320×200` frame so panels line up across the app.
- **Copy stays honest.** Describe what will appear and what causes it. Never
  imply data exists, never invent counts, never cheer.
- **Do not re-theme.** The art sits inside the existing dark card system; the
  scenes use the app's own green/blue/purple/orange mid-tones at low alpha.
- **Tables keep their columns.** Use `TableEmpty`, not a paragraph under the
  table. It pins itself to the visible part of a horizontally scrolling card.
- **Sizes**: `sm` (panels, dialogs, side lists), `md` (page-level cards, the
  default), `lg` (full-page moments).

## Scenes

`inbox`, `calendar`, `payslip`, `team`, `documents`, `chat`, `tasks`, `chart`,
`bell`, `box`, `search`, `shield`, `hiring`, `wallet`.

Pick by *meaning*, not by module: filtered-to-nothing lists use `search`,
all-clear / audit trails use `shield`, money uses `payslip` or `wallet`.

## Analytics

`pages/payroll/analytics/analyticsShared.jsx` re-exports an `EmptyState` and a
`DataTable` that every payroll report uses. Give `DataTable` an `empty` line;
add `emptyTitle` / `emptyIllustration` when the default is not specific enough.

## Tests

`test/emptyStates.test.js` pins the art module (offline, vector, one frame), the
component contract (composition order, sizes, table variant) and adoption across
modules. `test/teamAvailability.test.js` covers the copy of the team table.
