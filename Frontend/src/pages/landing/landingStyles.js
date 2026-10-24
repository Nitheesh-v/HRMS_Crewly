// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — THE PAGE'S OWN DESIGN PRIMITIVES.
//
// The marketing surface is not a separate brand: it is the app's night canvas,
// its emerald "done" colour and the violet of the logo mark. These constants
// exist so the eleven sections cannot drift into eleven slightly different
// buttons — and so the test suite can resolve a shared class string instead of
// being told to trust it (see `sharedClassNames` in landingPage.test.js).
//
// House rules encoded here:
//   · primary action   = emerald, dark text (the product's "confirm")
//   · secondary action = hairline glass, light text
//   · panels           = glass card with a lit top edge (`.landing-card`)
//   · one accent only  = violet, reserved for AI and for the logo
//   · motion           = colour/shadow/transform only, never `transition-all`
//     (it would animate outline-width and freeze the focus ring)
// ═══════════════════════════════════════════════════════════════════════════

export const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

// Explicit property list, never `transition`/`transition-all`: both animate
// outline-* and the global reduced-motion rule collapses them to 0.01ms, which
// was measured leaving the focus ring at outline-width: 0px in Chromium.
export const transition = 'transition-[color,background-color,border-color,box-shadow,transform]';

export const primaryCta =
  'group inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-[#04231a] shadow-[0_12px_30px_-14px_rgba(16,185,129,0.85)] transition-[color,background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

export const secondaryCta =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-5 py-3 text-sm font-semibold text-slate-100 transition-[color,background-color,border-color,box-shadow,transform] hover:border-white/30 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

export const ghostLink =
  'inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-100 transition-[color,background-color,border-color,box-shadow,transform] hover:border-white/30 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

export const navLink =
  'rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

// Eyebrow + section title treatment, one implementation.
export const eyebrow = 'text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400';

export const sectionTitle = 'mt-3 text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl';

export const sectionCopy = 'mt-4 text-base leading-relaxed text-slate-400';
