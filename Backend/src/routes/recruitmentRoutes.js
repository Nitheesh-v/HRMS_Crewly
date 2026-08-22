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
  stageRules,
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
  updateStage,
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
  candidateInboxDetailRules,
  candidateInboxListRules,
  candidateResumeAccessRules,
} from '../validators/candidateInboxValidator.js';
import {
  resumeParsedReadRules,
  resumeReprocessRules,
} from '../validators/resumeParsingValidator.js';
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

const router = Router();

const resumeReprocessRateLimit = securityRateLimit({
  windowMs: 15 * 60 * 1000,
  maximum: 5,
  keyGenerator: (req) =>
    `${req.companyId}:${req.user?._id}:${req.params.candidateRef}:resume-reprocess`,
  message: 'Too many resume reprocessing requests. Please try again later.',
});

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus,
  requireFeature(
    'recruitment'
  )
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
  stageRules,
  updateStage
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