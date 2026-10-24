// ═══════════════════════════════════════════════════════════════════════════
// BAR CHART — vertical bars that grow from the baseline.
//
// Sized for a dashboard card, not for an analytics page: no axes library, no
// tooltips, no zoom. The value sits above each bar in text, so the chart is
// still readable when the animation is paused or the reader is on a screen
// reader.
// ═══════════════════════════════════════════════════════════════════════════

const BarChart = ({
  bars = [],
  height = 132,
  className = '',
  valueFormatter = (value) => value,
  maxBarWidth = 34,
}) => {
  const safe = bars.map((bar) => ({ ...bar, value: Math.max(0, Number(bar.value) || 0) }));
  const max = Math.max(1, ...safe.map((bar) => bar.value));

  return (
    <div className={className} role="img" aria-label={safe.map((bar) => `${bar.label}: ${bar.value}`).join(', ')}>
      <div className="flex items-end gap-2" style={{ height }}>
        {safe.map((bar, index) => {
          const pct = (bar.value / max) * 100;
          return (
            <div
              key={bar.label}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
            >
              {/* The value rides directly above its own bar: the column ends at
                  the baseline, so the two read as one object. */}
              <span className="mb-1 text-[11px] font-semibold text-crewly-text">
                {valueFormatter(bar.value)}
              </span>
              <div
                className="chart-bar w-full rounded-t-md"
                style={{
                  maxWidth: `${maxBarWidth}px`,
                  height: `${Math.max(pct, bar.value ? 4 : 0)}%`,
                  backgroundColor: bar.color,
                  animationDelay: `${index * 80}ms`,
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex gap-2 border-t border-crewly-border pt-2">
        {safe.map((bar) => (
          <span
            key={bar.label}
            className="min-w-0 flex-1 truncate text-center text-[10px] uppercase tracking-wide text-crewly-dim"
          >
            {bar.label}
          </span>
        ))}
      </div>
    </div>
  );
};

export default BarChart;
