import { Check, Quote, Sparkles } from 'lucide-react';
import { AI_LAYER, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

// The one place on this page where violet leads — because violet is the AI
// accent inside the product too (the assistant chip, the AI settings pages).
// Everything around it stays emerald, so the section reads as a different
// material rather than a different website.
const AiSection = () => (
  <section
    id={SECTION_IDS.ai}
    className="relative scroll-mt-28 overflow-hidden border-t border-white/[0.06] bg-crewly-night px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
  >
    <div
      className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_55%_45%_at_70%_0%,rgba(139,92,246,0.14),transparent),radial-gradient(ellipse_50%_40%_at_10%_90%,rgba(16,185,129,0.1),transparent)]"
      aria-hidden="true"
    />

    <div className="mx-auto max-w-7xl">
      <div className="relative overflow-hidden rounded-[32px] border border-white/10 bg-gradient-to-br from-violet-600/[0.16] via-white/[0.02] to-emerald-500/[0.1] px-6 py-12 sm:px-10 sm:py-14 lg:px-14">
        <div
          className="landing-dots pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_70%_60%_at_70%_10%,black,transparent)]"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-violet-500/20 blur-3xl"
          aria-hidden="true"
        />

        <div className="relative grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-14">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-500/10 px-3.5 py-1.5 text-xs font-semibold text-violet-200">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {AI_LAYER.eyebrow}
            </p>

            <h2 className="mt-5 text-balance text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl lg:text-[2.85rem]">
              {AI_LAYER.title}
            </h2>

            <p className="mt-4 max-w-xl text-sm leading-relaxed text-slate-300 sm:text-base">{AI_LAYER.copy}</p>

            <dl className="mt-7 flex flex-wrap gap-x-8 gap-y-4">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Languages</dt>
                <dd className="mt-1 text-2xl font-bold text-white">{AI_LAYER.languageCount}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Out of the box</dt>
                <dd className="mt-1 text-2xl font-bold text-white">{AI_LAYER.defaultLanguageCount}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Configured by</dt>
                <dd className="mt-1 text-2xl font-bold text-white">Your admin</dd>
              </div>
            </dl>

            <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2">
              {['Permission-scoped answers', 'PII redacted before the model', 'Usage metered per company'].map((item) => (
                <li key={item} className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300">
                  <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* An illustrative conversation, labelled as such in the card, so a
              screenshot of it is never mistaken for a real company's data. */}
          <div className="rounded-2xl border border-white/10 bg-[#0b1220]/90 p-4 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.9)] backdrop-blur sm:p-5">
            <div className="flex items-center gap-2.5 border-b border-white/[0.08] pb-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-emerald-500 text-white">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-white">{AI_LAYER.demo.title}</p>
                <p className="text-[11px] text-slate-500">{AI_LAYER.demo.subtitle}</p>
              </div>
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                Live in app
              </span>
            </div>

            <div className="mt-4 space-y-3">
              <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-violet-600 px-3.5 py-2.5 text-[13px] leading-relaxed text-white">
                {AI_LAYER.demo.question}
              </p>

              <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-white/[0.05] px-3.5 py-3">
                <p className="text-[13px] leading-relaxed text-slate-200">{AI_LAYER.demo.answer}</p>
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] font-medium text-slate-400">
                  <Quote className="h-2.5 w-2.5 text-violet-300" aria-hidden="true" />
                  {AI_LAYER.demo.citation}
                </p>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {AI_LAYER.demo.chips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-medium text-slate-400"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </div>

            <p className="mt-4 border-t border-white/[0.08] pt-2.5 text-[10px] leading-relaxed text-slate-500">
              {AI_LAYER.demo.note}
            </p>
          </div>
        </div>

        <div className="relative mt-12 grid gap-4 sm:grid-cols-3">
          {AI_LAYER.capabilities.map((capability) => (
            <article
              key={capability.tag}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-violet-400/30 hover:bg-white/[0.05]"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-400/25 bg-violet-500/10 text-violet-200">
                <LandingIcon name={capability.icon} className="h-4 w-4" />
              </span>
              <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                {capability.tag}
              </p>
              <h3 className="mt-1.5 text-base font-semibold text-white">{capability.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{capability.copy}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  </section>
);

export default AiSection;
