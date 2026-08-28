import { randomUUID } from 'node:crypto';
import Candidate from '../models/Candidate.js';
import CandidateDecision from '../models/CandidateDecision.js';
import CandidateHistory from '../models/CandidateHistory.js';
import CandidatePipelineHistory from '../models/CandidatePipelineHistory.js';
import Interview, { ACTIVE_INTERVIEW_STATUSES } from '../models/Interview.js';
import InterviewFeedback from '../models/InterviewFeedback.js';
import ApiError from '../utils/ApiError.js';
import { recordAudit } from '../utils/securityauditService.js';
import {
  normalizeCandidateStage,
  transitionCandidateStage,
} from './candidatePipelineService.js';
import { notifyHumanDecision } from './recruitmentEvaluationNotificationService.js';
import { bumpRecruitmentAnalyticsGeneration } from './analyticsCacheInvalidation.js';

const DECISION_REASON_CATEGORIES = {
  SELECTED: ['BEST_FIT', 'ROLE_ALIGNMENT', 'INTERVIEW_EVIDENCE', 'OTHER'],
  REJECTED: [
    'SKILLS_MISMATCH',
    'INTERVIEW_PERFORMANCE',
    'ROLE_EXPECTATIONS',
    'POSITION_CLOSED',
    'COMPENSATION_EXPECTATIONS',
    'OTHER',
  ],
  HOLD: [
    'POSITION_PAUSED',
    'AWAITING_APPROVAL',
    'CANDIDATE_AVAILABILITY',
    'ADDITIONAL_REVIEW',
    'OTHER',
  ],
};

const DECISION_HISTORY_ACTION = {
  SELECTED: 'CANDIDATE_SELECTED',
  REJECTED: 'CANDIDATE_REJECTED',
  HOLD: 'CANDIDATE_HOLD',
};
const PROTECTED_CLASS_REASON_PATTERN =
  /\b(age|caste|disability|disabled|ethnicity|gender|marital|nationality|pregnan\w*|race|religion|sex|sexual orientation)\b/i;

const loadCandidate = async ({ companyId, candidateId }) => {
  const candidate = await Candidate.findOne({ _id: candidateId, companyId })
    .select('_id candidateCode name job currentStage stage')
    .lean();
  if (!candidate) throw ApiError.notFound('Candidate not found');
  return candidate;
};

const safeDecisionDto = (record, { idempotent = false } = {}) => ({
  id: record._id,
  candidateId: record.candidate,
  jobId: record.job,
  decision: record.decision,
  sourceStage: record.sourceStage,
  reasonCategory: record.reasonCategory,
  comment: record.comment || '',
  decidedBy: record.decidedBy,
  decidedAt: record.decidedAt,
  status: record.status,
  pipelineHistoryId: record.pipelineHistory || null,
  candidateHistoryId: record.candidateHistory || null,
  idempotent,
});

const finalReviewReason = (comment) => {
  const value = String(comment || '').trim().slice(0, 1000);
  return value || 'Human review of interview and recruitment evidence started';
};

export const startCandidateFinalReview = async ({
  companyId,
  candidateId,
  actor,
  input,
  requestContext,
}) => {
  const candidate = await loadCandidate({ companyId, candidateId });
  const currentStage = normalizeCandidateStage(
    candidate.currentStage || candidate.stage
  );

  if (currentStage === 'FINAL_REVIEW') {
    return {
      candidateId: candidate._id,
      fromStage: 'FINAL_REVIEW',
      toStage: 'FINAL_REVIEW',
      idempotent: true,
    };
  }
  if (currentStage !== 'HR_FINAL') {
    throw ApiError.conflict('Final Review can begin only after the HR Final stage');
  }

  const [completedInterviews, activeInterview] = await Promise.all([
    Interview.find({
      companyId,
      candidate: candidate._id,
      job: candidate.job,
      status: 'COMPLETED',
    })
      .select('_id interviewers')
      .lean(),
    Interview.exists({
      companyId,
      candidate: candidate._id,
      job: candidate.job,
      status: { $in: ACTIVE_INTERVIEW_STATUSES },
    }),
  ]);
  if (!completedInterviews.length) {
    throw ApiError.conflict('Complete at least one interview before Final Review');
  }
  if (activeInterview) {
    throw ApiError.conflict('Complete or cancel active interviews before Final Review');
  }

  const submittedFeedback = await InterviewFeedback.find({
    companyId,
    interview: { $in: completedInterviews.map((interview) => interview._id) },
    status: { $in: ['SUBMITTED', 'LOCKED'] },
  })
    .select('interview interviewer')
    .lean();
  const submittedKeys = new Set(
    submittedFeedback.map((feedback) => `${feedback.interview}:${feedback.interviewer}`)
  );
  const pendingFeedback = completedInterviews.reduce(
    (total, interview) =>
      total +
      interview.interviewers.filter(
        (interviewerId) =>
          !submittedKeys.has(`${interview._id}:${interviewerId}`)
      ).length,
    0
  );
  if (pendingFeedback) {
    throw ApiError.conflict(
      `Submit all assigned scorecards before Final Review (${pendingFeedback} pending)`
    );
  }

  const reason = finalReviewReason(input.comment);
  const transition = await transitionCandidateStage({
    companyId,
    candidateId: candidate._id,
    targetStage: 'FINAL_REVIEW',
    reason,
    actorId: actor._id,
    requestContext,
    metadata: {
      source: 'MANUAL',
      action: 'FINAL_REVIEW_STARTED',
    },
  });

  let timelineEvent;
  try {
    timelineEvent = await CandidateHistory.create({
      companyId,
      candidate: candidate._id,
      job: candidate.job,
      action: 'FINAL_REVIEW_STARTED',
      source: 'FINAL_DECISION',
      actorType: 'TENANT_USER',
      actor: actor._id,
      metadata: {
        pipelineHistoryId: transition.pipelineHistoryId,
      },
      eventAt: transition.changedAt,
    });
  } catch {
    await transitionCandidateStage({
      companyId,
      candidateId: candidate._id,
      targetStage: 'HR_FINAL',
      reason: 'Final Review timeline could not be secured',
      actorId: actor._id,
      requestContext,
      metadata: { source: 'MANUAL', action: 'FINAL_REVIEW_ROLLBACK' },
    }).catch(() => {});
    throw new ApiError(
      500,
      'Final Review history could not be secured, so the transition was not completed'
    );
  }

  await recordAudit({
    req: requestContext,
    action: 'FINAL_REVIEW_STARTED',
    companyId,
    actorId: actor._id,
    resource: 'Candidate',
    resourceId: candidate._id,
    previousValue: { currentStage },
    newValue: { currentStage: 'FINAL_REVIEW' },
    metadata: {
      pipelineHistoryId: transition.pipelineHistoryId,
      candidateHistoryId: timelineEvent._id,
    },
    statusCode: 200,
    critical: true,
  });

  // 28.7: analytics cache generation bump (fire-and-forget, never throws).
  bumpRecruitmentAnalyticsGeneration(companyId).catch(() => {});

  return { ...transition, candidateHistoryId: timelineEvent._id, idempotent: false };
};

const normalizeDecisionInput = (input) => {
  const decision = String(input.decision || '').toUpperCase().trim();
  const reasonCategory = String(input.reasonCategory || '').toUpperCase().trim();
  const comment = String(input.comment || '').trim().slice(0, 2000);

  if (!DECISION_REASON_CATEGORIES[decision]) {
    throw ApiError.badRequest('Choose Selected, Rejected, or Hold');
  }
  if (!DECISION_REASON_CATEGORIES[decision].includes(reasonCategory)) {
    throw ApiError.badRequest('Choose an approved reason category for this decision');
  }
  if (['REJECTED', 'HOLD'].includes(decision) && comment.length < 5) {
    throw ApiError.badRequest('Add a brief decision comment for Rejected or Hold');
  }
  if (comment && PROTECTED_CLASS_REASON_PATTERN.test(comment)) {
    throw ApiError.badRequest(
      'Decision comments must contain only job-related evidence and cannot reference protected-class information'
    );
  }

  return { decision, reasonCategory, comment };
};

const matchingDecision = (record, input) =>
  record?.decision === input.decision &&
  record?.reasonCategory === input.reasonCategory &&
  String(record?.comment || '') === input.comment;

const latestCompletedDecision = async ({ companyId, candidateId }) =>
  CandidateDecision.findOne({
    companyId,
    candidate: candidateId,
    status: 'COMPLETED',
  })
    .sort({ decidedAt: -1, _id: -1 })
    .lean();

export const recordCandidateFinalDecision = async ({
  companyId,
  candidateId,
  actor,
  input,
  requestContext,
}) => {
  const normalized = normalizeDecisionInput(input);
  let candidate = await loadCandidate({ companyId, candidateId });
  let currentStage = normalizeCandidateStage(candidate.currentStage || candidate.stage);

  const completed = await latestCompletedDecision({ companyId, candidateId });
  if (currentStage === normalized.decision) {
    if (matchingDecision(completed, normalized)) {
      return safeDecisionDto(completed, { idempotent: true });
    }
    if (!completed) {
      // A prior request may have changed the stage before finalizing its ledger.
      // The active operation below is allowed to resume that exact request only.
    } else {
      throw ApiError.conflict('This candidate already has a different completed decision');
    }
  } else if (currentStage !== 'FINAL_REVIEW') {
    throw ApiError.conflict('A final decision can be recorded only from Final Review');
  }

  let operation = await CandidateDecision.findOne({
    companyId,
    candidate: candidate._id,
    activeOperationKey: 'FINAL_DECISION',
  }).lean();

  if (operation && !matchingDecision(operation, normalized)) {
    throw ApiError.conflict('Another final decision is already in progress');
  }
  if (!operation && currentStage === normalized.decision) {
    throw ApiError.conflict('This stage was not created by a resumable final-decision request');
  }

  if (!operation) {
    try {
      operation = await CandidateDecision.create({
        companyId,
        candidate: candidate._id,
        job: candidate.job,
        decision: normalized.decision,
        sourceStage: 'FINAL_REVIEW',
        reasonCategory: normalized.reasonCategory,
        comment: normalized.comment,
        decidedBy: actor._id,
        status: 'PENDING',
        activeOperationKey: 'FINAL_DECISION',
      });
      operation = operation.toObject();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      operation = await CandidateDecision.findOne({
        companyId,
        candidate: candidate._id,
        activeOperationKey: 'FINAL_DECISION',
      }).lean();
      if (!operation || !matchingDecision(operation, normalized)) {
        throw ApiError.conflict('Another final decision is already in progress');
      }
    }
  }

  const claimToken = randomUUID();
  const claimExpiry = new Date(Date.now() - 60 * 1000);
  const claimedOperation = await CandidateDecision.findOneAndUpdate(
    {
      _id: operation._id,
      companyId,
      activeOperationKey: 'FINAL_DECISION',
      status: { $in: ['PENDING', 'STAGE_CHANGED'] },
      $or: [
        { claimedAt: null },
        { claimedAt: { $exists: false } },
        { claimedAt: { $lte: claimExpiry } },
      ],
    },
    { $set: { claimToken, claimedAt: new Date() } },
    { returnDocument: 'after' }
  )
    .select('+claimToken +claimedAt')
    .lean();

  if (!claimedOperation) {
    const winner = await latestCompletedDecision({ companyId, candidateId });
    if (matchingDecision(winner, normalized)) {
      return safeDecisionDto(winner, { idempotent: true });
    }
    throw ApiError.conflict('This final decision is already being recorded');
  }
  operation = claimedOperation;

  let pipelineHistoryId = operation.pipelineHistory || null;
  if (currentStage === 'FINAL_REVIEW') {
    try {
      const transition = await transitionCandidateStage({
        companyId,
        candidateId: candidate._id,
        targetStage: normalized.decision,
        reason: `${normalized.reasonCategory}: ${normalized.comment || 'Human decision recorded'}`,
        actorId: actor._id,
        requestContext,
        metadata: {
          source: 'MANUAL',
          action: `FINAL_DECISION_${normalized.decision}`,
        },
      });
      pipelineHistoryId = transition.pipelineHistoryId;
      await CandidateDecision.updateOne(
        {
          _id: operation._id,
          companyId,
          activeOperationKey: 'FINAL_DECISION',
          status: 'PENDING',
          claimToken,
        },
        {
          $set: {
            status: 'STAGE_CHANGED',
            pipelineHistory: pipelineHistoryId,
          },
        }
      );
      currentStage = normalized.decision;
    } catch (error) {
      await CandidateDecision.updateOne(
        { _id: operation._id, companyId, status: 'PENDING', claimToken },
        {
          $set: {
            status: 'FAILED',
            activeOperationKey: null,
            failureCode: 'PIPELINE_TRANSITION_FAILED',
          },
          $unset: { claimToken: 1, claimedAt: 1 },
        }
      ).catch(() => {});
      throw error;
    }
  } else if (!pipelineHistoryId) {
    const pipelineHistory = await CandidatePipelineHistory.findOne({
      companyId,
      candidateId: candidate._id,
      fromStage: 'FINAL_REVIEW',
      toStage: normalized.decision,
    })
      .sort({ createdAt: -1 })
      .select('_id')
      .lean();
    if (!pipelineHistory) {
      await CandidateDecision.updateOne(
        { _id: operation._id, companyId, claimToken },
        {
          $set: {
            status: 'FAILED',
            activeOperationKey: null,
            failureCode: 'PIPELINE_HISTORY_MISSING',
          },
          $unset: { claimToken: 1, claimedAt: 1 },
        }
      ).catch(() => {});
      throw ApiError.conflict('The final-decision pipeline transition could not be verified');
    }
    pipelineHistoryId = pipelineHistory._id;
    await CandidateDecision.updateOne(
      {
        _id: operation._id,
        companyId,
        activeOperationKey: 'FINAL_DECISION',
        claimToken,
      },
      { $set: { status: 'STAGE_CHANGED', pipelineHistory: pipelineHistoryId } }
    );
  }

  let timelineEvent = operation.candidateHistory
    ? { _id: operation.candidateHistory }
    : await CandidateHistory.findOne({
        companyId,
        candidate: candidate._id,
        'metadata.decisionId': operation._id,
      })
        .select('_id')
        .lean();

  if (!timelineEvent) {
    try {
      timelineEvent = await CandidateHistory.create({
        companyId,
        candidate: candidate._id,
        job: candidate.job,
        action: DECISION_HISTORY_ACTION[normalized.decision],
        source: 'FINAL_DECISION',
        actorType: 'TENANT_USER',
        actor: actor._id,
        metadata: {
          decisionId: operation._id,
          decision: normalized.decision,
          reasonCategory: normalized.reasonCategory,
          pipelineHistoryId,
        },
        eventAt: new Date(),
      });
    } catch {
      await transitionCandidateStage({
        companyId,
        candidateId: candidate._id,
        targetStage: 'FINAL_REVIEW',
        reason: 'Final decision timeline could not be secured',
        actorId: actor._id,
        requestContext,
        metadata: { source: 'MANUAL', action: 'FINAL_DECISION_ROLLBACK' },
      }).catch(() => {});
      await CandidateDecision.updateOne(
        { _id: operation._id, companyId, claimToken },
        {
          $set: {
            status: 'FAILED',
            activeOperationKey: null,
            failureCode: 'TIMELINE_FAILED',
          },
          $unset: { claimToken: 1, claimedAt: 1 },
        }
      ).catch(() => {});
      throw new ApiError(
        500,
        'Decision history could not be secured, so the decision was not completed'
      );
    }
  }

  const decidedAt = new Date();
  const finalized = await CandidateDecision.findOneAndUpdate(
    {
      _id: operation._id,
      companyId,
      activeOperationKey: 'FINAL_DECISION',
      status: { $in: ['PENDING', 'STAGE_CHANGED'] },
      claimToken,
    },
    {
      $set: {
        status: 'COMPLETED',
        activeOperationKey: null,
        decidedAt,
        pipelineHistory: pipelineHistoryId,
        candidateHistory: timelineEvent._id,
        failureCode: '',
      },
      $unset: { claimToken: 1, claimedAt: 1 },
    },
    { returnDocument: 'after', runValidators: true }
  ).lean();

  if (!finalized) {
    const winner = await latestCompletedDecision({ companyId, candidateId });
    if (matchingDecision(winner, normalized)) {
      return safeDecisionDto(winner, { idempotent: true });
    }
    throw ApiError.conflict('Final decision changed in another request');
  }

  await recordAudit({
    req: requestContext,
    action: DECISION_HISTORY_ACTION[normalized.decision],
    companyId,
    actorId: actor._id,
    resource: 'CandidateDecision',
    resourceId: finalized._id,
    previousValue: { currentStage: 'FINAL_REVIEW' },
    newValue: { currentStage: normalized.decision },
    metadata: {
      reasonCategory: normalized.reasonCategory,
      pipelineHistoryId,
      candidateHistoryId: timelineEvent._id,
      humanDecision: true,
    },
    statusCode: 200,
    critical: true,
  });

  candidate = { ...candidate, currentStage: normalized.decision };
  await notifyHumanDecision({
    companyId,
    candidate,
    decision: normalized.decision,
  });

  // 28.7: analytics cache generation bump (fire-and-forget, never throws).
  bumpRecruitmentAnalyticsGeneration(companyId).catch(() => {});

  return safeDecisionDto(finalized);
};
