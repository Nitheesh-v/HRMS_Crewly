import { ClipboardList, ShieldCheck } from 'lucide-react';
import { Outlet } from 'react-router-dom';

const CandidatePreOnboardingPublicLayout = () => (
  <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
    <header className="border-b border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-indigo-500/10 p-2 text-indigo-300">
            <ClipboardList className="h-5 w-5" />
          </span>
          <div>
            <p className="font-semibold">Crewly Pre-Onboarding</p>
            <p className="text-xs text-slate-500">Private candidate document portal</p>
          </div>
        </div>
        <div className="hidden items-center gap-2 text-xs text-slate-400 sm:flex">
          <ShieldCheck className="h-4 w-4 text-indigo-300" />
          Token-authorized access
        </div>
      </div>
    </header>
    <main className="flex-1">
      <Outlet />
    </main>
    <footer className="border-t border-slate-800 px-5 py-6 text-center text-xs text-slate-500">
      This private portal is intended only for the named candidate. Do not forward its URL.
    </footer>
  </div>
);

export default CandidatePreOnboardingPublicLayout;
