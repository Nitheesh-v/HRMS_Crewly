import { Link } from 'react-router-dom';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { HERO, WORKPLACE_FACTS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import DashboardPreview from '../DashboardPreview.jsx';
import { primaryCta, secondaryCta } from '../landingStyles.js';

// The "works everywhere" strip. There are no customers in this repository to
// fill a logo wall, so it carries shipped facts instead and loops. The list is
// rendered twice for the CSS marquee to wrap seamlessly, and the duplicate is
// aria-hidden so it is not read out twice.
const FactsMarquee = () => (
  <div className="landing-marquee relative mt-16 overflow-hidden border-y border-white/[0.06] bg-white/[0.02] py-3.5">
    <div
      className="pointer-events-none absolute inset-y-0 left-0 z-10 w-20 bg-gradient-to-r from-crewly-night via-crewly-night/80 to-transparent"
      aria-hidden="true"
    />
    <div
      className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20 bg-gradient-to-l from-crewly-night via-crewly-night/80 to-transparent"
      aria-hidden="true"
    />

    <div className="flex w-max landing-marquee-track">
      {[0, 1].map((copy) => (
        <ul key={copy} aria-hidden={copy === 1 ? 'true' : undefined} className="flex shrink-0 items-center gap-9 pr-9">
          {WORKPLACE_FACTS.map((fact) => (
            <li key={`${copy}-${fact.label}`} className="flex items-center gap-2 whitespace-nowrap">
              <span className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-emerald-300">
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

const HeroSection = () => (
  <section className="relative overflow-hidden">
    <div className="landing-aurora pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />
    <div
      className="landing-grid pointer-events-none absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,black,transparent)]"
      aria-hidden="true"
    />

    <div className="mx-auto max-w-7xl px-5 pb-4 pt-14 sm:px-6 sm:pt-20 lg:px-8 lg:pt-24">
      <div className="mx-auto max-w-4xl text-center">
        <p className="landing-rise inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300">
          <span className="landing-breathe h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          {HERO.eyebrow}
        </p>

        <h1 className="landing-rise landing-rise-1 mt-6 text-[2.6rem] font-bold leading-[1.03] tracking-tight text-white sm:text-6xl lg:text-[4.2rem]">
          {HERO.titleLead}{' '}
          {/* Inline on purpose: an absolutely-positioned underline draws one
              rectangle under the LAST line only, so on a phone the accent broke
              over two lines and the full stop was left alone on its own row. */}
          <span className="bg-gradient-to-r from-emerald-300 via-teal-200 to-emerald-400 bg-clip-text text-transparent">
            {HERO.titleAccent}
          </span>
          <span className="text-emerald-400">.</span>
        </h1>

        <p className="landing-rise landing-rise-2 mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-slate-400 sm:text-lg">
          {HERO.copy}
        </p>

        <div className="landing-rise landing-rise-2 mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to={HERO.primaryCta.to} className={`${primaryCta} w-full sm:w-auto`}>
            {HERO.primaryCta.label}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>

          <a href={HERO.secondaryCta.href} className={`${secondaryCta} w-full sm:w-auto`}>
            {HERO.secondaryCta.label}
          </a>
        </div>

        <ul className="landing-rise landing-rise-3 mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-slate-500">
          {HERO.assurances.map((assurance) => (
            <li key={assurance} className="inline-flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              {assurance}
            </li>
          ))}
        </ul>
      </div>

      {/* The product, immediately. DashboardPreview is decorative and hides
          itself from assistive technology. */}
      <div className="relative mx-auto mt-12 max-w-5xl sm:mt-16">
        <div
          className="pointer-events-none absolute -inset-x-6 -bottom-8 -top-6 -z-10 rounded-[36px] bg-[radial-gradient(60%_60%_at_25%_20%,rgba(16,185,129,0.18),transparent_70%),radial-gradient(55%_55%_at_80%_75%,rgba(139,92,246,0.16),transparent_70%)] blur-2xl"
          aria-hidden="true"
        />

        <DashboardPreview />

        {/* Two floating cards, decorative. Both describe real product surfaces. */}
        <div
          aria-hidden="true"
          className="landing-float absolute -left-8 bottom-10 hidden w-44 rounded-2xl border border-white/10 bg-[#0b1220]/95 p-3 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.9)] backdrop-blur xl:block"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/15 text-violet-300">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <p className="text-[11px] font-semibold text-white">Crewly AI</p>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
            &ldquo;You have 9 casual leave days left, of 12.&rdquo;
          </p>
          <p className="mt-1.5 text-[9px] font-medium text-emerald-300">Answered from your records</p>
        </div>

        <div
          aria-hidden="true"
          className="landing-float absolute -right-8 top-6 hidden w-44 rounded-2xl border border-white/10 bg-[#0b1220]/95 p-3 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.9)] backdrop-blur [animation-delay:1.6s] xl:block"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-300">
              <Check className="h-3.5 w-3.5" />
            </span>
            <p className="text-[11px] font-semibold text-white">Payroll reviewed</p>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
            Approval recorded with the actor and the time.
          </p>
        </div>
      </div>

      <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 pb-14 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
        {HERO.footnotes.map((note) => (
          <li key={note} className="inline-flex items-center gap-2">
            <span className="h-1 w-1 rounded-full bg-slate-600" aria-hidden="true" />
            {note}
          </li>
        ))}
      </ul>
    </div>

    <FactsMarquee />
  </section>
);

export default HeroSection;
