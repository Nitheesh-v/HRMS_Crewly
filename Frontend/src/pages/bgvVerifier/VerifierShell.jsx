import { ShieldCheck } from 'lucide-react';

// Phase 30.6 — dedicated "Crewly BGV Operations" shell. Visually distinct
// from tenant HRMS and Super Admin; no tenant navigation, no HR menus.
const VerifierShell = ({ title, subtitle, children }) => (
  <div className="flex min-h-screen items-center justify-center bg-crewly-bg px-4 py-10">
    <div className="w-full max-w-md">
      <div className="mb-6 text-center">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-crewly-green/10 text-crewly-green">
          <ShieldCheck className="h-6 w-6" />
        </span>
        <h1 className="mt-3 text-xl font-black text-crewly-text">
          Crewly <span className="text-crewly-green">BGV Operations</span>
        </h1>
        <p className="mt-1 text-xs text-crewly-dim">
          Internal background verification portal · operated by Infolexus
        </p>
      </div>
      <div className="card">
        <h2 className="font-semibold text-crewly-text">{title}</h2>
        {subtitle ? <p className="mt-1 text-xs text-crewly-dim">{subtitle}</p> : null}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  </div>
);

export default VerifierShell;
