// ═══════════════════════════════════════════════════════════════════════════
// STACKED BAR — one horizontal bar per row, split into its parts.
//
// Used for leave balance (used vs remaining per type) and for any "of this,
// how much" figure. The bar is plain flex/percentage markup, not SVG, because
// the numbers next to it are text and should wrap like text.
// ═══════════════════════════════════════════════════════════════════════════

export const StackedBar = ({ parts = [], height = 8, className = '', trackClassName = '' }) => {
  const total = parts.reduce((sum, part) => sum + Math.max(0, Number(part.value) || 0), 0);

  return (
    <div
      className={`flex w-full overflow-hidden rounded-full bg-crewly-inset ${trackClassName} ${className}`}
      style={{ height }}
      role="presentation"
    >
      {total > 0 &&
        parts.map((part, index) => {
          const value = Math.max(0, Number(part.value) || 0);
          if (!value) return null;
          return (
            <div
              key={part.label || index}
              className="chart-split h-full origin-left first:rounded-l-full last:rounded-r-full"
              style={{
                width: `${(value / total) * 100}%`,
                backgroundColor: part.color,
                animationDelay: `${index * 90}ms`,
              }}
              title={`${part.label}: ${value}`}
            />
          );
        })}
    </div>
  );
};

// A labelled row: name on the left, "used / total" on the right, bar beneath.
export const SplitRow = ({
  label,
  used = 0,
  total = 0,
  colors = ['var(--chart-half)', 'var(--chart-muted-soft)'],
  unit = 'days',
}) => {
  const usedValue = Math.max(0, Number(used) || 0);
  const totalValue = Math.max(0, Number(total) || 0);
  const remaining = Math.max(0, totalValue - usedValue);

  return (
    <li className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium text-crewly-text">{label}</span>
        <span className="shrink-0 text-[11px] text-crewly-dim">
          <span className="font-semibold text-crewly-text">{usedValue}</span>
          {' / '}
          {totalValue} {unit}
        </span>
      </div>
      <StackedBar
        height={6}
        parts={[
          { label: `${label} used`, value: usedValue, color: colors[0] },
          { label: `${label} remaining`, value: remaining, color: colors[1] },
        ]}
      />
    </li>
  );
};

export default StackedBar;
