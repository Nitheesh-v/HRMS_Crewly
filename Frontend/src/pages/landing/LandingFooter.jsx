// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — FOOTER
//
// Compact by design. The first version stacked five blocks (brand, link
// columns, a support panel, a legal row and a colophon row) above a 280px
// wordmark, which made the footer taller than most of the page's sections. The
// page has already made its case by the time a reader gets here; the footer's
// job is to be a map and a receipt, not a sixth section.
//
// TWO RULES IT STILL FOLLOWS:
//
//  1. NO DEAD LINKS. "Terms" and "Privacy" do not exist, so they are stated as
//     plain text instead of dressed up as links, and every entry above resolves
//     to a real route or a real section — the test suite proves it.
//
//  2. NO INVENTED CONTACT DETAILS. There is no support email in the codebase,
//     so this footer does not manufacture one. Support is a real screen inside
//     every workspace, and that is what it points at.
// ═══════════════════════════════════════════════════════════════════════════

import { Link } from 'react-router-dom';
import { ArrowUp, ArrowUpRight, LifeBuoy } from 'lucide-react';
import { BRAND, FOOTER_COLUMNS, FOOTER_CREDIT, FOOTER_SUPPORT, HERO_WATERMARK, LEGAL_NOTE } from './landingData.js';
import { focusRing, primaryCta } from './landingStyles.js';

const footerLink =
  'text-[13px] text-crewly-ink/60 transition-colors hover:text-crewly-forest focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crewly-forest';

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
  <footer className="relative overflow-hidden border-t border-crewly-ink/10 bg-crewly-void-soft">
    <div className="landing-beam absolute inset-x-0 top-0 h-px opacity-60" aria-hidden="true" />

    <div className="mx-auto max-w-7xl px-5 pb-5 pt-8 sm:px-6 lg:px-8">
      <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 lg:grid-cols-[1.5fr_repeat(4,1fr)] lg:gap-8">
        {/* Brand + the one action. Kept to three short lines so it cannot set
            the height of the whole block. */}
        <div className="col-span-2 sm:col-span-3 lg:col-span-1">
          <Link
            to="/"
            aria-label="Crewly home"
            className={`group inline-flex items-center gap-2 rounded-lg ${focusRing}`}
          >
            <img src="/logo-crewly-mark.png" alt="" className="landing-mark" />
            <span className="text-[16px] font-bold tracking-tight text-crewly-ink">{BRAND.name}</span>
          </Link>

          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-crewly-ink/50">{BRAND.tagline}</p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link to="/register" className={`${primaryCta} px-5 py-2.5 text-[13px]`}>
              Create a workspace
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <span className="text-[11px] font-medium text-crewly-ink/45">
              {BRAND.trialDays}-day trial · no card
            </span>
          </div>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-crewly-ink/80">
              {column.title}
            </h3>
            <ul className="mt-3 space-y-1.5">
              {column.links.map((link) => (
                <li key={`${column.title}-${link.label}`}>
                  <FooterLink link={link} />
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      {/* Support: one strip, one sentence, one link. */}
      <div className="mt-6 flex flex-col gap-3 rounded-xl border border-crewly-ink/10 bg-white/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2.5 text-[12.5px] leading-relaxed text-crewly-ink/55">
          <LifeBuoy className="h-4 w-4 shrink-0 text-crewly-forest" aria-hidden="true" />
          <span>
            <span className="font-semibold text-crewly-ink">{FOOTER_SUPPORT.title}:</span> {FOOTER_SUPPORT.copy}
          </span>
        </p>
        <Link
          to={FOOTER_SUPPORT.link.to}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-crewly-ink/15 px-3.5 py-1.5 text-[12px] font-semibold text-crewly-ink transition-colors hover:border-crewly-ink/30 hover:bg-white ${focusRing}`}
        >
          {FOOTER_SUPPORT.link.label}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      {/* One bottom bar: the copyright line, then the legal note and the jump
          back up. Three short facts, no stacked rows. */}
      <div className="mt-6 border-t border-crewly-ink/10 pt-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-relaxed text-crewly-ink/50">
            © {new Date().getFullYear()} {BRAND.name} · {FOOTER_CREDIT.label} · Multi-tenant, INR billing
          </p>
          <a
            href="#main"
            className={`inline-flex w-fit items-center gap-1.5 rounded-lg text-[11px] font-semibold text-crewly-ink/55 transition-colors hover:text-crewly-forest ${focusRing}`}
          >
            Back to top
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-crewly-ink/40">
          <span className="font-semibold text-crewly-ink/50">{LEGAL_NOTE.label}:</span> {LEGAL_NOTE.text}
        </p>
      </div>
    </div>

    {/* The signature. Full height, small type, 8% ink: the reference closes on
        its own name, and this is the shortest honest way to do that. */}
    <div className="pointer-events-none flex justify-center overflow-hidden" aria-hidden="true">
      <span className="landing-wordmark">{HERO_WATERMARK}</span>
    </div>
  </footer>
);

export default LandingFooter;
