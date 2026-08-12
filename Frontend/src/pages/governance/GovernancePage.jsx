import { useCallback, useEffect, useState } from 'react';
import systemService from '../../services/systemService';
import { ROLES, roleLabel } from '../../utils/roles';

const ROLE_COLS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE];
const fmtDT = (d) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function GovernancePage() {
  const [tab, setTab] = useState('audit');

  // audit state
  const [logs, setLogs] = useState([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  // matrix state
  const [matrix, setMatrix] = useState([]);
  const [error, setError] = useState('');

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 15 };
      if (search) params.search = search;
      if (status) params.status = status;
      const res = await systemService.audit(params);
      setLogs(res?.data || []);
      setMeta(res?.meta || { page: 1, pages: 1, total: 0 });
    } catch (err) {
      setError(err?.response?.data?.message || err.message);
    } finally { setLoading(false); }
  }, [page, search, status]);

  useEffect(() => { if (tab === 'audit') loadLogs(); }, [tab, loadLogs]);
  useEffect(() => {
    if (tab === 'matrix') {
      (async () => {
        try {
          const res = await systemService.permissions();
          setMatrix(res?.data || (Array.isArray(res) ? res : []));
        } catch (err) { setError(err?.response?.data?.message || err.message); }
      })();
    }
  }, [tab]);

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold">🛡️ Governance</h1>
        <p className="text-sm text-crewly-dim">Who did what, when — and what every role is allowed to do.</p>
      </div>

      {error && <div className="card px-4 py-3 text-sm text-crewly-red">{error}</div>}

      <div className="flex gap-2">
        {[['audit', '📜 Audit Logs'], ['matrix', '🔐 Role Permissions']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`rounded-lg px-4 py-2 text-sm transition ${tab === key ? 'bg-crewly-green/15 text-crewly-green' : 'border border-crewly-border text-crewly-dim hover:text-crewly-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── audit tab ── */}
      {tab === 'audit' && (
        <>
          <div className="card flex flex-wrap gap-3 p-4">
            <input className="input flex-1 min-w-[200px]" placeholder="Search actor or action…"
              value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} />
            <select className="input" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
              <option value="">All results</option>
              <option value="success">✅ Success only</option>
              <option value="failed">❌ Failed only</option>
            </select>
          </div>

          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-crewly-dim">
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Actor</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Result</th>
                  <th className="px-4 py-3">Path</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-crewly-dim">Loading…</td></tr>
                ) : logs.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-crewly-dim">No activity yet — do something (create a user, run payroll) and come back!</td></tr>
                ) : logs.map((l) => (
                  <tr key={l._id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="px-4 py-3 text-xs text-crewly-dim whitespace-nowrap">{fmtDT(l.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{l.actorName}</div>
                      <div className="text-[11px] text-crewly-dim">{l.actorRole ? roleLabel(l.actorRole) : ''}</div>
                    </td>
                    <td className="px-4 py-3">{l.action}</td>
                    <td className="px-4 py-3">
                      <span className={`badge ${l.statusCode < 400 ? 'text-crewly-green' : 'text-crewly-red'}`}>{l.statusCode}</span>
                    </td>
                    <td className="px-4 py-3 text-[11px] font-mono text-crewly-dim">{l.method} {l.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-crewly-dim">
            <span>Page {meta.page} of {meta.pages} · {meta.total} events</span>
            <div className="space-x-2">
              <button className="btn-ghost" disabled={meta.page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
              <button className="btn-ghost" disabled={meta.page >= meta.pages} onClick={() => setPage((p) => p + 1)}>Next →</button>
            </div>
          </div>
        </>
      )}

      {/* ── matrix tab ── */}
      {tab === 'matrix' && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-crewly-border text-crewly-dim">
                <th className="px-4 py-3">Feature</th>
                {ROLE_COLS.map((r) => <th key={r} className="px-4 py-3 text-center">{roleLabel(r)}</th>)}
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.feature} className="border-b border-crewly-border/50 last:border-0">
                  <td className="px-4 py-3">{row.feature}</td>
                  {ROLE_COLS.map((r) => (
                    <td key={r} className="px-4 py-3 text-center">
                      {row.roles.includes(r) ? '✅' : <span className="text-crewly-dim">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-crewly-dim">
            Super Admin operates the separate /admin portal. This matrix mirrors real backend enforcement (read-only view).
          </p>
        </div>
      )}
    </div>
  );
}