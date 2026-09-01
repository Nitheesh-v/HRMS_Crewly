/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  Building2,
  CheckCircle2,
  Coins,
  Loader2,
  Play,
  RefreshCw,
  Users,
  Wallet,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import payrollRunService from '../../services/payrollRunService.js';

// ─────────────────────────────────────────────────────────────
// Phase 29.6 — Run Payroll (the calculation workspace)
//
//   1. Payroll month + pre-checks            (§6 / §29)
//   2. KPI cards                             (§23)
//   3. Progress tracker (live polling)       (§27)
//   4. Employee payroll results table        (§24)
//   5. Employee payroll detail drawer        (§24)
//   6. Error report                          (§22)
//
// This page CALCULATES. It never approves, never pays, never
// produces a bank file and never generates a payslip — those are
// later phases (§31).
// ─────────────────────────────────────────────────────────────

const currentMonth = () => new Date().toISOString().slice(0, 7);

const POLL_MS = 3000;

const formatMoney = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;

const formatNumber = (value) => Number(value || 0).toLocaleString('en-IN');

const formatMonth = (month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return month || '—';
  const [year, part] = String(month).split('-');
  return new Date(Number(year), Number(part) - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
};

const RUN_STATUS_LABELS = {
  DRAFT: 'Draft',
  CALCULATING: 'Calculating',
  CALCULATED: 'Calculated',
  ERROR: 'Error',
  RECALCULATED: 'Recalculated',
};

const runBadge = (status) => {
  const styles = {
    DRAFT: 'bg-slate-500/15 text-slate-300',
    CALCULATING: 'bg-sky-500/15 text-sky-300',
    CALCULATED: 'bg-emerald-500/15 text-emerald-300',
    RECALCULATED: 'bg-indigo-500/15 text-indigo-300',
    ERROR: 'bg-red-500/15 text-red-300',
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${styles[status] || styles.DRAFT}`}>
      {RUN_STATUS_LABELS[status] || status || 'Draft'}
    </span>
  );
};

const KpiCard = ({ icon: Icon, label, value, hint, tone = 'default' }) => {
  const tones = {
    default: 'text-crewly-text',
    good: 'text-emerald-300',
    bad: 'text-red-300',
    warn: 'text-amber-300',
  };
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-crewly-dim">{label}</span>
        <Icon size={16} className="text-crewly-dim" />
      </div>
      <p className={`mt-2 text-xl font-semibold ${tones[tone] || tones.default}`}>{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-crewly-dim">{hint}</p> : null}
    </div>
  );
};

const RunPayrollPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();

  const canRead = hasAnyPermission(['PAYROLL_RUN_READ', 'PAYROLL_RUN_PREPARE', 'PAYROLL_RUN_EXECUTE']);
  const canRun = hasAnyPermission(['PAYROLL_RUN_EXECUTE']);
  const canRecalculate = hasAnyPermission(['PAYROLL_RUN_RECALCULATE']);

  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);

  const [run, setRun] = useState(null);
  const [summary, setSummary] = useState({});
  const [results, setResults] = useState([]);
  const [periodStatus, setPeriodStatus] = useState('');
  const [filters, setFilters] = useState({ status: 'ALL', search: '' });
  const [detailEmployeeId, setDetailEmployeeId] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);

  const pollRef = useRef(null);

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 6000);
  }, []);

  const load = useCallback(async () => {
    try {
      const [summaryResponse, resultsResponse] = await Promise.all([
        payrollRunService.summary(month),
        payrollRunService.results(month, {
          status: filters.status === 'ALL' ? undefined : filters.status,
          search: filters.search || undefined,
        }),
      ]);

      setRun(summaryResponse?.data?.run || null);
      setSummary(summaryResponse?.data?.summary || {});
      setResults(resultsResponse?.data || []);
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403) setAccessDenied(true);
      else flash('error', error?.message || 'Unable to load the payroll run');
    } finally {
      setLoading(false);
    }
  }, [month, filters.status, filters.search, flash]);

  useEffect(() => {
    if (!permsLoading && canRead) load();
    if (!permsLoading && !canRead) setLoading(false);
  }, [permsLoading, canRead, load]);

  // §27 — while the worker is running, poll the run document. HR can leave the
  // page: the job continues in the worker process.
  const calculating = run?.status === 'CALCULATING';

  useEffect(() => {
    if (!calculating) return undefined;
    pollRef.current = setInterval(() => load(), POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [calculating, load]);

  // The monthly-input lock state (§6) is shown as a pre-check hint.
  useEffect(() => {
    if (!permsLoading || !canRead) return;
    import('../../services/monthlyInputService.js')
      .then((module) => module.default.periods())
      .then((response) => {
        const found = (response?.data || []).find((row) => row.month === month);
        setPeriodStatus(found?.status || '');
      })
      .catch(() => setPeriodStatus(''));
  }, [permsLoading, canRead, month]);

  const inputsLocked = ['LOCKED', 'SENT_TO_PAYROLL'].includes(periodStatus);

  const visible = useMemo(() => results, [results]);

  const handleRun = async () => {
    setConfirmRun(false);
    setBusy(true);
    try {
      const response = await payrollRunService.run(month);
      flash('success', response?.message || 'Payroll run started');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Unable to start the payroll run');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const handleRecalculate = async (employeeIds = null) => {
    setBusy(true);
    try {
      const response = await payrollRunService.recalculate(
        month,
        employeeIds ? { employeeIds } : {},
      );
      flash('success', response?.message || 'Payroll recalculated');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Unable to recalculate');
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    setBusy(true);
    try {
      await payrollRunService.cancel(month);
      flash('success', 'Payroll run cancelled');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Unable to cancel the run');
    } finally {
      setBusy(false);
    }
  };

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Run Payroll</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Payroll access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to view payroll calculations. Contact your Company Admin
            or Payroll Administrator.
          </p>
        </div>
      </div>
    );
  }

  const progress = run?.progress || {};

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Run Payroll</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Calculate the month from the configured data: structure, attendance, leave and monthly
            inputs. This page never approves, pays or produces a bank file.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            className="input"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
          {runBadge(run?.status || 'DRAFT')}
        </div>
      </div>

      {banner ? (
        <div
          className={`card border-l-4 text-sm ${
            banner.type === 'error'
              ? 'border-red-500 text-red-200'
              : 'border-emerald-500 text-emerald-200'
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      {/* §6 / §29 — pre-checks are visible before HR presses anything */}
      {!inputsLocked ? (
        <div className="card flex items-start gap-3 border-l-4 border-amber-500">
          <AlertTriangle size={18} className="mt-0.5 text-amber-300" />
          <div className="text-sm">
            <p className="font-semibold text-amber-200">
              Monthly inputs for {formatMonth(month)} are not locked
            </p>
            <p className="text-crewly-dim">
              The engine refuses to run while the month is open. Lock the inputs in{' '}
              <Link className="text-indigo-300 hover:underline" to="/app/payroll/inputs">
                Monthly Inputs
              </Link>{' '}
              first.
            </p>
          </div>
        </div>
      ) : null}

      {/* §27 — progress tracker */}
      {calculating ? (
        <div className="card space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold">
              Payroll progress · {formatNumber(progress.processed)} / {formatNumber(progress.total)}{' '}
              employees
            </span>
            <span className="text-crewly-dim">{formatNumber(progress.percent)}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{ width: `${Math.min(100, Number(progress.percent) || 0)}%` }}
            />
          </div>
          <p className="text-xs text-crewly-dim">
            Current employee: {progress.currentEmployeeName || '—'} · status calculating. You can
            leave this page — the job continues in the background worker.
          </p>
        </div>
      ) : null}

      {/* §23 — KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          icon={Users}
          label="Total employees"
          value={formatNumber(summary.totalEmployees)}
          hint={formatMonth(month)}
        />
        <KpiCard
          icon={CheckCircle2}
          label="Calculated"
          value={formatNumber(summary.calculated)}
          tone="good"
          hint="Snapshots written"
        />
        <KpiCard
          icon={AlertTriangle}
          label="Errors"
          value={formatNumber(summary.errors)}
          tone={summary.errors > 0 ? 'bad' : 'default'}
          hint="See the error report"
        />
        <KpiCard
          icon={Wallet}
          label="Gross payroll"
          value={formatMoney(summary.grossPayroll)}
          hint="Earnings before deductions"
        />
        <KpiCard
          icon={Coins}
          label="Net payroll"
          value={formatMoney(summary.netPayroll)}
          hint={`${formatMoney(summary.totalDeductions)} deducted`}
        />
        <KpiCard
          icon={Building2}
          label="Employer cost"
          value={formatMoney(summary.employerCost)}
          hint="Does not reduce net salary"
        />
      </div>

      {/* actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={busy || !canRun} onClick={() => setConfirmRun(true)}>
          <Play size={15} /> {run?.runCount > 0 ? 'Run payroll again' : 'Run payroll'}
        </button>
        <button
          className="btn-secondary"
          disabled={busy || !canRecalculate || !run}
          onClick={() => handleRecalculate()}
        >
          <RefreshCw size={15} /> Recalculate month
        </button>
        <button className="btn-secondary" disabled={busy || !canRun || !calculating} onClick={handleCancel}>
          <Ban size={15} /> Cancel run
        </button>
        <button
          className="btn-secondary"
          onClick={() => setReportOpen(true)}
          disabled={!summary.errors}
        >
          <AlertTriangle size={15} /> Error report{summary.errors ? ` (${summary.errors})` : ''}
        </button>
        {run?.queued ? (
          <span className="text-xs text-crewly-dim">Last run processed by the background worker</span>
        ) : run ? (
          <span className="text-xs text-crewly-dim">Last run calculated inline (no queue configured)</span>
        ) : null}
      </div>

      {/* §24 — results table */}
      <div className="card overflow-x-auto p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 p-3">
          <input
            className="input max-w-xs"
            placeholder="Search name or code"
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />
          <select
            className="input max-w-[180px]"
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
          >
            <option value="ALL">All results</option>
            <option value="CALCULATED">Calculated</option>
            <option value="ERROR">Errors</option>
          </select>
          <span className="ml-auto text-xs text-crewly-dim">
            {visible.length} result(s) · snapshot v{formatNumber(run?.version)}
          </span>
        </div>

        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
            <tr>
              <th className="px-3 py-2">Employee</th>
              <th className="px-3 py-2">Paid days</th>
              <th className="px-3 py-2">LOP</th>
              <th className="px-3 py-2">Gross</th>
              <th className="px-3 py-2">Variable</th>
              <th className="px-3 py-2">Reimbursements</th>
              <th className="px-3 py-2">Deductions</th>
              <th className="px-3 py-2">Net pay</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-crewly-dim">
                  <Loader2 className="mx-auto animate-spin" size={18} /> Loading payroll…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-crewly-dim">
                  No payroll results for {formatMonth(month)} yet. Run payroll to calculate the
                  month.
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row._id} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-3 py-2">
                    <p className="font-medium">{row.employeeName}</p>
                    <p className="text-xs text-crewly-dim">{row.employeeCode}</p>
                  </td>
                  <td className="px-3 py-2">
                    {formatNumber(row.attendance?.paidDays)} / {formatNumber(row.attendance?.workingDays)}
                  </td>
                  <td className="px-3 py-2">
                    {formatNumber(row.attendance?.lopDays)}
                    {row.attendance?.otHours ? (
                      <span className="ml-1 text-xs text-crewly-dim">
                        · {formatNumber(row.attendance.otHours)}h OT
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{formatMoney(row.totals?.gross)}</td>
                  <td className="px-3 py-2">{formatMoney(row.totals?.variableEarnings)}</td>
                  <td className="px-3 py-2">{formatMoney(row.totals?.reimbursements)}</td>
                  <td className="px-3 py-2">{formatMoney(row.totals?.totalDeductions)}</td>
                  <td className="px-3 py-2 font-semibold">{formatMoney(row.totals?.netPay)}</td>
                  <td className="px-3 py-2">
                    {row.status === 'ERROR' ? (
                      <span className="rounded-full bg-red-500/15 px-2.5 py-0.5 text-[11px] text-red-300">
                        error
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] text-emerald-300">
                        calculated
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.status === 'ERROR' ? (
                      <span className="text-xs text-crewly-dim">see error report</span>
                    ) : (
                      <button
                        className="text-sm text-indigo-300 hover:underline"
                        onClick={() => setDetailEmployeeId(row.employeeId)}
                      >
                        View breakdown
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-crewly-dim">
        Every result is an immutable snapshot (§19): recalculating writes a new version, and
        {formatMonth(month)} stays exactly as it was calculated. Inputs come from{' '}
        <Link className="text-indigo-300 hover:underline" to="/app/payroll/inputs">
          Monthly Inputs
        </Link>
        .
      </p>

      {detailEmployeeId ? (
        <PayrollDetailDrawer
          month={month}
          employeeId={detailEmployeeId}
          canRecalculate={canRecalculate}
          onClose={() => setDetailEmployeeId(null)}
          onRecalculate={handleRecalculate}
          flash={flash}
          busy={busy}
        />
      ) : null}

      {reportOpen ? (
        <ErrorReportModal
          month={month}
          results={results}
          onClose={() => setReportOpen(false)}
        />
      ) : null}

      {confirmRun ? (
        <Modal title={`Run payroll for ${formatMonth(month)}?`} onClose={() => setConfirmRun(false)}>
          <div className="space-y-3 text-sm">
            <p className="text-crewly-dim">
              The engine reads the salary structure, attendance, leave and the locked monthly inputs
              and writes one immutable snapshot per active employee. Employees who fail the
              pre-checks are listed in the error report instead of stopping the run.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setConfirmRun(false)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={busy} onClick={handleRun}>
                {busy ? <Loader2 className="animate-spin" size={15} /> : <Play size={15} />}
                {run?.runCount > 0 ? 'Run again (new version)' : 'Run payroll'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// §24 — employee payroll detail (read only)
// ─────────────────────────────────────────────────────────────
const Section = ({ title, rows, total, tone = 'default' }) => {
  if (!rows?.length) return null;
  const toneClass =
    tone === 'bad' ? 'text-red-300' : tone === 'good' ? 'text-emerald-300' : 'text-crewly-text';

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">{title}</h3>
        {total !== undefined ? <span className={`text-sm font-semibold ${toneClass}`}>{formatMoney(total)}</span> : null}
      </div>
      <table className="w-full text-left text-sm">
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.code || row.type || row.name}-${index}`} className="border-t border-white/5">
              <td className="px-2 py-1">{row.name || row.label}</td>
              <td className="px-2 py-1 text-xs text-crewly-dim">{row.reason || row.meta?.reason || ''}</td>
              <td className="px-2 py-1 text-right">{formatMoney(row.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

const PayrollDetailDrawer = ({
  month,
  employeeId,
  canRecalculate,
  onClose,
  onRecalculate,
  flash,
  busy,
}) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    payrollRunService
      .result(month, employeeId)
      .then((response) => {
        if (active) setData(response?.data || null);
      })
      .catch((error) => flash('error', error?.message || 'Unable to load the payroll breakdown'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [month, employeeId, flash]);

  const totals = data?.totals || {};
  const attendance = data?.attendance || {};

  return (
    <Modal
      title={`Payroll breakdown · ${data?.employeeName || 'Employee'} · ${formatMonth(month)}`}
      onClose={onClose}
      wide
    >
      {loading ? (
        <div className="py-10 text-center text-crewly-dim">
          <Loader2 className="mx-auto animate-spin" size={18} /> Loading…
        </div>
      ) : !data ? (
        <p className="text-sm text-crewly-dim">No snapshot found for this employee and month.</p>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg bg-white/5 p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Gross salary</p>
              <p className="text-sm font-semibold">{formatMoney(totals.gross)}</p>
            </div>
            <div className="rounded-lg bg-white/5 p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Net salary</p>
              <p className="text-sm font-semibold text-emerald-300">{formatMoney(totals.netPay)}</p>
            </div>
            <div className="rounded-lg bg-white/5 p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Deductions</p>
              <p className="text-sm font-semibold text-red-300">{formatMoney(totals.totalDeductions)}</p>
            </div>
            <div className="rounded-lg bg-white/5 p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Employer cost</p>
              <p className="text-sm font-semibold">{formatMoney(totals.employerCost)}</p>
            </div>
          </div>

          {/* §18 / §24 — attendance summary */}
          <section>
            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-crewly-dim">
              Attendance
            </h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {[
                ['Working days', attendance.workingDays],
                ['Paid days', attendance.paidDays],
                ['Present', attendance.presentDays],
                ['LOP', attendance.lopDays],
                ['Paid leave', attendance.paidLeaveDays],
                ['OT hours', attendance.otHours],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-white/5 p-2">
                  <p className="text-[11px] uppercase text-crewly-dim">{label}</p>
                  <p className="text-sm font-semibold">{formatNumber(value)}</p>
                </div>
              ))}
            </div>
          </section>

          <Section title="Earnings" rows={data.earnings} total={totals.gross} />
          <Section title="Variable earnings" rows={data.variableEarnings} total={totals.variableEarnings} />
          {Number(totals.overtime) > 0 ? (
            <Section
              title={`Overtime (${formatNumber(data.overtime?.hours)} h × ${formatMoney(data.overtime?.rate)})`}
              rows={[{ name: 'Overtime pay', amount: data.overtime?.amount }]}
              total={totals.overtime}
            />
          ) : null}
          <Section title="Reimbursements (approved)" rows={data.reimbursements} total={totals.reimbursements} />
          <Section title="Deductions" rows={data.deductions} total={totals.totalDeductions} tone="bad" />
          <Section
            title="Employer contributions (do not reduce net pay)"
            rows={data.employerContributions}
            total={totals.employerCost}
          />

          {Number(totals.ctc) > 0 ? (
            <p className="text-xs text-crewly-dim">
              Cost to company for the month: {formatMoney(totals.ctc)}. Structure:{' '}
              {data.structureName || '—'}. Snapshot version {formatNumber(data.version)}.
            </p>
          ) : null}

          {data.warnings?.length ? (
            <div className="rounded-lg border-l-4 border-amber-500 bg-amber-500/5 p-3 text-sm">
              <p className="font-semibold text-amber-200">Calculation warnings</p>
              <ul className="mt-1 list-disc pl-5 text-crewly-dim">
                {data.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {canRecalculate ? (
            <div className="flex justify-end">
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => {
                  onRecalculate([employeeId]);
                  onClose();
                }}
              >
                <RefreshCw size={15} /> Recalculate this employee
              </button>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────
// §22 — error report
// ─────────────────────────────────────────────────────────────
const ErrorReportModal = ({ month, results, onClose }) => {
  const failed = results.filter((row) => row.status === 'ERROR');

  return (
    <Modal title={`Payroll error report · ${formatMonth(month)}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <p className="text-crewly-dim">
          {failed.length === 0
            ? 'Every employee was calculated successfully.'
            : `${failed.length} employee(s) could not be calculated. They were skipped — the rest of the month completed normally.`}
        </p>

        <div className="max-h-80 overflow-y-auto rounded-lg border border-white/5">
          <table className="w-full text-left text-xs">
            <thead className="bg-white/5 uppercase tracking-wide text-crewly-dim">
              <tr>
                <th className="px-2 py-1">Employee</th>
                <th className="px-2 py-1">Reason</th>
              </tr>
            </thead>
            <tbody>
              {failed.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-2 py-6 text-center text-crewly-dim">
                    No errors.
                  </td>
                </tr>
              ) : (
                failed.map((row) => (
                  <tr key={row._id} className="border-t border-white/5">
                    <td className="px-2 py-1">
                      {row.employeeName || row.employeeId} ({row.employeeCode || '—'})
                    </td>
                    <td className="px-2 py-1 text-red-300">{(row.issues || []).join(' · ')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
};

export default RunPayrollPage;
