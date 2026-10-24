// ═══════════════════════════════════════════════════════════════════════════
// EMPTY STATE — the one way this app says "nothing here yet".
//
// Before this component every empty list invented its own sentence: a bare
// `text-crewly-dim` paragraph, a dashed border, a lone lucide icon, sometimes a
// sentence with an exclamation mark. Twenty modules produced twenty different
// shades of nothing.
//
// An empty state is not a dead end: it is the first thing a new workspace sees,
// so it carries three things — a picture, a sentence that says what will appear
// here, and (where the screen has one) the action that fills it.
//
// Usage
//   <EmptyState illustration="calendar" title="No leave requests yet"
//               description="Requests from your team land here for approval." />
//   <TableEmpty colSpan={5} illustration="documents" title="No documents yet" />
// ═══════════════════════════════════════════════════════════════════════════

import EmptyIllustration from './EmptyIllustration.jsx';

const SIZES = {
  xs: 'h-16 w-24',
  sm: 'h-24 w-40',
  md: 'h-36 w-56',
  lg: 'h-44 w-72',
};

const PADDING = {
  xs: 'py-3',
  sm: 'py-6',
  md: 'py-10',
  lg: 'py-14',
};

const EmptyState = ({
  illustration = 'inbox',
  title,
  description = null,
  action = null,
  size = 'md',
  className = '',
}) => (
  <div
    className={`flex flex-col items-center justify-center px-4 text-center ${PADDING[size] || PADDING.md} ${className}`}
  >
    <EmptyIllustration name={illustration} className={SIZES[size] || SIZES.md} />

    <p className="mt-3 text-sm font-semibold text-crewly-text">{title}</p>

    {description ? (
      <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-crewly-dim">{description}</p>
    ) : null}

    {action ? <div className="mt-4">{action}</div> : null}
  </div>
);

// The same thing inside a table body, so a list does not lose its columns when
// it has no rows.
export const TableEmpty = ({
  colSpan,
  illustration = 'inbox',
  title,
  description = null,
  action = null,
  size = 'sm',
}) => (
  <tr>
    {/* A wide table scrolls sideways, so the empty state is pinned to the
        visible part of the card: `min(100%, 100vw)` keeps the box the width of
        the viewport when the row is 1,100px wide, and `sticky left-0` holds it
        in view instead of parking it in the middle of the scroll. */}
    <td colSpan={colSpan}>
      <div className="sticky left-0 px-4" style={{ width: 'min(100%, 100vw)' }}>
        <EmptyState
          illustration={illustration}
          title={title}
          description={description}
          action={action}
          size={size}
        />
      </div>
    </td>
  </tr>
);

export default EmptyState;
