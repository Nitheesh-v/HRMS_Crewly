// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP GENERATION & EMPLOYEE SALARY PORTAL (pure rules)
//
//  No mongoose, no redis, no req, no Date.now(). Every function here is a
//  function of its inputs, so a 5,000-employee payslip run can be tested
//  without a database, a queue, an SMTP server or a PDF renderer.
//
//  The one law of this phase (§5 / §22):
//
//      A PAYSLIP IS A COPY, NEVER A CALCULATION.
//
//  Salary figures come from the immutable 29.6 PayrollResult snapshot, bank
//  details from the 29.4 profile, payment facts from the 29.8 payment row and
//  company identity from 29.1 setup + Company. Nothing is recomputed here —
//  not even when a payslip is regenerated (§22).
// ═══════════════════════════════════════════════════════════════════════════

// ── statuses (§21) ─────────────────────────────────────────────────────────

export const PAYSLIP_STATUSES = ['PENDING', 'GENERATED', 'EMAILED', 'DOWNLOADED', 'FAILED'];

export const PAYSLIP_STATUS_LABELS = {
  PENDING: 'Pending',
  GENERATED: 'Generated',
  EMAILED: 'Emailed',
  DOWNLOADED: 'Downloaded',
  FAILED: 'Failed',
};

// A payslip only ever moves forward along the delivery chain. FAILED is not
// terminal: a retry re-renders the PDF and puts it back on GENERATED.
export const PAYSLIP_TRANSITIONS = {
  PENDING: ['GENERATED', 'FAILED'],
  GENERATED: ['EMAILED', 'DOWNLOADED', 'FAILED', 'GENERATED'],
  EMAILED: ['DOWNLOADED', 'FAILED', 'EMAILED'],
  DOWNLOADED: ['EMAILED', 'DOWNLOADED', 'FAILED'],
  FAILED: ['GENERATED', 'FAILED'],
};

export const canTransitionPayslip = (from, to) =>
  Boolean(PAYSLIP_TRANSITIONS[from]?.includes(to));

// §25 — audit action names, in one place so the service, the worker and the
// tests cannot drift apart.
export const PAYSLIP_AUDIT_ACTIONS = Object.freeze({
  GENERATED: 'PAYSLIP_GENERATED',
  DOWNLOADED: 'PAYSLIP_DOWNLOADED',
  EMAILED: 'PAYSLIP_EMAILED',
  REGENERATED: 'PAYSLIP_REGENERATED',
  VIEWED: 'PAYSLIP_VIEWED',
});

// ── payslip number (§7) ────────────────────────────────────────────────────

export const PAYSLIP_NUMBER_PREFIX = 'PS';

/**
 * PS-2026-08-000245
 *
 * The counter is a COMPANY-WIDE running sequence (never reset per month) so a
 * number is permanent and never reused, while the month stays in the number
 * for a human reading the PDF footer.
 */
export const buildPayslipNumber = ({ month = '', sequence = 1 } = {}) => {
  const [year, part] = String(month || '0000-00').split('-');
  return `${PAYSLIP_NUMBER_PREFIX}-${year || '0000'}-${part || '00'}-${String(
    Math.max(1, Math.trunc(Number(sequence) || 1)),
  ).padStart(6, '0')}`;
};

// ── money / dates (display only — never recalculated) ──────────────────────

export const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const monthLabel = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return String(month || '');
  const [year, part] = String(month).split('-');
  return `${MONTHS_LONG[Number(part) - 1]} ${year}`;
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

// ── §6 — the snapshot ──────────────────────────────────────────────────────

const lines = (rows = [], nameKey = 'name', amountKey = 'amount') =>
  (Array.isArray(rows) ? rows : []).map((row) => {
    if (row === null || row === undefined) return null;
    if (typeof row !== 'object') return { name: String(row), amount: 0 };
    return {
      name: String(row[nameKey] ?? row.label ?? row.componentName ?? ''),
      amount: money(row[amountKey] ?? row.value ?? 0),
      ...(row.code ? { code: String(row.code) } : {}),
    };
  }).filter((row) => row && row.name);

const sumLines = (rows = []) =>
  money((rows || []).reduce((total, row) => total + money(row?.amount), 0));

/**
 * §6 — freeze everything a payslip will ever need. Called ONCE, at generation
 * time, from data the caller has already loaded. Regeneration (§22) re-renders
 * the stored snapshot and never calls this again with fresh payroll data.
 */
export const buildPayslipSnapshot = ({
  company = {},
  setup = {},
  employee = {},
  profile = {},
  result = {},
  payment = null,
  month = '',
  payslipNumber = '',
  generatedAt = null,
} = {}) => {
  const legal = setup.legalInfo || setup.legal || {};
  const bank = profile.bank || {};
  const totals = result.totals || {};
  const attendance = result.attendance || {};
  const earnings = lines(result.earnings);
  const variableEarnings = lines(result.variableEarnings);
  const reimbursements = lines(result.reimbursements);
  const deductions = lines(result.deductions);
  const employerContributions = lines(result.employerContributions);

  const grossSalary = money(
    totals.grossSalary ?? totals.gross ?? sumLines(earnings) + sumLines(variableEarnings),
  );
  const totalEarnings = money(totals.totalEarnings ?? sumLines([...earnings, ...variableEarnings]));
  const totalDeductions = money(totals.totalDeductions ?? sumLines(deductions));
  const netSalary = money(
    totals.netSalary ?? result.netSalary ?? money(totalEarnings + sumLines(reimbursements) - totalDeductions),
  );

  return {
    // ── company (§6) ───────────────────────────────────────────────────────
    company: {
      name: company.name || '',
      address: company.address || '',
      pan: legal.pan || '',
      tan: legal.tan || '',
      logoUrl: company.logoUrl || '',
    },

    // ── employee (§6) — masked bank details only (§13 / §26) ───────────────
    employee: {
      employeeId: String(employee._id || profile.userId || ''),
      employeeCode: employee.employeeCode || result.employeeCode || '',
      name: employee.name || result.employeeName || '',
      department: employee.departmentName || '',
      designation: employee.designation || result.designation || '',
      joiningDate: employee.joiningDate || employee.dateOfJoining || null,
      bankName: bank.bankName || '',
      // Masked at the source: the full number is never copied into a payslip.
      accountNumberMasked: bank.accountNumberMasked || '',
      uan: profile.statutory?.uan || profile.uan || '',
      pan: profile.statutory?.pan || profile.pan || '',
    },

    // ── payroll (§6) ───────────────────────────────────────────────────────
    payroll: {
      month,
      monthLabel: monthLabel(month),
      cycle: setup.payrollPolicy?.frequency || result.cycle || 'MONTHLY',
      paymentDate: payment?.paymentDate || null,
      payslipNumber,
    },

    // ── salary (§6 / §9 / §10 / §11) ───────────────────────────────────────
    salary: {
      grossSalary,
      totalEarnings,
      totalReimbursements: money(sumLines(reimbursements)),
      totalDeductions,
      netSalary,
      // §11 — employer contributions are information, never a deduction.
      totalEmployerContributions: money(sumLines(employerContributions)),
    },
    earnings,
    variableEarnings,
    reimbursements,
    deductions,
    employerContributions,

    // ── attendance (§12) — copied from the snapshot, never recalculated ─────
    attendance: {
      workingDays: Number(attendance.workingDays ?? attendance.totalWorkingDays ?? 0),
      presentDays: Number(attendance.presentDays ?? attendance.paidDays ?? 0),
      paidDays: Number(attendance.payableDays ?? attendance.paidDays ?? 0),
      lopDays: Number(attendance.lopDays ?? result.lop?.lopDays ?? 0),
      overtimeHours: Number(attendance.overtimeHours ?? result.overtime?.hours ?? 0),
    },

    // ── payment (§13) ──────────────────────────────────────────────────────
    payment: payment
      ? {
          paymentDate: payment.paymentDate || null,
          method: payment.method || 'BANK_TRANSFER',
          bankName: payment.bank?.bankName || '',
          accountNumberMasked: payment.bank?.accountNumberMasked || '',
          reference: payment.paymentReference || '',
        }
      : null,

    generatedAt: generatedAt || null,
    snapshotVersion: 1,
  };
};

// §22 — the values fingerprint. Regeneration re-renders the PDF from the
// stored snapshot, but this lets a test (and the regenerate path) prove the
// numbers could not have changed.
export const snapshotValuesKey = (snapshot = {}) => {
  const salary = snapshot.salary || {};
  const key = (rows = []) => (rows || []).map((row) => `${row.name}:${money(row.amount)}`).join('|');
  return [
    salary.grossSalary,
    salary.totalEarnings,
    salary.totalDeductions,
    salary.netSalary,
    key(snapshot.earnings),
    key(snapshot.variableEarnings),
    key(snapshot.reimbursements),
    key(snapshot.deductions),
    key(snapshot.employerContributions),
  ].join('~');
};

// ── §1 / §5 — the payment gate ─────────────────────────────────────────────

/**
 * A payslip is generated only for an employee whose salary was actually paid
 * (§1: "Payslips are generated only after Payroll Status = Paid").
 *
 * The 29.8 payment row is the source of truth: PARTIALLY_PAID batches still
 * produce payslips for the employees who were paid, so three failed transfers
 * never hold back the other 142.
 */
export const PAID_PAYMENT_STATUSES = ['PAID'];

export const isPaidForPayslip = (payment = null) =>
  Boolean(payment) && PAID_PAYMENT_STATUSES.includes(payment.status);

export const generationGateError = ({ hasBatch = false, paidCount = 0, batchStatus = '' } = {}) => {
  if (!hasBatch) return 'No payment batch exists for this month — pay the payroll before generating payslips.';
  if (!paidCount) {
    return batchStatus
      ? `No salary has been confirmed as paid for this month yet (payment batch is ${batchStatus}).`
      : 'No salary has been confirmed as paid for this month yet.';
  }
  return null;
};

// ── §15 — list filters ─────────────────────────────────────────────────────

export const filterPayslips = ({ rows = [], month = '', year = '', financialYear = '', search = '', fyStartMonth = 4 } = {}) => {
  const needle = String(search || '').trim().toLowerCase();
  return (rows || []).filter((row) => {
    if (month && row.month !== month) return false;
    if (year && String(row.month || '').slice(0, 4) !== String(year)) return false;
    if (financialYear && financialYearOf(row.month, fyStartMonth) !== financialYear) return false;
    if (!needle) return true;
    const haystack = [
      row.month,
      monthLabel(row.month),
      row.payslipNumber,
      row.employeeName,
      row.employeeCode,
      row.departmentName,
    ]
      .map((value) => String(value || '').toLowerCase())
      .join(' ');
    return haystack.includes(needle);
  });
};

export const sortPayslips = (rows = []) =>
  [...(rows || [])].sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')));

// ── §27 — admin dashboard counters ─────────────────────────────────────────

export const payslipSummary = ({ rows = [] } = {}) => {
  const list = rows || [];
  const byStatus = (status) => list.filter((row) => row.status === status).length;
  return {
    totalPayslips: list.length,
    employees: new Set(list.map((row) => String(row.employeeId))).size,
    generated: byStatus('GENERATED'),
    emailed: byStatus('EMAILED'),
    downloaded: byStatus('DOWNLOADED'),
    pending: byStatus('PENDING'),
    failed: byStatus('FAILED'),
    totalNetSalary: money(
      list.reduce((sum, row) => sum + money(row.snapshot?.salary?.netSalary), 0),
    ),
  };
};

// ── §18 — file naming ──────────────────────────────────────────────────────

const safeName = (value) =>
  String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'payslip';

export const payslipFilename = ({ month = '', employeeCode = '', name = '' } = {}) =>
  `payslip-${month || 'month'}-${safeName(employeeCode || name)}.pdf`;

export const zipEntryName = ({ month = '', employeeCode = '', name = '' } = {}) =>
  `${month || 'month'}/${safeName(employeeCode || name)}-${month || ''}.pdf`;

export const bulkZipFilename = ({ month = '', scope = 'COMPANY', departmentName = '' } = {}) =>
  scope === 'DEPARTMENT'
    ? `payslips-${month || 'month'}-${safeName(departmentName)}.zip`
    : `payslips-${month || 'month'}.zip`;

// ── §19 — email copy ───────────────────────────────────────────────────────

export const payslipEmailCopy = ({ month = '', employeeName = '', companyName = '' } = {}) => ({
  subject: `Salary Payslip — ${monthLabel(month)}`,
  text:
    `Dear ${employeeName || 'Employee'},\n\n` +
    `Your salary for ${monthLabel(month)} has been processed successfully. ` +
    'Please find your payslip attached.\n\n' +
    `— ${companyName || 'Crewly HRMS'}`,
  html:
    `<p>Dear ${employeeName || 'Employee'},</p>` +
    `<p>Your salary for <strong>${monthLabel(month)}</strong> has been processed successfully. ` +
    'Please find your payslip attached.</p>' +
    `<p>— ${companyName || 'Crewly HRMS'}</p>`,
});

// ── §20 — in-app notification copy ─────────────────────────────────────────

export const NOTIFICATION_TYPES = Object.freeze({
  PAYSLIP_AVAILABLE: 'PAYSLIP_AVAILABLE',
  PAYSLIPS_GENERATED: 'PAYSLIPS_GENERATED',
  PAYSLIP_EMAIL_FAILED: 'PAYSLIP_EMAIL_FAILED',
});

export const notificationCopy = (type, payload = {}) => {
  const label = monthLabel(payload.month);
  if (type === NOTIFICATION_TYPES.PAYSLIP_AVAILABLE) {
    return `Your ${label} payslip is now available.`;
  }
  if (type === NOTIFICATION_TYPES.PAYSLIPS_GENERATED) {
    const count = Number(payload.count || 0);
    return `${count} payslip${count === 1 ? '' : 's'} generated for ${label}.`;
  }
  if (type === NOTIFICATION_TYPES.PAYSLIP_EMAIL_FAILED) {
    return `The payslip email for ${label} could not be delivered. You can still download it from the portal.`;
  }
  return 'A payslip was updated.';
};

// ── §16 — the employee-facing view (never the PDF binary) ──────────────────

export const toPayslipCardView = (row = {}) => ({
  _id: row._id,
  month: row.month,
  monthLabel: monthLabel(row.month),
  payslipNumber: row.payslipNumber,
  status: row.status,
  statusLabel: PAYSLIP_STATUS_LABELS[row.status] || row.status,
  gross: row.snapshot?.salary?.grossSalary || 0,
  net: row.snapshot?.salary?.netSalary || 0,
  paymentDate: row.snapshot?.payment?.paymentDate || row.snapshot?.payroll?.paymentDate || null,
  downloadCount: row.downloadCount || 0,
  emailedAt: row.emailedAt || null,
  generatedAt: row.generatedAt || null,
});

export default {
  PAYSLIP_STATUSES,
  buildPayslipNumber,
  buildPayslipSnapshot,
  snapshotValuesKey,
  filterPayslips,
  payslipSummary,
  payslipEmailCopy,
  notificationCopy,
  toPayslipCardView,
};
