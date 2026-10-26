// ═══════════════════════════════════════════════════════════════════════════
// EMPTY-STATE ILLUSTRATIONS — one flat scene per kind of "nothing here yet".
//
// Storyset-style flat vector scenes, drawn here rather than downloaded: the app
// ships no bitmap illustrations, has no licence to redistribute anyone else's,
// and every one of these has to render on the app's own dark card without a
// network request. They are deliberately small compositions — an object or two,
// a plate behind them, one accent colour — because an empty state is a pause,
// not a hero image.
//
// All of them share one 320×200 frame, so a row of empty panels across the app
// lines up: the plate is always at the same place, the accent always sits at the
// optical centre. Colours are the app's own, plus the four mid-tones GitHub's
// dark theme already uses for charts (blue / purple / orange / pink), kept at
// low alpha so they read as paper cut-outs, not as alerts.
// ═══════════════════════════════════════════════════════════════════════════

// The scenes keep their own mid-tone palette rather than the theme's tokens:
// these hexes are picked to sit at the midpoint of both surfaces (cream paper
// and pine card), and they are drawn with a low-alpha wash, so one set works in
// both themes — which also keeps them valid inside SVG presentation attributes,
// where `var()` is not reliable.
const GREEN = '#7d9a55';
const BLUE = '#8e9162';
const PURPLE = '#a8bba3';
const ORANGE = '#db9558';
const PINK = '#c98f7a';
const TEAL = '#97a87a';
const YELLOW = '#cbb95e';

const wash = (hex, alpha = 0.18) => `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;

// Ink and paper *are* theme tokens: a dashed line has to be legible on a pine
// card and on cream paper.
const ink = (alpha = 0.55) => `rgba(var(--art-ink-rgb), ${alpha})`;
const dim = (alpha = 0.35) => `rgba(var(--art-dim-rgb), ${alpha})`;
// The plate every scene sits on: two tinted discs, a dashed orbit, a floor
// shadow and a halo that breathes. `tone` is the scene's own colour, `alt` the
// second voice — that pairing is what makes these read as illustrations rather
// than as grey line art on a dark card.
const Plate = ({ tone = BLUE, alt = PURPLE }) => (
  <>
    <circle className="empty-art-halo" cx="160" cy="98" r="70" fill={wash(tone, 0.13)} />
    <circle cx="160" cy="98" r="52" fill={wash(alt, 0.10)} />
    <circle
      cx="160"
      cy="98"
      r="62"
      fill="none"
      stroke={wash(tone, 0.32)}
      strokeWidth="1.4"
      strokeDasharray="2 9"
      strokeLinecap="round"
      className="empty-art-orbit"
    />
    <ellipse cx="160" cy="168" rx="80" ry="6" fill="rgba(0,0,0,0.07)" />
    <ellipse cx="160" cy="167" rx="44" ry="4" fill="rgba(0,0,0,0.10)" />
  </>
);

// Three lines that read as "text" without pretending to be text.
const TextLines = ({ x, y, widths, color = dim(0.6), height = 4, gap = 9 }) => (
  <>
    {widths.map((width, index) => (
      <rect
        key={`${x}-${y}-${index}`}
        x={x}
        y={y + index * gap}
        width={width}
        height={height}
        rx={height / 2}
        fill={color}
      />
    ))}
  </>
);

const scenes = {
  // A tray with nothing in it and one envelope drifting in.
  inbox: () => (
    <>
      <Plate tone={BLUE} alt={PURPLE} />
      <path
        d="M110 104 h100 l14 34 a8 8 0 0 1 -8 10 h-112 a8 8 0 0 1 -8 -10 z"
        fill={wash(BLUE, 0.14)}
        stroke={BLUE}
        strokeOpacity="0.7"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M96 138 h34 l10 12 h40 l10 -12 h34" stroke={BLUE} strokeOpacity="0.55" strokeWidth="2.5" strokeLinecap="round" />
      <g transform="rotate(-12 150 76)">
        <rect x="126" y="60" width="52" height="34" rx="4" fill={wash(BLUE, 0.10)} stroke={ink(0.5)} strokeWidth="2.2" />
        <path d="M126 64 l26 18 l26 -18" stroke={ink(0.45)} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <circle className="empty-art-dot" cx="216" cy="66" r="4" fill={TEAL} fillOpacity="0.85" />
      <circle className="empty-art-dot" cx="232" cy="86" r="2.5" fill={PINK} fillOpacity="0.8" />
    </>
  ),

  // A calendar with one day marked.
  calendar: () => (
    <>
      <Plate tone={GREEN} alt={BLUE} />
      <rect x="112" y="56" width="96" height="92" rx="10" fill={wash(BLUE, 0.10)} stroke={BLUE} strokeOpacity="0.55" strokeWidth="2.5" />
      <path d="M112 82 h96" stroke={BLUE} strokeOpacity="0.35" strokeWidth="2.2" />
      <path d="M132 48 v16 M188 48 v16" stroke={ink(0.6)} strokeWidth="4" strokeLinecap="round" />
      <rect x="126" y="96" width="18" height="14" rx="3" fill={wash(GREEN, 0.35)} stroke={GREEN} strokeOpacity="0.7" strokeWidth="1.8" />
      <rect x="154" y="96" width="18" height="14" rx="3" fill={wash(BLUE, 0.25)} />
      <rect x="182" y="96" width="16" height="14" rx="3" fill={wash(BLUE, 0.25)} />
      <rect x="126" y="120" width="18" height="14" rx="3" fill={wash(BLUE, 0.18)} />
      <rect x="154" y="120" width="18" height="14" rx="3" fill={wash(BLUE, 0.18)} />
      <path d="M136 103 l4 5 l7 -9" stroke={GREEN} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="214" cy="64" r="9" fill={wash(ORANGE, 0.3)} stroke={ORANGE} strokeOpacity="0.7" strokeWidth="2" />
    </>
  ),

  // A payslip, striped like a receipt, with a rupee mark.
  payslip: () => (
    <>
      <Plate tone={GREEN} alt={ORANGE} />
      <path
        d="M126 52 h68 v100 l-8 -7 l-8 7 l-8 -7 l-8 7 l-8 -7 l-8 7 l-8 -7 l-8 7 l-8 -7 l-8 7 z"
        fill={wash(GREEN, 0.10)}
        stroke={GREEN}
        strokeOpacity="0.55"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <TextLines x={140} y={70} widths={[40, 28, 34]} />
      <path d="M140 112 h40" stroke={dim(0.5)} strokeWidth="2" strokeDasharray="3 5" strokeLinecap="round" />
      <text x="140" y="136" fontFamily="'Iowan Old Style', Palatino, Georgia, serif" fontSize="22" fill={GREEN} fillOpacity="0.9">
        ₹
      </text>
      <circle cx="204" cy="128" r="12" fill={wash(GREEN, 0.22)} stroke={GREEN} strokeOpacity="0.7" strokeWidth="2" />
      <path d="M199 128 l4 4 l7 -8" stroke={GREEN} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),

  // Three people and the lines that make them a team.
  team: () => (
    <>
      <Plate tone={BLUE} alt={GREEN} />
      <path d="M160 92 v18 M160 110 h-36 v12 M160 110 h36 v12" stroke={dim(0.5)} strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="160" cy="76" r="16" fill={wash(BLUE, 0.22)} stroke={BLUE} strokeOpacity="0.75" strokeWidth="2.4" />
      <path d="M150 74 a10 10 0 0 1 20 0" stroke={BLUE} strokeOpacity="0.75" strokeWidth="2.2" fill="none" />
      <circle cx="124" cy="134" r="13" fill={wash(GREEN, 0.22)} stroke={GREEN} strokeOpacity="0.75" strokeWidth="2.4" />
      <circle cx="196" cy="134" r="13" fill={wash(ORANGE, 0.22)} stroke={ORANGE} strokeOpacity="0.75" strokeWidth="2.4" />
      <path d="M118 134 a6 6 0 0 1 12 0" stroke={GREEN} strokeOpacity="0.8" strokeWidth="2" fill="none" />
      <path d="M190 134 a6 6 0 0 1 12 0" stroke={ORANGE} strokeOpacity="0.8" strokeWidth="2" fill="none" />
    </>
  ),

  // Two documents, one behind the other.
  documents: () => (
    <>
      <Plate tone={BLUE} alt={PURPLE} />
      <g transform="rotate(-8 140 104)">
        <rect x="108" y="52" width="62" height="82" rx="7" fill={wash(BLUE, 0.06)} stroke={ink(0.35)} strokeWidth="2.4" />
        <TextLines x={120} y={68} widths={[36, 30, 34, 24]} color={dim(0.35)} />
      </g>
      <rect x="140" y="60" width="66" height="86" rx="7" fill={wash(BLUE, 0.13)} stroke={BLUE} strokeOpacity="0.6" strokeWidth="2.5" />
      <path d="M192 60 v20 h14" stroke={BLUE} strokeOpacity="0.5" strokeWidth="2.4" strokeLinejoin="round" />
      <TextLines x={152} y={82} widths={[40, 30, 38, 26]} />
      <circle cx="207" cy="134" r="12" fill="var(--art-plate)" stroke={PURPLE} strokeOpacity="0.9" strokeWidth="2.2" />
      <circle cx="207" cy="134" r="12" fill={wash(PURPLE, 0.25)} />
      <path d="M202 134 l3.5 3.5 l6.5 -7" stroke={PURPLE} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),

  // Two speech bubbles, one replying to the other.
  chat: () => (
    <>
      <Plate tone={BLUE} alt={GREEN} />
      <path
        d="M104 62 h84 a10 10 0 0 1 10 10 v34 a10 10 0 0 1 -10 10 h-58 l-18 16 v-16 h-8 a10 10 0 0 1 -10 -10 v-34 a10 10 0 0 1 10 -10 z"
        fill={wash(BLUE, 0.16)}
        stroke={BLUE}
        strokeOpacity="0.7"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <TextLines x={112} y={76} widths={[52, 38]} color={ink(0.35)} />
      <path
        d="M186 104 h44 a10 10 0 0 0 10 -10 v-22 a10 10 0 0 0 -10 -10 h-40 a10 10 0 0 0 -10 10 v22 a10 10 0 0 0 10 10 z"
        fill={wash(GREEN, 0.18)}
        stroke={GREEN}
        strokeOpacity="0.75"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <circle cx="176" cy="84" r="2.6" fill={GREEN} />
      <circle cx="186" cy="84" r="2.6" fill={GREEN} />
      <circle cx="196" cy="84" r="2.6" fill={GREEN} />
      <circle className="empty-art-dot" cx="224" cy="128" r="4" fill={YELLOW} fillOpacity="0.85" />
    </>
  ),

  // A checklist with two items done.
  tasks: () => (
    <>
      <Plate tone={PURPLE} alt={GREEN} />
      <rect x="112" y="52" width="96" height="100" rx="9" fill={wash(PURPLE, 0.09)} stroke={PURPLE} strokeOpacity="0.5" strokeWidth="2.5" />
      <path d="M128 58 v-6 h20 v6" stroke={ink(0.5)} strokeWidth="2.4" strokeLinejoin="round" />
      {[
        { y: 76, done: true },
        { y: 100, done: true },
        { y: 124, done: false },
      ].map((row) => (
        <g key={row.y}>
          <rect
            x="126"
            y={row.y}
            width="14"
            height="14"
            rx="4"
            fill={row.done ? wash(GREEN, 0.3) : 'none'}
            stroke={row.done ? GREEN : dim(0.7)}
            strokeWidth="2"
          />
          {row.done && (
            <path
              d={`M129 ${row.y + 7} l3 3 l6 -7`}
              stroke={GREEN}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          <rect
            x="148"
            y={row.y + 5}
            width={row.done ? 40 : 34}
            height="4"
            rx="2"
            fill={row.done ? dim(0.45) : dim(0.3)}
          />
        </g>
      ))}
      <circle cx="214" cy="66" r="11" fill={wash(ORANGE, 0.25)} stroke={ORANGE} strokeOpacity="0.7" strokeWidth="2" />
      <path d="M214 61 v6 l4 3" stroke={ORANGE} strokeWidth="2" strokeLinecap="round" />
    </>
  ),

  // Bars and a trend line: the "no data yet" analytic.
  chart: () => (
    <>
      <Plate tone={BLUE} alt={PURPLE} />
      <path d="M104 148 h112" stroke={dim(0.55)} strokeWidth="2.2" strokeLinecap="round" />
      <rect x="112" y="112" width="16" height="36" rx="4" fill={wash(BLUE, 0.35)} stroke={BLUE} strokeOpacity="0.6" strokeWidth="1.8" />
      <rect x="138" y="92" width="16" height="56" rx="4" fill={wash(GREEN, 0.35)} stroke={GREEN} strokeOpacity="0.6" strokeWidth="1.8" />
      <rect x="164" y="120" width="16" height="28" rx="4" fill={wash(PURPLE, 0.3)} stroke={PURPLE} strokeOpacity="0.55" strokeWidth="1.8" />
      <rect x="190" y="102" width="16" height="46" rx="4" fill={wash(ORANGE, 0.3)} stroke={ORANGE} strokeOpacity="0.55" strokeWidth="1.8" />
      <path
        d="M112 96 l28 -16 l26 20 l26 -14 l26 8"
        stroke={ink(0.6)}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="4 6"
      />
      <circle cx="192" cy="60" r="10" fill="none" stroke={ink(0.4)} strokeWidth="2.4" strokeDasharray="3 4" />
      <path d="M199 67 l8 8" stroke={ink(0.45)} strokeWidth="2.6" strokeLinecap="round" />
    </>
  ),

  // A bell with nothing to ring about.
  bell: () => (
    <>
      <Plate tone={ORANGE} alt={PURPLE} />
      <path
        d="M132 118 a28 28 0 0 1 56 0 v10 a6 6 0 0 0 4 6 h-64 a6 6 0 0 0 4 -6 z"
        fill={wash(ORANGE, 0.16)}
        stroke={ORANGE}
        strokeOpacity="0.7"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M152 142 a8 8 0 0 0 16 0" stroke={ORANGE} strokeOpacity="0.7" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M160 62 v-8" stroke={ink(0.5)} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M196 74 l10 -8 M124 74 l-10 -8" stroke={ink(0.25)} strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="206" cy="120" r="8" fill={wash(GREEN, 0.4)} stroke={GREEN} strokeOpacity="0.8" strokeWidth="2" />
      <path d="M202 120 l3 3 l6 -6" stroke={GREEN} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),

  // An open box: assets, stock, inventory.
  box: () => (
    <>
      <Plate tone={BLUE} alt={ORANGE} />
      <path d="M120 108 h80 v44 a6 6 0 0 1 -6 6 h-68 a6 6 0 0 1 -6 -6 z" fill={wash(BLUE, 0.14)} stroke={BLUE} strokeOpacity="0.65" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M116 92 l14 -16 h60 l14 16 z" fill={wash(BLUE, 0.22)} stroke={BLUE} strokeOpacity="0.6" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M120 108 l-4 -16 M200 108 l4 -16" stroke={ink(0.4)} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M148 92 h24" stroke={ink(0.45)} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M160 60 v-10 M142 66 l-8 -8 M178 66 l8 -8" stroke={ink(0.25)} strokeWidth="2" strokeLinecap="round" />
      <circle className="empty-art-dot" cx="212" cy="146" r="5" fill={GREEN} fillOpacity="0.5" />
    </>
  ),

  // A magnifier over a card: filtered to nothing.
  search: () => (
    <>
      <Plate tone={PURPLE} alt={ORANGE} />
      <rect x="104" y="66" width="96" height="76" rx="9" fill={wash(PURPLE, 0.10)} stroke={ink(0.4)} strokeWidth="2.4" />
      <TextLines x={120} y={84} widths={[44, 36, 40]} color={dim(0.35)} />
      <circle cx="196" cy="112" r="26" fill={wash(PURPLE, 0.12)} stroke={ink(0.65)} strokeWidth="3" />
      <path d="M214 132 l16 16" stroke={ink(0.65)} strokeWidth="4" strokeLinecap="round" />
      <path d="M186 106 a12 12 0 0 1 12 -6" stroke={PURPLE} strokeOpacity="0.8" strokeWidth="2.4" strokeLinecap="round" />
      <circle className="empty-art-dot" cx="228" cy="66" r="4" fill={ORANGE} fillOpacity="0.7" />
    </>
  ),

  // A shield: security, audit, permissions.
  shield: () => (
    <>
      <Plate tone={GREEN} alt={BLUE} />
      <path
        d="M160 52 l34 12 v32 c0 22 -14 36 -34 44 c-20 -8 -34 -22 -34 -44 v-32 z"
        fill={wash(GREEN, 0.14)}
        stroke={GREEN}
        strokeOpacity="0.7"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path d="M146 100 l10 10 l18 -20" stroke={GREEN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="214" cy="70" r="8" fill={wash(BLUE, 0.25)} stroke={BLUE} strokeOpacity="0.6" strokeWidth="2" />
      <circle className="empty-art-dot" cx="108" cy="120" r="5" fill={ORANGE} fillOpacity="0.6" />
    </>
  ),

  // A CV card with a reading glass: recruitment pipelines.
  hiring: () => (
    <>
      <Plate tone={ORANGE} alt={BLUE} />
      <rect x="106" y="56" width="76" height="94" rx="9" fill={wash(BLUE, 0.10)} stroke={BLUE} strokeOpacity="0.5" strokeWidth="2.5" />
      <circle cx="126" cy="78" r="10" fill={wash(BLUE, 0.25)} stroke={BLUE} strokeOpacity="0.7" strokeWidth="2" />
      <path d="M120 78 a6 6 0 0 1 12 0" stroke={BLUE} strokeOpacity="0.8" strokeWidth="2" fill="none" />
      <TextLines x={116} y={98} widths={[52, 42, 46]} />
      <circle cx="196" cy="112" r="20" fill={wash(ORANGE, 0.12)} stroke={ORANGE} strokeOpacity="0.75" strokeWidth="2.8" />
      <path d="M210 126 l12 12" stroke={ORANGE} strokeOpacity="0.75" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M188 108 l5 6 l10 -12" stroke={ORANGE} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),

  // A card and coins: billing, invoices, expenses.
  wallet: () => (
    <>
      <Plate tone={PURPLE} alt={GREEN} />
      <rect x="104" y="76" width="104" height="66" rx="9" fill={wash(PURPLE, 0.14)} stroke={PURPLE} strokeOpacity="0.65" strokeWidth="2.5" />
      <path d="M104 96 h104" stroke={PURPLE} strokeOpacity="0.5" strokeWidth="2.2" />
      <rect x="104" y="112" width="30" height="16" rx="3" fill={wash(PURPLE, 0.35)} />
      <circle cx="196" cy="132" r="14" fill={wash(ORANGE, 0.3)} stroke={ORANGE} strokeOpacity="0.8" strokeWidth="2.2" />
      <text x="190" y="137" fontFamily="'Iowan Old Style', Palatino, Georgia, serif" fontSize="15" fill={ORANGE}>
        ₹
      </text>
      <circle cx="214" cy="98" r="9" fill={wash(GREEN, 0.3)} stroke={GREEN} strokeOpacity="0.7" strokeWidth="2" />
      <path d="M120 60 h40" stroke={ink(0.25)} strokeWidth="2.2" strokeLinecap="round" />
    </>
  ),
};

const EmptyIllustration = ({ name = 'inbox', className = 'h-40 w-64' }) => {
  const scene = scenes[name] || scenes.inbox;

  return (
    <svg
      viewBox="0 0 320 200"
      className={`empty-art ${className}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      <g className="empty-art-float">{scene()}</g>
    </svg>
  );
};

export default EmptyIllustration;
