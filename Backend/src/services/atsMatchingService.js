import crypto from 'node:crypto';
import mongoose from 'mongoose';
import ATSResult from '../models/ATSResult.js';
import Candidate from '../models/Candidate.js';
import CandidateHistory from '../models/CandidateHistory.js';
import CandidateResume from '../models/CandidateResume.js';
import JobPosting from '../models/JobPosting.js';
import ResumeParseResult from '../models/ResumeParseResult.js';
import ApiError from '../utils/ApiError.js';
import { recordAudit } from '../utils/securityauditService.js';
import {
  boundedText,
  normalizeSkills,
} from './resumeNormalizationService.js';
import { getATSScoringConfiguration } from './atsScoringConfig.js';

const roundScore = (value) => Math.round((Number(value) || 0) * 100) / 100;
const boundedList = (values, maximum = 100, length = 200) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => boundedText(value, length)).filter(Boolean))]
    .slice(0, maximum);

const candidateReferenceFilter = (candidateRef) =>
  mongoose.isValidObjectId(candidateRef)
    ? { _id: candidateRef }
    : { candidateCode: String(candidateRef || '').trim().toUpperCase() };

const qualificationKey = (value) =>
  boundedText(value, 300)
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const qualificationLevel = (value) => {
  const key = qualificationKey(value);

  if (/\b(phd|ph d|doctorate|doctoral)\b/.test(key)) return 6;
  if (/\b(master|masters|msc|m sc|mtech|m tech|mba|ma|m a)\b/.test(key)) return 5;
  if (/\b(bachelor|bachelors|bsc|b sc|btech|b tech|be|b e|ba|b a)\b/.test(key)) return 4;
  if (/\b(associate|foundation degree)\b/.test(key)) return 3;
  if (/\b(diploma|polytechnic)\b/.test(key)) return 2;
  if (/\b(high school|secondary|12th|higher secondary)\b/.test(key)) return 1;
  return 0;
};

const GENERIC_QUALIFICATION_TOKENS = new Set([
  'a',
  'b',
  'ba',
  'bachelor',
  'bachelors',
  'be',
  'bsc',
  'btech',
  'degree',
  'diploma',
  'doctorate',
  'doctoral',
  'in',
  'm',
  'ma',
  'master',
  'masters',
  'mba',
  'msc',
  'mtech',
  'of',
  'ph',
  'phd',
  's',
  'tech',
  'technology',
  'the',
]);

const qualificationMatches = (candidateQualification, requirement) => {
  const candidateKey = qualificationKey(candidateQualification);
  const requirementKey = qualificationKey(requirement);
  if (!candidateKey || !requirementKey) return false;

  const candidateLevel = qualificationLevel(candidateKey);
  const requiredLevel = qualificationLevel(requirementKey);

  if (requiredLevel) {
    if (candidateLevel < requiredLevel) return false;

    const candidateTokens = new Set(candidateKey.split(' '));
    const subjectTokens = requirementKey
      .split(' ')
      .filter(
        (token) =>
          token.length > 1 &&
          !GENERIC_QUALIFICATION_TOKENS.has(token)
      );

    return subjectTokens.every((token) => candidateTokens.has(token));
  }

  return (
    candidateKey === requirementKey ||
    candidateKey.includes(requirementKey) ||
    requirementKey.includes(candidateKey)
  );
};

const skillEvidence = ({ candidate, parseResult }) => {
  const parsedSkills = (parseResult?.structuredData?.skills || []).map(
    (skill) => skill?.display || skill?.normalized || skill
  );
  return normalizeSkills([parsedSkills, candidate?.skills || []], 200);
};

const skillBreakdown = ({ requirements, evidence, maxScore, label }) => {
  const normalizedRequirements = normalizeSkills(requirements || [], 100);
  const evidenceKeys = new Set(evidence.map((skill) => skill.normalized));
  const matched = normalizedRequirements
    .filter((skill) => evidenceKeys.has(skill.normalized))
    .map((skill) => skill.display);
  const missing = normalizedRequirements
    .filter((skill) => !evidenceKeys.has(skill.normalized))
    .map((skill) => skill.display);
  const score = normalizedRequirements.length
    ? maxScore * (matched.length / normalizedRequirements.length)
    : maxScore;

  return {
    score: roundScore(score),
    maxScore,
    matched,
    missing,
    explanation: normalizedRequirements.length
      ? `${matched.length} of ${normalizedRequirements.length} ${label.toLowerCase()} matched the normalized resume and application skill evidence.`
      : `No ${label.toLowerCase()} are configured for this job, so this category receives full credit.`,
  };
};

const experienceBreakdown = ({ candidate, parseResult, job, maxScore }) => {
  const parsedMonths = Math.max(
    0,
    Math.min(1200, Number(parseResult?.structuredData?.derivedExperienceMonths) || 0)
  );
  const declaredMonths = Math.max(
    0,
    Math.min(1200, (Number(candidate?.totalExperience) || 0) * 12)
  );
  const candidateMonths = parsedMonths > 0 ? parsedMonths : declaredMonths;
  const source = parsedMonths > 0 ? 'PARSED_RESUME' : 'CANDIDATE_DECLARATION';
  const requiredMinMonths = Math.max(
    0,
    Math.min(1200, (Number(job?.minExperience) || 0) * 12)
  );
  const ratio = requiredMinMonths > 0
    ? Math.min(1, candidateMonths / requiredMinMonths)
    : 1;
  const sourceLabel = source === 'PARSED_RESUME'
    ? 'parsed non-overlapping resume duration'
    : 'candidate self-declaration fallback';

  return {
    score: roundScore(maxScore * ratio),
    maxScore,
    candidateMonths: roundScore(candidateMonths),
    requiredMinMonths: roundScore(requiredMinMonths),
    source,
    explanation: requiredMinMonths > 0
      ? `${roundScore(candidateMonths / 12)} years of ${sourceLabel} were compared with the ${roundScore(requiredMinMonths / 12)}-year minimum. Experience above the minimum is not penalized.`
      : `The job has no minimum experience requirement, so this category receives full credit using ${sourceLabel}.`,
  };
};

const candidateQualifications = ({ candidate, parseResult }) => {
  const parsed = (parseResult?.structuredData?.education || []).flatMap((item) => {
    const qualification = boundedText(item?.qualification, 200);
    const field = boundedText(item?.fieldOfStudy, 200);

    return [
      qualification && field ? `${qualification} in ${field}` : qualification || field,
    ];
  });

  return boundedList(
    [...parsed, candidate?.education?.degree || ''],
    50,
    300
  );
};

const educationBreakdown = ({ candidate, parseResult, job, maxScore }) => {
  const qualifications = candidateQualifications({ candidate, parseResult });
  const requirements = boundedList(job?.educationRequirements || [], 20, 200);
  const matched = requirements.filter((requirement) =>
    qualifications.some((qualification) =>
      qualificationMatches(qualification, requirement)
    )
  );
  const missing = requirements.filter((requirement) => !matched.includes(requirement));
  const score = requirements.length
    ? maxScore * (matched.length / requirements.length)
    : maxScore;

  return {
    score: roundScore(score),
    maxScore,
    candidateQualifications: qualifications,
    requiredQualifications: requirements,
    matched,
    missing,
    explanation: requirements.length
      ? `${matched.length} of ${requirements.length} configured education requirements matched parsed or candidate-entered qualifications. Recognized equivalent or higher qualification levels count as matches.`
      : 'No education requirement is configured for this job, so this category receives full credit.',
  };
};

const locationKey = (value) =>
  boundedText(value, 200)
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const locationsMatch = (candidateLocation, jobLocation) => {
  const candidateKey = locationKey(candidateLocation);
  const jobKey = locationKey(jobLocation);
  if (!candidateKey || !jobKey) return false;
  return (
    candidateKey === jobKey ||
    (candidateKey.length >= 3 && jobKey.includes(candidateKey)) ||
    (jobKey.length >= 3 && candidateKey.includes(jobKey))
  );
};

const locationAndNoticeBreakdown = ({
  candidate,
  parseResult,
  job,
  maxScore,
  defaultMaxNoticePeriod,
}) => {
  const locationMax = roundScore(maxScore / 2);
  const noticeMax = roundScore(maxScore - locationMax);
  const workMode = String(job?.workMode || 'ONSITE').toUpperCase();
  const candidateLocation = boundedText(
    candidate?.location || parseResult?.structuredData?.identity?.location,
    200
  );
  const jobLocation = boundedText(job?.location, 200);
  const genericJobLocation = ['', 'on site', 'onsite', 'office'].includes(
    locationKey(jobLocation)
  );
  const remote = workMode === 'REMOTE';
  const locationMatched = remote || genericJobLocation || locationsMatch(candidateLocation, jobLocation);
  const locationScore = locationMatched ? locationMax : 0;
  const locationExplanation = remote
    ? 'The job is remote, so the location requirement is satisfied automatically.'
    : genericJobLocation
      ? 'No specific job city is configured, so the location portion receives full credit.'
      : locationMatched
        ? `Candidate location “${candidateLocation}” matches the configured job location “${jobLocation}”.`
        : candidateLocation
          ? `Candidate location “${candidateLocation}” does not match the configured job location “${jobLocation}”.`
          : `No candidate location was available to compare with “${jobLocation}”.`;

  const configuredNotice = Number(job?.maxNoticePeriod);
  const hasConfiguredNotice =
    job?.maxNoticePeriod !== null &&
    job?.maxNoticePeriod !== undefined &&
    job?.maxNoticePeriod !== '' &&
    Number.isFinite(configuredNotice);
  const jobMaxNoticePeriod = hasConfiguredNotice
    ? Math.max(0, Math.min(365, configuredNotice))
    : defaultMaxNoticePeriod;
  const candidateNotice = candidate?.noticePeriod;
  const hasCandidateNotice =
    candidateNotice !== null &&
    candidateNotice !== undefined &&
    candidateNotice !== '' &&
    Number.isFinite(Number(candidateNotice));
  const candidateNoticePeriod = hasCandidateNotice
    ? Math.max(0, Math.min(365, Number(candidateNotice)))
    : null;
  let noticeFactor = 0.2;
  let noticeExplanation = `Candidate notice period is unavailable; conservative partial credit is applied against the ${jobMaxNoticePeriod}-day expectation.`;

  if (candidateNoticePeriod !== null && candidateNoticePeriod <= jobMaxNoticePeriod) {
    noticeFactor = 1;
    noticeExplanation = `${candidateNoticePeriod} days meets the job expectation of ${jobMaxNoticePeriod} days or fewer.`;
  } else if (candidateNoticePeriod !== null && candidateNoticePeriod <= 60) {
    noticeFactor = 0.6;
    noticeExplanation = `${candidateNoticePeriod} days exceeds the ${jobMaxNoticePeriod}-day expectation but is within 60 days, so partial credit is applied.`;
  } else if (candidateNoticePeriod !== null) {
    noticeExplanation = `${candidateNoticePeriod} days exceeds both the ${jobMaxNoticePeriod}-day expectation and 60-day partial-match threshold.`;
  }

  const noticeScore = roundScore(noticeMax * noticeFactor);

  return {
    score: roundScore(locationScore + noticeScore),
    maxScore,
    explanation: 'Location and notice period are evaluated separately and contribute equal halves of this category.',
    location: {
      score: locationScore,
      maxScore: locationMax,
      matched: locationMatched,
      candidateLocation,
      jobLocation,
      workMode,
      explanation: locationExplanation,
    },
    notice: {
      score: noticeScore,
      maxScore: noticeMax,
      matched: candidateNoticePeriod !== null && candidateNoticePeriod <= jobMaxNoticePeriod,
      candidateNoticePeriod,
      jobMaxNoticePeriod,
      explanation: noticeExplanation,
    },
  };
};

const matchCategory = (score) => {
  if (score >= 85) return 'STRONG';
  if (score >= 70) return 'GOOD';
  if (score >= 50) return 'MODERATE';
  return 'WEAK';
};

export const calculateATSMatch = ({
  candidate,
  job,
  parseResult,
  configuration = getATSScoringConfiguration(),
}) => {
  const weights = configuration.weights;
  const evidence = skillEvidence({ candidate, parseResult });
  const requiredSkillMatch = skillBreakdown({
    requirements: job?.requiredSkills,
    evidence,
    maxScore: weights.requiredSkills,
    label: 'Required skills',
  });
  const experienceMatch = experienceBreakdown({
    candidate,
    parseResult,
    job,
    maxScore: weights.experience,
  });
  const preferredSkillMatch = skillBreakdown({
    requirements: job?.preferredSkills,
    evidence,
    maxScore: weights.preferredSkills,
    label: 'Preferred skills',
  });
  const educationMatch = educationBreakdown({
    candidate,
    parseResult,
    job,
    maxScore: weights.education,
  });
  const locationAndNoticeMatch = locationAndNoticeBreakdown({
    candidate,
    parseResult,
    job,
    maxScore: weights.locationAndNotice,
    defaultMaxNoticePeriod: configuration.defaultMaxNoticePeriod,
  });
  const earned = [
    requiredSkillMatch,
    experienceMatch,
    preferredSkillMatch,
    educationMatch,
    locationAndNoticeMatch,
  ].reduce((total, result) => total + result.score, 0);
  const available = Object.values(weights).reduce(
    (total, weight) => total + weight,
    0
  );
  const overallScore = roundScore(available > 0 ? (earned / available) * 100 : 0);

  return {
    overallScore,
    matchCategory: matchCategory(overallScore),
    engineVersion: configuration.engineVersion,
    scoringWeights: { ...weights },
    requiredSkillMatch,
    preferredSkillMatch,
    experienceMatch,
    educationMatch,
    locationAndNoticeMatch,
  };
};

const fingerprintFor = ({ candidate, job, parseResult, configuration }) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        engineVersion: configuration.engineVersion,
        weights: configuration.weights,
        candidate: {
          skills: candidate.skills,
          totalExperience: candidate.totalExperience,
          education: candidate.education,
          location: candidate.location,
          noticePeriod: candidate.noticePeriod,
        },
        job: {
          requiredSkills: job.requiredSkills,
          preferredSkills: job.preferredSkills,
          minExperience: job.minExperience,
          educationRequirements: job.educationRequirements,
          location: job.location,
          workMode: job.workMode,
          maxNoticePeriod: job.maxNoticePeriod,
        },
        parseResult: {
          id: String(parseResult._id),
          updatedAt: parseResult.updatedAt,
          structuredData: parseResult.structuredData,
        },
      })
    )
    .digest('hex');

const safeResultResponse = (result) => ({
  overallScore: result.overallScore,
  matchCategory: result.matchCategory,
  engineVersion: result.engineVersion,
  evaluatedAt: result.evaluatedAt,
  scoringWeights: result.scoringWeights,
  breakdown: {
    requiredSkills: result.requiredSkillMatch,
    experience: result.experienceMatch,
    preferredSkills: result.preferredSkillMatch,
    education: result.educationMatch,
    locationAndNotice: result.locationAndNoticeMatch,
  },
});

const parserStateResponse = (parsingStatus) => {
  const status = String(parsingStatus || 'PENDING').toUpperCase();

  if (status === 'UNSUPPORTED') {
    return {
      status: 'PARSING_UNSUPPORTED',
      parserStatus: status,
      message: 'ATS matching is unavailable because this resume format could not be parsed safely.',
    };
  }

  if (status === 'REVIEW_REQUIRED') {
    return {
      status: 'PARSING_REVIEW_REQUIRED',
      parserStatus: status,
      message: 'ATS matching requires machine-readable resume content. This resume needs manual review.',
    };
  }

  if (status === 'FAILED') {
    return {
      status: 'PARSING_FAILED',
      parserStatus: status,
      message: 'ATS matching is waiting for a successful resume reprocess.',
    };
  }

  return {
    status: 'PARSING_PENDING',
    parserStatus: status,
    message: 'ATS matching will start automatically after resume parsing completes.',
  };
};

export const getCandidateATSResult = async ({ companyId, candidateRef }) => {
  const candidate = await Candidate.findOne({
    companyId,
    ...candidateReferenceFilter(candidateRef),
  })
    .select('_id candidateCode job')
    .lean();

  if (!candidate) throw ApiError.notFound('Candidate not found');

  const resume = await CandidateResume.findOne({
    companyId,
    candidate: candidate._id,
    job: candidate.job,
    status: 'UPLOADED',
  })
    .select('_id parsingStatus parsingCompletedAt')
    .lean();

  if (!resume) {
    return {
      status: 'NO_RESUME',
      parserStatus: 'NOT_AVAILABLE',
      message: 'A secure resume is required before ATS matching can run.',
    };
  }

  if (!['COMPLETED', 'PARSED'].includes(resume.parsingStatus)) {
    return parserStateResponse(resume.parsingStatus);
  }

  const result = await ATSResult.findOne({
    companyId,
    candidateId: candidate._id,
    jobId: candidate.job,
  })
    .select(
      '+recalculationPending overallScore matchCategory engineVersion evaluatedAt scoringWeights requiredSkillMatch preferredSkillMatch experienceMatch educationMatch locationAndNoticeMatch'
    )
    .lean();

  if (!result || result.recalculationPending) {
    return {
      status: 'MATCHING_PENDING',
      parserStatus: 'COMPLETED',
      message: result?.recalculationPending
        ? 'ATS recalculation is queued against the current job requirements.'
        : 'Resume parsing is complete and ATS matching is queued.',
    };
  }

  return {
    status: 'COMPLETED',
    parserStatus: 'COMPLETED',
    result: safeResultResponse(result),
  };
};

export const prepareATSReprocess = async ({
  companyId,
  candidateRef,
  actorId,
}) => {
  const candidate = await Candidate.findOne({
    companyId,
    ...candidateReferenceFilter(candidateRef),
  })
    .select('_id candidateCode job')
    .lean();

  if (!candidate) throw ApiError.notFound('Candidate not found');

  const resume = await CandidateResume.findOne({
    companyId,
    candidate: candidate._id,
    job: candidate.job,
    status: 'UPLOADED',
  })
    .select('_id parsingStatus')
    .lean();

  if (!resume) throw ApiError.notFound('Resume not found');
  if (!['COMPLETED', 'PARSED'].includes(resume.parsingStatus)) {
    throw new ApiError(409, 'ATS matching requires a successfully parsed resume');
  }

  const [parseResult, job] = await Promise.all([
    ResumeParseResult.findOne({
      companyId,
      candidate: candidate._id,
      resume: resume._id,
      status: 'COMPLETED',
    })
      .select('_id')
      .sort({ completedAt: -1 })
      .lean(),
    JobPosting.findOne({
      _id: candidate.job,
      companyId,
    })
      .select('_id')
      .lean(),
  ]);

  if (!parseResult) {
    throw new ApiError(409, 'Completed parsed resume data is unavailable');
  }
  if (!job) throw ApiError.notFound('Job not found');

  const requestedAt = new Date();
  await ATSResult.updateOne(
    {
      companyId,
      candidateId: candidate._id,
      jobId: job._id,
    },
    {
      $set: {
        recalculationPending: true,
        recalculationRequestedAt: requestedAt,
        recalculationRequestedBy: actorId,
      },
    }
  );

  return { candidate, resume, parseResult, job, requestedAt };
};

export const processATSMatch = async ({
  companyId,
  candidateId,
  jobId,
  resumeId,
  parseResultId,
  trigger = 'RESUME_PARSED',
  actorId = null,
}) => {
  const candidate = await Candidate.findOne({
    _id: candidateId,
    companyId,
    job: jobId,
  })
    .select(
      '_id candidateCode job stage skills totalExperience education location noticePeriod'
    )
    .lean();

  if (!candidate) return { accepted: false, reason: 'CANDIDATE_NOT_FOUND' };

  const [job, resume, parseResult] = await Promise.all([
    JobPosting.findOne({ _id: jobId, companyId })
      .select(
        '_id requiredSkills preferredSkills minExperience educationRequirements location workMode maxNoticePeriod'
      )
      .lean(),
    CandidateResume.findOne({
      _id: resumeId,
      companyId,
      candidate: candidateId,
      job: jobId,
      status: 'UPLOADED',
      parsingStatus: { $in: ['COMPLETED', 'PARSED'] },
    })
      .select('_id')
      .lean(),
    ResumeParseResult.findOne({
      _id: parseResultId,
      companyId,
      candidate: candidateId,
      resume: resumeId,
      status: 'COMPLETED',
    })
      .select('_id structuredData updatedAt')
      .lean(),
  ]);

  if (!job || !resume || !parseResult) {
    return { accepted: false, reason: 'MATCH_INPUTS_NOT_AVAILABLE' };
  }

  const configuration = getATSScoringConfiguration();
  const inputFingerprint = fingerprintFor({
    candidate,
    job,
    parseResult,
    configuration,
  });
  const existing = await ATSResult.findOne({ companyId, candidateId })
    .select('+inputFingerprint evaluatedAt overallScore matchCategory')
    .lean();

  if (
    trigger !== 'MANUAL_REPROCESS' &&
    existing?.inputFingerprint === inputFingerprint
  ) {
    await Candidate.updateOne(
      { _id: candidateId, companyId, job: jobId, stage: 'APPLIED' },
      { $set: { stage: 'ATS_SCREENING' } }
    );

    return { accepted: true, skipped: true, reason: 'UNCHANGED_INPUTS' };
  }

  const evaluatedAt = new Date();
  const calculated = calculateATSMatch({
    candidate,
    job,
    parseResult,
    configuration,
  });
  const result = await ATSResult.findOneAndUpdate(
    { companyId, candidateId },
    {
      $setOnInsert: { companyId, candidateId },
      $set: {
        jobId,
        resumeId,
        parseResultId,
        ...calculated,
        evaluatedAt,
        inputFingerprint,
        trigger,
        processedBy: actorId,
        recalculationPending: false,
        recalculationRequestedBy: null,
      },
    },
    {
      upsert: true,
      returnDocument: 'after',
      setDefaultsOnInsert: true,
      runValidators: true,
    }
  ).lean();

  await Candidate.updateOne(
    { _id: candidateId, companyId, job: jobId, stage: 'APPLIED' },
    { $set: { stage: 'ATS_SCREENING' } }
  );

  const action = existing ? 'ATS_REPROCESSED' : 'ATS_PROCESSED';
  const actorType = trigger === 'MANUAL_REPROCESS' ? 'TENANT_USER' : 'SYSTEM';
  const safeMetadata = {
    score: calculated.overallScore,
    category: calculated.matchCategory,
    engineVersion: calculated.engineVersion,
    trigger,
  };

  await CandidateHistory.create({
    companyId,
    candidate: candidateId,
    job: jobId,
    action,
    source: 'ATS_ENGINE',
    actorType,
    actor: actorId,
    metadata: safeMetadata,
    eventAt: evaluatedAt,
  });

  await recordAudit({
    req: null,
    action,
    companyId,
    actorId,
    actorName: actorId ? '' : 'Crewly ATS engine',
    actorRole: actorId ? '' : 'SYSTEM',
    resource: 'ATSResult',
    resourceId: result._id,
    previousValue: existing
      ? {
          overallScore: existing.overallScore,
          matchCategory: existing.matchCategory,
          evaluatedAt: existing.evaluatedAt,
        }
      : null,
    newValue: safeMetadata,
    statusCode: 200,
    critical: true,
  });

  return {
    accepted: true,
    skipped: false,
    action,
    result: safeResultResponse(result),
  };
};
