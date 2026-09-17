import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock, RefreshCw, Send, Undo2 } from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import usePermission from '../../hooks/usePermission.js';

// Phase 31.11 — Monthly attendance finalization panel. Shows the
// month status, the backend-derived readiness report (blockers must
// be resolved in their own workflows — nothing here can override
// them), the aggregate preview totals, and the finalize / send /
// reopen actions. Time facts only: no reasons, no money, no salary
// math of any kind.

const STATUS_STYLES = {
  OPEN: 'bg-white/10 text-crewly-dim',
  FINALizing: 'bg-crewly-orange/15 text-crewly-orange',
  FINALIZED: 'bg-crewly-green/15 text-crewly-green',
  SENT_TO_PAYROLL: 'bg-blue-400/15 text-blue-300',
  REOPENED: 'bg-violet-400/15 text-violet-300',
};

const fmtDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

const AttendanceFinalizationPanel = ({ month }) => {
  const { hasPermission } = usePermission();
  const canManage = hasPermission('ATTENDANCE_FINALIZATION_MANAGE');
  const canReopen = hasPermission('ATTENDANCE_FINALIZATION_REOPEN');

  const [status, setStatus] = useState(null);
  const [report, setReport] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const [showReopen, setShowReopen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // 31.16 D-05 — summary lives on preview, not validate.
      const [statusRes, validateRes, previewRes] = await Promise.all([
        attendanceService.finalizationStatus(month),
        attendanceService.finalizationValidate(month),
        attendanceService.finalizationPreview(month),
      ]);
      setStatus(statusRes);
      setReport(validateRes);
      setPreview(previewRes);
    } catch (err) {
      setStatus(null);
      setReport(null);
      setPreview(null);
      setError(err?.response?.data?.message || err.message || 'Failed to load finalization');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setShowReopen(false); setReopenReason(''); setActionError(''); }, [month]);

  const runAction = async (kind, call) => {
    setBusy(kind);
    setActionError('');
    try {
      await call();
      await load();
    } catch (err) {
      setActionError(err?.response?.data?.message || err.message || 'Action failed');
    } finally {
      setBusy('');
    }
  };

  const readiness = report?.readiness || { ready: false, blockers: 0, warnings: 0 };
  // 31.16 D-05 — the backend names these `summary` (on preview) and
  // `gates` (on all three reads), not `report.summary` / `payrollGates`.
  const summary = preview?.summary || {};
  const gates = report?.gates || status?.gates || preview?.gates || {};
  const finalizeBlocked = gates?.finalize && gates.finalize.allowed === false;
  const sendBlocked = gates?.send && gates.send.allowed === false;
  const reopenBlocked = gates?.reopen && gates.reopen.allowed === false;
  const canFinalize = canManage
    && ['OPEN', 'REOPENED'].includes(status?.status)
    && readiness.ready
    && !finalizeBlocked;
  const canSend = canManage && status?.status === 'FINALIZED' && !sendBlocked;
  const canReopenNow = canReopen
    && ['FINALIZED', 'SENT_TO_PAYROLL'].includes(status?.status)
    && !reopenBlocked;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Month finalization</h2>
          <p className="text-sm text-crewly-dim">
            {month} · validated through {report?.scopeThrough || '—'} · {report?.employees ?? '—'} employees
          </p>
        </div>
        <button type="button" className="btn-ghost px-2 py-1" onClick={load} aria-label="Reload finalization">
          <RefreshCw size={16} />
        </button>
      </div>

      {loading && <div className="card text-sm text-crewly-dim">Checking month readiness…</div>}
      {error && (
        <div className="card text-sm text-crewly-red">
          {error} <button type="button" className="underline" onClick={load}>Retry</button>
        </div>
      )}

      {!loading && !error && status && (
        <>
          <div className="card flex flex-wrap items-center gap-3">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[status.status] || STATUS_STYLES.OPEN}`}>
              {status.status.replace(/_/g, ' ')}
            </span>
            <span className="text-sm text-crewly-dim">
              Version {status.currentVersion}
              {status.currentVersion > 0 && status.versions?.length > 0 && (
                <> · latest finalized {fmtDateTime(status.versions[status.versions.length - 1]?.finalizedAt)}</>
              )}
            </span>
            <span className="ml-auto inline-flex items-center gap-2 text-sm">
              {readiness.ready ? (
                <span className="inline-flex items-center gap-1 text-crewly-green">
                  <CheckCircle2 size={16} /> Ready{readiness.warnings > 0 ? ` · ${readiness.warnings} warning${readiness.warnings > 1 ? 's' : ''}` : ''}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-crewly-red">
                  <AlertTriangle size={16} /> {readiness.blockers} blocker{readiness.blockers === 1 ? '' : 's'}
                  {readiness.warnings > 0 ? ` · ${readiness.warnings} warning${readiness.warnings > 1 ? 's' : ''}` : ''}
                </span>
              )}
            </span>
          </div>

          {(finalizeBlocked || sendBlocked || reopenBlocked) && (
            <div className="card inline-flex items-start gap-2 text-sm text-crewly-orange">
              <Lock size={16} className="mt-0.5" />
              <span>
                Payroll gate: {[gates.finalize, gates.send, gates.reopen].filter((gate) => gate && gate.allowed === false).map((gate) => (gate.reasons || []).join('; ')).filter(Boolean).join(' · ')}
              </span>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Scheduled days', summary.scheduledWorkingDays],
              ['Worked units', summary.workedUnits],
              ['Leave units', summary.leaveUnits],
              ['Absent units', summary.absentUnits],
              ['Approved OT (min)', summary.approvedOtMinutes],
              ['Comp-off days', summary.compOffDays],
              ['Late days', summary.lateDays],
              ['Scoped days', summary.scopedDays],
            ].map(([label, value]) => (
              <div key={label} className="card">
                <div className="text-xs text-crewly-dim">{label}</div>
                <div className="text-xl font-semibold">{value ?? '—'}</div>
              </div>
            ))}
          </div>

          {report.blockers?.length > 0 && (
            <div className="card overflow-x-auto">
              <h3 className="pb-2 text-sm font-semibold text-crewly-red">
                Blockers — resolve these in their own screens first
              </h3>
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs text-crewly-dim">
                    <th className="py-2 pr-3 font-medium">Date</th>
                    <th className="py-2 pr-3 font-medium">Employee</th>
                    <th className="py-2 pr-3 font-medium">Issue</th>
                    <th className="py-2 font-medium">Where to fix</th>
                  </tr>
                </thead>
                <tbody>
                  {report.blockers.map((issue, index) => (
                    <tr key={`${issue.code}-${issue.employeeId}-${issue.date || index}`} className="border-b border-white/5">
                      <td className="py-2 pr-3">{issue.date || '—'}</td>
                      <td className="py-2 pr-3">
                        <div className="font-medium">{issue.employeeName}</div>
                        <div className="text-xs text-crewly-dim">{issue.employeeCode}</div>
                      </td>
                      <td className="py-2 pr-3">{issue.label}</td>
                      <td className="py-2 text-crewly-dim">{issue.workflow}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.warnings?.length > 0 && (
            <div className="card">
              <h3 className="pb-2 text-sm font-semibold text-crewly-orange">
                Warnings — finalization stays allowed
              </h3>
              <ul className="space-y-1 text-sm">
                {report.warnings.slice(0, 20).map((issue, index) => (
                  <li key={`${issue.code}-${issue.employeeId}-${issue.date || index}`} className="text-crewly-dim">
                    {issue.date || ''} · {issue.employeeName} · {issue.label}
                  </li>
                ))}
              </ul>
              {report.warnings.length > 20 && (
                <p className="pt-1 text-xs text-crewly-dim">…and {report.warnings.length - 20} more</p>
              )}
            </div>
          )}

          {status.versions?.length > 0 && (
            <div className="card">
              <h3 className="pb-2 text-sm font-semibold">Version history</h3>
              <ul className="space-y-1 text-sm text-crewly-dim">
                {status.versions.map((version) => (
                  <li key={version.version}>
                    v{version.version} · finalized {fmtDateTime(version.finalizedAt)}
                    {version.sentToPayrollAt && <> · sent {fmtDateTime(version.sentToPayrollAt)}</>}
                    {version.reopenReason && <> · reopened: {version.reopenReason}</>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {actionError && <div className="card text-sm text-crewly-red">{actionError}</div>}

          <div className="card flex flex-wrap items-center gap-2">
            {canManage && (
              <button
                type="button"
                className="btn-primary px-3 py-1 text-sm"
                disabled={!canFinalize || finalizeBlocked || Boolean(busy)}
                onClick={() => runAction('finalize', () => attendanceService.finalizeMonth(month))}
                title={readiness.ready ? 'Lock this month as versioned snapshots' : 'Resolve all blockers first'}
              >
                {busy === 'finalize' ? 'Finalizing…' : 'Finalize month'}
              </button>
            )}
            {canManage && (
              <button
                type="button"
                className="btn-ghost px-3 py-1 text-sm"
                disabled={!canSend || Boolean(busy)}
                onClick={() => runAction('send', () => attendanceService.sendFinalizationToPayroll(month))}
                title="Sync the finalized snapshot into payroll monthly inputs"
              >
                <span className="inline-flex items-center gap-1">
                  <Send size={14} /> {busy === 'send' ? 'Sending…' : 'Send to payroll'}
                </span>
              </button>
            )}
            {canReopen && ['FINALIZED', 'SENT_TO_PAYROLL'].includes(status.status) && (
              <button
                type="button"
                className="btn-ghost px-3 py-1 text-sm"
                disabled={!canReopenNow || Boolean(busy)}
                onClick={() => setShowReopen((value) => !value)}
                title={reopenBlocked ? 'Payroll has passed the point of no return' : 'Reopen for corrections (creates a new version)'}
              >
                <span className="inline-flex items-center gap-1">
                  <Undo2 size={14} /> Reopen
                </span>
              </button>
            )}
            {!canManage && !canReopen && (
              <span className="text-sm text-crewly-dim">You can view finalization; actions need HR rights.</span>
            )}
          </div>

          {showReopen && canReopenNow && (
            <div className="card flex flex-wrap items-center gap-2">
              <input
                value={reopenReason}
                onChange={(event) => setReopenReason(event.target.value)}
                placeholder="Reason for reopening (required, recorded in history)"
                className="input min-w-[280px] flex-1"
                aria-label="Reopen reason"
              />
              <button
                type="button"
                className="btn-primary px-3 py-1 text-sm"
                disabled={reopenReason.trim().length < 3 || Boolean(busy)}
                onClick={() => runAction('reopen', () => attendanceService.reopenFinalization(month, reopenReason.trim()))}
              >
                {busy === 'reopen' ? 'Reopening…' : 'Confirm reopen'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AttendanceFinalizationPanel;
