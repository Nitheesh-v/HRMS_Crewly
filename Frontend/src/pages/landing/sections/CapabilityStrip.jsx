// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — CAPABILITIES + THE MODULE CLOUD
//
// Three numbers that are counted, not claimed: the module inventory, the role
// set and the languages the assistant ships. They are read from landingData, so
// adding a module or a language updates the headline number for free.
//
// Below them, six capability cards (the work an HR desk actually does) and then
// the denser inventory: every module, grouped, as chips. The chips are the honest
// version of a feature wall — no nested cards pretending to be testimonials.
// ═══════════════════════════════════════════════════════════════════════════

import { ArrowRight } from 'lucide-react';
import {
  AI_LAYER,
  CAPABILITIES,
  MODULE_GROUPS,
  ROLE_CARDS,
  SECTION_IDS,
} from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import { displayLg, eyebrow, ghostLink, sectionCopy } from '../landingStyles.js';

const moduleCount = MODULE_GROUPS.reduce((total, group) => total + group.items.length, 0);

const numbers = [
  {
    value: String(moduleCount),
    label: 'modules in one workspace',
    copy: 'People, time, money, hiring and teamwork — one login, one employee record underneath.',
  },
  {
    value: String(ROLE_CARDS.length),
    label: 'shipped roles',
    copy: 'Admin, HR, manager, team lead and employee, with a permission catalogue for the exceptions.',
  },
  {
    value: String(AI_LAYER.languageCount),
    label: 'languages in the assistant',
    copy: 'Including transliterated speech, so a question can be asked the way people actually type.',
  },
];

const accentClasses = {
  emerald: 'border-emerald-400/15 bg-emerald-500/[0.05] text-emerald-300',
  violet: 'border-violet-400/20 bg-violet-500/[0.07] text-violet-300',
};

const CapabilityStrip = () => (
  <section
    id={SECTION_IDS.capabilities}
    className="relative scroll-mt-24 overflow-hidden py-20 sm:py-24 lg:py-28"
  >
    <div className="landing-glow-soft pointer-events-none absolute inset-0 -z-10 opacity-70" aria-hidden="true" />

    <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
      <div className="landing-scroll-in max-w-3xl">
        <p className={eyebrow}>What is actually inside</p>
        <h2 className={`mt-4 ${displayLg}`}>Everything the desk does. One login.</h2>
        <p className={`mt-5 max-w-xl ${sectionCopy}`}>
          Six areas carry the work, and the modules below them read the same employee record. That is
          the whole architecture: no second system of record, no monthly re-keying.
        </p>
      </div>

      {/* The counted numbers */}
      <div className="mt-12 grid gap-3 sm:grid-cols-3">
        {numbers.map((number) => (
          <div key={number.label} className="landing-glass landing-scroll-in rounded-2xl p-5">
            <p className="text-[2.75rem] font-bold leading-none tracking-[-0.04em] text-white">
              {number.value}
            </p>
            <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
              {number.label}
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-slate-500">{number.copy}</p>
          </div>
        ))}
      </div>

      {/* The six areas */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CAPABILITIES.map((capability) => (
          <article
            key={capability.key}
            className="landing-scroll-in group relative flex flex-col rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 transition-[background-color,border-color,transform] hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.04]"
          >
            <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border ${accentClasses[capability.accent]}`}>
              <LandingIcon name={capability.icon} className="h-4 w-4" />
            </span>
            <h3 className="mt-4 text-[15px] font-semibold text-white">{capability.name}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-400">{capability.line}</p>
            <ul className="mt-auto space-y-1.5 border-t border-white/[0.06] pt-4">
              {capability.points.map((point) => (
                <li key={point} className="flex gap-2 text-[12px] leading-relaxed text-slate-500">
                  <span
                    className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${
                      capability.accent === 'violet' ? 'bg-violet-400' : 'bg-emerald-400'
                    }`}
                    aria-hidden="true"
                  />
                  {point}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      {/* The inventory, in full */}
      <div id={SECTION_IDS.modules} className="landing-scroll-in mt-4 scroll-mt-24 overflow-hidden rounded-3xl border border-white/[0.07] bg-white/[0.015]">
        <div className="flex flex-col gap-3 border-b border-white/[0.06] p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
          <div>
            <p className={eyebrow}>The full inventory</p>
            <h3 className="mt-2 text-xl font-bold tracking-[-0.02em] text-white">
              {moduleCount} modules, grouped the way the sidebar groups them.
            </h3>
          </div>
          <p className="max-w-sm text-[13px] leading-relaxed text-slate-500">
            Names match the product's own navigation. If it is not in this list, we have not shipped it.
          </p>
        </div>

        <div className="divide-y divide-white/[0.05]">
          {MODULE_GROUPS.map((group) => (
            <div key={group.title} className="grid gap-3 p-5 sm:grid-cols-[13rem_1fr] sm:gap-6 sm:p-6">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-white">{group.title}</p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">{group.blurb}</p>
              </div>

              <ul className="flex flex-wrap content-start items-start gap-1.5">
                {group.items.map((item) => (
                  <li
                    key={item.name}
                    title={item.copy}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:border-emerald-400/25 hover:text-white"
                  >
                    <LandingIcon name={item.icon} className="h-3 w-3 text-slate-500" />
                    {item.name}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <a href={`#${SECTION_IDS.ai}`} className={`mt-8 ${ghostLink}`}>
        And the assistant on top
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  </section>
);

export default CapabilityStrip;
