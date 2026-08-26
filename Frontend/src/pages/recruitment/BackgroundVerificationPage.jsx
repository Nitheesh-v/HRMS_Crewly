/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import bgvService from '../../services/bgvService.js';

const StatusPill = ({ status }) => (
  <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
    {String(status || '').replaceAll('_', ' ')}
  </span>
);

const BackgroundVerificationPage = () => {
  const { hasPermission } = usePermission();
  const canRead = hasPermission('BACKGROUND_VERIFICATION_READ');
  const canSettings = hasPermission('BACKGROUND_VERIFICATION_SETTINGS_READ');
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ kpis: {} });
  const [filters, setFilters] = useState({ status: '', search: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const result = await bgvService.list({
        status: filters.status || undefined,
        search: filters.search || undefined,
      });
      setRows(result.cases || []);
      setMeta(result.meta || {});
    } catch (requestError) {
      setError(requestError.message || 'BGV cases could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [canRead, filters]);

  useEffect(() => {
    load();
  }, [load]);

  if (!canRead) {
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-6 text-amber-100">
        You need BACKGROUND_VERIFICATION_READ. Restart backend after pull and log out/in.
      </div>
    );
  }

  const kpis = [
    ['Not started', meta.kpis?.notStarted],
    ['In progress', meta.kpis?.inProgress],
    ['Awaiting candidate', meta.kpis?.awaitingCandidate],
    ['Awaiting verifier', meta.kpis?.awaitingVerifier],
    ['Review required', meta.kpis?.reviewRequired],
    ['Completed', meta.kpis?.completed],
    ['Discrepancies', meta.kpis?.discrepancies],
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-indigo-300">
            <ShieldCheck className="h-5 w-5" />
            <p className="text-xs font-semibold uppercase tracking-[0.2em]">Recruitment</p>
          </div>
          <h1 className="mt-2 text-2xl font-bold text-slate-100">Background verification</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Human-controlled verification. Discrepancies never auto-reject candidates.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSettings ? (
            <Link to="/app/recruitment/background-verification/settings" className="btn-ghost">
              Settings
            </Link>
          ) : null}
          <button type="button" className="btn-ghost gap-2" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold text-slate-100">{Number(value) || 0}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-col gap-3 lg:flex-row">
          <input
            className="input flex-1"
            placeholder="Search case, candidate, job"
            value={filters.search}
            onChange={(event) =>
              setFilters((current) => ({ ...current, search: event.target.value }))
            }
          />
          <select
            className="input lg:w-56"
            value={filters.status}
            onChange={(event) =>
              setFilters((current) => ({ ...current, status: event.target.value }))
            }
          >
            <option value="">All statuses</option>
            {[
              'NOT_STARTED',
              'IN_PROGRESS',
              'AWAITING_CANDIDATE',
              'AWAITING_VERIFIER',
              'REVIEW_REQUIRED',
              'COMPLETED',
              'CANCELLED',
            ].map((status) => (
              <option key={status} value={status}>
                {status.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>
      </section>

      {error ? (
        <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-800 bg-slate-950/60 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Case</th>
                <th className="px-4 py-3">Candidate</th>
                <th className="px-4 py-3">Job</th>
                <th className="px-4 py-3">Checks</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="6" className="px-4 py-10 text-center text-slate-500">
                    Loading BGV cases...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan="6" className="px-4 py-10 text-center text-slate-500">
                    No background verification cases yet. Start from a candidate detail page.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="border-t border-slate-800/80">
                    <td className="px-4 py-3 font-mono text-xs text-indigo-300">
                      {row.caseCode}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-100">{row.candidateName}</p>
                      <p className="text-xs text-slate-500">{row.candidateCode}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{row.jobTitle || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">
                      {row.verifiedRequiredCount || 0}/{row.requiredCheckCount || 0}
                      {row.discrepancyCount ? (
                        <span className="mt-1 block text-xs text-amber-300">
                          {row.discrepancyCount} discrepancy
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={row.status} />
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/app/recruitment/background-verification/${row.id}`}
                        className="btn-ghost"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default BackgroundVerificationPage;
