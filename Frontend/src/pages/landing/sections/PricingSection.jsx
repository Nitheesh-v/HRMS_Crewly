import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { PLANS, PRICING_NOTE, SECTION_IDS } from '../landingData.js';

// The prices rendered here are the platform catalogue's, and the test suite
// compares them against Backend/src/utils/platformPlans.js — a price change that
// is not mirrored here fails the build rather than shipping a wrong number.
const inr = (value) => `₹${value.toLocaleString('en-IN')}`;

const monthsFree = (plan) =>
  plan.monthly > 0 ? Math.round(plan.monthly * 12 - plan.yearly) / plan.monthly : 0;

const PricingSection = () => {
  const [cycle, setCycle] = useState('monthly');
  const yearly = cycle === 'yearly';

  return (
    <section id={SECTION_IDS.pricing} className="scroll-mt-24 border-t border-white/10 px-5 py-16 sm:px-6 lg:px-8 lg:py-24">
      <div className="mx-auto max-w-7xl">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Pricing</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Start free. Pay when the team grows into it.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-400">{PRICING_NOTE}</p>
        </div>

        <div className="mt-8 flex justify-center">
          <div
            role="group"
            aria-label="Billing period"
            className="inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-1"
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
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
                  cycle === option.id
                    ? 'bg-emerald-500 text-[#06251a]'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-4">
          {PLANS.map((plan) => {
            const price = yearly ? plan.yearly : plan.monthly;
            const free = monthsFree(plan);

            return (
              <article
                key={plan.code}
                className={`relative flex flex-col rounded-2xl border p-6 transition-all duration-200 hover:-translate-y-1 ${
                  plan.featured
                    ? 'border-emerald-400/40 bg-emerald-500/[0.06] shadow-[0_0_40px_-16px_rgba(16,185,129,0.55)]'
                    : 'border-white/10 bg-white/[0.03] hover:border-white/20'
                }`}
              >
                {plan.featured && (
                  <p className="absolute -top-3 left-6 inline-flex items-center gap-1.5 rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-bold text-[#06251a]">
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    Most popular
                  </p>
                )}

                <h3 className="text-lg font-semibold text-white">{plan.name}</h3>
                <p className="mt-1 min-h-[40px] text-sm leading-relaxed text-slate-400">{plan.tagline}</p>

                <p className="mt-5 flex items-baseline gap-1.5">
                  <span className="text-3xl font-bold tracking-tight text-white">{inr(price)}</span>
                  <span className="text-sm text-slate-400">
                    {price === 0 ? 'forever' : yearly ? '/ year' : '/ month'}
                  </span>
                </p>
                {yearly && free > 0 && (
                  <p className="mt-1 text-xs font-medium text-emerald-300">
                    {free} months free vs monthly
                  </p>
                )}

                <ul className="mt-5 flex-1 space-y-2.5">
                  {plan.highlights.map((highlight) => (
                    <li key={highlight} className="flex gap-2.5 text-sm text-slate-300">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                      <span>{highlight}</span>
                    </li>
                  ))}
                </ul>

                <Link
                  to={plan.cta.to}
                  className={`mt-6 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
                    plan.featured
                      ? 'bg-emerald-500 text-[#06251a] hover:bg-emerald-400'
                      : 'border border-white/15 text-slate-100 hover:bg-white/5'
                  }`}
                >
                  {plan.cta.label}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default PricingSection;
