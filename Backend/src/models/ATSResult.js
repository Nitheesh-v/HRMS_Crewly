import mongoose from 'mongoose';

export const ATS_MATCH_CATEGORIES = ['STRONG', 'GOOD', 'MODERATE', 'WEAK'];

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

const scoreFields = {
  score: { type: Number, min: 0, required: true },
  maxScore: { type: Number, min: 0, required: true },
  explanation: { ...textField(1000), required: true },
};

const skillMatchSchema = new mongoose.Schema(
  {
    ...scoreFields,
    matched: {
      type: [String],
      default: [],
      validate: boundedArray(100, 'Too many matched skills'),
    },
    missing: {
      type: [String],
      default: [],
      validate: boundedArray(100, 'Too many missing skills'),
    },
  },
  { _id: false }
);

const experienceMatchSchema = new mongoose.Schema(
  {
    ...scoreFields,
    candidateMonths: { type: Number, min: 0, max: 1200, default: 0 },
    requiredMinMonths: { type: Number, min: 0, max: 1200, default: 0 },
    source: {
      type: String,
      enum: ['PARSED_RESUME', 'CANDIDATE_DECLARATION'],
      default: 'CANDIDATE_DECLARATION',
    },
  },
  { _id: false }
);

const educationMatchSchema = new mongoose.Schema(
  {
    ...scoreFields,
    candidateQualifications: {
      type: [String],
      default: [],
      validate: boundedArray(50, 'Too many candidate qualifications'),
    },
    requiredQualifications: {
      type: [String],
      default: [],
      validate: boundedArray(20, 'Too many required qualifications'),
    },
    matched: {
      type: [String],
      default: [],
      validate: boundedArray(20, 'Too many matched qualifications'),
    },
    missing: {
      type: [String],
      default: [],
      validate: boundedArray(20, 'Too many missing qualifications'),
    },
  },
  { _id: false }
);

const locationMatchSchema = new mongoose.Schema(
  {
    ...scoreFields,
    matched: { type: Boolean, default: false },
    candidateLocation: textField(200),
    jobLocation: textField(200),
    workMode: textField(30),
  },
  { _id: false }
);

const noticeMatchSchema = new mongoose.Schema(
  {
    ...scoreFields,
    matched: { type: Boolean, default: false },
    candidateNoticePeriod: { type: Number, min: 0, max: 365, default: null },
    jobMaxNoticePeriod: { type: Number, min: 0, max: 365, required: true },
  },
  { _id: false }
);

const locationAndNoticeMatchSchema = new mongoose.Schema(
  {
    ...scoreFields,
    location: { type: locationMatchSchema, required: true },
    notice: { type: noticeMatchSchema, required: true },
  },
  { _id: false }
);

const scoringWeightsSchema = new mongoose.Schema(
  {
    requiredSkills: { type: Number, min: 0, required: true },
    experience: { type: Number, min: 0, required: true },
    preferredSkills: { type: Number, min: 0, required: true },
    education: { type: Number, min: 0, required: true },
    locationAndNotice: { type: Number, min: 0, required: true },
  },
  { _id: false }
);

const atsResultSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    candidateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Candidate',
      required: true,
      index: true,
    },
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPosting',
      required: true,
      index: true,
    },
    resumeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CandidateResume',
      required: true,
    },
    parseResultId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ResumeParseResult',
      required: true,
    },
    overallScore: { type: Number, min: 0, max: 100, required: true },
    matchCategory: {
      type: String,
      enum: ATS_MATCH_CATEGORIES,
      required: true,
      index: true,
    },
    engineVersion: { ...textField(30, '1.0'), required: true },
    evaluatedAt: { type: Date, required: true, index: true },
    scoringWeights: { type: scoringWeightsSchema, required: true },
    requiredSkillMatch: { type: skillMatchSchema, required: true },
    preferredSkillMatch: { type: skillMatchSchema, required: true },
    experienceMatch: { type: experienceMatchSchema, required: true },
    educationMatch: { type: educationMatchSchema, required: true },
    locationAndNoticeMatch: {
      type: locationAndNoticeMatchSchema,
      required: true,
    },
    inputFingerprint: {
      ...textField(128),
      select: false,
    },
    trigger: {
      type: String,
      enum: ['RESUME_PARSED', 'STARTUP_RECOVERY', 'MANUAL_REPROCESS'],
      default: 'RESUME_PARSED',
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    recalculationPending: {
      type: Boolean,
      default: false,
      select: false,
    },
    recalculationRequestedAt: {
      type: Date,
      default: null,
      select: false,
    },
    recalculationRequestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      select: false,
    },
  },
  { timestamps: true, versionKey: false }
);

atsResultSchema.index({ companyId: 1, candidateId: 1 }, { unique: true });
atsResultSchema.index({ companyId: 1, jobId: 1, evaluatedAt: -1 });

export default mongoose.model('ATSResult', atsResultSchema);
