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
});

// §16 — the CTC report is the one the brief reserves for Finance.
export const FINANCE_ONLY_REPORTS = Object.freeze(['CTC']);

export const isReportKey = (value) => REPORT_KEYS.includes(String(value || '').toUpperCase());

// ── §10 — salary bands are DATA, never a switch in a component ─────────────

export const SALARY_BANDS = Object.freeze([
  { key: 'BAND_0_25K', label: 'Up to Rs 25,000', min: 0, max: 25000 },
  { key: 'BAND_25_50K', label: 'Rs 25,001 - 50,000', min: 25000, max: 50000 },
  { key: 'BAND_50_75K', label: 'Rs 50,001 - 75,000', min: 50000, max: 75000 },
  { key: 'BAND_75_1L', label: 'Rs 75,001 - 1,00,000', min: 75000, max: 100000 },
  { key: 'BAND_ABOVE_1L', label: 'Above Rs 1,00,000', min: 100000, max: Number.POSITIVE_INFINITY },
]);

export const bandOf = (amount = 0) => {
  const value = Number(amount) || 0;
  // The last band is open-ended, so `find` would miss a negative or an
  // enormous figure: fall back to the last band rather than dropping a row.
  return SALARY_BANDS.find((band) => value >= band.min && value < band.max) || SALARY_BANDS[SALARY_BANDS.length - 1];
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

  const gross = num(totals.gross ?? totals.grossSalary);
  const net = num(totals.netPay ?? totals.netSalary);
  const employeeId = String(result.employeeId || employee?._id || '');

  return {
    employeeId,
    employeeCode: result.employeeCode || employee?.employeeCode || '',
    employeeName: result.employeeName || employee?.name || '',
    departmentId: String(result.departmentId || employee?.department || ''),
    department: departmentName || employee?.departmentName || '',
    designation: result.designation || employee?.designation || '',

    month: result.month || '',

    gross,
    basic: num(totals.basic),
    totalEarnings: num(totals.totalEarnings),
    totalDeductions: num(totals.totalDeductions),
    net,
    employerCost: num(totals.employerCost),
    ctc: num(totals.ctc),

    // §12 — variable pay, broken out by what the company actually paid.
    variableEarnings: num(totals.variableEarnings),
    bonus: sumLines(result.variableEarnings, ['BONUS', 'PERFORMANCE_BONUS', 'FESTIVAL_BONUS', 'INCENTIVE', 'COMMISSION']),
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
    paidAt: payment?.paidAt || null,
    paymentReference: payment?.paymentReference || '',

    hasStatutory: Boolean(statutory),
  };
};

const sumLines = (lines = [], names = []) =>
  money(
    (Array.isArray(lines) ? lines : [])
      .filter((line) => names.includes(String(line?.name || line?.type || '').toUpperCase().replace(/\s+/g, '_')))
      .reduce((total, line) => total + num(line?.amount), 0),
  );

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
  const paidEmployees = list.length;
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
    averageSalary: paidEmployees ? money(net / paidEmployees) : 0,
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

export const analyticsKpis = ({ rows = [], settlements = [], previous = null } = {}) => {
  const summary = summariseRows({ rows });
  const statutory = statutoryLiability({ rows });

  const byCost = departmentRows({ rows });
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
      averageSalary: row.employees ? money(num(row.net) / row.employees) : 0,
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

export const salaryBandRows = ({ rows = [] } = {}) => {
  const seeded = SALARY_BANDS.map((band) => ({
    key: band.key,
    label: band.label,
    employees: 0,
    payroll: 0,
    netPayroll: 0,
  }));
  const index = new Map(seeded.map((row) => [row.key, row]));

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const band = bandOf(row.gross);
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
  activeEmployees = 0,
  joined = 0,
  exited = 0,
  previousRows = [],
} = {}) => {
  const now = summariseRows({ rows });
  const before = summariseRows({ rows: previousRows });
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
      variableEarnings: num(row.variableEarnings),
      overtime: num(row.overtime),
      reimbursements: num(row.reimbursements),
      net: num(row.net),
      totalVariable: money(num(row.bonus) + num(row.overtime) + num(row.reimbursements)),
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
    const dailyRate = num(row.workingDays) > 0 ? num(row.gross) / num(row.workingDays) : 0;
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

// ── §17 — the payroll register ─────────────────────────────────────────────

export const REGISTER_HEADERS = [
  'Employee ID',
  'Employee Name',
  'Department',
  'Designation',
  'Gross',
  'Deductions',
  'Net',
  'Employer Cost',
  'Payment Date',
  'Status',
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
      money(row.gross),
      money(row.totalDeductions),
      money(row.net),
      money(row.employerCost),
      // String(date) renders "Sat Sep 05 ..." — the register needs the
      // calendar date, so format it rather than stringify it.
      row.paidAt ? new Date(row.paidAt).toISOString().slice(0, 10) : '',
      row.paymentStatus || 'NOT_IN_BATCH',
    ]);

// ── export tables for every report (§19) ───────────────────────────────────

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
        headers: ['Employee Code', 'Employee Name', 'Department', 'Designation', 'Bonus', 'Variable Earnings', 'Overtime', 'Reimbursements', 'Total Variable'],
        rows: (payload.rows || []).map((row) => [
          row.employeeCode, row.employeeName, row.department, row.designation,
          money(row.bonus), money(row.variableEarnings), money(row.overtime),
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
        rows: Object.entries(payload.summary || {}).map(([label, value]) => [label, value]),
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
} = {}) => {
  const wantedMonth = String(month || '');
  const wantedMonths = Array.isArray(months) && months.length ? months.map(String) : [];
  const department = String(departmentId || '');
  const wantedDesignation = String(designation || '').trim().toLowerCase();
  const employee = String(employeeId || '');
  const wantedStatus = String(status || '').toUpperCase();

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (wantedMonth && String(row.month) !== wantedMonth) return false;
    if (wantedMonths.length && !wantedMonths.includes(String(row.month))) return false;
    if (department && String(row.departmentId) !== department) return false;
    if (wantedDesignation && String(row.designation || '').trim().toLowerCase() !== wantedDesignation) return false;
    if (employee && String(row.employeeId) !== employee) return false;
    if (wantedStatus && String(row.paymentStatus || '').toUpperCase() !== wantedStatus) return false;
    return true;
  });
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
