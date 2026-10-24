// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — HERO
//
// One light source, one promise, one window onto the product. The headline says
// what the product actually fixes (records that disagree) rather than a category
// noun, and the emerald is the page's only action colour from here down.
//
// The dashboard is decorative (aria-hidden in ProductWindow) and the floating
// cards around it are too — a screen reader gets the sentence, not a fake table.
// ═══════════════════════════════════════════════════════════════════════════

import { Link } from 'react-router-dom';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { HERO, WORKPLACE_FACTS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import ProductWindow from '../ProductWindow.jsx';
import { displayXl, primaryCta, secondaryCta, sectionCopy } from '../landingStyles.js';

// The "what it does" strip. There are no customers in this repository to fill a
// logo wall, so it carries shipped facts instead and loops. The list is rendered
// twice for the CSS marquee to wrap seamlessly, and the duplicate is aria-hidden
// so it is not read out twice.
const FactsMarquee = () => (
  <div className="landing-marquee relative overflow-hidden border-y border-white/[0.06] bg-white/[0.015] py-3.5">
    <div
      className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-crewly-void via-crewly-void/80 to-transparent"
      aria-hidden="true"
    />
    <div
      className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-crewly-void via-crewly-void/80 to-transparent"
      aria-hidden="true"
    />

    <div className="landing-marquee-track flex w-max">
      {[0, 1].map((copy) => (
        <ul
          key={copy}
          aria-hidden={copy === 1 ? 'true' : undefined}
          className="flex shrink-0 items-center gap-10 pr-10"
        >
          {WORKPLACE_FACTS.map((fact) => (
            <li key={`${copy}-${fact.label}`} className="flex items-center gap-2 whitespace-nowrap">
              <span className="flex h-6 w-6 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-emerald-300">
                <LandingIcon name={fact.icon} className="h-3.5 w-3.5" />
              </span>
              <span className="text-[13px] font-medium text-slate-400">{fact.label}</span>
            </li>
          ))}
        </ul>
      ))}
    </div>
  </div>
);

// Decorative, non-interactive callouts that make the window feel like it is
// floating in a workspace rather than pasted onto the page.
const FloatingCard = ({ className, children }) => (
  // Only from `xl`: below that the window is close enough to the gutters that a
  // floating card would sit on top of a number instead of beside it.
  <div aria-hidden="true" className={`landing-glass absolute hidden rounded-2xl p-3 xl:block ${className}`}>
    {children}
  </div>
);

const HeroSection = () => (
  <section className="relative overflow-hidden">
    <div className="landing-glow pointer-events-none absolute inset-x-0 -top-48 -z-10 h-[78rem]" aria-hidden="true" />
    <div
      className="landing-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-[46rem] [mask-image:radial-gradient(ellipse_62%_52%_at_50%_0%,black,transparent)]"
      aria-hidden="true"
    />

    <div className="mx-auto max-w-7xl px-5 pb-6 pt-14 sm:px-6 sm:pt-20 lg:px-8 lg:pt-24">
      <div className="mx-auto max-w-4xl text-center">
        <p className="landing-rise inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/[0.08] px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
          <span className="landing-breathe h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          {HERO.badge}
          {/* The note is a second thought on a phone: at 390px it turned the
              pill into a three-line block above the headline. */}
          <span className="hidden h-3 w-px bg-emerald-400/25 sm:inline-block" aria-hidden="true" />
          <span className="hidden font-medium normal-case tracking-normal text-emerald-200/70 sm:inline">
            {HERO.badgeNote}
          </span>
        </p>

        <h1 className={`landing-rise landing-rise-1 mx-auto mt-7 max-w-4xl ${displayXl}`}>
          {HERO.titleLead}{' '}
          {/* Inline on purpose: an absolutely-positioned underline draws one
              rectangle under the LAST line only, so on a phone the accent broke
              over two lines and the full stop was left alone on its own row. */}
          <span className="bg-gradient-to-r from-emerald-300 via-teal-200 to-emerald-400 bg-clip-text text-transparent">
            {HERO.titleAccent}
          </span>
          .
        </h1>

        <p className={`landing-rise landing-rise-2 mx-auto mt-6 max-w-2xl ${sectionCopy}`}>{HERO.copy}</p>

        <div className="landing-rise landing-rise-2 mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to={HERO.primaryCta.to} className={primaryCta}>
            {HERO.primaryCta.label}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
          <a href={HERO.secondaryCta.href} className={secondaryCta}>
            {HERO.secondaryCta.label}
          </a>
        </div>

        <ul className="landing-rise landing-rise-3 mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {HERO.assurances.map((item) => (
            <li key={item} className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {/* The product window. `landing-drift` gives it a slow perspective sway;
          the cards sit outside that transform so they do not wobble with it. */}
      <div className="landing-rise landing-rise-3 relative mx-auto mt-14 max-w-5xl sm:mt-16">
        <div
          className="pointer-events-none absolute -inset-x-8 -bottom-10 -top-6 -z-10 rounded-[3rem] bg-[radial-gradient(60%_60%_at_50%_40%,rgba(16,185,129,0.22),transparent_70%)] blur-2xl"
          aria-hidden="true"
        />

        <div className="landing-drift origin-top">
          <ProductWindow />
        </div>

        {/* Two glass cards ride the window's outer edge, at the vertical
            extremes so neither covers a number a visitor is meant to read. */}
        <FloatingCard className="-bottom-6 -left-5 w-52 xl:-left-8">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
              <Check className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[10px] font-semibold text-white">Payroll approved</p>
              <p className="truncate text-[9px] text-slate-500">October · 137 employees</p>
            </div>
          </div>
        </FloatingCard>

        <FloatingCard className="-right-5 top-1/2 w-44 -translate-y-1/2 xl:-right-8">
          <div className="flex items-center gap-1.5 text-[9px] font-semibold text-violet-300">
            <Sparkles className="h-3 w-3" />
            Crewly AI
          </div>
          <p className="mt-1 text-[10px] leading-snug text-slate-400">
            “9 casual days left this year.”
          </p>
        </FloatingCard>
      </div>
    </div>

    <FactsMarquee />
  </section>
);

export default HeroSection;
