// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE — FOOTER
//
// TWO RULES THIS FOOTER FOLLOWS, and why:
//
//  1. NO DEAD LINKS. The auth screens render "Terms & Conditions" and
//     "Privacy Policy" as plain text because those pages do not exist. This
//     footer does not dress them up as links, and it does not repeat them as
//     dead spans either — inventing legal copy or fake destinations is worse
//     than not having the link. Every entry here resolves to a real route or a
//     real section, and the test suite proves it.
//
//  2. NO INVENTED CONTACT DETAILS. There is no support email in the codebase,
//     so this footer does not manufacture one. Support is a real screen inside
//     every workspace, and that is what it points at.
// ═══════════════════════════════════════════════════════════════════════════

import { Link } from 'react-router-dom';
import { ArrowUpRight, LifeBuoy } from 'lucide-react';
import { BRAND, FOOTER_COLUMNS, FOOTER_SUPPORT } from './landingData.js';

const BrandMark = () => (
  <div className="flex items-center gap-2.5">
    <img src="/logo-crewly.png" alt="" className="h-8 w-8 object-contain" />
    <span className="text-lg font-semibold tracking-tight text-white">{BRAND.name}</span>
  </div>
);

const FooterLink = ({ link }) => {
  const className =
    'text-sm text-slate-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400';

  if (link.to) {
    return (
      <Link to={link.to} className={className}>
        {link.label}
      </Link>
    );
  }

  return (
    <a href={link.href} className={className}>
      {link.label}
    </a>
  );
};

const LandingFooter = () => (
  <footer className="border-t border-white/10 bg-[#080e1b]">
    <div className="mx-auto max-w-7xl px-5 py-14 sm:px-6 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <BrandMark />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-400">{BRAND.tagline}</p>
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
            {BRAND.trialDays}-day trial · no card required
          </p>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h3 className="text-sm font-semibold text-white">{column.title}</h3>
            <ul className="mt-4 space-y-2.5">
              {column.links.map((link) => (
                <li key={`${column.title}-${link.label}`}>
                  <FooterLink link={link} />
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="mt-12 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300">
              <LifeBuoy className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-white">{FOOTER_SUPPORT.title}</h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-400">{FOOTER_SUPPORT.copy}</p>
            </div>
          </div>

          <Link
            to={FOOTER_SUPPORT.link.to}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            {FOOTER_SUPPORT.link.label}
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="mt-10 flex flex-col gap-3 border-t border-white/10 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-500">
          © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
        </p>
        <p className="text-xs text-slate-500">
          Multi-tenant SaaS · INR billing · Each company&apos;s data stays in its own tenant.
        </p>
      </div>
    </div>
  </footer>
);

export default LandingFooter;
