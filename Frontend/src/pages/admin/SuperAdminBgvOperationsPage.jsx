import { useCallback, useEffect, useState } from 'react';
import {
  Ban,
  ClipboardList,
  Loader2,
  RefreshCw,
  RotateCcw,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import superAdminService from '../../services/superAdminService.js';

const CHECK_TYPES = ['IDENTITY', 'ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'REFERENCE'];

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-orange-400 focus:outline-none';

// Phase 30.7 — BGV CHECK assignment operations (platform-only).
// The queue is safe operational context: order reference, tenant company,
// candidate display name, check type, submission age, assignment state.
// Raw documents/identifiers are never listed here.
const SuperAdminBgvOperationsPage = () => {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');

  // Assignment / reassignment dialog state.
  const [dialog, setDialog] = useState(null); // { mode: 'assign'|'reassign'|'unassign', row }
  const [eligible, setEligible] = useState(null);
  const [form, setForm] = useState({ verifierId: '', reason: '' });

  const load = useCallback(async () => {
    try {
      const result = await superAdminService.bgvOperationsQueue();
      setRows(result.rows || []);
    } catch (requestError) {
      setError(requestError?.response?.data?.message || requestError.message || 'Could not load the operations queue');
    }
  }, []);

  useEffect(() => {
    document.title = 'BGV Operations — Crewly Control';
    load();
  }, [load]);

  const openDialog = async (mode, row) => {
    setNotice('');
    setError('');
    setForm({ verifierId: '', reason: '' });
    setEligible(null);
    setDialog({ mode, row });
    if (mode !== 'unassign') {
      try {
        const result = await superAdminService.bgvEligibleVerifiers(row.checkType);
        setEligible(result.verifiers || []);
      } catch (requestError) {
        setError(requestError?.response?.data?.message || requestError.message || 'Could not load eligible verifiers');
      }
    }
  };

  const submitDialog = async () => {
    if (!dialog) return;
    const { mode, row } = dialog;
    const key = `${mode}-${row.orderId}-${row.checkType}`;
    setBusy(key);
    setError('');
    try {
      if (mode === 'assign') {
        await superAdminService.bgvAssignCheck({ orderId: row.orderId, checkType: row.checkType, verifierId: form.verifierId, reason: form.reason });
      } else if (mode === 'reassign') {
        await superAdminService.bgvReassignCheck({ orderId: row.orderId, checkType: row.checkType, verifierId: form.verifierId, reason: form.reason });
      } else if (mode === 'unassign') {
        await superAdminService.bgvUnassignCheck({ orderId: row.orderId, checkType: row.checkType, reason: form.reason });
      } else {
        await superAdminService.bgvCancelCheck({ orderId: row.orderId, checkType: row.checkType, reason: form.reason });
      }
      setNotice(
        mode === 'assign'
          ? 'Check assigned to verifier.'
          : mode === 'reassign'
            ? 'Check reassigned. Previous verifier lost access immediately.'
            : mode === 'unassign'
              ? 'Check unassigned. Former verifier lost access immediately.'
              : 'Check cancelled. The CANCELLED conclusion is locked; verifiers cannot cancel work.'
      );
      setDialog(null);
      await load();
    } catch (requestError) {
      setError(requestError?.response?.data?.message || requestError.message || 'Operation failed');
    } finally {
      setBusy('');
    }
  };

  const visible = (rows || []).filter((row) => {
    if (typeFilter !== 'ALL' && row.checkType !== typeFilter) return false;
    if (stateFilter === 'UNASSIGNED') return !row.assignment || !row.assignment.verifier;
    if (stateFilter === 'ASSIGNED') return row.assignment?.verifier && row.assignment.status === 'ASSIGNED';
    if (stateFilter === 'IN_PROGRESS') return row.assignment?.verifier && row.assignment.status === 'IN_PROGRESS';
    return true;
  });

  const stateBadge = (row) => {
    if (!row.assignment || !row.assignment.verifier) {
      return <span className="rounded-full bg-slate-500/10 px-2.5 py-1 text-[11px] font-semibold text-slate-300">UNASSIGNED</span>;
    }
    if (row.assignment.status === 'IN_PROGRESS') {
      return <span className="rounded-full bg-orange-500/10 px-2.5 py-1 text-[11px] font-semibold text-orange-300">IN PROGRESS</span>;
    }
    return <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">ASSIGNED</span>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-100">
            <ClipboardList className="h-5 w-5 text-orange-400" /> BGV Operations
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Assign submitted candidate checks to internal verifiers. Check-level assignment only — verifiers see nothing beyond their assigned checks.
          </p>
        </div>
        <button type="button" onClick={load} className="btn-ghost gap-2 !px-4 !py-2 text-sm">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {error ? <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div> : null}
      {notice ? <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</div> : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
          {['ALL', 'UNASSIGNED', 'ASSIGNED', 'IN_PROGRESS'].map((state) => (
            <button
              key={state}
              type="button"
              onClick={() => setStateFilter(state)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${stateFilter === state ? 'bg-orange-500/15 text-orange-300' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {state.replaceAll('_', ' ')}
            </button>
          ))}
        </div>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className={inputClass + ' !w-auto'}>
          <option value="ALL">All check types</option>
          {CHECK_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Candidate</th>
              <th className="px-4 py-3">Check</th>
              <th className="px-4 py-3">Waiting</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3">Verifier</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" /> Loading submitted checks…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                  No submitted checks match this filter yet.
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const key = `${row.orderId}-${row.checkType}`;
                const hasVerifier = Boolean(row.assignment?.verifier);
                const verifierDeactivated = row.assignment?.verifier?.status === 'DEACTIVATED';
                return (
                  <tr key={key} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-4 py-3 font-mono text-xs text-slate-300">{row.orderCode}</td>
                    <td className="px-4 py-3 text-slate-200">{row.companyName}</td>
                    <td className="px-4 py-3 text-slate-200">{row.candidateName}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border border-slate-700 bg-slate-950/60 px-2.5 py-1 text-[11px] font-semibold text-slate-300">{row.checkType}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{row.waitingDays}d</td>
                    <td className="px-4 py-3">
                      {stateBadge(row)}
                      {row.verificationState === 'SUBMITTED' ? (
                        <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">FINDINGS SUBMITTED</span>
                      ) : row.verificationState === 'AWAITING_THIRD_PARTY' ? (
                        <span className="ml-2 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">AWAITING 3RD PARTY</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {hasVerifier ? (
                        <span className={verifierDeactivated ? 'text-rose-300' : 'text-slate-200'}>
                          {row.assignment.verifier.name}
                          {verifierDeactivated ? (
                            <span className="ml-2 rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-300">DEACTIVATED</span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {hasVerifier ? (
                          <>
                            <button type="button" onClick={() => openDialog('reassign', row)} className="btn-ghost gap-2 !px-3 !py-1.5 text-xs">
                              <RotateCcw className="h-3.5 w-3.5" /> Reassign
                            </button>
                            {row.assignment.status === 'ASSIGNED' ? (
                              <button type="button" onClick={() => openDialog('unassign', row)} className="btn-ghost gap-2 !px-3 !py-1.5 text-xs text-rose-300">
                                <UserMinus className="h-3.5 w-3.5" /> Unassign
                              </button>
                            ) : null}
                            {row.verificationState !== 'SUBMITTED' ? (
                              <button type="button" onClick={() => openDialog('cancel', row)} className="btn-ghost gap-2 !px-3 !py-1.5 text-xs text-rose-300">
                                <Ban className="h-3.5 w-3.5" /> Cancel check
                              </button>
                            ) : null}
                          </>
                        ) : (
                          <button type="button" onClick={() => openDialog('assign', row)} className="btn-primary gap-2 !px-3 !py-1.5 text-xs">
                            <UserPlus className="h-3.5 w-3.5" /> Assign
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {dialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-base font-semibold text-slate-100">
              {dialog.mode === 'assign' ? 'Assign check' : dialog.mode === 'reassign' ? 'Reassign check' : dialog.mode === 'unassign' ? 'Unassign check' : 'Cancel check (CANCELLED conclusion)'}
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              {dialog.row.orderCode} · {dialog.row.candidateName} · {dialog.row.checkType}
            </p>

            {dialog.mode !== 'unassign' ? (
              <div className="mt-4">
                <label className="label" htmlFor="ops-verifier">Eligible verifier (ACTIVE + {dialog.row.checkType})</label>
                {eligible === null ? (
                  <p className="mt-2 flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading eligible verifiers…</p>
                ) : eligible.length === 0 ? (
                  <p className="mt-2 text-xs text-amber-300">No active verifier holds the {dialog.row.checkType} specialization yet.</p>
                ) : (
                  <select
                    id="ops-verifier"
                    className={inputClass}
                    value={form.verifierId}
                    onChange={(event) => setForm((current) => ({ ...current, verifierId: event.target.value }))}
                  >
                    <option value="">Select verifier…</option>
                    {eligible.map((verifier) => (
                      <option key={verifier.id} value={verifier.id}>
                        {verifier.name} ({verifier.email})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : dialog.mode === 'unassign' ? (
              <p className="mt-3 text-xs text-slate-400">
                Allowed only before verification work starts. The former verifier loses access immediately and the action is recorded in history.
              </p>
            ) : (
              <p className="mt-3 text-xs text-slate-400">
                Platform-only cancellation (verifiers never see CANCELLED). Records a locked CANCELLED conclusion with your business reason; the
                check history is preserved.
              </p>
            )}

            <div className="mt-4">
              <label className="label" htmlFor="ops-reason">
                Reason {dialog.mode === 'reassign' || dialog.mode === 'cancel' ? '(required, min 10 characters for cancel)' : '(optional)'}
              </label>
              <input
                id="ops-reason"
                className={inputClass}
                value={form.reason}
                maxLength={300}
                placeholder="e.g. verifier on leave"
                onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}
              />
            </div>

            {error ? <p className="mt-3 text-xs text-rose-300">{error}</p> : null}

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => { setDialog(null); setError(''); }} className="btn-ghost gap-2 !px-4 !py-2 text-sm">Cancel</button>
              <button
                type="button"
                onClick={submitDialog}
                disabled={
                  Boolean(busy) ||
                  (dialog.mode === 'assign' || dialog.mode === 'reassign' ? !form.verifierId : false) ||
                  ((dialog.mode === 'reassign' || dialog.mode === 'cancel') && form.reason.trim().length < (dialog.mode === 'cancel' ? 10 : 1))
                }
                className="btn-primary gap-2 !px-4 !py-2 text-sm"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {dialog.mode === 'assign' ? 'Assign' : dialog.mode === 'reassign' ? 'Reassign' : dialog.mode === 'unassign' ? 'Unassign' : 'Cancel check'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default SuperAdminBgvOperationsPage;
