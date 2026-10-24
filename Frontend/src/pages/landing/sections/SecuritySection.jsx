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

const SecuritySection = () => (
  <section
    id={SECTION_IDS.security}
    className="relative scroll-mt-24 overflow-hidden border-y border-white/[0.05] bg-white/[0.012] py-20 sm:py-24 lg:py-28"
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
        {SECURITY_POINTS.map((point) => (
          <article
            key={point.title}
            className="landing-scroll-in rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 transition-[background-color,border-color] hover:border-emerald-400/20 hover:bg-emerald-500/[0.03]"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] text-emerald-300">
              <LandingIcon name={point.icon} className="h-4 w-4" />
            </span>
            <h3 className="mt-4 text-[15px] font-semibold text-white">{point.title}</h3>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-400">{point.copy}</p>
          </article>
        ))}
      </div>

      <div className="landing-scroll-in mt-3 flex items-start gap-3 rounded-2xl border border-white/[0.07] bg-crewly-panel/60 p-4">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
        <p className="text-[12.5px] leading-relaxed text-slate-500">
          We do not claim ISO, SOC or any other certification on this page. There is no audit behind
          one yet — when there is, it will say so here, with the certificate.
        </p>
      </div>

      {/* Roles, merged in: permissions are a security surface, not a persona page. */}
      <div id={SECTION_IDS.roles} className="landing-scroll-in mt-16 scroll-mt-24">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className={eyebrow}>Who sees what</p>
            <h3 className="mt-3 text-2xl font-bold tracking-[-0.025em] text-white sm:text-3xl">
              Five roles, out of the box.
            </h3>
          </div>
          <p className="max-w-sm text-[12.5px] leading-relaxed text-slate-500">
            Defaults that make sense on day one. Where a role is not a precise fit, a permission can be
            overridden for one person instead of inventing a sixth role.
          </p>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {ROLE_CARDS.map((role) => (
            <article
              key={role.code}
              className={`flex flex-col rounded-2xl border p-4 ${
                role.featured
                  ? 'border-emerald-400/25 bg-emerald-500/[0.06]'
                  : 'border-white/[0.07] bg-white/[0.02]'
              }`}
            >
              <span
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${
                  role.featured
                    ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                    : 'border-white/10 bg-white/[0.04] text-slate-400'
                }`}
              >
                <LandingIcon name={role.icon} className="h-3.5 w-3.5" />
              </span>
              <h4 className="mt-3 text-[13px] font-semibold text-white">{role.name}</h4>
              <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500">{role.copy}</p>
              <ul className="mt-3 space-y-1 border-t border-white/[0.06] pt-3">
                {role.sees.slice(0, 3).map((item) => (
                  <li key={item} className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-slate-400">
                    <Check
                      className={`mt-0.5 h-2.5 w-2.5 shrink-0 ${role.featured ? 'text-emerald-400' : 'text-slate-600'}`}
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
