import { MODULE_GROUPS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

const moduleCount = MODULE_GROUPS.reduce((total, group) => total + group.items.length, 0);

const ModulesSection = () => (
  <section id={SECTION_IDS.modules} className="relative scroll-mt-24 border-t border-white/10 px-5 py-16 sm:px-6 lg:px-8 lg:py-24">
    <div
      className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_40%_at_50%_0%,rgba(16,185,129,0.07),transparent)]"
      aria-hidden="true"
    />

    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <div className="flex items-center gap-3">
            <span className="h-px w-8 bg-gradient-to-r from-emerald-400 to-transparent" aria-hidden="true" />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Modules</p>
          </div>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Everything a growing company needs, in one place
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-400">
            {moduleCount} modules that share one employee record. Turn on what you need on the
            smallest plan and add the rest as you grow — nothing is a separate product
            with a separate login.
          </p>
        </div>

        <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-medium text-slate-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          One login · {moduleCount} modules · {MODULE_GROUPS.length} groups
        </p>
      </div>

      <div className="mt-12 space-y-12">
        {MODULE_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="flex items-center gap-2.5 text-lg font-semibold text-white">
                <span className="h-4 w-1 rounded-full bg-gradient-to-b from-emerald-400 to-teal-500" aria-hidden="true" />
                {group.title}
              </h3>
              <p className="text-sm text-slate-400">{group.blurb}</p>
              <span className="ml-auto rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-0.5 text-[11px] font-medium text-slate-400">
                {group.items.length}
              </span>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {group.items.map((item, index) => (
                <article
                  key={item.name}
                  className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-all duration-200 hover:-translate-y-1 hover:border-emerald-400/30 hover:bg-white/[0.05] hover:shadow-[0_18px_40px_-22px_rgba(16,185,129,0.4)]"
                >
                  <span
                    className="pointer-events-none absolute -right-2 -top-3 text-5xl font-bold text-white/[0.04] transition-colors group-hover:text-emerald-400/10"
                    aria-hidden="true"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>

                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-500/10 text-emerald-300 transition-all group-hover:border-emerald-400/40 group-hover:bg-emerald-500/20">
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
