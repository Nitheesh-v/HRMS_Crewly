// ============================================================
//  PHASE 30.1.1 — BGV Ops Workbench (Crewly super-admin portal)
//
//  The cross-tenant verification queue. Columns: tenant, candidate,
//  check type, assignee, status, SLA, last update. Filters: tenant,
//  check type, status, aging, candidate search, "My assignments".
//  Stat cards: Open / Due in 48h / Overdue / Awaiting response.
//  Verification here is Crewly-operated: tenants NEVER appear as
//  verifiers (the picker lists platform users only).
//  Lucide + Tailwind slate, loading/error/empty states, no new deps.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Building2,
  Clock3,
  Inbox,
  Search,
  ShieldCheck,
  UserPlus2,
} from 'lucide-react';
import useAuth from '../../hooks/useAuth.jsx';
import superAdminBgvService from '../../services/superAdminBgvService.js';
import superAdminService from '../../services/superAdminService.js';

export const CHECK_TYPE_LABELS = {
  IDENTITY: 'Identity',
  ADDRESS: 'Address',
  EDUCATION: 'Education',
  EMPLOYMENT: 'Employment',
  COURT_RECORD: 'Court record',
};

export const STATUS_LABELS = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In progress',
  VERIFIED: 'Verified',
  DISCREPANCY: 'Discrepancy',
  UTV: 'Unable to verify',
  INSUFFICIENT_DATA: 'Insufficient data',
  SKIPPED: 'Skipped',
};

export const STATUS_TONES = {
  PENDING: 'border-slate-500/40 bg-slate-500/10 text-slate-300',
  IN_PROGRESS: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  VERIFIED: 'border-crewly-green/40 bg-crewly-green/10 text-crewly-green',
  DISCREPANCY: 'border-crewly-red/40 bg-crewly-red/10 text-crewly-red',
  UTV: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  INSUFFICIENT_DATA: 'border-purple-500/40 bg-purple-500/10 text-purple-300',
  SKIPPED: 'border-slate-700 bg-slate-800/60 text-slate-500',
};

const dayMs = 86400000;

export const slaTone = (check) => {
  const due = check.sla?.dueAt ? new Date(check.sla.dueAt).getTime() : null;
  const terminal = ['VERIFIED', 'UTV', 'SKIPPED'].includes(check.status);
  if (terminal || !due) return 'border-slate-700 text-crewly-dim';
  const now = Date.now();
  if (due < now) return 'border-crewly-red/40 text-crewly-red';
  if (due - now <= 2 * dayMs) return 'border-amber-500/40 text-amber-300';
  return 'border-crewly-green/40 text-crewly-green';
};

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const relativeDays = (value) => {
  if (!value) return '';
  const diff = Math.round((Date.now() - new Date(value).getTime()) / dayMs);
  return diff <= 0 ? 'today' : `${diff}d ago`;
};

const selectClass =
  'rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2 text-sm outline-none focus:border-crewly-green';

const StatCard = ({ icon: Icon, label, value, tone = '' }) => (
  <div className="card flex items-center gap-3 !p-4">
    <span className={`rounded-lg border p-2 ${tone || 'border-crewly-border text-crewly-dim'}`}>
      <Icon size={16} />
    </span>
    <span>
      <span className="block text-xl font-semibold">{value ?? '—'}</span>
      <span className="text-xs text-crewly-dim">{label}</span>
    </span>
  </div>
);

const SuperAdminBgvWorkbenchPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canAssign = ['SUPER_ADMIN', 'PLATFORM_ADMIN'].includes(user?.role);

  const [stats, setStats] = useState(null);
  const [checks, setChecks] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [meta, setMeta] = useState({ page: 1, total: 0, limit: 25, capped: false });
  const [filters, setFilters] = useState({ companyId: '', checkType: '', status: '', agingBucket: '', search: '', mine: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Tenant dropdown (the whole point of the ops view is working
  // ACROSS tenants, so the list starts unfiltered-but-capped).
  useEffect(() => {
    superAdminService
      .companies({ limit: 200 })
      .then((data) => setTenants(data?.rows || []))
      .catch(() => setTenants([]));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const params = { page: meta.page, limit: meta.limit };
    Object.entries(filters).forEach(([key, value]) => {
      if (key === 'mine') { if (value) params.assignedToMe = 'true'; return; }
      if (value) params[key] = value;
    });
    Promise.all([
      filters.mine ? superAdminBgvService.mine(params) : superAdminBgvService.list(params),
      superAdminBgvService.stats(filters.companyId ? { companyId: filters.companyId } : {}),
    ])
      .then(([list, statsData]) => {
        setChecks(list.checks);
        setMeta((m) => ({ ...m, total: list.meta?.total ?? list.checks.length, capped: Boolean(list.meta?.capped) }));
        setStats(statsData);
      })
      .catch((err) => setError(err?.message || 'Could not load the verification queue'))
      .finally(() => setLoading(false));
  }, [filters, meta.page, meta.limit]);

  useEffect(() => { load(); }, [load]);

  const assignToMe = async (checkId) => {
    setError('');
    try {
      await superAdminBgvService.assign(checkId, user?._id);
      load();
    } catch (err) {
      setError(err?.message || 'Could not assign this check to you');
    }
  };

  const totalPages = Math.max(1, Math.ceil(meta.total / meta.limit));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ShieldCheck size={22} className="text-crewly-green" /> BGV Verification Queue
        </h1>
        <span className="text-sm text-crewly-dim">Crewly-operated · all tenants</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Inbox} label="Open checks" value={stats?.open} />
        <StatCard icon={Clock3} label="Due in 48h" value={stats?.dueSoonIn48h} tone="border-amber-500/40 text-amber-300" />
        <StatCard icon={AlertTriangle} label="Overdue" value={stats?.overdue} tone="border-crewly-red/40 text-crewly-red" />
        <StatCard icon={Search} label="Awaiting response" value={stats?.awaitingResponse} />
      </div>

      {error && (
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>
      )}
      {meta.capped && !error && (
        <p className="text-xs text-crewly-dim">
          Unfiltered queue is capped by the server — narrow with tenant, status or assignee to page deeper.
        </p>
      )}

      <div className="card flex flex-wrap items-end gap-3 !p-4">
        <label className="text-sm">
          <span className="mb-1.5 flex items-center gap-1 text-crewly-dim"><Building2 size={12} /> Tenant</span>
          <select
            className={selectClass}
            value={filters.companyId}
            onChange={(e) => setFilters((f) => ({ ...f, companyId: e.target.value }))}
          >
            <option value="">All tenants</option>
            {tenants.map((tenant) => (
              <option key={tenant._id || tenant.id} value={tenant._id || tenant.id}>{tenant.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1.5 block text-crewly-dim">Check type</span>
          <select
            className={selectClass}
            value={filters.checkType}
            onChange={(e) => setFilters((f) => ({ ...f, checkType: e.target.value }))}
          >
            <option value="">All</option>
            {Object.entries(CHECK_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1.5 block text-crewly-dim">Status</span>
          <select
            className={selectClass}
            value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          >
            <option value="">All</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1.5 block text-crewly-dim">Aging</span>
          <select
            className={selectClass}
            value={filters.agingBucket}
            onChange={(e) => setFilters((f) => ({ ...f, agingBucket: e.target.value }))}
          >
            <option value="">Any</option>
            <option value="0-3">0–3 days</option>
            <option value="4-7">4–7 days</option>
            <option value="8-12">8–12 days</option>
            <option value=">12">Over 12 days</option>
          </select>
        </label>
        <label className="min-w-40 flex-1 text-sm">
          <span className="mb-1.5 block text-crewly-dim">Candidate</span>
          <input
            className="w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2 text-sm outline-none focus:border-crewly-green"
            placeholder="Name or candidate code"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
        </label>
        <button
          type="button"
          onClick={() => setFilters((f) => ({ ...f, mine: !f.mine }))}
          className={`rounded-lg border px-3 py-2 text-sm transition ${
            filters.mine
              ? 'border-crewly-green/50 bg-crewly-green/10 text-crewly-green'
              : 'border-crewly-border text-crewly-dim hover:text-crewly-text'
          }`}
        >
          My assignments
        </button>
        <button
          type="button"
          onClick={() => { setMeta((m) => ({ ...m, page: 1 })); load(); }}
          className="rounded-lg border border-crewly-border px-3 py-2 text-sm text-crewly-dim transition hover:text-crewly-text"
        >
          Search
        </button>
      </div>

      <div className="card overflow-x-auto !p-0">
        {loading ? (
          <p className="p-6 text-sm text-crewly-dim">Loading checks…</p>
        ) : !checks.length ? (
          <p className="p-6 text-sm text-crewly-dim">
            No checks in this view. {filters.mine ? 'Nothing is assigned to you yet.' : 'Checks appear here once a tenant case is started (27.15) — or use case seeding from the detail page.'}
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-crewly-border text-xs uppercase tracking-wide text-crewly-dim">
              <tr>
                <th className="px-4 py-3">Tenant</th>
                <th className="px-4 py-3">Candidate</th>
                <th className="px-4 py-3">Check</th>
                <th className="px-4 py-3">Assignee</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">SLA</th>
                <th className="px-4 py-3">Last update</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.id} className="border-b border-crewly-border/60 last:border-0 hover:bg-crewly-surface/40">
                  <td className="px-4 py-3">
                    <Link to={`/super-admin/companies/${check.companyId}`} className="font-medium text-crewly-dim transition hover:text-crewly-green">
                      {check.company?.name || 'Tenant'}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="block font-medium">{check.caseInfo?.candidateName || 'Unknown'}</span>
                    <span className="text-xs text-crewly-dim">
                      {check.caseInfo?.candidateCode}
                      {check.caseInfo?.jobTitle ? ` · ${check.caseInfo.jobTitle}` : ''}
                    </span>
                  </td>
                  <td className="px-4 py-3">{CHECK_TYPE_LABELS[check.checkType] || check.checkType}</td>
                  <td className="px-4 py-3 text-crewly-dim">
                    {check.assignedVerifierName || <span className="italic">unassigned</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs ${STATUS_TONES[check.status] || ''}`}>
                      {STATUS_LABELS[check.status] || check.status}
                    </span>
                    {!check.isRequired && check.status !== 'SKIPPED' && (
                      <span className="ml-1.5 text-xs text-crewly-dim">optional</span>
                    )}
                  </td>
                  <td className={`px-4 py-3 text-xs ${slaTone(check)}`}>
                    {formatDate(check.sla?.dueAt)}
                    {check.sla?.extendedOnce ? ' · extended' : ''}
                  </td>
                  <td className="px-4 py-3 text-xs text-crewly-dim">{relativeDays(check.updatedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {canAssign && !check.assignedVerifierId && (
                        <button
                          type="button"
                          onClick={() => assignToMe(check.id)}
                          className="flex items-center gap-1 rounded-lg border border-crewly-border px-2 py-1 text-xs text-crewly-dim transition hover:border-crewly-green/50 hover:text-crewly-green"
                        >
                          <UserPlus2 size={13} /> Assign to me
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => navigate(`/super-admin/bgv/checks/${check.id}`)}
                        className="rounded-lg border border-crewly-border px-2 py-1 text-xs transition hover:border-crewly-green/50 hover:text-crewly-green"
                      >
                        Open
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-3 text-sm text-crewly-dim">
          <button
            type="button"
            disabled={meta.page <= 1}
            onClick={() => setMeta((m) => ({ ...m, page: m.page - 1 }))}
            className="rounded-lg border border-crewly-border px-3 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>
          <span>Page {meta.page} of {totalPages}</span>
          <button
            type="button"
            disabled={meta.page >= totalPages}
            onClick={() => setMeta((m) => ({ ...m, page: m.page + 1 }))}
            className="rounded-lg border border-crewly-border px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
};

export default SuperAdminBgvWorkbenchPage;
