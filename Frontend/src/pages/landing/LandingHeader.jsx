// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — ANNOUNCEMENT BAR + HEADER
//
//   · the announcement bar is a real fact (the AI assistant and its language
//     list ship today) and it can be dismissed, once, for the session
//   · the header is sticky, paper-white with a hairline, and gains a shadow
//     only after the page scrolls
//   · "Platform" is a real disclosure: aria-expanded, a labelled panel, closes
//     on Escape, on outside click and on choosing an item
//   · every menu item is an `<a href="#platform">`, so the menu still works if
//     the event that selects the tab never fires
//   · the CTA knows who is looking: a signed-in visitor gets "Open dashboard"
//     instead of a "Sign in" button they would bounce off
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { ArrowRight, ChevronDown, LayoutDashboard, Menu, Sparkles, X } from 'lucide-react';
import { ANNOUNCEMENT, NAV_LINKS, PLATFORM_TABS, SECTION_IDS } from './landingData.js';
import LandingIcon from './LandingIcon.jsx';
import { requestPlatformTab } from './landingTabs.js';

const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700';

const primaryCta =
  'group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-violet-700 to-[#4c1d95] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_10px_24px_-12px_rgba(76,29,149,0.9)] transition-[color,background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:from-violet-600 hover:to-violet-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700';

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
    <div className="relative bg-[#171233] text-white">
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(109,40,217,0.55),transparent_45%,rgba(15,157,118,0.35))]"
        aria-hidden="true"
      />

      <div className="relative mx-auto flex max-w-7xl items-center justify-center gap-3 px-5 py-2.5 text-center sm:px-6 lg:px-8">
        <span className="hidden shrink-0 rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white sm:inline">
          {ANNOUNCEMENT.badge}
        </span>
        <p className="min-w-0 text-xs leading-snug text-white/85 sm:text-[13px]">
          {ANNOUNCEMENT.text}{' '}
          <a
            href={ANNOUNCEMENT.link.href}
            className={`inline-flex items-center gap-1 font-semibold text-white underline decoration-white/40 underline-offset-2 transition-colors hover:decoration-white ${focusRing}`}
          >
            {ANNOUNCEMENT.link.label}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </a>
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={ANNOUNCEMENT.dismissLabel}
          className={`ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white ${focusRing}`}
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
    className="absolute left-1/2 top-full z-50 mt-3 w-[min(56rem,calc(100vw-2.5rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_30px_70px_-30px_rgba(23,18,51,0.45)]"
  >
    <div className="grid gap-1 sm:grid-cols-2">
      {PLATFORM_TABS.map((tab) => (
        <a
          key={tab.key}
          href={`#${SECTION_IDS.platform}`}
          onClick={() => onChoose(tab.key)}
          className={`flex items-start gap-3 rounded-xl p-3 transition-colors hover:bg-violet-50/80 ${focusRing}`}
        >
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700">
            <LandingIcon name={tab.icon} className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[#171233]">{tab.label}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{tab.title}</span>
          </span>
        </a>
      ))}
    </div>

    <div className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5">
      <p className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
        <Sparkles className="h-3.5 w-3.5 text-violet-600" aria-hidden="true" />
        One login, one employee record, {PLATFORM_TABS.length} product areas
      </p>
      <a
        href={`#${SECTION_IDS.modules}`}
        className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-violet-700 hover:bg-white ${focusRing}`}
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
        className={`sticky top-0 z-50 border-b transition-[color,background-color,border-color,box-shadow,transform] duration-300 ${
          scrolled || menuOpen || platformOpen
            ? 'border-slate-200/80 bg-white/90 shadow-[0_18px_40px_-32px_rgba(23,18,51,0.6)] backdrop-blur-xl'
            : 'border-transparent bg-white/70 backdrop-blur'
        }`}
      >
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-5 sm:px-6 lg:h-[70px] lg:px-8">
          <Link
            to="/"
            className={`group flex shrink-0 items-center rounded-lg ${focusRing}`}
            aria-label="Crewly home"
          >
            <img
              src="/logo-crewly-wordmark.png"
              alt=""
              className="landing-wordmark"
              width="603"
              height="233"
            />
          </Link>

          {/* Desktop navigation. The panel is anchored to the NAV, not to the
              "Platform" button: the nav sits in the middle of the header, so a
              56rem panel centred on it always fits, even at a 1024px window. */}
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
                    className={`inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-[#171233] ${focusRing}`}
                  >
                    {link.label}
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-slate-400 transition-transform ${platformOpen ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                ) : (
                  <a
                    key={link.href}
                    href={link.href}
                    className={`rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-[#171233] ${focusRing}`}
                  >
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
                <Link
                  to="/login"
                  className={`rounded-xl px-3.5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-[#171233] ${focusRing}`}
                >
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
            className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-700 transition-colors hover:bg-slate-100 lg:hidden ${focusRing}`}
          >
            {menuOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>

        <div
          id="landing-mobile-menu"
          hidden={!menuOpen}
          className="max-h-[calc(100vh-4rem)] overflow-y-auto border-t border-slate-200/80 bg-white lg:hidden"
        >
            <nav aria-label="Sections" className="mx-auto max-w-7xl px-5 py-3 sm:px-6">
              {NAV_LINKS.filter((link) => !link.opensPlatformMenu).map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={closeAll}
                  className={`block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-[#171233] ${focusRing}`}
                >
                  {link.label}
                </a>
              ))}

              <div className="mt-1 border-t border-slate-200/80 pt-1">
                <button
                  type="button"
                  onClick={() => setMobilePlatformOpen((open) => !open)}
                  aria-expanded={mobilePlatformOpen}
                  aria-controls="landing-mobile-platform"
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-[#171233] ${focusRing}`}
                >
                  Platform
                  <ChevronDown
                    className={`h-4 w-4 text-slate-400 transition-transform ${mobilePlatformOpen ? 'rotate-180' : ''}`}
                    aria-hidden="true"
                  />
                </button>

                <div id="landing-mobile-platform" hidden={!mobilePlatformOpen} className="pb-1">
                  {PLATFORM_TABS.map((tab) => (
                    <a
                      key={tab.key}
                      href={`#${SECTION_IDS.platform}`}
                      onClick={() => chooseTab(tab.key)}
                      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-violet-50 hover:text-violet-800 ${focusRing}`}
                    >
                      <LandingIcon name={tab.icon} className="h-4 w-4 text-violet-600" />
                      {tab.label}
                    </a>
                  ))}
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-2 border-t border-slate-200/80 pt-3">
                {signedIn ? (
                  <Link to="/app" onClick={closeAll} className={`${primaryCta} justify-center`}>
                    Open dashboard
                  </Link>
                ) : (
                  <>
                    <Link
                      to="/login"
                      onClick={closeAll}
                      className={`rounded-xl border border-slate-200 px-4 py-2.5 text-center text-sm font-semibold text-[#171233] transition-colors hover:bg-slate-50 ${focusRing}`}
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
