// ═══════════════════════════════════════════════════════════════════════════
// DONUT — one ring, one row of segments, one number in the middle.
//
// Hand-drawn SVG rather than a charting dependency: the app ships four of these
// and a library would cost 100 kB to draw them. `pathLength={100}` lets every
// segment be expressed in percentages, so the maths stays readable.
//
// Accessibility: the svg is decorative (`aria-hidden`); the legend underneath
// carries the same numbers as text, which is what a screen reader should hear.
// ═══════════════════════════════════════════════════════════════════════════

const SIZE = 148;
const STROKE = 16;

const DonutChart = ({
  segments = [],
  centerValue,
  centerLabel,
  className = '',
  ariaLabel = 'Breakdown',
  size = SIZE,
  thickness = STROKE,
}) => {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.value) || 0), 0);
  const radius = (size - thickness) / 2;
  const center = size / 2;

  let cursor = 0;

  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="presentation"
        aria-hidden="true"
        className="-rotate-90"
        fill="none"
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          stroke="var(--chart-track)"
          strokeWidth={thickness}
        />
        {total > 0 &&
          segments.map((segment, index) => {
            const value = Math.max(0, Number(segment.value) || 0);
            if (!value) return null;
            const pct = (value / total) * 100;
            // Butt caps keep each slice exactly as wide as its share: round caps
            // add half a stroke on both ends, which flatters a 1-day slice.
            const gap = segments.length > 1 ? 1.2 : 0;
            const arc = Math.max(pct - gap, 0.5);
            const offset = cursor;
            cursor += pct;
            return (
              <circle
                key={segment.label || index}
                className="chart-segment"
                style={{ animationDelay: `${index * 90}ms` }}
                cx={center}
                cy={center}
                r={radius}
                pathLength={100}
                stroke={segment.color}
                strokeWidth={thickness}
                strokeLinecap="butt"
                strokeDasharray={`${arc} ${100 - arc}`}
                strokeDashoffset={-offset}
              />
            );
          })}
      </svg>

      {(centerValue || centerLabel) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {centerValue != null && (
            <span className="text-2xl font-extrabold leading-none text-crewly-text">
              {centerValue}
            </span>
          )}
          {centerLabel && (
            <span className="mt-1 max-w-[5.5rem] text-[10px] uppercase leading-tight tracking-wide text-crewly-dim">
              {centerLabel}
            </span>
          )}
        </div>
      )}
      <span className="sr-only">{ariaLabel}</span>
    </div>
  );
};

export const DonutLegend = ({ segments = [], formatter = (value) => value }) => {
  const total = segments.reduce((sum, segment) => sum + (Number(segment.value) || 0), 0);
  return (
    <ul className="min-w-0 flex-1 space-y-1.5">
      {segments.map((segment) => {
        const pct = total ? Math.round(((Number(segment.value) || 0) / total) * 100) : 0;
        return (
          <li key={segment.label} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: segment.color }}
            />
            <span className="min-w-0 flex-1 truncate text-crewly-dim">{segment.label}</span>
            <span className="shrink-0 font-semibold text-crewly-text">
              {formatter(segment.value)}
            </span>
            <span className="w-8 shrink-0 text-right text-[11px] text-crewly-dim">{pct}%</span>
          </li>
        );
      })}
    </ul>
  );
};

export default DonutChart;
