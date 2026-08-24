import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import CandidateHistory from '../models/CandidateHistory.js';
import CandidatePipelineHistory, {
  DISPOSITION_PIPELINE_STAGES,
  PIPELINE_STAGES,
  POSITIVE_PIPELINE_STAGES,
} from '../models/CandidatePipelineHistory.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import {
  candidatePipelineUpdateEmail,
  sendMail,
} from '../utils/mailer.js';
import { recordAudit } from '../utils/securityauditService.js';

const LEGACY_STAGE_MAP = {
  SCREENING: 'HR_SCREENING',
  INTERVIEW: 'INTERVIEW_1',
  HIRED: 'JOINED',
};
const RECRUITER_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];
const HIRING_MANAGER_ROLES = [
  'COMPANY_ADMIN',
  'HR_MANAGER',
  'MANAGER',
  'TEAM_LEAD',
];

export const normalizeCandidateStage = (value) => {
  const stage = String(value || '').toUpperCase();
  if (PIPELINE_STAGES.includes(stage)) return stage;
  return LEGACY_STAGE_MAP[stage] || 'APPLIED';
};

const transitionRequiresReason = (fromStage, toStage) => {
  if (DISPOSITION_PIPELINE_STAGES.includes(toStage)) return true;

  const fromIndex = POSITIVE_PIPELINE_STAGES.indexOf(fromStage);
  const toIndex = POSITIVE_PIPELINE_STAGES.indexOf(toStage);
  return fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex;
};

const safeTransitionMetadata = (metadata = {}) => ({
  source: ['ATS_ENGINE', 'MANUAL', 'BULK', 'PIPELINE'].includes(
    metadata.source
  )
    ? metadata.source
    : 'MANUAL',
  bulk: Boolean(metadata.bulk),
  ...(metadata.bulkAction
    ? { bulkAction: String(metadata.bulkAction).slice(0, 50) }
    : {}),
  ...(metadata.action
    ? { action: String(metadata.action).slice(0, 80) }
    : {}),
  ...(metadata.actorType === 'SYSTEM' ? { actorType: 'SYSTEM' } : {}),
});

const candidateStageGuard = (candidate, fromStage) => ({
  $or: [
    { currentStage: fromStage },
    {
      currentStage: { $exists: false },
      stage: candidate.stage,
    },
  ],
});

const safeFailure = (error) => ({
  statusCode: Number(error?.statusCode) || 409,
  message:
    Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500
      ? String(error.message || 'Candidate action could not be completed').slice(0, 300)
      : 'Candidate action could not be completed safely',
});

export const transitionCandidateStage = async ({
  companyId,
  candidateId,
  targetStage,
  reason = '',
  actorId,
  metadata = {},
}) => {
  const normalizedTarget = String(targetStage || '').toUpperCase();
  if (!PIPELINE_STAGES.includes(normalizedTarget)) {
    throw ApiError.badRequest('Choose a valid pipeline stage');
  }
  if (!mongoose.isValidObjectId(actorId)) {
    throw ApiError.badRequest('A valid pipeline actor is required');
  }

  const candidate = await Candidate.findOne({
    _id: candidateId,
    companyId,
  })
    .select('_id candidateCode job currentStage stage')
    .lean();

  if (!candidate) throw ApiError.notFound('Candidate not found');

  const fromStage = normalizeCandidateStage(
    candidate.currentStage || candidate.stage
  );
  const changeReason = String(reason || '').trim().slice(0, 1000);

  if (fromStage === normalizedTarget) {
    throw ApiError.conflict(`Candidate is already in ${normalizedTarget}`);
  }
  if (fromStage === 'JOINED') {
    throw ApiError.conflict('JOINED is a final recruitment stage');
  }
  if (
    transitionRequiresReason(fromStage, normalizedTarget) &&
    !changeReason
  ) {
    throw ApiError.badRequest(
      'A reason is required for disposition or sent-back stage changes'
    );
  }

  const updated = await Candidate.findOneAndUpdate(
    {
      _id: candidate._id,
      companyId,
      job: candidate.job,
      ...candidateStageGuard(candidate, fromStage),
    },
    {
      $set: {
        currentStage: normalizedTarget,
        stage: normalizedTarget,
      },
    },
    { returnDocument: 'after' }
  )
    .select('_id candidateCode job currentStage stage')
    .lean();

  if (!updated) {
    throw ApiError.conflict(
      'Candidate stage changed in another request. Refresh and try again.'
    );
  }

  let history;
  try {
    history = await CandidatePipelineHistory.create({
      companyId,
      candidateId: candidate._id,
      jobPostingId: candidate.job,
      fromStage,
      toStage: normalizedTarget,
      changedBy: actorId,
      changeReason,
      metadata: safeTransitionMetadata(metadata),
      createdAt: new Date(),
    });
  } catch {
    await Candidate.updateOne(
      {
        _id: candidate._id,
        companyId,
        job: candidate.job,
        currentStage: normalizedTarget,
      },
      {
        $set: {
          currentStage: fromStage,
          stage: fromStage,
        },
      }
    ).catch(() => {});

    throw new ApiError(
      500,
      'Stage history could not be secured, so the transition was not completed'
    );
  }

  await recordAudit({
    req: null,
    action: 'CANDIDATE_STAGE_CHANGED',
    companyId,
    actorId,
    resource: 'Candidate',
    resourceId: candidate._id,
    previousValue: { currentStage: fromStage },
    newValue: { currentStage: normalizedTarget },
    metadata: {
      reason: changeReason,
      bulk: Boolean(metadata.bulk),
      source: metadata.source || 'MANUAL',
      pipelineHistoryId: history._id,
    },
    statusCode: 200,
    critical: true,
  });

  return {
    candidateId: updated._id,
    candidateCode: updated.candidateCode,
    fromStage,
    toStage: normalizedTarget,
    changedAt: history.createdAt,
    candidate: updated,
  };
};

const recordCandidateEvent = async ({
  companyId,
  candidate,
  actorId,
  action,
  metadata,
}) =>
  CandidateHistory.create({
    companyId,
    candidate: candidate._id,
    job: candidate.job?._id || candidate.job,
    action,
    source: 'PIPELINE',
    actorType: 'TENANT_USER',
    actor: actorId,
    metadata,
    eventAt: new Date(),
  });

const assignCandidate = async ({
  companyId,
  candidate,
  actorId,
  assignmentField,
  assignmentLabel,
  assignee,
  bulkAction,
}) => {
  const currentAssignee = candidate[assignmentField]?._id || candidate[assignmentField];
  if (String(currentAssignee || '') === String(assignee._id)) {
    throw ApiError.conflict(
      `Candidate is already assigned to this ${assignmentLabel.toLowerCase()}`
    );
  }

  const assignmentGuard = currentAssignee
    ? { [assignmentField]: currentAssignee }
    : {
        $or: [
          { [assignmentField]: null },
          { [assignmentField]: { $exists: false } },
        ],
      };
  const updated = await Candidate.findOneAndUpdate(
    {
      _id: candidate._id,
      companyId,
      job: candidate.job?._id || candidate.job,
      ...assignmentGuard,
    },
    { $set: { [assignmentField]: assignee._id } },
    { returnDocument: 'after' }
  )
    .select('_id')
    .lean();

  if (!updated) throw ApiError.conflict('Candidate assignment changed in another request');

  let event;
  try {
    event = await recordCandidateEvent({
      companyId,
      candidate,
      actorId,
      action: 'CANDIDATE_ASSIGNMENT_UPDATED',
      metadata: {
        assignmentType: assignmentField,
        assigneeId: assignee._id,
        assigneeName: assignee.name,
        assigneeRole: assignee.role,
        bulk: true,
        bulkAction,
      },
    });
  } catch {
    const rollback = currentAssignee
      ? { $set: { [assignmentField]: currentAssignee } }
      : { $unset: { [assignmentField]: 1 } };
    await Candidate.updateOne(
      {
        _id: candidate._id,
        companyId,
        [assignmentField]: assignee._id,
      },
      rollback
    ).catch(() => {});
    throw new ApiError(
      500,
      'Assignment history could not be secured, so the assignment was not completed'
    );
  }

  await recordAudit({
    req: null,
    action: 'CANDIDATE_ASSIGNMENT_UPDATED',
    companyId,
    actorId,
    resource: 'Candidate',
    resourceId: candidate._id,
    newValue: {
      assignmentType: assignmentField,
      assigneeId: assignee._id,
    },
    metadata: { bulk: true, candidateHistoryId: event._id },
    critical: true,
  });

  return { candidateId: candidate._id, assignedTo: assignee._id };
};

const sendCandidateUpdate = async ({
  companyId,
  companyName,
  candidate,
  actorId,
}) => {
  const job = candidate.job || {};
  const currentStage = normalizeCandidateStage(
    candidate.currentStage || candidate.stage
  );
  const delivery = await sendMail({
    to: candidate.email,
    ...candidatePipelineUpdateEmail({
      candidateName: candidate.name,
      companyName,
      jobTitle: job.title || 'the position',
      candidateCode: candidate.candidateCode,
      stage: currentStage,
    }),
    sensitive: true,
  });

  const event = await recordCandidateEvent({
    companyId,
    candidate,
    actorId,
    action: 'CANDIDATE_EMAIL_SENT',
    metadata: {
      template: 'APPLICATION_STATUS_UPDATE',
      stage: currentStage,
      delivered: Boolean(delivery.delivered),
      deliveryMode: delivery.mode,
      bulk: true,
    },
  });

  await recordAudit({
    req: null,
    action: 'CANDIDATE_EMAIL_SENT',
    companyId,
    actorId,
    resource: 'Candidate',
    resourceId: candidate._id,
    metadata: {
      template: 'APPLICATION_STATUS_UPDATE',
      stage: currentStage,
      delivered: Boolean(delivery.delivered),
      deliveryMode: delivery.mode,
      bulk: true,
      candidateHistoryId: event._id,
    },
    statusCode: delivery.delivered ? 200 : 502,
    critical: true,
  });

  if (!delivery.delivered) {
    throw new ApiError(502, 'Standard candidate email could not be delivered');
  }

  return { candidateId: candidate._id, delivered: true };
};

const targetStageForAction = ({ action, targetStage }) =>
  ({
    SHORTLIST: 'SHORTLISTED',
    REJECT: 'REJECTED',
    HOLD: 'HOLD',
    MOVE_STAGE: targetStage,
  })[action] || '';

export const bulkCandidateAction = async ({
  companyId,
  companyName,
  candidateIds,
  action,
  targetStage = '',
  reason = '',
  userId = null,
  actorId,
}) => {
  const candidates = await Candidate.find({
    _id: { $in: candidateIds },
    companyId,
  })
    .select(
      '_id candidateCode name email job currentStage stage assignedRecruiter hiringManager'
    )
    .populate({ path: 'job', select: 'title jobCode' })
    .lean();

  if (candidates.length !== candidateIds.length) {
    throw ApiError.forbidden(
      'Candidate selection contains unavailable or cross-tenant records'
    );
  }

  const candidateMap = new Map(
    candidates.map((candidate) => [String(candidate._id), candidate])
  );
  const orderedCandidates = candidateIds.map((id) => candidateMap.get(String(id)));
  let assignee = null;
  let assignmentField = '';
  let assignmentLabel = '';

  if (['ASSIGN_RECRUITER', 'ASSIGN_HIRING_MANAGER'].includes(action)) {
    const allowedRoles = action === 'ASSIGN_RECRUITER'
      ? RECRUITER_ROLES
      : HIRING_MANAGER_ROLES;
    assignee = await User.findOne({
      _id: userId,
      companyId,
      status: 'ACTIVE',
      role: { $in: allowedRoles },
    })
      .select('_id name role')
      .lean();

    if (!assignee) {
      throw ApiError.badRequest('Selected assignee is not eligible in this company');
    }

    assignmentField = action === 'ASSIGN_RECRUITER'
      ? 'assignedRecruiter'
      : 'hiringManager';
    assignmentLabel = action === 'ASSIGN_RECRUITER'
      ? 'Recruiter'
      : 'Hiring manager';
  }

  const succeeded = [];
  const failed = [];
  const stageTarget = targetStageForAction({ action, targetStage });

  for (const candidate of orderedCandidates) {
    try {
      let result;

      if (stageTarget) {
        result = await transitionCandidateStage({
          companyId,
          candidateId: candidate._id,
          targetStage: stageTarget,
          reason,
          actorId,
          metadata: {
            source: 'BULK',
            bulk: true,
            bulkAction: action,
          },
        });
      } else if (assignee) {
        result = await assignCandidate({
          companyId,
          candidate,
          actorId,
          assignmentField,
          assignmentLabel,
          assignee,
          bulkAction: action,
        });
      } else if (action === 'SEND_EMAIL') {
        result = await sendCandidateUpdate({
          companyId,
          companyName,
          candidate,
          actorId,
        });
      } else {
        throw ApiError.badRequest('Unsupported bulk candidate action');
      }

      succeeded.push({
        candidateId: candidate._id,
        candidateCode: candidate.candidateCode,
        ...(result.toStage ? { toStage: result.toStage } : {}),
      });
    } catch (error) {
      failed.push({
        candidateId: candidate._id,
        candidateCode: candidate.candidateCode,
        ...safeFailure(error),
      });
    }
  }

  return {
    action,
    requested: candidateIds.length,
    succeeded,
    failed,
    summary: {
      requested: candidateIds.length,
      succeeded: succeeded.length,
      failed: failed.length,
    },
  };
};

export const getPipelineOptions = async ({ companyId }) => {
  const users = await User.find({
    companyId,
    status: 'ACTIVE',
    role: { $in: HIRING_MANAGER_ROLES },
  })
    .select('_id name role')
    .sort({ name: 1, _id: 1 })
    .lean();

  return {
    stages: PIPELINE_STAGES,
    dispositionStages: DISPOSITION_PIPELINE_STAGES,
    recruiters: users
      .filter((user) => RECRUITER_ROLES.includes(user.role))
      .map((user) => ({ id: user._id, name: user.name, role: user.role })),
    hiringManagers: users.map((user) => ({
      id: user._id,
      name: user.name,
      role: user.role,
    })),
  };
};
