// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — PRICING (+ the questions the price raises)
//
// Four real plans, monthly or yearly. Nothing is derived by hand: the monthly and
// yearly figures come from landingData, which the test suite compares against
// Backend/src/utils/platformPlans.js, and "2 months free" is arithmetic on those
// same numbers rather than a badge.
//
// The FAQ lives here because every one of its questions is a question about the
// price (trial, what happens when it ends, what a plan includes) — a separate
// marketing band would only add scroll distance.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Minus, Plus } from 'lucide-react';
import { BRAND, FAQS, PLANS, PRICING_NOTE, SECTION_IDS } from '../landingData.js';
import { displayLg, eyebrow, focusRing, primaryCta, secondaryCta, sectionCopy } from '../landingStyles.js';

const inr = (value) => `₹${value.toLocaleString('en-IN')}`;

// Rendered from the plan data: yearly is exactly ten months on every paid tier.
const monthsFree = (plan) =>
  plan.monthly > 0 ? Math.round((plan.monthly * 12 - plan.yearly) / plan.monthly) : 0;

const BillingToggle = ({ cycle, onChange }) => (
  <div role="group" aria-label="Billing cycle" className="inline-flex w-fit items-center gap-1 self-start rounded-full border border-crewly-ink/10 bg-crewly-ink/[0.03] p-1">
    {[
      { id: 'monthly', label: 'Monthly' },
      { id: 'yearly', label: 'Yearly' },
    ].map((option) => (
      <button
        key={option.id}
        type="button"
        onClick={() => onChange(option.id)}
        aria-pressed={cycle === option.id}
        className={`rounded-full px-4 py-1.5 text-[12px] font-semibold transition-[color,background-color,box-shadow] ${focusRing} ${
          cycle === option.id
            ? 'bg-crewly-lilac text-crewly-ink shadow-[0_0_20px_-6px_rgba(16,185,129,0.8)]'
            : 'text-crewly-ink/60 hover:text-crewly-ink'
        }`}
      >
        {option.label}
        {option.id === 'yearly' && (
          <span className={`ml-1.5 text-[10px] font-bold ${cycle === 'yearly' ? 'text-crewly-ink/60' : 'text-crewly-forest'}`}>
            2 months free
          </span>
        )}
      </button>
    ))}
  </div>
);

const PlanCard = ({ cycle, plan }) => {
  const price = cycle === 'yearly' ? plan.yearly : plan.monthly;
  const free = monthsFree(plan);

  return (
    <article
      className={`landing-scroll-in relative flex flex-col rounded-3xl border p-5 ${
        plan.featured
          ? 'border-crewly-ink/45 bg-[linear-gradient(180deg,rgba(230,204,255,0.55),rgba(230,204,255,0.16))] shadow-[0_20px_44px_-34px_rgba(20,17,14,0.55)]'
          : 'border-crewly-ink/10 bg-white/60'
      }`}
    >
      {plan.featured && (
        <span className="absolute -top-2.5 left-5 rounded-full bg-crewly-lilac px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-crewly-ink">
          Includes hiring &amp; performance
        </span>
      )}

      <h3 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-crewly-ink/60">{plan.name}</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-crewly-ink/50">{plan.tagline}</p>

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-[2rem] font-bold leading-none tracking-[-0.03em] text-crewly-ink">
          {price === 0 ? '₹0' : inr(price)}
        </span>
        <span className="text-[11px] text-crewly-ink/50">{cycle === 'yearly' && price > 0 ? '/year' : '/month'}</span>
      </div>
      <p className="mt-1 h-4 text-[10.5px] text-crewly-forest/80">
        {free > 0 && cycle === 'yearly' ? `${free} months free vs monthly` : ''}
      </p>

      <ul className="mt-5 flex-1 space-y-2 border-t border-crewly-ink/[0.06] pt-4">
        {plan.highlights.map((item) => (
          <li key={item} className="flex items-start gap-2 text-[12px] leading-relaxed text-crewly-ink/60">
            <Check className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${plan.featured ? 'text-crewly-forest' : 'text-crewly-ink/40'}`} aria-hidden="true" />
            {item}
          </li>
        ))}
      </ul>

      <Link
        to={plan.cta.to}
        className={`mt-5 justify-center ${plan.featured ? primaryCta : secondaryCta}`}
      >
        {plan.cta.label}
      </Link>
    </article>
  );
};

const FaqList = () => {
  const [open, setOpen] = useState(0);

  return (
    <div id={SECTION_IDS.faq} className="landing-scroll-in scroll-mt-24">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h3 className="max-w-sm text-2xl font-bold tracking-[-0.025em] text-crewly-ink sm:text-3xl">
          The questions the price raises.
        </h3>
        <p className="max-w-sm text-[12.5px] leading-relaxed text-crewly-ink/50">
          Straight answers about the trial, the tenant boundary and what a plan actually includes.
        </p>
      </div>

      <div className="mt-6 divide-y divide-white/[0.06] overflow-hidden rounded-3xl border border-crewly-ink/10 bg-crewly-ink/[0.015]">
        {FAQS.map((faq, index) => {
          const id = `faq-${index}`;
          const openNow = open === index;

          return (
            <div key={faq.q}>
              <h4>
                <button
                  type="button"
                  id={`${id}-button`}
                  onClick={() => setOpen(openNow ? -1 : index)}
                  aria-expanded={openNow}
                  aria-controls={`${id}-panel`}
                  className={`flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-crewly-ink/[0.03] ${focusRing}`}
                >
                  <span className="flex-1 text-[13px] font-semibold text-crewly-ink sm:text-sm">{faq.q}</span>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-crewly-ink/10 text-crewly-ink/60">
                    {openNow ? (
                      <Minus className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <Plus className="h-3 w-3" aria-hidden="true" />
                    )}
                  </span>
                </button>
              </h4>

              <div
                id={`${id}-panel`}
                role="region"
                aria-labelledby={`${id}-button`}
                hidden={!openNow}
                className="px-5 pb-5"
              >
                <p className="max-w-2xl text-[12.5px] leading-relaxed text-crewly-ink/50">{faq.a}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const PricingSection = () => {
  const [cycle, setCycle] = useState('monthly');

  return (
    <section
      id={SECTION_IDS.pricing}
      className="relative scroll-mt-24 overflow-hidden py-20 sm:py-24 lg:py-28"
    >
      <div className="landing-glow-soft pointer-events-none absolute inset-0 -z-10 opacity-50" aria-hidden="true" />

      <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
        <div className="landing-scroll-in flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className={eyebrow}>Pricing</p>
            <h2 className={`mt-4 ${displayLg}`}>Priced per company. Not per surprise.</h2>
            <p className={`mt-5 ${sectionCopy}`}>{PRICING_NOTE}</p>
          </div>
          <BillingToggle cycle={cycle} onChange={setCycle} />
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((plan) => (
            <PlanCard key={plan.code} cycle={cycle} plan={plan} />
          ))}
        </div>

        <p className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-crewly-ink/50">
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-crewly-forest" aria-hidden="true" />
            {BRAND.trialDays}-day trial · no card at signup
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-crewly-forest" aria-hidden="true" />
            Read-only if you stop, never deleted
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ArrowRight className="h-3.5 w-3.5 text-crewly-ink/40" aria-hidden="true" />
            Prices in INR, billed to the company
          </span>
        </p>

        <div className="mt-16 border-t border-crewly-ink/[0.06] pt-12">
          <FaqList />
        </div>
      </div>
    </section>
  );
};

export default PricingSection;
