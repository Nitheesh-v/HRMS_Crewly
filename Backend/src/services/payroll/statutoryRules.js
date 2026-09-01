// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY COMPLIANCE & GOVERNMENT REPORTS (pure rules)
//
//  No mongoose, no redis, no req, no Date.now(). Every function here is a
//  function of its inputs, so a 5,000-employee compliance run is testable
//  without a database, a queue, an SMTP server or a PDF renderer.
//
//  THE LAW OF THIS PHASE (§2 / §6 / §26):
//
//      CREWLY PREPARES THE RETURN. CREWLY NEVER FILES IT.
//
//  Every figure below is READ from the immutable 29.6 PayrollResult snapshot.
//  Nothing is recalculated — not PF, not ESI, not TDS. The rates, ceilings
//  and slab tables live in 29.6's payrollEngineRules and nowhere else, so a
//  statutory report can never disagree with the payroll that produced it.
//
//  WHAT IS STORED is the WORKFLOW: that a human reviewed the report, what
//  status it carries, who marked it filed and when. The numbers are always
//  re-derived, which is precisely why a payroll recalculation can never
//  leave a stale statutory figure behind (§20).
// ═══════════════════════════════════════════════════════════════════════════

// The paid-status test is 29.9's, imported rather than restated: both phases
// hang off the same "salary has actually been paid" gate, and two copies of
// that list would eventually disagree.
import { isPaidForPayslip } from './payslipRules.js';

// ── report types (§7–§12, §16) ─────────────────────────────────────────────

export const STATUTORY_TYPES = [
  'PF',
  'ESI',
  'PT',
  'TDS',
  'LWF',
  'GRATUITY',
  'COMPLIANCE_SUMMARY',
];

export const STATUTORY_TYPE_LABELS = {
  PF: 'Provident Fund',
  ESI: 'Employee State Insurance',
  PT: 'Professional Tax',
  TDS: 'Tax Deducted at Source',
  LWF: 'Labour Welfare Fund',
  GRATUITY: 'Gratuity',
  COMPLIANCE_SUMMARY: 'Compliance Summary',
};

// The five filable reports (§14). Gratuity and the compliance summary are
// reports, not returns — there is nothing to file for them.
export const FILABLE_TYPES = ['PF', 'ESI', 'PT', 'TDS', 'LWF'];

export const isStatutoryType = (type) => STATUTORY_TYPES.includes(String(type || '').toUpperCase());

// §18 — the annual reports. One key per report, each derived from the same
// monthly statutory rows rolled up over a financial year.
export const ANNUAL_REPORT_KEYS = [
  'ANNUAL_PF',
  'ANNUAL_TDS',
  'ANNUAL_PAYROLL_REGISTER',
  'ANNUAL_EMPLOYER_CONTRIBUTION',
  'ANNUAL_DEPARTMENT',
];

export const ANNUAL_REPORT_LABELS = {
  ANNUAL_PF: 'Annual PF Summary',
  ANNUAL_TDS: 'Annual TDS Summary',
  ANNUAL_PAYROLL_REGISTER: 'Annual Payroll Register',
  ANNUAL_EMPLOYER_CONTRIBUTION: 'Annual Employer Contribution',
  ANNUAL_DEPARTMENT: 'Department-wise Payroll',
};

export const REPORT_KEYS = [...STATUTORY_TYPES, ...ANNUAL_REPORT_KEYS];
export const isReportKey = (key) => REPORT_KEYS.includes(String(key || '').toUpperCase());

// ── filing status (§14) ────────────────────────────────────────────────────

export const FILING_STATUSES = ['DRAFT', 'REVIEWED', 'READY', 'FILED', 'REOPENED'];

export const FILING_STATUS_LABELS = {
  DRAFT: 'Draft',
  REVIEWED: 'Reviewed',
  READY: 'Ready',
  FILED: 'Filed',
  REOPENED: 'Reopened',
  // A month whose reports were never generated has no row at all; the UI
  // shows this instead of an empty cell.
  NOT_GENERATED: 'Not generated',
};

export const FILING_TRANSITIONS = {
  DRAFT: ['REVIEWED', 'READY', 'FILED'],
  REVIEWED: ['READY', 'FILED', 'REOPENED'],
  READY: ['FILED', 'REVIEWED', 'REOPENED'],
  FILED: ['REOPENED'],
  REOPENED: ['REVIEWED', 'READY', 'FILED'],
};

export const canTransitionFiling = (from, to) =>
  Boolean(FILING_TRANSITIONS[String(from || '').toUpperCase()]?.includes(
    String(to || '').toUpperCase(),
  ));

// The status a report carries the moment it is generated (§6: generate first,
// review second — a freshly generated return is never silently "ready").
export const INITIAL_FILING_STATUS = 'DRAFT';

// ── §25 — audit action names, in one place so the service, the worker and
// the tests cannot drift apart.
export const STATUTORY_AUDIT_ACTIONS = Object.freeze({
  GENERATED: 'STATUTORY_REPORT_GENERATED',
  DOWNLOADED: 'STATUTORY_REPORT_DOWNLOADED',
  FILING_UPDATED: 'STATUTORY_FILING_STATUS_UPDATED',
  REOPENED: 'STATUTORY_REPORT_REOPENED',
  REMINDER_SENT: 'COMPLIANCE_REMINDER_SENT',
  CALENDAR_TASK_UPDATED: 'COMPLIANCE_CALENDAR_TASK_UPDATED',
});

// ── §22 — in-app notification copy ─────────────────────────────────────────

export const NOTIFICATION_TYPES = Object.freeze({
  REPORTS_GENERATED: 'STATUTORY_REPORTS_GENERATED',
  FILING_DUE: 'STATUTORY_FILING_DUE',
  COMPLIANCE_FILED: 'STATUTORY_COMPLIANCE_FILED',
});

export const notificationCopy = (type, payload = {}) => {
  const label = monthLabel(payload.month);
  const name = STATUTORY_TYPE_LABELS[String(payload.type || '').toUpperCase()] || 'Statutory';

  if (type === NOTIFICATION_TYPES.REPORTS_GENERATED) {
    const count = Number(payload.count || 0);
    return `${count} statutory report${count === 1 ? '' : 's'} generated for ${label}.`;
  }
  if (type === NOTIFICATION_TYPES.FILING_DUE) {
    const when = payload.overdue ? 'is overdue' : 'is due';
    return `${name} for ${label} ${when} on ${payload.dueDate || 'the filing date'}.`;
  }
  if (type === NOTIFICATION_TYPES.COMPLIANCE_FILED) {
    return `${name} for ${label} was marked as filed.`;
  }
  return 'A statutory report was updated.';
};

// ── money / months / financial years ───────────────────────────────────────

export const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const monthLabel = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return String(month || '');
  const [year, part] = String(month).split('-');
  return `${MONTHS_LONG[Number(part) - 1]} ${year}`;
};

export const shortMonthLabel = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return String(month || '');
  const [year, part] = String(month).split('-');
  return `${MONTHS_SHORT[Number(part) - 1]} ${year}`;
};

// §15 — the financial year is company policy (29.1), never hardcoded April.
export const financialYearOf = (month, fyStartMonth = 4) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return '';
  const [year, part] = String(month).split('-').map(Number);
  const start = Math.min(12, Math.max(1, Number(fyStartMonth) || 4));
  const startYear = part >= start ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

export const financialYearLabel = (fy) => {
  const [start] = String(fy || '').split('-');
  if (!start) return '';
  return `FY ${start}-${String((Number(start) + 1) % 100).padStart(2, '0')}`;
};

/**
 * §18 — the calendar months that belong to a financial year, in order.
 * `2026-27` starting in April is Apr 2026 … Mar 2027.
 */
export const monthsOfFinancialYear = (fy = '', fyStartMonth = 4) => {
  const [raw] = String(fy || '').split('-');
  const startYear = Number(raw);
  if (!Number.isInteger(startYear) || startYear < 1970) return [];
  const start = Math.min(12, Math.max(1, Number(fyStartMonth) || 4));
  const months = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const monthIndex = start - 1 + offset; // 0-based
    const year = startYear + Math.floor(monthIndex / 12);
    months.push(`${year}-${String((monthIndex % 12) + 1).padStart(2, '0')}`);
  }
  return months;
};

export const previousMonth = (month = '') => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return '';
  const [year, part] = String(month).split('-').map(Number);
  return part === 1 ? `${year - 1}-12` : `${year}-${String(part - 1).padStart(2, '0')}`;
};

// ── §19 — the compliance calendar due dates ────────────────────────────────
//
// Data, never logic buried in a component: when the law moves a date, one
// row changes here and every calendar, reminder and export follows.
//
// `dayOfNextMonth` — the return for August is due on this day of September.
// `annual`         — one return per financial year, not per month.

export const FILING_DUE_RULES = Object.freeze({
  PF: { dayOfNextMonth: 15, note: 'Monthly ECR remittance' },
  ESI: { dayOfNextMonth: 15, note: 'Monthly ESI contribution' },
  TDS: { dayOfNextMonth: 7, note: 'Monthly TDS payment' },
  PT: { dayOfNextMonth: 20, note: 'Monthly professional tax remittance' },
  LWF: { dayOfNextMonth: 15, note: 'Monthly labour welfare fund contribution' },
  // Gratuity is provisioning, not a monthly remittance: one annual return.
  GRATUITY: { annual: true, month: 3, day: 31, note: 'Annual gratuity return' },
});

const pad = (value) => String(value).padStart(2, '0');

const lastDayOf = (year, monthNumber) =>
  new Date(Date.UTC(Number(year), Number(monthNumber), 0)).getUTCDate();

/**
 * The calendar due date for one type in one payroll month, as `YYYY-MM-DD`.
 * Returns '' for COMPLIANCE_SUMMARY — it is an internal review report and
 * has no statutory date attached to it.
 */
export const statutoryDueDate = (type = '', month = '', fyStartMonth = 4) => {
  const key = String(type || '').toUpperCase();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return '';
  const rule = FILING_DUE_RULES[key];
  if (!rule) return '';

  if (rule.annual) {
    // An annual return is due after the financial year it belongs to ends.
    const fy = financialYearOf(month, fyStartMonth);
    const [startYear] = String(fy || '').split('-').map(Number);
    if (!startYear) return '';
    const endYear = startYear + 1;
    const endMonth = ((Number(fyStartMonth) || 4) + 10) % 12 + 1;
    const day = Math.min(Number(rule.day) || 31, lastDayOf(endYear, endMonth));
    return `${endYear}-${pad(rule.month || endMonth)}-${pad(day)}`;
  }

  const [year, part] = String(month).split('-').map(Number);
  const nextYear = part === 12 ? year + 1 : year;
  const nextMonth = part === 12 ? 1 : part + 1;
  const day = Math.min(Number(rule.dayOfNextMonth) || 15, lastDayOf(nextYear, nextMonth));
  return `${nextYear}-${pad(nextMonth)}-${pad(day)}`;
};

export const daysUntil = (dueDate = '', today = '') => {
  if (!dueDate || !today) return null;
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  const now = new Date(`${today}T00:00:00Z`).getTime();
  if (!Number.isFinite(due) || !Number.isFinite(now)) return null;
  return Math.round((due - now) / 86400000);
};

// ── §2 / §6 — the payment gate ─────────────────────────────────────────────

/**
 * Statutory reports are prepared only for employees whose salary was
 * actually paid — the same gate 29.9 applies to payslips. A partially paid
 * month still reports every employee who was paid.
 */
export const isPaidForStatutory = (payment = null) => isPaidForPayslip(payment);

export const statutoryGateError = ({ hasBatch = false, paidCount = 0, batchStatus = '' } = {}) => {
  if (!hasBatch) {
    return 'No payment batch exists for this month — pay the payroll before preparing statutory reports.';
  }
  if (!paidCount) {
    return batchStatus
      ? `No salary has been confirmed as paid for this month yet (payment batch is ${batchStatus}).`
      : 'No salary has been confirmed as paid for this month yet.';
  }
  return null;
};

// ── §6 — one employee's statutory row, read from the 29.6 snapshot ──────────

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Everything one employee contributes to every statutory report for a month.
 * Every field is copied out of `result.statutory` — the engine's own block —
 * with the deduction / employer-contribution lines as the fallback for a
 * snapshot produced before the block existed. Nothing here computes anything.
 */
export const buildStatutoryRow = ({
  result = {},
  profile = {},
  employee = {},
  departmentName = '',
} = {}) => {
  const statutory = result.statutory || {};
  const totals = result.totals || {};

  const pf = statutory.pf || {};
  const esi = statutory.esi || {};
  const pt = statutory.professionalTax || {};
  const tds = statutory.tds || {};
  const gratuity = statutory.gratuity || {};
  const lwf = statutory.lwf || {};

  return {
    employeeId: String(result.employeeId || employee._id || ''),
    employeeCode: result.employeeCode || employee.employeeCode || '',
    employeeName: result.employeeName || employee.name || '',
    department: departmentName || '',
    designation: result.designation || '',

    // §7 / §8 / §10 — statutory identity, read-only for the employee (§17).
    pan: profile.statutory?.pan || '',
    uan: profile.statutory?.uan || '',
    esiNumber: profile.statutory?.esiNumber || '',
    pfMember: Boolean(profile.statutory?.pfMember),
    taxRegime: profile.tax?.regime || '',

    gross: money(totals.gross ?? totals.grossSalary ?? 0),
    basic: money(totals.basic ?? 0),
    net: money(totals.netPay ?? totals.netSalary ?? 0),

    pf: {
      applicable: Boolean(pf.applicable),
      wage: money(pf.pfWage),
      employee: money(pf.employee),
      employerEpf: money(pf.employerEpf),
      employerPension: money(pf.employerPension),
      employer: money(pf.employer),
    },
    esi: {
      applicable: Boolean(esi.applicable),
      wage: money(esi.wage),
      employee: money(esi.employee),
      employer: money(esi.employer),
    },
    pt: {
      applicable: Boolean(pt.applicable),
      state: pt.state || '',
      amount: money(pt.amount),
    },
    tds: {
      applicable: Boolean(tds.applicable),
      monthly: money(tds.monthly),
      annualIncome: money(tds.annualIncome),
      taxableIncome: money(tds.taxableIncome),
      annualTax: money(tds.annualTax),
      regime: tds.regime || '',
    },
    lwf: {
      applicable: Boolean(lwf.applicable),
      employee: money(lwf.employee),
      employer: money(lwf.employer),
    },
    gratuity: {
      applicable: Boolean(gratuity.applicable),
      amount: money(gratuity.amount),
    },
  };
};

// ── §7–§12, §16 — the monthly roll-up ──────────────────────────────────────

const sumBy = (rows = [], pick) =>
  money((rows || []).reduce((total, row) => total + num(pick(row)), 0));

const countWhere = (rows = [], pick) =>
  (rows || []).filter((row) => Boolean(pick(row))).length;

const groupBy = (rows = [], keyOf, seed, merge) => {
  const map = new Map();
  (rows || []).forEach((row) => {
    const key = String(keyOf(row) || 'Unassigned');
    map.set(key, merge(map.get(key) || seed(key), row));
  });
  return [...map.values()];
};

/**
 * The one aggregation every monthly report, KPI card and export is built
 * from. A single pass over the rows produces every statutory block, so the
 * dashboard, the PF report and the compliance summary can never disagree.
 */
export const summariseStatutoryRows = ({ rows = [] } = {}) => {
  const list = rows || [];

  const pfEmployees = countWhere(list, (row) => row.pf?.applicable);
  const esiEmployees = countWhere(list, (row) => row.esi?.applicable);
  const ptEmployees = countWhere(list, (row) => row.pt?.applicable);
  const tdsEmployees = countWhere(list, (row) => row.tds?.applicable);
  const lwfEmployees = countWhere(list, (row) => row.lwf?.applicable);
  const gratuityEmployees = countWhere(list, (row) => row.gratuity?.applicable);

  const pfEmployee = sumBy(list, (row) => row.pf?.employee);
  const pfEmployer = sumBy(list, (row) => row.pf?.employer);
  const pfEmployerEpf = sumBy(list, (row) => row.pf?.employerEpf);
  const pfEmployerPension = sumBy(list, (row) => row.pf?.employerPension);

  const esiEmployee = sumBy(list, (row) => row.esi?.employee);
  const esiEmployer = sumBy(list, (row) => row.esi?.employer);

  const ptTotal = sumBy(list, (row) => row.pt?.amount);
  const tdsTotal = sumBy(list, (row) => row.tds?.monthly);

  const lwfEmployee = sumBy(list, (row) => row.lwf?.employee);
  const lwfEmployer = sumBy(list, (row) => row.lwf?.employer);

  // §12 — gratuity is a LIABILITY, not a monthly deduction. The engine
  // provisions 4.81% of basic; × 12 is the annual exposure finance wants.
  const gratuityBase = money(
    list.filter((row) => row.gratuity?.applicable).reduce((total, row) => total + num(row.basic), 0),
  );
  const gratuityMonthly = sumBy(list, (row) => row.gratuity?.amount);

  return {
    employees: list.length,
    grossPayroll: sumBy(list, (row) => row.gross),
    netPayroll: sumBy(list, (row) => row.net),

    pf: {
      employees: pfEmployees,
      wage: sumBy(list, (row) => row.pf?.applicable ? row.pf?.wage : 0),
      employee: pfEmployee,
      employerEpf: pfEmployerEpf,
      employerPension: pfEmployerPension,
      employer: pfEmployer,
      total: money(pfEmployee + pfEmployer),
    },
    esi: {
      employees: esiEmployees,
      wage: sumBy(list, (row) => row.esi?.applicable ? row.esi?.wage : 0),
      employee: esiEmployee,
      employer: esiEmployer,
      total: money(esiEmployee + esiEmployer),
    },
    pt: {
      employees: ptEmployees,
      total: ptTotal,
      // §9 — state-wise. Crewly's 29.1 setup records one state per company,
      // so this is normally a single row; grouping keeps it correct if a
      // company ever records per-employee states.
      byState: groupBy(
        list.filter((row) => row.pt?.applicable),
        (row) => row.pt?.state || 'Default',
        (state) => ({ state, employees: 0, amount: 0 }),
        (entry, row) => ({
          ...entry,
          employees: entry.employees + 1,
          amount: money(entry.amount + num(row.pt?.amount)),
        }),
      ).sort((a, b) => String(a.state).localeCompare(String(b.state))),
    },
    tds: {
      employees: tdsEmployees,
      total: tdsTotal,
      // §10 — department summary alongside the monthly and annual views.
      byDepartment: groupBy(
        list.filter((row) => row.tds?.applicable),
        (row) => row.department || 'Unassigned',
        (department) => ({ department, employees: 0, taxableIncome: 0, tds: 0 }),
        (entry, row) => ({
          ...entry,
          employees: entry.employees + 1,
          taxableIncome: money(entry.taxableIncome + num(row.tds?.taxableIncome)),
          tds: money(entry.tds + num(row.tds?.monthly)),
        }),
      ).sort((a, b) => b.tds - a.tds),
    },
    lwf: {
      employees: lwfEmployees,
      employee: lwfEmployee,
      employer: lwfEmployer,
      total: money(lwfEmployee + lwfEmployer),
    },
    gratuity: {
      employees: gratuityEmployees,
      base: gratuityBase,
      monthly: gratuityMonthly,
      annualised: money(gratuityMonthly * 12),
    },
  };
};

// ── §5 — the KPI cards ─────────────────────────────────────────────────────

/**
 * Seven cards: five payables plus how much filing is still outstanding.
 * §16 — the payables are the TOTAL (employee + employer) for PF, ESI and
 * LWF, because that is the amount that actually leaves the company.
 */
export const complianceKpis = ({ summary = {}, statuses = [], fyStartMonth = 4 } = {}) => {
  const rows = Array.isArray(statuses) ? statuses : [];
  const filable = rows.filter((row) => FILABLE_TYPES.includes(String(row?.type || '').toUpperCase()));
  const filed = filable.filter((row) => row?.status === 'FILED').length;
  const pending = filable.length - filed;

  return {
    pfPayable: money(summary?.pf?.total),
    esiPayable: money(summary?.esi?.total),
    ptPayable: money(summary?.pt?.total),
    tdsPayable: money(summary?.tds?.total),
    lwfPayable: money(summary?.lwf?.total),
    filingPending: pending,
    filingCompleted: filed,
    grossPayroll: money(summary?.grossPayroll),
    netPayroll: money(summary?.netPayroll),
    employees: Number(summary?.employees || 0),
  };
};

// ── §13 — the monthly compliance register ──────────────────────────────────

export const REGISTER_HEADERS = [
  'Month',
  'Financial Year',
  'Employees',
  'Gross Payroll',
  'Net Payroll',
  'PF Employee',
  'PF Employer',
  'PF Total',
  'ESI Employee',
  'ESI Employer',
  'ESI Total',
  'PT Collected',
  'TDS Deducted',
  'LWF Employee',
  'LWF Employer',
  'LWF Total',
  'Gratuity Provision',
  'PF Status',
  'ESI Status',
  'PT Status',
  'TDS Status',
  'LWF Status',
];

const statusOfType = (statuses = [], type) => {
  const row = (statuses || []).find((entry) => String(entry?.type || '').toUpperCase() === type);
  return row?.status || 'NOT_GENERATED';
};

export const registerRows = ({ months = [], byMonth = {}, statusesByMonth = {}, fyStartMonth = 4 } = {}) =>
  (months || []).map((month) => {
    const summary = byMonth[month] || {};
    const statuses = statusesByMonth[month] || [];
    const pf = summary.pf || {};
    const esi = summary.esi || {};
    const lwf = summary.lwf || {};
    return [
      month,
      financialYearOf(month, fyStartMonth),
      summary.employees ?? 0,
      money(summary.grossPayroll),
      money(summary.netPayroll),
      money(pf.employee),
      money(pf.employer),
      money(pf.total),
      money(esi.employee),
      money(esi.employer),
      money(esi.total),
      money(summary.pt?.total),
      money(summary.tds?.total),
      money(lwf.employee),
      money(lwf.employer),
      money(lwf.total),
      money(summary.gratuity?.monthly),
      statusOfType(statuses, 'PF'),
      statusOfType(statuses, 'ESI'),
      statusOfType(statuses, 'PT'),
      statusOfType(statuses, 'TDS'),
      statusOfType(statuses, 'LWF'),
    ];
  });

export const registerFilename = ({ financialYear = '' } = {}) =>
  `compliance-register-${financialYear || 'all'}.csv`;

// ── §15 — the government export tables ─────────────────────────────────────
//
// One header set and one row builder per report. CSV and XLSX share them
// (29.8's dependency-free writers), so the two formats can never diverge.

const reportDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

/**
 * Registers are read by humans: "1 employee covered", "2 employees covered".
 * Pluralises the FIRST word of the phrase only, so "employees covered" never
 * becomes "employees covereds".
 */
const countLabel = (phrase, count) => {
  const value = Number(count) || 0;
  const words = String(phrase || 'employees').split(' ').filter(Boolean);
  const head = (words[0] || 'employee').replace(/s$/, '');
  words[0] = value === 1 ? head : `${head}s`;
  return `${value} ${words.join(' ')}`;
};

const totalLabel = (phrase, count) => `TOTAL (${countLabel(phrase, count)})`;

export const EXPORT_TABLES = Object.freeze({
  PF: {
    headers: [
      'Employee Code', 'Employee Name', 'UAN', 'PF Wages',
      'Employee PF', 'Employer EPF', 'Employer Pension', 'Employer PF', 'Total PF',
    ],
    rows: ({ rows = [] } = {}) =>
      rows.filter((row) => row.pf?.applicable).map((row) => [
        row.employeeCode, row.employeeName, row.uan,
        money(row.pf.wage), money(row.pf.employee), money(row.pf.employerEpf),
        money(row.pf.employerPension), money(row.pf.employer),
        money(num(row.pf.employee) + num(row.pf.employer)),
      ]),
    totals: ({ summary = {} } = {}) => [
      '', totalLabel('employees', summary?.pf?.employees), '', money(summary?.pf?.wage),
      money(summary?.pf?.employee), money(summary?.pf?.employerEpf), money(summary?.pf?.employerPension),
      money(summary?.pf?.employer), money(summary?.pf?.total),
    ],
  },

  ESI: {
    headers: [
      'Employee Code', 'Employee Name', 'ESI Number', 'Gross Wages',
      'Employee ESI', 'Employer ESI', 'Total ESI',
    ],
    rows: ({ rows = [] } = {}) =>
      rows.filter((row) => row.esi?.applicable).map((row) => [
        row.employeeCode, row.employeeName, row.esiNumber,
        money(row.esi.wage), money(row.esi.employee), money(row.esi.employer),
        money(num(row.esi.employee) + num(row.esi.employer)),
      ]),
    totals: ({ summary = {} } = {}) => [
      '', totalLabel('employees', summary?.esi?.employees), '', money(summary?.esi?.wage),
      money(summary?.esi?.employee), money(summary?.esi?.employer), money(summary?.esi?.total),
    ],
  },

  PT: {
    headers: ['State', 'Employees', 'PT Collected'],
    rows: ({ summary = {} } = {}) =>
      (summary?.pt?.byState || []).map((entry) => [entry.state, entry.employees, money(entry.amount)]),
    totals: ({ summary = {} } = {}) => [
      'TOTAL', money(summary?.pt?.employees), money(summary?.pt?.total),
    ],
  },

  TDS: {
    headers: [
      'Employee Code', 'Employee Name', 'PAN', 'Department', 'Regime',
      'Taxable Income (Annualised)', 'TDS Deducted (Month)', 'Annual Tax',
    ],
    rows: ({ rows = [] } = {}) =>
      rows.filter((row) => row.tds?.applicable).map((row) => [
        row.employeeCode, row.employeeName, row.pan, row.department || '', row.tds.regime || '',
        money(row.tds.taxableIncome), money(row.tds.monthly), money(row.tds.annualTax),
      ]),
    totals: ({ summary = {} } = {}) => [
      '', totalLabel('employees', summary?.tds?.employees), '', '', '', '',
      money(summary?.tds?.total), '',
    ],
  },

  LWF: {
    headers: ['Employee Code', 'Employee Name', 'Employee LWF', 'Employer LWF', 'Total LWF'],
    rows: ({ rows = [] } = {}) =>
      rows.filter((row) => row.lwf?.applicable).map((row) => [
        row.employeeCode, row.employeeName,
        money(row.lwf.employee), money(row.lwf.employer),
        money(num(row.lwf.employee) + num(row.lwf.employer)),
      ]),
    totals: ({ summary = {} } = {}) => [
      '', totalLabel('employees', summary?.lwf?.employees),
      money(summary?.lwf?.employee), money(summary?.lwf?.employer), money(summary?.lwf?.total),
    ],
  },

  GRATUITY: {
    headers: [
      'Employee Code', 'Employee Name', 'Department', 'Gratuity Base (Monthly Basic)',
      'Monthly Provision', 'Annualised Liability',
    ],
    rows: ({ rows = [] } = {}) =>
      rows.filter((row) => row.gratuity?.applicable).map((row) => [
        row.employeeCode, row.employeeName, row.department || '',
        money(row.basic), money(row.gratuity.amount), money(num(row.gratuity.amount) * 12),
      ]),
    totals: ({ summary = {} } = {}) => [
      '', totalLabel('employees', summary?.gratuity?.employees), '',
      money(summary?.gratuity?.base), money(summary?.gratuity?.monthly), money(summary?.gratuity?.annualised),
    ],
  },

  COMPLIANCE_SUMMARY: {
    headers: ['Section', 'Particulars', 'Amount'],
    rows: ({ summary = {} } = {}) => {
      const s = summary || {};
      const pf = s.pf || {};
      const esi = s.esi || {};
      const pt = s.pt || {};
      const tds = s.tds || {};
      const lwf = s.lwf || {};
      const gratuity = s.gratuity || {};
      return [
        ['Payroll Summary', `Gross Payroll (${countLabel('employees', s.employees)})`, money(s.grossPayroll)],
        ['Payroll Summary', 'Net Payroll', money(s.netPayroll)],
        ['PF', `Employee PF (${countLabel('employees covered', pf.employees)})`, money(pf.employee)],
        ['PF', 'Employer PF', money(pf.employer)],
        ['PF', 'Total PF Payable', money(pf.total)],
        ['ESI', `Employee ESI (${countLabel('employees covered', esi.employees)})`, money(esi.employee)],
        ['ESI', 'Employer ESI', money(esi.employer)],
        ['ESI', 'Total ESI Payable', money(esi.total)],
        ['PT', `Professional Tax collected (${countLabel('employees', pt.employees)})`, money(pt.total)],
        ['TDS', `TDS deducted (${countLabel('employees', tds.employees)})`, money(tds.total)],
        ['LWF', `Employee LWF (${countLabel('employees covered', lwf.employees)})`, money(lwf.employee)],
        ['LWF', 'Employer LWF', money(lwf.employer)],
        ['LWF', 'Total LWF Payable', money(lwf.total)],
        ['Gratuity', `Monthly provision (${countLabel('employees eligible', gratuity.employees)})`, money(gratuity.monthly)],
        ['Gratuity', 'Annualised liability', money(gratuity.annualised)],
      ];
    },
    totals: () => [],
  },
});

// §18 — the annual reports. Each is a roll-up of the same monthly rows.
export const ANNUAL_TABLES = Object.freeze({
  ANNUAL_PF: {
    headers: [
      'Employee Code', 'Employee Name', 'UAN', 'Months Covered',
      'Employee PF', 'Employer PF', 'Total PF',
    ],
    rows: ({ rows = [] } = {}) =>
      rows.filter((row) => num(row.employeePF) > 0 || num(row.employerPF) > 0).map((row) => [
        row.employeeCode, row.employeeName, row.uan, row.months,
        money(row.employeePF), money(row.employerPF),
        money(num(row.employeePF) + num(row.employerPF)),
      ]),
  },

  ANNUAL_TDS: {
    headers: [
      'Employee Code', 'Employee Name', 'PAN', 'Department', 'Regime',
      'Months Covered', 'Annual Taxable Income', 'TDS Deducted',
    ],
    rows: ({ rows = [] } = {}) =>
      rows.filter((row) => num(row.tds) > 0).map((row) => [
        row.employeeCode, row.employeeName, row.pan, row.department || '', row.regime || '',
        row.months, money(row.taxableIncome), money(row.tds),
      ]),
  },

  ANNUAL_PAYROLL_REGISTER: {
    headers: [
      'Month', 'Employees', 'Gross Payroll', 'Net Payroll',
      'PF Total', 'ESI Total', 'PT', 'TDS', 'LWF Total',
    ],
    rows: ({ months = [] } = {}) =>
      months.map((row) => [
        row.month,
        row.employees,
        money(row.grossPayroll),
        money(row.netPayroll),
        money(row.pfTotal),
        money(row.esiTotal),
        money(row.pt),
        money(row.tds),
        money(row.lwfTotal),
      ]),
  },

  ANNUAL_EMPLOYER_CONTRIBUTION: {
    headers: [
      'Month', 'Employer PF', 'Employer Pension', 'Employer ESI',
      'Employer LWF', 'Gratuity Provision', 'Total Employer Cost',
    ],
    rows: ({ months = [] } = {}) =>
      months.map((row) => [
        row.month,
        money(row.employerEpf),
        money(row.employerPension),
        money(row.employerEsi),
        money(row.employerLwf),
        money(row.gratuity),
        money(
          num(row.employerEpf) + num(row.employerPension) + num(row.employerEsi) +
            num(row.employerLwf) + num(row.gratuity),
        ),
      ]),
  },

  ANNUAL_DEPARTMENT: {
    headers: [
      'Department', 'Employees', 'Gross Payroll', 'Net Payroll',
      'PF Total', 'ESI Total', 'TDS', 'Employer Contributions',
    ],
    rows: ({ rows = [] } = {}) =>
      rows.map((row) => [
        row.department || 'Unassigned',
        row.employees,
        money(row.grossPayroll),
        money(row.netPayroll),
        money(row.pfTotal),
        money(row.esiTotal),
        money(row.tds),
        money(row.employerContributions),
      ]),
  },
});

/**
 * §18 — roll monthly statutory rows up into a per-employee annual view.
 * An employee who joined in September is not credited with April's salary:
 * `months` counts only the months they actually appear in.
 */
export const annualiseEmployeeRows = ({ monthRows = [] } = {}) => {
  const map = new Map();

  (monthRows || []).forEach((row) => {
    const key = String(row.employeeId || row.employeeCode || row.employeeName);
    const entry = map.get(key) || {
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      department: row.department,
      pan: row.pan,
      uan: row.uan,
      esiNumber: row.esiNumber,
      regime: row.taxRegime,
      months: 0,
      gross: 0,
      net: 0,
      basic: 0,
      employeePF: 0,
      employerPF: 0,
      employeeEsi: 0,
      employerEsi: 0,
      pt: 0,
      tds: 0,
      taxableIncome: 0,
      lwf: 0,
      gratuity: 0,
    };

    entry.months += 1;
    entry.gross = money(entry.gross + num(row.gross));
    entry.net = money(entry.net + num(row.net));
    entry.basic = money(entry.basic + num(row.basic));
    entry.employeePF = money(entry.employeePF + num(row.pf?.employee));
    entry.employerPF = money(entry.employerPF + num(row.pf?.employer));
    entry.employeeEsi = money(entry.employeeEsi + num(row.esi?.employee));
    entry.employerEsi = money(entry.employerEsi + num(row.esi?.employer));
    entry.pt = money(entry.pt + num(row.pt?.amount));
    entry.tds = money(entry.tds + num(row.tds?.monthly));
    entry.taxableIncome = money(entry.taxableIncome + num(row.tds?.taxableIncome));
    entry.lwf = money(entry.lwf + num(row.lwf?.employee) + num(row.lwf?.employer));
    entry.gratuity = money(entry.gratuity + num(row.gratuity?.amount));
    if (row.department) entry.department = row.department;

    map.set(key, entry);
  });

  return [...map.values()].sort((a, b) => String(a.employeeName).localeCompare(String(b.employeeName)));
};

/** §18 — the per-month rows behind ANNUAL_PAYROLL_REGISTER / ANNUAL_EMPLOYER_CONTRIBUTION. */
export const annualMonthRows = ({ months = [], summaries = {} } = {}) =>
  (months || []).map((month) => {
    const s = summaries[month] || {};
    return {
      month,
      monthLabel: monthLabel(month),
      employees: Number(s.employees || 0),
      grossPayroll: money(s.grossPayroll),
      netPayroll: money(s.netPayroll),
      pfTotal: money(s.pf?.total),
      esiTotal: money(s.esi?.total),
      pt: money(s.pt?.total),
      tds: money(s.tds?.total),
      lwfTotal: money(s.lwf?.total),
      employerEpf: money(s.pf?.employerEpf),
      employerPension: money(s.pf?.employerPension),
      employerEsi: money(s.esi?.employer),
      employerLwf: money(s.lwf?.employer),
      gratuity: money(s.gratuity?.monthly),
    };
  });

/** §18 — department-wise payroll for the year. */
export const annualDepartmentRows = ({ employeeRows = [] } = {}) => {
  const map = new Map();
  (employeeRows || []).forEach((row) => {
    const key = String(row.department || 'Unassigned');
    const entry = map.get(key) || {
      department: key,
      employees: 0,
      grossPayroll: 0,
      netPayroll: 0,
      pfTotal: 0,
      esiTotal: 0,
      tds: 0,
      employerContributions: 0,
    };
    entry.employees += 1;
    entry.grossPayroll = money(entry.grossPayroll + num(row.gross));
    entry.netPayroll = money(entry.netPayroll + num(row.net));
    entry.pfTotal = money(entry.pfTotal + num(row.employeePF) + num(row.employerPF));
    entry.esiTotal = money(entry.esiTotal + num(row.employeeEsi) + num(row.employerEsi));
    entry.tds = money(entry.tds + num(row.tds));
    entry.employerContributions = money(
      entry.employerContributions + num(row.employerPF) + num(row.employerEsi) + num(row.gratuity),
    );
    map.set(key, entry);
  });
  return [...map.values()].sort((a, b) => b.grossPayroll - a.grossPayroll);
};

// ── §15 — formats and filenames ────────────────────────────────────────────

export const EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF'];

export const normaliseFormat = (format = '') => {
  const key = String(format || '').trim().toUpperCase();
  return EXPORT_FORMATS.includes(key) ? key : 'CSV';
};

const safeSlug = (value) =>
  String(value || '')
    .replace(/[^a-zA-Z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'report';

export const exportFilename = ({
  reportKey = '',
  month = '',
  financialYear = '',
  format = 'CSV',
} = {}) => {
  const key = safeSlug(String(reportKey || 'report').toLowerCase());
  const period = month || financialYear || 'all';
  return `statutory-${key}-${safeSlug(period)}.${normaliseFormat(format).toLowerCase()}`;
};

export const contentTypes = {
  CSV: 'text/csv; charset=utf-8',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
};

// ── §19 — the compliance calendar ──────────────────────────────────────────

export const CALENDAR_TASK_STATUSES = ['PENDING', 'DONE'];

export const calendarStatusLabel = (status) =>
  status === 'DONE' ? 'Completed' : 'Pending';

/**
 * Which report types actually apply to this company. §11 — LWF is hidden
 * entirely when 29.1 has it switched off; gratuity likewise (§12).
 */
export const applicableTypes = (setup = {}) => {
  const statutory = setup?.statutory || {};
  const types = [];
  if (statutory.pf?.applicable) types.push('PF');
  if (statutory.esi?.applicable) types.push('ESI');
  if (statutory.professionalTax?.applicable) types.push('PT');
  if (statutory.tds?.applicable) types.push('TDS');
  if (statutory.labourWelfareFund?.applicable) types.push('LWF');
  if (statutory.gratuity?.applicable) types.push('GRATUITY');
  return types;
};

/**
 * §19 — the calendar rows for a range of months: one row per applicable
 * type, with the statutory due date, the report's filing status and whether
 * finance has ticked the task off.
 */
export const buildCalendar = ({
  months = [],
  setup = {},
  statusesByMonth = {},
  tasksByMonth = {},
  fyStartMonth = 4,
  today = '',
} = {}) => {
  const types = applicableTypes(setup);
  const rows = [];

  (months || []).forEach((month) => {
    const statuses = statusesByMonth[month] || [];
    const tasks = tasksByMonth[month] || [];
    types.forEach((type) => {
      const dueDate = statutoryDueDate(type, month, fyStartMonth);
      const report = (statuses || []).find((entry) => String(entry?.type || '').toUpperCase() === type);
      const task = (tasks || []).find((entry) => String(entry?.type || '').toUpperCase() === type);
      const status = report?.status || 'NOT_GENERATED';
      const remaining = daysUntil(dueDate, today);
      rows.push({
        month,
        monthLabel: monthLabel(month),
        type,
        typeLabel: STATUTORY_TYPE_LABELS[type] || type,
        dueDate,
        note: FILING_DUE_RULES[type]?.note || '',
        status,
        statusLabel: FILING_STATUS_LABELS[status] || status,
        filedAt: report?.filedAt || null,
        taskDone: Boolean(task?.status === 'DONE'),
        completedAt: task?.completedAt || null,
        // Overdue once the date has passed and the return is not filed.
        overdue: remaining !== null && remaining < 0 && status !== 'FILED',
        dueSoon: remaining !== null && remaining >= 0 && remaining <= 7 && status !== 'FILED',
        daysRemaining: remaining,
      });
    });
  });

  return rows;
};

export const REMINDER_WINDOW_DAYS = 7;

export const reminderCandidates = ({ rows = [] } = {}) =>
  (rows || []).filter(
    (row) =>
      row.dueDate &&
      row.status !== 'FILED' &&
      !row.taskDone &&
      (row.overdue || row.dueSoon),
  );

// ── §17 — the employee statutory view (read-only) ──────────────────────────

export const toEmployeeStatutoryView = ({
  profile = {},
  setup = {},
  employee = {},
  row = null,
} = {}) => {
  const statutory = profile?.statutory || {};
  return {
    employeeId: String(profile?.employeeId || employee?._id || ''),
    employeeCode: employee?.employeeCode || '',
    employeeName: employee?.name || '',
    pan: statutory.pan || '',
    uan: statutory.uan || '',
    esiNumber: statutory.esiNumber || '',
    pfMember: Boolean(statutory.pfMember),
    gratuityEligible: Boolean(statutory.gratuityEligible),
    ptState: setup?.statutory?.professionalTax?.state || '',
    taxRegime: profile?.tax?.regime || '',
    tdsApplicable: Boolean(profile?.tax?.tdsApplicable),
    // The employee sees their own current-month figures, read-only.
    current: row
      ? {
          month: row.month || '',
          monthLabel: monthLabel(row.month),
          pf: row.pf?.applicable ? money(row.pf.employee) : 0,
          esi: row.esi?.applicable ? money(row.esi.employee) : 0,
          pt: row.pt?.applicable ? money(row.pt.amount) : 0,
          tds: row.tds?.applicable ? money(row.tds.monthly) : 0,
          lwf: row.lwf?.applicable ? money(row.lwf.employee) : 0,
        }
      : null,
  };
};

export default {
  STATUTORY_TYPES,
  FILING_STATUSES,
  buildStatutoryRow,
  summariseStatutoryRows,
  complianceKpis,
  statutoryDueDate,
  buildCalendar,
  annualiseEmployeeRows,
  exportFilename,
};
