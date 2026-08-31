// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.2 — SALARY COMPONENT RULES (pure domain logic)
//
//  A salary component is a BUILDING BLOCK, not a salary:
//
//      Salary Component  →  Salary Structure (29.3)  →  Employee (29.4)
//
//  This module is PURE: no mongoose, no redis, no req/res. Everything here
//  is testable without infrastructure and is the single source of truth for
//  validation, normalization and display, so the API, a background job and
//  a script all enforce exactly the same rules.
//
//  PHASE 29.2 IS NOT THE PAYROLL ENGINE (§11). Nothing here computes a
//  salary. It only describes "what is this component and how will it
//  eventually behave".
//
//  FORMULA SAFETY (§45): formulas are stored as a CONTROLLED operation list
//  (whitelisted operators + component references). There is no eval(), no
//  user-submitted JavaScript and no string expression parser.
// ═══════════════════════════════════════════════════════════════════════════

export const COMPONENT_CATEGORIES = ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION'];

export const COMPONENT_CATEGORY_LABELS = {
  EARNING: 'Earning',
  DEDUCTION: 'Deduction',
  EMPLOYER_CONTRIBUTION: 'Employer Contribution',
};

// Employee deduction vs employer contribution is never the same thing (§19).
export const EMPLOYER_CONTRIBUTION_CATEGORY = 'EMPLOYER_CONTRIBUTION';

export const CALCULATION_TYPES = ['FIXED_AMOUNT', 'PERCENTAGE', 'FORMULA'];

export const CALCULATION_TYPE_LABELS = {
  FIXED_AMOUNT: 'Fixed Amount',
  PERCENTAGE: 'Percentage',
  FORMULA: 'Formula',
};

// Percentage bases (§13). Deliberately not limited to BASIC/GROSS so the
// architecture can grow without a schema change.
export const CALCULATION_BASES = ['BASIC', 'GROSS', 'CTC', 'COMPONENT'];

export const CALCULATION_BASE_LABELS = {
  BASIC: 'Basic Salary',
  GROSS: 'Gross Salary',
  CTC: 'CTC',
  COMPONENT: 'Another Component',
};

export const TAXABILITY_TYPES = ['TAXABLE', 'NON_TAXABLE', 'PARTIALLY_TAXABLE', 'DEFERRED'];

export const TAXABILITY_LABELS = {
  TAXABLE: 'Taxable',
  NON_TAXABLE: 'Non-taxable',
  PARTIALLY_TAXABLE: 'Partially Taxable',
  DEFERRED: 'Configured Later',
};

export const COMPONENT_STATUS = ['ACTIVE', 'INACTIVE'];

// Whitelisted formula operators — the only thing a formula may contain (§45).
export const FORMULA_OPERATORS = ['ADD', 'SUBTRACT', 'MULTIPLY_BY', 'PERCENT_OF'];

export const FORMULA_OPERATOR_LABELS = {
  ADD: '+',
  SUBTRACT: '−',
  MULTIPLY_BY: '×',
  PERCENT_OF: '% of',
};

export const NAME_MAX = 80;
export const CODE_MAX = 30;
export const DESCRIPTION_MAX = 500;

// 0.01 % – 1000 %: covers statutory fractions (4.81%) and bonus multiples.
export const PERCENTAGE_MIN = 0.01;
export const PERCENTAGE_MAX = 1000;

export const CODE_PATTERN = /^[A-Z0-9_]+$/;

// ── defaults ───────────────────────────────────────────────────────────────

export const defaultSalaryComponent = () => ({
  name: '',
  code: '',
  description: '',
  category: 'EARNING',
  calculationType: 'FIXED_AMOUNT',
  defaultAmount: null,
  percentage: null,
  calculationBase: null,
  dependsOnCode: '',
  formula: null,
  taxability: 'TAXABLE',
  pfApplicable: false,
  esiApplicable: false,
  tdsApplicable: true,
  professionalTaxApplicable: false,
  status: 'ACTIVE',
  effectiveFrom: null,
  isSystemDefault: false,
});

// ── normalization ──────────────────────────────────────────────────────────

const cleanText = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

const toNumberOrNull = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const toBool = (value, fallback = false) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const upperCodeOrEmpty = (value) => cleanText(value, CODE_MAX).toUpperCase().replace(/[\s-]+/g, '_');

const upperCode = upperCodeOrEmpty;

// Shapes user input into the canonical component form. Unknown fields are
// dropped so a client cannot smuggle in tenant or status overrides.
export const normalizeSalaryComponent = (input = {}) => {
  const base = defaultSalaryComponent();
  const raw = input && typeof input === 'object' ? input : {};
  const category = String(raw.category || base.category).toUpperCase();
  const calculationType = String(raw.calculationType || base.calculationType).toUpperCase();
  const taxability = String(raw.taxability || base.taxability).toUpperCase();
  const status = String(raw.status || base.status).toUpperCase();
  const effectiveFrom = toDateOrNull(raw.effectiveFrom) || new Date();

  return {
    name: cleanText(raw.name, NAME_MAX),
    code: upperCode(raw.code),
    description: cleanText(raw.description, DESCRIPTION_MAX),
    category: COMPONENT_CATEGORIES.includes(category) ? category : base.category,
    calculationType: CALCULATION_TYPES.includes(calculationType) ? calculationType : base.calculationType,
    defaultAmount: toNumberOrNull(raw.defaultAmount),
    percentage: toNumberOrNull(raw.percentage),
    calculationBase: raw.calculationBase ? String(raw.calculationBase).toUpperCase() : null,
    dependsOnCode: upperCode(raw.dependsOnCode),
    formula: normalizeFormula(raw.formula),
    taxability: TAXABILITY_TYPES.includes(taxability) ? taxability : base.taxability,
    pfApplicable: toBool(raw.pfApplicable, false),
    esiApplicable: toBool(raw.esiApplicable, false),
    tdsApplicable: toBool(raw.tdsApplicable, true),
    professionalTaxApplicable: toBool(raw.professionalTaxApplicable, false),
    status: COMPONENT_STATUS.includes(status) ? status : base.status,
    effectiveFrom,
    isSystemDefault: false,
  };
};

// Controlled, whitelisted operation list — never a string expression (§45).
export const normalizeFormula = (formula) => {
  if (!formula || typeof formula !== 'object') return null;

  const operations = Array.isArray(formula.operations) ? formula.operations : [];
  const cleaned = operations
    .slice(0, 25)
    .map((op) => ({
      operator: FORMULA_OPERATORS.includes(String(op?.operator || '').toUpperCase())
        ? String(op.operator).toUpperCase()
        : null,
      componentCode: upperCode(op?.componentCode),
      value: toNumberOrNull(op?.value),
    }))
    .filter((op) => op.operator && (op.componentCode || op.value !== null));

  if (!cleaned.length) return null;

  return {
    base: CALCULATION_BASES.includes(String(formula.base || '').toUpperCase())
      ? String(formula.base).toUpperCase()
      : 'GROSS',
    operations: cleaned,
  };
};

// ── validation ─────────────────────────────────────────────────────────────

// Returns [{ field, message }] in HR-friendly language (§54).
export const validateSalaryComponent = (component, { existingCodes = [], selfCode = '' } = {}) => {
  const errors = [];
  const value = component && typeof component === 'object' ? component : defaultSalaryComponent();
  const add = (field, message) => errors.push({ field, message });

  // ── name (§7)
  if (!value.name) add('name', 'Component name is required');
  else if (value.name.length < 2) add('name', 'Component name must be at least 2 characters');

  // ── code (§8)
  if (!value.code) add('code', 'Component code is required');
  else if (!CODE_PATTERN.test(value.code)) {
    add('code', 'Component code can only contain letters, numbers and underscores');
  }

  // ── category (§5)
  if (!COMPONENT_CATEGORIES.includes(value.category)) {
    add('category', 'Component type must be Earning, Deduction or Employer Contribution');
  }

  // ── calculation (§10 / §12 / §13)
  if (!CALCULATION_TYPES.includes(value.calculationType)) {
    add('calculationType', 'Calculation type must be Fixed Amount, Percentage or Formula');
  } else if (value.calculationType === 'FIXED_AMOUNT') {
    if (value.defaultAmount !== null && value.defaultAmount < 0) {
      add('defaultAmount', 'Default amount cannot be negative');
    }
  } else if (value.calculationType === 'PERCENTAGE') {
    if (value.percentage === null) add('percentage', 'Percentage is required for percentage components');
    else if (value.percentage < PERCENTAGE_MIN || value.percentage > PERCENTAGE_MAX) {
      add('percentage', `Percentage must be between ${PERCENTAGE_MIN} and ${PERCENTAGE_MAX}`);
    }
    if (!CALCULATION_BASES.includes(value.calculationBase)) {
      add('calculationBase', 'Choose what the percentage is calculated from');
    }
    if (value.calculationBase === 'COMPONENT' && !value.dependsOnCode) {
      add('dependsOnCode', 'Select the component this percentage is based on');
    }
    // §47 — HRA cannot depend on HRA
    if (value.calculationBase === 'COMPONENT' && value.dependsOnCode && value.dependsOnCode === value.code) {
      add('dependsOnCode', 'This component cannot depend on itself');
    }
  } else if (value.calculationType === 'FORMULA') {
    if (!value.formula) add('formula', 'Add at least one formula step');
  }

  // ── tax & statutory (§15–§18)
  if (!TAXABILITY_TYPES.includes(value.taxability)) add('taxability', 'Choose a tax treatment');
  if (!COMPONENT_STATUS.includes(value.status)) add('status', 'Status must be Active or Inactive');

  // §19 — an earning is never an employer contribution
  if (value.category === EMPLOYER_CONTRIBUTION_CATEGORY && value.calculationType === 'FIXED_AMOUNT' && value.defaultAmount === null) {
    // allowed: employer contributions may be defined later; no error
  }

  // ── dates (§23)
  if (value.effectiveFrom && Number.isNaN(new Date(value.effectiveFrom).getTime())) {
    add('effectiveFrom', 'Effective date is not a valid date');
  }

  // ── duplicate tenant-level code (§8 / §47)
  const known = new Set((existingCodes || []).map((code) => upperCode(code)).filter(Boolean));
  if (selfCode) known.delete(upperCode(selfCode));
  if (value.code && known.has(value.code)) {
    add('code', 'This component code is already in use. Please choose another code.');
  }

  return errors;
};

// ── dependency graph (§14) ─────────────────────────────────────────────────

// Builds code → [dependency codes] from a component list.
export const buildDependencyGraph = (components = []) => {
  const graph = new Map();

  for (const component of components) {
    const code = upperCode(component.code);
    if (!code) continue;
    const edges = [];

    if (component.calculationType === 'PERCENTAGE' && component.calculationBase === 'COMPONENT') {
      if (component.dependsOnCode) edges.push(upperCode(component.dependsOnCode));
    }

    if (component.calculationType === 'FORMULA' && component.formula?.operations?.length) {
      for (const op of component.formula.operations) {
        if (op.componentCode) edges.push(upperCode(op.componentCode));
      }
    }

    graph.set(code, edges);
  }

  return graph;
};

// Walks the graph from `startCode`. Returns the cycle path or null.
export const findDependencyCycle = (graph, startCode) => {
  const visiting = new Set();
  const visited = new Set();
  const path = [];

  const walk = (code) => {
    if (visiting.has(code)) return [...path, code];
    if (visited.has(code)) return null;

    visiting.add(code);
    path.push(code);

    for (const next of graph.get(code) || []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }

    visiting.delete(code);
    visited.add(code);
    path.pop();
    return null;
  };

  return walk(upperCode(startCode));
};

// Would adding/updating `candidate` create a circular dependency? (§14/§47)
export const detectCircularDependency = (candidate, existing = []) => {
  const graph = buildDependencyGraph(existing);

  const code = upperCode(candidate?.code);
  const edges = [];

  if (candidate?.calculationType === 'PERCENTAGE' && candidate.calculationBase === 'COMPONENT') {
    if (candidate.dependsOnCode) edges.push(upperCode(candidate.dependsOnCode));
  }
  if (candidate?.calculationType === 'FORMULA' && candidate.formula?.operations?.length) {
    for (const op of candidate.formula.operations) {
      if (op.componentCode) edges.push(upperCode(op.componentCode));
    }
  }

  if (!code || !edges.length) return null;

  // replace this component's own edges with the candidate's
  graph.set(code, edges);

  return findDependencyCycle(graph, code);
};

// ── display helpers ────────────────────────────────────────────────────────

// "40% of Basic Salary" / "Fixed ₹2,000" (§30 preview)
export const describeCalculation = (component = {}, codeToName = {}) => {
  const type = String(component.calculationType || '').toUpperCase();

  if (type === 'FIXED_AMOUNT') {
    const amount = Number(component.defaultAmount);
    return Number.isFinite(amount) && amount > 0
      ? `Fixed ₹${amount.toLocaleString('en-IN')}`
      : 'Fixed amount (set per employee)';
  }

  if (type === 'PERCENTAGE') {
    const pct = Number(component.percentage);
    const base = String(component.calculationBase || '').toUpperCase();
    const pctText = Number.isFinite(pct) ? `${pct}%` : '—%';

    if (base === 'COMPONENT') {
      const dep = upperCode(component.dependsOnCode);
      const name = codeToName[dep] || dep || 'another component';
      return `${pctText} of ${name}`;
    }

    return `${pctText} of ${CALCULATION_BASE_LABELS[base] || 'Gross Salary'}`;
  }

  if (type === 'FORMULA') {
    const ops = component.formula?.operations || [];
    if (!ops.length) return 'Formula (not configured)';
    const base = CALCULATION_BASE_LABELS[component.formula.base] || 'Gross Salary';
    const text = ops
      .map((op) => {
        const symbol = FORMULA_OPERATOR_LABELS[op.operator] || op.operator;
        const operand = op.componentCode
          ? codeToName[upperCode(op.componentCode)] || upperCode(op.componentCode)
          : op.value;
        return `${symbol} ${operand}`;
      })
      .join(' ');
    return `${base} ${text}`;
  }

  return 'Not configured';
};

// ── defaults driven by Phase 29.1 statutory config (§35 / §36) ──────────────
//
// Phase 29.1 is the single source of truth for company-level applicability:
// if PF is switched off there, no PF deduction component is suggested here.

const BASE_EARNINGS = [
  { name: 'Basic Salary', code: 'BASIC', category: 'EARNING', calculationType: 'FIXED_AMOUNT', pfApplicable: true, esiApplicable: true, professionalTaxApplicable: true },
  { name: 'House Rent Allowance', code: 'HRA', category: 'EARNING', calculationType: 'PERCENTAGE', percentage: 40, calculationBase: 'BASIC', pfApplicable: true, esiApplicable: true, professionalTaxApplicable: true },
  { name: 'Special Allowance', code: 'SPECIAL_ALLOWANCE', category: 'EARNING', calculationType: 'FIXED_AMOUNT', pfApplicable: true, esiApplicable: true, professionalTaxApplicable: true },
  { name: 'Bonus', code: 'BONUS', category: 'EARNING', calculationType: 'FIXED_AMOUNT', pfApplicable: false, esiApplicable: false, professionalTaxApplicable: true },
];

const PF_COMPONENT = {
  name: 'Provident Fund',
  code: 'PF',
  category: 'DEDUCTION',
  calculationType: 'PERCENTAGE',
  percentage: 12,
  calculationBase: 'BASIC',
  pfApplicable: false,
  esiApplicable: false,
  taxability: 'NON_TAXABLE',
};

const ESI_COMPONENT = {
  name: 'ESI',
  code: 'ESI',
  category: 'DEDUCTION',
  calculationType: 'PERCENTAGE',
  percentage: 0.75,
  calculationBase: 'GROSS',
  pfApplicable: false,
  esiApplicable: false,
  taxability: 'NON_TAXABLE',
};

const PT_COMPONENT = {
  name: 'Professional Tax',
  code: 'PT',
  category: 'DEDUCTION',
  calculationType: 'FIXED_AMOUNT',
  taxability: 'NON_TAXABLE',
};

const TDS_COMPONENT = {
  name: 'TDS',
  code: 'TDS',
  category: 'DEDUCTION',
  calculationType: 'FIXED_AMOUNT',
  taxability: 'NON_TAXABLE',
};

const LOP_COMPONENT = {
  name: 'Loss of Pay',
  code: 'LOP',
  category: 'DEDUCTION',
  calculationType: 'FIXED_AMOUNT',
  taxability: 'NON_TAXABLE',
};

const EMPLOYER_PF = {
  name: 'Employer PF Contribution',
  code: 'EMPLOYER_PF',
  category: 'EMPLOYER_CONTRIBUTION',
  calculationType: 'PERCENTAGE',
  percentage: 12,
  calculationBase: 'BASIC',
  taxability: 'NON_TAXABLE',
};

const EMPLOYER_ESI = {
  name: 'Employer ESI Contribution',
  code: 'EMPLOYER_ESI',
  category: 'EMPLOYER_CONTRIBUTION',
  calculationType: 'PERCENTAGE',
  percentage: 3.25,
  calculationBase: 'GROSS',
  taxability: 'NON_TAXABLE',
};

// statutory: the Phase 29.1 `statutory` section (already tenant-scoped).
export const suggestDefaultComponents = (statutory = {}) => {
  const pf = Boolean(statutory?.pf?.applicable);
  const esi = Boolean(statutory?.esi?.applicable);
  const pt = Boolean(statutory?.professionalTax?.applicable);
  const tds = Boolean(statutory?.tds?.applicable);

  const suggestions = [...BASE_EARNINGS];

  if (pf) suggestions.push(PF_COMPONENT, EMPLOYER_PF);
  if (esi) suggestions.push(ESI_COMPONENT, EMPLOYER_ESI);
  if (pt) suggestions.push(PT_COMPONENT);
  if (tds) suggestions.push(TDS_COMPONENT);

  suggestions.push(LOP_COMPONENT);

  return suggestions.map((item) => ({
    ...defaultSalaryComponent(),
    ...item,
    tdsApplicable: item.tdsApplicable ?? true,
    professionalTaxApplicable: item.professionalTaxApplicable ?? false,
    isSystemDefault: true,
  }));
};

// ── list filtering (§26 / §27) ─────────────────────────────────────────────

export const normalizeComponentFilters = (query = {}) => {
  const category = String(query.category || 'ALL').toUpperCase();
  const status = String(query.status || 'ALL').toUpperCase();
  const calculationType = String(query.calculationType || 'ALL').toUpperCase();
  const taxability = String(query.taxability || 'ALL').toUpperCase();

  return {
    search: cleanText(query.search, 80),
    category: category === 'ALL' || !COMPONENT_CATEGORIES.includes(category) ? 'ALL' : category,
    status: status === 'ALL' || !COMPONENT_STATUS.includes(status) ? 'ALL' : status,
    calculationType:
      calculationType === 'ALL' || !CALCULATION_TYPES.includes(calculationType) ? 'ALL' : calculationType,
    taxability: taxability === 'ALL' || !TAXABILITY_TYPES.includes(taxability) ? 'ALL' : taxability,
    pf: query.pf === undefined ? null : toBool(query.pf, null),
    esi: query.esi === undefined ? null : toBool(query.esi, null),
    tds: query.tds === undefined ? null : toBool(query.tds, null),
    page: Math.max(1, Number.parseInt(query.page, 10) || 1),
    limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 25)),
  };
};

// Filtering runs on the tenant's own components only (§27).
export const filterComponents = (components = [], filters = {}) => {
  const f = normalizeComponentFilters(filters);
  const needle = f.search.toLowerCase();

  const matched = components.filter((component) => {
    if (f.category !== 'ALL' && component.category !== f.category) return false;
    if (f.status !== 'ALL' && component.status !== f.status) return false;
    if (f.calculationType !== 'ALL' && component.calculationType !== f.calculationType) return false;
    if (f.taxability !== 'ALL' && component.taxability !== f.taxability) return false;
    if (f.pf !== null && Boolean(component.pfApplicable) !== f.pf) return false;
    if (f.esi !== null && Boolean(component.esiApplicable) !== f.esi) return false;
    if (f.tds !== null && Boolean(component.tdsApplicable) !== f.tds) return false;

    if (needle) {
      const haystack = [
        component.name,
        component.code,
        component.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    return true;
  });

  const total = matched.length;
  const start = (f.page - 1) * f.limit;
  const items = matched.slice(start, start + f.limit);

  return {
    items,
    meta: { total, page: f.page, limit: f.limit, pages: Math.max(1, Math.ceil(total / f.limit)) },
  };
};
