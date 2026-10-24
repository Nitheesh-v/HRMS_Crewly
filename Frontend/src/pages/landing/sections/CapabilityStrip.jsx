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
import { TINTS, tintAt } from '../landingTints.js';

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

// The three counted numbers get the palest stocks; the six cards get the
// stronger ones. `TINTS` is shared with the hero's marquee chips, so a colour
// means the same thing everywhere it appears.
const NUMBER_TINTS = ['lilac', 'sage', 'amber'].map((name) => TINTS[name]);

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
        {numbers.map((number, index) => (
          <div
            key={number.label}
            className={`landing-scroll-in rounded-2xl border p-5 ${NUMBER_TINTS[index].surface}`}
          >
            <p className={`text-[2.75rem] font-bold leading-none tracking-[-0.04em] ${NUMBER_TINTS[index].ink}`}>
              {number.value}
            </p>
            <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-crewly-ink/70">
              {number.label}
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-crewly-ink/55">{number.copy}</p>
          </div>
        ))}
      </div>

      {/* The six areas */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CAPABILITIES.map((capability) => (
          <article
            key={capability.key}
            className={`landing-scroll-in group relative flex flex-col rounded-2xl border p-5 transition-[background-color,border-color,transform] hover:-translate-y-0.5 hover:bg-white/70 ${TINTS[capability.accent].surface}`}
          >
            <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border ${TINTS[capability.accent].chip}`}>
              <LandingIcon name={capability.icon} className="h-4 w-4" />
            </span>
            <h3 className="mt-4 text-[15px] font-semibold text-crewly-ink">{capability.name}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-crewly-ink/60">{capability.line}</p>
            <ul className="mt-auto space-y-1.5 border-t border-crewly-ink/[0.06] pt-4">
              {capability.points.map((point) => (
                <li key={point} className="flex gap-2 text-[12px] leading-relaxed text-crewly-ink/50">
                  <span
                    className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${TINTS[capability.accent].dot}`}
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
      <div id={SECTION_IDS.modules} className="landing-scroll-in mt-4 scroll-mt-24 overflow-hidden rounded-3xl border border-crewly-ink/10 bg-crewly-sand/60">
        <div className="flex flex-col gap-3 border-b border-crewly-ink/[0.06] p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
          <div>
            <p className={eyebrow}>The full inventory</p>
            <h3 className="mt-2 text-xl font-bold tracking-[-0.02em] text-crewly-ink">
              {moduleCount} modules, grouped the way the sidebar groups them.
            </h3>
          </div>
          <p className="max-w-sm text-[13px] leading-relaxed text-crewly-ink/50">
            Names match the product's own navigation. If it is not in this list, we have not shipped it.
          </p>
        </div>

        <div className="divide-y divide-crewly-ink/[0.07]">
          {MODULE_GROUPS.map((group, groupIndex) => (
            <div key={group.title} className="grid gap-3 p-5 sm:grid-cols-[13rem_1fr] sm:gap-6 sm:p-6">
              <div>
                <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-crewly-ink">
                  <span className={`h-2 w-2 rounded-full ${tintAt(groupIndex).dot}`} aria-hidden="true" />
                  {group.title}
                </p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-crewly-ink/40">{group.blurb}</p>
              </div>

              <ul className="flex flex-wrap content-start items-start gap-1.5">
                {group.items.map((item) => (
                  <li
                    key={item.name}
                    title={item.copy}
                    className="inline-flex items-center gap-1.5 rounded-full border border-crewly-ink/[0.08] bg-crewly-ink/[0.03] px-2.5 py-1 text-[11px] font-medium text-crewly-ink/75 transition-colors hover:border-crewly-forest/30 hover:text-crewly-ink"
                  >
                    <LandingIcon name={item.icon} className="h-3 w-3 text-crewly-ink/50" />
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
