import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkUsageLimit,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import {
  createJobRules,
  updateJobRules,
  candidateRules,
  offerRules,
} from '../validators/recruitmentValidator.js';
import {
  approveRequisitionRules,
  createJobFromRequisitionRules,
  createRequisitionRules,
  rejectRequisitionRules,
  sendBackRequisitionRules,
  submitRequisitionRules,
  updateRequisitionRules,
} from '../validators/requisitionValidator.js';
import {
  listJobs,
  createJob,
  updateJob,
  listCandidates,
  addCandidate,
  updateOffer,
  convertCandidate,
} from '../controllers/recruitmentController.js';
import {
  candidateInboxDetail,
  candidateInboxList,
  candidateResumeDownload,
} from '../controllers/candidateInboxController.js';
import {
  candidateParsedResumeRead,
  candidateResumeReprocess,
} from '../controllers/resumeParsingController.js';
import {
  candidateATSReprocess,
  candidateATSResultRead,
} from '../controllers/atsController.js';
import {
  candidatePipelineBulkAction,
  candidatePipelineOptions,
  candidatePipelineStageUpdate,
} from '../controllers/candidatePipelineController.js';
import {
  candidateInboxDetailRules,
  candidateInboxListRules,
  candidateResumeAccessRules,
} from '../validators/candidateInboxValidator.js';
import {
  resumeParsedReadRules,
  resumeReprocessRules,
} from '../validators/resumeParsingValidator.js';
import {
  atsReprocessRules,
  atsResultReadRules,
} from '../validators/atsValidator.js';
import {
  bulkPipelineRules,
  pipelineStageRules,
} from '../validators/candidatePipelineValidator.js';
import { securityRateLimit } from '../middlewares/securityRateLimit.js';
import {
  requisitionApprove,
  requisitionCreate,
  requisitionCreateJob,
  requisitionDetail,
  requisitionList,
  requisitionOptions,
  requisitionReject,
  requisitionSendBack,
  requisitionSubmit,
  requisitionUpdate,
} from '../controllers/requisitionController.js';
import {
  candidateInterviewList,
  interviewCancel,
  interviewDetail,
  interviewEligibleInterviewers,
  interviewList,
  interviewOptions,
  interviewReschedule,
  interviewSchedule,
  interviewStatusUpdate,
  myInterviewList,
} from '../controllers/interviewController.js';
import {
  cancelInterviewRules,
  candidateInterviewRules,
  interviewDetailRules,
  interviewListRules,
  rescheduleInterviewRules,
  scheduleInterviewRules,
  updateInterviewStatusRules,
} from '../validators/interviewValidator.js';

const router = Router();

const resumeReprocessRateLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 5,
  keyGenerator: (req) =>
    `${req.companyId}:${req.user?._id}:${req.params.candidateRef}:resume-reprocess`,
  message: 'Too many resume reprocessing requests. Please try again later.',
});

const atsReprocessRateLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 5,
  keyGenerator: (req) =>
    `${req.companyId}:${req.user?._id}:${req.params.candidateId}:ats-reprocess`,
  message: 'Too many ATS recalculation requests. Please try again later.',
});

const pipelineBulkRateLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 20,
  keyGenerator: (req) =>
    `${req.companyId}:${req.user?._id}:candidate-bulk-action`,
  message: 'Too many bulk candidate actions. Please try again later.',
});

const interviewWriteRateLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 40,
  keyGenerator: (req) =>
    `${req.companyId}:${req.user?._id}:interview-write`,
  message: 'Too many interview changes. Please try again later.',
});

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus,
  requireFeature(
    'recruitment'
  )
);

// Phase 27.9 — interview management. Literal routes stay before /:id.
router.get(
  '/interviews/options',
  requireAnyPermission(['INTERVIEW_READ', 'INTERVIEW_CREATE']),
  interviewOptions
);

router.get(
  '/interviews/eligible-interviewers',
  requireAnyPermission(['INTERVIEW_READ', 'INTERVIEW_CREATE']),
  interviewEligibleInterviewers
);

router.get(
  '/interviews/my-interviews',
  requirePermission('INTERVIEW_READ_SELF'),
  interviewListRules,
  myInterviewList
);

router.get(
  '/interviews',
  requirePermission('INTERVIEW_READ'),
  interviewListRules,
  interviewList
);

router.post(
  '/interviews',
  checkWriteAccess,
  requirePermission('INTERVIEW_CREATE'),
  interviewWriteRateLimit,
  scheduleInterviewRules,
  interviewSchedule
);

router.get(
  '/interviews/:id',
  requireAnyPermission(['INTERVIEW_READ', 'INTERVIEW_READ_SELF']),
  interviewDetailRules,
  interviewDetail
);

router.patch(
  '/interviews/:id/reschedule',
  checkWriteAccess,
  requirePermission('INTERVIEW_UPDATE'),
  interviewWriteRateLimit,
  rescheduleInterviewRules,
  interviewReschedule
);

router.post(
  '/interviews/:id/cancel',
  checkWriteAccess,
  requirePermission('INTERVIEW_UPDATE'),
  interviewWriteRateLimit,
  cancelInterviewRules,
  interviewCancel
);

router.patch(
  '/interviews/:id/status',
  checkWriteAccess,
  requireAnyPermission(['INTERVIEW_UPDATE', 'INTERVIEW_UPDATE_SELF']),
  interviewWriteRateLimit,
  updateInterviewStatusRules,
  interviewStatusUpdate
);

router.get(
  '/candidates/:candidateRef/interviews',
  requirePermission('INTERVIEW_READ'),
  candidateInterviewRules,
  candidateInterviewList
);

// Phase 27.1 — requisition routes. Literal /options stays before /:id.
router.get(
  '/requisitions/options',
  requireAnyPermission([
    'REQUISITION_READ',
    'REQUISITION_READ_SELF',
    'REQUISITION_CREATE',
  ]),
  requisitionOptions
);

router.get(
  '/requisitions',
  requireAnyPermission([
    'REQUISITION_READ',
    'REQUISITION_READ_SELF',
  ]),
  requisitionList
);

router.post(
  '/requisitions',
  checkWriteAccess,
  requireAnyPermission([
    'REQUISITION_CREATE',
  ]),
  createRequisitionRules,
  requisitionCreate
);

router.get(
  '/requisitions/:id',
  requireAnyPermission([
    'REQUISITION_READ',
    'REQUISITION_READ_SELF',
  ]),
  requisitionDetail
);

router.patch(
  '/requisitions/:id',
  checkWriteAccess,
  requireAnyPermission([
    'REQUISITION_UPDATE',
    'REQUISITION_UPDATE_SELF',
  ]),
  updateRequisitionRules,
  requisitionUpdate
);

router.post(
  '/requisitions/:id/submit',
  checkWriteAccess,
  requireAnyPermission([
    'REQUISITION_SUBMIT',
    'REQUISITION_SUBMIT_SELF',
  ]),
  submitRequisitionRules,
  requisitionSubmit
);

// Phase 27.2 — exact-permission HR decisions.
router.post(
  '/requisitions/:id/approve',
  checkWriteAccess,
  requirePermission('REQUISITION_APPROVE'),
  approveRequisitionRules,
  requisitionApprove
);

router.post(
  '/requisitions/:id/reject',
  checkWriteAccess,
  requirePermission('REQUISITION_REJECT'),
  rejectRequisitionRules,
  requisitionReject
);

router.post(
  '/requisitions/:id/send-back',
  checkWriteAccess,
  requirePermission('REQUISITION_SEND_BACK'),
  sendBackRequisitionRules,
  requisitionSendBack
);

// Phase 27.3 — create one job from an approved requisition.
router.post(
  '/requisitions/:id/create-job',
  checkWriteAccess,
  requirePermission('RECRUITMENT_CREATE'),
  checkUsageLimit('jobPostingsMonthly'),
  createJobFromRequisitionRules,
  requisitionCreateJob
);

router.get(
  '/jobs',
  requirePermission(
    'RECRUITMENT_READ'
  ),
  listJobs
);

router.post(
  '/jobs',
  checkWriteAccess,
  requirePermission(
    'RECRUITMENT_CREATE'
  ),
  checkUsageLimit(
    'jobPostingsMonthly'
  ),
  createJobRules,
  createJob
);

router.patch(
  '/jobs/:id',
  checkWriteAccess,
  requirePermission(
    'RECRUITMENT_UPDATE'
  ),
  updateJobRules,
  updateJob
);

router.get(
  '/candidates',
  requirePermission('CANDIDATE_READ'),
  listCandidates
);

router.get(
  '/candidates/pipeline-options',
  requirePermission('CANDIDATE_READ'),
  candidatePipelineOptions
);

router.post(
  '/candidates/bulk-actions',
  checkWriteAccess,
  requirePermission('CANDIDATE_UPDATE'),
  pipelineBulkRateLimit,
  bulkPipelineRules,
  candidatePipelineBulkAction
);

router.get(
  '/candidates/inbox',
  requirePermission('CANDIDATE_READ'),
  candidateInboxListRules,
  candidateInboxList
);

router.get(
  '/candidates/:candidateRef/detail',
  requirePermission('CANDIDATE_READ'),
  candidateInboxDetailRules,
  candidateInboxDetail
);

router.get(
  '/candidates/:candidateId/ats-result',
  requirePermission('CANDIDATE_READ'),
  atsResultReadRules,
  candidateATSResultRead
);

router.post(
  '/candidates/:candidateId/ats-reprocess',
  checkWriteAccess,
  requirePermission('CANDIDATE_UPDATE'),
  atsReprocessRateLimit,
  atsReprocessRules,
  candidateATSReprocess
);

router.get(
  '/candidates/:candidateRef/resume/parsed',
  requirePermission('CANDIDATE_READ'),
  resumeParsedReadRules,
  candidateParsedResumeRead
);

router.post(
  '/candidates/:candidateRef/resume/reprocess',
  checkWriteAccess,
  requirePermission('CANDIDATE_UPDATE'),
  resumeReprocessRateLimit,
  resumeReprocessRules,
  candidateResumeReprocess
);

router.get(
  '/candidates/:candidateRef/resume',
  requirePermission('CANDIDATE_READ'),
  candidateResumeAccessRules,
  candidateResumeDownload
);

router.post(
  '/candidates',
  checkWriteAccess,
  requirePermission('CANDIDATE_CREATE'),
  checkUsageLimit(
    'recruitmentCandidatesMonthly'
  ),
  candidateRules,
  addCandidate
);

router.patch(
  '/candidates/:id/stage',
  checkWriteAccess,
  requirePermission('CANDIDATE_UPDATE'),
  pipelineStageRules,
  candidatePipelineStageUpdate
);

router.patch(
  '/candidates/:id/offer',
  checkWriteAccess,
  requirePermission('CANDIDATE_UPDATE'),
  offerRules,
  updateOffer
);

router.post(
  '/candidates/:id/convert',
  checkWriteAccess,
  requirePermission(
    'RECRUITMENT_APPROVE'
  ),
  checkUsageLimit(
    'employees'
  ),
  convertCandidate
);

export default router;