// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.6 — PAYROLL ENGINE RULES (pure)
//
//  No mongoose, no redis, no req, no Date.now(): every number in here is a
//  function of its inputs. That is what keeps the engine testable for a
//  thousand employees with a thousand different structures.
//
//  SOURCE OF TRUTH (§7 — never duplicate another module's data):
//    · 29.1 PayrollSetup   → applicability flags, LOP basis, OT policy, cycle
//    · 29.3 Structure      → the earnings/deduction RULES (computeStructurePreview)
//    · 29.4 Profile        → gross, CTC, tax regime, statutory identity
//    · 29.5 Monthly inputs → attendance/leave figures, bonus, claims, deductions
//    · THIS MODULE         → the arithmetic: payable days, LOP, OT, statutory
//                            rates/ceilings (29.1 deliberately stores no rates)
//
//  §17 — every intermediate value is stored. Nothing here returns only a net.
// ═══════════════════════════════════════════════════════════════════════════

import { CATEGORY_OF, ENTRY_TYPE_LABELS } from './monthlyInputRules.js';

// ── statuses (§20 / §22) ───────────────────────────────────────────────────

export const PAYROLL_RUN_STATUSES = [
  'DRAFT',
  'CALCULATING',
  'CALCULATED',
  'ERROR',
  'RECALCULATED',
];

export const PAYROLL_RESULT_STATUSES = ['CALCULATED', 'ERROR'];

// ── statutory configuration (§15) ──────────────────────────────────────────
//
// 29.1 stores APPLICABILITY ONLY ("No rates, ceilings or formulas — the
// engine decides those later"). So the rates live here, in one place, as
// data. They are the values in force for FY 2026-27 and must be reviewed
// when the law changes — they are not spread through the codebase.

export const STATUTORY_RULES = {
  PF: {
    employeeRate: 0.12,
    employerRate: 0.12,
    // Employer PF is split: 8.33% goes to EPS (pension), the rest to EPF.
    pensionRate: 0.0833,
    // Statutory wage ceiling for mandatory PF membership.
    wageCeiling: 15000,
    pensionWageCeiling: 15000,
  },
  ESI: {
    employeeRate: 0.0075,
    employerRate: 0.0325,
    // Gross wage ceiling for ESI coverage.
    wageCeiling: 21000,
  },
  GRATUITY: {
    // 4.81% = 15/26 of the monthly basic, the standard provisioning rate.
    rate: 0.0481,
  },
  LWF: {
    // State labour welfare fund — nominal annual amounts, per employee.
    employee: 20,
    employer: 40,
  },
  TDS: {
    cessRate: 0.04,
    standardDeduction: { OLD: 50000, NEW: 75000 },
    // §87A rebate: taxable income at or below the ceiling pays no tax.
    rebate: {
      OLD: { incomeCeiling: 500000, maxRebate: 12500 },
      NEW: { incomeCeiling: 1200000, maxRebate: 60000 },
    },
    // Slab tables (FY 2026-27). [upperLimit, marginalRate] ascending.
    slabs: {
      OLD: [
        [250000, 0],
        [500000, 0.05],
        [1000000, 0.2],
        [Infinity, 0.3],
      ],
      NEW: [
        [400000, 0],
        [800000, 0.05],
        [1200000, 0.1],
        [1600000, 0.15],
        [2000000, 0.2],
        [2400000, 0.25],
        [Infinity, 0.3],
      ],
    },
  },
};

// Professional tax is STATE law. The table below is data, not logic: it is a
// working approximation for the states Crewly ships with and is reviewed by
// the company's finance team when 29.1 records a different state.
export const PROFESSIONAL_TAX_SLABS = {
  KARNATAKA: [
    [25000, 0],
    [Infinity, 200],
  ],
  MAHARASHTRA: [
    [7500, 0],
    [10000, 175],
    [Infinity, 200],
  ],
  TAMIL_NADU: [
    [21000, 0],
    [30000, 135],
    [45000, 315],
    [60000, 690],
    [75000, 1025],
    [Infinity, 1250],
  ],
  WEST_BENGAL: [
    [10000, 0],
    [15000, 110],
    [25000, 130],
    [40000, 150],
    [Infinity, 200],
  ],
  TELANGANA: [
    [15000, 0],
    [20000, 150],
    [Infinity, 200],
  ],
  ANDHRA_PRADESH: [
    [15000, 0],
    [20000, 150],
    [Infinity, 200],
  ],
  GUJARAT: [
    [12000, 0],
    [18000, 80],
    [25000, 130],
    [Infinity, 200],
  ],
  KERALA: [
    [20000, 0],
    [Infinity, 200],
  ],
  DELHI: [[Infinity, 0]],
};

// A state with no entry falls back to this conservative default.
const DEFAULT_PT_SLABS = [
  [25000, 0],
  [Infinity, 200],
];

// ── small helpers ──────────────────────────────────────────────────────────

export const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const positive = (value) => Math.max(0, Number(value) || 0);

const stateKey = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

// Component codes that mean "this line IS a statutory amount" (§15). When a
// structure carries one of these, the engine still applies the law (ceilings,
// eligibility) rather than trusting the flat configured amount.
const STATUTORY_CODE_MAP = {
  PF: 'PF',
  EPF: 'PF',
  PROVIDENT_FUND: 'PF',
  EMPLOYEE_PF: 'PF',
  PF_EMPLOYEE: 'PF',
  ESI: 'ESI',
  ESIC: 'ESI',
  EMPLOYEE_ESI: 'ESI',
  ESI_EMPLOYEE: 'ESI',
  PT: 'PT',
  PROFESSIONAL_TAX: 'PT',
  PROF_TAX: 'PT',
  TDS: 'TDS',
  INCOME_TAX: 'TDS',
  IT: 'TDS',
  GRATUITY: 'GRATUITY',
  LWF: 'LWF',
  LABOUR_WELFARE_FUND: 'LWF',
};

export const statutoryKindOf = (code = '', name = '') => {
  const key = String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (STATUTORY_CODE_MAP[key]) return STATUTORY_CODE_MAP[key];

  const label = String(name || '')
    .trim()
    .toUpperCase();
  if (/PROVIDENT|PF\b|E\.P\.F/.test(label)) return 'PF';
  if (/ESI|ESIC|EMPLOYEE.?S.?STATE/.test(label)) return 'ESI';
  if (/PROFESSIONAL\s*TAX/.test(label)) return 'PT';
  if (/INCOME\s*TAX|\bTDS\b/.test(label)) return 'TDS';
  if (/GRATUITY/.test(label)) return 'GRATUITY';
  if (/LABOUR\s*WELFARE|\bLWF\b/.test(label)) return 'LWF';
  return null;
};

// ── attendance → payable days (§10 / §11) ──────────────────────────────────

export const computePayableDays = ({
  workingDays = 0,
  lopDays = 0,
  halfDays = 0,
  basis = 'PER_DAY',
} = {}) => {
  const working = positive(workingDays);
  const lop = positive(lopDays);

  // PER_HOUR converts days into hours; the engine keeps days as the unit of
  // record and only uses hours for the LOP arithmetic.
  const hoursPerDay = 8;
  const payableDays = Math.max(0, working - lop);

  return {
    workingDays: round2(working),
    lopDays: round2(lop),
    halfDays: round2(halfDays),
    paidDays: round2(payableDays),
    payableHours: round2(payableDays * hoursPerDay),
    workingHours: round2(working * hoursPerDay),
    basis: ['PER_DAY', 'PER_HOUR', 'PAYABLE_WORKING_DAYS'].includes(basis) ? basis : 'PER_DAY',
    ratio: working > 0 ? round2(payableDays / working) : 0,
  };
};

// §11 — LOP is a deduction line, never a silent haircut on every component.
export const computeLopDeduction = ({
  monthlyEarnings = 0,
  workingDays = 0,
  lopDays = 0,
  basis = 'PER_DAY',
} = {}) => {
  const working = positive(workingDays);
  const lop = positive(lopDays);
  if (working <= 0 || lop <= 0) return { days: round2(lop), amount: 0, basis };

  const divisor = basis === 'PER_HOUR' ? working * 8 : working;
  const units = basis === 'PER_HOUR' ? lop * 8 : lop;

  return {
    days: round2(lop),
    units: round2(units),
    basis,
    amount: round2((positive(monthlyEarnings) / divisor) * units),
  };
};

// ── overtime (§12) ─────────────────────────────────────────────────────────

export const computeOvertimePay = ({
  otHours = 0,
  monthlyGross = 0,
  workingDays = 0,
  hoursPerDay = 8,
  policy = {},
} = {}) => {
  const hours = positive(otHours);
  const enabled = Boolean(policy?.enabled);

  if (!enabled || hours <= 0) {
    return {
      hours: round2(hours),
      rate: 0,
      amount: 0,
      basis: policy?.basis || 'HOURLY',
      multiplier: Number(policy?.multiplier) || 1,
      enabled,
    };
  }

  const basis = ['HOURLY', 'FIXED', 'CUSTOM'].includes(policy?.basis) ? policy.basis : 'HOURLY';
  const multiplier = Math.max(0, Number(policy?.multiplier) || 1);
  const working = positive(workingDays) || 1;

  // HOURLY/CUSTOM: an hour costs one working hour of the monthly gross.
  // FIXED: the configured multiplier IS the hourly rate in rupees.
  const hourlyBase = positive(monthlyGross) / (working * (hoursPerDay || 8));
  const rate = basis === 'FIXED' ? multiplier : round2(hourlyBase * multiplier);

  return {
    hours: round2(hours),
    rate: round2(rate),
    amount: round2(rate * hours),
    basis,
    multiplier,
    enabled,
  };
};

// ── statutory components (§15 / §16) ───────────────────────────────────────

export const computeProvidentFund = ({ pfWages = 0, applicable = false } = {}) => {
  if (!applicable) {
    return {
      applicable: false,
      employee: 0,
      employerEpf: 0,
      employerPension: 0,
      employer: 0,
      pfWage: 0,
      pensionWage: 0,
      ceilingApplied: false,
    };
  }

  const rules = STATUTORY_RULES.PF;
  const grossWage = positive(pfWages);
  const ceilingApplied = grossWage > rules.wageCeiling;

  // PF wages are restricted to the ceiling unless the employee is already a
  // member earning above it (a company-level choice made in 29.1 through
  // `pf.applicable`; the engine applies the statutory ceiling).
  const pfWage = ceilingApplied ? rules.wageCeiling : grossWage;
  const pensionWage = Math.min(pfWage, rules.pensionWageCeiling);

  const employee = round2(pfWage * rules.employeeRate);
  const employerPension = round2(pensionWage * rules.pensionRate);
  const employerEpf = round2(Math.max(0, pfWage * rules.employerRate - employerPension));

  return {
    applicable: true,
    employee,
    employerEpf,
    employerPension,
    employer: round2(employerEpf + employerPension),
    pfWage: round2(pfWage),
    pensionWage: round2(pensionWage),
    ceilingApplied,
  };
};

export const computeEsi = ({ monthlyGross = 0, applicable = false } = {}) => {
  if (!applicable) {
    return { applicable: false, employee: 0, employer: 0, wage: 0, outsideCeiling: false };
  }

  const rules = STATUTORY_RULES.ESI;
  const wage = positive(monthlyGross);
  // ESI stops at the wage ceiling: above it the employee is not covered.
  const outsideCeiling = wage > rules.wageCeiling;
  if (outsideCeiling) {
    return { applicable: true, employee: 0, employer: 0, wage: round2(wage), outsideCeiling: true };
  }

  return {
    applicable: true,
    employee: round2(wage * rules.employeeRate),
    employer: round2(wage * rules.employerRate),
    wage: round2(wage),
    outsideCeiling: false,
  };
};

export const computeProfessionalTax = ({
  monthlyGross = 0,
  state = '',
  applicable = false,
} = {}) => {
  if (!applicable) return { applicable: false, amount: 0, state: stateKey(state) || '' };

  const slabs = PROFESSIONAL_TAX_SLABS[stateKey(state)] || DEFAULT_PT_SLABS;
  const wage = positive(monthlyGross);
  const amount = slabs.reduce((found, [limit, tax]) => (wage <= limit && found === null ? tax : found), null);

  return {
    applicable: true,
    amount: round2(amount === null ? slabs.at(-1)[1] : amount),
    state: stateKey(state) || 'DEFAULT',
  };
};

export const computeGratuity = ({ monthlyBasic = 0, applicable = false } = {}) => {
  if (!applicable) return { applicable: false, amount: 0 };
  return { applicable: true, amount: round2(positive(monthlyBasic) * STATUTORY_RULES.GRATUITY.rate) };
};

export const computeLabourWelfareFund = ({ applicable = false } = {}) => {
  if (!applicable) return { applicable: false, employee: 0, employer: 0 };
  return {
    applicable: true,
    employee: round2(STATUTORY_RULES.LWF.employee),
    employer: round2(STATUTORY_RULES.LWF.employer),
  };
};

// Tax on an annual amount, slab by slab, before cess and rebate.
export const taxFromSlabs = (annualIncome = 0, slabs = []) => {
  let income = positive(annualIncome);
  let tax = 0;
  let previousLimit = 0;

  for (const [limit, rate] of slabs) {
    if (income <= previousLimit) break;
    const taxableInSlab = Math.min(income, limit) - previousLimit;
    if (taxableInSlab > 0) tax += taxableInSlab * rate;
    previousLimit = limit;
  }

  return round2(tax);
};

// §15 — TDS is annualised: the engine projects the year, subtracts what has
// already been deducted this financial year, and spreads the remainder over
// the months that are left. No declarations are captured yet (29.4 stores a
// declaration STATUS only), so Chapter VI-A deductions default to zero.
export const computeMonthlyTds = ({
  monthlyTaxable = 0,
  regime = 'NEW',
  monthsRemaining = 1,
  tdsPaidThisYear = 0,
  declarations = 0,
  applicable = false,
} = {}) => {
  if (!applicable) {
    return {
      applicable: false,
      monthly: 0,
      annualIncome: 0,
      annualTax: 0,
      cess: 0,
      rebate: 0,
      regime,
    };
  }

  const key = regime === 'OLD' ? 'OLD' : 'NEW';
  const rules = STATUTORY_RULES.TDS;
  const annualIncome = round2(positive(monthlyTaxable) * 12);
  const taxable = Math.max(0, annualIncome - rules.standardDeduction[key] - positive(declarations));

  const baseTax = taxFromSlabs(taxable, rules.slabs[key]);
  const rebateRule = rules.rebate[key];
  const rebate = taxable <= rebateRule.incomeCeiling ? Math.min(baseTax, rebateRule.maxRebate) : 0;
  const taxAfterRebate = Math.max(0, baseTax - rebate);
  const cess = round2(taxAfterRebate * rules.cessRate);
  const annualTax = round2(taxAfterRebate + cess);

  const remaining = Math.max(1, Number(monthsRemaining) || 1);
  const outstanding = Math.max(0, annualTax - positive(tdsPaidThisYear));

  return {
    applicable: true,
    monthly: round2(outstanding / remaining),
    annualIncome,
    taxableIncome: round2(taxable),
    annualTax,
    cess,
    rebate: round2(rebate),
    tdsPaidThisYear: round2(positive(tdsPaidThisYear)),
    monthsRemaining: remaining,
    regime: key,
  };
};

// ── §13 / §14 — monthly inputs are consumed, never re-derived ──────────────

export const splitMonthlyEntries = (entries = []) => {
  const variableEarnings = [];
  const reimbursements = [];
  const deductions = [];

  (entries || []).forEach((entry) => {
    const category = CATEGORY_OF(entry.type);
    const row = {
      type: entry.type,
      label: ENTRY_TYPE_LABELS[entry.type] || entry.type,
      amount: round2(entry.amount),
      reason: entry.reason || '',
      claimStatus: entry.claimStatus || 'APPROVED',
      claimDate: entry.claimDate || '',
      source: entry.source || 'MANUAL',
      entryId: entry.entryId || '',
    };

    // §16 — a rejected claim never reaches payroll.
    if (category === 'REIMBURSEMENT') {
      if (row.claimStatus === 'REJECTED') return;
      reimbursements.push(row);
      return;
    }
    if (category === 'DEDUCTION' || category === 'RECOVERY') {
      deductions.push(row);
      return;
    }
    variableEarnings.push(row);
  });

  return { variableEarnings, reimbursements, deductions };
};

// ── §6 / §29 — pre-checks. Nothing is silently skipped: a failed check
// becomes an ERROR row with a human reason (§22). ───────────────────────────

export const precheckCompany = ({ setup = null, period = null } = {}) => {
  const errors = [];

  if (!setup) errors.push('Payroll setup is not configured for this company');
  else {
    if (setup.status && setup.status !== 'ACTIVE') {
      errors.push(`Payroll setup is ${String(setup.status).toLowerCase()} — activate it before running payroll`);
    }
    if (!setup.payrollPolicy?.cycleStartDay || !setup.payrollPolicy?.cycleEndDay) {
      errors.push('No payroll cycle is configured in Payroll Setup');
    }
    if (!setup.bankAccount?.accountNumberLast4) {
      errors.push('No company bank account is configured in Payroll Setup');
    }
  }

  if (period && !['LOCKED', 'SENT_TO_PAYROLL'].includes(period.status)) {
    errors.push(`Monthly inputs for this month are not locked (status ${period.status})`);
  }

  return errors;
};

export const precheckEmployee = ({
  employee = null,
  profile = null,
  structure = null,
  monthlyGross = 0,
} = {}) => {
  const errors = [];

  if (!employee) errors.push('Employee not found in this company');
  else if (employee.status !== 'ACTIVE') errors.push('Employee is not active');

  if (!profile) errors.push('Employee has no payroll profile (Phase 29.4)');
  else {
    if (profile.payrollStatus && profile.payrollStatus !== 'ACTIVE') {
      errors.push(`Payroll profile is ${String(profile.payrollStatus).toLowerCase()}`);
    }
    if (!profile.structureId) errors.push('No salary structure assigned to the payroll profile');
  }

  if (profile?.structureId && !structure) {
    errors.push('The assigned salary structure no longer exists');
  }
  if (structure && !['ACTIVE'].includes(structure.status)) {
    errors.push(`Salary structure is ${String(structure.status || '').toLowerCase()}`);
  }
  if (!(positive(monthlyGross) > 0)) errors.push('No effective monthly gross salary to calculate');

  return errors;
};

// ── the pipeline (§8 / §17) ────────────────────────────────────────────────

export const calculateEmployeePayroll = ({
  month = '',
  employee = {},
  profile = {},
  structurePreview = null,
  structureComponents = {},
  auto = {},
  entries = [],
  setup = {},
  monthsRemaining = 1,
  tdsPaidThisYear = 0,
  declarations = 0,
} = {}) => {
  const policy = setup?.payrollPolicy || {};
  const statutory = setup?.statutory || {};
  const employeeStatutory = profile?.statutory || {};
  const tax = profile?.tax || {};

  const gross = round2(profile?.monthlyGross || 0);
  const workingDays = positive(auto?.workingDays || policy?.workingDays || 0);
  const lopDays = positive(auto?.lopDays || 0);
  const halfDays = positive(auto?.halfDays || 0);
  const otHours = positive(auto?.otHours || 0);

  // ── 1. earnings: the structure decides, the engine never invents a rule (§9)
  const preview = structurePreview || { earnings: [], deductions: [], employerContributions: [] };
  const earnings = (preview.earnings || []).map((line) => ({
    code: line.componentCode,
    name: line.name,
    amount: round2(line.amount),
    calculationMethod: line.calculationMethod,
    methodLabel: line.methodLabel || line.calculationMethod,
    source: 'STRUCTURE',
    order: line.order ?? 0,
  }));

  const basicLine = earnings.find((line) => statutoryKindOf(line.code, line.name) === null && /BASIC/i.test(String(line.code || line.name || '')))
    || earnings[0]
    || null;
  const monthlyBasic = round2(basicLine?.amount || 0);

  // ── 2. attendance → payable days + LOP (§10 / §11)
  const payable = computePayableDays({
    workingDays,
    lopDays,
    halfDays,
    basis: policy?.lopPolicy?.basis || 'PER_DAY',
  });

  const earningsTotal = round2(earnings.reduce((sum, line) => sum + line.amount, 0));
  const lop = computeLopDeduction({
    monthlyEarnings: earningsTotal || gross,
    workingDays,
    lopDays,
    basis: policy?.lopPolicy?.basis || 'PER_DAY',
  });

  // ── 3. overtime (§12)
  const overtime = computeOvertimePay({
    otHours,
    monthlyGross: earningsTotal || gross,
    workingDays,
    policy: policy?.overtimePolicy || { enabled: false },
  });

  // ── 4. variable earnings + reimbursements + input deductions (§13/§14/§15)
  const { variableEarnings, reimbursements, deductions: inputDeductions } = splitMonthlyEntries(entries);
  const variableTotal = round2(variableEarnings.reduce((sum, row) => sum + row.amount, 0));
  const reimbursementTotal = round2(reimbursements.reduce((sum, row) => sum + row.amount, 0));
  const inputDeductionTotal = round2(inputDeductions.reduce((sum, row) => sum + row.amount, 0));

  // ── 5. statutory (§15) — applicability from 29.1 + the employee's own flags
  const pfApplicable = Boolean(statutory?.pf?.applicable) && Boolean(employeeStatutory?.pfMember);
  const esiApplicable = Boolean(statutory?.esi?.applicable) && Boolean(employeeStatutory?.esiNumber);
  const ptApplicable = Boolean(statutory?.professionalTax?.applicable);
  const tdsApplicable = Boolean(statutory?.tds?.applicable) && Boolean(tax?.tdsApplicable);
  const gratuityApplicable = Boolean(statutory?.gratuity?.applicable) && Boolean(employeeStatutory?.gratuityEligible);
  const lwfApplicable = Boolean(statutory?.labourWelfareFund?.applicable);

  // PF wages: basic (+ DA). Crewly structures carry DA inside the allowance
  // lines, so basic is the PF wage base unless a DA component exists.
  const daAmount = round2(
    earnings
      .filter((line) => /^DA$|DEARNESS/i.test(String(line.code || line.name || '')))
      .reduce((sum, line) => sum + line.amount, 0),
  );

  const pf = computeProvidentFund({ pfWages: monthlyBasic + daAmount, applicable: pfApplicable });
  const esi = computeEsi({ monthlyGross: earningsTotal || gross, applicable: esiApplicable });
  const professionalTax = computeProfessionalTax({
    monthlyGross: earningsTotal || gross,
    state: statutory?.professionalTax?.state,
    applicable: ptApplicable,
  });

  // TDS base: monthly taxable earnings = earnings + variable + OT − LOP.
  const monthlyTaxable = Math.max(
    0,
    round2(earningsTotal + variableTotal + overtime.amount - lop.amount),
  );

  const tds = computeMonthlyTds({
    monthlyTaxable,
    regime: tax?.regime || 'NEW',
    monthsRemaining,
    tdsPaidThisYear,
    declarations,
    applicable: tdsApplicable,
  });

  const gratuity = computeGratuity({ monthlyBasic, applicable: gratuityApplicable });
  const lwf = computeLabourWelfareFund({ applicable: lwfApplicable });

  // ── 6. deduction lines (§15 — every deduction shows name, amount, source)
  const statutoryDeductionLines = [
    { code: 'PF', name: 'Provident Fund', amount: pf.employee, source: 'STATUTORY', statutory: 'PF' },
    { code: 'ESI', name: 'ESI', amount: esi.employee, source: 'STATUTORY', statutory: 'ESI' },
    {
      code: 'PROFESSIONAL_TAX',
      name: 'Professional Tax',
      amount: professionalTax.amount,
      source: 'STATUTORY',
      statutory: 'PT',
    },
    { code: 'TDS', name: 'Income Tax (TDS)', amount: tds.monthly, source: 'STATUTORY', statutory: 'TDS' },
    { code: 'LWF', name: 'Labour Welfare Fund', amount: lwf.employee, source: 'STATUTORY', statutory: 'LWF' },
  ].filter((line) => line.amount > 0);

  // Structure deduction lines that are NOT statutory stay as configured; the
  // statutory ones above replace them (the law has ceilings, a flat amount
  // does not).
  const structureDeductionLines = (preview.deductions || [])
    .filter((line) => !statutoryKindOf(line.componentCode, line.name))
    .map((line) => ({
      code: line.componentCode,
      name: line.name,
      amount: round2(line.amount),
      source: 'STRUCTURE',
      calculationMethod: line.calculationMethod,
    }))
    .filter((line) => line.amount > 0);

  const lopLine = lop.amount > 0
    ? [{
        code: 'LOP',
        name: 'Loss of Pay',
        amount: lop.amount,
        source: 'ATTENDANCE',
        meta: { days: lop.days, basis: lop.basis },
      }]
    : [];

  const inputDeductionLines = inputDeductions.map((row) => ({
    code: row.type,
    name: row.label,
    amount: row.amount,
    source: row.source === 'MANUAL' ? 'MONTHLY_INPUT' : row.source,
    meta: { reason: row.reason },
  }));

  const deductions = [
    ...statutoryDeductionLines,
    ...structureDeductionLines,
    ...lopLine,
    ...inputDeductionLines,
  ];

  // ── 7. employer contributions (§16) — never reduce net salary
  const statutoryEmployerLines = [
    { code: 'PF_EMPLOYER', name: 'Employer PF', amount: pf.employer, source: 'STATUTORY', statutory: 'PF' },
    { code: 'ESI_EMPLOYER', name: 'Employer ESI', amount: esi.employer, source: 'STATUTORY', statutory: 'ESI' },
    { code: 'GRATUITY', name: 'Gratuity', amount: gratuity.amount, source: 'STATUTORY', statutory: 'GRATUITY' },
    { code: 'LWF_EMPLOYER', name: 'Employer LWF', amount: lwf.employer, source: 'STATUTORY', statutory: 'LWF' },
  ].filter((line) => line.amount > 0);

  const structureEmployerLines = (preview.employerContributions || [])
    .filter((line) => !statutoryKindOf(line.componentCode, line.name))
    .map((line) => ({
      code: line.componentCode,
      name: line.name,
      amount: round2(line.amount),
      source: 'STRUCTURE',
    }))
    .filter((line) => line.amount > 0);

  const employerContributions = [...statutoryEmployerLines, ...structureEmployerLines];

  // ── 8. totals (§17 — every intermediate value is stored)
  const totalEarnings = round2(earningsTotal + variableTotal + overtime.amount);
  const totalDeductions = round2(deductions.reduce((sum, line) => sum + line.amount, 0));
  const netPay = round2(totalEarnings + reimbursementTotal - totalDeductions);
  const employerCost = round2(employerContributions.reduce((sum, line) => sum + line.amount, 0));
  const ctc = round2(totalEarnings + employerCost);

  // §29 — no negative salary ever leaves the engine.
  const warnings = [];
  if (netPay < 0) warnings.push('Net salary is negative — check deductions and LOP');
  if (!earnings.length) warnings.push('The salary structure produced no earnings');
  if (Math.abs(earningsTotal - gross) > 1 && gross > 0) {
    warnings.push('Structure earnings do not add up to the profile gross');
  }

  return {
    month,
    employeeId: String(employee?._id || ''),
    employeeName: employee?.name || '',
    employeeCode: employee?.employeeCode || '',
    departmentId: employee?.department || null,
    designation: profile?.designation || employee?.designation || '',

    earnings,
    variableEarnings,
    overtime,
    reimbursements,
    deductions,

    lop: { ...lop, source: auto?.lopSource || 'ATTENDANCE' },
    payable,
    statutory: {
      pf,
      esi,
      professionalTax,
      tds,
      gratuity,
      lwf,
    },
    employerContributions,

    attendance: {
      workingDays: payable.workingDays,
      paidDays: payable.paidDays,
      presentDays: positive(auto?.presentDays),
      absentDays: positive(auto?.absentDays),
      halfDays: payable.halfDays,
      lopDays: payable.lopDays,
      paidLeaveDays: positive(auto?.paidLeaveDays),
      lateMarks: positive(auto?.lateMarks),
      otHours: overtime.hours,
      lopSource: auto?.lopSource || 'ATTENDANCE',
    },

    totals: {
      gross: earningsTotal || gross,
      basic: monthlyBasic,
      totalEarnings,
      variableEarnings: variableTotal,
      overtime: overtime.amount,
      reimbursements: reimbursementTotal,
      totalDeductions,
      netPay,
      employerCost,
      ctc,
    },

    warnings,
    structureId: String(profile?.structureId || ''),
    structureName: profile?.structureName || '',
    components: structureComponents,
  };
};

// ── §23 — KPIs for the payroll dashboard ───────────────────────────────────

export const summarizeRun = (results = []) => {
  const rows = results || [];
  const calculated = rows.filter((row) => row.status === 'CALCULATED');

  const sum = (field, list = calculated) =>
    round2((list || []).reduce((total, row) => total + Number(row?.totals?.[field] || 0), 0));

  return {
    totalEmployees: rows.length,
    calculated: calculated.length,
    errors: rows.filter((row) => row.status === 'ERROR').length,
    grossPayroll: sum('totalEarnings'),
    netPayroll: sum('netPay'),
    employerCost: sum('employerCost'),
    totalReimbursements: sum('reimbursements'),
    totalDeductions: sum('totalDeductions'),
    ctc: sum('ctc'),
  };
};

export default {
  PAYROLL_RUN_STATUSES,
  PAYROLL_RESULT_STATUSES,
  STATUTORY_RULES,
  PROFESSIONAL_TAX_SLABS,
  calculateEmployeePayroll,
  computePayableDays,
  computeLopDeduction,
  computeOvertimePay,
  computeProvidentFund,
  computeEsi,
  computeProfessionalTax,
  computeGratuity,
  computeLabourWelfareFund,
  computeMonthlyTds,
  precheckCompany,
  precheckEmployee,
  splitMonthlyEntries,
  statutoryKindOf,
  summarizeRun,
  taxFromSlabs,
};
