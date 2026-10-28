/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Coins,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Users,
  Wallet,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import payrollRunService from '../../services/payrollRunService.js';
import { notify } from '../../utils/notify.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';
import {
  Avatar,
  CheckRow,
  Panel,
  Pipeline,
  StageBand,
  StageButton,
  StatCard,
  Td,
  Th,
} from '../../components/payroll/PayrollCockpit.jsx';

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

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

const RunPayrollPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();

  const canRead = hasAnyPermission(['PAYROLL_RUN_READ', 'PAYROLL_RUN_PREPARE', 'PAYROLL_RUN_EXECUTE']);
  const canRun = hasAnyPermission(['PAYROLL_RUN_EXECUTE']);
  const canRecalculate = hasAnyPermission(['PAYROLL_RUN_RECALCULATE']);

  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const [run, setRun] = useState(null);
  const [summary, setSummary] = useState({});
  const [results, setResults] = useState([]);
  const [periodStatus, setPeriodStatus] = useState('');
  const [filters, setFilters] = useState({ status: 'ALL', search: '' });
  const [page, setPage] = useState(1);
  const [detailEmployeeId, setDetailEmployeeId] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);

  const pollRef = useRef(null);

  /*
   * 35.1 — feedback is a toast now. The signature is unchanged so every call
   * site keeps working; only the destination moved (out of the page flow and
   * into the app-wide stack).
   */
  /*
   * 35.1 — feedback is a toast now. The signature is unchanged so every call
   * site keeps working; only the destination moved (out of the page flow and
   * into the app-wide stack).
   */
  const flash = useCallback((type, text) => {
    const body = typeof text === 'string' && text ? text : '';

    if (!body) return;

    const kind = String(type).toLowerCase();

    if (kind === 'error' || kind === 'danger' || kind === 'failed') notify.error(body);
    else if (kind === 'warning' || kind === 'warn') notify.warning(body);
    else if (kind === 'info') notify.info(body);
    else notify.success(body);
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
      setResults(Array.isArray(resultsResponse) ? resultsResponse : resultsResponse?.data || []);
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
        const list = Array.isArray(response) ? response : response?.data || [];
        const found = list.find((row) => row.month === month);
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

  /*
   * The one-line statutory summary the cockpit table prints under Deductions.
   * It is the same deduction lines the drawer lists, folded by their statutory
   * code — PF / ESI / PT / TDS — so the table and the drawer can never disagree.
   */
  const deductionLine = (row) => {
    const parts = [];
    (row.deductions || []).forEach((line) => {
      const amount = Number(line.amount || 0);
      if (!amount) return;
      const code = String(line.statutory || line.code || '').toUpperCase();
      const label = code === 'PROFESSIONAL_TAX' ? 'PT' : code;
      if (!['PF', 'ESI', 'PT', 'TDS'].includes(label)) return;
      parts.push(`${label} ${Math.round(amount / 100) / 10}k`);
    });
    return parts.join(' | ');
  };

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="st-surface min-h-screen space-y-4">
        <StageBand eyebrow="Cycle stage 02 of 04" title="Payroll calculation cockpit" />
        <Panel title="Payroll access required">
          <div className="p-4 text-sm text-st-on-variant">
            You don&apos;t have permission to view payroll calculations. Contact your Company Admin
            or Payroll Administrator.
          </div>
        </Panel>
      </div>
    );
  }

  const progress = run?.progress || {};
  const PAGE_SIZE = 6;
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const calculatedCount = Number(summary.calculated || 0);
  const totalCount = Number(summary.totalEmployees || 0);

  /*
   * The statutory split is summed from what the engine wrote on each result —
   * `deductions[].statutory` is PF / ESI / PT / TDS, the codes the engine uses.
   * Nothing here estimates a rate; an employee with no snapshot contributes 0.
   */
  const statutorySplit = results.reduce(
    (totals, row) => {
      (row.deductions || []).forEach((line) => {
        const key = String(line.statutory || '').toUpperCase();
        if (key === 'PF') totals.pf += Number(line.amount || 0);
        else if (key === 'ESI') totals.esi += Number(line.amount || 0);
        else if (key === 'PT') totals.pt += Number(line.amount || 0);
        else if (key === 'TDS') totals.tds += Number(line.amount || 0);
      });
      return totals;
    },
    { pf: 0, esi: 0, pt: 0, tds: 0 },
  );

  const netPay = Number(summary.netPayroll || 0);
  const employerCost = Number(summary.employerCost || 0);
  const allocation = [
    { label: 'Net pay', amount: netPay, className: 'bg-st-primary-container' },
    { label: 'Retirals & employer', amount: employerCost, className: 'bg-st-secondary' },
    { label: 'TDS & PT', amount: statutorySplit.tds + statutorySplit.pt, className: 'bg-st-tertiary' },
  ];
  const allocationTotal = allocation.reduce((sum, band) => sum + band.amount, 0) || 1;

  const flaggedRows = results.filter((row) => (row.warnings || []).length > 0 || (row.issues || []).length > 0);

  return (
    <div className="space-y-3">
      <StageBand
        eyebrow={`Cycle ${formatMonth(month)}${
          run?.version ? ` · snapshot v${run.version}${run.finishedAt ? ` · calculated ${formatDate(run.finishedAt)}` : ''}` : ' · no snapshot yet'
        }`}
        title="Payroll calculation cockpit"
        description="Calculate the month from what is already configured: salary structure, attendance, leave and the locked monthly inputs. This page calculates only — it never approves, pays or produces a bank file."
        pills={[
          {
            label: `engine ${String(run?.status || 'not run').replace(/_/g, ' ').toLowerCase()}`,
            tone: run?.status === 'ERROR' ? 'bad' : run?.status ? 'good' : 'default',
            title: 'Status of the payroll run stored for this month',
          },
          {
            label: inputsLocked ? 'inputs locked' : 'inputs open',
            tone: inputsLocked ? 'good' : 'warn',
            title: 'The engine refuses to run while monthly inputs are open',
          },
          ...(run?.runCount ? [{ label: `run #${run.runCount}`, tone: 'default' }] : []),
        ]}
        aside={
          <label className="flex items-center gap-2 text-[11px] font-semibold text-st-on-variant">
            <span className="uppercase tracking-wide">Payroll month</span>
            <input
              type="month"
              value={month}
              onChange={(event) => {
                setMonth(event.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-st-outline-variant/70 bg-st-lowest px-2 py-1.5 text-[11px] font-semibold text-st-on"
            />
          </label>
        }
        actions={
          <>
            <StageButton
              variant="primary"
              icon={Play}
              disabled={busy || !canRun || calculating}
              onClick={() => setConfirmRun(true)}
            >
              {run?.runCount > 0 ? 'Run payroll again' : 'Run payroll engine'}
            </StageButton>
            <StageButton
              icon={RefreshCw}
              disabled={busy || !canRecalculate || !run || calculating}
              onClick={() => handleRecalculate()}
            >
              Recalculate month
            </StageButton>
            <StageButton
              icon={Ban}
              disabled={busy || !canRun || !calculating}
              onClick={handleCancel}
            >
              Cancel run
            </StageButton>
            <StageButton icon={AlertTriangle} onClick={() => setReportOpen(true)} disabled={!summary.errors}>
              Audit &amp; exceptions{summary.errors ? ` (${summary.errors})` : ''}
            </StageButton>
            <Link
              to="/app/payroll/components"
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-[12px] font-semibold text-st-primary hover:bg-st-low"
            >
              <FileText aria-hidden="true" size={13} /> Structures &amp; rules used
            </Link>
          </>
        }
      />

      {/* §6 / §29 — the pre-check is stated before anyone presses Run. */}
      {!inputsLocked ? (
        <div className="flex items-start gap-2 rounded-xl border-l-4 border-st-primary-container bg-st-lowest px-3 py-2 shadow-sm">
          <AlertTriangle size={14} className="mt-0.5 text-st-primary" />
          <p className="text-[11px] leading-snug text-st-on-variant">
            <span className="font-semibold text-st-on">
              Monthly inputs for {formatMonth(month)} are not locked.
            </span>{' '}
            The engine refuses to run while the month is open — lock it in{' '}
            <Link className="font-semibold text-st-primary hover:underline" to="/app/payroll/inputs">
              Monthly payroll inputs
            </Link>{' '}
            first.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border-l-4 border-st-secondary bg-st-lowest px-3 py-2 shadow-sm">
          <CheckCircle2 size={14} className="text-st-secondary" />
          <p className="text-[11px] leading-snug text-st-on-variant">
            <span className="font-semibold text-st-on">Inputs verified &amp; locked.</span> The engine
            will compute base pay, statutory withholdings (PF, ESI, PT, TDS), overtime and LOP
            against the saved structures for {formatMonth(month)}.
          </p>
          <Link
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/70 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low"
            to="/app/payroll/inputs"
          >
            Audit input ledger
          </Link>
        </div>
      )}

      <Pipeline
        steps={[
          { key: 'inputs', index: '01', label: 'Monthly inputs', hint: 'Locked & verified', state: inputsLocked ? 'done' : 'active' },
          {
            key: 'run',
            index: '02',
            label: 'Run payroll',
            hint: 'Calculation cockpit',
            state: calculating ? 'active' : run?.summary ? 'done' : inputsLocked ? 'active' : 'locked',
          },
          { key: 'review', index: '03', label: 'Review & approval', hint: 'Audit & sign-off', state: run?.summary ? 'active' : 'locked' },
          { key: 'payment', index: '04', label: 'Salary payment', hint: 'Bank file & release', state: 'locked' },
        ]}
        footnote="A recalculation writes a new immutable snapshot version; the previous version stays readable."
      />

      {calculating ? (
        <div className="space-y-1.5 rounded-2xl bg-st-lowest p-3 shadow-sm">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-st-on">
              Calculating · {formatNumber(progress.processed)} / {formatNumber(progress.total)} employees
            </span>
            <span className="tabular-nums text-st-on-variant">{formatNumber(progress.percent)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-st-high">
            <div
              className="h-full rounded-full bg-st-primary-container transition-all"
              style={{ width: `${Math.min(100, Number(progress.percent) || 0)}%` }}
            />
          </div>
          <p className="text-[10px] text-st-on-variant">
            Current employee: {progress.currentEmployeeName || '—'}. You can leave this page — the job
            continues in the background worker.
          </p>
        </div>
      ) : null}

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={Users}
          label="Scope coverage"
          value={formatNumber(totalCount)}
          hint="Active payroll population"
        />
        <StatCard
          icon={CheckCircle2}
          label="Compute status"
          value={`${formatNumber(calculatedCount)} / ${formatNumber(totalCount)}`}
          tone={totalCount && calculatedCount === totalCount ? 'good' : 'default'}
          hint="Snapshots written this version"
        />
        <StatCard
          icon={AlertTriangle}
          label="Audit validation"
          value={`${formatNumber(summary.errors)} error(s)`}
          tone={summary.errors ? 'bad' : 'good'}
          hint="Employees the engine could not price"
        />
        <StatCard
          icon={Wallet}
          label="Gross earnings"
          value={formatMoney(summary.grossPayroll)}
          hint={`${formatMoney(summary.totalReimbursements)} reimbursed`}
        />
        <StatCard
          icon={Coins}
          label="Net disbursable"
          value={formatMoney(summary.netPayroll)}
          hint={`${formatMoney(summary.totalDeductions)} deducted`}
        />
        <StatCard
          icon={Building2}
          label="Employer overhead"
          value={formatMoney(summary.employerCost)}
          hint="PF, ESI & gratuity — never reduces net pay"
        />
      </div>

      <Panel
        title="Employee payroll results"
        subtitle={`${formatNumber(visible.length)} snapshot(s) · ${
          run?.version ? `version v${run.version}` : 'not calculated yet'
        }`}
        right={
          <span className="text-[10px] text-st-on-variant">
            {formatNumber(calculatedCount)} calculated · {formatNumber(summary.errors)} error
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 border-t border-st-high px-3 py-2">
          <input
            className="min-w-[10rem] flex-1 rounded-lg border border-st-outline-variant/60 bg-st-lowest px-2.5 py-1.5 text-[11px] text-st-on placeholder:text-st-on-variant/70"
            placeholder="Search employee name or code"
            value={filters.search}
            onChange={(event) => {
              setFilters({ ...filters, search: event.target.value });
              setPage(1);
            }}
          />
          <select
            className="rounded-lg border border-st-outline-variant/60 bg-st-lowest px-2 py-1.5 text-[11px] font-semibold text-st-on"
            value={filters.status}
            onChange={(event) => {
              setFilters({ ...filters, status: event.target.value });
              setPage(1);
            }}
          >
            <option value="ALL">All results</option>
            <option value="CALCULATED">Calculated</option>
            <option value="ERROR">Errors</option>
          </select>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1.5 text-[11px] font-semibold text-st-on hover:bg-st-low disabled:opacity-50"
            onClick={() => setReportOpen(true)}
            disabled={!summary.errors}
          >
            <AlertTriangle aria-hidden="true" size={12} /> Exception report
          </button>
        </div>

        <div className="overflow-x-auto border-t border-st-high">
          <table className="w-full text-left">
            <thead className="bg-st-low/70">
              <tr>
                <Th>Employee profile</Th>
                <Th>Paid / total days</Th>
                <Th>LOP docked</Th>
                <Th>Base gross</Th>
                <Th>Variable</Th>
                <Th>Reimb.</Th>
                <Th>Deductions</Th>
                <Th>Net payable</Th>
                <Th>Status</Th>
                <Th className="text-right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-3 py-10 text-center text-st-on-variant">
                    <Loader2 className="mx-auto animate-spin" size={16} />
                  </td>
                </tr>
              ) : pageRows.length === 0 ? (
                <TableEmpty
                  colSpan={10}
                  illustration="wallet"
                  title={`No payroll results for ${formatMonth(month)} yet`}
                  description="Run payroll to calculate the month — each employee lands here with their gross, deductions, net and any blocking error."
                />
              ) : (
                pageRows.map((row) => (
                  <tr key={row._id} className="border-t border-st-high/70 hover:bg-st-low/50">
                    <Td>
                      <div className="flex items-start gap-2">
                        <Avatar name={row.employeeName} />
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-st-on">{row.employeeName}</p>
                          <p className="truncate text-[10px] text-st-on-variant">
                            {row.employeeCode}
                            {row.designation ? ` · ${row.designation}` : ''}
                          </p>
                        </div>
                      </div>
                    </Td>
                    <Td className="tabular-nums">
                      {formatNumber(row.attendance?.paidDays)} / {formatNumber(row.attendance?.workingDays)}
                    </Td>
                    <Td>
                      <span className="tabular-nums">{formatNumber(row.lop?.days ?? row.attendance?.lopDays)} d</span>
                      {Number(row.lop?.amount) > 0 ? (
                        <span className="block text-[9px] text-st-on-variant">
                          −{formatMoney(row.lop.amount)}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="tabular-nums">{formatMoney(row.totals?.gross)}</Td>
                    <Td className="tabular-nums">
                      {Number(row.totals?.variableEarnings) > 0 ? (
                        <span className="text-st-secondary">+{formatMoney(row.totals?.variableEarnings)}</span>
                      ) : (
                        formatMoney(0)
                      )}
                    </Td>
                    <Td className="tabular-nums">{formatMoney(row.totals?.reimbursements)}</Td>
                    <Td>
                      <span className="tabular-nums font-semibold">−{formatMoney(row.totals?.totalDeductions)}</span>
                      {deductionLine(row) ? (
                        <span className="block text-[9px] text-st-on-variant">{deductionLine(row)}</span>
                      ) : null}
                    </Td>
                    <Td className="tabular-nums font-bold text-st-on">{formatMoney(row.totals?.netPay)}</Td>
                    <Td>
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wide ${
                          row.status === 'ERROR' ? 'text-st-error' : 'text-st-secondary'
                        }`}
                      >
                        {row.status === 'ERROR' ? 'error' : 'calculated'}
                      </span>
                      {row.warnings?.length ? (
                        <span className="block text-[9px] text-st-on-variant">
                          {row.warnings.length} warning(s)
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-right">
                      {row.status === 'ERROR' ? (
                        <button
                          type="button"
                          className="rounded-lg px-2 py-1 text-[10px] font-semibold text-st-error hover:bg-st-low"
                          onClick={() => setReportOpen(true)}
                        >
                          See why
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            className="rounded-lg px-2 py-1 text-[10px] font-semibold text-st-primary hover:bg-st-low"
                            onClick={() => setDetailEmployeeId(row.employeeId)}
                          >
                            Breakdown
                          </button>
                          {canRecalculate ? (
                            <button
                              type="button"
                              title="Recalculate only this employee"
                              className="rounded-lg px-1.5 py-1 text-st-on-variant hover:bg-st-low"
                              disabled={busy}
                              onClick={() => handleRecalculate([row.employeeId])}
                            >
                              <RefreshCw aria-hidden="true" size={11} />
                            </button>
                          ) : null}
                        </span>
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-st-high px-3 py-2 text-[10px] text-st-on-variant">
          <span>
            Page {currentPage} of {pageCount} · {formatNumber(visible.length)} result(s)
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded-md px-2 py-1 font-semibold text-st-on hover:bg-st-low disabled:opacity-40"
              disabled={currentPage <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft aria-hidden="true" size={12} />
            </button>
            <span className="rounded-md bg-st-primary-container px-2 py-1 font-bold text-st-on-primary-container">
              {currentPage}
            </span>
            <button
              type="button"
              className="rounded-md px-2 py-1 font-semibold text-st-on hover:bg-st-low disabled:opacity-40"
              disabled={currentPage >= pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            >
              <ChevronRight aria-hidden="true" size={12} />
            </button>
          </div>
        </div>
      </Panel>

      <div className="grid gap-2.5 lg:grid-cols-2">
        <Panel title="Payroll allocation" subtitle="Where this month's money goes, from the snapshots">
          <div className="space-y-2 px-4 pb-3">
            <div className="flex h-2 overflow-hidden rounded-full bg-st-container">
              {allocation.map((band) => (
                <span
                  key={band.label}
                  title={`${band.label}: ${formatMoney(band.amount)}`}
                  style={{ width: `${Math.round((band.amount / allocationTotal) * 100)}%` }}
                  className={band.className}
                />
              ))}
            </div>
            <div className="flex items-center justify-between text-[10px] font-semibold text-st-on">
              <span>Total {formatMoney(allocationTotal)}</span>
              <span className="text-st-on-variant">net + employer cost + tax</span>
            </div>
            {allocation.map((band) => (
              <div key={band.label} className="flex items-center justify-between text-[10px]">
                <span className="text-st-on-variant">
                  <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${band.className}`} />
                  {band.label}
                </span>
                <span className="font-semibold tabular-nums text-st-on">
                  {formatMoney(band.amount)} · {Math.round((band.amount / allocationTotal) * 100)}%
                </span>
              </div>
            ))}
            <p className="pt-1 text-[9px] leading-snug text-st-on-variant">
              Statutory split read from each snapshot&apos;s deduction lines: PF {formatMoney(statutorySplit.pf)},
              ESI {formatMoney(statutorySplit.esi)}, PT {formatMoney(statutorySplit.pt)}, TDS{' '}
              {formatMoney(statutorySplit.tds)}.
            </p>
          </div>
        </Panel>

        <Panel title="Calculation health check" subtitle="What the engine did and did not price">
          <div className="space-y-1 px-4 pb-3">
            <CheckRow
              ok={Boolean(totalCount) && calculatedCount === totalCount}
              label="Every employee in scope produced a snapshot"
              value={`${formatNumber(calculatedCount)} of ${formatNumber(totalCount)}`}
            />
            <CheckRow
              ok={!summary.errors}
              label="Blocking errors"
              value={formatNumber(summary.errors)}
            />
            <CheckRow
              ok={!flaggedRows.length}
              label="Snapshots carrying a warning"
              value={formatNumber(flaggedRows.length)}
            />
            <CheckRow
              ok={inputsLocked}
              label="Inputs locked at calculation time"
              value={inputsLocked ? 'yes' : 'no'}
            />
            <p className="pt-1 text-[9px] leading-snug text-st-on-variant">
              This is a structural check of the calculation, not a legal opinion. Statutory amounts
              come from the rule set stored in Salary architecture; a change there applies to the
              next recalculation, never to an existing snapshot.
            </p>
          </div>
        </Panel>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-st-lowest px-4 py-3 shadow-sm">
        <p className="text-[11px] text-st-on-variant">
          {run?.summary
            ? `${formatNumber(calculatedCount)} employee snapshot(s) computed · version v${formatNumber(run.version)} · results are immutable`
            : 'No snapshot for this month yet — running payroll writes one version per employee.'}
        </p>
        <div className="flex items-center gap-2">
          <Link
            to="/app/payroll/inputs"
            className="rounded-lg border border-st-outline-variant/70 px-3 py-1.5 text-[11px] font-semibold text-st-on hover:bg-st-low"
          >
            ← Back to inputs
          </Link>
          <Link
            to="/app/payroll/review"
            className="rounded-lg bg-st-primary-container px-3 py-1.5 text-[11px] font-bold text-st-on-primary-container hover:brightness-105"
          >
            Proceed to review &amp; approval →
          </Link>
        </div>
      </div>

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
            <tr key={`${row.code || row.type || row.name}-${index}`} className="border-t border-crewly-hairline">
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
        if (active) setData(response?.data ?? response ?? null);
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
            <div className="rounded-lg bg-crewly-inset p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Gross salary</p>
              <p className="text-sm font-semibold">{formatMoney(totals.gross)}</p>
            </div>
            <div className="rounded-lg bg-crewly-inset p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Net salary</p>
              <p className="text-sm font-semibold text-emerald-300">{formatMoney(totals.netPay)}</p>
            </div>
            <div className="rounded-lg bg-crewly-inset p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Deductions</p>
              <p className="text-sm font-semibold text-red-300">{formatMoney(totals.totalDeductions)}</p>
            </div>
            <div className="rounded-lg bg-crewly-inset p-3">
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
                <div key={label} className="rounded-lg bg-crewly-inset p-2">
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

        <div className="max-h-80 overflow-y-auto rounded-lg border border-crewly-hairline">
          <table className="w-full text-left text-xs">
            <thead className="bg-crewly-inset uppercase tracking-wide text-crewly-dim">
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
                  <tr key={row._id} className="border-t border-crewly-hairline">
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
