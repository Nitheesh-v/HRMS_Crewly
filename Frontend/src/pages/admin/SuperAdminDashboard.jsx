// ============================================================
// 👑 SUPER ADMIN DASHBOARD — live platform control center
// Standalone page (no tenant sidebar) — super admin has no company.
// Data: GET /admin-api/overview + /companies + /revenue
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useAuth from '../../hooks/useAuth.jsx';
import adminService from '../../services/adminService';

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const errMsg = (err, fallback) =>
  err?.response?.data?.message || err?.data?.message || err?.message || fallback;

const PLAN_STYLES = {
  TRIAL: 'bg-gray-500/15 text-gray-400',
  BASIC: 'bg-blue-500/15 text-blue-400',
  PRO: 'bg-crewly-green/15 text-crewly-green',
  ENTERPRISE: 'bg-purple-500/15 text-purple-400',
};

const SUB_STYLES = {
  ACTIVE: 'bg-crewly-green/15 text-crewly-green',
  EXPIRING_SOON: 'bg-crewly-orange/15 text-crewly-orange',
  EXPIRED: 'bg-crewly-red/15 text-crewly-red',
};

const StatCard = ({ icon, label, value, accent = 'text-crewly-text' }) => (
  <div className="card">
    <div className="text-2xl">{icon}</div>
    <p className="mt-2 text-xs uppercase tracking-wide text-crewly-dim">{label}</p>
    <p className={`mt-1 text-2xl font-extrabold ${accent}`}>{value}</p>
  </div>
);

const SuperAdminDashboard = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [overview, setOverview] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [revenue, setRevenue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const [ov, comps, rev] = await Promise.all([
        adminService.overview(),
        adminService.companies(),
        adminService.revenue(),
      ]);
      setOverview(ov || {});
      setCompanies(Array.isArray(comps) ? comps : comps?.companies || []);
      setRevenue(Array.isArray(rev) ? rev : rev?.months || []);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(errMsg(err, 'Failed to load platform data'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleStatus = async (c) => {
    const next = c.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
    const ok = window.confirm(
      `${next === 'SUSPENDED' ? '⛔ Suspend' : '✅ Activate'} ${c.name}?\n\n` +
      (next === 'SUSPENDED'
        ? 'Every user of this company will be blocked from logging in.'
        : 'Users of this company will be able to log in again.')
    );
    if (!ok) return;
    setBusyId(c.id);
    setError('');
    try {
      await adminService.setCompanyStatus(c.id, next);
      await load(true);
    } catch (err) {
      setError(errMsg(err, 'Status update failed'));
    } finally {
      setBusyId(null);
    }
  };

  const maxRev = Math.max(1, ...revenue.map((r) => r.total || 0));
  const totalRev = revenue.reduce((s, r) => s + (r.total || 0), 0);

  const daysLeftLabel = (d) => {
    if (d === null || d === undefined) return <span className="text-crewly-dim">—</span>;
    if (d < 0) return <span className="font-semibold text-crewly-red">Expired</span>;
    if (d <= 3) return <span className="font-semibold text-crewly-orange">{d}d left</span>;
    return <span className="text-crewly-dim">{d} days</span>;
  };

  return (
    <div className="min-h-screen bg-crewly-bg">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-crewly-orange/40 bg-crewly-card px-8 py-4">
        <span className="text-lg font-extrabold text-crewly-orange">
          Crewly <span className="text-crewly-green">Platform</span>
        </span>
        <div className="flex items-center gap-4">
          <button className="btn-ghost px-4 py-2 text-sm" onClick={() => load()} disabled={loading}>
            {loading ? 'Refreshing…' : '🔄 Refresh'}
          </button>
          <span className="text-sm text-crewly-dim">
            {user?.name} <span className="badge bg-crewly-orange/15 text-crewly-orange">SUPER ADMIN</span>
          </span>
          <button className="btn-ghost px-4 py-2 text-sm" onClick={() => { logout(); navigate('/login'); }}>
            Logout
          </button>
        </div>
      </header>

      <main className="p-8">
        <div className="mb-6 flex items-end justify-between">
          <h1 className="text-2xl font-bold">Super Admin Portal</h1>
          {updatedAt && (
            <span className="text-xs text-crewly-dim">
              Live data · updated {updatedAt.toLocaleTimeString('en-IN')}
            </span>
          )}
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
            {error}
          </div>
        )}

        {loading && !overview ? (
          <p className="text-crewly-dim">Loading platform data…</p>
        ) : (
          <>
            {/* ── Headline stats ─────────────────────────────────── */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard icon="🏢" label="Companies" value={overview?.totalCompanies ?? 0} />
              <StatCard icon="⏳" label="On Trial" value={overview?.trialing ?? 0} accent="text-crewly-dim" />
              <StatCard icon="💎" label="Paying" value={overview?.activePaid ?? 0} accent="text-crewly-green" />
              <StatCard icon="⛔" label="Suspended" value={overview?.suspended ?? 0} accent="text-crewly-red" />
              <StatCard icon="💰" label="Live MRR" value={money(overview?.mrr ?? 0)} accent="text-crewly-green" />
            </div>

            {/* ── Revenue chart ──────────────────────────────────── */}
            <section className="card mt-6">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold">📈 Revenue — last 12 months</h2>
                <span className="text-xs text-crewly-dim">Total {money(totalRev)}</span>
              </div>
              <div className="flex h-44 items-end gap-2">
                {revenue.map((m) => (
                  <div key={m.key} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                    <span className="text-[10px] text-crewly-dim">{m.total ? money(m.total) : ''}</span>
                    <div
                      className="w-full max-w-10 rounded-t bg-crewly-green/70"
                      style={{ height: `${Math.max(4, Math.round(((m.total || 0) / maxRev) * 140))}px` }}
                      title={`${m.label}: ${money(m.total)}`}
                    />
                    <span className="text-[10px] text-crewly-dim">{m.label}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* ── Companies table ────────────────────────────────── */}
            <section className="card mt-6 overflow-hidden p-0">
              <div className="flex items-center justify-between px-5 py-4">
                <h2 className="font-semibold">🏢 Customer Companies</h2>
                <span className="text-xs text-crewly-dim">{companies.length} total</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-y border-crewly-border text-left text-xs uppercase tracking-wide text-crewly-dim">
                      <th className="px-5 py-3">Company</th>
                      <th className="px-3 py-3">Plan</th>
                      <th className="px-3 py-3">Employees</th>
                      <th className="px-3 py-3">Subscription</th>
                      <th className="px-3 py-3">Expires</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-5 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {companies.length === 0 && (
                      <tr>
                        <td colSpan="7" className="px-5 py-8 text-center text-crewly-dim">
                          No customer companies yet.
                        </td>
                      </tr>
                    )}
                    {companies.map((c) => (
                      <tr key={c.id} className="border-b border-crewly-border/60 last:border-0">
                        <td className="px-5 py-3">
                          <p className="font-semibold">{c.name}</p>
                          <p className="text-xs text-crewly-dim">{c.code} · {c.email}</p>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`badge ${PLAN_STYLES[c.plan] || PLAN_STYLES.TRIAL}`}>{c.plan}</span>
                        </td>
                        <td className="px-3 py-3">{c.employees}</td>
                        <td className="px-3 py-3">
                          <span className={`badge ${SUB_STYLES[c.subStatus] || 'bg-gray-500/15 text-gray-400'}`}>
                            {c.subStatus}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          {daysLeftLabel(c.daysLeft)}
                          {c.endDate && (
                            <p className="text-[10px] text-crewly-dim">
                              {new Date(c.endDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`badge ${c.status === 'SUSPENDED' ? 'bg-crewly-red/15 text-crewly-red' : 'bg-crewly-green/15 text-crewly-green'}`}>
                            {c.status}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button
                            disabled={busyId === c.id}
                            onClick={() => toggleStatus(c)}
                            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                              c.status === 'SUSPENDED'
                                ? 'bg-crewly-green/15 text-crewly-green hover:bg-crewly-green/25'
                                : 'bg-crewly-red/15 text-crewly-red hover:bg-crewly-red/25'
                            } disabled:opacity-50`}
                          >
                            {busyId === c.id ? '…' : c.status === 'SUSPENDED' ? 'Activate' : 'Suspend'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
};

export default SuperAdminDashboard;