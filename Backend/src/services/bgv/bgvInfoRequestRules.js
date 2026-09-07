// Phase 30.9 — ADDITIONAL INFORMATION REQUEST rules (backend-authoritative).
//
//  - Request categories are a controlled allowlist per check; the frontend
//    mirror is a convenience only — unknown categories are rejected.
//  - There is NO category that can request credentials: passwords, OTPs,
//    DigiLocker/EPFO/banking logins and social-media secrets have no
//    workflow here (forbidden-pattern scan in QA).
//  - Every category declares a RESPONSE KIND:
//      FILE             → candidate uploads a replacement/addition through
//                          the secure portal (private storage, versioned;
//                          mapped to one of the five 30.5 evidence
//                          categories),
//      TEXT             → bounded clarification text,
//      REFERENCE_RECORD → adds ONE alternate reference record (validated by
//                          the 30.5 reference validator) — nothing else.
//  - A request never creates consent, never charges, never concludes,
//    never rejects; it only opens a controlled response window.

export const INFO_REQUEST_STATUSES = [
  'OPEN',
  'CANDIDATE_RESPONDED',
  'RESOLVED',
  'CANCELLED',
];

export const INFO_REQUEST_CATEGORIES = {
  IDENTITY: [
    'CLEARER_DOCUMENT',
    'ALTERNATE_ID_DOCUMENT',
    'SELFIE_REUPLOAD',
    'NAME_CLARIFICATION',
    'DOB_CLARIFICATION',
    'OTHER_IDENTITY_CLARIFICATION',
  ],
  ADDRESS: [
    'CLEARER_ADDRESS_PROOF',
    'RECENT_ADDRESS_PROOF',
    'ADDRESS_CLARIFICATION',
    'CONTACT_CLARIFICATION',
  ],
  EDUCATION: [
    'CLEARER_CERTIFICATE',
    'MARKSHEET',
    'ENROLLMENT_NUMBER',
    'INSTITUTION_DETAILS',
    'PASSING_YEAR_CLARIFICATION',
    'OTHER_EDUCATION_EVIDENCE',
  ],
  EMPLOYMENT: [
    'CLEARER_EMPLOYMENT_DOCUMENT',
    'EXPERIENCE_LETTER',
    'RELIEVING_LETTER',
    'EMPLOYEE_ID',
    'EMPLOYMENT_DATES',
    'HR_CONTACT',
    'OTHER_EMPLOYMENT_EVIDENCE',
  ],
  REFERENCE: [
    'REFERENCE_CONTACT_CORRECTION',
    'ALTERNATE_REFERENCE',
    'RELATIONSHIP_CLARIFICATION',
    'REFERENCE_DETAILS',
  ],
};

// Response kinds per category. FILE entries map to one of the five
// BGV_EVIDENCE_CATEGORIES so resubmissions slot into the existing private,
// versioned evidence architecture.
export const INFO_REQUEST_RESPONSE = {
  // IDENTITY
  'IDENTITY:CLEARER_DOCUMENT': { kind: 'FILE', evidenceCategory: 'IDENTITY_DOCUMENT' },
  'IDENTITY:ALTERNATE_ID_DOCUMENT': { kind: 'FILE', evidenceCategory: 'IDENTITY_DOCUMENT' },
  'IDENTITY:SELFIE_REUPLOAD': { kind: 'FILE', evidenceCategory: 'IDENTITY_SELFIE' },
  'IDENTITY:NAME_CLARIFICATION': { kind: 'TEXT' },
  'IDENTITY:DOB_CLARIFICATION': { kind: 'TEXT' },
  'IDENTITY:OTHER_IDENTITY_CLARIFICATION': { kind: 'TEXT' },
  // ADDRESS
  'ADDRESS:CLEARER_ADDRESS_PROOF': { kind: 'FILE', evidenceCategory: 'ADDRESS_PROOF' },
  'ADDRESS:RECENT_ADDRESS_PROOF': { kind: 'FILE', evidenceCategory: 'ADDRESS_PROOF' },
  'ADDRESS:ADDRESS_CLARIFICATION': { kind: 'TEXT' },
  'ADDRESS:CONTACT_CLARIFICATION': { kind: 'TEXT' },
  // EDUCATION
  'EDUCATION:CLEARER_CERTIFICATE': { kind: 'FILE', evidenceCategory: 'EDUCATION_CERTIFICATE' },
  'EDUCATION:MARKSHEET': { kind: 'FILE', evidenceCategory: 'EDUCATION_CERTIFICATE' },
  'EDUCATION:ENROLLMENT_NUMBER': { kind: 'TEXT' },
  'EDUCATION:INSTITUTION_DETAILS': { kind: 'TEXT' },
  'EDUCATION:PASSING_YEAR_CLARIFICATION': { kind: 'TEXT' },
  'EDUCATION:OTHER_EDUCATION_EVIDENCE': { kind: 'FILE', evidenceCategory: 'EDUCATION_CERTIFICATE' },
  // EMPLOYMENT
  'EMPLOYMENT:CLEARER_EMPLOYMENT_DOCUMENT': { kind: 'FILE', evidenceCategory: 'EMPLOYMENT_EVIDENCE' },
  'EMPLOYMENT:EXPERIENCE_LETTER': { kind: 'FILE', evidenceCategory: 'EMPLOYMENT_EVIDENCE' },
  'EMPLOYMENT:RELIEVING_LETTER': { kind: 'FILE', evidenceCategory: 'EMPLOYMENT_EVIDENCE' },
  'EMPLOYMENT:EMPLOYEE_ID': { kind: 'TEXT' },
  'EMPLOYMENT:EMPLOYMENT_DATES': { kind: 'TEXT' },
  'EMPLOYMENT:HR_CONTACT': { kind: 'TEXT' },
  'EMPLOYMENT:OTHER_EMPLOYMENT_EVIDENCE': { kind: 'FILE', evidenceCategory: 'EMPLOYMENT_EVIDENCE' },
  // REFERENCE
  'REFERENCE:REFERENCE_CONTACT_CORRECTION': { kind: 'TEXT' },
  'REFERENCE:ALTERNATE_REFERENCE': { kind: 'REFERENCE_RECORD' },
  'REFERENCE:RELATIONSHIP_CLARIFICATION': { kind: 'TEXT' },
  'REFERENCE:REFERENCE_DETAILS': { kind: 'TEXT' },
};

export const CATEGORY_LABELS = {
  CLEARER_DOCUMENT: 'A clearer copy of the identity document',
  ALTERNATE_ID_DOCUMENT: 'An alternate approved identity document',
  SELFIE_REUPLOAD: 'A new current photograph (selfie)',
  NAME_CLARIFICATION: 'Clarification of the legal name',
  DOB_CLARIFICATION: 'Clarification of the date of birth',
  OTHER_IDENTITY_CLARIFICATION: 'Identity clarification',
  CLEARER_ADDRESS_PROOF: 'A clearer copy of the address proof',
  RECENT_ADDRESS_PROOF: 'A more recent address proof',
  ADDRESS_CLARIFICATION: 'Address clarification',
  CONTACT_CLARIFICATION: 'Contact details clarification',
  CLEARER_CERTIFICATE: 'A clearer copy of the certificate',
  MARKSHEET: 'A marksheet supporting the qualification',
  ENROLLMENT_NUMBER: 'The enrollment / registration number',
  INSTITUTION_DETAILS: 'Institution details',
  PASSING_YEAR_CLARIFICATION: 'Clarification of the passing year',
  OTHER_EDUCATION_EVIDENCE: 'Additional education evidence',
  CLEARER_EMPLOYMENT_DOCUMENT: 'A clearer copy of the employment document',
  EXPERIENCE_LETTER: 'The experience letter',
  RELIEVING_LETTER: 'The relieving letter',
  EMPLOYEE_ID: 'The employee ID',
  EMPLOYMENT_DATES: 'Corrected employment dates',
  HR_CONTACT: 'A verifiable HR contact',
  OTHER_EMPLOYMENT_EVIDENCE: 'Additional employment evidence',
  REFERENCE_CONTACT_CORRECTION: 'Corrected reference contact details',
  ALTERNATE_REFERENCE: 'An alternate professional reference',
  RELATIONSHIP_CLARIFICATION: 'Clarification of the relationship',
  REFERENCE_DETAILS: 'Reference details',
};

export const requestResponseSpec = (checkType, category) =>
  INFO_REQUEST_RESPONSE[`${checkType}:${category}`] || null;

export const sanitizeRequestMessage = (message) =>
  String(message ?? '').trim().slice(0, 500);

export const sanitizeResponseText = (text) =>
  String(text ?? '').trim().slice(0, 1000);
