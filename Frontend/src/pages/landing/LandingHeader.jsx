// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — FLOATING GLASS HEADER
//
// A pill of glass that floats over the canvas, then settles onto the top edge
// when the page scrolls. Five links, one action, one brand mark: the page is
// long and loud, the navigation should not compete with it.
//
//   · sticky, so the CTA is one click away from any scroll position
//   · mobile is a real disclosure (aria-expanded, aria-controls, Escape)
//   · the panel stays MOUNTED and toggles `hidden`, so `aria-controls` always
//     names an element that exists
//   · a signed-in visitor gets "Open dashboard" instead of "Start free" — the
//     page never tells an existing customer to register again
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { ArrowRight, LayoutDashboard, Menu, X } from 'lucide-react';
import { NAV_LINKS } from './landingData.js';
import { focusRing, navLink, primaryCta } from './landingStyles.js';

const BrandLockup = () => (
  <>
    <span className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-white/12 bg-white/[0.06] p-1.5">
      <img src="/logo-crewly-mark.png" alt="" className="h-full w-full object-contain" />
    </span>
    <span className="text-[16px] font-bold tracking-tight text-white">Crewly</span>
  </>
);

const LandingHeader = () => {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const user = useSelector((state) => state.auth?.user);
  const signedIn = Boolean(user);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Escape closes the mobile panel — a keyboard user must not be trapped.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="sticky top-0 z-50">
      <div
        className={`mx-auto max-w-7xl px-4 transition-[padding] duration-300 sm:px-6 ${
          scrolled ? 'pt-2 sm:pt-3' : 'pt-4 sm:pt-6'
        }`}
      >
        <div
          className={`flex h-14 items-center justify-between gap-3 rounded-full border px-3 backdrop-blur-xl transition-[background-color,border-color,box-shadow] duration-300 sm:h-16 sm:px-4 ${
            scrolled
              ? 'border-white/12 bg-crewly-void/92 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.95)]'
              : 'border-white/[0.07] bg-white/[0.03]'
          }`}
        >
          <Link
            to="/"
            aria-label="Crewly home"
            className={`group flex shrink-0 items-center gap-2.5 rounded-full pl-1 pr-2 py-1 ${focusRing}`}
          >
            <BrandLockup />
          </Link>

          <nav aria-label="Sections" className="hidden items-center gap-0.5 lg:flex">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className={navLink}>
                {link.label}
              </a>
            ))}
          </nav>

          <div className="hidden items-center gap-1 lg:flex">
            {signedIn ? (
              <Link to="/app" className={primaryCta}>
                <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
                Open dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className={`rounded-full px-3.5 py-2 text-sm font-medium text-slate-300 transition-colors hover:text-white ${focusRing}`}>
                  Sign in
                </Link>
                <Link to="/register" className={primaryCta}>
                  Start free
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="landing-mobile-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className={`inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-slate-200 transition-colors hover:bg-white/[0.08] lg:hidden ${focusRing}`}
          >
            {menuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>

        <div
          id="landing-mobile-menu"
          hidden={!menuOpen}
          className="mt-2 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-3xl border border-white/10 bg-crewly-void-soft/95 p-2 backdrop-blur-xl lg:hidden"
        >
          <nav aria-label="Sections">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className={`block rounded-2xl px-3.5 py-3 text-sm font-medium text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white ${focusRing}`}
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="mt-2 flex flex-col gap-2 border-t border-white/10 pt-3">
            {signedIn ? (
              <Link to="/app" onClick={() => setMenuOpen(false)} className={`${primaryCta} justify-center`}>
                Open dashboard
              </Link>
            ) : (
              <>
                <Link
                  to="/login"
                  onClick={() => setMenuOpen(false)}
                  className={`rounded-full border border-white/15 px-4 py-2.5 text-center text-sm font-semibold text-slate-100 transition-colors hover:bg-white/[0.06] ${focusRing}`}
                >
                  Sign in
                </Link>
                <Link to="/register" onClick={() => setMenuOpen(false)} className={`${primaryCta} justify-center`}>
                  Start free
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

export default LandingHeader;
