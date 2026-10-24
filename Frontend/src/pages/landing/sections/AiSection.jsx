// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — THE AI LAYER
//
// The one place on the page where violet is allowed to lead: it is the colour the
// assistant carries inside the app, and keeping it exclusive is what stops the
// page from turning into a rainbow.
//
// The transcript is labelled illustrative in the data, and the guardrails stated
// here (permissions, redaction, metering) are the ones the backend implements —
// see the AI section of docs/HOME_PAGE_BUILD_PLAN.md.
// ═══════════════════════════════════════════════════════════════════════════

import { ArrowRight, Sparkles } from 'lucide-react';
import { AI_LAYER, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import { displayLg, ghostLink, sectionCopy } from '../landingStyles.js';

const ChatDemo = () => (
  <div aria-hidden="true" className="landing-glass relative overflow-hidden rounded-[24px] p-4 sm:p-5">
    <div
      className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-violet-500/20 blur-3xl"
      aria-hidden="true"
    />

    <div className="relative flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-violet-400/30 bg-violet-500/15 text-violet-300">
        <Sparkles className="h-4 w-4" />
      </span>
      <span>
        <span className="block text-[12px] font-semibold text-white">{AI_LAYER.demo.title}</span>
        <span className="block text-[10px] text-slate-500">{AI_LAYER.demo.subtitle}</span>
      </span>
      <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] font-medium text-slate-400">
        <span className="h-1 w-1 rounded-full bg-violet-400" />
        guarded
      </span>
    </div>

    <div className="relative mt-5 space-y-2.5">
      <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md border border-white/10 bg-white/[0.06] px-3.5 py-2.5">
        <p className="text-[12px] leading-relaxed text-slate-200">{AI_LAYER.demo.question}</p>
      </div>

      <div className="w-fit max-w-[92%] rounded-2xl rounded-bl-md border border-violet-400/20 bg-violet-500/[0.09] px-3.5 py-2.5">
        <p className="text-[12px] leading-relaxed text-violet-50">{AI_LAYER.demo.answer}</p>
        <p className="mt-2 flex items-center gap-1.5 border-t border-violet-300/15 pt-2 text-[9px] text-violet-300/70">
          <span className="h-1 w-1 rounded-full bg-violet-400" />
          {AI_LAYER.demo.citation}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 pt-1">
        {AI_LAYER.demo.chips.map((chip) => (
          <span
            key={chip}
            className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] font-medium text-slate-400"
          >
            {chip}
          </span>
        ))}
      </div>
    </div>

    <p className="relative mt-4 border-t border-white/[0.06] pt-3 text-[10px] text-slate-600">
      {AI_LAYER.demo.note}
    </p>
  </div>
);

const AiSection = () => (
  <section
    id={SECTION_IDS.ai}
    className="relative scroll-mt-24 overflow-hidden py-20 sm:py-24 lg:py-28"
  >
    <div
      className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_75%_25%,rgba(139,92,246,0.16),transparent_70%),radial-gradient(40%_40%_at_10%_80%,rgba(16,185,129,0.1),transparent_70%)]"
      aria-hidden="true"
    />
    <div className="landing-dots pointer-events-none absolute inset-0 -z-10 opacity-[0.35] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,black,transparent)]" aria-hidden="true" />

    <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_0.92fr] lg:gap-16">
        <div className="landing-scroll-in">
          <p className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-300">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            {AI_LAYER.eyebrow}
          </p>
          <h2 className={`mt-4 ${displayLg}`}>{AI_LAYER.title}</h2>
          <p className={`mt-5 max-w-xl ${sectionCopy}`}>{AI_LAYER.copy}</p>

          <div className="mt-8 space-y-2">
            {AI_LAYER.capabilities.map((capability) => (
              <div
                key={capability.title}
                className="landing-scroll-in flex gap-3.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 transition-[background-color,border-color] hover:border-violet-400/20 hover:bg-violet-500/[0.04]"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-400/20 bg-violet-500/[0.08] text-violet-300">
                  <LandingIcon name={capability.icon} className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300/70">
                    {capability.tag}
                  </p>
                  <h3 className="mt-1 text-sm font-semibold text-white">{capability.title}</h3>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">{capability.copy}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-slate-500">
            <span className="rounded-full border border-emerald-400/20 bg-emerald-500/[0.07] px-2.5 py-1 text-emerald-300">
              {AI_LAYER.languageCount} languages
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
              {AI_LAYER.defaultLanguageCount} on by default
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
              Per-tenant provider and limits
            </span>
          </p>

          <a href={`#${SECTION_IDS.security}`} className={`mt-7 ${ghostLink}`}>
            How the data is handled
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>

        <div className="landing-scroll-in relative">
          <ChatDemo />
        </div>
      </div>
    </div>
  </section>
);

export default AiSection;
