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
import { BRAND, FOOTER_COLUMNS, FOOTER_CREDIT, FOOTER_SUPPORT, HERO_WATERMARK, LEGAL_NOTE } from './landingData.js';
import { primaryCta } from './landingStyles.js';

const footerLink =
  'text-sm text-white/45 transition-colors hover:text-emerald-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';

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
  <footer className="relative overflow-hidden border-t border-white/[0.06] bg-crewly-void-soft">
    <div className="landing-beam absolute inset-x-0 top-0 h-px opacity-60" aria-hidden="true" />

    <div className="mx-auto max-w-7xl px-5 pb-8 pt-14 sm:px-6 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-[1.35fr_repeat(4,1fr)] lg:gap-8">
        <div>
          <Link
            to="/"
            aria-label="Crewly home"
            className="group inline-flex items-center gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] p-1.5 transition-colors group-hover:border-emerald-400/30">
              <img src="/logo-crewly-mark.png" alt="" className="h-full w-full object-contain" />
            </span>
            <span className="text-[17px] font-semibold tracking-tight text-white">{BRAND.name}</span>
          </Link>

          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-500">{BRAND.tagline}</p>

          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
            {BRAND.trialDays}-day trial · no card required
          </p>

          <Link to="/register" className={`mt-5 ${primaryCta}`}>
            Create a workspace
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-white">{column.title}</h3>
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

      <div className="mt-12 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
              <LifeBuoy className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-white">{FOOTER_SUPPORT.title}</h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">{FOOTER_SUPPORT.copy}</p>
            </div>
          </div>

          <Link
            to={FOOTER_SUPPORT.link.to}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-4 py-2 text-sm font-semibold text-slate-100 transition-colors hover:border-white/30 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          >
            {FOOTER_SUPPORT.link.label}
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="mt-10 flex flex-col gap-4 border-t border-white/[0.08] pt-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs text-white/45">
            © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
          <p className="mt-1.5 max-w-xl text-[11px] leading-relaxed text-white/35">
            <span className="font-semibold text-white/50">{LEGAL_NOTE.label}:</span> {LEGAL_NOTE.text}
          </p>
        </div>

        <div className="flex items-center gap-4 sm:flex-col sm:items-end">
          <p className="text-[11px] text-white/35">
            Multi-tenant SaaS · INR billing · Each company&apos;s data stays in its own tenant.
          </p>
          <a
            href="#main"
            className="inline-flex items-center gap-1.5 rounded-lg text-[11px] font-semibold text-white/50 transition-colors hover:text-emerald-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          >
            Back to top
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>

      {/* The colophon. The reference closes on its own name, cropped by the
          viewport; so does this one, with a credit line this repo can back up. */}
      <div className="mt-12 flex flex-col gap-3 border-t border-white/[0.08] pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
          {FOOTER_CREDIT.label}
        </p>
        <p className="text-[11px] text-white/30">{FOOTER_CREDIT.detail}</p>
      </div>
    </div>

    <div className="pointer-events-none relative flex justify-center overflow-hidden" aria-hidden="true">
      <span className="landing-wordmark translate-y-[16%] text-white/[0.07]">{HERO_WATERMARK}</span>
    </div>
  </footer>
);

export default LandingFooter;
