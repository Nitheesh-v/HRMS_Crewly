// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — THE PAGE'S DESIGN PRIMITIVES.
//
// One light source, one action colour, one type scale. These constants exist so
// nine sections cannot drift into nine slightly different buttons — and so the
// test suite can resolve a shared class string instead of being told to trust it
// (see `sharedClassNames` in landingPage.test.js).
//
// House rules encoded here:
//   · canvas is near-black; light comes from ONE emerald glow behind the hero
//   · action colour is emerald, always, with dark text on it
//   · violet is reserved: the AI surface and the logo mark, nowhere else
//   · display type is clamped and tightly tracked, never a fixed size per breakpoint
//   · motion is colour/shadow/transform only, never `transition-all` (it would
//     animate outline-width and freeze the focus ring — measured, not theorised)
// ═══════════════════════════════════════════════════════════════════════════

export const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

// Explicit property list. `transition` and `transition-all` both animate
// outline-*; the global reduced-motion rule collapses durations to 0.01ms and
// in Chromium that left the focus ring at outline-width: 0px.
export const transition = 'transition-[color,background-color,border-color,box-shadow,transform]';

export const primaryCta =
  'group inline-flex items-center justify-center gap-2 rounded-full bg-emerald-400 px-6 py-3.5 text-sm font-semibold text-[#04231a] shadow-[0_0_0_1px_rgba(52,211,153,0.5),0_18px_40px_-16px_rgba(16,185,129,0.75)] transition-[color,background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:bg-emerald-300 hover:shadow-[0_0_0_1px_rgba(52,211,153,0.7),0_22px_50px_-14px_rgba(16,185,129,0.9)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-200';

export const secondaryCta =
  'inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-6 py-3.5 text-sm font-semibold text-white backdrop-blur transition-[color,background-color,border-color,box-shadow,transform] hover:border-white/30 hover:bg-white/[0.09] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

export const ghostLink =
  'inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-slate-100 transition-[color,background-color,border-color,box-shadow,transform] hover:border-white/30 hover:bg-white/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

export const navLink =
  'rounded-full px-3.5 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

// The badge above a headline: a small, tracked, uppercase label with a live dot.
export const pill =
  'inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300 backdrop-blur';

// Display scale. Clamped so one rule covers phone → 4K without eight variants.
export const displayXl =
  'text-[clamp(2.6rem,6.6vw,5.25rem)] font-bold leading-[0.94] tracking-[-0.035em] text-white';

export const displayLg =
  'text-[clamp(2rem,4.4vw,3.5rem)] font-bold leading-[1.02] tracking-[-0.03em] text-white';

export const eyebrow = 'text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-400';

export const sectionCopy = 'text-base leading-relaxed text-slate-400 sm:text-lg';

export const glass = 'landing-glass rounded-3xl';
