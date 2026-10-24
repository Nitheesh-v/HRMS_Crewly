// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — THE PRODUCT MOMENT
//
// One screen, told in three beats, with the payroll run shown as the artefact
// the month actually produces. This replaces the old six-tab platform tour: a
// visitor does not need every route, they need to believe the numbers agree.
//
// The panel on the right is a drawing of the real review step (inputs → compute
// → review → pay). It is aria-hidden and uses no company data.
// ═══════════════════════════════════════════════════════════════════════════

import { ArrowRight, Check, Lock } from 'lucide-react';
import { PRODUCT_MOMENT, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import { displayLg, eyebrow, ghostLink, sectionCopy } from '../landingStyles.js';

const lines = [
  { label: 'Gross earnings', value: '₹61,40,000', note: '138 employees' },
  { label: 'PF · ESI · PT', value: '₹4,92,180', note: 'statutory, computed' },
  { label: 'TDS', value: '₹3,18,400', note: 'per employee profile' },
  { label: 'Net payable', value: '₹53,29,420', note: 'after deductions', strong: true },
];

const steps = [
  { label: 'Inputs locked', state: 'done' },
  { label: 'Computed', state: 'done' },
  { label: 'HR review', state: 'current' },
  { label: 'Paid', state: 'next' },
];

const PayrollReview = () => (
  <div aria-hidden="true" className="landing-glass overflow-hidden rounded-[24px] p-4 sm:p-5">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-crewly-ink/50">Payroll run</p>
        <p className="mt-1 text-base font-bold text-crewly-ink">October 2026</p>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-[10px] font-semibold text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        In review
      </span>
    </div>

    <div className="mt-4 flex items-center gap-1">
      {steps.map((step, index) => (
        <span key={step.label} className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span
            className={`h-1 rounded-full ${
              step.state === 'done'
                ? 'bg-crewly-lilac/70'
                : step.state === 'current'
                  ? 'bg-amber-400'
                  : 'bg-crewly-ink/10'
            }`}
          />
          <span
            className={`truncate text-[9px] font-medium ${
              step.state === 'next' ? 'text-crewly-ink/40' : 'text-crewly-ink/60'
            }`}
          >
            {index + 1}. {step.label}
          </span>
        </span>
      ))}
    </div>

    <div className="mt-4 space-y-px overflow-hidden rounded-xl border border-crewly-ink/10 bg-white/60">
      {lines.map((line) => (
        <div key={line.label} className="flex items-baseline justify-between gap-3 bg-crewly-void-soft px-3 py-2.5">
          <span className="min-w-0">
            <span className={`block text-[11px] ${line.strong ? 'font-semibold text-crewly-ink' : 'text-crewly-ink/75'}`}>
              {line.label}
            </span>
            <span className="block text-[9px] text-crewly-ink/50">{line.note}</span>
          </span>
          <span className={`shrink-0 text-[12px] tabular-nums ${line.strong ? 'font-bold text-crewly-forest' : 'font-medium text-crewly-ink/85'}`}>
            {line.value}
          </span>
        </div>
      ))}
    </div>

    <div className="mt-3 flex items-center gap-2 rounded-xl border border-crewly-forest/20 bg-crewly-forest/[0.08] px-3 py-2">
      <Lock className="h-3 w-3 shrink-0 text-crewly-forest" />
      <p className="text-[10px] leading-snug text-crewly-forest">
        A person approves before money moves. Nothing pays itself.
      </p>
    </div>
  </div>
);

const ProductMomentSection = () => (
  <section
    id={SECTION_IDS.product}
    className="relative scroll-mt-24 overflow-hidden py-20 sm:py-24 lg:py-28"
  >
    <div className="landing-glow-soft pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />

    <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
      <div className="grid items-start gap-12 lg:grid-cols-[1.02fr_1fr] lg:gap-16">
        <div className="landing-scroll-in">
          <p className={eyebrow}>{PRODUCT_MOMENT.eyebrow}</p>
          <h2 className={`mt-4 max-w-xl ${displayLg}`}>{PRODUCT_MOMENT.title}</h2>
          <p className={`mt-5 max-w-lg ${sectionCopy}`}>{PRODUCT_MOMENT.copy}</p>

          <ol className="mt-9 space-y-3">
            {PRODUCT_MOMENT.callouts.map((callout, index) => (
              <li
                key={callout.title}
                className="landing-scroll-in group flex gap-4 rounded-2xl border border-crewly-ink/10 bg-white/60 p-4 transition-[background-color,border-color] hover:border-crewly-ink/15 hover:bg-white/80"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-crewly-forest/25 bg-crewly-forest/[0.08] text-crewly-forest">
                  <LandingIcon name={callout.icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[10px] font-bold tabular-nums text-crewly-ink/40">0{index + 1}</span>
                    <span className="text-sm font-semibold text-crewly-ink">{callout.title}</span>
                  </span>
                  <span className="mt-1 block text-[13px] leading-relaxed text-crewly-ink/60">{callout.copy}</span>
                </span>
              </li>
            ))}
          </ol>

          <a href={`#${SECTION_IDS.pricing}`} className={`mt-7 ${ghostLink}`}>
            See what it costs
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>

        <div className="landing-scroll-in relative">
          <div
            className="pointer-events-none absolute -inset-6 -z-10 rounded-[2.5rem] bg-[radial-gradient(60%_60%_at_60%_30%,rgba(139,92,246,0.16),transparent_70%)] blur-2xl"
            aria-hidden="true"
          />
          <PayrollReview />

          <div className="landing-glass mt-3 flex items-center gap-3 rounded-2xl p-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-crewly-forest/10 text-crewly-forest">
              <Check className="h-4 w-4" aria-hidden="true" />
            </span>
            <p className="text-[12px] leading-snug text-crewly-ink/75">
              Payslips go out from the numbers that were paid — not a re-export.
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
);

export default ProductMomentSection;
