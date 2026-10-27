/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Landmark,
  Lock,
  Play,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react';

import usePermission from '../../hooks/usePermission.js';
import payrollRunService from '../../services/payrollRunService.js';
import payrollReviewService from '../../services/payrollReviewService.js';
import payrollPaymentService from '../../services/payrollPaymentService.js';
import payrollSetupService from '../../services/payrollSetupService.js';
import payslipService from '../../services/payslipService.js';
import departmentService from '../../services/departmentService.js';
import attendanceService from '../../services/attendanceService.js';
import monthlyInputService from '../../services/monthlyInputService.js';
import { notify } from '../../utils/notify.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';

// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL & COMPENSATION CENTER — the Stitch "Payroll Processing & Payslip
// Hub" export, rebuilt on live responses.
//
// Every panel below answers one question with ONE endpoint:
//
//   · the run + its totals ......... /payroll/runs/:month (+ /results)
//   · statutory split .............. the STATUTORY lines inside each result
//   · LOP and absence .............. result.attendance.lopDays + the LOP line
//   · approval posture ............. /payroll/review/:month
//   · disbursement ................. /payroll/payments/dashboard
//   · the company bank account ..... /payroll/setup (masked, never the number)
//   · the viewer's own payslip ..... /payroll/payslips/mine
//   · attendance reconciliation .... /attendance/analytics/overview
//   · cycle state .................. /payroll/inputs/periods
//
// The mock also draws a hardware token handshake, a bank gateway "balance", a
// legal-identifier validation badge and a Form 16 archive. None of those
// exist, so each one is either replaced by the real fact (the permission that
// actually gates a disbursement) or labelled as unavailable with the endpoint
// it would need.
// ═══════════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 6;

const PILL = 'rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider';

const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const money2 = (value) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const num = (value) => Number(value || 0).toLocaleString('en-IN');

const monthLabel = (month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return month || '—';
  const [year, part] = String(month).split('-');
  return new Date(Number(year), Number(part) - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
};

const clockOf = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
};

const PERIOD_LABELS = {
  DRAFT: 'Draft',
  COLLECTING_INPUTS: 'Collecting inputs',
  VALIDATED: 'Validated',
  LOCKED: 'Inputs locked',
  SENT_TO_PAYROLL: 'Sent to payroll',
};

const RUN_LABELS = {
  DRAFT: 'Draft',
  CALCULATING: 'Calculating',
  CALCULATED: 'Calculated',
  ERROR: 'Error',
  RECALCULATED: 'Recalculated',
};

const REVIEW_LABELS = {
  CALCULATED: 'Calculated',
  UNDER_REVIEW: 'Under review',
  LOCKED: 'Locked',
  PENDING_FINANCE_APPROVAL: 'Pending finance approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  REOPENED: 'Reopened',
};

const BATCH_LABELS = {
  DRAFT: 'Draft batch',
  READY: 'Ready',
  FILE_GENERATED: 'File generated',
  DOWNLOADED: 'File downloaded',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  PARTIALLY_PAID: 'Partially paid',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const tone = (kind) => {
  if (kind === 'good') return 'bg-st-secondary-container text-st-on-secondary-container';
  if (kind === 'warn') return 'bg-st-primary-fixed text-st-on-primary-fixed-variant';
  if (kind === 'bad') return 'bg-st-error-container text-st-on-error-container';
  return 'bg-st-high text-st-on-variant';
};

const resultKind = (status) => (status === 'CALCULATED' ? 'good' : status === 'ERROR' ? 'bad' : 'neutral');
const reviewKind = (status) => {
  if (status === 'APPROVED') return 'good';
  if (status === 'REJECTED') return 'bad';
  if (status === 'PENDING_FINANCE_APPROVAL' || status === 'LOCKED') return 'warn';
  return 'neutral';
};
const batchKind = (status) => {
  if (status === 'PAID') return 'good';
  if (status === 'FAILED' || status === 'CANCELLED') return 'bad';
  if (status === 'PARTIALLY_PAID' || status === 'PROCESSING') return 'warn';
  return 'neutral';
};

// The engine writes one line per deduction with a `code`; the table reads
// those lines instead of re-deriving the law in the browser.
const lineOf = (rows, code) => {
  const found = (rows || []).find((line) => String(line.code || '').toUpperCase() === code);
  return found ? Number(found.amount || 0) : 0;
};
const statutorySum = (rows) =>
  (rows || [])
    .filter((line) => String(line.source || '').toUpperCase() === 'STATUTORY')
    .reduce((sum, line) => sum + Number(line.amount || 0), 0);

const initials = (name) =>
  String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

const Kpi = ({ label, value, unit, icon: Icon, tone: chip, hint, detail, bar, meter = 0 }) => (
  <div className="rounded-xl bg-st-lowest p-4 shadow-sm">
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{label}</span>
      <span className={`rounded-lg p-1 ${chip}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </div>
    <div className="mt-1 flex items-baseline gap-1">
      <span className="text-2xl font-bold tabular-nums text-st-on">{value}</span>
      {unit ? <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{unit}</span> : null}
    </div>
    {hint ? <p className="mt-0.5 text-[10px] leading-snug text-st-on-variant">{hint}</p> : null}
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-st-high">
      <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} />
    </div>
    {detail ? <p className="mt-1.5 text-[9px] leading-snug text-st-on-variant">{detail}</p> : null}
  </div>
);

const Panel = ({ title, icon: Icon, badge, note, action, children, className = '' }) => (
  <section className={`flex flex-col rounded-xl bg-st-lowest p-4 shadow-sm ${className}`}>
    <div className="flex items-start gap-2">
      <div className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
          {Icon ? <Icon className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> : null}
          {title}
          {badge ? <span className={`ml-1 ${PILL} ${badge.kind ? tone(badge.kind) : tone('neutral')}`}>{badge.text}</span> : null}
        </h2>
        {note ? <p className="mt-0.5 text-[10px] leading-relaxed text-st-on-variant">{note}</p> : null}
      </div>
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
    <div className="mt-2.5 flex-1">{children}</div>
  </section>
);

const PayrollPage = () => {
  const { loading: permsLoading, hasAnyPermission, hasPermission } = usePermission();

  const canReadRun = hasAnyPermission(['PAYROLL_RUN_READ', 'PAYROLL_RUN_PREPARE', 'PAYROLL_RUN_EXECUTE']);
  const canExecute = hasPermission('PAYROLL_RUN_EXECUTE');
  const canReview = hasAnyPermission(['PAYROLL_RUN_REVIEW', 'PAYROLL_RUN_APPROVE']);
  const canPayRead = hasPermission('PAYROLL_PAYMENT_READ');
  const canPayGenerate = hasPermission('PAYROLL_PAYMENT_GENERATE');
  const canPayMark = hasPermission('PAYROLL_PAYMENT_MARK_PAID');
  const canPayConfirm = hasPermission('PAYROLL_PAYMENT_CONFIRM');
  const canPayslipSelf = hasPermission('PAYSLIP_READ_SELF');
  const canSetupRead = hasPermission('PAYROLL_SETUP_READ');
  const canAttendance = hasPermission('ATTENDANCE_ANALYTICS_READ');

  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [tab, setTab] = useState('company');

  const [run, setRun] = useState(null);
  const [runSummary, setRunSummary] = useState(null);
  const [results, setResults] = useState([]);
  const [review, setReview] = useState(null);
  const [payment, setPayment] = useState(null);
  const [setup, setSetup] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [attendance, setAttendance] = useState(null);
  const [period, setPeriod] = useState(null);
  const [myPayslips, setMyPayslips] = useState([]);
  const [myDetail, setMyDetail] = useState(null);
  const [audit, setAudit] = useState(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState('');
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState('');
  const [gaps, setGaps] = useState({});

  const [query, setQuery] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const gap = useCallback((key, message) => {
    setGaps((current) => (current[key] === message ? current : { ...current, [key]: message }));
  }, []);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError('');
    setDenied(false);

    const tasks = [];

    if (canReadRun) {
      tasks.push(
        payrollRunService.summary(month).then(
          (response) => {
            setRun(response?.data?.run || null);
            setRunSummary(response?.data?.summary || null);
          },
          (err) => {
            if (err?.status === 403) setDenied(true);
            else setError(err?.message || 'Could not read the payroll run');
          },
        ),
      );
      tasks.push(
        payrollRunService.results(month).then(
          (response) => setResults(Array.isArray(response) ? response : response?.data || []),
          () => setResults([]),
        ),
      );
      tasks.push(
        monthlyInputService.periods().then(
          (response) => {
            const rows = Array.isArray(response) ? response : response?.data || [];
            setPeriod(rows.find((row) => row.month === month) || null);
          },
          () => setPeriod(null),
        ),
      );
    }

    if (canReview) {
      tasks.push(
        payrollReviewService.dashboard(month).then(
          (response) => setReview(response?.data || null),
          (err) => gap('review', err?.status === 403
            ? 'Approval posture needs PAYROLL_RUN_REVIEW.'
            : err?.message || 'Review dashboard unavailable'),
        ),
      );
    }

    if (canPayRead) {
      tasks.push(
        payrollPaymentService.dashboard(month).then(
          (response) => setPayment(response?.data || null),
          (err) => gap('payment', err?.status === 403
            ? 'Disbursement needs PAYROLL_PAYMENT_READ.'
            : err?.message || 'Payment dashboard unavailable'),
        ),
      );
    }

    if (canSetupRead) {
      tasks.push(
        payrollSetupService.get().then(
          (response) => setSetup(response?.data || response || null),
          () => gap('setup', 'Company bank account needs PAYROLL_SETUP_READ.'),
        ),
      );
    }

    tasks.push(
      departmentService.getAll().then(
        (response) => {
          const rows = Array.isArray(response) ? response : response?.data || [];
          setDepartments(rows);
        },
        () => setDepartments([]),
      ),
    );

    if (canAttendance) {
      tasks.push(
        attendanceService.analyticsOverview({ month }).then(
          (response) => setAttendance(response?.data || response || null),
          () => gap('attendance', 'Attendance reconciliation needs ATTENDANCE_ANALYTICS_READ.'),
        ),
      );
    }

    if (canPayslipSelf) {
      tasks.push(
        payslipService.mine().then(
          (response) => {
            const rows = Array.isArray(response) ? response : response?.data || [];
            setMyPayslips(rows);
            const latest = rows[0];
            if (latest?._id) {
              payslipService.mineDetail(latest._id).then(
                (detailResponse) => setMyDetail(detailResponse?.data || detailResponse || null),
                () => setMyDetail(null),
              );
            }
          },
          () => setMyPayslips([]),
        ),
      );
    }

    await Promise.allSettled(tasks);
    setLoading(false);
    setRefreshing(false);
  }, [month, canReadRun, canReview, canPayRead, canSetupRead, canAttendance, canPayslipSelf, gap]);

  useEffect(() => {
    // No run permission → the denied panel renders; nothing to fetch.
    if (permsLoading || !canReadRun) return;
    load();
  }, [permsLoading, canReadRun, load]);

  // The batch audit trail is a second call, only once a batch exists.
  const batch = payment?.batches?.[0] || null;
  const batchId = batch?._id || batch?.id || '';

  useEffect(() => {
    if (!batchId) return undefined;
    let active = true;
    payrollPaymentService.batchAudit(batchId).then(
      (response) => { if (active) setAudit(Array.isArray(response) ? response : response?.data || []); },
      () => { if (active) setAudit([]); },
    );
    return () => { active = false; };
  }, [batchId]);

  const departmentName = useCallback(
    (id) => {
      if (!id) return '';
      const found = (departments || []).find((row) => String(row._id || row.id) === String(id));
      return found?.name || '';
    },
    [departments],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (results || []).filter((row) => {
      if (departmentId && String(row.departmentId || '') !== departmentId) return false;
      if (statusFilter !== 'ALL' && row.status !== statusFilter) return false;
      if (!needle) return true;
      return [row.employeeName, row.employeeCode, row.designation, departmentName(row.departmentId)]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [results, query, departmentId, statusFilter, departmentName]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // ── figures, all derived from the run's own result rows ──────────────────
  const calculated = useMemo(() => (results || []).filter((row) => row.status === 'CALCULATED'), [results]);

  const figures = useMemo(() => {
    const sum = (field) => calculated.reduce((total, row) => total + Number(row?.totals?.[field] || 0), 0);
    const statutory = calculated.reduce(
      (acc, row) => {
        acc.employee += statutorySum(row.deductions);
        acc.employer += statutorySum(row.employerContributions);
        acc.pf += lineOf(row.deductions, 'PF');
        acc.esi += lineOf(row.deductions, 'ESI');
        acc.pt += lineOf(row.deductions, 'PROFESSIONAL_TAX');
        acc.tds += lineOf(row.deductions, 'TDS');
        acc.lwf += lineOf(row.deductions, 'LWF');
        return acc;
      },
      { employee: 0, employer: 0, pf: 0, esi: 0, pt: 0, tds: 0, lwf: 0 },
    );
    const lop = calculated.reduce(
      (acc, row) => {
        acc.days += Number(row?.attendance?.lopDays || row?.lop?.days || 0);
        acc.amount += lineOf(row.deductions, 'LOP');
        if (Number(row?.attendance?.lopDays || row?.lop?.days || 0) > 0) acc.people += 1;
        return acc;
      },
      { days: 0, amount: 0, people: 0 },
    );
    const employees = Number(runSummary?.totalEmployees || results.length || 0);

    return {
      employees,
      calculated: calculated.length,
      errors: Number(runSummary?.errors || (results || []).filter((row) => row.status === 'ERROR').length),
      netPayroll: Number(runSummary?.netPayroll ?? sum('netPay')),
      grossPayroll: Number(runSummary?.grossPayroll ?? sum('totalEarnings')),
      employerCost: Number(runSummary?.employerCost ?? sum('employerCost')),
      deductions: Number(runSummary?.totalDeductions ?? sum('totalDeductions')),
      statutory,
      lop,
      averageCtc: calculated.length ? sum('ctc') / calculated.length : 0,
      outflow: sum('netPay') + statutory.employer,
    };
  }, [calculated, results, runSummary]);

  const periodStatus = period?.status || '';
  const inputsReady = ['LOCKED', 'SENT_TO_PAYROLL'].includes(periodStatus);
  const running = run?.status === 'CALCULATING';

  const runPayroll = async () => {
    setBusy('run');
    setError('');
    try {
      const response = await payrollRunService.run(month);
      notify.success(response?.message || `Payroll ${monthLabel(month)} calculated`);
      await load({ silent: true });
    } catch (err) {
      setError(err?.message || 'Could not start the payroll run');
      notify.error(err, 'Could not start the payroll run');
    } finally {
      setBusy('');
    }
  };

  const openDetail = async (row) => {
    setDetailId(row.employeeId);
    setDetail({ employeeName: row.employeeName, employeeCode: row.employeeCode, loading: true });
    setDetailLoading(true);
    try {
      const response = await payrollRunService.result(month, row.employeeId);
      setDetail(response?.data || response || null);
    } catch (err) {
      setDetail(null);
      notify.error(err, 'Could not open that payslip calculation');
    } finally {
      setDetailLoading(false);
    }
  };

  const downloadRegister = async () => {
    setBusy('register');
    try {
      // The export endpoint answers inline when the queue is off and with a
      // queued row when it is on — meta says which, and only the inline path
      // has content to save.
      const response = await payrollReviewService.export(month, 'SALARY_SUMMARY');
      const meta = response?.meta || {};
      if (meta.queued) {
        notify.success(response?.message || 'Salary summary queued — it appears in Review & Approval when ready.');
      } else if (meta.content) {
        const blob = new Blob([meta.content], { type: 'text/csv;charset=utf-8' });
        const url = window.URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `salary-summary-${month}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.URL.revokeObjectURL(url);
        notify.success('Salary summary downloaded');
      } else {
        notify.success(response?.message || 'Salary summary exported');
      }
    } catch (err) {
      notify.error(err, 'Could not export the salary summary');
    } finally {
      setBusy('');
    }
  };

  const generateBankFile = async () => {
    if (!batchId) return;
    setBusy('bank');
    try {
      await payrollPaymentService.generateFile(batchId, 'CSV');
      notify.success('Bank transfer file generated');
      await load({ silent: true });
    } catch (err) {
      notify.error(err, 'Could not generate the bank file');
    } finally {
      setBusy('');
    }
  };

  const confirmDisbursement = async () => {
    if (!batchId) return;
    setBusy('disburse');
    try {
      await payrollPaymentService.markAllPaid(batchId);
      notify.success('Batch marked as paid — each employee row carries its own payment stamp.');
      await load({ silent: true });
    } catch (err) {
      notify.error(err, 'Could not confirm the disbursement');
    } finally {
      setBusy('');
    }
  };

  const downloadMyPayslip = async (payslipId) => {
    try {
      const blob = await payslipService.downloadMine(payslipId);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `payslip-${payslipId}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      notify.error(err, 'Could not download the payslip');
    }
  };

  if (permsLoading) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">
          Checking payroll permissions…
        </div>
      </div>
    );
  }

  if (!canReadRun || denied) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">Payroll &amp; Compensation Center</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            Payroll runs need <span className="font-semibold text-st-on">PAYROLL_RUN_READ</span>. Your role
            doesn&apos;t hold it — ask your Company Admin or Payroll Administrator to grant it, or open your own
            payslips from the employee portal.
          </p>
          <Link
            to="/app/payroll/my-payslips"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-st-low px-3 py-2 text-[11px] font-bold text-st-on"
          >
            My payslips <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
    );
  }

  const dayCounts = attendance?.totals?.dayCounts || null;
  const captureCounts = attendance?.sources?.counts || null;
  const setupBank = setup?.config?.bankAccount || null;
  const latestPayslip = myPayslips[0] || null;
  const archive = myPayslips.slice(1, 4);
  // The detail endpoint returns the stored payslip document; its lines live
  // inside the immutable snapshot, never at the top level.
  const mySnapshot = myDetail?.snapshot || null;
  const earningsLines = mySnapshot?.earnings || [];
  const earningsTotalForBar = earningsLines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const reviewStatus = review?.review?.status || '';
  const kpis = review?.kpis || null;

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-5">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
              Payroll · Payroll Processing &amp; Payslip Hub
            </span>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">
                Payroll &amp; Compensation Center
              </h1>
              <span className={`${PILL} ${periodStatus ? tone(inputsReady ? 'good' : 'warn') : tone('neutral')}`}>
                {periodStatus ? PERIOD_LABELS[periodStatus] || periodStatus : 'No period yet'}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Automated monthly salary calculation, LOP &amp; attendance reconciliation, and self-service
              payslip archives — every figure read from this month&apos;s calculated result rows.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-st-lowest p-1 shadow-sm">
              {[
                ['company', 'Company Payroll Run', ReceiptText],
                ['mine', 'My Payslips & Tax Vault', Wallet],
              ].map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  aria-pressed={tab === key}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-bold transition ${
                    tab === key ? 'bg-st-primary-container text-st-on-primary-container' : 'text-st-on-variant hover:text-st-on'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
                  {key === 'mine' && myPayslips.length ? (
                    <span className="rounded-full bg-st-lowest px-1.5 text-[9px] tabular-nums text-st-on">
                      {myPayslips.length}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => load({ silent: true })}
              className="rounded-lg bg-st-lowest p-2 text-st-on-variant shadow-sm transition hover:text-st-on"
              aria-label="Reload this month"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </section>

        {error ? (
          <div className="flex items-center gap-3 rounded-lg bg-st-error-container px-4 py-2.5 text-xs font-medium text-st-on-error-container">
            {error}
            <button type="button" onClick={() => load()} className="rounded bg-st-lowest px-2 py-1 text-[11px] font-bold text-st-on">
              Retry
            </button>
          </div>
        ) : null}

        {tab === 'company' ? (
          <>
            {/* ── control strip ─────────────────────────────────────────── */}
            <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-2.5 py-1.5">
                    <CalendarDays className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" />
                    <span className="sr-only">Payroll month</span>
                    <input
                      type="month"
                      value={month}
                      onChange={(event) => setMonth(event.target.value || month)}
                      className="bg-transparent text-xs font-bold text-st-on focus:outline-none"
                    />
                  </label>

                  {dayCounts ? (
                    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg bg-st-low px-2.5 py-1.5 text-[10px] text-st-on-variant">
                      <CheckCircle2 className="h-3 w-3 text-st-secondary" aria-hidden="true" />
                      Attendance for {monthLabel(month)}:
                      <span className="font-bold text-st-on">{num(dayCounts.present)} present</span>·
                      <span className="font-bold text-st-on">{num(dayCounts.absent)} absent</span>·
                      <span className="font-bold text-st-on">{num(dayCounts.halfDay)} half-day</span>
                      <Link to="/app/attendance/analytics" className="font-bold text-st-primary hover:underline">
                        reconcile
                      </Link>
                    </span>
                  ) : (
                    <span className="rounded-lg bg-st-low px-2.5 py-1.5 text-[10px] text-st-on-variant">
                      {gaps.attendance || 'Attendance reconciliation is not exposed to your role'}
                    </span>
                  )}

                  {captureCounts ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-lg bg-st-secondary-container/60 px-2.5 py-1.5 text-[10px] text-st-on-secondary-container">
                      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                      Punch sources:
                      {Object.entries(captureCounts)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 4)
                        .map(([source, count]) => (
                          <span key={source} className="font-bold">
                            {source} {num(count)}
                          </span>
                        ))}
                    </span>
                  ) : null}
                </div>

                <div className="xl:ml-auto">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-right">
                      <p className="flex items-center justify-end gap-1 text-[10px] font-bold text-st-on">
                        <Lock className="h-2.5 w-2.5" aria-hidden="true" /> Re-run safe
                      </p>
                      <p className="text-[9px] leading-snug text-st-on-variant">
                        Each re-run writes a new result version; payment stamps live in their own ledger.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={runPayroll}
                      disabled={!canExecute || running || busy === 'run'}
                      title={canExecute ? undefined : 'Needs PAYROLL_RUN_EXECUTE'}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95 disabled:opacity-50"
                    >
                      {busy === 'run' || running ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          {running ? 'Calculating…' : 'Starting…'}
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5" aria-hidden="true" />
                          {calculated.length ? 'Recalculate this month' : 'Generate & execute payroll'}
                        </>
                      )}
                    </button>
                  </div>
                  {!inputsReady && periodStatus ? (
                    <p className="mt-1 flex items-center justify-end gap-1 text-[9px] text-st-on-variant">
                      <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
                      Monthly inputs are {PERIOD_LABELS[periodStatus]?.toLowerCase() || periodStatus} — the engine
                      refuses to run until they are locked.
                    </p>
                  ) : null}
                  {!canExecute ? (
                    <p className="mt-1 text-right text-[9px] text-st-on-variant">
                      Payroll execution is held by the Payroll Admin role.
                    </p>
                  ) : null}
                </div>
              </div>
            </section>

            {/* ── KPI row ───────────────────────────────────────────────── */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi
                label="Total outflow"
                value={money(figures.outflow)}
                icon={Banknote}
                chip="bg-st-primary-fixed text-st-on-primary-fixed-variant"
                hint={`Net ${money(figures.netPayroll)} + employer statutory ${money(figures.statutory.employer)}`}
                bar="bg-st-primary-container"
                meter={figures.outflow ? 100 : 0}
                detail={`${figures.calculated} calculated employee${figures.calculated === 1 ? '' : 's'} · average CTC ${money(figures.averageCtc)}`}
              />
              <Kpi
                label="Statutory pool"
                value={money(figures.statutory.employee + figures.statutory.employer)}
                icon={Landmark}
                chip="bg-st-tertiary-fixed text-st-on-tertiary-fixed"
                hint={`PF ${money(figures.statutory.pf)} · ESI ${money(figures.statutory.esi)} · PT ${money(figures.statutory.pt)}`}
                bar="bg-st-tertiary"
                meter={figures.grossPayroll ? ((figures.statutory.employee + figures.statutory.employer) / figures.grossPayroll) * 100 : 0}
                detail={`Employee ${money(figures.statutory.employee)} · employer ${money(figures.statutory.employer)} · TDS ${money(figures.statutory.tds)}`}
              />
              <Kpi
                label="LOP & absence"
                value={money(figures.lop.amount)}
                icon={AlertTriangle}
                chip="bg-st-error-container text-st-on-error-container"
                hint={`${figures.lop.days.toLocaleString('en-IN')} loss-of-pay day${figures.lop.days === 1 ? '' : 's'} across ${figures.lop.people} employee${figures.lop.people === 1 ? '' : 's'}`}
                bar="bg-st-error"
                meter={figures.employees ? (figures.lop.people / figures.employees) * 100 : 0}
                detail={
                  figures.errors
                    ? `${figures.errors} employee${figures.errors === 1 ? '' : 's'} could not be calculated — see the row status`
                    : 'Every employee in this run calculated without an error'
                }
              />
              <Kpi
                label="Disbursement status"
                value={batch ? BATCH_LABELS[batch.status] || batch.status : 'No batch'}
                icon={Wallet}
                chip="bg-st-secondary-container text-st-on-secondary-container"
                hint={
                  batch
                    ? `${num(batch.summary?.successfulTransactions)} paid / ${num(batch.summary?.totalTransactions)} rows · ${money(batch.summary?.totalNetSalary)}`
                    : canPayRead
                      ? 'Finance has not prepared a transfer batch for this month yet'
                      : 'Payment state needs PAYROLL_PAYMENT_READ'
                }
                bar="bg-st-secondary"
                meter={batch?.summary?.totalTransactions
                  ? (Number(batch.summary.successfulTransactions || 0) / Number(batch.summary.totalTransactions)) * 100
                  : 0}
                detail={batch?.batchNumber ? `Batch ${batch.batchNumber}` : gaps.payment || 'No batch number to show'}
              />
            </div>

            {/* ── filter row + exports ──────────────────────────────────── */}
            <section className="rounded-xl bg-st-lowest p-3 shadow-sm">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                <label className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-st-outline" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    maxLength={60}
                    placeholder="Search employee name or code…"
                    className="w-full rounded-lg bg-st-low py-2 pl-8 pr-2 text-[11px] text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                    aria-label="Search employees in this payroll run"
                  />
                </label>
                <select
                  value={departmentId}
                  onChange={(event) => setDepartmentId(event.target.value)}
                  className="rounded-lg bg-st-low px-2.5 py-2 text-[11px] font-semibold text-st-on focus:outline-none"
                  aria-label="Filter by department"
                >
                  <option value="">All departments</option>
                  {departments.map((row) => (
                    <option key={row._id || row.id} value={row._id || row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="rounded-lg bg-st-low px-2.5 py-2 text-[11px] font-semibold text-st-on focus:outline-none"
                  aria-label="Filter by calculation status"
                >
                  <option value="ALL">All statuses</option>
                  <option value="CALCULATED">Calculated</option>
                  <option value="ERROR">Error</option>
                </select>

                <div className="flex flex-wrap items-center gap-1.5 lg:ml-auto">
                  <button
                    type="button"
                    onClick={generateBankFile}
                    disabled={!batchId || !canPayGenerate || busy === 'bank'}
                    title={
                      !batchId
                        ? 'No payment batch exists for this month yet'
                        : canPayGenerate
                          ? 'Generate the bank transfer file from this batch'
                          : 'Needs PAYROLL_PAYMENT_GENERATE (Finance)'
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-2.5 py-1.5 text-[10px] font-bold text-st-on transition hover:bg-st-container disabled:opacity-50"
                  >
                    <Download className="h-3 w-3" aria-hidden="true" /> Bank .CSV file
                  </button>
                  <button
                    type="button"
                    onClick={downloadRegister}
                    disabled={!canReview || busy === 'register'}
                    title={canReview ? 'Salary summary export from Review & Approval' : 'Needs PAYROLL_RUN_REVIEW'}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-2.5 py-1.5 text-[10px] font-bold text-st-on transition hover:bg-st-container disabled:opacity-50"
                  >
                    <FileSpreadsheet className="h-3 w-3" aria-hidden="true" /> Summary export
                  </button>
                  <span
                    title="No Form 16 archive endpoint exists in this build — statutory exports live on Statutory & Compliance"
                    className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg bg-st-low/60 px-2.5 py-1.5 text-[10px] font-bold text-st-on-variant/70"
                  >
                    <FileText className="h-3 w-3" aria-hidden="true" /> Form 16 — not configured
                  </span>
                </div>
              </div>
            </section>

            {/* ── payroll register ─────────────────────────────────────── */}
            <section className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                <h2 className="text-sm font-bold text-st-on">Employee payroll register</h2>
                <span className={`${PILL} ${tone(run?.status === 'CALCULATED' ? 'good' : running ? 'warn' : 'neutral')}`}>
                  {RUN_LABELS[run?.status] || (run ? run.status : 'Not run')}
                  {run?.version ? ` · v${run.version}` : ''}
                </span>
                <span className="text-[10px] text-st-on-variant">
                  {monthLabel(month)} · {num(figures.employees)} employee{figures.employees === 1 ? '' : 's'}
                </span>
                {reviewStatus ? (
                  <span className={`${PILL} ${tone(reviewKind(reviewStatus))}`}>
                    {REVIEW_LABELS[reviewStatus] || reviewStatus}
                  </span>
                ) : gaps.review ? (
                  <span className="text-[10px] text-st-on-variant">{gaps.review}</span>
                ) : null}
                <Link
                  to="/app/payroll/review"
                  className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline"
                >
                  Review &amp; approval <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              </div>

              <div className="overflow-x-auto border-t border-st-high/60">
                <table className="w-full min-w-[62rem] text-left">
                  <thead>
                    <tr className="bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                      <th className="py-2 pl-4 pr-2 font-bold">Employee</th>
                      <th className="px-2 py-2 text-right font-bold">Gross</th>
                      <th className="px-2 py-2 text-right font-bold">PF</th>
                      <th className="px-2 py-2 text-right font-bold">Prof. tax</th>
                      <th className="px-2 py-2 text-right font-bold">TDS</th>
                      <th className="px-2 py-2 text-right font-bold">LOP deduction</th>
                      <th className="px-2 py-2 text-right font-bold">Net payable</th>
                      <th className="px-2 py-2 font-bold">Status</th>
                      <th className="py-2 pl-2 pr-4 text-right font-bold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => {
                      const lopDays = Number(row?.attendance?.lopDays || row?.lop?.days || 0);
                      const lopAmount = lineOf(row.deductions, 'LOP');
                      return (
                        <tr key={`${row.employeeId}-${row.version || 1}`} className="border-b border-st-high/50 hover:bg-st-low">
                          <td className="py-2.5 pl-4 pr-2">
                            <div className="flex items-center gap-2">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-st-secondary-container text-[9px] font-bold text-st-on-secondary-container">
                                {initials(row.employeeName)}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-[11px] font-bold text-st-on">
                                  {row.employeeName || 'Unnamed employee'}
                                </span>
                                <span className="block truncate text-[9px] text-st-on-variant">
                                  {row.employeeCode || '—'}
                                  {row.designation ? ` · ${row.designation}` : ''}
                                  {departmentName(row.departmentId) ? ` · ${departmentName(row.departmentId)}` : ''}
                                </span>
                              </span>
                            </div>
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums text-st-on">
                            {money(row?.totals?.gross)}
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums text-st-on-variant">
                            {money(lineOf(row.deductions, 'PF'))}
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums text-st-on-variant">
                            {money(lineOf(row.deductions, 'PROFESSIONAL_TAX'))}
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums text-st-on-variant">
                            {money(lineOf(row.deductions, 'TDS'))}
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums text-st-on-variant">
                            {lopAmount ? (
                              <>
                                <span className="block text-st-on">{money(lopAmount)}</span>
                                <span className="block text-[9px]">
                                  {lopDays.toLocaleString('en-IN')} day{lopDays === 1 ? '' : 's'}
                                </span>
                              </>
                            ) : (
                              <span className="text-[10px]">0 d</span>
                            )}
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] font-bold tabular-nums text-st-on">
                            {money(row?.totals?.netPay)}
                          </td>
                          <td className="px-2 py-2.5">
                            <span className={`${PILL} ${tone(resultKind(row.status))}`}>{row.status || 'UNKNOWN'}</span>
                            {row.warnings?.length ? (
                              <span className="mt-0.5 block text-[9px] text-st-on-variant" title={row.warnings.join(' · ')}>
                                {row.warnings.length} warning{row.warnings.length === 1 ? '' : 's'}
                              </span>
                            ) : null}
                          </td>
                          <td className="py-2.5 pl-2 pr-4 text-right">
                            <button
                              type="button"
                              onClick={() => openDetail(row)}
                              className="rounded p-1.5 text-st-on-variant transition hover:bg-st-low hover:text-st-on"
                              aria-label={`Open ${row.employeeName || 'employee'} calculation`}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {!loading && visible.length === 0 ? (
                      <TableEmpty
                        colSpan={9}
                        illustration="wallet"
                        title={
                          results.length
                            ? 'No employee matches these filters'
                            : `No payroll calculated for ${monthLabel(month)}`
                        }
                        description={
                          results.length
                            ? 'Clear the search, department or status filter to see the whole run.'
                            : 'Run the engine and every active employee appears here with the lines it used — gross, statutory deductions, LOP and net payable.'
                        }
                      />
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-st-high/60 px-4 py-2 text-[10px] text-st-on-variant">
                <span>
                  Showing <strong className="font-bold text-st-on">{visible.length}</strong> of {filtered.length}{' '}
                  employee{filtered.length === 1 ? '' : 's'}
                  {filtered.length !== results.length ? ` (${results.length} in the run)` : ''} · Total net for these
                  rows{' '}
                  <strong className="font-bold text-st-on">
                    {money(visible.reduce((sum, row) => sum + Number(row?.totals?.netPay || 0), 0))}
                  </strong>{' '}
                  (subset)
                </span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={safePage <= 1}
                    className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <span className="px-1 text-st-on">
                    Page {safePage} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((value) => value + 1)}
                    disabled={safePage >= totalPages}
                    className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            </section>

            {/* ── payslip summary + disbursement gateway ───────────────── */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
              <Panel
                title="Quick payslip & tax summary"
                icon={ReceiptText}
                badge={latestPayslip ? { text: latestPayslip.statusLabel || latestPayslip.status || 'Issued', kind: 'good' } : { text: 'None issued', kind: 'neutral' }}
                note="Your own account only — this card reads /payroll/payslips/mine, never the company register."
                action={
                  <Link to="/app/payroll/my-payslips" className="text-[10px] font-bold text-st-primary hover:underline">
                    Tax vault
                  </Link>
                }
              >
                {canPayslipSelf ? (
                  latestPayslip ? (
                    <>
                      <div className="rounded-lg bg-st-low p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
                              Latest statement
                            </p>
                            <p className="text-sm font-bold text-st-on">{latestPayslip.monthLabel || monthLabel(latestPayslip.month)}</p>
                            <p className="text-[9px] text-st-on-variant">
                              {latestPayslip.paymentDate ? `Credited ${clockOf(latestPayslip.paymentDate)}` : 'Payment date not stamped'}
                              {latestPayslip.payslipNumber ? ` · ${latestPayslip.payslipNumber}` : ''}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
                              Net pay
                            </p>
                            <p className="text-xl font-bold tabular-nums text-st-on">{money(latestPayslip.net)}</p>
                          </div>
                        </div>

                        {earningsLines.length ? (
                          <>
                            <p className="mt-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
                              Earnings composition
                            </p>
                            <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-st-high">
                              {earningsLines.map((line, index) => {
                                const share = earningsTotalForBar ? (Number(line.amount || 0) / earningsTotalForBar) * 100 : 0;
                                const palette = ['bg-st-primary', 'bg-st-secondary', 'bg-st-tertiary', 'bg-st-outline'];
                                return (
                                  <span
                                    key={`${line.code || line.name}-${index}`}
                                    className={palette[index % palette.length]}
                                    style={{ width: `${share}%` }}
                                    title={`${line.name}: ${money(line.amount)}`}
                                  />
                                );
                              })}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                              {earningsLines.slice(0, 4).map((line, index) => (
                                <span key={`${line.name}-${index}`} className="inline-flex items-center gap-1 text-[9px] text-st-on-variant">
                                  <span className={`h-1.5 w-1.5 rounded-full ${['bg-st-primary', 'bg-st-secondary', 'bg-st-tertiary', 'bg-st-outline'][index % 4]}`} />
                                  {line.name} ({earningsTotalForBar ? Math.round((Number(line.amount || 0) / earningsTotalForBar) * 100) : 0}%)
                                </span>
                              ))}
                            </div>
                          </>
                        ) : (
                          <p className="mt-2 text-[9px] text-st-on-variant">
                            The line-by-line composition is read from the payslip snapshot; it is not available
                            until the snapshot is opened.
                          </p>
                        )}
                      </div>

                      {archive.length ? (
                        <>
                          <p className="mt-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
                            Previous payslips
                          </p>
                          <div className="mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                            {archive.map((row) => (
                              <div key={row._id} className="flex items-center justify-between gap-1 rounded-lg bg-st-low px-2 py-1.5">
                                <span className="min-w-0">
                                  <span className="block truncate text-[10px] font-bold text-st-on">
                                    {row.monthLabel || monthLabel(row.month)}
                                  </span>
                                  <span className="block text-[9px] tabular-nums text-st-on-variant">{money(row.net)}</span>
                                </span>
                                <button
                                  type="button"
                                  onClick={() => downloadMyPayslip(row._id)}
                                  className="rounded p-1 text-st-on-variant transition hover:text-st-on"
                                  aria-label={`Download ${row.monthLabel || row.month} payslip`}
                                >
                                  <Download className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : null}

                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => downloadMyPayslip(latestPayslip._id)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[10px] font-bold text-st-on-primary transition hover:opacity-95"
                        >
                          <Download className="h-3 w-3" aria-hidden="true" />
                          Download PDF payslip
                        </button>
                        <Link
                          to="/app/payroll/my-payslips"
                          className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-3 py-2 text-[10px] font-bold text-st-on transition hover:bg-st-container"
                        >
                          <ReceiptText className="h-3 w-3" aria-hidden="true" /> Year-to-date view
                        </Link>
                        <span className="text-[9px] text-st-on-variant">
                          {myPayslips.length} statement{myPayslips.length === 1 ? '' : 's'} released
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-st-high px-3 py-5 text-center">
                      <ReceiptText className="mx-auto h-5 w-5 text-st-outline" aria-hidden="true" />
                      <p className="mt-1 text-[11px] font-bold text-st-on">No payslip released to you yet</p>
                      <p className="text-[10px] text-st-on-variant">
                        Payslips are generated from a calculated run and released by payroll. Nothing is shown
                        until the first one is issued.
                      </p>
                    </div>
                  )
                ) : (
                  <p className="rounded-lg bg-st-low px-3 py-2 text-[10px] text-st-on-variant">
                    Your role has no self-service payslip permission (PAYSLIP_READ_SELF).
                  </p>
                )}
              </Panel>

              <div className="flex flex-col gap-3">
                <Panel
                  title="Bank & disbursement gateway"
                  icon={Landmark}
                  badge={batch ? { text: BATCH_LABELS[batch.status] || batch.status, kind: batchKind(batch.status) } : { text: 'No batch', kind: 'neutral' }}
                  note="Crewly prepares the transfer file; it never moves money. The bank account is read from Payroll Setup and always masked."
                >
                  {setupBank ? (
                    <div className="rounded-lg bg-st-low p-2.5">
                      <p className="flex items-center gap-1 text-[10px] font-bold text-st-on">
                        <Building2 className="h-3 w-3 text-st-outline" aria-hidden="true" />
                        {setupBank.bankName || 'Bank not named'}
                      </p>
                      <p className="mt-0.5 text-[9px] text-st-on-variant">
                        {setupBank.accountHolderName || 'No holder name'} ·{' '}
                        {setupBank.maskedAccountNumber || (setupBank.accountNumberLast4 ? `•••• ${setupBank.accountNumberLast4}` : 'no account number')}
                        {setupBank.ifsc ? ` · IFSC ${setupBank.ifsc}` : ''}
                      </p>
                      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                        <div className="rounded bg-st-lowest px-2 py-1.5">
                          <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Batch ledger</p>
                          <p className="text-[11px] font-bold tabular-nums text-st-on">
                            {money(batch?.summary?.totalNetSalary || figures.netPayroll)}
                          </p>
                        </div>
                        <div className="rounded bg-st-lowest px-2 py-1.5">
                          <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Batch reference</p>
                          <p className="truncate font-mono text-[10px] text-st-on">
                            {batch?.batchNumber || 'not created'}
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="rounded-lg bg-st-low px-3 py-2 text-[10px] text-st-on-variant">
                      {gaps.setup || 'Company bank account is not configured in Payroll Setup.'}
                    </p>
                  )}

                  <div className="mt-2 rounded-lg bg-st-low px-2.5 py-2">
                    <p className="text-[10px] font-bold text-st-on">How a disbursement is authorised here</p>
                    <p className="mt-0.5 text-[9px] leading-relaxed text-st-on-variant">
                      By permission, not by hardware: <span className="font-mono">PAYROLL_PAYMENT_GENERATE</span>{' '}
                      produces the bank file and <span className="font-mono">PAYROLL_PAYMENT_CONFIRM</span> /{' '}
                      <span className="font-mono">PAYROLL_PAYMENT_MARK_PAID</span> stamp it paid.{' '}
                      There is no security-key handshake or dual-admin token in this build — every step is
                      written to the audit trail below instead.
                    </p>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={confirmDisbursement}
                      disabled={!batchId || !(canPayMark || canPayConfirm) || busy === 'disburse'}
                      title={
                        !batchId
                          ? 'No payment batch for this month yet'
                          : canPayMark || canPayConfirm
                            ? 'Stamp every pending row in this batch as paid'
                            : 'Needs PAYROLL_PAYMENT_MARK_PAID (Finance)'
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[10px] font-bold text-st-on-primary transition hover:opacity-95 disabled:opacity-50"
                    >
                      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                      {busy === 'disburse' ? 'Confirming…' : 'Confirm & mark paid'}
                    </button>
                    <Link
                      to="/app/payroll/salary-payment"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-3 py-2 text-[10px] font-bold text-st-on transition hover:bg-st-container"
                    >
                      Payment workspace <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                    {!(canPayMark || canPayConfirm) ? (
                      <span className="text-[9px] text-st-on-variant">Finance holds this step.</span>
                    ) : null}
                  </div>
                </Panel>

                <Panel
                  title="Audit trail — this batch"
                  icon={ShieldCheck}
                  note="Read from the platform audit log for this batch, its payment rows and its files."
                >
                  {audit === null ? (
                    <p className="text-[10px] text-st-on-variant">
                      {batchId ? 'Reading the audit trail…' : 'No payment batch exists for this month yet.'}
                    </p>
                  ) : audit.length ? (
                    <ul className="space-y-1">
                      {audit.slice(0, 5).map((entry, index) => (
                        <li key={`${entry.at}-${entry.action}-${index}`} className="flex items-start gap-2 rounded-lg bg-st-low px-2 py-1.5">
                          <span aria-hidden="true" className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-st-secondary" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[10px] font-bold text-st-on">
                              {String(entry.action || '').replace(/_/g, ' ').toLowerCase()}
                              {entry.from || entry.to ? (
                                <span className="ml-1 font-normal text-st-on-variant">
                                  {entry.from ? `${entry.from} → ` : ''}
                                  {entry.to || ''}
                                </span>
                              ) : null}
                            </span>
                            <span className="block text-[9px] text-st-on-variant">
                              {entry.actorName || 'System'}
                              {entry.actorRole ? ` · ${entry.actorRole}` : ''} · {clockOf(entry.at)}
                              {entry.reason ? ` · ${entry.reason}` : ''}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg border border-dashed border-st-high px-3 py-3 text-center text-[10px] text-st-on-variant">
                      No audit entries for this batch yet — the trail fills as the batch moves.
                    </p>
                  )}
                </Panel>
              </div>
            </div>

            <p className="flex items-start gap-2 rounded-xl bg-st-low px-4 py-3 text-[10px] leading-relaxed text-st-on-variant">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-outline" aria-hidden="true" />
              <span>
                <strong className="font-semibold text-st-on">What this screen refuses to invent.</strong> The
                register shows only what the engine stored for this month&apos;s result version. There is no
                confidence percentile, no bank-gateway balance, no hardware-key handshake, no Form 16 archive and
                no CIN/PAN/TAN verification badge on this page — the legal identifiers live on{' '}
                <Link to="/app/payroll/setup" className="font-bold text-st-primary hover:underline">
                  Payroll Setup
                </Link>{' '}
                and are not re-validated here.
              </span>
            </p>
          </>
        ) : (
          /* ── self-service tab ─────────────────────────────────────────── */
          <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
            <div className="flex items-start gap-2">
              <div>
                <h2 className="text-sm font-bold text-st-on">My payslips &amp; tax vault</h2>
                <p className="text-[10px] text-st-on-variant">
                  Your own statements only. {myPayslips.length} released
                  {kpis ? ` · company net for ${monthLabel(month)} is ${money(kpis.netPayroll)}` : ''}.
                </p>
              </div>
              <Link
                to="/app/payroll/my-payslips"
                className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline"
              >
                Open the full vault <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>

            {myPayslips.length ? (
              <ul className="mt-2.5 divide-y divide-st-high/60">
                {myPayslips.map((row) => (
                  <li key={row._id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] font-bold text-st-on">
                        {row.monthLabel || monthLabel(row.month)}
                        {row.payslipNumber ? (
                          <span className="ml-1 font-mono text-[9px] font-normal text-st-on-variant">{row.payslipNumber}</span>
                        ) : null}
                      </span>
                      <span className="block text-[9px] text-st-on-variant">
                        Gross {money(row.gross)} · net {money(row.net)}
                        {row.paymentDate ? ` · credited ${clockOf(row.paymentDate)}` : ''}
                      </span>
                    </span>
                    <span className={`${PILL} ${tone(row.status === 'PAID' || row.status === 'RELEASED' ? 'good' : 'neutral')}`}>
                      {row.statusLabel || row.status || '—'}
                    </span>
                    <button
                      type="button"
                      onClick={() => downloadMyPayslip(row._id)}
                      className="rounded bg-st-low p-1.5 text-st-on-variant transition hover:text-st-on"
                      aria-label={`Download ${row.monthLabel || row.month}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 rounded-lg border border-dashed border-st-high px-3 py-5 text-center text-[10px] text-st-on-variant">
                Nothing released to your account yet. Payslips appear the moment payroll releases them for a
                calculated month.
              </p>
            )}
          </section>
        )}
      </div>

      {/* ── employee calculation drawer ─────────────────────────────────── */}
      {detailId ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-st-inverse/40" role="presentation" onClick={() => { setDetailId(''); setDetail(null); }}>
          <aside
            className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-st-lowest p-4 shadow-xl"
            role="dialog"
            aria-label="Employee payroll breakdown"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-st-on">
                  {detail?.employeeName || 'Employee payroll'}
                </h2>
                <p className="text-[10px] text-st-on-variant">
                  {detail?.employeeCode || '—'} · {monthLabel(month)}
                  {detail?.structureName ? ` · ${detail.structureName}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setDetailId(''); setDetail(null); }}
                className="ml-auto rounded bg-st-low p-1.5 text-st-on-variant transition hover:text-st-on"
                aria-label="Close breakdown"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {detailLoading ? (
              <p className="mt-4 text-[11px] text-st-on-variant">Reading the stored result…</p>
            ) : !detail ? (
              <div className="mt-4 rounded-lg bg-st-low px-3 py-4 text-[10px] text-st-on-variant">
                This employee has no stored result for {monthLabel(month)}.
              </div>
            ) : (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {[
                    ['Gross', detail?.totals?.gross],
                    ['Total earnings', detail?.totals?.totalEarnings],
                    ['Deductions', detail?.totals?.totalDeductions],
                    ['Net payable', detail?.totals?.netPay],
                    ['Employer cost', detail?.totals?.employerCost],
                    ['CTC', detail?.totals?.ctc],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-st-low px-2.5 py-1.5">
                      <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">{label}</p>
                      <p className="text-[12px] font-bold tabular-nums text-st-on">{money(value)}</p>
                    </div>
                  ))}
                </div>

                <p className="mt-3 text-[9px] font-bold uppercase tracking-[0.14em] text-st-on-variant">Attendance used</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {[
                    ['Working', detail?.attendance?.workingDays],
                    ['Present', detail?.attendance?.presentDays],
                    ['Paid days', detail?.attendance?.paidDays],
                    ['LOP days', detail?.attendance?.lopDays],
                    ['Late marks', detail?.attendance?.lateMarks],
                    ['OT hours', detail?.attendance?.otHours],
                  ].map(([label, value]) => (
                    <span key={label} className="rounded-full bg-st-low px-2 py-0.5 text-[9px] text-st-on-variant">
                      {label} <span className="font-bold text-st-on">{num(value)}</span>
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-[9px] text-st-on-variant">
                  LOP source: {detail?.attendance?.lopSource || '—'} · read from the stored snapshot, never
                  recalculated here.
                </p>

                {[
                  ['Earnings', detail?.earnings],
                  ['Variable pay', detail?.variableEarnings],
                  ['Reimbursements', detail?.reimbursements],
                  ['Deductions', detail?.deductions],
                  ['Employer contributions', detail?.employerContributions],
                ].map(([title, rows]) =>
                  (rows || []).length ? (
                    <div key={title} className="mt-2.5">
                      <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-st-on-variant">{title}</p>
                      <ul className="mt-1 space-y-0.5">
                        {rows.map((line, index) => (
                          <li key={`${line.code || line.name}-${index}`} className="flex items-center justify-between gap-2 text-[10px]">
                            <span className="min-w-0 truncate text-st-on">
                              {line.name}
                              {line.source ? (
                                <span className="ml-1 text-[8px] uppercase tracking-wider text-st-on-variant">
                                  {line.source}
                                </span>
                              ) : null}
                            </span>
                            <span className="shrink-0 font-semibold tabular-nums text-st-on">{money2(line.amount)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null,
                )}

                {detail?.warnings?.length ? (
                  <div className="mt-3 rounded-lg bg-st-primary-fixed/50 px-2.5 py-2">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-primary-fixed-variant">
                      Engine warnings
                    </p>
                    <ul className="mt-0.5 space-y-0.5 text-[9px] text-st-on-primary-fixed-variant">
                      {detail.warnings.map((warning) => (
                        <li key={warning}>· {warning}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <Link
                  to="/app/payroll/review"
                  className="mt-3 inline-flex items-center gap-1.5 self-start rounded-lg bg-st-primary px-3 py-2 text-[10px] font-bold text-st-on-primary"
                >
                  Review this month <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              </>
            )}
          </aside>
        </div>
      ) : null}
    </div>
  );
};

export default PayrollPage;
