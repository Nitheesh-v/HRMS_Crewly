// Phase 30.8 — workbench field definitions (UI mirror of the backend
// OBSERVATION_SCHEMAS). The backend registry is authoritative: unknown or
// renamed fields are dropped server-side, so this mirror only drives the
// structured forms. No DigiLocker password/OTP fields exist anywhere —
// DigiLocker-assisted verification is manual/issuer-assisted only.

export const CONFIRMED = ['CONFIRMED', 'DISCREPANT', 'UNCONFIRMED'];
export const CONSISTENT = ['CONSISTENT', 'INCONSISTENT', 'UNCONFIRMED'];
export const MATCHES = ['MATCH', 'PARTIAL_MATCH', 'NO_MATCH', 'UNCONFIRMED'];

const CONTACT_BASE = [
  { key: 'contactedAt', label: 'Contacted at', type: 'date' },
  { key: 'recipientDescriptor', label: 'Safe recipient descriptor', type: 'string', max: 120, placeholder: 'e.g. HR desk, official landline' },
  { key: 'summary', label: 'Attempt summary', type: 'string', max: 500 },
];

export const METHOD_LABELS = {
  DOCUMENT_REVIEW: 'Document review',
  SELFIE_MANUAL_COMPARISON: 'Selfie manual comparison',
  CROSS_DOCUMENT_CONSISTENCY: 'Cross-document consistency',
  QR_ISSUER_VERIFICATION: 'QR / issuer verification',
  DIGILOCKER_ISSUER_ASSISTED: 'DigiLocker / issuer-assisted (manual)',
  MANUAL_VIDEO_VERIFICATION: 'Manual video verification',
  TELEPHONE_VERIFICATION: 'Telephone verification',
  FIELD_VERIFICATION: 'Field verification (manual)',
  CERTIFICATE_REVIEW: 'Certificate review',
  INSTITUTION_PORTAL: 'Institution portal',
  INSTITUTION_EMAIL: 'Institution email',
  INSTITUTION_PHONE: 'Institution phone',
  OFFICIAL_HR_EMAIL: 'Official HR email',
  HR_TELEPHONE: 'HR telephone',
  SUPPORTING_SALARY_EVIDENCE: 'Supporting salary evidence',
  UAN_EPFO_SUPPORTING_EVIDENCE: 'UAN / EPFO supporting evidence',
  TELEPHONE_REFERENCE: 'Telephone reference',
  EMAIL_REFERENCE: 'Email reference',
  RELATIONSHIP_AUTHENTICITY_CHECK: 'Relationship authenticity check',
};

export const OUTCOME_LABELS = {
  COMPLETED: 'Completed',
  CONTACTED: 'Contacted',
  NO_RESPONSE: 'No response',
  INVALID_CONTACT: 'Invalid contact',
  RESPONSE_RECEIVED: 'Response received',
  CALLBACK_REQUESTED: 'Callback requested',
  SOURCE_UNAVAILABLE: 'Source unavailable',
  DISCREPANCY_NOTED: 'Discrepancy noted',
};

const REFERENCE_QUESTIONNAIRE = [
  { key: 'relationship', label: 'Relationship with candidate', type: 'string', max: 120 },
  { key: 'periodKnown', label: 'Period known / worked together', type: 'string', max: 120 },
  { key: 'roleSummary', label: 'Role / responsibilities', type: 'string', max: 300 },
  { key: 'strengths', label: 'Strengths', type: 'string', max: 500 },
  { key: 'reliability', label: 'Reliability', type: 'enum', options: ['STRONG', 'SATISFACTORY', 'CONCERNS', 'DECLINED_TO_ANSWER'] },
  { key: 'professionalBehavior', label: 'Professional behavior', type: 'string', max: 500 },
  { key: 'rehireEligible', label: 'Rehire eligibility', type: 'enum', options: ['YES', 'NO', 'DECLINED_TO_ANSWER', 'NOT_APPLICABLE'] },
  { key: 'comments', label: 'Comments', type: 'string', max: 500 },
];

const DIGILOCKER_FIELDS = [
  { key: 'originRepresentation', label: 'Origin representation', type: 'enum', options: ['CANDIDATE_PROVIDED_DIGILOCKER'] },
  { key: 'issuer', label: 'Issuer', type: 'string', max: 120 },
  { key: 'mechanism', label: 'Verification mechanism used (manual/public)', type: 'string', max: 120 },
  { key: 'verifiedAt', label: 'Verified at', type: 'date' },
  { key: 'established', label: 'What was actually established', type: 'string', max: 500 },
];

// Field lists keyed "CHECK:METHOD" — mirrors backend OBSERVATION_SCHEMAS.
export const METHOD_FIELDS = {
  'IDENTITY:DOCUMENT_REVIEW': [
    { key: 'documentType', label: 'Document type', type: 'string', max: 60 },
    { key: 'matches', label: 'Document vs submitted data', type: 'enum', options: MATCHES },
    { key: 'summary', label: 'Review summary', type: 'string', max: 500 },
  ],
  'IDENTITY:SELFIE_MANUAL_COMPARISON': [
    { key: 'comparison', label: 'Manual comparison result', type: 'enum', options: ['MATCH', 'NO_MATCH', 'INCONCLUSIVE'] },
    { key: 'manualComparison', label: 'Manual comparison performed (no automated matching)', type: 'boolean' },
    { key: 'summary', label: 'Summary', type: 'string', max: 500 },
  ],
  'IDENTITY:CROSS_DOCUMENT_CONSISTENCY': [
    { key: 'nameConsistency', label: 'Name across documents', type: 'enum', options: CONSISTENT },
    { key: 'dobConsistency', label: 'Date of birth across documents', type: 'enum', options: CONSISTENT },
    { key: 'summary', label: 'Summary', type: 'string', max: 500 },
  ],
  'IDENTITY:QR_ISSUER_VERIFICATION': [
    { key: 'issuer', label: 'Source / issuer', type: 'string', max: 120 },
    { key: 'mechanism', label: 'Mechanism used', type: 'string', max: 120 },
    { key: 'verifiedAt', label: 'Verification timestamp', type: 'date' },
    { key: 'established', label: 'What was actually established', type: 'string', max: 500 },
  ],
  'IDENTITY:DIGILOCKER_ISSUER_ASSISTED': DIGILOCKER_FIELDS,
  'IDENTITY:MANUAL_VIDEO_VERIFICATION': [
    { key: 'conductedAt', label: 'Conducted at', type: 'date' },
    { key: 'durationMinutes', label: 'Duration (minutes)', type: 'number' },
    { key: 'videoStored', label: 'Video stored (policy default: no)', type: 'boolean' },
    { key: 'summary', label: 'Summary', type: 'string', max: 500 },
  ],
  'ADDRESS:DOCUMENT_REVIEW': [
    { key: 'evidenceType', label: 'Evidence type', type: 'string', max: 60 },
    { key: 'matches', label: 'Address facts vs submitted', type: 'enum', options: MATCHES },
    { key: 'summary', label: 'Summary', type: 'string', max: 500 },
  ],
  'ADDRESS:TELEPHONE_VERIFICATION': CONTACT_BASE,
  'ADDRESS:FIELD_VERIFICATION': [
    { key: 'visitDate', label: 'Visit date', type: 'date' },
    { key: 'located', label: 'Address located', type: 'enum', options: ['LOCATED', 'NOT_LOCATED', 'INCONCLUSIVE'] },
    { key: 'residenceConfirmed', label: 'Residence confirmation', type: 'enum', options: ['CONFIRMED', 'UNCONFIRMED', 'DECLINED'] },
    { key: 'summary', label: 'Safe notes', type: 'string', max: 500 },
  ],
  'EDUCATION:CERTIFICATE_REVIEW': [
    { key: 'institution', label: 'Institution', type: 'string', max: 200 },
    { key: 'qualification', label: 'Qualification', type: 'string', max: 120 },
    { key: 'matches', label: 'Certificate vs submitted', type: 'enum', options: MATCHES },
    { key: 'summary', label: 'Summary', type: 'string', max: 500 },
  ],
  'EDUCATION:INSTITUTION_PORTAL': [
    { key: 'portal', label: 'Portal', type: 'string', max: 120 },
    { key: 'accessedAt', label: 'Accessed at', type: 'date' },
    { key: 'established', label: 'What was established', type: 'string', max: 500 },
  ],
  'EDUCATION:INSTITUTION_EMAIL': [
    { key: 'institution', label: 'Institution', type: 'string', max: 200 },
    { key: 'officialDomain', label: 'Official institution domain', type: 'boolean' },
    { key: 'responseReceived', label: 'Response received', type: 'boolean' },
    { key: 'qualificationConfirmed', label: 'Qualification', type: 'enum', options: CONFIRMED },
    { key: 'passingYearConfirmed', label: 'Passing year', type: 'enum', options: CONFIRMED },
    { key: 'enrollmentConfirmed', label: 'Enrollment / registration', type: 'enum', options: CONFIRMED },
    ...CONTACT_BASE,
  ],
  'EDUCATION:INSTITUTION_PHONE': [
    { key: 'institution', label: 'Institution', type: 'string', max: 200 },
    { key: 'qualificationConfirmed', label: 'Qualification', type: 'enum', options: CONFIRMED },
    { key: 'passingYearConfirmed', label: 'Passing year', type: 'enum', options: CONFIRMED },
    ...CONTACT_BASE,
  ],
  'EDUCATION:DIGILOCKER_ISSUER_ASSISTED': DIGILOCKER_FIELDS,
  'EMPLOYMENT:DOCUMENT_REVIEW': [
    { key: 'documentType', label: 'Document type', type: 'string', max: 60, placeholder: 'experience letter, relieving letter…' },
    { key: 'matches', label: 'Document vs submitted', type: 'enum', options: MATCHES },
    { key: 'summary', label: 'Summary', type: 'string', max: 500 },
  ],
  'EMPLOYMENT:OFFICIAL_HR_EMAIL': [
    { key: 'employer', label: 'Employer', type: 'string', max: 200 },
    { key: 'officialDomain', label: 'Official employer domain (personal email is an attempt source only)', type: 'boolean' },
    { key: 'responseReceived', label: 'Response received', type: 'boolean' },
    { key: 'employeeIdConfirmed', label: 'Employee ID', type: 'enum', options: ['CONFIRMED', 'NOT_REQUESTED', 'UNCONFIRMED'] },
    { key: 'designationConfirmed', label: 'Designation', type: 'enum', options: CONFIRMED },
    { key: 'startDateConfirmed', label: 'Start date', type: 'enum', options: CONFIRMED },
    { key: 'endDateConfirmed', label: 'End date', type: 'enum', options: CONFIRMED },
    { key: 'salaryConfirmed', label: 'Salary (only where policy permits)', type: 'enum', options: ['CONFIRMED', 'NOT_REQUESTED', 'UNCONFIRMED', 'DECLINED'] },
    ...CONTACT_BASE,
  ],
  'EMPLOYMENT:HR_TELEPHONE': [
    { key: 'employer', label: 'Employer', type: 'string', max: 200 },
    { key: 'employeeIdConfirmed', label: 'Employee ID', type: 'enum', options: ['CONFIRMED', 'NOT_REQUESTED', 'UNCONFIRMED'] },
    { key: 'designationConfirmed', label: 'Designation', type: 'enum', options: CONFIRMED },
    { key: 'startDateConfirmed', label: 'Start date', type: 'enum', options: CONFIRMED },
    { key: 'endDateConfirmed', label: 'End date', type: 'enum', options: CONFIRMED },
    ...CONTACT_BASE,
  ],
  'EMPLOYMENT:SUPPORTING_SALARY_EVIDENCE': [
    { key: 'evidenceType', label: 'Evidence type', type: 'enum', options: ['PAYSLIP', 'BANK_STATEMENT', 'FORM16', 'OTHER'] },
    { key: 'periodCovered', label: 'Period covered', type: 'string', max: 80 },
    { key: 'consistent', label: 'Consistency (amounts are never stored)', type: 'enum', options: CONSISTENT },
    { key: 'summary', label: 'Summary', type: 'string', max: 500 },
  ],
  'EMPLOYMENT:UAN_EPFO_SUPPORTING_EVIDENCE': [
    { key: 'uanLast4', label: 'UAN last four digits only', type: 'string', max: 4, placeholder: '4321' },
    { key: 'recordsConsistent', label: 'EPFO records (supporting only)', type: 'enum', options: CONSISTENT },
    { key: 'summary', label: 'Summary', type: 'string', max: 500 },
  ],
  'REFERENCE:TELEPHONE_REFERENCE': [...REFERENCE_QUESTIONNAIRE, ...CONTACT_BASE],
  'REFERENCE:EMAIL_REFERENCE': [...REFERENCE_QUESTIONNAIRE, ...CONTACT_BASE],
  'REFERENCE:RELATIONSHIP_AUTHENTICITY_CHECK': [
    { key: 'authenticity', label: 'Authenticity', type: 'enum', options: ['AUTHENTIC', 'QUESTIONABLE', 'UNCONFIRMED'] },
    { key: 'indicators', label: 'Indicators', type: 'string', max: 500 },
  ],
};

export const CONCLUSION_COPY = {
  VERIFIED: {
    label: 'Verified',
    hint: 'Requires at least one completed primary verification activity and no recorded discrepancies.',
  },
  VERIFIED_WITH_DISCREPANCY: {
    label: 'Verified with discrepancy',
    hint: 'Requires at least one structured discrepancy (field, claimed vs source-confirmed, explanation).',
  },
  UNABLE_TO_VERIFY: {
    label: 'Unable to verify',
    hint: 'Requires a reason and recorded attempt context. A non-responsive source is never treated as candidate failure.',
  },
  INCONCLUSIVE: {
    label: 'Inconclusive',
    hint: 'Requires an explanation.',
  },
};

export const severityLabel = (severity) =>
  ({ INFO: 'Info', MINOR: 'Minor', MAJOR: 'Major' })[severity] || severity;
