// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — FOOTER
//
// TWO RULES THIS FOOTER FOLLOWS, and why:
//
//  1. NO DEAD LINKS. The auth screens render "Terms & Conditions" and
//     "Privacy Policy" as plain text because those pages do not exist. This
//     footer states that in the bottom bar instead of dressing them up as
//     links, and every entry above resolves to a real route or a real section —
//     the test suite proves it.
//
//  2. NO INVENTED CONTACT DETAILS. There is no support email in the codebase,
//     so this footer does not manufacture one. Support is a real screen inside
//     every workspace, and that is what it points at.
// ═══════════════════════════════════════════════════════════════════════════

import { Link } from 'react-router-dom';
import { ArrowUp, ArrowUpRight, LifeBuoy } from 'lucide-react';
import { BRAND, FOOTER_COLUMNS, FOOTER_SUPPORT, LEGAL_NOTE } from './landingData.js';

const footerLink =
  'text-sm text-slate-500 transition-colors hover:text-violet-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700';

const FooterLink = ({ link }) =>
  link.to ? (
    <Link to={link.to} className={footerLink}>
      {link.label}
    </Link>
  ) : (
    <a href={link.href} className={footerLink}>
      {link.label}
    </a>
  );

const LandingFooter = () => (
  <footer className="relative border-t border-crewly-lilac-line bg-white">
    <div className="mx-auto max-w-7xl px-5 pb-8 pt-14 sm:px-6 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-[1.35fr_repeat(4,1fr)] lg:gap-8">
        <div>
          <Link
            to="/"
            aria-label="Crewly home"
            className="inline-flex rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-700"
          >
            <img
              src="/logo-crewly-wordmark.png"
              alt=""
              className="landing-wordmark"
              width="603"
              height="233"
            />
          </Link>

          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-500">{BRAND.tagline}</p>

          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-crewly-lilac-line bg-crewly-lilac/60 px-3 py-1.5 text-xs font-semibold text-crewly-ink-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            {BRAND.trialDays}-day trial · no card required
          </p>

          <Link
            to="/register"
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-violet-700 to-[#4c1d95] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_10px_24px_-14px_rgba(76,29,149,0.9)] transition-[color,background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:from-violet-600 hover:to-violet-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
          >
            Create a workspace
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-crewly-ink">{column.title}</h3>
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

      <div className="mt-12 overflow-hidden rounded-2xl border border-crewly-lilac-line bg-crewly-lilac/40">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-700 ring-1 ring-crewly-lilac-line">
              <LifeBuoy className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-crewly-ink">{FOOTER_SUPPORT.title}</h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">{FOOTER_SUPPORT.copy}</p>
            </div>
          </div>

          <Link
            to={FOOTER_SUPPORT.link.to}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-crewly-ink transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
          >
            {FOOTER_SUPPORT.link.label}
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="mt-10 flex flex-col gap-4 border-t border-crewly-lilac-line pt-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs text-slate-500">
            © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
          <p className="mt-1.5 max-w-xl text-[11px] leading-relaxed text-slate-400">
            <span className="font-semibold text-slate-500">{LEGAL_NOTE.label}:</span> {LEGAL_NOTE.text}
          </p>
        </div>

        <div className="flex items-center gap-4 sm:flex-col sm:items-end">
          <p className="text-[11px] text-slate-400">
            Multi-tenant SaaS · INR billing · Each company&apos;s data stays in its own tenant.
          </p>
          <a
            href="#main"
            className="inline-flex items-center gap-1.5 rounded-lg text-[11px] font-semibold text-slate-500 transition-colors hover:text-violet-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
          >
            Back to top
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  </footer>
);

export default LandingFooter;
