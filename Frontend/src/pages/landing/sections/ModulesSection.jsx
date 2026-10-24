import { MODULE_GROUPS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

const moduleCount = MODULE_GROUPS.reduce((total, group) => total + group.items.length, 0);

// The inventory, as opposed to PlatformSection's deep dives: grouped the way the
// sidebar groups them, so someone comparing this page with the product finds the
// same words in the same places.
const ModulesSection = () => (
  <section
    id={SECTION_IDS.modules}
    className="scroll-mt-28 border-t border-crewly-lilac-line bg-white px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
  >
    <div className="mx-auto max-w-7xl">
      <div className="max-w-3xl">
        <div className="flex items-center gap-3">
          <span className="h-px w-8 bg-gradient-to-r from-violet-500 to-transparent" aria-hidden="true" />
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">All modules</p>
        </div>
        <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-crewly-ink sm:text-4xl">
          {moduleCount} modules. One login. No bolt-ons.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          Turn on what you need on the smallest plan and add the rest as you grow. Nothing here is a
          separate product with a separate password, and nothing here is &ldquo;coming soon&rdquo;.
        </p>
        <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-crewly-lilac-line bg-crewly-lilac/60 px-4 py-2 text-xs font-semibold text-crewly-ink-soft">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          {MODULE_GROUPS.length} groups · {moduleCount} modules · shipped
        </p>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        {MODULE_GROUPS.map((group) => (
          <div
            key={group.title}
            className="rounded-3xl border border-crewly-lilac-line bg-gradient-to-b from-white to-crewly-lilac/30 p-5 sm:p-6"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="flex items-center gap-2.5 text-lg font-semibold text-crewly-ink">
                <span className="h-4 w-1 rounded-full bg-gradient-to-b from-violet-500 to-emerald-500" aria-hidden="true" />
                {group.title}
              </h3>
              <p className="text-sm text-slate-500">{group.blurb}</p>
              <span className="ml-auto rounded-full bg-white px-2.5 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-crewly-lilac-line">
                {group.items.length}
              </span>
            </div>

            <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
              {group.items.map((item) => (
                <article
                  key={item.name}
                  className="group rounded-2xl border border-white bg-white p-4 shadow-[0_1px_2px_rgba(23,18,51,0.04)] transition-[color,background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-[0_18px_34px_-26px_rgba(59,21,128,0.6)]"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-crewly-lilac text-violet-700 transition-colors group-hover:bg-violet-100">
                    <LandingIcon name={item.icon} className="h-4 w-4" />
                  </span>
                  <h4 className="mt-3 text-sm font-semibold text-crewly-ink">{item.name}</h4>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">{item.copy}</p>
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
