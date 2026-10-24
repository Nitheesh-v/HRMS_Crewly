import { Check, Quote, Sparkles } from 'lucide-react';
import { AI_LAYER, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

// Keka sells its AI layer as three behaviours. Ours are the three things the
// assistant actually does — answer from permitted records, speak the tenant's
// languages, and keep the guardrails (redaction + metered usage) on by default.
//
// The band is a violet gradient rather than the near-black panel Keka uses:
// the page stays a light surface, and the brand colour does the work of
// separating the section.
const AiSection = () => (
  <section id={SECTION_IDS.ai} className="scroll-mt-28 bg-white px-5 py-16 sm:px-6 lg:px-8 lg:py-24">
    <div className="mx-auto max-w-7xl">
      <div className="relative overflow-hidden rounded-[32px] bg-gradient-to-br from-[#3b1580] via-[#5b21b6] to-[#0f766e] px-6 py-12 sm:px-10 sm:py-14 lg:px-14">
        <div
          className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(rgba(255,255,255,0.16)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_70%_60%_at_70%_10%,black,transparent)]"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-emerald-300/20 blur-3xl"
          aria-hidden="true"
        />

        <div className="relative grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-14">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-white backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {AI_LAYER.eyebrow}
            </p>

            <h2 className="mt-5 text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl lg:text-[2.85rem]">
              {AI_LAYER.title}
            </h2>

            <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/80 sm:text-base">{AI_LAYER.copy}</p>

            <dl className="mt-7 flex flex-wrap gap-x-8 gap-y-4">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/60">Languages</dt>
                <dd className="mt-1 text-2xl font-bold text-white">{AI_LAYER.languageCount}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/60">Out of the box</dt>
                <dd className="mt-1 text-2xl font-bold text-white">{AI_LAYER.defaultLanguageCount}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/60">Configured by</dt>
                <dd className="mt-1 text-2xl font-bold text-white">Your admin</dd>
              </div>
            </dl>

            <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2">
              {['Permission-scoped answers', 'PII redacted before the model', 'Usage metered per company'].map((item) => (
                <li key={item} className="inline-flex items-center gap-1.5 text-xs font-medium text-white/85">
                  <Check className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* An illustrative conversation. It is labelled as illustrative in the
              card itself, so nobody mistakes the numbers for their own. */}
          <div className="rounded-2xl bg-white p-4 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.55)] sm:p-5">
            <div className="flex items-center gap-2.5 border-b border-slate-100 pb-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-emerald-500 text-white">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-crewly-ink">{AI_LAYER.demo.title}</p>
                <p className="text-[11px] text-slate-500">{AI_LAYER.demo.subtitle}</p>
              </div>
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                Live in app
              </span>
            </div>

            <div className="mt-4 space-y-3">
              <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-violet-600 px-3.5 py-2.5 text-[13px] leading-relaxed text-white">
                {AI_LAYER.demo.question}
              </p>

              <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-slate-50 px-3.5 py-3">
                <p className="text-[13px] leading-relaxed text-slate-700">{AI_LAYER.demo.answer}</p>
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200">
                  <Quote className="h-2.5 w-2.5 text-violet-600" aria-hidden="true" />
                  {AI_LAYER.demo.citation}
                </p>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {AI_LAYER.demo.chips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded-full border border-slate-200 px-2.5 py-1 text-[10px] font-medium text-slate-500"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </div>

            <p className="mt-4 border-t border-slate-100 pt-2.5 text-[10px] leading-relaxed text-slate-400">
              {AI_LAYER.demo.note}
            </p>
          </div>
        </div>

        <div className="relative mt-12 grid gap-4 sm:grid-cols-3">
          {AI_LAYER.capabilities.map((capability) => (
            <article
              key={capability.tag}
              className="rounded-2xl border border-white/15 bg-white/10 p-5 backdrop-blur transition-colors hover:bg-white/15"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 text-white">
                <LandingIcon name={capability.icon} className="h-4 w-4" />
              </span>
              <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-200">
                {capability.tag}
              </p>
              <h3 className="mt-1.5 text-base font-semibold text-white">{capability.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-white/75">{capability.copy}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  </section>
);

export default AiSection;
