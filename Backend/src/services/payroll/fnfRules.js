// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT (F&F) RULES (pure)
//
//  No mongoose, no redis, no req, no Date.now(): every number in here is a
//  function of its inputs. That is what lets a settlement be re-checked in a
//  test three years after it was paid.
//
//  SOURCE OF TRUTH (§6 — never duplicate another module's data):
//    · Exit / Resignation → employee, resignation date, last working day,
//                           the reason. Crewly stores NONE of that again as
//                           an editable field: it is COPIED into the
//                           settlement as a frozen snapshot.
//    · 29.4 Profile       → gross, basic, statutory identity, joining date
//    · 29.6 Snapshot      → the last calculated payroll (basic, gross,
//                           working days) used as the proration base
//    · 29.5 Period        → the month's working days
//    · Assets             → what is still out on loan to this employee
//    · Leave              → unused earned leave
//    · THIS MODULE        → the arithmetic and the workflow
//
//  §26 — do NOT build: bank API, government gratuity portal, digital
//  signatures, legal documents, experience/relieving letters. Those belong
//  to the Exit Management module.
// ═══════════════════════════════════════════════════════════════════════════

// ── §14 — settlement lifecycle ─────────────────────────────────────────────

export const SETTLEMENT_STATUSES = [
  'DRAFT',
  'CALCULATED',
  'HR_REVIEWED',
  'FINANCE_APPROVED',
  'PAID',
  'CLOSED',
  'REOPENED',
];

export const SETTLEMENT_STATUS_LABELS = Object.freeze({
  DRAFT: 'Draft',
  CALCULATED: 'Calculated',
  HR_REVIEWED: 'HR Reviewed',
  FINANCE_APPROVED: 'Finance Approved',
  PAID: 'Paid',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
});

// §15 / §16 — a Finance rejection returns the settlement to the HR reviewer's
// workbench (CALCULATED), never to a dead end: that is the state in which the
// payable and recovery items are editable again, so HR can fix whatever
// Finance objected to and send it back. HR_REVIEWED itself is deliberately
// read-only — it is the queue Finance works from, not a place to edit.
export const SETTLEMENT_TRANSITIONS = Object.freeze({
  DRAFT: ['CALCULATED'],
  CALCULATED: ['HR_REVIEWED', 'DRAFT'],
  HR_REVIEWED: ['FINANCE_APPROVED', 'CALCULATED'],
  FINANCE_APPROVED: ['PAID', 'CALCULATED'],
  PAID: ['CLOSED'],
  // §14 — "Once Closed, the settlement becomes immutable." The only way out
  // is an audited reopen, and that is a Company Admin action.
  CLOSED: ['REOPENED'],
  REOPENED: ['CALCULATED'],
});

export const canTransitionSettlement = (from, to) =>
  (SETTLEMENT_TRANSITIONS[String(from || '').toUpperCase()] || []).includes(
    String(to || '').toUpperCase(),
  );

export const transitionError = (from, to) =>
  `A settlement cannot move from ${SETTLEMENT_STATUS_LABELS[from] || from} to ${
    SETTLEMENT_STATUS_LABELS[to] || to
  }`;

// Anything before Finance approval may still be corrected. From Finance
// approval onwards the numbers are frozen — only a reopen changes them.
export const EDITABLE_STATUSES = ['DRAFT', 'CALCULATED', 'REOPENED'];
export const isSettlementEditable = (status) =>
  EDITABLE_STATUSES.includes(String(status || '').toUpperCase());

export const OPEN_SETTLEMENT_STATUSES = [
  'DRAFT',
  'CALCULATED',
  'HR_REVIEWED',
  'FINANCE_APPROVED',
  'REOPENED',
];

export const isSettlementOpen = (status) =>
  OPEN_SETTLEMENT_STATUSES.includes(String(status || '').toUpperCase());

// §14 — CLOSED is the immutable state.
export const isSettlementLocked = (status) => String(status || '').toUpperCase() === 'CLOSED';

export const INITIAL_SETTLEMENT_STATUS = 'DRAFT';

// ── §23 — audit actions ────────────────────────────────────────────────────

export const FNF_AUDIT_ACTIONS = Object.freeze({
  SETTLEMENT_CREATED: 'Final settlement created',
  SETTLEMENT_CALCULATED: 'Final settlement calculated',
  SETTLEMENT_RECALCULATED: 'Final settlement recalculated',
  SETTLEMENT_HR_REVIEWED: 'Final settlement HR reviewed',
  SETTLEMENT_FINANCE_APPROVED: 'Final settlement approved by Finance',
  SETTLEMENT_FINANCE_REJECTED: 'Final settlement rejected by Finance',
  SETTLEMENT_RECOVERY_ADDED: 'Final settlement recovery added by Finance',
  SETTLEMENT_PAID: 'Final settlement marked paid',
  SETTLEMENT_CLOSED: 'Final settlement closed',
  SETTLEMENT_REOPENED: 'Final settlement reopened',
  STATEMENT_DOWNLOADED: 'F&F statement downloaded',
});

// ── §22 — notification copy (no new notification module) ───────────────────

export const NOTIFICATION_TYPES = Object.freeze({
  HR_REVIEWED: 'FNF_HR_REVIEWED',
  FINANCE_APPROVED: 'FNF_FINANCE_APPROVED',
  FINANCE_REJECTED: 'FNF_FINANCE_REJECTED',
  RECOVERY_ADDED: 'FNF_RECOVERY_ADDED',
  SETTLEMENT_PAID: 'FNF_SETTLEMENT_PAID',
  SETTLEMENT_CLOSED: 'FNF_SETTLEMENT_CLOSED',
});

export const notificationCopy = (type, payload = {}) => {
  const who = payload.employeeName || 'An employee';
  const amount = payload.netSettlement === undefined ? '' : ` (Rs ${inr(payload.netSettlement)})`;
  switch (type) {
    case NOTIFICATION_TYPES.HR_REVIEWED:
      return `HR completed the review of ${who}'s final settlement${amount}. Finance approval is pending.`;
    case NOTIFICATION_TYPES.FINANCE_APPROVED:
      return `Finance approved ${who}'s final settlement${amount}. It is ready for payment.`;
    case NOTIFICATION_TYPES.FINANCE_REJECTED:
      return `Finance rejected ${who}'s final settlement.${payload.remarks ? ` Reason: ${payload.remarks}` : ''}`;
    case NOTIFICATION_TYPES.RECOVERY_ADDED:
      return `Finance added a recovery to ${who}'s final settlement${amount}. It is awaiting your review.`;
    case NOTIFICATION_TYPES.SETTLEMENT_PAID:
      return `Your final settlement${amount} has been paid. Download the F&F statement from My Payroll.`;
    case NOTIFICATION_TYPES.SETTLEMENT_CLOSED:
      return `${who}'s final settlement is closed and archived.`;
    default:
      return 'Final settlement updated';
  }
};

// ── numbers, dates, labels ─────────────────────────────────────────────────

export const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

const groupDigits = (digits) => {
  if (digits.length <= 3) return digits;
  const tail = digits.slice(-3);
  let head = digits.slice(0, -3);
  const parts = [];
  while (head.length > 2) {
    parts.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head) parts.unshift(head);
  return `${parts.join(',')},${tail}`;
};

export const inr = (value) => {
  const number = Number(value) || 0;
  const negative = number < 0 ? '-' : '';
  const absolute = Math.abs(number);
  const paise = Math.round(absolute * 100) % 100;
  const whole = Math.floor(absolute + 1e-9);
  const grouped = groupDigits(String(whole));
  return paise ? `${negative}${grouped}.${String(paise).padStart(2, '0')}` : `${negative}${grouped}`;
};

export const rupees = (value) => `Rs ${inr(value)}`;

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const monthLabel = (month = '') => {
  if (!MONTH_PATTERN.test(String(month))) return String(month || '');
  const [year, index] = String(month).split('-');
  return `${MONTHS_LONG[Number(index) - 1]} ${year}`;
};

export const shortMonthLabel = (month = '') => {
  if (!MONTH_PATTERN.test(String(month))) return String(month || '');
  const [year, index] = String(month).split('-');
  return `${MONTHS_SHORT[Number(index) - 1]} ${year}`;
};

export const dayOfMonth = (date = '') => {
  if (!DATE_PATTERN.test(String(date))) return 0;
  return Number(String(date).slice(8, 10));
};

export const daysInMonth = (month = '') => {
  if (!MONTH_PATTERN.test(String(month))) return 30;
  const [year, index] = String(month).split('-').map(Number);
  return new Date(Date.UTC(year, index, 0)).getUTCDate();
};

export const monthOfDate = (date = '') =>
  DATE_PATTERN.test(String(date)) ? String(date).slice(0, 7) : '';

// Whole days between two ISO dates (b inclusive). Used for notice served and
// for years of service. Never negative.
export const daysBetween = (from = '', to = '') => {
  if (!DATE_PATTERN.test(String(from)) || !DATE_PATTERN.test(String(to))) return 0;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86400000) + 1;
};

/**
 * Any date-ish value -> 'YYYY-MM-DD'.
 *
 * MongoDB hands back Date objects and the Exit module stores them that way,
 * while the settlement itself stores strings (an immutable record must be
 * readable the same way three years later). Every conversion goes through
 * here so `String(new Date()).slice(0, 10)` — which yields "Mon Aug 17" —
 * can never happen again.
 */
export const isoDate = (value) => {
  if (!value) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (DATE_PATTERN.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
};

export const formatDate = (value = '') => {
  const iso = isoDate(value);
  if (!iso) return '—';
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
};

// ── §9 / §10 — the item catalogues ─────────────────────────────────────────

export const RECOVERY_TYPES = [
  'NOTICE',
  'ASSET',
  'CAFETERIA',
  'ADVANCE_SALARY',
  'OTHER',
];

export const RECOVERY_TYPE_LABELS = Object.freeze({
  NOTICE: 'Notice Recovery',
  ASSET: 'Asset Recovery',
  CAFETERIA: 'Cafeteria Recovery',
  ADVANCE_SALARY: 'Advance Salary Recovery',
  OTHER: 'Other Company Recovery',
});

export const PAYABLE_TYPES = [
  'PERFORMANCE_BONUS',
  'INCENTIVE',
  'LEAVE_ENCASHMENT',
  'GRATUITY',
  'REIMBURSEMENT',
  'OVERTIME',
];

export const PAYABLE_TYPE_LABELS = Object.freeze({
  PERFORMANCE_BONUS: 'Performance Bonus',
  INCENTIVE: 'Incentive',
  LEAVE_ENCASHMENT: 'Leave Encashment',
  GRATUITY: 'Gratuity',
  REIMBURSEMENT: 'Reimbursement',
  OVERTIME: 'Pending Overtime',
});

export const isRecoveryType = (type) => RECOVERY_TYPES.includes(String(type || '').toUpperCase());
export const isPayableType = (type) => PAYABLE_TYPES.includes(String(type || '').toUpperCase());

// §9 — "Every recovery requires: Amount, Reason, Approved By."
export const validateRecoveryItem = (item = {}) => {
  const errors = [];
  if (!isRecoveryType(item.type)) errors.push('recovery type is not recognised');
  const amount = Number(item.amount);
  if (!Number.isFinite(amount) || amount <= 0) errors.push('recovery amount must be greater than zero');
  if (!String(item.reason || '').trim()) errors.push('recovery reason is required');
  return errors;
};

export const validatePayableItem = (item = {}) => {
  const errors = [];
  if (!isPayableType(item.type)) errors.push('payable type is not recognised');
  const amount = Number(item.amount);
  if (!Number.isFinite(amount) || amount <= 0) errors.push('payable amount must be greater than zero');
  return errors;
};

export const normaliseRecovery = (item = {}, actor = null) => ({
  type: String(item.type || 'OTHER').toUpperCase(),
  label: String(item.label || RECOVERY_TYPE_LABELS[String(item.type || '').toUpperCase()] || 'Recovery').trim(),
  amount: money(item.amount),
  reason: String(item.reason || '').trim(),
  approvedBy: item.approvedBy ? String(item.approvedBy) : (actor?._id ? String(actor._id) : ''),
  approvedByName: String(item.approvedByName || actor?.name || '').trim(),
  approvedAt: item.approvedAt || null,
  source: item.source === 'SYSTEM' ? 'SYSTEM' : 'MANUAL',
});

export const normalisePayable = (item = {}) => ({
  type: String(item.type || 'OTHER').toUpperCase(),
  label: String(item.label || PAYABLE_TYPE_LABELS[String(item.type || '').toUpperCase()] || 'Payable').trim(),
  amount: money(item.amount),
  note: String(item.note || '').trim(),
  source: item.source === 'SYSTEM' ? 'SYSTEM' : 'MANUAL',
});

// ── §12 — notice period decisions ──────────────────────────────────────────

export const NOTICE_DECISIONS = ['COMPLETED', 'BUYOUT', 'WAIVED'];

export const NOTICE_DECISION_LABELS = Object.freeze({
  COMPLETED: 'Completed Notice',
  BUYOUT: 'Notice Buyout',
  WAIVED: 'Notice Waived',
});

export const NOTICE_DECISION_NOTES = Object.freeze({
  COMPLETED: 'The employee served the full notice period.',
  BUYOUT: 'The employee pays the shortfall for the notice period not served.',
  WAIVED: 'The company waives the notice recovery.',
});

export const isNoticeDecision = (decision) =>
  NOTICE_DECISIONS.includes(String(decision || '').toUpperCase());

// ── §15 — the HR review checklist ──────────────────────────────────────────

export const CHECKLIST_ITEMS = [
  'attendanceVerified',
  'leaveVerified',
  'assetClearanceCompleted',
  'noticeDecisionCompleted',
];

export const CHECKLIST_LABELS = Object.freeze({
  attendanceVerified: 'Attendance Verified',
  leaveVerified: 'Leave Verified',
  assetClearanceCompleted: 'Asset Clearance Completed',
  noticeDecisionCompleted: 'Notice Decision Completed',
});

export const emptyChecklist = () => ({
  attendanceVerified: false,
  leaveVerified: false,
  assetClearanceCompleted: false,
  noticeDecisionCompleted: false,
});

export const checklistComplete = (checklist = {}) =>
  CHECKLIST_ITEMS.every((key) => Boolean(checklist?.[key]));

export const checklistProgress = (checklist = {}) => {
  const done = CHECKLIST_ITEMS.filter((key) => Boolean(checklist?.[key])).length;
  return { done, total: CHECKLIST_ITEMS.length, percent: Math.round((done / CHECKLIST_ITEMS.length) * 100) };
};

// ── §7 / §8 / §12 — the arithmetic ─────────────────────────────────────────
//
// Every rule below is DATA, not UI logic. When the company's policy differs,
// finance changes the number here — not a hardcoded constant in a React file.

export const FNF_RULES = Object.freeze({
  // §7 — proration basis. `workingDays` comes from the 29.5 PayrollPeriod
  // (or, failing that, from the calendar month).
  proration: { fallbackWorkingDays: 30 },
  // §8 — leave encashment pays unused EARNED leave, capped so a decade of
  // unused leave cannot become an open-ended liability.
  leaveEncashment: { types: ['EARNED'], maxDays: 30 },
  // §12 — notice period length is a company policy; 60 days is the Crewly
  // default and the settlement records whatever was actually used.
  notice: { defaultDays: 60 },
  // §11 / §10 — gratuity: 15/26 of the last drawn basic for every completed
  // year of service, payable from five years (the Payment of Gratuity Act
  // rounds a part-year of six months or more up).
  gratuity: { rate: 15 / 26, minimumServiceYears: 5, partYearMonths: 6 },
});

export const dailyRate = ({ monthlyGross = 0, workingDays = 0 } = {}) => {
  const days = Number(workingDays) > 0 ? Number(workingDays) : FNF_RULES.proration.fallbackWorkingDays;
  return money((Number(monthlyGross) || 0) / days);
};

/**
 * §7 — payable days.
 *
 * The last working day decides it, so HR never types the number: with
 * workingDays 31 and a last working day of 18 Aug the payable days are 18.
 * LOP already taken in the month is subtracted, and the result can never be
 * negative or exceed the month.
 */
export const computePayableDays = ({
  month = '',
  workingDays = 0,
  lastWorkingDate = '',
  lopDays = 0,
} = {}) => {
  const cap = Number(workingDays) > 0
    ? Number(workingDays)
    : (daysInMonth(month) || FNF_RULES.proration.fallbackWorkingDays);

  const day = dayOfMonth(lastWorkingDate);
  const upto = day > 0 ? Math.min(day, cap) : cap;
  const lop = Math.max(0, Number(lopDays) || 0);

  return Math.max(0, Math.min(cap, upto - lop));
};

export const computePendingSalary = ({
  monthlyGross = 0,
  workingDays = 0,
  payableDays = 0,
  lopDays = 0,
} = {}) => {
  const rate = dailyRate({ monthlyGross, workingDays });
  return {
    dailyRate: rate,
    payableDays,
    // §5 — the attendance the calculation used is frozen with the figure that
    // came out of it. Without it the statement reads "16 payable days of 31"
    // with no way to see that two of them were loss of pay.
    lopDays: Math.max(0, Number(lopDays) || 0),
    amount: money(rate * (Number(payableDays) || 0)),
  };
};

/**
 * §8 — leave encashment, shown transparently: days × rate, with the cap and
 * the leave type recorded so the employee can see exactly how it was reached.
 */
export const computeLeaveEncashment = ({
  unusedDays = 0,
  dailyRate: rate = 0,
  leaveType = 'EARNED',
  maxDays = FNF_RULES.leaveEncashment.maxDays,
} = {}) => {
  const raw = Math.max(0, Number(unusedDays) || 0);
  const capped = Math.min(raw, Math.max(0, Number(maxDays) || 0));
  return {
    leaveType,
    unusedDays: raw,
    encashedDays: capped,
    capped: capped < raw,
    maxDays: Math.max(0, Number(maxDays) || 0),
    dailyRate: money(rate),
    amount: money(capped * (Number(rate) || 0)),
  };
};

export const yearsOfService = ({ joiningDate = '', lastWorkingDate = '' } = {}) => {
  const days = daysBetween(joiningDate, lastWorkingDate);
  return days > 0 ? money(days / 365) : 0;
};

/**
 * §10 / §11 — gratuity for the settlement statement.
 *
 * This is the EMPLOYEE's gratuity payable on exit (15/26 × last basic ×
 * credited years), which is a different thing from 29.10's monthly employer
 * provisioning rate — the annual report provisions, the settlement pays.
 */
export const computeGratuity = ({
  monthlyBasic = 0,
  joiningDate = '',
  lastWorkingDate = '',
  eligible = false,
} = {}) => {
  const rules = FNF_RULES.gratuity;
  const years = yearsOfService({ joiningDate, lastWorkingDate });
  const basic = Number(monthlyBasic) || 0;

  // The Act: five completed years, and a part-year of six months or more
  // counts as a full one.
  const credited = Math.floor(years + (rules.partYearMonths / 12));

  if (!eligible || credited < rules.minimumServiceYears || basic <= 0) {
    return {
      eligible: false,
      yearsOfService: years,
      creditedYears: credited,
      monthlyBasic: money(basic),
      amount: 0,
      reason: !eligible
        ? 'Gratuity is not applicable to this employee'
        : credited < rules.minimumServiceYears
          ? `Minimum ${rules.minimumServiceYears} years of service not completed (${money(years)} years)`
          : 'Basic pay is not available',
    };
  }

  return {
    eligible: true,
    yearsOfService: years,
    creditedYears: credited,
    monthlyBasic: money(basic),
    amount: money(basic * rules.rate * credited),
    reason: `${credited} year(s) x Rs ${inr(basic)} x 15/26`,
  };
};

/**
 * §12 — three scenarios, one function.
 *
 *   COMPLETED → no recovery
 *   BUYOUT    → the employee pays the shortfall
 *   WAIVED    → the company waives it, and the waiver is recorded so the
 *               audit trail can show it was a decision, not an omission
 */
export const computeNoticeRecovery = ({
  decision = 'COMPLETED',
  noticePeriodDays = FNF_RULES.notice.defaultDays,
  servedDays = 0,
  dailyRate: rate = 0,
} = {}) => {
  const required = Math.max(0, Number(noticePeriodDays) || 0);
  const served = Math.max(0, Number(servedDays) || 0);
  const shortfall = Math.max(0, required - served);
  const key = String(decision || 'COMPLETED').toUpperCase();

  const recoverable = key === 'BUYOUT' ? money(shortfall * (Number(rate) || 0)) : 0;

  return {
    decision: key,
    noticePeriodDays: required,
    servedDays: served,
    shortfallDays: shortfall,
    dailyRate: money(rate),
    amount: recoverable,
    waived: key === 'WAIVED' && shortfall > 0,
    note: NOTICE_DECISION_NOTES[key] || '',
  };
};

// ── §11 — the settlement summary ───────────────────────────────────────────

export const summariseItems = (items = []) =>
  money((items || []).reduce((sum, item) => sum + (Number(item?.amount) || 0), 0));

/**
 * §11 — Earnings − Recoveries = Net Settlement.
 *
 * Recoveries are deliberately NOT deductions on a salary line: they are
 * listed separately so the employee can see a notice buyout is not a pay
 * deduction for a month of work.
 */
export const settlementTotals = ({
  pendingSalary = 0,
  additionalPayables = [],
  leaveEncashment = 0,
  noticeRecovery = 0,
  recoveries = [],
} = {}) => {
  const payables = Array.isArray(additionalPayables) ? additionalPayables : [];
  const recoveryList = Array.isArray(recoveries) ? recoveries : [];

  const manualPayables = payables.filter((item) => item?.source !== 'SYSTEM');
  const totalAdditional = summariseItems(payables);
  const totalManualAdditional = summariseItems(manualPayables);
  const totalRecoveries = money((Number(noticeRecovery) || 0) + summariseItems(recoveryList));
  const totalEarnings = money((Number(pendingSalary) || 0) + totalAdditional);
  const netSettlement = money(totalEarnings - totalRecoveries);

  return {
    pendingSalary: money(pendingSalary),
    leaveEncashment: money(leaveEncashment),
    totalAdditional,
    totalManualAdditional,
    totalEarnings,
    noticeRecovery: money(noticeRecovery),
    otherRecoveries: summariseItems(recoveryList),
    totalRecoveries,
    netSettlement,
    // §29-style guard carried over from the payroll engine: a settlement
    // that pays out less than nothing is always a data error.
    negative: netSettlement < 0,
  };
};

// ── §19 — dashboard KPIs ───────────────────────────────────────────────────

export const SETTLEMENT_KPI_KEYS = [
  'pendingSettlements',
  'hrReview',
  'financeApproval',
  'paid',
  'closed',
  'totalSettlementAmount',
];

export const settlementKpis = ({ rows = [] } = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const count = (status) => list.filter((row) => String(row?.status || '').toUpperCase() === status).length;

  const pending = list.filter((row) =>
    ['DRAFT', 'CALCULATED', 'REOPENED'].includes(String(row?.status || '').toUpperCase()),
  ).length;

  // §19 — "Total Settlement Amount" is what the company has committed to pay,
  // including everything still awaiting approval.
  const totalSettlementAmount = money(
    list
      .filter((row) => !['DRAFT'].includes(String(row?.status || '').toUpperCase()))
      .reduce((sum, row) => sum + (Number(row?.totals?.netSettlement) || 0), 0),
  );

  return {
    totalSettlements: list.length,
    pendingSettlements: pending,
    hrReview: count('HR_REVIEWED'),
    financeApproval: count('FINANCE_APPROVED'),
    paid: count('PAID'),
    closed: count('CLOSED'),
    totalSettlementAmount,
  };
};

// ── §17 — the settlement number ────────────────────────────────────────────

export const buildSettlementNumber = ({ month = '', sequence = 1 } = {}) =>
  `FNF-${String(month || '').replace('-', '')}-${String(Math.max(1, Number(sequence) || 1)).padStart(4, '0')}`;

// ── list / card views ──────────────────────────────────────────────────────

export const toSettlementCardView = (row = {}) => ({
  _id: row._id,
  settlementNumber: row.settlementNumber || '',
  employeeId: row.employeeId || '',
  employeeName: row.employee?.name || row.employeeName || '',
  employeeCode: row.employee?.employeeCode || row.employeeCode || '',
  department: row.employee?.departmentName || row.departmentName || '',
  designation: row.employee?.designation || row.designation || '',
  month: row.month || '',
  monthLabel: monthLabel(row.month),
  status: row.status || 'DRAFT',
  statusLabel: SETTLEMENT_STATUS_LABELS[row.status] || row.status || 'Draft',
  lastWorkingDate: row.exit?.lastWorkingDate || '',
  resignationDate: row.exit?.resignationDate || '',
  netSettlement: row.totals?.netSettlement ?? 0,
  netSettlementLabel: rupees(row.totals?.netSettlement ?? 0),
  checklist: row.checklist || emptyChecklist(),
  checklistProgress: checklistProgress(row.checklist),
  updatedAt: row.updatedAt || null,
  paidAt: row.payment?.paidAt || null,
});

export const filterSettlements = ({ rows = [], search = '', status = '', departmentId = '' } = {}) => {
  const needle = String(search || '').trim().toLowerCase();
  const wanted = String(status || '').toUpperCase();
  const department = String(departmentId || '');

  return (rows || []).filter((row) => {
    if (wanted && String(row?.status || '').toUpperCase() !== wanted) return false;
    if (department && String(row?.employee?.departmentId || '') !== department) return false;
    if (!needle) return true;
    return [
      row?.employee?.name,
      row?.employee?.employeeCode,
      row?.settlementNumber,
      row?.employee?.designation,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
};

export const sortSettlements = (rows = []) =>
  [...(rows || [])].sort((a, b) => {
    const left = String(a?.exit?.lastWorkingDate || a?.month || '');
    const right = String(b?.exit?.lastWorkingDate || b?.month || '');
    if (left === right) return String(a?.settlementNumber || '').localeCompare(String(b?.settlementNumber || ''));
    return right.localeCompare(left);
  });

// ── §18 — the employee's own view (never the company's numbers) ─────────────

export const toEmployeeSettlementView = (row = {}) => ({
  _id: row._id,
  settlementNumber: row.settlementNumber || '',
  status: row.status || 'DRAFT',
  statusLabel: SETTLEMENT_STATUS_LABELS[row.status] || row.status || 'Draft',
  month: row.month || '',
  monthLabel: monthLabel(row.month),
  exit: {
    resignationDate: row.exit?.resignationDate || '',
    lastWorkingDate: row.exit?.lastWorkingDate || '',
    reason: row.exit?.reason || '',
    noticePeriodDays: row.exit?.noticePeriodDays ?? FNF_RULES.notice.defaultDays,
    noticeDecision: row.exit?.noticeDecision || 'COMPLETED',
    noticeDecisionLabel: NOTICE_DECISION_LABELS[row.exit?.noticeDecision] || 'Completed Notice',
  },
  earnings: {
    pendingSalary: row.earnings?.pendingSalary || { amount: 0, payableDays: 0, dailyRate: 0 },
    leaveEncashment: row.earnings?.leaveEncashment || { amount: 0, encashedDays: 0, dailyRate: 0 },
    gratuity: row.earnings?.gratuity || { amount: 0, eligible: false },
    additional: row.earnings?.additional || [],
  },
  recoveries: {
    notice: row.recoveries?.notice || { amount: 0, shortfallDays: 0, decision: 'COMPLETED' },
    items: row.recoveries?.items || [],
  },
  totals: row.totals || settlementTotals({}),
  payment: row.payment || { paidAt: null, reference: '', method: '' },
  // An employee may download the statement once it has been paid; before that
  // the figures are still moving and the portal says so.
  canDownload: ['PAID', 'CLOSED'].includes(String(row.status || '').toUpperCase()),
});

// ── §15 / §17 — exports ────────────────────────────────────────────────────

export const REGISTER_HEADERS = [
  'Settlement No',
  'Employee Code',
  'Employee Name',
  'Department',
  'Designation',
  'Month',
  'Resignation Date',
  'Last Working Day',
  'Notice Decision',
  'Payable Days',
  'Pending Salary',
  'Leave Encashment',
  'Gratuity',
  'Other Payables',
  'Notice Recovery',
  'Other Recoveries',
  'Net Settlement',
  'Status',
  'Paid On',
];

export const registerRows = ({ rows = [] } = {}) =>
  (rows || []).map((row) => [
    row?.settlementNumber || '',
    row?.employee?.employeeCode || '',
    row?.employee?.name || '',
    row?.employee?.departmentName || '',
    row?.employee?.designation || '',
    monthLabel(row?.month),
    formatDate(row?.exit?.resignationDate),
    formatDate(row?.exit?.lastWorkingDate),
    NOTICE_DECISION_LABELS[row?.exit?.noticeDecision] || '',
    row?.earnings?.pendingSalary?.payableDays ?? 0,
    money(row?.earnings?.pendingSalary?.amount),
    money(row?.earnings?.leaveEncashment?.amount),
    money(row?.earnings?.gratuity?.amount),
    money(row?.totals?.totalManualAdditional),
    money(row?.recoveries?.notice?.amount),
    money(row?.totals?.otherRecoveries),
    money(row?.totals?.netSettlement),
    SETTLEMENT_STATUS_LABELS[row?.status] || row?.status || '',
    row?.payment?.paidAt ? String(row.payment.paidAt).slice(0, 10) : '',
  ]);

export const registerFilename = ({ month = '' } = {}) =>
  `final-settlement-register-${month || 'all'}.csv`;

export const statementFilename = ({ settlementNumber = '', employeeName = '' } = {}) => {
  const safe = String(employeeName || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  // The settlement number already carries the FNF prefix — do not double it.
  const stem = settlementNumber ? String(settlementNumber) : 'FNF-draft';
  return `${stem}${safe ? `-${safe}` : ''}.pdf`;
};

export const EXPORT_FORMATS = ['CSV', 'XLSX'];
export const normaliseFormat = (format = '') => {
  const key = String(format || '').toUpperCase();
  return EXPORT_FORMATS.includes(key) ? key : 'CSV';
};

export const contentTypes = Object.freeze({
  CSV: 'text/csv; charset=utf-8',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
});

export const reportFilename = ({ month = '', format = 'CSV' } = {}) =>
  `final-settlement-register-${month || 'all'}.${normaliseFormat(format).toLowerCase()}`;

export default {
  SETTLEMENT_STATUSES,
  SETTLEMENT_STATUS_LABELS,
  SETTLEMENT_TRANSITIONS,
  canTransitionSettlement,
  transitionError,
  isSettlementEditable,
  isSettlementLocked,
  FNF_AUDIT_ACTIONS,
  NOTIFICATION_TYPES,
  notificationCopy,
  RECOVERY_TYPES,
  RECOVERY_TYPE_LABELS,
  PAYABLE_TYPES,
  PAYABLE_TYPE_LABELS,
  NOTICE_DECISIONS,
  NOTICE_DECISION_LABELS,
  CHECKLIST_ITEMS,
  CHECKLIST_LABELS,
  emptyChecklist,
  checklistComplete,
  checklistProgress,
  FNF_RULES,
  dailyRate,
  computePayableDays,
  computePendingSalary,
  computeLeaveEncashment,
  computeGratuity,
  computeNoticeRecovery,
  settlementTotals,
  settlementKpis,
  buildSettlementNumber,
  toSettlementCardView,
  toEmployeeSettlementView,
  filterSettlements,
  sortSettlements,
  registerRows,
  REGISTER_HEADERS,
  registerFilename,
  statementFilename,
  reportFilename,
  monthLabel,
  daysBetween,
  formatDate,
  money,
  rupees,
  inr,
};
