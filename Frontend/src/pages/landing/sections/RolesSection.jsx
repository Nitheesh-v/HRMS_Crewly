import { ROLE_CARDS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

// Keka sells "solutions by role". This is the honest version: the five roles the
// product actually ships (pinned by test against ROLE_LABELS), and what each one
// gets on day one. No personas invented for a slide.
const RolesSection = () => (
  <section
    id={SECTION_IDS.roles}
    className="scroll-mt-28 border-t border-crewly-lilac-line bg-white px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
  >
    <div className="mx-auto max-w-7xl">
      <div className="mx-auto max-w-3xl text-center">
        <div className="flex items-center justify-center gap-3">
          <span className="h-px w-8 bg-gradient-to-l from-emerald-500 to-transparent" aria-hidden="true" />
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Who it is for</p>
          <span className="h-px w-8 bg-gradient-to-r from-emerald-500 to-transparent" aria-hidden="true" />
        </div>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-crewly-ink sm:text-4xl">
          Five roles, five honestly different views
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          The same workspace looks different depending on who opened it — and not because a page was
          hidden with CSS. Permissions decide what is fetched, what is shown and what can be changed.
        </p>
      </div>

      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {ROLE_CARDS.map((role) => (
          <article
            key={role.code}
            className={`flex flex-col rounded-2xl border p-5 transition-[color,background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-1 ${
              role.featured
                ? 'border-violet-200 bg-gradient-to-b from-violet-50/90 to-white shadow-[0_24px_50px_-38px_rgba(76,29,149,0.8)] ring-1 ring-violet-100'
                : 'border-crewly-lilac-line bg-white hover:border-violet-200 hover:shadow-[0_20px_44px_-34px_rgba(59,21,128,0.55)]'
            }`}
          >
            <span
              className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                role.featured ? 'bg-violet-600 text-white' : 'bg-crewly-lilac text-violet-700'
              }`}
            >
              <LandingIcon name={role.icon} className="h-4 w-4" />
            </span>

            <h3 className="mt-4 text-base font-semibold text-crewly-ink">{role.name}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-500">{role.copy}</p>

            <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Gets on day one
            </p>
            <ul className="mt-2 space-y-1.5">
              {role.sees.map((item) => (
                <li key={item} className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-600">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <p className="mx-auto mt-8 max-w-3xl text-center text-xs leading-relaxed text-slate-500">
        A role that is not a precise fit can be adjusted: the permission catalogue allows per-person
        overrides, and every change lands in the audit trail.
      </p>
    </div>
  </section>
);

export default RolesSection;
