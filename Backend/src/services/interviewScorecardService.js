import InterviewScorecardTemplate from '../models/InterviewScorecardTemplate.js';
import ApiError from '../utils/ApiError.js';

const criterion = (
  key,
  label,
  description,
  { weight = 1, required = true, commentRequiredBelowScore = 4 } = {}
) => ({
  key,
  label,
  description,
  maxScore: 10,
  weight,
  required,
  commentRequiredBelowScore,
});

const DEFAULT_SCORECARDS = [
  {
    key: 'TECHNICAL_DEFAULT',
    name: 'Technical interview scorecard',
    roundCategory: 'TECHNICAL',
    criteria: [
      criterion('TECHNICAL_KNOWLEDGE', 'Technical knowledge', 'Depth and accuracy of role-relevant technical knowledge.', { weight: 1.3 }),
      criterion('PROBLEM_SOLVING', 'Problem solving', 'Structure, reasoning, trade-offs, and solution quality.', { weight: 1.3 }),
      criterion('IMPLEMENTATION_QUALITY', 'Implementation quality', 'Correctness, maintainability, and attention to edge cases.'),
      criterion('COMMUNICATION', 'Communication', 'Clarity of explanation, listening, and response to guidance.'),
      criterion('ROLE_READINESS', 'Role readiness', 'Ability to apply experience to the responsibilities of this role.'),
    ],
  },
  {
    key: 'MANAGER_DEFAULT',
    name: 'Manager interview scorecard',
    roundCategory: 'MANAGER',
    criteria: [
      criterion('ROLE_OWNERSHIP', 'Role ownership', 'Accountability, initiative, and ability to deliver outcomes.', { weight: 1.2 }),
      criterion('COLLABORATION', 'Collaboration', 'Cross-functional teamwork and constructive conflict handling.'),
      criterion('DECISION_MAKING', 'Decision making', 'Judgment, prioritization, and use of evidence.', { weight: 1.2 }),
      criterion('LEADERSHIP_POTENTIAL', 'Leadership potential', 'Ability to influence, support others, and scale responsibility.'),
      criterion('ROLE_ALIGNMENT', 'Role alignment', 'Alignment between demonstrated experience and role expectations.'),
    ],
  },
  {
    key: 'HR_DEFAULT',
    name: 'HR interview scorecard',
    roundCategory: 'HR',
    criteria: [
      criterion('MOTIVATION', 'Motivation', 'Clarity and relevance of motivation for the role.'),
      criterion('COMMUNICATION', 'Communication', 'Clarity, listening, and professional communication.'),
      criterion('VALUES_ALIGNMENT', 'Values alignment', 'Alignment with documented workplace values and expected conduct.'),
      criterion('CAREER_ALIGNMENT', 'Career alignment', 'Alignment between the opportunity and stated career goals.'),
      criterion('PRACTICAL_READINESS', 'Practical readiness', 'Availability and practical ability to take up the role.'),
    ],
  },
  {
    key: 'CUSTOM_DEFAULT',
    name: 'General interview scorecard',
    roundCategory: 'CUSTOM',
    criteria: [
      criterion('ROLE_KNOWLEDGE', 'Role knowledge', 'Understanding of the work and its core responsibilities.'),
      criterion('PROBLEM_SOLVING', 'Problem solving', 'Reasoning, judgment, and solution quality.'),
      criterion('RELEVANT_EXPERIENCE', 'Relevant experience', 'Relevance and depth of demonstrated prior experience.'),
      criterion('COMMUNICATION', 'Communication', 'Clarity, listening, and ability to explain decisions.'),
      criterion('ROLE_READINESS', 'Role readiness', 'Readiness to perform the responsibilities of the role.'),
    ],
  },
];

const scorecardSnapshot = (template) => ({
  key: template.key,
  name: template.name,
  roundCategory: template.roundCategory,
  version: template.version,
  criteria: (template.criteria || []).map((item) => ({
    key: item.key,
    label: item.label,
    description: item.description || '',
    maxScore: item.maxScore,
    weight: item.weight,
    required: item.required !== false,
    commentRequiredBelowScore: item.commentRequiredBelowScore ?? null,
  })),
});

export const ensureCompanyDefaultScorecards = async ({ companyId }) => {
  await InterviewScorecardTemplate.bulkWrite(
    DEFAULT_SCORECARDS.map((template) => ({
      updateOne: {
        filter: { companyId, key: template.key, job: null },
        update: {
          $setOnInsert: {
            companyId,
            ...template,
            job: null,
            version: 1,
            active: true,
            isSystemDefault: true,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  ).catch((error) => {
    if (error?.code !== 11000 && !error?.writeErrors?.every((item) => item.code === 11000)) {
      throw error;
    }
  });
};

export const resolveInterviewScorecard = async ({ companyId, interview }) => {
  const roundCategory = String(interview?.round?.category || 'CUSTOM').toUpperCase();
  const jobId = interview?.job?._id || interview?.job;

  await ensureCompanyDefaultScorecards({ companyId });

  const template = await InterviewScorecardTemplate.findOne({
    companyId,
    active: true,
    roundCategory,
    $or: [{ job: jobId }, { job: null }],
  })
    .sort({ job: -1, version: -1, createdAt: -1 })
    .lean();

  if (!template) {
    throw new ApiError(500, 'An interview scorecard could not be resolved');
  }

  return {
    id: template._id,
    companyId: template.companyId,
    job: template.job,
    ...scorecardSnapshot(template),
  };
};

export const snapshotFromScorecard = (scorecard) => scorecardSnapshot(scorecard);
