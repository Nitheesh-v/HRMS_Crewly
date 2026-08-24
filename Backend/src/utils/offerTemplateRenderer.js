export const OFFER_TEMPLATE_VARIABLES = Object.freeze([
  'candidateName',
  'candidateEmail',
  'companyName',
  'companyAddress',
  'offerCode',
  'offerDate',
  'expiryDate',
  'jobTitle',
  'designation',
  'department',
  'location',
  'employmentType',
  'workMode',
  'reportingManager',
  'joiningDate',
  'currency',
  'salary',
  'annualCTC',
  'monthlyBasic',
  'monthlyHra',
  'monthlyAllowances',
  'variablePay',
  'bonus',
  'probationMonths',
  'probationPeriod',
  'noticePeriodDays',
  'noticePeriod',
  'additionalTerms',
]);

const VARIABLE_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g;
const VARIABLE_LIKE_PATTERN = /{{[^{}]*}}/g;
const allowedVariables = new Set(OFFER_TEMPLATE_VARIABLES);

export const extractOfferTemplateVariables = (content = '') => {
  const variables = [];
  const unknownVariables = [];
  const seen = new Set();

  for (const match of String(content).matchAll(VARIABLE_LIKE_PATTERN)) {
    const parsed = /^{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}$/.exec(match[0]);
    const name = parsed?.[1] || match[0];

    if (!allowedVariables.has(name)) {
      if (!unknownVariables.includes(name)) unknownVariables.push(name);
      continue;
    }

    if (!seen.has(name)) {
      seen.add(name);
      variables.push(name);
    }
  }

  return { variables, unknownVariables };
};

export const renderOfferTemplate = ({ content = '', values = {} }) => {
  const { variables, unknownVariables } = extractOfferTemplateVariables(content);
  const unresolvedVariables = [];

  const renderedContent = String(content).replace(
    VARIABLE_PATTERN,
    (token, name) => {
      if (!allowedVariables.has(name)) return token;

      const value = values[name];
      const missing = value === null || value === undefined || String(value).trim() === '';

      if (missing) {
        if (!unresolvedVariables.includes(name)) unresolvedVariables.push(name);
        return `[Missing: ${name}]`;
      }

      return String(value);
    }
  );

  return {
    renderedContent,
    variables,
    unknownVariables,
    unresolvedVariables,
    valid: unknownVariables.length === 0 && unresolvedVariables.length === 0,
  };
};

const displayDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

const displayMoney = (value, currency) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';

  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency || ''} ${amount.toFixed(2)}`.trim();
  }
};

const displayEnum = (value) =>
  String(value || '')
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const buildOfferTemplateValues = (offer) => {
  const currency = offer.compensationSnapshot?.currency || '';
  const monthly = offer.compensationSnapshot?.monthly || {};

  return {
    candidateName: offer.candidateSnapshot?.name,
    candidateEmail: offer.candidateSnapshot?.email,
    companyName: offer.companySnapshot?.name,
    companyAddress: offer.companySnapshot?.address,
    offerCode: offer.offerCode,
    offerDate: displayDate(offer.terms?.offerDate),
    expiryDate: displayDate(offer.terms?.expiryDate),
    jobTitle: offer.jobSnapshot?.title,
    designation: offer.terms?.designation,
    department: offer.terms?.departmentName,
    location: offer.terms?.location,
    employmentType: displayEnum(offer.terms?.employmentType),
    workMode: displayEnum(offer.terms?.workMode),
    reportingManager: offer.terms?.reportingManagerName,
    joiningDate: displayDate(offer.terms?.joiningDate),
    currency,
    salary: displayMoney(offer.compensationSnapshot?.annualCTC, currency),
    annualCTC: displayMoney(offer.compensationSnapshot?.annualCTC, currency),
    monthlyBasic: displayMoney(monthly.basic, currency),
    monthlyHra: displayMoney(monthly.hra, currency),
    monthlyAllowances: displayMoney(monthly.allowances, currency),
    variablePay: displayMoney(offer.compensationSnapshot?.variablePay, currency),
    bonus: displayMoney(offer.compensationSnapshot?.bonus, currency),
    probationMonths: offer.terms?.probationMonths,
    probationPeriod: `${offer.terms?.probationMonths ?? 0} months`,
    noticePeriodDays: offer.terms?.noticePeriodDays,
    noticePeriod: `${offer.terms?.noticePeriodDays ?? 0} days`,
    additionalTerms: offer.terms?.additionalTerms,
  };
};

export const DEFAULT_OFFER_TEMPLATE_CONTENT = `Date: {{offerDate}}
Offer reference: {{offerCode}}

Dear {{candidateName}},

We are pleased to offer you the position of {{designation}} with {{companyName}}. Your work location will be {{location}} under a {{workMode}} arrangement.

Your proposed joining date is {{joiningDate}}. Your annual cost to company will be {{annualCTC}} ({{currency}}), subject to applicable deductions and the terms in this letter.

Your probation period will be {{probationMonths}} months and your notice period will be {{noticePeriodDays}} days.

This offer remains valid until {{expiryDate}}. Please review this letter and record your decision through the secure candidate portal.

We look forward to welcoming you to {{companyName}}.

Sincerely,
People Operations
{{companyName}}`;
