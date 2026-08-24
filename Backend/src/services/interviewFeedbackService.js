import Interview from '../models/Interview.js';
import InterviewFeedback, {
  INTERVIEW_RECOMMENDATIONS,
} from '../models/InterviewFeedback.js';
import CandidateHistory from '../models/CandidateHistory.js';
import ApiError from '../utils/ApiError.js';
import { recordAudit } from '../utils/securityauditService.js';
import {
  resolveInterviewScorecard,
  snapshotFromScorecard,
} from './interviewScorecardService.js';
import { notifyFeedbackComplete } from './recruitmentEvaluationNotificationService.js';

const isAssigned = (interview, actorId) =>
  (interview.interviewers || []).some(
    (interviewer) => String(interviewer?._id || interviewer) === String(actorId)
  );

const safePerson = (person) =>
  person
    ? {
        id: person._id || person,
        ...(person.name ? { name: person.name } : {}),
        ...(person.role ? { role: person.role } : {}),
      }
    : null;

const loadInterview = async ({ companyId, interviewId }) =>
  Interview.findOne({ _id: interviewId, companyId })
    .populate({
      path: 'candidate',
      select: 'candidateCode name currentStage stage job',
      match: { companyId },
    })
    .populate({
      path: 'job',
      select: 'jobCode title',
      match: { companyId },
    })
    .populate({
      path: 'interviewers',
      select: 'name role status',
      match: { companyId },
    })
    .lean();

const requireAssignedCompletedInterview = async ({
  companyId,
  interviewId,
  actorId,
}) => {
  const interview = await loadInterview({ companyId, interviewId });
  if (!interview || !interview.candidate || !interview.job) {
    throw ApiError.notFound('Interview not found');
  }
  if (!isAssigned(interview, actorId)) {
    throw ApiError.forbidden('This interview is not assigned to you');
  }
  if (interview.status !== 'COMPLETED') {
    throw ApiError.conflict('Feedback is available after the interview is completed');
  }
  return interview;
};

const normalizeText = (value, maxLength) =>
  String(value || '').trim().slice(0, maxLength);

export const calculateInterviewScore = ({ ratings, criteria }) => {
  const criterionMap = new Map(criteria.map((item) => [item.key, item]));
  let weightedScore = 0;
  let includedWeight = 0;

  ratings.forEach((rating) => {
    const criterion = criterionMap.get(rating.criterionKey);
    if (!criterion) return;
    weightedScore += (rating.score / criterion.maxScore) * criterion.weight;
    includedWeight += criterion.weight;
  });

  if (!includedWeight) return null;
  return Math.round((weightedScore / includedWeight) * 1000) / 100;
};

export const normalizeFeedbackPayload = ({
  input,
  templateSnapshot,
  submit = false,
}) => {
  const criteria = templateSnapshot.criteria || [];
  const criterionMap = new Map(criteria.map((item) => [item.key, item]));
  const rawRatings = Array.isArray(input.ratings) ? input.ratings : [];
  const seen = new Set();

  const ratings = rawRatings.map((rawRating) => {
    const criterionKey = String(rawRating?.criterionKey || '').toUpperCase().trim();
    const criterion = criterionMap.get(criterionKey);
    if (!criterion || seen.has(criterionKey)) {
      throw ApiError.badRequest(
        !criterion
          ? 'Feedback contains a criterion that is not in this scorecard'
          : 'Each scorecard criterion can be rated only once'
      );
    }
    seen.add(criterionKey);

    const score = Number(rawRating.score);
    if (!Number.isFinite(score) || score < 1 || score > criterion.maxScore) {
      throw ApiError.badRequest(
        `${criterion.label} must be scored between 1 and ${criterion.maxScore}`
      );
    }
    const comment = normalizeText(rawRating.comment, 1500);
    if (
      submit &&
      criterion.commentRequiredBelowScore !== null &&
      score < criterion.commentRequiredBelowScore &&
      !comment
    ) {
      throw ApiError.badRequest(
        `Add a comment for ${criterion.label} when the score is below ${criterion.commentRequiredBelowScore}`
      );
    }

    return {
      criterionKey,
      criterionLabel: criterion.label,
      score,
      maxScore: criterion.maxScore,
      weight: criterion.weight,
      comment,
    };
  });

  if (submit) {
    const missing = criteria.filter((item) => item.required && !seen.has(item.key));
    if (missing.length) {
      throw ApiError.badRequest(
        `Complete all required criteria: ${missing.map((item) => item.label).join(', ')}`
      );
    }
  }

  const recommendation = String(input.recommendation || '').toUpperCase().trim();
  if (recommendation && !INTERVIEW_RECOMMENDATIONS.includes(recommendation)) {
    throw ApiError.badRequest('Choose a valid interview recommendation');
  }
  if (submit && !recommendation) {
    throw ApiError.badRequest('Choose a recommendation before submitting feedback');
  }

  return {
    ratings,
    overallScore: calculateInterviewScore({ ratings, criteria }),
    maxOverallScore: 10,
    strengths: normalizeText(input.strengths, 4000),
    concerns: normalizeText(input.concerns, 4000),
    privateNotes: normalizeText(input.privateNotes, 5000),
    recommendation,
  };
};

const safeTemplateDto = (template) => ({
  id: template.id || template._id || null,
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

const safeOwnFeedbackDto = (feedback, { idempotent = false } = {}) => ({
  id: feedback._id,
  interviewId: feedback.interview,
  candidateId: feedback.candidate,
  jobId: feedback.job,
  interviewer: safePerson(feedback.interviewer),
  template: safeTemplateDto({
    id: feedback.scorecardTemplate,
    ...feedback.templateSnapshot,
  }),
  ratings: feedback.ratings || [],
  overallScore: feedback.overallScore,
  maxOverallScore: feedback.maxOverallScore || 10,
  strengths: feedback.strengths || '',
  concerns: feedback.concerns || '',
  privateNotes: feedback.privateNotes || '',
  recommendation: feedback.recommendation || '',
  status: feedback.status,
  submittedAt: feedback.submittedAt || null,
  lastEditedAt: feedback.lastEditedAt || feedback.updatedAt,
  readOnly: ['SUBMITTED', 'LOCKED'].includes(feedback.status),
  idempotent,
});

const comparableFeedback = (feedback) => ({
  ratings: (feedback.ratings || []).map((item) => ({
    criterionKey: item.criterionKey,
    score: Number(item.score),
    comment: item.comment || '',
  })),
  strengths: feedback.strengths || '',
  concerns: feedback.concerns || '',
  privateNotes: feedback.privateNotes || '',
  recommendation: feedback.recommendation || '',
});

const feedbackMatches = (feedback, normalized) =>
  JSON.stringify(comparableFeedback(feedback)) ===
  JSON.stringify(comparableFeedback(normalized));

export const getOwnInterviewScorecard = async ({
  companyId,
  interviewId,
  actorId,
}) => {
  const interview = await requireAssignedCompletedInterview({
    companyId,
    interviewId,
    actorId,
  });
  const existing = await InterviewFeedback.findOne({
    companyId,
    interview: interview._id,
    interviewer: actorId,
  })
    .select('+privateNotes')
    .lean();
  const template = existing
    ? { id: existing.scorecardTemplate, ...existing.templateSnapshot }
    : await resolveInterviewScorecard({ companyId, interview });

  return {
    interview: {
      id: interview._id,
      interviewCode: interview.interviewCode,
      status: interview.status,
      round: interview.round,
      candidate: {
        id: interview.candidate._id,
        candidateCode: interview.candidate.candidateCode,
        name: interview.candidate.name,
      },
      job: {
        id: interview.job._id,
        jobCode: interview.job.jobCode,
        title: interview.job.title,
      },
    },
    template: safeTemplateDto(template),
    feedbackStatus: existing?.status || 'NOT_STARTED',
  };
};

export const getOwnInterviewFeedback = async ({
  companyId,
  interviewId,
  actorId,
}) => {
  const interview = await requireAssignedCompletedInterview({
    companyId,
    interviewId,
    actorId,
  });
  const feedback = await InterviewFeedback.findOne({
    companyId,
    interview: interview._id,
    interviewer: actorId,
  })
    .select('+privateNotes')
    .lean();

  if (!feedback) {
    const template = await resolveInterviewScorecard({ companyId, interview });
    return {
      feedback: null,
      status: 'NOT_STARTED',
      template: safeTemplateDto(template),
      readOnly: false,
    };
  }

  return {
    feedback: safeOwnFeedbackDto(feedback),
    status: feedback.status,
    template: safeTemplateDto({
      id: feedback.scorecardTemplate,
      ...feedback.templateSnapshot,
    }),
    readOnly: ['SUBMITTED', 'LOCKED'].includes(feedback.status),
  };
};

export const saveOwnInterviewFeedback = async ({
  companyId,
  interviewId,
  actor,
  input,
  requestContext,
}) => {
  const submit = String(input.action || 'SAVE_DRAFT').toUpperCase() === 'SUBMIT';
  const interview = await requireAssignedCompletedInterview({
    companyId,
    interviewId,
    actorId: actor._id,
  });
  let existing = await InterviewFeedback.findOne({
    companyId,
    interview: interview._id,
    interviewer: actor._id,
  })
    .select('+privateNotes')
    .lean();

  const scorecard = existing
    ? { id: existing.scorecardTemplate, ...existing.templateSnapshot }
    : await resolveInterviewScorecard({ companyId, interview });
  const normalized = normalizeFeedbackPayload({
    input,
    templateSnapshot: scorecard,
    submit,
  });

  if (existing && ['SUBMITTED', 'LOCKED'].includes(existing.status)) {
    if (submit && feedbackMatches(existing, normalized)) {
      return safeOwnFeedbackDto(existing, { idempotent: true });
    }
    throw ApiError.conflict('Submitted interview feedback is read-only');
  }

  const now = new Date();
  let draft;
  try {
    draft = await InterviewFeedback.findOneAndUpdate(
      {
        companyId,
        interview: interview._id,
        interviewer: actor._id,
        status: 'DRAFT',
      },
      {
        $setOnInsert: {
          companyId,
          interview: interview._id,
          candidate: interview.candidate._id,
          job: interview.job._id,
          interviewer: actor._id,
          scorecardTemplate: scorecard.id,
          templateSnapshot: snapshotFromScorecard(scorecard),
          status: 'DRAFT',
        },
        $set: {
          ...normalized,
          lastEditedAt: now,
        },
      },
      {
        upsert: true,
        returnDocument: 'after',
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    )
      .select('+privateNotes')
      .lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    existing = await InterviewFeedback.findOne({
      companyId,
      interview: interview._id,
      interviewer: actor._id,
    })
      .select('+privateNotes')
      .lean();
    if (submit && existing && feedbackMatches(existing, normalized)) {
      return safeOwnFeedbackDto(existing, { idempotent: true });
    }
    throw ApiError.conflict('Feedback changed in another request. Refresh and try again.');
  }

  if (!submit) {
    await recordAudit({
      req: requestContext,
      action: 'INTERVIEW_FEEDBACK_SAVED',
      companyId,
      actorId: actor._id,
      resource: 'InterviewFeedback',
      resourceId: draft._id,
      metadata: {
        interviewId: interview._id,
        criterionCount: draft.ratings.length,
        status: 'DRAFT',
      },
      statusCode: 200,
    });
    return safeOwnFeedbackDto(draft);
  }

  const submittedAt = new Date();
  const submitted = await InterviewFeedback.findOneAndUpdate(
    {
      _id: draft._id,
      companyId,
      interviewer: actor._id,
      status: 'DRAFT',
      updatedAt: draft.updatedAt,
    },
    {
      $set: {
        status: 'SUBMITTED',
        submittedAt,
        lastEditedAt: submittedAt,
      },
    },
    { returnDocument: 'after', runValidators: true }
  )
    .select('+privateNotes')
    .lean();

  if (!submitted) {
    const winner = await InterviewFeedback.findOne({
      _id: draft._id,
      companyId,
      interviewer: actor._id,
    })
      .select('+privateNotes')
      .lean();
    if (winner && ['SUBMITTED', 'LOCKED'].includes(winner.status) && feedbackMatches(winner, normalized)) {
      return safeOwnFeedbackDto(winner, { idempotent: true });
    }
    throw ApiError.conflict('Feedback changed in another request. Refresh and try again.');
  }

  let timelineEvent;
  try {
    timelineEvent = await CandidateHistory.create({
      companyId,
      candidate: interview.candidate._id,
      job: interview.job._id,
      action: 'INTERVIEW_FEEDBACK_SUBMITTED',
      source: 'INTERVIEW',
      actorType: 'TENANT_USER',
      actor: actor._id,
      metadata: {
        interviewId: interview._id,
        interviewCode: interview.interviewCode,
        roundKey: interview.round?.key || '',
        roundName: interview.round?.name || '',
        recommendation: submitted.recommendation,
        overallScore: submitted.overallScore,
        maxOverallScore: submitted.maxOverallScore,
      },
      eventAt: submittedAt,
    });
  } catch {
    await InterviewFeedback.updateOne(
      {
        _id: submitted._id,
        companyId,
        interviewer: actor._id,
        status: 'SUBMITTED',
        submittedAt,
      },
      { $set: { status: 'DRAFT', submittedAt: null } }
    ).catch(() => {});
    throw new ApiError(
      500,
      'Feedback history could not be secured, so the submission was not completed'
    );
  }

  await recordAudit({
    req: requestContext,
    action: 'INTERVIEW_FEEDBACK_SUBMITTED',
    companyId,
    actorId: actor._id,
    resource: 'InterviewFeedback',
    resourceId: submitted._id,
    metadata: {
      interviewId: interview._id,
      candidateHistoryId: timelineEvent._id,
      recommendation: submitted.recommendation,
      overallScore: submitted.overallScore,
      maxOverallScore: submitted.maxOverallScore,
    },
    statusCode: 200,
    critical: true,
  });

  const submittedInterviewerIds = await InterviewFeedback.find({
    companyId,
    interview: interview._id,
    interviewer: { $in: interview.interviewers.map((item) => item._id || item) },
    status: { $in: ['SUBMITTED', 'LOCKED'] },
  }).distinct('interviewer');
  if (submittedInterviewerIds.length === interview.interviewers.length) {
    await notifyFeedbackComplete({ companyId, interview, candidate: interview.candidate });
  }

  return safeOwnFeedbackDto(submitted);
};

const submittedFeedbackDto = (feedback) => ({
  id: feedback._id,
  interviewer: safePerson(feedback.interviewer),
  status: feedback.status,
  template: {
    key: feedback.templateSnapshot?.key,
    name: feedback.templateSnapshot?.name,
    version: feedback.templateSnapshot?.version,
  },
  ratings: feedback.ratings || [],
  overallScore: feedback.overallScore,
  maxOverallScore: feedback.maxOverallScore || 10,
  strengths: feedback.strengths || '',
  concerns: feedback.concerns || '',
  privateNotes: feedback.privateNotes || '',
  recommendation: feedback.recommendation,
  submittedAt: feedback.submittedAt,
});

export const feedbackSummaryForInterviews = async ({
  companyId,
  interviews,
  actorId = null,
  includeSubmittedDetails = false,
  includeAggregate = true,
}) => {
  const interviewIds = interviews.map((interview) => interview._id);
  if (!interviewIds.length) return new Map();

  const feedbackRecords = await InterviewFeedback.find({
    companyId,
    interview: { $in: interviewIds },
  })
    .select(includeSubmittedDetails ? '+privateNotes' : '')
    .populate({ path: 'interviewer', select: 'name role', match: { companyId } })
    .lean();
  const grouped = new Map();
  feedbackRecords.forEach((feedback) => {
    const key = String(feedback.interview);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(feedback);
  });

  return new Map(
    interviews.map((interview) => {
      const records = grouped.get(String(interview._id)) || [];
      const assigned = interview.interviewers || [];
      const submitted = records.filter((item) =>
        ['SUBMITTED', 'LOCKED'].includes(item.status)
      );
      const own = actorId
        ? records.find((item) => String(item.interviewer?._id || item.interviewer) === String(actorId))
        : null;
      const roundAverage = submitted.length
        ? Math.round(
            (submitted.reduce((sum, item) => sum + Number(item.overallScore || 0), 0) /
              submitted.length) *
              100
          ) / 100
        : null;
      const submittedIds = new Set(
        submitted.map((item) => String(item.interviewer?._id || item.interviewer))
      );

      return [
        String(interview._id),
        {
          enabled: interview.status === 'COMPLETED',
          assignedCount: assigned.length,
          submittedCount: submitted.length,
          pendingCount: Math.max(0, assigned.length - submitted.length),
          pendingInterviewers: assigned
            .filter((item) => !submittedIds.has(String(item._id || item)))
            .map(safePerson),
          roundAverage: includeAggregate ? roundAverage : null,
          maxOverallScore: 10,
          ownStatus: own?.status || 'NOT_STARTED',
          canSubmitOwn:
            interview.status === 'COMPLETED' && Boolean(actorId) && isAssigned(interview, actorId) &&
            !['SUBMITTED', 'LOCKED'].includes(own?.status),
          ...(includeSubmittedDetails
            ? { individualFeedback: submitted.map(submittedFeedbackDto) }
            : {}),
        },
      ];
    })
  );
};

export const getAllSubmittedInterviewFeedback = async ({
  companyId,
  interviewId,
}) => {
  const interview = await loadInterview({ companyId, interviewId });
  if (!interview || !interview.candidate || !interview.job) {
    throw ApiError.notFound('Interview not found');
  }
  const summaries = await feedbackSummaryForInterviews({
    companyId,
    interviews: [interview],
    includeSubmittedDetails: true,
  });

  return {
    interview: {
      id: interview._id,
      interviewCode: interview.interviewCode,
      round: interview.round,
      status: interview.status,
      candidate: {
        id: interview.candidate._id,
        candidateCode: interview.candidate.candidateCode,
        name: interview.candidate.name,
      },
      job: {
        id: interview.job._id,
        jobCode: interview.job.jobCode,
        title: interview.job.title,
      },
    },
    ...summaries.get(String(interview._id)),
  };
};
