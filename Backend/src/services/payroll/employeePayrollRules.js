// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.4 — EMPLOYEE PAYROLL PROFILE RULES (pure domain logic)
//
//  The bridge between HR and Payroll. It stores WHAT an employee is paid and
//  HOW they are paid — it never computes a monthly payroll and never creates
//  a payslip (those are later phases, §25).
//
//      Salary Structure (29.3) → Employee Payroll Profile (29.4)
//                                    → Variable Pay & Inputs (29.5)
//
//  PURE: no mongoose, no redis, no req/res. The API, the recruitment
//  conversion job and a script all behave identically.
// ═══════════════════════════════════════════════════════════════════════════

import { computeStructurePreview } from './salaryStructureRules.js';

// ── catalogues ─────────────────────────────────────────────────────────────

// §14
export const PAYROLL_STATUSES = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'SUSPENDED'];

export const PAYROLL_STATUS_LABELS = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  ON_HOLD: 'On Hold',
  SUSPENDED: 'Suspended',
};

// DRAFT → ACTIVE → ON_HOLD → ACTIVE; SUSPENDED is reversible only by HR
// re-activating through a revision, never silently.
export const PAYROLL_STATUS_TRANSITIONS = {
  DRAFT: ['ACTIVE', 'SUSPENDED'],
  ACTIVE: ['ON_HOLD', 'SUSPENDED'],
  ON_HOLD: ['ACTIVE', 'SUSPENDED'],
  SUSPENDED: ['DRAFT'],
};

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'];

export const EMPLOYMENT_TYPE_LABELS = {
  FULL_TIME: 'Full Time',
  PART_TIME: 'Part Time',
  CONTRACT: 'Contract',
  INTERN: 'Intern',
};

// §13 — designed for expansion; the company default comes from 29.1.
export const PAY_GROUPS = ['MONTHLY', 'WEEKLY', 'EXECUTIVE'];

export const PAY_GROUP_LABELS = {
  MONTHLY: 'Monthly Payroll',
  WEEKLY: 'Weekly Payroll',
  EXECUTIVE: 'Executive Payroll',
};

export const TAX_REGIMES = ['OLD', 'NEW'];

export const ACCOUNT_TYPES = ['SAVINGS', 'CURRENT'];

export const RESIDENTIAL_STATUSES = ['RESIDENT', 'NRI'];

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CHEQUE', 'CASH'];

export const PAYMENT_METHOD_LABELS = {
  BANK_TRANSFER: 'Bank Transfer',
  CHEQUE: 'Cheque',
  CASH: 'Cash',
};

// ── formats (§10 / §11) ────────────────────────────────────────────────────

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const UAN_RE = /^[0-9]{12}$/;
const ESI_RE = /^[0-9]{17}$/;
const AADHAAR_RE = /^[0-9]{12}$/;

const clean = (value, max = 120) => String(value == null ? '' : value).trim().slice(0, max);
const code = (value, max = 40) =>
  String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, '');
const digits = (value) => String(value == null ? '' : value).replace(/\D+/g, '');

export const isValidIfsc = (value) => IFSC_RE.test(code(value, 11));
export const isValidPan = (value) => PAN_RE.test(code(value, 10));
export const isValidUan = (value) => UAN_RE.test(digits(value));
export const isValidEsi = (value) => ESI_RE.test(digits(value));
export const isValidAadhaar = (value) => AADHAAR_RE.test(digits(value));
export const isValidAccountNumber = (value) => {
  const only = digits(value);
  return only.length >= 9 && only.length <= 18;
};

// §10 — the only account shape that ever leaves the server.
export const maskAccountNumber = (value) => {
  const only = digits(value);
  if (!only) return '';
  return only.length <= 4 ? only : `XXXX XXXX ${only.slice(-4)}`;
};

// §22 — audit records never carry identity numbers (project rule).
export const redactForAudit = (value) => (value ? '[REDACTED]' : '');

// ── defaults ───────────────────────────────────────────────────────────────

export const defaultEmployeePayroll = () => ({
  employeeId: null,
  structureId: null,
  annualCtc: 0,
  monthlyGross: 0,
  employmentType: 'FULL_TIME',
  payGroup: 'MONTHLY',
  payrollStatus: 'DRAFT',
  effectiveFrom: null,
  designation: '',
  bank: {
    bankName: '',
    accountHolderName: '',
    accountNumber: '',
    ifsc: '',
    branch: '',
    accountType: 'SAVINGS',
    paymentMethod: 'BANK_TRANSFER',
  },
  statutory: {
    pan: '',
    aadhaar: '',
    uan: '',
    esiNumber: '',
    pfMember: false,
    gratuityEligible: false,
  },
  tax: {
    regime: 'NEW',
    tdsApplicable: true,
    panVerified: false,
    declarationStatus: 'PENDING',
    residentialStatus: 'RESIDENT',
  },
});

// ── normalization ──────────────────────────────────────────────────────────

const toNumber = (value) => {
  if (value === '' || value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const pickEnum = (value, allowed, fallback) => {
  const wanted = code(value);
  return allowed.includes(wanted) ? wanted : fallback;
};

// Client-supplied tenant or lineage fields are dropped on purpose (§3).
export const normalizeEmployeePayroll = (input = {}) => {
  const raw = input && typeof input === 'object' ? input : {};
  const base = defaultEmployeePayroll();

  return {
    structureId: raw.structureId || null,
    annualCtc: toNumber(raw.annualCtc),
    monthlyGross: toNumber(raw.monthlyGross),
    employmentType: pickEnum(raw.employmentType, EMPLOYMENT_TYPES, base.employmentType),
    payGroup: pickEnum(raw.payGroup, PAY_GROUPS, base.payGroup),
    payrollStatus: pickEnum(raw.payrollStatus, PAYROLL_STATUSES, base.payrollStatus),
    effectiveFrom: toDateOrNull(raw.effectiveFrom),
    designation: clean(raw.designation, 80),
    bank: {
      bankName: clean(raw.bank?.bankName, 120),
      accountHolderName: clean(raw.bank?.accountHolderName, 120),
      // Only a NEW number is ever accepted; '' keeps the stored one.
      accountNumber: raw.bank?.accountNumber ? digits(raw.bank.accountNumber) : '',
      ifsc: code(raw.bank?.ifsc, 11),
      branch: clean(raw.bank?.branch, 120),
      accountType: pickEnum(raw.bank?.accountType, ACCOUNT_TYPES, base.bank.accountType),
      paymentMethod: pickEnum(raw.bank?.paymentMethod, PAYMENT_METHODS, base.bank.paymentMethod),
    },
    statutory: {
      pan: code(raw.statutory?.pan, 10),
      aadhaar: raw.statutory?.aadhaar ? digits(raw.statutory.aadhaar) : '',
      uan: raw.statutory?.uan ? digits(raw.statutory.uan) : '',
      esiNumber: raw.statutory?.esiNumber ? digits(raw.statutory.esiNumber) : '',
      pfMember: Boolean(raw.statutory?.pfMember),
      gratuityEligible: Boolean(raw.statutory?.gratuityEligible),
    },
    tax: {
      regime: pickEnum(raw.tax?.regime, TAX_REGIMES, base.tax.regime),
      tdsApplicable: raw.tax?.tdsApplicable === undefined ? base.tax.tdsApplicable : Boolean(raw.tax.tdsApplicable),
      panVerified: Boolean(raw.tax?.panVerified),
      declarationStatus: clean(raw.tax?.declarationStatus, 30) || 'PENDING',
      residentialStatus: pickEnum(raw.tax?.residentialStatus, RESIDENTIAL_STATUSES, base.tax.residentialStatus),
    },
  };
};

// ── validation (§23) ───────────────────────────────────────────────────────

// CTC = 12 × (gross + employer contributions). Rounding of a few rupees a
// month is tolerated; a wrong order of magnitude is not.
export const ctcTolerance = (annualCtc = 0) => Math.max(12, Math.round(Number(annualCtc) * 0.005));

export const validateEmployeePayroll = (
  profile,
  { statutory = {}, structure = null, existingVersions = [], selfEffectiveFrom = null } = {},
) => {
  const errors = [];
  const value = profile && typeof profile === 'object' ? profile : defaultEmployeePayroll();
  const add = (field, message) => errors.push({ field, message });

  if (!value.structureId) add('structureId', 'Select a salary structure');
  if (!structure) add('structureId', 'The selected salary structure is no longer available');
  else if (structure.status !== 'ACTIVE') {
    add('structureId', 'Only an active salary structure can be assigned');
  }

  if (!value.annualCtc || value.annualCtc <= 0) add('annualCtc', 'Annual CTC must be greater than zero');
  if (!value.monthlyGross || value.monthlyGross <= 0) {
    add('monthlyGross', 'Monthly gross must be greater than zero');
  }

  if (!PAYROLL_STATUSES.includes(value.payrollStatus)) add('payrollStatus', 'Invalid payroll status');
  if (!value.effectiveFrom) add('effectiveFrom', 'Effective date is required');

  // §23 — gross must align with CTC. Employer cost comes from the structure.
  if (structure && value.monthlyGross > 0 && value.annualCtc > 0) {
    const preview = computeStructurePreview({
      items: structure.items || [],
      components: structure.componentMap || {},
      gross: value.monthlyGross,
    });
    const expected = (value.monthlyGross + preview.totals.employerCost) * 12;
    if (Math.abs(expected - value.annualCtc) > ctcTolerance(value.annualCtc)) {
      add(
        'annualCtc',
        `CTC does not match this structure. Expected about ${Math.round(expected).toLocaleString('en-IN')} for a gross of ${Math.round(value.monthlyGross).toLocaleString('en-IN')}.`,
      );
    }
  }

  // §23 — a revision can never start on or before the one it replaces.
  if (selfEffectiveFrom && value.effectiveFrom && value.effectiveFrom < new Date(selfEffectiveFrom)) {
    add('effectiveFrom', 'A revision cannot start before the salary it replaces');
  }

  (existingVersions || []).forEach((version) => {
    if (!version?.effectiveFrom || !value.effectiveFrom) return;
    if (String(version._id) === String(value._id)) return;
    if (value.effectiveFrom.getTime() === new Date(version.effectiveFrom).getTime()) {
      add('effectiveFrom', 'Another revision already starts on this date');
    }
  });

  // §10 — bank
  if (!value.bank.bankName) add('bank.bankName', 'Bank name is required');
  if (value.bank.ifsc && !isValidIfsc(value.bank.ifsc)) add('bank.ifsc', 'IFSC must look like HDFC0001234');
  if (value.bank.accountNumber && !isValidAccountNumber(value.bank.accountNumber)) {
    add('bank.accountNumber', 'Account number must be 9 to 18 digits');
  }

  // §11 — statutory follows the company's 29.1 configuration.
  const needs = (key) => Boolean(statutory?.[key]?.applicable);

  if (value.statutory.pan && !isValidPan(value.statutory.pan)) add('statutory.pan', 'PAN must look like ABCDE1234F');
  if (value.statutory.aadhaar && !isValidAadhaar(value.statutory.aadhaar)) {
    add('statutory.aadhaar', 'Aadhaar must be 12 digits');
  }
  if (value.statutory.uan && !isValidUan(value.statutory.uan)) add('statutory.uan', 'UAN must be 12 digits');
  if (value.statutory.esiNumber && !isValidEsi(value.statutory.esiNumber)) {
    add('statutory.esiNumber', 'ESI number must be 17 digits');
  }

  // Going ACTIVE is the payroll commitment: the statutory identity must be
  // complete for everything the company actually operates (§11 / §14).
  if (value.payrollStatus === 'ACTIVE') {
    if (!value.bank.bankName) add('bank.bankName', 'Bank name is required before activating payroll');
    if (!value.bank.ifsc) add('bank.ifsc', 'IFSC is required before activating payroll');
    if (!value.bank.accountNumber && !value.bank.hasStoredAccount) {
      add('bank.accountNumber', 'Account number is required before activating payroll');
    }
    if (!value.statutory.pan) add('statutory.pan', 'PAN is required before activating payroll');
    if (needs('pf') && !value.statutory.uan) add('statutory.uan', 'UAN is required because PF applies to this company');
    if (needs('esi') && !value.statutory.esiNumber) {
      add('statutory.esiNumber', 'ESI number is required because ESI applies to this company');
    }
  }

  return errors;
};

// §21 — status changes go through the documented transitions only.
export const canChangePayrollStatus = (from, to) =>
  (PAYROLL_STATUS_TRANSITIONS[String(from || '').toUpperCase()] || []).includes(String(to || '').toUpperCase());

// ── §9 live breakup preview (display only) ─────────────────────────────────

export const computeEmployeePayrollPreview = ({ structure = null, monthlyGross = 0 } = {}) => {
  const gross = Math.max(0, Number(monthlyGross) || 0);

  if (!structure) {
    return { monthlyGross: gross, earnings: [], deductions: [], employerContributions: [], totals: null };
  }

  const preview = computeStructurePreview({
    items: structure.items || [],
    components: structure.componentMap || {},
    gross,
  });

  return {
    ...preview,
    annual: {
      gross: Math.round(preview.totals.gross * 12 * 100) / 100,
      totalDeductions: Math.round(preview.totals.totalDeductions * 12 * 100) / 100,
      netPay: Math.round(preview.totals.netPay * 12 * 100) / 100,
      employerCost: Math.round(preview.totals.employerCost * 12 * 100) / 100,
      ctc: Math.round(preview.totals.ctc * 12 * 100) / 100,
    },
  };
};

// ── §15 / §16 — revisions ──────────────────────────────────────────────────

// A change to money or structure is history: it always writes a new version.
export const isSalaryRevision = (before = {}, after = {}) =>
  Number(before.annualCtc || 0) !== Number(after.annualCtc || 0) ||
  Number(before.monthlyGross || 0) !== Number(after.monthlyGross || 0) ||
  String(before.structureId || '') !== String(after.structureId || '') ||
  (before.effectiveFrom || '')?.getTime?.() !== (after.effectiveFrom || '')?.getTime?.();

// ── serialization (§24) ────────────────────────────────────────────────────

// The full account number is never returned: the bank sub-document carries a
// masked mirror only, and the encrypted field is select:false.
export const serializeEmployeePayroll = (profile = {}) => {
  const bank = profile.bank || {};

  return {
    ...profile,
    bank: {
      ...bank,
      accountNumber: undefined,
      hasAccount: Boolean(bank.accountNumberMasked),
    },
  };
};
