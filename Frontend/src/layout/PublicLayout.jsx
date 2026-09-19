import { Outlet, Link } from 'react-router-dom';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';

const PublicLayout = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-crewly-border bg-crewly-bg/95 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
        <Link to="/" className="shrink-0 text-lg sm:text-xl font-extrabold tracking-wide text-crewly-green">
          Crewly <span className="text-crewly-orange">HRMS</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-2 sm:gap-3 md:flex">
          <Link to="/login" className="btn-ghost px-4 py-2 text-sm">Sign In</Link>
          <Link to="/register" className="btn-primary px-4 py-2 text-sm sm:px-5">Register Company</Link>
        </nav>

        {/* Mobile hamburger */}
        <button
          type="button"
          onClick={() => setMobileOpen(v => !v)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-crewly-border text-crewly-text md:hidden"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="sticky top-[57px] z-20 border-b border-crewly-border bg-crewly-card p-4 md:hidden">
          <div className="flex flex-col gap-2">
            <Link to="/login" onClick={() => setMobileOpen(false)} className="btn-ghost w-full justify-center">Sign In</Link>
            <Link to="/register" onClick={() => setMobileOpen(false)} className="btn-primary w-full justify-center">Register Company</Link>
          </div>
        </div>
      )}

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-crewly-border px-4 py-4 text-center text-xs sm:text-sm text-crewly-dim sm:px-6 lg:px-8">
        © {new Date().getFullYear()} Crewly HRMS. All rights reserved.
      </footer>
    </div>
  );
};

export default PublicLayout;
