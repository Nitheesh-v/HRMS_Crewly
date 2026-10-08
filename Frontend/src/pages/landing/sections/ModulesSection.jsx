import { MODULE_GROUPS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

const ModulesSection = () => (
  <section id={SECTION_IDS.modules} className="scroll-mt-24 border-t border-white/10 px-5 py-16 sm:px-6 lg:px-8 lg:py-24">
    <div className="mx-auto max-w-7xl">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Modules</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Everything a growing company needs, in one place
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-400">
          Twenty modules that share one employee record. Turn on what you need on the
          smallest plan and add the rest as you grow — nothing is a separate product
          with a separate login.
        </p>
      </div>

      <div className="mt-12 space-y-10">
        {MODULE_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-lg font-semibold text-white">{group.title}</h3>
              <p className="text-sm text-slate-400">{group.blurb}</p>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {group.items.map((item) => (
                <article
                  key={item.name}
                  className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-all duration-200 hover:-translate-y-1 hover:border-emerald-400/30 hover:bg-white/[0.05]"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300 transition-colors group-hover:bg-emerald-500/20">
                    <LandingIcon name={item.icon} />
                  </span>
                  <h4 className="mt-4 text-base font-semibold text-white">{item.name}</h4>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">{item.copy}</p>
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
