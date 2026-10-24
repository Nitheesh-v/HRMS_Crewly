import { Link } from 'react-router-dom';
import { ArrowRight, Check, Sparkles, Star } from 'lucide-react';
import { HERO, WORKPLACE_FACTS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import DashboardPreview from '../DashboardPreview.jsx';

// The "works everywhere" strip. Keka fills this slot with customer logos; there
// are no customers in this repository, so it carries shipped facts instead and
// loops. The list is rendered twice for the CSS marquee to wrap seamlessly, and
// the duplicate is aria-hidden so it is not read out twice.
const FactsMarquee = () => (
  <div className="landing-marquee relative mt-16 overflow-hidden border-y border-crewly-lilac-line bg-crewly-lilac/70 py-3.5">
    <div
      className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-crewly-lilac via-crewly-lilac/70 to-transparent"
      aria-hidden="true"
    />
    <div
      className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-crewly-lilac via-crewly-lilac/70 to-transparent"
      aria-hidden="true"
    />

    <div className="flex w-max landing-marquee-track">
      {[0, 1].map((copy) => (
        <ul
          key={copy}
          aria-hidden={copy === 1 ? 'true' : undefined}
          className="flex shrink-0 items-center gap-8 pr-8"
        >
          {WORKPLACE_FACTS.map((fact) => (
            <li key={`${copy}-${fact.label}`} className="flex items-center gap-2 whitespace-nowrap">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white text-violet-700 ring-1 ring-crewly-lilac-line">
                <LandingIcon name={fact.icon} className="h-3.5 w-3.5" />
              </span>
              <span className="text-[13px] font-medium text-crewly-ink-soft">{fact.label}</span>
            </li>
          ))}
        </ul>
      ))}
    </div>
  </div>
);

const HeroSection = () => (
  <section className="relative isolate overflow-hidden">
    <div className="landing-aurora pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />
    <div
      className="landing-grid pointer-events-none absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,black,transparent)]"
      aria-hidden="true"
    />

    <div className="mx-auto max-w-7xl px-5 pb-4 pt-14 sm:px-6 sm:pt-20 lg:px-8 lg:pt-24">
      <div className="mx-auto max-w-4xl text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-violet-200/80 bg-white/80 px-3.5 py-1.5 text-xs font-semibold text-violet-800 shadow-sm backdrop-blur">
          <span className="landing-breathe h-1.5 w-1.5 rounded-full bg-violet-600" aria-hidden="true" />
          {HERO.eyebrow}
        </p>

        <h1 className="mt-6 text-balance text-4xl font-bold leading-[1.05] tracking-tight text-crewly-ink sm:text-5xl lg:text-[4.1rem]">
          {HERO.titleLead}{' '}
          {/* Inline on purpose. An absolutely-positioned underline draws one
              rectangle under the LAST line only, so on a phone the accent broke
              over two lines and the full stop was left hanging on its own row.
              Inline, the gradient text and the stop flow and wrap as one. */}
          <span className="bg-gradient-to-r from-violet-700 via-violet-600 to-emerald-600 bg-clip-text text-transparent">
            {HERO.titleAccent}
          </span>
          <span className="text-violet-700">.</span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-slate-600 sm:text-lg">
          {HERO.copy}
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to={HERO.primaryCta.to}
            className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-violet-700 to-[#4c1d95] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_16px_34px_-16px_rgba(76,29,149,0.85)] transition-[color,background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:from-violet-600 hover:to-violet-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 sm:w-auto"
          >
            {HERO.primaryCta.label}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>

          <a
            href={HERO.secondaryCta.href}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300/80 bg-white px-6 py-3.5 text-sm font-semibold text-crewly-ink shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 sm:w-auto"
          >
            {HERO.secondaryCta.label}
          </a>
        </div>

        <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-slate-500">
          {HERO.assurances.map((assurance) => (
            <li key={assurance} className="inline-flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              {assurance}
            </li>
          ))}
        </ul>
      </div>

      {/* The product, immediately. Decorative mock — the whole column is hidden
          from assistive technology by DashboardPreview itself. */}
      <div className="relative mx-auto mt-12 max-w-5xl sm:mt-16">
        <div
          className="pointer-events-none absolute -inset-x-6 -bottom-8 -top-6 -z-10 rounded-[36px] bg-[radial-gradient(60%_60%_at_25%_20%,rgba(109,40,217,0.18),transparent_70%),radial-gradient(55%_55%_at_80%_75%,rgba(15,157,118,0.16),transparent_70%)] blur-2xl"
          aria-hidden="true"
        />

        <DashboardPreview />

        {/* Two floating cards, decorative. They describe real product surfaces. */}
        <div
          aria-hidden="true"
          className="landing-float absolute -left-8 bottom-10 hidden w-44 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-[0_24px_50px_-30px_rgba(23,18,51,0.55)] backdrop-blur xl:block"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-50 text-violet-700">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <p className="text-[11px] font-semibold text-crewly-ink">Crewly AI</p>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            &ldquo;You have 9 casual leave days left, of 12.&rdquo;
          </p>
          <p className="mt-1.5 text-[9px] font-medium text-emerald-700">Answered from your records</p>
        </div>

        <div
          aria-hidden="true"
          className="landing-float absolute -right-8 top-6 hidden w-44 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-[0_24px_50px_-30px_rgba(23,18,51,0.55)] backdrop-blur [animation-delay:1.6s] xl:block"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
              <Star className="h-3.5 w-3.5" />
            </span>
            <p className="text-[11px] font-semibold text-crewly-ink">Payroll reviewed</p>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            Approval recorded with the actor and the time.
          </p>
        </div>
      </div>

      <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 pb-14 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {HERO.footnotes.map((note) => (
          <li key={note} className="inline-flex items-center gap-2">
            <span className="h-1 w-1 rounded-full bg-slate-300" aria-hidden="true" />
            {note}
          </li>
        ))}
      </ul>
    </div>

    <FactsMarquee />
  </section>
);

export default HeroSection;
