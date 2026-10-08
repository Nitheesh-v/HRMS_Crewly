import { SECURITY_POINTS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';

// Claims here are deliberately the ones the codebase can back up (tenant scoping,
// HttpOnly cookies, the permission catalogue, the audit model, payroll review,
// read-only on lapse). No certificates, no badges, no "bank-grade" adjectives —
// nothing this repository cannot evidence.
const SecuritySection = () => (
  <section id={SECTION_IDS.security} className="scroll-mt-24 border-t border-white/10 px-5 py-16 sm:px-6 lg:px-8 lg:py-24">
    <div className="mx-auto max-w-7xl">
      <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Security</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Built for the data you cannot afford to mix up
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-400">
            Crewly is multi-tenant: many companies share the platform, and none of them
            share data. That promise is enforced in the queries, the sessions and the
            permission checks — not in a settings page.
          </p>

          <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <p className="text-sm leading-relaxed text-slate-300">
              <span className="font-semibold text-white">Straight answer on compliance:</span>{' '}
              we do not claim certifications we have not been audited for, and this page
              carries no badges. What you get today is tenant isolation, role-based access,
              an audit trail and revocable sessions — described exactly as implemented.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {SECURITY_POINTS.map((point) => (
            <article
              key={point.title}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-emerald-400/25 hover:bg-white/[0.05]"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300">
                <LandingIcon name={point.icon} />
              </span>
              <h3 className="mt-4 text-base font-semibold text-white">{point.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{point.copy}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  </section>
);

export default SecuritySection;
