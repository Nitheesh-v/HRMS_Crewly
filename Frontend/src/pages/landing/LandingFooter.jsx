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
  'text-sm text-crewly-ink/60 transition-colors hover:text-crewly-forest focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest';

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
  <footer className="relative overflow-hidden border-t border-crewly-ink/[0.06] bg-crewly-void-soft">
    <div className="landing-beam absolute inset-x-0 top-0 h-px opacity-60" aria-hidden="true" />

    <div className="mx-auto max-w-7xl px-5 pb-8 pt-14 sm:px-6 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-[1.35fr_repeat(4,1fr)] lg:gap-8">
        <div>
          <Link
            to="/"
            aria-label="Crewly home"
            className="group inline-flex items-center gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-crewly-forest"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-crewly-ink/10 bg-crewly-ink/[0.05] p-1.5 transition-colors group-hover:border-crewly-forest/35">
              <img src="/logo-crewly-mark.png" alt="" className="h-full w-full object-contain" />
            </span>
            <span className="text-[17px] font-semibold tracking-tight text-crewly-ink">{BRAND.name}</span>
          </Link>

          <p className="mt-4 max-w-xs text-sm leading-relaxed text-crewly-ink/50">{BRAND.tagline}</p>

          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-crewly-ink/10 bg-crewly-ink/[0.03] px-3 py-1.5 text-xs font-semibold text-crewly-ink/60">
            <span className="h-1.5 w-1.5 rounded-full bg-crewly-lilac" aria-hidden="true" />
            {BRAND.trialDays}-day trial · no card required
          </p>

          <Link to="/register" className={`mt-5 ${primaryCta}`}>
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

      <div className="mt-12 overflow-hidden rounded-2xl border border-crewly-ink/10 bg-white/60">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-crewly-forest/25 bg-crewly-forest/10 text-crewly-forest">
              <LifeBuoy className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-crewly-ink">{FOOTER_SUPPORT.title}</h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-crewly-ink/50">{FOOTER_SUPPORT.copy}</p>
            </div>
          </div>

          <Link
            to={FOOTER_SUPPORT.link.to}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-crewly-ink/15 bg-white/60 px-4 py-2 text-sm font-semibold text-crewly-ink transition-colors hover:border-crewly-ink/30 hover:bg-crewly-ink/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest"
          >
            {FOOTER_SUPPORT.link.label}
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="mt-10 flex flex-col gap-4 border-t border-crewly-ink/[0.08] pt-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs text-crewly-ink/60">
            © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
          <p className="mt-1.5 max-w-xl text-[11px] leading-relaxed text-crewly-ink/45">
            <span className="font-semibold text-crewly-ink/55">{LEGAL_NOTE.label}:</span> {LEGAL_NOTE.text}
          </p>
        </div>

        <div className="flex items-center gap-4 sm:flex-col sm:items-end">
          <p className="text-[11px] text-crewly-ink/45">
            Multi-tenant SaaS · INR billing · Each company&apos;s data stays in its own tenant.
          </p>
          <a
            href="#main"
            className="inline-flex items-center gap-1.5 rounded-lg text-[11px] font-semibold text-crewly-ink/55 transition-colors hover:text-crewly-forest focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest"
          >
            Back to top
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>

      {/* The colophon. The reference closes on its own name, cropped by the
          viewport; so does this one, with a credit line this repo can back up. */}
      <div className="mt-12 flex flex-col gap-3 border-t border-crewly-ink/[0.08] pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-crewly-ink/60">
          {FOOTER_CREDIT.label}
        </p>
        <p className="text-[11px] text-crewly-ink/40">{FOOTER_CREDIT.detail}</p>
      </div>
    </div>

    <div className="pointer-events-none relative flex justify-center overflow-hidden" aria-hidden="true">
      <span className="landing-wordmark translate-y-[16%] text-crewly-ink/[0.07]">{HERO_WATERMARK}</span>
    </div>
  </footer>
);

export default LandingFooter;
