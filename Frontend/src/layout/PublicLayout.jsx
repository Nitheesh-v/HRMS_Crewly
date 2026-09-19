import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Menu, X, ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle.jsx';
import useTheme from '../hooks/useTheme.js';

const NAV_LINKS = [
  { label: 'Features', href: '#features' },
  { label: 'Solutions', href: '#solutions' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'Resources', href: '#faq' },
];

const PublicLayout = () => {
  useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const isLanding = location.pathname === '/';

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const handleNavClick = (e, href) => {
    if (!isLanding) {
      e.preventDefault();
      navigate(`/${href}`);
      setTimeout(() => {
        document.querySelector(href)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
      return;
    }
    e.preventDefault();
    document.querySelector(href)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setMobileOpen(false);
  };

  return (
    <div className="flex min-h-screen flex-col bg-crewly-bg text-crewly-text">
      <div className="relative z-40 flex items-center justify-center gap-2 bg-gradient-to-r from-crewly-green to-emerald-600 px-4 py-2 text-center text-xs font-semibold text-white sm:gap-3 sm:px-6 sm:text-[13px]">
        <span className="hidden items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-bold tracking-wide sm:inline-flex">
          <Sparkles className="h-3 w-3" /> NEW
        </span>
        <span className="truncate">AI-powered Recruitment + Geofenced Attendance now live — trusted by 10,000+ teams</span>
        <Link to="/register" className="hidden shrink-0 items-center gap-1 rounded-full bg-white px-3 py-1 text-xs font-bold text-crewly-green transition hover:bg-white/90 sm:inline-flex">
          Start free <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <header className={`sticky top-0 z-30 border-b backdrop-blur-xl transition ${scrolled ? 'border-crewly-border bg-crewly-bg/80 shadow-sm' : 'border-transparent bg-crewly-bg/60'}`}>
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8">
          <Link to="/" className="flex shrink-0 items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-crewly-green font-black text-white sm:h-9 sm:w-9">
              C
            </div>
            <span className="text-lg font-extrabold tracking-tight sm:text-xl">
              Crewly <span className="font-black text-crewly-orange">HRMS</span>
            </span>
            <span className="hidden rounded-full border border-crewly-border bg-crewly-card px-2 py-0.5 text-[10px] font-bold tracking-widest text-crewly-dim sm:inline-block">
              SAAS
            </span>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex">
            {NAV_LINKS.map((l) => (
              <a key={l.label} href={l.href} onClick={(e) => handleNavClick(e, l.href)} className="rounded-full px-3.5 py-2 text-sm font-medium text-crewly-dim transition hover:bg-crewly-card hover:text-crewly-text">
                {l.label}
              </a>
            ))}
            <Link to="/careers/acme" className="rounded-full px-3.5 py-2 text-sm font-medium text-crewly-dim transition hover:bg-crewly-card hover:text-crewly-text">
              Careers
            </Link>
          </nav>

          <div className="hidden items-center gap-2 lg:flex">
            <ThemeToggle />
            <Link to="/login" className="rounded-full px-4 py-2 text-sm font-semibold text-crewly-text transition hover:bg-crewly-card">
              Sign in
            </Link>
            <Link to="/register" className="inline-flex items-center gap-1.5 rounded-full bg-crewly-green px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-crewly-green/20 transition hover:bg-[#0e9f6e] hover:shadow-xl active:scale-[0.98]">
              Start free trial <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="flex items-center gap-2 lg:hidden">
            <ThemeToggle />
            <Link to="/register" className="inline-flex items-center gap-1 rounded-full bg-crewly-green px-4 py-2 text-xs font-bold text-white">
              Try free
            </Link>
            <button type="button" onClick={() => setMobileOpen((v) => !v)} className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-crewly-border bg-crewly-card text-crewly-text transition hover:border-crewly-green/30" aria-label={mobileOpen ? 'Close menu' : 'Open menu'} aria-expanded={mobileOpen}>
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="border-t border-crewly-border bg-crewly-card/95 px-4 py-4 backdrop-blur-xl lg:hidden">
            <nav className="flex flex-col gap-1">
              {NAV_LINKS.map((l) => (
                <a key={l.label} href={l.href} onClick={(e) => handleNavClick(e, l.href)} className="rounded-xl px-3 py-3 text-sm font-medium text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text">
                  {l.label}
                </a>
              ))}
              <a href="/careers/acme" className="rounded-xl px-3 py-3 text-sm font-medium text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text">
                Careers
              </a>
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-crewly-border pt-4">
                <Link to="/login" onClick={() => setMobileOpen(false)} className="btn-ghost w-full justify-center rounded-full">
                  Sign In
                </Link>
                <Link to="/register" onClick={() => setMobileOpen(false)} className="btn-primary w-full justify-center rounded-full">
                  Register
                </Link>
              </div>
              <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[11px] text-crewly-dim">
                <ShieldCheck className="h-3.5 w-3.5 text-crewly-green" /> SOC 2 · GDPR · 99.9% uptime
              </p>
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-crewly-border bg-[#0a0e13] text-crewly-dim dark:bg-[#0a0e13] light:bg-white light:text-gray-500">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
            <div className="sm:col-span-2 lg:col-span-2">
              <Link to="/" className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-crewly-green font-black text-white">
                  C
                </div>
                <span className="text-lg font-extrabold tracking-tight text-white">
                  Crewly <span className="text-crewly-orange">HRMS</span>
                </span>
              </Link>
              <p className="mt-3 max-w-sm text-sm leading-relaxed">The modern, multi-tenant HRMS for ambitious teams. Attendance, Payroll, Recruitment, Performance & more — in one beautifully fast workspace.</p>
              <div className="mt-5 flex items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-crewly-green/10 px-2.5 py-1 font-semibold text-crewly-green ring-1 ring-crewly-green/20">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-crewly-green" /> All systems operational
                </span>
                <span className="text-crewly-dim">· 14-day free trial</span>
              </div>
            </div>
            <div>
              <h4 className="mb-3 text-sm font-bold tracking-wide text-white">Product</h4>
              <ul className="space-y-2.5 text-sm">
                {[
                  ['Features', '#features'],
                  ['Attendance & Geofence', '#solutions'],
                  ['Payroll & Compliance', '#solutions'],
                  ['Recruitment ATS', '#solutions'],
                  ['Pricing', '#pricing'],
                  ['Security', '#faq'],
                ].map(([label, href]) => (
                  <li key={label}>
                    <a href={href} className="hover:text-white hover:underline">
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-3 text-sm font-bold tracking-wide text-white">Company</h4>
              <ul className="space-y-2.5 text-sm">
                {[
                  ['About Crewly', '/'],
                  ['Careers', '/careers/acme'],
                  ['Customers', '#solutions'],
                  ['Contact', '/register'],
                ].map(([label, href]) => (
                  <li key={label}>
                    <a href={href} className="hover:text-white hover:underline">
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-3 text-sm font-bold tracking-wide text-white">Resources</h4>
              <ul className="space-y-2.5 text-sm">
                {[
                  ['Help Center', '/login'],
                  ['API Docs', '/login'],
                  ['Status', '/login'],
                  ['Privacy & Terms', '/login'],
                ].map(([label, href]) => (
                  <li key={label}>
                    <Link to={href} className="hover:text-white hover:underline">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-crewly-border pt-6 text-xs sm:flex-row">
            <p>© {new Date().getFullYear()} Crewly HRMS · Built for scale in Chennai, for teams worldwide.</p>
            <div className="flex items-center gap-3">
              <span className="hidden items-center gap-1.5 sm:inline-flex">
                <ShieldCheck className="h-4 w-4 text-crewly-green" /> Enterprise-grade · Multi-tenant · Audit-logged
              </span>
              <span className="inline-flex gap-2">
                <a href="#" className="hover:text-white">
                  X
                </a>
                <span>·</span>
                <a href="#" className="hover:text-white">
                  LinkedIn
                </a>
                <span>·</span>
                <a href="#" className="hover:text-white">
                  GitHub
                </a>
              </span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default PublicLayout;
