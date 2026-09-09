import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ClipboardList, Inbox, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import bgvVerifierAuthService from '../../services/bgvVerifierAuthService.js';

// Phase 30.7 — "My Verification Work". Only checks CURRENTLY assigned to
// the authenticated verifier appear (identity comes from the session; the
// backend never accepts a client-supplied verifierId). Safe summary only:
// no evidence, no identifiers, no payment data in the list.
const BgvVerifierWorkPage = () => {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await bgvVerifierAuthService.work();
      setRows(result.rows || []);
    } catch (requestError) {
      if (requestError?.status === 401 || requestError?.status === 403) {
        bgvVerifierAuthService.clearToken();
        window.location.assign('/bgv-verifier/login');
        return;
      }
      setError(requestError?.message || 'Could not load your work queue');
    }
  }, []);

  useEffect(() => {
    document.title = 'My Verification Work — Crewly BGV Operations';
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
                My <span className="text-crewly-green">Verification Work</span>
              </p>
              <p className="text-[11px] text-crewly-dim">Internal verification portal · Infolexus</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/bgv-verifier" className="btn-ghost gap-2 !px-4 !py-2 text-sm">
              <ArrowLeft className="h-4 w-4" /> Profile
            </Link>
            <button type="button" onClick={logout} disabled={busy} className="btn-ghost gap-2 !px-4 !py-2 text-sm">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />} Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 px-4 py-8">
        {error ? <div className="card border-rose-500/40 text-sm text-rose-300">{error}</div> : null}

        {rows === null && !error ? (
          <div className="card flex items-center gap-2 text-sm text-crewly-dim">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your assignments…
          </div>
        ) : null}

        {rows && rows.length === 0 ? (
          <div className="card text-center">
            <Inbox className="mx-auto h-8 w-8 text-crewly-dim" />
            <p className="mt-3 text-sm font-semibold text-crewly-text">No assigned checks yet</p>
            <p className="mt-1 text-xs text-crewly-dim">
              Checks assigned to you by the Crewly BGV operations team will appear here.
            </p>
          </div>
        ) : null}

        {(rows || []).map((row) => (
          <Link
            key={`${row.orderId}-${row.checkType}`}
            to={`/bgv-verifier/work/${row.orderId}/${row.checkType}`}
            className="card block transition hover:border-crewly-green/40"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-crewly-green/10 text-crewly-green">
                  <ClipboardList className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-crewly-text">
                    {row.checkType} <span className="text-crewly-dim">·</span> {row.candidateName}
                  </p>
                  <p className="text-[11px] text-crewly-dim">
                    {row.companyName} · {row.orderCode} · Assigned {new Date(row.assignedAt).toLocaleDateString()}
                    {row.submittedAt ? ` · Candidate submitted ${new Date(row.submittedAt).toLocaleDateString()}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {row.qaStatus === 'APPROVED' ? (
                  <span className="badge bg-crewly-green/10 text-crewly-green">QA APPROVED</span>
                ) : row.qaStatus === 'RETURNED' ? (
                  <span className="badge bg-amber-500/10 text-amber-300">QA RETURNED</span>
                ) : row.workState === 'SUBMITTED' ? (
                  <span className="badge bg-sky-500/10 text-sky-300">AWAITING QA</span>
                ) : (
                  <span
                    className={`badge ${row.status === 'IN_PROGRESS' ? 'bg-amber-500/10 text-amber-300' : 'bg-crewly-green/10 text-crewly-green'}`}
                  >
                    {row.status.replaceAll('_', ' ')}
                  </span>
                )}
                <ArrowUpRight className="h-4 w-4 text-crewly-dim" />
              </div>
            </div>
          </Link>
        ))}
      </main>
    </div>
  );
};

export default BgvVerifierWorkPage;
