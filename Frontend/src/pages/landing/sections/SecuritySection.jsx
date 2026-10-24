import { Lock, ShieldQuestion } from 'lucide-react';
import { SECURITY_POINTS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

// Keka's security band is a row of certification badges. There is no audit trail
// in this repository that would justify a badge, so this section carries none:
// it states the controls that are implemented, and says plainly what is not.
const SecuritySection = () => (
  <section
    id={SECTION_IDS.security}
    className="scroll-mt-28 border-t border-crewly-lilac-line bg-crewly-lilac/40 px-5 py-16 sm:px-6 lg:px-8 lg:py-24"
  >
    <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
      <div>
        <div className="flex items-center gap-3">
          <span className="h-px w-8 bg-gradient-to-r from-violet-500 to-transparent" aria-hidden="true" />
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Security</p>
        </div>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-crewly-ink sm:text-4xl">
          Built for the data you cannot afford to mix up
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          Crewly is multi-tenant: many companies share the platform, and none of them share data. That
          promise is enforced in the queries, the sessions and the permission checks — not in a settings
          page.
        </p>

        <div className="mt-6 rounded-2xl border border-amber-200/80 bg-amber-50/70 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <ShieldQuestion className="h-4 w-4" aria-hidden="true" />
            Straight answer on compliance
          </p>
          <p className="mt-2 text-sm leading-relaxed text-amber-900/80">
            We do not claim certifications we have not been audited for, and this page carries no badges.
            What you get today is tenant isolation, role-based access, an audit trail and revocable
            sessions — described exactly as implemented.
          </p>
        </div>

        <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-crewly-lilac-line bg-white px-3.5 py-2 text-xs font-semibold text-crewly-ink-soft">
          <Lock className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
          HttpOnly session cookie · CSRF header · per-tenant scoping
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {SECURITY_POINTS.map((point) => (
          <article
            key={point.title}
            className="group rounded-2xl border border-white bg-white p-5 shadow-[0_16px_36px_-32px_rgba(23,18,51,0.5)] transition-[color,background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-violet-200"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 transition-colors group-hover:bg-emerald-100">
              <LandingIcon name={point.icon} className="h-4 w-4" />
            </span>
            <h3 className="mt-4 text-base font-semibold text-crewly-ink">{point.title}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-500">{point.copy}</p>
          </article>
        ))}
      </div>
    </div>
  </section>
);

export default SecuritySection;
