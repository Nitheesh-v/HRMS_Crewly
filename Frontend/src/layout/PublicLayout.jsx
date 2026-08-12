import { Outlet, Link } from 'react-router-dom';

const PublicLayout = () => {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-crewly-border px-8 py-4">
        <Link to="/" className="text-xl font-extrabold tracking-wide text-crewly-green">
          Crewly <span className="text-crewly-orange">HRMS</span>
        </Link>
        <nav className="flex items-center gap-3">
          <Link to="/login" className="btn-ghost text-sm">Sign In</Link>
          <Link to="/register" className="btn-primary text-sm">Register Company</Link>
        </nav>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-crewly-border py-4 text-center text-sm text-crewly-dim">
        © {new Date().getFullYear()} Crewly HRMS. All rights reserved.
      </footer>
    </div>
  );
};

export default PublicLayout;