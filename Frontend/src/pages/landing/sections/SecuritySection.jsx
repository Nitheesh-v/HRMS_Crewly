// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — TRUST: SECURITY + WHO SEES WHAT
//
// A buyer's last question before a trial is "what happens to our data, and who
// inside our company can see it". This section answers both in one place instead
// of scattering roles into their own marketing band.
//
// NO BADGES. There is no audit in this repository, so there is no certification
// wall here — the last tile says so in plain words. That sentence is pinned by
// the test suite; deleting it turns an honest page into a liar.
// ═══════════════════════════════════════════════════════════════════════════

import { Check, ShieldCheck } from 'lucide-react';
import { ROLE_CARDS, SECURITY_POINTS, SECTION_IDS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import { displayLg, eyebrow, sectionCopy } from '../landingStyles.js';
import { tintAt } from '../landingTints.js';

const SecuritySection = () => (
  <section
    id={SECTION_IDS.security}
    className="relative scroll-mt-24 overflow-hidden bg-crewly-sage/55 py-20 sm:py-24 lg:py-28"
  >
    <div className="landing-glow-soft pointer-events-none absolute inset-0 -z-10 opacity-60" aria-hidden="true" />

    <div className="mx-auto max-w-7xl px-5 sm:px-6 lg:px-8">
      <div className="landing-scroll-in grid gap-8 lg:grid-cols-[1fr_1fr] lg:items-end lg:gap-16">
        <div>
          <p className={eyebrow}>Trust, stated plainly</p>
          <h2 className={`mt-4 ${displayLg}`}>Your tenant. Your roles. Your record.</h2>
        </div>
        <p className={`${sectionCopy} max-w-xl lg:pb-2`}>
          Nothing here is aspirational: each point is a behaviour the product ships. Where we have
          not been audited, we say so instead of hanging a badge on the wall.
        </p>
      </div>

      <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SECURITY_POINTS.map((point, index) => (
          <article
            key={point.title}
            className="landing-scroll-in rounded-2xl border border-crewly-ink/15 bg-crewly-void p-5 transition-[background-color,border-color] hover:bg-white"
          >
            <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border ${tintAt(index).chip}`}>
              <LandingIcon name={point.icon} className="h-4 w-4" />
            </span>
            <h3 className="mt-4 text-[15px] font-semibold text-crewly-ink">{point.title}</h3>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-crewly-ink/60">{point.copy}</p>
            <span className={`mt-3 block h-px w-10 ${tintAt(index).dot}`} aria-hidden="true" />
          </article>
        ))}
      </div>

      <div className="landing-scroll-in mt-3 flex items-start gap-3 rounded-2xl border border-crewly-lilac-deep/40 bg-crewly-lilac/30 p-4">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-crewly-forest" aria-hidden="true" />
        <p className="text-[12.5px] leading-relaxed text-crewly-ink/50">
          We do not claim ISO, SOC or any other certification on this page. There is no audit behind
          one yet — when there is, it will say so here, with the certificate.
        </p>
      </div>

      {/* Roles, merged in: permissions are a security surface, not a persona page. */}
      <div id={SECTION_IDS.roles} className="landing-scroll-in mt-16 scroll-mt-24">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className={eyebrow}>Who sees what</p>
            <h3 className="mt-3 text-2xl font-bold tracking-[-0.025em] text-crewly-ink sm:text-3xl">
              Five roles, out of the box.
            </h3>
          </div>
          <p className="max-w-sm text-[12.5px] leading-relaxed text-crewly-ink/50">
            Defaults that make sense on day one. Where a role is not a precise fit, a permission can be
            overridden for one person instead of inventing a sixth role.
          </p>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {ROLE_CARDS.map((role, index) => (
            <article
              key={role.code}
              className={`flex flex-col rounded-2xl border p-4 ${
                role.featured
                  ? 'border-crewly-forest/40 bg-crewly-forest text-crewly-void'
                  : tintAt(index + 1).surface
              }`}
            >
              <span
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${
                  role.featured
                    ? 'border-crewly-lilac/50 bg-crewly-lilac text-crewly-forest'
                    : tintAt(index + 1).chip
                }`}
              >
                <LandingIcon name={role.icon} className="h-3.5 w-3.5" />
              </span>
              <h4 className={`mt-3 text-[13px] font-semibold ${role.featured ? 'text-crewly-void' : 'text-crewly-ink'}`}>
                {role.name}
              </h4>
              <p className={`mt-1 text-[11.5px] leading-relaxed ${role.featured ? 'text-crewly-void/70' : 'text-crewly-ink/55'}`}>
                {role.copy}
              </p>
              <ul className={`mt-3 space-y-1 border-t pt-3 ${role.featured ? 'border-crewly-void/20' : 'border-crewly-ink/10'}`}>
                {role.sees.slice(0, 3).map((item) => (
                  <li
                    key={item}
                    className={`flex items-start gap-1.5 text-[10.5px] leading-relaxed ${
                      role.featured ? 'text-crewly-void/80' : 'text-crewly-ink/60'
                    }`}
                  >
                    <Check
                      className={`mt-0.5 h-2.5 w-2.5 shrink-0 ${role.featured ? 'text-crewly-lilac' : 'text-crewly-ink/40'}`}
                      aria-hidden="true"
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </div>
  </section>
);

export default SecuritySection;
