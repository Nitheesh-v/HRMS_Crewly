// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.7 — PAYROLL REVIEW & APPROVAL RULES (pure)
//
//  No mongoose, no redis, no req, no Date.now(). The review workflow is a
//  state machine plus a validation catalogue plus report builders — all
//  functions of their inputs, so a thousand-employee month can be tested
//  without a database.
//
//  THIS PHASE NEVER CALCULATES (§21): the numbers come from the 29.6
//  snapshots. Review validates, locks, approves and reports — it does not
//  produce a single rupee.
//
//  SEPARATION OF DUTIES (§2 / §14): the person who prepares the payroll is
//  not the person who approves it. The transitions below enforce that.
// ═══════════════════════════════════════════════════════════════════════════

// ── statuses (§6) ──────────────────────────────────────────────────────────

export const REVIEW_STATUSES = [
  'CALCULATED',
  'UNDER_REVIEW',
  'LOCKED',
  'PENDING_FINANCE_APPROVAL',
  'APPROVED',
  'REJECTED',
  'REOPENED',
];

// §6 — every transition is explicit; anything else is refused with a reason.
export const REVIEW_TRANSITIONS = {
  CALCULATED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['LOCKED', 'REOPENED'],
  LOCKED: ['PENDING_FINANCE_APPROVAL', 'REOPENED'],
  PENDING_FINANCE_APPROVAL: ['APPROVED', 'REJECTED', 'REOPENED'],
  APPROVED: ['REOPENED'],
  REJECTED: ['REOPENED'],
  REOPENED: ['UNDER_REVIEW'],
};

export const canTransition = (from, to) =>
  (REVIEW_TRANSITIONS[from] || []).includes(to);

export const transitionError = (from, to) =>
  `Payroll cannot move from ${String(from || '?').replace(/_/g, ' ').toLowerCase()} to ${String(
    to || '?',
  )
    .replace(/_/g, ' ')
    .toLowerCase()}`;

// A locked or approved payroll is read-only (§12 / §24).
export const READ_ONLY_STATUSES = ['LOCKED', 'PENDING_FINANCE_APPROVAL', 'APPROVED'];
export const isReadOnly = (status) => READ_ONLY_STATUSES.includes(status);

// ── review checklist (§11) ─────────────────────────────────────────────────

export const CHECKLIST_ITEMS = [
  { key: 'ATTENDANCE_VERIFIED', label: 'Attendance verified' },
  { key: 'LEAVE_VERIFIED', label: 'Leave verified' },
  { key: 'BONUS_VERIFIED', label: 'Bonus verified' },
  { key: 'REIMBURSEMENTS_APPROVED', label: 'Reimbursements approved' },
  { key: 'DEDUCTIONS_REVIEWED', label: 'Deductions reviewed' },
  { key: 'NET_SALARY_REVIEWED', label: 'Net salary reviewed' },
  { key: 'ERROR_COUNT_ZERO', label: 'Error count is zero' },
];

export const emptyChecklist = () =>
  Object.fromEntries(CHECKLIST_ITEMS.map((item) => [item.key, false]));

export const checklistComplete = (checklist = {}) =>
  CHECKLIST_ITEMS.every((item) => Boolean(checklist?.[item.key]));

export const checklistProgress = (checklist = {}) => {
  const done = CHECKLIST_ITEMS.filter((item) => Boolean(checklist?.[item.key])).length;
  return { done, total: CHECKLIST_ITEMS.length, percent: Math.round((done / CHECKLIST_ITEMS.length) * 100) };
};

// ── error validation (§10) ─────────────────────────────────────────────────

const ERROR_CATALOGUE = {
  MISSING_BANK_ACCOUNT: { severity: 'CRITICAL', message: 'No bank account on the payroll profile' },
  MISSING_PAN: { severity: 'CRITICAL', message: 'PAN is missing on the payroll profile' },
  MISSING_SALARY_STRUCTURE: { severity: 'CRITICAL', message: 'No salary structure assigned' },
  INVALID_PAYROLL_PROFILE: { severity: 'CRITICAL', message: 'Payroll profile is missing or not active' },
  NEGATIVE_SALARY: { severity: 'CRITICAL', message: 'Net salary is negative' },
  DUPLICATE_PAYROLL_RECORD: { severity: 'CRITICAL', message: 'More than one current payroll record for this employee' },
  ATTENDANCE_MISSING: { severity: 'WARNING', message: 'No attendance figures were imported for this month' },
  MISSING_IFSC: { severity: 'WARNING', message: 'Bank IFSC is missing' },
  ZERO_NET_SALARY: { severity: 'WARNING', message: 'Net salary is zero' },
};

export const ERROR_SEVERITIES = ['CRITICAL', 'WARNING'];

export const validateEmployeeForReview = ({ employee = null, profile = null, results = [] } = {}) => {
  const errors = [];
  const add = (code) => errors.push({ code, ...ERROR_CATALOGUE[code] });

  if (!employee || employee.status !== 'ACTIVE') add('INVALID_PAYROLL_PROFILE');

  if (!profile) add('INVALID_PAYROLL_PROFILE');
  else {
    if (profile.payrollStatus && profile.payrollStatus !== 'ACTIVE') add('INVALID_PAYROLL_PROFILE');
    if (!profile.structureId) add('MISSING_SALARY_STRUCTURE');
    if (!profile.bank?.accountNumberLast4) add('MISSING_BANK_ACCOUNT');
    else if (!profile.bank?.ifsc) add('MISSING_IFSC');
    if (!profile.statutory?.pan) add('MISSING_PAN');
  }

  if (Array.isArray(results) && results.length > 1) add('DUPLICATE_PAYROLL_RECORD');

  const result = Array.isArray(results) ? results[0] : null;
  if (!result) add('INVALID_PAYROLL_PROFILE');
  else {
    const net = Number(result.totals?.netPay || 0);
    if (net < 0) add('NEGATIVE_SALARY');
    if (net === 0) add('ZERO_NET_SALARY');
    const attendance = result.attendance || {};
    if (!Number(attendance.workingDays) && !Number(attendance.paidDays)) add('ATTENDANCE_MISSING');
  }

  // One code can be added twice (profile missing + no result) — de-duplicate.
  const seen = new Set();
  return errors.filter((error) => {
    if (seen.has(error.code)) return false;
    seen.add(error.code);
    return true;
  });
};

export const criticalErrors = (errors = []) =>
  (errors || []).filter((error) => error.severity === 'CRITICAL');

export const summarizeErrors = (rows = []) => {
  const byCode = {};
  let critical = 0;
  let warnings = 0;

  (rows || []).forEach((row) => {
    (row.errors || []).forEach((error) => {
      byCode[error.code] = (byCode[error.code] || 0) + 1;
      if (error.severity === 'CRITICAL') critical += 1;
      else warnings += 1;
    });
  });

  return {
    employeesWithErrors: (rows || []).filter((row) => (row.errors || []).length > 0).length,
    critical,
    warnings,
    byCode,
  };
};

// ── dashboard KPIs (§7) and the summary report (§16) ───────────────────────

export const reviewKpis = ({ results = [], errorRows = [] } = {}) => {
  const calculated = (results || []).filter((row) => row.status === 'CALCULATED');
  const sum = (field) =>
    Math.round(calculated.reduce((total, row) => total + Number(row?.totals?.[field] || 0), 0) * 100) / 100;

  return {
    totalEmployees: (results || []).length,
    grossPayroll: sum('totalEarnings'),
    netPayroll: sum('netPay'),
    totalDeductions: sum('totalDeductions'),
    employerCost: sum('employerCost'),
    totalReimbursements: sum('reimbursements'),
    employeesWithErrors: (errorRows || []).filter((row) => (row.errors || []).length > 0).length,
    readyForApproval:
      (errorRows || []).filter((row) => (row.errors || []).length === 0).length ===
        (errorRows || []).length && (errorRows || []).length > 0,
  };
};

export const summaryReport = ({ results = [] } = {}) => {
  const calculated = (results || []).filter((row) => row.status === 'CALCULATED');
  const sum = (field) =>
    Math.round(calculated.reduce((total, row) => total + Number(row?.totals?.[field] || 0), 0) * 100) / 100;

  const totalEarnings = sum('totalEarnings');
  const reimbursements = sum('reimbursements');
  const employerCost = sum('employerCost');

  return {
    totalEmployees: calculated.length,
    grossPayroll: totalEarnings,
    totalEarnings,
    totalReimbursements: reimbursements,
    totalDeductions: sum('totalDeductions'),
    employerContribution: employerCost,
    netPayroll: sum('netPay'),
    payrollCost: Math.round((totalEarnings + reimbursements + employerCost) * 100) / 100,
  };
};

// ── difference report (§17) ────────────────────────────────────────────────
//
// Never hide a revision: compare the same employee's snapshot lines across two
// versions and return only what actually moved.

const flattenLines = (result = {}) => {
  const lines = [];
  (result.earnings || []).forEach((line) => lines.push({ group: 'Earnings', ...line }));
  (result.variableEarnings || []).forEach((line) =>
    lines.push({ group: 'Variable earnings', code: line.type, name: line.label, amount: line.amount }),
  );
  (result.reimbursements || []).forEach((line) =>
    lines.push({ group: 'Reimbursements', code: line.type, name: line.label, amount: line.amount }),
  );
  (result.deductions || []).forEach((line) => lines.push({ group: 'Deductions', ...line }));
  (result.employerContributions || []).forEach((line) =>
    lines.push({ group: 'Employer contributions', ...line }),
  );
  return lines;
};

export const diffResults = (previous = null, next = null) => {
  if (!previous || !next) return { changed: false, rows: [] };

  const before = new Map(flattenLines(previous).map((line) => [`${line.group}:${line.code}`, line]));
  const after = new Map(flattenLines(next).map((line) => [`${line.group}:${line.code}`, line]));
  const keys = new Set([...before.keys(), ...after.keys()]);

  const rows = [];
  keys.forEach((key) => {
    const oldLine = before.get(key);
    const newLine = after.get(key);
    const oldAmount = Number(oldLine?.amount || 0);
    const newAmount = Number(newLine?.amount || 0);
    if (oldAmount === newAmount && Boolean(oldLine) === Boolean(newLine)) return;
    rows.push({
      group: (newLine || oldLine).group,
      component: (newLine || oldLine).name || (newLine || oldLine).code,
      previous: Math.round(oldAmount * 100) / 100,
      current: Math.round(newAmount * 100) / 100,
      difference: Math.round((newAmount - oldAmount) * 100) / 100,
    });
  });

  const netBefore = Number(previous.totals?.netPay || 0);
  const netAfter = Number(next.totals?.netPay || 0);

  return {
    changed: rows.length > 0 || netBefore !== netAfter,
    rows,
    netPrevious: Math.round(netBefore * 100) / 100,
    netCurrent: Math.round(netAfter * 100) / 100,
    netDifference: Math.round((netAfter - netBefore) * 100) / 100,
  };
};

// ── bulk review actions (§18) ──────────────────────────────────────────────
//
// None of these may touch a salary value — that is the whole point.

export const BULK_REVIEW_ACTIONS = [
  'MARK_ALL_REVIEWED',
  'VERIFY_BANK_DETAILS',
  'VERIFY_PAN',
  'EXPORT_ERROR_LIST',
  'DOWNLOAD_PAYROLL_SUMMARY',
];

export const BULK_REVIEW_ACTION_LABELS = {
  MARK_ALL_REVIEWED: 'Mark all reviewed',
  VERIFY_BANK_DETAILS: 'Verify bank details',
  VERIFY_PAN: 'Verify PAN',
  EXPORT_ERROR_LIST: 'Export error list',
  DOWNLOAD_PAYROLL_SUMMARY: 'Download payroll summary',
};

export const PER_EMPLOYEE_REVIEW_FLAGS = ['BANK_VERIFIED', 'PAN_VERIFIED'];

// ── exports (§19) ──────────────────────────────────────────────────────────

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (header = [], rows = []) =>
  [header.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n');

export const EXPORT_REPORTS = [
  { key: 'PAYROLL_REGISTER', label: 'Payroll register' },
  { key: 'SALARY_SUMMARY', label: 'Salary summary' },
  { key: 'DEPARTMENT_PAYROLL', label: 'Department payroll' },
  { key: 'DEDUCTION_REPORT', label: 'Deduction report' },
  { key: 'EMPLOYER_CONTRIBUTION_REPORT', label: 'Employer contribution report' },
  { key: 'ERROR_LIST', label: 'Error list' },
];

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

export const buildPayrollRegister = ({ results = [] } = {}) =>
  toCsv(
    [
      'employeeCode',
      'employeeName',
      'department',
      'workingDays',
      'paidDays',
      'lopDays',
      'otHours',
      'gross',
      'variable',
      'reimbursements',
      'deductions',
      'netPay',
      'employerCost',
    ],
    (results || []).map((row) => [
      row.employeeCode || '',
      row.employeeName || '',
      row.departmentName || '',
      row.attendance?.workingDays ?? '',
      row.attendance?.paidDays ?? '',
      row.attendance?.lopDays ?? '',
      row.attendance?.otHours ?? '',
      money(row.totals?.gross),
      money(row.totals?.variableEarnings),
      money(row.totals?.reimbursements),
      money(row.totals?.totalDeductions),
      money(row.totals?.netPay),
      money(row.totals?.employerCost),
    ]),
  );

export const buildSalarySummary = ({ results = [] } = {}) =>
  toCsv(
    ['employeeCode', 'employeeName', 'basic', 'gross', 'variable', 'reimbursements', 'deductions', 'netPay'],
    (results || []).map((row) => [
      row.employeeCode || '',
      row.employeeName || '',
      money(row.totals?.basic),
      money(row.totals?.gross),
      money(row.totals?.variableEarnings),
      money(row.totals?.reimbursements),
      money(row.totals?.totalDeductions),
      money(row.totals?.netPay),
    ]),
  );

export const buildDepartmentPayroll = ({ results = [] } = {}) => {
  const byDepartment = new Map();
  (results || []).forEach((row) => {
    const key = row.departmentName || 'Unassigned';
    const current = byDepartment.get(key) || { employees: 0, gross: 0, net: 0, employer: 0 };
    current.employees += 1;
    current.gross += Number(row.totals?.gross || 0);
    current.net += Number(row.totals?.netPay || 0);
    current.employer += Number(row.totals?.employerCost || 0);
    byDepartment.set(key, current);
  });

  return toCsv(
    ['department', 'employees', 'gross', 'netPay', 'employerCost'],
    [...byDepartment.entries()].map(([department, totals]) => [
      department,
      totals.employees,
      money(totals.gross),
      money(totals.net),
      money(totals.employer),
    ]),
  );
};

export const buildDeductionReport = ({ results = [] } = {}) => {
  const rows = [];
  (results || []).forEach((row) => {
    (row.deductions || []).forEach((line) => {
      rows.push([row.employeeCode || '', row.employeeName || '', line.name || line.code, line.source, money(line.amount)]);
    });
  });
  return toCsv(['employeeCode', 'employeeName', 'component', 'source', 'amount'], rows);
};

export const buildEmployerContributionReport = ({ results = [] } = {}) => {
  const rows = [];
  (results || []).forEach((row) => {
    (row.employerContributions || []).forEach((line) => {
      rows.push([row.employeeCode || '', row.employeeName || '', line.name || line.code, money(line.amount)]);
    });
  });
  return toCsv(['employeeCode', 'employeeName', 'component', 'amount'], rows);
};

export const buildErrorList = ({ errorRows = [] } = {}) => {
  const rows = [];
  (errorRows || []).forEach((row) => {
    (row.errors || []).forEach((error) => {
      rows.push([row.employeeCode || '', row.employeeName || '', error.severity, error.code, error.message]);
    });
  });
  return toCsv(['employeeCode', 'employeeName', 'severity', 'code', 'message'], rows);
};

export const buildExport = (reportKey, { results = [], errorRows = [] } = {}) => {
  switch (reportKey) {
    case 'SALARY_SUMMARY':
      return buildSalarySummary({ results });
    case 'DEPARTMENT_PAYROLL':
      return buildDepartmentPayroll({ results });
    case 'DEDUCTION_REPORT':
      return buildDeductionReport({ results });
    case 'EMPLOYER_CONTRIBUTION_REPORT':
      return buildEmployerContributionReport({ results });
    case 'ERROR_LIST':
      return buildErrorList({ errorRows });
    default:
      return buildPayrollRegister({ results });
  }
};

export default {
  REVIEW_STATUSES,
  REVIEW_TRANSITIONS,
  CHECKLIST_ITEMS,
  BULK_REVIEW_ACTIONS,
  BULK_REVIEW_ACTION_LABELS,
  EXPORT_REPORTS,
  buildExport,
  canTransition,
  checklistComplete,
  checklistProgress,
  criticalErrors,
  diffResults,
  emptyChecklist,
  isReadOnly,
  reviewKpis,
  summarizeErrors,
  summaryReport,
  validateEmployeeForReview,
};
