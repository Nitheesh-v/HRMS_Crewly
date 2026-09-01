// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.3 — SALARY STRUCTURE RULES (pure domain logic)
//
//  A salary structure is a REUSABLE TEMPLATE, not an employee salary:
//
//      Salary Component (29.2) → Salary Structure (29.3) → Employee (29.4)
//
//  This module is PURE: no mongoose, no redis, no req/res. It is the single
//  source of truth for validation, normalization, ordering and the preview
//  calculation, so the API, a job and a script all behave identically.
//
//  PHASE 29.3 IS NOT THE PAYROLL ENGINE (§22). Nothing here computes an
//  employee's salary. The preview in §9 is a VISUALISATION for a sample
//  gross figure the user types; its output is never persisted.
// ═══════════════════════════════════════════════════════════════════════════

import { COMPONENT_CATEGORIES } from './salaryComponentRules.js';

export const STRUCTURE_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'];

export const STRUCTURE_STATUS_LABELS = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archived',
};

// Lifecycle transitions the service allows (§5 / §14).
export const STRUCTURE_TRANSITIONS = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

// §7 — calculation methods available at STRUCTURE level. This is deliberately
// a different axis from the component's own default calculation: a component
// says "how it usually behaves", the structure says "what it does here".
export const CALCULATION_METHODS = [
  'FIXED_AMOUNT',
  'PERCENTAGE_OF_GROSS',
  'PERCENTAGE_OF_BASIC',
  'PERCENTAGE_OF_CTC',
  'REMAINING',
];

export const CALCULATION_METHOD_LABELS = {
  FIXED_AMOUNT: 'Fixed Amount',
  PERCENTAGE_OF_GROSS: 'Percentage of Gross',
  PERCENTAGE_OF_BASIC: 'Percentage of Basic',
  PERCENTAGE_OF_CTC: 'Percentage of CTC',
  REMAINING: 'Remaining Amount',
};

// Basic is the anchor for PERCENTAGE_OF_BASIC. It is resolved from the
// component code, never hardcoded to a magic string in the engine.
export const BASIC_COMPONENT_CODE = 'BASIC';

export const NAME_MAX = 80;
export const CODE_MAX = 30;
export const DESCRIPTION_MAX = 500;
export const PERCENTAGE_MIN = 0.01;
export const PERCENTAGE_MAX = 100;

// ── defaults ───────────────────────────────────────────────────────────────

export const defaultSalaryStructure = () => ({
  name: '',
  code: '',
  description: '',
  departmentId: null,
  designation: '',
  effectiveFrom: null,
  status: 'DRAFT',
  items: [],
});

// ── normalization ──────────────────────────────────────────────────────────

const cleanText = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

const toNumberOrNull = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const upperCodeOrEmpty = (value) =>
  cleanText(value, CODE_MAX).toUpperCase().replace(/[\s-]+/g, '_');

export const normalizeStructureItem = (item = {}, index = 0) => {
  const method = String(item.calculationMethod || 'FIXED_AMOUNT').toUpperCase();

  return {
    componentCode: upperCodeOrEmpty(item.componentCode),
    calculationMethod: CALCULATION_METHODS.includes(method) ? method : 'FIXED_AMOUNT',
    value: method === 'REMAINING' ? null : toNumberOrNull(item.value),
    // §11 — display order, used later by payslips.
    order: Number.isInteger(Number(item.order)) ? Number(item.order) : index,
  };
};

export const normalizeSalaryStructure = (input = {}) => {
  const raw = input && typeof input === 'object' ? input : {};
  const status = String(raw.status || 'DRAFT').toUpperCase();

  // Client-supplied tenant or lineage fields are dropped on purpose.
  return {
    name: cleanText(raw.name, NAME_MAX),
    code: upperCodeOrEmpty(raw.code),
    description: cleanText(raw.description, DESCRIPTION_MAX),
    departmentId: raw.departmentId || null,
    designation: cleanText(raw.designation, 80),
    effectiveFrom: toDateOrNull(raw.effectiveFrom) || new Date(),
    status: STRUCTURE_STATUSES.includes(status) ? status : 'DRAFT',
    items: (Array.isArray(raw.items) ? raw.items : []).map(normalizeStructureItem),
  };
};

// ── validation (§10) ───────────────────────────────────────────────────────

// `components` = the company's ACTIVE components (code → component).
export const validateSalaryStructure = (
  structure,
  { components = {}, existingCodes = [], selfCode = '' } = {},
) => {
  const errors = [];
  const value = structure && typeof structure === 'object' ? structure : defaultSalaryStructure();
  const add = (field, message) => errors.push({ field, message });

  // ── required fields
  if (!value.name) add('name', 'Structure name is required');
  else if (value.name.length < 2) add('name', 'Structure name must be at least 2 characters');

  if (!value.code) add('code', 'Structure code is required');

  if (value.effectiveFrom && Number.isNaN(new Date(value.effectiveFrom).getTime())) {
    add('effectiveFrom', 'Effective date is not a valid date');
  }

  if (!STRUCTURE_STATUSES.includes(value.status)) add('status', 'Invalid structure status');

  // ── duplicate tenant-level code (§3)
  const known = new Set((existingCodes || []).map(upperCodeOrEmpty).filter(Boolean));
  if (selfCode) known.delete(upperCodeOrEmpty(selfCode));
  if (value.code && known.has(value.code)) {
    add('code', 'This structure code is already in use. Please choose another code.');
  }

  const items = Array.isArray(value.items) ? value.items : [];
  if (!items.length) add('items', 'Add at least one salary component');

  // ── per-item checks
  const seen = new Set();
  let remainingCount = 0;

  items.forEach((item, index) => {
    const code = upperCodeOrEmpty(item.componentCode);
    const label = components[code]?.name || code || `Item ${index + 1}`;

    if (!code) {
      add('items', 'Every structure line must select a component');
      return;
    }

    // §10 — no duplicate components
    if (seen.has(code)) {
      add('items', `${label} is added more than once`);
    }
    seen.add(code);

    // §10 — inactive or unknown components cannot be selected
    const component = components[code];
    if (!component) {
      add('items', `${code} is not an active salary component`);
      return;
    }

    if (!CALCULATION_METHODS.includes(item.calculationMethod)) {
      add('items', `${label} uses an unknown calculation method`);
      return;
    }

    // §8 — Remaining is earnings-only and unique
    if (item.calculationMethod === 'REMAINING') {
      remainingCount += 1;
      if (component.category !== 'EARNING') {
        add('items', `${label}: only an earning can use Remaining Amount`);
      }
    }

    // value sanity per method
    if (item.calculationMethod === 'FIXED_AMOUNT') {
      if (item.value === null) add('items', `${label}: enter the fixed amount`);
      else if (item.value < 0) add('items', `${label}: amount cannot be negative`);
    }

    if (item.calculationMethod.startsWith('PERCENTAGE_')) {
      if (item.value === null) add('items', `${label}: enter the percentage`);
      else if (item.value < PERCENTAGE_MIN || item.value > PERCENTAGE_MAX) {
        add('items', `${label}: percentage must be between ${PERCENTAGE_MIN} and ${PERCENTAGE_MAX}`);
      }
    }
  });

  if (remainingCount > 1) {
    add('items', 'Only one earning can use Remaining Amount');
  }

  // §10 — at least one earning
  const hasEarning = items.some((item) => components[upperCodeOrEmpty(item.componentCode)]?.category === 'EARNING');
  if (items.length && !hasEarning) {
    add('items', 'A salary structure needs at least one earning component');
  }

  return errors;
};

// §10 — gross distribution must balance (only meaningful when the structure
// is checked against a gross figure, which the UI does live).
export const validateAgainstGross = (items = [], components = {}, gross = 0) => {
  const errors = [];
  const earnings = items.filter(
    (item) => components[upperCodeOrEmpty(item.componentCode)]?.category === 'EARNING',
  );

  const hasRemaining = earnings.some((item) => item.calculationMethod === 'REMAINING');
  if (!hasRemaining) return errors;

  const grossValue = Number(gross) || 0;
  const allocated = earnings
    .filter((item) => item.calculationMethod !== 'REMAINING')
    .reduce((sum, item) => {
      if (item.calculationMethod === 'FIXED_AMOUNT') return sum + (Number(item.value) || 0);
      if (item.calculationMethod === 'PERCENTAGE_OF_GROSS') {
        return sum + (grossValue * (Number(item.value) || 0)) / 100;
      }
      return sum;
    }, 0);

  if (allocated > grossValue) {
    errors.push({
      field: 'items',
      message:
        'The fixed and percentage earnings exceed the gross salary, so the Remaining Amount would be negative.',
    });
  }

  return errors;
};

// ── §9 live preview ────────────────────────────────────────────────────────
//
// Pure and display-only. The result is NEVER stored — the payroll engine in a
// later phase owns real calculations (§1 / §22).

const amountFor = ({ item, gross, basic, ctc }) => {
  switch (item.calculationMethod) {
    case 'FIXED_AMOUNT':
      return Math.round((Number(item.value) || 0) * 100) / 100;
    case 'PERCENTAGE_OF_GROSS':
      return (gross * (Number(item.value) || 0)) / 100;
    case 'PERCENTAGE_OF_BASIC':
      return (basic * (Number(item.value) || 0)) / 100;
    case 'PERCENTAGE_OF_CTC':
      return (ctc * (Number(item.value) || 0)) / 100;
    default:
      return 0;
  }
};

export const computeStructurePreview = ({
  items = [],
  components = {},
  gross = 0,
} = {}) => {
  const grossValue = Math.max(0, Number(gross) || 0);

  const withCategory = (category) =>
    items
      .map((item, index) => ({ ...item, order: Number.isInteger(item.order) ? item.order : index }))
      .filter((item) => components[upperCodeOrEmpty(item.componentCode)]?.category === category)
      .sort((a, b) => a.order - b.order);

  const earnings = withCategory('EARNING');
  const deductions = withCategory('DEDUCTION');
  const employers = withCategory('EMPLOYER_CONTRIBUTION');

  // Basic is the anchor for PERCENTAGE_OF_BASIC, so it resolves first.
  const basicItem =
    earnings.find((item) => upperCodeOrEmpty(item.componentCode) === BASIC_COMPONENT_CODE) ||
    earnings[0] ||
    null;
  const basicAmount = basicItem ? amountFor({ item: basicItem, gross: grossValue, basic: 0, ctc: grossValue }) : 0;

  // Employer contributions sit on top of gross, so CTC = gross + employer cost.
  const employerTotal = employers.reduce(
    (sum, item) => sum + amountFor({ item, gross: grossValue, basic: basicAmount, ctc: grossValue }),
    0,
  );
  const ctcValue = grossValue + employerTotal;

  const remainingItem = earnings.find((item) => item.calculationMethod === 'REMAINING') || null;

  const allocated = earnings
    .filter((item) => item !== remainingItem)
    .reduce(
      (sum, item) =>
        sum + amountFor({ item, gross: grossValue, basic: basicAmount, ctc: ctcValue }),
      0,
    );

  const remainingAmount = remainingItem ? grossValue - allocated : 0;

  const line = (item) => {
    const code = upperCodeOrEmpty(item.componentCode);
    const component = components[code] || {};
    const isRemaining = item.calculationMethod === 'REMAINING';

    return {
      componentCode: code,
      name: component.name || code,
      calculationMethod: item.calculationMethod,
      methodLabel: CALCULATION_METHOD_LABELS[item.calculationMethod] || item.calculationMethod,
      value: isRemaining ? null : Number(item.value) || 0,
      amount: isRemaining
        ? Math.round(remainingAmount * 100) / 100
        : Math.round(amountFor({ item, gross: grossValue, basic: basicAmount, ctc: ctcValue }) * 100) / 100,
      isRemaining,
      order: item.order,
    };
  };

  const earningLines = earnings.map(line);
  const deductionLines = deductions.map(line);
  const employerLines = employers.map(line);

  const deductionTotal = deductionLines.reduce((sum, item) => sum + item.amount, 0);

  return {
    earnings: earningLines,
    deductions: deductionLines,
    employerContributions: employerLines,
    totals: {
      gross: Math.round(grossValue * 100) / 100,
      basic: Math.round(basicAmount * 100) / 100,
      totalDeductions: Math.round(deductionTotal * 100) / 100,
      netPay: Math.round((grossValue - deductionTotal) * 100) / 100,
      employerCost: Math.round(employerTotal * 100) / 100,
      ctc: Math.round(ctcValue * 100) / 100,
      remaining: Math.round(remainingAmount * 100) / 100,
    },
  };
};

// ── listing / filters (§15) ────────────────────────────────────────────────

export const normalizeStructureFilters = (query = {}) => {
  const status = String(query.status || 'ALL').toUpperCase();

  return {
    search: cleanText(query.search, 80),
    status: status === 'ALL' || !STRUCTURE_STATUSES.includes(status) ? 'ALL' : status,
    departmentId: query.departmentId ? String(query.departmentId) : '',
    effectiveFrom: query.effectiveFrom ? String(query.effectiveFrom) : '',
    page: Math.max(1, Number.parseInt(query.page, 10) || 1),
    limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 25)),
  };
};

export const filterStructures = (structures = [], filters = {}) => {
  const f = normalizeStructureFilters(filters);
  const needle = f.search.toLowerCase();

  const matched = structures.filter((structure) => {
    if (f.status !== 'ALL' && structure.status !== f.status) return false;
    if (f.departmentId && String(structure.departmentId || '') !== f.departmentId) return false;
    if (f.effectiveFrom) {
      const from = new Date(structure.effectiveFrom || 0);
      if (from < new Date(f.effectiveFrom)) return false;
    }
    if (needle) {
      const haystack = [structure.name, structure.code, structure.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const total = matched.length;
  const start = (f.page - 1) * f.limit;

  return {
    items: matched.slice(start, start + f.limit),
    meta: { total, page: f.page, limit: f.limit, pages: Math.max(1, Math.ceil(total / f.limit)) },
  };
};

// §13 — clone copies configuration, never identity or history.
export const cloneStructurePayload = (source = {}, overrides = {}) => {
  // Keys sent as undefined would otherwise overwrite the clone defaults.
  const { name, code, ...rest } = Object.fromEntries(
    Object.entries(overrides || {}).filter(([, value]) => value !== undefined),
  );

  return {
    // Configuration is copied; identity, version and history are reset (§13).
    ...normalizeSalaryStructure(source),
    ...rest,
    name: String(name || `${source.name} Copy`).trim(),
    code: code ? upperCodeOrEmpty(code) : upperCodeOrEmpty(`${source.code}_COPY`),
    status: 'DRAFT',
    version: 1,
    isCurrent: true,
    previousVersionId: null,
  };
};

export const canTransition = (from, to) =>
  (STRUCTURE_TRANSITIONS[String(from || '').toUpperCase()] || []).includes(String(to || '').toUpperCase());

export const CATEGORY_LABELS = {
  EARNING: 'Earnings',
  DEDUCTION: 'Deductions',
  EMPLOYER_CONTRIBUTION: 'Employer Contributions',
};

export const STRUCTURE_CATEGORIES = COMPONENT_CATEGORIES;
