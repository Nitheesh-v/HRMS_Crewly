import { ROLE_CARDS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import { eyebrow } from '../landingStyles.js';

// The five roles the product actually ships (pinned by test against ROLE_LABELS),
// and what each one gets on day one. No personas invented for a slide.
//
// The layout is a ladder, not a row of equal boxes: the admin card opens into a
// wide panel with the HR Manager beside it, and the three scoped roles fill the
// row beneath — one owner, four scoped roles, read top-left to bottom-right.
// (A `row-span-2` admin card was tried first and left a dead column of empty
// space inside it, because the right column is two cards tall.)
const RolesSection = () => {
  const [lead, ...rest] = ROLE_CARDS;

  return (
    <section
      id={SECTION_IDS.roles}
      className="scroll-mt-28 border-t border-white/[0.06] bg-crewly-night px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
    >
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
          <div>
            <div className="flex items-center gap-3">
              <span className="h-px w-8 bg-gradient-to-r from-emerald-400 to-transparent" aria-hidden="true" />
              <p className={eyebrow}>Who it is for</p>
            </div>
            <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Five roles, five honestly different views
            </h2>
          </div>
          <p className="text-base leading-relaxed text-slate-400">
            The same workspace looks different depending on who opened it — and not because a page was
            hidden with CSS. Permissions decide what is fetched, what is shown and what can be changed.
          </p>
        </div>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {/* The owner's card: double width on desktop, emerald edge. */}
          <article className="landing-card relative flex flex-col overflow-hidden rounded-3xl border-emerald-400/25 bg-gradient-to-br from-emerald-500/[0.12] via-emerald-500/[0.03] to-transparent p-6 sm:p-7 lg:col-span-2">
            <div
              className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-emerald-400/15 blur-3xl"
              aria-hidden="true"
            />
            <div>
              <div className="flex items-start justify-between gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500 text-[#04231a]">
                  <LandingIcon name={lead.icon} className="h-5 w-5" />
                </span>
                <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300">
                  Owns the workspace
                </span>
              </div>

              <h3 className="mt-5 text-2xl font-bold tracking-tight text-white">{lead.name}</h3>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-300">{lead.copy}</p>
            </div>

            <div className="mt-6 grid gap-2 sm:grid-cols-2 lg:mt-auto lg:pt-6">
              {lead.sees.map((item) => (
                <span
                  key={item}
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-slate-200"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </div>
          </article>

          {rest.map((role) => (
            <article
              key={role.code}
              className="group rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:border-emerald-400/25 hover:bg-white/[0.04]"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-400/20 bg-violet-500/10 text-violet-300">
                  <LandingIcon name={role.icon} className="h-4 w-4" />
                </span>
                <h3 className="text-base font-semibold text-white">{role.name}</h3>
              </div>

              <p className="mt-3 text-[13px] leading-relaxed text-slate-400">{role.copy}</p>

              <ul className="mt-4 space-y-1.5">
                {role.sees.map((item) => (
                  <li key={item} className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-400">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <p className="mt-8 text-xs leading-relaxed text-slate-500">
          A role that is not a precise fit can be adjusted: the permission catalogue allows per-person
          overrides, and every change lands in the audit trail.
        </p>
      </div>
    </section>
  );
};

export default RolesSection;
