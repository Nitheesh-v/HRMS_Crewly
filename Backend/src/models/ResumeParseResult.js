import mongoose from 'mongoose';

export const RESUME_PARSE_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'RETRY_PENDING',
  'UNSUPPORTED',
  'REVIEW_REQUIRED',
];

export const RESUME_PARSE_FAILURE_CATEGORIES = [
  'NONE',
  'STORAGE_UNAVAILABLE',
  'UNSUPPORTED_FORMAT',
  'PASSWORD_PROTECTED',
  'CORRUPT_FILE',
  'RESOURCE_LIMIT',
  'EXTRACTION_FAILED',
  'NO_EXTRACTABLE_TEXT',
  'PARSER_FAILED',
  'PERSISTENCE_FAILED',
];

const boundedArray = (maximum, message) => ({
  validator: (value) => !Array.isArray(value) || value.length <= maximum,
  message,
});

const textField = (maximum = 500, defaultValue = '') => ({
  type: String,
  trim: true,
  maxlength: maximum,
  default: defaultValue,
});

const uncertainDateSchema = new mongoose.Schema(
  {
    original: textField(100),
    normalized: { type: Date, default: null },
    precision: {
      type: String,
      enum: ['UNKNOWN', 'YEAR', 'MONTH', 'DAY'],
      default: 'UNKNOWN',
    },
    uncertain: { type: Boolean, default: true },
  },
  { _id: false }
);

const skillSchema = new mongoose.Schema(
  {
    display: textField(100),
    normalized: textField(100),
  },
  { _id: false }
);

const educationSchema = new mongoose.Schema(
  {
    qualification: textField(200),
    fieldOfStudy: textField(200),
    institution: textField(300),
    location: textField(200),
    startDate: { type: uncertainDateSchema, default: () => ({}) },
    endDate: { type: uncertainDateSchema, default: () => ({}) },
    grade: textField(100),
    description: textField(1500),
    originalText: textField(2000),
  },
  { _id: false }
);

const workExperienceSchema = new mongoose.Schema(
  {
    employer: textField(300),
    title: textField(250),
    location: textField(200),
    startDate: { type: uncertainDateSchema, default: () => ({}) },
    endDate: { type: uncertainDateSchema, default: () => ({}) },
    isCurrent: { type: Boolean, default: false },
    description: textField(3000),
    technologies: {
      type: [skillSchema],
      default: [],
      validate: boundedArray(50, 'Too many technologies'),
    },
    originalText: textField(4000),
  },
  { _id: false }
);

const certificationSchema = new mongoose.Schema(
  {
    name: textField(300),
    issuer: textField(300),
    issuedDate: { type: uncertainDateSchema, default: () => ({}) },
    expiryDate: { type: uncertainDateSchema, default: () => ({}) },
    credentialId: textField(200),
    credentialUrl: textField(500),
    originalText: textField(1500),
  },
  { _id: false }
);

const projectSchema = new mongoose.Schema(
  {
    name: textField(300),
    role: textField(200),
    description: textField(2500),
    technologies: {
      type: [skillSchema],
      default: [],
      validate: boundedArray(50, 'Too many project technologies'),
    },
    url: textField(500),
    originalText: textField(3000),
  },
  { _id: false }
);

const linkSchema = new mongoose.Schema(
  {
    label: textField(100),
    url: textField(500),
  },
  { _id: false }
);

const languageSchema = new mongoose.Schema(
  {
    name: textField(100),
    proficiency: textField(100),
  },
  { _id: false }
);

const namedItemSchema = new mongoose.Schema(
  {
    title: textField(300),
    issuer: textField(300),
    date: { type: uncertainDateSchema, default: () => ({}) },
    description: textField(2000),
    url: textField(500),
    originalText: textField(2500),
  },
  { _id: false }
);

const parsedDataSchema = new mongoose.Schema(
  {
    identity: {
      name: textField(200),
      email: textField(320),
      phone: textField(100),
      location: textField(300),
    },
    summary: textField(5000),
    skills: {
      type: [skillSchema],
      default: [],
      validate: boundedArray(200, 'Too many parsed skills'),
    },
    education: {
      type: [educationSchema],
      default: [],
      validate: boundedArray(30, 'Too many education entries'),
    },
    workExperience: {
      type: [workExperienceSchema],
      default: [],
      validate: boundedArray(50, 'Too many work experience entries'),
    },
    derivedExperienceMonths: { type: Number, min: 0, max: 1200, default: 0 },
    certifications: {
      type: [certificationSchema],
      default: [],
      validate: boundedArray(50, 'Too many certifications'),
    },
    projects: {
      type: [projectSchema],
      default: [],
      validate: boundedArray(50, 'Too many projects'),
    },
    links: {
      type: [linkSchema],
      default: [],
      validate: boundedArray(30, 'Too many links'),
    },
    languages: {
      type: [languageSchema],
      default: [],
      validate: boundedArray(50, 'Too many languages'),
    },
    awards: {
      type: [namedItemSchema],
      default: [],
      validate: boundedArray(50, 'Too many awards'),
    },
    achievements: {
      type: [namedItemSchema],
      default: [],
      validate: boundedArray(50, 'Too many achievements'),
    },
    publications: {
      type: [namedItemSchema],
      default: [],
      validate: boundedArray(50, 'Too many publications'),
    },
    volunteering: {
      type: [namedItemSchema],
      default: [],
      validate: boundedArray(50, 'Too many volunteering entries'),
    },
  },
  { _id: false }
);

const confidenceSchema = new mongoose.Schema(
  {
    overall: { type: Number, min: 0, max: 1, default: 0 },
    textExtraction: { type: Number, min: 0, max: 1, default: 0 },
    sectionDetection: { type: Number, min: 0, max: 1, default: 0 },
    dateNormalization: { type: Number, min: 0, max: 1, default: 0 },
  },
  { _id: false }
);

const resumeParseResultSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      index: true,
    },
    resume: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CandidateResume',
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['RESUME_PARSER'],
      default: 'RESUME_PARSER',
      immutable: true,
    },
    parserVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    extractorVersion: textField(100),
    status: {
      type: String,
      enum: RESUME_PARSE_STATUSES,
      default: 'PENDING',
      index: true,
    },
    rawText: {
      type: String,
      maxlength: 250000,
      default: '',
      select: false,
    },
    structuredData: {
      type: parsedDataSchema,
      default: () => ({}),
    },
    warnings: {
      type: [{ type: String, trim: true, maxlength: 300 }],
      default: [],
      validate: boundedArray(50, 'Too many parser warnings'),
    },
    extractionConfidence: {
      type: confidenceSchema,
      default: () => ({}),
    },
    attemptCount: { type: Number, min: 0, max: 100, default: 0 },
    requestedAt: { type: Date, default: Date.now },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    nextRetryAllowedAt: { type: Date, default: null },
    processingLeaseId: { type: String, maxlength: 100, default: '', select: false },
    processingLeaseExpiresAt: { type: Date, default: null, select: false },
    failureCategory: {
      type: String,
      enum: RESUME_PARSE_FAILURE_CATEGORIES,
      default: 'NONE',
    },
    safeErrorMessage: textField(500),
    processingMetadata: {
      mimeType: textField(150),
      inputBytes: { type: Number, min: 0, default: 0 },
      expandedBytes: { type: Number, min: 0, default: 0 },
      extractedCharacters: { type: Number, min: 0, default: 0 },
      pageCount: { type: Number, min: 0, max: 10000, default: 0 },
      processedPageCount: { type: Number, min: 0, max: 1000, default: 0 },
      processingDurationMs: { type: Number, min: 0, default: 0 },
    },
  },
  { timestamps: true, versionKey: false }
);

resumeParseResultSchema.index(
  { companyId: 1, resume: 1, parserVersion: 1 },
  { unique: true }
);
resumeParseResultSchema.index({ companyId: 1, candidate: 1, createdAt: -1 });
resumeParseResultSchema.index({ companyId: 1, status: 1, requestedAt: 1 });
resumeParseResultSchema.index({ status: 1, processingLeaseExpiresAt: 1 });

export default mongoose.model('ResumeParseResult', resumeParseResultSchema);
