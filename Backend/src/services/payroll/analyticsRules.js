// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — PAYROLL ANALYTICS RULES (pure)
//
//  Everything in this file is a function of its arguments: no database, no
//  clock, no cache, no I/O. That is what makes a report testable and what
//  keeps the dashboard, the trend chart and the exported spreadsheet from
//  ever disagreeing with each other — they are all the same aggregation.
//
//  Three rules the whole module obeys:
//
//   1. §2 / §11 — NOTHING IS RECALCULATED. Every figure is copied out of the
//      immutable 29.6 PayrollResult snapshot (isCurrent + CALCULATED). An
//      analytics module that recomputed salary would be a second payroll
//      engine, and the two would eventually disagree.
//   2. §21 — the aggregation is done ONCE per read and cached per company +
//      month, because a 500-employee year of snapshots is 6,000 documents
//      and nobody should pay for that twice.
//   3. Money never leaves this file unrounded. `money()` rounds; `rupees()`
//      formats for a document; `inr()` groups digits for a spreadsheet.
// ═══════════════════════════════════════════════════════════════════════════

import {
  buildStatutoryRow,
  financialYearOf,
  money,
  monthLabel,
  summariseStatutoryRows,
} from './statutoryRules.js';
import { statutoryKindOf } from './payrollEngineRules.js';
import { ENTRY_TYPE_LABELS } from './monthlyInputRules.js';

// ── §5 / §6 / §26 — the report catalogue ───────────────────────────────────

export const REPORT_KEYS = [
  'OVERVIEW',
  'DEPARTMENT',
  'DESIGNATION',
  'HEADCOUNT',
  'SALARY_BANDS',
  'TREND',
  'BONUS',
  'OVERTIME',
  'LEAVE',
  'STATUTORY',
  'CTC',
  'REGISTER',
  // ── 29.13 ────────────────────────────────────────────────────────────────
  'EARNINGS',
  'DEDUCTIONS',
  'EMPLOYER',
  'REIMBURSEMENT',
  'FNF',
  'VARIANCE',
];

export const REPORT_LABELS = Object.freeze({
  OVERVIEW: 'Payroll Overview',
  DEPARTMENT: 'Department Payroll',
  DESIGNATION: 'Designation Analytics',
  HEADCOUNT: 'Headcount & Cost',
  SALARY_BANDS: 'Salary Distribution',
  TREND: 'Payroll Trends',
  BONUS: 'Bonus & Incentive',
  OVERTIME: 'Overtime',
  LEAVE: 'Leave Impact',
  STATUTORY: 'Statutory Liability',
  CTC: 'Cost to Company',
  REGISTER: 'Payroll Register',
  // ── 29.13 ──
  EARNINGS: 'Earnings Analytics',
  DEDUCTIONS: 'Deduction Analytics',
  EMPLOYER: 'Employer Contribution',
  REIMBURSEMENT: 'Reimbursement Analytics',
  FNF: 'F&F Settlements',
  VARIANCE: 'Payroll Variance',
});

// §16 — the CTC report is the one the brief reserves for Finance.
export const FINANCE_ONLY_REPORTS = Object.freeze(['CTC']);

export const isReportKey = (value) => REPORT_KEYS.includes(String(value || '').toUpperCase());

// ── §10 / §8 — salary bands are DATA, never a switch in a component ─────────

export const SALARY_BANDS = Object.freeze([
  { key: 'BAND_0_25K', label: 'Up to Rs 25,000', min: 0, max: 25000 },
  { key: 'BAND_25_50K', label: 'Rs 25,001 - 50,000', min: 25000, max: 50000 },
  { key: 'BAND_50_75K', label: 'Rs 50,001 - 75,000', min: 50000, max: 75000 },
  { key: 'BAND_75_1L', label: 'Rs 75,001 - 1,00,000', min: 75000, max: 100000 },
  // `max: null` means open-ended. Infinity would be the obvious value, but it
  // survives neither JSON nor a round-trip back from the browser, and the top
  // band is the one a company is most likely to edit.
  { key: 'BAND_ABOVE_1L', label: 'Above Rs 1,00,000', min: 100000, max: null },
]);

/**
 * §8 — a company may define its own bands ("Up to 30k", "30-60k", …).
 *
 * Stored per company, so the normaliser has to be defensive about what comes
 * back out of the database: bands are sorted, overlapped or inverted ranges
 * are dropped, and the LAST band is forced open-ended so a salary can never
 * fall off the end of the distribution. Anything unreadable falls back to the
 * default five rather than rendering an empty chart.
 */
export const normaliseSalaryBands = (bands = null) => {
  const list = Array.isArray(bands) ? bands : [];
  const cleaned = list
    .map((band, index) => ({
      key: String(band?.key || `BAND_${index}`).trim() || `BAND_${index}`,
      label: String(band?.label || '').trim(),
      min: Number.isFinite(Number(band?.min)) ? Math.max(0, Number(band.min)) : null,
      // `Number(null)` is 0, not NaN — a band whose ceiling was left open
      // would silently become "up to zero" and be dropped. Check for the
      // absence of a value first, then for its being a number.
      max: band?.max === null || band?.max === undefined || band?.max === ''
        ? null
        : Number.isFinite(Number(band.max)) ? Number(band.max) : null,
    }))
    // A band with no ceiling is legal — the top one always is — so it is
    // filtered out here only if it sits below another band, which would
    // swallow everything above it.
    .filter((band) => band.label && band.min !== null && (band.max === null || band.max > band.min))
    .sort((a, b) => a.min - b.min);

  // Only one band can be open-ended, and it has to be the top one: the
  // editor returns the top band with `max: null`, so dropping it would
  // silently delete what the user just typed.
  const closed = cleaned.filter((band) => band.max !== null);
  const open = cleaned.filter((band) => band.max === null);
  const ordered = [...closed, ...(open.length ? [open[0]] : [])];

  if (ordered.length < 2) return [...SALARY_BANDS];

  // Drop a band that starts before the previous one ends: overlapping bands
  // would count one employee twice, which is worse than dropping a band.
  const nonOverlapping = ordered.filter((band, index) => index === 0 || band.min >= ordered[index - 1].max);
  const usable = nonOverlapping.length >= 2 ? nonOverlapping : ordered;

  return usable.map((band, index) => ({
    key: band.key,
    label: band.label,
    min: band.min,
    // The top band has no ceiling: a 12-lakh salary must still be counted.
    max: index === usable.length - 1 ? null : band.max,
  }));
};

const ceilingOf = (band = {}) => (band.max === null || band.max === undefined ? Number.POSITIVE_INFINITY : Number(band.max));

/**
 * §8 — what is WRONG with a set of bands, as words a person can act on.
 *
 * The normaliser is forgiving (it repairs and falls back) because it reads
 * whatever is in the database. The editor must not be: silently repairing
 * what a user typed means they save one thing and get another.
 */
export const salaryBandIssues = (bands = []) => {
  if (!Array.isArray(bands)) return ['salaryBands must be a list'];
  if (bands.length < 2) return ['Give at least two salary bands'];

  const issues = [];
  const ordered = [...bands].sort((a, b) => Number(a?.min) || 0 - (Number(b?.min) || 0));
  let highestSeen = null;

  ordered.forEach((band, index) => {
    const label = `Band ${index + 1}`;
    if (!String(band?.label || '').trim()) issues.push(`${label} needs a name`);

    const min = Number(band?.min);
    if (!Number.isFinite(min) || min < 0) issues.push(`${label} needs a numeric lower limit`);

    const max = band?.max === null || band?.max === undefined || band?.max === ''
      ? null
      : Number(band.max);
    // The top band's ceiling is ignored — it is always open-ended — but a
    // middle band without one would swallow everything above it.
    if (index < ordered.length - 1 && (max === null || !Number.isFinite(max))) {
      issues.push(`${label} needs an upper limit (only the last band is open-ended)`);
    } else if (max !== null && Number.isFinite(max) && Number.isFinite(min) && max <= min) {
      issues.push(`${label}: the upper limit must be above the lower one`);
    }
    if (highestSeen !== null && Number.isFinite(min) && min < highestSeen) {
      issues.push(`${label} overlaps the band below it`);
    }
    if (max !== null && Number.isFinite(max)) highestSeen = max;
  });

  return issues;
};

export const bandOf = (amount = 0, bands = null) => {
  const value = Number(amount) || 0;
  const list = Array.isArray(bands) && bands.length ? bands : SALARY_BANDS;
  // The last band is open-ended, so `find` would miss a negative or an
  // enormous figure: fall back to the last band rather than dropping a row.
  return list.find((band) => value >= num(band.min) && value < ceilingOf(band)) || list[list.length - 1];
};

// ── §11 — trend granularity ────────────────────────────────────────────────

export const TREND_PERIODS = ['MONTHLY', 'QUARTERLY', 'YEARLY'];

export const TREND_PERIOD_LABELS = Object.freeze({
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  YEARLY: 'Yearly',
});

export const isTrendPeriod = (value) => TREND_PERIODS.includes(String(value || '').toUpperCase());

export const periodKeyOf = (month = '', period = 'MONTHLY') => {
  const key = String(period || 'MONTHLY').toUpperCase();
  const [year, monthPart] = String(month || '').split('-');
  if (!year || !monthPart) return '';
  if (key === 'YEARLY') return year;
  if (key === 'QUARTERLY') {
    const quarter = Math.floor((Number(monthPart) - 1) / 3) + 1;
    return `${year}-Q${quarter}`;
  }
  return `${year}-${monthPart}`;
};

export const periodLabelOf = (key = '', period = 'MONTHLY') => {
  const value = String(key || '');
  if (!value) return '';
  if (String(period).toUpperCase() === 'YEARLY') return `FY ${value}`;
  if (String(period).toUpperCase() === 'QUARTERLY') {
    const [year, quarter] = value.split('-');
    return `Q${String(quarter || '').replace('Q', '')} ${year}`;
  }
  return monthLabel(value);
};

// ── §4 — payroll period presets ────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const PERIOD_PRESETS = [
  'CURRENT_MONTH',
  'PREVIOUS_MONTH',
  'LAST_3_MONTHS',
  'LAST_6_MONTHS',
  'LAST_12_MONTHS',
  'CURRENT_FY',
  'PREVIOUS_FY',
  'CUSTOM',
];

export const PERIOD_PRESET_LABELS = Object.freeze({
  CURRENT_MONTH: 'Current month',
  PREVIOUS_MONTH: 'Previous month',
  LAST_3_MONTHS: 'Last 3 months',
  LAST_6_MONTHS: 'Last 6 months',
  LAST_12_MONTHS: 'Last 12 months',
  CURRENT_FY: 'Current financial year',
  PREVIOUS_FY: 'Previous financial year',
  CUSTOM: 'Custom range',
});

export const isPeriodPreset = (value) => PERIOD_PRESETS.includes(String(value || '').toUpperCase());

export const shiftMonthOf = (month = '', delta = 0) => {
  if (!MONTH_RE.test(String(month || ''))) return '';
  const [year, part] = String(month).split('-').map(Number);
  const index = year * 12 + (part - 1) + Number(delta || 0);
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

/** Inclusive list of months from `from` to `to`, oldest first. */
export const monthRange = (from = '', to = '') => {
  if (!MONTH_RE.test(String(from || '')) || !MONTH_RE.test(String(to || ''))) return [];
  if (String(to) < String(from)) return [];
  const span =
    (Number(String(to).slice(0, 4)) * 12 + Number(String(to).slice(5))) -
    (Number(String(from).slice(0, 4)) * 12 + Number(String(from).slice(5)));
  const months = [];
  for (let offset = 0; offset <= span; offset += 1) months.push(shiftMonthOf(from, offset));
  return months;
};

/**
 * §4 — turns a preset into the months it covers.
 *
 * The window is resolved here, in the rules, because every report, the
 * dashboard and every export have to agree on what "last quarter" means.
 * An unknown preset falls back to the current month rather than to the whole
 * database.
 */
export const resolvePeriod = ({
  preset = 'CURRENT_MONTH',
  month = '',
  fromMonth = '',
  toMonth = '',
  now = null,
} = {}) => {
  const key = isPeriodPreset(preset) ? String(preset).toUpperCase() : 'CURRENT_MONTH';
  const today = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const anchor = MONTH_RE.test(String(month || '')) ? String(month) : `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;

  const build = (months, from, to) => ({
    preset: key,
    label: key === 'CUSTOM'
      ? `${monthLabel(from)} to ${monthLabel(to)}`
      : PERIOD_PRESET_LABELS[key],
    months,
    fromMonth: from,
    toMonth: to,
  });

  if (key === 'PREVIOUS_MONTH') {
    const target = shiftMonthOf(anchor, -1);
    return build([target], target, target);
  }
  if (key === 'LAST_3_MONTHS') return build(recentMonths(anchor, 3), shiftMonthOf(anchor, -2), anchor);
  if (key === 'LAST_6_MONTHS') return build(recentMonths(anchor, 6), shiftMonthOf(anchor, -5), anchor);
  if (key === 'LAST_12_MONTHS') return build(recentMonths(anchor, 12), shiftMonthOf(anchor, -11), anchor);
  if (key === 'CURRENT_FY') {
    const months = financialYearMonths(anchor, 4);
    return build(months, months[0] || '', months[months.length - 1] || '');
  }
  if (key === 'PREVIOUS_FY') {
    const months = financialYearMonths(shiftMonthOf(anchor, -12), 4);
    return build(months, months[0] || '', months[months.length - 1] || '');
  }
  if (key === 'CUSTOM') {
    const months = monthRange(fromMonth, toMonth);
    return build(months, months[0] || '', months[months.length - 1] || '');
  }
  return build([anchor], anchor, anchor);
};

// ── §20 — schedule frequencies ─────────────────────────────────────────────

export const SCHEDULE_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'YEARLY'];

export const SCHEDULE_FREQUENCY_LABELS = Object.freeze({
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  YEARLY: 'Yearly',
});

export const isScheduleFrequency = (value) => SCHEDULE_FREQUENCIES.includes(String(value || '').toUpperCase());

/**
 * The next run, in UTC, from a given instant. Months and quarters advance on
 * the calendar, not on a fixed 30-day tick, so "monthly on the 3rd" stays on
 * the 3rd — including across a short month.
 */
export const nextRunAt = ({ from = new Date(), frequency = 'MONTHLY', dayOfMonth = 1 } = {}) => {
  const start = from instanceof Date && !Number.isNaN(from.getTime()) ? new Date(from.getTime()) : new Date();
  const step = String(frequency || 'MONTHLY').toUpperCase() === 'YEARLY'
    ? 12
    : String(frequency || 'MONTHLY').toUpperCase() === 'QUARTERLY'
      ? 3
      : 1;

  const day = Math.min(Math.max(1, Number(dayOfMonth) || 1), 31);
  // Clamped to the end of the target month: scheduling the 31st must not skip
  // February and land in March.
  const candidateAt = (year, monthIndex) => {
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, monthIndex, Math.min(day, lastDay)));
  };

  // The next occurrence STRICTLY AFTER "from". A schedule created on the 2nd
  // to run on the 3rd fires tomorrow, not five weeks from now — and one that
  // has just executed on its due date steps forward a whole period, never
  // back onto the day it already ran.
  let index = start.getUTCFullYear() * 12 + start.getUTCMonth();
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const candidate = candidateAt(Math.floor(index / 12), index % 12);
    if (candidate.getTime() > start.getTime()) return candidate;
    index += step;
  }
  return start;
};

// ── §24 — audit actions ───────────────────────────────────────────────────

export const ANALYTICS_AUDIT_ACTIONS = Object.freeze({
  REPORT_VIEWED: 'Payroll report viewed',
  REPORT_EXPORTED: 'Payroll report exported',
  REPORT_DOWNLOADED: 'Payroll report downloaded',
  SALARY_HISTORY_VIEWED: 'Employee salary history viewed',
  SCHEDULE_CREATED: 'Scheduled report created',
  SCHEDULE_UPDATED: 'Scheduled report updated',
  SCHEDULE_DELETED: 'Scheduled report deleted',
  SCHEDULE_EXECUTED: 'Scheduled report executed',
  DASHBOARD_REFRESHED: 'Executive dashboard refreshed',
});

// ── the one row every report is built from ─────────────────────────────────

const num = (value) => Number(value) || 0;

/**
 * One employee-month, normalised out of the snapshot.
 *
 * The snapshot already stores the employee's identity as it was on the day of
 * the run (29.6 §18), so the row does NOT depend on the User document — the
 * join only fills in what payroll never stored (department name, current
 * status, joining date). A report about August therefore still reads August
 * for someone who changed department in September.
 */
export const buildAnalyticsRow = ({
  result = {},
  employee = null,
  departmentName = '',
  payment = null,
} = {}) => {
  const totals = result.totals || {};
  const attendance = result.attendance || {};
  const statutory = result.statutory || {};

  // §5 — "gross" is the month's WHOLE earnings, not just the fixed structure.
  //
  // The engine stores two figures and they are not the same number:
  //   gross         = the structure earnings (what PF, ESI and LOP are
  //                   computed on; what the payslip shows as Gross Salary)
  //   totalEarnings = structure + variable + overtime (what the payslip shows
  //                   as Total Earnings, and what 29.6 sums as `grossPayroll`)
  // Reporting the narrow one beside a net that includes overtime made the
  // executive dashboard show net pay ABOVE gross pay for any month with
  // overtime or variable pay. The fixed figure is still carried, because §14
  // has to price a LOP day off the same base the engine deducted it from.
  const fixedGross = num(totals.gross ?? totals.grossSalary);
  const gross = num(totals.totalEarnings ?? fixedGross);
  const net = num(totals.netPay ?? totals.netSalary);
  const employeeId = String(result.employeeId || employee?._id || '');

  return {
    employeeId,
    employeeCode: result.employeeCode || employee?.employeeCode || '',
    employeeName: result.employeeName || employee?.name || '',
    departmentId: String(result.departmentId || employee?.department || ''),
    department: departmentName || employee?.departmentName || '',
    designation: result.designation || employee?.designation || '',
    // §24 — employment status and salary structure are filters the brief
    // asks for. The status lives on the User record (HR owns it), the
    // structure id is stamped on the snapshot by 29.6.
    employmentStatus: employee?.status || '',
    structureId: String(result.structureId || ''),
    structureName: result.structureName || '',

    month: result.month || '',

    gross,
    // The structure earnings the engine based LOP, PF and ESI on. Kept
    // because §14 prices a lost day off this base, not off the total.
    fixedGross,
    basic: num(totals.basic),
    totalEarnings: num(totals.totalEarnings),
    totalDeductions: num(totals.totalDeductions),
    net,
    employerCost: num(totals.employerCost),
    ctc: num(totals.ctc),

    // §12 — variable pay, broken out by what the company actually paid.
    // Bonus is the BONUS_* / INCENTIVE / COMMISSION lines; anything else that
    // arrived as variable pay (an adjustment, say) is shown on its own line so
    // the columns add up to the total instead of quietly hiding it.
    variableEarnings: num(totals.variableEarnings),
    bonus: sumLines(result.variableEarnings, BONUS_LINES),
    otherVariable: Math.max(0, money(num(totals.variableEarnings) - sumLines(result.variableEarnings, BONUS_LINES))),
    overtime: num(totals.overtime),
    reimbursements: num(totals.reimbursements),

    // §13 — overtime hours come from the attendance block, never recomputed.
    otHours: num(attendance.otHours),
    // §14 — loss of pay, the payroll cost of leave.
    lopDays: num(attendance.lopDays),
    paidLeaveDays: num(attendance.paidLeaveDays),
    workingDays: num(attendance.workingDays),
    paidDays: num(attendance.paidDays),

    // §15 — statutory, read through 29.10's own row builder so the two
    // modules cannot drift apart on what "PF employer" means.
    statutory: buildStatutoryRow({ result, employee: employee || {}, departmentName }),

    // §17 — the register needs to know whether the money actually moved.
    paymentStatus: payment?.status || 'NOT_IN_BATCH',
    // §22 — and whether the payroll itself calculated. The reader only ever
    // returns CALCULATED snapshots, so this is the reader's contract showing
    // through, not a per-employee state.
    payrollStatus: result.status || '',
    paidAt: payment?.paidAt || null,
    paymentReference: payment?.paymentReference || '',

    hasStatutory: Boolean(statutory),

    // §11 / §12 / §18 — the line-level breakdown the component reports group
    // by. The codes come from 29.2 (structure components), 29.5 (variable pay
    // and reimbursements) and 29.6 (statutory), so a component a company adds
    // next year shows up in these reports without this file changing.
    lines: {
      earnings: normaliseLines(result.earnings),
      variableEarnings: normaliseLines(result.variableEarnings),
      reimbursements: normaliseLines(result.reimbursements),
      deductions: normaliseLines(result.deductions),
      employerContributions: normaliseLines(result.employerContributions),
    },
  };
};

/**
 * One payroll line, normalised. The three producers disagree about the field
 * name for the code — 29.6 writes `code`, 29.5 writes `type`, a structure
 * preview writes `componentCode` — so this is the one place that reconciles
 * them.
 */
const normaliseLines = (lines = []) =>
  (Array.isArray(lines) ? lines : []).map((line) => ({
    code: String(line?.code || line?.type || line?.componentCode || '').trim().toUpperCase() || 'OTHER',
    name: line?.name || line?.label || '',
    amount: num(line?.amount),
    source: line?.source || '',
    claimStatus: line?.claimStatus || '',
  }));

// §12 — which variable-earning entry types are bonus and incentive pay.
//
// Taken from the vocabulary 29.5 actually stores (monthlyInputRules
// ENTRY_TYPE_LABELS: BONUS_PERFORMANCE, BONUS_FESTIVAL, BONUS_RETENTION,
// BONUS_SPOT, BONUS_JOINING, INCENTIVE, COMMISSION_SALES), not invented here.
// Matching on a prefix rather than a fixed list means a bonus type added later
// is counted as bonus without anyone remembering to update this file.
/**
 * §12 — the pattern that decides whether a variable-earning line is bonus or
 * incentive pay.
 *
 * It is a single exported constant because TWO readers use it: the row
 * builder, and the MongoDB aggregation that sums a large window without
 * loading it. If the rule were written twice the two would eventually
 * disagree about the same rupee.
 */
export const BONUS_ENTRY_PATTERN = /^(BONUS_.+|INCENTIVE|COMMISSION_SALES)$/;

export const isBonusEntry = (type = '') => {
  const key = String(type || '').trim().toUpperCase();
  if (!key) return false;
  return BONUS_ENTRY_PATTERN.test(key);
};

const sumLines = (lines = [], predicate = null) =>
  money(
    (Array.isArray(lines) ? lines : [])
      .filter((line) => (predicate ? predicate(line) : true))
      .reduce((total, line) => total + num(line?.amount), 0),
  );

const BONUS_LINES = (line) => isBonusEntry(line?.type || line?.name);

// ── the one aggregation ────────────────────────────────────────────────────

/**
 * §5 / §6 — the roll-up every KPI card, chart and export reads.
 *
 * Built in a single pass so the dashboard can never disagree with the
 * department table or the register: they are literally the same numbers.
 */
export const summariseRows = ({ rows = [] } = {}) => {
  const list = Array.isArray(rows) ? rows : [];

  const sum = (pick) => money(list.reduce((total, row) => total + num(pick(row)), 0));
  // §5 — a headcount, not a count of employee-months. Over a twelve-month
  // window one employee is ONE employee, however many months they were paid;
  // counting rows would report twelve times the company. Rows with no
  // employee identity at all (a synthetic series in a test) fall back to the
  // row count rather than collapsing to zero.
  const identities = new Set(list.map((row) => String(row.employeeId || '')).filter(Boolean));
  const paidEmployees = identities.size || list.length;
  const gross = sum((row) => row.gross);
  const net = sum((row) => row.net);

  return {
    employeesPaid: paidEmployees,
    grossSalary: gross,
    netSalary: net,
    earningsTotal: sum((row) => row.totalEarnings),
    deductionsTotal: sum((row) => row.totalDeductions),
    employerContribution: sum((row) => row.employerCost),
    // §16 — Cost To Company is what the company actually spends: earnings
    // plus everything it contributes on the employee's behalf.
    ctc: sum((row) => row.ctc),
    totalPayrollCost: money(gross + sum((row) => row.employerCost)),
    // §5 — "average salary" is the average of what the company PAID per head,
    // not of what landed in a bank account. A card sitting between "Gross
    // Salary" and "Net Salary Paid" has to say which one it is averaging.
    averageSalary: paidEmployees ? money(gross / paidEmployees) : 0,
    averageCtc: paidEmployees ? money(sum((row) => row.ctc) / paidEmployees) : 0,
    // §12 / §13 — variable pay and overtime, for the bonus and OT reports.
    bonusTotal: sum((row) => row.bonus),
    variableTotal: sum((row) => row.variableEarnings),
    overtimeTotal: sum((row) => row.overtime),
    overtimeHours: money(list.reduce((total, row) => total + num(row.otHours), 0)),
    reimbursements: sum((row) => row.reimbursements),
    // §14 — the cost of leave.
    lopDays: money(list.reduce((total, row) => total + num(row.lopDays), 0)),
    paidLeaveDays: money(list.reduce((total, row) => total + num(row.paidLeaveDays), 0)),
  };
};

// ── §5 — the executive KPI cards ───────────────────────────────────────────

export const analyticsKpis = ({
  rows = [],
  // §29 — the aggregation path hands in a roll-up it computed in MongoDB, and
  // the row path hands in nothing. Either way the cards below are the same
  // numbers, which is the only property that matters.
  summary: providedSummary = null,
  statutory: providedStatutory = null,
  departments: providedDepartments = null,
  settlements = [],
  previous = null,
} = {}) => {
  const summary = providedSummary || summariseRows({ rows });
  const statutory = providedStatutory || statutoryLiability({ rows });

  const byCost = providedDepartments || departmentRows({ rows });
  const highest = byCost.reduce(
    (best, row) => (num(row.totalCost) > num(best?.totalCost) ? row : best),
    byCost[0] || null,
  );

  const previousCost = num(previous?.totalPayrollCost);

  return {
    totalPayrollCost: summary.totalPayrollCost,
    netSalaryPaid: summary.netSalary,
    grossSalary: summary.grossSalary,
    employerContribution: summary.employerContribution,
    employeesPaid: summary.employeesPaid,
    averageSalary: summary.averageSalary,
    highestDepartmentCost: highest
      ? { department: highest.department, cost: highest.totalCost }
      : { department: '', cost: 0 },
    totalStatutoryLiability: statutory.totals?.totalLiability ?? 0,
    statutory: statutory.totals,
    // §3 — the rest of the card set: what was deducted, and the three
    // variable costs management asks about most.
    employeeDeductions: summary.deductionsTotal,
    overtimeCost: summary.overtimeTotal,
    overtimeHours: summary.overtimeHours,
    bonusTotal: summary.bonusTotal,
    reimbursements: summary.reimbursements,
    // §14 — the rupee cost of lost days. Derived, like the leave report: the
    // snapshot stores the days, not the money.
    lopDays: summary.lopDays,
    lopDeduction: money(summary.lopDeduction),
    // §6 — the settlement count and the month-on-month move.
    finalSettlements: (settlements || []).length,
    settlementAmount: money((settlements || []).reduce((total, row) => total + num(row?.totals?.netSettlement), 0)),
    costChangePercent: previousCost
      ? money(((summary.totalPayrollCost - previousCost) / previousCost) * 100)
      : 0,
  };
};

// ── §7 — department payroll ────────────────────────────────────────────────

const groupRows = (rows = [], keyOf, seed, merge) => {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const key = String(keyOf(row) || 'Unassigned');
    map.set(key, merge(map.get(key) || seed(key), row));
  });
  return [...map.values()];
};

export const departmentRows = ({ rows = [] } = {}) =>
  groupRows(
    rows,
    (row) => row.department || 'Unassigned',
    (key) => ({ department: key, employees: 0, gross: 0, net: 0, employerCost: 0, ctc: 0, bonus: 0, overtime: 0, otHours: 0, lopDays: 0 }),
    (acc, row) => ({
      department: acc.department,
      employees: acc.employees + 1,
      gross: money(acc.gross + num(row.gross)),
      net: money(acc.net + num(row.net)),
      employerCost: money(acc.employerCost + num(row.employerCost)),
      ctc: money(acc.ctc + num(row.ctc)),
      bonus: money(acc.bonus + num(row.bonus)),
      overtime: money(acc.overtime + num(row.overtime)),
      otHours: money(acc.otHours + num(row.otHours)),
      lopDays: money(acc.lopDays + num(row.lopDays)),
    }),
  )
    .map((row) => ({
      ...row,
      totalCost: money(num(row.gross) + num(row.employerCost)),
      averageSalary: row.employees ? money(num(row.gross) / row.employees) : 0,
    }))
    // §7 — "Support sorting by highest payroll cost": the default order.
    .sort((a, b) => num(b.totalCost) - num(a.totalCost));

// ── §8 — designation analytics ─────────────────────────────────────────────

export const designationRows = ({ rows = [] } = {}) =>
  groupRows(
    rows,
    (row) => row.designation || 'Unassigned',
    (key) => ({ designation: key, employees: 0, total: 0, highest: 0, lowest: Number.POSITIVE_INFINITY, ctc: 0 }),
    (acc, row) => ({
      designation: acc.designation,
      employees: acc.employees + 1,
      total: money(acc.total + num(row.gross)),
      highest: Math.max(acc.highest, num(row.gross)),
      lowest: Math.min(acc.lowest, num(row.gross)),
      ctc: money(acc.ctc + num(row.ctc)),
    }),
  )
    .map((row) => ({
      ...row,
      averageSalary: row.employees ? money(num(row.total) / row.employees) : 0,
      // An empty group would otherwise print Infinity as a salary.
      lowest: Number.isFinite(row.lowest) ? row.lowest : 0,
      totalCost: row.ctc,
    }))
    .sort((a, b) => num(b.totalCost) - num(a.totalCost));

// ── §10 — salary distribution ──────────────────────────────────────────────

export const salaryBandRows = ({ rows = [], bands = null } = {}) => {
  const list = Array.isArray(bands) && bands.length ? bands : SALARY_BANDS;
  const seeded = list.map((band) => ({
    key: band.key,
    label: band.label,
    employees: 0,
    payroll: 0,
    netPayroll: 0,
  }));
  const index = new Map(seeded.map((row) => [row.key, row]));

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const band = bandOf(row.gross, list);
    const target = index.get(band.key);
    if (!target) return;
    target.employees += 1;
    target.payroll = money(target.payroll + num(row.gross));
    target.netPayroll = money(target.netPayroll + num(row.net));
  });

  const total = seeded.reduce((sum, row) => sum + row.employees, 0);
  return seeded.map((row) => ({
    ...row,
    sharePercent: total ? money((row.employees / total) * 100) : 0,
  }));
};

// ── §9 — headcount & cost ──────────────────────────────────────────────────

/**
 * §9 — joins payroll cost to the HR facts. `activeEmployees`, `joined` and
 * `exited` come from the HR side (User / Resignation / settlement), while the
 * cost figures come from the snapshots. They are deliberately kept in
 * separate fields: headcount is a headcount, cost is cost.
 */
export const headcountMetrics = ({
  rows = [],
  // §29 — the aggregation path supplies the roll-up it computed in MongoDB;
  // the row path supplies rows and lets this function do the arithmetic.
  summary = null,
  previousSummary = null,
  activeEmployees = 0,
  joined = 0,
  exited = 0,
  previousRows = [],
} = {}) => {
  const now = summary || summariseRows({ rows });
  const before = previousSummary || summariseRows({ rows: previousRows });
  const costNow = num(now.totalPayrollCost);
  const costBefore = num(before.totalPayrollCost);

  return {
    activeEmployees,
    joinedThisMonth: joined,
    exitedThisMonth: exited,
    netHeadcountChange: joined - exited,
    employeesPaid: now.employeesPaid,
    payrollCost: costNow,
    previousPayrollCost: costBefore,
    payrollCostIncrease: money(costNow - costBefore),
    payrollCostIncreasePercent: costBefore ? money(((costNow - costBefore) / costBefore) * 100) : 0,
    averageCostPerEmployee: activeEmployees ? money(costNow / activeEmployees) : 0,
    averageCostPerPaidEmployee: now.employeesPaid ? money(costNow / now.employeesPaid) : 0,
  };
};

// ── §11 — trends ───────────────────────────────────────────────────────────

/**
 * §11 — "Do not recalculate old payroll. Use historical snapshots only."
 * Each bucket is the roll-up of the snapshots that fall in it, so a quarterly
 * figure is the sum of three monthly ones rather than a fresh aggregation.
 */
export const trendRows = ({ rows = [], period = 'MONTHLY' } = {}) => {
  const key = isTrendPeriod(period) ? String(period).toUpperCase() : 'MONTHLY';
  const buckets = new Map();

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const bucket = periodKeyOf(row.month, key);
    if (!bucket) return;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(row);
  });

  return [...buckets.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([bucket, bucketRows]) => {
      const summary = summariseRows({ rows: bucketRows });
      return {
        key: bucket,
        label: periodLabelOf(bucket, key),
        months: [...new Set(bucketRows.map((row) => row.month))].sort(),
        employeesPaid: summary.employeesPaid,
        grossPayroll: summary.grossSalary,
        netSalary: summary.netSalary,
        employerContribution: summary.employerContribution,
        bonus: summary.bonusTotal,
        overtime: summary.overtimeTotal,
        totalPayrollCost: summary.totalPayrollCost,
      };
    });
};

export const trendSeries = ({ rows = [], period = 'MONTHLY' } = {}) => {
  const trend = trendRows({ rows, period });
  const series = (pick) => trend.map((row) => ({ label: row.label, value: pick(row) }));

  return {
    period: isTrendPeriod(period) ? String(period).toUpperCase() : 'MONTHLY',
    rows: trend,
    grossPayroll: series((row) => row.grossPayroll),
    netSalary: series((row) => row.netSalary),
    employerContribution: series((row) => row.employerContribution),
    bonus: series((row) => row.bonus),
    overtime: series((row) => row.overtime),
  };
};

// ── §12 — bonus & incentive ────────────────────────────────────────────────

export const bonusRows = ({ rows = [] } = {}) =>
  (Array.isArray(rows) ? rows : [])
    .filter((row) => num(row.bonus) > 0 || num(row.variableEarnings) > 0)
    .map((row) => ({
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      department: row.department,
      designation: row.designation,
      month: row.month,
      bonus: num(row.bonus),
      otherVariable: num(row.otherVariable),
      variableEarnings: num(row.variableEarnings),
      overtime: num(row.overtime),
      reimbursements: num(row.reimbursements),
      net: num(row.net),
      // Everything beyond fixed pay: variable earnings, engine overtime and
      // reimbursements. Bonus sits inside variable earnings, so it is not
      // added twice.
      totalVariable: money(num(row.variableEarnings) + num(row.overtime) + num(row.reimbursements)),
    }))
    .sort((a, b) => num(b.totalVariable) - num(a.totalVariable));

// ── §13 — overtime ─────────────────────────────────────────────────────────

export const overtimeRows = ({ rows = [] } = {}) =>
  (Array.isArray(rows) ? rows : [])
    // §13 — "Read data from Attendance and Payroll snapshots. Do not
    // calculate OT here." No hours means no row; the cost stays whatever the
    // engine already priced.
    .filter((row) => num(row.otHours) > 0 || num(row.overtime) > 0)
    .map((row) => ({
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      department: row.department,
      designation: row.designation,
      month: row.month,
      otHours: num(row.otHours),
      overtimeCost: num(row.overtime),
      costPerHour: num(row.otHours) > 0 ? money(num(row.overtime) / num(row.otHours)) : 0,
    }))
    // §13 — "Employee OT Ranking": highest utilisation first.
    .sort((a, b) => num(b.otHours) - num(a.otHours) || num(b.overtimeCost) - num(a.overtimeCost));

export const overtimeByDepartment = ({ rows = [] } = {}) =>
  groupRows(
    rows.filter((row) => num(row.otHours) > 0 || num(row.overtime) > 0),
    (row) => row.department || 'Unassigned',
    (key) => ({ department: key, employees: 0, otHours: 0, overtimeCost: 0 }),
    (acc, row) => ({
      department: acc.department,
      employees: acc.employees + 1,
      otHours: money(acc.otHours + num(row.otHours)),
      overtimeCost: money(acc.overtimeCost + num(row.overtime)),
    }),
  ).sort((a, b) => num(b.overtimeCost) - num(a.overtimeCost));

// ── §14 — leave impact ─────────────────────────────────────────────────────

/**
 * §14 — the payroll cost of leave. The LOP deduction is what the month's
 * salary LOST because of leave without pay; the paid-leave cost is what the
 * company paid for days not worked. Both are derived from the daily rate the
 * snapshot implies — and both are labelled as derived, because the engine
 * stores the days, not the rupees.
 */
export const leaveImpactRows = ({ rows = [] } = {}) => {
  const list = Array.isArray(rows) ? rows : [];

  const perRow = list.map((row) => {
    // The engine deducts LOP from the structure earnings, not from the month's
    // total, so the daily rate has to come from the same base or §14 overstates
    // the cost of a lost day for anyone with overtime or variable pay.
    const dailyRate = num(row.workingDays) > 0 ? num(row.fixedGross ?? row.gross) / num(row.workingDays) : 0;
    return {
      ...row,
      dailyRate: money(dailyRate),
      lopDeduction: money(dailyRate * num(row.lopDays)),
      paidLeaveCost: money(dailyRate * num(row.paidLeaveDays)),
    };
  });

  const total = perRow.reduce(
    (acc, row) => ({
      lopDays: money(acc.lopDays + num(row.lopDays)),
      paidLeaveDays: money(acc.paidLeaveDays + num(row.paidLeaveDays)),
      lopDeduction: money(acc.lopDeduction + num(row.lopDeduction)),
      paidLeaveCost: money(acc.paidLeaveCost + num(row.paidLeaveCost)),
    }),
    { lopDays: 0, paidLeaveDays: 0, lopDeduction: 0, paidLeaveCost: 0 },
  );

  return {
    ...total,
    // The figures are derived from the daily rate, so say so on the report
    // rather than presenting them as if the engine had stored them.
    derived: true,
    rows: perRow
      .filter((row) => num(row.lopDays) > 0 || num(row.paidLeaveDays) > 0)
      .map((row) => ({
        employeeId: row.employeeId,
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        department: row.department,
        lopDays: num(row.lopDays),
        paidLeaveDays: num(row.paidLeaveDays),
        dailyRate: row.dailyRate,
        lopDeduction: row.lopDeduction,
        paidLeaveCost: row.paidLeaveCost,
      }))
      .sort((a, b) => num(b.lopDeduction) - num(a.lopDeduction)),
    byDepartment: groupRows(
      perRow,
      (row) => row.department || 'Unassigned',
      (key) => ({ department: key, employees: 0, lopDays: 0, paidLeaveDays: 0, lopDeduction: 0, paidLeaveCost: 0 }),
      (acc, row) => ({
        department: acc.department,
        employees: acc.employees + 1,
        lopDays: money(acc.lopDays + num(row.lopDays)),
        paidLeaveDays: money(acc.paidLeaveDays + num(row.paidLeaveDays)),
        lopDeduction: money(acc.lopDeduction + num(row.lopDeduction)),
        paidLeaveCost: money(acc.paidLeaveCost + num(row.paidLeaveCost)),
      }),
    ).sort((a, b) => num(b.lopDeduction) - num(a.lopDeduction)),
  };
};

// ── §15 / §16 — statutory liability and CTC ────────────────────────────────

/**
 * §15 — the consolidated statutory liability. 29.10's roll-up is reused
 * verbatim (so the two modules cannot disagree about what PF employer means)
 * and this adds the one thing 29.10 never needed: a single total, plus the
 * bucket table the report and the export both render.
 */
export const statutoryLiability = ({ rows = [] } = {}) => {
  const rollup = summariseStatutoryRows({ rows: (Array.isArray(rows) ? rows : []).map((row) => row.statutory) });

  const buckets = [
    { key: 'PF', label: 'Provident Fund', employee: rollup.pf.employee, employer: rollup.pf.employer },
    { key: 'ESI', label: 'ESI', employee: rollup.esi.employee, employer: rollup.esi.employer },
    // PT and TDS are remitted on the employee's behalf; there is no employer
    // share, which is exactly what the report has to show.
    { key: 'PT', label: 'Professional Tax', employee: rollup.pt.total, employer: 0 },
    { key: 'TDS', label: 'TDS', employee: rollup.tds.total, employer: 0 },
    { key: 'LWF', label: 'Labour Welfare Fund', employee: rollup.lwf.employee, employer: rollup.lwf.employer },
  ].map((bucket) => ({ ...bucket, total: money(num(bucket.employee) + num(bucket.employer)) }));

  const employerTotal = money(buckets.reduce((total, bucket) => total + num(bucket.employer), 0));
  const employeeTotal = money(buckets.reduce((total, bucket) => total + num(bucket.employee), 0));

  return {
    ...rollup,
    buckets,
    totals: {
      employee: employeeTotal,
      employer: employerTotal,
      totalLiability: money(employeeTotal + employerTotal),
      // §15 — the gratuity provision is a liability the company carries but
      // does not remit, so it is reported alongside, never inside, the total.
      gratuityProvision: money(rollup.gratuity?.monthly ?? 0),
      gratuityAnnualised: money(rollup.gratuity?.annualised ?? 0),
      byState: rollup.pt?.byState || [],
      byDepartment: rollup.tds?.byDepartment || [],
    },
  };
};

export const ctcRows = ({ rows = [] } = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const summary = summariseRows({ rows: list });

  // §16 — every bucket is read from the statutory block the engine froze, so
  // the CTC report is a restatement of the snapshot and never an estimate.
  const pf = money(list.reduce((total, row) => total + num(row.statutory?.pf?.employer), 0));
  const esi = money(list.reduce((total, row) => total + num(row.statutory?.esi?.employer), 0));
  const lwf = money(list.reduce((total, row) => total + num(row.statutory?.lwf?.employer), 0));
  const gratuity = money(list.reduce((total, row) => total + num(row.statutory?.gratuity?.amount), 0));

  const buckets = [
    { key: 'GROSS', label: 'Gross Salary', amount: summary.grossSalary },
    { key: 'PF', label: 'Employer PF', amount: pf },
    { key: 'ESI', label: 'Employer ESI', amount: esi },
    { key: 'LWF', label: 'Employer LWF', amount: lwf },
    { key: 'GRATUITY', label: 'Gratuity Provision', amount: gratuity },
  ];

  const identified = buckets.reduce((total, bucket) => total + num(bucket.amount), 0);
  // §16 — "Other Employer Benefits" is whatever the snapshot contributed
  // beyond PF / ESI / LWF / gratuity, so the total always ties to the CTC.
  const other = money(num(summary.employerContribution) - (pf + esi + lwf + gratuity));

  return {
    buckets: [...buckets, { key: 'OTHER', label: 'Other Employer Benefits', amount: other }],
    grossSalary: summary.grossSalary,
    employerPf: pf,
    employerEsi: esi,
    employerLwf: lwf,
    gratuity,
    otherEmployerBenefits: other,
    employerContribution: summary.employerContribution,
    totalCompanyPayrollCost: money(num(summary.grossSalary) + num(summary.employerContribution)),
    // A negative "other" means the buckets do not add up — say so instead of
    // quietly printing a number nobody can reconcile.
    reconciled: money(identified - num(summary.employerContribution)) === 0 || other >= 0,
  };
};

// ══ 29.13 — earnings, deductions, employer, reimbursements, F&F, variance ════

const distinctEmployees = (rows = []) =>
  new Set((Array.isArray(rows) ? rows : []).map((row) => String(row.employeeId || '')).filter(Boolean)).size;

// ── §11 — earnings by component ────────────────────────────────────────────

const EARNINGS_CATEGORY_LABELS = Object.freeze({
  FIXED: 'Fixed earnings',
  VARIABLE: 'Variable earnings',
  OVERTIME: 'Overtime',
  REIMBURSEMENT: 'Reimbursements',
});

/**
 * §11 — earnings grouped by the component that produced them.
 *
 * The codes are whatever 29.2 / 29.5 / 29.6 stored, so a company that adds a
 * component next year sees it here without this file changing — the brief's
 * "do not hard-code only Basic/HRA/etc" is a property of reading the lines,
 * not of a longer list of names.
 */
export const earningsRows = ({ rows = [] } = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const buckets = new Map();

  const add = ({ key, label, category, kind, amount, employeeId }) => {
    if (!num(amount)) return;
    const bucket = buckets.get(key) || {
      key, label, category, kind, employees: new Set(), amount: 0,
    };
    bucket.amount = money(bucket.amount + num(amount));
    if (employeeId) bucket.employees.add(String(employeeId));
    buckets.set(key, bucket);
  };

  list.forEach((row) => {
    (row.lines?.earnings || []).forEach((line) =>
      add({
        key: `FIXED:${line.code}`,
        label: line.name || humanise(line.code),
        category: 'FIXED',
        kind: line.code,
        amount: line.amount,
        employeeId: row.employeeId,
      }));

    (row.lines?.variableEarnings || []).forEach((line) => {
      // §12 — the same vocabulary the bonus report uses, so the two reports
      // cannot disagree about what counts as a bonus.
      const kind = line.code === 'INCENTIVE'
        ? 'INCENTIVE'
        : line.code === 'COMMISSION_SALES'
          ? 'COMMISSION'
          : isBonusEntry(line.code)
            ? 'BONUS'
            : 'OTHER_VARIABLE';
      add({
        key: `VARIABLE:${line.code}`,
        label: ENTRY_TYPE_LABELS[line.code] || line.name || humanise(line.code),
        category: 'VARIABLE',
        kind,
        amount: line.amount,
        employeeId: row.employeeId,
      });
    });

    (row.lines?.reimbursements || []).forEach((line) =>
      add({
        key: `REIMBURSEMENT:${line.code}`,
        label: ENTRY_TYPE_LABELS[line.code] || line.name || humanise(line.code),
        category: 'REIMBURSEMENT',
        kind: line.code,
        amount: line.amount,
        employeeId: row.employeeId,
      }));

    // Overtime is priced by the engine and stored as a total, not as a line,
    // so it is reported as its own bucket rather than being left out.
    add({
      key: 'OVERTIME:OVERTIME',
      label: 'Overtime',
      category: 'OVERTIME',
      kind: 'OVERTIME',
      amount: row.overtime,
      employeeId: row.employeeId,
    });
  });

  const rowsOut = [...buckets.values()]
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      category: bucket.category,
      categoryLabel: EARNINGS_CATEGORY_LABELS[bucket.category] || bucket.category,
      kind: bucket.kind,
      employees: bucket.employees.size,
      amount: bucket.amount,
    }))
    .sort((a, b) => num(b.amount) - num(a.amount));

  const byCategory = (category) =>
    money(rowsOut.filter((row) => row.category === category).reduce((total, row) => total + num(row.amount), 0));
  const byKind = (kinds = []) =>
    money(rowsOut.filter((row) => kinds.includes(row.kind)).reduce((total, row) => total + num(row.amount), 0));

  const grossPayroll = money(list.reduce((total, row) => total + num(row.gross), 0));
  const fixed = byCategory('FIXED');
  const variable = byCategory('VARIABLE');
  const overtime = byCategory('OVERTIME');
  const reimbursements = byCategory('REIMBURSEMENT');

  return {
    rows: rowsOut,
    totals: {
      grossPayroll,
      fixedEarnings: fixed,
      variableEarnings: variable,
      bonus: byKind(['BONUS']),
      incentive: byKind(['INCENTIVE']),
      commission: byKind(['COMMISSION']),
      otherVariable: byKind(['OTHER_VARIABLE']),
      overtime,
      reimbursements,
      total: money(fixed + variable + overtime + reimbursements),
      // The buckets must add up to the earnings the company paid. If they do
      // not, the report says so instead of printing a total nobody can tie.
      reconciled: money(fixed + variable + overtime) === grossPayroll,
    },
  };
};

// ── §12 / §13 — deductions and employer contributions ──────────────────────

const DEDUCTION_KIND_LABELS = Object.freeze({
  PF: 'Provident Fund',
  ESI: 'ESI',
  PT: 'Professional Tax',
  TDS: 'TDS',
  LWF: 'Labour Welfare Fund',
  LOP: 'Loss of Pay',
  GRATUITY: 'Gratuity',
  OTHER: 'Other Deductions',
});

/**
 * 29.6 already owns the code→statutory-kind mapping (a component called
 * "Provident Fund" and one called EPF are the same thing to the engine), so
 * the deduction report reuses it rather than restating it here.
 */
const deductionKindOf = (line = {}) => {
  if (String(line.code || '').toUpperCase() === 'LOP') return 'LOP';
  return statutoryKindOf(line.code, line.name) || 'OTHER';
};

export const deductionRows = ({ rows = [] } = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const byKind = new Map();
  const byCode = new Map();

  const bump = (map, key, label, amount, employeeId, extra = {}) => {
    const bucket = map.get(key) || { key, label, employees: new Set(), amount: 0, ...extra };
    bucket.amount = money(bucket.amount + num(amount));
    if (employeeId) bucket.employees.add(String(employeeId));
    map.set(key, bucket);
  };

  list.forEach((row) => {
    (row.lines?.deductions || []).forEach((line) => {
      if (!num(line.amount)) return;
      const kind = deductionKindOf(line);
      bump(byKind, kind, DEDUCTION_KIND_LABELS[kind] || kind, line.amount, row.employeeId);
      bump(byCode, line.code, line.name || humanise(line.code), line.amount, row.employeeId, { kind });
    });
  });

  const grossPayroll = money(list.reduce((total, row) => total + num(row.gross), 0));
  const totalDeductions = money([...byKind.values()].reduce((total, bucket) => total + num(bucket.amount), 0));
  const percent = (amount) => (grossPayroll ? money((num(amount) / grossPayroll) * 100) : 0);

  const finish = (bucket) => ({ ...bucket, employees: bucket.employees.size, percentOfGross: percent(bucket.amount) });

  return {
    rows: [...byKind.values()].map(finish).sort((a, b) => num(b.amount) - num(a.amount)),
    components: [...byCode.values()].map(finish).sort((a, b) => num(b.amount) - num(a.amount)),
    totals: {
      totalDeductions,
      // Reported from the snapshot's own total, not from the lines: a company
      // that stores a deduction without a line would otherwise be understated.
      snapshotTotal: money(list.reduce((total, row) => total + num(row.totalDeductions), 0)),
      statutoryTotal: money(
        [...byKind.entries()]
          .filter(([key]) => ['PF', 'ESI', 'PT', 'TDS', 'LWF'].includes(key))
          .reduce((total, [, bucket]) => total + num(bucket.amount), 0),
      ),
      lopTotal: num(byKind.get('LOP')?.amount || 0),
      otherTotal: num(byKind.get('OTHER')?.amount || 0),
      grossPayroll,
      percentOfGross: percent(totalDeductions),
    },
  };
};

export const employerContributionRows = ({ rows = [] } = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const buckets = new Map();

  list.forEach((row) => {
    (row.lines?.employerContributions || []).forEach((line) => {
      if (!num(line.amount)) return;
      const kind = statutoryKindOf(line.code, line.name) || 'OTHER';
      const key = kind === 'GRATUITY' ? 'GRATUITY' : kind;
      const bucket = buckets.get(key) || {
        key,
        label: key === 'OTHER' ? 'Other Employer Contributions' : DEDUCTION_KIND_LABELS[key] || key,
        employees: new Set(),
        amount: 0,
      };
      bucket.amount = money(bucket.amount + num(line.amount));
      bucket.employees.add(String(row.employeeId));
      buckets.set(key, bucket);
    });
  });

  const total = money([...buckets.values()].reduce((sum, bucket) => sum + num(bucket.amount), 0));
  const snapshotTotal = money(list.reduce((sum, row) => sum + num(row.employerCost), 0));

  return {
    rows: [...buckets.values()]
      .map((bucket) => ({ ...bucket, employees: bucket.employees.size }))
      .sort((a, b) => num(b.amount) - num(a.amount)),
    total,
    // The lines and the engine's own total must agree. When a company's
    // structure contributes something without a line, the difference is shown
    // rather than hidden inside "other".
    snapshotTotal,
    unclassified: money(snapshotTotal - total),
    byDepartment: groupRows(
      list,
      (row) => row.department || 'Unassigned',
      (key) => ({ department: key, employees: 0, employerCost: 0 }),
      (acc, row) => ({
        department: acc.department,
        employees: acc.employees + 1,
        employerCost: money(acc.employerCost + num(row.employerCost)),
      }),
    ).sort((a, b) => num(b.employerCost) - num(a.employerCost)),
  };
};

// ── §18 — reimbursements ───────────────────────────────────────────────────

export const reimbursementRows = ({ rows = [] } = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const withClaims = list.filter((row) => num(row.reimbursements) > 0 || (row.lines?.reimbursements || []).length);

  const byCategory = new Map();
  withClaims.forEach((row) => {
    (row.lines?.reimbursements || []).forEach((line) => {
      if (!num(line.amount)) return;
      const bucket = byCategory.get(line.code) || {
        key: line.code,
        label: ENTRY_TYPE_LABELS[line.code] || line.name || humanise(line.code),
        employees: new Set(),
        amount: 0,
      };
      bucket.amount = money(bucket.amount + num(line.amount));
      bucket.employees.add(String(row.employeeId));
      byCategory.set(line.code, bucket);
    });
  });

  const total = money(withClaims.reduce((sum, row) => sum + num(row.reimbursements), 0));
  const categories = [...byCategory.values()].map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    employees: bucket.employees.size,
    amount: bucket.amount,
    sharePercent: total ? money((num(bucket.amount) / total) * 100) : 0,
  })).sort((a, b) => num(b.amount) - num(a.amount));

  return {
    total,
    employees: distinctEmployees(withClaims),
    categories,
    byDepartment: groupRows(
      withClaims,
      (row) => row.department || 'Unassigned',
      (key) => ({ department: key, employees: 0, reimbursements: 0 }),
      (acc, row) => ({
        department: acc.department,
        employees: acc.employees + 1,
        reimbursements: money(acc.reimbursements + num(row.reimbursements)),
      }),
    ).sort((a, b) => num(b.reimbursements) - num(a.reimbursements)),
    byMonth: groupRows(
      withClaims,
      (row) => row.month || '',
      (key) => ({ month: key, label: monthLabel(key), employees: 0, reimbursements: 0 }),
      (acc, row) => ({
        month: acc.month,
        label: acc.label,
        employees: acc.employees + 1,
        reimbursements: money(acc.reimbursements + num(row.reimbursements)),
      }),
    ).sort((a, b) => String(a.month).localeCompare(String(b.month))),
    rows: withClaims
      .map((row) => ({
        employeeId: row.employeeId,
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        department: row.department,
        designation: row.designation,
        month: row.month,
        reimbursements: num(row.reimbursements),
        categories: (row.lines?.reimbursements || [])
          .filter((line) => num(line.amount))
          .map((line) => ({ code: line.code, label: ENTRY_TYPE_LABELS[line.code] || line.name, amount: num(line.amount) })),
      }))
      .sort((a, b) => num(b.reimbursements) - num(a.reimbursements)),
  };
};

// ── §20 — F&F settlements ──────────────────────────────────────────────────

const settlementAmount = (row = {}, path = '') => {
  const value = String(path).split('.').reduce((node, key) => (node == null ? undefined : node[key]), row);
  return num(value);
};

/**
 * §20 — F&F analytics, read from the FINALISED settlement records.
 *
 * Nothing here recalculates a settlement: 29.11 owns that arithmetic and its
 * result is the only number that was ever paid. A draft is reported as a
 * draft, never as money.
 */
export const fnfRows = ({ settlements = [] } = {}) => {
  const list = Array.isArray(settlements) ? settlements : [];

  const rowsOut = list.map((row) => {
    const items = Array.isArray(row?.recoveries?.items) ? row.recoveries.items : [];
    const otherRecoveries = money(items.reduce((total, item) => total + num(item?.amount), 0));
    return {
      settlementNumber: row?.settlementNumber || '',
      employeeId: String(row?.exit?.employeeId || ''),
      employeeName: row?.employeeName || '',
      month: row?.month || '',
      status: row?.status || '',
      lastWorkingDate: row?.exit?.lastWorkingDate || '',
      netSettlement: num(row?.totals?.netSettlement),
      pendingSalary: settlementAmount(row, 'earnings.pendingSalary.amount'),
      leaveEncashment: settlementAmount(row, 'earnings.leaveEncashment.amount'),
      noticeRecovery: settlementAmount(row, 'recoveries.notice.amount'),
      otherRecoveries,
      paidAt: row?.payment?.paidAt || '',
    };
  }).sort((a, b) => String(b.month).localeCompare(String(a.month)));

  const sum = (pick) => money(rowsOut.reduce((total, row) => total + num(pick(row)), 0));
  const CLOSED_STATUSES = ['PAID', 'CLOSED'];

  const byStatus = groupRows(
    rowsOut,
    (row) => row.status || 'DRAFT',
    (key) => ({ status: key, count: 0, netSettlement: 0 }),
    (acc, row) => ({
      status: acc.status,
      count: acc.count + 1,
      netSettlement: money(acc.netSettlement + num(row.netSettlement)),
    }),
  ).sort((a, b) => b.count - a.count);

  const pending = rowsOut.filter((row) => !CLOSED_STATUSES.includes(String(row.status).toUpperCase()));

  return {
    count: rowsOut.length,
    byStatus,
    pending: { count: pending.length, netSettlement: money(pending.reduce((total, row) => total + num(row.netSettlement), 0)) },
    completed: {
      count: rowsOut.length - pending.length,
      netSettlement: money(
        rowsOut.filter((row) => CLOSED_STATUSES.includes(String(row.status).toUpperCase()))
          .reduce((total, row) => total + num(row.netSettlement), 0),
      ),
    },
    totals: {
      netSettlement: sum((row) => row.netSettlement),
      pendingSalary: sum((row) => row.pendingSalary),
      leaveEncashment: sum((row) => row.leaveEncashment),
      noticeRecovery: sum((row) => row.noticeRecovery),
      otherRecoveries: sum((row) => row.otherRecoveries),
      recoveriesTotal: money(
        sum((row) => row.noticeRecovery) + sum((row) => row.otherRecoveries),
      ),
    },
    byMonth: groupRows(
      rowsOut,
      (row) => row.month || 'Unassigned',
      (key) => ({
        month: key, label: monthLabel(key), count: 0,
        netSettlement: 0, leaveEncashment: 0, noticeRecovery: 0, otherRecoveries: 0,
      }),
      (acc, row) => ({
        month: acc.month,
        label: acc.label,
        count: acc.count + 1,
        netSettlement: money(acc.netSettlement + num(row.netSettlement)),
        leaveEncashment: money(acc.leaveEncashment + num(row.leaveEncashment)),
        noticeRecovery: money(acc.noticeRecovery + num(row.noticeRecovery)),
        otherRecoveries: money(acc.otherRecoveries + num(row.otherRecoveries)),
      }),
    ).sort((a, b) => String(a.month).localeCompare(String(b.month))),
    rows: rowsOut,
  };
};

// ── §21 — payroll variance ─────────────────────────────────────────────────

/** Under half a percent the trend is called stable: rounding, not a movement. */
export const STABLE_THRESHOLD_PERCENT = 0.5;

export const directionOf = (difference = 0, changePercent = 0) => {
  if (Math.abs(Number(changePercent) || 0) < STABLE_THRESHOLD_PERCENT) return 'STABLE';
  return num(difference) > 0 ? 'INCREASING' : 'DECREASING';
};

const varianceLine = ({ key, label, previous = 0, current = 0 }) => {
  const before = num(previous);
  const after = num(current);
  const difference = money(after - before);
  const changePercent = before ? money(((after - before) / before) * 100) : after ? 100 : 0;
  return {
    key,
    label,
    previous: money(before),
    current: money(after),
    difference,
    changePercent,
    direction: directionOf(difference, changePercent),
  };
};

/**
 * §21 — current period against the previous one, line by line.
 *
 * "The system should identify the numerical difference" — the difference and
 * the percentage are computed, never inferred from a chart. No prediction is
 * made here and none is implied: this is arithmetic on two closed periods.
 */
export const varianceRows = ({ rows = [], previousRows = [] } = {}) => {
  const now = summariseRows({ rows });
  const before = summariseRows({ rows: previousRows });
  const statutoryNow = statutoryLiability({ rows });
  const statutoryBefore = statutoryLiability({ rows: previousRows });

  const lines = [
    varianceLine({ key: 'HEADCOUNT', label: 'Employees Paid', previous: before.employeesPaid, current: now.employeesPaid }),
    varianceLine({ key: 'GROSS', label: 'Gross Payroll', previous: before.grossSalary, current: now.grossSalary }),
    varianceLine({ key: 'NET', label: 'Net Payroll', previous: before.netSalary, current: now.netSalary }),
    varianceLine({ key: 'DEDUCTIONS', label: 'Employee Deductions', previous: before.deductionsTotal, current: now.deductionsTotal }),
    varianceLine({ key: 'EMPLOYER', label: 'Employer Cost', previous: before.employerContribution, current: now.employerContribution }),
    varianceLine({ key: 'TOTAL_COST', label: 'Total Payroll Cost', previous: before.totalPayrollCost, current: now.totalPayrollCost }),
    varianceLine({ key: 'AVERAGE_SALARY', label: 'Average Salary', previous: before.averageSalary, current: now.averageSalary }),
    varianceLine({ key: 'BONUS', label: 'Bonus', previous: before.bonusTotal, current: now.bonusTotal }),
    varianceLine({ key: 'VARIABLE', label: 'Variable Pay', previous: before.variableTotal, current: now.variableTotal }),
    varianceLine({ key: 'OVERTIME', label: 'Overtime Cost', previous: before.overtimeTotal, current: now.overtimeTotal }),
    varianceLine({ key: 'OVERTIME_HOURS', label: 'Overtime Hours', previous: before.overtimeHours, current: now.overtimeHours }),
    varianceLine({ key: 'REIMBURSEMENTS', label: 'Reimbursements', previous: before.reimbursements, current: now.reimbursements }),
    varianceLine({ key: 'LOP_DAYS', label: 'LOP Days', previous: before.lopDays, current: now.lopDays }),
    varianceLine({
      key: 'STATUTORY',
      label: 'Statutory Liability',
      previous: statutoryBefore.totals?.totalLiability ?? 0,
      current: statutoryNow.totals?.totalLiability ?? 0,
    }),
  ];

  return {
    rows: lines,
    current: { ...now, statutoryLiability: statutoryNow.totals?.totalLiability ?? 0 },
    previous: { ...before, statutoryLiability: statutoryBefore.totals?.totalLiability ?? 0 },
    // §5 — the headline direction, off the same numbers the cards show.
    direction: directionOf(
      money(num(now.totalPayrollCost) - num(before.totalPayrollCost)),
      num(before.totalPayrollCost)
        ? money(((num(now.totalPayrollCost) - num(before.totalPayrollCost)) / num(before.totalPayrollCost)) * 100)
        : 0,
    ),
  };
};

/**
 * §9 — WHY the payroll cost moved.
 *
 * A single "cost is up 8%" tells a CFO nothing they can act on. The change is
 * split three ways, and the three parts add up to the whole exactly:
 *
 *   headcount    what the joiners cost, less what the leavers cost
 *   likeForLike  what the people who were here both months cost more/less
 *   variable     the part of like-for-like that is bonus, OT, reimbursements
 *                and other variable pay rather than fixed salary
 */
export const costMovement = ({ rows = [], previousRows = [] } = {}) => {
  const current = new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row.employeeId), row]));
  const previous = new Map((Array.isArray(previousRows) ? previousRows : []).map((row) => [String(row.employeeId), row]));

  const ids = [...new Set([...current.keys(), ...previous.keys()])];
  let joiners = 0;
  let leavers = 0;
  let stayers = 0;
  let headcountEffect = 0;
  let likeForLikeEffect = 0;
  let fixedEffect = 0;
  let variableEffect = 0;

  const variableOf = (row) =>
    num(row?.variableEarnings) + num(row?.overtime) + num(row?.reimbursements);

  ids.forEach((id) => {
    const now = current.get(id) || null;
    const before = previous.get(id) || null;

    if (now && !before) {
      joiners += 1;
      headcountEffect += num(now.gross);
      return;
    }
    if (!now && before) {
      leavers += 1;
      headcountEffect -= num(before.gross);
      return;
    }
    stayers += 1;
    const delta = num(now.gross) - num(before.gross);
    likeForLikeEffect += delta;
    const variableDelta = variableOf(now) - variableOf(before);
    variableEffect += variableDelta;
    fixedEffect += delta - variableDelta;
  });

  const total = money(headcountEffect + likeForLikeEffect);

  return {
    joiners,
    leavers,
    stayers,
    total,
    headcountEffect: money(headcountEffect),
    likeForLikeEffect: money(likeForLikeEffect),
    fixedEffect: money(fixedEffect),
    variableEffect: money(variableEffect),
    // The decomposition is only trustworthy if it adds up — say so, so a
    // reader never has to take the split on faith.
    reconciled: total === money(
      num(summariseRows({ rows }).grossSalary) - num(summariseRows({ rows: previousRows }).grossSalary),
    ),
  };
};

// ── §17 — the payroll register ─────────────────────────────────────────────

export const REGISTER_HEADERS = [
  'Employee ID',
  'Employee Name',
  'Department',
  'Designation',
  'Payroll Period',
  'Basic',
  'Gross',
  'Total Earnings',
  'Total Deductions',
  'Employer Cost',
  'Net Salary',
  'Payment Status',
  'Payroll Status',
];

export const registerRows = ({ rows = [] } = {}) =>
  (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((a, b) => String(a.employeeCode || '').localeCompare(String(b.employeeCode || '')))
    .map((row) => [
      row.employeeCode || '',
      row.employeeName || '',
      row.department || '',
      row.designation || '',
      row.month || '',
      money(row.basic),
      money(row.gross),
      money(row.totalEarnings),
      money(row.totalDeductions),
      money(row.employerCost),
      money(row.net),
      row.paymentStatus || 'NOT_IN_BATCH',
      // Every row in the register is a CALCULATED snapshot — 29.12 reads no
      // other kind — so this column is a statement about the register's own
      // scope rather than a per-row fact.
      row.payrollStatus || 'CALCULATED',
    ]);

// ── export tables for every report (§19) ───────────────────────────────────

/**
 * §6 — the overview summary's keys, in the order they read best, as the words
 * they should be printed as. `humanise` covers any key added later, so a new
 * metric can never leak its camelCase name into a spreadsheet again.
 */
const OVERVIEW_LABELS = {
  employeesPaid: 'Employees Paid',
  grossSalary: 'Gross Salary',
  netSalary: 'Net Salary Paid',
  earningsTotal: 'Total Earnings',
  deductionsTotal: 'Total Deductions',
  employerContribution: 'Employer Contribution',
  ctc: 'Total CTC',
  totalPayrollCost: 'Total Payroll Cost',
  averageSalary: 'Average Salary',
  averageCtc: 'Average CTC',
  bonusTotal: 'Total Bonus',
  variableTotal: 'Total Variable Pay',
  overtimeTotal: 'Overtime Cost',
  overtimeHours: 'Overtime Hours',
  reimbursements: 'Reimbursements',
  lopDays: 'Loss of Pay Days',
  paidLeaveDays: 'Paid Leave Days',
  finalSettlements: 'Final Settlements',
  payrollAccuracy: 'Payroll Accuracy %',
  statutoryLiability: 'Total Statutory Liability',
  totalStatutoryLiability: 'Total Statutory Liability',
};

const humanise = (key = '') =>
  String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());

export const reportTable = ({ reportKey = '', payload = {} } = {}) => {
  const key = String(reportKey || '').toUpperCase();

  switch (key) {
    case 'DEPARTMENT':
      return {
        headers: ['Department', 'Employees', 'Gross Salary', 'Net Salary', 'Employer Cost', 'Total Cost', 'Average Salary'],
        rows: (payload.rows || []).map((row) => [
          row.department, row.employees, money(row.gross), money(row.net),
          money(row.employerCost), money(row.totalCost), money(row.averageSalary),
        ]),
      };
    case 'DESIGNATION':
      return {
        headers: ['Designation', 'Employees', 'Average Salary', 'Highest Salary', 'Lowest Salary', 'Total Cost'],
        rows: (payload.rows || []).map((row) => [
          row.designation, row.employees, money(row.averageSalary),
          money(row.highest), money(row.lowest), money(row.totalCost),
        ]),
      };
    case 'SALARY_BANDS':
      return {
        headers: ['Salary Band', 'Employees', 'Share %', 'Gross Payroll', 'Net Payroll'],
        rows: (payload.rows || []).map((row) => [
          row.label, row.employees, row.sharePercent, money(row.payroll), money(row.netPayroll),
        ]),
      };
    case 'TREND':
      return {
        headers: ['Period', 'Employees Paid', 'Gross Payroll', 'Net Salary', 'Employer Contribution', 'Bonus', 'Overtime', 'Total Cost'],
        rows: (payload.rows || []).map((row) => [
          row.label, row.employeesPaid, money(row.grossPayroll), money(row.netSalary),
          money(row.employerContribution), money(row.bonus), money(row.overtime), money(row.totalPayrollCost),
        ]),
      };
    case 'BONUS':
      return {
        headers: ['Employee Code', 'Employee Name', 'Department', 'Designation', 'Bonus', 'Other Variable', 'Overtime', 'Reimbursements', 'Total Variable'],
        // Bonus + Other Variable is the whole of the variable earnings, so the
        // money columns add up to the total instead of quietly hiding an
        // adjustment that was not a bonus.
        rows: (payload.rows || []).map((row) => [
          row.employeeCode, row.employeeName, row.department, row.designation,
          money(row.bonus), money(row.otherVariable), money(row.overtime),
          money(row.reimbursements), money(row.totalVariable),
        ]),
      };
    case 'OVERTIME':
      return {
        headers: ['Employee Code', 'Employee Name', 'Department', 'OT Hours', 'OT Cost', 'Cost per Hour'],
        rows: (payload.rows || []).map((row) => [
          row.employeeCode, row.employeeName, row.department,
          row.otHours, money(row.overtimeCost), money(row.costPerHour),
        ]),
      };
    case 'LEAVE':
      return {
        headers: ['Employee Code', 'Employee Name', 'Department', 'LOP Days', 'Paid Leave Days', 'Daily Rate', 'LOP Deduction', 'Paid Leave Cost'],
        rows: (payload.rows || []).map((row) => [
          row.employeeCode, row.employeeName, row.department, row.lopDays,
          row.paidLeaveDays, money(row.dailyRate), money(row.lopDeduction), money(row.paidLeaveCost),
        ]),
      };
    case 'STATUTORY':
      return {
        headers: ['Component', 'Employee', 'Employer', 'Total'],
        rows: (payload.buckets || []).map((row) => [row.label, money(row.employee), money(row.employer), money(row.total)]),
      };
    case 'CTC':
      return {
        headers: ['Component', 'Amount'],
        rows: (payload.buckets || []).map((row) => [row.label, money(row.amount)]),
      };
    case 'REGISTER':
      return { headers: REGISTER_HEADERS, rows: registerRows({ rows: payload.rows || [] }) };
    // ── 29.13 ─────────────────────────────────────────────────────────────
    case 'EARNINGS': {
      const total = num(payload.totals?.total);
      return {
        headers: ['Component', 'Category', 'Employees', 'Amount', 'Share %'],
        rows: (payload.rows || []).map((row) => [
          row.label, row.categoryLabel, row.employees, money(row.amount),
          total ? money((num(row.amount) / total) * 100) : 0,
        ]),
      };
    }
    case 'DEDUCTIONS':
      return {
        headers: ['Deduction', 'Employees', 'Amount', '% of Gross'],
        rows: (payload.rows || []).map((row) => [
          row.label, row.employees, money(row.amount), row.percentOfGross,
        ]),
      };
    case 'EMPLOYER':
      return {
        headers: ['Contribution', 'Employees', 'Amount'],
        rows: [
          ...(payload.rows || []).map((row) => [row.label, row.employees, money(row.amount)]),
          // The unclassified remainder is printed, not folded into "other":
          // a company whose structure contributes more than its lines must be
          // able to see that on the face of the report.
          ...(num(payload.unclassified)
            ? [['Unclassified employer cost', '', money(payload.unclassified)]]
            : []),
          ['Total Employer Contribution', '', money(payload.snapshotTotal)],
        ],
      };
    case 'REIMBURSEMENT':
      return {
        headers: ['Category', 'Employees', 'Amount', 'Share %'],
        rows: (payload.categories || []).map((row) => [
          row.label, row.employees, money(row.amount), row.sharePercent,
        ]),
      };
    case 'FNF':
      return {
        headers: ['Settlement', 'Month', 'Last Working Day', 'Net Settlement', 'Leave Encashment', 'Notice Recovery', 'Other Recoveries', 'Status'],
        rows: (payload.rows || []).map((row) => [
          row.settlementNumber, row.month, row.lastWorkingDate,
          money(row.netSettlement), money(row.leaveEncashment),
          money(row.noticeRecovery), money(row.otherRecoveries), row.status,
        ]),
      };
    case 'VARIANCE':
      return {
        headers: ['Metric', 'Previous', 'Current', 'Difference', 'Change %', 'Direction'],
        rows: (payload.rows || []).map((row) => [
          row.label, money(row.previous), money(row.current),
          money(row.difference), row.changePercent,
          // A direction word, not an arrow nobody can search for.
          String(row.direction || '').toLowerCase(),
        ]),
      };
    case 'HEADCOUNT':
      return {
        headers: ['Metric', 'Value'],
        rows: [
          ['Active Employees', payload.activeEmployees ?? 0],
          ['Joined This Month', payload.joinedThisMonth ?? 0],
          ['Exited This Month', payload.exitedThisMonth ?? 0],
          ['Net Headcount Change', payload.netHeadcountChange ?? 0],
          ['Employees Paid', payload.employeesPaid ?? 0],
          ['Payroll Cost', money(payload.payrollCost)],
          ['Previous Payroll Cost', money(payload.previousPayrollCost)],
          ['Payroll Cost Increase', money(payload.payrollCostIncrease)],
          ['Payroll Cost Increase %', payload.payrollCostIncreasePercent ?? 0],
          ['Average Cost Per Employee', money(payload.averageCostPerEmployee)],
        ],
      };
    case 'OVERVIEW':
    default:
      return {
        headers: ['Metric', 'Value'],
        // §6 — the overview is a two-column metric table, and its labels have
        // to read like a report rather than like JavaScript: a file that says
        // `averageCtc,93930.6` is not finished work.
        rows: Object.entries(payload.summary || {}).map(([key, value]) => [
          OVERVIEW_LABELS[key] || humanise(key),
          value,
        ]),
      };
  }
};

export const reportFilename = ({ reportKey = '', month = '', period = '', format = 'CSV' } = {}) => {
  const key = String(reportKey || 'report').toLowerCase().replace(/_/g, '-');
  // The month wins when there is one: a file called
  // payroll-department-2026-08.csv can be filed next to September's,
  // while "...-monthly.csv" is ambiguous the moment two months exist.
  // The period is the fallback for a report that spans months.
  const suffix = month ? `-${month}` : period ? `-${String(period).toLowerCase()}` : '';
  const extension = String(format || 'CSV').toLowerCase();
  return `payroll-${key}${suffix}.${extension}`;
};

// ── §18 — filters ──────────────────────────────────────────────────────────

export const applyFilters = ({
  rows = [],
  month = '',
  months = [],
  departmentId = '',
  designation = '',
  employeeId = '',
  status = '',
  employmentStatus = '',
  structureId = '',
} = {}) => {
  const wantedMonth = String(month || '');
  const wantedMonths = Array.isArray(months) && months.length ? months.map(String) : [];
  const department = String(departmentId || '');
  const wantedDesignation = String(designation || '').trim().toLowerCase();
  const employee = String(employeeId || '');
  const wantedStatus = String(status || '').toUpperCase();
  const wantedEmployment = String(employmentStatus || '').toUpperCase();
  const wantedStructure = String(structureId || '');

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (wantedMonth && String(row.month) !== wantedMonth) return false;
    if (wantedMonths.length && !wantedMonths.includes(String(row.month))) return false;
    if (department && String(row.departmentId) !== department) return false;
    if (wantedDesignation && String(row.designation || '').trim().toLowerCase() !== wantedDesignation) return false;
    if (employee && String(row.employeeId) !== employee) return false;
    if (wantedStatus && String(row.paymentStatus || '').toUpperCase() !== wantedStatus) return false;
    if (wantedEmployment && String(row.employmentStatus || '').toUpperCase() !== wantedEmployment) return false;
    if (wantedStructure && String(row.structureId || '') !== wantedStructure) return false;
    return true;
  });
};

/**
 * §22 — the register's search box. It matches the things a person types when
 * looking for a colleague: code, name, department, designation. Deliberately
 * NOT the amounts — searching payroll for "54000" is not a question anyone
 * asks, and it would let someone fish for a salary by guessing.
 */
export const searchRows = ({ rows = [], search = '' } = {}) => {
  const term = String(search || '').trim().toLowerCase();
  if (!term) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    [row.employeeCode, row.employeeName, row.department, row.designation]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term)));
};

/**
 * §11 — the months a trend reads. Defaults to the twelve months ending at
 * `month`, because "payroll trend" without a window is not a question anyone
 * asked.
 */
export const recentMonths = (month = '', count = 12) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return [];
  const [year, part] = String(month).split('-').map(Number);
  const months = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const index = year * 12 + (part - 1) - offset;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return months;
};

export const financialYearMonths = (month = '', fyStartMonth = 4) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return [];
  const fy = financialYearOf(month, fyStartMonth);
  const startYear = Number(String(fy).split('-')[0]);
  const months = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const m = ((fyStartMonth - 1 + offset) % 12) + 1;
    const y = m >= fyStartMonth ? startYear : startYear + 1;
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return months;
};

// ── exports ────────────────────────────────────────────────────────────────

export {
  money as roundMoney,
};
