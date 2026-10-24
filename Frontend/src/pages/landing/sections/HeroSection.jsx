// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — HERO
//
// The reference layout: pure black, the product's own name as a giant cropped
// watermark behind everything, white-outlined stickers scattered around, a stack
// of notification cards overlapping the product window, and one heavy pill CTA.
//
// Everything decorative here — the watermark, the stickers, the cards, the mock
// inside the window — is aria-hidden. A screen reader gets the promise, the
// three assurances and the two actions; it is never read a fake inbox.
// ═══════════════════════════════════════════════════════════════════════════

import { Link } from 'react-router-dom';
import { ArrowRight, Bell, Check, Sparkles } from 'lucide-react';
import { HERO, HERO_NOTIFICATIONS, HERO_STICKERS, WORKPLACE_FACTS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import ProductWindow from '../ProductWindow.jsx';
import { displayXl, primaryCta, secondaryCta, sectionCopy } from '../landingStyles.js';

// The "what it does" strip. There are no customers in this repository to fill a
// logo wall, so it carries shipped facts instead and loops. The list is rendered
// twice for the CSS marquee to wrap seamlessly, and the duplicate is aria-hidden
// so it is not read out twice.
const FactsMarquee = () => (
  <div className="landing-marquee relative overflow-hidden border-y border-white/10 bg-white/[0.02] py-3.5">
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
              <span className="flex h-6 w-6 items-center justify-center rounded-md border border-white/15 bg-white/[0.06] text-emerald-300">
                <LandingIcon name={fact.icon} className="h-3.5 w-3.5" />
              </span>
              <span className="text-[13px] font-medium text-white/60">{fact.label}</span>
            </li>
          ))}
        </ul>
      ))}
    </div>
  </div>
);

const Sticker = ({ sticker }) => (
  <span
    aria-hidden="true"
    className={`landing-sticker absolute hidden items-center gap-1.5 rounded-full px-3.5 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white lg:inline-flex ${sticker.rotate} ${sticker.className}`}
  >
    <LandingIcon name={sticker.icon} className={`h-3.5 w-3.5 ${sticker.tone}`} />
    {sticker.label}
  </span>
);

const toneClasses = {
  emerald: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300',
  amber: 'border-amber-400/30 bg-amber-500/10 text-amber-300',
  violet: 'border-violet-400/30 bg-violet-500/10 text-violet-300',
};

// The reference lets its cards sit on top of its product shot; so does this,
// but only from `xl`, where there is gutter to do it in without burying a number.
const NotificationStack = () => (
  <div aria-hidden="true" className="absolute -left-28 -top-4 z-20 hidden w-56 -rotate-3 xl:block">
    <p className="mb-2 flex items-center gap-1.5 pl-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white/45">
      <Bell className="h-3 w-3" />
      Today at Crewly
    </p>

    <div className="space-y-2">
      {HERO_NOTIFICATIONS.map((note) => (
        <div key={note.title} className="landing-glass rounded-2xl p-3">
          <div className="flex items-start gap-2">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${toneClasses[note.tone]}`}>
              <LandingIcon name={note.icon} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[11px] font-semibold text-white">{note.title}</span>
                <span className="shrink-0 text-[9px] text-white/35">{note.time}</span>
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-white/50">{note.body}</span>
            </span>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const FloatingCard = ({ className, children }) => (
  <div aria-hidden="true" className={`landing-glass absolute hidden rounded-2xl p-3 xl:block ${className}`}>
    {children}
  </div>
);

const HeroSection = () => (
  <section className="relative overflow-hidden">
    <div className="landing-glow pointer-events-none absolute inset-x-0 -top-48 -z-10 h-[78rem]" aria-hidden="true" />
    <div
      className="landing-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-[46rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]"
      aria-hidden="true"
    />

    {/* Stickers sit in the section's margins, never on the headline. */}
    <div className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden="true">
      {HERO_STICKERS.map((sticker) => (
        <Sticker key={sticker.label} sticker={sticker} />
      ))}
    </div>

    <div className="relative mx-auto max-w-7xl px-5 pb-6 pt-14 sm:px-6 sm:pt-20 lg:px-8 lg:pt-24">
      <div className="relative mx-auto max-w-4xl text-center">
        <p className="landing-rise inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/80 backdrop-blur">
          <span className="landing-breathe h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          {HERO.badge}
          {/* The note is a second thought on a phone: at 390px it turned the
              pill into a three-line block above the headline. */}
          <span className="hidden h-3 w-px bg-white/20 sm:inline-block" aria-hidden="true" />
          <span className="hidden font-medium normal-case tracking-normal text-white/50 sm:inline">
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
            <li key={item} className="inline-flex items-center gap-1.5 text-xs font-medium text-white/50">
              <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {/* The product window, with the collage around it. */}
      <div className="landing-rise landing-rise-3 relative mx-auto mt-14 max-w-5xl sm:mt-16">
        <div
          className="pointer-events-none absolute -inset-x-8 -bottom-10 -top-6 -z-10 rounded-[3rem] bg-[radial-gradient(60%_60%_at_50%_40%,rgba(16,185,129,0.2),transparent_70%)] blur-2xl"
          aria-hidden="true"
        />

        <NotificationStack />

        <div className="landing-drift origin-top">
          <ProductWindow />
        </div>

        <FloatingCard className="-right-6 bottom-10 w-44">
          <div className="flex items-center gap-1.5 text-[9px] font-semibold text-violet-300">
            <Sparkles className="h-3 w-3" />
            Crewly AI
          </div>
          <p className="mt-1 text-[10px] leading-snug text-white/55">
            “9 casual days left this year.”
          </p>
        </FloatingCard>
      </div>
    </div>

    <FactsMarquee />
  </section>
);

export default HeroSection;
