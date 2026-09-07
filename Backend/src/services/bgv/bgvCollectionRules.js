// Phase 30.5 — candidate BGV collection RULES (pure, no I/O).
//
// Central home for: purchased-check authorization, identifier validation &
// masking (full numbers never persist), structured record validation,
// readiness computation for purchased checks only, and collection states.
// The backend — not the frontend — decides readiness and submission.

import {
  ADDRESS_EVIDENCE_CATEGORIES,
  BGV_IDENTITY_DOCUMENT_TYPES,
  RESIDENCE_TYPES,
} from '../../models/BgvCollectionCase.js';
import { BGV_EVIDENCE_CATEGORIES } from '../../models/BgvEvidenceFile.js';

export const BGV_COLLECTION_PURPOSE = 'BGV_COLLECTION';

export const COLLECTION_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
};

// HR-facing collection visibility (minimum-necessary: status only).
export const HR_COLLECTION_STATUS = {
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  AWAITING_CANDIDATE: 'AWAITING_CANDIDATE',
  CANDIDATE_DRAFT: 'CANDIDATE_DRAFT',
  CANDIDATE_SUBMITTED: 'CANDIDATE_SUBMITTED',
};

// Evidence category → purchased check it belongs to. Uploads are rejected
// server-side when the mapped check was not purchased for the order.
export const CATEGORY_CHECK_MAP = {
  IDENTITY_DOCUMENT: 'IDENTITY',
  IDENTITY_SELFIE: 'IDENTITY',
  ADDRESS_PROOF: 'ADDRESS',
  EDUCATION_CERTIFICATE: 'EDUCATION',
  EMPLOYMENT_EVIDENCE: 'EMPLOYMENT',
};

// Record-scoped categories must reference an existing repeatable record.
export const RECORD_SCOPED_CATEGORIES = ['EDUCATION_CERTIFICATE', 'EMPLOYMENT_EVIDENCE'];

// Selfies are sensitive biometric-adjacent evidence: images only, private,
// never a public URL. No face recognition — 30.5 is collection only.
export const SELFIE_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const EVIDENCE_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
];
export const EVIDENCE_MAX_FILE_BYTES = 5 * 1024 * 1024;

// ── identifier validation (format only — values are never retained) ──
export const IDENTIFIER_PATTERNS = {
  PAN: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  AADHAAR: /^[0-9]{12}$/,
  PASSPORT: /^[A-Z][0-9]{7}$/,
  DRIVING_LICENSE: /^[A-Z0-9-]{8,20}$/,
  OTHER_APPROVED_ID: /^[A-Z0-9-]{5,30}$/,
};

export const isValidIdentityDocumentType = (value) =>
  BGV_IDENTITY_DOCUMENT_TYPES.includes(String(value || '').toUpperCase());

export const isValidIdentifier = (documentType, rawValue) => {
  const pattern = IDENTIFIER_PATTERNS[String(documentType || '').toUpperCase()];
  if (!pattern) return false;
  const normalized = String(rawValue || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  return pattern.test(normalized);
};

// Display-safe masking — the ONLY form of the identifier that persists.
export const maskIdentifier = (documentType, rawValue) => {
  const normalized = String(rawValue || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  const type = String(documentType || '').toUpperCase();
  if (type === 'AADHAAR') {
    const last4 = normalized.slice(-4);
    return `XXXX XXXX ${last4}`;
  }
  const last4 = normalized.slice(-4);
  return `${'*'.repeat(Math.max(0, normalized.length - 4))}${last4}`;
};

export const normalizeIdentifier = (rawValue) =>
  String(rawValue || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

// ── structured record validation (minimum necessary fields) ─────────
const isNonEmpty = (value) => String(value || '').trim().length > 0;
const MAX_TEXT = 200;

export const validateIdentityInput = (input = {}, options = {}) => {
  const { allowBlankIdentifier = false } = options;
  if (!isNonEmpty(input.legalName)) return 'Legal name is required';
  if (String(input.legalName).length > 160) return 'Legal name is too long';
  if (!input.dateOfBirth) return 'Date of birth is required for identity comparison';
  const dob = new Date(input.dateOfBirth);
  if (Number.isNaN(dob.getTime())) return 'Date of birth is invalid';
  if (dob.getTime() > Date.now()) return 'Date of birth cannot be in the future';
  if (!isValidIdentityDocumentType(input.documentType)) {
    return 'Choose a supported identity document type';
  }
  // A blank identifier is only acceptable when the service will keep the
  // previously stored masked value (same document type).
  if (!allowBlankIdentifier && !isValidIdentifier(input.documentType, input.identifier)) {
    return 'The identity document number format is not valid for the selected type';
  }
  return '';
};

export const validateAddressInput = (input = {}) => {
  if (!isNonEmpty(input.line1)) return 'Address line 1 is required';
  if (!isNonEmpty(input.city)) return 'City is required';
  if (!isNonEmpty(input.state)) return 'State is required';
  const pincode = String(input.pincode || '').trim();
  if (!/^[0-9]{4,10}$/.test(pincode)) return 'A valid postal/PIN code is required';
  if (!isNonEmpty(input.country)) return 'Country is required';
  if (input.residenceType && !RESIDENCE_TYPES.includes(input.residenceType)) {
    return 'Choose a valid residence type';
  }
  if (
    input.livingSince &&
    (Number.isNaN(new Date(input.livingSince).getTime()) ||
      new Date(input.livingSince).getTime() > Date.now())
  ) {
    return 'Living-since date is invalid';
  }
  if (
    input.evidenceCategory &&
    !ADDRESS_EVIDENCE_CATEGORIES.includes(input.evidenceCategory)
  ) {
    return 'Choose a supported address evidence category';
  }
  for (const field of ['line1', 'line2', 'locality', 'city', 'state', 'country']) {
    if (String(input[field] || '').length > MAX_TEXT) return `${field} is too long`;
  }
  return '';
};

const currentYear = () => new Date().getFullYear();

export const validateEducationRecord = (record = {}) => {
  if (!isNonEmpty(record.institution)) return 'Institution name is required';
  if (!isNonEmpty(record.qualification)) return 'Qualification is required';
  const start = Number(record.startYear || 0);
  const end = Number(record.endYear || 0);
  if (!start) return 'Start year is required';
  if (start < 1950 || start > currentYear()) return 'Start year is out of range';
  if (end) {
    if (end < 1950 || end > currentYear() + 8) return 'End year is out of range';
    if (end < start) return 'End year cannot be before the start year';
  }
  return '';
};

export const validateEmploymentRecord = (record = {}) => {
  if (!isNonEmpty(record.employer)) return 'Employer name is required';
  if (!isNonEmpty(record.designation)) return 'Designation is required';
  const startDate = new Date(record.startDate || '');
  if (Number.isNaN(startDate.getTime())) return 'Start date is required and must be valid';
  if (startDate.getTime() > Date.now()) return 'Start date cannot be in the future';
  if (record.endDate) {
    const endDate = new Date(record.endDate);
    if (Number.isNaN(endDate.getTime())) return 'End date is invalid';
    if (endDate.getTime() < startDate.getTime()) {
      return 'End date cannot be before the start date';
    }
  }
  if (record.employmentType && !['CURRENT', 'PREVIOUS'].includes(record.employmentType)) {
    return 'Employment type must be CURRENT or PREVIOUS';
  }
  if (record.hrContactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.hrContactEmail)) {
    return 'HR contact email is not valid';
  }
  if (record.hrContactPhone && !/^[0-9+\-\s()]{6,20}$/.test(record.hrContactPhone)) {
    return 'HR contact phone is not valid';
  }
  return '';
};

export const validateReferenceRecord = (record = {}) => {
  if (!isNonEmpty(record.name)) return 'Referee name is required';
  if (!isNonEmpty(record.relationship)) return 'Relationship to the referee is required';
  const email = String(record.email || '').trim();
  const phone = String(record.phone || '').trim();
  if (!email && !phone) return 'Provide at least one contact method (email or phone)';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Referee email is not valid';
  if (phone && !/^[0-9+\-\s()]{6,20}$/.test(phone)) return 'Referee phone is not valid';
  return '';
};

// ── readiness: purchased checks only ────────────────────────────────
// Unpurchased checks NEVER block submission (backend-enforced).
export const computeCollectionReadiness = ({
  purchasedChecks = [],
  collectionCase,
  activeFiles = [],
}) => {
  const filesFor = (checkType, recordId = null) =>
    activeFiles.filter(
      (file) =>
        file.checkType === checkType &&
        (recordId === null ? !file.recordId : String(file.recordId) === String(recordId))
    );

  const missing = [];
  const perCheck = {};
  const doc = collectionCase || {};

  for (const checkType of purchasedChecks) {
    const gaps = [];
    if (checkType === 'IDENTITY') {
      const identity = doc.identity || {};
      if (!isNonEmpty(identity.legalName)) gaps.push('Legal name');
      if (!identity.dateOfBirth) gaps.push('Date of birth');
      if (!identity.documentType) gaps.push('Identity document type');
      if (!isNonEmpty(identity.identifierMasked)) gaps.push('Identity document number');
      if (filesFor('IDENTITY').length === 0) gaps.push('Identity document file');
    } else if (checkType === 'ADDRESS') {
      const address = doc.address || {};
      if (!isNonEmpty(address.line1)) gaps.push('Address line 1');
      if (!isNonEmpty(address.city)) gaps.push('City');
      if (!isNonEmpty(address.state)) gaps.push('State');
      if (!isNonEmpty(address.pincode)) gaps.push('PIN code');
      if (filesFor('ADDRESS').length === 0) gaps.push('Address proof file');
    } else if (checkType === 'EDUCATION') {
      const records = doc.educations || [];
      if (records.length === 0) {
        gaps.push('At least one education record');
      } else {
        records.forEach((record, index) => {
          if (filesFor('EDUCATION', record._id).length === 0) {
            gaps.push(`Certificate file for education record ${index + 1}`);
          }
        });
      }
    } else if (checkType === 'EMPLOYMENT') {
      const records = doc.employments || [];
      if (records.length === 0) {
        gaps.push('At least one employment record');
      } else {
        records.forEach((record, index) => {
          if (filesFor('EMPLOYMENT', record._id).length === 0) {
            gaps.push(`Evidence file for employment record ${index + 1}`);
          }
        });
      }
    } else if (checkType === 'REFERENCE') {
      if ((doc.references || []).length === 0) gaps.push('At least one referee');
    }

    perCheck[checkType] = gaps.length === 0 ? 'COMPLETE' : 'INCOMPLETE';
    gaps.forEach((requirement) => missing.push({ checkType, requirement }));
  }

  return { ready: missing.length === 0, missing, perCheck };
};

// Safe API projection — masked identifiers only, no fingerprints, no
// storage keys, no raw identity values.
export const sanitizeCollectionCase = (collectionCase) => {
  if (!collectionCase) return null;
  return {
    id: String(collectionCase._id),
    status: collectionCase.status,
    purchasedChecks: collectionCase.purchasedChecks || [],
    submittedAt: collectionCase.submittedAt || null,
    identity: {
      legalName: collectionCase.identity?.legalName || '',
      dateOfBirth: collectionCase.identity?.dateOfBirth || null,
      documentType: collectionCase.identity?.documentType || null,
      identifierMasked: collectionCase.identity?.identifierMasked || '',
      // NOTE: the full number exists nowhere — masked display only.
    },
    address: {
      line1: collectionCase.address?.line1 || '',
      line2: collectionCase.address?.line2 || '',
      locality: collectionCase.address?.locality || '',
      city: collectionCase.address?.city || '',
      state: collectionCase.address?.state || '',
      pincode: collectionCase.address?.pincode || '',
      country: collectionCase.address?.country || '',
      residenceType: collectionCase.address?.residenceType || null,
      livingSince: collectionCase.address?.livingSince || null,
      evidenceCategory: collectionCase.address?.evidenceCategory || null,
    },
    educations: (collectionCase.educations || []).map((record) => ({
      id: String(record._id),
      institution: record.institution,
      universityBoard: record.universityBoard || '',
      qualification: record.qualification,
      specialization: record.specialization || '',
      enrollmentNumber: record.enrollmentNumber || '',
      startYear: record.startYear || null,
      endYear: record.endYear || null,
      location: record.location || '',
    })),
    employments: (collectionCase.employments || []).map((record) => ({
      id: String(record._id),
      employer: record.employer,
      designation: record.designation,
      employeeId: record.employeeId || '',
      startDate: record.startDate,
      endDate: record.endDate || null,
      employmentType: record.employmentType || 'PREVIOUS',
      hrContactName: record.hrContactName || '',
      hrContactEmail: record.hrContactEmail || '',
      hrContactPhone: record.hrContactPhone || '',
    })),
    references: (collectionCase.references || []).map((record) => ({
      id: String(record._id),
      name: record.name,
      organization: record.organization || '',
      designation: record.designation || '',
      relationship: record.relationship,
      email: record.email || '',
      phone: record.phone || '',
      context: record.context || '',
    })),
  };
};

// Safe file projection — never exposes storageKey/checksum/public URLs.
export const sanitizeEvidenceFile = (file) =>
  file
    ? {
        id: String(file._id),
        checkType: file.checkType,
        category: file.category,
        recordId: file.recordId || null,
        version: file.version,
        fileName: file.originalFileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        scanStatus: file.scanStatus,
        status: file.status,
        isActive: file.isActive,
        uploadedAt: file.uploadedAt || null,
      }
    : null;

export const isSupportedEvidenceCategory = (category) =>
  BGV_EVIDENCE_CATEGORIES.includes(String(category || ''));
