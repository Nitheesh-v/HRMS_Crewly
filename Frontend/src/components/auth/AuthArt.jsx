// ═══════════════════════════════════════════════════════════════════════════
// AUTH — the hand-drawn scene beside the form.
//
// The reference signs you in next to a sketch: a chunky monitor sitting on a
// paint-spattered lily pad, with two little winged houses floating above it.
// This is the same composition in Crewly's own terms — the "houses" are the two
// things an HR desk actually sends (a leave approval and a payslip), and the
// monitor is the payroll screen they end up in.
//
// Everything is inline SVG: no image request, no font dependency, and it inherits
// the palette tokens so the sketch can never drift from the buttons. It is
// decorative (aria-hidden) because the form is the page's only real content.
// ═══════════════════════════════════════════════════════════════════════════

const CREAM = 'rgba(252, 250, 236, 0.82)';
const CREAM_SOFT = 'rgba(252, 250, 236, 0.32)';
const AMBER = '#e9b23f';
const CLAY = '#d9683f';
const SAGE = '#c3ddc6';
const LILAC = '#e6ccff';

// A little wing: two arcs, drawn loose so it reads as pencil rather than vector.
const Wing = ({ flip = false, x = 0, y = 0 }) => (
  <g
    transform={`translate(${x} ${y}) scale(${flip ? -1 : 1} 1)`}
    stroke={CREAM}
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* two feathers, not a fan: a larger upper lobe and a smaller lower one,
        both curling away from the card the way the reference's wings do */}
    <path d="M0 2 C -8 -14 -26 -27 -46 -28 C -40 -12 -26 1 -10 9 Z" fill="rgba(252, 250, 236, 0.06)" />
    <path d="M-2 14 C -12 6 -28 5 -40 11 C -30 20 -16 23 -4 21 Z" fill="rgba(252, 250, 236, 0.04)" />
    <path d="M-12 -6 C -22 -10 -32 -14 -38 -20" stroke={CREAM_SOFT} strokeWidth="1.6" />
  </g>
);

const AuthArt = () => (
  <svg
    viewBox="0 0 620 660"
    className="h-full max-h-[660px] w-full max-w-[620px]"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    {/* ── The pad the monitor sits on ─────────────────────────────────── */}
    <g stroke={CREAM} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path
        d="M96 556 C 104 521 178 497 262 493 C 356 488 448 500 505 524 C 548 542 552 570 520 588 C 470 617 344 626 246 618 C 160 611 88 592 96 556 Z"
        fill="rgba(252, 250, 236, 0.035)"
      />
      <path d="M118 574 C 176 592 268 600 350 596" stroke={CREAM_SOFT} strokeWidth="1.6" />
    </g>

    {/* Paint dots — the reference's spattered colour, in this page's palette. */}
    <g opacity="0.92">
      <ellipse cx="196" cy="586" rx="30" ry="10" fill={AMBER} opacity="0.75" />
      <ellipse cx="268" cy="600" rx="20" ry="7" fill={CLAY} opacity="0.7" />
      <ellipse cx="392" cy="592" rx="27" ry="9" fill={SAGE} opacity="0.8" />
      <ellipse cx="332" cy="576" rx="14" ry="5" fill={LILAC} opacity="0.6" />
      <ellipse cx="470" cy="578" rx="11" ry="4" fill={CREAM} opacity="0.25" />
    </g>

    {/* ── The monitor ─────────────────────────────────────────────────── */}
    <g stroke={CREAM} strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round">
      {/* body + the little shelf under it */}
      <rect x="176" y="236" width="272" height="196" rx="16" fill="rgba(35, 33, 32, 0.94)" />
      <rect x="190" y="438" width="244" height="38" rx="9" fill="rgba(35, 33, 32, 0.94)" />
      <path d="M206 456 H 300" stroke={CREAM_SOFT} strokeWidth="1.8" />
      <path d="M316 456 H 356" stroke={CREAM_SOFT} strokeWidth="1.8" />
      <path d="M246 476 L 240 492" />
      <path d="M378 476 L 384 492" />
    </g>

    {/* Screen: a payroll run, drawn small. The bars are the only saturated
        pixels in the scene, so the eye lands on the numbers. */}
    <g strokeLinecap="round" strokeLinejoin="round">
      <rect x="194" y="254" width="236" height="160" rx="8" fill="rgba(252, 250, 236, 0.035)" stroke={CREAM} strokeWidth="2" />
      <path d="M210 276 H 300" stroke={CREAM} strokeWidth="2.6" />
      <path d="M210 292 H 262" stroke={CREAM_SOFT} strokeWidth="2" />
      <path d="M210 328 H 414" stroke={CREAM_SOFT} strokeWidth="1.6" />
      <path d="M210 352 H 414" stroke={CREAM_SOFT} strokeWidth="1.6" />

      <rect x="210" y="364" width="56" height="16" rx="8" fill={SAGE} opacity="0.85" />
      <rect x="274" y="364" width="44" height="16" rx="8" fill={AMBER} opacity="0.85" />
      <rect x="326" y="364" width="64" height="16" rx="8" fill={CLAY} opacity="0.8" />

      <path d="M210 306 H 232" stroke={SAGE} strokeWidth="3" />
      <path d="M240 306 H 258" stroke={CREAM_SOFT} strokeWidth="3" />
      <path d="M266 306 H 300" stroke={CREAM_SOFT} strokeWidth="3" />
    </g>

    {/* ── Winged payslip (right) ──────────────────────────────────────── */}
    <g className="auth-float">
      <g transform="translate(444 118) rotate(7)">
        <Wing x={-2} y={44} />
        <Wing flip x={148} y={44} />
        <rect x="0" y="0" width="146" height="104" rx="12" fill="rgba(43, 40, 37, 0.96)" stroke={CREAM} strokeWidth="2.4" />
        <path d="M18 26 H 70" stroke={CREAM} strokeWidth="2.6" strokeLinecap="round" />
        <path d="M18 44 H 108" stroke={CREAM_SOFT} strokeWidth="2" strokeLinecap="round" />
        <path d="M18 60 H 92" stroke={CREAM_SOFT} strokeWidth="2" strokeLinecap="round" />
        <text
          x="103"
          y="84"
          fontFamily="'Iowan Old Style', Palatino, Georgia, serif"
          fontSize="26"
          fill={SAGE}
        >
          ₹
        </text>
        <path d="M18 84 H 72" stroke={CREAM_SOFT} strokeWidth="2" strokeLinecap="round" />
      </g>
    </g>

    {/* ── Winged leave approval (upper left) ──────────────────────────── */}
    <g className="auth-float-slow">
      <g transform="translate(66 128) rotate(-8)">
        <Wing x={-2} y={38} />
        <Wing flip x={124} y={38} />
        <rect x="0" y="0" width="122" height="88" rx="12" fill="rgba(43, 40, 37, 0.96)" stroke={CREAM} strokeWidth="2.4" />
        <circle cx="30" cy="32" r="13" stroke={SAGE} strokeWidth="2.4" fill="rgba(195, 221, 198, 0.14)" />
        <path d="M24 32 L 28 37 L 37 27" stroke={SAGE} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M52 27 H 100" stroke={CREAM} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M52 41 H 86" stroke={CREAM_SOFT} strokeWidth="2" strokeLinecap="round" />
        <path d="M22 64 H 100" stroke={CREAM_SOFT} strokeWidth="2" strokeLinecap="round" />
      </g>
    </g>

    {/* A dotted path from the cards down to the screen — the approvals landing
        in the run. */}
    <path
      d="M300 236 C 286 210 262 198 244 212"
      stroke={CLAY}
      strokeWidth="2"
      strokeDasharray="2 8"
      strokeLinecap="round"
      opacity="0.8"
    />
    <circle cx="238" cy="216" r="3.4" fill={CLAY} opacity="0.9" />
  </svg>
);

export default AuthArt;
