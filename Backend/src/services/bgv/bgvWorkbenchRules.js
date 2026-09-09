// Phase 30.8 — BGV verification workbench RULES (backend-authoritative).
//
// Everything here is the single source of truth for:
//  - the controlled METHOD REGISTRY per check (frontend mirrors are a
//    convenience only; arbitrary method identifiers are rejected),
//  - per-method attempt outcomes (contact attempts are append-only history —
//    an individual attempt outcome is NEVER the final check conclusion),
//  - structured per-method observation schemas (no giant free-text box;
//    unknown fields are dropped, forbidden fields are rejected),
//  - the standardized reference questionnaire (no protected/sensitive
//    personal-characteristic questions),
//  - the conclusion readiness engine (VERIFIED requires real work;
//    discrepancy conclusions require structured discrepancies),
//  - human-decision boundary: conclusions are BGV findings only — never a
//    candidate reject/hire/JOINED transition, never an automatic BGV CLEAR.
//
// DigiLocker boundary: DIGILOCKER_ISSUER_ASSISTED records a MANUAL /
// issuer-assisted verification of candidate-provided material. No DigiLocker
// API, no credentials, no OTP, no scraping — those fields are rejected.

export const WORKBENCH_STATES = ['IN_PROGRESS', 'AWAITING_THIRD_PARTY', 'SUBMITTED'];

// Verification conclusions — separate concept from operational state.
export const CONCLUSIONS = [
  'VERIFIED',
  'VERIFIED_WITH_DISCREPANCY',
  'UNABLE_TO_VERIFY',
  'INCONCLUSIVE',
  'CANCELLED',
];

// Verifiers may submit everything except CANCELLED (Super-Admin-only).
export const VERIFIER_CONCLUSIONS = CONCLUSIONS.filter((value) => value !== 'CANCELLED');

export const ATTEMPT_OUTCOMES = [
  'COMPLETED',
  'CONTACTED',
  'NO_RESPONSE',
  'INVALID_CONTACT',
  'RESPONSE_RECEIVED',
  'CALLBACK_REQUESTED',
  'SOURCE_UNAVAILABLE',
  'DISCREPANCY_NOTED',
];

// Outcomes that represent substantive verification work for readiness.
export const SUBSTANTIVE_OUTCOMES = ['COMPLETED', 'CONTACTED', 'RESPONSE_RECEIVED'];

// Supporting-evidence-only methods: they can corroborate but are never a
// sole automatic verification basis (UAN/EPFO and salary evidence policy).
export const SUPPORTING_ONLY_METHODS = ['UAN_EPFO_SUPPORTING_EVIDENCE', 'SUPPORTING_SALARY_EVIDENCE'];

const CONTACT_OUTCOMES = [
  'CONTACTED',
  'NO_RESPONSE',
  'INVALID_CONTACT',
  'RESPONSE_RECEIVED',
  'CALLBACK_REQUESTED',
  'SOURCE_UNAVAILABLE',
];
const REVIEW_OUTCOMES = ['COMPLETED', 'DISCREPANCY_NOTED'];
const PORTAL_OUTCOMES = ['COMPLETED', 'RESPONSE_RECEIVED', 'NO_RESPONSE', 'SOURCE_UNAVAILABLE'];

export const DISCREPANCY_SEVERITIES = ['INFO', 'MINOR', 'MAJOR'];

// ── controlled method registry per check ──────────────────────────
export const METHOD_REGISTRY = {
  IDENTITY: [
    'DOCUMENT_REVIEW',
    'SELFIE_MANUAL_COMPARISON',
    'CROSS_DOCUMENT_CONSISTENCY',
    'QR_ISSUER_VERIFICATION',
    'DIGILOCKER_ISSUER_ASSISTED',
    'MANUAL_VIDEO_VERIFICATION',
  ],
  ADDRESS: ['DOCUMENT_REVIEW', 'TELEPHONE_VERIFICATION', 'FIELD_VERIFICATION'],
  EDUCATION: [
    'CERTIFICATE_REVIEW',
    'INSTITUTION_PORTAL',
    'INSTITUTION_EMAIL',
    'INSTITUTION_PHONE',
    'DIGILOCKER_ISSUER_ASSISTED',
  ],
  EMPLOYMENT: [
    'DOCUMENT_REVIEW',
    'OFFICIAL_HR_EMAIL',
    'HR_TELEPHONE',
    'SUPPORTING_SALARY_EVIDENCE',
    'UAN_EPFO_SUPPORTING_EVIDENCE',
  ],
  REFERENCE: ['TELEPHONE_REFERENCE', 'EMAIL_REFERENCE', 'RELATIONSHIP_AUTHENTICITY_CHECK'],
};

export const METHOD_OUTCOMES = {
  // IDENTITY
  'IDENTITY:DOCUMENT_REVIEW': REVIEW_OUTCOMES,
  'IDENTITY:SELFIE_MANUAL_COMPARISON': REVIEW_OUTCOMES,
  'IDENTITY:CROSS_DOCUMENT_CONSISTENCY': REVIEW_OUTCOMES,
  'IDENTITY:QR_ISSUER_VERIFICATION': [...REVIEW_OUTCOMES, 'SOURCE_UNAVAILABLE'],
  'IDENTITY:DIGILOCKER_ISSUER_ASSISTED': [...REVIEW_OUTCOMES, 'SOURCE_UNAVAILABLE'],
  'IDENTITY:MANUAL_VIDEO_VERIFICATION': REVIEW_OUTCOMES,
  // ADDRESS
  'ADDRESS:DOCUMENT_REVIEW': REVIEW_OUTCOMES,
  'ADDRESS:TELEPHONE_VERIFICATION': CONTACT_OUTCOMES,
  'ADDRESS:FIELD_VERIFICATION': [...REVIEW_OUTCOMES, 'SOURCE_UNAVAILABLE'],
  // EDUCATION
  'EDUCATION:CERTIFICATE_REVIEW': REVIEW_OUTCOMES,
  'EDUCATION:INSTITUTION_PORTAL': PORTAL_OUTCOMES,
  'EDUCATION:INSTITUTION_EMAIL': CONTACT_OUTCOMES,
  'EDUCATION:INSTITUTION_PHONE': CONTACT_OUTCOMES,
  'EDUCATION:DIGILOCKER_ISSUER_ASSISTED': [...REVIEW_OUTCOMES, 'SOURCE_UNAVAILABLE'],
  // EMPLOYMENT
  'EMPLOYMENT:DOCUMENT_REVIEW': REVIEW_OUTCOMES,
  'EMPLOYMENT:OFFICIAL_HR_EMAIL': CONTACT_OUTCOMES,
  'EMPLOYMENT:HR_TELEPHONE': CONTACT_OUTCOMES,
  'EMPLOYMENT:SUPPORTING_SALARY_EVIDENCE': [...REVIEW_OUTCOMES, 'SOURCE_UNAVAILABLE'],
  'EMPLOYMENT:UAN_EPFO_SUPPORTING_EVIDENCE': [...REVIEW_OUTCOMES, 'SOURCE_UNAVAILABLE'],
  // REFERENCE
  'REFERENCE:TELEPHONE_REFERENCE': CONTACT_OUTCOMES,
  'REFERENCE:EMAIL_REFERENCE': CONTACT_OUTCOMES,
  'REFERENCE:RELATIONSHIP_AUTHENTICITY_CHECK': REVIEW_OUTCOMES,
};

// ── observation field primitives ──────────────────────────────────
const str = (max) => ({ type: 'string', max });
const bool = () => ({ type: 'boolean' });
const date = () => ({ type: 'date' });
const enumeration = (options) => ({ type: 'enum', options });

const CONFIRMED_TRISTATE = enumeration(['CONFIRMED', 'DISCREPANT', 'UNCONFIRMED']);
const CONSISTENT_TRISTATE = enumeration(['CONSISTENT', 'INCONSISTENT', 'UNCONFIRMED']);

const CONTACT_BASE = {
  contactedAt: date(),
  recipientDescriptor: str(120), // safe descriptor: "HR desk, official landline"
  summary: str(500),
};

const REFERENCE_QUESTIONNAIRE = {
  relationship: str(120),
  periodKnown: str(120),
  roleSummary: str(300),
  strengths: str(500),
  reliability: enumeration(['STRONG', 'SATISFACTORY', 'CONCERNS', 'DECLINED_TO_ANSWER']),
  professionalBehavior: str(500),
  rehireEligible: enumeration(['YES', 'NO', 'DECLINED_TO_ANSWER', 'NOT_APPLICABLE']),
  comments: str(500),
};

// Per-method structured observation schemas. Unknown fields are dropped;
// required fields validated; free-text notes supplement, never replace.
export const OBSERVATION_SCHEMAS = {
  'IDENTITY:DOCUMENT_REVIEW': {
    documentType: str(60),
    matches: enumeration(['MATCH', 'PARTIAL_MATCH', 'NO_MATCH', 'UNCONFIRMED']),
    summary: str(500),
  },
  'IDENTITY:SELFIE_MANUAL_COMPARISON': {
    // Explicitly MANUAL: no automated facial recognition/biometrics exist.
    comparison: enumeration(['MATCH', 'NO_MATCH', 'INCONCLUSIVE']),
    manualComparison: bool(),
    summary: str(500),
  },
  'IDENTITY:CROSS_DOCUMENT_CONSISTENCY': {
    nameConsistency: enumeration(['CONSISTENT', 'INCONSISTENT', 'UNCONFIRMED']),
    dobConsistency: enumeration(['CONSISTENT', 'INCONSISTENT', 'UNCONFIRMED']),
    summary: str(500),
  },
  'IDENTITY:QR_ISSUER_VERIFICATION': {
    issuer: str(120),
    mechanism: str(120), // e.g. issuer's public verification page
    verifiedAt: date(),
    established: str(500), // exactly what was established — never claims
    // government authentication beyond what actually occurred
  },
  'IDENTITY:DIGILOCKER_ISSUER_ASSISTED': {
    originRepresentation: enumeration(['CANDIDATE_PROVIDED_DIGILOCKER']),
    issuer: str(120),
    mechanism: str(120),
    verifiedAt: date(),
    established: str(500),
  },
  'IDENTITY:MANUAL_VIDEO_VERIFICATION': {
    conductedAt: date(),
    durationMinutes: { type: 'number', min: 1, max: 240 },
    videoStored: bool(), // policy default false; never auto-stored
    summary: str(500),
  },
  'ADDRESS:DOCUMENT_REVIEW': {
    evidenceType: str(60),
    matches: enumeration(['MATCH', 'PARTIAL_MATCH', 'NO_MATCH', 'UNCONFIRMED']),
    summary: str(500),
  },
  'ADDRESS:TELEPHONE_VERIFICATION': CONTACT_BASE,
  'ADDRESS:FIELD_VERIFICATION': {
    visitDate: date(),
    located: enumeration(['LOCATED', 'NOT_LOCATED', 'INCONCLUSIVE']),
    residenceConfirmed: enumeration(['CONFIRMED', 'UNCONFIRMED', 'DECLINED']),
    summary: str(500), // no GPS/geolocation fields exist on purpose
  },
  'EDUCATION:CERTIFICATE_REVIEW': {
    institution: str(200),
    qualification: str(120),
    matches: enumeration(['MATCH', 'PARTIAL_MATCH', 'NO_MATCH', 'UNCONFIRMED']),
    summary: str(500),
  },
  'EDUCATION:INSTITUTION_PORTAL': {
    portal: str(120),
    accessedAt: date(),
    established: str(500),
  },
  'EDUCATION:INSTITUTION_EMAIL': {
    institution: str(200),
    officialDomain: bool(),
    responseReceived: bool(),
    qualificationConfirmed: CONFIRMED_TRISTATE,
    passingYearConfirmed: CONFIRMED_TRISTATE,
    enrollmentConfirmed: CONFIRMED_TRISTATE,
    ...CONTACT_BASE,
  },
  'EDUCATION:INSTITUTION_PHONE': {
    institution: str(200),
    qualificationConfirmed: CONFIRMED_TRISTATE,
    passingYearConfirmed: CONFIRMED_TRISTATE,
    ...CONTACT_BASE,
  },
  'EDUCATION:DIGILOCKER_ISSUER_ASSISTED': {
    originRepresentation: enumeration(['CANDIDATE_PROVIDED_DIGILOCKER']),
    issuer: str(120),
    mechanism: str(120),
    verifiedAt: date(),
    established: str(500),
  },
  'EMPLOYMENT:DOCUMENT_REVIEW': {
    documentType: str(60), // experience letter, relieving letter…
    matches: enumeration(['MATCH', 'PARTIAL_MATCH', 'NO_MATCH', 'UNCONFIRMED']),
    summary: str(500),
  },
  'EMPLOYMENT:OFFICIAL_HR_EMAIL': {
    employer: str(200),
    officialDomain: bool(), // false ⇒ personal email: recorded as an attempt
    // source only, never mislabelled as official-domain verification
    responseReceived: bool(),
    employeeIdConfirmed: enumeration(['CONFIRMED', 'NOT_REQUESTED', 'UNCONFIRMED']),
    designationConfirmed: CONFIRMED_TRISTATE,
    startDateConfirmed: CONFIRMED_TRISTATE,
    endDateConfirmed: CONFIRMED_TRISTATE,
    salaryConfirmed: enumeration(['CONFIRMED', 'NOT_REQUESTED', 'UNCONFIRMED', 'DECLINED']),
    ...CONTACT_BASE,
  },
  'EMPLOYMENT:HR_TELEPHONE': {
    employer: str(200),
    employeeIdConfirmed: enumeration(['CONFIRMED', 'NOT_REQUESTED', 'UNCONFIRMED']),
    designationConfirmed: CONFIRMED_TRISTATE,
    startDateConfirmed: CONFIRMED_TRISTATE,
    endDateConfirmed: CONFIRMED_TRISTATE,
    ...CONTACT_BASE,
  },
  'EMPLOYMENT:SUPPORTING_SALARY_EVIDENCE': {
    evidenceType: enumeration(['PAYSLIP', 'BANK_STATEMENT', 'FORM16', 'OTHER']),
    periodCovered: str(80),
    consistent: CONSISTENT_TRISTATE, // consistency only — amounts never stored
    summary: str(500),
  },
  'EMPLOYMENT:UAN_EPFO_SUPPORTING_EVIDENCE': {
    uanLast4: { type: 'digits4' }, // LAST FOUR ONLY — full UAN is rejected
    recordsConsistent: CONSISTENT_TRISTATE,
    summary: str(500), // supporting evidence only — never a sole basis
  },
  'REFERENCE:TELEPHONE_REFERENCE': { ...REFERENCE_QUESTIONNAIRE, ...CONTACT_BASE },
  'REFERENCE:EMAIL_REFERENCE': { ...REFERENCE_QUESTIONNAIRE, ...CONTACT_BASE },
  'REFERENCE:RELATIONSHIP_AUTHENTICITY_CHECK': {
    authenticity: enumeration(['AUTHENTIC', 'QUESTIONABLE', 'UNCONFIRMED']),
    indicators: str(500),
  },
};

// Keys rejected outright anywhere in observations (case-insensitive):
// credentials, geolocation, full identifiers.
const FORBIDDEN_KEY_PATTERN =
  /^(password|passwd|otp|credential|credentials|secret|token|latitude|longitude|lat|lng|gps|geolocation|aadhaar|aadhar|pan|uan)$/i;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Sanitize client observations against the schema. Unknown keys are
// dropped; forbidden keys throw; strings are trimmed + length-bounded
// (rendered as escaped text by React — no HTML is ever interpreted).
export const sanitizeObservations = ({ checkType, method, observations }) => {
  const schema = OBSERVATION_SCHEMAS[`${checkType}:${method}`];
  if (!schema) throw Object.assign(new Error('Unsupported method'), { statusCode: 400 });
  const input = isPlainObject(observations) ? observations : {};
  const clean = {};

  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw Object.assign(new Error('Field not permitted'), { statusCode: 400 });
    }
  }
  // uanLast4 guard: reject anything that looks like a full UAN elsewhere.
  for (const [key, value] of Object.entries(input)) {
    if (/uan/i.test(key) && key !== 'uanLast4' && typeof value === 'string' && value.replace(/\D/g, '').length > 4) {
      throw Object.assign(new Error('Field not permitted'), { statusCode: 400 });
    }
  }

  for (const [key, rule] of Object.entries(schema)) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null || value === '') continue;
    if (rule.type === 'string') {
      const text = String(value).trim().slice(0, rule.max);
      if (text) clean[key] = text;
    } else if (rule.type === 'boolean') {
      clean[key] = Boolean(value);
    } else if (rule.type === 'date') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) clean[key] = parsed;
    } else if (rule.type === 'enum') {
      if (rule.options.includes(String(value))) clean[key] = String(value);
    } else if (rule.type === 'number') {
      const num = Number(value);
      if (Number.isFinite(num) && num >= rule.min && num <= rule.max) clean[key] = num;
    } else if (rule.type === 'digits4') {
      const digits = String(value).replace(/\D/g, '').slice(-4);
      if (digits.length >= 1 && digits.length <= 4) clean[key] = digits;
    }
  }
  return clean;
};

export const sanitizeNotes = (notes) => {
  const text = String(notes ?? '').trim();
  return text.slice(0, 2000);
};

export const sanitizeDiscrepancy = ({ field, candidateClaimed, sourceConfirmed, severity, explanation }) => {
  const cleanField = String(field ?? '').trim().slice(0, 80);
  const cleanClaimed = String(candidateClaimed ?? '').trim().slice(0, 300);
  const cleanSource = String(sourceConfirmed ?? '').trim().slice(0, 300);
  const cleanExplanation = String(explanation ?? '').trim().slice(0, 1000);
  const cleanSeverity = DISCREPANCY_SEVERITIES.includes(String(severity)) ? String(severity) : 'INFO';
  if (!cleanField || !cleanClaimed || !cleanSource || !cleanExplanation) {
    throw Object.assign(new Error('Discrepancy requires field, claimed value, source value and explanation'), {
      statusCode: 400,
    });
  }
  return {
    field: cleanField,
    candidateClaimed: cleanClaimed,
    sourceConfirmed: cleanSource,
    severity: cleanSeverity,
    explanation: cleanExplanation,
  };
};

// ── conclusion readiness engine (backend enforcement) ─────────────
export const evaluateConclusionReadiness = ({ conclusion, reason, activities = [], discrepancies = [] }) => {
  const errors = [];
  const trimmedReason = String(reason ?? '').trim();

  if (!CONCLUSIONS.includes(String(conclusion))) {
    return { ok: false, errors: ['Unknown conclusion'] };
  }
  if (String(conclusion) === 'CANCELLED') {
    // Only reachable through the platform cancel path; verifier surface
    // never offers it.
    if (trimmedReason.length < 10) errors.push('Cancellation requires a business reason (min 10 characters)');
    return { ok: errors.length === 0, errors };
  }
  if (String(conclusion) === 'VERIFIED') {
    const substantive = activities.filter(
      (activity) =>
        SUBSTANTIVE_OUTCOMES.includes(activity.outcome) &&
        !SUPPORTING_ONLY_METHODS.includes(activity.method)
    );
    if (substantive.length === 0) {
      errors.push('VERIFIED requires at least one completed primary verification activity (supporting UAN/salary evidence alone is not sufficient)');
    }
    if (discrepancies.length > 0) {
      errors.push('Recorded discrepancies exist — submit VERIFIED_WITH_DISCREPANCY instead');
    }
  }
  if (String(conclusion) === 'VERIFIED_WITH_DISCREPANCY') {
    if (activities.length === 0) errors.push('At least one verification activity is required');
    if (discrepancies.length === 0) {
      errors.push('VERIFIED_WITH_DISCREPANCY requires at least one structured discrepancy');
    }
  }
  if (String(conclusion) === 'UNABLE_TO_VERIFY') {
    if (trimmedReason.length < 10) errors.push('UNABLE_TO_VERIFY requires a reason (min 10 characters)');
    if (activities.length === 0) {
      errors.push('UNABLE_TO_VERIFY requires recorded attempt context (at least one activity)');
    }
  }
  if (String(conclusion) === 'INCONCLUSIVE') {
    if (trimmedReason.length < 10) errors.push('INCONCLUSIVE requires an explanation (min 10 characters)');
  }
  return { ok: errors.length === 0, errors };
};

// ── safe workbench view (shared with the 30.7 check detail DTO) ────
export const safeActivity = (activity) => ({
  seq: activity.seq,
  method: activity.method,
  outcome: activity.outcome,
  verifierId: String(activity.verifier),
  at: activity.at,
  observations: activity.observations || {},
  notes: activity.notes || '',
  evidenceFileId: activity.evidenceFile ? String(activity.evidenceFile) : null,
});

// When no verification row exists yet (freshly assigned check), the
// workbench must still render its registry forms — the record itself is
// created lazily on the first recorded activity. Gating the forms behind
// the record's existence deadlocks the workflow (Phase 30.8 RCA).
export const buildWorkbenchView = (verification, fallbackCheckType = null) => {
  const checkType = verification?.checkType || fallbackCheckType;
  if (!checkType) return null;
  const submitted = verification?.state === 'SUBMITTED';
  return {
    state: verification?.state || 'IN_PROGRESS',
    activities: (verification?.activities || []).map(safeActivity),
    discrepancies: (verification?.discrepancies || []).map((entry) => ({ ...entry, recordedBy: String(entry.recordedBy) })),
    conclusion: verification?.conclusion || null,
    // Registry mirror for the UI — the backend re-validates every call.
    allowedMethods: METHOD_REGISTRY[checkType] || [],
    methodOutcomes: Object.fromEntries(
      (METHOD_REGISTRY[checkType] || []).map((method) => [method, METHOD_OUTCOMES[`${checkType}:${method}`] || []])
    ),
    verifierConclusions: VERIFIER_CONCLUSIONS,
    states: WORKBENCH_STATES,
    locked: submitted,
    // Phase 30.10 — QA lifecycle + immutable revision history for the UI.
    qaStatus:
      verification?.qa?.status && verification.qa.status !== 'NONE'
        ? verification.qa.status
        : verification?.qaStatus || 'NONE',
    qaReturnReason: verification?.qa?.returnReason || verification?.qaReturnReason || '',
    revision: verification?.qa?.currentRevision || (verification?.submissions || []).length,
    submissions: (verification?.submissions || []).map((entry) => ({
      revision: entry.revision,
      conclusion: entry.conclusion?.value || null,
      submittedAt: entry.submittedAt || null,
      qaStatus: entry.qa?.status || 'PENDING',
      qaReturnReason: entry.qa?.returnReason || '',
      reviewedAt: entry.qa?.reviewedAt || null,
    })),
  };
};
