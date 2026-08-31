// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.1 — COMPANY PAYROLL SETUP — PURE RULES
//
//  This module is PURE: no Mongoose, no Redis, no network, no Date.now().
//  Everything in here is unit-testable without infrastructure (the
//  hermetic suite test/payrollSetup.test.js is built on it).
//
//  RESPONSIBILITY (§10 of the phase brief):
//    This phase decides WHAT APPLIES to a company.
//    It never decides HOW MUCH anything is — that belongs to the
//    later payroll engine phases. No statutory FORMULAS live here.
//
//  Reuses the attendance/shift weekend vocabulary (scheduleEngine.DAY_KEYS)
//  instead of inventing a second weekly-off model.
// ═══════════════════════════════════════════════════════════════════════════

import { DAY_KEYS } from '../../utils/scheduleEngine.js';

// ── Enums ──────────────────────────────────────────────────────────────────

export const PAYROLL_SETUP_STATUS = Object.freeze([
  'NOT_CONFIGURED',
  'DRAFT',
  'CONFIGURED',
  'ACTIVE',
  'SUSPENDED',
]);

// The four wizard sections (§5). Review & Activate is NOT a data section —
// it is the activation gate evaluated from these four.
export const PAYROLL_SETUP_SECTIONS = Object.freeze([
  { key: 'LEGAL', label: 'Company & Legal Information', step: 1 },
  { key: 'STATUTORY', label: 'Statutory Configuration', step: 2 },
  { key: 'POLICY', label: 'Payroll Policy', step: 3 },
  { key: 'BANK', label: 'Company Bank Account', step: 4 },
]);

export const PAYROLL_SETUP_SECTION_KEYS = Object.freeze(
  PAYROLL_SETUP_SECTIONS.map((section) => section.key),
);

export const PAYROLL_FREQUENCIES = Object.freeze([
  'MONTHLY',
  'WEEKLY',
  'BIWEEKLY',
  'SEMIMONTHLY',
]);

// Only MONTHLY is activatable today; the others are accepted by the model
// (forward-compatible, §11) but blocked at the activation gate.
export const ACTIVATABLE_FREQUENCIES = Object.freeze(['MONTHLY']);

export const PAYROLL_CYCLE_TYPES = Object.freeze([
  'FIXED_MONTH_DAY',
  'CUSTOM_RANGE',
]);

export const PAYMENT_DATE_TYPES = Object.freeze([
  'SPECIFIC_DAY',
  'LAST_WORKING_DAY',
  'CUSTOM',
]);

export const WEEKEND_POLICY_TYPES = Object.freeze([
  'SAT_SUN',
  'SUN_ONLY',
  'CUSTOM',
]);

export const LOP_POLICY_BASIS = Object.freeze([
  'PER_DAY',
  'PER_HOUR',
  'PAYABLE_WORKING_DAYS',
]);

export const OVERTIME_BASIS = Object.freeze(['HOURLY', 'FIXED', 'CUSTOM']);

export const BANK_ACCOUNT_TYPES = Object.freeze(['SAVINGS', 'CURRENT', 'OTHER']);

// ── Format validators (§7) ─────────────────────────────────────────────────

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^[0-9]{8,18}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const REFERENCE_PREFIX_RE = /^[A-Z0-9]{2,20}$/;

export const normalizeCode = (value) => String(value ?? '').trim().toUpperCase();
export const digitsOnly = (value) => String(value ?? '').replace(/\D+/g, '');

export const isValidPan = (value) => PAN_RE.test(normalizeCode(value));
export const isValidTan = (value) => TAN_RE.test(normalizeCode(value));
export const isValidGst = (value) => GST_RE.test(normalizeCode(value));
export const isValidCin = (value) => CIN_RE.test(normalizeCode(value));
export const isValidIfsc = (value) => IFSC_RE.test(normalizeCode(value));
export const isValidAccountNumber = (value) => ACCOUNT_RE.test(digitsOnly(value));
export const isValidCurrency = (value) => CURRENCY_RE.test(normalizeCode(value));
export const isValidReferencePrefix = (value) =>
  REFERENCE_PREFIX_RE.test(normalizeCode(value));

// ── Masking (§17) — the ONLY shape the API ever returns ────────────────────

export const maskAccountNumber = (value) => {
  const digits = digitsOnly(value);
  if (!digits) return '';
  const last4 = digits.slice(-4);
  // Fixed display mask — the real length is never disclosed either.
  return digits.length <= 4 ? last4 : `XXXX XXXX ${last4}`;
};

// ── Default configuration shape ────────────────────────────────────────────
// Shared by the Mongoose defaults and by the "no configuration yet"
// response, so an untouched company and a freshly started setup are
// byte-identical to the frontend.

export const defaultPayrollSetupConfiguration = () => ({
  legal: {
    legalName: '',
    pan: '',
    tan: '',
    gst: '',
    cin: '',
    addressLine: '',
    city: '',
    state: '',
    pincode: '',
    country: 'India',
  },
  statutory: {
    pf: { applicable: false, establishmentNumber: '', registrationDate: null },
    esi: { applicable: false, registrationNumber: '' },
    professionalTax: { applicable: false, state: '' },
    labourWelfareFund: { applicable: false, state: '' },
    gratuity: { applicable: false },
    tds: { applicable: false },
  },
  payrollPolicy: {
    frequency: 'MONTHLY',
    cycleType: 'FIXED_MONTH_DAY',
    cycleStartDay: 1,
    cycleEndDay: 31,
    paymentDateType: 'SPECIFIC_DAY',
    paymentDayOfMonth: 30,
    paymentMonthOffset: 0,
    currency: 'INR',
    financialYearStartMonth: 4,
    weekendPolicy: { type: 'SAT_SUN', customWorkingDays: [] },
    lopPolicy: { basis: 'PER_DAY' },
    overtimePolicy: { enabled: false, basis: 'HOURLY', multiplier: 1 },
    processingDeadlineDay: 25,
    lockRequiresReopen: true,
  },
  bankAccount: {
    bankName: '',
    accountHolderName: '',
    ifsc: '',
    branch: '',
    accountType: 'CURRENT',
    paymentReferencePrefix: '',
  },
});

// ── Weekend policy → working days (§12, reuses scheduleEngine) ─────────────

export const weekendPolicyToWorkingDays = (weekendPolicy = {}) => {
  const { type, customWorkingDays = [] } = weekendPolicy || {};
  if (type === 'CUSTOM') {
    const custom = DAY_KEYS.filter((day) => customWorkingDays.includes(day));
    if (custom.length > 0) return custom;
  }
  if (type === 'SUN_ONLY') return DAY_KEYS.filter((day) => day !== 'SUN');
  return DAY_KEYS.filter((day) => day !== 'SAT' && day !== 'SUN');
};

const MON_FIRST = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export const weekendPolicySummary = (weekendPolicy = {}) => {
  const workingDays = weekendPolicyToWorkingDays(weekendPolicy);
  const offDays = MON_FIRST.filter((day) => !workingDays.includes(day));
  const range = `${workingDays[0]}–${workingDays[workingDays.length - 1]}`;
  return {
    workingDays,
    offDays,
    label: offDays.length ? `${range} working (${offDays.join('+')} off)` : 'All days working',
  };
};

// ── Section validators ─────────────────────────────────────────────────────
// Every validator returns [{ field, message }]. Empty array = valid.
// `partial` = draft/autosave mode: only FORMAT is checked, required fields
// are allowed to be blank (§32 — the wizard must save half-finished work).

export const validateLegalSection = (legal = {}, { partial = false } = {}) => {
  const errors = [];
  const legalName = String(legal.legalName ?? '').trim();
  const pan = normalizeCode(legal.pan);
  const tan = normalizeCode(legal.tan);
  const gst = normalizeCode(legal.gst);
  const cin = normalizeCode(legal.cin);
  const state = String(legal.state ?? '').trim();
  const country = String(legal.country ?? '').trim();

  if (!legalName && !partial) {
    errors.push({ field: 'legal.legalName', message: 'Legal company name is required' });
  }
  if (legalName && legalName.length < 2) {
    errors.push({ field: 'legal.legalName', message: 'Legal company name is too short' });
  }
  if (!state && !partial) {
    errors.push({ field: 'legal.state', message: 'State is required (statutory rules depend on it)' });
  }
  if (!country && !partial) {
    errors.push({ field: 'legal.country', message: 'Country is required' });
  }
  if (pan && !isValidPan(pan)) {
    errors.push({ field: 'legal.pan', message: 'PAN must look like ABCDE1234F' });
  }
  if (tan && !isValidTan(tan)) {
    errors.push({ field: 'legal.tan', message: 'TAN must look like ABCD12345E' });
  }
  if (gst && !isValidGst(gst)) {
    errors.push({ field: 'legal.gst', message: 'GST number format is invalid' });
  }
  if (cin && !isValidCin(cin)) {
    errors.push({ field: 'legal.cin', message: 'CIN format is invalid' });
  }
  return errors;
};

export const validateStatutorySection = (statutory = {}, { partial = false, pan = '' } = {}) => {
  const errors = [];
  const section = statutory || {};
  const pf = section.pf || {};
  const esi = section.esi || {};
  const pt = section.professionalTax || {};
  const lwf = section.labourWelfareFund || {};
  const tds = section.tds || {};

  // §9 — conditional requirements: registration fields are required ONLY
  // when the corresponding component is switched on.
  if (pf.applicable) {
    const number = String(pf.establishmentNumber ?? '').trim();
    if (!number && !partial) {
      errors.push({
        field: 'statutory.pf.establishmentNumber',
        message: 'PF establishment number is required when PF is applicable',
      });
    }
    if (number && (number.length < 5 || number.length > 30)) {
      errors.push({
        field: 'statutory.pf.establishmentNumber',
        message: 'PF establishment number must be 5–30 characters',
      });
    }
  }
  if (esi.applicable) {
    const number = String(esi.registrationNumber ?? '').trim();
    if (!number && !partial) {
      errors.push({
        field: 'statutory.esi.registrationNumber',
        message: 'ESI registration number is required when ESI is applicable',
      });
    }
    if (number && (number.length < 8 || number.length > 20)) {
      errors.push({
        field: 'statutory.esi.registrationNumber',
        message: 'ESI registration number must be 8–20 characters',
      });
    }
  }
  if (pt.applicable && !String(pt.state ?? '').trim() && !partial) {
    errors.push({
      field: 'statutory.professionalTax.state',
      message: 'Professional Tax state is required when PT is applicable',
    });
  }
  if (lwf.applicable && !String(lwf.state ?? '').trim() && !partial) {
    errors.push({
      field: 'statutory.labourWelfareFund.state',
      message: 'Labour Welfare Fund state is required when LWF is applicable',
    });
  }
  // §7 — PAN is only mandatory where the company actually deducts TDS.
  if (tds.applicable && !normalizeCode(pan) && !partial) {
    errors.push({
      field: 'legal.pan',
      message: 'PAN is required when TDS is applicable',
    });
  }
  return errors;
};

export const validatePolicySection = (policy = {}, { partial = false } = {}) => {
  const errors = [];
  const section = policy || {};
  const frequency = normalizeCode(section.frequency);
  const cycleType = normalizeCode(section.cycleType);
  const paymentDateType = normalizeCode(section.paymentDateType);
  const weekend = section.weekendPolicy || {};
  const overtime = section.overtimePolicy || {};

  if (frequency && !PAYROLL_FREQUENCIES.includes(frequency)) {
    errors.push({ field: 'payrollPolicy.frequency', message: 'Unsupported payroll frequency' });
  }
  // §11 — the model carries weekly/biweekly/semimonthly forward, but only
  // monthly payroll can be activated in this phase.
  if (!partial && frequency && !ACTIVATABLE_FREQUENCIES.includes(frequency)) {
    errors.push({
      field: 'payrollPolicy.frequency',
      message: 'Only monthly payroll can be activated in this phase',
    });
  }
  if (cycleType && !PAYROLL_CYCLE_TYPES.includes(cycleType)) {
    errors.push({ field: 'payrollPolicy.cycleType', message: 'Unsupported payroll cycle type' });
  }

  const startDay = Number(section.cycleStartDay);
  const endDay = Number(section.cycleEndDay);
  if (Number.isFinite(startDay) && (startDay < 1 || startDay > 31)) {
    errors.push({ field: 'payrollPolicy.cycleStartDay', message: 'Cycle start day must be 1–31' });
  }
  if (Number.isFinite(endDay) && (endDay < 1 || endDay > 31)) {
    errors.push({ field: 'payrollPolicy.cycleEndDay', message: 'Cycle end day must be 1–31' });
  }
  // 26→25 is legal; 1→31 is legal; 1→1 is not
  if (!partial && Number.isFinite(startDay) && Number.isFinite(endDay) && startDay === endDay) {
    errors.push({
      field: 'payrollPolicy.cycleEndDay',
      message: 'Cycle end day must differ from the cycle start day',
    });
  }

  if (paymentDateType && !PAYMENT_DATE_TYPES.includes(paymentDateType)) {
    errors.push({
      field: 'payrollPolicy.paymentDateType',
      message: 'Unsupported salary payment date type',
    });
  }
  const paymentDay = Number(section.paymentDayOfMonth);
  if (paymentDateType === 'SPECIFIC_DAY' || paymentDateType === 'CUSTOM') {
    if (!Number.isFinite(paymentDay) || paymentDay < 1 || paymentDay > 31) {
      errors.push({
        field: 'payrollPolicy.paymentDayOfMonth',
        message: 'Salary payment day must be between 1 and 31',
      });
    }
  }
  const monthOffset = Number(section.paymentMonthOffset ?? 0);
  if (!Number.isInteger(monthOffset) || monthOffset < 0 || monthOffset > 1) {
    errors.push({
      field: 'payrollPolicy.paymentMonthOffset',
      message: 'Payment month offset must be 0 (same month) or 1 (following month)',
    });
  }

  const currency = normalizeCode(section.currency);
  if (currency && !isValidCurrency(currency)) {
    errors.push({ field: 'payrollPolicy.currency', message: 'Currency must be a 3-letter code' });
  }

  const fyMonth = Number(section.financialYearStartMonth);
  if (Number.isFinite(fyMonth) && (fyMonth < 1 || fyMonth > 12)) {
    errors.push({
      field: 'payrollPolicy.financialYearStartMonth',
      message: 'Financial year start month must be 1–12',
    });
  }

  const weekendType = normalizeCode(weekend.type);
  if (weekendType && !WEEKEND_POLICY_TYPES.includes(weekendType)) {
    errors.push({ field: 'payrollPolicy.weekendPolicy.type', message: 'Unsupported weekend policy' });
  }
  if (weekendType === 'CUSTOM') {
    const custom = Array.isArray(weekend.customWorkingDays) ? weekend.customWorkingDays : [];
    const valid = custom.filter((day) => DAY_KEYS.includes(normalizeCode(day)));
    if (!partial && valid.length === 0) {
      errors.push({
        field: 'payrollPolicy.weekendPolicy.customWorkingDays',
        message: 'Select at least one working day for the custom weekend policy',
      });
    }
    if (valid.length !== custom.length) {
      errors.push({
        field: 'payrollPolicy.weekendPolicy.customWorkingDays',
        message: 'Custom working days must be one of SUN, MON, TUE, WED, THU, FRI, SAT',
      });
    }
  }

  const lopBasis = normalizeCode(section.lopPolicy?.basis);
  if (lopBasis && !LOP_POLICY_BASIS.includes(lopBasis)) {
    errors.push({ field: 'payrollPolicy.lopPolicy.basis', message: 'Unsupported loss-of-pay basis' });
  }

  if (overtime.enabled) {
    const otBasis = normalizeCode(overtime.basis);
    if (otBasis && !OVERTIME_BASIS.includes(otBasis)) {
      errors.push({
        field: 'payrollPolicy.overtimePolicy.basis',
        message: 'Unsupported overtime calculation basis',
      });
    }
    const multiplier = Number(overtime.multiplier ?? 1);
    if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 5) {
      errors.push({
        field: 'payrollPolicy.overtimePolicy.multiplier',
        message: 'Overtime multiplier must be between 1 and 5',
      });
    }
  }

  const deadline = Number(section.processingDeadlineDay);
  if (Number.isFinite(deadline) && (deadline < 1 || deadline > 31)) {
    errors.push({
      field: 'payrollPolicy.processingDeadlineDay',
      message: 'Payroll processing deadline must be between 1 and 31',
    });
  }
  return errors;
};

export const validateBankSection = (bank = {}, { partial = false, hasAccountNumber = false } = {}) => {
  const errors = [];
  const section = bank || {};
  const bankName = String(section.bankName ?? '').trim();
  const holder = String(section.accountHolderName ?? '').trim();
  const ifsc = normalizeCode(section.ifsc);
  const accountType = normalizeCode(section.accountType);
  const prefix = normalizeCode(section.paymentReferencePrefix);
  const accountNumber = digitsOnly(section.accountNumber);

  if (!bankName && !partial) {
    errors.push({ field: 'bankAccount.bankName', message: 'Bank name is required' });
  }
  if (!holder && !partial) {
    errors.push({
      field: 'bankAccount.accountHolderName',
      message: 'Account holder name is required',
    });
  }
  if (accountNumber && !isValidAccountNumber(accountNumber)) {
    errors.push({
      field: 'bankAccount.accountNumber',
      message: 'Account number must contain 8–18 digits',
    });
  }
  if (!accountNumber && !partial && !hasAccountNumber) {
    errors.push({ field: 'bankAccount.accountNumber', message: 'Account number is required' });
  }
  if (ifsc && !isValidIfsc(ifsc)) {
    errors.push({ field: 'bankAccount.ifsc', message: 'IFSC must look like HDFC0001234' });
  }
  if (!ifsc && !partial) {
    errors.push({ field: 'bankAccount.ifsc', message: 'IFSC is required' });
  }
  if (accountType && !BANK_ACCOUNT_TYPES.includes(accountType)) {
    errors.push({ field: 'bankAccount.accountType', message: 'Unsupported account type' });
  }
  if (prefix && !isValidReferencePrefix(prefix)) {
    errors.push({
      field: 'bankAccount.paymentReferencePrefix',
      message: 'Payment reference prefix must be 2–20 letters or digits',
    });
  }
  return errors;
};

// ── Whole-configuration evaluation (drives §30 progress + §21 gate) ────────

export const evaluateConfiguration = (config = {}, { partial = false, savedSections = null } = {}) => {
  const legal = config.legal || {};
  const statutory = config.statutory || {};
  const policy = config.payrollPolicy || {};
  const bank = config.bankAccount || {};

  const legalErrors = validateLegalSection(legal, { partial });
  const statutoryErrors = validateStatutorySection(statutory, { partial, pan: legal.pan });
  const policyErrors = validatePolicySection(policy, { partial });
  const bankErrors = validateBankSection(bank, {
    partial,
    hasAccountNumber: Boolean(bank.accountNumberLast4),
  });

  const errorsBySection = {
    LEGAL: legalErrors,
    STATUTORY: statutoryErrors,
    POLICY: policyErrors,
    BANK: bankErrors,
  };

  // A section only counts as complete once it is valid AND the
  // administrator has actually saved it — untouched defaults must never
  // read as "2 / 4 completed" (§30).
  const sections = PAYROLL_SETUP_SECTIONS.map((section) => {
    const errors = errorsBySection[section.key];
    const saved = Array.isArray(savedSections) ? savedSections.includes(section.key) : true;
    return { ...section, errors, complete: errors.length === 0 && saved };
  });

  const completedCount = sections.filter((section) => section.complete).length;

  return {
    sections,
    completedCount,
    totalCount: PAYROLL_SETUP_SECTIONS.length,
    allComplete: completedCount === PAYROLL_SETUP_SECTIONS.length,
    errors: errorsBySection,
    warnings: buildWarnings(config),
  };
};

// Non-blocking advice shown on the review step (§20).
export const buildWarnings = (config = {}) => {
  const warnings = [];
  const statutory = config.statutory || {};
  const policy = config.payrollPolicy || {};
  const bank = config.bankAccount || {};

  if (!statutory.pf?.applicable && !statutory.esi?.applicable) {
    warnings.push({
      code: 'NO_STATUTORY_COMPONENTS',
      message: 'No statutory components are enabled. Statutory deductions will be skipped until PF or ESI is switched on.',
    });
  }
  if (statutory.tds?.applicable && !config.legal?.pan) {
    warnings.push({
      code: 'TDS_WITHOUT_PAN',
      message: 'TDS is enabled but the company PAN is missing.',
    });
  }
  if (policy.overtimePolicy?.enabled && !policy.overtimePolicy?.basis) {
    warnings.push({
      code: 'OVERTIME_WITHOUT_BASIS',
      message: 'Overtime is enabled without a calculation basis.',
    });
  }
  if (!bank.paymentReferencePrefix) {
    warnings.push({
      code: 'NO_PAYMENT_REFERENCE',
      message: 'No payment reference prefix set — payment batches will use a generated reference.',
    });
  }
  return warnings;
};

export const canActivate = (evaluation) => Boolean(evaluation?.allComplete);

// ── Status machine (§4) ────────────────────────────────────────────────────

const TRANSITIONS = Object.freeze({
  NOT_CONFIGURED: ['DRAFT'],
  DRAFT: ['CONFIGURED'],
  CONFIGURED: ['DRAFT', 'ACTIVE', 'SUSPENDED'],
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'CONFIGURED', 'DRAFT'],
});

export const canTransition = (from, to) =>
  Boolean(TRANSITIONS[from]?.includes(to));

export const ACTIVATABLE_STATUSES = Object.freeze(['DRAFT', 'CONFIGURED', 'SUSPENDED']);
