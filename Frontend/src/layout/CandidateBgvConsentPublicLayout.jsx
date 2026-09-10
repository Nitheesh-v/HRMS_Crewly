import { ShieldCheck, UserCheck } from 'lucide-react';
import { Outlet } from 'react-router-dom';

const CandidateBgvConsentPublicLayout = () => (
  <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
    <header className="border-b border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-teal-500/10 p-2 text-teal-300">
            <UserCheck className="h-5 w-5" />
          </span>
          <div>
            <p className="font-semibold">Crewly Background Verification</p>
            <p className="text-xs text-slate-500">Private candidate consent portal</p>
          </div>
        </div>
        <div className="hidden items-center gap-2 text-xs text-slate-400 sm:flex">
          <ShieldCheck className="h-4 w-4 text-teal-300" /> Token-authorized access
        </div>
      </div>
    </header>
    <main className="flex-1">
      <Outlet />
    </main>
    <footer className="border-t border-slate-800 px-5 py-6 text-center text-xs text-slate-500">
      This private portal is intended only for the named candidate. Opening the
      link does not record consent — you choose explicitly on the page.
    </footer>
  </div>
);

export default CandidateBgvConsentPublicLayout;
