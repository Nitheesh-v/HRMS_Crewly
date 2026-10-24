import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { BRAND, PLANS, PRICING_NOTE, SECTION_IDS } from '../landingData.js';

// The prices rendered here are the platform catalogue's, and the test suite
// compares them against Backend/src/utils/platformPlans.js — a price change that
// is not mirrored here fails the build rather than shipping a wrong number.
const inr = (value) => `₹${value.toLocaleString('en-IN')}`;

const monthsFree = (plan) =>
  plan.monthly > 0 ? Math.round((plan.monthly * 12 - plan.yearly) / plan.monthly) : 0;

const PricingSection = () => {
  const [cycle, setCycle] = useState('monthly');
  const yearly = cycle === 'yearly';

  return (
    <section
      id={SECTION_IDS.pricing}
      className="relative isolate scroll-mt-28 border-t border-crewly-lilac-line bg-white px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 bg-[radial-gradient(ellipse_60%_100%_at_50%_0%,rgba(109,40,217,0.07),transparent)]"
        aria-hidden="true"
      />

      <div className="mx-auto max-w-7xl">
        <div className="mx-auto max-w-2xl text-center">
          <div className="flex items-center justify-center gap-3">
            <span className="h-px w-8 bg-gradient-to-l from-violet-500 to-transparent" aria-hidden="true" />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Pricing</p>
            <span className="h-px w-8 bg-gradient-to-r from-violet-500 to-transparent" aria-hidden="true" />
          </div>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-crewly-ink sm:text-4xl">
            Start free. Pay when the team grows into it.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-600">{PRICING_NOTE}</p>
        </div>

        <div className="mt-8 flex justify-center">
          <div
            role="group"
            aria-label="Billing period"
            className="inline-flex rounded-xl border border-crewly-lilac-line bg-crewly-lilac/60 p-1"
          >
            {[
              { id: 'monthly', label: 'Monthly' },
              { id: 'yearly', label: 'Yearly · 2 months free' },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setCycle(option.id)}
                aria-pressed={cycle === option.id}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 ${
                  cycle === option.id
                    ? 'bg-white text-crewly-ink shadow-sm'
                    : 'text-slate-500 hover:text-crewly-ink'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-12 grid items-start gap-5 md:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((plan) => {
            const price = yearly ? plan.yearly : plan.monthly;
            const free = monthsFree(plan);

            return (
              <article
                key={plan.code}
                className={`relative flex h-full flex-col rounded-3xl border p-6 transition-[color,background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-1 ${
                  plan.featured
                    ? 'border-violet-300 bg-gradient-to-b from-violet-50 via-white to-white shadow-[0_30px_60px_-40px_rgba(76,29,149,0.8)] ring-1 ring-violet-200 lg:-my-2 lg:py-8'
                    : 'border-crewly-lilac-line bg-white hover:border-violet-200 hover:shadow-[0_24px_50px_-38px_rgba(59,21,128,0.5)]'
                }`}
              >
                {plan.featured && (
                  <p className="absolute -top-3 left-6 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-b from-violet-700 to-[#4c1d95] px-3 py-1 text-[11px] font-bold text-white shadow-[0_8px_20px_-8px_rgba(76,29,149,0.9)]">
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    Most popular
                  </p>
                )}

                <h3 className="text-lg font-semibold text-crewly-ink">{plan.name}</h3>
                <p className="mt-1 min-h-[40px] text-sm leading-relaxed text-slate-500">{plan.tagline}</p>

                <p className="mt-5 flex items-baseline gap-1.5">
                  <span className="text-3xl font-bold tracking-tight text-crewly-ink">{inr(price)}</span>
                  <span className="text-sm text-slate-500">
                    {price === 0 ? 'forever' : yearly ? '/ year' : '/ month'}
                  </span>
                </p>
                <p className="mt-1 min-h-[18px] text-xs font-medium text-emerald-700">
                  {yearly && free > 0 ? `${free} months free vs monthly` : ''}
                </p>

                <div className="my-5 h-px bg-gradient-to-r from-crewly-lilac-line via-crewly-lilac-line/60 to-transparent" aria-hidden="true" />

                <ul className="flex-1 space-y-2.5">
                  {plan.highlights.map((highlight) => (
                    <li key={highlight} className="flex gap-2.5 text-sm text-slate-700">
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-100">
                        <Check className="h-2.5 w-2.5 text-emerald-700" aria-hidden="true" />
                      </span>
                      <span>{highlight}</span>
                    </li>
                  ))}
                </ul>

                <Link
                  to={plan.cta.to}
                  className={`mt-6 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-[color,background-color,border-color,box-shadow,transform] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 ${
                    plan.featured
                      ? 'bg-gradient-to-b from-violet-700 to-[#4c1d95] text-white shadow-[0_12px_28px_-16px_rgba(76,29,149,0.95)] hover:from-violet-600 hover:to-violet-800'
                      : 'border border-slate-300 bg-white text-crewly-ink hover:border-slate-400 hover:bg-slate-50'
                  }`}
                >
                  {plan.cta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </article>
            );
          })}
        </div>

        <p className="mt-8 text-center text-xs leading-relaxed text-slate-500">
          All plans start with the same {BRAND.trialDays}-day trial. No card at signup, and no automatic charge when
          the trial ends.
        </p>
      </div>
    </section>
  );
};

export default PricingSection;
