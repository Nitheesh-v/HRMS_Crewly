import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import CandidateHistory from '../models/CandidateHistory.js';
import Company from '../models/Company.js';
import Interview, {
  ACTIVE_INTERVIEW_STATUSES,
  INTERVIEW_STATUSES,
  INTERVIEW_TYPES,
} from '../models/Interview.js';
import InterviewScheduleLock from '../models/InterviewScheduleLock.js';
import JobPosting from '../models/JobPosting.js';
import JobRequisition from '../models/JobRequisition.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { nextInterviewCode } from '../utils/interviewIdentifiers.js';
import {
  companyDayUtcRange,
  interviewWallClockToUtc,
  reminderDispatchAfter,
} from '../utils/interviewDateTime.js';
import { hasPermission } from '../utils/permissionService.js';
import { recordAudit } from '../utils/securityauditService.js';
import { transitionCandidateStage } from './candidatePipelineService.js';
import { dispatchInterviewNotification } from './interviewNotificationDispatcher.js';
import {
  interviewRoundOptions,
  resolveInterviewRound,
} from './interviewRoundService.js';

const SCHEDULABLE_CANDIDATE_STAGES = [
  'SHORTLISTED',
  'INTERVIEW_1',
  'INTERVIEW_2',
  'INTERVIEW_3',
  'MANAGER_ROUND',
  'HR_FINAL',
];
const ASSIGNABLE_INTERVIEWER_ROLES = [
  'COMPANY_ADMIN',
  'HR_MANAGER',
  'MANAGER',
  'TEAM_LEAD',
  'EMPLOYEE',
];
const STATUS_TRANSITIONS = {
  SCHEDULED: ['IN_PROGRESS', 'COMPLETED', 'NO_SHOW'],
  RESCHEDULED: ['IN_PROGRESS', 'COMPLETED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'NO_SHOW'],
};
const STATUS_EVENT_ACTION = {
  IN_PROGRESS: 'INTERVIEW_STARTED',
  COMPLETED: 'INTERVIEW_COMPLETED',
  NO_SHOW: 'INTERVIEW_NO_SHOW',
};
const SCHEDULE_LOCK_LEASE_MS = 60 * 1000;

const acquireScheduleLock = async (companyId) => {
  const ownerToken = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SCHEDULE_LOCK_LEASE_MS);

  try {
    const lock = await InterviewScheduleLock.findOneAndUpdate(
      {
        _id: companyId,
        companyId,
        $or: [
          { expiresAt: { $lte: now } },
          { expiresAt: { $exists: false } },
        ],
      },
      {
        $set: { ownerToken, expiresAt },
        $setOnInsert: { _id: companyId, companyId },
      },
      {
        upsert: true,
        returnDocument: 'after',
        setDefaultsOnInsert: true,
      }
    ).lean();

    if (!lock || lock.ownerToken !== ownerToken) {
      throw ApiError.conflict(
        'Another interview schedule is being saved. Refresh and try again.'
      );
    }
    return ownerToken;
  } catch (error) {
    if (error.code === 11000) {
      throw ApiError.conflict(
        'Another interview schedule is being saved. Refresh and try again.'
      );
    }
    throw error;
  }
};

const releaseScheduleLock = async ({ companyId, ownerToken }) => {
  await InterviewScheduleLock.updateOne(
    { _id: companyId, companyId, ownerToken },
    { $set: { expiresAt: new Date(0), ownerToken: `released:${ownerToken}` } }
  ).catch(() => {});
};

const objectIdStrings = (values = []) => values.map((value) => String(value));
const sameIds = (left = [], right = []) => {
  const leftIds = objectIdStrings(left).sort();
  const rightIds = objectIdStrings(right).sort();
  return leftIds.length === rightIds.length &&
    leftIds.every((value, index) => value === rightIds[index]);
};
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const paginationValues = (query = {}) => ({
  page: Math.min(10000, Math.max(1, Number(query.page) || 1)),
  limit: Math.min(50, Math.max(1, Number(query.limit) || 20)),
});
const isAssigned = (interview, actorId) =>
  (interview.interviewers || []).some(
    (interviewer) =>
      String(interviewer?._id || interviewer) === String(actorId)
  );
const isHttpsUrl = (value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const validateChannel = ({ interviewType, meetingLink = '', location = '' }) => {
  if (!INTERVIEW_TYPES.includes(interviewType)) {
    throw ApiError.badRequest('Choose a valid interview type');
  }
  if (interviewType === 'ONLINE' && !isHttpsUrl(meetingLink)) {
    throw ApiError.badRequest('An HTTPS meeting link is required for online interviews');
  }
  if (interviewType === 'ONSITE' && !String(location || '').trim()) {
    throw ApiError.badRequest('A location is required for onsite interviews');
  }
};

const candidateReferenceFilter = (candidateRef) =>
  mongoose.isValidObjectId(candidateRef)
    ? { _id: candidateRef }
    : { candidateCode: String(candidateRef || '').trim().toUpperCase() };

const interviewPopulate = (query) =>
  query
    .populate({
      path: 'candidate',
      select: 'candidateCode name email phone currentStage stage status job',
    })
    .populate({
      path: 'job',
      select: 'jobCode title location workMode employmentType status',
    })
    .populate({
      path: 'interviewers',
      select: 'name email role status',
    })
    .populate({ path: 'createdBy', select: 'name role' })
    .populate({ path: 'updatedBy', select: 'name role' })
    .populate({ path: 'cancellation.cancelledBy', select: 'name role' })
    .populate({ path: 'rescheduleHistory.changedBy', select: 'name role' })
    .populate({ path: 'statusHistory.changedBy', select: 'name role' });

const safePerson = (person) =>
  person
    ? {
        id: person._id || person,
        ...(person.name ? { name: person.name } : {}),
        ...(person.role ? { role: person.role } : {}),
        ...(person.status ? { status: person.status } : {}),
      }
    : null;

const safeInterviewDto = (
  interview,
  {
    includeInternalNotes = false,
    includeDispatchMetadata = false,
    canReschedule = false,
    canCancel = false,
    canSetStatus = false,
  } = {}
) => ({
  id: interview._id,
  interviewCode: interview.interviewCode,
  candidate: interview.candidate
    ? {
        id: interview.candidate._id,
        candidateCode: interview.candidate.candidateCode,
        name: interview.candidate.name,
        email: interview.candidate.email,
        phone: interview.candidate.phone || '',
        currentStage:
          interview.candidate.currentStage || interview.candidate.stage || '',
      }
    : null,
  job: interview.job
    ? {
        id: interview.job._id,
        jobCode: interview.job.jobCode,
        title: interview.job.title,
        location: interview.job.location || '',
        workMode: interview.job.workMode || '',
        employmentType: interview.job.employmentType || '',
      }
    : null,
  requisitionId: interview.requisition || null,
  round: interview.round,
  scheduledStartAt: interview.scheduledStartAt,
  scheduledEndAt: interview.scheduledEndAt,
  timezone: interview.timezone,
  durationMinutes: interview.durationMinutes,
  interviewType: interview.interviewType,
  meetingLink: interview.meetingLink || '',
  location: interview.location || '',
  candidateInstructions: interview.candidateInstructions || '',
  ...(includeInternalNotes
    ? { internalNotes: interview.internalNotes || '' }
    : {}),
  interviewers: (interview.interviewers || []).map(safePerson),
  status: interview.status,
  cancellation: interview.cancellation?.cancelledAt
    ? {
        reason: interview.cancellation.reason || '',
        cancelledAt: interview.cancellation.cancelledAt,
        cancelledBy: safePerson(interview.cancellation.cancelledBy),
      }
    : null,
  rescheduleHistory: (interview.rescheduleHistory || []).map((entry) => ({
    id: entry._id,
    previousStartAt: entry.previousStartAt,
    previousEndAt: entry.previousEndAt,
    newStartAt: entry.newStartAt,
    newEndAt: entry.newEndAt,
    previousTimezone: entry.previousTimezone,
    newTimezone: entry.newTimezone,
    previousInterviewerIds: entry.previousInterviewers,
    newInterviewerIds: entry.newInterviewers,
    reason: entry.reason,
    changedBy: safePerson(entry.changedBy),
    changedAt: entry.changedAt,
  })),
  statusHistory: (interview.statusHistory || []).map((entry) => ({
    id: entry._id,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    reason: entry.reason || '',
    changedBy: safePerson(entry.changedBy),
    changedAt: entry.changedAt,
  })),
  createdBy: safePerson(interview.createdBy),
  updatedBy: safePerson(interview.updatedBy),
  createdAt: interview.createdAt,
  updatedAt: interview.updatedAt,
  feedback: {
    enabled: false,
    status: 'NOT_IMPLEMENTED',
  },
  capabilities: {
    canReschedule,
    canCancel,
    canSetStatus,
  },
  ...(includeDispatchMetadata
    ? {
        notificationDispatch: interview.notificationDispatch || null,
        reminderDispatch: interview.reminderDispatch || null,
      }
    : {}),
});

const validateInterviewers = async ({ companyId, interviewerIds }) => {
  const normalized = [...new Set(objectIdStrings(interviewerIds))];
  if (normalized.length !== interviewerIds.length) {
    throw ApiError.badRequest('Interviewer selection cannot contain duplicates');
  }
  if (normalized.length < 1 || normalized.length > 10) {
    throw ApiError.badRequest('Choose between 1 and 10 interviewers');
  }

  const users = await User.find({
    _id: { $in: normalized },
    companyId,
    status: 'ACTIVE',
    role: { $in: ASSIGNABLE_INTERVIEWER_ROLES },
  })
    .select('_id name email role status')
    .sort({ name: 1, _id: 1 })
    .lean();

  if (users.length !== normalized.length) {
    throw ApiError.badRequest(
      'Every interviewer must be an active user in this company'
    );
  }

  const userMap = new Map(users.map((user) => [String(user._id), user]));
  return normalized.map((id) => userMap.get(id));
};

const assertNoScheduleConflict = async ({
  companyId,
  candidateId,
  interviewerIds,
  scheduledStartAt,
  scheduledEndAt,
  excludeInterviewId = null,
}) => {
  const filter = {
    companyId,
    status: { $in: ACTIVE_INTERVIEW_STATUSES },
    scheduledStartAt: { $lt: scheduledEndAt },
    scheduledEndAt: { $gt: scheduledStartAt },
    $or: [
      { candidate: candidateId },
      { interviewers: { $in: interviewerIds } },
    ],
  };
  if (excludeInterviewId) filter._id = { $ne: excludeInterviewId };

  const conflict = await Interview.findOne(filter)
    .select('scheduledStartAt scheduledEndAt interviewers candidate -_id')
    .lean();
  if (!conflict) return;

  const selected = new Set(objectIdStrings(interviewerIds));
  const sharedInterviewerIds = objectIdStrings(conflict.interviewers).filter((id) =>
    selected.has(id)
  );
  throw new ApiError(409, 'The candidate or an interviewer has an overlapping interview', [
    {
      field: 'scheduledStartAt',
      message: 'Choose a non-overlapping time',
      conflictStartAt: conflict.scheduledStartAt,
      conflictEndAt: conflict.scheduledEndAt,
      sharedInterviewerIds,
      candidateConflict: String(conflict.candidate) === String(candidateId),
    },
  ]);
};

const recordInterviewCandidateEvent = ({
  companyId,
  candidate,
  actorId,
  action,
  interview,
  metadata = {},
}) =>
  CandidateHistory.create({
    companyId,
    candidate: candidate._id || candidate,
    job: candidate.job?._id || candidate.job,
    action,
    source: 'INTERVIEW',
    actorType: 'TENANT_USER',
    actor: actorId,
    metadata: {
      interviewId: interview._id,
      interviewCode: interview.interviewCode,
      roundKey: interview.round.key,
      roundName: interview.round.name,
      scheduledStartAt: interview.scheduledStartAt,
      scheduledEndAt: interview.scheduledEndAt,
      timezone: interview.timezone,
      status: interview.status,
      ...metadata,
    },
    eventAt: new Date(),
  });

const safeAuditSchedule = (interview) => ({
  interviewCode: interview.interviewCode,
  candidateId: interview.candidate?._id || interview.candidate,
  jobId: interview.job?._id || interview.job,
  roundKey: interview.round.key,
  roundSequence: interview.round.sequence,
  scheduledStartAt: interview.scheduledStartAt,
  scheduledEndAt: interview.scheduledEndAt,
  timezone: interview.timezone,
  interviewType: interview.interviewType,
  interviewerIds: objectIdStrings(interview.interviewers),
  status: interview.status,
});

const saveNotificationDispatch = async ({ companyId, interviewId, dispatch }) => {
  await Interview.updateOne(
    { _id: interviewId, companyId },
    { $set: { notificationDispatch: dispatch } }
  ).catch(() => {});
};

const notifyInterview = async ({
  event,
  company,
  interview,
  candidate,
  job,
  interviewers,
}) => {
  const dispatch = await dispatchInterviewNotification({
    event,
    companyId: company._id,
    companyName: company.name,
    interview,
    candidate,
    job,
    interviewers,
  });
  await saveNotificationDispatch({
    companyId: company._id,
    interviewId: interview._id,
    dispatch,
  });
};

const loadCompany = async (companyId) => {
  const company = await Company.findOne({ _id: companyId })
    .select('_id name timezone')
    .lean();
  if (!company) throw ApiError.notFound('Company not found');
  return company;
};

const loadInterviewForResponse = async ({ companyId, interviewId }) =>
  interviewPopulate(
    Interview.findOne({ _id: interviewId, companyId }).select('+internalNotes')
  ).lean();

const accessCapabilities = async ({ actor, interview }) => {
  const [canReadAll, canUpdateAll] = await Promise.all([
    hasPermission(actor, 'INTERVIEW_READ'),
    hasPermission(actor, 'INTERVIEW_UPDATE'),
  ]);
  const assigned = isAssigned(interview, actor._id);

  return {
    canReadAll,
    canUpdateAll,
    assigned,
    canSetStatus: canUpdateAll || assigned,
    canReschedule:
      canUpdateAll && ['SCHEDULED', 'RESCHEDULED'].includes(interview.status),
    canCancel:
      canUpdateAll && ACTIVE_INTERVIEW_STATUSES.includes(interview.status),
  };
};

export const getInterviewOptions = async ({ companyId }) => {
  const [company, interviewers] = await Promise.all([
    loadCompany(companyId),
    User.find({
      companyId,
      status: 'ACTIVE',
      role: { $in: ASSIGNABLE_INTERVIEWER_ROLES },
    })
      .select('_id name email role')
      .sort({ name: 1, _id: 1 })
      .lean(),
  ]);

  return {
    companyTimezone: company.timezone || 'Asia/Kolkata',
    rounds: interviewRoundOptions(),
    interviewTypes: INTERVIEW_TYPES,
    statuses: INTERVIEW_STATUSES,
    interviewers: interviewers.map((user) => ({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    })),
  };
};

export const scheduleInterview = async ({
  companyId,
  actor,
  input,
  requestContext,
}) => {
  const company = await loadCompany(companyId);
  const schedule = interviewWallClockToUtc({
    date: input.date,
    time: input.time,
    timezone: input.timezone || company.timezone,
    durationMinutes: input.durationMinutes,
  });
  if (schedule.scheduledStartAt.getTime() <= Date.now()) {
    throw ApiError.badRequest('Interview start time must be in the future');
  }
  validateChannel(input);

  const candidate = await Candidate.findOne({
    _id: input.candidateId,
    companyId,
  })
    .select(
      '_id candidateCode name email phone job requisition currentStage stage status'
    )
    .lean();
  if (!candidate) throw ApiError.notFound('Candidate not found');
  if (candidate.status !== 'ACTIVE') {
    throw ApiError.conflict('Only active candidates can be scheduled');
  }
  const currentStage = candidate.currentStage || candidate.stage;
  if (!SCHEDULABLE_CANDIDATE_STAGES.includes(currentStage)) {
    throw ApiError.conflict(
      'Interview scheduling begins after the candidate is shortlisted'
    );
  }

  const job = await JobPosting.findOne({
    _id: candidate.job,
    companyId,
  })
    .select('_id jobCode title sourceRequisition status')
    .lean();
  if (!job) {
    throw ApiError.conflict('Candidate job is unavailable in this company');
  }

  const requisitionId = candidate.requisition || job.sourceRequisition || null;
  if (requisitionId) {
    const requisitionExists = await JobRequisition.exists({
      _id: requisitionId,
      companyId,
    });
    if (!requisitionExists) {
      throw ApiError.conflict('Candidate requisition is unavailable in this company');
    }
  }

  const round = resolveInterviewRound(input);
  if (input.updateCandidateStage && !round.targetStage) {
    throw ApiError.badRequest(
      'Automatic pipeline movement is available only for configured interview rounds'
    );
  }
  const interviewerUsers = await validateInterviewers({
    companyId,
    interviewerIds: input.interviewerIds,
  });
  const interviewerIds = interviewerUsers.map((user) => user._id);

  const scheduleLockToken = await acquireScheduleLock(companyId);
  let interviewCode;
  let interview;
  let timelineEvent;
  try {
    await assertNoScheduleConflict({
      companyId,
      candidateId: candidate._id,
      interviewerIds,
      ...schedule,
    });

    interviewCode = await nextInterviewCode(companyId);
    const now = new Date();
    try {
      interview = await Interview.create({
        companyId,
        interviewCode,
        candidate: candidate._id,
        job: job._id,
        requisition: requisitionId,
        round: round.snapshot,
        activeRoundKey: round.snapshot.key,
        ...schedule,
        interviewType: input.interviewType,
        meetingLink: String(input.meetingLink || '').trim(),
        location: String(input.location || '').trim(),
        candidateInstructions: String(input.candidateInstructions || '').trim(),
        internalNotes: String(input.internalNotes || '').trim(),
        interviewers: interviewerIds,
        status: 'SCHEDULED',
        statusHistory: [
          {
            fromStatus: null,
            toStatus: 'SCHEDULED',
            reason: 'Interview scheduled',
            changedBy: actor._id,
            changedAt: now,
          },
        ],
        reminderDispatch: {
          state: 'PENDING',
          dispatchAfter: reminderDispatchAfter(schedule.scheduledStartAt),
        },
        createdBy: actor._id,
        updatedBy: actor._id,
      });
    } catch (error) {
      if (
        error.code === 11000 &&
        (error.keyPattern?.activeRoundKey || error.keyValue?.activeRoundKey)
      ) {
        throw ApiError.conflict(
          'An active interview already exists for this candidate and round'
        );
      }
      throw error;
    }

    try {
      timelineEvent = await recordInterviewCandidateEvent({
        companyId,
        candidate,
        actorId: actor._id,
        action: 'INTERVIEW_SCHEDULED',
        interview,
      });
    } catch {
      await Interview.deleteOne({
        _id: interview._id,
        companyId,
        status: 'SCHEDULED',
      }).catch(() => {});
      throw new ApiError(
        500,
        'Interview history could not be secured, so scheduling was not completed'
      );
    }
  } finally {
    await releaseScheduleLock({ companyId, ownerToken: scheduleLockToken });
  }

  let stageTransition = { requested: Boolean(input.updateCandidateStage), changed: false };
  if (input.updateCandidateStage) {
    try {
      const transition = await transitionCandidateStage({
        companyId,
        candidateId: candidate._id,
        targetStage: round.targetStage,
        reason: `Interview ${interviewCode} scheduled for ${round.snapshot.name}`,
        actorId: actor._id,
        metadata: {
          source: 'PIPELINE',
          action: 'INTERVIEW_SCHEDULED',
          bulk: false,
        },
      });
      stageTransition = {
        requested: true,
        changed: true,
        fromStage: transition.fromStage,
        toStage: transition.toStage,
      };
    } catch (error) {
      stageTransition = {
        requested: true,
        changed: false,
        warning:
          error.statusCode >= 400 && error.statusCode < 500
            ? String(error.message).slice(0, 300)
            : 'The interview was scheduled, but the pipeline stage was not changed',
      };
    }
  }

  const auditInterview = {
    ...interview.toObject(),
    candidate: candidate._id,
    job: job._id,
  };
  await recordAudit({
    req: requestContext,
    action: 'INTERVIEW_SCHEDULED',
    companyId,
    actorId: actor._id,
    resource: 'Interview',
    resourceId: interview._id,
    newValue: safeAuditSchedule(auditInterview),
    metadata: { candidateHistoryId: timelineEvent._id },
    statusCode: 201,
    critical: true,
  });
  await recordAudit({
    req: requestContext,
    action: 'INTERVIEWER_ASSIGNED',
    companyId,
    actorId: actor._id,
    resource: 'Interview',
    resourceId: interview._id,
    newValue: { interviewerIds: objectIdStrings(interviewerIds) },
    statusCode: 201,
    critical: true,
  });

  await notifyInterview({
    event: 'SCHEDULED',
    company,
    interview: { ...interview.toObject(), internalNotes: input.internalNotes || '' },
    candidate,
    job,
    interviewers: interviewerUsers,
  });

  const populated = await loadInterviewForResponse({
    companyId,
    interviewId: interview._id,
  });
  return {
    interview: safeInterviewDto(populated, {
      includeInternalNotes: true,
      includeDispatchMetadata: true,
      canReschedule: true,
      canCancel: true,
      canSetStatus: true,
    }),
    stageTransition,
  };
};

const buildInterviewListFilter = async ({ companyId, query, actorId = null }) => {
  const filter = { companyId };
  if (actorId) filter.interviewers = actorId;
  if (query.status) filter.status = query.status;
  if (query.job) filter.job = query.job;
  if (query.interviewer && !actorId) filter.interviewers = query.interviewer;
  if (query.roundKey) filter['round.key'] = String(query.roundKey).toUpperCase();

  if (query.view === 'upcoming') {
    filter.scheduledEndAt = { $gte: new Date() };
  } else if (query.view === 'past') {
    filter.scheduledEndAt = { $lt: new Date() };
  }

  if (query.dateFrom || query.dateTo) {
    const company = await loadCompany(companyId);
    filter.scheduledStartAt = {};
    if (query.dateFrom) {
      filter.scheduledStartAt.$gte = companyDayUtcRange({
        date: query.dateFrom,
        timezone: company.timezone,
      }).start;
    }
    if (query.dateTo) {
      filter.scheduledStartAt.$lt = companyDayUtcRange({
        date: query.dateTo,
        timezone: company.timezone,
      }).end;
    }
  }

  if (query.search?.trim()) {
    const search = new RegExp(escapeRegex(query.search.trim()), 'i');
    const [candidateIds, jobIds] = await Promise.all([
      Candidate.find({
        companyId,
        $or: [
          { candidateCode: search },
          { name: search },
          { email: search },
        ],
      }).distinct('_id'),
      JobPosting.find({
        companyId,
        $or: [{ jobCode: search }, { title: search }],
      }).distinct('_id'),
    ]);
    filter.$or = [
      { interviewCode: search },
      { candidate: { $in: candidateIds } },
      { job: { $in: jobIds } },
    ];
  }

  return filter;
};

const listInterviewRecords = async ({ companyId, query, actorId = null }) => {
  const { page, limit } = paginationValues(query);
  const filter = await buildInterviewListFilter({ companyId, query, actorId });
  const ascending = query.view === 'upcoming';
  const [interviews, total] = await Promise.all([
    interviewPopulate(
      Interview.find(filter).select(actorId ? '+internalNotes' : '')
    )
      .sort({ scheduledStartAt: ascending ? 1 : -1, _id: ascending ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Interview.countDocuments(filter),
  ]);

  return {
    interviews,
    meta: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

const interviewKpis = async ({ companyId, actorId = null }) => {
  const company = await loadCompany(companyId);
  const today = companyDayUtcRange({ timezone: company.timezone });
  const base = { companyId, ...(actorId ? { interviewers: actorId } : {}) };
  const [todayCount, inProgress, completed, upcoming] = await Promise.all([
    Interview.countDocuments({
      ...base,
      scheduledStartAt: { $gte: today.start, $lt: today.end },
      status: { $ne: 'CANCELLED' },
    }),
    Interview.countDocuments({ ...base, status: 'IN_PROGRESS' }),
    Interview.countDocuments({ ...base, status: 'COMPLETED' }),
    Interview.countDocuments({
      ...base,
      scheduledEndAt: { $gte: new Date() },
      status: { $in: ACTIVE_INTERVIEW_STATUSES },
    }),
  ]);

  return {
    today: todayCount,
    inProgress,
    completed,
    upcoming,
    feedbackPending: 0,
    feedbackEnabled: false,
  };
};

export const listInterviews = async ({ companyId, query = {} }) => {
  const [records, kpis] = await Promise.all([
    listInterviewRecords({ companyId, query }),
    interviewKpis({ companyId }),
  ]);
  return {
    interviews: records.interviews.map((interview) =>
      safeInterviewDto(interview, {
        canReschedule: ['SCHEDULED', 'RESCHEDULED'].includes(interview.status),
        canCancel: ACTIVE_INTERVIEW_STATUSES.includes(interview.status),
        canSetStatus: ACTIVE_INTERVIEW_STATUSES.includes(interview.status),
      })
    ),
    meta: records.meta,
    kpis,
  };
};

export const listMyInterviews = async ({ companyId, actor, query = {} }) => {
  const [records, kpis] = await Promise.all([
    listInterviewRecords({ companyId, query, actorId: actor._id }),
    interviewKpis({ companyId, actorId: actor._id }),
  ]);
  return {
    interviews: records.interviews.map((interview) =>
      safeInterviewDto(interview, {
        includeInternalNotes: true,
        canSetStatus: ACTIVE_INTERVIEW_STATUSES.includes(interview.status),
      })
    ),
    meta: records.meta,
    kpis,
  };
};

export const getCandidateInterviews = async ({ companyId, candidateRef }) => {
  const candidate = await Candidate.findOne({
    companyId,
    ...candidateReferenceFilter(candidateRef),
  })
    .select('_id job')
    .lean();
  if (!candidate) throw ApiError.notFound('Candidate not found');

  const interviews = await interviewPopulate(
    Interview.find({
      companyId,
      candidate: candidate._id,
      job: candidate.job,
    })
  )
    .sort({ 'round.sequence': 1, scheduledStartAt: 1 })
    .lean();

  return interviews.map((interview) =>
    safeInterviewDto(interview, {
      canReschedule: ['SCHEDULED', 'RESCHEDULED'].includes(interview.status),
      canCancel: ACTIVE_INTERVIEW_STATUSES.includes(interview.status),
      canSetStatus: ACTIVE_INTERVIEW_STATUSES.includes(interview.status),
    })
  );
};

export const getInterviewDetail = async ({ companyId, interviewId, actor }) => {
  const interview = await loadInterviewForResponse({ companyId, interviewId });
  if (!interview) throw ApiError.notFound('Interview not found');
  const access = await accessCapabilities({ actor, interview });
  if (!access.canReadAll && !access.assigned) {
    throw ApiError.forbidden('This interview is not assigned to you');
  }

  return safeInterviewDto(interview, {
    includeInternalNotes: access.canReadAll || access.assigned,
    includeDispatchMetadata: access.canReadAll,
    canReschedule: access.canReschedule,
    canCancel: access.canCancel,
    canSetStatus: access.canSetStatus && ACTIVE_INTERVIEW_STATUSES.includes(interview.status),
  });
};

export const rescheduleInterview = async ({
  companyId,
  interviewId,
  actor,
  input,
  requestContext,
}) => {
  const [company, current] = await Promise.all([
    loadCompany(companyId),
    Interview.findOne({ _id: interviewId, companyId })
      .select('+internalNotes')
      .lean(),
  ]);
  if (!current) throw ApiError.notFound('Interview not found');
  if (!['SCHEDULED', 'RESCHEDULED'].includes(current.status)) {
    throw ApiError.conflict('Only scheduled interviews can be rescheduled');
  }

  const schedule = interviewWallClockToUtc(input);
  if (schedule.scheduledStartAt.getTime() <= Date.now()) {
    throw ApiError.badRequest('Interview start time must be in the future');
  }
  const interviewType = current.interviewType;
  const meetingLink = String(input.meetingLink ?? current.meetingLink ?? '').trim();
  const location = String(input.location ?? current.location ?? '').trim();
  validateChannel({ interviewType, meetingLink, location });
  const interviewerUsers = await validateInterviewers({
    companyId,
    interviewerIds: input.interviewerIds,
  });
  const interviewerIds = interviewerUsers.map((user) => user._id);
  const [candidate, job] = await Promise.all([
    Candidate.findOne({
      _id: current.candidate,
      companyId,
      job: current.job,
    })
      .select('_id candidateCode name email phone job')
      .lean(),
    JobPosting.findOne({ _id: current.job, companyId })
      .select('_id jobCode title')
      .lean(),
  ]);
  if (!candidate || !job) {
    throw ApiError.conflict('Interview candidate or job is no longer available');
  }

  const changedAt = new Date();
  const reason = String(input.reason || '').trim();
  const scheduleLockToken = await acquireScheduleLock(companyId);
  let updated;
  let timelineEvent;
  try {
    await assertNoScheduleConflict({
      companyId,
      candidateId: current.candidate,
      interviewerIds,
      ...schedule,
      excludeInterviewId: current._id,
    });

    updated = await Interview.findOneAndUpdate(
      {
        _id: current._id,
        companyId,
        status: current.status,
        scheduledStartAt: current.scheduledStartAt,
        scheduledEndAt: current.scheduledEndAt,
      },
      {
        $set: {
          ...schedule,
          meetingLink,
          location,
          interviewers: interviewerIds,
          status: 'RESCHEDULED',
          updatedBy: actor._id,
          notificationDispatch: {
            lastEvent: '',
            lastAttemptAt: null,
            candidate: { state: 'NOT_REQUESTED', mode: '' },
            interviewers: [],
          },
          reminderDispatch: {
            state: 'PENDING',
            dispatchAfter: reminderDispatchAfter(schedule.scheduledStartAt),
            claimedAt: null,
            dispatchedAt: null,
            attempts: 0,
            lastError: '',
          },
        },
        $push: {
          rescheduleHistory: {
            previousStartAt: current.scheduledStartAt,
            previousEndAt: current.scheduledEndAt,
            newStartAt: schedule.scheduledStartAt,
            newEndAt: schedule.scheduledEndAt,
            previousTimezone: current.timezone,
            newTimezone: schedule.timezone,
            previousInterviewers: current.interviewers,
            newInterviewers: interviewerIds,
            reason,
            changedBy: actor._id,
            changedAt,
          },
          statusHistory: {
            fromStatus: current.status,
            toStatus: 'RESCHEDULED',
            reason,
            changedBy: actor._id,
            changedAt,
          },
        },
      },
      { returnDocument: 'after', runValidators: true }
    )
      .select('+internalNotes')
      .lean();
    if (!updated) {
      throw ApiError.conflict(
        'Interview schedule changed in another request. Refresh and try again.'
      );
    }

    try {
      timelineEvent = await recordInterviewCandidateEvent({
        companyId,
        candidate,
        actorId: actor._id,
        action: 'INTERVIEW_RESCHEDULED',
        interview: updated,
        metadata: {
          previousScheduledStartAt: current.scheduledStartAt,
          previousScheduledEndAt: current.scheduledEndAt,
        },
      });
    } catch {
      await Interview.updateOne(
        {
          _id: current._id,
          companyId,
          scheduledStartAt: updated.scheduledStartAt,
          scheduledEndAt: updated.scheduledEndAt,
        },
        {
          $set: {
            scheduledStartAt: current.scheduledStartAt,
            scheduledEndAt: current.scheduledEndAt,
            timezone: current.timezone,
            durationMinutes: current.durationMinutes,
            meetingLink: current.meetingLink,
            location: current.location,
            interviewers: current.interviewers,
            status: current.status,
            updatedBy: current.updatedBy,
            notificationDispatch: current.notificationDispatch,
            reminderDispatch: current.reminderDispatch,
          },
          $pop: { rescheduleHistory: 1, statusHistory: 1 },
        }
      ).catch(() => {});
      throw new ApiError(
        500,
        'Interview history could not be secured, so rescheduling was not completed'
      );
    }
  } finally {
    await releaseScheduleLock({ companyId, ownerToken: scheduleLockToken });
  }

  await recordAudit({
    req: requestContext,
    action: 'INTERVIEW_RESCHEDULED',
    companyId,
    actorId: actor._id,
    resource: 'Interview',
    resourceId: current._id,
    previousValue: safeAuditSchedule(current),
    newValue: safeAuditSchedule(updated),
    metadata: { candidateHistoryId: timelineEvent._id },
    statusCode: 200,
    critical: true,
  });
  if (!sameIds(current.interviewers, interviewerIds)) {
    await recordAudit({
      req: requestContext,
      action: 'INTERVIEWER_ASSIGNED',
      companyId,
      actorId: actor._id,
      resource: 'Interview',
      resourceId: current._id,
      previousValue: { interviewerIds: objectIdStrings(current.interviewers) },
      newValue: { interviewerIds: objectIdStrings(interviewerIds) },
      statusCode: 200,
      critical: true,
    });
  }

  await notifyInterview({
    event: 'RESCHEDULED',
    company,
    interview: updated,
    candidate,
    job,
    interviewers: interviewerUsers,
  });

  const populated = await loadInterviewForResponse({ companyId, interviewId });
  return safeInterviewDto(populated, {
    includeInternalNotes: true,
    includeDispatchMetadata: true,
    canReschedule: true,
    canCancel: true,
    canSetStatus: true,
  });
};

export const cancelInterview = async ({
  companyId,
  interviewId,
  actor,
  reason,
  requestContext,
}) => {
  const [company, current] = await Promise.all([
    loadCompany(companyId),
    Interview.findOne({ _id: interviewId, companyId })
      .select('+internalNotes')
      .lean(),
  ]);
  if (!current) throw ApiError.notFound('Interview not found');
  if (!ACTIVE_INTERVIEW_STATUSES.includes(current.status)) {
    throw ApiError.conflict('This interview can no longer be cancelled');
  }
  const changedAt = new Date();
  const cancellationReason = String(reason || '').trim();
  const updated = await Interview.findOneAndUpdate(
    { _id: current._id, companyId, status: current.status },
    {
      $set: {
        status: 'CANCELLED',
        activeRoundKey: null,
        cancellation: {
          reason: cancellationReason,
          cancelledBy: actor._id,
          cancelledAt: changedAt,
        },
        reminderDispatch: {
          state: 'CANCELLED',
          dispatchAfter: current.reminderDispatch?.dispatchAfter || null,
          claimedAt: null,
          dispatchedAt: null,
          attempts: current.reminderDispatch?.attempts || 0,
          lastError: '',
        },
        updatedBy: actor._id,
      },
      $push: {
        statusHistory: {
          fromStatus: current.status,
          toStatus: 'CANCELLED',
          reason: cancellationReason,
          changedBy: actor._id,
          changedAt,
        },
      },
    },
    { returnDocument: 'after', runValidators: true }
  )
    .select('+internalNotes')
    .lean();
  if (!updated) {
    throw ApiError.conflict('Interview changed in another request. Refresh and try again.');
  }

  const [candidate, job, interviewerUsers] = await Promise.all([
    Candidate.findOne({ _id: current.candidate, companyId, job: current.job })
      .select('_id candidateCode name email phone job')
      .lean(),
    JobPosting.findOne({ _id: current.job, companyId })
      .select('_id jobCode title')
      .lean(),
    User.find({ _id: { $in: current.interviewers }, companyId, status: 'ACTIVE' })
      .select('_id name email role')
      .lean(),
  ]);
  if (!candidate || !job) {
    throw ApiError.conflict('Interview candidate or job is no longer available');
  }

  let timelineEvent;
  try {
    timelineEvent = await recordInterviewCandidateEvent({
      companyId,
      candidate,
      actorId: actor._id,
      action: 'INTERVIEW_CANCELLED',
      interview: updated,
    });
  } catch {
    await Interview.updateOne(
      { _id: current._id, companyId, status: 'CANCELLED' },
      {
        $set: {
          status: current.status,
          activeRoundKey: current.activeRoundKey,
          cancellation: current.cancellation,
          reminderDispatch: current.reminderDispatch,
          updatedBy: current.updatedBy,
        },
        $pop: { statusHistory: 1 },
      }
    ).catch(() => {});
    throw new ApiError(
      500,
      'Interview history could not be secured, so cancellation was not completed'
    );
  }

  await recordAudit({
    req: requestContext,
    action: 'INTERVIEW_CANCELLED',
    companyId,
    actorId: actor._id,
    resource: 'Interview',
    resourceId: current._id,
    previousValue: { status: current.status },
    newValue: { status: 'CANCELLED' },
    metadata: {
      reason: cancellationReason,
      candidateHistoryId: timelineEvent._id,
    },
    statusCode: 200,
    critical: true,
  });
  await notifyInterview({
    event: 'CANCELLED',
    company,
    interview: updated,
    candidate,
    job,
    interviewers: interviewerUsers,
  });

  const populated = await loadInterviewForResponse({ companyId, interviewId });
  return safeInterviewDto(populated, {
    includeInternalNotes: true,
    includeDispatchMetadata: true,
  });
};

export const updateInterviewStatus = async ({
  companyId,
  interviewId,
  actor,
  targetStatus,
  reason = '',
  requestContext,
}) => {
  const current = await Interview.findOne({ _id: interviewId, companyId })
    .select('+internalNotes')
    .lean();
  if (!current) throw ApiError.notFound('Interview not found');

  const canUpdateAll = await hasPermission(actor, 'INTERVIEW_UPDATE');
  if (!canUpdateAll && !isAssigned(current, actor._id)) {
    throw ApiError.forbidden('This interview is not assigned to you');
  }
  if (!(STATUS_TRANSITIONS[current.status] || []).includes(targetStatus)) {
    throw ApiError.conflict(
      `Interview cannot move from ${current.status} to ${targetStatus}`
    );
  }
  const statusReason = String(reason || '').trim();
  if (targetStatus === 'NO_SHOW' && !statusReason) {
    throw ApiError.badRequest('A reason is required when marking a no-show');
  }

  const changedAt = new Date();
  const terminal = ['COMPLETED', 'NO_SHOW'].includes(targetStatus);
  const updated = await Interview.findOneAndUpdate(
    { _id: current._id, companyId, status: current.status },
    {
      $set: {
        status: targetStatus,
        ...(terminal ? { activeRoundKey: null } : {}),
        ...(terminal
          ? {
              reminderDispatch: {
                state: 'NOT_REQUIRED',
                dispatchAfter: current.reminderDispatch?.dispatchAfter || null,
                claimedAt: null,
                dispatchedAt: current.reminderDispatch?.dispatchedAt || null,
                attempts: current.reminderDispatch?.attempts || 0,
                lastError: '',
              },
            }
          : {}),
        updatedBy: actor._id,
      },
      $push: {
        statusHistory: {
          fromStatus: current.status,
          toStatus: targetStatus,
          reason: statusReason,
          changedBy: actor._id,
          changedAt,
        },
      },
    },
    { returnDocument: 'after', runValidators: true }
  )
    .select('+internalNotes')
    .lean();
  if (!updated) {
    throw ApiError.conflict('Interview changed in another request. Refresh and try again.');
  }

  const [company, candidate, job, interviewerUsers] = await Promise.all([
    loadCompany(companyId),
    Candidate.findOne({ _id: current.candidate, companyId, job: current.job })
      .select('_id candidateCode name email phone job')
      .lean(),
    JobPosting.findOne({ _id: current.job, companyId })
      .select('_id jobCode title')
      .lean(),
    User.find({ _id: { $in: current.interviewers }, companyId, status: 'ACTIVE' })
      .select('_id name email role')
      .lean(),
  ]);
  if (!candidate || !job) {
    throw ApiError.conflict('Interview candidate or job is no longer available');
  }

  const action = STATUS_EVENT_ACTION[targetStatus];
  let timelineEvent;
  try {
    timelineEvent = await recordInterviewCandidateEvent({
      companyId,
      candidate,
      actorId: actor._id,
      action,
      interview: updated,
    });
  } catch {
    await Interview.updateOne(
      { _id: current._id, companyId, status: targetStatus },
      {
        $set: {
          status: current.status,
          activeRoundKey: current.activeRoundKey,
          reminderDispatch: current.reminderDispatch,
          updatedBy: current.updatedBy,
        },
        $pop: { statusHistory: 1 },
      }
    ).catch(() => {});
    throw new ApiError(
      500,
      'Interview history could not be secured, so the status was not changed'
    );
  }

  await recordAudit({
    req: requestContext,
    action: 'INTERVIEW_STATUS_CHANGED',
    companyId,
    actorId: actor._id,
    resource: 'Interview',
    resourceId: current._id,
    previousValue: { status: current.status },
    newValue: { status: targetStatus },
    metadata: {
      eventAction: action,
      reason: statusReason,
      candidateHistoryId: timelineEvent._id,
      operationalOnly: targetStatus === 'COMPLETED',
    },
    statusCode: 200,
    critical: true,
  });
  await notifyInterview({
    event: targetStatus,
    company,
    interview: updated,
    candidate,
    job,
    interviewers: interviewerUsers,
  });

  const populated = await loadInterviewForResponse({ companyId, interviewId });
  const access = await accessCapabilities({ actor, interview: populated });
  return safeInterviewDto(populated, {
    includeInternalNotes: true,
    includeDispatchMetadata: access.canReadAll,
    canReschedule: access.canReschedule,
    canCancel: access.canCancel,
    canSetStatus:
      access.canSetStatus && ACTIVE_INTERVIEW_STATUSES.includes(populated.status),
  });
};
