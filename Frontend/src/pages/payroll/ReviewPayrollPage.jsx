/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  Coins,
  Download,
  FileSpreadsheet,
  History,
  Loader2,
  Lock,
  MessageSquarePlus,
  RotateCcw,
  Send,
  ShieldCheck,
  ThumbsDown,
  Unlock,
  Users,
  Wallet,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import payrollReviewService from '../../services/payrollReviewService.js';

// ─────────────────────────────────────────────────────────────
// Phase 29.7 — Review & Approve Payroll
//
//   1. Payroll month + review status        (§6 / §7)
//   2. KPI cards                            (§7)
//   3. Review checklist                     (§11)
//   4. Employee review table + bulk actions (§8 / §18)
//   5. Employee payroll breakdown drawer    (§9)
//   6. Error report                         (§10 / §22)
//   7. Difference report                    (§17)
//   8. Remarks thread                       (§15)
//   9. Reports (CSV)                        (§19)
//  10. Lock / submit / approve / reject     (§12 / §13 / §14)
//
// This page REVIEWS. It never calculates (§21) — every figure comes
// from the 29.6 snapshot — and it never pays anyone, never builds a
// bank file and never generates a payslip (§31).
// ─────────────────────────────────────────────────────────────

const currentMonth = () => new Date().toISOString().slice(0, 7);

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

const formatStamp = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

const STATUS_LABELS = {
  CALCULATED: 'Calculated',
  UNDER_REVIEW: 'Under review',
  LOCKED: 'Locked',
  PENDING_FINANCE_APPROVAL: 'Pending finance approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  REOPENED: 'Reopened',
};

const STATUS_STYLES = {
  CALCULATED: 'bg-slate-500/15 text-slate-300',
  UNDER_REVIEW: 'bg-sky-500/15 text-sky-300',
  LOCKED: 'bg-indigo-500/15 text-indigo-300',
  PENDING_FINANCE_APPROVAL: 'bg-amber-500/15 text-amber-300',
  APPROVED: 'bg-emerald-500/15 text-emerald-300',
  REJECTED: 'bg-red-500/15 text-red-300',
  REOPENED: 'bg-orange-500/15 text-orange-300',
};

const statusBadge = (status) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${STATUS_STYLES[status] || STATUS_STYLES.CALCULATED}`}>
    {STATUS_LABELS[status] || status || 'Calculated'}
  </span>
);

// §11 — the checklist labels mirror the backend catalogue so a tick means the
// same thing in both places.
const CHECKLIST_ITEMS = [
  { key: 'ATTENDANCE_VERIFIED', label: 'Attendance verified' },
  { key: 'LEAVE_VERIFIED', label: 'Leave verified' },
  { key: 'BONUS_VERIFIED', label: 'Bonus verified' },
  { key: 'REIMBURSEMENTS_APPROVED', label: 'Reimbursements approved' },
  { key: 'DEDUCTIONS_REVIEWED', label: 'Deductions reviewed' },
  { key: 'NET_SALARY_REVIEWED', label: 'Net salary reviewed' },
  { key: 'ERROR_COUNT_ZERO', label: 'Error count is zero' },
];

// §19 — the report catalogue. ERROR_COUNT_ZERO is derived, so it is not tickable.
const REPORT_KEYS = [
  { key: 'PAYROLL_REGISTER', label: 'Payroll register' },
  { key: 'SALARY_SUMMARY', label: 'Salary summary' },
  { key: 'DEPARTMENT_PAYROLL', label: 'Department payroll' },
  { key: 'DEDUCTION_REPORT', label: 'Deduction report' },
  { key: 'EMPLOYER_CONTRIBUTION_REPORT', label: 'Employer contribution report' },
  { key: 'ERROR_LIST', label: 'Error list' },
];

const TABS = [
  { key: 'employees', label: 'Employees' },
  { key: 'errors', label: 'Errors' },
  { key: 'differences', label: 'Differences' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'reports', label: 'Reports' },
];

const downloadCsv = (content, filename) => {
  const blob = new Blob([String(content || '')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
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

const ReviewPayrollPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();

  // §4 — permissions, never role names.
  const canRead = hasAnyPermission(['PAYROLL_RUN_READ', 'PAYROLL_RUN_PREPARE', 'PAYROLL_RUN_REVIEW']);
  const canPrepare = hasAnyPermission(['PAYROLL_RUN_PREPARE']);
  const canLock = hasAnyPermission(['PAYROLL_RUN_LOCK']);
  const canReopen = hasAnyPermission(['PAYROLL_RUN_REOPEN']);
  const canSubmit = hasAnyPermission(['PAYROLL_RUN_REVIEW']);
  const canApprove = hasAnyPermission(['PAYROLL_RUN_APPROVE']);
  const canReject = hasAnyPermission(['PAYROLL_RUN_REJECT']);

  const [month, setMonth] = useState(currentMonth());
  const [tab, setTab] = useState('employees');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);

  const [review, setReview] = useState(null);
  const [kpis, setKpis] = useState({});
  const [summary, setSummary] = useState({});
  const [checklist, setChecklist] = useState({});
  const [checklistProgress, setChecklistProgress] = useState({ done: 0, total: CHECKLIST_ITEMS.length, percent: 0 });
  const [errorSummary, setErrorSummary] = useState({});
  const [canLockNow, setCanLockNow] = useState(false);

  const [rows, setRows] = useState([]);
  const [errorRows, setErrorRows] = useState([]);
  const [differences, setDifferences] = useState([]);
  const [filters, setFilters] = useState({ state: 'ALL', search: '' });

  const [selected, setSelected] = useState([]);
  const [detailEmployeeId, setDetailEmployeeId] = useState(null);
  const [reasonPrompt, setReasonPrompt] = useState(null);
  const [remarkDraft, setRemarkDraft] = useState('');

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 6000);
  }, []);

  const status = review?.status || 'CALCULATED';
  const readOnly = ['LOCKED', 'PENDING_FINANCE_APPROVAL', 'APPROVED'].includes(status);

  const loadDashboard = useCallback(async () => {
    try {
      // GET /payroll/review/:month answers without a meta block, so api.js
      // hands back the review state itself.
      const data = (await payrollReviewService.dashboard(month)) || {};
      setReview(data.review || null);
      setKpis(data.kpis || {});
      setSummary(data.summary || {});
      setChecklist(data.checklist || {});
      setChecklistProgress(data.checklistProgress || checklistProgress);
      setErrorSummary(data.errors || {});
      setCanLockNow(Boolean(data.canLock));
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403) setAccessDenied(true);
      else flash('error', error?.message || 'Unable to load the payroll review');
    }
  }, [month, flash, checklistProgress]);

  const loadEmployees = useCallback(async () => {
    try {
      const response = await payrollReviewService.employees(month, {
        state: filters.state === 'ALL' ? undefined : filters.state,
        search: filters.search || undefined,
      });
      setRows(response?.data || []);
    } catch (error) {
      if (error?.status !== 403) flash('error', error?.message || 'Unable to load employees');
    }
  }, [month, filters.state, filters.search, flash]);

  const loadErrors = useCallback(async () => {
    try {
      const response = await payrollReviewService.errors(month);
      setErrorRows(response?.data || []);
    } catch (error) {
      if (error?.status !== 403) flash('error', error?.message || 'Unable to load the error report');
    }
  }, [month, flash]);

  const loadDifferences = useCallback(async () => {
    try {
      const response = await payrollReviewService.differences(month);
      setDifferences(response?.rows || []);
    } catch (error) {
      if (error?.status !== 403) setDifferences([]);
    }
  }, [month]);

  const reload = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadDashboard(), loadEmployees(), loadErrors()]);
    setLoading(false);
  }, [loadDashboard, loadEmployees, loadErrors]);

  useEffect(() => {
    if (!permsLoading && canRead) reload();
    if (!permsLoading && !canRead) setLoading(false);
  }, [permsLoading, canRead, reload]);

  useEffect(() => {
    if (tab === 'differences') loadDifferences();
  }, [tab, loadDifferences]);

  const visible = useMemo(() => {
    const term = filters.search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filters.state === 'REVIEWED' && row.review?.state !== 'REVIEWED') return false;
      if (filters.state === 'PENDING' && row.review?.state === 'REVIEWED') return false;
      if (filters.state === 'ERRORS' && !(row.reviewErrors || []).length) return false;
      if (!term) return true;
      return [row.employeeName, row.employeeCode].some((field) =>
        String(field || '').toLowerCase().includes(term),
      );
    });
  }, [rows, filters.search, filters.state]);

  const allSelected = visible.length > 0 && selected.length === visible.length;

  const toggleSelectAll = () => {
    setSelected(allSelected ? [] : visible.map((row) => String(row.employeeId)));
  };

  const toggleSelect = (employeeId) => {
    const id = String(employeeId);
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const run = async (action) => {
    setBusy(true);
    try {
      const response = await action();
      flash('success', response?.message || 'Payroll updated');
      await reload();
      if (tab === 'differences') await loadDifferences();
      return response;
    } catch (error) {
      flash('error', error?.message || 'Unable to complete the action');
      await reload();
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleChecklist = (item, value) =>
    run(() => payrollReviewService.setChecklist(month, item, value));

  const REPORT_ACTIONS = ['EXPORT_ERROR_LIST', 'DOWNLOAD_PAYROLL_SUMMARY'];

  const handleBulk = (action) => {
    const isReport = REPORT_ACTIONS.includes(action);
    if (!isReport && !selected.length) return;

    const employeeIds = selected;
    if (!isReport) setSelected([]);

    return run(async () => {
      const response = await payrollReviewService.bulk(month, action, employeeIds);
      // With meta present api.js returns the whole body, so the CSV reaches us
      // in meta.content when the worker is not running.
      const content = response?.meta?.content || response?.data?.content || '';
      if (isReport && content) {
        downloadCsv(
          content,
          `crewly-${action === 'EXPORT_ERROR_LIST' ? 'error-list' : 'salary-summary'}-${month}.csv`,
        );
      }
      return response;
    });
  };

  const handleExport = async (reportKey) => {
    setBusy(true);
    try {
      const response = await payrollReviewService.export(month, reportKey);
      const content = response?.meta?.content || response?.data?.content || '';
      if (content) {
        downloadCsv(content, `crewly-${reportKey.toLowerCase()}-${month}.csv`);
        flash('success', 'Report downloaded');
      } else {
        flash(
          'success',
          'Report queued — it is generated by the background worker and will be ready shortly',
        );
      }
    } catch (error) {
      flash('error', error?.message || 'Unable to generate the report');
    } finally {
      setBusy(false);
    }
  };

  const askReason = (kind, config) => setReasonPrompt({ kind, value: '', ...config });

  const confirmReason = async () => {
    const prompt = reasonPrompt;
    setReasonPrompt(null);
    if (!prompt) return;
    const reason = String(prompt.value || '').trim();
    if (prompt.minLength && reason.length < prompt.minLength) {
      flash('error', prompt.emptyMessage || 'A reason is required');
      return;
    }
    await run(() => prompt.call(reason));
    // The lock endpoint takes no body, so an optional note is kept as a remark.
    if (prompt.kind === 'lock' && reason) {
      await run(() => payrollReviewService.addRemark(month, reason, 'SYSTEM'));
    }
  };

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Review Payroll</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Payroll access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to review payroll. Contact your Company Admin or Payroll
            Administrator.
          </p>
        </div>
      </div>
    );
  }

  const lockBlockedReason = () => {
    if (readOnly) return 'This payroll is locked or approved. Reopen it before locking again.';
    if (Number(errorSummary.critical || 0) > 0) return 'Resolve the critical errors before locking.';
    if (Number(checklistProgress.percent || 0) < 100) return 'Complete the review checklist first.';
    return '';
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Review Payroll</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Review the calculated month, resolve errors, lock it and send it to finance. This page
            never calculates pay and never pays anyone.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            className="input"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
          {statusBadge(status)}
        </div>
      </div>

      {banner ? (
        <div
          className={`card border-l-4 text-sm ${
            banner.type === 'error' ? 'border-red-500 text-red-200' : 'border-emerald-500 text-emerald-200'
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      {status === 'REJECTED' && review?.rejectionReason ? (
        <div className="card flex items-start gap-3 border-l-4 border-red-500">
          <ThumbsDown size={18} className="mt-0.5 text-red-300" />
          <div className="text-sm">
            <p className="font-semibold text-red-200">Finance rejected this payroll</p>
            <p className="text-crewly-dim">{review.rejectionReason}</p>
          </div>
        </div>
      ) : null}

      {status === 'REOPENED' && review?.reopenReason ? (
        <div className="card flex items-start gap-3 border-l-4 border-orange-500">
          <Unlock size={18} className="mt-0.5 text-orange-300" />
          <div className="text-sm">
            <p className="font-semibold text-orange-200">This payroll was reopened</p>
            <p className="text-crewly-dim">{review.reopenReason}</p>
          </div>
        </div>
      ) : null}

      {/* §7 — the seven KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <KpiCard
          icon={Users}
          label="Total employees"
          value={formatNumber(kpis.totalEmployees)}
          hint={formatMonth(month)}
        />
        <KpiCard
          icon={Wallet}
          label="Gross payroll"
          value={formatMoney(kpis.grossPayroll)}
          hint="Earnings before deductions"
        />
        <KpiCard
          icon={Coins}
          label="Net payroll"
          value={formatMoney(kpis.netPayroll)}
          tone="good"
          hint="What reaches the bank in 29.8"
        />
        <KpiCard
          icon={ThumbsDown}
          label="Total deductions"
          value={formatMoney(kpis.totalDeductions)}
          tone="bad"
          hint="PF, ESI, PT, TDS, LOP, loans"
        />
        <KpiCard
          icon={Building2}
          label="Employer cost"
          value={formatMoney(kpis.employerCost)}
          hint="Does not reduce net salary"
        />
        <KpiCard
          icon={AlertTriangle}
          label="Employees with errors"
          value={formatNumber(kpis.employeesWithErrors)}
          tone={kpis.employeesWithErrors > 0 ? 'bad' : 'good'}
          hint={`${formatNumber(errorSummary.critical || 0)} critical · ${formatNumber(errorSummary.warnings || 0)} warnings`}
        />
        <KpiCard
          icon={ShieldCheck}
          label="Ready for approval"
          value={kpis.readyForApproval ? 'Yes' : 'No'}
          tone={kpis.readyForApproval ? 'good' : 'warn'}
          hint={
            kpis.readyForApproval
              ? 'No errors — finance can approve'
              : 'Resolve the errors below first'
          }
        />
      </div>

      {/* §11 — checklist */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
              Review checklist
            </h2>
            <p className="text-xs text-crewly-dim">
              Payroll can be locked only when every box is ticked and no critical error remains.
            </p>
          </div>
          <span className="text-xs text-crewly-dim">{formatNumber(checklistProgress.percent)}% complete</span>
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-indigo-500 transition-all"
            style={{ width: `${Math.min(100, Number(checklistProgress.percent) || 0)}%` }}
          />
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {CHECKLIST_ITEMS.map((item) => {
            const derived = item.key === 'ERROR_COUNT_ZERO';
            const checked = derived
              ? Number(errorSummary.critical || 0) === 0
              : Boolean(checklist[item.key]);
            return (
              <label
                key={item.key}
                className={`flex items-center gap-2 rounded-lg border border-white/5 bg-white/5 p-2 text-sm ${
                  derived || readOnly || !canPrepare ? 'opacity-70' : 'cursor-pointer hover:bg-white/10'
                }`}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-indigo-500"
                  checked={checked}
                  disabled={derived || readOnly || !canPrepare || busy}
                  onChange={(event) => handleChecklist(item.key, event.target.checked)}
                />
                <span>{item.label}</span>
                {derived ? (
                  <span className="ml-auto text-[10px] uppercase text-crewly-dim">auto</span>
                ) : null}
              </label>
            );
          })}
        </div>
      </div>

      {/* §12 / §13 / §14 — workflow actions */}
      <div className="card flex flex-wrap items-center gap-2">
        <button
          className="btn-primary"
          disabled={busy || !canLock || !canLockNow || Boolean(lockBlockedReason())}
          title={lockBlockedReason() || 'Lock payroll'}
          onClick={() =>
            askReason('lock', {
              title: `Lock payroll for ${formatMonth(month)}?`,
              body: 'Locking freezes the monthly inputs and stops every edit on this month. Finance can still reject it after review.',
              actionLabel: 'Lock payroll',
              minLength: 0,
              call: () => payrollReviewService.lock(month),
            })
          }
        >
          <Lock size={15} /> Lock payroll
        </button>

        <button
          className="btn-secondary"
          disabled={busy || !canSubmit || status !== 'LOCKED'}
          onClick={() => run(() => payrollReviewService.submit(month))}
        >
          <Send size={15} /> Submit to finance
        </button>

        <button
          className="btn-secondary"
          disabled={busy || !canApprove || status !== 'PENDING_FINANCE_APPROVAL'}
          onClick={() => run(() => payrollReviewService.approve(month))}
        >
          <ShieldCheck size={15} /> Approve
        </button>

        <button
          className="btn-secondary"
          disabled={busy || !canReject || status !== 'PENDING_FINANCE_APPROVAL'}
          onClick={() =>
            askReason('reject', {
              title: `Reject payroll for ${formatMonth(month)}?`,
              body: 'Finance must record why. The reason is stored with the audit trail and shown to HR on this page.',
              actionLabel: 'Reject payroll',
              minLength: 3,
              emptyMessage: 'A rejection reason is required',
              call: (reason) => payrollReviewService.reject(month, reason),
            })
          }
        >
          <ThumbsDown size={15} /> Reject
        </button>

        <button
          className="btn-secondary"
          disabled={busy || !canReopen || !['LOCKED', 'APPROVED', 'REJECTED'].includes(status)}
          onClick={() =>
            askReason('reopen', {
              title: `Reopen payroll for ${formatMonth(month)}?`,
              body: 'Reopening unlocks the monthly inputs and lets HR edit and recalculate. Authorisation and a reason are required.',
              actionLabel: 'Reopen payroll',
              minLength: 3,
              emptyMessage: 'A reason is required to reopen',
              call: (reason) => payrollReviewService.reopen(month, reason),
            })
          }
        >
          <RotateCcw size={15} /> Reopen
        </button>

        <span className="ml-auto text-xs text-crewly-dim">
          {lockBlockedReason() || `Version ${formatNumber(review?.runVersion || 1)} of the snapshot`}
        </span>
      </div>

      {/* tabs */}
      <div className="flex flex-wrap gap-1 border-b border-white/10">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            className={`border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === entry.key
                ? 'border-indigo-500 text-crewly-text'
                : 'border-transparent text-crewly-dim hover:text-crewly-text'
            }`}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
            {entry.key === 'errors' && Number(errorSummary.employeesWithErrors || 0) > 0 ? (
              <span className="ml-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-300">
                {formatNumber(errorSummary.employeesWithErrors)}
              </span>
            ) : null}
            {entry.key === 'remarks' && (review?.remarks || []).length ? (
              <span className="ml-1 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-crewly-dim">
                {formatNumber((review?.remarks || []).length)}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* §8 — employee review table */}
      {tab === 'employees' ? (
        <div className="card space-y-3 p-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-white/5 p-3">
            <input
              className="input max-w-xs"
              placeholder="Search name or code"
              value={filters.search}
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
            />
            <select
              className="input max-w-[190px]"
              value={filters.state}
              onChange={(event) => setFilters({ ...filters, state: event.target.value })}
            >
              <option value="ALL">All employees</option>
              <option value="REVIEWED">Reviewed</option>
              <option value="PENDING">Pending review</option>
              <option value="ERRORS">With errors</option>
            </select>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                className="btn-secondary"
                disabled={busy || !canPrepare || !selected.length || readOnly}
                onClick={() => handleBulk('MARK_ALL_REVIEWED')}
              >
                <CheckCircle2 size={15} /> Mark reviewed
              </button>
              <button
                className="btn-secondary"
                disabled={busy || !canPrepare || !selected.length || readOnly}
                onClick={() => handleBulk('VERIFY_BANK_DETAILS')}
              >
                <Building2 size={15} /> Verify bank
              </button>
              <button
                className="btn-secondary"
                disabled={busy || !canPrepare || !selected.length || readOnly}
                onClick={() => handleBulk('VERIFY_PAN')}
              >
                <ClipboardCheck size={15} /> Verify PAN
              </button>
              {/* §18 — reports are bulk actions too; they need no selection
                  and stay available once the month is locked. */}
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => handleBulk('EXPORT_ERROR_LIST')}
              >
                <AlertTriangle size={15} /> Export error list
              </button>
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => handleBulk('DOWNLOAD_PAYROLL_SUMMARY')}
              >
                <Download size={15} /> Download payroll summary
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
                <tr>
                  <th className="px-3 py-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-indigo-500"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Department</th>
                  <th className="px-3 py-2">Gross</th>
                  <th className="px-3 py-2">Bonus</th>
                  <th className="px-3 py-2">Deductions</th>
                  <th className="px-3 py-2">Net pay</th>
                  <th className="px-3 py-2">LOP</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-10 text-center text-crewly-dim">
                      <Loader2 className="mx-auto animate-spin" size={18} /> Loading payroll review…
                    </td>
                  </tr>
                ) : visible.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-10 text-center text-crewly-dim">
                      No payroll results for {formatMonth(month)} yet. Calculate the month in{' '}
                      <Link className="text-indigo-300 hover:underline" to="/app/payroll/run">
                        Run Payroll
                      </Link>{' '}
                      first.
                    </td>
                  </tr>
                ) : (
                  visible.map((row) => {
                    const errors = row.reviewErrors || [];
                    const critical = errors.filter((entry) => entry.severity === 'CRITICAL');
                    return (
                      <tr key={row._id} className="border-t border-white/5 hover:bg-white/5">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-indigo-500"
                            checked={selected.includes(String(row.employeeId))}
                            onChange={() => toggleSelect(row.employeeId)}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-medium">{row.employeeName}</p>
                          <p className="text-xs text-crewly-dim">{row.employeeCode}</p>
                        </td>
                        <td className="px-3 py-2 text-xs text-crewly-dim">
                          {row.departmentName || '—'}
                        </td>
                        <td className="px-3 py-2">{formatMoney(row.totals?.gross)}</td>
                        <td className="px-3 py-2">
                          {formatMoney(row.totals?.variableEarnings)}
                          {Number(row.totals?.reimbursements) > 0 ? (
                            <span className="ml-1 text-xs text-crewly-dim">
                              · {formatMoney(row.totals.reimbursements)} reimbursed
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">{formatMoney(row.totals?.totalDeductions)}</td>
                        <td className="px-3 py-2 font-semibold">{formatMoney(row.totals?.netPay)}</td>
                        <td className="px-3 py-2">
                          {formatNumber(row.attendance?.lopDays)}
                          {row.attendance?.otHours ? (
                            <span className="ml-1 text-xs text-crewly-dim">
                              · {formatNumber(row.attendance.otHours)}h OT
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          {critical.length ? (
                            <span className="rounded-full bg-red-500/15 px-2.5 py-0.5 text-[11px] text-red-300">
                              error
                            </span>
                          ) : errors.length ? (
                            <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] text-amber-300">
                              warning
                            </span>
                          ) : row.review?.state === 'REVIEWED' ? (
                            <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] text-emerald-300">
                              ready
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-500/15 px-2.5 py-0.5 text-[11px] text-slate-300">
                              pending
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            className="text-sm text-indigo-300 hover:underline"
                            onClick={() => setDetailEmployeeId(row.employeeId)}
                          >
                            Review breakdown
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <p className="px-3 pb-3 text-xs text-crewly-dim">
            {formatNumber(selected.length)} selected · reviewing never changes a salary figure (§18).
            Recalculation happens in{' '}
            <Link className="text-indigo-300 hover:underline" to="/app/payroll/run">
              Run Payroll
            </Link>
            .
          </p>
        </div>
      ) : null}

      {/* §10 / §22 — error report */}
      {tab === 'errors' ? (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
                Payroll error report
              </h2>
              <p className="text-xs text-crewly-dim">
                {formatNumber(errorSummary.critical || 0)} critical ·{' '}
                {formatNumber(errorSummary.warnings || 0)} warnings ·{' '}
                {formatNumber(errorSummary.employeesWithErrors || 0)} employee(s) affected
              </p>
            </div>
            <button className="btn-secondary" disabled={busy} onClick={() => handleExport('ERROR_LIST')}>
              <Download size={15} /> Export error list
            </button>
          </div>

          <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-white/5">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
                <tr>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Severity</th>
                  <th className="px-3 py-2">Issue</th>
                </tr>
              </thead>
              <tbody>
                {errorRows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-crewly-dim">
                      No errors. This month is clean.
                    </td>
                  </tr>
                ) : (
                  errorRows.map((row) =>
                    (row.errors || []).map((entry, index) => (
                      <tr key={`${row.employeeId}-${entry.code}-${index}`} className="border-t border-white/5">
                        <td className="px-3 py-2">
                          {index === 0 ? (
                            <>
                              <p className="font-medium">{row.employeeName}</p>
                              <p className="text-xs text-crewly-dim">{row.employeeCode}</p>
                            </>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] ${
                              entry.severity === 'CRITICAL'
                                ? 'bg-red-500/15 text-red-300'
                                : 'bg-amber-500/15 text-amber-300'
                            }`}
                          >
                            {String(entry.severity || '').toLowerCase()}
                          </span>
                        </td>
                        <td className="px-3 py-2">{entry.message || entry.code}</td>
                      </tr>
                    )),
                  )
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-crewly-dim">
            Critical errors block locking (§10). Fix the payroll profile or the monthly inputs in{' '}
            <Link className="text-indigo-300 hover:underline" to="/app/payroll/employees">
              Employee Payroll
            </Link>
            , then recalculate the month.
          </p>
        </div>
      ) : null}

      {/* §17 — difference report */}
      {tab === 'differences' ? (
        <div className="card space-y-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
              Difference report
            </h2>
            <p className="text-xs text-crewly-dim">
              Every recalculation writes a new snapshot version (§19). This report shows what changed
              between the last two versions of {formatMonth(month)}.
            </p>
          </div>

          <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-white/5">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
                <tr>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Component</th>
                  <th className="px-3 py-2">Previous</th>
                  <th className="px-3 py-2">Current</th>
                  <th className="px-3 py-2">Difference</th>
                  <th className="px-3 py-2">Net before</th>
                  <th className="px-3 py-2">Net after</th>
                </tr>
              </thead>
              <tbody>
                {differences.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-crewly-dim">
                      No recalculation differences yet. This month has one snapshot version.
                    </td>
                  </tr>
                ) : (
                  differences.map((row) => (
                    <tr key={`${row.employeeId}-${row.component}`} className="border-t border-white/5">
                      <td className="px-3 py-2">
                        <p className="font-medium">{row.employeeName}</p>
                        <p className="text-xs text-crewly-dim">{row.employeeCode}</p>
                      </td>
                      <td className="px-3 py-2">{row.component}</td>
                      <td className="px-3 py-2">{formatMoney(row.previous)}</td>
                      <td className="px-3 py-2">{formatMoney(row.current)}</td>
                      <td
                        className={`px-3 py-2 font-semibold ${
                          Number(row.difference) < 0 ? 'text-red-300' : 'text-emerald-300'
                        }`}
                      >
                        {formatMoney(row.difference)}
                      </td>
                      <td className="px-3 py-2">{formatMoney(row.netPrevious)}</td>
                      <td className="px-3 py-2">{formatMoney(row.netCurrent)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* §15 — remarks */}
      {tab === 'remarks' ? (
        <div className="card space-y-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
              Review remarks
            </h2>
            <p className="text-xs text-crewly-dim">
              Append-only. Every note keeps its author, role and time, and nothing is ever edited or
              deleted.
            </p>
          </div>

          <div className="space-y-2">
            {(review?.remarks || []).length === 0 ? (
              <p className="text-sm text-crewly-dim">No remarks yet.</p>
            ) : (
              (review?.remarks || []).map((entry, index) => (
                <div key={`${entry.createdAt}-${index}`} className="rounded-lg bg-white/5 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-crewly-dim">
                    <span className="font-semibold text-crewly-text">{entry.authorName || 'System'}</span>
                    {entry.role ? <span>· {entry.role}</span> : null}
                    {entry.channel ? <span>· {entry.channel}</span> : null}
                    <span>· {formatStamp(entry.createdAt)}</span>
                    {entry.statusAtTime ? <span>· payroll {STATUS_LABELS[entry.statusAtTime] || entry.statusAtTime}</span> : null}
                  </div>
                  <p className="mt-1">{entry.message}</p>
                </div>
              ))
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <textarea
              className="input min-h-[80px] flex-1"
              placeholder="Add a remark — for example, why a bonus was corrected"
              value={remarkDraft}
              onChange={(event) => setRemarkDraft(event.target.value)}
              disabled={busy || !hasAnyPermission(['PAYROLL_RUN_PREPARE', 'PAYROLL_RUN_REVIEW', 'PAYROLL_RUN_APPROVE', 'PAYROLL_RUN_REJECT', 'PAYROLL_RUN_LOCK'])}
            />
            <button
              className="btn-primary"
              disabled={busy || !remarkDraft.trim()}
              onClick={async () => {
                const message = remarkDraft.trim();
                setRemarkDraft('');
                await run(() => payrollReviewService.addRemark(month, message));
              }}
            >
              <MessageSquarePlus size={15} /> Add remark
            </button>
          </div>
        </div>
      ) : null}

      {/* §19 — reports */}
      {tab === 'reports' ? (
        <div className="card space-y-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
              Payroll reports
            </h2>
            <p className="text-xs text-crewly-dim">
              Reports are built from the locked snapshot and exported as CSV. When the queue is
              configured the work runs in the background worker.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {REPORT_KEYS.map((report) => (
              <button
                key={report.key}
                className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 p-3 text-sm hover:bg-white/10"
                disabled={busy}
                onClick={() => handleExport(report.key)}
              >
                <span className="flex items-center gap-2">
                  <FileSpreadsheet size={15} className="text-crewly-dim" />
                  {report.label}
                </span>
                <Download size={15} className="text-crewly-dim" />
              </button>
            ))}
          </div>

          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-crewly-dim">
              Payroll summary report · {formatMonth(month)}
            </h3>
            <table className="w-full text-left text-sm">
              <tbody>
                {[
                  ['Total employees', formatNumber(summary.totalEmployees)],
                  ['Gross payroll', formatMoney(summary.grossPayroll)],
                  ['Total earnings', formatMoney(summary.totalEarnings)],
                  ['Total reimbursements', formatMoney(summary.totalReimbursements)],
                  ['Total deductions', formatMoney(summary.totalDeductions)],
                  ['Employer contribution', formatMoney(summary.employerContribution)],
                  ['Net payroll', formatMoney(summary.netPayroll)],
                  ['Payroll cost', formatMoney(summary.payrollCost)],
                ].map(([label, value]) => (
                  <tr key={label} className="border-t border-white/5">
                    <td className="px-2 py-1.5">{label}</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-crewly-dim">
              This is the final review before salary payment. Figures come from the calculated
              snapshot, so they match the register and every export above.
            </p>
          </section>
        </div>
      ) : null}

      <p className="text-xs text-crewly-dim">
        Review history: locked {formatStamp(review?.lockedAt)} · submitted{' '}
        {formatStamp(review?.submittedAt)} · approved {formatStamp(review?.approvedAt)} · reopened{' '}
        {formatStamp(review?.reopenedAt)} · {formatNumber(review?.lockCount || 0)} lock(s). Every
        action is written to the audit log.
      </p>

      {detailEmployeeId ? (
        <EmployeeReviewDrawer
          month={month}
          employeeId={detailEmployeeId}
          readOnly={readOnly || !canPrepare}
          busy={busy}
          onClose={() => setDetailEmployeeId(null)}
          onSaved={reload}
          flash={flash}
        />
      ) : null}

      {reasonPrompt ? (
        <Modal title={reasonPrompt.title} onClose={() => setReasonPrompt(null)}>
          <div className="space-y-3 text-sm">
            <p className="text-crewly-dim">{reasonPrompt.body}</p>
            <textarea
              className="input min-h-[90px] w-full"
              placeholder={reasonPrompt.minLength ? 'Reason (required)' : 'Reason (optional)'}
              value={reasonPrompt.value}
              onChange={(event) => setReasonPrompt({ ...reasonPrompt, value: event.target.value })}
            />
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setReasonPrompt(null)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={busy} onClick={confirmReason}>
                {busy ? <Loader2 className="animate-spin" size={15} /> : <History size={15} />}
                {reasonPrompt.actionLabel}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// §9 — one employee's payroll breakdown, with the review controls
// ─────────────────────────────────────────────────────────────
const Section = ({ title, rows, total, tone = 'default' }) => {
  if (!rows?.length) return null;
  const toneClass =
    tone === 'bad' ? 'text-red-300' : tone === 'good' ? 'text-emerald-300' : 'text-crewly-text';

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">{title}</h3>
        {total !== undefined ? (
          <span className={`text-sm font-semibold ${toneClass}`}>{formatMoney(total)}</span>
        ) : null}
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

const EmployeeReviewDrawer = ({ month, employeeId, readOnly, busy, onClose, onSaved, flash }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    payrollReviewService
      .employee(month, employeeId)
      .then((response) => {
        if (!active) return;
        setData(response || null);
        setNote(response?.review?.note || '');
      })
      .catch((error) => {
        if (active) flash('error', error?.message || 'Unable to load the payroll breakdown');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [month, employeeId, flash]);

  const save = async (state) => {
    setSaving(true);
    try {
      await payrollReviewService.reviewEmployee(month, employeeId, { state, note });
      await onSaved();
      onClose();
    } catch (error) {
      flash('error', error?.message || 'Unable to save the review');
    } finally {
      setSaving(false);
    }
  };

  const totals = data?.totals || {};
  const attendance = data?.attendance || {};
  const errors = data?.reviewErrors || [];

  return (
    <Modal
      title={`Review payroll · ${data?.employeeName || 'Employee'} · ${formatMonth(month)}`}
      onClose={onClose}
      wide
    >
      {loading ? (
        <div className="py-10 text-center text-crewly-dim">
          <Loader2 className="mx-auto animate-spin" size={18} /> Loading…
        </div>
      ) : !data ? (
        <p className="text-sm text-crewly-dim">No payroll snapshot found for this employee and month.</p>
      ) : (
        <div className="space-y-5">
          {/* §9 — salary summary: CTC, gross, net */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-lg bg-white/5 p-3">
              <p className="text-[11px] uppercase text-crewly-dim">CTC</p>
              <p className="text-sm font-semibold">{formatMoney(totals.ctc)}</p>
            </div>
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

          {errors.length ? (
            <div className="rounded-lg border-l-4 border-red-500 bg-red-500/5 p-3 text-sm">
              <p className="font-semibold text-red-200">Review issues</p>
              <ul className="mt-1 list-disc pl-5 text-crewly-dim">
                {errors.map((entry) => (
                  <li key={entry.code}>
                    {entry.message || entry.code}{' '}
                    <span className="text-xs uppercase">({String(entry.severity || '').toLowerCase()})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

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
          <Section title="Reimbursements" rows={data.reimbursements} total={totals.reimbursements} />
          <Section title="Deductions" rows={data.deductions} total={totals.totalDeductions} tone="bad" />
          <Section
            title="Employer contributions (do not reduce net pay)"
            rows={data.employerContributions}
            total={totals.employerCost}
          />

          <div className="space-y-2 border-t border-white/5 pt-3">
            <label className="block text-xs uppercase tracking-wide text-crewly-dim" htmlFor="review-note">
              Review note
            </label>
            <textarea
              id="review-note"
              className="input min-h-[70px] w-full"
              placeholder="For example: verified against the attendance register"
              value={note}
              disabled={readOnly || saving}
              onChange={(event) => setNote(event.target.value)}
            />
            {readOnly ? (
              <p className="text-xs text-crewly-dim">
                This payroll is locked. Reopen it before changing a review.
              </p>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <button className="btn-secondary" disabled={saving || busy} onClick={() => save('PENDING')}>
                  Mark pending
                </button>
                <button className="btn-primary" disabled={saving || busy} onClick={() => save('REVIEWED')}>
                  <CheckCircle2 size={15} /> Mark reviewed
                </button>
              </div>
            )}
          </div>

          <p className="text-xs text-crewly-dim">
            Snapshot version {formatNumber(data.version)} · figures are read from the calculated
            payroll, never recomputed here.
          </p>
        </div>
      )}
    </Modal>
  );
};

export default ReviewPayrollPage;
