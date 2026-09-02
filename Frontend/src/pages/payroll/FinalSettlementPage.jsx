/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BadgeIndianRupee,
  Calculator,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Lock,
  Printer,
  ScrollText,
  Search,
  ShieldCheck,
  Undo2,
  Users,
  Wallet,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import exitService from '../../services/exitService.js';
import userService from '../../services/userService.js';
import fnfService, { saveBlob } from '../../services/fnfService.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 29.11 — Payroll → Final Settlement (§19 / §25)
//
//   Dashboard    the KPI cards: pending, HR review, finance approval, …
//   Settlements  the list, with search and a department filter
//   Detail       one settlement: exit, earnings, recoveries, checklist,
//                HR review, Finance approval, payment, the F&F statement
//   Files        background exports (§21)
//
// Three things this page never does:
//   · it never computes a settlement figure — every rupee arrives already
//     calculated by the server (§7 / §8 / §10 / §12)
//   · it never lets HR approve a payment, or Finance recalculate one — the
//     buttons are permission-gated here AND re-checked server-side (§4/§24)
//   · it never edits a closed settlement (§14)
// ───────────────────────────────────────────────────────────────────────────

const money = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;
const count = (value) => Number(value || 0).toLocaleString('en-IN');

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const monthLabel = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return month || '—';
  const [year, part] = String(month).split('-');
  return `${MONTHS_LONG[Number(part) - 1]} ${year}`;
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// §14 — settlement status colours.
const STATUS_STYLES = {
  DRAFT: 'bg-slate-500/15 text-slate-300',
  CALCULATED: 'bg-sky-500/15 text-sky-300',
  HR_REVIEWED: 'bg-indigo-500/15 text-indigo-300',
  FINANCE_APPROVED: 'bg-amber-500/15 text-amber-300',
  PAID: 'bg-emerald-500/15 text-emerald-300',
  CLOSED: 'bg-violet-500/15 text-violet-300',
  REOPENED: 'bg-orange-500/15 text-orange-300',
};

const STATUS_LABELS = {
  DRAFT: 'Draft',
  CALCULATED: 'Calculated',
  HR_REVIEWED: 'HR Reviewed',
  FINANCE_APPROVED: 'Finance Approved',
  PAID: 'Paid',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
};

const statusBadge = (status) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${STATUS_STYLES[status] || STATUS_STYLES.DRAFT}`}>
    {STATUS_LABELS[status] || status || 'Draft'}
  </span>
);

// §12 — the notice decision is a decision, not an amount.
const NOTICE_LABELS = {
  COMPLETED: 'Completed Notice',
  BUYOUT: 'Notice Buyout',
  WAIVED: 'Notice Waived',
};

// §9 / §10 — the item catalogues the server accepts.
const RECOVERY_TYPES = [
  ['NOTICE', 'Notice Recovery'],
  ['ASSET', 'Asset Recovery'],
  ['CAFETERIA', 'Cafeteria Recovery'],
  ['ADVANCE_SALARY', 'Advance Salary Recovery'],
  ['OTHER', 'Other Company Recovery'],
];

const PAYABLE_TYPES = [
  ['PERFORMANCE_BONUS', 'Performance Bonus'],
  ['INCENTIVE', 'Incentive'],
  ['LEAVE_ENCASHMENT', 'Leave Encashment'],
  ['GRATUITY', 'Gratuity'],
  ['REIMBURSEMENT', 'Reimbursement'],
  ['OVERTIME', 'Pending Overtime'],
];

// §5 — the create picker's escape hatch: an exit with no approved resignation.
const MANUAL_EXIT = '__MANUAL__';

const CHECKLIST_LABELS = {
  attendanceVerified: 'Attendance Verified',
  leaveVerified: 'Leave Verified',
  assetClearanceCompleted: 'Asset Clearance Completed',
  noticeDecisionCompleted: 'Notice Decision Completed',
};

const TABS = [
  { key: 'DASHBOARD', label: 'Dashboard', icon: BadgeIndianRupee },
  { key: 'SETTLEMENTS', label: 'Settlements', icon: Users },
  { key: 'DETAIL', label: 'Settlement Detail', icon: FileText },
  { key: 'FILES', label: 'Downloads', icon: FileSpreadsheet },
];

const KpiCard = ({ icon: Icon, label, value, tone = 'default', onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`card p-4 text-left ${onClick ? 'transition hover:border-crewly-accent/40' : 'cursor-default'}`}
  >
    <div className="flex items-center justify-between">
      <span className="text-xs uppercase tracking-wide text-crewly-dim">{label}</span>
      <Icon size={16} className="text-crewly-dim" />
    </div>
    <p
      className={`mt-2 text-xl font-semibold ${
        tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-crewly-text'
      }`}
    >
      {value}
    </p>
  </button>
);

const SectionTitle = ({ children, note }) => (
  <div className="mb-2">
    <h3 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">{children}</h3>
    {note ? <p className="text-xs text-crewly-dim">{note}</p> : null}
  </div>
);

const Field = ({ label, value }) => (
  <div>
    <dt className="text-xs uppercase tracking-wide text-crewly-dim">{label}</dt>
    <dd className="mt-0.5 text-sm font-medium">{value === '' || value === null || value === undefined ? '—' : value}</dd>
  </div>
);

const FinalSettlementPage = () => {
  const { loading: permsLoading, hasAnyPermission, hasPermission } = usePermission();

  // §4 — permissions, never role names.
  const canRead = hasAnyPermission([
    'FINAL_SETTLEMENT_READ',
    'FINAL_SETTLEMENT_CALCULATE',
    'FINAL_SETTLEMENT_REVIEW',
    'FINAL_SETTLEMENT_APPROVE',
    'FINAL_SETTLEMENT_PAY',
    'FINAL_SETTLEMENT_CLOSE',
    'FINAL_SETTLEMENT_REOPEN',
  ]);
  const canCalculate = hasPermission('FINAL_SETTLEMENT_CALCULATE');
  const canReview = hasPermission('FINAL_SETTLEMENT_REVIEW');
  const canApprove = hasPermission('FINAL_SETTLEMENT_APPROVE');
  const canPay = hasPermission('FINAL_SETTLEMENT_PAY');
  const canClose = hasPermission('FINAL_SETTLEMENT_CLOSE');
  const canReopen = hasPermission('FINAL_SETTLEMENT_REOPEN');

  // All months by default — an exit is not a monthly event, and hiding it
  // behind the current month would make a real settlement invisible.
  const [month, setMonth] = useState('');
  const [tab, setTab] = useState('DASHBOARD');

  const [dashboard, setDashboard] = useState(null);
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const [files, setFiles] = useState([]);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [departmentId, setDepartmentId] = useState('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);

  // §5 — creating a settlement from an approved resignation. HR picks an exit
  // Crewly already knows about; the last working day is never re-typed (§6).
  const [createOpen, setCreateOpen] = useState(false);
  const [resignations, setResignations] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [createDraft, setCreateDraft] = useState({
    resignationId: '',
    employeeId: '',
    lastWorkingDate: '',
    noticePeriodDays: 60,
    noticeDecision: 'COMPLETED',
  });

  // §9 / §10 — adding a payable or a recovery by hand.
  const [itemDraft, setItemDraft] = useState({ kind: 'RECOVERY', type: 'ASSET', amount: '', label: '', reason: '' });

  // §13 — the recovery Finance adds for an asset that was not returned.
  const [recoveryDraft, setRecoveryDraft] = useState({ type: 'ASSET', amount: '', reason: '' });

  // §16 — Finance remarks; §14 — the reopen reason.
  const [remarks, setRemarks] = useState('');
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  // §5 — payment details.
  const [paymentDraft, setPaymentDraft] = useState({ paidAt: new Date().toISOString().slice(0, 10), reference: '', method: 'Bank Transfer' });

  const [checklist, setChecklist] = useState({});

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 7000);
  }, []);

  // ── loads ────────────────────────────────────────────────────────────────

  const loadDashboard = useCallback(async () => {
    try {
      const data = await fnfService.dashboard(month);
      setDashboard(data || null);
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403) setAccessDenied(true);
      else flash('error', error?.message || 'Unable to load the settlement dashboard');
    } finally {
      setLoading(false);
    }
  }, [month, flash]);

  const loadList = useCallback(async () => {
    try {
      const data = await fnfService.list({ month, status: statusFilter, search, departmentId });
      setRows(data || []);
    } catch (error) {
      flash('error', error?.message || 'Unable to load settlements');
    }
  }, [month, statusFilter, search, departmentId, flash]);

  const loadDetail = useCallback(
    async (settlementId) => {
      try {
        const data = await fnfService.get(settlementId);
        setDetail(data || null);
        setChecklist(data?.checklist || {});
        setRemarks(data?.approval?.financeRemarks || '');
      } catch (error) {
        flash('error', error?.message || 'Unable to load this settlement');
      }
    },
    [flash],
  );

  // Typing in the search box must not fire one request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const loadCreateOptions = useCallback(async () => {
    const [approved, users] = await Promise.all([
      exitService.requests('APPROVED').catch(() => []),
      userService.getAll({ limit: 200 }).catch(() => ({ data: [] })),
    ]);
    setResignations(Array.isArray(approved) ? approved : []);
    const list = users?.data || users || [];
    setEmployees(Array.isArray(list) ? list : []);
  }, []);

  const openCreate = () => {
    setCreateOpen(true);
    loadCreateOptions();
  };

  const loadFiles = useCallback(async () => {
    try {
      setFiles(await fnfService.files(month));
    } catch {
      setFiles([]);
    }
  }, [month]);

  useEffect(() => {
    if (!permsLoading && canRead) {
      loadDashboard();
      loadList();
      loadFiles();
    }
    if (!permsLoading && !canRead) setLoading(false);
  }, [permsLoading, canRead, loadDashboard, loadList, loadFiles]);

  const openDetail = async (settlementId) => {
    setTab('DETAIL');
    await loadDetail(settlementId);
  };

  // ── actions ──────────────────────────────────────────────────────────────

  const run = async (action, message) => {
    setBusy(true);
    try {
      const result = await action();
      flash('success', typeof message === 'function' ? message(result) : message);
      if (detail?._id) await loadDetail(detail._id);
      await loadDashboard();
      await loadList();
      return result;
    } catch (error) {
      flash('error', error?.message || 'Unable to complete the action');
      if (detail?._id) await loadDetail(detail._id);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () =>
    run(
      async () => {
        const chosen =
          createDraft.resignationId && createDraft.resignationId !== MANUAL_EXIT
            ? resignations.find((row) => String(row._id) === String(createDraft.resignationId))
            : null;

        // §6 — with an approved resignation the last working day comes from
        // the Exit module; only a manual exit asks for one.
        const employeeId = chosen ? String(chosen.user?._id || chosen.user || '') : createDraft.employeeId;
        if (!employeeId) throw new Error('Choose an employee');

        const created = await fnfService.create({
          employeeId,
          resignationId: chosen ? String(chosen._id) : undefined,
          month: month || undefined,
          lastWorkingDate: chosen ? undefined : createDraft.lastWorkingDate || undefined,
          noticePeriodDays: Number(createDraft.noticePeriodDays) || 60,
          noticeDecision: createDraft.noticeDecision,
        });
        setCreateOpen(false);
        setCreateDraft({ resignationId: '', employeeId: '', lastWorkingDate: '', noticePeriodDays: 60, noticeDecision: 'COMPLETED' });
        if (created?.settlementId) await loadDetail(created.settlementId);
        return created;
      },
      (result) => `Settlement ${result?.settlementNumber || ''} created`,
    ).then((result) => {
      if (result?.settlementId) setTab('DETAIL');
    });

  const handleCalculate = () =>
    run(() => fnfService.calculate(detail._id), 'Final settlement calculated from the payroll snapshot');

  const handleNotice = (decision) =>
    run(
      () => fnfService.setNotice({ settlementId: detail._id, decision, noticePeriodDays: detail?.exit?.noticePeriodDays }),
      () => `Notice decision set to ${NOTICE_LABELS[decision] || decision}`,
    );

  const handleAddItem = () => {
    const amount = Number(itemDraft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      flash('error', 'Enter an amount greater than zero');
      return null;
    }
    if (itemDraft.kind === 'RECOVERY' && !String(itemDraft.reason || '').trim()) {
      flash('error', 'A recovery needs a reason');
      return null;
    }

    const item = {
      type: itemDraft.type,
      amount,
      label: itemDraft.label || undefined,
      ...(itemDraft.kind === 'RECOVERY' ? { reason: itemDraft.reason } : { note: itemDraft.reason }),
    };

    return run(
      () =>
        fnfService.updateItems({
          settlementId: detail._id,
          payables: itemDraft.kind === 'PAYABLE' ? [...(detail.earnings?.additional || []).filter((row) => row.source !== 'SYSTEM'), item] : undefined,
          recoveries: itemDraft.kind === 'RECOVERY' ? [...(detail.recoveries?.items || []), item] : undefined,
        }),
      () => (itemDraft.kind === 'RECOVERY' ? 'Recovery added' : 'Payable added'),
    ).then(() => {
      setItemDraft({ kind: itemDraft.kind, type: itemDraft.type, amount: '', label: '', reason: '' });
    });
  };

  const handleRemoveItem = (kind, index) =>
    run(
      () =>
        fnfService.updateItems({
          settlementId: detail._id,
          payables:
            kind === 'PAYABLE'
              ? (detail.earnings?.additional || []).filter((row) => row.source !== 'SYSTEM').filter((_, i) => i !== index)
              : undefined,
          recoveries:
            kind === 'RECOVERY'
              ? (detail.recoveries?.items || []).filter((_, i) => i !== index)
              : undefined,
        }),
      'Item removed',
    );

  const handleChecklist = (complete) =>
    run(
      () => fnfService.hrReview({ settlementId: detail._id, checklist, complete, remarks }),
      complete ? 'Settlement sent to Finance' : 'Checklist saved',
    );

  const handleAddRecovery = () => {
    const amount = Number(recoveryDraft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      flash('error', 'Enter an amount greater than zero');
      return null;
    }
    if (String(recoveryDraft.reason || '').trim().length < 3) {
      flash('error', 'A recovery needs a reason the employee can read');
      return null;
    }
    return run(
      () =>
        fnfService.addRecovery({
          settlementId: detail._id,
          type: recoveryDraft.type,
          amount,
          reason: recoveryDraft.reason,
        }),
      'Recovery added — the salary figures were left exactly as they were',
    ).then(() => setRecoveryDraft({ type: recoveryDraft.type, amount: '', reason: '' }));
  };

  const handleFinance = (action) =>
    run(
      () => fnfService.finance({ settlementId: detail._id, action, remarks }),
      action === 'APPROVE' ? 'Settlement approved — ready for payment' : 'Settlement returned to HR review',
    ).then(() => setRemarks(''));

  const handlePay = () =>
    run(
      () => fnfService.markPaid({ settlementId: detail._id, ...paymentDraft }),
      'Settlement marked paid — the employee has been notified',
    );

  const handleClose = () => run(() => fnfService.close(detail._id), 'Settlement closed and archived');

  const handleReopen = () =>
    run(
      async () => {
        await fnfService.reopen({ settlementId: detail._id, remarks: reopenReason });
        setReopenOpen(false);
        setReopenReason('');
      },
      'Settlement reopened',
    );

  const handleStatement = () =>
    run(
      () => fnfService.requestStatement(detail._id),
      (result) => (result?.queued ? 'F&F statement queued — it will appear shortly' : 'F&F statement generated'),
    );

  const handleDownloadStatement = async () => {
    setBusy(true);
    try {
      const blob = await fnfService.downloadStatement(detail._id);
      saveBlob(blob, `FNF-${detail.settlementNumber}.pdf`);
    } catch (error) {
      flash('error', error?.message || 'Unable to download the F&F statement');
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (format) => {
    setBusy(true);
    try {
      const blob = await fnfService.register({ month, format });
      saveBlob(blob, `final-settlement-register-${month || 'all'}.${String(format).toLowerCase()}`);
    } catch (error) {
      flash('error', error?.message || 'Unable to build the settlement register');
    } finally {
      setBusy(false);
    }
  };

  const handleRequestRegister = () =>
    run(
      () => fnfService.requestRegister({ month, format: 'XLSX' }),
      (result) => (result?.queued ? 'Register queued — it will appear under Downloads' : 'Register ready'),
    ).then(() => loadFiles());

  const handleDownloadFile = async (fileId, filename) => {
    setBusy(true);
    try {
      saveBlob(await fnfService.downloadFile(fileId), filename || 'settlement-register.xlsx');
      await loadFiles();
    } catch (error) {
      flash('error', error?.message || 'Unable to download this file');
    } finally {
      setBusy(false);
    }
  };

  // ── guards ───────────────────────────────────────────────────────────────

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Final Settlement</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Final settlement access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to view final settlements. Contact your Company Admin or Payroll
            Admin.
          </p>
        </div>
      </div>
    );
  }

  const kpis = dashboard?.kpis || {};
  const departments = dashboard?.departments || [];

  const pending = detail?.earnings?.pendingSalary || {};
  const leave = detail?.earnings?.leaveEncashment || {};
  const gratuity = detail?.earnings?.gratuity || {};
  const notice = detail?.recoveries?.notice || {};
  const totals = detail?.totals || {};
  const manualPayables = (detail?.earnings?.additional || []).filter((item) => item.source !== 'SYSTEM');
  const systemPayables = (detail?.earnings?.additional || []).filter((item) => item.source === 'SYSTEM');
  const checklistDone = (detail?.checklistProgress?.done ?? 0);

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Final Settlement</h1>
          <p className="text-sm text-crewly-dim">
            Full &amp; Final settlement for every exiting employee · {month ? monthLabel(month) : 'All months'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            className="input-field w-auto"
            aria-label="Settlement month"
          />
          {canCalculate && (
            <button type="button" className="btn-primary flex items-center gap-2" onClick={openCreate}>
              <Users size={15} /> New settlement
            </button>
          )}
          <button
            type="button"
            className="btn-secondary flex items-center gap-2"
            onClick={() => handleRegister('CSV')}
            disabled={busy}
          >
            <ScrollText size={15} /> Register
          </button>
          <button
            type="button"
            className="btn-secondary flex items-center gap-2"
            onClick={handleRequestRegister}
            disabled={busy}
          >
            <FileSpreadsheet size={15} /> Export XLSX
          </button>
        </div>
      </div>

      {banner ? (
        <div
          className={`card flex items-start gap-2 text-sm ${
            banner.type === 'error' ? 'border-red-500/40 text-red-300' : 'border-emerald-500/40 text-emerald-300'
          }`}
        >
          {banner.type === 'error' ? <AlertTriangle size={16} className="mt-0.5" /> : <CheckCircle2 size={16} className="mt-0.5" />}
          <span>{banner.text}</span>
        </div>
      ) : null}

      {/* ── tabs ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1 border-b border-white/10 pb-2">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition ${
              tab === key ? 'bg-crewly-accent/15 text-crewly-accent' : 'text-crewly-dim hover:text-crewly-text'
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card flex items-center gap-2 text-sm text-crewly-dim">
          <Loader2 size={16} className="animate-spin" /> Loading final settlements…
        </div>
      ) : null}

      {/* ── §19 — dashboard ────────────────────────────────────────────── */}
      {tab === 'DASHBOARD' && !loading ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <KpiCard
              icon={Users}
              label="Pending Settlements"
              value={count(kpis.pendingSettlements)}
              onClick={() => {
                setStatusFilter('');
                setTab('SETTLEMENTS');
              }}
            />
            <KpiCard
              icon={ClipboardCheck}
              label="HR Review"
              value={count(kpis.hrReview)}
              tone="warn"
              onClick={() => {
                setStatusFilter('HR_REVIEWED');
                setTab('SETTLEMENTS');
              }}
            />
            <KpiCard
              icon={ShieldCheck}
              label="Finance Approval"
              value={count(kpis.financeApproval)}
              tone="warn"
              onClick={() => {
                setStatusFilter('FINANCE_APPROVED');
                setTab('SETTLEMENTS');
              }}
            />
            <KpiCard icon={Wallet} label="Paid" value={count(kpis.paid)} tone="good" onClick={() => {
              setStatusFilter('PAID');
              setTab('SETTLEMENTS');
            }} />
            <KpiCard icon={Lock} label="Closed" value={count(kpis.closed)} onClick={() => {
              setStatusFilter('CLOSED');
              setTab('SETTLEMENTS');
            }} />
            <KpiCard
              icon={BadgeIndianRupee}
              label="Total Settlement Amount"
              value={money(kpis.totalSettlementAmount)}
            />
          </div>

          <div className="card">
            <SectionTitle note="The most recent exits, newest last-working-day first.">
              Recent settlements
            </SectionTitle>
            {dashboard?.recent?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-crewly-dim">
                    <tr>
                      <th className="py-2 pr-3">Settlement</th>
                      <th className="py-2 pr-3">Employee</th>
                      <th className="py-2 pr-3">Last working day</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3 text-right">Net settlement</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.recent.map((row) => (
                      <tr key={row._id} className="border-t border-white/5">
                        <td className="py-2 pr-3 font-medium">{row.settlementNumber}</td>
                        <td className="py-2 pr-3">
                          {row.employeeName}
                          <span className="block text-xs text-crewly-dim">{row.employeeCode}</span>
                        </td>
                        <td className="py-2 pr-3">{formatDate(row.lastWorkingDate)}</td>
                        <td className="py-2 pr-3">{statusBadge(row.status)}</td>
                        <td className="py-2 pr-3 text-right">{money(row.netSettlement)}</td>
                        <td className="py-2 text-right">
                          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => openDetail(row._id)}>
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-crewly-dim">No settlements yet for this month.</p>
            )}
          </div>
        </div>
      ) : null}

      {/* ── §19 — the list ─────────────────────────────────────────────── */}
      {tab === 'SETTLEMENTS' && !loading ? (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 text-xs uppercase tracking-wide text-crewly-dim">
              Search
              <span className="relative mt-1 block">
                <Search size={14} className="absolute left-2 top-2.5 text-crewly-dim" />
                <input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Name, employee code or settlement number"
                  className="input-field w-full pl-7"
                />
              </span>
            </label>
            <label className="text-xs uppercase tracking-wide text-crewly-dim">
              Status
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="input-field mt-1 w-auto"
              >
                <option value="">All statuses</option>
                {Object.keys(STATUS_LABELS).map((key) => (
                  <option key={key} value={key}>
                    {STATUS_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs uppercase tracking-wide text-crewly-dim">
              Department
              <select
                value={departmentId}
                onChange={(event) => setDepartmentId(event.target.value)}
                className="input-field mt-1 w-auto"
              >
                <option value="">All departments</option>
                {departments.map((department) => (
                  <option key={department._id} value={department._id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-crewly-dim">
                  <tr>
                    <th className="py-2 pr-3">Settlement</th>
                    <th className="py-2 pr-3">Employee</th>
                    <th className="py-2 pr-3">Department</th>
                    <th className="py-2 pr-3">Last working day</th>
                    <th className="py-2 pr-3">Checklist</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3 text-right">Net settlement</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row._id} className="border-t border-white/5">
                      <td className="py-2 pr-3 font-medium">{row.settlementNumber}</td>
                      <td className="py-2 pr-3">
                        {row.employeeName}
                        <span className="block text-xs text-crewly-dim">{row.employeeCode}</span>
                      </td>
                      <td className="py-2 pr-3 text-crewly-dim">{row.department || '—'}</td>
                      <td className="py-2 pr-3">{formatDate(row.lastWorkingDate)}</td>
                      <td className="py-2 pr-3 text-xs text-crewly-dim">
                        {row.checklistProgress?.done ?? 0}/{row.checklistProgress?.total ?? 4}
                      </td>
                      <td className="py-2 pr-3">{statusBadge(row.status)}</td>
                      <td className="py-2 pr-3 text-right">{money(row.netSettlement)}</td>
                      <td className="py-2 text-right">
                        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => openDetail(row._id)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-crewly-dim">No settlements match these filters.</p>
          )}
        </div>
      ) : null}

      {/* ── §25 — one settlement ───────────────────────────────────────── */}
      {tab === 'DETAIL' ? (
        detail ? (
          <div className="space-y-5">
            <div className="card flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{detail.employee?.name || detail.exit?.employeeName}</h2>
                  {statusBadge(detail.status)}
                  {detail.locked ? (
                    <span className="flex items-center gap-1 text-xs text-crewly-dim">
                      <Lock size={12} /> immutable
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-crewly-dim">
                  {detail.settlementNumber} · {detail.employee?.employeeCode} · {detail.employee?.designation}
                  {detail.employee?.departmentName ? ` · ${detail.employee.departmentName}` : ''} ·{' '}
                  {detail.monthLabel}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canCalculate && detail.editable ? (
                  <button type="button" className="btn-secondary flex items-center gap-2" onClick={handleCalculate} disabled={busy}>
                    <Calculator size={15} /> Calculate
                  </button>
                ) : null}
                {canCalculate && !detail.locked ? (
                  <button type="button" className="btn-secondary flex items-center gap-2" onClick={handleStatement} disabled={busy}>
                    <Printer size={15} /> Statement
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-secondary flex items-center gap-2"
                  onClick={handleDownloadStatement}
                  disabled={busy || !['PAID', 'CLOSED'].includes(detail.status)}
                >
                  <Download size={15} /> Download F&amp;F
                </button>
                {canClose && detail.status === 'PAID' ? (
                  <button type="button" className="btn-primary flex items-center gap-2" onClick={handleClose} disabled={busy}>
                    <Lock size={15} /> Close
                  </button>
                ) : null}
                {canReopen && detail.status === 'CLOSED' ? (
                  <button type="button" className="btn-secondary flex items-center gap-2" onClick={() => setReopenOpen(true)} disabled={busy}>
                    <Undo2 size={15} /> Reopen
                  </button>
                ) : null}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              {/* §11 — the settlement */}
              <div className="card space-y-4 lg:col-span-2">
                <div>
                  <SectionTitle note="Copied from the Exit module — never re-typed here (§6).">
                    Exit details
                  </SectionTitle>
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Field label="Date of Joining" value={formatDate(detail.exit?.joiningDate)} />
                    <Field label="Resignation Date" value={formatDate(detail.exit?.resignationDate)} />
                    <Field label="Last Working Day" value={formatDate(detail.exit?.lastWorkingDate)} />
                    <Field label="Notice Period" value={detail.exit?.noticePeriodDays ? `${detail.exit.noticePeriodDays} days` : '—'} />
                    <Field label="Notice Served" value={detail.exit?.servedDays != null ? `${detail.exit.servedDays} days` : '—'} />
                    <Field label="Notice Decision" value={NOTICE_LABELS[detail.exit?.noticeDecision] || 'Completed Notice'} />
                  </dl>
                  {detail.exit?.reason ? (
                    <p className="mt-3 rounded-lg bg-white/5 p-2 text-xs text-crewly-dim">{detail.exit.reason}</p>
                  ) : null}
                </div>

                <div>
                  <SectionTitle note="Salary is paid only up to the last working day, and the arithmetic is shown (§7).">
                    Earnings
                  </SectionTitle>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        <tr className="border-t border-white/5">
                          <td className="py-2 pr-3">
                            Pending Salary
                            <span className="block text-xs text-crewly-dim">
                              {pending.payableDays ?? 0} payable day(s) × {money(pending.dailyRate)} of{' '}
                              {pending.workingDays ?? 0} working days
                              {Number(pending.lopDays) > 0 ? `, less ${pending.lopDays} loss of pay` : ''}
                            </span>
                          </td>
                          <td className="py-2 text-right">{money(pending.amount)}</td>
                        </tr>
                        {leave.amount > 0 ? (
                          <tr className="border-t border-white/5">
                            <td className="py-2 pr-3">
                              Leave Encashment ({leave.leaveType || 'EARNED'})
                              <span className="block text-xs text-crewly-dim">
                                {leave.encashedDays ?? 0} day(s) × {money(leave.dailyRate)}
                                {leave.capped ? ` · capped at ${leave.maxDays} days` : ''}
                              </span>
                            </td>
                            <td className="py-2 text-right">{money(leave.amount)}</td>
                          </tr>
                        ) : null}
                        {gratuity.amount > 0 ? (
                          <tr className="border-t border-white/5">
                            <td className="py-2 pr-3">
                              Gratuity
                              <span className="block text-xs text-crewly-dim">{gratuity.reason}</span>
                            </td>
                            <td className="py-2 text-right">{money(gratuity.amount)}</td>
                          </tr>
                        ) : null}
                        {systemPayables
                          .filter((item) => item.type !== 'LEAVE_ENCASHMENT' && item.type !== 'GRATUITY')
                          .map((item, index) => (
                            <tr key={`system-${index}`} className="border-t border-white/5">
                              <td className="py-2 pr-3">
                                {item.label}
                                <span className="block text-xs text-crewly-dim">{item.note}</span>
                              </td>
                              <td className="py-2 text-right">{money(item.amount)}</td>
                            </tr>
                          ))}
                        {manualPayables.map((item, index) => (
                          <tr key={`manual-${index}`} className="border-t border-white/5">
                            <td className="py-2 pr-3">
                              {item.label}
                              <span className="block text-xs text-crewly-dim">{item.note}</span>
                            </td>
                            <td className="py-2 text-right">
                              {money(item.amount)}
                              {detail.editable && canCalculate ? (
                                <button
                                  type="button"
                                  className="ml-2 text-xs text-red-300"
                                  onClick={() => handleRemoveItem('PAYABLE', index)}
                                >
                                  remove
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                        <tr className="border-t border-white/10 font-semibold">
                          <td className="py-2 pr-3">Total Earnings</td>
                          <td className="py-2 text-right">{money(totals.totalEarnings)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <SectionTitle note="Recoveries are shown separately — a notice buyout is not a salary deduction (§9).">
                    Recoveries
                  </SectionTitle>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        {notice.amount > 0 || notice.waived ? (
                          <tr className="border-t border-white/5">
                            <td className="py-2 pr-3">
                              Notice Recovery ({NOTICE_LABELS[notice.decision] || 'Notice'})
                              <span className="block text-xs text-crewly-dim">
                                {notice.waived
                                  ? `${notice.shortfallDays ?? 0} shortfall day(s) waived by the company`
                                  : `${notice.shortfallDays ?? 0} shortfall day(s) × ${money(notice.dailyRate)} — required ${notice.noticePeriodDays ?? 0}, served ${notice.servedDays ?? 0}`}
                              </span>
                            </td>
                            <td className="py-2 text-right">{money(notice.amount)}</td>
                          </tr>
                        ) : null}
                        {(detail.recoveries?.items || []).map((item, index) => (
                          <tr key={`recovery-${index}`} className="border-t border-white/5">
                            <td className="py-2 pr-3">
                              {item.label}
                              <span className="block text-xs text-crewly-dim">
                                {item.reason}
                                {item.approvedByName ? ` · approved by ${item.approvedByName}` : ''}
                              </span>
                            </td>
                            <td className="py-2 text-right">
                              {money(item.amount)}
                              {detail.editable && canCalculate ? (
                                <button
                                  type="button"
                                  className="ml-2 text-xs text-red-300"
                                  onClick={() => handleRemoveItem('RECOVERY', index)}
                                >
                                  remove
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                        <tr className="border-t border-white/10 font-semibold">
                          <td className="py-2 pr-3">Total Recoveries</td>
                          <td className="py-2 text-right">{money(totals.totalRecoveries)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div
                  className={`rounded-xl p-4 ${
                    (totals.netSettlement || 0) < 0 ? 'bg-red-500/10' : 'bg-emerald-500/10'
                  }`}
                >
                  <p className="text-xs uppercase tracking-wide text-crewly-dim">
                    {Number(totals.netSettlement || 0) < 0
                      ? 'Amount recoverable from the employee'
                      : 'Net Settlement (Full & Final)'}
                  </p>
                  <p
                    className={`text-2xl font-semibold ${
                      (totals.netSettlement || 0) < 0 ? 'text-red-300' : 'text-emerald-300'
                    }`}
                  >
                    {money(totals.netSettlement)}
                  </p>
                </div>
              </div>

              {/* §15 / §16 / §5 — the workflow */}
              <div className="space-y-4">
                <div className="card space-y-3">
                  <SectionTitle note="Finance approval stays closed until every item is ticked (§15).">
                    HR review checklist ({checklistDone}/{detail.checklistProgress?.total ?? 4})
                  </SectionTitle>
                  {Object.entries(CHECKLIST_LABELS).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={Boolean(checklist?.[key])}
                        disabled={!canReview || detail.locked}
                        onChange={(event) => setChecklist((current) => ({ ...current, [key]: event.target.checked }))}
                      />
                      {label}
                    </label>
                  ))}
                  {canReview && !detail.locked ? (
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        className="btn-secondary flex-1"
                        onClick={() => handleChecklist(false)}
                        disabled={busy || detail.status === 'HR_REVIEWED'}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn-primary flex-1"
                        onClick={() => handleChecklist(true)}
                        disabled={busy || detail.status === 'HR_REVIEWED'}
                      >
                        Send to Finance
                      </button>
                    </div>
                  ) : null}
                  {detail.approval?.hrReviewedByName ? (
                    <p className="text-xs text-crewly-dim">
                      Reviewed by {detail.approval.hrReviewedByName} on {formatDate(detail.approval.hrReviewedAt)}
                    </p>
                  ) : null}
                </div>

                <div className="card space-y-3">
                  <SectionTitle note="Assets still in the employee's hands at settlement time (§13).">
                    Asset clearance
                  </SectionTitle>
                  {detail.assets?.length ? (
                    <ul className="space-y-1 text-sm">
                      {detail.assets.map((asset) => (
                        <li key={asset.assetId} className="flex items-center justify-between gap-2">
                          <span>{asset.name}</span>
                          <span className="text-xs text-amber-300">{asset.status}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-crewly-dim">No assets outstanding.</p>
                  )}
                </div>

                {canCalculate && detail.editable ? (
                  <div className="card space-y-3">
                    <SectionTitle note="Every recovery needs an amount and a reason (§9).">
                      Add an item
                    </SectionTitle>
                    <select
                      value={itemDraft.kind}
                      onChange={(event) =>
                        setItemDraft((current) => ({
                          ...current,
                          kind: event.target.value,
                          type: event.target.value === 'RECOVERY' ? 'ASSET' : 'PERFORMANCE_BONUS',
                        }))
                      }
                      className="input-field w-full"
                    >
                      <option value="RECOVERY">Recovery</option>
                      <option value="PAYABLE">Additional payable</option>
                    </select>
                    <select
                      value={itemDraft.type}
                      onChange={(event) => setItemDraft((current) => ({ ...current, type: event.target.value }))}
                      className="input-field w-full"
                    >
                      {(itemDraft.kind === 'RECOVERY' ? RECOVERY_TYPES : PAYABLE_TYPES).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Amount"
                      value={itemDraft.amount}
                      onChange={(event) => setItemDraft((current) => ({ ...current, amount: event.target.value }))}
                      className="input-field w-full"
                    />
                    <input
                      placeholder={itemDraft.kind === 'RECOVERY' ? 'Reason (required)' : 'Note'}
                      value={itemDraft.reason}
                      onChange={(event) => setItemDraft((current) => ({ ...current, reason: event.target.value }))}
                      className="input-field w-full"
                    />
                    <button type="button" className="btn-primary w-full" onClick={handleAddItem} disabled={busy}>
                      Add {itemDraft.kind === 'RECOVERY' ? 'recovery' : 'payable'}
                    </button>
                  </div>
                ) : null}

                {canCalculate && detail.editable ? (
                  <div className="card space-y-2">
                    <SectionTitle>Notice decision (§12)</SectionTitle>
                    <div className="flex flex-wrap gap-2">
                      {Object.keys(NOTICE_LABELS).map((decision) => (
                        <button
                          key={decision}
                          type="button"
                          className={`btn-secondary px-2 py-1 text-xs ${
                            detail.exit?.noticeDecision === decision ? 'border-crewly-accent text-crewly-accent' : ''
                          }`}
                          onClick={() => handleNotice(decision)}
                          disabled={busy}
                        >
                          {NOTICE_LABELS[decision]}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {(canApprove || canPay) && !detail.locked ? (
                  <div className="card space-y-3">
                    <SectionTitle note="A rejection needs remarks so HR knows what to fix (§16).">
                      Finance
                    </SectionTitle>
                    <textarea
                      value={remarks}
                      onChange={(event) => setRemarks(event.target.value)}
                      placeholder="Remarks (required to reject)"
                      className="input-field w-full"
                      rows={2}
                    />
                    {/* §13 — an unreturned laptop is discovered at clearance
                        time, which is Finance's stage. Finance may add the
                        recovery here — and nothing else: no payable, and the
                        salary figures are not recalculated behind HR's back. */}
                    {canApprove && detail.status === 'HR_REVIEWED' ? (
                      <div className="space-y-2 border-b border-white/10 pb-3">
                        <p className="text-xs uppercase tracking-wide text-crewly-dim">
                          Add a recovery (§13)
                        </p>
                        <select
                          value={recoveryDraft.type}
                          onChange={(event) => setRecoveryDraft((current) => ({ ...current, type: event.target.value }))}
                          className="input-field w-full"
                        >
                          {RECOVERY_TYPES.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Amount"
                          value={recoveryDraft.amount}
                          onChange={(event) => setRecoveryDraft((current) => ({ ...current, amount: event.target.value }))}
                          className="input-field w-full"
                        />
                        <input
                          placeholder="Reason (required)"
                          value={recoveryDraft.reason}
                          onChange={(event) => setRecoveryDraft((current) => ({ ...current, reason: event.target.value }))}
                          className="input-field w-full"
                        />
                        <button
                          type="button"
                          className="btn-secondary w-full"
                          onClick={handleAddRecovery}
                          disabled={busy}
                        >
                          Add recovery
                        </button>
                      </div>
                    ) : null}
                    {canApprove && detail.status === 'HR_REVIEWED' ? (
                      <div className="flex gap-2">
                        <button type="button" className="btn-primary flex-1" onClick={() => handleFinance('APPROVE')} disabled={busy}>
                          Approve
                        </button>
                        <button type="button" className="btn-secondary flex-1" onClick={() => handleFinance('REJECT')} disabled={busy}>
                          Reject
                        </button>
                      </div>
                    ) : null}
                    {detail.approval?.financeByName ? (
                      <p className="text-xs text-crewly-dim">
                        {detail.approval.financeByName} on {formatDate(detail.approval.financeAt)}
                        {detail.approval.financeRemarks ? ` · ${detail.approval.financeRemarks}` : ''}
                      </p>
                    ) : null}

                    {canPay && detail.status === 'FINANCE_APPROVED' ? (
                      <div className="space-y-2 border-t border-white/10 pt-3">
                        <input
                          type="date"
                          value={paymentDraft.paidAt}
                          onChange={(event) => setPaymentDraft((current) => ({ ...current, paidAt: event.target.value }))}
                          className="input-field w-full"
                        />
                        <input
                          placeholder="Payment reference"
                          value={paymentDraft.reference}
                          onChange={(event) => setPaymentDraft((current) => ({ ...current, reference: event.target.value }))}
                          className="input-field w-full"
                        />
                        <button type="button" className="btn-primary w-full" onClick={handlePay} disabled={busy}>
                          Mark paid
                        </button>
                      </div>
                    ) : null}
                    {detail.payment?.paidAt ? (
                      <p className="text-xs text-crewly-dim">
                        Paid {formatDate(detail.payment.paidAt)}
                        {detail.payment.reference ? ` · ${detail.payment.reference}` : ''}
                        {detail.payment.paidByName ? ` · ${detail.payment.paidByName}` : ''}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="card space-y-2">
                  <SectionTitle>History (§23)</SectionTitle>
                  <ul className="space-y-2 text-xs text-crewly-dim">
                    {(detail.history || []).map((entry, index) => (
                      <li key={`${entry.status}-${index}`}>
                        <span className="text-crewly-text">{STATUS_LABELS[entry.status] || entry.status}</span>
                        {entry.previousStatus ? ` ← ${STATUS_LABELS[entry.previousStatus] || entry.previousStatus}` : ''}
                        <span className="block">
                          {entry.byName || 'System'} · {formatDate(entry.at)}
                        </span>
                        {entry.remarks ? <span className="block italic">{entry.remarks}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="card space-y-2">
            <h2 className="text-lg font-semibold">No settlement selected</h2>
            <p className="text-sm text-crewly-dim">
              Open a settlement from the Settlements tab, or create one from an approved resignation.
            </p>
          </div>
        )
      ) : null}

      {/* ── §21 — background downloads ─────────────────────────────────── */}
      {tab === 'FILES' && !loading ? (
        <div className="card space-y-3">
          <SectionTitle note="Large exports are built in the background (§21).">
            Generated files
          </SectionTitle>
          {files.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-crewly-dim">
                  <tr>
                    <th className="py-2 pr-3">File</th>
                    <th className="py-2 pr-3">Requested by</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3 text-right">Size</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {files.map((row) => (
                    <tr key={row._id} className="border-t border-white/5">
                      <td className="py-2 pr-3">{row.filename || '—'}</td>
                      <td className="py-2 pr-3 text-crewly-dim">{row.requestedByName || '—'}</td>
                      <td className="py-2 pr-3 text-xs">{row.status}</td>
                      <td className="py-2 pr-3 text-right">{row.sizeBytes ? `${row.sizeBytes} B` : '—'}</td>
                      <td className="py-2 text-right">
                        {row.status === 'READY' ? (
                          <button
                            type="button"
                            className="btn-secondary px-2 py-1 text-xs"
                            onClick={() => handleDownloadFile(row._id, row.filename)}
                          >
                            Download
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-crewly-dim">No exports yet. Use Export XLSX to build one.</p>
          )}
        </div>
      ) : null}

      {/* ── §5 — create from the Exit module ───────────────────────────── */}
      {createOpen ? (
      <Modal onClose={() => setCreateOpen(false)} title="New final settlement">
        <div className="space-y-3 text-sm">
          <p className="text-crewly-dim">
            Pick a resignation HR has already approved. The last working day, the reason and the
            resignation date are copied from the Exit module — Crewly never re-types them (§6).
          </p>
          <label className="block text-xs uppercase tracking-wide text-crewly-dim">
            Approved resignation
            <select
              value={createDraft.resignationId}
              onChange={(event) =>
                setCreateDraft((current) => ({
                  ...current,
                  resignationId: event.target.value,
                  lastWorkingDate: '',
                  employeeId: '',
                }))
              }
              className="input-field mt-1 w-full"
            >
              <option value="">Select an approved resignation…</option>
              {resignations.map((row) => (
                <option key={row._id} value={row._id}>
                  {row.user?.name || row.user?.employeeCode || 'Employee'}
                  {row.user?.employeeCode ? ` (${row.user.employeeCode})` : ''} — last working day{' '}
                  {formatDate(row.lastWorkingDate)}
                </option>
              ))}
              <option value={MANUAL_EXIT}>Manual exit (no approved resignation)</option>
            </select>
          </label>

          {createDraft.resignationId === MANUAL_EXIT ? (
            <>
              <label className="block text-xs uppercase tracking-wide text-crewly-dim">
                Employee
                <select
                  value={createDraft.employeeId}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, employeeId: event.target.value }))
                  }
                  className="input-field mt-1 w-full"
                >
                  <option value="">Select an employee…</option>
                  {employees.map((row) => (
                    <option key={row._id} value={row._id}>
                      {row.name}
                      {row.employeeCode ? ` (${row.employeeCode})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs uppercase tracking-wide text-crewly-dim">
                Last working day
                <input
                  type="date"
                  value={createDraft.lastWorkingDate}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, lastWorkingDate: event.target.value }))
                  }
                  className="input-field mt-1 w-full"
                />
              </label>
            </>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs uppercase tracking-wide text-crewly-dim">
              Notice period (days)
              <input
                type="number"
                min="0"
                max="365"
                value={createDraft.noticePeriodDays}
                onChange={(event) => setCreateDraft((current) => ({ ...current, noticePeriodDays: event.target.value }))}
                className="input-field mt-1 w-full"
              />
            </label>
            <label className="block text-xs uppercase tracking-wide text-crewly-dim">
              Notice decision
              <select
                value={createDraft.noticeDecision}
                onChange={(event) => setCreateDraft((current) => ({ ...current, noticeDecision: event.target.value }))}
                className="input-field mt-1 w-full"
              >
                {Object.keys(NOTICE_LABELS).map((decision) => (
                  <option key={decision} value={decision}>
                    {NOTICE_LABELS[decision]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleCreate}
              disabled={
                busy ||
                (createDraft.resignationId === MANUAL_EXIT
                  ? !createDraft.employeeId || !createDraft.lastWorkingDate
                  : !createDraft.resignationId)
              }
            >
              Create settlement
            </button>
          </div>
        </div>
      </Modal>
      ) : null}

      {/* ── §14 — reopen ───────────────────────────────────────────────── */}
      {reopenOpen ? (
      <Modal onClose={() => setReopenOpen(false)} title="Reopen a closed settlement">
        <div className="space-y-3 text-sm">
          <p className="text-crewly-dim">
            A closed settlement is immutable. Reopening it is audited, and the reason is stored with the
            record.
          </p>
          <textarea
            value={reopenReason}
            onChange={(event) => setReopenReason(event.target.value)}
            placeholder="Why is this settlement being reopened?"
            className="input-field w-full"
            rows={3}
          />
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary" onClick={() => setReopenOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleReopen}
              disabled={busy || String(reopenReason || '').trim().length < 3}
            >
              Reopen
            </button>
          </div>
        </div>
      </Modal>
      ) : null}
    </div>
  );
};

export default FinalSettlementPage;
