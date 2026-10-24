// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — ANNOUNCEMENT BAR + HEADER
//
// The page opens on the app's own chrome, not a template's: a night canvas, the
// emerald it uses for "live", and the violet of the logo mark as the only
// accent. The header is the same one the product would ship — glass, a hairline,
// a platform mega-menu — so the page and the app feel like one product.
//
//   · the announcement bar states something already live and can be dismissed
//   · the header is sticky and gains depth only after the page scrolls
//   · "Platform" is a real disclosure: aria-expanded, a labelled panel, Escape,
//     outside-click and choosing an item all close it
//   · the panel and the mobile menus stay MOUNTED and toggle `hidden`, so
//     `aria-controls` always names an element that exists
//   · every menu item is still an `<a href="#platform">`, so the menu works even
//     if the event that selects a tab never fires
//   · the CTA knows who is looking: a signed-in visitor gets "Open dashboard"
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { ArrowRight, ChevronDown, LayoutDashboard, Menu, Sparkles, X } from 'lucide-react';
import { ANNOUNCEMENT, NAV_LINKS, PLATFORM_TABS, SECTION_IDS } from './landingData.js';
import LandingIcon from './LandingIcon.jsx';
import { requestPlatformTab } from './landingTabs.js';
import { focusRing, navLink, primaryCta } from './landingStyles.js';

// One announcement per visit. `sessionStorage` is optional on purpose: in a
// browser that blocks it (or in SSR), the bar simply stays visible.
const ANNOUNCEMENT_KEY = 'crewly.landing.announcement.dismissed';

const readDismissed = () => {
  try {
    return window.sessionStorage.getItem(ANNOUNCEMENT_KEY) === '1';
  } catch {
    return false;
  }
};

const BrandLockup = () => (
  <>
    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] p-1.5 transition-colors group-hover:border-emerald-400/30">
      <img src="/logo-crewly-mark.png" alt="" className="h-full w-full object-contain" />
    </span>
    <span className="text-[17px] font-semibold tracking-tight text-white">Crewly</span>
  </>
);

const AnnouncementBar = () => {
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);

    try {
      window.sessionStorage.setItem(ANNOUNCEMENT_KEY, '1');
    } catch {
      /* storage unavailable — the bar stays dismissed for this page view */
    }
  };

  return (
    <div className="relative overflow-hidden border-b border-white/[0.06] bg-[#050810]">
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(16,185,129,0.16),transparent_38%,rgba(139,92,246,0.18))]"
        aria-hidden="true"
      />

      <div className="relative mx-auto flex max-w-7xl items-center gap-3 px-5 py-2.5 sm:px-6 lg:px-8">
        <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-emerald-300 sm:inline-flex">
          <span className="landing-breathe h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          {ANNOUNCEMENT.badge}
        </span>

        <p className="min-w-0 flex-1 text-center text-xs leading-snug text-slate-300 sm:text-left sm:text-[13px]">
          {ANNOUNCEMENT.text}{' '}
          <a
            href={ANNOUNCEMENT.link.href}
            className={`inline-flex items-center gap-1 font-semibold text-emerald-300 underline decoration-emerald-300/30 underline-offset-2 transition-colors hover:text-emerald-200 hover:decoration-emerald-300/70 ${focusRing}`}
          >
            {ANNOUNCEMENT.link.label}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </a>
        </p>

        <button
          type="button"
          onClick={dismiss}
          aria-label={ANNOUNCEMENT.dismissLabel}
          className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200 ${focusRing}`}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

const PlatformMenu = ({ onChoose, open }) => (
  <div
    id="landing-platform-menu"
    // Kept in the DOM and hidden with the `hidden` attribute: `aria-controls`
    // must name an element that exists, and a conditional render would leave
    // the trigger pointing at nothing for most of the page's life.
    hidden={!open}
    className="absolute left-1/2 top-full z-50 mt-3 w-[min(54rem,calc(100vw-2.5rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/10 bg-[#0b1220]/97 p-2 shadow-[0_40px_80px_-40px_rgba(0,0,0,0.95)] backdrop-blur-xl"
  >
    <div className="grid gap-0.5 sm:grid-cols-2">
      {PLATFORM_TABS.map((tab) => (
        <a
          key={tab.key}
          href={`#${SECTION_IDS.platform}`}
          onClick={() => onChoose(tab.key)}
          className={`group/item flex items-start gap-3 rounded-xl p-3 transition-colors hover:bg-emerald-500/[0.07] ${focusRing}`}
        >
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-500/10 text-emerald-300 transition-colors group-hover/item:border-emerald-400/40">
            <LandingIcon name={tab.icon} className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-white">{tab.label}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-slate-400">{tab.title}</span>
          </span>
        </a>
      ))}
    </div>

    <div className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5">
      <p className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
        <Sparkles className="h-3.5 w-3.5 text-violet-300" aria-hidden="true" />
        One login, one employee record, {PLATFORM_TABS.length} product areas
      </p>
      <a
        href={`#${SECTION_IDS.modules}`}
        className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-emerald-300 transition-colors hover:bg-white/5 hover:text-emerald-200 ${focusRing}`}
      >
        Browse every module
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  </div>
);

const LandingHeader = () => {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [platformOpen, setPlatformOpen] = useState(false);
  const [mobilePlatformOpen, setMobilePlatformOpen] = useState(false);
  const platformRef = useRef(null);
  const user = useSelector((state) => state.auth?.user);
  const signedIn = Boolean(user);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Escape closes whichever surface is open — a keyboard user must not be
  // trapped by a menu they cannot see the exit from.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setPlatformOpen(false);
        setMenuOpen(false);
        setMobilePlatformOpen(false);
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!platformOpen) return undefined;

    const onPointerDown = (event) => {
      if (platformRef.current && !platformRef.current.contains(event.target)) setPlatformOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);

    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [platformOpen]);

  const closeAll = useCallback(() => {
    setMenuOpen(false);
    setPlatformOpen(false);
    setMobilePlatformOpen(false);
  }, []);

  const chooseTab = useCallback((key) => {
    setPlatformOpen(false);
    setMenuOpen(false);
    requestPlatformTab(key);
  }, []);

  return (
    <>
      <AnnouncementBar />

      <header
        className={`sticky top-0 z-50 border-b transition-[background-color,border-color,box-shadow,backdrop-filter] duration-300 ${
          scrolled || menuOpen || platformOpen
            ? 'border-white/10 bg-crewly-night/90 shadow-[0_20px_40px_-32px_rgba(0,0,0,0.95)] backdrop-blur-xl'
            : 'border-transparent bg-crewly-night/70 backdrop-blur'
        }`}
      >
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-5 sm:px-6 lg:h-[70px] lg:px-8">
          <Link
            to="/"
            className={`group flex shrink-0 items-center gap-2.5 rounded-lg ${focusRing}`}
            aria-label="Crewly home"
          >
            <BrandLockup />
          </Link>

          {/* Desktop navigation. The panel is anchored to the NAV, not to the
              "Platform" button: the nav sits mid-header, so a 54rem panel
              centred on it always fits, even at a 1024px window. */}
          <div ref={platformRef} className="relative hidden lg:block">
            <nav aria-label="Sections" className="flex items-center gap-0.5">
              {NAV_LINKS.map((link) =>
                link.opensPlatformMenu ? (
                  <button
                    key={link.href}
                    type="button"
                    onClick={() => setPlatformOpen((open) => !open)}
                    aria-expanded={platformOpen}
                    aria-controls="landing-platform-menu"
                    className={`inline-flex items-center gap-1 ${navLink}`}
                  >
                    {link.label}
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-slate-500 transition-transform ${platformOpen ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                ) : (
                  <a key={link.href} href={link.href} className={navLink}>
                    {link.label}
                  </a>
                ),
              )}
            </nav>

            <PlatformMenu onChoose={chooseTab} open={platformOpen} />
          </div>

          <div className="hidden items-center gap-1.5 lg:flex">
            {signedIn ? (
              <Link to="/app" className={primaryCta}>
                <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
                Open dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className={navLink}>
                  Sign in
                </Link>
                <Link to="/register" className={primaryCta}>
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
            className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 text-slate-200 transition-colors hover:bg-white/[0.06] lg:hidden ${focusRing}`}
          >
            {menuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>

        <div
          id="landing-mobile-menu"
          hidden={!menuOpen}
          className="max-h-[calc(100vh-4rem)] overflow-y-auto border-t border-white/10 bg-[#080d19] lg:hidden"
        >
          <nav aria-label="Sections" className="mx-auto max-w-7xl px-5 py-3 sm:px-6">
            {NAV_LINKS.filter((link) => !link.opensPlatformMenu).map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={closeAll}
                className={`block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white ${focusRing}`}
              >
                {link.label}
              </a>
            ))}

            <div className="mt-1 border-t border-white/10 pt-1">
              <button
                type="button"
                onClick={() => setMobilePlatformOpen((open) => !open)}
                aria-expanded={mobilePlatformOpen}
                aria-controls="landing-mobile-platform"
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white ${focusRing}`}
              >
                Platform
                <ChevronDown
                  className={`h-4 w-4 text-slate-500 transition-transform ${mobilePlatformOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>

              <div id="landing-mobile-platform" hidden={!mobilePlatformOpen} className="pb-1">
                {PLATFORM_TABS.map((tab) => (
                  <a
                    key={tab.key}
                    href={`#${SECTION_IDS.platform}`}
                    onClick={() => chooseTab(tab.key)}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-400 transition-colors hover:bg-emerald-500/[0.08] hover:text-emerald-200 ${focusRing}`}
                  >
                    <LandingIcon name={tab.icon} className="h-4 w-4 text-emerald-400" />
                    {tab.label}
                  </a>
                ))}
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3">
              {signedIn ? (
                <Link to="/app" onClick={closeAll} className={`${primaryCta} justify-center`}>
                  Open dashboard
                </Link>
              ) : (
                <>
                  <Link
                    to="/login"
                    onClick={closeAll}
                    className={`rounded-xl border border-white/15 px-4 py-2.5 text-center text-sm font-semibold text-slate-100 transition-colors hover:bg-white/[0.06] ${focusRing}`}
                  >
                    Sign in
                  </Link>
                  <Link to="/register" onClick={closeAll} className={`${primaryCta} justify-center`}>
                    Start free
                  </Link>
                </>
              )}
            </div>
          </nav>
        </div>
      </header>
    </>
  );
};

export default LandingHeader;
