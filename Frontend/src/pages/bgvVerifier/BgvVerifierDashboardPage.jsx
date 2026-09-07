import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Inbox, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import bgvVerifierAuthService from '../../services/bgvVerifierAuthService.js';

// Phase 30.6 — authenticated verifier landing. Shows identity +
// specializations only; NO candidate lists, NO documents, NO assignments
// (those begin in 30.7). No tenant or platform navigation here.
const BgvVerifierDashboardPage = () => {
  const [verifier, setVerifier] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await bgvVerifierAuthService.me();
      setVerifier(result.verifier || result);
    } catch {
      bgvVerifierAuthService.clearToken();
      window.location.assign('/bgv-verifier/login');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = 'Crewly BGV Operations';
    load();
  }, [load]);

  const logout = async () => {
    setBusy(true);
    try {
      await bgvVerifierAuthService.logout();
    } catch {
      // session may already be gone — local cleanup still required
    }
    bgvVerifierAuthService.clearToken();
    window.location.assign('/bgv-verifier/login');
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-crewly-bg text-crewly-dim">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading Crewly BGV Operations…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-crewly-bg">
      <header className="border-b border-crewly-border bg-crewly-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-crewly-green/10 text-crewly-green">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-black text-crewly-text">
                Crewly <span className="text-crewly-green">BGV Operations</span>
              </p>
              <p className="text-[11px] text-crewly-dim">Internal verification portal · Infolexus</p>
            </div>
          </div>
          <button type="button" onClick={logout} disabled={busy} className="btn-ghost gap-2 !px-4 !py-2 text-sm">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />} Logout
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
        <section className="card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-crewly-text">{verifier?.name || 'Verifier'}</h1>
              <p className="text-xs text-crewly-dim">{verifier?.email || ''}</p>
            </div>
            <span className="badge bg-crewly-green/10 text-crewly-green">
              {String(verifier?.status || '').replaceAll('_', ' ')}
            </span>
          </div>
          <div className="mt-4">
            <p className="text-xs font-semibold text-crewly-dim">Specializations</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(verifier?.specializations || []).map((specialization) => (
                <span key={specialization} className="inline-flex items-center gap-1 rounded-full border border-crewly-border bg-crewly-bg/60 px-3 py-1 text-xs text-crewly-text">
                  <BadgeCheck className="h-3.5 w-3.5 text-crewly-green" /> {specialization}
                </span>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-crewly-dim">
              Specializations mark eligibility for future work types only — they do not grant access to any candidate record.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-crewly-border/40 text-crewly-dim">
              <Inbox className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-semibold text-crewly-text">No verification work is assigned yet.</h2>
              <p className="text-xs text-crewly-dim">
                Case assignment and evidence review arrive with the verification workbench phase. Until then, nothing candidate-related is visible here.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default BgvVerifierDashboardPage;
