/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  CalendarX,
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
import monthlyInputService, { downloadImportTemplate } from '../../services/monthlyInputService.js';

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

const periodBadge = (status) => {
  const styles = {
    NOT_STARTED: 'bg-slate-500/15 text-slate-300',
    ATTENDANCE_IMPORTED: 'bg-sky-500/15 text-sky-300',
    COLLECTING_INPUTS: 'bg-indigo-500/15 text-indigo-300',
    VALIDATED: 'bg-emerald-500/15 text-emerald-300',
    LOCKED: 'bg-amber-500/15 text-amber-300',
    SENT_TO_PAYROLL: 'bg-violet-500/15 text-violet-300',
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${styles[status] || styles.NOT_STARTED}`}>
      {String(status || 'not started').replace(/_/g, ' ').toLowerCase()}
    </span>
  );
};

const statusPill = (status) => {
  const styles = {
    READY: 'bg-emerald-500/15 text-emerald-300',
    PENDING: 'bg-indigo-500/15 text-indigo-300',
    ERROR: 'bg-red-500/15 text-red-300',
    LOCKED: 'bg-amber-500/15 text-amber-300',
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${styles[status] || styles.PENDING}`}>
      {String(status || 'pending').replace(/_/g, ' ').toLowerCase()}
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

const MonthlyInputsPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();

  const canRead = hasAnyPermission(['PAYROLL_INPUT_READ', 'PAYROLL_INPUT_MANAGE', 'PAYROLL_INPUT_LOCK']);
  const canManage = hasAnyPermission(['PAYROLL_INPUT_MANAGE']);
  const canLock = hasAnyPermission(['PAYROLL_INPUT_LOCK', 'PAYROLL_INPUT_MANAGE']);

  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);

  const [rows, setRows] = useState([]);
  const [period, setPeriod] = useState(null);
  const [summary, setSummary] = useState({});
  const [entryTypes, setEntryTypes] = useState([]);
  const [bulkActions, setBulkActions] = useState([]);

  const [filters, setFilters] = useState({ search: '', status: 'ALL' });
  const [selected, setSelected] = useState([]);
  const [drawerEmployeeId, setDrawerEmployeeId] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 5000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await monthlyInputService.list({ month });
      setRows(data?.data || []);
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

  const locked = ['LOCKED', 'SENT_TO_PAYROLL'].includes(period?.status);

  const visible = useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filters.status !== 'ALL' && row.status !== filters.status) return false;
      if (!needle) return true;
      return [row.employeeName, row.employeeCode, row.email]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, filters]);

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
    const { withErrors = 0, total = 0 } = data?.data || {};
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

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Monthly Payroll Inputs</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Payroll access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to view monthly payroll inputs. Contact your Company Admin
            or Payroll Administrator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Monthly Payroll Inputs</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Variable pay, reimbursements and deductions for the month — the last editable stage
            before the payroll engine runs. No salary is calculated here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value);
              setSelected([]);
            }}
            className="input"
          />
          <span className="text-sm text-crewly-dim">{periodBadge(period?.status || 'NOT_STARTED')}</span>
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

      {locked ? (
        <div className="card flex items-start gap-3 border-l-4 border-amber-500">
          <Lock size={18} className="mt-0.5 text-amber-300" />
          <div className="text-sm">
            <p className="font-semibold text-amber-200">{formatMonth(month)} is locked</p>
            <p className="text-crewly-dim">
              Inputs can&apos;t be added, edited or imported while the month is locked. Reopen it to
              make changes — every reopen is recorded in the audit trail.
            </p>
          </div>
        </div>
      ) : null}

      {/* §25 — KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={Users}
          label="Employees"
          value={formatNumber(summary.employees)}
          hint={`${formatMonth(month)}`}
        />
        <KpiCard
          icon={CheckCircle2}
          label="Ready"
          value={formatNumber(summary.ready)}
          tone="good"
          hint="Inputs complete"
        />
        <KpiCard
          icon={RefreshCw}
          label="Pending"
          value={formatNumber(summary.pending)}
          tone="warn"
          hint="Still being collected"
        />
        <KpiCard
          icon={AlertTriangle}
          label="Errors"
          value={formatNumber(summary.error)}
          tone="bad"
          hint="Must be fixed before lock"
        />
        <KpiCard
          icon={Wallet}
          label="Variable earnings"
          value={formatMoney(summary.totalBonus)}
          hint="Bonus, incentive, commission"
        />
        <KpiCard
          icon={Upload}
          label="Reimbursements"
          value={formatMoney(summary.totalReimbursement)}
          hint="Claims not rejected"
        />
        <KpiCard
          icon={Download}
          label="Deductions"
          value={formatMoney(summary.totalDeduction)}
          hint="Recoveries and fines"
        />
        <KpiCard
          icon={CalendarX}
          label="LOP days"
          value={formatNumber(summary.totalLopDays)}
          hint={`${formatNumber(summary.totalOtHours)} overtime hour(s)`}
        />
      </div>

      {/* §7 / §11 / §12 / §19 / §20 — actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={saving || locked} onClick={handleImportAutomatic}>
          <RefreshCw size={15} /> Import attendance &amp; leave
        </button>
        <button className="btn-secondary" onClick={() => setImportOpen(true)} disabled={locked}>
          <FileSpreadsheet size={15} /> Bulk import
        </button>
        <button className="btn-secondary" onClick={() => setBulkOpen(true)} disabled={!selected.length || locked}>
          <Users size={15} /> Bulk action ({selected.length})
        </button>
        <button className="btn-secondary" onClick={() => setReportOpen(true)}>
          <ShieldCheck size={15} /> Validation report
        </button>
        <button className="btn-secondary" onClick={handleValidate} disabled={saving}>
          Validate month
        </button>
        {locked ? (
          <button className="btn-secondary" disabled={saving || !canLock} onClick={() => handleStatus('COLLECTING_INPUTS')}>
            <Unlock size={15} /> Reopen month
          </button>
        ) : (
          <button className="btn-secondary" disabled={saving || !canLock} onClick={() => setConfirmLock(true)}>
            <Lock size={15} /> Lock month
          </button>
        )}
      </div>

      {/* §18 — table */}
      <div className="card overflow-x-auto p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 p-3">
          <input
            className="input max-w-xs"
            placeholder="Search name, code or email"
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />
          <select
            className="input max-w-[180px]"
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="ml-auto text-xs text-crewly-dim">
            {visible.length} of {rows.length} employee(s)
          </span>
        </div>

        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  checked={Boolean(visible.length) && visible.every((row) => selected.includes(row.employeeId))}
                  onChange={(event) =>
                    setSelected(event.target.checked ? visible.map((row) => row.employeeId) : [])
                  }
                />
              </th>
              <th className="px-3 py-2">Employee</th>
              <th className="px-3 py-2">Present</th>
              <th className="px-3 py-2">Absent / LOP</th>
              <th className="px-3 py-2">Leave</th>
              <th className="px-3 py-2">Variable</th>
              <th className="px-3 py-2">Reimbursement</th>
              <th className="px-3 py-2">Deduction</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-crewly-dim">
                  <Loader2 className="mx-auto animate-spin" size={18} /> Loading month…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-crewly-dim">
                  No employee inputs for {formatMonth(month)}. Import attendance and leave to build
                  the month.
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row._id} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.includes(row.employeeId)}
                      onChange={() => toggleRow(row.employeeId)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <p className="font-medium">{row.employeeName}</p>
                    <p className="text-xs text-crewly-dim">
                      {row.employeeCode}
                      {row.designation ? ` · ${row.designation}` : ''}
                    </p>
                  </td>
                  <td className="px-3 py-2">{formatNumber(row.auto?.presentDays)}</td>
                  <td className="px-3 py-2">
                    {formatNumber(row.auto?.absentDays)}
                    <span className="ml-1 text-xs text-crewly-dim">
                      / {formatNumber(row.auto?.lopDays)} LOP
                    </span>
                  </td>
                  <td className="px-3 py-2">{formatNumber(row.auto?.paidLeaveDays)}</td>
                  <td className="px-3 py-2">{formatMoney(row.totals?.bonus)}</td>
                  <td className="px-3 py-2">{formatMoney(row.totals?.reimbursement)}</td>
                  <td className="px-3 py-2">{formatMoney(row.totals?.deduction)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      {statusPill(row.status)}
                      {row.issues?.length ? (
                        <span className="text-[11px] text-red-300">
                          {row.issues.length} issue(s)
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      className="text-sm text-indigo-300 hover:underline"
                      onClick={() => setDrawerEmployeeId(row.employeeId)}
                    >
                      Open drawer
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-crewly-dim">
        Variable pay never changes the salary structure (§16). It is stored per month and consumed by
        the payroll engine. Salary components live in{' '}
        <Link className="text-indigo-300 hover:underline" to="/app/payroll/components">
          Payroll Components
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
};

const EmployeeDrawer = ({ employeeId, month, entryTypes, locked, canManage, onClose, onChanged, flash }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyEntry);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await monthlyInputService.get(employeeId, month);
      setData(response?.data || null);
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

  const auto = data?.auto || {};
  const entries = data?.entries || [];
  const labelOf = (type) => entryTypes.find((item) => item.value === type)?.label || type;

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
                <div key={label} className="rounded-lg bg-white/5 p-2">
                  <p className="text-[11px] uppercase text-crewly-dim">{label}</p>
                  <p className="text-sm font-semibold">{formatNumber(value)}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-crewly-dim">
              Imported figures can&apos;t be edited here — correct the attendance or leave record, then
              re-import the month.{auto.lopSource ? ` LOP source: ${auto.lopSource}.` : ''}
            </p>
          </section>

          {/* §13.2 — variable pay */}
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-crewly-dim">
              Variable pay, reimbursements &amp; deductions
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-crewly-dim">
                  <tr>
                    <th className="px-2 py-1">Type</th>
                    <th className="px-2 py-1">Amount</th>
                    <th className="px-2 py-1">Reason</th>
                    <th className="px-2 py-1">Claim</th>
                    <th className="px-2 py-1">Source</th>
                    <th className="px-2 py-1 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-2 py-4 text-center text-crewly-dim">
                        No variable entries for {formatMonth(month)}.
                      </td>
                    </tr>
                  ) : (
                    entries.map((entry) => (
                      <tr key={entry.entryId} className="border-t border-white/5">
                        <td className="px-2 py-1">{labelOf(entry.type)}</td>
                        <td className="px-2 py-1">{formatMoney(entry.amount)}</td>
                        <td className="px-2 py-1">{entry.reason || '—'}</td>
                        <td className="px-2 py-1 text-xs">
                          {entry.claimStatus || '—'}
                          {entry.claimDate ? ` · ${formatDate(entry.claimDate)}` : ''}
                        </td>
                        <td className="px-2 py-1 text-xs">{entry.source || 'MANUAL'}</td>
                        <td className="px-2 py-1 text-right">
                          {locked ? (
                            <span className="text-xs text-crewly-dim">locked</span>
                          ) : (
                            <div className="flex justify-end gap-2">
                              <button
                                className="text-xs text-indigo-300 hover:underline"
                                onClick={() => {
                                  setEditingId(entry.entryId);
                                  setForm({
                                    type: entry.type,
                                    amount: entry.amount,
                                    reason: entry.reason || '',
                                    remarks: entry.remarks || '',
                                    claimDate: entry.claimDate ? String(entry.claimDate).slice(0, 10) : '',
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
                    ))
                  )}
                </tbody>
              </table>
            </div>
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
              <div className="rounded-lg bg-white/5 p-3">
                <p className="text-xs uppercase text-crewly-dim">Total amount</p>
                <p className="text-lg font-semibold">{formatMoney(preview.totals?.amount)}</p>
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-white/5">
              <table className="w-full text-left text-xs">
                <thead className="bg-white/5 uppercase tracking-wide text-crewly-dim">
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
                    <tr key={`a-${row.line}`} className="border-t border-white/5">
                      <td className="px-2 py-1">{row.line}</td>
                      <td className="px-2 py-1">{row.employeeName || row.employeeCode}</td>
                      <td className="px-2 py-1">{row.entry?.type}</td>
                      <td className="px-2 py-1">{formatMoney(row.entry?.amount)}</td>
                      <td className="px-2 py-1 text-emerald-300">accepted</td>
                    </tr>
                  ))}
                  {(preview.rejected || []).map((row, index) => (
                    <tr key={`r-${index}`} className="border-t border-white/5">
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

        <div className="max-h-40 overflow-y-auto rounded-lg border border-white/5 p-2 text-xs text-crewly-dim">
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

        <div className="max-h-80 overflow-y-auto rounded-lg border border-white/5">
          <table className="w-full text-left text-xs">
            <thead className="bg-white/5 uppercase tracking-wide text-crewly-dim">
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
                    <tr key={`${row.employeeId}-${index}`} className="border-t border-white/5">
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
