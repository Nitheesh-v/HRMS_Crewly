import { MODULE_GROUPS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import { eyebrow, sectionCopy, sectionTitle } from '../landingStyles.js';

const moduleCount = MODULE_GROUPS.reduce((total, group) => total + group.items.length, 0);

// The inventory, as opposed to PlatformSection's deep dives: grouped the way the
// sidebar groups them, so someone comparing this page with the product finds the
// same words in the same places.
const ModulesSection = () => (
  <section
    id={SECTION_IDS.modules}
    className="scroll-mt-28 border-t border-white/[0.06] bg-[#080d19] px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
  >
    <div className="mx-auto max-w-7xl">
      <div className="max-w-3xl">
        <div className="flex items-center gap-3">
          <span className="h-px w-8 bg-gradient-to-r from-emerald-400 to-transparent" aria-hidden="true" />
          <p className={eyebrow}>All modules</p>
        </div>
        <h2 className={sectionTitle}>{moduleCount} modules. One login. No bolt-ons.</h2>
        <p className={sectionCopy}>
          Turn on what you need on the smallest plan and add the rest as you grow. Nothing here is a
          separate product with a separate password, and nothing here is &ldquo;coming soon&rdquo;.
        </p>
        <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-semibold text-slate-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          {MODULE_GROUPS.length} groups · {moduleCount} modules · shipped
        </p>
      </div>

      <div className="mt-12 grid gap-5 lg:grid-cols-2">
        {MODULE_GROUPS.map((group) => (
          <div key={group.title} className="landing-card rounded-3xl p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="flex items-center gap-2.5 text-lg font-semibold text-white">
                <span className="h-4 w-1 rounded-full bg-gradient-to-b from-emerald-400 to-violet-500" aria-hidden="true" />
                {group.title}
              </h3>
              <p className="text-sm text-slate-500">{group.blurb}</p>
              <span className="ml-auto rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-semibold text-slate-400">
                {group.items.length}
              </span>
            </div>

            <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
              {group.items.map((item) => (
                <article
                  key={item.name}
                  className="group rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:border-emerald-400/30 hover:bg-white/[0.04]"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-500/10 text-emerald-300 transition-colors group-hover:border-emerald-400/40 group-hover:bg-emerald-500/15">
                    <LandingIcon name={item.icon} className="h-4 w-4" />
                  </span>
                  <h4 className="mt-3 text-sm font-semibold text-white">{item.name}</h4>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-slate-400">{item.copy}</p>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default ModulesSection;
