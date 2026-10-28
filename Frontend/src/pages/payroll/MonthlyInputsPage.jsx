/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CalendarX,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Unlock,
  Upload,
  Users,
  Wallet,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import departmentService from '../../services/departmentService.js';
import monthlyInputService, { downloadImportTemplate } from '../../services/monthlyInputService.js';
import { notify } from '../../utils/notify.js';
import EmptyState, { TableEmpty } from '../../components/common/EmptyState.jsx';
import {
  Avatar,
  CheckRow,
  Fact,
  Panel,
  Pipeline,
  Pill,
  Rail,
  StageBand,
  StageButton,
  StatCard,
  Td,
  Th,
} from '../../components/payroll/PayrollCockpit.jsx';

// ─────────────────────────────────────────────────────────────
// Phase 29.5 — Monthly Payroll Inputs
//
//  The workspace HR works in every month, between attendance and
//  the 29.6 payroll engine. Sections in this file:
//    1. Payroll month dashboard   (§25 KPI cards + period status)
//    2. Employee input table      (§18 search / filter / sort)
//    3. Employee input drawer     (§13: auto figures + variable pay)
//    4. Bulk import               (§11 preview → confirm)
//    5. Validation report         (§19)
//
//  No salary is ever calculated here — the engine (29.6) owns that.
//  The server is always the authority: this file only renders.
// ─────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'READY', label: 'Ready' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'ERROR', label: 'Errors' },
  { value: 'LOCKED', label: 'Locked' },
];

const currentMonth = () => new Date().toISOString().slice(0, 7);

const formatMoney = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;

const formatNumber = (value) => Number(value || 0).toLocaleString('en-IN');

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

const formatMonth = (month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return month || '—';
  const [year, part] = String(month).split('-');
  const label = new Date(Number(year), Number(part) - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
  return label;
};

// §6 — Indian financial year, 1 April to 31 March (display only; the backend
// stores the authoritative value on the period).
const financialYearOf = (month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return '—';
  const [year, part] = String(month).split('-').map(Number);
  const startYear = part >= 4 ? year : year - 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const MonthlyInputsPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();

  const canRead = hasAnyPermission(['PAYROLL_INPUT_READ', 'PAYROLL_INPUT_MANAGE', 'PAYROLL_INPUT_LOCK']);
  const canManage = hasAnyPermission(['PAYROLL_INPUT_MANAGE']);
  const canLock = hasAnyPermission(['PAYROLL_INPUT_LOCK', 'PAYROLL_INPUT_MANAGE']);

  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const [rows, setRows] = useState([]);
  const [period, setPeriod] = useState(null);
  const [summary, setSummary] = useState({});
  const [entryTypes, setEntryTypes] = useState([]);
  const [bulkActions, setBulkActions] = useState([]);

  const [departments, setDepartments] = useState([]);
  const [filters, setFilters] = useState({ search: '', status: 'ALL', department: 'ALL' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState([]);
  const [drawerEmployeeId, setDrawerEmployeeId] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);

  const departmentName = (id) => {
    if (!id) return '';
    const found = departments.find((row) => String(row._id || row.id) === String(id));
    return found?.name || '';
  };

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
    setLoading(true);
    try {
      const data = await monthlyInputService.list({ month });
      setRows(data?.data ?? data ?? []);
      setPeriod(data?.meta?.period || null);
      setSummary(data?.meta?.summary || {});
      setEntryTypes(data?.meta?.entryTypes || []);
      setBulkActions(data?.meta?.bulkActions || []);
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403 || error?.code === 'PAYROLL_ACCESS_DENIED') setAccessDenied(true);
      else flash('error', error?.message || 'Unable to load monthly payroll inputs');
    } finally {
      setLoading(false);
    }
  }, [month, flash]);

  useEffect(() => {
    if (!permsLoading && canRead) load();
    if (!permsLoading && !canRead) setLoading(false);
  }, [permsLoading, canRead, load]);

  // §9 — the table shows the department name; the master is tiny and cached
  // by the browser, so it is fetched once.
  useEffect(() => {
    if (!permsLoading || !canRead) return;
    departmentService
      .getAll()
      .then((response) => setDepartments(Array.isArray(response) ? response : response?.data || []))
      .catch(() => setDepartments([]));
  }, [permsLoading, canRead]);

  const locked = ['LOCKED', 'SENT_TO_PAYROLL'].includes(period?.status);

  const visible = useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filters.status !== 'ALL' && row.status !== filters.status) return false;
      if (filters.department !== 'ALL' && String(row.departmentId || '') !== String(filters.department)) {
        return false;
      }
      if (!needle) return true;
      return [row.employeeName, row.employeeCode, row.email]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, filters]);

  /*
   * Everything below is arithmetic on the response, never a new fact:
   *   readiness      = ready ÷ population, the same two numbers the KPI row shows
   *   claimsVerified = reimbursement entries the month holds, minus the pending ones
   *   finalizedCount = rows whose LOP came from a finalized attendance version
   *   variableMix    = this month's entries summed by category
   * The export printed a scored "input health" ring and a device-sync badge;
   * neither has a source here, so these are the honest equivalents: a ratio of
   * two numbers the API already returned, and the count of rows whose
   * attendance actually came from a finalized period.
   */
  const readiness = Number(summary.employees)
    ? Math.round((Number(summary.ready || 0) / Number(summary.employees)) * 100)
    : null;

  const claimEntries = rows.flatMap((row) =>
    (row.entries || []).filter((entry) => String(entry.type || '').startsWith('REIMBURSEMENT_')),
  );
  const claimsVerified = Math.max(0, claimEntries.length - Number(summary.claimsPending || 0));

  const finalizedCount = rows.filter((row) => Boolean(row.auto?.attendanceSource?.version)).length;

  const variableMix = useMemo(() => {
    const bands = [
      { key: 'BONUS', label: 'Bonus', className: 'bg-st-primary-container' },
      { key: 'INCENTIVE', label: 'Incentive', className: 'bg-st-secondary' },
      { key: 'COMMISSION', label: 'Commission', className: 'bg-st-tertiary' },
    ];
    const amounts = Object.fromEntries(bands.map((band) => [band.key, 0]));

    rows.forEach((row) => {
      (row.entries || []).forEach((entry) => {
        const type = String(entry.type || '');
        if (type.startsWith('BONUS_')) amounts.BONUS += Number(entry.amount || 0);
        else if (type === 'INCENTIVE') amounts.INCENTIVE += Number(entry.amount || 0);
        else if (type === 'COMMISSION_SALES') amounts.COMMISSION += Number(entry.amount || 0);
      });
    });

    const total = Object.values(amounts).reduce((sum, value) => sum + value, 0);
    return {
      total,
      bands: bands.map((band) => ({
        ...band,
        amount: Math.round(amounts[band.key] * 100) / 100,
        percent: total ? Math.round((amounts[band.key] / total) * 100) : 0,
      })),
    };
  }, [rows]);

const statusTone = (status) =>
  status === 'READY'
    ? 'text-st-secondary'
    : status === 'ERROR'
      ? 'text-st-error'
      : status === 'LOCKED'
        ? 'text-st-primary'
        : 'text-st-on-variant';

  const run = async (action, successMessage) => {
    setSaving(true);
    try {
      const data = await action();
      await load();
      flash('success', data?.message || successMessage);
      return true;
    } catch (error) {
      flash('error', error?.message || 'Something went wrong');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleImportAutomatic = () =>
    run(() => monthlyInputService.importAutomatic(month), 'Attendance and leave imported');

  const handleValidate = async () => {
    const data = await monthlyInputService.validate(month).catch((error) => {
      flash('error', error?.message || 'Validation failed');
      return null;
    });
    if (!data) return;
    await load();
    const { withErrors = 0, total = 0 } = data?.data ?? data ?? {};
    if (withErrors > 0) {
      setReportOpen(true);
      flash('error', `${withErrors} of ${total} employee(s) still have validation errors`);
    } else {
      flash('success', `All ${total} employee inputs validated`);
    }
  };

  const handleStatus = async (status) => {
    setConfirmLock(false);
    const ok = await run(
      () => monthlyInputService.setStatus(month, status),
      `Month moved to ${String(status || '').replace(/_/g, ' ').toLowerCase()}`,
    );
    if (ok) flash('success', `Month is now ${String(status || '').replace(/_/g, ' ').toLowerCase()}`);
  };

  const toggleRow = (employeeId) =>
    setSelected((current) =>
      current.includes(employeeId)
        ? current.filter((value) => value !== employeeId)
        : [...current, employeeId],
    );

  /*
   * The entry catalogue ships with the month (`meta.entryTypes`), so a line is
   * named the way the server names it and categorised the way the server
   * categorises it — no second vocabulary maintained in the browser.
   */
  const labelForType = (type) =>
    entryTypes.find((entry) => entry.value === type)?.label ||
    String(type || '')
      .replace(/_/g, ' ')
      .toLowerCase();

  const categoryForType = (type) => entryTypes.find((entry) => entry.value === type)?.category || '';

  /** The month's biggest variable line for this employee, named as the export names it. */
  const bonusLabel = (row) => {
    const lines = (row.entries || [])
      .filter((entry) => ['BONUS', 'INCENTIVE', 'COMMISSION'].includes(categoryForType(entry.type)))
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
    return lines.length ? labelForType(lines[0].type) : '';
  };

  const claimNote = (row) => {
    const claims = (row.entries || []).filter((entry) =>
      String(entry.type || '').startsWith('REIMBURSEMENT_'),
    );
    if (!claims.length) return '';
    const pending = claims.filter((entry) => (entry.claimStatus || 'APPROVED') === 'PENDING').length;
    return pending ? `${pending} awaiting a decision` : 'verified';
  };

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="st-surface min-h-screen space-y-4">
        <StageBand eyebrow="Cycle stage 01 of 04" title="Monthly payroll inputs" />
        <Panel title="Payroll access required">
          <div className="space-y-2 p-4 text-sm text-st-on-variant">
            <p>
              You don&apos;t have permission to view monthly payroll inputs. Contact your Company
              Admin or Payroll Administrator.
            </p>
          </div>
        </Panel>
      </div>
    );
  }

  const PAGE_SIZE = 8;
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // Clamp on read: filtering can leave the stored page past the last one.
  const currentPage = Math.min(page, pageCount);
  const pageRows = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="space-y-3">
      {/* ── the cycle stage, stated once ─────────────────────────────── */}
      <StageBand
        eyebrow={
          locked ? 'Cycle stage 01 of 04 · Inputs locked' : 'Cycle stage 01 of 04 · Locking required to advance'
        }
        title="Monthly payroll inputs"
        description="Variable pay, reimbursements and deductions for the month — the last editable stage before the engine calculates. Nothing on this page changes a salary structure."
        pills={[
          {
            label: String(period?.status || 'NOT_STARTED').replace(/_/g, ' ').toLowerCase(),
            tone: locked ? 'good' : 'accent',
            title: 'Status of the payroll period stored by Payroll Setup',
          },
          ...(period?.lockedAt
            ? [{ label: `locked ${formatDate(period.lockedAt)}`, tone: 'warn' }]
            : []),
          { label: formatMonth(month), tone: 'default' },
        ]}
        aside={
          <label className="flex items-center gap-2 text-[11px] font-semibold text-st-on-variant">
            <span className="uppercase tracking-wide">Payroll month</span>
            <input
              type="month"
              value={month}
              onChange={(event) => {
                setMonth(event.target.value);
                setSelected([]);
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
              icon={locked ? Unlock : Lock}
              disabled={saving || !canLock}
              onClick={() => (locked ? handleStatus('COLLECTING_INPUTS') : setConfirmLock(true))}
            >
              {locked ? 'Reopen month' : 'Validate & lock month'}
            </StageButton>
            <StageButton
              icon={RefreshCw}
              disabled={saving || locked}
              onClick={handleImportAutomatic}
              title="Re-import attendance and leave for the month from the attendance ledger"
            >
              Sync attendance &amp; leave
            </StageButton>
            <StageButton icon={FileSpreadsheet} disabled={locked} onClick={() => setImportOpen(true)}>
              Bulk CSV
            </StageButton>
            <StageButton
              icon={Users}
              disabled={!selected.length || locked}
              onClick={() => setBulkOpen(true)}
            >
              Bulk action{selected.length ? ` (${selected.length})` : ''}
            </StageButton>
            <StageButton icon={ShieldCheck} onClick={() => setReportOpen(true)}>
              Validation report{summary.error ? ` (${summary.error})` : ''}
            </StageButton>
            <StageButton variant="quiet" onClick={handleValidate} disabled={saving}>
              Re-validate month
            </StageButton>
          </>
        }
      />

      {/* ── where this month sits in the four stages ─────────────────── */}
      <Pipeline
        steps={[
          {
            key: 'inputs',
            index: '01',
            label: 'Monthly inputs',
            hint: 'Reimbursements, incentives & LOP',
            state: locked ? 'done' : 'active',
          },
          { key: 'run', index: '02', label: 'Run payroll', hint: 'Tax, PF, ESI & gross', state: locked ? 'active' : 'locked' },
          { key: 'review', index: '03', label: 'Review & approval', hint: 'Sign-off by finance', state: 'locked' },
          { key: 'payment', index: '04', label: 'Salary payment', hint: 'Bank file & release', state: 'locked' },
        ]}
        footnote="Stages 02–04 open from their own pages. Locking here is what lets the engine run."
      />

      {locked ? (
        <div className="flex items-start gap-2 rounded-xl border-l-4 border-st-primary-container bg-st-lowest px-3 py-2 text-[11px] shadow-sm">
          <Lock size={14} className="mt-0.5 text-st-primary" />
          <p className="text-st-on-variant">
            <span className="font-semibold text-st-on">{formatMonth(month)} is locked.</span> Inputs
            can&apos;t be added, edited or imported until it is reopened, and every reopen is written
            to the audit trail.
          </p>
        </div>
      ) : null}

      {/* ── the payroll month at a glance (29.1 owns these) ──────────── */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl bg-st-lowest px-4 py-3 text-[11px] shadow-sm">
        <span className="flex items-center gap-1.5 text-st-on-variant">
          <CalendarDays aria-hidden="true" size={13} />
          Payroll period
          <span className="font-semibold text-st-on">
            {formatMonth(month)} ({period?.financialYear || financialYearOf(month)})
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-st-on-variant">
          <CalendarRange aria-hidden="true" size={13} />
          Cycle window
          <span className="font-semibold text-st-on">
            {period?.cycleStart && period?.cycleEnd
              ? `${period.cycleStart} – ${period.cycleEnd}`
              : 'set in Company setup'}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-st-on-variant">
          <CalendarClock aria-hidden="true" size={13} />
          Company standard
          <span className="font-semibold text-st-on">{formatNumber(period?.workingDays)} working days</span>
        </span>
        <span className="ml-auto max-w-md text-[10px] leading-snug text-st-on-variant">
          Inputs are stored per month and per employee. Freezing them hands the exact numbers to the
          calculation engine — nothing is reinterpreted later.
        </span>
      </div>

      {/* ── the month in six numbers ─────────────────────────────────── */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={Users}
          label="Employees"
          value={formatNumber(summary.employees)}
          hint={`${formatMonth(month)} payroll population`}
        />
        <StatCard
          icon={CheckCircle2}
          label="Ready & clear"
          value={formatNumber(summary.ready)}
          tone="good"
          hint="Every component validated"
        />
        <StatCard
          icon={AlertTriangle}
          label="Needs review"
          value={formatNumber(summary.pending)}
          tone={summary.error > 0 ? 'bad' : 'default'}
          badge={summary.error ? { label: `${formatNumber(summary.error)} error`, tone: 'bad' } : undefined}
          hint={`${formatNumber(summary.claimsPending)} claim(s) unreviewed`}
        />
        <StatCard
          icon={Wallet}
          label="Variable pay"
          value={formatMoney(summary.totalBonus)}
          hint="Bonus, incentive, commission"
        />
        <StatCard
          icon={Upload}
          label="Claims total"
          value={formatMoney(summary.totalReimbursement)}
          hint={`${formatNumber(claimsVerified)} verified · ${formatNumber(summary.claimsPending)} pending`}
        />
        <StatCard
          icon={CalendarX}
          label="LOP days"
          value={formatNumber(summary.totalLopDays)}
          hint={`${formatNumber(summary.totalOtHours)} overtime hour(s)`}
        />
      </div>

      {/* ── the roster, and the context beside it ────────────────────── */}
      <div className="flex flex-col gap-3 xl:flex-row">
        <div className="min-w-0 flex-1 space-y-3">
          <Panel
            title="Employee inputs"
            subtitle={`Showing ${pageRows.length} of ${visible.length} employee(s) · ${formatNumber(period?.workingDays)} working-day base`}
            right={
              <div className="flex items-center gap-1.5 text-[10px] text-st-on-variant">
                <span className="font-semibold text-st-secondary">
                  {formatNumber(summary.ready)} ready
                </span>
                <span aria-hidden="true">•</span>
                <span className="font-semibold text-st-primary">
                  {formatNumber(summary.pending)} review
                </span>
              </div>
            }
          >
            <div className="flex flex-wrap items-center gap-1.5 border-t border-st-high px-3 py-2">
              <input
                className="min-w-[10rem] flex-1 rounded-lg border border-st-outline-variant/60 bg-st-lowest px-2.5 py-1.5 text-[11px] text-st-on placeholder:text-st-on-variant/70"
                placeholder="Search by name, code or email"
                value={filters.search}
                onChange={(event) => {
                  setFilters({ ...filters, search: event.target.value });
                  setPage(1);
                }}
              />
              <select
                className="rounded-lg border border-st-outline-variant/60 bg-st-lowest px-2 py-1.5 text-[11px] font-semibold text-st-on"
                value={filters.department}
                onChange={(event) => {
                  setFilters({ ...filters, department: event.target.value });
                  setPage(1);
                }}
              >
                <option value="ALL">All departments</option>
                {departments.map((row) => (
                  <option key={row._id || row.id} value={row._id || row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
              <select
                className="rounded-lg border border-st-outline-variant/60 bg-st-lowest px-2 py-1.5 text-[11px] font-semibold text-st-on"
                value={filters.status}
                onChange={(event) => {
                  setFilters({ ...filters, status: event.target.value });
                  setPage(1);
                }}
              >
                {STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1.5 text-[11px] font-semibold text-st-on hover:bg-st-low"
                onClick={() => setReportOpen(true)}
                title="Every employee with an open validation issue"
              >
                <ShieldCheck aria-hidden="true" size={12} /> Audit sheet
              </button>
            </div>

            <div className="overflow-x-auto border-t border-st-high">
              <table className="w-full text-left">
                <thead className="bg-st-low/70">
                  <tr>
                    <Th className="w-8">
                      <input
                        type="checkbox"
                        aria-label="Select every visible employee"
                        checked={Boolean(pageRows.length) && pageRows.every((row) => selected.includes(row.employeeId))}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? Array.from(new Set([...selected, ...pageRows.map((row) => row.employeeId)]))
                              : selected.filter((id) => !pageRows.some((row) => row.employeeId === id)),
                          )
                        }
                      />
                    </Th>
                    <Th>Employee details</Th>
                    <Th>Work days</Th>
                    <Th>LOP</Th>
                    <Th>Overtime</Th>
                    <Th>Variable / bonus</Th>
                    <Th>Reimbursements</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-10 text-center text-st-on-variant">
                        <Loader2 className="mx-auto animate-spin" size={16} />
                      </td>
                    </tr>
                  ) : pageRows.length === 0 ? (
                    <TableEmpty
                      colSpan={9}
                      illustration="calendar"
                      title={`No employee inputs for ${formatMonth(month)}`}
                      description="Import attendance and leave to build the month. Every employee's payable days, LOP and variable pay then appear here for review."
                    />
                  ) : (
                    pageRows.map((row) => (
                      <tr key={row._id} className="border-t border-st-high/70 hover:bg-st-low/50">
                        <Td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.employeeName}`}
                            checked={selected.includes(row.employeeId)}
                            onChange={() => toggleRow(row.employeeId)}
                          />
                        </Td>
                        <Td>
                          <div className="flex items-start gap-2">
                            <Avatar name={row.employeeName} />
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-st-on">{row.employeeName}</p>
                              <p className="truncate text-[10px] text-st-on-variant">
                                {row.employeeCode}
                                {row.designation ? ` · ${row.designation}` : ''}
                                {departmentName(row.departmentId) ? ` · ${departmentName(row.departmentId)}` : ''}
                              </p>
                            </div>
                          </div>
                        </Td>
                        <Td className="tabular-nums">
                          {formatNumber(row.auto?.workingDays || period?.workingDays)}
                        </Td>
                        <Td>
                          <span className="tabular-nums">{formatNumber(row.auto?.lopDays)}</span>
                          <span className="block text-[9px] text-st-on-variant">
                            {row.auto?.lopSource === 'LEAVE' ? 'synced leave' : 'attendance'}
                          </span>
                        </Td>
                        <Td className="tabular-nums">{formatNumber(row.auto?.otHours)} hrs</Td>
                        <Td>
                          <span className="tabular-nums font-semibold">{formatMoney(row.totals?.bonus)}</span>
                          {row.totals?.bonus > 0 ? (
                            <span className="block text-[9px] text-st-on-variant">{bonusLabel(row)}</span>
                          ) : null}
                        </Td>
                        <Td>
                          <span className="tabular-nums">{formatMoney(row.totals?.reimbursement)}</span>
                          {claimNote(row) ? (
                            <span className="block text-[9px] text-st-on-variant">{claimNote(row)}</span>
                          ) : null}
                        </Td>
                        <Td>
                          <span className={`text-[10px] font-bold uppercase tracking-wide ${statusTone(row.status)}`}>
                            {row.status === 'READY' ? 'Ready' : row.status === 'ERROR' ? 'Needs action' : String(row.status || 'pending').toLowerCase()}
                          </span>
                          {row.issues?.length ? (
                            <span className="block text-[9px] text-st-error">{row.issues.length} issue(s)</span>
                          ) : null}
                        </Td>
                        <Td className="text-right">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-st-primary hover:bg-st-low"
                            onClick={() => setDrawerEmployeeId(row.employeeId)}
                          >
                            {canManage && !locked ? 'Edit' : 'Review'}
                            <ChevronRight aria-hidden="true" size={11} />
                          </button>
                        </Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-st-high px-3 py-2 text-[10px] text-st-on-variant">
              <span>
                Page {currentPage} of {pageCount} · {formatNumber(visible.length)} employee(s) in this view
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

          {/* ── the three reads under the roster ─────────────────────── */}
          <div className="grid gap-2.5 lg:grid-cols-3">
            <Panel title="Variable pay distribution" subtitle="This month's entries by category">
              <div className="space-y-2 px-4 pb-3">
                {variableMix.total > 0 ? (
                  <>
                    <div className="flex h-2 overflow-hidden rounded-full bg-st-container">
                      {variableMix.bands.map((band) => (
                        <span
                          key={band.label}
                          title={`${band.label}: ${formatMoney(band.amount)}`}
                          style={{ width: `${band.percent}%` }}
                          className={band.className}
                        />
                      ))}
                    </div>
                    {variableMix.bands.map((band) => (
                      <div key={band.label} className="flex items-center justify-between text-[10px]">
                        <span className="text-st-on-variant">
                          <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${band.className}`} />
                          {band.label}
                        </span>
                        <span className="font-semibold text-st-on">
                          {formatMoney(band.amount)} · {band.percent}%
                        </span>
                      </div>
                    ))}
                  </>
                ) : (
                  <p className="text-[10px] leading-snug text-st-on-variant">
                    No variable pay entered for {formatMonth(month)} yet. Categories appear here as
                    soon as an employee has a bonus, incentive or commission line.
                  </p>
                )}
              </div>
            </Panel>

            <Panel title="Attendance & leave import" subtitle="What the last import wrote">
              <div className="space-y-1 px-4 pb-3">
                <CheckRow
                  ok={finalizedCount === rows.length && rows.length > 0}
                  label="Timecards from a finalized attendance period"
                  value={`${formatNumber(finalizedCount)} of ${formatNumber(rows.length)}`}
                />
                <CheckRow ok={Number(summary.totalLopDays) === 0} label="Unpaid days carried in" value={`${formatNumber(summary.totalLopDays)} days`} />
                <CheckRow ok={true} label="Overtime hours carried in" value={`${formatNumber(summary.totalOtHours)} hrs`} />
                <p className="pt-1 text-[9px] leading-snug text-st-on-variant">
                  Every figure is read from the attendance ledger; nothing is typed in by hand.
                </p>
              </div>
            </Panel>

            <Panel title="Statutory & deductions" subtitle="Calculated by the engine, not here">
              <div className="space-y-1 px-4 pb-3">
                <CheckRow ok={false} label="PF, ESI, PT and TDS" value="Stage 02" />
                <CheckRow ok={false} label="Recoveries entered here" value={formatMoney(summary.totalDeduction)} />
                <p className="pt-1 text-[9px] leading-snug text-st-on-variant">
                  Only the recoveries on this page flow through. Statutory amounts are computed when
                  payroll runs, against the saved salary structure.
                </p>
              </div>
            </Panel>
          </div>
        </div>

        {/* ── the rail ─────────────────────────────────────────────────── */}
        <Rail>
          <Panel
            title="Input readiness"
            subtitle="Validated in this browser, from the month's rows"
            right={
              <Pill tone={readiness === 100 ? 'good' : readiness >= 60 ? 'warn' : 'bad'}>
                {readiness === null ? '—' : `${readiness}%`}
              </Pill>
            }
          >
            <div className="px-4 pb-3">
              <div className="mb-3 flex items-center gap-3">
                <div
                  className="grid h-16 w-16 shrink-0 place-items-center rounded-full"
                  style={{
                    background: `conic-gradient(var(--color-st-primary-container) ${readiness || 0}%, var(--color-st-high) 0)`,
                  }}
                >
                  <div className="grid h-12 w-12 place-items-center rounded-full bg-st-lowest text-[13px] font-bold text-st-on">
                    {readiness === null ? '—' : `${readiness}%`}
                  </div>
                </div>
                <p className="text-[10px] leading-snug text-st-on-variant">
                  Ready employees ÷ population. An employee counts as ready only when every
                  component validates and none of their rows carry an issue.
                </p>
              </div>
              <CheckRow
                ok={finalizedCount === rows.length && rows.length > 0}
                label="Attendance matched"
                value={`${formatNumber(finalizedCount)}/${formatNumber(rows.length)}`}
              />
              <CheckRow
                ok={Number(summary.totalLopDays) === 0}
                label="LOP days factored"
                value={`${formatNumber(summary.totalLopDays)}`}
              />
              <CheckRow
                ok={!summary.claimsPending}
                label="Claims awaiting a decision"
                value={formatNumber(summary.claimsPending)}
              />
              <CheckRow
                ok={!summary.error}
                label="Blocking validation errors"
                value={formatNumber(summary.error)}
              />
              {summary.claimsPending ? (
                <button
                  type="button"
                  className="mt-2 w-full rounded-lg bg-st-primary-container px-3 py-2 text-[11px] font-bold text-st-on-primary-container hover:brightness-105"
                  onClick={() => {
                    setBulkOpen(true);
                  }}
                >
                  Open bulk action for {formatNumber(summary.claimsPending)} pending claim(s)
                </button>
              ) : null}
            </div>
          </Panel>

          <Panel title="Pre-lock checklist" subtitle="What locking will freeze">
            <div className="px-4 pb-3">
              <CheckRow
                ok={!summary.pending && !summary.error}
                label="Every employee validated"
                value={`${formatNumber(summary.ready)}/${formatNumber(summary.employees)}`}
              />
              <CheckRow
                ok={Number(summary.totalLopDays) === 0}
                label="Unpaid leave (LOP) verified"
                value={`${formatNumber(summary.totalLopDays)} days`}
              />
              <CheckRow
                ok={Number(summary.totalBonus) === 0}
                label="Variable incentives validated"
                value={formatMoney(summary.totalBonus)}
              />
              <CheckRow
                ok={!summary.claimsPending}
                label="Reimbursement invoices verified"
                value={`${formatNumber(claimsVerified)} of ${formatNumber(claimsVerified + Number(summary.claimsPending || 0))}`}
              />
              <p className="pt-2 text-[9px] leading-snug text-st-on-variant">
                Locking stops further variable submissions and authorises the engine to calculate{' '}
                {formatMonth(month)}. It is refused while any employee still has an error.
              </p>
            </div>
          </Panel>

          <Panel title="Payroll policy" subtitle="How this month is governed">
            <div className="space-y-1 px-4 pb-3 text-[10px] leading-snug text-st-on-variant">
              <Fact label="Payroll month" value={formatMonth(month)} />
              <Fact label="Financial year" value={period?.financialYear || financialYearOf(month)} />
              <Fact label="Working days" value={formatNumber(period?.workingDays)} />
              <Fact
                label="Locked at"
                value={period?.lockedAt ? formatDate(period.lockedAt) : 'not locked'}
              />
              <p className="pt-1">
                Cycle dates and working days come from Company setup. Changing them changes the base
                every employee is paid on, so they are edited there — not here.
              </p>
            </div>
          </Panel>
        </Rail>
      </div>

      <p className="px-1 text-[10px] text-st-on-variant">
        Variable pay never changes a salary structure — it is stored per month and consumed by the
        engine. Components and structures live in{' '}
        <Link className="font-semibold text-st-primary hover:underline" to="/app/payroll/components">
          Salary architecture
        </Link>
        .
      </p>

      {drawerEmployeeId ? (
        <EmployeeDrawer
          employeeId={drawerEmployeeId}
          month={month}
          entryTypes={entryTypes}
          locked={locked}
          canManage={canManage}
          onClose={() => setDrawerEmployeeId(null)}
          onChanged={() => load()}
          flash={flash}
        />
      ) : null}

      {importOpen ? (
        <BulkImportModal
          month={month}
          onClose={() => setImportOpen(false)}
          onDone={async () => {
            setImportOpen(false);
            await load();
          }}
          flash={flash}
        />
      ) : null}

      {bulkOpen ? (
        <BulkActionModal
          month={month}
          actions={bulkActions}
          employees={rows.filter((row) => selected.includes(row.employeeId))}
          onClose={() => setBulkOpen(false)}
          onDone={async () => {
            setBulkOpen(false);
            setSelected([]);
            await load();
          }}
          flash={flash}
        />
      ) : null}

      {reportOpen ? (
        <ValidationReportModal
          month={month}
          rows={rows}
          onClose={() => setReportOpen(false)}
          onSelect={(employeeId) => {
            setReportOpen(false);
            setDrawerEmployeeId(employeeId);
          }}
        />
      ) : null}

      {confirmLock ? (
        <Modal title={`Lock ${formatMonth(month)}?`} onClose={() => setConfirmLock(false)}>
          <div className="space-y-3 text-sm">
            <p className="text-crewly-dim">
              Locking freezes every employee input for the month. Validation runs first, and the lock
              is refused while any employee still has an error. Reopening is the only way back and is
              written to the audit trail.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setConfirmLock(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={saving}
                onClick={() => handleStatus('LOCKED')}
              >
                {saving ? <Loader2 className="animate-spin" size={15} /> : <Lock size={15} />}
                Validate &amp; lock
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// §13 — Employee Input Drawer
// ─────────────────────────────────────────────────────────────
const emptyEntry = {
  type: 'BONUS_PERFORMANCE',
  amount: '',
  reason: '',
  remarks: '',
  claimDate: '',
  claimStatus: 'APPROVED',
};

const EmployeeDrawer = ({ employeeId, month, entryTypes, locked, canManage, onClose, onChanged, flash }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyEntry);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);

  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await monthlyInputService.get(employeeId, month);
      setData(response?.data || null);
      setNotes(response?.data?.remarks || '');
    } catch (error) {
      flash('error', error?.message || 'Unable to open employee input');
    } finally {
      setLoading(false);
    }
  }, [employeeId, month, flash]);

  useEffect(() => {
    load();
  }, [load]);

  const submitEntry = async (event) => {
    event.preventDefault();
    if (!form.amount || Number(form.amount) <= 0) {
      flash('error', 'Amount must be greater than zero');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        month,
        type: form.type,
        amount: Number(form.amount),
        reason: form.reason,
        remarks: form.remarks,
        claimDate: form.claimDate || undefined,
        claimStatus: form.claimStatus || 'APPROVED',
      };
      if (editingId) await monthlyInputService.updateEntry(employeeId, editingId, payload);
      else await monthlyInputService.addEntry(employeeId, payload);
      setForm(emptyEntry);
      setEditingId(null);
      await load();
      onChanged();
      flash('success', editingId ? 'Entry updated' : 'Entry added');
    } catch (error) {
      flash('error', error?.message || 'Unable to save entry');
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = async (entryId) => {
    setSaving(true);
    try {
      await monthlyInputService.removeEntry(employeeId, entryId, month);
      await load();
      onChanged();
      flash('success', 'Entry removed');
    } catch (error) {
      flash('error', error?.message || 'Unable to remove entry');
    } finally {
      setSaving(false);
    }
  };

  // §16 / §17 — approving or rejecting a claim is a first-class edit.
  const setClaimStatus = async (entryId, claimStatus) => {
    setSaving(true);
    try {
      await monthlyInputService.updateEntry(employeeId, entryId, { month, claimStatus });
      await load();
      onChanged();
      flash('success', claimStatus === 'APPROVED' ? 'Claim approved' : `Claim ${claimStatus.toLowerCase()}`);
    } catch (error) {
      flash('error', error?.message || 'Unable to update the claim');
    } finally {
      setSaving(false);
    }
  };

  // §10 — HR notes, saved without leaving the drawer.
  const saveNotes = async () => {
    setSaving(true);
    try {
      await monthlyInputService.saveRemarks(employeeId, { month, remarks: notes });
      await load();
      onChanged();
      flash('success', 'Notes saved');
    } catch (error) {
      flash('error', error?.message || 'Unable to save notes');
    } finally {
      setSaving(false);
    }
  };

  const auto = data?.auto || {};
  const entries = data?.entries || [];
  const labelOf = (type) => entryTypes.find((item) => item.value === type)?.label || type;
  const categoryOf = (type) => entryTypes.find((item) => item.value === type)?.category || 'ADJUSTMENT';

  // §10 / §13 — the drawer groups entries the way the spec lists them.
  const GROUPS = [
    { key: 'EARNINGS', title: 'Variable earnings', categories: ['BONUS', 'INCENTIVE', 'COMMISSION', 'OVERTIME'] },
    { key: 'REIMBURSEMENT', title: 'Reimbursements', categories: ['REIMBURSEMENT'] },
    { key: 'DEDUCTION', title: 'Deductions', categories: ['DEDUCTION', 'RECOVERY'] },
    { key: 'ADJUSTMENT', title: 'Adjustments', categories: ['ADJUSTMENT'] },
  ];
  const grouped = GROUPS.map((group) => ({
    ...group,
    rows: entries.filter((entry) => group.categories.includes(categoryOf(entry.type))),
  })).filter((group) => group.rows.length > 0);

  return (
    <Modal title={`Payroll inputs · ${data?.employeeName || 'Employee'}`} onClose={onClose} wide>
      {loading ? (
        <div className="py-10 text-center text-crewly-dim">
          <Loader2 className="mx-auto animate-spin" size={18} /> Loading…
        </div>
      ) : (
        <div className="space-y-5">
          {/* §13.1 — automatic inputs, read only */}
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-crewly-dim">
              Automatic inputs (from attendance &amp; leave)
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {[
                ['Working days', auto.workingDays],
                ['Present', auto.presentDays],
                ['Absent', auto.absentDays],
                ['LOP', auto.lopDays],
                ['Paid leave', auto.paidLeaveDays],
                ['Late marks', auto.lateMarks],
                ['Half day', auto.halfDays],
                ['Overtime (h)', auto.otHours],
                ['Night shifts', auto.nightShiftCount],
                ['Weekend shifts', auto.weekendShiftCount],
                ['Holiday shifts', auto.holidayShiftCount],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-crewly-inset p-2">
                  <p className="text-[11px] uppercase text-crewly-dim">{label}</p>
                  <p className="text-sm font-semibold">{formatNumber(value)}</p>
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-crewly-dim">
              <span>
                Paid leave split: casual {formatNumber(auto.leaveBreakdown?.CASUAL)}, sick{' '}
                {formatNumber(auto.leaveBreakdown?.SICK)}, earned{' '}
                {formatNumber(auto.leaveBreakdown?.EARNED)}, other{' '}
                {formatNumber(auto.leaveBreakdown?.OTHER)}
              </span>
              {/* §15 — the OT rate is a preview read of 29.1. No amount here. */}
              <span>
                OT policy:{' '}
                {auto.otPolicy?.enabled
                  ? `${auto.otPolicy.basis?.toLowerCase() || 'hourly'} × ${formatNumber(auto.otPolicy.multiplier || 1)}`
                  : 'overtime not enabled in Payroll Setup'}
              </span>
              {auto.lopLeaveIds?.length ? (
                <span>{auto.lopLeaveIds.length} LOP leave record(s) behind these days</span>
              ) : null}
            </div>
            <p className="mt-2 text-[11px] text-crewly-dim">
              Imported figures can&apos;t be edited here — correct the attendance or leave record, then
              re-import the month. LOP source:{' '}
              {auto.lopSource === 'LEAVE' ? 'Leave module' : 'attendance absence'}.
            </p>
          </section>

          {/* §10 / §13 — grouped the way the spec lists them, with subtotals */}
          {grouped.length === 0 ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-crewly-dim">
                Variable pay, reimbursements &amp; deductions
              </h3>
              <EmptyState
                illustration="wallet"
                title={`No variable entries for ${formatMonth(month)}`}
                description="Bonuses, incentives, reimbursements and ad-hoc deductions you add for the month are grouped here with their subtotals."
                size="sm"
              />
            </section>
          ) : (
            grouped.map((group) => (
              <section key={group.key}>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
                    {group.title}
                  </h3>
                  <span className="text-sm font-semibold">
                    {formatMoney(group.rows.reduce((sum, entry) => sum + Number(entry.amount || 0), 0))}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-crewly-dim">
                      <tr>
                        <th className="px-2 py-1">Type</th>
                        <th className="px-2 py-1">Amount</th>
                        <th className="px-2 py-1">Reason</th>
                        <th className="px-2 py-1">Claim</th>
                        <th className="px-2 py-1">Approved by</th>
                        <th className="px-2 py-1">Source</th>
                        <th className="px-2 py-1 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((entry) => (
                        <tr
                          key={entry.entryId}
                          className={`border-t border-crewly-hairline ${
                            entry.claimStatus === 'REJECTED' ? 'opacity-60 line-through' : ''
                          }`}
                        >
                          <td className="px-2 py-1">{labelOf(entry.type)}</td>
                          <td className="px-2 py-1">{formatMoney(entry.amount)}</td>
                          <td className="px-2 py-1">{entry.reason || '—'}</td>
                          <td className="px-2 py-1 text-xs">
                            {entry.claimStatus || '—'}
                            {entry.claimDate ? ` · ${formatDate(entry.claimDate)}` : ''}
                          </td>
                          <td className="px-2 py-1 text-xs">
                            {entry.approvedBy ? String(entry.approvedBy).slice(-6) : '—'}
                          </td>
                          <td className="px-2 py-1 text-xs">{entry.source || 'MANUAL'}</td>
                          <td className="px-2 py-1 text-right">
                            {locked ? (
                              <span className="text-xs text-crewly-dim">locked</span>
                            ) : (
                              <div className="flex justify-end gap-2">
                                {categoryOf(entry.type) === 'REIMBURSEMENT' ? (
                                  <>
                                    {entry.claimStatus !== 'APPROVED' ? (
                                      <button
                                        className="text-xs text-emerald-300 hover:underline"
                                        onClick={() => setClaimStatus(entry.entryId, 'APPROVED')}
                                      >
                                        Approve
                                      </button>
                                    ) : null}
                                    {entry.claimStatus !== 'REJECTED' ? (
                                      <button
                                        className="text-xs text-amber-300 hover:underline"
                                        onClick={() => setClaimStatus(entry.entryId, 'REJECTED')}
                                      >
                                        Reject
                                      </button>
                                    ) : null}
                                  </>
                                ) : null}
                                <button
                                  className="text-xs text-indigo-300 hover:underline"
                                  onClick={() => {
                                    setEditingId(entry.entryId);
                                    setForm({
                                      type: entry.type,
                                      amount: entry.amount,
                                      reason: entry.reason || '',
                                      remarks: entry.remarks || '',
                                      claimDate: entry.claimDate
                                        ? String(entry.claimDate).slice(0, 10)
                                        : '',
                                    });
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  className="text-xs text-red-300 hover:underline"
                                  onClick={() => removeEntry(entry.entryId)}
                                >
                                  Remove
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))
          )}

          {/* §10 — remarks */}
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-crewly-dim">
              Remarks (HR notes)
            </h3>
            <textarea
              className="input h-20"
              placeholder="Notes for this employee this month — visible in the audit trail"
              value={notes}
              disabled={locked}
              onChange={(event) => setNotes(event.target.value)}
            />
            {!locked && canManage ? (
              <div className="mt-2 flex justify-end">
                <button className="btn-secondary" disabled={saving} onClick={saveNotes}>
                  Save notes
                </button>
              </div>
            ) : null}
          </section>

          {!locked && canManage ? (
            <form className="grid gap-2 sm:grid-cols-5" onSubmit={submitEntry}>
              <select
                className="input"
                value={form.type}
                onChange={(event) => setForm({ ...form, type: event.target.value })}
              >
                {entryTypes.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                type="number"
                min="1"
                step="0.01"
                placeholder="Amount"
                value={form.amount}
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
              />
              <input
                className="input"
                placeholder="Reason"
                value={form.reason}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
              />
              <input
                className="input"
                type="date"
                value={form.claimDate}
                onChange={(event) => setForm({ ...form, claimDate: event.target.value })}
              />
              {/* §16 — a claim can be entered as pending; someone still has to
                  approve it before the month is handed to the engine. */}
              {categoryOf(form.type) === 'REIMBURSEMENT' ? (
                <select
                  className="input"
                  value={form.claimStatus}
                  onChange={(event) => setForm({ ...form, claimStatus: event.target.value })}
                >
                  <option value="APPROVED">Approved</option>
                  <option value="PENDING">Pending approval</option>
                  <option value="REJECTED">Rejected</option>
                </select>
              ) : null}
              <button className="btn-primary" disabled={saving}>
                {editingId ? 'Update entry' : 'Add entry'}
              </button>
              {editingId ? (
                <button
                  type="button"
                  className="btn-secondary sm:col-span-5"
                  onClick={() => {
                    setEditingId(null);
                    setForm(emptyEntry);
                  }}
                >
                  Cancel edit
                </button>
              ) : null}
            </form>
          ) : (
            <p className="text-xs text-crewly-dim">
              {locked ? 'This month is locked — entries are read only.' : 'You have read-only access.'}
            </p>
          )}

          {data?.issues?.length ? (
            <div className="rounded-lg border-l-4 border-red-500 bg-red-500/5 p-3 text-sm">
              <p className="font-semibold text-red-200">Validation issues</p>
              <ul className="mt-1 list-disc pl-5 text-crewly-dim">
                {data.issues.map((issue) => (
                  <li key={issue.code || issue.message}>{issue.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────
// §11 — Bulk import: preview, then store only after HR confirms
// ─────────────────────────────────────────────────────────────
const BulkImportModal = ({ month, onClose, onDone, flash }) => {
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const readFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setContent(String(reader.result || ''));
    reader.readAsText(file);
  };

  const previewFile = async () => {
    setBusy(true);
    try {
      const response = await monthlyInputService.previewImport({ month, content });
      setPreview(response?.data || null);
    } catch (error) {
      flash('error', error?.message || 'Unable to read the import file');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const response = await monthlyInputService.confirmImport({
        month,
        rows: (preview?.accepted || []).map((row) => ({
          employeeId: row.employeeId,
          entry: row.entry,
        })),
      });
      flash('success', response?.message || 'Import stored');
      await onDone();
    } catch (error) {
      flash('error', error?.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Bulk import · ${formatMonth(month)}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={() => downloadImportTemplate()}>
            <Download size={15} /> Template
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={readFile} />
          <button className="btn-secondary" onClick={() => fileRef.current?.click()}>
            <Upload size={15} /> Choose CSV
          </button>
          <button className="btn-secondary" disabled={busy || !content.trim()} onClick={previewFile}>
            Preview
          </button>
        </div>

        <textarea
          className="input h-40 font-mono text-xs"
          placeholder="Or paste CSV here: employeeCode,type,amount,reason,claimDate,remarks"
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setPreview(null);
          }}
        />

        {preview ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg bg-emerald-500/10 p-3">
                <p className="text-xs uppercase text-crewly-dim">Accepted</p>
                <p className="text-lg font-semibold text-emerald-300">{preview.totals?.accepted || 0}</p>
              </div>
              <div className="rounded-lg bg-red-500/10 p-3">
                <p className="text-xs uppercase text-crewly-dim">Rejected</p>
                <p className="text-lg font-semibold text-red-300">{preview.totals?.rejected || 0}</p>
              </div>
              <div className="rounded-lg bg-crewly-inset p-3">
                <p className="text-xs uppercase text-crewly-dim">Total amount</p>
                <p className="text-lg font-semibold">{formatMoney(preview.totals?.amount)}</p>
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-crewly-hairline">
              <table className="w-full text-left text-xs">
                <thead className="bg-crewly-inset uppercase tracking-wide text-crewly-dim">
                  <tr>
                    <th className="px-2 py-1">Line</th>
                    <th className="px-2 py-1">Employee</th>
                    <th className="px-2 py-1">Type</th>
                    <th className="px-2 py-1">Amount</th>
                    <th className="px-2 py-1">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {(preview.accepted || []).map((row) => (
                    <tr key={`a-${row.line}`} className="border-t border-crewly-hairline">
                      <td className="px-2 py-1">{row.line}</td>
                      <td className="px-2 py-1">{row.employeeName || row.employeeCode}</td>
                      <td className="px-2 py-1">{row.entry?.type}</td>
                      <td className="px-2 py-1">{formatMoney(row.entry?.amount)}</td>
                      <td className="px-2 py-1 text-emerald-300">accepted</td>
                    </tr>
                  ))}
                  {(preview.rejected || []).map((row, index) => (
                    <tr key={`r-${index}`} className="border-t border-crewly-hairline">
                      <td className="px-2 py-1">{row.line}</td>
                      <td className="px-2 py-1">{row.employeeCode || '—'}</td>
                      <td className="px-2 py-1">—</td>
                      <td className="px-2 py-1">—</td>
                      <td className="px-2 py-1 text-red-300">{row.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={busy || !preview.accepted?.length}
                onClick={confirm}
              >
                {busy ? <Loader2 className="animate-spin" size={15} /> : <FileSpreadsheet size={15} />}
                Import {preview.totals?.accepted || 0} row(s)
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-crewly-dim">
            Nothing is stored until you review the preview and confirm. Maximum 5,000 rows per file.
          </p>
        )}
      </div>
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────
// §12 — Bulk actions on the selected employees
// ─────────────────────────────────────────────────────────────
const BULK_LABELS = {
  ADD_FESTIVAL_BONUS: 'Add festival bonus',
  ADD_INTERNET_ALLOWANCE: 'Add internet allowance',
  APPLY_MEAL_REIMBURSEMENT: 'Apply meal reimbursement',
  MARK_ZERO_BONUS: 'Mark bonus zero',
  REMOVE_IMPORTED_ENTRIES: 'Remove imported entries',
};

const BulkActionModal = ({ month, actions, employees, onClose, onDone, flash }) => {
  const [action, setAction] = useState(actions[0] || 'ADD_FESTIVAL_BONUS');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const needsAmount = !['MARK_ZERO_BONUS', 'REMOVE_IMPORTED_ENTRIES'].includes(action);

  const apply = async () => {
    setBusy(true);
    try {
      const response = await monthlyInputService.bulkAction({
        month,
        action,
        employeeIds: employees.map((row) => row.employeeId),
        amount: needsAmount ? Number(amount) : undefined,
        reason: reason || undefined,
      });
      flash('success', response?.message || 'Bulk action applied');
      await onDone();
    } catch (error) {
      flash('error', error?.message || 'Bulk action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Bulk action · ${employees.length} employee(s)`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <select className="input" value={action} onChange={(event) => setAction(event.target.value)}>
          {(actions.length ? actions : Object.keys(BULK_LABELS)).map((value) => (
            <option key={value} value={value}>
              {BULK_LABELS[value] || value}
            </option>
          ))}
        </select>

        {needsAmount ? (
          <input
            className="input"
            type="number"
            min="1"
            step="0.01"
            placeholder="Amount per employee"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        ) : null}

        <input
          className="input"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />

        <div className="max-h-40 overflow-y-auto rounded-lg border border-crewly-hairline p-2 text-xs text-crewly-dim">
          {employees.map((row) => (
            <p key={row.employeeId}>
              {row.employeeName} · {row.employeeCode}
            </p>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy || (needsAmount && !amount)} onClick={apply}>
            {busy ? <Loader2 className="animate-spin" size={15} /> : <Users size={15} />}
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────
// §19 — Validation report
// ─────────────────────────────────────────────────────────────
const ValidationReportModal = ({ month, rows, onClose, onSelect }) => {
  const withIssues = rows.filter((row) => (row.issues || []).length > 0);

  return (
    <Modal title={`Validation report · ${formatMonth(month)}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <p className="text-crewly-dim">
          {withIssues.length === 0
            ? 'Every employee input passes validation. The month can be locked.'
            : `${withIssues.length} employee(s) must be fixed before the month can be locked.`}
        </p>

        <div className="max-h-80 overflow-y-auto rounded-lg border border-crewly-hairline">
          <table className="w-full text-left text-xs">
            <thead className="bg-crewly-inset uppercase tracking-wide text-crewly-dim">
              <tr>
                <th className="px-2 py-1">Employee</th>
                <th className="px-2 py-1">Issue</th>
                <th className="px-2 py-1 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {withIssues.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-2 py-6 text-center text-crewly-dim">
                    No validation errors.
                  </td>
                </tr>
              ) : (
                withIssues.map((row) =>
                  row.issues.map((issue, index) => (
                    <tr key={`${row.employeeId}-${index}`} className="border-t border-crewly-hairline">
                      <td className="px-2 py-1">
                        {index === 0 ? `${row.employeeName} (${row.employeeCode})` : ''}
                      </td>
                      <td className="px-2 py-1 text-red-300">{issue.message || issue}</td>
                      <td className="px-2 py-1 text-right">
                        {index === 0 ? (
                          <button
                            className="text-indigo-300 hover:underline"
                            onClick={() => onSelect(row.employeeId)}
                          >
                            Fix
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )),
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
};

export default MonthlyInputsPage;
