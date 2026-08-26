import mongoose from 'mongoose';
import ATSResult from '../models/ATSResult.js';
import Candidate from '../models/Candidate.js';
import CandidateEmployeeConversion from '../models/CandidateEmployeeConversion.js';
import CandidatePipelineHistory from '../models/CandidatePipelineHistory.js';
import Department from '../models/Department.js';
import Interview from '../models/Interview.js';
import InterviewFeedback from '../models/InterviewFeedback.js';
import JobPosting from '../models/JobPosting.js';
import JobRequisition from '../models/JobRequisition.js';
import OfferLetter from '../models/OfferLetter.js';
import PreOnboarding from '../models/PreOnboarding.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);
const oid = (value) => new mongoose.Types.ObjectId(String(value));

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_PRESETS = {
  LAST_7_DAYS: 7,
  LAST_30_DAYS: 30,
  LAST_90_DAYS: 90,
};

/**
 * Metric definitions (authoritative for Phase 27.14):
 *
 * TIME TO HIRE  = offer.acceptedAt − candidate.applicationDate  (days)
 * TIME TO FILL  = offer.acceptedAt − requisition.review.decidedAt (when APPROVED)
 *                 fallback: offer.acceptedAt − job.publishedAt
 * FUNNEL        = distinct candidates that ever reached a milestone stage
 *                 (from CandidatePipelineHistory.toStage), not only currentStage
 * JOINED        = pipeline stage JOINED or completed CandidateEmployeeConversion
 * READY_TO_JOIN = PreOnboarding.status READY_TO_JOIN (current, not period event)
 * OFFER ACCEPT  = accepted / sent  (withdrawn/expired/rejected shown separately)
 */

const parseDateRange = (query = {}) => {
  const now = new Date();
  let to = query.to ? new Date(query.to) : now;
  let from = query.from ? new Date(query.from) : null;

  const preset = String(query.range || query.preset || 'LAST_30_DAYS').toUpperCase();
  if (!from) {
    if (preset === 'THIS_MONTH') {
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    } else if (preset === 'THIS_QUARTER') {
      const q = Math.floor(now.getUTCMonth() / 3) * 3;
      from = new Date(Date.UTC(now.getUTCFullYear(), q, 1));
    } else if (preset === 'THIS_YEAR') {
      from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    } else {
      const days = RANGE_PRESETS[preset] || 30;
      from = new Date(now.getTime() - days * DAY_MS);
    }
  }

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw ApiError.badRequest('Choose a valid date range');
  }
  if (from > to) throw ApiError.badRequest('from must be before to');

  // Cap range at 400 days to protect aggregation cost.
  if (to.getTime() - from.getTime() > 400 * DAY_MS) {
    from = new Date(to.getTime() - 400 * DAY_MS);
  }

  return { from, to, preset };
};

const rate = (numerator, denominator) => {
  if (!denominator) return null;
  return Math.round((Number(numerator) / Number(denominator)) * 1000) / 10;
};

const median = (values = []) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
  }
  return Math.round(sorted[mid] * 10) / 10;
};

const average = (values = []) => {
  if (!values.length) return null;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return Math.round((sum / values.length) * 10) / 10;
};

const resolveScopedFilters = async ({ companyId, query = {} }) => {
  const companyObjectId = oid(companyId);
  const filters = { companyId: companyObjectId };
  const notes = [];

  if (query.jobId) {
    if (!isObjectId(query.jobId)) throw ApiError.badRequest('Choose a valid job');
    const job = await JobPosting.findOne({
      _id: query.jobId,
      companyId,
    })
      .select('_id')
      .lean();
    if (!job) throw ApiError.notFound('Job not found');
    filters.jobId = oid(query.jobId);
  }

  if (query.departmentId) {
    if (!isObjectId(query.departmentId)) {
      throw ApiError.badRequest('Choose a valid department');
    }
    const department = await Department.findOne({
      _id: query.departmentId,
      companyId,
    })
      .select('_id')
      .lean();
    if (!department) throw ApiError.notFound('Department not found');
    filters.departmentId = oid(query.departmentId);
  }

  if (query.recruiterId) {
    if (!isObjectId(query.recruiterId)) {
      throw ApiError.badRequest('Choose a valid recruiter');
    }
    const recruiter = await User.findOne({
      _id: query.recruiterId,
      companyId,
      status: 'ACTIVE',
    })
      .select('_id')
      .lean();
    if (!recruiter) throw ApiError.notFound('Recruiter not found');
    filters.recruiterId = oid(query.recruiterId);
  }

  if (query.hiringManagerId) {
    if (!isObjectId(query.hiringManagerId)) {
      throw ApiError.badRequest('Choose a valid hiring manager');
    }
    const manager = await User.findOne({
      _id: query.hiringManagerId,
      companyId,
      status: 'ACTIVE',
    })
      .select('_id')
      .lean();
    if (!manager) throw ApiError.notFound('Hiring manager not found');
    filters.hiringManagerId = oid(query.hiringManagerId);
  }

  if (query.source) {
    const source = String(query.source).toUpperCase();
    if (!['INTERNAL', 'CAREER_PAGE'].includes(source)) {
      throw ApiError.badRequest('Choose a valid candidate source');
    }
    filters.source = source;
  }

  return { filters, notes, companyObjectId };
};

const candidateMatch = (filters, { from, to } = {}) => {
  const match = { companyId: filters.companyId };
  if (filters.jobId) match.job = filters.jobId;
  if (filters.recruiterId) match.assignedRecruiter = filters.recruiterId;
  if (filters.hiringManagerId) match.hiringManager = filters.hiringManagerId;
  if (filters.source) match.source = filters.source;
  if (from && to) match.applicationDate = { $gte: from, $lte: to };
  return match;
};

const startOfUtcDay = (date) => {
  const value = new Date(date);
  value.setUTCHours(0, 0, 0, 0);
  return value;
};

const endOfUtcDay = (date) => {
  const value = new Date(date);
  value.setUTCHours(23, 59, 59, 999);
  return value;
};

export const getRecruitmentAnalyticsOverview = async ({
  companyId,
  query = {},
}) => {
  const range = parseDateRange(query);
  const { filters, notes, companyObjectId } = await resolveScopedFilters({
    companyId,
    query,
  });

  const from = range.from;
  const to = range.to;
  const todayStart = startOfUtcDay(new Date());
  const todayEnd = endOfUtcDay(new Date());

  // Department filter applies through jobs when candidate/job filter not set.
  let departmentJobIds = null;
  if (filters.departmentId) {
    departmentJobIds = await JobPosting.find({
      companyId,
      department: filters.departmentId,
      ...(filters.jobId ? { _id: filters.jobId } : {}),
    })
      .select('_id')
      .lean()
      .then((rows) => rows.map((row) => row._id));
  }

  const scopedJobMatch = {
    companyId: companyObjectId,
    ...(filters.jobId ? { _id: filters.jobId } : {}),
    ...(filters.departmentId ? { department: filters.departmentId } : {}),
  };

  const candidateBase = candidateMatch(filters);
  if (departmentJobIds) {
    candidateBase.job = { $in: departmentJobIds };
  }
  const candidateInPeriod = {
    ...candidateBase,
    applicationDate: { $gte: from, $lte: to },
  };

  const [
    pendingRequisitions,
    openJobs,
    applications,
    atsScreened,
    currentlyShortlisted,
    interviewsInPeriod,
    interviewsToday,
    selectedCurrent,
    offersSent,
    offersAccepted,
    offerStatusBreakdown,
    readyToJoin,
    joinedConversions,
    currentlyJoined,
    feedbackPending,
    offersPendingApproval,
    offersAwaitingCandidate,
    docsAwaitingVerification,
    requisitionsAwaitingApproval,
    preOnboardingBreakdown,
    atsCategoryRows,
    sourceApplicationRows,
    departmentRows,
    jobRows,
    funnelHistoryRows,
    timeToHireRows,
    applicationTrendRows,
    offerTrendRows,
    hireTrendRows,
    filterOptions,
  ] = await Promise.all([
    JobRequisition.countDocuments({
      companyId,
      status: { $in: ['SUBMITTED', 'PENDING_HR'] },
      ...(filters.departmentId ? { department: filters.departmentId } : {}),
    }),
    JobPosting.countDocuments({
      ...scopedJobMatch,
      status: 'OPEN',
    }),
    Candidate.countDocuments(candidateInPeriod),
    ATSResult.countDocuments({
      companyId: companyObjectId,
      ...(filters.jobId ? { job: filters.jobId } : {}),
      createdAt: { $gte: from, $lte: to },
      overallScore: { $gte: 0 },
    }),
    Candidate.countDocuments({
      ...candidateBase,
      currentStage: 'SHORTLISTED',
    }),
    Interview.countDocuments({
      companyId: companyObjectId,
      ...(filters.jobId ? { job: filters.jobId } : {}),
      scheduledStartAt: { $gte: from, $lte: to },
    }),
    Interview.countDocuments({
      companyId: companyObjectId,
      ...(filters.jobId ? { job: filters.jobId } : {}),
      scheduledStartAt: { $gte: todayStart, $lte: todayEnd },
      status: { $in: ['SCHEDULED', 'RESCHEDULED', 'IN_PROGRESS'] },
    }),
    Candidate.countDocuments({
      ...candidateBase,
      currentStage: 'SELECTED',
    }),
    OfferLetter.countDocuments({
      companyId: companyObjectId,
      ...(filters.jobId ? { job: filters.jobId } : {}),
      'delivery.sentAt': { $gte: from, $lte: to },
    }),
    OfferLetter.countDocuments({
      companyId: companyObjectId,
      ...(filters.jobId ? { job: filters.jobId } : {}),
      status: 'ACCEPTED',
      acceptedAt: { $gte: from, $lte: to },
    }),
    OfferLetter.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          ...(filters.jobId ? { job: filters.jobId } : {}),
          createdAt: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    PreOnboarding.countDocuments({
      companyId,
      status: 'READY_TO_JOIN',
      ...(filters.jobId ? { job: filters.jobId } : {}),
    }),
    CandidateEmployeeConversion.countDocuments({
      companyId,
      status: 'COMPLETED',
      convertedAt: { $gte: from, $lte: to },
    }),
    Candidate.countDocuments({
      ...candidateBase,
      currentStage: 'JOINED',
    }),
    InterviewFeedback.countDocuments({
      companyId: companyObjectId,
      status: 'DRAFT',
    }),
    OfferLetter.countDocuments({
      companyId,
      status: 'PENDING_APPROVAL',
      ...(filters.jobId ? { job: filters.jobId } : {}),
    }),
    OfferLetter.countDocuments({
      companyId,
      status: { $in: ['SENT', 'VIEWED'] },
      ...(filters.jobId ? { job: filters.jobId } : {}),
    }),
    PreOnboarding.countDocuments({
      companyId,
      status: { $in: ['UNDER_REVIEW', 'ACTION_REQUIRED', 'IN_PROGRESS'] },
      ...(filters.jobId ? { job: filters.jobId } : {}),
    }),
    JobRequisition.find({
      companyId,
      status: { $in: ['SUBMITTED', 'PENDING_HR'] },
      ...(filters.departmentId ? { department: filters.departmentId } : {}),
    })
      .select('_id requisitionNumber title status department createdAt priority')
      .populate('department', 'name')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
    PreOnboarding.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          ...(filters.jobId ? { job: filters.jobId } : {}),
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    ATSResult.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          ...(filters.jobId ? { job: filters.jobId } : {}),
          createdAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: '$matchCategory',
          count: { $sum: 1 },
          avgScore: { $avg: '$overallScore' },
        },
      },
    ]),
    Candidate.aggregate([
      { $match: candidateInPeriod },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
    JobPosting.aggregate([
      { $match: scopedJobMatch },
      {
        $lookup: {
          from: 'departments',
          localField: 'department',
          foreignField: '_id',
          as: 'dept',
        },
      },
      {
        $group: {
          _id: '$department',
          openJobs: {
            $sum: { $cond: [{ $eq: ['$status', 'OPEN'] }, 1, 0] },
          },
          totalJobs: { $sum: 1 },
          departmentName: { $first: { $arrayElemAt: ['$dept.name', 0] } },
        },
      },
    ]),
    JobPosting.find(scopedJobMatch)
      .select(
        '_id jobCode title status publicationStatus department publishedAt createdAt openings headcount'
      )
      .populate('department', 'name')
      .sort({ updatedAt: -1 })
      .limit(25)
      .lean(),
    CandidatePipelineHistory.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          createdAt: { $gte: from, $lte: to },
          ...(filters.jobId ? { jobPostingId: filters.jobId } : {}),
        },
      },
      {
        $group: {
          _id: {
            candidateId: '$candidateId',
            toStage: '$toStage',
          },
        },
      },
      {
        $group: {
          _id: '$_id.toStage',
          count: { $sum: 1 },
        },
      },
    ]),
    OfferLetter.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          status: 'ACCEPTED',
          acceptedAt: { $gte: from, $lte: to },
          ...(filters.jobId ? { job: filters.jobId } : {}),
        },
      },
      {
        $lookup: {
          from: 'candidates',
          localField: 'candidate',
          foreignField: '_id',
          as: 'candidateDoc',
        },
      },
      { $unwind: '$candidateDoc' },
      {
        $project: {
          days: {
            $divide: [
              { $subtract: ['$acceptedAt', '$candidateDoc.applicationDate'] },
              DAY_MS,
            ],
          },
          fillDays: {
            $cond: [
              { $ifNull: ['$terms.offerDate', false] },
              {
                $divide: [
                  { $subtract: ['$acceptedAt', '$terms.offerDate'] },
                  DAY_MS,
                ],
              },
              null,
            ],
          },
        },
      },
      {
        $match: {
          days: { $gte: 0, $lte: 400 },
        },
      },
    ]),
    Candidate.aggregate([
      { $match: candidateInPeriod },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$applicationDate' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    OfferLetter.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          'delivery.sentAt': { $gte: from, $lte: to },
          ...(filters.jobId ? { job: filters.jobId } : {}),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$delivery.sentAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    CandidateEmployeeConversion.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          status: 'COMPLETED',
          convertedAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$convertedAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Promise.all([
      Department.find({ companyId }).select('_id name').sort({ name: 1 }).lean(),
      JobPosting.find({ companyId, status: 'OPEN' })
        .select('_id jobCode title')
        .sort({ title: 1 })
        .limit(100)
        .lean(),
      User.find({
        companyId,
        status: 'ACTIVE',
        role: { $in: ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'] },
      })
        .select('_id name role')
        .sort({ name: 1 })
        .limit(100)
        .lean(),
    ]),
  ]);

  // Open jobs recount without publicationStatus if earlier failed soft.
  const openJobsCount =
    typeof openJobs === 'number'
      ? openJobs
      : await JobPosting.countDocuments({ ...scopedJobMatch, status: 'OPEN' });

  const funnelStageMap = Object.fromEntries(
    (funnelHistoryRows || []).map((row) => [row._id, row.count])
  );

  // Funnel milestones (distinct candidates that reached stage in period).
  // Fall back to current-stage counts when history is sparse for early stages.
  const applicationsCount = applications;
  const funnel = [
    {
      key: 'APPLICATIONS',
      label: 'Applications',
      count: applicationsCount,
    },
    {
      key: 'ATS_SCREENING',
      label: 'ATS Screened',
      count: Math.max(funnelStageMap.ATS_SCREENING || 0, atsScreened || 0),
    },
    {
      key: 'HR_SCREENING',
      label: 'HR Screened',
      count: funnelStageMap.HR_SCREENING || 0,
    },
    {
      key: 'SHORTLISTED',
      label: 'Shortlisted',
      count: Math.max(funnelStageMap.SHORTLISTED || 0, currentlyShortlisted || 0),
    },
    {
      key: 'INTERVIEWED',
      label: 'Interviewed',
      count: Math.max(
        funnelStageMap.INTERVIEW_1 || 0,
        funnelStageMap.INTERVIEW_2 || 0,
        funnelStageMap.MANAGER_ROUND || 0,
        funnelStageMap.HR_FINAL || 0
      ),
    },
    {
      key: 'SELECTED',
      label: 'Selected',
      count: Math.max(funnelStageMap.SELECTED || 0, selectedCurrent || 0),
    },
    {
      key: 'OFFER_SENT',
      label: 'Offer Sent',
      count: Math.max(funnelStageMap.OFFER || 0, offersSent || 0),
    },
    {
      key: 'OFFER_ACCEPTED',
      label: 'Offer Accepted',
      count: Math.max(funnelStageMap.OFFER_ACCEPTED || 0, offersAccepted || 0),
    },
    {
      key: 'JOINED',
      label: 'Joined',
      count: Math.max(
        funnelStageMap.JOINED || 0,
        joinedConversions || 0,
        currentlyJoined || 0
      ),
    },
  ].map((step, index, list) => {
    const previous = index === 0 ? step.count : list[index - 1].count;
    return {
      ...step,
      conversionFromPrevious: rate(step.count, previous),
      conversionFromApplications: rate(step.count, applicationsCount),
    };
  });

  const offerStatusMap = Object.fromEntries(
    (offerStatusBreakdown || []).map((row) => [row._id, row.count])
  );
  const preOnboardingMap = Object.fromEntries(
    (preOnboardingBreakdown || []).map((row) => [row._id, row.count])
  );

  const hireDays = (timeToHireRows || [])
    .map((row) => Number(row.days))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const fillDays = (timeToHireRows || [])
    .map((row) => Number(row.fillDays))
    .filter((value) => Number.isFinite(value) && value >= 0);

  // Source quality: applications in period + joined conversions via candidate source.
  const joinedBySource = await Candidate.aggregate([
    {
      $match: {
        ...candidateBase,
        currentStage: 'JOINED',
      },
    },
    { $group: { _id: '$source', count: { $sum: 1 } } },
  ]);
  const joinedSourceMap = Object.fromEntries(
    joinedBySource.map((row) => [row._id || 'INTERNAL', row.count])
  );
  const sourceAnalytics = ['CAREER_PAGE', 'INTERNAL'].map((source) => {
    const applicationCount =
      sourceApplicationRows.find((row) => row._id === source)?.count || 0;
    const joinedCount = joinedSourceMap[source] || 0;
    return {
      source,
      label: source === 'CAREER_PAGE' ? 'Career page' : 'Internal / manual',
      applications: applicationCount,
      joined: joinedCount,
      conversionRate: rate(joinedCount, applicationCount),
    };
  });

  const atsTotal = (atsCategoryRows || []).reduce(
    (sum, row) => sum + (row.count || 0),
    0
  );
  const atsDistribution = ['STRONG', 'GOOD', 'MODERATE', 'WEAK'].map(
    (category) => {
      const row = (atsCategoryRows || []).find((item) => item._id === category);
      const count = row?.count || 0;
      return {
        category,
        count,
        percentage: rate(count, atsTotal) || 0,
        averageScore: row?.avgScore
          ? Math.round(row.avgScore * 10) / 10
          : null,
      };
    }
  );

  // Job table enrichment (bounded).
  const jobIds = jobRows.map((job) => job._id);
  const [jobAppCounts, jobJoinedCounts, jobAtsAvg] = await Promise.all([
    Candidate.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          job: { $in: jobIds },
          applicationDate: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: '$job', count: { $sum: 1 } } },
    ]),
    Candidate.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          job: { $in: jobIds },
          currentStage: 'JOINED',
        },
      },
      { $group: { _id: '$job', count: { $sum: 1 } } },
    ]),
    ATSResult.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          job: { $in: jobIds },
        },
      },
      {
        $group: {
          _id: '$job',
          avgScore: { $avg: '$overallScore' },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);
  const jobAppMap = Object.fromEntries(
    jobAppCounts.map((row) => [String(row._id), row.count])
  );
  const jobJoinedMap = Object.fromEntries(
    jobJoinedCounts.map((row) => [String(row._id), row.count])
  );
  const jobAtsMap = Object.fromEntries(
    jobAtsAvg.map((row) => [String(row._id), row])
  );

  const now = Date.now();
  const jobs = jobRows.map((job) => {
    const published = job.publishedAt || job.createdAt;
    const ageDays = published
      ? Math.max(0, Math.floor((now - new Date(published).getTime()) / DAY_MS))
      : null;
    return {
      id: job._id,
      jobCode: job.jobCode,
      title: job.title,
      status: job.status,
      departmentName: job.department?.name || 'Unassigned',
      applications: jobAppMap[String(job._id)] || 0,
      joined: jobJoinedMap[String(job._id)] || 0,
      averageAtsScore: jobAtsMap[String(job._id)]?.avgScore
        ? Math.round(jobAtsMap[String(job._id)].avgScore * 10) / 10
        : null,
      ageDays,
      ageBucket:
        ageDays == null
          ? null
          : ageDays <= 15
            ? '0-15'
            : ageDays <= 30
              ? '16-30'
              : ageDays <= 60
                ? '31-60'
                : '60+',
    };
  });

  const departmentHiring = (departmentRows || []).map((row) => ({
    departmentId: row._id,
    departmentName: row.departmentName || 'Unassigned',
    openJobs: row.openJobs || 0,
    totalJobs: row.totalJobs || 0,
  }));

  // Work queue samples (safe identifiers only).
  const [
    interviewsTodayRows,
    feedbackPendingRows,
    offersPendingRows,
    offersAwaitingRows,
    docsReviewRows,
    readyRows,
  ] = await Promise.all([
    Interview.find({
      companyId,
      scheduledStartAt: { $gte: todayStart, $lte: todayEnd },
      status: { $in: ['SCHEDULED', 'RESCHEDULED', 'IN_PROGRESS'] },
      ...(filters.jobId ? { job: filters.jobId } : {}),
    })
      .select('_id interviewCode scheduledStartAt status candidate job')
      .populate('candidate', 'name candidateCode')
      .populate('job', 'title jobCode')
      .sort({ scheduledStartAt: 1 })
      .limit(10)
      .lean(),
    InterviewFeedback.find({
      companyId,
      status: 'DRAFT',
    })
      .select('_id interview candidate status updatedAt')
      .populate('candidate', 'name candidateCode')
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean(),
    OfferLetter.find({
      companyId,
      status: 'PENDING_APPROVAL',
      ...(filters.jobId ? { job: filters.jobId } : {}),
    })
      .select('_id offerCode status candidateSnapshot jobSnapshot createdAt')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
    OfferLetter.find({
      companyId,
      status: { $in: ['SENT', 'VIEWED'] },
      ...(filters.jobId ? { job: filters.jobId } : {}),
    })
      .select(
        '_id offerCode status candidateSnapshot jobSnapshot delivery.sentAt terms.expiryDate'
      )
      .sort({ 'delivery.sentAt': -1 })
      .limit(10)
      .lean(),
    PreOnboarding.find({
      companyId,
      status: { $in: ['UNDER_REVIEW', 'ACTION_REQUIRED', 'IN_PROGRESS'] },
      ...(filters.jobId ? { job: filters.jobId } : {}),
    })
      .select(
        '_id preOnboardingCode status candidateSnapshot jobSnapshot updatedAt'
      )
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean(),
    PreOnboarding.find({
      companyId,
      status: 'READY_TO_JOIN',
      ...(filters.jobId ? { job: filters.jobId } : {}),
    })
      .select(
        '_id preOnboardingCode status candidateSnapshot jobSnapshot candidate readyToJoinAt'
      )
      .sort({ readyToJoinAt: -1 })
      .limit(10)
      .lean(),
  ]);

  const [departments, openJobOptions, people] = filterOptions;

  const kpis = {
    pendingRequisitions,
    openJobs: openJobsCount,
    applications: applicationsCount,
    atsScreened,
    currentlyShortlisted,
    interviewsInPeriod,
    interviewsToday,
    currentlySelected: selectedCurrent,
    offersSent,
    offersAccepted,
    readyToJoin,
    joinedInPeriod: joinedConversions,
    currentlyJoined,
  };

  return {
    range: {
      from,
      to,
      preset: range.preset,
    },
    definitions: {
      timeToHire:
        'offer.acceptedAt − candidate.applicationDate (completed accepts only)',
      timeToFill:
        'Approximate: offer.acceptedAt − offer.terms.offerDate when available',
      funnel:
        'Distinct candidates that reached each milestone in the selected period (history-first)',
      offerAcceptanceRate: 'accepted / sent in selected period',
      joined: 'Completed candidate→employee conversions in period; current JOINED shown separately',
    },
    notes,
    kpis,
    funnel,
    conversionRates: {
      applicationToAts: rate(kpis.atsScreened, kpis.applications),
      atsToShortlist: rate(
        funnel.find((item) => item.key === 'SHORTLISTED')?.count || 0,
        kpis.atsScreened
      ),
      shortlistToInterview: rate(
        funnel.find((item) => item.key === 'INTERVIEWED')?.count || 0,
        funnel.find((item) => item.key === 'SHORTLISTED')?.count || 0
      ),
      interviewToSelected: rate(
        funnel.find((item) => item.key === 'SELECTED')?.count || 0,
        funnel.find((item) => item.key === 'INTERVIEWED')?.count || 0
      ),
      selectedToOfferSent: rate(
        kpis.offersSent,
        funnel.find((item) => item.key === 'SELECTED')?.count || 0
      ),
      offerAcceptanceRate: rate(kpis.offersAccepted, kpis.offersSent),
      acceptedToJoined: rate(kpis.joinedInPeriod, kpis.offersAccepted),
    },
    sourceAnalytics,
    departmentHiring,
    atsDistribution,
    interviewMetrics: {
      inPeriod: interviewsInPeriod,
      today: interviewsToday,
      feedbackPending,
    },
    offerMetrics: {
      byStatus: offerStatusMap,
      sent: offersSent,
      accepted: offersAccepted,
      rejected: offerStatusMap.REJECTED || 0,
      expired: offerStatusMap.EXPIRED || 0,
      withdrawn: offerStatusMap.WITHDRAWN || 0,
      acceptanceRate: rate(offersAccepted, offersSent),
    },
    preOnboardingMetrics: {
      byStatus: preOnboardingMap,
      readyToJoin,
      actionRequired: preOnboardingMap.ACTION_REQUIRED || 0,
      underReview: preOnboardingMap.UNDER_REVIEW || 0,
      inProgress: preOnboardingMap.IN_PROGRESS || 0,
    },
    timeToHire: {
      averageDays: average(hireDays),
      medianDays: median(hireDays),
      minDays: hireDays.length ? Math.min(...hireDays) : null,
      maxDays: hireDays.length ? Math.max(...hireDays) : null,
      sampleSize: hireDays.length,
    },
    timeToFill: {
      averageDays: average(fillDays),
      medianDays: median(fillDays),
      sampleSize: fillDays.length,
      available: fillDays.length > 0,
      note: 'Uses acceptedAt − offerDate as a contractual proxy when requisition decision timestamps are sparse',
    },
    trends: {
      applications: applicationTrendRows.map((row) => ({
        date: row._id,
        count: row.count,
      })),
      offersSent: offerTrendRows.map((row) => ({
        date: row._id,
        count: row.count,
      })),
      hires: hireTrendRows.map((row) => ({
        date: row._id,
        count: row.count,
      })),
    },
    jobs,
    workQueue: {
      requisitionsAwaitingApproval: (requisitionsAwaitingApproval || []).map(
        (item) => ({
          id: item._id,
          code: item.requisitionNumber,
          title: item.title,
          status: item.status,
          priority: item.priority,
          departmentName: item.department?.name || '',
          href: `/app/recruitment/approvals`,
        })
      ),
      interviewsToday: interviewsTodayRows.map((item) => ({
        id: item._id,
        code: item.interviewCode,
        status: item.status,
        scheduledStartAt: item.scheduledStartAt,
        candidateName: item.candidate?.name || '',
        candidateCode: item.candidate?.candidateCode || '',
        jobTitle: item.job?.title || '',
        href: `/app/recruitment/interviews`,
      })),
      feedbackPending: feedbackPendingRows.map((item) => ({
        id: item._id,
        candidateName: item.candidate?.name || '',
        candidateCode: item.candidate?.candidateCode || '',
        status: item.status,
        href: `/app/recruitment/interviews`,
      })),
      offersPendingApproval: offersPendingRows.map((item) => ({
        id: item._id,
        offerCode: item.offerCode,
        candidateName: item.candidateSnapshot?.name || '',
        jobTitle: item.jobSnapshot?.title || '',
        href: `/app/recruitment/offers/${item._id}`,
      })),
      offersAwaitingCandidate: offersAwaitingRows.map((item) => ({
        id: item._id,
        offerCode: item.offerCode,
        status: item.status,
        candidateName: item.candidateSnapshot?.name || '',
        href: `/app/recruitment/offers/${item._id}`,
      })),
      documentsAwaitingVerification: docsReviewRows.map((item) => ({
        id: item._id,
        code: item.preOnboardingCode,
        status: item.status,
        candidateName: item.candidateSnapshot?.name || '',
        href: `/app/recruitment/pre-onboarding/${item._id}`,
      })),
      readyToJoin: readyRows.map((item) => ({
        id: item._id,
        code: item.preOnboardingCode,
        candidateName: item.candidateSnapshot?.name || '',
        candidateCode: item.candidateSnapshot?.candidateCode || '',
        candidateId: item.candidate,
        href: `/app/recruitment/candidates/${item.candidateSnapshot?.candidateCode || item.candidate}/convert`,
      })),
    },
    options: {
      departments: departments.map((item) => ({
        id: item._id,
        name: item.name,
      })),
      jobs: openJobOptions.map((item) => ({
        id: item._id,
        jobCode: item.jobCode,
        title: item.title,
      })),
      people: people.map((item) => ({
        id: item._id,
        name: item.name,
        role: item.role,
      })),
      sources: [
        { value: 'CAREER_PAGE', label: 'Career page' },
        { value: 'INTERNAL', label: 'Internal / manual' },
      ],
      ranges: [
        'LAST_7_DAYS',
        'LAST_30_DAYS',
        'LAST_90_DAYS',
        'THIS_MONTH',
        'THIS_QUARTER',
        'THIS_YEAR',
      ],
    },
  };
};
