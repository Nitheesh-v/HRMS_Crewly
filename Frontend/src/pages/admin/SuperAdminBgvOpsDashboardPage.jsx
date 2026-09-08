import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Clock,
  Gauge,
  Loader2,
  RefreshCw,
  Settings2,
  TimerReset,
  Users,
} from 'lucide-react';
import superAdminService from '../../services/superAdminService.js';

// Phase 30.11 — internal BGV operations dashboard (platform-only).
// Everything shown is DERIVED server-side from the authoritative Phase
// 30.x documents: no second state machine, no stored counters, and no
// React countdown timers — SLA status is recomputed by the backend on
// every fetch. Rows are deliberately safe (order code, names, state,
// age/due): no PAN/Aadhaar/UAN, documents, notes or payment data.

const STATE_BADGE = {
  AWAITING_CONSENT: 'bg-sky-500/10 text-sky-300',
  AWAITING_CANDIDATE_SUBMISSION: 'bg-sky-500/10 text-sky-300',
  UNASSIGNED: 'bg-amber-500/10 text-amber-300',
  IN_PROGRESS: 'bg-indigo-500/10 text-indigo-300',
  AWAITING_CANDIDATE: 'bg-amber-500/10 text-amber-300',
  AWAITING_THIRD_PARTY: 'bg-amber-500/10 text-amber-300',
  AWAITING_QA: 'bg-violet-500/10 text-violet-300',
  QA_RETURNED: 'bg-rose-500/10 text-rose-300',
  APPROVED: 'bg-crewly-green/10 text-crewly-green',
  REPORT_READY: 'bg-crewly-green/10 text-crewly-green',
  RELEASED: 'bg-crewly-green/10 text-crewly-green',
};

const SLA_BADGE = {
  ON_TRACK: 'bg-crewly-green/10 text-crewly-green',
  DUE_SOON: 'bg-amber-500/10 text-amber-300',
  OVERDUE: 'bg-rose-500/10 text-rose-300',
  PAUSED: 'bg-slate-500/10 text-slate-300',
  COMPLETED: 'bg-crewly-green/10 text-crewly-green',
  SLA_NOT_CONFIGURED: 'bg-slate-500/10 text-slate-400',
};

const STATE_LABEL = {
  AWAITING_CONSENT: 'Awaiting consent',
  AWAITING_CANDIDATE_SUBMISSION: 'Awaiting submission',
  UNASSIGNED: 'Unassigned',
  IN_PROGRESS: 'In progress',
  AWAITING_CANDIDATE: 'Waiting candidate',
  AWAITING_THIRD_PARTY: 'Waiting third party',
  AWAITING_QA: 'Awaiting QA',
  QA_RETURNED: 'QA returned',
  APPROVED: 'Approved',
  REPORT_READY: 'Report ready',
  RELEASED: 'Released',
};

const CHECK_TYPES = ['IDENTITY', 'ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'REFERENCE'];
const TABS = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'queues', label: 'Queues', icon: ClipboardList },
  { id: 'workload', label: 'Verifier workload', icon: Users },
  { id: 'sla', label: 'SLA settings', icon: Settings2 },
];

const hoursLabel = (hours) => {
  if (hours === null || hours === undefined) return '—';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

const SuperAdminBgvOpsDashboardPage = () => {
  const [tab, setTab] = useState('overview');
  const [summary, setSummary] = useState(null);
  const [queue, setQueue] = useState(null);
  const [workload, setWorkload] = useState(null);
  const [sla, setSla] = useState(null);
  const [filters, setFilters] = useState({ state: '', checkType: '', orderCode: '', sla: '', sort: 'age_desc' });
  const [page, setPage] = useState(1);
  const [slaForm, setSlaForm] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const loadSummary = useCallback(async () => {
    try {
      const result = await superAdminService.bgvOpsDashboard();
      setSummary(result);
    } catch (requestError) {
      setError(requestError?.message || 'Could not load the operations dashboard');
    }
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const params = { page, pageSize: 20, sort: filters.sort };
      if (filters.state) params.state = filters.state;
      if (filters.checkType) params.checkType = filters.checkType;
      if (filters.orderCode) params.orderCode = filters.orderCode;
      if (filters.sla) params.sla = filters.sla;
      const result = await superAdminService.bgvOpsQueue(params);
      setQueue(result);
    } catch (requestError) {
      setError(requestError?.message || 'Could not load the queue');
    }
  }, [page, filters]);

  const loadWorkload = useCallback(async () => {
    try {
      const result = await superAdminService.bgvOpsWorkload();
      setWorkload(result);
    } catch (requestError) {
      setError(requestError?.message || 'Could not load verifier workload');
    }
  }, []);

  const loadSla = useCallback(async () => {
    try {
      const result = await superAdminService.bgvOpsSlaRead();
      setSla(result);
      const targets = result?.policy?.targets || {};
      setSlaForm({
        targets: Object.fromEntries(CHECK_TYPES.map((type) => [type, targets[type] ?? ''])),
        dueSoonHours: result?.policy?.dueSoonHours ?? 24,
        pauseOnCandidateWait: result?.policy?.pauseOnCandidateWait ?? true,
        unassignedTargetHours: result?.policy?.unassignedTargetHours ?? '',
      });
    } catch (requestError) {
      setError(requestError?.message || 'Could not load SLA settings');
    }
  }, []);

  useEffect(() => {
    setError('');
    setNotice('');
    if (tab === 'overview') loadSummary();
    if (tab === 'queues') loadQueue();
    if (tab === 'workload') loadWorkload();
    if (tab === 'sla') loadSla();
  }, [tab, loadSummary, loadQueue, loadWorkload, loadSla]);

  const saveSla = async () => {
    setBusy('sla');
    setError('');
    setNotice('');
    try {
      const targets = {};
      for (const type of CHECK_TYPES) {
        const raw = slaForm.targets[type];
        if (raw !== '' && raw !== null) targets[type] = Number(raw);
      }
      const result = await superAdminService.bgvOpsSlaUpdate({
        targets,
        dueSoonHours: slaForm.dueSoonHours === '' ? null : Number(slaForm.dueSoonHours),
        pauseOnCandidateWait: slaForm.pauseOnCandidateWait,
        unassignedTargetHours:
          slaForm.unassignedTargetHours === '' ? null : Number(slaForm.unassignedTargetHours),
      });
      setNotice('SLA policy saved — dashboard statuses now use the new targets.');
      await loadSla();
      setSla(result);
    } catch (requestError) {
      setError(requestError?.response?.data?.message || requestError?.message || 'Could not save SLA settings');
    } finally {
      setBusy('');
    }
  };

  const drill = (state) => {
    setFilters((prev) => ({ ...prev, state }));
    setPage(1);
    setTab('queues');
  };

  const cards = summary
    ? [
        { label: 'Awaiting consent', value: summary.counts?.AWAITING_CONSENT ?? 0, state: 'AWAITING_CONSENT', icon: Clock },
        { label: 'Awaiting submission', value: summary.counts?.AWAITING_CANDIDATE_SUBMISSION ?? 0, state: 'AWAITING_CANDIDATE_SUBMISSION', icon: Clock },
        { label: 'Unassigned', value: summary.counts?.UNASSIGNED ?? 0, state: 'UNASSIGNED', icon: Users },
        { label: 'In progress', value: summary.counts?.IN_PROGRESS ?? 0, state: 'IN_PROGRESS', icon: Activity },
        { label: 'Waiting candidate', value: summary.counts?.AWAITING_CANDIDATE ?? 0, state: 'AWAITING_CANDIDATE', icon: Clock },
        { label: 'Waiting third party', value: summary.counts?.AWAITING_THIRD_PARTY ?? 0, state: 'AWAITING_THIRD_PARTY', icon: Clock },
        { label: 'Awaiting QA', value: summary.counts?.AWAITING_QA ?? 0, state: 'AWAITING_QA', icon: ClipboardList },
        { label: 'Overdue', value: summary.overdue ?? 0, sla: 'OVERDUE', icon: AlertTriangle, danger: true },
        { label: 'Completed / released', value: (summary.counts?.REPORT_READY ?? 0) + (summary.counts?.RELEASED ?? 0), state: 'RELEASED', icon: CheckCircle2 },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">BGV Operations</h1>
          <p className="text-sm text-crewly-muted">
            Internal derived view of the verification pipeline — queues, workload and SLA. Not a hiring-decision
            dashboard, and never shown to tenant HR.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/super-admin/bgv-operations" className="btn-ghost text-xs">
            <Users className="h-4 w-4" /> Assignments
          </Link>
          <Link to="/super-admin/bgv-qa" className="btn-ghost text-xs">
            <ClipboardList className="h-4 w-4" /> QA Review
          </Link>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => {
              if (tab === 'overview') loadSummary();
              if (tab === 'queues') loadQueue();
              if (tab === 'workload') loadWorkload();
              if (tab === 'sla') loadSla();
            }}
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="card border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{error}</div>}
      {notice && <div className="card border-crewly-green/30 bg-crewly-green/10 p-3 text-sm text-crewly-green">{notice}</div>}

      <div className="flex flex-wrap gap-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`btn-ghost text-xs ${tab === id ? 'border-crewly-teal/60 text-crewly-teal' : ''}`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-4">
          {!summary ? (
            <div className="card flex items-center gap-2 p-6 text-sm text-crewly-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading derived counts…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                {cards.map((card) => (
                  <button
                    key={card.label}
                    type="button"
                    onClick={() => {
                      if (card.sla) {
                        setFilters((p) => ({ ...p, sla: card.sla, state: '' }));
                        setPage(1);
                        setTab('queues');
                      } else {
                        drill(card.state);
                      }
                    }}
                    className="card p-4 text-left transition hover:border-crewly-teal/50"
                  >
                    <div className="flex items-center justify-between text-crewly-muted">
                      <span className="text-xs">{card.label}</span>
                      <card.icon className={`h-4 w-4 ${card.danger && card.value > 0 ? 'text-rose-400' : ''}`} />
                    </div>
                    <div className={`mt-2 text-2xl font-semibold ${card.danger && card.value > 0 ? 'text-rose-300' : 'text-white'}`}>
                      {card.value}
                    </div>
                  </button>
                ))}
              </div>
              {summary.slaNotConfigured > 0 && (
                <div className="card flex items-start gap-2 border-amber-500/30 p-3 text-xs text-amber-300">
                  <TimerReset className="mt-0.5 h-4 w-4" />
                  <span>
                    {summary.slaNotConfigured} row(s) have <strong>no SLA configured</strong> — set turnaround targets in
                    SLA settings. No default targets are assumed.
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'queues' && (
        <div className="space-y-3">
          <div className="card flex flex-wrap items-end gap-3 p-3">
            <div>
              <label className="label" htmlFor="ops-state">State</label>
              <select
                id="ops-state"
                className="input h-9 text-xs"
                value={filters.state}
                onChange={(event) => { setFilters((p) => ({ ...p, state: event.target.value })); setPage(1); }}
              >
                <option value="">All states</option>
                {Object.keys(STATE_LABEL).map((state) => (
                  <option key={state} value={state}>{STATE_LABEL[state]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ops-check">Check</label>
              <select
                id="ops-check"
                className="input h-9 text-xs"
                value={filters.checkType}
                onChange={(event) => { setFilters((p) => ({ ...p, checkType: event.target.value })); setPage(1); }}
              >
                <option value="">All checks</option>
                {CHECK_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ops-sla">SLA</label>
              <select
                id="ops-sla"
                className="input h-9 text-xs"
                value={filters.sla}
                onChange={(event) => { setFilters((p) => ({ ...p, sla: event.target.value })); setPage(1); }}
              >
                <option value="">Any SLA</option>
                <option value="OVERDUE">Overdue only</option>
                <option value="DUE_SOON">Due soon</option>
                <option value="SLA_NOT_CONFIGURED">Not configured</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ops-code">Order ref</label>
              <input
                id="ops-code"
                className="input h-9 text-xs"
                placeholder="BGV-…"
                value={filters.orderCode}
                onChange={(event) => { setFilters((p) => ({ ...p, orderCode: event.target.value })); setPage(1); }}
              />
            </div>
            <div>
              <label className="label" htmlFor="ops-sort">Sort</label>
              <select
                id="ops-sort"
                className="input h-9 text-xs"
                value={filters.sort}
                onChange={(event) => setFilters((p) => ({ ...p, sort: event.target.value }))}
              >
                <option value="age_desc">Oldest first</option>
                <option value="age_asc">Newest first</option>
              </select>
            </div>
          </div>

          {!queue ? (
            <div className="card flex items-center gap-2 p-6 text-sm text-crewly-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading queue…
            </div>
          ) : queue.rows?.length === 0 ? (
            <div className="card p-6 text-center text-sm text-crewly-muted">Nothing in this queue right now.</div>
          ) : (
            <div className="card overflow-x-auto p-0">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-crewly-muted">
                  <tr>
                    <th className="px-3 py-2">Order</th>
                    <th className="px-3 py-2">Organisation</th>
                    <th className="px-3 py-2">Candidate</th>
                    <th className="px-3 py-2">Check</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2">Verifier</th>
                    <th className="px-3 py-2">Age</th>
                    <th className="px-3 py-2">SLA</th>
                    <th className="px-3 py-2">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.rows.map((row) => (
                    <tr key={`${row.orderId}-${row.checkType || 'ORDER'}`} className="border-b border-white/5">
                      <td className="px-3 py-2 font-medium text-white">{row.orderCode}</td>
                      <td className="px-3 py-2 text-crewly-muted">{row.companyName}</td>
                      <td className="px-3 py-2 text-crewly-muted">{row.candidateName}</td>
                      <td className="px-3 py-2 text-crewly-muted">{row.checkType || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`badge ${STATE_BADGE[row.state] || ''}`}>{STATE_LABEL[row.state] || row.state}</span>
                      </td>
                      <td className="px-3 py-2 text-crewly-muted">{row.verifierName || '—'}</td>
                      <td className="px-3 py-2 text-crewly-muted">{hoursLabel(row.ageHours)}</td>
                      <td className="px-3 py-2">
                        <span className={`badge ${SLA_BADGE[row.slaStatus] || ''}`}>
                          {row.slaStatus === 'OVERDUE' ? `OVERDUE ${row.overdueDays}d` : row.slaStatus}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-crewly-muted">
                        {row.lastActivityIso ? new Date(row.lastActivityIso).toLocaleString('en-IN') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {queue && queue.pages > 1 && (
            <div className="flex items-center justify-between text-xs text-crewly-muted">
              <span>Page {queue.page} of {queue.pages} · {queue.total} rows</span>
              <div className="flex gap-2">
                <button type="button" className="btn-ghost text-xs" disabled={queue.page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </button>
                <button type="button" className="btn-ghost text-xs" disabled={queue.page >= queue.pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'workload' && (
        <div className="space-y-3">
          {!workload ? (
            <div className="card flex items-center gap-2 p-6 text-sm text-crewly-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading workload…
            </div>
          ) : workload.verifiers?.length === 0 ? (
            <div className="card p-6 text-center text-sm text-crewly-muted">No verifiers yet.</div>
          ) : (
            <div className="card overflow-x-auto p-0">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/10 text-crewly-muted">
                  <tr>
                    <th className="px-3 py-2">Verifier</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Specialisations</th>
                    <th className="px-3 py-2">Assigned</th>
                    <th className="px-3 py-2">In progress</th>
                    <th className="px-3 py-2">Waiting candidate</th>
                    <th className="px-3 py-2">Waiting third party</th>
                    <th className="px-3 py-2">Submitted / QA</th>
                    <th className="px-3 py-2">Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {workload.verifiers.map((verifier) => (
                    <tr key={verifier.verifierId} className="border-b border-white/5">
                      <td className="px-3 py-2 font-medium text-white">{verifier.name}</td>
                      <td className="px-3 py-2">
                        <span className={`badge ${verifier.status === 'ACTIVE' ? 'bg-crewly-green/10 text-crewly-green' : 'bg-slate-500/10 text-slate-400'}`}>
                          {verifier.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-crewly-muted">{(verifier.specializations || []).join(', ') || '—'}</td>
                      <td className="px-3 py-2 text-crewly-muted">{verifier.assigned}</td>
                      <td className="px-3 py-2 text-crewly-muted">{verifier.inProgress}</td>
                      <td className="px-3 py-2 text-crewly-muted">{verifier.waitingCandidate}</td>
                      <td className="px-3 py-2 text-crewly-muted">{verifier.awaitingThirdParty}</td>
                      <td className="px-3 py-2 text-crewly-muted">{verifier.submittedForQa}</td>
                      <td className={`px-3 py-2 ${verifier.overdue > 0 ? 'text-rose-300' : 'text-crewly-muted'}`}>{verifier.overdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-crewly-muted">
            Workload is decision support for human operators only — reassignment always happens explicitly on the
            Assignments page. This view is never exposed to tenant HR.
          </p>
        </div>
      )}

      {tab === 'sla' && (
        <div className="space-y-4">
          {!slaForm ? (
            <div className="card flex items-center gap-2 p-6 text-sm text-crewly-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading SLA settings…
            </div>
          ) : (
            <div className="card space-y-4 p-4">
              {!sla?.configured && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                  No SLA targets are configured yet. Until you set them, dashboard rows explicitly show
                  SLA_NOT_CONFIGURED — no defaults are assumed or seeded.
                </div>
              )}
              <div>
                <h2 className="text-sm font-semibold text-white">Turnaround targets (hours)</h2>
                <p className="text-xs text-crewly-muted">
                  Whole hours, 1–720. Leave blank to keep a check unconfigured. The clock starts when the candidate
                  submission is complete AND a verifier is assigned; candidate-response waits pause the clock.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                {CHECK_TYPES.map((type) => (
                  <div key={type}>
                    <label className="label" htmlFor={`sla-${type}`}>{type}</label>
                    <input
                      id={`sla-${type}`}
                      type="number"
                      min="1"
                      max="720"
                      className="input h-9 text-xs"
                      placeholder="Unconfigured"
                      value={slaForm.targets[type]}
                      onChange={(event) => setSlaForm((p) => ({ ...p, targets: { ...p.targets, [type]: event.target.value } }))}
                    />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div>
                  <label className="label" htmlFor="sla-duesoon">Due-soon window (hours)</label>
                  <input
                    id="sla-duesoon"
                    type="number"
                    min="1"
                    max="168"
                    className="input h-9 text-xs"
                    value={slaForm.dueSoonHours}
                    onChange={(event) => setSlaForm((p) => ({ ...p, dueSoonHours: event.target.value }))}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="sla-unassigned">Unassigned age target (hours)</label>
                  <input
                    id="sla-unassigned"
                    type="number"
                    min="1"
                    max="720"
                    className="input h-9 text-xs"
                    placeholder="Optional"
                    value={slaForm.unassignedTargetHours}
                    onChange={(event) => setSlaForm((p) => ({ ...p, unassignedTargetHours: event.target.value }))}
                  />
                </div>
                <label className="flex items-end gap-2 pb-1 text-xs text-crewly-muted" htmlFor="sla-pause">
                  <input
                    id="sla-pause"
                    type="checkbox"
                    className="h-4 w-4"
                    checked={slaForm.pauseOnCandidateWait}
                    onChange={(event) => setSlaForm((p) => ({ ...p, pauseOnCandidateWait: event.target.checked }))}
                  />
                  Pause SLA while waiting on the candidate
                </label>
              </div>
              <button type="button" className="btn-primary text-xs" disabled={busy === 'sla'} onClick={saveSla}>
                {busy === 'sla' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />} Save SLA policy
              </button>
              {sla?.policy?.updatedAt && (
                <p className="text-xs text-crewly-muted">Last updated {new Date(sla.policy.updatedAt).toLocaleString('en-IN')}.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SuperAdminBgvOpsDashboardPage;
