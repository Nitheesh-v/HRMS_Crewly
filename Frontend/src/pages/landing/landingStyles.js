// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — THE PAGE'S DESIGN PRIMITIVES.
//
// One paper, one ink, one action colour, and a small set of tint families.
// These constants exist so nine sections cannot drift into nine slightly
// different buttons — and so the test suite can resolve a shared class string
// instead of being told to trust it (see `sharedClassNames` in
// landingPage.test.js).
//
// House rules encoded here:
//   · the canvas is warm cream, the type is ink, and the serif does the shouting
//   · action colour is lilac (with an ink outline), always, with ink text on it
//   · forest green is the accent for "live" and for labels
//   · clay, amber and sage are the tints — one family per card, cycled, never
//     two accents on one card; the *-deep token is the one text can sit on
//   · the two dark moments are forest (`landing-band`), and everything inside
//     them uses the OnDark primitives rather than a one-off override
//   · display type is clamped, tightly tracked and serif, never a fixed size
//   · motion is colour/shadow/transform only, never `transition-all` (it would
//     animate outline-width and freeze the focus ring — measured, not theorised)
// ═══════════════════════════════════════════════════════════════════════════

export const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest';

// Explicit property list. `transition` and `transition-all` both animate
// outline-*; the global reduced-motion rule collapses durations to 0.01ms and
// in Chromium that left the focus ring at outline-width: 0px.
export const transition = 'transition-[color,background-color,border-color,box-shadow,transform]';

// The reference's button: a lilac pill with a thin ink outline and a hard offset
// shadow, so it reads like a physical sticker rather than a web button.
export const primaryCta =
  'landing-sheen group inline-flex items-center justify-center gap-2 rounded-full border-[1.5px] border-crewly-ink bg-crewly-lilac px-6 py-3.5 text-sm font-semibold text-crewly-ink shadow-[0_3px_0_rgba(20,17,14,0.9)] transition-[color,background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:bg-crewly-lilac-deep hover:shadow-[0_5px_0_rgba(20,17,14,0.9)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest sm:px-7 sm:py-4 sm:text-[15px]';

export const secondaryCta =
  'inline-flex items-center justify-center gap-2 rounded-full border-[1.5px] border-crewly-ink/25 bg-white/60 px-6 py-3.5 text-sm font-semibold text-crewly-ink transition-[color,background-color,border-color,box-shadow,transform] hover:border-crewly-ink/50 hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest sm:px-7 sm:py-4 sm:text-[15px]';

export const ghostLink =
  'inline-flex items-center gap-2 rounded-full border-[1.5px] border-crewly-ink/25 px-4 py-2 text-sm font-semibold text-crewly-ink transition-[color,background-color,border-color,box-shadow,transform] hover:border-crewly-ink/50 hover:bg-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest';

export const navLink =
  'rounded-full px-3.5 py-2 text-sm font-medium text-crewly-ink/65 transition-colors hover:bg-crewly-lilac/50 hover:text-crewly-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest';

// A small labelled chip: white paper, ink outline, uppercase tracking.
export const pill =
  'inline-flex items-center gap-2 rounded-full border border-crewly-ink/20 bg-white/70 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-crewly-ink/70';

// Display scale. The serif carries the headline; the sans carries everything
// else. Clamped so one rule covers phone → 4K without eight variants.
export const displayXl =
  'landing-serif text-[clamp(2.6rem,6.4vw,5.25rem)] leading-[0.98] tracking-[-0.02em] text-crewly-ink';

export const displayLg =
  'landing-serif text-[clamp(2.1rem,4.8vw,3.75rem)] leading-[1.02] tracking-[-0.015em] text-crewly-ink';

export const eyebrow =
  'text-[11px] font-semibold uppercase tracking-[0.2em] text-crewly-forest';

export const sectionCopy = 'text-base leading-relaxed text-crewly-ink/65 sm:text-lg';

export const glass = 'landing-glass rounded-3xl';

// ── On the forest bands ────────────────────────────────────────────────────
// The dark panels are deep forest, so type inside them is paper. These exist so
// a section on the band never writes `!text-crewly-void` by hand.
export const displayLgOnDark =
  'landing-serif text-[clamp(2.1rem,4.8vw,3.75rem)] leading-[1.02] tracking-[-0.015em] text-crewly-void';

export const eyebrowOnDark =
  'text-[11px] font-semibold uppercase tracking-[0.2em] text-crewly-lilac';

export const sectionCopyOnDark = 'text-base leading-relaxed text-crewly-void/70 sm:text-lg';

export const ghostLinkOnDark =
  'inline-flex items-center gap-2 rounded-full border-[1.5px] border-crewly-void/30 px-4 py-2 text-sm font-semibold text-crewly-void transition-[color,background-color,border-color,box-shadow,transform] hover:border-crewly-void/60 hover:bg-crewly-void/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-lilac';

export const secondaryCtaOnDark =
  'inline-flex items-center justify-center gap-2 rounded-full border-[1.5px] border-crewly-void/35 bg-crewly-void/[0.06] px-6 py-3.5 text-sm font-semibold text-crewly-void transition-[color,background-color,border-color,box-shadow] hover:border-crewly-void/70 hover:bg-crewly-void/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-lilac sm:px-7 sm:py-4 sm:text-[15px]';
