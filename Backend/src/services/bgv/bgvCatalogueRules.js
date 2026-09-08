// Phase 30.2 — BGV SERVICE CATALOGUE & PRICING (pure rules).
//
// The five Crewly BGV products are platform-owned and backend-allowlisted.
// The frontend can never define a sixth product: unknown types are rejected
// here before any database work.
//
// Money representation: integer minor currency units (paise for INR).
// ₹499.00 === 49900. No floating-point money arithmetic anywhere; parsing and
// formatting use integer math only. The legacy billing stack stores whole
// rupees and multiplies by 100 at the Razorpay boundary — Phase 30.3 will map
// minor units to that boundary without losing precision.

export const BGV_CATALOGUE_CURRENCY = 'INR';

// Exactly five products in Phase 30.2. Criminal/court/watchlist/PEP/credit/
// medical/drug/licence checks are deliberately absent (future phases only).
export const BGV_CATALOGUE_TYPES = [
  'IDENTITY',
  'ADDRESS',
  'EDUCATION',
  'EMPLOYMENT',
  'REFERENCE',
];

// Backend-owned human definitions; the database stores only the commercial
// configuration (price/active/description overrides/provenance).
export const BGV_CATALOGUE_DEFINITIONS = {
  IDENTITY: {
    name: 'Identity Verification',
    description:
      'Manual document review with cross-document consistency checks, document + selfie comparison and issuer-assisted (e.g. DigiLocker) evidence where actually available.',
  },
  ADDRESS: {
    name: 'Address Verification',
    description:
      'Address-document review with phone verification and optional field verification where policy permits.',
  },
  EDUCATION: {
    name: 'Education Verification',
    description:
      'Certificate review against institution portals, institution email/letter confirmation or issuer-assisted (e.g. DigiLocker) evidence.',
  },
  EMPLOYMENT: {
    name: 'Employment Verification',
    description:
      'Official employer HR email or telephone verification with supporting employment documents and appropriately consented salary-credit evidence.',
  },
  REFERENCE: {
    name: 'Reference Verification',
    description:
      'Structured telephone/email reference questionnaire with referee relationship and authenticity checks plus attempt history.',
  },
};

// ₹1,00,000.00 per service — a sane commercial ceiling for a single check.
export const BGV_PRICE_MAX_MINOR = 10_000_000;

// Zero is an explicit, supported business rule (a free promotional service).
// Negative, NaN, Infinity and malformed money are always rejected.
export const BGV_PRICE_MIN_MINOR = 0;

const MONEY_PATTERN = /^\d{1,7}(?:\.\d{1,2})?$/;

// Parse a rupee amount (string like "499" / "499.5" / "499.99", or a finite
// number) into integer minor units using string/integer math only.
export const parsePriceToMinorUnits = (input) => {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      return { ok: false, reason: 'Price must be a finite number' };
    }
    input = String(input);
  }
  if (typeof input !== 'string') {
    return { ok: false, reason: 'Price must be a number or string' };
  }
  const value = input.trim();
  if (!MONEY_PATTERN.test(value)) {
    return { ok: false, reason: 'Price must be a valid amount with at most two decimals' };
  }
  const [rupeePart, paisePart = ''] = value.split('.');
  const minor =
    Number.parseInt(rupeePart, 10) * 100 +
    Number.parseInt(paisePart.padEnd(2, '0'), 10);
  if (!Number.isSafeInteger(minor)) {
    return { ok: false, reason: 'Price is not representable in minor units' };
  }
  if (minor < BGV_PRICE_MIN_MINOR) {
    return { ok: false, reason: 'Price must not be negative' };
  }
  if (minor > BGV_PRICE_MAX_MINOR) {
    return { ok: false, reason: 'Price exceeds the allowed catalogue maximum' };
  }
  return { ok: true, minor };
};

// Format integer minor units for display using integer math only.
export const formatMinorUnits = (minor) => {
  const safe = Number.isSafeInteger(minor) && minor >= 0 ? minor : 0;
  const rupees = Math.floor(safe / 100);
  const paise = safe % 100;
  return `₹${rupees.toLocaleString('en-IN')}.${String(paise).padStart(2, '0')}`;
};

export const isCatalogueType = (type) => BGV_CATALOGUE_TYPES.includes(type);

export const DESCRIPTION_MAX_LENGTH = 2000;

// Validate a configure/update payload. Returns { ok, value } or { ok, errors }.
export const validateCataloguePayload = (payload = {}) => {
  const errors = [];
  const { type, price, currency, description, active } = payload;

  if (!isCatalogueType(type)) {
    errors.push('Unknown BGV service type');
  }

  // Price is optional on update (activate/deactivate-only mutations exist);
  // the service enforces "price required" for first-time configuration.
  let minor = null;
  if (price !== undefined && price !== null && price !== '') {
    const parsed = parsePriceToMinorUnits(price);
    if (!parsed.ok) errors.push(parsed.reason);
    else minor = parsed.minor;
  }

  if (currency !== undefined && currency !== BGV_CATALOGUE_CURRENCY) {
    errors.push(`Only ${BGV_CATALOGUE_CURRENCY} is supported`);
  }

  let safeDescription;
  if (description !== undefined) {
    safeDescription = String(description ?? '').trim();
    if (safeDescription.length > DESCRIPTION_MAX_LENGTH) {
      errors.push('Keep the description within 2000 characters');
    }
  }

  if (active !== undefined && typeof active !== 'boolean') {
    errors.push('Active must be a boolean');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      type,
      priceMinorUnits: minor,
      description: safeDescription,
      active: typeof active === 'boolean' ? active : undefined,
    },
  };
};
