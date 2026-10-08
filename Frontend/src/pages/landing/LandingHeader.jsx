// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE — HEADER
//
//   · sticky, and it only gains a background once the page has scrolled, so the
//     hero is not fighting a solid bar at the top
//   · anchored nav that matches the sections that actually exist (tested)
//   · the CTA knows who is looking: a signed-in visitor gets "Open dashboard"
//     instead of a "Sign in" button they would bounce off
//   · the mobile menu is a real disclosure: aria-expanded, closes on navigation,
//     closes on Escape
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { ArrowRight, LayoutDashboard, Menu, X } from 'lucide-react';
import { NAV_LINKS } from './landingData.js';

const LandingHeader = () => {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const user = useSelector((state) => state.auth?.user);
  const signedIn = Boolean(user);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Escape closes the menu — a keyboard user must not be trapped by it.
  useEffect(() => {
    if (!menuOpen) return undefined;

    const onKey = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        scrolled || menuOpen
          ? 'border-b border-white/10 bg-[#0b1120]/85 backdrop-blur-xl'
          : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-5 sm:px-6 lg:px-8">
        <Link
          to="/"
          className="flex items-center gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-400"
          aria-label="Crewly home"
        >
          <img src="/logo-crewly.png" alt="" className="h-7 w-7 object-contain" />
          <span className="text-lg font-semibold tracking-tight text-white">Crewly</span>
        </Link>

        {/* Desktop nav */}
        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {signedIn ? (
            <Link
              to="/app"
              className="group inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-[#06251a] transition-colors hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
            >
              <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
              Open dashboard
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className="group inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-[#06251a] transition-colors hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
              >
                Start free
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </>
          )}
        </div>

        {/* Mobile disclosure */}
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="landing-mobile-menu"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 text-slate-200 transition-colors hover:bg-white/5 md:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
        >
          {menuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>

      {menuOpen && (
        <div id="landing-mobile-menu" className="border-t border-white/10 bg-[#0b1120]/95 backdrop-blur-xl md:hidden">
          <nav aria-label="Sections" className="mx-auto max-w-7xl px-5 py-3 sm:px-6">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={closeMenu}
                className="block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
              >
                {link.label}
              </a>
            ))}

            <div className="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3">
              {signedIn ? (
                <Link
                  to="/app"
                  onClick={closeMenu}
                  className="rounded-xl bg-emerald-500 px-4 py-2.5 text-center text-sm font-semibold text-[#06251a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
                >
                  Open dashboard
                </Link>
              ) : (
                <>
                  <Link
                    to="/login"
                    onClick={closeMenu}
                    className="rounded-xl border border-white/15 px-4 py-2.5 text-center text-sm font-semibold text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
                  >
                    Sign in
                  </Link>
                  <Link
                    to="/register"
                    onClick={closeMenu}
                    className="rounded-xl bg-emerald-500 px-4 py-2.5 text-center text-sm font-semibold text-[#06251a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
                  >
                    Start free
                  </Link>
                </>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
};

export default LandingHeader;
