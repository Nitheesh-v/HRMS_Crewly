// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.5 — VARIABLE PAY & MONTHLY PAYROLL INPUTS (pure domain logic)
//
//  The last EDITABLE stage before the payroll engine (29.6). It COLLECTS data:
//
//      Attendance / Leave / Shift  ──auto──►  Monthly Input  ◄──manual── HR
//                                                   │
//                                        validate → lock → 29.6
//
//  It never calculates salary, PF, ESI, TDS or a payslip (§26).
//
//  PURE: no mongoose, no redis, no req/res — so the API, a script, a job and
//  the hermetic test suite all behave identically.
// ═══════════════════════════════════════════════════════════════════════════

// ── payroll period (§6) ─────────────────────────────────────────────────────

export const PERIOD_STATUSES = [
  'DRAFT',
  'COLLECTING_INPUTS',
  'VALIDATED',
  'LOCKED',
  'SENT_TO_PAYROLL',
];

export const PERIOD_STATUS_LABELS = {
  DRAFT: 'Draft',
  COLLECTING_INPUTS: 'Collecting Inputs',
  VALIDATED: 'Validated',
  LOCKED: 'Locked',
  SENT_TO_PAYROLL: 'Sent to Payroll',
};

// §5 / §20 — locking is one-way except for an authorized reopen.
export const PERIOD_TRANSITIONS = {
  DRAFT: ['COLLECTING_INPUTS'],
  COLLECTING_INPUTS: ['VALIDATED', 'LOCKED'],
  VALIDATED: ['LOCKED', 'COLLECTING_INPUTS'],
  LOCKED: ['COLLECTING_INPUTS', 'SENT_TO_PAYROLL'],
  SENT_TO_PAYROLL: [],
};

// ── variable pay types (§8 / §13) ───────────────────────────────────────────

export const ENTRY_CATEGORIES = [
  'BONUS',
  'INCENTIVE',
  'COMMISSION',
  'REIMBURSEMENT',
  'OVERTIME',
  'DEDUCTION',
  'ADJUSTMENT',
  'RECOVERY',
];

export const ENTRY_TYPES = [
  // Earnings
  'BONUS_PERFORMANCE',
  'BONUS_FESTIVAL',
  'BONUS_RETENTION',
  'BONUS_SPOT',
  'BONUS_JOINING',
  'INCENTIVE',
  'COMMISSION_SALES',
  'OVERTIME_ADJUSTMENT',
  // Reimbursements (§16 — monthly claims, never salary components)
  'REIMBURSEMENT_TRAVEL',
  'REIMBURSEMENT_FOOD',
  'REIMBURSEMENT_INTERNET',
  'REIMBURSEMENT_FUEL',
  'REIMBURSEMENT_MEDICAL',
  'REIMBURSEMENT_MOBILE',
  // Deductions / recoveries
  'DEDUCTION_ADVANCE_RECOVERY',
  'DEDUCTION_LOAN_EMI',
  'DEDUCTION_FINE',
  'DEDUCTION_ONE_TIME',
  'RECOVERY',
  'ADJUSTMENT',
];

export const ENTRY_TYPE_LABELS = {
  BONUS_PERFORMANCE: 'Performance Bonus',
  BONUS_FESTIVAL: 'Festival Bonus',
  BONUS_RETENTION: 'Retention Bonus',
  BONUS_SPOT: 'Spot Award',
  BONUS_JOINING: 'Joining Bonus',
  INCENTIVE: 'Incentive',
  COMMISSION_SALES: 'Sales Commission',
  OVERTIME_ADJUSTMENT: 'Overtime Adjustment',
  REIMBURSEMENT_TRAVEL: 'Travel Reimbursement',
  REIMBURSEMENT_FOOD: 'Food Reimbursement',
  REIMBURSEMENT_INTERNET: 'Internet Reimbursement',
  REIMBURSEMENT_FUEL: 'Fuel Reimbursement',
  REIMBURSEMENT_MEDICAL: 'Medical Reimbursement',
  REIMBURSEMENT_MOBILE: 'Mobile Reimbursement',
  DEDUCTION_ADVANCE_RECOVERY: 'Salary Advance Recovery',
  DEDUCTION_LOAN_EMI: 'Loan EMI',
  DEDUCTION_FINE: 'Fine',
  DEDUCTION_ONE_TIME: 'One-Time Deduction',
  RECOVERY: 'Recovery',
  ADJUSTMENT: 'Adjustment',
};

export const ENTRY_CATEGORY_BY_TYPE = {
  BONUS_PERFORMANCE: 'BONUS',
  BONUS_FESTIVAL: 'BONUS',
  BONUS_RETENTION: 'BONUS',
  BONUS_SPOT: 'BONUS',
  BONUS_JOINING: 'BONUS',
  INCENTIVE: 'INCENTIVE',
  COMMISSION_SALES: 'COMMISSION',
  OVERTIME_ADJUSTMENT: 'OVERTIME',
  REIMBURSEMENT_TRAVEL: 'REIMBURSEMENT',
  REIMBURSEMENT_FOOD: 'REIMBURSEMENT',
  REIMBURSEMENT_INTERNET: 'REIMBURSEMENT',
  REIMBURSEMENT_FUEL: 'REIMBURSEMENT',
  REIMBURSEMENT_MEDICAL: 'REIMBURSEMENT',
  REIMBURSEMENT_MOBILE: 'REIMBURSEMENT',
  DEDUCTION_ADVANCE_RECOVERY: 'DEDUCTION',
  DEDUCTION_LOAN_EMI: 'DEDUCTION',
  DEDUCTION_FINE: 'DEDUCTION',
  DEDUCTION_ONE_TIME: 'DEDUCTION',
  RECOVERY: 'RECOVERY',
  ADJUSTMENT: 'ADJUSTMENT',
};

export const CATEGORY_OF = (type) => ENTRY_CATEGORY_BY_TYPE[type] || 'ADJUSTMENT';
export const isDeductionType = (type) => ['DEDUCTION', 'RECOVERY'].includes(CATEGORY_OF(type));

// §16 — only approved claims flow into payroll.
export const CLAIM_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

// §18
export const INPUT_STATUSES = ['PENDING', 'READY', 'ERROR', 'LOCKED'];

// §12 — every bulk action is explicit and audited.
export const BULK_ACTIONS = [
  'ADD_FESTIVAL_BONUS',
  'ADD_INTERNET_ALLOWANCE',
  'APPLY_MEAL_REIMBURSEMENT',
  'MARK_ZERO_BONUS',
  'REMOVE_IMPORTED_ENTRIES',
];

export const BULK_ACTION_LABELS = {
  ADD_FESTIVAL_BONUS: 'Add festival bonus',
  ADD_INTERNET_ALLOWANCE: 'Add internet allowance',
  APPLY_MEAL_REIMBURSEMENT: 'Apply meal reimbursement',
  MARK_ZERO_BONUS: 'Mark zero bonus (clear bonuses)',
  REMOVE_IMPORTED_ENTRIES: 'Remove imported entries',
};

export const BULK_ACTION_TYPES = {
  ADD_FESTIVAL_BONUS: 'BONUS_FESTIVAL',
  ADD_INTERNET_ALLOWANCE: 'REIMBURSEMENT_INTERNET',
  APPLY_MEAL_REIMBURSEMENT: 'REIMBURSEMENT_FOOD',
};

export const ENTRY_SOURCES = ['MANUAL', 'BULK_IMPORT', 'BULK_ACTION'];

export const MAX_IMPORT_ROWS = 5000;
export const MAX_AMOUNT = 100000000;

// ── month helpers ───────────────────────────────────────────────────────────

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isValidMonth = (value) => MONTH_RE.test(String(value || '').trim());

export const monthBounds = (month) => {
  const [year, monthNumber] = String(month).split('-').map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const end = new Date(Date.UTC(year, monthNumber, 0));
  return {
    start,
    end,
    startKey: start.toISOString().slice(0, 10),
    endKey: end.toISOString().slice(0, 10),
    daysInMonth: end.getUTCDate(),
  };
};

export const monthLabel = (month) => {
  if (!isValidMonth(month)) return '';
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

// Indian financial year: 1 April – 31 March (§6).
export const financialYearOf = (month) => {
  if (!isValidMonth(month)) return '';
  const [year, monthNumber] = month.split('-').map(Number);
  const startYear = monthNumber >= 4 ? year : year - 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

export const isDateInMonth = (date, month) => {
  if (!date || !isValidMonth(month)) return false;
  const key = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  const { startKey, endKey } = monthBounds(month);
  return key >= startKey && key <= endKey;
};

// ── normalization ───────────────────────────────────────────────────────────

const clean = (value, max = 200) => String(value == null ? '' : value).trim().slice(0, max);
const toNumber = (value) => {
  if (value === '' || value === null || value === undefined) return 0;
  const parsed = Number(String(value).replace(/[,₹\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

// Generated ids must be unique even when two entries are normalized in the
// same millisecond, otherwise the duplicate check compares an entry to itself.
const generatedEntryId = (index) =>
  `entry-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const normalizeEntry = (input = {}, index = 0) => {
  const raw = input && typeof input === 'object' ? input : {};
  const type = String(raw.type || '').trim().toUpperCase();
  const claimStatus = String(raw.claimStatus || 'APPROVED').trim().toUpperCase();

  return {
    entryId: raw.entryId || generatedEntryId(index),
    type: ENTRY_TYPES.includes(type) ? type : '',
    amount: toNumber(raw.amount),
    reason: clean(raw.reason, 200),
    effectiveMonth: isValidMonth(raw.effectiveMonth) ? raw.effectiveMonth : '',
    claimDate: raw.claimDate ? String(raw.claimDate).slice(0, 10) : '',
    remarks: clean(raw.remarks, 300),
    claimStatus: CLAIM_STATUSES.includes(claimStatus) ? claimStatus : 'APPROVED',
    approvedBy: raw.approvedBy || null,
    source: ENTRY_SOURCES.includes(raw.source) ? raw.source : 'MANUAL',
    createdAt: raw.createdAt || null,
  };
};

// ── validation (§19) ────────────────────────────────────────────────────────

export const validateEntry = (entry, { month = '', existing = [] } = {}) => {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  if (!entry.type) add('type', 'Choose what this entry is (bonus, reimbursement, deduction…)');
  if (!(entry.amount > 0)) add('amount', 'Amount must be greater than zero');
  if (entry.amount > MAX_AMOUNT) add('amount', 'Amount looks too large — please check');
  if (!entry.reason) add('reason', 'A reason is required for every manual entry');
  if (month && entry.effectiveMonth && entry.effectiveMonth !== month) {
    add('effectiveMonth', 'The entry month must match the payroll month');
  }

  // §19 — duplicate bonus / reimbursement entries are rejected.
  if (entry.type) {
    const duplicate = (existing || []).find(
      (row) =>
        row.type === entry.type &&
        String(row.entryId || '') !== String(entry.entryId || '') &&
        row.reason === entry.reason &&
        Number(row.amount) === Number(entry.amount),
    );
    if (duplicate) {
      add('type', `A similar ${ENTRY_TYPE_LABELS[entry.type] || entry.type} entry already exists`);
    }
  }

  return errors;
};

// Whole-employee validation (§19). The caller supplies what it read.
export const validateEmployeeInput = ({
  month = '',
  hasProfile = false,
  hasStructure = false,
  employeeActive = true,
  entries = [],
  locked = false,
} = {}) => {
  const issues = [];

  if (!isValidMonth(month)) issues.push('Payroll month is required');
  if (!employeeActive) issues.push('Employee is not active in this company');
  if (!hasProfile) issues.push('Employee has no payroll profile (Phase 29.4)');
  else if (!hasStructure) issues.push('Employee payroll profile has no salary structure');

  (entries || []).forEach((entry) => {
    validateEntry(entry, { month }).forEach((error) => issues.push(error.message));
  });

  return { issues, locked };
};

export const statusFor = ({ issues = [], locked = false } = {}) => {
  if (locked) return 'LOCKED';
  if (issues.length) return 'ERROR';
  return 'READY';
};

// ── CSV import (§11) — pure, no dependency ──────────────────────────────────

export const IMPORT_TEMPLATE_HEADER = [
  'employeeCode',
  'type',
  'amount',
  'reason',
  'claimDate',
  'remarks',
];

const splitCsvLine = (line) => {
  const cells = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
};

export const parseImportCsv = (content = '') => {
  const text = String(content || '').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');

  if (!lines.length) return { rows: [], rejected: [], header: [] };

  const header = splitCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  const indexOf = (name) => header.indexOf(name);

  if (indexOf('employeecode') === -1 || indexOf('type') === -1 || indexOf('amount') === -1) {
    return {
      rows: [],
      rejected: [{ line: 1, employeeCode: '', message: 'The header must contain employeeCode, type and amount' }],
      header,
    };
  }

  const rows = [];
  const rejected = [];

  lines.slice(1, MAX_IMPORT_ROWS + 1).forEach((line, offset) => {
    const lineNumber = offset + 2;
    const cells = splitCsvLine(line);
    const value = (name) => cells[indexOf(name)] || '';

    const employeeCode = value('employeecode').toUpperCase();
    if (!employeeCode) {
      rejected.push({ line: lineNumber, employeeCode: '', message: 'Employee code is missing' });
      return;
    }

    const entry = normalizeEntry(
      {
        type: value('type'),
        amount: value('amount'),
        reason: value('reason'),
        claimDate: value('claimdate'),
        remarks: value('remarks'),
        source: 'BULK_IMPORT',
      },
      offset,
    );

    const errors = validateEntry(entry);
    if (errors.length) {
      rejected.push({ line: lineNumber, employeeCode, message: errors[0].message });
      return;
    }

    // Duplicate rows inside the same file (§11).
    if (
      rows.some(
        (row) =>
          row.employeeCode === employeeCode &&
          row.entry.type === entry.type &&
          row.entry.amount === entry.amount &&
          row.entry.reason === entry.reason,
      )
    ) {
      rejected.push({
        line: lineNumber,
        employeeCode,
        message: 'Duplicate row — the same employee, type and amount already appears above',
      });
      return;
    }

    rows.push({ line: lineNumber, employeeCode, entry });
  });

  if (lines.length - 1 > MAX_IMPORT_ROWS) {
    rejected.push({
      line: MAX_IMPORT_ROWS + 2,
      employeeCode: '',
      message: `Only the first ${MAX_IMPORT_ROWS} rows are imported — split the file`,
    });
  }

  return { rows, rejected, header };
};

// ── totals and KPIs (§25) ───────────────────────────────────────────────────

export const entryTotals = (entries = []) => {
  const totals = { bonus: 0, reimbursement: 0, deduction: 0 };
  const approved = (entries || []).filter(
    (entry) => (entry.claimStatus || 'APPROVED') !== 'REJECTED',
  );

  approved.forEach((entry) => {
    const category = CATEGORY_OF(entry.type);
    if (category === 'REIMBURSEMENT') totals.reimbursement += Number(entry.amount) || 0;
    else if (category === 'DEDUCTION' || category === 'RECOVERY') {
      totals.deduction += Number(entry.amount) || 0;
    } else totals.bonus += Number(entry.amount) || 0;
  });

  return {
    bonus: Math.round(totals.bonus * 100) / 100,
    reimbursement: Math.round(totals.reimbursement * 100) / 100,
    deduction: Math.round(totals.deduction * 100) / 100,
  };
};

export const summarizeMonth = (inputs = []) => {
  const summary = {
    employees: inputs.length,
    ready: 0,
    pending: 0,
    error: 0,
    locked: 0,
    totalBonus: 0,
    totalReimbursement: 0,
    totalDeduction: 0,
    totalLopDays: 0,
    totalOtHours: 0,
  };

  (inputs || []).forEach((row) => {
    const statusKey = statusFor({ issues: row.issues || [], locked: row.locked }).toLowerCase();
    summary[statusKey] = (summary[statusKey] || 0) + 1;

    const totals = entryTotals(row.entries);
    summary.totalBonus += totals.bonus;
    summary.totalReimbursement += totals.reimbursement;
    summary.totalDeduction += totals.deduction;
    summary.totalLopDays += Number(row.auto?.lopDays || 0);
    summary.totalOtHours += Number(row.auto?.otHours || 0);
  });

  summary.totalBonus = Math.round(summary.totalBonus * 100) / 100;
  summary.totalReimbursement = Math.round(summary.totalReimbursement * 100) / 100;
  summary.totalDeduction = Math.round(summary.totalDeduction * 100) / 100;
  summary.totalOtHours = Math.round(summary.totalOtHours * 100) / 100;

  return summary;
};

// ── automatic imports (§7 / §14 / §15) ─────────────────────────────────────

// Weekend policy comes from 29.1; the input module never re-decides it.
const isWeekend = (dateKey, weekendPolicy = {}) => {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const days = weekendPolicy.weekendDays || [0];
  return days.includes(day);
};

export const computeAutomaticSummary = ({
  month = '',
  workingDays = 0,
  attendance = [],
  leaves = [],
  holidays = [],
  lopLeaveType = null,
} = {}) => {
  const summary = {
    workingDays: Number(workingDays) || 0,
    presentDays: 0,
    lateMarks: 0,
    halfDays: 0,
    absentDays: 0,
    paidLeaveDays: 0,
    lopDays: 0,
    lopSource: 'ATTENDANCE',
    otMinutes: 0,
    otHours: 0,
    nightShiftCount: 0,
    weekendShiftCount: 0,
    holidayShiftCount: 0,
  };

  (attendance || []).forEach((row) => {
    if (row.status === 'HALF_DAY') summary.halfDays += 1;
    else if (row.status === 'PRESENT' || row.status === 'LATE') summary.presentDays += 1;
    if (Number(row.lateMinutes) > 0) summary.lateMarks += 1;
    summary.otMinutes += Number(row.overtimeMinutes) || 0;

    if (row.shiftIsNight) summary.nightShiftCount += 1;
    if (isWeekend(row.date, row.weekendPolicy)) summary.weekendShiftCount += 1;
    if ((holidays || []).some((holiday) => holiday.date === row.date)) summary.holidayShiftCount += 1;
  });

  // §14 — LOP lives in the Leave module as soon as it owns a LOP type; until
  // then the single source of truth is attendance absence.
  (leaves || []).forEach((leave) => {
    if (lopLeaveType && leave.type === lopLeaveType) {
      summary.lopDays += Number(leave.days) || 0;
      summary.lopSource = 'LEAVE';
      return;
    }
    if (leave.status === 'APPROVED') summary.paidLeaveDays += Number(leave.days) || 0;
  });

  const counted = summary.presentDays + summary.halfDays * 0.5;
  summary.absentDays = Math.max(0, Math.round((summary.workingDays - counted) * 100) / 100);
  if (!lopLeaveType) summary.lopDays = summary.absentDays;

  summary.otHours = Math.round((summary.otMinutes / 60) * 100) / 100;

  return summary;
};
