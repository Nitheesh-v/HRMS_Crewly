// ═══════════════════════════════════════════════════════════════════════════
// RING GAUGE — one arc, one percentage, one caption.
//
// For goals that are "how far through": weekly hours, monthly target, quota.
// `pathLength={100}` means the arc is simply the percentage.
// ═══════════════════════════════════════════════════════════════════════════

const RingGauge = ({
  value = 0,
  max = 100,
  size = 116,
  thickness = 10,
  color = '#3fb950',
  trackColor = 'var(--chart-track)',
  centerValue,
  centerLabel,
  caption,
  className = '',
}) => {
  const safeMax = Math.max(1, Number(max) || 1);
  const raw = Math.max(0, Number(value) || 0);
  const pct = Math.min(100, Math.round((raw / safeMax) * 100));
  const radius = (size - thickness) / 2;
  const center = size / 2;

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          className="-rotate-90"
          role="presentation"
          aria-hidden="true"
          fill="none"
        >
          <circle cx={center} cy={center} r={radius} stroke={trackColor} strokeWidth={thickness} />
          <circle
            className="chart-ring"
            cx={center}
            cy={center}
            r={radius}
            pathLength={100}
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={`${Math.max(pct, 1)} ${100 - Math.max(pct, 1)}`}
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xl font-extrabold leading-none text-crewly-text">
            {centerValue ?? `${pct}%`}
          </span>
          {centerLabel && (
            <span className="mt-1 text-[10px] uppercase tracking-wide text-crewly-dim">
              {centerLabel}
            </span>
          )}
        </div>
      </div>
      {caption && <p className="mt-2 max-w-[13rem] text-center text-[11px] leading-snug text-crewly-dim">{caption}</p>}
    </div>
  );
};

export default RingGauge;
